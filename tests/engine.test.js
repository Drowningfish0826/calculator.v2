/* ============================================================================
 * tests/engine.test.js — 求解引擎自我檢測（node tests/engine.test.js）
 * ----------------------------------------------------------------------------
 * 以「獨立方法」交叉驗證求解結果：
 *   1. 兩變數問題以頂點列舉法暴力比對
 *   2. 影子價格以「右端擾動重解」比對
 *   3. 敏感度範圍以「邊界內外重解」驗證
 *   4. 整數解以暴力列舉比對
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

['assets/js/fraction.js', 'assets/js/solver.js'].forEach((file) => {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInThisContext(code, { filename: file });
});

const { Frac } = globalThis.LPC;
const { solveLP, solveInteger } = globalThis.LPC.solver;

let passed = 0;
let failed = 0;

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + extra));
  }
}

function near(a, b, tolerance) {
  const diff = Math.abs(a - b);
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return diff <= (tolerance === undefined ? 1e-9 : tolerance) * scale;
}

function model(options) {
  return {
    sense: options.sense || 'max',
    c: options.c,
    nonNeg: options.nonNeg !== false,
    variableNames: options.variableNames || options.c.map((_, index) => 'x' + (index + 1)),
    integer: options.integer || options.c.map(() => false),
    binary: options.binary || options.c.map(() => false),
    constraints: options.constraints.map((row) => ({ a: row.a, op: row.op, b: row.b }))
  };
}

/* --------------------------------------------------------------------- */
/* 暴力法：兩變數頂點列舉（含軸交點）                                     */
/* --------------------------------------------------------------------- */
function bruteForce2D(theModel) {
  const lines = theModel.constraints.map((row) => ({
    a: row.a.map(Number),
    b: Number(row.b),
    op: row.op
  }));
  if (theModel.nonNeg !== false) {
    lines.push({ a: [1, 0], b: 0, op: '>=' });
    lines.push({ a: [0, 1], b: 0, op: '>=' });
  }
  const candidates = [];
  const addCandidate = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const feasible = lines.every((line) => {
      const lhs = line.a[0] * x + line.a[1] * y;
      if (line.op === '<=') return lhs <= line.b + 1e-9;
      if (line.op === '>=') return lhs >= line.b - 1e-9;
      return Math.abs(lhs - line.b) <= 1e-9;
    });
    if (!feasible) return;
    if (theModel.nonNeg !== false && (x < -1e-9 || y < -1e-9)) return;
    candidates.push([x, y]);
  };
  addCandidate(0, 0);
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const det = lines[i].a[0] * lines[j].a[1] - lines[i].a[1] * lines[j].a[0];
      if (Math.abs(det) < 1e-12) continue;
      const x = (lines[i].b * lines[j].a[1] - lines[i].a[1] * lines[j].b) / det;
      const y = (lines[i].a[0] * lines[j].b - lines[i].b * lines[j].a[0]) / det;
      addCandidate(x, y);
    }
  }
  if (!candidates.length) return null;
  let best = null;
  for (const [x, y] of candidates) {
    const z = Number(theModel.c[0]) * x + Number(theModel.c[1]) * y;
    if (best === null) best = { x, y, z };
    else if (theModel.sense === 'max' ? z > best.z : z < best.z) best = { x, y, z };
  }
  return best;
}

function summarize(result) {
  if (result.status !== 'optimal') return result.status;
  return {
    x: result.x.map((value) => Number(value)),
    z: Number(result.z)
  };
}

/* --------------------------------------------------------------------- */
/* 測試案例                                                              */
/* --------------------------------------------------------------------- */

console.log('\n── 1. 課本標準題（兩階段法／≤ 型） ──');
{
  const example = model({
    sense: 'max',
    c: ['3', '5'],
    constraints: [
      { a: ['1', '0'], op: '<=', b: '4' },
      { a: ['0', '2'], op: '<=', b: '12' },
      { a: ['3', '2'], op: '<=', b: '18' }
    ]
  });
  const result = solveLP(example);
  check('狀態為 optimal', result.status === 'optimal', result.status);
  check('x1 = 2', result.x[0].eq('2'), result.x[0].toString());
  check('x2 = 6', result.x[1].eq('6'), result.x[1].toString());
  check('Z = 36', result.z.eq('36'), result.z.toString());
  check('第 3 條限制式為緊束', result.constraints[2].binding === true);
  check('第 1 條限制式剩餘 2', result.constraints[0].slack.eq('2'), result.constraints[0].slack.toString());
  const brute = bruteForce2D(example);
  check('與暴力頂點法一致', near(Number(result.z), brute.z));
  console.log('  最佳解 x =', summarize(result).x, ' Z =', Number(result.z));
}

