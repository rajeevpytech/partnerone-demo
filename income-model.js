'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PartnerIncomeModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PERIOD = '2026-10';
  const sum = rows => rows.reduce((total, row) => total + row.amount, 0);
  function forMember(state, treeModel, memberId, filters = {}) {
    const member = treeModel.node(state.tree, memberId);
    if (!member) throw new Error('Choose an existing demonstration member.');
    let all;
    if (memberId === treeModel.ROOT) all = state.credits.map(row => ({ ...row }));
    else {
      all = (state.memberIncome || []).filter(row => row.memberId === memberId).map(row => ({ ...row }));
      const opening = member.bonusPaid - sum(all);
      if (opening > 0) all.push({ id:'OPEN-' + memberId, date:'25 Oct 2026', period:PERIOD, kind:'binary', label:'Opening matching credit', detail:'Sample matching credits before this reporting update', amount:opening });
    }
    all.sort((a, b) => {
      const stamp = row => {
        const parts = row.date.split(' ');
        return row.period + '-' + parts[0].padStart(2, '0');
      };
      return stamp(b).localeCompare(stamp(a));
    });
    const periodRows = all.filter(row => !filters.period || filters.period === 'all' || row.period === filters.period);
    const rows = periodRows.filter(row => !filters.kind || filters.kind === 'all' || row.kind === filters.kind);
    const totals = { binary:0, hybrid:0, benefit:0, total:sum(periodRows), filtered:sum(rows) };
    for (const row of periodRows) if (Object.hasOwn(totals, row.kind)) totals[row.kind] += row.amount;
    return { member, all, rows, totals, matching:treeModel.metrics(state.tree, memberId, state.pairRate) };
  }
  function snapshot(state, treeModel) {
    const credit = sum(state.credits);
    const paid = sum(state.withdrawals.filter(row => row.status === 'Completed'));
    const reserved = sum(state.withdrawals.filter(row => row.status === 'Pending'));
    const matching = treeModel.metrics(state.tree, treeModel.ROOT, state.pairRate);
    const monthCredit = sum(state.credits.filter(row => row.period === PERIOD));
    return {
      left:matching.left, right:matching.right, settled:state.settled,
      pendingPairs:matching.pendingPairs, pendingIncome:matching.pendingBonus,
      credited:credit, available:credit - paid - reserved, reserved, paid,
      networkPending:sum(treeModel.pending(state.tree, state.pairRate).map(row => ({ amount:row.pendingBonus }))),
      distribution:state.profit / 2 - monthCredit - 6000 - state.reserve - treeModel.otherPaid(state.tree),
    };
  }
  function statement(report) {
    const cell = value => {
      let text = String(value ?? '');
      if (/^[=+@-]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    const rows = [['Member ID','Member','Reference','Date','Income type','Description','Amount (INR)','Status'], ...report.rows.map(row => [report.member.id,report.member.name,row.id,row.date,row.label,row.detail,row.amount,'Credited'])];
    return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
  }
  return { forMember, snapshot, statement };
});
