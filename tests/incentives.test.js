'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers');

test('manual incentive credits require admin, an approved plan, evidence and verified pool funding',async t=>{
  const f=await fixture(t),owner=await f.createMember('OWNER');
  const request={member_id:'OWNER',kind:'hybrid',amount_paise:10000,reference:'APPROVAL-H1',reason:'External written hybrid approval'};
  assert.equal((await f.post('/api/admin/incentives',request,owner)).status,403);
  assert.equal((await f.request('/api/admin/incentives',{auth:owner})).status,403);
  assert.equal((await f.post('/api/admin/incentives',request)).body.code,'plan_not_approved');
  await f.configure();
  const insufficient=await f.post('/api/admin/incentives',request);
  assert.equal(insufficient.status,409);assert.equal(insufficient.body.code,'insufficient_pool');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM incentive_evidence').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ledger').get().n,0);
  assert.equal((await f.post('/api/admin/profit',{amount_paise:40000,reference:'VERIFIED-PROFIT-1'})).status,201);
  for(const invalid of [
    {...request,amount_paise:1.5},
    {...request,amount_paise:-100},
    {...request,kind:'rank-auto'},
    {...request,reference:''},
    {...request,reason:''}
  ])assert.equal((await f.post('/api/admin/incentives',invalid)).status,400);
  assert.equal((await f.post('/api/admin/incentives',{...request,member_id:'UNKNOWN'})).status,404);
  assert.equal((await f.post('/api/admin/incentives',request)).status,201);
  const bootstrap=(await f.request('/api/bootstrap',{auth:owner})).body;
  assert.equal(bootstrap.summary.available_paise,10000);
  assert.equal(bootstrap.summary.total_income_paise,10000);
  assert.equal(bootstrap.ledger[0].kind,'hybrid_credit');
  assert.equal((await f.request('/api/bootstrap',{auth:f.admin})).body.summary.member_pool_remaining_paise,10000);
});

test('manual hybrid and reward approval evidence is immutable, member-owned and idempotent',async t=>{
  const f=await fixture(t),owner=await f.createMember('OWNER'),recipient=await f.createMember('RECIPIENT','OWNER','left');
  await f.configure();
  assert.equal((await f.post('/api/admin/profit',{amount_paise:100000,reference:'REALIZED-PROFIT-2'})).status,201);
  const request={member_id:'RECIPIENT',kind:'hybrid',amount_paise:10000,reference:'SIGNED-HYBRID-2',reason:'Verified individual hybrid approval'};
  const first=await f.post('/api/admin/incentives',request,f.admin,{'Idempotency-Key':'hybrid-approval-2'});
  assert.equal(first.status,201,JSON.stringify(first.body));
  const repeat=await f.post('/api/admin/incentives',request,f.admin,{'Idempotency-Key':'hybrid-approval-2'});
  assert.equal(repeat.status,201);assert.equal(repeat.body.id,first.body.id);
  assert.equal((await f.post('/api/admin/incentives',request)).status,409);
  assert.equal((await f.post('/api/admin/incentives',{...request,amount_paise:12000},f.admin,{'Idempotency-Key':'hybrid-approval-2'})).status,409);
  assert.equal((await f.post('/api/admin/incentives',{...request,kind:'reward',amount_paise:5000,reference:'SIGNED-REWARD-2'})).status,201);
  const own=(await f.request('/api/bootstrap',{auth:owner})).body,received=(await f.request('/api/bootstrap',{auth:recipient})).body;
  assert.equal(own.summary.available_paise,0);assert.equal(own.summary.total_income_paise,0);assert.equal(own.ledger.length,0);
  assert.equal(received.summary.available_paise,15000);assert.equal(received.summary.total_income_paise,15000);
  assert.deepEqual(received.ledger.map(l=>l.kind).sort(),['hybrid_credit','reward_credit']);
  const approved=(await f.request('/api/admin/incentives',{auth:f.admin})).body.incentives;
  assert.equal(approved.length,2);assert.ok(approved.every(r=>r.member_id==='RECIPIENT'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM incentive_evidence').get().n,2);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind IN ('hybrid_credit','reward_credit')").get().n,2);
  assert.throws(()=>f.db.prepare('UPDATE incentive_evidence SET amount_paise=1').run(),/immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM incentive_evidence').run(),/immutable/);
  assert.equal((await f.request('/api/bootstrap',{auth:f.admin})).body.summary.member_pool_remaining_paise,35000);
});

test('incentive credits consume the same member pool and block unfunded monthly benefits',async t=>{
  const f=await fixture(t),owner=await f.createMember('OWNER');
  await f.configure();
  assert.equal((await f.post('/api/admin/profit',{amount_paise:100000,reference:'REALIZED-PROFIT-3'})).status,201);
  assert.equal((await f.post('/api/admin/incentives',{member_id:'OWNER',kind:'hybrid',amount_paise:10000,reference:'SIGNED-HYBRID-3',reason:'External approval consumes common pool'})).status,201);
  const monthly=await f.post('/api/benefits',{type:'Monthly',period:'2026-10',note:'Externally reviewed eligibility'},owner);
  assert.equal(monthly.status,201);
  const benefit=await f.post('/api/admin/benefits/'+monthly.body.id+'/review',{decision:'approve',reference:'EXTERNAL-ELIGIBILITY-3'});
  assert.equal(benefit.status,409);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='monthly_benefit'").get().n,0);
  // Exhaust the funded pool through a separately evidenced award; a concurrent
  // second award is rejected atomically rather than creating an overdraft.
  const outcomes=await Promise.all([
    f.post('/api/admin/incentives',{member_id:'OWNER',kind:'reward',amount_paise:40000,reference:'SIGNED-REWARD-3A',reason:'Verified award A'}),
    f.post('/api/admin/incentives',{member_id:'OWNER',kind:'reward',amount_paise:40000,reference:'SIGNED-REWARD-3B',reason:'Verified award B'})
  ]);
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[201,409]);
  assert.equal((await f.request('/api/bootstrap',{auth:f.admin})).body.summary.member_pool_remaining_paise,0);
  assert.equal((await f.request('/api/bootstrap',{auth:owner})).body.summary.total_income_paise,50000);
  assert.equal((await f.post('/api/admin/incentives',{member_id:'OWNER',kind:'hybrid',amount_paise:1,reference:'NO-FUNDING-LEFT',reason:'Must remain blocked'})).status,409);
});
