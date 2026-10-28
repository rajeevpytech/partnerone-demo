'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {openDatabase}=require('../server/db');
const {initializeCommerce}=require('../server/commerce');
const {fixture}=require('./helpers');

async function configuredShop(t,{stock=null}={}) {
  const f=await fixture(t);
  const owner=await f.createMember('OWNER'),other=await f.createMember('OTHER','OWNER','left');
  await f.configure();
  assert.equal((await f.post('/api/admin/products',{id:'PRODUCT',name:'Verified test product',description:'Test fixture only',price_paise:10000,bv:1000})).status,201);
  const funding=await f.post('/api/funding',{amount_paise:100000,reference:'TEST-TRANSFER-OWNER'},owner);
  assert.equal(funding.status,201);
  assert.equal((await f.post('/api/admin/funding/'+funding.body.id+'/review',{decision:'approve',reference:'TEST-BANK-OWNER'})).status,200);
  if(stock!==null)assert.equal((await f.post('/api/admin/inventory',{product_id:'PRODUCT',tracked:true,adjustment_quantity:stock,reference:'OPENING-COUNT',reason:'Verified opening sellable stock'})).status,200);
  return {...f,owner,other};
}

test('commerce migration is additive and repeatable; existing products remain untracked',()=>{
  const db=openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO products VALUES(?,?,?,?,?,?,?)').run('EXISTING','Existing product','No invented inventory',25000,1000,1,new Date().toISOString());
    const before=db.prepare('PRAGMA user_version').get().user_version;
    initializeCommerce(db);initializeCommerce(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM commerce_inventory').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger').get().n,0);
  } finally {db.close();}
});

test('enabling tracking covers existing pending orders atomically and rejection releases stock once',async t=>{
  const f=await configuredShop(t);
  const order=await f.post('/api/orders',{product_id:'PRODUCT',quantity:2},f.owner);
  assert.equal(order.status,201,JSON.stringify(order.body));
  let pub=await f.request('/api/public');
  assert.equal(pub.body.products[0].stock_tracked,false);
  assert.equal(pub.body.products[0].available_quantity,null);
  assert.equal((await f.post('/api/admin/inventory',{product_id:'PRODUCT',tracked:true,adjustment_quantity:1,reference:'BAD-OPEN',reason:'Count too small for commitments'})).status,409);
  let inv=await f.request('/api/admin/inventory',{auth:f.admin});
  assert.equal(inv.body.inventory[0].stock_tracked,false);
  assert.equal(inv.body.inventory[0].on_hand_quantity,0);
  const enabled=await f.post('/api/admin/inventory',{product_id:'PRODUCT',tracked:true,adjustment_quantity:5,reference:'GOOD-OPEN',reason:'Physical count excludes historical approved obligations'},f.admin,{'Idempotency-Key':'enable-stock'});
  assert.equal(enabled.status,200,JSON.stringify(enabled.body));
  assert.equal(enabled.body.reserved_quantity,2);assert.equal(enabled.body.available_quantity,3);
  assert.equal((await f.post('/api/admin/inventory',{product_id:'PRODUCT',tracked:false,adjustment_quantity:0,reference:'DISABLE-BAD',reason:'Cannot disable existing reservations'})).status,409);
  assert.equal((await f.post('/api/admin/inventory',{product_id:'PRODUCT',adjustment_quantity:-4,reference:'DEDUCT-BAD',reason:'Would consume reserved inventory'})).status,409);
  assert.equal((await f.post('/api/admin/orders/'+order.body.id+'/review',{decision:'reject',reason:'Customer review rejected'})).status,200);
  assert.equal((await f.post('/api/admin/orders/'+order.body.id+'/review',{decision:'reject',reason:'Repeated rejection'})).status,409);
  inv=await f.request('/api/admin/inventory',{auth:f.admin});
  assert.equal(inv.body.inventory[0].on_hand_quantity,5);assert.equal(inv.body.inventory[0].reserved_quantity,0);assert.equal(inv.body.inventory[0].available_quantity,5);
  const boot=(await f.request('/api/bootstrap',{auth:f.owner})).body;
  assert.equal(boot.summary.purchase_balance_paise,100000);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='order_release'").get().n,1);
  assert.throws(()=>f.db.prepare('DELETE FROM commerce_inventory_events').run(),/immutable/);
  assert.equal((await f.request('/api/public')).body.products[0].reference,undefined);
});

