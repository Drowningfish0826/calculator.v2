/* ============================================================================
 * tests/network.test.js — 網路模型引擎檢測（node tests/network.test.js）
 * ----------------------------------------------------------------------------
 * 以「與線性規劃完全無關的獨立演算法」交叉驗證：
 *   最短路徑 ⟷ Dijkstra
 *   最大流量 ⟷ Edmonds–Karp（BFS 增廣路徑）
 *   轉運問題 ⟷ 逐次最短路徑法（Bellman–Ford 最小成本流）
 * 另外檢查每個解的可行性：流量平衡、容量、供需。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
['assets/js/fraction.js', 'assets/js/model.js', 'assets/js/solver.js', 'assets/js/network.js'].forEach((file) => {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
});
const N = globalThis.LPC.network;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, extra) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    if (failures.length < 40) {
      failures.push('  ✗ ' + name + (extra === undefined ? '' : '  → ' + extra));
    }
  }
}

let seed = 20261118;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

/* ------------------------------------------------------------------------- */
/* 獨立演算法                                                                */
/* ------------------------------------------------------------------------- */

function dijkstra(n, arcs, s, t) {
  const dist = new Array(n).fill(Infinity);
  const done = new Array(n).fill(false);
  dist[s] = 0;
  for (let k = 0; k < n; k += 1) {
    let u = -1;
    for (let v = 0; v < n; v += 1) if (!done[v] && (u < 0 || dist[v] < dist[u])) u = v;
    if (u < 0 || dist[u] === Infinity) break;
    done[u] = true;
    arcs.forEach((a) => {
      if (a.i === u && dist[u] + a.c < dist[a.j]) dist[a.j] = dist[u] + a.c;
    });
  }
  return dist[t];
}

function edmondsKarp(n, arcs, s, t) {
  const cap = Array.from({ length: n }, () => new Array(n).fill(0));
  arcs.forEach((a) => {
    cap[a.i][a.j] += a.c;
  });
  let flow = 0;
  for (;;) {
    const prev = new Array(n).fill(-1);
    prev[s] = s;
    const queue = [s];
    while (queue.length && prev[t] < 0) {
      const u = queue.shift();
      for (let v = 0; v < n; v += 1) if (prev[v] < 0 && cap[u][v] > 0) { prev[v] = u; queue.push(v); }
    }
    if (prev[t] < 0) return flow;
    let push = Infinity;
    for (let v = t; v !== s; v = prev[v]) push = Math.min(push, cap[prev[v]][v]);
    for (let v = t; v !== s; v = prev[v]) { cap[prev[v]][v] -= push; cap[v][prev[v]] += push; }
    flow += push;
  }
}

/** 最小成本流：超級源點 → 供應點（容量＝供應量），需求點 → 超級匯點（容量＝需求量），送 min(S, D) */
function minCostFlow(nodes, arcs) {
  const n = nodes.length + 2;
  const S = n - 2;
  const T = n - 1;
  const edges = [];
  const graph = Array.from({ length: n }, () => []);
  const add = (u, v, cap, cost) => {
    graph[u].push(edges.length); edges.push({ v, cap, cost });
    graph[v].push(edges.length); edges.push({ v: u, cap: 0, cost: -cost });
  };
  let supply = 0;
  let demand = 0;
  nodes.forEach((node, index) => {
    if (node.role === 'supply') { add(S, index, node.amount, 0); supply += node.amount; }
    if (node.role === 'demand') { add(index, T, node.amount, 0); demand += node.amount; }
  });
  arcs.forEach((a) => add(a.i, a.j, 1e9, a.c));
  const target = Math.min(supply, demand);
  let sent = 0;
  let cost = 0;
  while (sent < target) {
    const dist = new Array(n).fill(Infinity);
    const via = new Array(n).fill(-1);
    dist[S] = 0;
    for (let round = 0; round < n; round += 1) {
      let changed = false;
      for (let u = 0; u < n; u += 1) {
        if (dist[u] === Infinity) continue;
        graph[u].forEach((id) => {
          const e = edges[id];
          if (e.cap > 0 && dist[u] + e.cost < dist[e.v]) { dist[e.v] = dist[u] + e.cost; via[e.v] = id; changed = true; }
        });
      }
      if (!changed) break;
    }
    if (dist[T] === Infinity) return { feasible: false };
    let push = target - sent;
    for (let v = T; v !== S; v = edges[via[v] ^ 1].v) push = Math.min(push, edges[via[v]].cap);
    for (let v = T; v !== S; v = edges[via[v] ^ 1].v) { edges[via[v]].cap -= push; edges[via[v] ^ 1].cap += push; }
    sent += push;
    cost += push * dist[T];
  }
  return { feasible: true, cost };
}

