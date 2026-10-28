'use strict';

// Additive commerce state. Existing products remain untracked until an operator
// records a physical count; historical approved orders are never rewritten.
function initializeCommerce(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS commerce_inventory (
  product_id TEXT PRIMARY KEY REFERENCES products(id),
  tracked INTEGER NOT NULL DEFAULT 0 CHECK(tracked IN (0,1)),
  on_hand_quantity INTEGER NOT NULL DEFAULT 0 CHECK(on_hand_quantity >= 0),
  reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK(reserved_quantity >= 0),
  updated_at TEXT NOT NULL,
  CHECK(reserved_quantity <= on_hand_quantity)
);
CREATE TABLE IF NOT EXISTS commerce_reservations (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  status TEXT NOT NULL CHECK(status IN ('Untracked','Reserved','Released','Committed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commerce_inventory_events (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  kind TEXT NOT NULL CHECK(kind IN ('adjustment','reserve','release','commit')),
  on_hand_change INTEGER NOT NULL,
  reserved_change INTEGER NOT NULL,
  tracked_after INTEGER NOT NULL CHECK(tracked_after IN (0,1)),
  order_id TEXT REFERENCES orders(id),
  reference TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(product_id,kind,reference)
);
CREATE TRIGGER IF NOT EXISTS commerce_inventory_events_no_update BEFORE UPDATE ON commerce_inventory_events BEGIN SELECT RAISE(ABORT,'Inventory events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS commerce_inventory_events_no_delete BEFORE DELETE ON commerce_inventory_events BEGIN SELECT RAISE(ABORT,'Inventory events are immutable'); END;
CREATE TABLE IF NOT EXISTS commerce_fulfilments (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  status TEXT NOT NULL CHECK(status IN ('Dispatched','Delivered')),
  carrier TEXT NOT NULL,
  tracking_reference TEXT NOT NULL,
  dispatched_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS commerce_fulfilment_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL CHECK(status IN ('Dispatched','Delivered')),
  carrier TEXT NOT NULL,
  tracking_reference TEXT NOT NULL,
  reference TEXT NOT NULL,
  actor TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(order_id,status)
);
CREATE TRIGGER IF NOT EXISTS commerce_fulfilment_events_no_update BEFORE UPDATE ON commerce_fulfilment_events BEGIN SELECT RAISE(ABORT,'Fulfilment events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS commerce_fulfilment_events_no_delete BEFORE DELETE ON commerce_fulfilment_events BEGIN SELECT RAISE(ABORT,'Fulfilment events are immutable'); END;
CREATE TABLE IF NOT EXISTS commerce_cancellations (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS commerce_cancellations_no_update BEFORE UPDATE ON commerce_cancellations BEGIN SELECT RAISE(ABORT,'Cancellation records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS commerce_cancellations_no_delete BEFORE DELETE ON commerce_cancellations BEGIN SELECT RAISE(ABORT,'Cancellation records are immutable'); END;
`);
}

function createCommerce(ctx) {
  const {db,fail,text,integer,safeId,find,transaction,auditAction,writeLedger,send,consumeOnce,member,admin,now,id}=ctx;
  const MAX_QUANTITY=1000000000;
  function inventory(productId) {
    return db.prepare('SELECT * FROM commerce_inventory WHERE product_id=?').get(productId) || {product_id:productId,tracked:0,on_hand_quantity:0,reserved_quantity:0};
  }
  function ensureInventory(productId) {
    db.prepare('INSERT OR IGNORE INTO commerce_inventory(product_id,updated_at) VALUES(?,?)').run(productId,now());
    return inventory(productId);
  }
  function event(productId,kind,handChange,reservedChange,tracked,orderId,reference,reason,user) {
    db.prepare('INSERT INTO commerce_inventory_events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id('STOCK'),productId,kind,handChange,reservedChange,tracked?1:0,orderId||null,reference,reason,user?.id||null,now());
  }
  function storedOrder(value) {
    const orderId=typeof value==='string'?value:value?.id;
    if(typeof orderId!=='string')fail(400,'A saved order is required.');
    return find('orders',orderId);
  }
  // Hooks deliberately do not open transactions: callers must include them in
  // the same immediate transaction as the order and wallet/BV changes.
  function reserveOrder(value,user=null) {
    if(!db.isTransaction)throw new Error('Inventory reservation requires the order transaction.');
    const order=storedOrder(value);
    if(order.status!=='Pending')fail(409,'Only a pending order can reserve inventory.');
    const prior=db.prepare('SELECT * FROM commerce_reservations WHERE order_id=?').get(order.id);
    if(prior) {
      if(prior.product_id===order.product_id&&prior.quantity===order.quantity&&['Reserved','Untracked'].includes(prior.status))return;
      fail(409,'This order inventory reservation has already been processed.');
    }
    const stock=ensureInventory(order.product_id);
    if(stock.tracked&&stock.on_hand_quantity-stock.reserved_quantity<order.quantity)fail(409,'Insufficient available stock for this order.','insufficient_stock');
    if(stock.tracked)db.prepare('UPDATE commerce_inventory SET reserved_quantity=reserved_quantity+?,updated_at=? WHERE product_id=?').run(order.quantity,now(),order.product_id);
    db.prepare('INSERT INTO commerce_reservations VALUES(?,?,?,?,?,?)').run(order.id,order.product_id,order.quantity,stock.tracked?'Reserved':'Untracked',now(),now());
    event(order.product_id,'reserve',0,stock.tracked?order.quantity:0,stock.tracked,order.id,order.id,'Order inventory reservation',user);
  }
  function releaseOrder(value,user=null) {
    if(!db.isTransaction)throw new Error('Inventory release requires the order transaction.');
    const order=storedOrder(value);
    if(!['Pending','Rejected'].includes(order.status))fail(409,'Approved orders cannot release inventory through cancellation.');
    const stock=ensureInventory(order.product_id);
    const prior=db.prepare('SELECT * FROM commerce_reservations WHERE order_id=?').get(order.id);
    if(prior&&['Released','Committed'].includes(prior.status))fail(409,'This inventory reservation has already been processed.');
    if(!prior&&stock.tracked)fail(409,'This order has no tracked reservation. An inventory reconciliation is required.');
    if(prior?.status==='Reserved') {
      if(stock.reserved_quantity<prior.quantity)fail(409,'Reserved stock requires an integrity review.');
      db.prepare('UPDATE commerce_inventory SET reserved_quantity=reserved_quantity-?,updated_at=? WHERE product_id=?').run(prior.quantity,now(),order.product_id);
    }
    if(prior)db.prepare("UPDATE commerce_reservations SET status='Released',updated_at=? WHERE order_id=?").run(now(),order.id);
    else db.prepare('INSERT INTO commerce_reservations VALUES(?,?,?,?,?,?)').run(order.id,order.product_id,order.quantity,'Released',now(),now());
    event(order.product_id,'release',0,prior?.status==='Reserved'?-prior.quantity:0,stock.tracked,order.id,order.id,'Pending order inventory released',user);
  }
  function commitOrder(value,user=null) {
    if(!db.isTransaction)throw new Error('Inventory commit requires the order transaction.');
    const order=storedOrder(value);
    if(order.status!=='Approved')fail(409,'Only an approved order can commit inventory.');
    const stock=ensureInventory(order.product_id);
    const prior=db.prepare('SELECT * FROM commerce_reservations WHERE order_id=?').get(order.id);
    if(prior&&['Released','Committed'].includes(prior.status))fail(409,'This inventory reservation has already been processed.');
    if(!prior&&stock.tracked)fail(409,'This order has no tracked reservation. An inventory reconciliation is required.');
    if(prior?.status==='Reserved') {
      if(stock.reserved_quantity<prior.quantity||stock.on_hand_quantity<prior.quantity)fail(409,'Reserved stock requires an integrity review.');
      db.prepare('UPDATE commerce_inventory SET on_hand_quantity=on_hand_quantity-?,reserved_quantity=reserved_quantity-?,updated_at=? WHERE product_id=?').run(prior.quantity,prior.quantity,now(),order.product_id);
    }
    if(prior)db.prepare("UPDATE commerce_reservations SET status='Committed',updated_at=? WHERE order_id=?").run(now(),order.id);
    else db.prepare('INSERT INTO commerce_reservations VALUES(?,?,?,?,?,?)').run(order.id,order.product_id,order.quantity,'Committed',now(),now());
    event(order.product_id,'commit',prior?.status==='Reserved'?-prior.quantity:0,prior?.status==='Reserved'?-prior.quantity:0,stock.tracked,order.id,order.id,'Approved order inventory committed',user);
  }
  function enrichProducts(rows) {
    return rows.map(row=>{const stock=inventory(row.id);return {...row,stock_tracked:!!stock.tracked,available_quantity:stock.tracked?stock.on_hand_quantity-stock.reserved_quantity:null};});
  }
  function enrichOrders(rows) {
    return rows.map(row=>{const fulfilment=db.prepare('SELECT * FROM commerce_fulfilments WHERE order_id=?').get(row.id),cancellation=db.prepare('SELECT reason,created_at FROM commerce_cancellations WHERE order_id=?').get(row.id);return {...row,fulfilment_status:fulfilment?.status||(row.status==='Approved'?'Pending':null),carrier:fulfilment?.carrier||null,tracking_reference:fulfilment?.tracking_reference||null,dispatched_at:fulfilment?.dispatched_at||null,delivered_at:fulfilment?.delivered_at||null,cancelled_at:cancellation?.created_at||null,cancellation_reason:cancellation?.reason||null};});
  }
  function stockRows() {
    return db.prepare('SELECT id FROM products ORDER BY name,id').all().map(p=>{const stock=inventory(p.id);return {product_id:p.id,stock_tracked:!!stock.tracked,on_hand_quantity:stock.on_hand_quantity,reserved_quantity:stock.reserved_quantity,available_quantity:stock.tracked?stock.on_hand_quantity-stock.reserved_quantity:null};});
  }
  function adjustInventory(req,user,route,body) {
    admin(user);
    const productId=safeId(body.product_id);
    const change=integer(body.adjustment_quantity===undefined?0:body.adjustment_quantity,'Stock adjustment',-MAX_QUANTITY,MAX_QUANTITY);
    if(body.tracked!==undefined&&typeof body.tracked!=='boolean')fail(400,'tracked must be true or false.');
    const reference=text(body.reference,'Stock reference',200),reason=text(body.reason,'Stock adjustment reason',1000);
    return consumeOnce(req,user,route,body,()=>{
      find('products',productId);
      const stock=ensureInventory(productId),tracked=body.tracked===undefined?!!stock.tracked:body.tracked;
      if(!change&&tracked===!!stock.tracked)fail(409,'No inventory change was requested.');
      const nextHand=stock.on_hand_quantity+change;
      if(!Number.isSafeInteger(nextHand)||nextHand<0||nextHand>MAX_QUANTITY)fail(409,'The stock adjustment would create an invalid physical count.');
      if(!tracked&&stock.reserved_quantity>0)fail(409,'Release or process all reserved orders before disabling stock tracking.');
      let nextReserved=stock.reserved_quantity;
      if(tracked&&!stock.tracked) {
        const pending=db.prepare("SELECT * FROM orders WHERE product_id=? AND status='Pending' ORDER BY created_at,id").all(productId);
        nextReserved=pending.reduce((total,order)=>total+order.quantity,0);
        if(nextHand<nextReserved)fail(409,'The physical stock count cannot cover existing pending orders.');
        // Once tracking starts, every currently pending order must hold stock,
        // including records created before this additive module existed.
        for(const order of pending) {
          const reservation=db.prepare('SELECT * FROM commerce_reservations WHERE order_id=?').get(order.id);
          if(reservation&&reservation.status!=='Untracked')fail(409,'Pending orders require an inventory integrity review.');
          if(reservation)db.prepare("UPDATE commerce_reservations SET status='Reserved',updated_at=? WHERE order_id=?").run(now(),order.id);
          else db.prepare('INSERT INTO commerce_reservations VALUES(?,?,?,?,?,?)').run(order.id,productId,order.quantity,'Reserved',now(),now());
        }
      }
      if(nextHand<nextReserved)fail(409,'The stock adjustment would consume inventory reserved for pending orders.');
      db.prepare('UPDATE commerce_inventory SET tracked=?,on_hand_quantity=?,reserved_quantity=?,updated_at=? WHERE product_id=?').run(tracked?1:0,nextHand,nextReserved,now(),productId);
      event(productId,'adjustment',change,nextReserved-stock.reserved_quantity,tracked,null,reference,reason,user);
      auditAction(user,'inventory_adjusted',productId,{adjustment_quantity:change,tracked,on_hand_quantity:nextHand,reserved_quantity:nextReserved,reference,reason});
      return {ok:true,product_id:productId,stock_tracked:tracked,on_hand_quantity:nextHand,reserved_quantity:nextReserved,available_quantity:tracked?nextHand-nextReserved:null};
    });
  }
  function cancelOrder(req,user,route,body,orderId) {
    const owner=member(user),reason=text(body.reason,'Cancellation reason',1000);
    return consumeOnce(req,user,route,body,()=>{
      const order=find('orders',orderId);
      if(order.member_id!==owner)fail(404,'Order not found.');
      if(order.status!=='Pending')fail(409,'Only your pending orders can be cancelled.');
      const at=now();
      db.prepare("UPDATE orders SET status='Rejected',reason=?,reviewed_at=? WHERE id=? AND status='Pending'").run('Member cancellation: '+reason,at,order.id);
      releaseOrder(order,user);
      writeLedger(owner,'purchase','order_release',order.amount_paise,order.id,'Member-cancelled pending purchase reservation released');
      db.prepare('INSERT INTO commerce_cancellations VALUES(?,?,?,?,?)').run(order.id,owner,reason,user.id,at);
      auditAction(user,'order_cancelled',order.id,{reason,amount_paise:order.amount_paise});
      return {ok:true,id:order.id,status:'Rejected',cancelled_at:at};
    });
  }
  function fulfilOrder(req,user,route,body,orderId) {
    admin(user);
    if(!['Dispatched','Delivered'].includes(body.status))fail(400,'Fulfilment status must be Dispatched or Delivered.');
    return consumeOnce(req,user,route,body,()=>{
      const order=find('orders',orderId);
      if(order.status!=='Approved')fail(409,'Only approved orders can be dispatched or delivered.');
      const previous=db.prepare('SELECT * FROM commerce_fulfilments WHERE order_id=?').get(order.id);
      if(body.status==='Dispatched'&&previous)fail(409,'This order has already been dispatched.');
      if(body.status==='Delivered'&&previous?.status!=='Dispatched')fail(409,'Dispatch must be recorded once before delivery.');
      const carrier=body.status==='Dispatched'?text(body.carrier,'Carrier name',150):previous.carrier;
      const tracking=body.status==='Dispatched'?text(body.tracking_reference,'Tracking reference',200):previous.tracking_reference;
      if(body.status==='Delivered'&&(body.carrier!==undefined&&body.carrier!==carrier||body.tracking_reference!==undefined&&body.tracking_reference!==tracking))fail(409,'Delivery must retain the recorded carrier and tracking reference.');
      const reference=text(body.reference||tracking,'Fulfilment evidence reference',200),at=now();
      if(body.status==='Dispatched')db.prepare('INSERT INTO commerce_fulfilments VALUES(?,?,?,?,?,?)').run(order.id,'Dispatched',carrier,tracking,at,null);
      else db.prepare("UPDATE commerce_fulfilments SET status='Delivered',delivered_at=? WHERE order_id=?").run(at,order.id);
      db.prepare('INSERT INTO commerce_fulfilment_events VALUES(?,?,?,?,?,?,?,?)').run(id('SHIP'),order.id,body.status,carrier,tracking,reference,user.id,at);
      auditAction(user,'order_'+body.status.toLowerCase(),order.id,{carrier,tracking_reference:tracking,reference});
      return {ok:true,id:order.id,fulfilment_status:body.status,carrier,tracking_reference:tracking,dispatched_at:previous?.dispatched_at||at,delivered_at:body.status==='Delivered'?at:null};
    });
  }
  function handle(req,res,route,method,body,user) {
    if(route==='/api/admin/inventory'&&method==='GET') {
      admin(user);
      send(res,200,{inventory:stockRows(),events:db.prepare('SELECT * FROM commerce_inventory_events ORDER BY created_at DESC,id LIMIT 200').all()});return true;
    }
    if(route==='/api/admin/inventory'&&method==='POST') {send(res,200,adjustInventory(req,user,route,body));return true;}
    let match;
    if((match=route.match(/^\/api\/orders\/([^/]+)\/cancel$/))&&method==='POST') {send(res,200,cancelOrder(req,user,route,body,match[1]));return true;}
    if((match=route.match(/^\/api\/admin\/orders\/([^/]+)\/fulfilment$/))&&method==='POST') {send(res,200,fulfilOrder(req,user,route,body,match[1]));return true;}
    if((match=route.match(/^\/api\/orders\/([^/]+)$/))&&method==='GET') {
      const order=find('orders',match[1]);if(user.role!=='admin'&&order.member_id!==member(user))fail(404,'Order not found.');
      send(res,200,{order:enrichOrders([order])[0]});return true;
    }
    return false;
  }
  return {handle,reserveOrder,releaseOrder,commitOrder,enrichProducts,enrichOrders};
}

module.exports={initializeCommerce,createCommerce};
