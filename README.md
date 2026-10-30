# IMP Vendedor

Bot Discord de produtos digitais em TypeScript/Bun + Postgres. Cada unidade do estoque é um texto, código ou link de até 1.400 caracteres; arquivos devem ser entregues por link. Respostas de compras são privadas. O estoque é reservado em transação para evitar vender a mesma unidade para duas pessoas.

## Estado da entrega

Código inicial implementado. A tentativa de criar o serviço no projeto Railway que contém novara-dashboard foi bloqueada pelo limite de recursos do plano. Nenhum serviço foi publicado. O bot não usa o token do Novara. Não está operacional até liberar capacidade de hospedagem e configurar uma aplicação Discord própria, servidor, banco e provedor de pagamento. Uma implantação sem credenciais responde em /health com configured=false e não aceita interações.

## Configuração Discord

1. Crie uma aplicação IMP Vendedor no Discord Developer Portal. Copie o token do bot, Application ID e Public Key diretamente para as variáveis Railway DISCORD_TOKEN, DISCORD_CLIENT_ID e DISCORD_PUBLIC_KEY. Não publique tokens no chat ou no código.
2. Defina GUILD_ID com o ID do servidor de vendas. Convide a aplicação com os escopos bot e applications.commands. Permissões necessárias: visualizar canais, enviar mensagens e ler histórico nos canais de logs; não precisa Administrador nem Message Content Intent.
3. Após o deploy com variáveis completas, os comandos são registrados no servidor. Defina a Interactions Endpoint URL da aplicação como https://DOMINIO-DO-SERVICO/interactions.
4. Configure canais privados com /logs e valide as permissões. O bot não muda as permissões dos canais.
5. Cadastre produtos com /produto e unidades com /estoque. Em centavos, 1290 significa R$12,90. O conteúdo do estoque não é enviado aos logs.

DATABASE_URL deve apontar para Postgres. O bot cria apenas o schema imp_vendedor, sem alterar tabelas Novara ou CGEx.

## Pix

PAYMENT_PROVIDER=disabled mantém vendas bloqueadas. Nenhuma cobrança é gerada nesse modo.

Um adaptador opcional Mercado Pago está implementado, mas a escolha do provedor ainda está pendente. Para adotá-lo, configure PAYMENT_PROVIDER=mercadopago, MP_ACCESS_TOKEN, MP_COLLECTOR_ID (ID da conta recebedora) e MP_WEBHOOK_SECRET. Cadastre no painel da aplicação Mercado Pago o webhook de Payments https://DOMINIO-DO-SERVICO/webhooks/mercadopago. A conta recebedora é a conta vinculada ao access token: não há repasse para uma chave Pix arbitrária. Outro banco exige seu próprio adaptador/API.

O bot gera Pix com referência única por pedido e chave de idempotência; confere a assinatura do webhook e consulta o pagamento na API. Só entrega com approved, Pix, BRL, referência, valor, recebedor e live_mode=true correspondentes. Comprovantes enviados por compradores não aprovam pedidos. /verificar também consulta a API e permite recuperar entregas pendentes sem depender de um novo webhook.

## Comandos

- /catalogo: produtos e unidades disponíveis.
- /comprar produto email: reserva unidade e gera cobrança Pix.
- /compras: últimas dez compras do próprio usuário.
- /verificar pedido: consulta pagamento e tenta entregar por DM.
- /produto nome centavos: cadastro, exige Gerenciar Servidor ou Administrador.
- /estoque produto conteudo: inclui uma unidade, mesma permissão.
- /logs vendas entregas: canais de registros, mesma permissão.

## Operação e limites

- O registro de compra e os logs são persistidos. Logs com falha ficam pendentes e são tentados na próxima operação relacionada. Não há worker de retentativa contínua.
- DMs bloqueadas mantêm o pedido pago e o produto reservado. Após abrir as DMs, o comprador usa /verificar para tentar novamente.
- A entrega tem lock por pedido, mensagem salva e nonce Discord para reduzir duplicatas. Uma queda entre envio e commit pode exigir conferência manual; não há garantia absoluta de entrega exatamente uma vez.
- Até três pedidos pendentes por comprador. O Pix vence em 30 minutos, mas a unidade só é liberada após consulta à API confirmar cancelled ou rejected. Sem webhook/consulta, pode permanecer reservada. Não há rotina de limpeza de reservas.
- Se houver timeout na criação da cobrança, não libere a reserva sem consultar a API: o pagamento pode ter sido criado. /verificar busca pela referência. Se a API confirmar que não há pagamento, o responsável precisa corrigir o pedido no banco; ainda não há comando administrativo para esse caso.
- Reembolsos, chargebacks, cupons, upload de arquivos, edição/desativação de produtos e dashboard web não estão implementados. A administração é pelos comandos Discord.
- Conteúdos de estoque são dados privados no banco: restrinja acesso e configure backups no provedor.
- Antes de abrir vendas reais, valide no servidor: permissões, assinatura Discord, estoque concorrente, pagamento pendente/aprovado/incorreto, webhook repetido, DM fechada e recuperação. Os testes locais cobrem a validação de pagamento, não substituem esses testes com as credenciais finais.

## Execução

Instale Bun, copie .env.example para .env e preencha suas variáveis. Execute bun install e bun run index.ts. Para Railway Functions, use o conteúdo completo de index.ts; não depende de arquivos locais.

Validação local: npm test. O adaptador é integrado ao arquivo da função; os testes leem a função de validação do próprio index.ts.

Descrição sugerida: Seu assistente de compras digitais: pagamentos via Pix, confirmação automática e entregas organizadas. Consulte seus pedidos e acompanhe cada etapa com o IMP Vendedor.
