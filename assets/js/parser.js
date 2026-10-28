/* ============================================================================
 * parser.js — 文字建模（離線規則引擎）
 * ----------------------------------------------------------------------------
 * 兩種輸入方式：
 *   1. 自然語言：抽取產品、單位利潤、資源耗用與資源上限
 *   2. 速記格式：一行一條限制式，適合快速輸入
 * 解析結果一律轉成可再編輯的模型，並回報「找到了什麼」與警告，
 * 讓使用者知道系統的判斷依據，而不是黑箱。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});
  var model = LPC.model;

  var UNIT_WORDS = [
    '小時', '工時', '人時', '人日', '機時', '公斤', '公克', '公噸', '噸', 'kg', 'g',
    '單位', '箱', '件', '台', '部', '度', '桶', '人', '天', '日', '元', '萬元', '％', '%',
    '平方公尺', '立方公尺', '公升', '毫升', '個', '包', '袋', '張', '小時'
  ].sort(function (left, right) {
    return right.length - left.length;
  });

  var PROFIT_WORDS =
    '利潤|毛利|收益|獲利|淨利|售價|單價|貢獻|報酬|產值|附加價值|利差|成本|費用|支出';
  var USAGE_WORDS =
    '需要|需|耗用|消耗|使用|投入|佔用|花費|用掉|要用|製造|生產|含有|含|提供|搭配|消耗掉';
  var CAPACITY_WORDS =
    '可用|最多|最高|上限|不超過|限額|限量|供應|庫存|總共|共有|僅有|預算|產能|每天|每日|每月|每週|本週|至少|最少|不得低於|需求';

  function normalizeText(text) {
    return String(text || '')
      .replace(/[０-９]/g, function (character) {
        return String.fromCharCode(character.charCodeAt(0) - 0xfee0);
      })
      .replace(/[Ａ-Ｚａ-ｚ]/g, function (character) {
        return String.fromCharCode(character.charCodeAt(0) - 0xfee0);
      })
      .replace(/≤/g, '<=')
      .replace(/≥/g, '>=')
      .replace(/≦/g, '<=')
      .replace(/≧/g, '>=')
      .replace(/：/g, ':')
      .replace(/。/g, '。\n');
  }

  function splitSentences(text) {
    return text
      .split(/[。；;\n]/)
      .map(function (line) {
        return line.trim();
      })
      .filter(Boolean);
  }

  function stripUnitPrefix(word) {
    var result = word;
    for (var index = 0; index < UNIT_WORDS.length; index += 1) {
      var unit = UNIT_WORDS[index];
      if (result.indexOf(unit) === 0) {
        result = result.slice(unit.length);
        break;
      }
    }
    return result;
  }

  function unique(list) {
    var seen = {};
    var output = [];
    list.forEach(function (item) {
      if (!item || seen[item]) {
        return;
      }
      seen[item] = true;
      output.push(item);
    });
    return output;
  }

  /**
   * 在同一個句子裡，找出最靠近資源名稱的那個數字。
   * 以「子句」為單位可避免把前一句的數字誤判成本句的上限。
   */
  function detectCapacity(text, name) {
    var sentences = splitSentences(text);
    var found = null;
    sentences.forEach(function (sentence) {
      if (!new RegExp(CAPACITY_WORDS).test(sentence)) {
        return;
      }
      var clauses = sentence.split(/[，,、]/);
      clauses.forEach(function (clause) {
        var nameIndex = clause.indexOf(name);
        if (nameIndex < 0) {
          return;
        }
        var pattern = /\d+(?:\.\d+)?/g;
        var match;
        var bestValue = null;
        var bestDistance = Infinity;
        while ((match = pattern.exec(clause)) !== null) {
          var distance = Math.abs(match.index - nameIndex);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestValue = match[0];
          }
        }
        if (bestValue !== null && found === null) {
          found = bestValue;
        }
      });
    });
    return found;
  }

  /* --------------------------------------------------------------------- */
  /* 產品名稱                                                              */
  /* --------------------------------------------------------------------- */

  var CHINESE_ORDINALS = ['甲', '乙', '丙', '丁', '戊', '己'];

  function detectProducts(text) {
    var enumerated = /([甲乙丙丁戊]|[A-Z])\s*(?:、|,|，|和|與|及|\/)\s*([甲乙丙丁戊]|[A-Z])(?:\s*(?:、|,|，|和|與|及)\s*([甲乙丙丁戊]|[A-Z]))?(?:\s*(?:、|,|，|和|與|及)\s*([甲乙丙丁戊]|[A-Z]))?/.exec(
      text
    );
    if (enumerated) {
      var list = enumerated.slice(1).filter(Boolean);
      return unique(list);
    }
    var letters = [];
    var letterPattern = /(?:產品|商品|方案|作物|專案|房型|機型|車型|品項)\s*([A-Z]|[甲乙丙丁戊])/g;
    var match;
    while ((match = letterPattern.exec(text)) !== null) {
      letters.push(match[1]);
    }
    if (letters.length >= 2) {
      return unique(letters);
    }
    var looseLetters = [];
    var loosePattern = /(?:^|[^A-Za-z])([A-Z])(?![A-Za-z])/g;
    while ((match = loosePattern.exec(text)) !== null) {
      looseLetters.push(match[1]);
    }
    return unique(looseLetters).slice(0, model.MAX_VARIABLES);
  }

  /* --------------------------------------------------------------------- */
  /* 自然語言解析                                                          */
  /* --------------------------------------------------------------------- */

  function parseNatural(rawText) {
    var text = normalizeText(rawText);
    var sentences = splitSentences(text);
    var findings = [];
    var warnings = [];
    var textForSense = text;

    var sense = 'max';
    if (/最小|最低|最少|省錢|降低成本|成本最小|極小/.test(textForSense)) {
      sense = 'min';
    }
    if (/最大|最高|最多|極大|利潤最大|收益最大/.test(textForSense)) {
      sense = sense === 'min' ? sense : 'max';
    }
    findings.push({
      label: '問題類型',
      value: sense === 'max' ? '最大化' : '最小化'
    });

    var products = detectProducts(text);
    if (!products.length) {
      warnings.push('找不到產品或決策項目（例如「A、B 兩種產品」）。請在下方表單直接設定。');
      return {
        ok: false,
        model: null,
        findings: findings,
        warnings: warnings,
        confidence: 0
      };
    }
    findings.push({ label: '決策項目', value: products.join('、') });

    /* ---- 單位利潤 ---- */
    var profits = products.map(function (product) {
      var pattern = new RegExp(
        '(' + escapeRegExp(product) + ')[^。；\\n]{0,24}?(?:' + PROFIT_WORDS + ')[^0-9]{0,8}(\\d+(?:\\.\\d+)?)',
        ''
      );
      var matched = pattern.exec(text);
      if (matched) {
        findings.push({ label: product + ' 的單位貢獻', value: matched[2] });
        return matched[2];
      }
      var reversed = new RegExp(
        '(?:' + PROFIT_WORDS + ')[^。；\\n]{0,12}?(' + escapeRegExp(product) + ')[^0-9。；]{0,10}(\\d+(?:\\.\\d+)?)',
        ''
      );
      var alternative = reversed.exec(text);
      if (alternative) {
        findings.push({ label: product + ' 的單位貢獻', value: alternative[2] });
        return alternative[2];
      }
      warnings.push('找不到「' + product + '」的單位利潤／單位成本，暫以 0 代入。');
      return '0';
    });

    /* ---- 資源耗用 ---- */
    var usage = {};
    var resourceOrder = [];

    products.forEach(function (product) {
      sentences.forEach(function (sentence) {
        if (sentence.indexOf(product) < 0) {
          return;
        }
        var sentenceHasUsageWord = new RegExp(USAGE_WORDS).test(sentence);
        /* 以子句為單位，避免把「B 的用量」誤記到「A」身上 */
        var clauses = sentence.split(/[，,、]/);
        clauses.forEach(function (clause) {
          if (clause.indexOf(product) < 0) {
            return;
          }
          if (!sentenceHasUsageWord && !new RegExp(USAGE_WORDS).test(clause)) {
            return;
          }
          var pattern = /(\d+(?:\.\d+)?)\s*([\u4e00-\u9fa5A-Za-z％%]{1,6})/g;
          var match;
          while ((match = pattern.exec(clause)) !== null) {
            var amount = match[1];
            var unitAndName = match[2];
            var unit = null;
            for (var index = 0; index < UNIT_WORDS.length; index += 1) {
              if (unitAndName.indexOf(UNIT_WORDS[index]) === 0) {
                unit = UNIT_WORDS[index];
                break;
              }
            }
            if (!unit) {
              continue;
            }
            var name = stripUnitPrefix(unitAndName)
              .replace(/^的/, '')
              .replace(/(?:與|和|及|、|以|來|生|製).*$/, '');
            if (name.length > 4) {
              name = name.slice(0, 4);
            }
            if (!name) {
              continue;
            }
            if (!usage[name]) {
              usage[name] = { name: name, amount: {}, unit: unit };
              resourceOrder.push(name);
            }
            usage[name].amount[product] = amount;
          }
        });
      });
    });

    if (!resourceOrder.length) {
      warnings.push('找不到資源耗用描述（例如「A 每單位需 2 小時人力」）。');
    }

    /* ---- 資源上限 ---- */
    var capacities = {};
    resourceOrder.forEach(function (name) {
      var value = detectCapacity(text, name);
      if (value !== null) {
        capacities[name] = value;
        findings.push({ label: name + ' 可用量', value: value + usage[name].unit });
      } else {
        capacities[name] = '0';
        warnings.push('找不到「' + name + '」的可用上限，暫以 0 代入。');
      }
    });

    /* ---- 組裝模型 ---- */
    var varNames = products.map(function (product, index) {
      return /^[A-Z]$/.test(product) ? 'x' + (index + 1) : 'x' + (index + 1);
    });
    var constraints = resourceOrder.map(function (name) {
      return {
        a: products.map(function (product) {
          return usage[name].amount[product] || '0';
        }),
        op: sense === 'max' ? '<=' : '>=',
        b: capacities[name],
        label: name
      };
    });

    var objectiveValues = profits;
    var integerFlags = /整數|不可分割|不可切割/.test(text)
      ? products.map(function () {
          return true;
        })
      : products.map(function () {
          return false;
        });

    var built = model.create({
      sense: sense,
      varNames: varNames,
      c: objectiveValues,
      constraints: constraints,
      integer: integerFlags,
      meta: {
        objectiveLabel: sense === 'max' ? '總利潤' : '總成本',
        objectiveUnit: '元',
        variableUnit: '單位',
        variableLabels: products.map(function (product) {
          return '產品 ' + product;
        }),
        resourceLabels: resourceOrder
      }
    });

    var scoreParts = 0;
    var scoreTotal = products.length + resourceOrder.length * 2;
    products.forEach(function (product, index) {
      if (objectiveValues[index] !== '0') {
        scoreParts += 1;
      }
    });
    resourceOrder.forEach(function (name) {
      if (capacities[name] !== '0') {
        scoreParts += 1;
      }
      var covered = products.filter(function (product) {
        return usage[name].amount[product] !== undefined;
      }).length;
      if (covered > 0) {
        scoreParts += 1;
      }
    });
    var confidence = scoreTotal ? Math.min(1, scoreParts / scoreTotal) : 0;

    return {
      ok: resourceOrder.length > 0 && confidence > 0,
      mode: 'natural',
      model: built,
      findings: findings,
      warnings: warnings,
      confidence: confidence
    };
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* --------------------------------------------------------------------- */
  /* 速記格式解析                                                          */
  /* --------------------------------------------------------------------- */

  function parseShorthand(rawText) {
    var lines = String(rawText || '')
      .split(/\n/)
      .map(function (line) {
        return line.trim();
      })
      .filter(function (line) {
        return line && line.charAt(0) !== '#' && line.charAt(0) !== '／';
      });
    if (!lines.length) {
      return { ok: false, warnings: ['沒有輸入內容。'], findings: [], confidence: 0 };
    }

    var findings = [];
    var warnings = [];
    var sense = 'max';
    if (/^(min|最小化|最小)$/i.test(lines[0])) {
      sense = 'min';
      lines.shift();
    } else if (/^(max|最大化|最大)$/i.test(lines[0])) {
      lines.shift();
    }

    var objectiveLine = null;
    var constraintLines = [];
    lines.forEach(function (line) {
      if (/^(利潤|毛利|收益|目標|成本|objective|z)\b/i.test(line) || /^(利潤|毛利|收益|目標|成本)/.test(line)) {
        objectiveLine = line;
      } else {
        constraintLines.push(line);
      }
    });

    if (!objectiveLine) {
      return { ok: false, warnings: ['找不到目標函數行（請以「利潤 30 50」開頭）。'], findings: [], confidence: 0 };
    }

    var objectiveTokens = objectiveLine.split(/[\s,]+/);
    var objectiveValues = objectiveTokens.slice(1).filter(function (token) {
      return isNumeric(token);
    });
    if (!objectiveValues.length) {
      return { ok: false, warnings: ['目標函數行沒有數字。'], findings: [], confidence: 0 };
    }

    var varCount = objectiveValues.length;
    var constraints = constraintLines.map(function (line) {
      var tokens = line.split(/[\s,]+/);
      var label = tokens[0];
      var rest = tokens.slice(1);
      var op = '<=' ;
      var rhs = '0';
      var coefficients = [];
      rest.forEach(function (token) {
        if (/^(<=|<|≤|小於等於)$/.test(token)) {
          op = '<=';
        } else if (/^(>=|>|≥|大於等於)$/.test(token)) {
          op = '>=';
        } else if (/^(=|=|＝)$/.test(token)) {
          op = '=';
        } else if (isNumeric(token)) {
          coefficients.push(token);
        }
      });
      if (coefficients.length > varCount) {
        rhs = coefficients.pop();
      } else {
        warnings.push('「' + label + '」的係數數量不足，已補 0。');
      }
      while (coefficients.length < varCount) {
        coefficients.push('0');
      }
      return { a: coefficients.slice(0, varCount), op: op, b: rhs, label: label };
    });

    findings.push({ label: '問題類型', value: sense === 'max' ? '最大化' : '最小化' });
    findings.push({ label: '決策變數', value: varCount + ' 個' });
    findings.push({
      label: '目標係數',
      value: objectiveValues.join(', ')
    });

    var built = model.create({
      sense: sense,
      varNames: Array.from({ length: varCount }, function (_, index) {
        return 'x' + (index + 1);
      }),
      c: objectiveValues,
      constraints: constraints,
      meta: {
        objectiveLabel: sense === 'max' ? '總利潤' : '總成本',
        resourceLabels: constraints.map(function (constraint) {
          return constraint.label;
        })
      }
    });

    return {
      ok: constraints.length > 0,
      mode: 'shorthand',
      model: built,
      findings: findings,
      warnings: warnings,
      confidence: constraints.length > 0 ? 1 : 0
    };
  }

  function isNumeric(token) {
    return /^[+-]?\d+(?:\.\d+)?(?:\/\d+)?$/.test(token);
  }

  /* --------------------------------------------------------------------- */

  function parse(rawText) {
    var text = String(rawText || '');
    var looksShorthand =
      /^\s*(max|min|最大化|最小化)\s*$/im.test(text) &&
      /^\s*([\u4e00-\u9fa5A-Za-z]{1,8})\s+[+-]?\d/im.test(text);
    if (looksShorthand) {
      var shorthand = parseShorthand(text);
      if (shorthand.ok) {
        return shorthand;
      }
    }
    return parseNatural(text);
  }

  var SAMPLE_TEXTS = {
    production:
      '某工廠生產 A、B 兩種產品。每單位 A 的利潤為 30 元，每單位 B 的利潤為 50 元。' +
      '生產每單位 A 需要 2 小時人力與 1 公斤原料；生產每單位 B 需要 3 小時人力與 2 公斤原料。' +
      '本週可用人力為 120 小時，原料為 80 公斤。試問如何安排生產可使利潤最大？',
    diet:
      '農場要調配 A、B 兩種飼料。每公斤 A 的成本為 30 元，每公斤 B 的成本為 20 元。' +
      '每公斤 A 含 3 單位蛋白質與 1 單位熱量，每公斤 B 含 1 單位蛋白質與 2 單位熱量。' +
      '每日最少需要 18 單位蛋白質與 16 單位熱量，求最低成本的配方。'
  };

  LPC.parser = {
    parse: parse,
    parseNatural: parseNatural,
    parseShorthand: parseShorthand,
    SAMPLE_TEXTS: SAMPLE_TEXTS
  };
})(typeof window !== 'undefined' ? window : globalThis);
