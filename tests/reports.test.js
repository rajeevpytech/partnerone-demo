'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {openDatabase,transaction,ledger}=require('../server/db');
const {initializeReports,captureClosing,createReports,savedPeriod}=require('../server/reports');

const approvedPlan={approved:true,pair_bv:1000,pair_income_paise:10000,max_pairs_per_closing:2,profit_share_bps:5000,approval_reference:'Approved source plan 1'};

function fixture(t){
  const db=openDatabase(':memory:');
  t.after(()=>db.close());
  initializeReports(db);
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)').run('ADMIN','administrator','disabled','Administrator','','admin',null,1,0,'2026-10-01T00:00:00.000Z');
  const insert=db.prepare('INSERT INTO members VALUES(?,?,?,?,?,?)');
  insert.run('ROOT','Saved Root','9876543210',null,null,'2026-10-01T00:00:00.000Z');
  insert.run('LEFT','Saved Left','9876543211','ROOT','left','2026-10-01T00:00:00.000Z');
  insert.run('RIGHT','Saved Right','9876543212','ROOT','right','2026-10-01T00:00:00.000Z');
  const admin={id:'ADMIN',role:'admin',member_id:null},root={id:'ROOT-USER',role:'member',member_id:'ROOT'},left={id:'LEFT-USER',role:'member',member_id:'LEFT'},right={id:'RIGHT-USER',role:'member',member_id:'RIGHT'};
  const fail=(status,message,code)=>{const e=new Error(message);e.status=status;e.code=code;throw e;};
  const send=(res,status,body)=>{res.statusCode=status;res.headers['cache-control']='no-store';res.body=body;};
  const reports=createReports({db,fail,send});
  function request(url,user=admin,method='GET'){
    const res={headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(body){this.body=body;}};
    try{const handled=reports.handle({url,method},res,user);return {handled,status:res.statusCode,body:res.body,headers:res.headers};}
    catch(e){return {status:e.status||500,error:e.message};}
  }
  function closing(cid,payouts,created='2026-10-31T18:30:00.000Z',p=approvedPlan){
    return transaction(db,()=>{
      const total=payouts.reduce((sum,row)=>sum+row.amount,0);
      db.prepare('INSERT INTO closings VALUES(?,?,?,?,?)').run(cid,'KEY-'+cid,total,created,'ADMIN');
      captureClosing(db,cid,payouts,p);
      for(const row of payouts)ledger(db,row.id,'commission','matching_credit',row.amount,cid+':'+row.id,'Saved verified matching');
    });
  }
  function rootPayout(name='Saved Root'){
    return {id:'ROOT',name,pairs:2,amount:20000,matched_bv:3000,before:{left_bv:4500,right_bv:3500,matched_bv:1000,self_bv:700}};
  }
  return {db,admin,root,left,right,request,closing,rootPayout};
}

test('closing reports save exact immutable volume/rate/name/paise snapshots across later edits',t=>{
  const f=fixture(t);
  f.closing('CLOSE-1',[f.rootPayout(),{id:'LEFT',name:'Saved Left',pairs:1,amount:10000,matched_bv:1000,before:{left_bv:1000,right_bv:1000,matched_bv:0,self_bv:0}}]);
  f.db.prepare('UPDATE members SET name=? WHERE id=?').run('Renamed later','ROOT');
  f.db.prepare('UPDATE plan SET pair_bv=?,pair_income_paise=?,max_pairs_per_closing=?,approved=0 WHERE id=1').run(2000,50000,50);
  const result=f.request('/api/closings',f.root);
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.body.total,1);
  const row=result.body.items[0];
  assert.equal(row.member_name,'Saved Root');
  assert.equal(row.period,'2026-11');
  assert.equal(row.left_bv_before,4500);assert.equal(row.right_bv_after,3500);
  assert.equal(row.matched_bv_before,1000);assert.equal(row.matched_bv_after,3000);
  assert.equal(row.carry_left_bv_before,3500);assert.equal(row.carry_right_bv_before,2500);
  assert.equal(row.carry_left_bv_after,1500);assert.equal(row.carry_right_bv_after,500);
  assert.equal(row.gross_paise,20000);assert.equal(row.tds_paise,0);assert.equal(row.admin_fee_paise,0);assert.equal(row.net_paise,20000);
  assert.equal(row.deduction_status,'not_configured');
  assert.deepEqual(row.plan_snapshot,approvedPlan);
  assert.equal(row.details_available,true);
  assert.throws(()=>f.db.prepare('UPDATE closing_items SET gross_paise=999').run(),/immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM closing_items').run(),/immutable/);
  assert.throws(()=>f.db.prepare('UPDATE closing_report_meta SET period=?').run('2030-01'),/immutable/);
  assert.throws(()=>captureClosing(f.db,'CLOSE-1',[],approvedPlan),/already has/);
});