console.log('\n── 2. 最小化／≥ 型（需要第一階段人工變數） ──');
{
  const example = model({
    sense: 'min',
    c: ['2', '3'],
    constraints: [
      { a: ['1', '1'], op: '>=', b: '5' },
      { a: ['2', '1'], op: '>=', b: '6' }
    ]
  });
  const result = solveLP(example);
  const brute = bruteForce2D(example);
  check('狀態為 optimal', result.status === 'optimal', result.status);
  check('Z = 10', result.z.eq('10'), result.z.toString());
  check('與暴力頂點法一致', near(Number(result.z), brute.z));
  check('影子價格非負（需求增加 → 成本增加）', result.constraints[0].shadow.sign() >= 0);
  console.log('  x =', summarize(result).x, ' Z =', Number(result.z), ' 影子價格 =',
    result.constraints.map((info) => info.shadow.toString()));
}

console.log('\n── 3. 等式限制式 ──');
{
  const example = model({
    sense: 'max',
    c: ['2', '1'],
    constraints: [
      { a: ['1', '1'], op: '=', b: '4' },
      { a: ['1', '0'], op: '<=', b: '3' }
    ]
  });
  const result = solveLP(example);
  check('Z = 7', result.z.eq('7'), result.z.toString());
  check('x1 = 3, x2 = 1', result.x[0].eq('3') && result.x[1].eq('1'), summarize(result).x.join(','));
}

console.log('\n── 4. 無可行解 ──');
{
  const result = solveLP(
    model({
      sense: 'max',
      c: ['1'],
      constraints: [
        { a: ['1'], op: '<=', b: '1' },
        { a: ['1'], op: '>=', b: '3' }
      ]
    })
  );
  check('狀態為 infeasible', result.status === 'infeasible', result.status);
}

console.log('\n── 5. 無界解 ──');
{
  const result = solveLP(
    model({
      sense: 'max',
      c: ['1', '1'],
      constraints: [{ a: ['1', '-1'], op: '<=', b: '1' }]
    })
  );
  check('狀態為 unbounded', result.status === 'unbounded', result.status);
}

console.log('\n── 6. 自由變數（取消非負限制） ──');
{
  const example = model({
    sense: 'max',
    c: ['1', '0'],
    nonNeg: false,
    constraints: [{ a: ['1', '0'], op: '<=', b: '5' }]
  });
  const result = solveLP(example);
  check('x1 = 5', result.x[0].eq('5'), result.x[0].toString());
}

console.log('\n── 7. 右端為負值 ──');
{
  const example = model({
    sense: 'max',
    c: ['1', '2'],
    constraints: [
      { a: ['-1', '1'], op: '<=', b: '-1' },
      { a: ['1', '0'], op: '<=', b: '4' }
    ]
  });
  const result = solveLP(example);
  const brute = bruteForce2D(example);
  check('狀態為 optimal', result.status === 'optimal', result.status);
  check('與暴力頂點法一致', result.status === 'optimal' && near(Number(result.z), brute.z),
    result.status === 'optimal' ? Number(result.z) + ' vs ' + brute.z : '');
}

console.log('\n── 8. 多重最佳解 ──');
{
  const result = solveLP(
    model({
      sense: 'max',
      c: ['1', '1'],
      constraints: [{ a: ['1', '1'], op: '<=', b: '4' }]
    })
  );
  check('偵測到多重最佳解', result.alternative === true);
}

console.log('\n── 9. 影子價格與右端擾動交叉驗證 ──');
{
  const base = model({
    sense: 'max',
    c: ['3', '5'],
    constraints: [
      { a: ['1', '0'], op: '<=', b: '4' },
      { a: ['0', '2'], op: '<=', b: '12' },
      { a: ['3', '2'], op: '<=', b: '18' }
    ]
  });
  const result = solveLP(base);
  for (let index = 0; index < base.constraints.length; index += 1) {
    const perturbed = model({
      sense: 'max',
      c: base.c,
      constraints: base.constraints.map((row, position) =>
        position === index
          ? { a: row.a, op: row.op, b: String(Number(row.b) + 0.5) }
          : row
      )
    });
    const delta = solveLP(perturbed);
    const numeric = (Number(delta.z) - Number(result.z)) / 0.5;
    check(
      '限制式 ' + (index + 1) + ' 影子價格 = ' + numeric.toFixed(4),
      near(numeric, Number(result.constraints[index].shadow), 1e-9),
      Number(result.constraints[index].shadow)
    );
  }
}

