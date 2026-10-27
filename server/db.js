'use strict';
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const now=()=>new Date().toISOString();
const id=(prefix)=>prefix+'-'+crypto.randomUUID();
function openDatabase(filename){
  if(filename!==':memory:') fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
  const db=new DatabaseSync(filename);
  if(filename!==':memory:')fs.chmodSync(filename,0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
  db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', role TEXT NOT NULL CHECK(role IN ('admin','member')), member_id TEXT UNIQUE REFERENCES members(id), active INTEGER NOT NULL DEFAULT 1, force_password_change INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', parent_id TEXT REFERENCES members(id), side TEXT CHECK(side IN ('left','right')), joined_at TEXT NOT NULL, CHECK((parent_id IS NULL AND side IS NULL) OR (parent_id IS NOT NULL AND side IS NOT NULL)), UNIQUE(parent_id,side));
CREATE UNIQUE INDEX IF NOT EXISTS one_root_member ON members((1)) WHERE parent_id IS NULL;
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',price_paise INTEGER NOT NULL CHECK(price_paise>0),bv INTEGER NOT NULL CHECK(bv>=0),active INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plan(id INTEGER PRIMARY KEY CHECK(id=1),approved INTEGER NOT NULL DEFAULT 0,pair_bv INTEGER NOT NULL DEFAULT 0,pair_income_paise INTEGER NOT NULL DEFAULT 0,profit_share_bps INTEGER NOT NULL DEFAULT 5000 CHECK(profit_share_bps=5000),max_pairs_per_closing INTEGER NOT NULL DEFAULT 0,approval_reference TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
INSERT OR IGNORE INTO plan(id,updated_at) VALUES(1,datetime('now'));
CREATE TABLE IF NOT EXISTS profit_events(id TEXT PRIMARY KEY,amount_paise INTEGER NOT NULL CHECK(amount_paise>0),reference TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,actor TEXT NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id),product_id TEXT NOT NULL REFERENCES products(id),quantity INTEGER NOT NULL CHECK(quantity>0),unit_price_paise INTEGER NOT NULL,unit_bv INTEGER NOT NULL,amount_paise INTEGER NOT NULL,bv INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('Pending','Approved','Rejected')),reference TEXT,reason TEXT,created_at TEXT NOT NULL,reviewed_at TEXT);
CREATE TABLE IF NOT EXISTS business_events(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),member_id TEXT NOT NULL REFERENCES members(id),side TEXT NOT NULL CHECK(side IN ('left','right')),bv INTEGER NOT NULL CHECK(bv>0),created_at TEXT NOT NULL,UNIQUE(order_id,member_id));
CREATE TABLE IF NOT EXISTS settlements(member_id TEXT PRIMARY KEY REFERENCES members(id),matched_bv INTEGER NOT NULL DEFAULT 0 CHECK(matched_bv>=0));
CREATE TABLE IF NOT EXISTS closings(id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,total_paise INTEGER NOT NULL,created_at TEXT NOT NULL,actor TEXT NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id),account TEXT NOT NULL CHECK(account IN ('commission','purchase')),kind TEXT NOT NULL,amount_paise INTEGER NOT NULL,source_id TEXT NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(account,kind,source_id));
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'Ledger entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'Ledger entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS business_no_update BEFORE UPDATE ON business_events BEGIN SELECT RAISE(ABORT,'Business events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS business_no_delete BEFORE DELETE ON business_events BEGIN SELECT RAISE(ABORT,'Business events are immutable'); END;
CREATE TABLE IF NOT EXISTS withdrawals(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id),amount_paise INTEGER NOT NULL CHECK(amount_paise>0),status TEXT NOT NULL CHECK(status IN ('Pending','Approved','Rejected','Paid')),reference TEXT,reason TEXT,created_at TEXT NOT NULL,reviewed_at TEXT);
CREATE TABLE IF NOT EXISTS funding_requests(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id),amount_paise INTEGER NOT NULL CHECK(amount_paise>0),reference TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('Pending','Approved','Rejected')),verification_reference TEXT,reason TEXT,created_at TEXT NOT NULL,reviewed_at TEXT);
CREATE TABLE IF NOT EXISTS verified_receipts(reference TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS benefits(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id),type TEXT NOT NULL CHECK(type IN ('Education','Monthly')),period TEXT NOT NULL,note TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('Pending','Reviewed','Approved','Rejected')),reference TEXT,reason TEXT,created_at TEXT NOT NULL,reviewed_at TEXT,UNIQUE(member_id,type,period));
CREATE TABLE IF NOT EXISTS enquiries(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Open',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,source_id TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit entries are immutable'); END;
CREATE TABLE IF NOT EXISTS idempotency(user_id TEXT NOT NULL REFERENCES users(id),route TEXT NOT NULL,key TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,route,key));
PRAGMA user_version=1;
`);
  return db;
}
function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}
function audit(db,user,action,source,detail){db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').run(id('AUD'),user.id,action,source,JSON.stringify(detail),now());}
function ledger(db,member,account,kind,amount,source,description){db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?)').run(id('LE'),member,account,kind,amount,source,description,now());}
function balance(db,member,account='commission'){return Number(db.prepare('SELECT COALESCE(SUM(amount_paise),0) AS n FROM ledger WHERE member_id=? AND account=?').get(member,account).n);}
function remainingPool(db){const profit=Number(db.prepare('SELECT COALESCE(SUM(amount_paise / 2),0) AS n FROM profit_events').get().n);const credits=Number(db.prepare("SELECT COALESCE(SUM(amount_paise),0) AS n FROM ledger WHERE account='commission' AND kind IN ('matching_credit','monthly_benefit')").get().n);return profit-credits;}
module.exports={openDatabase,transaction,audit,ledger,balance,remainingPool,id,now};