test('concurrent purchase requests cannot oversell and pending member cancellation restores funds and stock once',async t=>{
  const f=await configuredShop(t,{stock:1});
  const attempts=await Promise.all([
    f.post('/api/orders',{product_id:'PRODUCT',quantity:1},f.owner,{'Idempotency-Key':'buy-one-A'}),
    f.post('/api/orders',{product_id:'PRODUCT',quantity:1},f.owner,{'Idempotency-Key':'buy-one-B'})
  ]);
  assert.deepEqual(attempts.map(r=>r.status).sort(),[201,409]);
  const orderId=attempts.find(r=>r.status===201).body.id;
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get().n,1);
  assert.equal((await f.request('/api/bootstrap',{auth:f.owner})).body.summary.purchase_balance_paise,90000);
  assert.equal((await f.post('/api/orders/'+orderId+'/cancel',{reason:'Unauthorized sibling'},f.other)).status,404);
  assert.equal((await f.request('/api/orders/'+orderId,{auth:f.other})).status,404);
  const cancellation=await f.post('/api/orders/'+orderId+'/cancel',{reason:'Member changed their purchase decision'},f.owner,{'Idempotency-Key':'cancel-once'});
  assert.equal(cancellation.status,200,JSON.stringify(cancellation.body));
  const replay=await f.post('/api/orders/'+orderId+'/cancel',{reason:'Member changed their purchase decision'},f.owner,{'Idempotency-Key':'cancel-once'});
  assert.equal(replay.status,200);assert.equal(replay.body.cancelled_at,cancellation.body.cancelled_at);
  assert.equal((await f.post('/api/orders/'+orderId+'/cancel',{reason:'Another cancellation'},f.owner)).status,409);
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/review',{decision:'approve',reference:'TOO-LATE'})).status,409);
  const inv=(await f.request('/api/admin/inventory',{auth:f.admin})).body.inventory[0];
  assert.equal(inv.available_quantity,1);assert.equal(inv.reserved_quantity,0);assert.equal(inv.on_hand_quantity,1);
  const boot=(await f.request('/api/bootstrap',{auth:f.owner})).body;
  assert.equal(boot.summary.purchase_balance_paise,100000);
  assert.equal(boot.orders[0].status,'Rejected');assert.ok(boot.orders[0].cancelled_at);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='order_release'").get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM commerce_cancellations').get().n,1);
});

