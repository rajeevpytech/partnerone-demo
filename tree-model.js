'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PartnerTreeModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ROOT = 'PT-1001';
  function create(owner = {}) {
    return {
      version: 2,
      adjustments: { left: (owner.left ?? 128) - 128, right: (owner.right ?? 114) - 114 },
      nodes: [
        { id: ROOT, name: 'Aarav Sharma', level: 6, parentId: null, side: null, sales: 0, closedPairs: owner.settled ?? 114, bonusPaid: 11400 },
        { id: 'PT-1002', name: 'Maya Singh', level: 5, parentId: ROOT, side: 'left', sales: 20, closedPairs: 40, bonusPaid: 4000 },
        { id: 'PT-1003', name: 'Rohan Gupta', level: 5, parentId: ROOT, side: 'right', sales: 20, closedPairs: 34, bonusPaid: 3400 },
        { id: 'PT-1004', name: 'Ananya Verma', level: 4, parentId: 'PT-1002', side: 'left', sales: 68, closedPairs: 0, bonusPaid: 0 },
        { id: 'PT-1005', name: 'Kabir Mehta', level: 4, parentId: 'PT-1002', side: 'right', sales: 40, closedPairs: 0, bonusPaid: 0 },
        { id: 'PT-1006', name: 'Neha Kapoor', level: 4, parentId: 'PT-1003', side: 'left', sales: 60, closedPairs: 0, bonusPaid: 0 },
        { id: 'PT-1007', name: 'Vivek Rao', level: 3, parentId: 'PT-1003', side: 'right', sales: 34, closedPairs: 0, bonusPaid: 0 },
      ],
      events: [], lastChange: null, lastClosing: null, exampleParent: null,
    };
  }
  const node = (tree, id) => tree.nodes.find(n => n.id === id);
  const child = (tree, parentId, side) => tree.nodes.find(n => n.parentId === parentId && n.side === side);
  function path(tree, id) {
    const result = [], visited = new Set();
    let current = node(tree, id);
    while (current && !visited.has(current.id)) {
      visited.add(current.id); result.unshift(current); current = node(tree, current.parentId);
    }
    return result;
  }
  function totalSales(tree, id, visited = new Set()) {
    const n = node(tree, id);
    if (!n || visited.has(id)) return 0;
    visited.add(id);
    return n.sales + ['left', 'right'].reduce((sum, side) => {
      const c = child(tree, id, side);
      return sum + (c ? totalSales(tree, c.id, visited) : 0);
    }, 0);
  }
  function metrics(tree, id, rate = 100) {
    const n = node(tree, id);
    if (!n) throw new Error('Member does not exist.');
    const values = {};
    for (const side of ['left', 'right']) {
      const c = child(tree, id, side);
      values[side] = (c ? totalSales(tree, c.id) : 0) + (id === ROOT ? tree.adjustments[side] : 0);
    }
    const pairs = Math.min(values.left, values.right);
    const pendingPairs = Math.max(0, pairs - n.closedPairs);
    return { ...values, pairs, pendingPairs, pendingBonus: pendingPairs * rate, creditedBonus: n.bonusPaid, closedPairs: n.closedPairs };
  }
  function pending(tree, rate = 100) {
    return tree.nodes.map(n => ({ id: n.id, name: n.name, ...metrics(tree, n.id, rate) })).filter(n => n.pendingPairs > 0);
  }
  function otherPaid(tree) { return tree.nodes.filter(n => n.id !== ROOT).reduce((sum, n) => sum + n.bonusPaid, 0); }
  function add(tree, options, rate = 100) {
    const parent = node(tree, options.parentId);
    if (!parent) throw new Error('Choose an existing parent member.');
    if (!['left', 'right'].includes(options.side)) throw new Error('Choose Left or Right.');
    if (child(tree, parent.id, options.side)) throw new Error('This position is already occupied. Choose an empty position.');
    if (tree.nodes.length >= 80) throw new Error('This demonstration supports up to 80 recorded members. Reset to explore again.');
    const name = String(options.name || '').trim();
    if (!name || name.length > 50) throw new Error('Enter a sample name of up to 50 characters.');
    const before = new Map(tree.nodes.map(n => [n.id, metrics(tree, n.id, rate)]));
    let sequence = 2001;
    while (node(tree, 'PT-' + sequence)) sequence++;
    const member = { id: 'PT-' + sequence, name, parentId: parent.id, side: options.side, level: 1, sales: options.qualifyingSale ? 1 : 0, closedPairs: 0, bonusPaid: 0, added: true };
    tree.nodes.push(member);
    const ancestors = path(tree, parent.id).reverse();
    const impacts = ancestors.map(n => {
      const old = before.get(n.id), current = metrics(tree, n.id, rate);
      return { id: n.id, name: n.name, left: current.left, right: current.right, addedPairs: current.pairs - old.pairs, readyBonus: current.pendingBonus };
    });
    tree.lastAction = 'placement';
    tree.lastChange = { memberId: member.id, name, parentId: parent.id, parentName: parent.name, side: options.side, qualifyingSale: !!options.qualifyingSale, path: path(tree, member.id).map(n => n.id), impacts };
    tree.events.unshift(tree.lastChange); tree.events = tree.events.slice(0, 20);
    return { member, impacts };
  }
  function close(tree, rate, budget) {
    const due = pending(tree, rate);
    const total = due.reduce((sum, n) => sum + n.pendingBonus, 0);
    if (!due.length) return { total: 0, payouts: [] };
    if (total > budget) throw new Error('The distribution pool is insufficient. Update the approved profit in Admin console.');
    const payouts = due.map(m => {
      const n = node(tree, m.id);
      n.closedPairs += m.pendingPairs;
      n.bonusPaid += m.pendingBonus;
      return { id: n.id, name: n.name, pairs: m.pendingPairs, amount: m.pendingBonus, rate };
    });
    tree.lastAction = 'closing';
    tree.lastClosing = { total, payouts };
    return tree.lastClosing;
  }
  return { ROOT, create, node, child, path, metrics, totalSales, pending, otherPaid, add, close };
});