/* ------------------------------------------------------------------------- */
/* 可行性檢查                                                                */
/* ------------------------------------------------------------------------- */

function checkFeasible(title, spec, result) {
  const compiled = N.compile(spec);
  const balance = compiled.nodes.map(() => 0);
  result.arcs.forEach((arc) => {
    const f = Number(arc.flow);
    check(title + '：流量非負 ' + arc.from + '→' + arc.to, f >= -1e-9, f);
    if (spec.type === 'maxflow') {
      check(title + '：不超過容量 ' + arc.from + '→' + arc.to, f <= Number(arc.value) + 1e-9, f + '>' + arc.value);
    }
    balance[arc.i] += f;
    balance[arc.j] -= f;
  });
  compiled.nodes.forEach((node, index) => {
    const net = balance[index];
    if (spec.type === 'maxflow') {
      const want = index === compiled.source ? Number(result.maxFlow) : index === compiled.sink ? -Number(result.maxFlow) : 0;
      check(title + '：流量守恆 ' + node.name, Math.abs(net - want) < 1e-9, net + ' vs ' + want);
    } else if (spec.type === 'shortest') {
      const want = index === compiled.source ? 1 : index === compiled.sink ? -1 : 0;
      check(title + '：路徑平衡 ' + node.name, Math.abs(net - want) < 1e-9, net);
    } else {
      const amount = node.amount ? Number(node.amount) : 0;
      if (node.role === 'transship') check(title + '：轉運點平衡 ' + node.name, Math.abs(net) < 1e-9, net);
      if (node.role === 'supply') check(title + '：供應不超過 ' + node.name, net <= amount + 1e-9, net);
      if (node.role === 'demand') check(title + '：需求不超過 ' + node.name, -net <= amount + 1e-9, -net);
    }
  });
}

/* ------------------------------------------------------------------------- */
/* 1. 講義例題                                                              */
/* ------------------------------------------------------------------------- */

(function pdfExamples() {
  const walshSpec = N.findExample('walsh').build();
  const walsh = N.solve(walshSpec);
  check('Walsh：求得最佳解', walsh.status === 'optimal', walsh.status);
  check('Walsh：Z* = 10043', Number(walsh.z) === 10043, String(walsh.z));
  check('Walsh：農場→加工廠成本 4658', Number(walsh.stageCosts[0].cost) === 4658, String(walsh.stageCosts[0].cost));
  check('Walsh：加工廠→配銷中心成本 5385', Number(walsh.stageCosts[1].cost) === 5385, String(walsh.stageCosts[1].cost));
  const louisiana = walsh.unmet.filter((u) => u.name === 'Louisiana')[0];
  check('Walsh：Louisiana 缺 30', Number(louisiana.shortage) === 30, String(louisiana.shortage));
  check('Walsh：判定供不應求', walsh.caseInfo === 'short');
  check('Walsh：模型 12 個變數、8 條限制式', walsh.model.varNames.length === 12 && walsh.model.constraints.length === 8);
  check('Walsh：變數命名與講義一致（x14、x58）', walsh.model.varNames[0] === 'x14' && walsh.model.varNames[11] === 'x58', walsh.model.varNames.join(','));
  checkFeasible('Walsh', walshSpec, walsh);

  const spSpec = N.findExample('shortest-7').build();
  const sp = N.solve(spSpec);
  check('最短路徑：Z* = 38', Number(sp.z) === 38, String(sp.z));
  check('最短路徑：1→3→4→7', sp.path.nodes.join('>') === '1>3>4>7', sp.path.nodes.join('>'));
  check('最短路徑：變數皆為 0-1', sp.model.binary.every(Boolean));
  checkFeasible('最短路徑', spSpec, sp);

  const mfSpec = N.findExample('express').build();
  const mf = N.solve(mfSpec);
  check('最大流量：F* = 10', Number(mf.maxFlow) === 10, String(mf.maxFlow));
  check('最大流量：最小切割容量 = 10', Number(mf.cut.capacity) === 10, String(mf.cut.capacity));
  check('最大流量：不超過節點 1 輸出能力 11', Number(mf.maxFlow) <= 11);
  check('最大流量：容量 0 的反向弧不建變數', mf.model.varNames.length === 18, mf.model.varNames.length);
  checkFeasible('最大流量', mfSpec, mf);
})();

