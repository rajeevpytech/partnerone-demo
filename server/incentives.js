'use strict';

function initializeIncentives(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS incentive_evidence (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK(kind IN ('hybrid','reward')),
  amount_paise INTEGER NOT NULL CHECK(amount_paise>0),
  reference TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS incentive_evidence_no_update BEFORE UPDATE ON incentive_evidence BEGIN SELECT RAISE(ABORT,'Incentive approval evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS incentive_evidence_no_delete BEFORE DELETE ON incentive_evidence BEGIN SELECT RAISE(ABORT,'Incentive approval evidence is immutable'); END;
`);
}

function createIncentives(ctx) {
  const {db,fail,text,integer,safeId,find,admin,requirePlan,remainingPool,consumeOnce,writeLedger,auditAction,send,now,id}=ctx;
  function handle(req,res,route,method,body,user) {
    if(route!=='/api/admin/incentives'||!['GET','POST'].includes(method))return false;
    admin(user);
    if(method==='GET') {
      send(res,200,{incentives:db.prepare('SELECT * FROM incentive_evidence ORDER BY created_at DESC,id LIMIT 1000').all()});
      return true;
    }
    const memberId=safeId(body.member_id);
    if(!['hybrid','reward'].includes(body.kind))fail(400,'Incentive kind must be hybrid or reward.');
    const amount=integer(body.amount_paise,'Approved incentive amount');
    const reference=text(body.reference,'External approval reference',200);
    const reason=text(body.reason,'Approval evidence note',1000);
    const result=consumeOnce(req,user,route,body,()=>{
      requirePlan();
      find('members',memberId);
      if(remainingPool()<amount)fail(409,'The verified 50% member profit pool cannot fund this incentive. No credit was created.','insufficient_pool');
      const incentiveId=id('INC');
      db.prepare('INSERT INTO incentive_evidence VALUES(?,?,?,?,?,?,?,?)').run(incentiveId,memberId,body.kind,amount,reference,reason,user.id,now());
      writeLedger(memberId,'commission',body.kind==='hybrid'?'hybrid_credit':'reward_credit',amount,incentiveId,'Externally approved '+body.kind+' incentive');
      auditAction(user,'approved_'+body.kind+'_incentive_recorded',incentiveId,{member_id:memberId,amount_paise:amount,reference,reason});
      return {ok:true,id:incentiveId,member_id:memberId,kind:body.kind,amount_paise:amount};
    });
    send(res,201,result);
    return true;
  }
  return {handle};
}

module.exports={initializeIncentives,createIncentives};
