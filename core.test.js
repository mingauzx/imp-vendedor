import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const functionText=source.match(/function approvedPayment\(payment, order, collectorId\) \{[\s\S]*?\n\}/)[0];
const approvedPayment=new Function(functionText+'; return approvedPayment;')();
const order={id:'order-1',amount:1290};
const payment={status:'approved',payment_method_id:'pix',currency_id:'BRL',external_reference:'order-1',transaction_amount:12.9,collector_id:123,live_mode:true};
test('accepts the matching live Pix payment',()=>assert.equal(approvedPayment(payment,order,'123'),true));
for(const [field,value] of Object.entries({status:'pending',payment_method_id:'credit_card',currency_id:'USD',external_reference:'other-order',transaction_amount:1,collector_id:456,live_mode:false})) {
  test(`rejects mismatched ${field}`,()=>assert.equal(approvedPayment({...payment,[field]:value},order,'123'),false));
}
