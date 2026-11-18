/* ============================================================================
 * networkui.js — 「網路模型」分頁的介面（左：節點與弧線；右：網路圖與結果）
 * ----------------------------------------------------------------------------
 * 自己的狀態、自己的儲存鍵、自己的結果面板；求解交給 LPC.network。
 * 「套用到自訂模型」會把建好的線性規劃送到第一個分頁，可再看敏感度分析。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});
  var NET = LPC.network;
  var modelLib = LPC.model;
  var fmt = modelLib.fmt;
  var fmtGrouped = modelLib.fmtGrouped;
  var esc = modelLib.escapeHTML;

  var STORAGE_KEY = 'lpc.network.v1';
  var SOLVE_DELAY = 160;

  var ns = {
    spec: null,
    result: null,
    view: 'solution',
    exampleId: null,
    timer: null,
    solveMs: 0,
    ready: false
  };

  /* --------------------------------------------------------------------- */
  /* 小工具                                                                */
  /* --------------------------------------------------------------------- */

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function util() {
    return LPC.util || {};
  }

  function toast(message, kind) {
    if (util().toast) {
      util().toast(message, kind);
    }
  }

  function isNumber(text) {
    try {
      LPC.Frac.coerce(text);
      return true;
    } catch (error) {
      return false;
    }
  }

  function markValid(input, valid) {
    if (valid) {
      input.removeAttribute('aria-invalid');
    } else {
      input.setAttribute('aria-invalid', 'true');
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ spec: ns.spec, exampleId: ns.exampleId }));
    } catch (error) {
      /* 無痕模式等情況忽略 */
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }
      var data = JSON.parse(raw);
      var spec = NET.create(data.spec);
      if (!spec.nodes.length) {
        return null;
      }
      return { spec: spec, exampleId: data.exampleId || null };
    } catch (error) {
      return null;
    }
  }

  function typeInfo() {
    return NET.TYPES[ns.spec.type];
  }

  function unitSuffix() {
    return ns.spec.unit ? ' ' + esc(ns.spec.unit) : '';
  }

  /* --------------------------------------------------------------------- */
  /* 左側：輸入表單                                                        */
  /* --------------------------------------------------------------------- */

  function nodeOptions(selected, includeBlank) {
    var options = includeBlank ? '<option value="">—</option>' : '';
    return (
      options +
      ns.spec.nodes
        .map(function (node) {
          return '<option value="' + esc(node.name) + '"' + (node.name === selected ? ' selected' : '') + '>' + esc(node.name || '（未命名）') + '</option>';
        })
        .join('')
    );
  }

  function renderPanel() {
    var host = qs('#panel-network');
    if (!host) {
      return;
    }
    var spec = ns.spec;
    var info = typeInfo();
    var isTransship = spec.type === 'transship';

    var typeButtons = Object.keys(NET.TYPES)
      .map(function (key) {
        var item = NET.TYPES[key];
        return (
          '<button type="button" role="radio" aria-checked="' + (spec.type === key ? 'true' : 'false') + '" data-n-type="' + key + '">' +
          esc(item.name) + '</button>'
        );
      })
      .join('');

    var chips = NET.examples
      .map(function (example) {
        return (
          '<button type="button" class="chip' + (ns.exampleId === example.id ? ' is-on' : '') + '" data-n-example="' + example.id + '">' +
          esc(example.title) + '</button>'
        );
      })
      .join('');
    var example = NET.findExample(ns.exampleId);

    var nodeRows = spec.nodes
      .map(function (node, index) {
        var roleCell = isTransship
          ? '<td><select class="select net-role" data-n-role="' + index + '" aria-label="' + esc(node.name) + ' 的角色">' +
            ['supply', 'transship', 'demand']
              .map(function (role) {
                return '<option value="' + role + '"' + (node.role === role ? ' selected' : '') + '>' + NET.ROLE_NAMES[role] + '</option>';
              })
              .join('') +
            '</select></td>' +
            '<td><input class="input input-num" type="text" inputmode="decimal" data-n-amount="' + index + '" value="' + esc(node.amount) + '"' +
            (node.role === 'transship' ? ' disabled placeholder="—"' : ' placeholder="數量"') +
            ' aria-label="' + esc(node.name) + ' 的' + (node.role === 'supply' ? '供應量' : '需求量') + '" autocomplete="off"></td>'
          : '';
        return (
          '<tr>' +
          '<td class="net-node-index">' + (index + 1) + '</td>' +
          '<td><input class="input" type="text" data-n-node="' + index + '" value="' + esc(node.name) + '" aria-label="第 ' + (index + 1) + ' 個節點名稱" autocomplete="off"></td>' +
          roleCell +
          '<td><button type="button" class="btn btn-icon btn-danger-quiet" data-n-node-remove="' + index + '" aria-label="刪除節點 ' + esc(node.name) + '"' +
          (spec.nodes.length <= 2 ? ' disabled' : '') + '>✕</button></td>' +
          '</tr>'
        );
      })
      .join('');

    var arcRows = spec.arcs
      .map(function (arc, index) {
        return (
          '<tr>' +
          '<td><select class="select" data-n-arc-from="' + index + '" aria-label="第 ' + (index + 1) + ' 條弧線起點">' + nodeOptions(arc.from, true) + '</select></td>' +
          '<td class="net-arrow" aria-hidden="true">→</td>' +
          '<td><select class="select" data-n-arc-to="' + index + '" aria-label="第 ' + (index + 1) + ' 條弧線終點">' + nodeOptions(arc.to, true) + '</select></td>' +
          '<td><input class="input input-num" type="text" inputmode="decimal" data-n-arc-value="' + index + '" value="' + esc(arc.value) + '" aria-label="' +
          esc(info.valueLabel) + '" autocomplete="off"></td>' +
          '<td><input class="input input-num" type="text" inputmode="decimal" data-n-arc-reverse="' + index + '" value="' + esc(arc.reverse) +
          '" placeholder="—" aria-label="' + esc(info.reverseLabel) + '（選填）" autocomplete="off"></td>' +
          '<td><button type="button" class="btn btn-icon btn-danger-quiet" data-n-arc-remove="' + index + '" aria-label="刪除第 ' + (index + 1) + ' 條弧線">✕</button></td>' +
          '</tr>'
        );
      })
      .join('');

    var endpoints = isTransship
      ? ''
      : '<div class="field-row net-endpoints">' +
        '<label class="field"><span class="field-label">' + (spec.type === 'shortest' ? '起點' : 'Source（來源點）') + '</span>' +
        '<select class="select" data-n-source>' + nodeOptions(spec.source, false) + '</select></label>' +
        '<label class="field"><span class="field-label">' + (spec.type === 'shortest' ? '終點' : 'Sink（目的地）') + '</span>' +
        '<select class="select" data-n-sink>' + nodeOptions(spec.sink, false) + '</select></label>' +
        '</div>';

    host.innerHTML =
      '<section class="step">' +
      '<header class="step-head"><span class="step-index">01</span><h2 class="step-title">網路模型</h2>' +
      '<span class="step-hint">節點＋弧線 → 自動建立線性規劃</span></header>' +
      '<div class="field-group">' +
      '<div class="segmented net-type" role="radiogroup" aria-label="網路問題類型">' + typeButtons + '</div>' +
      '<p class="net-type-hint">' + esc(info.hint) + '</p>' +
      '<div class="field-row">' +
      '<label class="field"><span class="field-label">問題名稱</span><input type="text" class="input" data-n-title value="' + esc(spec.title) + '" placeholder="例：Walsh 水果公司" autocomplete="off"></label>' +
      '<label class="field net-unit-field"><span class="field-label">單位</span><input type="text" class="input" data-n-unit value="' + esc(spec.unit) + '" placeholder="例：千噸" autocomplete="off"></label>' +
      '</div>' +
      '<div class="sample-row"><span class="field-label">講義例題</span>' + chips + '</div>' +
      (example
        ? '<div class="callout"><div class="callout-title">' + esc(example.title) + '</div>' + esc(example.description) +
          '<br><span class="goal-example-note">' + esc(example.answer) + '</span></div>'
        : '') +
      '</div></section>' +
      '<section class="step">' +
      '<header class="step-head"><span class="step-index">02</span><h2 class="step-title">節點</h2>' +
      '<span class="step-hint">' + (isTransship ? '指定每個節點是供應點、轉運點或需求點' : '最多 ' + NET.MAX_NODES + ' 個') + '</span></header>' +
      '<div class="field-group">' +
      '<div class="table-scroll"><table class="var-table net-node-table"><thead><tr><th scope="col">#</th><th scope="col">名稱</th>' +
      (isTransship ? '<th scope="col">角色</th><th scope="col">供應／需求量</th>' : '') +
      '<th scope="col"><span class="visually-hidden">刪除</span></th></tr></thead><tbody>' + nodeRows + '</tbody></table></div>' +
      '<div class="step-actions"><button type="button" class="btn btn-outline" data-n-node-add' + (spec.nodes.length >= NET.MAX_NODES ? ' disabled' : '') + '>＋ 新增節點</button></div>' +
      endpoints +
      '</div></section>' +
      '<section class="step">' +
      '<header class="step-head"><span class="step-index">03</span><h2 class="step-title">弧線</h2>' +
      '<span class="step-hint">「反向」選填：同一條路線反方向也能走時才填</span></header>' +
      '<div class="field-group">' +
      '<div class="table-scroll"><table class="var-table net-arc-table"><thead><tr>' +
      '<th scope="col">從</th><th scope="col"><span class="visually-hidden">方向</span></th><th scope="col">到</th>' +
      '<th scope="col">' + esc(info.valueLabel) + '</th><th scope="col">' + esc(info.reverseLabel) + '</th>' +
      '<th scope="col"><span class="visually-hidden">刪除</span></th></tr></thead><tbody>' + arcRows + '</tbody></table></div>' +
      '<div class="step-actions"><button type="button" class="btn btn-outline" data-n-arc-add>＋ 新增弧線</button></div>' +
      '</div></section>' +
      '<section class="step step-last">' +
      '<header class="step-head"><span class="step-index">04</span><h2 class="step-title">自動建立的線性規劃</h2>' +
      '<span class="step-hint">可套用到「自訂模型」看敏感度分析</span></header>' +
      '<div class="model-sheet"><div id="net-model-preview" aria-live="polite"></div>' +
      '<div class="model-sheet-actions">' +
      '<button type="button" class="btn btn-primary btn-small" data-n-apply>套用到自訂模型</button>' +
      '<button type="button" class="btn btn-quiet btn-small" data-n-copy>複製模型文字</button>' +
      '<button type="button" class="btn btn-quiet btn-small" data-n-reset>清空重填</button>' +
      '</div></div></section>';

    renderModelPreview();
  }

  function currentModel() {
    var built = NET.buildModel(ns.spec);
    return built.ok ? built.model : null;
  }

  function renderModelPreview() {
    var host = qs('#net-model-preview');
    if (!host) {
      return;
    }
    var built = NET.buildModel(ns.spec);
    if (!built.ok) {
      host.innerHTML = '<p class="muted">輸入完整後會在這裡顯示模型。</p>';
      return;
    }
    var size = built.model.varNames.length + ' 個變數、' + built.model.constraints.length + ' 條限制式';
    host.innerHTML =
      '<div class="mathblock">' + modelLib.modelHTML(built.model) + '</div>' +
      '<p class="net-model-size">' + size + (built.notes.length ? '。' + esc(built.notes[0]) : '') + '</p>';
  }

  /* --------------------------------------------------------------------- */
  /* 網路圖（SVG）                                                         */
  /* --------------------------------------------------------------------- */

  function layoutColumns(compiled) {
    var count = compiled.nodes.length;
    var level = [];
    var index;
    if (compiled.type === 'transship') {
      for (index = 0; index < count; index += 1) {
        var role = compiled.nodes[index].role;
        level.push(role === 'supply' ? 0 : role === 'transship' ? 1 : 2);
      }
    } else {
      for (index = 0; index < count; index += 1) {
        level.push(-1);
      }
      var start = compiled.source === null || compiled.source === undefined ? 0 : compiled.source;
      level[start] = 0;
      var queue = [start];
      while (queue.length) {
        var current = queue.shift();
        compiled.arcs.forEach(function (arc) {
          [[arc.i, arc.j], [arc.j, arc.i]].forEach(function (pair) {
            if (pair[0] === current && level[pair[1]] < 0) {
              level[pair[1]] = level[current] + 1;
              queue.push(pair[1]);
            }
          });
        });
      }
      var maxLevel = 0;
      level.forEach(function (value) {
        maxLevel = Math.max(maxLevel, value);
      });
      for (index = 0; index < count; index += 1) {
        if (level[index] < 0) {
          level[index] = maxLevel + 1;
        }
      }
      var sink = compiled.sink;
      if (sink !== null && sink !== undefined) {
        var others = 0;
        level.forEach(function (value, position) {
          if (position !== sink) {
            others = Math.max(others, value);
          }
        });
        level[sink] = Math.max(level[sink], others + 1);
        if (level[sink] > others + 1) {
          level[sink] = others + 1;
        }
      }
    }
    /* 壓縮空欄 */
    var used = [];
    level.forEach(function (value) {
      if (used.indexOf(value) < 0) {
        used.push(value);
      }
    });
    used.sort(function (left, right) {
      return left - right;
    });
    return level.map(function (value) {
      return used.indexOf(value);
    });
  }

  function renderDiagram(compiled, result) {
    var columns = layoutColumns(compiled);
    var columnCount = 0;
    var perColumn = {};
    columns.forEach(function (column, index) {
      columnCount = Math.max(columnCount, column + 1);
      (perColumn[column] = perColumn[column] || []).push(index);
    });
    var tallest = 0;
    Object.keys(perColumn).forEach(function (key) {
      tallest = Math.max(tallest, perColumn[key].length);
    });
    var longNames = compiled.nodes.some(function (node) {
      return node.name.length > 3;
    });
    var width = 720;
    var rowGap = longNames ? 96 : 84;
    var height = Math.max(200, tallest * rowGap + 40);
    var marginX = longNames ? 70 : 44;
    var radius = 17;
    var columnX = function (column) {
      return columnCount === 1 ? width / 2 : marginX + (column * (width - marginX * 2)) / (columnCount - 1);
    };

    /* 欄內順序：依「前一欄鄰居的平均高度」排序（重心法），減少交叉 */
    var slotY = {};
    for (var column = 0; column < columnCount; column += 1) {
      var members = perColumn[column] || [];
      if (column > 0) {
        var weights = {};
        members.forEach(function (index) {
          var ys = [];
          compiled.arcs.forEach(function (arc) {
            var other = arc.i === index ? arc.j : arc.j === index ? arc.i : null;
            if (other !== null && columns[other] < column && slotY[other] !== undefined) {
              ys.push(slotY[other]);
            }
          });
          weights[index] = ys.length
            ? ys.reduce(function (total, value) {
                return total + value;
              }, 0) / ys.length
            : 0.5;
        });
        members.sort(function (left, right) {
          return weights[left] - weights[right] || left - right;
        });
        perColumn[column] = members;
      }
      members.forEach(function (index, slot) {
        slotY[index] = (slot + 1) / (members.length + 1);
      });
    }

    var position = compiled.nodes.map(function (node, index) {
      var column = columns[index];
      var members = perColumn[column];
      var slot = members.indexOf(index);
      /* 同一欄 3 個以上節點時左右交錯，避免上下兩點的弧線穿過中間節點 */
      var stagger = members.length >= 3 && compiled.type !== 'transship' ? (slot % 2 ? 22 : -22) : 0;
      return { x: columnX(column) + stagger, y: height * slotY[index] };
    });

    var flowByKey = {};
    if (result && result.arcs) {
      result.arcs.forEach(function (arc) {
        flowByKey[arc.i + '-' + arc.j] = arc;
      });
    }
    var onPath = {};
    if (result && result.path) {
      result.path.legs.forEach(function (leg) {
        onPath[leg.from + '\u0000' + leg.to] = true;
      });
    }
    var cutKeys = {};
    if (result && result.cut) {
      result.cut.arcs.forEach(function (arc) {
        cutKeys[arc.from + '\u0000' + arc.to] = true;
      });
    }

    function towards(from, to, distance) {
      var dx = to.x - from.x;
      var dy = to.y - from.y;
      var length = Math.sqrt(dx * dx + dy * dy) || 1;
      return { x: from.x + (dx / length) * distance, y: from.y + (dy / length) * distance };
    }

    var edges = compiled.arcs
      .map(function (arc) {
        var a = position[arc.i];
        var b = position[arc.j];
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        var length = Math.sqrt(dx * dx + dy * dy) || 1;
        var nx = -dy / length;
        var ny = dx / length;
        var paired = compiled.arcs.some(function (other) {
          return other.i === arc.j && other.j === arc.i;
        });
        var sameColumn = columns[arc.i] === columns[arc.j];
        /* 雙向弧線往兩側彎開；同欄弧線也稍微彎曲，避免與其他弧線重疊 */
        var bend = paired ? 18 : sameColumn ? 26 : 0;
        if (!bend) {
          /* 直線若穿過其他節點，就往遠離該節點的方向彎過去 */
          compiled.nodes.forEach(function (other, otherIndex) {
            if (bend || otherIndex === arc.i || otherIndex === arc.j) {
              return;
            }
            var p = position[otherIndex];
            var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (length * length);
            if (t <= 0.05 || t >= 0.95) {
              return;
            }
            var side = (p.x - a.x) * nx + (p.y - a.y) * ny;
            if (Math.abs(side) < radius + 8) {
              bend = (side > 0 ? -1 : 1) * (radius * 2 + 14);
            }
          });
        }
        var control = { x: (a.x + b.x) / 2 + nx * bend, y: (a.y + b.y) / 2 + ny * bend };
        var start = towards(a, control, radius + 2);
        var end = towards(b, control, radius + 6);
        var info = flowByKey[arc.i + '-' + arc.j];
        var used = info && info.used;
        var highlight = compiled.type === 'shortest' ? onPath[arc.from + '\u0000' + arc.to] : used;
        var isCut = cutKeys[arc.from + '\u0000' + arc.to];
        var label;
        if (compiled.type === 'maxflow') {
          label = info ? fmt(info.flow) + '/' + fmt(arc.value) : fmt(arc.value);
        } else if (compiled.type === 'transship' && used) {
          label = fmt(info.flow) + ' @' + fmt(arc.value);
        } else {
          label = fmt(arc.value);
        }
        var mid = {
          x: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x,
          y: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y
        };
        var labelShift = bend ? (bend > 0 ? 9 : -9) : 0;
        var lx = mid.x + nx * labelShift;
        var ly = mid.y + ny * labelShift;
        var d = bend
          ? 'M' + start.x.toFixed(1) + ',' + start.y.toFixed(1) + ' Q' + control.x.toFixed(1) + ',' + control.y.toFixed(1) + ' ' + end.x.toFixed(1) + ',' + end.y.toFixed(1)
          : 'M' + start.x.toFixed(1) + ',' + start.y.toFixed(1) + ' L' + end.x.toFixed(1) + ',' + end.y.toFixed(1);
        var classes = 'net-edge' + (highlight ? ' is-on' : '') + (isCut ? ' is-cut' : '');
        return (
          '<g class="' + classes + '"><title>' + esc(arc.from + ' → ' + arc.to + '：' + label) + '</title>' +
          '<path d="' + d + '" marker-end="url(#net-arrow' + (highlight ? '-on' : '') + ')"></path>' +
          '<text class="net-edge-label" x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="middle" dominant-baseline="middle">' + esc(label) + '</text></g>'
        );
      })
      /* 有流量的弧線畫在上層 */
      .sort(function (left, right) {
        return (left.indexOf('is-on') >= 0) - (right.indexOf('is-on') >= 0);
      })
      .join('');

    var nodes = compiled.nodes
      .map(function (node, index) {
        var p = position[index];
        var inside = node.name.length <= 3 ? node.name : String(index + 1);
        var classes = 'net-node net-role-' + node.role;
        if (index === compiled.source) {
          classes += ' is-source';
        }
        if (index === compiled.sink) {
          classes += ' is-sink';
        }
        var caption = node.name.length > 3 ? node.name : '';
        if (compiled.type === 'transship' && node.amount) {
          caption += (caption ? ' ' : '') + (node.role === 'supply' ? '供 ' : '需 ') + fmt(node.amount);
        }
        return (
          '<g class="' + classes + '"><title>' + esc(node.name) + '</title>' +
          '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + radius + '"></circle>' +
          '<text class="net-node-label" x="' + p.x.toFixed(1) + '" y="' + p.y.toFixed(1) + '" text-anchor="middle" dominant-baseline="central">' + esc(inside) + '</text>' +
          (caption ? '<text class="net-node-caption" x="' + p.x.toFixed(1) + '" y="' + (p.y + radius + 13).toFixed(1) + '" text-anchor="middle">' + esc(caption) + '</text>' : '') +
          '</g>'
        );
      })
      .join('');

    var legend =
      compiled.type === 'transship'
        ? '<span><i class="net-key net-role-supply"></i>供應點</span><span><i class="net-key net-role-transship"></i>轉運點</span><span><i class="net-key net-role-demand"></i>需求點</span><span><i class="net-key-line is-on"></i>有運送（流量 @ 單位成本）</span>'
        : compiled.type === 'shortest'
        ? '<span><i class="net-key-line is-on"></i>最短路徑</span><span><i class="net-key-line"></i>未選用（數字為距離）</span>'
        : '<span><i class="net-key-line is-on"></i>有流量（流量/容量）</span><span><i class="net-key-line is-cut"></i>瓶頸（最小切割）</span>';

    return (
      '<figure class="net-figure">' +
      '<svg class="net-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="網路圖">' +
      '<defs>' +
      '<marker id="net-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="net-arrow-head"></path></marker>' +
      '<marker id="net-arrow-on" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="net-arrow-head is-on"></path></marker>' +
      '</defs>' +
      edges + nodes +
      '</svg>' +
      '<figcaption class="net-legend">' + legend + '</figcaption>' +
      '</figure>'
    );
  }

  /* --------------------------------------------------------------------- */
  /* 右側：結果                                                            */
  /* --------------------------------------------------------------------- */

  function renderHead() {
    var result = ns.result;
    var label = qs('#net-verdict-label');
    var value = qs('#net-verdict-value');
    var sub = qs('#net-verdict-sub');
    var status = qs('#net-solve-status');
    if (!label) {
      return;
    }
    var info = typeInfo();
    var title = ns.spec.title ? esc(ns.spec.title) + '　·　' : '';
    if (!result || result.status === 'invalid' || result.status === 'error') {
      label.innerHTML = title + esc(info.name);
      value.textContent = '尚未完成';
      sub.textContent = result && result.errors ? '請修正 ' + result.errors.length + ' 個輸入問題' : '';
      status.innerHTML = '<span class="status-dot is-warn"></span>模型尚未完成';
      return;
    }
    if (result.status !== 'optimal') {
      label.innerHTML = title + esc(info.name);
      value.textContent = result.status === 'infeasible' ? '無可行解' : '無界';
      sub.textContent = '';
      status.innerHTML = '<span class="status-dot is-error"></span>' + (result.status === 'infeasible' ? '無可行解' : '目標函數無界');
      return;
    }
    var unit = ns.spec.unit ? '<span class="verdict-unit">' + esc(ns.spec.unit) + '</span>' : '';
    if (result.type === 'shortest') {
      label.innerHTML = title + '最短距離';
      value.innerHTML = fmtGrouped(result.z) + unit;
      sub.innerHTML = '路徑：' + result.path.nodes.map(esc).join(' → ');
    } else if (result.type === 'maxflow') {
      label.innerHTML = title + '最大流量 F*';
      value.innerHTML = fmtGrouped(result.maxFlow) + unit;
      sub.innerHTML = '瓶頸弧線：' + result.cut.arcs.map(function (arc) {
        return esc(arc.from) + '→' + esc(arc.to);
      }).join('、');
    } else {
      label.innerHTML = title + '最低總運輸成本 Z*';
      value.innerHTML = fmtGrouped(result.z);
      var shortage = result.unmet.filter(function (item) {
        return item.shortage.isPos();
      });
      sub.innerHTML = shortage.length
        ? '尚未滿足：' + shortage.map(function (item) {
            return esc(item.name) + ' 缺 ' + fmt(item.shortage);
          }).join('、')
        : '所有需求皆已滿足';
    }
    status.innerHTML = '<span class="status-dot"></span>已求得最佳解 · ' + Math.max(0, Math.round(ns.solveMs)) + ' ms';
  }

  function warningsHTML(result) {
    var list = (result.warnings || []).concat(result.notes && result.type !== 'transship' ? result.notes : []);
    if (!list.length) {
      return '';
    }
    return (
      '<div class="callout is-warn"><div class="callout-title">提醒</div><ul class="goal-error-list">' +
      list.map(function (text) {
        return '<li>' + esc(text) + '</li>';
      }).join('') +
      '</ul></div>'
    );
  }

  function balanceTable(result) {
    var rows = result.nodes
      .map(function (node, index) {
        var compiledIndex = index;
        var requirement;
        var ok;
        var net = node.outflow.sub(node.inflow);
        if (result.type === 'transship') {
          if (node.role === 'transship') {
            requirement = '流入 = 流出';
            ok = net.isZero();
          } else if (node.role === 'supply') {
            requirement = (result.caseInfo === 'surplus' ? '運出 ≤ ' : '運出 = ') + fmt(node.amount);
            ok = true;
          } else {
            requirement = (result.caseInfo === 'short' ? '收到 ≤ ' : '收到 = ') + fmt(node.amount);
            ok = true;
          }
        } else if (result.type === 'shortest') {
          var c = result.built.compiled;
          requirement = compiledIndex === c.source ? '流出 − 流入 = 1' : compiledIndex === c.sink ? '流入 − 流出 = 1' : '流入 = 流出';
          ok = true;
        } else {
          var cc = result.built.compiled;
          requirement = compiledIndex === cc.source ? '流出 − 流入 = F' : compiledIndex === cc.sink ? '流入 − 流出 = F' : '流入 = 流出（守恆）';
          ok = true;
        }
        return (
          '<tr><td class="strong">' + esc(node.name) + '</td>' +
          (result.type === 'transship' ? '<td>' + NET.ROLE_NAMES[node.role] + '</td>' : '') +
          '<td class="num">' + fmt(node.inflow) + '</td><td class="num">' + fmt(node.outflow) + '</td>' +
          '<td>' + requirement + '</td><td>' + (ok ? '<span class="goal-chip is-met">✓</span>' : '<span class="goal-chip is-miss">✗</span>') + '</td></tr>'
        );
      })
      .join('');
    return (
      '<div class="section-divider">流量平衡檢查</div>' +
      '<div class="table-scroll"><table class="data-table"><thead><tr><th>節點</th>' +
      (result.type === 'transship' ? '<th>角色</th>' : '') +
      '<th class="num">流入</th><th class="num">流出</th><th>條件</th><th>檢查</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    );
  }

  function arcTable(result) {
    var showAll = result.type === 'maxflow';
    var rows = result.arcs
      .filter(function (arc) {
        return showAll || arc.used;
      })
      .map(function (arc) {
        var extra;
        if (result.type === 'maxflow') {
          extra = '<td class="num">' + fmt(arc.value) + '</td><td>' + (arc.saturated ? '<span class="goal-chip is-miss">滿載</span>' : arc.used ? '剩 ' + fmt(arc.value.sub(arc.flow)) : '<span class="muted">未使用</span>') + '</td>';
        } else if (result.type === 'transship') {
          extra = '<td class="num">' + fmt(arc.value) + '</td><td class="num">' + fmtGrouped(arc.cost) + '</td>';
        } else {
          extra = '<td class="num">' + fmt(arc.value) + '</td>';
        }
        return (
          '<tr' + (arc.used ? ' class="row-binding"' : '') + '><td>' + NET.varHTML(arc.name) + '</td><td class="strong">' + esc(arc.from) + ' → ' + esc(arc.to) + '</td>' +
          '<td class="num">' + fmt(arc.flow) + '</td>' + extra + '</tr>'
        );
      })
      .join('');
    var heads =
      result.type === 'maxflow'
        ? '<th class="num">流量</th><th class="num">容量</th><th>狀態</th>'
        : result.type === 'transship'
        ? '<th class="num">運量</th><th class="num">單位成本</th><th class="num">成本</th>'
        : '<th class="num">選用</th><th class="num">距離</th>';
    return (
      '<div class="section-divider">' + (result.type === 'maxflow' ? '各弧線流量' : result.type === 'transship' ? '最佳運送方案（只列有運送的路線）' : '選用的弧線') + '</div>' +
      '<div class="table-scroll"><table class="data-table"><thead><tr><th>變數</th><th>弧線</th>' + heads + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    );
  }

  function summaryCells(cells) {
    return (
      '<div class="summary-grid">' +
      cells
        .map(function (cell) {
          return (
            '<div class="summary-cell"><div class="summary-label">' + esc(cell.label) + '</div>' +
            '<div class="summary-value' + (cell.serif ? ' is-serif' : '') + '">' + cell.value + '</div>' +
            (cell.note ? '<div class="summary-note">' + esc(cell.note) + '</div>' : '') + '</div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function renderSolutionView(result) {
    var compiled = result.built.compiled;
    var parts = [];
    if (result.type === 'shortest') {
      var legs = result.path.legs.map(function (leg) {
        return fmt(leg.value);
      });
      parts.push(
        summaryCells([
          { label: '最短距離 Z*', value: fmtGrouped(result.z) + unitSuffix(), serif: true },
          { label: '經過節點', value: String(result.path.nodes.length) + ' 個', note: (result.path.legs.length) + ' 段弧線' },
          { label: '計算', value: legs.join(' + ') + ' = ' + fmt(result.z) }
        ]),
        '<div class="net-path" aria-label="最短路徑">' +
          result.path.nodes.map(function (name) {
            return '<span class="net-path-node">' + esc(name) + '</span>';
          }).join('<span class="net-path-arrow">→</span>') +
          '</div>'
      );
    } else if (result.type === 'maxflow') {
      parts.push(
        summaryCells([
          { label: '最大流量 F*', value: fmtGrouped(result.maxFlow) + unitSuffix(), serif: true },
          { label: '瓶頸（最小切割）容量', value: fmtGrouped(result.cut.capacity), note: '最大流量 = 最小切割容量' },
          { label: 'Source 輸出能力上限', value: fmtGrouped(sourceCapacity(result)), note: '流出弧容量合計' }
        ]),
        '<div class="callout"><div class="callout-title">管理意涵：瓶頸在哪裡？</div>' +
          '把網路切成「Source 這側」｛' + result.cut.sourceSide.map(esc).join('、') + '｝與其餘節點，跨越兩側的弧線 ' +
          result.cut.arcs.map(function (arc) {
            return '<b>' + esc(arc.from) + '→' + esc(arc.to) + '</b>（' + fmt(arc.value) + '）';
          }).join('、') +
          ' 全部滿載，容量合計正好等於最大流量。要提高運量，必須先擴充這些路線。</div>'
      );
    } else {
      var stageRows = result.stageCosts
        .map(function (stage) {
          return '<tr><td class="strong">' + esc(stage.label) + '</td><td>' + esc(stage.terms.join(' + ') || '—') + '</td><td class="num">' + fmtGrouped(stage.cost) + '</td></tr>';
        })
        .join('');
      var unmetRows = result.unmet
        .map(function (item) {
          return (
            '<tr' + (item.shortage.isPos() ? ' class="goal-row-miss"' : '') + '><td class="strong">' + esc(item.name) + '</td><td class="num">' + fmt(item.demand) +
            '</td><td class="num">' + fmt(item.received) + '</td><td>' + (item.shortage.isPos() ? '<span class="goal-chip is-miss">缺 ' + fmt(item.shortage) + '</span>' : '<span class="goal-chip is-met">滿足</span>') + '</td></tr>'
          );
        })
        .join('');
      parts.push(
        summaryCells([
          { label: '最低總運輸成本 Z*', value: fmtGrouped(result.z), serif: true },
          { label: '總供應量', value: fmtGrouped(result.totals.supply) + unitSuffix() },
          { label: '總需求量', value: fmtGrouped(result.totals.demand) + unitSuffix(), note: result.caseInfo === 'short' ? '供不應求' : result.caseInfo === 'surplus' ? '供過於求' : '供需平衡' }
        ]),
        '<div class="section-divider">成本拆解</div>' +
          '<div class="table-scroll"><table class="data-table"><thead><tr><th>階段</th><th>運量 × 單位成本</th><th class="num">成本</th></tr></thead><tbody>' + stageRows +
          '<tr><td class="strong">合計</td><td></td><td class="num strong">' + fmtGrouped(result.z) + '</td></tr></tbody></table></div>' +
          '<div class="section-divider">需求滿足情況</div>' +
          '<div class="table-scroll"><table class="data-table"><thead><tr><th>需求點</th><th class="num">需求量</th><th class="num">收到</th><th>狀態</th></tr></thead><tbody>' + unmetRows + '</tbody></table></div>'
      );
    }
    return (
      '<div class="view">' +
      '<div class="view-head"><h3 class="view-title">' + esc(typeInfo().name) + '結果</h3>' +
      '<span class="view-desc">' + esc(NET.TYPES[result.type].en) + ' Model · 以精確分數的單純形法求解</span></div>' +
      warningsHTML(result) +
      renderDiagram(compiled, result) +
      parts.join('') +
      arcTable(result) +
      balanceTable(result) +
      '</div>'
    );
  }

  function sourceCapacity(result) {
    var c = result.built.compiled;
    return c.arcs
      .filter(function (arc) {
        return arc.i === c.source;
      })
      .reduce(function (total, arc) {
        return total.add(arc.value);
      }, LPC.Frac.zero());
  }

  function renderStepsView(result) {
    var items = result.steps
      .map(function (step, index) {
        return (
          '<li class="goal-step"><div class="goal-step-index">步驟' + '一二三四五六七八'.charAt(index) + '</div><div class="goal-step-main">' +
          '<div class="goal-step-title">' + esc(step.title) + '</div>' +
          step.lines.map(function (line) {
            return '<div class="net-step-line">' + line + '</div>';
          }).join('') +
          '</div></li>'
        );
      })
      .join('');
    return (
      '<div class="view"><div class="view-head"><h3 class="view-title">建模步驟</h3>' +
      '<span class="view-desc">依講義順序：決策變數 → 目標函數 → 流量平衡 → ' + (result.type === 'maxflow' ? '容量' : result.type === 'shortest' ? '0-1' : '非負') + '限制</span></div>' +
      '<ol class="goal-steps">' + items + '</ol></div>'
    );
  }

  function renderModelView(result) {
    return (
      '<div class="view"><div class="view-head"><h3 class="view-title">完整線性規劃模型</h3>' +
      '<span class="view-desc">' + result.model.varNames.length + ' 個變數、' + result.model.constraints.length + ' 條限制式</span></div>' +
      '<div class="model-sheet"><div class="mathblock goal-model-big">' + modelLib.modelHTML(result.model) + '</div>' +
      '<div class="model-sheet-actions"><button type="button" class="btn btn-primary btn-small" data-n-apply>套用到自訂模型（看敏感度分析）</button>' +
      '<button type="button" class="btn btn-quiet btn-small" data-n-copy>複製模型文字</button></div></div></div>'
    );
  }

  function renderProblem(result) {
    var lines = (result.errors || [result.message || ''])
      .map(function (text) {
        return '<li>' + esc(text) + '</li>';
      })
      .join('');
    return '<div class="view"><div class="callout is-error"><div class="callout-title">請修正下列輸入</div><ul class="goal-error-list">' + lines + '</ul></div></div>';
  }

  function renderBody() {
    var body = qs('#net-result-body');
    var result = ns.result;
    if (!body) {
      return;
    }
    if (!result) {
      body.innerHTML = '';
      return;
    }
    if (result.status === 'invalid' || result.status === 'error') {
      body.innerHTML = renderProblem(result);
      return;
    }
    if (result.status !== 'optimal') {
      body.innerHTML =
        '<div class="view"><div class="callout is-error"><div class="callout-title">' + (result.status === 'infeasible' ? '無可行解' : '目標函數無界') + '</div>' +
        esc(result.message || '') + '</div>' + renderDiagram(result.built.compiled, null) + '</div>';
      return;
    }
    if (ns.view === 'steps') {
      body.innerHTML = renderStepsView(result);
    } else if (ns.view === 'model') {
      body.innerHTML = renderModelView(result);
    } else {
      body.innerHTML = renderSolutionView(result);
    }
  }

  function renderTabs() {
    qsa('#net-tabs [data-nview]').forEach(function (button) {
      var active = button.getAttribute('data-nview') === ns.view;
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.classList.toggle('is-active', active);
    });
  }

  function renderResult() {
    renderHead();
    renderTabs();
    renderBody();
  }

  /* --------------------------------------------------------------------- */
  /* 求解與編輯                                                            */
  /* --------------------------------------------------------------------- */

  function solveNow(manual) {
    var started = global.performance ? global.performance.now() : Date.now();
    try {
      ns.result = NET.solve(ns.spec);
    } catch (error) {
      ns.result = { ok: false, status: 'error', errors: ['求解時發生錯誤：' + error.message] };
    }
    ns.solveMs = (global.performance ? global.performance.now() : Date.now()) - started;
    renderResult();
    if (manual) {
      toast('已重新求解');
    }
  }

  function scheduleSolve() {
    clearTimeout(ns.timer);
    ns.timer = setTimeout(function () {
      solveNow(false);
    }, SOLVE_DELAY);
  }

  function onEdit() {
    ns.exampleId = ns.exampleId && NET.findExample(ns.exampleId) ? ns.exampleId : null;
    renderModelPreview();
    save();
    scheduleSolve();
  }

  function onStructureChange() {
    renderPanel();
    save();
    solveNow(false);
  }

  function loadSpec(spec, exampleId) {
    ns.spec = NET.create(spec);
    ns.exampleId = exampleId || null;
    ns.view = 'solution';
    if (ns.ready) {
      onStructureChange();
    }
  }

  function loadExample(id) {
    var example = NET.findExample(id);
    if (!example) {
      return;
    }
    loadSpec(example.build(), id);
    toast('已載入：' + example.title);
  }

  function uniqueNodeName() {
    var names = ns.spec.nodes.map(function (node) {
      return node.name;
    });
    for (var index = ns.spec.nodes.length + 1; index < 200; index += 1) {
      var candidate = String(index);
      if (names.indexOf(candidate) < 0) {
        return candidate;
      }
    }
    return 'N' + Date.now();
  }

  function renameNode(index, name) {
    var old = ns.spec.nodes[index].name;
    ns.spec.nodes[index].name = name;
    ns.spec.arcs.forEach(function (arc) {
      if (arc.from === old) {
        arc.from = name;
      }
      if (arc.to === old) {
        arc.to = name;
      }
    });
    if (ns.spec.source === old) {
      ns.spec.source = name;
    }
    if (ns.spec.sink === old) {
      ns.spec.sink = name;
    }
  }

  function refreshNodeSelects() {
    qsa('#panel-network select[data-n-arc-from], #panel-network select[data-n-arc-to]').forEach(function (select) {
      var index = Number(select.getAttribute('data-n-arc-from') || select.getAttribute('data-n-arc-to'));
      var arc = ns.spec.arcs[index];
      var value = select.hasAttribute('data-n-arc-from') ? arc.from : arc.to;
      select.innerHTML = nodeOptions(value, true);
    });
    ['source', 'sink'].forEach(function (key) {
      var select = qs('#panel-network select[data-n-' + key + ']');
      if (select) {
        select.innerHTML = nodeOptions(ns.spec[key], false);
      }
    });
  }

  function copyModel() {
    var built = NET.buildModel(ns.spec);
    if (!built.ok) {
      toast('模型尚未完成', 'error');
      return;
    }
    if (util().copyText) {
      util().copyText(modelLib.modelText(built.model)).then(function () {
        toast('模型文字已複製');
      });
    }
  }

  function applyToModel() {
    var model = currentModel();
    if (!model) {
      toast('請先修正輸入', 'error');
      return;
    }
    if (LPC.app && LPC.app.loadModel) {
      LPC.app.loadModel(model, '網路模型：' + (ns.spec.title || typeInfo().name));
    }
  }

  function bind() {
    var host = qs('#panel-network');
    host.addEventListener('input', function (event) {
      var target = event.target;
      var index;
      if (target.matches('[data-n-title]')) {
        ns.spec.title = target.value;
        save();
        renderHead();
        return;
      }
      if (target.matches('[data-n-unit]')) {
        ns.spec.unit = target.value;
        onEdit();
        return;
      }
      if (target.matches('[data-n-node]')) {
        index = Number(target.getAttribute('data-n-node'));
        var name = target.value.trim();
        var duplicate = ns.spec.nodes.some(function (node, position) {
          return position !== index && node.name === name;
        });
        markValid(target, name !== '' && !duplicate);
        renameNode(index, name);
        refreshNodeSelects();
        onEdit();
        return;
      }
      if (target.matches('[data-n-amount]')) {
        ns.spec.nodes[Number(target.getAttribute('data-n-amount'))].amount = target.value;
        markValid(target, isNumber(target.value));
        onEdit();
        return;
      }
      if (target.matches('[data-n-arc-value]')) {
        ns.spec.arcs[Number(target.getAttribute('data-n-arc-value'))].value = target.value;
        markValid(target, target.value.trim() === '' || isNumber(target.value));
        onEdit();
        return;
      }
      if (target.matches('[data-n-arc-reverse]')) {
        ns.spec.arcs[Number(target.getAttribute('data-n-arc-reverse'))].reverse = target.value;
        markValid(target, target.value.trim() === '' || isNumber(target.value));
        onEdit();
      }
    });

    host.addEventListener('change', function (event) {
      var target = event.target;
      if (target.matches('[data-n-role]')) {
        var node = ns.spec.nodes[Number(target.getAttribute('data-n-role'))];
        node.role = target.value;
        if (node.role === 'transship') {
          node.amount = '';
        }
        onStructureChange();
        return;
      }
      if (target.matches('[data-n-arc-from]')) {
        ns.spec.arcs[Number(target.getAttribute('data-n-arc-from'))].from = target.value;
        onEdit();
        return;
      }
      if (target.matches('[data-n-arc-to]')) {
        ns.spec.arcs[Number(target.getAttribute('data-n-arc-to'))].to = target.value;
        onEdit();
        return;
      }
      if (target.matches('[data-n-source]')) {
        ns.spec.source = target.value;
        onEdit();
        return;
      }
      if (target.matches('[data-n-sink]')) {
        ns.spec.sink = target.value;
        onEdit();
      }
    });

    host.addEventListener('click', function (event) {
      var target = event.target;
      var button;
      if ((button = target.closest('[data-n-type]'))) {
        var type = button.getAttribute('data-n-type');
        if (type !== ns.spec.type) {
          var example = NET.examples.filter(function (item) {
            return item.type === type;
          })[0];
          loadSpec(example ? example.build() : NET.blank(type), example ? example.id : null);
        }
        return;
      }
      if ((button = target.closest('[data-n-example]'))) {
        loadExample(button.getAttribute('data-n-example'));
        return;
      }
      if (target.closest('[data-n-node-add]')) {
        ns.spec.nodes.push({ name: uniqueNodeName(), role: 'transship', amount: '' });
        onStructureChange();
        return;
      }
      if ((button = target.closest('[data-n-node-remove]'))) {
        var removed = ns.spec.nodes.splice(Number(button.getAttribute('data-n-node-remove')), 1)[0];
        ns.spec.arcs = ns.spec.arcs.filter(function (arc) {
          return arc.from !== removed.name && arc.to !== removed.name;
        });
        if (ns.spec.source === removed.name) {
          ns.spec.source = ns.spec.nodes[0].name;
        }
        if (ns.spec.sink === removed.name) {
          ns.spec.sink = ns.spec.nodes[ns.spec.nodes.length - 1].name;
        }
        onStructureChange();
        return;
      }
      if (target.closest('[data-n-arc-add]')) {
        var last = ns.spec.arcs[ns.spec.arcs.length - 1];
        ns.spec.arcs.push({ from: last ? last.from : '', to: '', value: '', reverse: '' });
        onStructureChange();
        var selects = qsa('#panel-network select[data-n-arc-to]');
        if (selects.length) {
          selects[selects.length - 1].focus();
        }
        return;
      }
      if ((button = target.closest('[data-n-arc-remove]'))) {
        ns.spec.arcs.splice(Number(button.getAttribute('data-n-arc-remove')), 1);
        onStructureChange();
        return;
      }
      if (target.closest('[data-n-reset]')) {
        loadSpec(NET.blank(ns.spec.type), null);
        return;
      }
      if (target.closest('[data-n-copy]')) {
        copyModel();
        return;
      }
      if (target.closest('[data-n-apply]')) {
        applyToModel();
      }
    });

    var resultHost = qs('#net-result');
    resultHost.addEventListener('click', function (event) {
      var target = event.target;
      var tab = target.closest('[data-nview]');
      if (tab) {
        ns.view = tab.getAttribute('data-nview');
        renderTabs();
        renderBody();
        return;
      }
      if (target.closest('#net-btn-solve')) {
        solveNow(true);
        return;
      }
      if (target.closest('[data-n-apply]')) {
        applyToModel();
        return;
      }
      if (target.closest('[data-n-copy]')) {
        copyModel();
      }
    });
  }

  function init() {
    if (!qs('#panel-network')) {
      return;
    }
    if (!ns.ready) {
      if (!ns.spec) {
        var stored = load();
        if (stored) {
          ns.spec = stored.spec;
          ns.exampleId = stored.exampleId;
        } else {
          ns.spec = NET.examples[0].build();
          ns.exampleId = NET.examples[0].id;
        }
      }
      bind();
      ns.ready = true;
    }
    renderPanel();
    solveNow(false);
  }

  LPC.networkUI = {
    state: ns,
    init: init,
    solve: solveNow,
    /** 由「文字建模」帶入網路規格 */
    load: function (spec) {
      ns.spec = NET.create(spec);
      ns.exampleId = null;
      ns.view = 'solution';
      save();
      if (ns.ready) {
        renderPanel();
        solveNow(false);
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