test('member closing detail and exports reveal own credits only, including guessed closing IDs',t=>{
  const f=fixture(t);
  f.closing('CLOSE-2',[f.rootPayout(),{id:'LEFT',name:'Saved Left',pairs:1,amount:10000,matched_bv:1000,before:{left_bv:1000,right_bv:1000,matched_bv:0}}]);
  const detail=f.request('/api/closings/CLOSE-2',f.left);
  assert.equal(detail.status,200);assert.equal(detail.body.items.length,1);
  assert.equal(detail.body.items[0].member_id,'LEFT');assert.equal(detail.body.closing.total_paise,10000);
  assert.equal(detail.body.closing.scope,'own');assert.equal(JSON.stringify(detail.body).includes('Saved Root'),false);
  assert.equal(f.request('/api/closings/CLOSE-2',f.right).status,404);
  assert.equal(f.request('/api/closings?member_id=ROOT',f.left).status,403);
  const csv=f.request('/api/closing-statement.csv',f.left);
  assert.equal(csv.status,200);assert.equal(csv.body.includes('Saved Root'),false);assert.equal(csv.body.includes('Saved Left'),true);
  assert.equal(csv.headers['cache-control'],'no-store');
  const admin=f.request('/api/closings/CLOSE-2');assert.equal(admin.body.items.length,2);assert.equal(admin.body.closing.total_paise,30000);
});

test('IST period and inclusive calendar-date filters handle midnight/month boundaries exactly',t=>{
  const f=fixture(t);
  assert.equal(savedPeriod('2026-10-31T18:29:59.999Z'),'2026-10');
  assert.equal(savedPeriod('2026-10-31T18:30:00.000Z'),'2026-11');
  f.closing('OCT-LAST',[f.rootPayout()],'2026-10-31T18:29:59.999Z');
  f.closing('NOV-FIRST',[f.rootPayout()],'2026-10-31T18:30:00.000Z');
  f.closing('NOV-END',[f.rootPayout()],'2026-11-01T18:29:59.999Z');
  f.closing('NEXT-DAY',[f.rootPayout()],'2026-11-01T18:30:00.000Z');
  const oct=f.request('/api/closings?period=2026-10',f.root);assert.deepEqual(oct.body.items.map(row=>row.closing_id),['OCT-LAST']);
  const day=f.request('/api/closings?from=2026-11-01&to=2026-11-01',f.root);
  assert.deepEqual(day.body.items.map(row=>row.closing_id),['NOV-END','NOV-FIRST']);
  assert.equal(day.body.totals.net_paise,40000);assert.equal(day.body.timezone,'Asia/Kolkata');
});

test('legacy closing history keeps absent details unknown and saved zero-payout closings explicit',t=>{
  const f=fixture(t);
  f.db.prepare('INSERT INTO closings VALUES(?,?,?,?,?)').run('LEGACY','OLD-KEY',15000,'2026-09-30T18:30:00.000Z','ADMIN');
  ledger(f.db,'ROOT','commission','matching_credit',15000,'LEGACY:ROOT','Known old credit');
  f.db.prepare('INSERT INTO closings VALUES(?,?,?,?,?)').run('OLD-ZERO','OLD-ZERO-KEY',0,'2026-09-30T17:00:00.000Z','ADMIN');
  f.closing('NEW-ZERO',[],'2026-10-01T00:00:00.000Z');
  const member=f.request('/api/closings',f.root);assert.equal(member.status,200,JSON.stringify(member));
  assert.equal(member.body.items.length,1);const old=member.body.items[0];
  assert.equal(old.details_available,false);assert.equal(old.gross_paise,null);assert.equal(old.net_paise,null);
  assert.equal(old.member_name,null); // A current profile name is not a historical name snapshot.
  assert.equal(old.pairs,null);assert.equal(old.plan_snapshot,null);assert.equal(old.recorded_credit_paise,15000);
  assert.match(old.unavailable_reason,/legacy/);assert.equal(member.body.legacy_count,1);
  assert.equal(member.body.totals.gross_paise,0);assert.equal(member.body.totals.recorded_credit_paise,15000);
  const all=f.request('/api/closings');assert.equal(all.body.total,3);assert.equal(all.body.legacy_count,2);
  const empty=f.request('/api/closings/NEW-ZERO');assert.equal(empty.body.details_available,true);assert.equal(empty.body.closing.total_paise,0);
  assert.equal(empty.body.items[0].pairs,0);assert.equal(empty.body.items[0].member_id,null);
  assert.equal(f.request('/api/closings/OLD-ZERO',f.root).status,404);
});