console.log('\n── 10. 敏感度範圍（邊界內外重解） ──');
{
  const base = {
    sense: 'max',
    c: ['3', '5'],
    constraints: [
      { a: ['1', '0'], op: '<=', b: '4' },
      { a: ['0', '2'], op: '<=', b: '12' },
      { a: ['3', '2'], op: '<=', b: '18' }
    ]
  };
  const result = solveLP(model(base));
  const info = result.constraints[2];
  const up = info.range.up === null ? null : Number(info.range.up);
  const down = info.range.down === null ? null : Number(info.range.down);
  console.log('  第 3 條限制式右端允許範圍： -' + down + ' / +' + up);
  if (up !== null) {
    const inside = solveLP(
      model({
        ...base,
        constraints: base.constraints.map((row, index) =>
          index === 2 ? { ...row, b: String(18 + up * 0.99) } : row
        )
      })
    );
    const outside = solveLP(
      model({
        ...base,
        constraints: base.constraints.map((row, index) =>
          index === 2 ? { ...row, b: String(18 + up * 1.01) } : row
        )
      })
    );
    const slopeInside = (Number(inside.z) - Number(result.z)) / (up * 0.99);
    const slopeOutside = (Number(outside.z) - Number(result.z)) / (up * 1.01);
    check('範圍內斜率維持影子價格', near(slopeInside, Number(info.shadow), 1e-6), slopeInside);
    check('範圍外斜率改變', !near(slopeOutside, Number(info.shadow), 1e-6), slopeOutside);
  }

  const objectiveInfo = result.varInfo[0];
  const objectiveUp = objectiveInfo.objRange.up === null ? null : Number(objectiveInfo.objRange.up);
  const objectiveDown =
    objectiveInfo.objRange.down === null ? null : Number(objectiveInfo.objRange.down);
  console.log('  x1 目標係數允許範圍： -' + objectiveDown + ' / +' + objectiveUp);
  if (objectiveUp !== null) {
    const inside = solveLP(model({ ...base, c: [String(3 + objectiveUp * 0.98), '5'] }));
    const outside = solveLP(model({ ...base, c: [String(3 + objectiveUp * 1.02), '5'] }));
    check(
      '範圍內最佳解不變',
      inside.x[0].eq(result.x[0]) && inside.x[1].eq(result.x[1]),
      inside.x.map((value) => value.toString()).join(',')
    );
    check(
      '範圍外最佳解改變',
      !(outside.x[0].eq(result.x[0]) && outside.x[1].eq(result.x[1])),
      outside.x.map((value) => value.toString()).join(',')
    );
  }
}

console.log('\n── 11. 整數規劃（分支定界） ──');
{
  const example = model({
    sense: 'max',
    c: ['5', '4'],
    integer: [true, true],
    constraints: [
      { a: ['6', '4'], op: '<=', b: '24' },
      { a: ['1', '2'], op: '<=', b: '6' }
    ]
  });
  const lp = solveLP(example);
  const integer = solveInteger(example);
  check('LP 鬆弛為 21', lp.z.eq('21'), lp.z.toString());
  check('LP 鬆弛 x1 = 3, x2 = 1.5', lp.x[0].eq('3') && lp.x[1].eq('1.5'), summarize(lp).x.join(','));

  let best = -Infinity;
  let bestPair = null;
  for (let a = 0; a <= 12; a += 1) {
    for (let b = 0; b <= 12; b += 1) {
      if (6 * a + 4 * b <= 24 && a + 2 * b <= 6) {
        const value = 5 * a + 4 * b;
        if (value > best) {
          best = value;
          bestPair = [a, b];
        }
      }
    }
  }
  check('整數最佳解與暴力列舉一致（Z = ' + best + '）', Number(integer.z) === best,
    Number(integer.z) + ' vs ' + best);
  check('整數解為 (' + bestPair + ')',
    Number(integer.x[0]) === bestPair[0] && Number(integer.x[1]) === bestPair[1],
    summarize(integer).x.join(','));
  check('整數解優於（不高於）LP 鬆弛', Number(integer.z) <= Number(lp.z));
  check('分支節點數 > 1', integer.nodes > 1, integer.nodes);
}

