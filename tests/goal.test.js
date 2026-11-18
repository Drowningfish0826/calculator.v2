/* ============================================================================
 * tests/goal.test.js — 目標規劃引擎自我檢測（node tests/goal.test.js）
 * ----------------------------------------------------------------------------
 * 以「獨立方法」交叉驗證：
 *   1. 頂點列舉法：目標規劃的字典式最佳解必落在（目標線、座標軸、硬限制線）
 *      這些超平面的某個交點上，列舉所有交點後取字典式最小值，與單純形法逐層求解比對。
 *   2. 整數解以暴力列舉比對。
 *   3. 講義例題的已知答案（Beaver Creek：x₁ = 15、x₂ = 20、加班 15 小時）。
 *   4. 邊界情形：無可行解、無錯誤輸入、離差變數運算式解析。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

['assets/js/fraction.js', 'assets/js/solver.js', 'assets/js/model.js', 'assets/js/goal.js'].forEach((file) => {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInThisContext(code, { filename: file });
});

const { Frac } = globalThis.LPC;
const GP = globalThis.LPC.goal;

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

const F = (value) => Frac.coerce(value);
const show = (list) => '[' + list.map((value) => value.toString()).join(', ') + ']';

/* --------------------------------------------------------------------- */
/* 依定義直接計算：給定 x，各離差變數與各優先層的值（獨立於單純形法）    */
/* --------------------------------------------------------------------- */
function evaluate(spec, compiled, x) {
  const m = spec.goals.length;
  const under = new Array(m).fill(null);
  const over = new Array(m).fill(null);
  spec.goals.forEach((goal, index) => {
    let lhs = F(0);
    goal.a.forEach((value, column) => {
      lhs = lhs.add(F(value).mul(x[column]));
    });
    const parsed = GP.parseDeviationTerms(goal.dev, m);
    parsed.terms.forEach((term) => {
      const source = term.side === '-' ? under[term.goal] : over[term.goal];
      if (source === null) {
        throw new Error('測試只支援引用編號較小的目標');
      }
      lhs = lhs.add(term.coef.mul(source));
    });
    const target = F(goal.target);
    // 目標限制式：lhs + d⁻ − d⁺ = target，且 d⁻·d⁺ = 0
    if (lhs.lt(target)) {
      under[index] = target.sub(lhs);
      over[index] = F(0);
    } else {
      under[index] = F(0);
      over[index] = lhs.sub(target);
    }
  });
  return compiled.levels.map((level) => {
    let total = F(0);
    level.terms.forEach((term) => {
      total = total.add(term.w.mul(term.side === '-' ? under[term.goal] : over[term.goal]));
    });
    return total;
  });
}

function hardFeasible(spec, x) {
  return spec.hard.every((row) => {
    let lhs = F(0);
    row.a.forEach((value, column) => {
      lhs = lhs.add(F(value).mul(x[column]));
    });
    const rhs = F(row.b);
    return row.op === '<=' ? lhs.lte(rhs) : row.op === '>=' ? lhs.gte(rhs) : lhs.eq(rhs);
  });
}

function lexCompare(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const order = left[index].cmp(right[index]);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

/* 解 n×n 線性方程組（Frac 高斯消去）；奇異回傳 null */
function solveSquare(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, index) => row.concat([rhs[index]]));
  for (let col = 0; col < n; col += 1) {
    let pivot = -1;
    for (let row = col; row < n; row += 1) {
      if (!a[row][col].isZero()) {
        pivot = row;
        break;
      }
    }
    if (pivot < 0) {
      return null;
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const inverse = a[col][col].inv();
    a[col] = a[col].map((value) => value.mul(inverse));
    for (let row = 0; row < n; row += 1) {
      if (row !== col && !a[row][col].isZero()) {
        const factor = a[row][col];
        a[row] = a[row].map((value, index) => value.sub(factor.mul(a[col][index])));
      }
    }
  }
  return a.map((row) => row[n]);
}

function combinations(count, size) {
  const result = [];
  (function walk(start, picked) {
    if (picked.length === size) {
      result.push(picked.slice());
      return;
    }
    for (let index = start; index < count; index += 1) {
      picked.push(index);
      walk(index + 1, picked);
      picked.pop();
    }
  })(0, []);
  return result;
}