test('invalid snapshots fail the enclosing transaction without partial reports, credits or closing rows',t=>{
  const f=fixture(t);
  const row=f.rootPayout();delete row.before;
  assert.throws(()=>f.closing('BAD-BEFORE',[row]),/before metrics/);
  const wrong=f.rootPayout();wrong.matched_bv=3100;
  assert.throws(()=>f.closing('BAD-CARRY',[wrong]),/reconcile/);
  const gross=f.rootPayout();gross.amount=20001;
  assert.throws(()=>f.closing('BAD-GROSS',[gross]),/gross income/);
  assert.throws(()=>f.closing('UNAPPROVED',[f.rootPayout()],undefined,{...approvedPlan,approved:false}),/approved/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM closings').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM closing_items').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ledger').get().n,0);
});

test('pagination totals cover more than1000 entries and ledger histories enforce scoped parameterized filters',t=>{
  const f=fixture(t);
  const add=f.db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?)');
  transaction(f.db,()=>{for(let n=0;n<1005;n++)add.run('H-'+String(n).padStart(4,'0'),'ROOT','commission','matching_credit',10,'history-'+n,'Historical test entry','2026-10-01T00:00:00.000Z');add.run('OTHER','LEFT','commission','matching_credit',99999,'other','Private other member','2026-10-01T00:00:00.000Z');});
  const result=f.request('/api/records/ledger?page=11&page_size=100&account=commission&sort=id&direction=asc',f.root);
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.items.length,5);assert.equal(result.body.total,1005);
  assert.equal(result.body.totals.amount_paise,10050);assert.equal(result.body.pages,11);
  assert.equal(JSON.stringify(result.body).includes('Private other member'),false);
  assert.equal(f.request('/api/records/ledger?member_id=LEFT',f.root).status,403);
  assert.equal(f.request('/api/records/users',f.root).status,404);
  assert.equal(f.request('/api/records/ledger?sort=created_at%3BDROP%20TABLE%20ledger',f.root).status,400);
  assert.equal(f.request('/api/records/ledger?status=Approved',f.root).status,400);
  assert.equal(f.request('/api/records/ledger?account=commission%27%20OR%201%3D1',f.root).status,400);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ledger').get().n,1006);
});

