/* ============================================================================
 * solver.js — 線性規劃求解核心
 * ----------------------------------------------------------------------------
 * 1. 標準化：最大化／最小化、≤／=／≥、自由變數拆分、右端負值翻轉
 * 2. 兩階段單純形法（Phase I 建立可行基、Phase II 追求最佳解）
 * 3. 最佳化後的敏感度分析：影子價格、減價成本、右端允許範圍、
 *    目標係數允許範圍（全程精確有理數）
 * 4. 整數規劃：分支定界法（Branch and Bound）
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});
  var Frac = LPC.Frac;

  var DEFAULT_MAX_ITER = 4000;
  var DEGENERATE_STREAK_LIMIT = 12;
  var DEFAULT_NODE_LIMIT = 4000;

  /* --------------------------------------------------------------------- */
  /* 單純形表                                                              */
  /* --------------------------------------------------------------------- */

  function Tableau(config) {
    this.A = config.A;
    this.b = config.b;
    this.c = config.c;
    this.basis = config.basis;
    this.blocked = config.blocked || [];
    this.rows = this.A.length;
    this.cols = this.rows > 0 ? this.A[0].length : 0;
    this.z = Frac.zero();
    this.recomputeCosts();
  }

  /** 由目前基變數重新計算檢定數（reduced cost）與目標值。 */
  Tableau.prototype.recomputeCosts = function () {
    this.d = new Array(this.cols);
    for (var colIndex = 0; colIndex < this.cols; colIndex++) {
      var weighted = Frac.zero();
      for (var rowIndex = 0; rowIndex < this.rows; rowIndex++) {
        var basicCost = this.c[this.basis[rowIndex]];
        var coefficient = this.A[rowIndex][colIndex];
        if (!basicCost.isZero() && !coefficient.isZero()) {
          weighted = weighted.add(basicCost.mul(coefficient));
        }
      }
      this.d[colIndex] = this.c[colIndex].sub(weighted);
    }
    var objective = Frac.zero();
    for (var index = 0; index < this.rows; index++) {
      objective = objective.add(this.c[this.basis[index]].mul(this.b[index]));
    }
    this.z = objective;
  };

  Tableau.prototype.pivot = function (pivotRow, pivotCol) {
    var inverse = this.A[pivotRow][pivotCol].inv();
    var newRow = this.A[pivotRow].map(function (value) {
      return value.mul(inverse);
    });
    var newRhs = this.b[pivotRow].mul(inverse);
    var enteringCost = this.d[pivotCol];
    var rowIndex;
    var colIndex;

    for (rowIndex = 0; rowIndex < this.rows; rowIndex++) {
      if (rowIndex === pivotRow) {
        continue;
      }
      var factor = this.A[rowIndex][pivotCol];
      if (factor.isZero()) {
        continue;
      }
      var targetRow = this.A[rowIndex];
      for (colIndex = 0; colIndex < this.cols; colIndex++) {
        var scaled = newRow[colIndex];
        if (!scaled.isZero()) {
          targetRow[colIndex] = targetRow[colIndex].sub(scaled.mul(factor));
        }
      }
      this.b[rowIndex] = this.b[rowIndex].sub(newRhs.mul(factor));
    }

    for (colIndex = 0; colIndex < this.cols; colIndex++) {
      var rowValue = newRow[colIndex];
      if (!rowValue.isZero() && !enteringCost.isZero()) {
        this.d[colIndex] = this.d[colIndex].sub(rowValue.mul(enteringCost));
      }
    }
    this.z = this.z.add(enteringCost.mul(newRhs));

    this.A[pivotRow] = newRow;
    this.b[pivotRow] = newRhs;
    this.basis[pivotRow] = pivotCol;
  };

  Tableau.prototype.isBlocked = function (colIndex) {
    return this.blocked[colIndex] === true;
  };

  /** Dantzig 規則（可切換 Bland 規則以避免退化循環）挑選進入變數。 */
  Tableau.prototype.chooseEntering = function (useBland) {
    var best = -1;
    var bestValue = null;
    for (var colIndex = 0; colIndex < this.cols; colIndex++) {
      if (this.isBlocked(colIndex)) {
        continue;
      }
      var reduced = this.d[colIndex];
      if (!reduced.isPos()) {
        continue;
      }
      if (useBland) {
        return colIndex;
      }
      if (bestValue === null || reduced.gt(bestValue)) {
        best = colIndex;
        bestValue = reduced;
      }
    }
    return best;
  };

  /** 最小比值測試；同值時以基變數索引較小者優先。 */
  Tableau.prototype.chooseLeaving = function (enteringCol) {
    var best = -1;
    var bestRatio = null;
    for (var rowIndex = 0; rowIndex < this.rows; rowIndex++) {
      var coefficient = this.A[rowIndex][enteringCol];
      if (!coefficient.isPos()) {
        continue;
      }
      var ratio = this.b[rowIndex].div(coefficient);
      if (bestRatio === null || ratio.lt(bestRatio)) {
        best = rowIndex;
        bestRatio = ratio;
        continue;
      }
      if (ratio.eq(bestRatio) && this.basis[rowIndex] < this.basis[best]) {
        best = rowIndex;
      }
    }
    return best;
  };

  Tableau.prototype.snapshot = function (meta) {
    var details = meta || {};
    return {
      phase: details.phase || 1,
      A: this.A.map(function (row) {
        return row.slice();
      }),
      b: this.b.slice(),
      d: this.d.slice(),
      basis: this.basis.slice(),
      z: this.z,
      entering: details.entering === undefined ? -1 : details.entering,
      leaving: details.leaving === undefined ? -1 : details.leaving,
      pivotValue: details.pivotValue || null,
      step: details.step || null
    };
  };

  Tableau.prototype.iterate = function (options) {
    var opts = options || {};
    var maxIter = opts.maxIter || DEFAULT_MAX_ITER;
    var snapshots = [];
    var degenerateStreak = 0;
    var useBland = false;
    var iteration = 0;

    while (iteration < maxIter) {
      var entering = this.chooseEntering(useBland);
      if (entering < 0) {
        return { status: 'optimal', iterations: snapshots, iterationCount: iteration };
      }
      var leaving = this.chooseLeaving(entering);
      if (leaving < 0) {
        return {
          status: 'unbounded',
          iterations: snapshots,
          iterationCount: iteration,
          unboundedCol: entering
        };
      }
      var pivotValue = this.A[leaving][entering];
      var step = this.b[leaving].div(pivotValue);
      if (opts.record) {
        snapshots.push(
          this.snapshot({
            phase: opts.phase,
            entering: entering,
            leaving: leaving,
            pivotValue: pivotValue,
            step: step
          })
        );
      }
      this.pivot(leaving, entering);
      iteration += 1;
      if (this.b[leaving].isZero()) {
        degenerateStreak += 1;
      } else {
        degenerateStreak = 0;
      }
      if (degenerateStreak >= DEGENERATE_STREAK_LIMIT) {
        useBland = true;
      }
    }
    return { status: 'iteration-limit', iterations: snapshots, iterationCount: iteration };
  };

  /* --------------------------------------------------------------------- */
  /* 模型正規化                                                            */
  /* --------------------------------------------------------------------- */

  function normalizeOperator(op) {
    if (op === '>=' || op === '≥' || op === '=>') {
      return '>=';
    }
    if (op === '=' || op === '==' || op === '＝' || op === '≦' || op === '≧') {
      if (op === '≦') {
        return '<=';
      }
      if (op === '≧') {
        return '>=';
      }
      return '=';
    }
    return '<=';
  }

  function flipOperator(op) {
    if (op === '<=') {
      return '>=';
    }
    if (op === '>=') {
      return '<=';
    }
    return '=';
  }

  function buildColumnLabels(colMeta, variableNames) {
    var counters = { slack: 0, surplus: 0, artificial: 0 };
    return colMeta.map(function (meta) {
      if (meta.kind === 'var') {
        var name = variableNames[meta.owner] || 'x' + (meta.owner + 1);
        return meta.weight === -1 ? name + '−' : name;
      }
      if (meta.kind === 'slack') {
        counters.slack += 1;
        return 's' + counters.slack;
      }
      if (meta.kind === 'surplus') {
        counters.surplus += 1;
        return 'e' + counters.surplus;
      }
      counters.artificial += 1;
      return 'a' + counters.artificial;
    });
  }

  /**
   * 把「轉換後（最大化）空間」的係數變動區間映射回原始問題。
   * @param {Frac|null} lower 轉換空間的下界（≤0，null 表示無下界）
   * @param {Frac|null} upper 轉換空間的上界（≥0，null 表示無上界）
   * @param {number} signValue 1（最大化）或 -1（最小化）
   */
  function mapObjectiveDelta(lower, upper, signValue) {
    if (signValue > 0) {
      return { down: lower === null ? null : lower.neg(), up: upper };
    }
    return { down: upper, up: lower === null ? null : lower.neg() };
  }

  /* --------------------------------------------------------------------- */
  /* 主要求解流程                                                          */
  /* --------------------------------------------------------------------- */

  /**
   * @param {Object} model  {sense, c, constraints, nonNeg, variableNames}
   * @param {Object} [options] {record, maxIter}
   * @returns {Object} 求解結果
   */
  function solveLP(model, options) {
    var opts = options || {};
    var record = opts.record === true;
    var sense = model.sense === 'min' ? 'min' : 'max';
    var sign = sense === 'max' ? Frac.one() : Frac.minusOne();
    var variableNames = model.variableNames || [];
    var varCount = model.c.length;
    var freeVariables = model.nonNeg === false;

    if (!varCount) {
      return { ok: false, status: 'empty-model', message: '尚未設定決策變數', x: null, z: null };
    }

    var objectives = model.c.map(Frac.coerce);
    var constraints = (model.constraints || []).map(function (constraint) {
      var normalized = {
        a: constraint.a.map(Frac.coerce),
        op: normalizeOperator(constraint.op),
        b: Frac.coerce(constraint.b)
      };
      if (normalized.b.isNeg()) {
        normalized.a = normalized.a.map(function (value) {
          return value.neg();
        });
        normalized.b = normalized.b.neg();
        normalized.op = flipOperator(normalized.op);
      }
      return normalized;
    });

    var rowCount = constraints.length;
    var colMeta = [];
    var objectiveRow = [];
    var varColumns = [];
    var j;
    var rowIndex;
    var colIndex;

    for (j = 0; j < varCount; j += 1) {
      var positiveCol = colMeta.length;
      colMeta.push({ kind: 'var', owner: j, weight: 1 });
      objectiveRow.push(sign.mul(objectives[j]));
      if (freeVariables) {
        var negativeCol = colMeta.length;
        colMeta.push({ kind: 'var', owner: j, weight: -1 });
        objectiveRow.push(sign.mul(objectives[j]).neg());
        varColumns.push({ positive: positiveCol, negative: negativeCol });
      } else {
        varColumns.push({ positive: positiveCol, negative: null });
      }
    }

    var matrix = constraints.map(function (constraint) {
      var row = [];
      for (var index = 0; index < varCount; index += 1) {
        row.push(constraint.a[index]);
        if (freeVariables) {
          row.push(constraint.a[index].neg());
        }
      }
      return row;
    });
    var rhs = constraints.map(function (constraint) {
      return constraint.b;
    });
    var basis = new Array(rowCount).fill(-1);
    var initialBasisCol = new Array(rowCount).fill(-1);

    for (rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      var operator = constraints[rowIndex].op;
      /* 只有 ≥ 型需要剩餘變數；等式不需要（否則會放寬成 ≥）。 */
      if (operator === '>=') {
        colMeta.push({ kind: 'surplus', row: rowIndex });
        objectiveRow.push(Frac.zero());
        for (var surplusRow = 0; surplusRow < rowCount; surplusRow += 1) {
          matrix[surplusRow].push(surplusRow === rowIndex ? Frac.minusOne() : Frac.zero());
        }
      }
      if (operator === '<=') {
        colMeta.push({ kind: 'slack', row: rowIndex });
        objectiveRow.push(Frac.zero());
        for (var slackRow = 0; slackRow < rowCount; slackRow += 1) {
          matrix[slackRow].push(slackRow === rowIndex ? Frac.one() : Frac.zero());
        }
        basis[rowIndex] = colMeta.length - 1;
        initialBasisCol[rowIndex] = colMeta.length - 1;
      } else {
        colMeta.push({ kind: 'artificial', row: rowIndex });
        objectiveRow.push(Frac.zero());
        for (var artificialRow = 0; artificialRow < rowCount; artificialRow += 1) {
          matrix[artificialRow].push(artificialRow === rowIndex ? Frac.one() : Frac.zero());
        }
        basis[rowIndex] = colMeta.length - 1;
        initialBasisCol[rowIndex] = colMeta.length - 1;
      }
    }

    /* ---- 沒有拘束條件的退化情形 ---- */
    if (rowCount === 0) {
      var allNonPositive = objectiveRow.every(function (value) {
        return !value.isPos();
      });
      return {
        ok: true,
        status: allNonPositive ? 'optimal' : 'unbounded',
        sense: sense,
        x: new Array(varCount).fill(Frac.zero()),
        z: Frac.zero(),
        iterations: [],
        alternative: false,
        variableNames: variableNames,
        columnMeta: colMeta,
        columnLabels: buildColumnLabels(colMeta, variableNames),
        varInfo: [],
        constraints: [],
        note: allNonPositive ? '沒有設定限制式，最佳解落在原點。' : '沒有設定限制式，目標函數可無限增大。'
      };
    }

    var snapshots = [];
    var artificialCount = colMeta.filter(function (meta) {
      return meta.kind === 'artificial';
    }).length;

    /* ---- 第一階段：最小化人工變數總和 ---- */
    var tableau = null;
    if (artificialCount > 0) {
      var phaseOneCost = colMeta.map(function (meta) {
        return meta.kind === 'artificial' ? Frac.minusOne() : Frac.zero();
      });
      tableau = new Tableau({
        A: matrix.map(function (row) {
          return row.slice();
        }),
        b: rhs.slice(),
        c: phaseOneCost,
        basis: basis.slice()
      });
      if (record) {
        snapshots.push(tableau.snapshot({ phase: 1 }));
      }
      var phaseOne = tableau.iterate({ phase: 1, record: record, maxIter: opts.maxIter });
      snapshots = snapshots.concat(phaseOne.iterations);
      if (phaseOne.status === 'iteration-limit') {
        return { ok: false, status: 'iteration-limit', message: '迭代次數超過上限。', x: null, z: null };
      }
      if (tableau.z.sign() < 0) {
        return {
          ok: true,
          status: 'infeasible',
          sense: sense,
          iterations: snapshots,
          x: null,
          z: null,
          variableNames: variableNames,
          columnMeta: colMeta,
          columnLabels: buildColumnLabels(colMeta, variableNames),
          constraints: []
        };
      }
      tableau.blocked = new Array(colMeta.length).fill(false);
      for (rowIndex = 0; rowIndex < tableau.rows; rowIndex += 1) {
        if (colMeta[tableau.basis[rowIndex]].kind !== 'artificial') {
          continue;
        }
        for (colIndex = 0; colIndex < tableau.cols; colIndex += 1) {
          if (colMeta[colIndex].kind === 'artificial') {
            continue;
          }
          if (!tableau.A[rowIndex][colIndex].isZero()) {
            tableau.pivot(rowIndex, colIndex);
            break;
          }
        }
      }
      tableau.c = objectiveRow.slice();
      tableau.blocked = colMeta.map(function (meta) {
        return meta.kind === 'artificial';
      });
      tableau.recomputeCosts();
    } else {
      tableau = new Tableau({
        A: matrix.map(function (row) {
          return row.slice();
        }),
        b: rhs.slice(),
        c: objectiveRow.slice(),
        basis: basis.slice()
      });
    }

    if (record) {
      snapshots.push(tableau.snapshot({ phase: 2 }));
    }
    var phaseTwo = tableau.iterate({ phase: 2, record: record, maxIter: opts.maxIter });
    snapshots = snapshots.concat(phaseTwo.iterations);
    if (record && (phaseTwo.status === 'optimal' || phaseTwo.status === 'unbounded')) {
      var finalSnapshot = tableau.snapshot({ phase: 2 });
      finalSnapshot.final = true;
      finalSnapshot.terminal = phaseTwo.status;
      snapshots.push(finalSnapshot);
    }

    if (phaseTwo.status === 'iteration-limit') {
      return { ok: false, status: 'iteration-limit', message: '迭代次數超過上限。', x: null, z: null };
    }
    if (phaseTwo.status === 'unbounded') {
      return {
        ok: true,
        status: 'unbounded',
        sense: sense,
        iterations: snapshots,
        x: null,
        z: null,
        unboundedColumn: phaseTwo.unboundedCol,
        variableNames: variableNames,
        columnMeta: colMeta,
        columnLabels: buildColumnLabels(colMeta, variableNames),
        constraints: []
      };
    }

    var solution = extractSolution({
      tableau: tableau,
      colMeta: colMeta,
      varColumns: varColumns,
      varCount: varCount,
      sign: sign,
      sense: sense,
      constraints: constraints,
      initialBasisCol: initialBasisCol,
      freeVariables: freeVariables,
      variableNames: variableNames
    });
    solution.iterations = snapshots;
    solution.columnMeta = colMeta;
    solution.columnLabels = buildColumnLabels(colMeta, variableNames);
    solution.phaseOneUsed = artificialCount > 0;
    solution.iterationCount = snapshots.length;
    return solution;
  }

  function extractSolution(context) {
    var tableau = context.tableau;
    var colMeta = context.colMeta;
    var sign = context.sign;
    var varCount = context.varCount;
    var rowCount = tableau.rows;
    var rowIndex;
    var colIndex;
    var j;

    var columnValues = new Array(tableau.cols).fill(Frac.zero());
    for (rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      columnValues[tableau.basis[rowIndex]] = tableau.b[rowIndex];
    }

    var values = [];
    for (j = 0; j < varCount; j += 1) {
      var columns = context.varColumns[j];
      var value = columnValues[columns.positive];
      if (columns.negative !== null) {
        value = value.sub(columnValues[columns.negative]);
      }
      values.push(value);
    }

    var zValue = sign.mul(tableau.z);

    /* B⁻¹ 的第 i 欄 = 初始基變數 i 在最終表的欄位 */
    var initialBasisOfRow = context.initialBasisCol;
    var basisCosts = tableau.basis.map(function (col) {
      return tableau.c[col];
    });
    var duals = [];
    for (colIndex = 0; colIndex < rowCount; colIndex += 1) {
      var dual = Frac.zero();
      for (rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        if (!basisCosts[rowIndex].isZero()) {
          dual = dual.add(basisCosts[rowIndex].mul(tableau.A[rowIndex][initialBasisOfRow[colIndex]]));
        }
      }
      duals.push(sign.mul(dual));
    }

    var basicRowOfColumn = new Array(tableau.cols).fill(-1);
    for (rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      basicRowOfColumn[tableau.basis[rowIndex]] = rowIndex;
    }

    var redundantRows = {};
    var artificialInBasis = false;
    for (rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      var basisMeta = colMeta[tableau.basis[rowIndex]];
      if (basisMeta.kind === 'artificial') {
        artificialInBasis = true;
        redundantRows[basisMeta.row] = true;
      }
    }

    var constraintInfo = context.constraints.map(function (constraint, index) {
      var leftHandSide = Frac.zero();
      constraint.a.forEach(function (coefficient, position) {
        leftHandSide = leftHandSide.add(coefficient.mul(values[position]));
      });
      var difference = leftHandSide.sub(constraint.b);
      var slackValue = constraint.op === '<=' ? difference.neg() : difference;
      var isRedundant = redundantRows[index] === true;
      return {
        index: index,
        op: constraint.op,
        rhs: constraint.b,
        lhs: leftHandSide,
        slack: slackValue,
        binding: leftHandSide.eq(constraint.b),
        shadow: isRedundant ? Frac.zero() : duals[index],
        range: redundantRows[index] === true ? null : computeRhsRange(index, tableau, rowCount, initialBasisOfRow[index]),
        redundant: isRedundant
      };
    });

    var objectiveRanges = computeObjectiveRanges({
      tableau: tableau,
      colMeta: colMeta,
      varColumns: context.varColumns,
      varCount: varCount,
      sign: sign,
      basicRowOfColumn: basicRowOfColumn,
      freeVariables: context.freeVariables
    });

    var varInfo = [];
    for (j = 0; j < varCount; j += 1) {
      var positiveCol = context.varColumns[j].positive;
      var basicRow = basicRowOfColumn[positiveCol];
      var varRange = objectiveRanges[j];
      varInfo.push({
        index: j,
        name: context.variableNames[j] || 'x' + (j + 1),
        value: values[j],
        basic: basicRow >= 0,
        basicRow: basicRow,
        reducedCost: sign.mul(tableau.d[positiveCol]),
        objRange: varRange,
        isInteger: false
      });
    }

    var alternativeVariables = [];
    for (colIndex = 0; colIndex < tableau.cols; colIndex += 1) {
      var meta = colMeta[colIndex];
      if (meta.kind !== 'var' || basicRowOfColumn[colIndex] >= 0) {
        continue;
      }
      if (tableau.d[colIndex].isZero()) {
        alternativeVariables.push(meta.owner);
      }
    }

    return {
      ok: true,
      status: 'optimal',
      sense: context.sense,
      x: values,
      z: zValue,
      variableNames: context.variableNames,
      varInfo: varInfo,
      constraints: constraintInfo,
      duals: duals,
      alternative: alternativeVariables.length > 0,
      alternativeVariables: alternativeVariables,
      artificialInBasis: artificialInBasis,
      freeVariables: context.freeVariables,
      objective: context.tableau.c.slice(context.varCount)
    };
  }

  /**
   * 右端常數 b_i 的允許變動範圍（維持同一組基 ⟹ 仍為最佳解）。
   * Δb_i ∈ [−down, +up]。
   */
  function computeRhsRange(constraintIndex, tableau, rowCount, basisColumn) {
    var down = null;
    var up = null;
    for (var index = 0; index < rowCount; index += 1) {
      var coefficient = tableau.A[index][basisColumn];
      if (coefficient.isZero()) {
        continue;
      }
      var rhsValue = tableau.b[index];
      if (coefficient.isPos()) {
        var decrement = rhsValue.div(coefficient);
        if (down === null || decrement.lt(down)) {
          down = decrement;
        }
      } else {
        var increment = rhsValue.div(coefficient.neg());
        if (up === null || increment.lt(up)) {
          up = increment;
        }
      }
    }
    void constraintIndex;
    return { down: down, up: up };
  }

  /**
   * 目標係數的允許變動範圍（維持同一組基 ⟹ 最佳解不變）。
   */
  function computeObjectiveRanges(context) {
    var tableau = context.tableau;
    var colMeta = context.colMeta;
    var results = [];
    var j;

    if (context.freeVariables) {
      for (j = 0; j < context.varCount; j += 1) {
        results.push(null);
      }
      return results;
    }

    for (j = 0; j < context.varCount; j += 1) {
      var positiveCol = context.varColumns[j].positive;
      var basicRow = context.basicRowOfColumn[positiveCol];
      var lower = null;
      var upper = null;

      if (basicRow >= 0) {
        for (var colIndex = 0; colIndex < tableau.cols; colIndex += 1) {
          if (colMeta[colIndex].kind === 'artificial') {
            continue;
          }
          if (context.basicRowOfColumn[colIndex] >= 0) {
            continue;
          }
          var alpha = tableau.A[basicRow][colIndex];
          if (alpha.isZero()) {
            continue;
          }
          var bound = tableau.d[colIndex].div(alpha);
          if (alpha.isPos()) {
            if (lower === null || bound.gt(lower)) {
              lower = bound;
            }
          } else if (upper === null || bound.lt(upper)) {
            upper = bound;
          }
        }
      } else {
        upper = tableau.d[positiveCol].neg();
      }

      var mapped = mapObjectiveDelta(lower, upper, context.sign.sign());
      results.push({ down: mapped.down, up: mapped.up, basic: basicRow >= 0 });
    }
    return results;
  }

  /* --------------------------------------------------------------------- */
  /* 整數規劃：分支定界                                                    */
  /* --------------------------------------------------------------------- */

  function cloneModel(model) {
    return {
      sense: model.sense,
      c: model.c.slice(),
      nonNeg: model.nonNeg,
      variableNames: (model.variableNames || []).slice(),
      integer: (model.integer || []).slice(),
      binary: (model.binary || []).slice(),
      constraints: (model.constraints || []).map(function (constraint) {
        return { a: constraint.a.slice(), op: constraint.op, b: constraint.b };
      })
    };
  }

  function withExtras(baseModel, extras) {
    var model = cloneModel(baseModel);
    extras.forEach(function (extra) {
      model.constraints.push({ a: extra.a.slice(), op: extra.op, b: extra.b });
    });
    return model;
  }

  function isBetter(candidate, incumbent, sense) {
    if (!incumbent) {
      return true;
    }
    return sense === 'max' ? candidate.gt(incumbent) : candidate.lt(incumbent);
  }

  function solveInteger(model, options) {
    var opts = options || {};
    var nodeLimit = opts.nodeLimit || DEFAULT_NODE_LIMIT;
    var sense = model.sense === 'min' ? 'min' : 'max';
    var varCount = model.c.length;
    var integerFlags = model.integer || [];
    var binaryFlags = model.binary || [];
    var relevant = [];
    var j;

    for (j = 0; j < varCount; j += 1) {
      if (integerFlags[j] || binaryFlags[j]) {
        relevant.push(j);
      }
    }
    if (!relevant.length) {
      var relaxed = solveLP(model, opts);
      relaxed.integer = false;
      return relaxed;
    }

    var baseModel = cloneModel(model);
    for (j = 0; j < varCount; j += 1) {
      if (!binaryFlags[j]) {
        continue;
      }
      var boundRow = new Array(varCount).fill(Frac.zero());
      boundRow[j] = Frac.one();
      baseModel.constraints.push({ a: boundRow, op: '<=', b: Frac.one() });
    }

    var originalConstraintCount = (model.constraints || []).length;
    var rootRelaxation = solveLP(baseModel, { record: false });
    rootRelaxation.integer = true;
    if (rootRelaxation.status === 'infeasible' || rootRelaxation.status === 'unbounded') {
      rootRelaxation.lpRelaxation = rootRelaxation;
      return rootRelaxation;
    }

    var stack = [{ extras: [], depth: 0, bound: rootRelaxation.z }];
    var incumbent = null;
    var incumbentNode = null;
    var nodeCount = 1;
    var branchLog = [];
    var pruned = 0;

    while (stack.length > 0 && nodeCount < nodeLimit) {
      var node = stack.pop();
      if (incumbent && !isBetter(node.bound, incumbent, sense)) {
        pruned += 1;
        continue;
      }
      nodeCount += 1;

      var lp = solveLP(withExtras(baseModel, node.extras), { record: false });
      if (lp.status === 'infeasible') {
        branchLog.push({ depth: node.depth, verdict: 'infeasible' });
        continue;
      }
      if (lp.status !== 'optimal') {
        branchLog.push({ depth: node.depth, verdict: 'unbounded' });
        continue;
      }
      if (incumbent && !isBetter(lp.z, incumbent, sense)) {
        pruned += 1;
        continue;
      }

      var branchVar = -1;
      var bestCentrality = null;
      for (var index = 0; index < relevant.length; index += 1) {
        var candidate = lp.x[relevant[index]];
        if (candidate.isInteger()) {
          continue;
        }
        var fractionalPart = candidate.sub(candidate.floor()).toNumber();
        var centrality = Math.abs(fractionalPart - 0.5);
        if (bestCentrality === null || centrality < bestCentrality) {
          bestCentrality = centrality;
          branchVar = relevant[index];
        }
      }

      if (branchVar < 0) {
        incumbent = lp.z;
        incumbentNode = lp;
        branchLog.push({ depth: node.depth, verdict: 'integer', z: lp.z });
        continue;
      }

      var branchValue = lp.x[branchVar];
      branchLog.push({
        depth: node.depth,
        verdict: 'branch',
        variable: branchVar,
        value: branchValue,
        z: lp.z
      });

      var lowerBranch = new Array(varCount).fill(Frac.zero());
      lowerBranch[branchVar] = Frac.one();
      stack.push({
        extras: node.extras.concat([{ a: lowerBranch, op: '>=', b: branchValue.ceil() }]),
        depth: node.depth + 1,
        bound: lp.z
      });
      var upperBranch = lowerBranch.slice();
      stack.push({
        extras: node.extras.concat([{ a: upperBranch, op: '<=', b: branchValue.floor() }]),
        depth: node.depth + 1,
        bound: lp.z
      });
    }

    if (!incumbentNode) {
      return {
        ok: true,
        status: 'infeasible',
        sense: sense,
        integer: true,
        nodes: nodeCount,
        branchLog: branchLog,
        lpRelaxation: rootRelaxation,
        variableNames: model.variableNames,
        constraints: []
      };
    }

    var result = incumbentNode;
    result.integer = true;
    result.nodes = nodeCount;
    result.pruned = pruned;
    result.branchLog = branchLog;
    result.lpRelaxation = rootRelaxation;
    result.hitLimit = stack.length > 0 && nodeCount >= nodeLimit;
    result.status = result.hitLimit ? 'limit' : 'optimal';
    result.originalConstraintCount = originalConstraintCount;
    /* 只保留使用者原本設定的限制式；0-1 上界與分支條件屬於求解過程，不列入分析 */
    result.constraints = (result.constraints || []).slice(0, originalConstraintCount);
    return result;
  }

  LPC.solver = {
    solveLP: solveLP,
    solveInteger: solveInteger,
    Tableau: Tableau,
    normalizeOperator: normalizeOperator
  };
})(typeof window !== 'undefined' ? window : globalThis);