/* 頂點列舉：超平面 = 座標軸 + 硬限制線 + 目標線（+ 額外指定的線） */
function bruteLexVertices(spec, extraPlanes) {
  const compiled = GP.compile(spec);
  const n = spec.varNames.length;
  const planes = [];
  for (let index = 0; index < n; index += 1) {
    const row = new Array(n).fill(F(0));
    row[index] = F(1);
    planes.push({ a: row, b: F(0) });
  }
  spec.hard.forEach((row) => planes.push({ a: row.a.map(F), b: F(row.b) }));
  spec.goals.forEach((goal) => {
    if (goal.a.some((value) => !F(value).isZero())) {
      planes.push({ a: goal.a.map(F), b: F(goal.target) });
    }
  });
  (extraPlanes || []).forEach((plane) => planes.push({ a: plane.a.map(F), b: F(plane.b) }));

  let best = null;
  let bestX = null;
  combinations(planes.length, n).forEach((picked) => {
    const x = solveSquare(
      picked.map((index) => planes[index].a),
      picked.map((index) => planes[index].b)
    );
    if (!x || x.some((value) => value.isNeg()) || !hardFeasible(spec, x)) {
      return;
    }
    const vector = evaluate(spec, compiled, x);
    if (best === null || lexCompare(vector, best) < 0) {
      best = vector;
      bestX = x;
    }
  });
  return { vector: best, x: bestX };
}

function bruteLexInteger(spec, limit) {
  const compiled = GP.compile(spec);
  const n = spec.varNames.length;
  let best = null;
  let bestX = null;
  (function walk(prefix) {
    if (prefix.length === n) {
      const x = prefix.map(F);
      if (!hardFeasible(spec, x)) {
        return;
      }
      const vector = evaluate(spec, compiled, x);
      if (best === null || lexCompare(vector, best) < 0) {
        best = vector;
        bestX = x;
      }
      return;
    }
    for (let value = 0; value <= limit; value += 1) {
      walk(prefix.concat([value]));
    }
  })([]);
  return { vector: best, x: bestX };
}

function levelVector(result) {
  return result.levels.map((level) => level.achieved);
}

function sameVector(left, right) {
  return left.length === right.length && left.every((value, index) => value.eq(right[index]));
}

/* --------------------------------------------------------------------- */
/* 1. 講義例題：與頂點列舉法交叉驗證                                      */
/* --------------------------------------------------------------------- */
const exampleExtra = {
  'beaver-overtime': [{ a: ['1', '2'], b: '50' }],
  'beaver-5': [{ a: ['1', '2'], b: '50' }, { a: ['1', '0'], b: '30' }, { a: ['0', '1'], b: '20' }]
};

GP.examples.forEach((example) => {
  const spec = example.build();
  const result = GP.solve(spec);
  check(example.id + '：求解成功', result.ok && result.status === 'optimal', result.status);
  if (!result.ok || result.status !== 'optimal') {
    return;
  }
  const brute = bruteLexVertices(spec, exampleExtra[example.id]);
  check(
    example.id + '：各優先層數值 = 頂點列舉的字典式最小值',
    sameVector(levelVector(result), brute.vector),
    'engine=' + show(levelVector(result)) + ' brute=' + show(brute.vector)
  );
  // 引擎自己回報的「各層最佳值」必須等於以最終解獨立重算的值
  const recomputed = evaluate(spec, GP.compile(spec), result.x);
  check(example.id + '：最終解重算結果與逐層最佳值一致', sameVector(recomputed, result.levels.map((level) => level.optimum)),
    show(recomputed) + ' vs ' + show(result.levels.map((level) => level.optimum)));
  // 離差變數互補：d⁻·d⁺ = 0
  check(example.id + '：每個目標 d⁻·d⁺ = 0',
    result.goals.every((goal) => goal.under.mul(goal.over).isZero()));
  check(example.id + '：x ≥ 0', result.x.every((value) => !value.isNeg()));
});

