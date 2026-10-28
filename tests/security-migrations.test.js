'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {fixture,ADMIN_PASSWORD,MEMBER_PASSWORD}=require('./helpers');
const {openDatabase}=require('../server/db');

test('members can revoke other sessions without disclosing session tokens or logging out the current device',async t=>{
  const f=await fixture(t);
  const first=await f.createMember('SESSION-ROOT');
  const other=await f.login('SESSION-ROOT',MEMBER_PASSWORD+'changed');
  let result=await f.request('/api/auth/sessions',{auth:first});
  assert.equal(result.status,200);
  assert.equal(result.body.total,2);
  assert.equal(result.body.sessions.filter(row=>row.current).length,1);
  for(const row of result.body.sessions)assert.deepEqual(Object.keys(row).sort(),['created_at','current','expires_at']);
  assert.equal((await f.post('/api/auth/logout-others',{},first)).body.removed,1);
  assert.equal((await f.request('/api/auth/me',{auth:other})).status,401);
  assert.equal((await f.request('/api/auth/me',{auth:first})).status,200);
  assert.equal((await f.post('/api/auth/logout-others',{},first)).body.removed,0);
  assert.equal((await f.request('/api/auth/me',{auth:f.admin})).status,200);
});

test('administrator login suspension revokes member sessions, preserves records and requires a reason',async t=>{
  const f=await fixture(t),root=await f.createMember('ACCOUNT-ROOT');
  const route='/api/admin/members/ACCOUNT-ROOT/status';
  assert.equal((await f.request(route,{method:'PATCH',auth:root,body:{active:false,reason:'Member request'}})).status,403);
  assert.equal((await f.request(route,{method:'PATCH',auth:f.admin,body:{active:false,reason:''}})).status,400);
  assert.equal((await f.request(route,{method:'PATCH',auth:f.admin,body:{active:false,reason:'Documented temporary login suspension'}})).status,200);
  assert.equal((await f.request('/api/bootstrap',{auth:root})).status,401);
  assert.equal((await f.request('/api/auth/login',{method:'POST',body:{username:'ACCOUNT-ROOT',password:MEMBER_PASSWORD+'changed'}})).status,401);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM members').get().n,1);
  assert.equal((await f.request(route,{method:'PATCH',auth:f.admin,body:{active:true,reason:'Login reinstated after review'}})).status,200);
  const reinstated=await f.login('ACCOUNT-ROOT',MEMBER_PASSWORD+'changed');
  assert.equal((await f.request('/api/bootstrap',{auth:reinstated})).body.members[0].account_active,undefined);
  assert.equal((await f.request('/api/bootstrap',{auth:f.admin})).body.members[0].account_active,true);
  assert.equal((await f.post('/api/admin/members/import',{members:[{id:'DISABLED',name:'Import fixture',parent_id:'ACCOUNT-ROOT',side:'left'}],dry_run:false})).status,201);
  assert.equal((await f.request('/api/admin/members/DISABLED/status',{method:'PATCH',auth:f.admin,body:{active:true,reason:'Premature activation attempt'}})).status,409);
});

test('large verified imports have a one-megabyte budget while ordinary requests return a usable413 response',async t=>{
  const f=await fixture(t);
  const members=Array.from({length:600},(_,i)=>({id:'IMPORT-'+i,name:'Verified fixture '+i+' '+ 'x'.repeat(65),phone:'9876543210',parent_id:i?'IMPORT-'+(i-1):null,side:i?'left':null}));
  assert.ok(Buffer.byteLength(JSON.stringify({members,dry_run:true}))>65536);
  const preview=await f.post('/api/admin/members/import',{members,dry_run:true});
  assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.equal(preview.body.count,600);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM members').get().n,0);
  const tooLarge=await f.post('/api/enquiries',{name:'Fixture',email:'qa@example.com',message:'x'.repeat(70000)},null);
  assert.equal(tooLarge.status,413);
  assert.match(tooLarge.body.error,/65536/);
  const importTooLarge=await f.post('/api/admin/members/import',{members:[],padding:'x'.repeat(1048576)});
  assert.equal(importTooLarge.status,413);
  assert.equal((await f.request('/api/health')).status,200);
});

test('schema upgrades are durable and databases from newer servers are rejected without downgrading them',async t=>{
  const f=await fixture(t);await f.createMember('PRESERVED');
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,2);
  assert.deepEqual(f.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row=>row.version),[1,2]);
  const second=openDatabase(f.dbPath);
  try{assert.equal(second.prepare('PRAGMA user_version').get().user_version,2);assert.equal(second.prepare('SELECT id FROM members').get().id,'PRESERVED');}finally{second.close();}
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dg-future-schema-')),filename=path.join(dir,'future.sqlite');
  try{let db=new DatabaseSync(filename);db.exec('PRAGMA user_version=99');db.close();assert.throws(()=>openDatabase(filename),/newer application/);db=new DatabaseSync(filename);assert.equal(db.prepare('PRAGMA user_version').get().user_version,99);db.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}
  const health=(await f.request('/api/health')).body;assert.equal(health.schema_version,2);assert.equal(typeof health.version,'string');
});