test('approved orders commit stock once and fulfilment requires administrator dispatch before delivery',async t=>{
  const f=await configuredShop(t,{stock:2});
  const placed=await f.post('/api/orders',{product_id:'PRODUCT',quantity:1},f.owner);
  assert.equal(placed.status,201);const orderId=placed.body.id;
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/fulfilment',{status:'Dispatched',carrier:'Carrier',tracking_reference:'TRACK-1'})).status,409);
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/review',{decision:'approve',reference:'INVOICE-1'})).status,200);
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/review',{decision:'approve',reference:'INVOICE-1'})).status,409);
  let inv=(await f.request('/api/admin/inventory',{auth:f.admin})).body.inventory[0];
  assert.equal(inv.on_hand_quantity,1);assert.equal(inv.reserved_quantity,0);assert.equal(inv.available_quantity,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM commerce_inventory_events WHERE kind='commit'").get().n,1);
  assert.equal((await f.post('/api/orders/'+orderId+'/cancel',{reason:'Cannot cancel approved order'},f.owner)).status,409);
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/fulfilment',{status:'Delivered'})).status,409);
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/fulfilment',{status:'Dispatched',carrier:'Carrier',tracking_reference:'TRACK-1'},f.owner)).status,403);
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/fulfilment',{status:'Dispatched',carrier:'Carrier'})).status,400);
  const body={status:'Dispatched',carrier:'Verified carrier',tracking_reference:'TRACK-1'};
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/fulfilment',body,f.admin,{'Idempotency-Key':'dispatch-once'})).status,200);
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/fulfilment',body,f.admin,{'Idempotency-Key':'dispatch-once'})).status,200);
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/fulfilment',body)).status,409);
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/fulfilment',{status:'Delivered',tracking_reference:'CHANGED'})).status,409);
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/fulfilment',{status:'Delivered',carrier:'Verified carrier',tracking_reference:'TRACK-1'})).status,200);
  assert.equal((await f.post('/api/admin/orders/'+orderId+'/fulfilment',{status:'Delivered'})).status,409);
  const saved=(await f.request('/api/orders/'+orderId,{auth:f.owner})).body.order;
  assert.equal(saved.fulfilment_status,'Delivered');assert.equal(saved.carrier,'Verified carrier');assert.ok(saved.dispatched_at);assert.ok(saved.delivered_at);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM commerce_fulfilment_events').get().n,2);
  assert.throws(()=>f.db.prepare("UPDATE commerce_fulfilment_events SET status='Delivered'").run(),/immutable/);
  inv=(await f.request('/api/admin/inventory',{auth:f.admin})).body.inventory[0];assert.equal(inv.on_hand_quantity,1);
  assert.equal((await f.request('/api/admin/inventory',{auth:f.owner})).status,403);
});

test('stock references and idempotency guards reject duplicate or invalid adjustments',async t=>{
  const f=await configuredShop(t);
  const adjustment={product_id:'PRODUCT',tracked:true,adjustment_quantity:10,reference:'RECEIPT-1',reason:'Verified receiving count'};
  const first=await f.post('/api/admin/inventory',adjustment,f.admin,{'Idempotency-Key':'receipt-one'});assert.equal(first.status,200);
  assert.equal((await f.post('/api/admin/inventory',adjustment,f.admin,{'Idempotency-Key':'receipt-one'})).status,200);
  assert.equal((await f.post('/api/admin/inventory',adjustment)).status,409);
  assert.equal((await f.post('/api/admin/inventory',{...adjustment,adjustment_quantity:11},f.admin,{'Idempotency-Key':'receipt-one'})).status,409);
  assert.equal((await f.post('/api/admin/inventory',{product_id:'PRODUCT',adjustment_quantity:0,reference:'NO-CHANGE',reason:'No actual change'})).status,409);
  assert.equal((await f.post('/api/admin/inventory',{product_id:'PRODUCT',adjustment_quantity:0.5,reference:'FRACTION',reason:'Invalid fractional stock'})).status,400);
  assert.equal((await f.post('/api/admin/inventory',{product_id:'PRODUCT',adjustment_quantity:-11,reference:'NEGATIVE',reason:'Invalid negative physical stock'})).status,409);
  assert.equal((await f.post('/api/admin/inventory',{product_id:'PRODUCT',tracked:'yes',adjustment_quantity:0,reference:'BOOL',reason:'Invalid boolean'})).status,400);
  assert.equal((await f.post('/api/admin/inventory',{product_id:'PRODUCT',adjustment_quantity:1,reference:'',reason:'Missing evidence'})).status,400);
  assert.equal((await f.post('/api/admin/inventory',adjustment,f.owner)).status,403);
  const inv=(await f.request('/api/admin/inventory',{auth:f.admin})).body.inventory[0];
  assert.equal(inv.on_hand_quantity,10);assert.equal(inv.available_quantity,10);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM commerce_inventory_events WHERE kind='adjustment'").get().n,1);
});