/* --------------------------------------------------------------------- */
/* 2. 講義已知答案：Beaver Creek 四個目標                                 */
/* --------------------------------------------------------------------- */
{
  const result = GP.solve(GP.examples[0].build());
  check('Beaver 四目標：x₁ = 15', result.x[0].eq(F(15)), result.x[0].toString());
  check('Beaver 四目標：x₂ = 20', result.x[1].eq(F(20)), result.x[1].toString());
  check('Beaver 四目標：P₁（工時不足）= 0', result.levels[0].achieved.isZero());
  check('Beaver 四目標：P₂（利潤不足）= 0', result.levels[1].achieved.isZero());
  check('Beaver 四目標：P₃（陶土超用）= 0', result.levels[2].achieved.isZero());
  check('Beaver 四目標：P₄（加班）= 15 小時', result.levels[3].achieved.eq(F(15)), result.levels[3].achieved.toString());
  check('Beaver 四目標：4 個優先層', result.levels.length === 4);
  // 目標 1 是「工時 ≥ 40」：只要 d₁⁻ = 0 即達成（加班 d₁⁺ 屬於 P₄，不影響該目標是否達成）
  check('Beaver 四目標：3 個目標限制式皆達成（d₁⁻ = d₂⁻ = d₃⁺ = 0）', result.metCount === 3 && result.goalCount === 3,
    result.metCount + '/' + result.goalCount);
}

/* 目標中的目標：加班 ≤ 10 → d₄⁺ = 15 − 10 = 5 */
{
  const result = GP.solve(GP.examples[1].build());
  check('目標中的目標：d₄⁺ = 5', result.levels[3].achieved.eq(F(5)), result.levels[3].achieved.toString());
  check('目標中的目標：加班（d₁⁺）= 15', result.goals[0].over.eq(F(15)), result.goals[0].over.toString());
  check('目標中的目標：d₄⁻ = 0', result.goals[3].under.isZero());
  check('目標中的目標：目標 4 的實際值（d₁⁺）= 15', result.goals[3].actual.eq(F(15)), result.goals[3].actual.toString());
}

/* 加權：min 4d₅⁻ + 5d₆⁻，檢查權重確實被使用 */
{
  const spec = GP.examples[2].build();
  const result = GP.solve(spec);
  const level5 = result.levels[4];
  check('加權目標：P₅ 含兩項', level5.terms.length === 2);
  const d5 = result.goals[4].under;
  const d6 = result.goals[5].under;
  check('加權目標：P₅ 數值 = 4d₅⁻ + 5d₆⁻', level5.achieved.eq(d5.mul(F(4)).add(d6.mul(F(5)))));
  // 同一個模型把權重對調，結果的加權和應不同或解不同（權重有作用）
  const swapped = GP.clone(spec);
  swapped.goals[4].under.w = '5';
  swapped.goals[5].under.w = '4';
  const other = GP.solve(swapped);
  check('加權目標：權重對調後仍可求解', other.status === 'optimal');
  check('加權目標：權重對調後 P₅ 值不同（權重確實進入目標函數）',
    !other.levels[4].achieved.eq(level5.achieved) || !other.goals[4].under.eq(d5),
    show([level5.achieved]) + ' vs ' + show([other.levels[4].achieved]));
}

/* --------------------------------------------------------------------- */
/* 3. 隨機模型壓力測試：兩變數、三變數                                    */
/* --------------------------------------------------------------------- */
let seed = 20260811;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function randInt(low, high) {
  return low + Math.floor(rand() * (high - low + 1));
}

function randomSpec(varCount) {
  const names = [];
  for (let index = 0; index < varCount; index += 1) {
    names.push('x' + (index + 1));
  }
  const goalCount = randInt(2, 4);
  const goals = [];
  for (let index = 0; index < goalCount; index += 1) {
    const op = ['>=', '<=', '='][randInt(0, 2)];
    const a = names.map(() => String(randInt(0, 6)));
    if (a.every((value) => value === '0')) {
      a[0] = '1';
    }
    const defaults = GP.defaultPenalties(op, randInt(1, 3));
    const goal = {
      label: '',
      a: a,
      op: op,
      target: String(randInt(5, 60)),
      under: defaults.under,
      over: defaults.over
    };
    if (rand() < 0.4) {
      goal.under.w = String(randInt(1, 5));
      goal.over.w = String(randInt(1, 5));
    }
    goals.push(goal);
  }
  const hard = [];
  if (rand() < 0.6) {
    hard.push({ label: '', a: names.map(() => String(randInt(1, 4))), op: '<=', b: String(randInt(20, 80)) });
  }
  return GP.create({ varNames: names, goals: goals, hard: hard });
}

