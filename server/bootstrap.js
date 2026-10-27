'use strict';
const path=require('node:path');
const {openDatabase,id,now,transaction}=require('./db');
const {passwordHash,validPassword}=require('./auth');
function bootstrapAdmin(db,{username,password,name='Company administrator'}){
  if(typeof username!=='string'||! /^[A-Za-z0-9_.@-]{3,100}$/.test(username))throw new Error('ADMIN_USERNAME must contain 3–100 letters, numbers or . _ @ -');
  if(!validPassword(password))throw new Error('ADMIN_PASSWORD must contain 12–256 characters.');
  const password_hash=passwordHash(password);
  return transaction(db,()=>{if(db.prepare("SELECT id FROM users WHERE role='admin'").get())throw new Error('An administrator already exists. Bootstrap is disabled.');const uid=id('ADMIN');db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)').run(uid,username,password_hash,name,'','admin',null,1,0,now());return uid;});
}
if(require.main===module){const db=openDatabase(process.env.DATABASE_PATH||path.resolve(__dirname,'../data/dhanvantri.sqlite'));try{const uid=bootstrapAdmin(db,{username:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD,name:process.env.ADMIN_NAME||'Company administrator'});console.log('Administrator created:',uid);console.log('Remove ADMIN_PASSWORD from the process environment after this one-time operation.');}catch(e){console.error(e.message);process.exitCode=1;}finally{db.close();}}
module.exports={bootstrapAdmin};
