'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {openDatabase}=require('./db');
const source=process.env.DATABASE_PATH||path.resolve(__dirname,'../data/dhanvantri.sqlite');
const destination=path.resolve(process.env.BACKUP_PATH||path.join(path.dirname(source),'backups/dhanvantri-'+new Date().toISOString().replaceAll(':','-')+'.sqlite'));
if(!fs.existsSync(source))throw new Error('Database does not exist.');
fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
if(fs.existsSync(destination))throw new Error('Backup path already exists. Choose a new destination.');
const db=openDatabase(source);try{db.prepare('VACUUM INTO ?').run(destination);fs.chmodSync(destination,0o600);console.log('Consistent SQLite backup saved to',destination);}finally{db.close();}