let randomChecked = 0;
for (let trial = 0; trial < 160; trial += 1) {
  const varCount = trial % 2 === 0 ? 2 : 3;
  const spec = randomSpec(varCount);
  const compiled = GP.compile(spec);
  if (!compiled.ok || !compiled.levels.length) {
    continue;
  }
  const result = GP.solve(spec);
  const brute = bruteLexVertices(spec);
  if (brute.vector === null) {
    check('隨機 #' + trial + '：頂點列舉無可行解時引擎也應無可行解', result.status === 'infeasible', result.status);
    continue;
  }
  randomChecked += 1;
  check('隨機 #' + trial + '（' + varCount + ' 變數）：可求解', result.status === 'optimal', result.status);
  if (result.status !== 'optimal') {
    continue;
  }
  check(
    '隨機 #' + trial + '：字典式最佳值與頂點列舉一致',
    sameVector(levelVector(result), brute.vector),
    'engine=' + show(levelVector(result)) + ' brute=' + show(brute.vector) + ' ' + JSON.stringify(spec)
  );
  check('隨機 #' + trial + '：硬限制成立', result.hard.every((row) => (row.op === '<=' ? row.lhs.lte(row.rhs) : row.lhs.gte(row.rhs))));
}
check('隨機測試：至少驗證了 100 個模型', randomChecked >= 100, String(randomChecked));

/* --------------------------------------------------------------------- */
/* 4. 整數規劃                                                            */
/* --------------------------------------------------------------------- */
{
  const spec = GP.examples[3].build(); // Rucklehouse
  spec.integer = [true, true];
  const result = GP.solve(spec);
  const brute = bruteLexInteger(spec, 80);
  check('整數（Rucklehouse）：可求解', result.status === 'optimal', result.status);
  check('整數（Rucklehouse）：解為整數', result.x.every((value) => value.isInteger()), show(result.x));
  check('整數（Rucklehouse）：各層數值與暴力列舉一致', sameVector(levelVector(result), brute.vector),
    'engine=' + show(levelVector(result)) + ' brute=' + show(brute.vector));
}

{
  const spec = GP.examples[4].build(); // 診所
  spec.integer = [true, true, true];
  const result = GP.solve(spec);
  const brute = bruteLexInteger(spec, 40);
  check('整數（診所）：各層數值與暴力列舉一致', sameVector(levelVector(result), brute.vector),
    'engine=' + show(levelVector(result)) + ' brute=' + show(brute.vector));
}

/* --------------------------------------------------------------------- */
/* 5. 邊界情形                                                            */
/* --------------------------------------------------------------------- */
{
  const spec = GP.create({
    varNames: ['x1'],
    hard: [
      { a: ['1'], op: '>=', b: '5' },
      { a: ['1'], op: '<=', b: '3' }
    ],
    goals: [{ a: ['1'], op: '>=', target: '10' }]
  });
  const result = GP.solve(spec);
  check('硬限制互相矛盾 → 無可行解', result.status === 'infeasible', result.status);
}

{
  const spec = GP.create({
    varNames: ['x1'],
    hard: [{ a: ['1'], op: '<=', b: '4' }],
    goals: [{ a: ['1'], op: '>=', target: '10' }]
  });
  const result = GP.solve(spec);
  check('硬限制擋住目標：d⁻ = 6', result.status === 'optimal' && result.goals[0].under.eq(F(6)), result.status);
  check('硬限制擋住目標：未達成', result.goals[0].met === false);
}

{
  const spec = GP.create({
    varNames: ['x1', 'x2'],
    goals: [{ a: ['1', 'abc'], op: '>=', target: '10' }]
  });
  const result = GP.solve(spec);
  check('非數字係數 → invalid', result.status === 'invalid' && result.errors.length > 0, result.status);
}

{
  const spec = GP.create({ varNames: ['x1'], goals: [] });
  check('沒有目標 → invalid', GP.solve(spec).status === 'invalid');
}

