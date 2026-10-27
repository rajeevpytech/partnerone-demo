'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {openDatabase}=require('../server/db');

test('backup snapshot survives an independent reopen and keeps private file permissions',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dhanvantri-backup-'));
  const source=path.join(dir,'data.sqlite');
  const backup=path.join(dir,'snapshot.sqlite');
  try{
    let db=openDatabase(source);
    const before=db.prepare('SELECT * FROM plan WHERE id=1').get();
    db.close();
    const result=spawnSync(process.execPath,[path.resolve(__dirname,'../server/backup.js')],{env:{...process.env,DATABASE_PATH:source,BACKUP_PATH:backup},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.ok(fs.statSync(backup).size>0);
    assert.equal(fs.statSync(backup).mode&0o777,0o600);
    db=openDatabase(backup);
    assert.deepEqual(db.prepare('SELECT * FROM plan WHERE id=1').get(),before);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    db.close();
    const repeat=spawnSync(process.execPath,[path.resolve(__dirname,'../server/backup.js')],{env:{...process.env,DATABASE_PATH:source,BACKUP_PATH:backup},encoding:'utf8'});
    assert.notEqual(repeat.status,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
