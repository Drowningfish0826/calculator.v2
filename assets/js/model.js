/* ============================================================================
 * model.js — 模型物件、驗證、數學式排版、分享編碼、管理意涵解讀
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});
  var Frac = LPC.Frac;

  var MAX_MANUAL_VARIABLES = 10;
  var MAX_VARIABLES = 60;
  var MAX_CONSTRAINTS = 80;

  /* --------------------------------------------------------------------- */
  /* 建立與複製                                                            */
  /* --------------------------------------------------------------------- */

  function create(spec) {
    var source = spec || {};
    var varCount = (source.varNames || source.c || []).length;
    var model = {
      sense: source.sense === 'min' ? 'min' : 'max',
      varNames: normalizeArray(source.varNames, varCount, function (index) {
        return 'x' + (index + 1);
      }),
      c: normalizeArray(source.c, varCount, function () {
        return '0';
      }),
      nonNeg: source.nonNeg !== false,
      integer: normalizeArray(source.integer, varCount, function () {
        return false;
      }),
      binary: normalizeArray(source.binary, varCount, function () {
        return false;
      }),
      constraints: (source.constraints || []).map(function (constraint) {
        return {
          a: normalizeArray(constraint.a, varCount, function () {
            return '0';
          }),
          op: constraint.op === '>=' ? '>=' : constraint.op === '=' ? '=' : '<=',
          b: constraint.b === undefined || constraint.b === null ? '0' : String(constraint.b),
          label: constraint.label || ''
        };
      }),
      meta: source.meta || {}
    };
    return model;
  }

  function normalizeArray(list, length, fallback) {
    var result = [];
    for (var index = 0; index < length; index += 1) {
      var value = list && list[index] !== undefined && list[index] !== null ? list[index] : fallback(index);
      result.push(value);
    }
    return result;
  }

  function clone(model) {
    return create({
      sense: model.sense,
      varNames: model.varNames.slice(),
      c: model.c.slice(),
      nonNeg: model.nonNeg,
      integer: model.integer.slice(),
      binary: model.binary.slice(),
      constraints: model.constraints.map(function (constraint) {
        return {
          a: constraint.a.slice(),
          op: constraint.op,
          b: constraint.b,
          label: constraint.label
        };
      }),
      meta: JSON.parse(JSON.stringify(model.meta || {}))
    });
  }

  function toSolverInput(model) {
    return {
      sense: model.sense,
      c: model.c,
      nonNeg: model.nonNeg,
      integer: model.integer.slice(),
      binary: model.binary.slice(),
      variableNames: model.varNames.slice(),
      constraints: model.constraints.map(function (constraint) {
        return { a: constraint.a, op: constraint.op, b: constraint.b };
      })
    };
  }

  /* --------------------------------------------------------------------- */
  /* 驗證                                                                  */
  /* --------------------------------------------------------------------- */

  function validate(model) {
    var issues = [];
    var varCount = model.varNames.length;

    if (!varCount) {
      issues.push({ level: 'error', field: 'vars', message: '至少要有一個決策變數。' });
    }
    if (varCount > MAX_VARIABLES) {
      issues.push({
        level: 'error',
        field: 'vars',
        message: '決策變數最多 ' + MAX_VARIABLES + ' 個（目前 ' + varCount + ' 個）。'
      });
    }

    var objectiveAllZero = true;
    model.c.forEach(function (value, index) {
      try {
        var parsed = Frac.coerce(value);
        if (!parsed.isZero()) {
          objectiveAllZero = false;
        }
      } catch (error) {
        issues.push({
          level: 'error',
          field: 'obj-' + index,
          message: '目標函數中 ' + model.varNames[index] + ' 的係數「' + value + '」不是有效數字。'
        });
      }
    });
    if (objectiveAllZero) {
      issues.push({ level: 'warn', field: 'objective', message: '目標函數係數全為 0，最佳解不具意義。' });
    }

    if (!model.constraints.length) {
      issues.push({ level: 'warn', field: 'constraints', message: '尚未新增限制式，求解結果可能為無界。' });
    }
    if (model.constraints.length > MAX_CONSTRAINTS) {
      issues.push({
        level: 'error',
        field: 'constraints',
        message: '限制式最多 ' + MAX_CONSTRAINTS + ' 條（目前 ' + model.constraints.length + ' 條）。'
      });
    }

    model.constraints.forEach(function (constraint, rowIndex) {
      constraint.a.forEach(function (value, columnIndex) {
        try {
          Frac.coerce(value);
        } catch (error) {
          issues.push({
            level: 'error',
            field: 'con-' + rowIndex + '-' + columnIndex,
            message: '第 ' + (rowIndex + 1) + ' 條限制式的 ' + model.varNames[columnIndex] + ' 係數無效。'
          });
        }
      });
      try {
        Frac.coerce(constraint.b);
      } catch (error) {
        issues.push({
          level: 'error',
          field: 'rhs-' + rowIndex,
          message: '第 ' + (rowIndex + 1) + ' 條限制式的右端值無效。'
        });
      }
    });

    var errors = issues.filter(function (issue) {
      return issue.level === 'error';
    });
    return { ok: errors.length === 0, issues: issues, errors: errors };
  }

  /* --------------------------------------------------------------------- */
  /* 數字與數學式排版                                                      */
  /* --------------------------------------------------------------------- */

  function fmt(value, options) {
    var opts = options || {};
    var fraction;
    try {
      fraction = value instanceof Frac ? value : Frac.coerce(value);
    } catch (error) {
      return String(value);
    }
    if (fraction.isInteger()) {
      return withMinus(fraction.toString());
    }
    if (opts.mode === 'fraction') {
      return withMinus(fraction.toPretty({ mode: 'fraction' }));
    }
    if (opts.mode === 'decimal') {
      return withMinus(fraction.toDecimal(opts.digits === undefined ? 4 : opts.digits));
    }
    return withMinus(fraction.toPretty({ digits: opts.digits === undefined ? 4 : opts.digits }));
  }

  /** 負號改用排版用的減號（U+2212），與中文字體的比例較協調。 */
  function withMinus(text) {
    return String(text).replace(/^-/, '\u2212');
  }

  /** 加上千分位（僅對可寫成有限小數的值）。 */
  function fmtGrouped(value, options) {
    var text = fmt(value, options);
    var negative = text.charAt(0) === '\u2212';
    if (negative) {
      text = text.slice(1);
    }
    if (/^\d+(\.\d+)?$/.test(text)) {
      var parts = text.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      text = parts.join('.');
    }
    return (negative ? '\u2212' : '') + text;
  }

  function signSymbol(value) {
    return value.isNeg() ? '−' : '+';
  }

  function variableHTML(name, index) {
    var base = escapeHTML(name.replace(/[0-9]+$/, ''));
    var digits = /([0-9]+)$/.exec(name);
    return (
      '<span class="math-var">' +
      base +
      (digits ? '<sub>' + escapeHTML(digits[1]) + '</sub>' : '') +
      '</span>'
    );
  }

  function escapeHTML(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 把一列係數排版成數學式。
   * @param {Array} coefficients
   * @param {Array} names
   * @param {Object} options {mode, keepZero, emptyText}
   */
  function linearHTML(coefficients, names, options) {
    var opts = options || {};
    var parts = [];
    var hasTerm = false;
    coefficients.forEach(function (rawValue, index) {
      var value;
      try {
        value = Frac.coerce(rawValue);
      } catch (error) {
        parts.push('<span class="math-term math-invalid">?</span>');
        return;
      }
      if (value.isZero() && !opts.keepZero) {
        return;
      }
      var magnitude = value.abs();
      var isFirst = !hasTerm;
      var signSymbolText = isFirst ? (value.isNeg() ? '−' : '') : value.isNeg() ? '−' : '+';
      var coefficientText = magnitude.eq(1) ? '' : fmt(magnitude);
      parts.push(
        '<span class="math-term">' +
          (signSymbolText ? '<span class="math-sign">' + signSymbolText + '</span>' : '') +
          (coefficientText ? '<span class="math-coef">' + coefficientText + '</span>' : '') +
          variableHTML(names[index], index) +
          '</span>'
      );
      hasTerm = true;
    });
    if (!hasTerm) {
      return '<span class="math-zero">' + escapeHTML(opts.emptyText || '0') + '</span>';
    }
    return parts.join('');
  }

  function relationHTML(op) {
    var symbol = op === '>=' ? '≥' : op === '=' ? '=' : '≤';
    return '<span class="math-rel">' + symbol + '</span>';
  }

  function objectiveHTML(model, options) {
    var opts = options || {};
    var head =
      '<span class="math-keyword">' + (model.sense === 'min' ? 'min' : 'max') + '</span>' +
      '<span class="math-objective">Z</span>' +
      '<span class="math-eq">=</span>';
    return (
      '<span class="mathline">' +
      head +
      linearHTML(model.c, model.varNames, { emptyText: '0' }) +
      '</span>' +
      (opts.withCount === false
        ? ''
        : '<span class="math-note">' +
          model.varNames.length +
          ' 個決策變數</span>')
    );
  }

  function constraintHTML(model, constraint, index, options) {
    var opts = options || {};
    return (
      '<span class="mathline mathline-constraint">' +
      (opts.withIndex === false
        ? ''
        : '<span class="math-index">(' + (index + 1) + ')</span>') +
      linearHTML(constraint.a, model.varNames, {}) +
      relationHTML(constraint.op) +
      '<span class="math-rhs">' + fmt(Frac.coerce(constraint.b)) + '</span>' +
      (constraint.label && opts.hideLabel !== true
        ? '<span class="math-label">' + escapeHTML(constraint.label) + '</span>'
        : '') +
      '</span>'
    );
  }

  function nonNegativityHTML(model) {
    if (!model.nonNeg) {
      return '<span class="mathline mathline-muted">各變數不受非負限制（可為負值）</span>';
    }
    return (
      '<span class="mathline">' +
      model.varNames
        .map(function (name, index) {
          return variableHTML(name, index);
        })
        .join('<span class="math-sep">, </span>') +
      '<span class="math-rel">≥</span><span class="math-rhs">0</span>' +
      '</span>'
    );
  }

  function integralityHTML(model) {
    var integerNames = [];
    var binaryNames = [];
    model.integer.forEach(function (flag, index) {
      if (flag) {
        integerNames.push(model.varNames[index]);
      }
    });
    model.binary.forEach(function (flag, index) {
      if (flag) {
        binaryNames.push(model.varNames[index]);
      }
    });
    var lines = [];
    if (integerNames.length) {
      lines.push(
        '<span class="mathline mathline-muted">' +
          integerNames.join(', ') +
          ' ∈ ℤ（整數）</span>'
      );
    }
    if (binaryNames.length) {
      lines.push(
        '<span class="mathline mathline-muted">' +
          binaryNames.join(', ') +
          ' ∈ {0, 1}（0-1 變數）</span>'
      );
    }
    return lines.join('');
  }

  function modelHTML(model) {
    var blocks = ['<div class="mathblock">', objectiveHTML(model, { withCount: false })];
    if (model.constraints.length) {
      blocks.push('<div class="mathblock-subject">subject to</div>');
      model.constraints.forEach(function (constraint, index) {
        blocks.push(constraintHTML(model, constraint, index, { withIndex: false }));
      });
    }
    blocks.push(nonNegativityHTML(model));
    blocks.push(integralityHTML(model));
    blocks.push('</div>');
    return blocks.join('');
  }

  function modelTextLines(model) {
    var lines = [];
    lines.push(objectiveText(model));
    if (model.constraints.length) {
      lines.push('  s.t.');
      model.constraints.forEach(function (constraint) {
        lines.push('    ' + constraintText(model, constraint));
      });
    }
    lines.push(
      '    ' +
        (model.nonNeg ? model.varNames.join(', ') + ' ≥ 0' : '各變數不受非負限制')
    );
    var integers = model.varNames.filter(function (name, index) {
      return model.integer[index];
    });
    if (integers.length) {
      lines.push('    ' + integers.join(', ') + ' ∈ ℤ');
    }
    var binaries = model.varNames.filter(function (name, index) {
      return model.binary[index];
    });
    if (binaries.length) {
      lines.push('    ' + binaries.join(', ') + ' ∈ {0, 1}');
    }
    return lines;
  }

  function termText(value, name, isFirst) {
    if (value.isZero()) {
      return '';
    }
    var magnitude = value.abs();
    var coefficient;
    if (isFirst) {
      coefficient = value.isNeg() ? '\u2212' : '';
      if (!magnitude.eq(1)) {
        coefficient += fmt(magnitude);
      }
    } else {
      coefficient = value.isNeg() ? '\u2212 ' : '+ ';
      if (!magnitude.eq(1)) {
        coefficient += fmt(magnitude);
      }
    }
    return coefficient + name;
  }

  function linearText(coefficients, names) {
    var parts = [];
    coefficients.forEach(function (rawValue, index) {
      var value = Frac.coerce(rawValue);
      if (value.isZero()) {
        return;
      }
      parts.push(termText(value, names[index], parts.length === 0));
    });
    return parts.length ? parts.join(' ') : '0';
  }

  function objectiveText(model) {
    return (model.sense === 'min' ? 'min' : 'max') + ' Z = ' + linearText(model.c, model.varNames);
  }

  function constraintText(model, constraint) {
    var symbol = constraint.op === '>=' ? '>=' : constraint.op === '=' ? '=' : '<=';
    return (
      linearText(constraint.a, model.varNames) +
      ' ' +
      symbol +
      ' ' +
      fmt(Frac.coerce(constraint.b)) +
      (constraint.label ? '   (' + constraint.label + ')' : '')
    );
  }

  function modelText(model) {
    return modelTextLines(model).join('\n');
  }

  /* --------------------------------------------------------------------- */
  /* 分享連結                                                              */
  /* --------------------------------------------------------------------- */

  function encodeBase64Url(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = '';
    bytes.forEach(function (byte) {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeBase64Url(encoded) {
    var padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4 !== 0) {
      padded += '=';
    }
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  }

  function encode(model) {
    return encodeBase64Url(JSON.stringify(serialize(model)));
  }

  function decode(token) {
    try {
      return deserialize(JSON.parse(decodeBase64Url(token)));
    } catch (error) {
      return null;
    }
  }

  function serialize(model) {
    return {
      s: model.sense,
      v: model.varNames,
      c: model.c,
      n: model.nonNeg,
      i: model.integer,
      b: model.binary,
      r: model.constraints.map(function (constraint) {
        return [constraint.a, constraint.op, constraint.b, constraint.label || ''];
      })
    };
  }

  function deserialize(raw) {
    if (!raw || !raw.v) {
      return null;
    }
    return create({
      sense: raw.s,
      varNames: raw.v,
      c: raw.c,
      nonNeg: raw.n !== false,
      integer: raw.i || [],
      binary: raw.b || [],
      constraints: (raw.r || []).map(function (row) {
        return { a: row[0], op: row[1], b: row[2], label: row[3] };
      })
    });
  }

  /* --------------------------------------------------------------------- */
  /* 管理意涵解讀                                                          */
  /* --------------------------------------------------------------------- */

  function metaOf(model) {
    var meta = model.meta || {};
    return {
      objectiveLabel: meta.objectiveLabel || (model.sense === 'max' ? '目標值' : '總成本'),
      objectiveUnit: meta.objectiveUnit || '',
      variableUnit: meta.variableUnit || '單位',
      variableLabels: meta.variableLabels || [],
      resourceLabels: meta.resourceLabels || [],
      resourceUnits: meta.resourceUnits || []
    };
  }

  function variableLabel(model, index) {
    var info = metaOf(model);
    return info.variableLabels[index] || model.varNames[index];
  }

  function resourceLabel(model, index) {
    var info = metaOf(model);
    var constraint = model.constraints[index];
    return info.resourceLabels[index] || (constraint && constraint.label) || '限制式 ' + (index + 1);
  }

  /**
   * 把數學結果翻譯成管理語言。
   * @returns {Array<{kind:string, title:string, text:string, detail?:string}>}
   */
  function interpret(model, result) {
    var notes = [];
    if (!result || result.status !== 'optimal') {
      return notes;
    }
    var info = metaOf(model);
    var unit = info.variableUnit;

    var allocation = result.varInfo
      .map(function (variable) {
        if (variable.value.isZero()) {
          return null;
        }
        return (
          variableLabel(model, variable.index) +
          ' ' +
          fmtGrouped(variable.value) +
          ' ' +
          unit
        );
      })
      .filter(Boolean);
    if (allocation.length) {
      notes.push({
        kind: 'allocation',
        title: '最佳決策組合',
        text: allocation.join('；') + '。'
      });
    }
    var zeroVariables = result.varInfo
      .filter(function (variable) {
        return variable.value.isZero();
      })
      .map(function (variable) {
        return variableLabel(model, variable.index);
      });
    if (zeroVariables.length && zeroVariables.length < model.varNames.length) {
      notes.push({
        kind: 'allocation',
        title: '未投入的項目',
        text: zeroVariables.join('、') + ' 在最佳解下為 0，表示資源配置上暫不投入。'
      });
    }

    notes.push({
      kind: 'objective',
      title: info.objectiveLabel + '最佳值',
      text:
        'Z* = ' +
        fmtGrouped(result.z) +
        (info.objectiveUnit ? ' ' + info.objectiveUnit : '') +
        '（' +
        (model.sense === 'max' ? '最大化' : '最小化') +
        '問題）。'
    });

    var binding = result.constraints.filter(function (constraint) {
      return constraint.binding;
    });
    var slacks = result.constraints.filter(function (constraint) {
      return !constraint.binding;
    });

    if (binding.length) {
      notes.push({
        kind: 'binding',
        title: '瓶頸資源（緊束限制）',
        text:
          binding
            .map(function (constraint) {
              return '「' + resourceLabel(model, constraint.index) + '」';
            })
            .join('、') +
          ' 在最佳解下已用盡，是限制目標值再往上提升的關鍵資源。'
      });
    }
    if (slacks.length) {
      notes.push({
        kind: 'slack',
        title: '仍有餘裕的資源',
        text:
          slacks
            .map(function (constraint) {
              return (
                '「' +
                resourceLabel(model, constraint.index) +
                '」尚有 ' +
                fmtGrouped(constraint.slack.abs()) +
                ' 的餘裕'
              );
            })
            .join('；') +
          '，短期內不是瓶頸。'
      });
    }

    var shadowLines = result.constraints
      .filter(function (constraint) {
        return constraint.binding && !constraint.shadow.isZero();
      })
      .map(function (constraint) {
        var direction = constraint.shadow.isPos() ? '增加' : '減少';
        return (
          '「' +
          resourceLabel(model, constraint.index) +
          '」每放寬 1 單位，' +
          info.objectiveLabel +
          '可' +
          direction +
          ' ' +
          fmtGrouped(constraint.shadow.abs()) +
          (info.objectiveUnit ? ' ' + info.objectiveUnit : '')
        );
      });
    if (shadowLines.length) {
      notes.push({
        kind: 'shadow',
        title: '資源邊際價值（影子價格）',
        text: shadowLines.join('；') + '。這是評估「是否值得加購資源」的依據。'
      });
    }

    var blockedVariables = result.varInfo.filter(function (variable) {
      return !variable.basic && variable.reducedCost.sign() < 0;
    });
    if (blockedVariables.length) {
      notes.push({
        kind: 'reduced',
        title: '暫不投入的變數',
        text:
          blockedVariables
            .map(function (variable) {
              return (
                variableLabel(model, variable.index) +
                ' 每單位會使' +
                info.objectiveLabel +
                '變動 ' +
                fmtGrouped(variable.reducedCost) +
                '，必須改善其單位貢獻超過 ' +
                fmtGrouped(variable.reducedCost.abs()) +
                ' 才會進入最佳解'
              );
            })
            .join('；') +
          '。'
      });
    }

    if (result.alternative) {
      notes.push({
        kind: 'alternative',
        title: '存在多重最佳解',
        text:
          '目前這組最佳解並非唯一，管理者可在相同最佳目標值下依其他條件（風險、排程、人力）挑選替代方案。'
      });
    }
    return notes;
  }

  function objectiveSummary(model, result) {
    if (!result || result.status !== 'optimal') {
      return '';
    }
    var info = metaOf(model);
    return (info.objectiveLabel || 'Z') + ' = ' + fmtGrouped(result.z) + (info.objectiveUnit ? ' ' + info.objectiveUnit : '');
  }

  LPC.model = {
    create: create,
    clone: clone,
    validate: validate,
    toSolverInput: toSolverInput,
    fmt: fmt,
    fmtGrouped: fmtGrouped,
    escapeHTML: escapeHTML,
    linearHTML: linearHTML,
    variableHTML: variableHTML,
    relationHTML: relationHTML,
    objectiveHTML: objectiveHTML,
    constraintHTML: constraintHTML,
    modelHTML: modelHTML,
    modelText: modelText,
    modelTextLines: modelTextLines,
    objectiveText: objectiveText,
    constraintText: constraintText,
    encode: encode,
    decode: decode,
    interpret: interpret,
    objectiveSummary: objectiveSummary,
    metaOf: metaOf,
    variableLabel: variableLabel,
    resourceLabel: resourceLabel,
    MAX_VARIABLES: MAX_VARIABLES,
    MAX_MANUAL_VARIABLES: MAX_MANUAL_VARIABLES,
    MAX_CONSTRAINTS: MAX_CONSTRAINTS
  };
})(typeof window !== 'undefined' ? window : globalThis);
