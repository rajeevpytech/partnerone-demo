'use strict';

// Saved closing reports are written in the same transaction as the closing and
// ledger. Readers never recompute historical results from today's plan or tree.
const DAY_MS = 86400000;
const IST_OFFSET_MS = 19800000;
const itemColumns = [
  'closing_id', 'member_id', 'member_name', 'created_at', 'period', 'pairs',
  'left_bv_before', 'right_bv_before', 'left_bv_after', 'right_bv_after',
  'matched_bv_before', 'matched_bv_after', 'carry_left_bv_before',
  'carry_right_bv_before', 'carry_left_bv_after', 'carry_right_bv_after',
  'self_bv', 'gross_paise', 'tds_paise', 'admin_fee_paise', 'net_paise',
  'plan_json', 'deduction_status'
];

function initializeReports(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS closing_report_meta (
      closing_id TEXT PRIMARY KEY REFERENCES closings(id),
      created_at TEXT NOT NULL,
      period TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      item_count INTEGER NOT NULL CHECK(item_count >= 0),
      gross_paise INTEGER NOT NULL CHECK(gross_paise >= 0),
      tds_paise INTEGER NOT NULL CHECK(tds_paise >= 0),
      admin_fee_paise INTEGER NOT NULL CHECK(admin_fee_paise >= 0),
      net_paise INTEGER NOT NULL CHECK(net_paise >= 0)
    );
    CREATE TABLE IF NOT EXISTS closing_items (
      closing_id TEXT NOT NULL REFERENCES closings(id),
      member_id TEXT NOT NULL REFERENCES members(id),
      member_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      period TEXT NOT NULL,
      pairs INTEGER NOT NULL CHECK(pairs > 0),
      left_bv_before INTEGER NOT NULL CHECK(left_bv_before >= 0),
      right_bv_before INTEGER NOT NULL CHECK(right_bv_before >= 0),
      left_bv_after INTEGER NOT NULL CHECK(left_bv_after = left_bv_before),
      right_bv_after INTEGER NOT NULL CHECK(right_bv_after = right_bv_before),
      matched_bv_before INTEGER NOT NULL CHECK(matched_bv_before >= 0),
      matched_bv_after INTEGER NOT NULL CHECK(matched_bv_after >= matched_bv_before),
      carry_left_bv_before INTEGER NOT NULL CHECK(carry_left_bv_before >= 0),
      carry_right_bv_before INTEGER NOT NULL CHECK(carry_right_bv_before >= 0),
      carry_left_bv_after INTEGER NOT NULL CHECK(carry_left_bv_after >= 0),
      carry_right_bv_after INTEGER NOT NULL CHECK(carry_right_bv_after >= 0),
      self_bv INTEGER CHECK(self_bv IS NULL OR self_bv >= 0),
      gross_paise INTEGER NOT NULL CHECK(gross_paise >= 0),
      tds_paise INTEGER NOT NULL CHECK(tds_paise >= 0),
      admin_fee_paise INTEGER NOT NULL CHECK(admin_fee_paise >= 0),
      net_paise INTEGER NOT NULL CHECK(net_paise = gross_paise - tds_paise - admin_fee_paise),
      plan_json TEXT NOT NULL,
      deduction_status TEXT NOT NULL CHECK(deduction_status = 'not_configured'),
      PRIMARY KEY(closing_id, member_id)
    );
    CREATE INDEX IF NOT EXISTS closing_items_member_time ON closing_items(member_id, created_at);
    CREATE INDEX IF NOT EXISTS closing_items_period ON closing_items(period, created_at);
    CREATE TRIGGER IF NOT EXISTS closing_items_no_update BEFORE UPDATE ON closing_items
      BEGIN SELECT RAISE(ABORT, 'Saved closing items are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS closing_items_no_delete BEFORE DELETE ON closing_items
      BEGIN SELECT RAISE(ABORT, 'Saved closing items are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS closing_meta_no_update BEFORE UPDATE ON closing_report_meta
      BEGIN SELECT RAISE(ABORT, 'Saved closing reports are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS closing_meta_no_delete BEFORE DELETE ON closing_report_meta
      BEGIN SELECT RAISE(ABORT, 'Saved closing reports are immutable'); END;
  `);
}

function checkedInteger(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid closing snapshot: ${label}.`);
  return value;
}

function savedPeriod(timestamp) {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw new Error('Invalid closing snapshot: created_at.');
  return new Date(value + IST_OFFSET_MS).toISOString().slice(0, 7);
}

function captureClosing(db, closingId, payouts, plan) {
  const closing = db.prepare('SELECT * FROM closings WHERE id=?').get(closingId);
  if (!closing) throw new Error('Cannot capture a closing that does not exist.');
  if (db.prepare('SELECT 1 FROM closing_report_meta WHERE closing_id=?').get(closingId)) {
    throw new Error('This closing already has an immutable saved report.');
  }
  if (!Array.isArray(payouts)) throw new Error('Closing payouts must be an array.');
  const snapshot = {
    approved: plan.approved === true || plan.approved === 1,
    pair_bv: checkedInteger(plan.pair_bv, 'plan pair BV', 1),
    pair_income_paise: checkedInteger(plan.pair_income_paise, 'plan pair income', 1),
    max_pairs_per_closing: checkedInteger(plan.max_pairs_per_closing, 'plan cap', 1),
    profit_share_bps: checkedInteger(plan.profit_share_bps, 'profit share'),
    approval_reference: String(plan.approval_reference || '')
  };
  if (!snapshot.approved || snapshot.profit_share_bps !== 5000) throw new Error('Closing snapshot requires the approved 50/50 plan.');
  const period = savedPeriod(closing.created_at);
  const planJson = JSON.stringify(snapshot);
  const seen = new Set();
  let total = 0;
  // Validate all records before the first insert. The caller also owns the
  // surrounding BEGIN IMMEDIATE transaction with settlement and ledger writes.
  const values = payouts.map(payout => {
    if (!payout || typeof payout !== 'object' || !payout.before || typeof payout.before !== 'object') {
      throw new Error('Closing snapshot requires explicit before metrics for every payout.');
    }
    const memberId = String(payout.id || '');
    if (!memberId || seen.has(memberId)) throw new Error('Closing snapshot contains a missing or duplicate member.');
    seen.add(memberId);
    const memberName = String(payout.name || '');
    if (!memberName) throw new Error('Closing snapshot requires the recorded member name.');
    const pairs = checkedInteger(payout.pairs, 'pairs', 1);
    if (pairs > snapshot.max_pairs_per_closing) throw new Error('Closing snapshot exceeds the saved pair cap.');
    const left = checkedInteger(payout.before.left_bv, 'left BV');
    const right = checkedInteger(payout.before.right_bv, 'right BV');
    const before = checkedInteger(payout.before.matched_bv, 'previous matched BV');
    const after = checkedInteger(payout.matched_bv, 'new matched BV');
    const consumed = checkedInteger(pairs * snapshot.pair_bv, 'consumed BV', 1);
    const amount = checkedInteger(payout.amount, 'gross income', 1);
    if (after !== before + consumed || after > Math.min(left, right)) throw new Error('Closing snapshot does not reconcile matched and carry BV.');
    if (amount !== pairs * snapshot.pair_income_paise) throw new Error('Closing snapshot does not reconcile gross income with its saved rate.');
    const self = payout.before.self_bv === undefined ? null : checkedInteger(payout.before.self_bv, 'self BV');
    total = checkedInteger(total + amount, 'closing total');
    // This backend currently applies no tax or administrative deductions.
    // Persist actual zeros, with the absence of a configured policy explicit.
    return [closingId, memberId, memberName, closing.created_at, period, pairs,
      left, right, left, right, before, after, left - before, right - before,
      left - after, right - after, self, amount, 0, 0, amount,
      planJson, 'not_configured'];
  });
  if (total !== closing.total_paise) throw new Error('Saved report total does not reconcile with the closing.');
  const insert = db.prepare(`INSERT INTO closing_items (${itemColumns.join(',')}) VALUES (${itemColumns.map(() => '?').join(',')})`);
  for (const row of values) insert.run(...row);
  db.prepare('INSERT INTO closing_report_meta VALUES(?,?,?,?,?,?,?,?,?)')
    .run(closingId, closing.created_at, period, planJson, values.length, total, 0, 0, total);
}

// A union presents only saved item details. Legacy ledger credits remain known
// amounts but their absent volume/rate/tax breakdown is deliberately NULL.
const reportCte = `WITH report_rows AS (
  SELECT i.*, 1 AS details_available, i.net_paise AS recorded_credit_paise,
    NULL AS unavailable_reason FROM closing_items i
  UNION ALL
  SELECT c.id, l.member_id, NULL, c.created_at,
    strftime('%Y-%m', c.created_at, '+5 hours', '+30 minutes'),
    NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
    NULL,NULL,NULL,NULL,NULL,NULL,0,l.amount_paise,
    'This legacy closing has no saved volume, rate or deduction breakdown.'
  FROM closings c JOIN ledger l ON l.source_id = c.id || ':' || l.member_id
    AND l.kind='matching_credit' AND l.account='commission'
  WHERE NOT EXISTS (SELECT 1 FROM closing_report_meta cm WHERE cm.closing_id=c.id)
  UNION ALL
  SELECT c.id,NULL,NULL,c.created_at,
    strftime('%Y-%m', c.created_at, '+5 hours', '+30 minutes'),
    NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
    NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,
    'This legacy closing has no saved item breakdown.'
  FROM closings c WHERE NOT EXISTS (SELECT 1 FROM closing_report_meta cm WHERE cm.closing_id=c.id)
    AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.source_id=c.id || ':' || l.member_id
      AND l.kind='matching_credit' AND l.account='commission')
  UNION ALL
  SELECT cm.closing_id,NULL,NULL,cm.created_at,cm.period,
    0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
    0,0,0,0,cm.plan_json,'not_configured',1,0,NULL
  FROM closing_report_meta cm WHERE cm.item_count=0
)`;

function csvCell(value) {
  let text = String(value ?? '');
  // Prefix potentially active spreadsheet values, including leading whitespace.
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function createReports({db, fail, send, enrichOrders = rows => rows}) {
  if (!db || typeof fail !== 'function' || typeof send !== 'function') throw new Error('Report context requires db, fail and send.');
  if (typeof enrichOrders !== 'function') throw new Error('Report order enrichment must be a function.');
  function query(url, allowed) {
    const out = {};
    for (const [key, value] of url.searchParams) {
      if (!allowed.includes(key)) fail(400, `Unsupported report filter: ${key}.`);
      if (Object.hasOwn(out, key)) fail(400, `Repeated report filter: ${key}.`);
      if (value.length > 200) fail(400, 'Report filter is too long.');
      out[key] = value.trim();
    }
    return out;
  }
  function positive(value, label, fallback, max) {
    if (value === undefined || value === '') return fallback;
    if (!/^[1-9][0-9]*$/.test(value)) fail(400, `${label} must be a positive whole number.`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > max) fail(400, `${label} exceeds its allowed limit.`);
    return number;
  }
  function day(value, label) {
    if (!value) return null;
    if (!/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value)) fail(400, `${label} must use YYYY-MM-DD.`);
    const date = Date.parse(value + 'T00:00:00.000Z');
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== value) fail(400, `${label} is not a valid calendar date.`);
    return date;
  }
  function filters(q, user, alias = 'r', hasPeriod = true) {
    if (!user || !['admin', 'member'].includes(user.role)) fail(403, 'Report access requires a member or administrator account.');
    const where = [], params = [];
    const requestedMember = q.member_id || '';
    if (requestedMember && !/^[A-Za-z0-9_-]{1,50}$/.test(requestedMember)) fail(400, 'Member ID contains unsupported characters.');
    if (user.role !== 'admin') {
      if (!user.member_id || requestedMember && requestedMember !== user.member_id) fail(403, 'You may view only your own financial records.');
      where.push(`${alias}.member_id=?`); params.push(user.member_id);
    } else if (requestedMember) {
      where.push(`${alias}.member_id=?`); params.push(requestedMember);
    }
    if (q.period) {
      if (!hasPeriod || !/^[1-9][0-9]{3}-(0[1-9]|1[0-2])$/.test(q.period)) fail(400, 'Period must use YYYY-MM.');
      where.push(`${alias}.period=?`); params.push(q.period);
    }
    const start = day(q.from, 'From date'), end = day(q.to, 'To date');
    if (start !== null && end !== null && start > end) fail(400, 'From date must not be after the to date.');
    if (start !== null) { where.push(`${alias}.created_at>=?`); params.push(new Date(start - IST_OFFSET_MS).toISOString()); }
    if (end !== null) { where.push(`${alias}.created_at<?`); params.push(new Date(end + DAY_MS - IST_OFFSET_MS).toISOString()); }
    return {where, params};
  }
  function paging(q) {
    const page = positive(q.page, 'Page', 1, 1000000), size = positive(q.page_size, 'Page size', 25, 100);
    return {page, size, offset: (page - 1) * size};
  }
  function mapped(row) {
    const {plan_json, ...item} = row;
    item.details_available = !!item.details_available;
    item.plan_snapshot = plan_json ? JSON.parse(plan_json) : null;
    return item;
  }
  function list(q, user, paginate = true, extraWhere = [], extraParams = []) {
    const f = filters(q, user), p = paging(q);
    const clauses = [...f.where, ...extraWhere];
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const params = [...f.params, ...extraParams];
    const count = db.prepare(reportCte + ` SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN details_available=0 THEN 1 ELSE 0 END),0) AS legacy_count,
      COALESCE(SUM(gross_paise),0) AS gross_paise,COALESCE(SUM(tds_paise),0) AS tds_paise,
      COALESCE(SUM(admin_fee_paise),0) AS admin_fee_paise,COALESCE(SUM(net_paise),0) AS net_paise,
      COALESCE(SUM(recorded_credit_paise),0) AS recorded_credit_paise
      FROM report_rows r` + where).get(...params);
    let sql = reportCte + ' SELECT * FROM report_rows r' + where + ' ORDER BY r.created_at DESC,r.closing_id DESC,r.member_id';
    const selection = [...params];
    if (paginate) { sql += ' LIMIT ? OFFSET ?'; selection.push(p.size, p.offset); }
    const items = db.prepare(sql).all(...selection).map(mapped);
    return {items, page:p.page, page_size:p.size, total:count.total, pages:Math.ceil(count.total / p.size),
      legacy_count:count.legacy_count, timezone:'Asia/Kolkata',
      totals:{gross_paise:count.gross_paise,tds_paise:count.tds_paise,
        admin_fee_paise:count.admin_fee_paise,net_paise:count.net_paise,
        recorded_credit_paise:count.recorded_credit_paise},
      totals_note:count.legacy_count ? 'Breakdown totals include saved reports only. Recorded credits also include known legacy ledger credits.' : 'Totals reflect the full filtered result, across all pages.',
      filters:{member_id:user.role==='admin'?(q.member_id||null):user.member_id,period:q.period||null,from:q.from||null,to:q.to||null}};
  }
  const common = ['member_id','period','from','to','page','page_size'];
  const records = {
    ledger:{table:'ledger',statuses:null,sorts:['created_at','amount_paise','id']},
    orders:{table:'orders',statuses:['Pending','Approved','Rejected'],sorts:['created_at','amount_paise','status','id']},
    withdrawals:{table:'withdrawals',statuses:['Pending','Approved','Rejected','Paid'],sorts:['created_at','amount_paise','status','id']},
    funding:{table:'funding_requests',statuses:['Pending','Approved','Rejected'],sorts:['created_at','amount_paise','status','id']},
    benefits:{table:'benefits',statuses:['Pending','Reviewed','Approved','Rejected'],sorts:['created_at','status','id']}
  };
  function handle(req, res, user) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    const recognized = route === '/api/closings' || route === '/api/closing-statement.csv' || /^\/api\/closings\/[^/]+$/.test(route) || /^\/api\/records\/[^/]+$/.test(route);
    if (!recognized) return false;
    if (req.method !== 'GET') fail(405, 'Reports are read-only. Use GET.');
    if (route === '/api/closings' || route === '/api/closing-statement.csv') {
      const q = query(url, common), csv = route.endsWith('.csv');
      const result = list(q, user, !csv);
      if (!csv) { send(res, 200, result); return true; }
      const cols = ['closing_id','member_id','member_name','created_at','period','details_available','pairs',
        'left_bv_before','right_bv_before','matched_bv_before','matched_bv_after',
        'carry_left_bv_before','carry_right_bv_before','carry_left_bv_after','carry_right_bv_after',
        'gross_paise','tds_paise','admin_fee_paise','net_paise','recorded_credit_paise',
        'pair_bv','pair_income_paise','max_pairs_per_closing','deduction_status','unavailable_reason'];
      const rows = result.items.map(item => ({...item,pair_bv:item.plan_snapshot?.pair_bv,
        pair_income_paise:item.plan_snapshot?.pair_income_paise,max_pairs_per_closing:item.plan_snapshot?.max_pairs_per_closing}));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="dhanvantri-closing-statement.csv"');
      res.setHeader('Cache-Control', 'no-store');
      res.end('\uFEFF' + cols.map(csvCell).join(',') + '\r\n' + rows.map(row => cols.map(key => csvCell(row[key])).join(',')).join('\r\n'));
      return true;
    }
    if (route.startsWith('/api/closings/')) {
      query(url, []);
      let closingId;
      try { closingId = decodeURIComponent(route.slice('/api/closings/'.length)); }
      catch { fail(400, 'Closing ID has invalid URL encoding.'); }
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(closingId)) fail(400, 'Closing ID contains unsupported characters.');
      const closing = db.prepare('SELECT id,created_at,total_paise FROM closings WHERE id=?').get(closingId);
      if (!closing) fail(404, 'Closing report not found.');
      const result = list({}, user, false, ['r.closing_id=?'], [closingId]);
      if (!result.items.length) fail(404, 'Closing report not found.');
      const meta = db.prepare('SELECT * FROM closing_report_meta WHERE closing_id=?').get(closingId);
      const detailsAvailable = !!meta;
      send(res, 200, {closing:{id:closing.id,created_at:meta?.created_at||closing.created_at,
        period:meta?.period||savedPeriod(closing.created_at),details_available:detailsAvailable,
        total_paise:user.role==='admin'?closing.total_paise:result.totals.recorded_credit_paise,
        scope:user.role==='admin'?'all':'own'},items:result.items,details_available:detailsAvailable});
      return true;
    }
    const kind = route.slice('/api/records/'.length), config = records[kind];
    if (!config) fail(404, 'Record history not found.');
    const q = query(url, [...common.filter(k => k !== 'period'),'status','sort','direction','account','entry_kind']);
    const f = filters(q, user, 'r', false), p = paging(q);
    if (q.status) {
      if (!config.statuses?.includes(q.status)) fail(400, 'Unsupported status filter for this record history.');
      f.where.push('r.status=?'); f.params.push(q.status);
    }
    if (q.account) {
      if (kind !== 'ledger' || !['commission','purchase'].includes(q.account)) fail(400, 'Unsupported account filter.');
      f.where.push('r.account=?'); f.params.push(q.account);
    }
    if (q.entry_kind) {
      if (kind !== 'ledger' || !/^[a-z_]{1,50}$/.test(q.entry_kind)) fail(400, 'Unsupported ledger kind filter.');
      f.where.push('r.kind=?'); f.params.push(q.entry_kind);
    }
    const sort = q.sort || 'created_at', direction = q.direction || 'desc';
    if (!config.sorts.includes(sort) || !['asc','desc'].includes(direction)) fail(400, 'Unsupported report sort.');
    const where = f.where.length ? ' WHERE ' + f.where.join(' AND ') : '';
    const hasAmount = kind !== 'benefits';
    const stats = db.prepare(`SELECT COUNT(*) AS total${hasAmount?',COALESCE(SUM(amount_paise),0) AS amount_paise':''} FROM ${config.table} r` + where).get(...f.params);
    const selected = db.prepare(`SELECT * FROM ${config.table} r${where} ORDER BY r.${sort} ${direction},r.id ${direction} LIMIT ? OFFSET ?`).all(...f.params,p.size,p.offset);
    const items = kind === 'orders' ? enrichOrders(selected) : selected;
    send(res, 200, {items,page:p.page,page_size:p.size,total:stats.total,pages:Math.ceil(stats.total/p.size),
      timezone:'Asia/Kolkata',totals:hasAmount?{amount_paise:stats.amount_paise}:{count:stats.total},
      filters:{member_id:user.role==='admin'?(q.member_id||null):user.member_id,status:q.status||null,from:q.from||null,to:q.to||null,account:q.account||null,entry_kind:q.entry_kind||null},sort,direction});
    return true;
  }
  return {handle};
}

module.exports = {initializeReports, captureClosing, createReports, savedPeriod, csvCell};