console.log('\n── 12. 背包問題（0-1 規劃） ──');
{
  const values = [10, 13, 18, 31];
  const weights = [
    [1, 2, 4, 7],
    [3, 1, 2, 1]
  ];
  const capacities = [10, 9];
  const example = model({
    sense: 'max',
    c: values.map(String),
    binary: [true, true, true, true],
    constraints: weights.map((row, index) => ({ a: row.map(String), op: '<=', b: String(capacities[index]) }))
  });
  const integer = solveInteger(example);

  let bruteBest = -Infinity;
  let brutePick = null;
  for (let mask = 0; mask < 1 << values.length; mask += 1) {
    let totalWeightA = 0;
    let totalWeightB = 0;
    let totalValue = 0;
    const pick = [];
    for (let index = 0; index < values.length; index += 1) {
      if (mask & (1 << index)) {
        pick.push(1);
        totalValue += values[index];
        totalWeightA += weights[0][index];
        totalWeightB += weights[1][index];
      } else {
        pick.push(0);
      }
    }
    if (totalWeightA <= capacities[0] && totalWeightB <= capacities[1] && totalValue > bruteBest) {
      bruteBest = totalValue;
      brutePick = pick;
    }
  }
  check('狀態為 optimal', integer.status === 'optimal', integer.status);
  check('最佳值與暴力列舉一致（Z = ' + bruteBest + '）', Number(integer.z) === bruteBest,
    Number(integer.z) + ' vs ' + bruteBest);
  check('0-1 變數皆為 0 或 1',
    integer.x.every((value) => value.isZero() || value.eq('1')),
    integer.x.map((value) => value.toString()).join(','));
  console.log('  選擇 =', integer.x.map((value) => Number(value)), '最適組合 =', brutePick);
}

console.log('\n── 13. 運輸問題（3×4，作業範例） ──');
{
  const supply = [300, 300, 300];
  const demand = [250, 350, 200, 100];
  const cost = [
    [16, 18, 11, 20],
    [14, 12, 13, 17],
    [13, 15, 17, 18]
  ];
  const variableNames = [];
  const c = [];
  const constraints = [];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      variableNames.push('x' + (i + 1) + (j + 1));
      c.push(String(cost[i][j]));
    }
  }
  for (let i = 0; i < 3; i += 1) {
    const row = new Array(12).fill('0');
    for (let j = 0; j < 4; j += 1) row[i * 4 + j] = '1';
    constraints.push({ a: row, op: '=', b: String(supply[i]) });
  }
  for (let j = 0; j < 4; j += 1) {
    const row = new Array(12).fill('0');
    for (let i = 0; i < 3; i += 1) row[i * 4 + j] = '1';
    constraints.push({ a: row, op: '=', b: String(demand[j]) });
  }
  const result = solveLP(model({ sense: 'min', c, constraints, variableNames }));
  check('狀態為 optimal', result.status === 'optimal', result.status);
  const totalDemand = demand.reduce((sum, value) => sum + value, 0);
  const totalSupply = supply.reduce((sum, value) => sum + value, 0);
  check('供需總量平衡', totalSupply === totalDemand, totalSupply + ' vs ' + totalDemand);
  const shipped = result.x.reduce((sum, value) => sum + Number(value), 0);
  check('總運輸量 = 需求量', Math.abs(shipped - totalDemand) < 1e-9, shipped);
  let recomputed = 0;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      recomputed += cost[i][j] * Number(result.x[i * 4 + j]);
    }
  }
  check('目標值可由運輸方案重算', near(recomputed, Number(result.z)), recomputed + ' vs ' + Number(result.z));
  console.log('  最小總成本 =', Number(result.z));
}

console.log('\n── 14. 退化問題（多條限制式同時等號成立） ──');
{
  const result = solveLP(
    model({
      sense: 'max',
      c: ['1', '1', '0'],
      constraints: [
        { a: ['1', '0', '0'], op: '<=', b: '0' },
        { a: ['0', '1', '0'], op: '<=', b: '0' },
        { a: ['1', '1', '0'], op: '<=', b: '0' }
      ]
    })
  );
  check('退化問題仍可收斂', result.status === 'optimal', result.status);
  check('退化問題最佳值為 0', result.status === 'optimal' && result.z.isZero());
}

console.log('\n結果：通過 ' + passed + ' 項，失敗 ' + failed + ' 項');
process.exit(failed === 0 ? 0 : 1);