/* ------------------------------------------------------------------------- */
/* 2. 隨機網路 × 獨立演算法                                                  */
/* ------------------------------------------------------------------------- */

function randomGraph(n, density, maxValue, allowZero) {
  const arcs = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i !== j && rnd() < density) arcs.push({ i, j, c: ri(allowZero ? 0 : 1, maxValue) });
    }
  }
  return arcs.slice(0, 50);
}

function toSpec(type, n, arcs, extra) {
  const names = Array.from({ length: n }, (_, k) => 'N' + (k + 1));
  return N.create(Object.assign({
    type,
    nodes: names.map((name) => ({ name })),
    arcs: arcs.map((a) => ({ from: names[a.i], to: names[a.j], value: String(a.c) })),
    source: names[0],
    sink: names[n - 1]
  }, extra || {}));
}

for (let t = 0; t < 120; t += 1) {
  const n = ri(3, 8);
  const arcs = randomGraph(n, 0.35, 30, true);
  const spec = toSpec('shortest', n, arcs);
  const want = dijkstra(n, arcs, 0, n - 1);
  const got = N.solve(spec);
  if (want === Infinity) {
    check('隨機最短路徑 #' + t + '：不可達時回報無可行解', got.status === 'infeasible' || got.status === 'invalid', got.status);
  } else {
    check('隨機最短路徑 #' + t + '：與 Dijkstra 相同', got.status === 'optimal' && Number(got.z) === want, (got.z && String(got.z)) + ' vs ' + want);
    if (got.status === 'optimal') {
      checkFeasible('隨機最短路徑 #' + t, spec, got);
      const legSum = got.path.legs.reduce((s, leg) => s + Number(leg.value), 0);
      check('隨機最短路徑 #' + t + '：路徑長度＝目標值', got.path.complete && legSum === want, legSum + ' vs ' + want);
    }
  }
}

for (let t = 0; t < 120; t += 1) {
  const n = ri(3, 8);
  const arcs = randomGraph(n, 0.4, 12, false);
  const spec = toSpec('maxflow', n, arcs);
  const want = edmondsKarp(n, arcs, 0, n - 1);
  const got = N.solve(spec);
  if (!arcs.length) continue;
  check('隨機最大流量 #' + t + '：與 Edmonds–Karp 相同', got.status === 'optimal' && Number(got.maxFlow) === want, (got.maxFlow && String(got.maxFlow)) + ' vs ' + want);
  if (got.status === 'optimal') {
    checkFeasible('隨機最大流量 #' + t, spec, got);
    check('隨機最大流量 #' + t + '：最小切割＝最大流量', Number(got.cut.capacity) === want, String(got.cut.capacity));
  }
}

for (let t = 0; t < 120; t += 1) {
  const s = ri(1, 3);
  const m = ri(1, 3);
  const d = ri(1, 3);
  const nodes = [];
  for (let k = 0; k < s; k += 1) nodes.push({ name: 'S' + (k + 1), role: 'supply', amount: ri(10, 90) });
  for (let k = 0; k < m; k += 1) nodes.push({ name: 'M' + (k + 1), role: 'transship' });
  for (let k = 0; k < d; k += 1) nodes.push({ name: 'D' + (k + 1), role: 'demand', amount: ri(10, 90) });
  if (t % 3 === 0) {
    /* 刻意做出供需平衡 */
    const totalS = nodes.filter((x) => x.role === 'supply').reduce((a, x) => a + x.amount, 0);
    const demandNodes = nodes.filter((x) => x.role === 'demand');
    demandNodes.forEach((x) => { x.amount = 0; });
    demandNodes[0].amount = totalS;
  }
  const arcs = [];
  nodes.forEach((a, i) => nodes.forEach((b, j) => {
    const ok = (a.role === 'supply' && b.role !== 'supply') || (a.role === 'transship' && b.role !== 'supply' && i !== j);
    if (ok && rnd() < 0.7) arcs.push({ i, j, c: ri(1, 30) });
  }));
  const spec = N.create({
    type: 'transship',
    nodes: nodes.map((x) => ({ name: x.name, role: x.role, amount: x.amount === undefined ? '' : String(x.amount) })),
    arcs: arcs.map((a) => ({ from: nodes[a.i].name, to: nodes[a.j].name, value: String(a.c) }))
  });
  const want = minCostFlow(nodes, arcs);
  const got = N.solve(spec);
  if (!want.feasible) {
    check('隨機轉運 #' + t + '：最小成本流不可行時 LP 也無可行解', got.status === 'infeasible' || got.status === 'invalid', got.status);
  } else {
    check('隨機轉運 #' + t + '：成本與最小成本流相同', got.status === 'optimal' && Number(got.z) === want.cost, (got.z && String(got.z)) + ' vs ' + want.cost + ' ' + got.status);
    if (got.status === 'optimal') checkFeasible('隨機轉運 #' + t, spec, got);
  }
}

