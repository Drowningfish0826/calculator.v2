/* ============================================================================
 * goal.js — 目標規劃（Goal Programming）求解引擎
 * ----------------------------------------------------------------------------
 * 依「多目標決策：目標規劃」講義實作：
 *   1. 每個目標建立「目標限制式」：  Σ aⱼxⱼ + dᵢ⁻ − dᵢ⁺ = 目標值
 *      dᵢ⁻ = 不足量、dᵢ⁺ = 超額量（離差變數）
 *   2. 只最小化「不希望發生」的偏離量；各偏離量可指定優先順序 Pₖ 與權重
 *   3. 優先順序目標規劃（Preemptive GP）：由 P₁ 往下逐層求解，
 *      每解完一層就把該層最佳值鎖成新的限制式，再解下一層
 *   4. 同一優先層內可加權（例如 min 4d₅⁻ + 5d₆⁻）
 *   5. 目標限制式可含其他目標的離差變數（講義「目標中的目標」，例：d₁⁺ + d₄⁻ − d₄⁺ = 10）
 *
 * 所有運算沿用 Frac 精確分數，並呼叫 LPC.solver 的單純形法／分支定界法。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});
  var Frac = LPC.Frac;

  var MAX_VARIABLES = 10;
  var MAX_GOALS = 12;
  var MAX_HARD = 20;

  /* --------------------------------------------------------------------- */
  /* 文字工具                                                              */
  /* --------------------------------------------------------------------- */

  var SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉';

  function subscript(number) {
    return String(number)
      .split('')
      .map(function (digit) {
        return SUBSCRIPTS.charAt(Number(digit));
      })
      .join('');
  }

  function escapeHTML(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmt(value) {
    return LPC.model ? LPC.model.fmt(value) : String(value);
  }

  /** 離差變數名稱（純文字）：d₁⁻ / d₁⁺ */
  function devText(goalIndex, side) {
    return 'd' + subscript(goalIndex + 1) + (side === '-' ? '⁻' : '⁺');
  }

  /** 離差變數名稱（HTML）：d<sub>1</sub><sup>−</sup> */
  function devHTML(goalIndex, side) {
    return (
      '<span class="math-var">d<sub>' + (goalIndex + 1) + '</sub><sup>' + (side === '-' ? '−' : '+') + '</sup></span>'
    );
  }

  function varHTML(name) {
    var text = String(name);
    var digits = /([0-9]+)$/.exec(text);
    var base = escapeHTML(text.replace(/[0-9]+$/, ''));
    return '<span class="math-var">' + base + (digits ? '<sub>' + escapeHTML(digits[1]) + '</sub>' : '') + '</span>';
  }

  /* --------------------------------------------------------------------- */
  /* 預設值與建立                                                          */
  /* --------------------------------------------------------------------- */

  function blankPenalty() {
    return { p: '', w: '1' };
  }

  /** 依目標型態（≥／≤／=）給出預設的「要最小化哪個偏離量」。 */
  function defaultPenalties(op, priority) {
    var level = priority === undefined || priority === null ? '1' : String(priority);
    if (op === '>=') {
      return { under: { p: level, w: '1' }, over: blankPenalty() };
    }
    if (op === '<=') {
      return { under: blankPenalty(), over: { p: level, w: '1' } };
    }
    return { under: { p: level, w: '1' }, over: { p: level, w: '1' } };
  }

  function create(spec) {
    var source = spec || {};
    var varNames = (source.varNames || ['x1', 'x2']).slice();
    var n = varNames.length;
    function pad(list, fallback) {
      var result = [];
      for (var index = 0; index < n; index += 1) {
        result.push(list && list[index] !== undefined && list[index] !== null ? String(list[index]) : fallback);
      }
      return result;
    }
    function penalty(value) {
      if (!value) {
        return blankPenalty();
      }
      return {
        p: value.p === undefined || value.p === null ? '' : String(value.p),
        w: value.w === undefined || value.w === null || value.w === '' ? '1' : String(value.w)
      };
    }
    return {
      title: source.title || '',
      varNames: varNames,
      integer: varNames.map(function (_, index) {
        return !!(source.integer && source.integer[index]);
      }),
      hard: (source.hard || []).map(function (row) {
        return {
          label: row.label || '',
          a: pad(row.a, '0'),
          op: row.op === '>=' ? '>=' : row.op === '=' ? '=' : '<=',
          b: row.b === undefined || row.b === null ? '0' : String(row.b)
        };
      }),
      goals: (source.goals || []).map(function (goal) {
        var op = goal.op === '<=' ? '<=' : goal.op === '=' ? '=' : '>=';
        var defaults = defaultPenalties(op, 1);
        return {
          label: goal.label || '',
          a: pad(goal.a, '0'),
          dev: goal.dev ? String(goal.dev) : '',
          op: op,
          target: goal.target === undefined || goal.target === null ? '0' : String(goal.target),
          under: goal.under ? penalty(goal.under) : defaults.under,
          over: goal.over ? penalty(goal.over) : defaults.over
        };
      })
    };
  }

  function clone(spec) {
    return create(JSON.parse(JSON.stringify(spec)));
  }

  /* --------------------------------------------------------------------- */
  /* 離差變數運算式：d1+, 2*d3-, -d2+ …                                    */
  /* --------------------------------------------------------------------- */

  var DEV_TERM = /^([+-]?)\s*(?:(\d+(?:\.\d+)?(?:\/\d+)?)\s*\*?\s*)?d\s*(\d+)\s*\^?\s*([+-])$/;

  /**
   * 解析「含其他離差變數」的欄位。以逗號分隔多項。
   * @returns {{terms: Array<{goal:number, side:string, coef:Frac}>, errors: string[]}}
   */
  function parseDeviationTerms(text, goalCount) {
    var terms = [];
    var errors = [];
    var cleaned = String(text || '')
      .replace(/[−–—]/g, '-')
      .replace(/⁺/g, '+')
      .replace(/⁻/g, '-')
      .replace(/，|；|;/g, ',')
      .trim();
    if (!cleaned) {
      return { terms: terms, errors: errors };
    }
    cleaned.split(',').forEach(function (piece) {
      var part = piece.trim();
      if (!part) {
        return;
      }
      var match = DEV_TERM.exec(part);
      if (!match) {
        errors.push('「' + part + '」格式不對，請寫成 d1+ 或 2*d3-（以逗號分隔多項）');
        return;
      }
      var goal = Number(match[3]) - 1;
      if (goal < 0 || goal >= goalCount) {
        errors.push('找不到目標 ' + match[3] + '，目前只有 ' + goalCount + ' 個目標');
        return;
      }
      var coefficient = match[2] ? Frac.coerce(match[2]) : Frac.one();
      if (match[1] === '-') {
        coefficient = coefficient.neg();
      }
      terms.push({ goal: goal, side: match[4], coef: coefficient });
    });
    return { terms: terms, errors: errors };
  }

  /* --------------------------------------------------------------------- */
  /* 驗證與編譯                                                            */
  /* --------------------------------------------------------------------- */

  function isNumber(text) {
    try {
      Frac.coerce(text);
      return true;
    } catch (error) {
      return false;
    }
  }

  /** 欄位索引：決策變數 0..n-1，其後每個目標 i 依序為 dᵢ⁻、dᵢ⁺。 */
  function underCol(n, goalIndex) {
    return n + 2 * goalIndex;
  }

  function overCol(n, goalIndex) {
    return n + 2 * goalIndex + 1;
  }

  function compile(spec) {
    var errors = [];
    var warnings = [];
    var n = spec.varNames.length;
    var m = spec.goals.length;
    var width = n + 2 * m;

    if (!n) {
      errors.push('至少要有一個決策變數。');
    }
    if (n > MAX_VARIABLES) {
      errors.push('決策變數最多 ' + MAX_VARIABLES + ' 個。');
    }
    if (!m) {
      errors.push('至少要設定一個目標。');
    }
    if (m > MAX_GOALS) {
      errors.push('目標最多 ' + MAX_GOALS + ' 個。');
    }
    if (spec.hard.length > MAX_HARD) {
      errors.push('系統限制式最多 ' + MAX_HARD + ' 條。');
    }

    function zeros() {
      var row = [];
      for (var index = 0; index < width; index += 1) {
        row.push(Frac.zero());
      }
      return row;
    }

    function readRow(list, where) {
      var row = zeros();
      list.forEach(function (value, index) {
        if (!isNumber(value)) {
          errors.push(where + '中 ' + spec.varNames[index] + ' 的係數「' + value + '」不是有效數字。');
          return;
        }
        row[index] = Frac.coerce(value);
      });
      return row;
    }

    var hardRows = spec.hard.map(function (row, index) {
      var where = '系統限制式 (' + (index + 1) + ')';
      var coefficients = readRow(row.a, where);
      if (!isNumber(row.b)) {
        errors.push(where + '的右端值「' + row.b + '」不是有效數字。');
      }
      return {
        a: coefficients,
        op: row.op,
        b: isNumber(row.b) ? Frac.coerce(row.b) : Frac.zero(),
        label: row.label
      };
    });

    var goalRows = spec.goals.map(function (goal, index) {
      var where = '目標 ' + (index + 1);
      var coefficients = readRow(goal.a, where);
      var parsed = parseDeviationTerms(goal.dev, m);
      parsed.errors.forEach(function (message) {
        errors.push(where + '：' + message);
      });
      parsed.terms.forEach(function (term) {
        if (term.goal === index) {
          errors.push(where + '不能引用自己的離差變數。');
          return;
        }
        var column = term.side === '-' ? underCol(n, term.goal) : overCol(n, term.goal);
        coefficients[column] = coefficients[column].add(term.coef);
      });
      if (!isNumber(goal.target)) {
        errors.push(where + '的目標值「' + goal.target + '」不是有效數字。');
      }
      coefficients[underCol(n, index)] = Frac.one();
      coefficients[overCol(n, index)] = Frac.minusOne();
      return {
        a: coefficients,
        op: goal.op,
        target: isNumber(goal.target) ? Frac.coerce(goal.target) : Frac.zero(),
        label: goal.label
      };
    });

    /* 優先層：把所有「要最小化」的偏離量依優先順序數字分組 */
    var byPriority = {};
    function addPenalty(goalIndex, side, penalty) {
      var text = String(penalty.p === undefined || penalty.p === null ? '' : penalty.p).trim();
      if (text === '') {
        return;
      }
      var where = '目標 ' + (goalIndex + 1) + ' 的 ' + devText(goalIndex, side);
      if (!/^\d+$/.test(text) || Number(text) < 1) {
        errors.push(where + '的優先順序必須是正整數（1 最優先）。');
        return;
      }
      var weight;
      try {
        weight = Frac.coerce(penalty.w === '' ? '1' : penalty.w);
      } catch (error) {
        errors.push(where + '的權重「' + penalty.w + '」不是有效數字。');
        return;
      }
      if (!weight.isPos()) {
        errors.push(where + '的權重必須大於 0。');
        return;
      }
      var key = Number(text);
      byPriority[key] = byPriority[key] || [];
      byPriority[key].push({
        goal: goalIndex,
        side: side,
        col: side === '-' ? underCol(n, goalIndex) : overCol(n, goalIndex),
        w: weight
      });
    }
    spec.goals.forEach(function (goal, index) {
      addPenalty(index, '-', goal.under);
      addPenalty(index, '+', goal.over);
    });

    var levels = Object.keys(byPriority)
      .map(Number)
      .sort(function (left, right) {
        return left - right;
      })
      .map(function (priority) {
        return { p: priority, name: 'P' + subscript(priority), plainName: 'P' + priority, terms: byPriority[priority] };
      });

    if (m && !levels.length && !errors.length) {
      warnings.push('尚未指定任何要最小化的偏離量（優先順序欄位全為空白），求解只會找一組可行解。');
    }

    spec.goals.forEach(function (goal, index) {
      var penalized = goal.under.p !== '' || goal.over.p !== '';
      if (!penalized) {
        warnings.push('目標 ' + (index + 1) + '沒有指定要最小化的偏離量，因此不會影響結果。');
      }
    });

    return {
      ok: errors.length === 0,
      errors: errors,
      warnings: warnings,
      n: n,
      m: m,
      width: width,
      hardRows: hardRows,
      goalRows: goalRows,
      levels: levels
    };
  }

  function validate(spec) {
    var compiled = compile(spec);
    return { ok: compiled.ok, errors: compiled.errors, warnings: compiled.warnings };
  }

  /* --------------------------------------------------------------------- */
  /* 求解                                                                  */
  /* --------------------------------------------------------------------- */

  function columnNames(spec) {
    var names = spec.varNames.slice();
    spec.goals.forEach(function (_, index) {
      names.push(devText(index, '-'));
      names.push(devText(index, '+'));
    });
    return names;
  }

  function levelObjectiveText(level) {
    var pieces = level.terms.map(function (term, index) {
      var name = devText(term.goal, term.side);
      var weight = term.w.isOne() ? '' : fmt(term.w) + ' ';
      return (index === 0 ? '' : '+ ') + weight + name;
    });
    return 'min ' + pieces.join(' ');
  }

  function weightedSum(level, values) {
    var total = Frac.zero();
    level.terms.forEach(function (term) {
      total = total.add(term.w.mul(values[term.col]));
    });
    return total;
  }

  function rowValue(row, values) {
    var total = Frac.zero();
    for (var index = 0; index < row.length; index += 1) {
      if (!row[index].isZero()) {
        total = total.add(row[index].mul(values[index]));
      }
    }
    return total;
  }

  /**
   * 優先順序目標規劃求解。
   * @param {Object} spec create() 產生的目標規劃模型
   * @param {Object} [options] {nodeLimit}
   */
  function solve(spec, options) {
    var opts = options || {};
    var compiled = compile(spec);
    if (!compiled.ok) {
      return { ok: false, status: 'invalid', errors: compiled.errors, warnings: compiled.warnings };
    }

    var n = compiled.n;
    var width = compiled.width;
    var names = columnNames(spec);
    var hasInteger = spec.integer.some(Boolean);
    var integerFlags = [];
    for (var column = 0; column < width; column += 1) {
      integerFlags.push(column < n ? !!spec.integer[column] : false);
    }

    function toLPRow(row, op, rhs) {
      return { a: row.slice(), op: op, b: rhs };
    }

    var baseConstraints = [];
    compiled.hardRows.forEach(function (row) {
      baseConstraints.push(toLPRow(row.a, row.op, row.b));
    });
    compiled.goalRows.forEach(function (row) {
      baseConstraints.push(toLPRow(row.a, '=', row.target));
    });

    var steps = [];
    var fixed = [];
    var finalX = null;
    var hitLimit = false;

    function runLP(objective, extra) {
      var lpModel = {
        sense: 'min',
        c: objective,
        nonNeg: true,
        variableNames: names,
        integer: integerFlags,
        binary: integerFlags.map(function () {
          return false;
        }),
        constraints: baseConstraints.concat(extra)
      };
      return hasInteger
        ? LPC.solver.solveInteger(lpModel, { nodeLimit: opts.nodeLimit })
        : LPC.solver.solveLP(lpModel, {});
    }

    function zeroObjective() {
      var row = [];
      for (var index = 0; index < width; index += 1) {
        row.push(Frac.zero());
      }
      return row;
    }

    var levelsToRun = compiled.levels.length ? compiled.levels : [null];

    for (var levelIndex = 0; levelIndex < levelsToRun.length; levelIndex += 1) {
      var level = levelsToRun[levelIndex];
      var objective = zeroObjective();
      if (level) {
        level.terms.forEach(function (term) {
          objective[term.col] = term.w;
        });
      }
      var extra = fixed.map(function (entry) {
        return toLPRow(entry.row, '=', entry.value);
      });
      var lp = runLP(objective, extra);

      if (lp.status === 'limit') {
        hitLimit = true;
      }
      if (!lp || lp.status === 'infeasible' || !lp.x) {
        return {
          ok: true,
          status: 'infeasible',
          failedLevel: level ? level.name : null,
          levelIndex: levelIndex,
          steps: steps,
          warnings: compiled.warnings,
          message:
            levelIndex === 0
              ? '系統限制式與目標限制式本身互相矛盾，找不到任何可行解。請檢查「系統限制式」是否過嚴，或整數條件是否讓問題無解。'
              : '求解到 ' + (level ? level.name : '') + ' 時失去可行解（不應發生），請檢查模型。'
        };
      }
      if (lp.status === 'unbounded') {
        return {
          ok: true,
          status: 'unbounded',
          steps: steps,
          warnings: compiled.warnings,
          message: '此層目標函數無界，請檢查權重與限制式。'
        };
      }
      if (lp.status !== 'optimal' && lp.status !== 'limit') {
        return {
          ok: false,
          status: 'error',
          steps: steps,
          warnings: compiled.warnings,
          errors: [lp.message || '求解失敗（' + lp.status + '）']
        };
      }

      var optimum = level ? weightedSum(level, lp.x) : Frac.zero();
      var added = null;
      if (level) {
        fixed.push({ row: objective.slice(), value: optimum, level: level });
        added = levelFixText(level, optimum);
      }
      steps.push({
        level: level,
        objectiveText: level ? levelObjectiveText(level) : '（沒有要最小化的偏離量，僅找可行解）',
        optimum: optimum,
        x: lp.x.slice(0, n),
        values: lp.x.slice(),
        integer: hasInteger,
        nodes: lp.nodes === undefined ? null : lp.nodes,
        added: added
      });
      finalX = lp.x;
    }

    var warnings = compiled.warnings.slice();
    if (hitLimit) {
      warnings.push('整數規劃的分支定界達到節點上限，結果可能不是最佳整數解。');
    }

    return buildResult(spec, compiled, names, finalX, steps, warnings);
  }

  function levelFixText(level, optimum) {
    var pieces = level.terms.map(function (term, index) {
      var weight = term.w.isOne() ? '' : fmt(term.w) + ' ';
      return (index === 0 ? '' : '+ ') + weight + devText(term.goal, term.side);
    });
    return pieces.join(' ') + ' = ' + fmt(optimum);
  }

  function buildResult(spec, compiled, names, values, steps, warnings) {
    var n = compiled.n;
    var x = values.slice(0, n);

    var goals = compiled.goalRows.map(function (row, index) {
      var under = values[underCol(n, index)];
      var over = values[overCol(n, index)];
      /* 實際達成值 = 目標限制式左邊扣掉自己的 d⁻、d⁺（即 target − d⁻ + d⁺） */
      var actual = row.target.sub(under).add(over);
      var goal = spec.goals[index];
      var met;
      if (row.op === '>=') {
        met = under.isZero();
      } else if (row.op === '<=') {
        met = over.isZero();
      } else {
        met = under.isZero() && over.isZero();
      }
      return {
        index: index,
        label: goal.label,
        op: row.op,
        target: row.target,
        actual: actual,
        under: under,
        over: over,
        met: met
      };
    });

    var hard = compiled.hardRows.map(function (row, index) {
      var lhs = Frac.zero();
      for (var column = 0; column < n; column += 1) {
        lhs = lhs.add(row.a[column].mul(x[column]));
      }
      var diff = lhs.sub(row.b);
      return {
        index: index,
        label: row.label,
        op: row.op,
        lhs: lhs,
        rhs: row.b,
        slack: row.op === '<=' ? diff.neg() : row.op === '>=' ? diff : Frac.zero(),
        binding: lhs.eq(row.b)
      };
    });

    var levels = compiled.levels.map(function (level, index) {
      var step = steps[index];
      var achieved = weightedSum(level, values);
      return {
        p: level.p,
        name: level.name,
        plainName: level.plainName,
        terms: level.terms.map(function (term) {
          return {
            goal: term.goal,
            side: term.side,
            w: term.w,
            label: devText(term.goal, term.side),
            value: values[term.col]
          };
        }),
        objectiveText: levelObjectiveText(level),
        optimum: step.optimum,
        achieved: achieved,
        met: achieved.isZero()
      };
    });

    var metCount = goals.filter(function (goal) {
      return goal.met;
    }).length;

    return {
      ok: true,
      status: 'optimal',
      varNames: spec.varNames.slice(),
      names: names,
      x: x,
      values: values.slice(),
      goals: goals,
      hard: hard,
      levels: levels,
      steps: steps,
      metCount: metCount,
      goalCount: goals.length,
      integer: spec.integer.some(Boolean),
      warnings: warnings
    };
  }

  /* --------------------------------------------------------------------- */
  /* 模型排版                                                              */
  /* --------------------------------------------------------------------- */

  function rowText(row, names) {
    var parts = [];
    row.forEach(function (value, index) {
      if (value.isZero()) {
        return;
      }
      var magnitude = value.abs();
      var sign = parts.length === 0 ? (value.isNeg() ? '−' : '') : value.isNeg() ? ' − ' : ' + ';
      var coefficient = magnitude.isOne() ? '' : fmt(magnitude);
      parts.push(sign + coefficient + names[index]);
    });
    return parts.length ? parts.join('') : '0';
  }

  function rowHTML(row, htmlNames) {
    var parts = [];
    row.forEach(function (value, index) {
      if (value.isZero()) {
        return;
      }
      var magnitude = value.abs();
      var first = parts.length === 0;
      var sign = first ? (value.isNeg() ? '−' : '') : value.isNeg() ? '−' : '+';
      var coefficient = magnitude.isOne() ? '' : fmt(magnitude);
      parts.push(
        '<span class="math-term">' +
          (sign ? '<span class="math-sign">' + sign + '</span>' : '') +
          (coefficient ? '<span class="math-coef">' + coefficient + '</span>' : '') +
          htmlNames[index] +
          '</span>'
      );
    });
    return parts.length ? parts.join('') : '<span class="math-zero">0</span>';
  }

  function htmlNames(spec) {
    var list = spec.varNames.map(varHTML);
    spec.goals.forEach(function (_, index) {
      list.push(devHTML(index, '-'));
      list.push(devHTML(index, '+'));
    });
    return list;
  }

  /** 目標函數：min ( P₁ d₁⁻, P₂ d₂⁻, … ) 的純文字。 */
  function objectiveText(compiled) {
    if (!compiled.levels.length) {
      return 'min ( )';
    }
    var pieces = compiled.levels.map(function (level) {
      var inner = level.terms
        .map(function (term, index) {
          var weight = term.w.isOne() ? '' : fmt(term.w) + ' ';
          return (index === 0 ? '' : ' + ') + weight + devText(term.goal, term.side);
        })
        .join('');
      return level.terms.length > 1 ? level.name + '(' + inner + ')' : level.name + ' ' + inner;
    });
    return 'min ( ' + pieces.join(',  ') + ' )';
  }

  function objectiveHTML(compiled) {
    if (!compiled.levels.length) {
      return '<span class="math-keyword">min</span> ( )';
    }
    var pieces = compiled.levels.map(function (level) {
      var inner = level.terms
        .map(function (term, index) {
          var weight = term.w.isOne() ? '' : '<span class="math-coef">' + fmt(term.w) + '</span>';
          return (index === 0 ? '' : '<span class="math-sign">+</span>') + weight + devHTML(term.goal, term.side);
        })
        .join('');
      return (
        '<span class="goal-p">P<sub>' + level.p + '</sub></span>' +
        (level.terms.length > 1 ? '<span class="math-sep">(</span>' + inner + '<span class="math-sep">)</span>' : inner)
      );
    });
    return (
      '<span class="math-keyword">min</span><span class="math-sep">(</span>' +
      pieces.join('<span class="math-sep">, </span>') +
      '<span class="math-sep">)</span>'
    );
  }

  function modelText(spec) {
    var compiled = compile(spec);
    if (!compiled.ok) {
      return '（模型尚未完成：' + compiled.errors[0] + '）';
    }
    var names = columnNames(spec);
    var lines = [objectiveText(compiled), 'subject to'];
    compiled.hardRows.forEach(function (row) {
      var symbol = row.op === '>=' ? '≥' : row.op === '=' ? '=' : '≤';
      lines.push('  ' + rowText(row.a, names) + ' ' + symbol + ' ' + fmt(row.b) + (row.label ? '    (' + row.label + ')' : ''));
    });
    compiled.goalRows.forEach(function (row) {
      lines.push('  ' + rowText(row.a, names) + ' = ' + fmt(row.target) + (row.label ? '    (' + row.label + ')' : ''));
    });
    lines.push('  ' + spec.varNames.join(', ') + ', dᵢ⁻, dᵢ⁺ ≥ 0');
    var integerNames = spec.varNames.filter(function (_, index) {
      return spec.integer[index];
    });
    if (integerNames.length) {
      lines.push('  ' + integerNames.join(', ') + ' 為整數');
    }
    return lines.join('\n');
  }

  function modelHTML(spec) {
    var compiled = compile(spec);
    if (!compiled.ok) {
      return '<div class="mathblock"><span class="mathline mathline-muted">模型尚未完成：' + escapeHTML(compiled.errors[0]) + '</span></div>';
    }
    var html = htmlNames(spec);
    var lines = [];
    lines.push('<span class="mathline">' + objectiveHTML(compiled) + '</span>');
    lines.push('<div class="mathblock-subject">subject to</div>');
    compiled.hardRows.forEach(function (row) {
      var symbol = row.op === '>=' ? '≥' : row.op === '=' ? '=' : '≤';
      lines.push(
        '<span class="mathline mathline-constraint">' +
          rowHTML(row.a, html) +
          '<span class="math-rel">' + symbol + '</span><span class="math-rhs">' + fmt(row.b) + '</span>' +
          (row.label ? '<span class="math-label">' + escapeHTML(row.label) + '</span>' : '') +
          '</span>'
      );
    });
    compiled.goalRows.forEach(function (row, index) {
      lines.push(
        '<span class="mathline mathline-constraint">' +
          '<span class="math-index">G' + (index + 1) + '</span>' +
          rowHTML(row.a, html) +
          '<span class="math-rel">=</span><span class="math-rhs">' + fmt(row.target) + '</span>' +
          (row.label ? '<span class="math-label">' + escapeHTML(row.label) + '</span>' : '') +
          '</span>'
      );
    });
    lines.push(
      '<span class="mathline mathline-muted">' +
        escapeHTML(spec.varNames.join(', ')) + ', d<sub>i</sub><sup>−</sup>, d<sub>i</sub><sup>+</sup> ≥ 0' +
        '</span>'
    );
    return '<div class="mathblock">' + lines.join('') + '</div>';
  }

  /* --------------------------------------------------------------------- */
  /* 例題（皆取自講義）                                                    */
  /* --------------------------------------------------------------------- */

  function p(priority, weight) {
    return { p: String(priority), w: weight === undefined ? '1' : String(weight) };
  }

  var none = { p: '', w: '1' };

  var examples = [
    {
      id: 'beaver-4',
      title: 'Beaver Creek 陶器：四個目標',
      tag: '講義主例題',
      description:
        '碗（x₁，$40）與杯子（x₂，$50）。目標依序為 P₁ 工時不低於 40、P₂ 利潤至少 $1600、P₃ 陶土不超過 120、P₄ 加班愈少愈好。',
      build: function () {
        return create({
          title: 'Beaver Creek 陶器製造公司（四個目標）',
          varNames: ['x1', 'x2'],
          goals: [
            { label: '勞力工時 ≥ 40 小時', a: ['1', '2'], op: '>=', target: '40', under: p(1), over: p(4) },
            { label: '每日利潤 ≥ $1600', a: ['40', '50'], op: '>=', target: '1600', under: p(2), over: none },
            { label: '陶土 ≤ 120 磅', a: ['4', '3'], op: '<=', target: '120', under: none, over: p(3) }
          ]
        });
      },
      note: 'P₁ 與 P₄ 都針對同一個目標限制式：d₁⁻ 放在 P₁（工時不足）、d₁⁺ 放在 P₄（加班）。'
    },
    {
      id: 'beaver-overtime',
      title: 'Beaver Creek：加班不超過 10 小時',
      tag: '目標中的目標',
      description:
        '管理者改變想法：允許加班，但希望不要超過 10 小時。新增 d₁⁺ + d₄⁻ − d₄⁺ = 10，並改為最小化 d₄⁺（針對離差變數建立新目標）。',
      build: function () {
        return create({
          title: 'Beaver Creek（加班上限 10 小時）',
          varNames: ['x1', 'x2'],
          goals: [
            { label: '勞力工時 ≥ 40 小時', a: ['1', '2'], op: '>=', target: '40', under: p(1), over: none },
            { label: '每日利潤 ≥ $1600', a: ['40', '50'], op: '>=', target: '1600', under: p(2), over: none },
            { label: '陶土 ≤ 120 磅', a: ['4', '3'], op: '<=', target: '120', under: none, over: p(3) },
            { label: '加班 d₁⁺ ≤ 10 小時', a: ['0', '0'], dev: 'd1+', op: '<=', target: '10', under: none, over: p(4) }
          ]
        });
      },
      note: '第 4 個目標沒有決策變數，只含另一個目標的離差變數 d₁⁺，所以要在「含其他離差變數」欄位填 d1+。'
    },
    {
      id: 'beaver-5',
      title: 'Beaver Creek：加入第五個目標（加權）',
      tag: '同層加權',
      description:
        '倉庫限制：希望每天生產接近 30 個碗與 20 個杯子。兩者同為 P₅，以利潤比 40:50 = 4:5 加權：min 4d₅⁻ + 5d₆⁻。',
      build: function () {
        return create({
          title: 'Beaver Creek（五個優先層，含加權目標）',
          varNames: ['x1', 'x2'],
          goals: [
            { label: '勞力工時 ≥ 40 小時', a: ['1', '2'], op: '>=', target: '40', under: p(1), over: none },
            { label: '每日利潤 ≥ $1600', a: ['40', '50'], op: '>=', target: '1600', under: p(2), over: none },
            { label: '陶土 ≤ 120 磅', a: ['4', '3'], op: '<=', target: '120', under: none, over: p(3) },
            { label: '加班 d₁⁺ ≤ 10 小時', a: ['0', '0'], dev: 'd1+', op: '<=', target: '10', under: none, over: p(4) },
            { label: '碗產量接近 30 個', a: ['1', '0'], op: '>=', target: '30', under: p(5, 4), over: none },
            { label: '杯子產量接近 20 個', a: ['0', '1'], op: '>=', target: '20', under: p(5, 5), over: none }
          ]
        });
      },
      note: '生產不會「過多」（倉庫放不下），所以第 5、6 個目標只有不足量 d₅⁻、d₆⁻。'
    },
    {
      id: 'rucklehouse',
      title: 'Rucklehouse 公關公司民意調查',
      tag: '講義例題',
      description:
        'x₁ = 電話訪員人數、x₂ = 親自訪員人數。P₁ 至少完成 3000 人次訪問、P₂ 每天預算最多 $2500、P₃ 至少 1000 人來自電話訪問。',
      build: function () {
        return create({
          title: 'Rucklehouse 公關公司民意調查',
          varNames: ['x1', 'x2'],
          goals: [
            { label: '至少完成 3000 位受訪者', a: ['80', '40'], op: '>=', target: '3000', under: p(1), over: none },
            { label: '每天預算最多 $2500', a: ['50', '70'], op: '<=', target: '2500', under: none, over: p(2) },
            { label: '至少 1000 位來自電話訪問', a: ['80', '0'], op: '>=', target: '1000', under: p(3), over: none }
          ]
        });
      },
      note: 'x₁ = 電話訪員（每人每天 80 通、成本 $50）、x₂ = 親自訪員（每人每天 40 人次、成本 $70）。'
    },
    {
      id: 'clinic',
      title: '診所人力配置',
      tag: '講義例題',
      description:
        'x₁ = GP、x₂ = 護士、x₃ = 內科醫生每週值班時數。P₁ 護士至少 30 小時、P₂ 預算不超過 $1,200、P₃ GP 與內科合計至少 20 小時、P₄ 內科至少 6 小時。',
      build: function () {
        return create({
          title: '診所人力配置問題',
          varNames: ['GP', 'Nurse', 'Internist'],
          goals: [
            { label: '護士值班至少 30 小時', a: ['0', '1', '0'], op: '>=', target: '30', under: p(1), over: none },
            { label: '每週預算 ≤ $1,200', a: ['40', '20', '150'], op: '<=', target: '1200', under: none, over: p(2) },
            { label: 'GP 與內科合計至少 20 小時', a: ['1', '0', '1'], op: '>=', target: '20', under: p(3), over: none },
            { label: '內科至少 6 小時', a: ['0', '0', '1'], op: '>=', target: '6', under: p(4), over: none }
          ]
        });
      },
      note: '費用：GP $40、護士 $20、內科 $150（每小時）。預算 $1,200 為目標，不是硬限制。'
    }
  ];

  /* --------------------------------------------------------------------- */
  /* 匯出                                                                  */
  /* --------------------------------------------------------------------- */

  LPC.goal = {
    create: create,
    clone: clone,
    compile: compile,
    validate: validate,
    solve: solve,
    parseDeviationTerms: parseDeviationTerms,
    defaultPenalties: defaultPenalties,
    blankPenalty: blankPenalty,
    modelText: modelText,
    modelHTML: modelHTML,
    devText: devText,
    devHTML: devHTML,
    varHTML: varHTML,
    examples: examples,
    MAX_VARIABLES: MAX_VARIABLES,
    MAX_GOALS: MAX_GOALS,
    MAX_HARD: MAX_HARD
  };
})(typeof window !== 'undefined' ? window : globalThis);
