'use strict';
const crypto=require('node:crypto');
function passwordHash(password){const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024}).toString('hex');return `scrypt$32768$8$3$${salt}$${hash}`;}
const dummyHash=passwordHash('never-a-usable-password-'+crypto.randomBytes(24).toString('hex'));
function verifyPassword(password,encoded=dummyHash){try{const [alg,n,r,p,salt,expected]=encoded.split('$');if(alg!=='scrypt'||n!=='32768'||r!=='8'||p!=='3'||!salt||!expected)return false;const found=crypto.scryptSync(password,salt,64,{N:Number(n),r:Number(r),p:Number(p),maxmem:64*1024*1024});const wanted=Buffer.from(expected,'hex');return wanted.length===found.length&&crypto.timingSafeEqual(found,wanted);}catch{return false;}}
const hashToken=token=>crypto.createHash('sha256').update(token).digest('hex');
const publicUser=u=>({id:u.id,username:u.username,name:u.name,role:u.role,member_id:u.member_id,force_password_change:!!u.force_password_change});
const validPassword=p=>typeof p==='string'&&p.length>=12&&p.length<=256;
module.exports={passwordHash,verifyPassword,hashToken,publicUser,validPassword};