test('report queries reject ambiguous/invalid dates, filters, pagination and spreadsheet formula injection is neutralized',t=>{
  const f=fixture(t);f.closing('SAFE-CSV',[f.rootPayout(' \t=HYPERLINK("https://example.invalid","test")')]);
  const csv=f.request('/api/closing-statement.csv');assert.equal(csv.status,200,JSON.stringify(csv));
  assert.match(csv.body,/' \t=HYPERLINK/);assert.match(csv.headers['content-disposition'],/dhanvantri-closing-statement/);
  for(const q of ['period=2026-13','from=2026-02-30','from=2026-11-02&to=2026-11-01','page=0','page=1e3','page_size=101','page=1&page=2','member_id=ROOT%27%20OR%201%3D1','surprise=1']){
    const result=f.request('/api/closings?'+q,f.root);assert.equal(result.status,400,q+' '+JSON.stringify(result));
  }
  assert.equal(f.request('/api/closings',f.root,'POST').status,405);
  assert.equal(f.request('/api/closings/%ZZ',f.root).status,400);
  assert.equal(f.request('/api/not-reports',f.root).handled,false);
});

test('authenticated HTTP closing route captures snapshots in its ledger transaction and report routes stay scoped',async t=>{
  const {fixture:integrationFixture}=require('./helpers');
  const f=await integrationFixture(t),root=await f.createMember('ROOT'),left=await f.createMember('LEFT','ROOT','left'),right=await f.createMember('RIGHT','ROOT','right');
  await f.configure();
  assert.equal((await f.post('/api/admin/products',{id:'REPORT-PRODUCT',name:'Report test product',price_paise:10000,bv:1000})).status,201);
  for(const [auth,member] of [[left,'LEFT'],[right,'RIGHT']]){
    ledger(f.db,member,'purchase','funding_credit',10000,'REPORT-FUND-'+member,'Fixture-only verified funding');
    const order=await f.post('/api/orders',{product_id:'REPORT-PRODUCT',quantity:1},auth);
    assert.equal(order.status,201,JSON.stringify(order.body));
    assert.equal((await f.post('/api/admin/orders/'+order.body.id+'/review',{decision:'approve',reference:'REPORT-INVOICE-'+member})).status,200);
  }
  assert.equal((await f.post('/api/admin/profit',{amount_paise:100000,reference:'REPORT-PROFIT-EVIDENCE'})).status,201);
  const close=await f.post('/api/admin/closing',{idempotency_key:'REPORT-CLOSING'});
  assert.equal(close.status,200,JSON.stringify(close.body));assert.equal(close.body.total_paise,10000);
  assert.equal((await f.request('/api/closings')).status,401);
  const report=await f.request('/api/closings',{auth:root});assert.equal(report.status,200,JSON.stringify(report.body));
  assert.equal(report.body.total,1);const item=report.body.items[0];
  assert.equal(item.closing_id,close.body.id);assert.equal(item.left_bv_before,1000);assert.equal(item.right_bv_before,1000);
  assert.equal(item.matched_bv_before,0);assert.equal(item.matched_bv_after,1000);assert.equal(item.net_paise,10000);
  assert.equal(item.plan_snapshot.pair_income_paise,10000);assert.equal(item.plan_snapshot.max_pairs_per_closing,100);
  assert.equal((await f.request('/api/closings/'+close.body.id,{auth:left})).status,404);
  assert.equal((await f.request('/api/closing-statement.csv',{auth:root})).headers.get('cache-control'),'no-store');
  const orders=await f.request('/api/records/orders',{auth:left});assert.equal(orders.status,200);assert.equal(orders.body.total,1);assert.equal(orders.body.items[0].member_id,'LEFT');
  const replay=await f.post('/api/admin/closing',{idempotency_key:'REPORT-CLOSING'});assert.equal(replay.body.replayed,true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM closing_items WHERE closing_id=?').get(close.body.id).n,1);
});

test('paginated order rows can receive commerce enrichment without affecting scoped counts or totals',t=>{
  const f=fixture(t);
  f.db.prepare('INSERT INTO products VALUES(?,?,?,?,?,?,?)').run('P','Product','',10000,1000,1,'2026-10-01T00:00:00.000Z');
  f.db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('OWN-ORDER','ROOT','P',1,10000,1000,10000,1000,'Approved','INVOICE',null,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z');
  f.db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('OTHER-ORDER','LEFT','P',1,10000,1000,10000,1000,'Approved','OTHER-INVOICE',null,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z');
  let supplied=[];
  const reports=createReports({db:f.db,fail:(status,message)=>{const e=new Error(message);e.status=status;throw e;},send:(res,status,body)=>{res.statusCode=status;res.body=body;},enrichOrders:rows=>{supplied=rows;return rows.map(row=>({...row,fulfilment_status:'Dispatched',tracking_reference:'SAVED-TRACK'}));}});
  const res={};assert.equal(reports.handle({url:'/api/records/orders',method:'GET'},res,f.root),true);
  assert.equal(supplied.length,1);assert.equal(supplied[0].id,'OWN-ORDER');
  assert.equal(res.body.total,1);assert.equal(res.body.totals.amount_paise,10000);
  assert.equal(res.body.items[0].fulfilment_status,'Dispatched');assert.equal(res.body.items[0].tracking_reference,'SAVED-TRACK');
});
