'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createApplication}=require('../server/app');
const {openDatabase}=require('../server/db');
const {bootstrapAdmin}=require('../server/bootstrap');
// Synthetic fixture passwords: never used by a deployed installation.
const ADMIN_PASSWORD='Fixture-only-admin-2026!';
const MEMBER_PASSWORD='Fixture-only-member-2026!';
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dg-integration-'));
  const dbPath=path.join(dir,'app.sqlite');
  const db=openDatabase(dbPath);
  bootstrapAdmin(db,{username:'administrator',password:ADMIN_PASSWORD});
  const app=createApplication({db,production:false,secureCookies:false,staticDir:path.resolve(__dirname,'../dist')});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));db.close();fs.rmSync(dir,{recursive:true,force:true});});
  async function request(route,{method='GET',body,auth,headers={}}={}){
    const h={...headers};if(body!==undefined)h['Content-Type']='application/json';
    if(auth){h.Cookie=auth.cookie;h['X-CSRF-Token']=auth.csrf;}
    const response=await fetch(origin+route,{method,body:body===undefined?undefined:JSON.stringify(body),headers:h});
    const result=(response.headers.get('content-type')||'').includes('json')?await response.json():await response.text();
    return {status:response.status,body:result,headers:response.headers};
  }
  async function login(username,password){
    const result=await request('/api/auth/login',{method:'POST',body:{username,password}});
    assert.equal(result.status,200,JSON.stringify(result.body));
    return {cookie:result.headers.get('set-cookie').split(';')[0],csrf:result.body.csrf,user:result.body.user};
  }
  const admin=await login('administrator',ADMIN_PASSWORD);
  const post=(route,body,auth=admin,headers)=>request(route,{method:'POST',body,auth,headers});
  async function createMember(id,parent_id=null,side=null,phone='9876543210'){
    const result=await post('/api/admin/members',{id,name:'Fixture '+id,phone,parent_id,side,username:id,password:MEMBER_PASSWORD});
    assert.equal(result.status,201,JSON.stringify(result.body));
    const account=await login(id,MEMBER_PASSWORD);
    assert.equal((await post('/api/auth/change-password',{current_password:MEMBER_PASSWORD,new_password:MEMBER_PASSWORD+'changed'},account)).status,200);
    return account;
  }
  async function configure(){assert.equal((await request('/api/admin/plan',{method:'PATCH',auth:admin,body:{approved:true,pair_bv:1000,pair_income_paise:10000,max_pairs_per_closing:100,approval_reference:'Approved fixture rules'}})).status,200);}
  return {app,db,dbPath,dir,origin,request,post,login,admin,createMember,configure};
}
module.exports={fixture,ADMIN_PASSWORD,MEMBER_PASSWORD};
