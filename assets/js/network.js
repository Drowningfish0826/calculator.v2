/* ============================================================================
 * network.js — 網路模型引擎：轉運問題、最短路徑、最大流量
 * ----------------------------------------------------------------------------
 * 三種模型共用同一份「節點＋弧線」資料，依講義的建模方式轉成線性規劃：
 *   轉運（Transshipment）  min Σ c·x，供應點／需求點／轉運點的流量平衡
 *   最短路徑（Shortest Path）min Σ d·x，起點流出 1、終點流入 1、中間點流入＝流出，x ∈ {0,1}
 *   最大流量（Maximal Flow） max F，Source 流出−流入＝F、Sink 流入−流出＝F、中間點守恆、0 ≤ x ≤ u
 * 建出的模型是一般的 LPC.model，因此可以直接用既有的單純形法（精確分數）求解，
 * 也可以「套用到自訂模型」看敏感度分析。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});
  var Frac = LPC.Frac;
  var modelLib = LPC.model;

  var MAX_NODES = 20;
  var MAX_VARIABLES = modelLib.MAX_VARIABLES;
  var MAX_CONSTRAINTS = modelLib.MAX_CONSTRAINTS;

  var TYPES = {
    transship: {
      id: 'transship',
      name: '轉運問題',
      en: 'Transshipment',
      sense: 'min',
      valueLabel: '單位運輸成本',
      reverseLabel: '反向成本',
      objectiveLabel: '總運輸成本',
      hint: '貨物可經過中繼站（轉運點）再送到需求點，求總運輸成本最低。'
    },
    shortest: {
      id: 'shortest',
      name: '最短路徑',
      en: 'Shortest Path',
      sense: 'min',
      valueLabel: '距離',
      reverseLabel: '反向距離',
      objectiveLabel: '總距離',
      hint: '從起點走到終點，選出一條總距離最短的路線（每條弧 0 或 1）。'
    },
    maxflow: {
      id: 'maxflow',
      name: '最大流量',
      en: 'Maximal Flow',
      sense: 'max',
      valueLabel: '容量',
      reverseLabel: '反向容量',
      objectiveLabel: '最大流量',
      hint: '在每條弧的容量限制下，求從 Source 送到 Sink 的最大總流量。'
    }
  };

  var ROLE_NAMES = { supply: '供應點', transship: '轉運點', demand: '需求點' };

  /* --------------------------------------------------------------------- */
  /* 小工具                                                                */
  /* --------------------------------------------------------------------- */

  function str(value) {
    return value === undefined || value === null ? '' : String(value).trim();
  }

  function parseNumber(text) {
    try {
      return Frac.coerce(str(text));
    } catch (error) {
      return null;
    }
  }

  function esc(text) {
    return modelLib.escapeHTML(String(text));
  }

  function fmt(value) {
    return modelLib.fmt(value);
  }

  function sum(list) {
    return list.reduce(function (total, value) {
      return total.add(value);
    }, Frac.zero());
  }

  /* --------------------------------------------------------------------- */
  /* 規格（spec）                                                          */
  /* --------------------------------------------------------------------- */

  function create(source) {
    var input = source || {};
    var type = TYPES[input.type] ? input.type : 'shortest';
    var nodes = (input.nodes || []).map(function (node) {
      var item = typeof node === 'string' ? { name: node } : node || {};
      return {
        name: str(item.name),
        role: ROLE_NAMES[item.role] ? item.role : 'transship',
        amount: str(item.amount)
      };
    });
    var arcs = (input.arcs || []).map(function (arc) {
      var item = arc || {};
      return { from: str(item.from), to: str(item.to), value: str(item.value), reverse: str(item.reverse) };
    });
    return {
      type: type,
      title: str(input.title),
      unit: str(input.unit),
      nodes: nodes,
      arcs: arcs,
      source: str(input.source) || (nodes[0] ? nodes[0].name : ''),
      sink: str(input.sink) || (nodes.length ? nodes[nodes.length - 1].name : '')
    };
  }

  function clone(spec) {
    return create(JSON.parse(JSON.stringify(spec)));
  }

  /* --------------------------------------------------------------------- */
  /* 驗證與整理                                                            */
  /* --------------------------------------------------------------------- */

  function compile(spec) {
    var errors = [];
    var warnings = [];
    var type = spec.type;
    var nodeIndex = {};
    var nodes = [];

    if (spec.nodes.length < 2) {
      errors.push('至少需要 2 個節點。');
    }
    if (spec.nodes.length > MAX_NODES) {
      errors.push('節點最多 ' + MAX_NODES + ' 個（目前 ' + spec.nodes.length + ' 個）。');
    }
    spec.nodes.forEach(function (node, index) {
      var name = node.name;
      if (!name) {
        errors.push('第 ' + (index + 1) + ' 個節點沒有名稱。');
        return;
      }
      if (nodeIndex[name] !== undefined) {
        errors.push('節點名稱「' + name + '」重複了，每個節點名稱必須不同。');
        return;
      }
      var amount = null;
      if (type === 'transship' && node.role !== 'transship') {
        amount = parseNumber(node.amount);
        if (amount === null) {
          errors.push('「' + name + '」的' + (node.role === 'supply' ? '供應量' : '需求量') + '「' + (node.amount || '空白') + '」不是有效數字。');
        } else if (amount.isNeg()) {
          errors.push('「' + name + '」的' + (node.role === 'supply' ? '供應量' : '需求量') + '不可為負。');
        }
      }
      nodeIndex[name] = nodes.length;
      nodes.push({ name: name, role: node.role, amount: amount });
    });

    var arcs = [];
    var seen = {};
    function pushArc(from, to, raw, row, reversed) {
      var value = parseNumber(raw);
      var label = from + ' → ' + to;
      if (value === null) {
        errors.push('弧線 ' + label + ' 的' + (reversed ? TYPES[type].reverseLabel : TYPES[type].valueLabel) + '「' + raw + '」不是有效數字。');
        return;
      }
      if ((type === 'shortest' || type === 'maxflow') && value.isNeg()) {
        errors.push('弧線 ' + label + ' 的' + TYPES[type].valueLabel + '不可為負。');
        return;
      }
      if (type === 'maxflow' && value.isZero()) {
        return;
      }
      var key = from + '\u0000' + to;
      if (seen[key]) {
        errors.push('弧線 ' + label + ' 重複出現（第 ' + (seen[key].row + 1) + ' 列與第 ' + (row + 1) + ' 列）。');
        return;
      }
      var arc = { from: from, to: to, i: nodeIndex[from], j: nodeIndex[to], value: value, row: row, reversed: reversed };
      seen[key] = arc;
      arcs.push(arc);
    }

    spec.arcs.forEach(function (arc, row) {
      if (!arc.from && !arc.to && !arc.value && !arc.reverse) {
        return;
      }
      if (!arc.from || nodeIndex[arc.from] === undefined) {
        errors.push('第 ' + (row + 1) + ' 條弧線的起點「' + (arc.from || '空白') + '」不是已定義的節點。');
        return;
      }
      if (!arc.to || nodeIndex[arc.to] === undefined) {
        errors.push('第 ' + (row + 1) + ' 條弧線的終點「' + (arc.to || '空白') + '」不是已定義的節點。');
        return;
      }
      if (arc.from === arc.to) {
        errors.push('第 ' + (row + 1) + ' 條弧線的起點與終點相同（' + arc.from + '）。');
        return;
      }
      if (arc.value === '' && arc.reverse === '') {
        errors.push('弧線 ' + arc.from + ' → ' + arc.to + ' 沒有填' + TYPES[type].valueLabel + '。');
        return;
      }
      if (arc.value !== '') {
        pushArc(arc.from, arc.to, arc.value, row, false);
      }
      if (arc.reverse !== '') {
        pushArc(arc.to, arc.from, arc.reverse, row, true);
      }
    });

    if (!arcs.length && !errors.length) {
      errors.push(type === 'maxflow' ? '沒有容量大於 0 的弧線。' : '尚未輸入任何弧線。');
    }

    var source = null;
    var sink = null;
    if (type === 'shortest' || type === 'maxflow') {
      source = nodeIndex[spec.source];
      sink = nodeIndex[spec.sink];
      if (source === undefined) {
        errors.push('請選擇' + (type === 'shortest' ? '起點' : 'Source（來源點）') + '。');
      }
      if (sink === undefined) {
        errors.push('請選擇' + (type === 'shortest' ? '終點' : 'Sink（目的地）') + '。');
      }
      if (source !== undefined && source === sink) {
        errors.push('起點與終點不能是同一個節點。');
      }
    }

    var totals = null;
    if (type === 'transship') {
      var supplyNodes = nodes.filter(function (node) {
        return node.role === 'supply';
      });
      var demandNodes = nodes.filter(function (node) {
        return node.role === 'demand';
      });
      if (!supplyNodes.length) {
        errors.push('轉運問題至少需要一個供應點。');
      }
      if (!demandNodes.length) {
        errors.push('轉運問題至少需要一個需求點。');
      }
      if (!errors.length) {
        totals = {
          supply: sum(supplyNodes.map(function (node) {
            return node.amount;
          })),
          demand: sum(demandNodes.map(function (node) {
            return node.amount;
          }))
        };
      }
    }

    var varCount = arcs.length + (type === 'maxflow' ? 1 : 0);
    var rowCount = nodes.length + (type === 'maxflow' ? arcs.length : 0);
    if (varCount > MAX_VARIABLES) {
      errors.push('弧線太多：決策變數最多 ' + MAX_VARIABLES + ' 個（目前 ' + varCount + ' 個）。');
    }
    if (rowCount > MAX_CONSTRAINTS) {
      errors.push('限制式最多 ' + MAX_CONSTRAINTS + ' 條（目前 ' + rowCount + ' 條），請減少節點或弧線。');
    }

    /* 孤立節點提醒 */
    if (!errors.length) {
      nodes.forEach(function (node, index) {
        var touched = arcs.some(function (arc) {
          return arc.i === index || arc.j === index;
        });
        if (!touched) {
          warnings.push('節點「' + node.name + '」沒有連接任何弧線。');
        }
      });
    }

    return {
      ok: errors.length === 0,
      errors: errors,
      warnings: warnings,
      type: type,
      nodes: nodes,
      arcs: arcs,
      source: source,
      sink: sink,
      totals: totals
    };
  }

  /* --------------------------------------------------------------------- */
  /* 建立線性規劃模型                                                      */
  /* --------------------------------------------------------------------- */

  function variableName(compiled, arc) {
    var wide = compiled.nodes.length > 9;
    return 'x' + (arc.i + 1) + (wide ? '_' : '') + (arc.j + 1);
  }

  function buildModel(spec, compiledInput) {
    var compiled = compiledInput || compile(spec);
    if (!compiled.ok) {
      return { ok: false, compiled: compiled };
    }
    var type = compiled.type;
    var info = TYPES[type];
    var nodes = compiled.nodes;
    var arcs = compiled.arcs;
    var varNames = arcs.map(function (arc) {
      return variableName(compiled, arc);
    });
    var variableLabels = arcs.map(function (arc) {
      return arc.from + '→' + arc.to;
    });
    var width = arcs.length + (type === 'maxflow' ? 1 : 0);
    var flowIndex = type === 'maxflow' ? arcs.length : -1;
    if (type === 'maxflow') {
      varNames.push('F');
      variableLabels.push('總流量 F');
    }

    function blankRow() {
      var row = [];
      for (var index = 0; index < width; index += 1) {
        row.push('0');
      }
      return row;
    }
    /** 該節點「流出 − 流入」的係數列 */
    function balanceRow(nodeIndex) {
      var row = blankRow();
      arcs.forEach(function (arc, index) {
        if (arc.i === nodeIndex) {
          row[index] = '1';
        } else if (arc.j === nodeIndex) {
          row[index] = '-1';
        }
      });
      return row;
    }
    function negate(row) {
      return row.map(function (value) {
        return value === '0' ? '0' : value.charAt(0) === '-' ? value.slice(1) : '-' + value;
      });
    }

    var constraints = [];
    var notes = [];
    var caseInfo = null;

    if (type === 'transship') {
      var cmp = compiled.totals.supply.cmp(compiled.totals.demand);
      caseInfo = cmp === 0 ? 'balanced' : cmp < 0 ? 'short' : 'surplus';
      if (caseInfo === 'short') {
        notes.push(
          '總供應量 ' + fmt(compiled.totals.supply) + ' < 總需求量 ' + fmt(compiled.totals.demand) +
            '（供不應求）：供應點的貨全部運出（＝），需求點收到的量不超過需求（≤）。'
        );
      } else if (caseInfo === 'surplus') {
        notes.push(
          '總供應量 ' + fmt(compiled.totals.supply) + ' > 總需求量 ' + fmt(compiled.totals.demand) +
            '（供過於求）：需求點全部滿足（＝），供應點運出的量不超過供應量（≤）。'
        );
      } else {
        notes.push('總供應量＝總需求量＝' + fmt(compiled.totals.supply) + '（供需平衡）：供應點與需求點都寫成等式。');
      }
      nodes.forEach(function (node, index) {
        if (node.role === 'supply') {
          constraints.push({
            a: balanceRow(index),
            op: caseInfo === 'surplus' ? '<=' : '=',
            b: node.amount.toString(),
            label: node.name + ' 供應'
          });
        } else if (node.role === 'demand') {
          constraints.push({
            a: negate(balanceRow(index)),
            op: caseInfo === 'short' ? '<=' : '=',
            b: node.amount.toString(),
            label: node.name + ' 需求'
          });
        } else {
          constraints.push({ a: negate(balanceRow(index)), op: '=', b: '0', label: node.name + ' 流量平衡' });
        }
      });
    } else if (type === 'shortest') {
      nodes.forEach(function (node, index) {
        if (index === compiled.source) {
          constraints.push({ a: balanceRow(index), op: '=', b: '1', label: '起點 ' + node.name });
        } else if (index === compiled.sink) {
          constraints.push({ a: negate(balanceRow(index)), op: '=', b: '1', label: '終點 ' + node.name });
        } else {
          constraints.push({ a: negate(balanceRow(index)), op: '=', b: '0', label: node.name + ' 流量平衡' });
        }
      });
    } else {
      nodes.forEach(function (node, index) {
        var row;
        if (index === compiled.source) {
          row = balanceRow(index);
          row[flowIndex] = '-1';
          constraints.push({ a: row, op: '=', b: '0', label: 'Source ' + node.name });
        } else if (index === compiled.sink) {
          row = negate(balanceRow(index));
          row[flowIndex] = '-1';
          constraints.push({ a: row, op: '=', b: '0', label: 'Sink ' + node.name });
        } else {
          constraints.push({ a: negate(balanceRow(index)), op: '=', b: '0', label: node.name + ' 流量守恆' });
        }
      });
      arcs.forEach(function (arc, index) {
        var row = blankRow();
        row[index] = '1';
        constraints.push({ a: row, op: '<=', b: arc.value.toString(), label: arc.from + '→' + arc.to + ' 容量' });
      });
    }

    var objective = blankRow();
    if (type === 'maxflow') {
      objective[flowIndex] = '1';
    } else {
      arcs.forEach(function (arc, index) {
        objective[index] = arc.value.toString();
      });
    }

    var built = modelLib.create({
      sense: info.sense,
      varNames: varNames,
      c: objective,
      constraints: constraints,
      binary: varNames.map(function () {
        return type === 'shortest';
      }),
      meta: {
        kind: 'network',
        networkType: type,
        objectiveLabel: info.objectiveLabel,
        objectiveUnit: spec.unit || '',
        variableUnit: type === 'shortest' ? '' : spec.unit || '單位',
        variableLabels: variableLabels,
        resourceLabels: constraints.map(function (constraint) {
          return constraint.label;
        })
      }
    });

    return {
      ok: true,
      compiled: compiled,
      model: built,
      varNames: varNames,
      flowIndex: flowIndex,
      notes: notes,
      caseInfo: caseInfo
    };
  }

  /* --------------------------------------------------------------------- */
  /* 求解與結果解讀                                                        */
  /* --------------------------------------------------------------------- */

  function solve(spec, options) {
    var opts = options || {};
    var compiled = compile(spec);
    if (!compiled.ok) {
      return { ok: false, status: 'invalid', errors: compiled.errors, warnings: compiled.warnings, type: spec.type };
    }
    var built = buildModel(spec, compiled);
    var type = compiled.type;
    var input = modelLib.toSolverInput(built.model);
    var lp;
    try {
      lp =
        type === 'shortest'
          ? LPC.solver.solveInteger(input, { nodeLimit: opts.nodeLimit || 3000 })
          : LPC.solver.solveLP(input, {});
    } catch (error) {
      return { ok: false, status: 'error', errors: ['求解時發生錯誤：' + error.message], type: type, built: built };
    }

    var base = {
      type: type,
      built: built,
      model: built.model,
      notes: built.notes,
      warnings: compiled.warnings.slice(),
      steps: buildSteps(spec, built)
    };

    if (!lp || lp.status === 'infeasible' || !lp.x) {
      var message =
        type === 'shortest'
          ? '從「' + compiled.nodes[compiled.source].name + '」沒有任何路線可以到達「' + compiled.nodes[compiled.sink].name + '」。請確認弧線方向（需要雙向時請填「反向距離」）。'
          : type === 'transship'
          ? '找不到可行的運送方案：有供應點的貨送不出去，或需求點收不到貨。請確認每個供應點都有路線通往需求點。'
          : '找不到可行解，請檢查容量是否為非負數。';
      return extend(base, { ok: true, status: 'infeasible', message: message });
    }
    if (lp.status === 'unbounded') {
      return extend(base, { ok: true, status: 'unbounded', message: '目標函數無界：請檢查是否有負成本的循環路線。' });
    }
    if (lp.status !== 'optimal' && lp.status !== 'limit') {
      return extend(base, { ok: false, status: 'error', errors: ['求解失敗（' + lp.status + '）'] });
    }

    var flows = compiled.arcs.map(function (arc, index) {
      return lp.x[index];
    });

    var cancelled = false;
    if (type === 'maxflow') {
      /* 同一對節點兩個方向都有流量時互相抵銷：總流量不變，方案更清楚 */
      compiled.arcs.forEach(function (arc, index) {
        compiled.arcs.forEach(function (other, otherIndex) {
          if (otherIndex <= index || other.i !== arc.j || other.j !== arc.i) {
            return;
          }
          if (flows[index].isPos() && flows[otherIndex].isPos()) {
            var shared = flows[index].lt(flows[otherIndex]) ? flows[index] : flows[otherIndex];
            flows[index] = flows[index].sub(shared);
            flows[otherIndex] = flows[otherIndex].sub(shared);
            cancelled = true;
          }
        });
      });
    }

    var arcResults = compiled.arcs.map(function (arc, index) {
      var flow = flows[index];
      return {
        from: arc.from,
        to: arc.to,
        i: arc.i,
        j: arc.j,
        name: built.varNames[index],
        value: arc.value,
        flow: flow,
        used: flow.isPos(),
        cost: type === 'maxflow' ? null : arc.value.mul(flow),
        saturated: type === 'maxflow' ? flow.eq(arc.value) : false
      };
    });

    var nodeResults = compiled.nodes.map(function (node, index) {
      var inflow = Frac.zero();
      var outflow = Frac.zero();
      arcResults.forEach(function (arc) {
        if (arc.j === index) {
          inflow = inflow.add(arc.flow);
        }
        if (arc.i === index) {
          outflow = outflow.add(arc.flow);
        }
      });
      return { name: node.name, role: node.role, amount: node.amount, inflow: inflow, outflow: outflow };
    });

    var result = extend(base, {
      ok: true,
      status: 'optimal',
      z: lp.z,
      arcs: arcResults,
      nodes: nodeResults,
      cancelled: cancelled,
      lp: lp
    });

    if (type === 'shortest') {
      result.path = tracePath(compiled, arcResults);
      if (result.path.extraArcs.length) {
        result.warnings.push('最佳解中另有成本為 0 的循環弧線（' + result.path.extraArcs.join('、') + '），不影響最短距離。');
      }
    } else if (type === 'maxflow') {
      result.maxFlow = lp.x[built.flowIndex];
      result.cut = minimumCut(compiled, arcResults);
      if (cancelled) {
        result.warnings.push('求解結果中有同一對節點雙向都有流量的情形，已互相抵銷（總流量不變）。');
      }
    } else {
      result.totals = compiled.totals;
      result.caseInfo = built.caseInfo;
      result.stageCosts = stageCosts(arcResults, compiled);
      result.unmet = nodeResults
        .filter(function (node) {
          return node.role === 'demand';
        })
        .map(function (node) {
          var received = node.inflow.sub(node.outflow);
          return { name: node.name, demand: node.amount, received: received, shortage: node.amount.sub(received) };
        });
      result.leftover = nodeResults
        .filter(function (node) {
          return node.role === 'supply';
        })
        .map(function (node) {
          var shipped = node.outflow.sub(node.inflow);
          return { name: node.name, supply: node.amount, shipped: shipped, left: node.amount.sub(shipped) };
        });
    }
    if (lp.status === 'limit') {
      result.warnings.push('分支定界達到節點上限，結果可能不是最佳解。');
    }
    return result;
  }

  function extend(target, extra) {
    Object.keys(extra).forEach(function (key) {
      target[key] = extra[key];
    });
    return target;
  }

  function tracePath(compiled, arcResults) {
    var nodes = [compiled.source];
    var used = {};
    var current = compiled.source;
    var guard = 0;
    while (current !== compiled.sink && guard < compiled.nodes.length + 1) {
      guard += 1;
      var next = null;
      for (var index = 0; index < arcResults.length; index += 1) {
        var arc = arcResults[index];
        if (!used[index] && arc.i === current && arc.flow.isPos()) {
          next = index;
          break;
        }
      }
      if (next === null) {
        break;
      }
      used[next] = true;
      current = arcResults[next].j;
      nodes.push(current);
    }
    var extraArcs = arcResults
      .filter(function (arc, index) {
        return arc.flow.isPos() && !used[index];
      })
      .map(function (arc) {
        return arc.from + '→' + arc.to;
      });
    var legs = [];
    for (var step = 0; step + 1 < nodes.length; step += 1) {
      var leg = arcResults.filter(function (arc) {
        return arc.i === nodes[step] && arc.j === nodes[step + 1];
      })[0];
      legs.push({ from: leg.from, to: leg.to, value: leg.value, name: leg.name });
    }
    return {
      nodes: nodes.map(function (index) {
        return compiled.nodes[index].name;
      }),
      legs: legs,
      complete: current === compiled.sink,
      extraArcs: extraArcs
    };
  }

  /** 以剩餘網路找出 Source 可到達的節點集合，跨越集合的弧線就是最小切割（瓶頸） */
  function minimumCut(compiled, arcResults) {
    var reach = {};
    reach[compiled.source] = true;
    var queue = [compiled.source];
    while (queue.length) {
      var current = queue.shift();
      arcResults.forEach(function (arc) {
        if (arc.i === current && !reach[arc.j] && arc.flow.lt(arc.value)) {
          reach[arc.j] = true;
          queue.push(arc.j);
        }
        if (arc.j === current && !reach[arc.i] && arc.flow.isPos()) {
          reach[arc.i] = true;
          queue.push(arc.i);
        }
      });
    }
    var cutArcs = arcResults.filter(function (arc) {
      return reach[arc.i] && !reach[arc.j];
    });
    return {
      sourceSide: compiled.nodes
        .map(function (node, index) {
          return reach[index] ? node.name : null;
        })
        .filter(Boolean),
      arcs: cutArcs.map(function (arc) {
        return { from: arc.from, to: arc.to, value: arc.value };
      }),
      capacity: sum(
        cutArcs.map(function (arc) {
          return arc.value;
        })
      )
    };
  }

  function stageCosts(arcResults, compiled) {
    var groups = {};
    var order = [];
    arcResults.forEach(function (arc) {
      var key = ROLE_NAMES[compiled.nodes[arc.i].role] + ' → ' + ROLE_NAMES[compiled.nodes[arc.j].role];
      if (!groups[key]) {
        groups[key] = { label: key, cost: Frac.zero(), terms: [] };
        order.push(key);
      }
      if (arc.used) {
        groups[key].cost = groups[key].cost.add(arc.cost);
        groups[key].terms.push(fmt(arc.value) + '(' + fmt(arc.flow) + ')');
      }
    });
    return order.map(function (key) {
      return groups[key];
    });
  }

  /* --------------------------------------------------------------------- */
  /* 建模步驟（對照講義的寫法）                                            */
  /* --------------------------------------------------------------------- */

  function varHTML(name) {
    if (name === 'F') {
      return '<i>F</i>';
    }
    return '<i>x</i><sub>' + esc(name.slice(1)) + '</sub>';
  }

  function sumHTML(names) {
    if (!names.length) {
      return '0';
    }
    return names.map(varHTML).join(' + ');
  }

  function buildSteps(spec, built) {
    var compiled = built.compiled;
    var type = compiled.type;
    var arcs = compiled.arcs;
    var names = built.varNames;
    var steps = [];

    function outNames(index) {
      return arcs
        .map(function (arc, position) {
          return arc.i === index ? names[position] : null;
        })
        .filter(Boolean);
    }
    function inNames(index) {
      return arcs
        .map(function (arc, position) {
          return arc.j === index ? names[position] : null;
        })
        .filter(Boolean);
    }

    steps.push({
      title: '定義決策變數',
      lines: [
        type === 'shortest'
          ? '<i>x</i><sub>ij</sub> = 1 表示路線經過弧線 (i, j)，0 表示不經過。'
          : '<i>x</i><sub>ij</sub> = 由節點 i 運送到節點 j 的數量。'
      ].concat(
        arcs.slice(0, 4).map(function (arc, index) {
          return varHTML(names[index]) + ' ：' + esc(arc.from) + ' → ' + esc(arc.to);
        }),
        arcs.length > 4 ? ['…共 ' + arcs.length + ' 條弧線'] : [],
        type === 'maxflow' ? ['<i>F</i> = 由 Source 送到 Sink 的總流量'] : []
      )
    });

    if (type === 'maxflow') {
      steps.push({ title: '目標函數', lines: ['max <i>F</i>'] });
    } else {
      var terms = arcs.map(function (arc, index) {
        return fmt(arc.value) + varHTML(names[index]);
      });
      steps.push({ title: '目標函數', lines: ['min <i>Z</i> = ' + terms.join(' + ')] });
    }

    var nodeLines = [];
    compiled.nodes.forEach(function (node, index) {
      var outs = sumHTML(outNames(index));
      var ins = sumHTML(inNames(index));
      var hasIn = inNames(index).length > 0;
      var hasOut = outNames(index).length > 0;
      var label = '<b>' + esc(node.name) + '</b>：';
      if (type === 'transship') {
        var c = built.caseInfo;
        if (node.role === 'supply') {
          nodeLines.push(label + (hasIn ? outs + ' − (' + ins + ')' : outs) + (c === 'surplus' ? ' ≤ ' : ' = ') + fmt(node.amount));
        } else if (node.role === 'demand') {
          nodeLines.push(label + (hasOut ? ins + ' − (' + outs + ')' : ins) + (c === 'short' ? ' ≤ ' : ' = ') + fmt(node.amount));
        } else {
          nodeLines.push(label + ins + ' = ' + outs + '　（流入量＝流出量）');
        }
      } else if (type === 'shortest') {
        if (index === compiled.source) {
          nodeLines.push(label + (hasIn ? outs + ' − (' + ins + ')' : outs) + ' = 1　（起點必須選一條出口）');
        } else if (index === compiled.sink) {
          nodeLines.push(label + (hasOut ? ins + ' − (' + outs + ')' : ins) + ' = 1　（終點必須有一條入口）');
        } else {
          nodeLines.push(label + ins + ' = ' + outs);
        }
      } else {
        if (index === compiled.source) {
          nodeLines.push(label + outs + (hasIn ? ' − ' + inNames(index).map(varHTML).join(' − ') : '') + ' = <i>F</i>　（流出 − 流入 ＝ F）');
        } else if (index === compiled.sink) {
          nodeLines.push(label + ins + (hasOut ? ' − ' + outNames(index).map(varHTML).join(' − ') : '') + ' = <i>F</i>　（流入 − 流出 ＝ F）');
        } else {
          nodeLines.push(label + ins + ' = ' + outs);
        }
      }
    });

    if (type === 'transship') {
      steps.push({ title: '供應、需求與轉運點流量平衡', lines: built.notes.map(esc).concat(nodeLines) });
      steps.push({ title: '非負限制', lines: ['所有 <i>x</i><sub>ij</sub> ≥ 0'] });
    } else if (type === 'shortest') {
      steps.push({ title: '起點、終點與中間節點流量平衡', lines: nodeLines });
      steps.push({ title: '0-1 限制', lines: ['<i>x</i><sub>ij</sub> ∈ {0, 1}　（1：選擇該弧線；0：不選）'] });
    } else {
      steps.push({ title: 'Source、Sink 與中間節點流量守恆', lines: nodeLines });
      steps.push({
        title: '容量限制',
        lines: arcs.slice(0, 6).map(function (arc, index) {
          return '0 ≤ ' + varHTML(names[index]) + ' ≤ ' + fmt(arc.value);
        }).concat(arcs.length > 6 ? ['…其餘弧線 0 ≤ <i>x</i><sub>ij</sub> ≤ <i>u</i><sub>ij</sub>'] : [])
      });
    }
    return steps;
  }

  /* --------------------------------------------------------------------- */
  /* 講義例題                                                              */
  /* --------------------------------------------------------------------- */

  function arcList(rows) {
    return rows.map(function (row) {
      return { from: row[0], to: row[1], value: String(row[2]), reverse: row[3] === undefined ? '' : String(row[3]) };
    });
  }

  var examples = [
    {
      id: 'walsh',
      type: 'transship',
      title: 'Walsh 水果公司（轉運）',
      description:
        '葡萄由 Ohio、Pennsylvania、New York 三個農場送到 Indiana、Georgia 兩個加工廠，再送到 Virginia、Kentucky、Louisiana 三個配銷中心。總供給 260 < 總需求 290（千噸），求最低運輸成本。',
      answer: '講義答案：Z* = 10,043；Virginia 75+15、Kentucky 80、Louisiana 90（尚缺 30）。',
      build: function () {
        return create({
          type: 'transship',
          title: 'Walsh 水果公司',
          unit: '千噸',
          nodes: [
            { name: 'Ohio', role: 'supply', amount: '72' },
            { name: 'Pennsylvania', role: 'supply', amount: '105' },
            { name: 'New York', role: 'supply', amount: '83' },
            { name: 'Indiana', role: 'transship' },
            { name: 'Georgia', role: 'transship' },
            { name: 'Virginia', role: 'demand', amount: '90' },
            { name: 'Kentucky', role: 'demand', amount: '80' },
            { name: 'Louisiana', role: 'demand', amount: '120' }
          ],
          arcs: arcList([
            ['Ohio', 'Indiana', 16], ['Ohio', 'Georgia', 21],
            ['Pennsylvania', 'Indiana', 18], ['Pennsylvania', 'Georgia', 16],
            ['New York', 'Indiana', 22], ['New York', 'Georgia', 25],
            ['Indiana', 'Virginia', 23], ['Indiana', 'Kentucky', 15], ['Indiana', 'Louisiana', 29],
            ['Georgia', 'Virginia', 20], ['Georgia', 'Kentucky', 17], ['Georgia', 'Louisiana', 24]
          ])
        });
      }
    },
    {
      id: 'shortest-7',
      type: 'shortest',
      title: '節點 1 → 7 最短路徑',
      description: '7 個節點、12 條弧線，弧上數字為距離（公里），求由節點 1 到節點 7 的最短路徑。',
      answer: '講義答案：1 → 3 → 4 → 7，Z* = 17 + 12 + 9 = 38 公里。',
      build: function () {
        return create({
          type: 'shortest',
          title: '節點 1 到節點 7 的最短路徑',
          unit: '公里',
          nodes: ['1', '2', '3', '4', '5', '6', '7'],
          source: '1',
          sink: '7',
          arcs: arcList([
            ['1', '2', 21], ['1', '3', 17], ['1', '4', 30], ['2', '4', 10], ['2', '5', 25], ['3', '4', 12],
            ['3', '6', 25], ['4', '5', 18], ['4', '6', 10], ['4', '7', 9], ['5', '7', 12], ['6', '7', 15]
          ])
        });
      }
    },
    {
      id: 'express',
      type: 'maxflow',
      title: '國際快遞包裹服務中心（最大流量）',
      description: '各路線兩個方向的每日最大運量（噸）不同，求由第 1 站送到第 7 站每日最多可運送多少包裹。',
      answer: '講義：節點 1 的總輸出能力為 6 + 5 = 11，故最大流量不超過 11。',
      build: function () {
        return create({
          type: 'maxflow',
          title: '國際快遞包裹服務中心',
          unit: '噸',
          nodes: ['1', '2', '3', '4', '5', '6', '7'],
          source: '1',
          sink: '7',
          arcs: arcList([
            ['1', '2', 6, 0], ['1', '3', 5, 1], ['2', '4', 2, 1], ['2', '6', 3, 4], ['3', '4', 7, 2], ['3', '5', 3, 0],
            ['3', '7', 4, 0], ['4', '5', 2, 6], ['4', '6', 4, 2], ['5', '7', 9, 0], ['6', '7', 4, 0]
          ])
        });
      }
    }
  ];

  function findExample(id) {
    return examples.filter(function (example) {
      return example.id === id;
    })[0] || null;
  }

  function blank(type) {
    if (type === 'transship') {
      return create({
        type: 'transship',
        nodes: [
          { name: '工廠1', role: 'supply', amount: '100' },
          { name: '物流中心', role: 'transship' },
          { name: '客戶1', role: 'demand', amount: '100' }
        ],
        arcs: [{ from: '工廠1', to: '物流中心', value: '' }, { from: '物流中心', to: '客戶1', value: '' }]
      });
    }
    return create({
      type: type,
      nodes: ['1', '2', '3'],
      source: '1',
      sink: '3',
      arcs: [{ from: '1', to: '2', value: '' }, { from: '2', to: '3', value: '' }]
    });
  }

  LPC.network = {
    TYPES: TYPES,
    ROLE_NAMES: ROLE_NAMES,
    MAX_NODES: MAX_NODES,
    create: create,
    clone: clone,
    blank: blank,
    compile: compile,
    buildModel: buildModel,
    solve: solve,
    varHTML: varHTML,
    examples: examples,
    findExample: findExample
  };
})(typeof window !== 'undefined' ? window : globalThis);
