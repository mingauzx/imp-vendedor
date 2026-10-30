import pg from 'pg';
import {createPublicKey, verify, createHmac, timingSafeEqual} from 'node:crypto';

const env = process.env;
const required = ['DATABASE_URL','DISCORD_TOKEN','DISCORD_CLIENT_ID','DISCORD_PUBLIC_KEY','GUILD_ID'];
const missing = required.filter(k => !env[k]);
const pool = env.DATABASE_URL ? new pg.Pool({connectionString:env.DATABASE_URL,max:5}) : null;
const money = n => (n/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const paymentEnabled = () => env.PAYMENT_PROVIDER === 'mercadopago' && env.MP_ACCESS_TOKEN && env.MP_COLLECTOR_ID && env.MP_WEBHOOK_SECRET;
const schema = `
CREATE SCHEMA IF NOT EXISTS imp_vendedor;
CREATE TABLE IF NOT EXISTS imp_vendedor.products(id serial PRIMARY KEY,name text NOT NULL,amount integer NOT NULL CHECK(amount>0),active boolean NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS imp_vendedor.orders(id text PRIMARY KEY,buyer text NOT NULL,product integer REFERENCES imp_vendedor.products(id),name text NOT NULL,amount integer NOT NULL,state text NOT NULL DEFAULT 'creating',payment_id text UNIQUE,dm_message text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS imp_vendedor.stock(id serial PRIMARY KEY,product integer NOT NULL REFERENCES imp_vendedor.products(id),payload text NOT NULL,order_id text UNIQUE REFERENCES imp_vendedor.orders(id));
CREATE TABLE IF NOT EXISTS imp_vendedor.settings(key text PRIMARY KEY,value text NOT NULL);
CREATE TABLE IF NOT EXISTS imp_vendedor.events(id bigserial PRIMARY KEY,kind text NOT NULL,order_id text REFERENCES imp_vendedor.orders(id),message text NOT NULL,sent boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(kind,order_id));
`;
async function transaction(fn) { const db=await pool.connect(); try {await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();} }
async function discord(path, body, method='POST') {
  const response=await fetch('https://discord.com/api/v10'+path,{method,headers:{Authorization:'Bot '+env.DISCORD_TOKEN,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  if(!response.ok) throw new Error('Discord HTTP '+response.status);
  return response.status===204?{}:response.json();
}
async function mp(path, body, key) {
  const response=await fetch('https://api.mercadopago.com'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+env.MP_ACCESS_TOKEN,'Content-Type':'application/json',...(key?{'X-Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error('Pagamento HTTP '+response.status);
  return response.json();
}
function approvedPayment(payment, order, collectorId) {
  return payment.status === 'approved' && payment.payment_method_id === 'pix'
    && payment.currency_id === 'BRL' && payment.external_reference === order.id
    && Number.isFinite(Number(payment.transaction_amount))
    && Math.round(Number(payment.transaction_amount) * 100) === order.amount
    && String(payment.collector_id) === String(collectorId)
    && payment.live_mode === true;
}
async function event(db,kind,order,message){await db.query('INSERT INTO imp_vendedor.events(kind,order_id,message) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[kind,order,message]);}
async function flushLogs() {
  await transaction(async db=>{
    const {rows}=await db.query("SELECT e.*,s.value channel FROM imp_vendedor.events e JOIN imp_vendedor.settings s ON s.key=CASE WHEN e.kind='delivery' THEN 'delivery_channel' ELSE 'sales_channel' END WHERE NOT e.sent ORDER BY e.id LIMIT 10 FOR UPDATE OF e SKIP LOCKED");
    for(const row of rows){
      try {await discord('/channels/'+row.channel+'/messages',{content:row.message,allowed_mentions:{parse:[]},nonce:String(1000000000000000000n+BigInt(row.id)),enforce_nonce:true});await db.query('UPDATE imp_vendedor.events SET sent=true WHERE id=$1',[row.id]);}catch{console.error('Log pendente',row.id);}
    }
  });
}
async function deliver(orderId) {
  return transaction(async db=>{
    const {rows:[order]}=await db.query('SELECT * FROM imp_vendedor.orders WHERE id=$1 FOR UPDATE',[orderId]);
    if(!order || order.state==='delivered' || order.state!=='paid') return;
    const {rows:[stock]}=await db.query('SELECT payload FROM imp_vendedor.stock WHERE order_id=$1',[order.id]);
    if(!stock) throw new Error('Estoque reservado ausente');
    const dm=await discord('/users/@me/channels',{recipient_id:order.buyer});
    const message=await discord('/channels/'+dm.id+'/messages',{content:`**IMP VENDEDOR — Entrega**\nPedido: ${order.id}\nProduto: ${order.name}\n\n${stock.payload}`,allowed_mentions:{parse:[]},nonce:order.id,enforce_nonce:true});
    await db.query("UPDATE imp_vendedor.orders SET state='delivered',dm_message=$2 WHERE id=$1",[order.id,message.id]);
    await event(db,'delivery',order.id,`📦 Entrega concluída · Pedido ${order.id} · Comprador ${order.buyer} · ${order.name}`);
  });
}
async function reconcile(payment) {
  if(!paymentEnabled()) return;
  const id=String(payment.external_reference||'');
  await transaction(async db=>{
    const {rows:[order]}=await db.query('SELECT * FROM imp_vendedor.orders WHERE id=$1 FOR UPDATE',[id]);
    if(!order || ['paid','delivered','cancelled','paid_review'].includes(order.state)) return;
    if(approvedPayment(payment,order,env.MP_COLLECTOR_ID)){
      await db.query("UPDATE imp_vendedor.orders SET state='paid',payment_id=$2 WHERE id=$1",[id,String(payment.id)]);
      await event(db,'sale',id,`✅ Venda aprovada · Pedido ${id} · Comprador ${order.buyer} · ${order.name} · ${money(order.amount)}`);
    } else if(['cancelled','rejected'].includes(payment.status) && String(payment.collector_id)===env.MP_COLLECTOR_ID && payment.payment_method_id==='pix') {
      await db.query("UPDATE imp_vendedor.orders SET state='cancelled',payment_id=$2 WHERE id=$1 AND state IN ('creating','pending')",[id,String(payment.id)]);
      await db.query('UPDATE imp_vendedor.stock SET order_id=NULL WHERE order_id=$1',[id]);
    }
  });
  try{await deliver(id);}catch{console.error('Entrega pendente',id);}
  await flushLogs();
}
const opt=(name,description,type,extra={})=>({name,description,type,...extra});
const commands=[
  {name:'catalogo',description:'Ver os produtos e o estoque disponível'},
  {name:'comprar',description:'Comprar um produto digital via Pix',options:[opt('produto','ID do produto',4,{required:true,min_value:1}),opt('email','E-mail do pagador para gerar a cobrança',3,{required:true,max_length:254})]},
  {name:'compras',description:'Ver suas últimas compras'},
  {name:'verificar',description:'Consultar pagamento e tentar entregar seu pedido',options:[opt('pedido','Número do pedido',3,{required:true,max_length:30})]},
  {name:'produto',description:'Cadastrar um produto',default_member_permissions:'32',options:[opt('nome','Nome do produto',3,{required:true,max_length:100}),opt('centavos','Preço em centavos: 1000 = R$ 10,00',4,{required:true,min_value:1,max_value:10000000})]},
  {name:'estoque',description:'Adicionar uma unidade digital ao estoque',default_member_permissions:'32',options:[opt('produto','ID do produto',4,{required:true,min_value:1}),opt('conteudo','Código, link ou instruções privadas de entrega',3,{required:true,max_length:1400})]},
  {name:'logs',description:'Configurar os canais privados de registros',default_member_permissions:'32',options:[opt('vendas','Canal privado de vendas',7,{required:true,channel_types:[0]}),opt('entregas','Canal privado de entregas',7,{required:true,channel_types:[0]})]}
].map(c=>({...c,type:1,dm_permission:false}));
function isAdmin(i){return (BigInt(i.member?.permissions||'0') & 40n)!==0n;}
async function execute(i) {
  const args=Object.fromEntries((i.data.options||[]).map(o=>[o.name,o.value]));
  const user=i.member.user.id;
  if(['produto','estoque','logs'].includes(i.data.name) && !isAdmin(i)) return 'Você precisa da permissão Gerenciar Servidor.';
  switch(i.data.name){
    case 'produto':{
      const {rows:[p]}=await pool.query('INSERT INTO imp_vendedor.products(name,amount) VALUES($1,$2) RETURNING id',[args.nome,args.centavos]);return `Produto #${p.id} cadastrado: ${args.nome} · ${money(args.centavos)}.`;
    }
    case 'estoque':{
      await pool.query('INSERT INTO imp_vendedor.stock(product,payload) VALUES($1,$2)',[args.produto,args.conteudo]);return 'Uma unidade adicionada ao estoque privado.';
    }
    case 'logs':{
      for(const [key,value] of [['sales_channel',args.vendas],['delivery_channel',args.entregas]]){
        const channel=await discord('/channels/'+value,undefined,'GET');
        if(channel.guild_id!==env.GUILD_ID) throw new Error('Canal fora do servidor');
        await pool.query('INSERT INTO imp_vendedor.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,value]);
      }
      await flushLogs();return 'Canais de vendas e entregas configurados.';
    }
    case 'catalogo':{
      const {rows}=await pool.query('SELECT p.id,p.name,p.amount,count(s.id)::int units FROM imp_vendedor.products p LEFT JOIN imp_vendedor.stock s ON s.product=p.id AND s.order_id IS NULL WHERE p.active GROUP BY p.id ORDER BY p.id LIMIT 20');
      return '**IMP VENDEDOR — Catálogo**\n'+(rows.map(p=>`#${p.id} · ${p.name} · ${money(p.amount)} · ${p.units} disponível(is)`).join('\n')||'Nenhum produto cadastrado.')+'\n\nUse /comprar para iniciar. '+(!paymentEnabled()?'As vendas aguardam a configuração do Pix.':'');
    }
    case 'comprar':{
      if(!paymentEnabled()) return 'As vendas ainda não foram ativadas. O responsável precisa configurar o provedor Pix.';
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email)) return 'Informe um e-mail válido.';
      const order=await transaction(async db=>{
        // Serialize purchases by buyer to enforce a pending-order limit under concurrency.
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[user]);
        const {rows:[existing]}=await db.query('SELECT * FROM imp_vendedor.orders WHERE id=$1',[i.id]);if(existing)return existing;
        const {rows:[count]}=await db.query("SELECT count(*)::int n FROM imp_vendedor.orders WHERE buyer=$1 AND state IN ('creating','pending')",[user]);
        if(count.n>=3)throw new Error('Você já tem três pedidos pendentes. Consulte-os antes de comprar novamente.');
        const {rows:[p]}=await db.query('SELECT * FROM imp_vendedor.products WHERE id=$1 AND active',[args.produto]);if(!p)throw new Error('Produto não encontrado.');
        const {rows:[stock]}=await db.query('SELECT id FROM imp_vendedor.stock WHERE product=$1 AND order_id IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED',[p.id]);if(!stock)throw new Error('Produto sem estoque.');
        const {rows:[o]}=await db.query('INSERT INTO imp_vendedor.orders(id,buyer,product,name,amount) VALUES($1,$2,$3,$4,$5) RETURNING *',[i.id,user,p.id,p.name,p.amount]);
        await db.query('UPDATE imp_vendedor.stock SET order_id=$2 WHERE id=$1',[stock.id,o.id]);
        await event(db,'purchase',o.id,`🧾 Compra registrada · Pedido ${o.id} · Comprador ${user} · ${p.name} · ${money(p.amount)} · Aguardando pagamento`);return o;
      });
      let payment;
      try{
        payment=await mp('/v1/payments',{transaction_amount:order.amount/100,description:order.name,payment_method_id:'pix',payer:{email:args.email},external_reference:order.id,date_of_expiration:new Date(Date.now()+30*60000).toISOString()},order.id);
      }catch{ return `Pedido ${order.id} registrado. A criação da cobrança está pendente de consulta. Use /verificar com esse número; não faça outro pedido.`; }
      await pool.query("UPDATE imp_vendedor.orders SET payment_id=$2,state='pending' WHERE id=$1 AND state='creating'",[order.id,String(payment.id)]);
      await flushLogs();
      const qr=payment.point_of_interaction?.transaction_data?.qr_code;
      return `**Pedido ${order.id}**\n${order.name} · ${money(order.amount)}\n\nPix copia e cola:\n${qr||'Consulte o pedido com /verificar.'}\n\nApós pagar, use /verificar. A entrega será por mensagem privada. Mantenha suas DMs abertas.`;
    }
    case 'compras':{
      const {rows}=await pool.query('SELECT id,name,amount,state FROM imp_vendedor.orders WHERE buyer=$1 ORDER BY created_at DESC LIMIT 10',[user]);
      return rows.map(o=>`${o.id} · ${o.name} · ${money(o.amount)} · ${o.state}`).join('\n')||'Você ainda não fez compras.';
    }
    case 'verificar':{
      const {rows:[o]}=await pool.query('SELECT * FROM imp_vendedor.orders WHERE id=$1 AND buyer=$2',[args.pedido,user]);if(!o)return 'Pedido não encontrado nas suas compras.';
      let pendingQr;
      if(paymentEnabled() && !['delivered','cancelled'].includes(o.state)){
        if(o.payment_id){const p=await mp('/v1/payments/'+encodeURIComponent(o.payment_id));await reconcile(p);if(p.status==='pending')pendingQr=p.point_of_interaction?.transaction_data?.qr_code;}
        else{
          const search=await mp('/v1/payments/search?external_reference='+encodeURIComponent(o.id));
          for(const found of search.results||[]){const p=await mp('/v1/payments/'+encodeURIComponent(found.id));await reconcile(p);if(p.status==='pending')pendingQr=p.point_of_interaction?.transaction_data?.qr_code;}
        }
      }
      try{await deliver(o.id);}catch{return 'Pagamento aprovado; a entrega está pendente. Abra suas mensagens privadas e use /verificar novamente. Seu produto continua reservado.';}
      await flushLogs();
      const {rows:[current]}=await pool.query('SELECT state FROM imp_vendedor.orders WHERE id=$1',[o.id]);
      return `Pedido ${o.id}: ${current.state}.`+(pendingQr?`\n\nPix copia e cola:\n${pendingQr}`:'');
    }
    default:return 'Comando desconhecido.';
  }
}
function validDiscordSignature(raw,headers){
  try{
    const timestamp=headers.get('x-signature-timestamp');const sig=headers.get('x-signature-ed25519');
    if(!timestamp||!sig||Math.abs(Date.now()/1000-Number(timestamp))>300)return false;
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(env.DISCORD_PUBLIC_KEY,'hex')]),format:'der',type:'spki'});
    return verify(null,Buffer.from(timestamp+raw),key,Buffer.from(sig,'hex'));
  }catch{return false;}
}
function validWebhook(url,headers){
  const id=url.searchParams.get('data.id');const request=headers.get('x-request-id');
  const parts=Object.fromEntries((headers.get('x-signature')||'').split(',').map(x=>x.trim().split('=')));
  if(!id||!request||!parts.ts||!parts.v1||!/^\d+$/.test(id))return false;
  const digest=createHmac('sha256',env.MP_WEBHOOK_SECRET).update(`id:${id.toLowerCase()};request-id:${request};ts:${parts.ts};`).digest();
  const received=Buffer.from(parts.v1,'hex');return digest.length===received.length&&timingSafeEqual(digest,received);
}
let ready=false;
if(!missing.length){
  await pool.query(schema);
  await discord(`/applications/${env.DISCORD_CLIENT_ID}/guilds/${env.GUILD_ID}/commands`,commands,'PUT');
  ready=true;
}
Bun.serve({port:Number(env.PORT||8080),async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/health')return Response.json({service:'IMP Vendedor',configured:ready,paymentsEnabled:Boolean(paymentEnabled()),missing});
  if(url.pathname==='/' && request.method==='GET')return new Response('IMP Vendedor — Serviço de vendas digitais. Configuração administrativa no Discord.',{headers:{'Content-Type':'text/plain; charset=utf-8'}});
  if(!ready)return new Response('Configuração pendente', {status:503});
  if(url.pathname==='/interactions' && request.method==='POST'){
    const raw=await request.text();if(raw.length>64000||!validDiscordSignature(raw,request.headers))return new Response('Unauthorized',{status:401});
    let i;try{i=JSON.parse(raw);}catch{return new Response('Bad request',{status:400});}
    if(i.type===1)return Response.json({type:1});
    if(i.type!==2||i.guild_id!==env.GUILD_ID)return new Response('Forbidden',{status:403});
    // Deferred private response keeps stock and payer details out of public channels.
    void execute(i).then(content=>discord(`/webhooks/${env.DISCORD_CLIENT_ID}/${i.token}/messages/@original`,{content:content.slice(0,1950),allowed_mentions:{parse:[]}},'PATCH')).catch(async error=>{
      console.error('Falha no comando',i.id,error instanceof Error?error.message:'unknown');
      try{await discord(`/webhooks/${env.DISCORD_CLIENT_ID}/${i.token}/messages/@original`,{content:'Não foi possível concluir. Consulte /compras ou tente /verificar. '+(['Produto sem estoque.','Produto não encontrado.'].includes(error.message)?error.message:''),allowed_mentions:{parse:[]}},'PATCH');}catch{console.error('Resposta indisponível',i.id);}
    });
    return Response.json({type:5,data:{flags:64}});
  }
  if(url.pathname==='/webhooks/mercadopago' && request.method==='POST'){
    if(!paymentEnabled()||!validWebhook(url,request.headers))return new Response('Unauthorized',{status:401});
    try{await reconcile(await mp('/v1/payments/'+encodeURIComponent(url.searchParams.get('data.id'))));return new Response('OK');}catch{console.error('Webhook pendente');return new Response('Retry',{status:503});}
  }
  return new Response('Not found',{status:404});
}});