/* ------------------------------------------------------------------------- */
/* 3. 輸入檢查                                                              */
/* ------------------------------------------------------------------------- */

function expectInvalid(title, spec, piece) {
  const r = N.solve(N.create(spec));
  check(title + '：應判為輸入錯誤', r.status === 'invalid', r.status);
  check(title + '：錯誤訊息含「' + piece + '」', (r.errors || []).join('|').indexOf(piece) >= 0, (r.errors || []).join('|'));
}
expectInvalid('節點重複', { type: 'shortest', nodes: ['1', '1', '2'], arcs: [{ from: '1', to: '2', value: '3' }], source: '1', sink: '2' }, '重複');
expectInvalid('弧線指到不存在節點', { type: 'shortest', nodes: ['1', '2'], arcs: [{ from: '1', to: '9', value: '3' }], source: '1', sink: '2' }, '9');
expectInvalid('負距離', { type: 'shortest', nodes: ['1', '2'], arcs: [{ from: '1', to: '2', value: '-3' }], source: '1', sink: '2' }, '不可為負');
expectInvalid('起終點相同', { type: 'maxflow', nodes: ['1', '2'], arcs: [{ from: '1', to: '2', value: '3' }], source: '1', sink: '1' }, '同一個');
expectInvalid('數字錯誤', { type: 'maxflow', nodes: ['1', '2'], arcs: [{ from: '1', to: '2', value: 'abc' }], source: '1', sink: '2' }, 'abc');
expectInvalid('重複弧線', { type: 'shortest', nodes: ['1', '2'], arcs: [{ from: '1', to: '2', value: '3' }, { from: '1', to: '2', value: '4' }], source: '1', sink: '2' }, '重複');
expectInvalid('轉運沒有需求點', { type: 'transship', nodes: [{ name: 'A', role: 'supply', amount: '5' }, { name: 'B', role: 'transship' }], arcs: [{ from: 'A', to: 'B', value: '1' }] }, '需求點');
expectInvalid('自我迴圈', { type: 'shortest', nodes: ['1', '2'], arcs: [{ from: '1', to: '1', value: '3' }], source: '1', sink: '2' }, '相同');
(function tooMany() {
  const names = Array.from({ length: 12 }, (_, k) => String(k + 1));
  const arcs = [];
  names.forEach((a) => names.forEach((b) => { if (a !== b) arcs.push({ from: a, to: b, value: '1' }); }));
  const r = N.solve(N.create({ type: 'shortest', nodes: names, arcs, source: '1', sink: '12' }));
  check('弧線過多：應判為輸入錯誤', r.status === 'invalid' && /最多/.test(r.errors.join('')), r.status);
})();
(function reverseColumn() {
  const r = N.solve(N.create({ type: 'shortest', nodes: ['A', 'B', 'C'], arcs: [{ from: 'B', to: 'A', value: '9', reverse: '2' }, { from: 'B', to: 'C', value: '3' }], source: 'A', sink: 'C' }));
  check('反向欄位會建立反方向弧線', r.status === 'optimal' && Number(r.z) === 5 && r.path.nodes.join('') === 'ABC', r.status + ' ' + (r.z && String(r.z)));
})();
(function unreachable() {
  const r = N.solve(N.create({ type: 'shortest', nodes: ['A', 'B', 'C'], arcs: [{ from: 'A', to: 'B', value: '1' }, { from: 'C', to: 'B', value: '1' }], source: 'A', sink: 'C' }));
  check('不可達：狀態為無可行解', r.status === 'infeasible', r.status);
  check('不可達：訊息提醒弧線方向', /方向/.test(r.message || ''), r.message);
})();
(function steps() {
  const r = N.solve(N.findExample('express').build());
  const text = r.steps.map((s) => s.title + s.lines.join('')).join('\n');
  check('建模步驟含 Source 限制（流出 − 流入 ＝ F）', /流出 − 流入 ＝ F/.test(text));
  check('建模步驟含容量限制', /容量限制/.test(text));
})();

failures.forEach((line) => console.log(line));
console.log('\n網路模型檢測：通過 ' + passed + ' 項，失敗 ' + failed + ' 項');
process.exit(failed ? 1 : 0);