{
  const spec = GP.create({
    varNames: ['x1'],
    goals: [{ a: ['1'], dev: 'd1+', op: '>=', target: '10' }]
  });
  check('引用自己的離差變數 → invalid', GP.solve(spec).status === 'invalid');
}

{
  const spec = GP.create({
    varNames: ['x1'],
    goals: [{ a: ['1'], op: '>=', target: '10', under: { p: '0', w: '1' } }]
  });
  check('優先順序 0 → invalid', GP.solve(spec).status === 'invalid');
}

{
  const spec = GP.create({
    varNames: ['x1'],
    goals: [{ a: ['1'], op: '>=', target: '10', under: { p: '1', w: '0' } }]
  });
  check('權重 0 → invalid', GP.solve(spec).status === 'invalid');
}

{
  const spec = GP.create({
    varNames: ['x1'],
    goals: [{ a: ['1'], op: '=', target: '7/3', under: { p: '1', w: '1' }, over: { p: '1', w: '1' } }]
  });
  const result = GP.solve(spec);
  check('分數目標值 7/3：精確求解', result.status === 'optimal' && result.x[0].eq(Frac.coerce('7/3')), result.x && result.x[0].toString());
  check('分數目標值：兩個偏離量皆為 0 → 達成', result.goals[0].met === true);
}

{
  // 優先層編號不連續（1、3、7）仍依大小順序求解
  const spec = GP.create({
    varNames: ['x1', 'x2'],
    goals: [
      { a: ['1', '0'], op: '<=', target: '5', under: { p: '', w: '1' }, over: { p: '3', w: '1' } },
      { a: ['1', '1'], op: '>=', target: '10', under: { p: '1', w: '1' }, over: { p: '', w: '1' } },
      { a: ['0', '1'], op: '<=', target: '2', under: { p: '', w: '1' }, over: { p: '7', w: '1' } }
    ]
  });
  const result = GP.solve(spec);
  check('不連續優先層編號：依 1、3、7 排序', result.levels.map((level) => level.p).join(',') === '1,3,7',
    result.levels && result.levels.map((level) => level.p).join(','));
  check('不連續優先層編號：P₁ 達成（x₁+x₂ ≥ 10）', result.levels[0].achieved.isZero());
}

{
  // 模型輸出（文字、HTML）不應丟例外
  GP.examples.forEach((example) => {
    const spec = example.build();
    const text = GP.modelText(spec);
    const html = GP.modelHTML(spec);
    check(example.id + '：模型文字含 min 與 subject to', /min/.test(text) && /subject to/.test(text));
    check(example.id + '：模型 HTML 非空', html.length > 50);
  });
  const text = GP.modelText(GP.examples[2].build());
  check('完整模式文字含加權項 4 d₅⁻ + 5 d₆⁻', text.indexOf('4 d₅⁻ + 5 d₆⁻') >= 0, text.split('\n')[0]);
  check('完整模式文字含 d₁⁺ + d₄⁻ − d₄⁺ = 10', text.indexOf('d₁⁺ + d₄⁻ − d₄⁺ = 10') >= 0, text);
}

{
  const parsed = GP.parseDeviationTerms('d1+, 2*d3-, -d2+, 1/2 d1-', 3);
  check('離差運算式解析：4 項', parsed.terms.length === 4 && parsed.errors.length === 0, JSON.stringify(parsed.errors));
  check('離差運算式解析：係數與方向',
    parsed.terms[1].coef.eq(F(2)) && parsed.terms[1].side === '-' && parsed.terms[2].coef.eq(F(-1)) &&
      parsed.terms[3].coef.eq(F('1/2')));
  check('離差運算式解析：超出目標數量 → 錯誤', GP.parseDeviationTerms('d9+', 3).errors.length === 1);
  check('離差運算式解析：亂碼 → 錯誤', GP.parseDeviationTerms('foo', 3).errors.length === 1);
  check('離差運算式解析：空字串 → 無項目', GP.parseDeviationTerms('', 3).terms.length === 0);
}

console.log('\n目標規劃引擎檢測：通過 ' + passed + ' 項，失敗 ' + failed + ' 項');
if (failed > 0) {
  process.exit(1);
}
