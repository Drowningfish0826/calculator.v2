/* ============================================================================
 * views.js — 結果面板的各種檢視
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});
  var Frac = LPC.Frac;
  var modelLib = LPC.model;
  var fmt = modelLib.fmt;
  var fmtGrouped = modelLib.fmtGrouped;
  var escapeHTML = modelLib.escapeHTML;

  function h(text) {
    return escapeHTML(text);
  }

  function num(value, options) {
    return fmt(value, options);
  }

  function rangeText(low, high, unit) {
    var lowText = low === null || low === undefined ? '−∞' : fmtGrouped(low);
    var highText = high === null || high === undefined ? '+∞' : fmtGrouped(high);
    return lowText + ' ~ ' + highText + (unit ? ' ' + unit : '');
  }

  function statusTag(binding, op) {
    if (binding) {
      return '<span class="tag tag-binding">緊束（等號成立）</span>';
    }
    return '<span class="tag tag-slack">未緊束' + (op === '>=' ? '（有盈餘）' : '（有餘裕）') + '</span>';
  }

  /* --------------------------------------------------------------------- */
  /* 空狀態與錯誤                                                          */
  /* --------------------------------------------------------------------- */

  function renderPending(message, detail) {
    return (
      '<div class="empty-state">' +
      '<div class="empty-state-title">' + h(message) + '</div>' +
      '<div class="empty-state-text">' + detail + '</div>' +
      '</div>'
    );
  }

  function renderInvalid(errors) {
    var list = errors
      .map(function (issue) {
        return '<li>' + h(issue.message) + '</li>';
      })
      .join('');
    return (
      '<div class="view">' +
      '<div class="callout is-error">' +
      '<div class="callout-title">模型還有 ' + errors.length + ' 個地方需要修正</div>' +
      '<ul style="margin:8px 0 0;padding-left:20px">' + list + '</ul>' +
      '</div></div>'
    );
  }

  function renderInfeasible(model, result) {
    var hints = [];
    hints.push('檢查是否有互相衝突的限制式，例如同時要求 <b>x₁ ≤ 5</b> 與 <b>x₁ ≥ 8</b>。');
    hints.push('若問題本來就無解，可放寬部分「≥」型需求或提高資源上限後重新求解。');
    if (model.constraints.length > 6) {
      hints.push('限制式數量較多時，可先暫時停用幾條，找出造成衝突的那一條。');
    }
    return (
      '<div class="view">' +
      '<div class="callout is-error">' +
      '<div class="callout-title">無可行解（Infeasible）</div>' +
      '<p>這些限制式彼此衝突，找不到任何一組決策變數能同時滿足所有條件，因此沒有最佳解。</p>' +
      '</div>' +
      '<div class="section-divider">可以試試</div>' +
      '<ul style="padding-left:20px;font-size:13.5px;line-height:1.9">' +
      hints
        .map(function (hint) {
          return '<li>' + hint + '</li>';
        })
        .join('') +
      '</ul>' +
      '<div class="section-divider">系統做了什麼</div>' +
      '<p style="font-size:13px;color:var(--ink-2)">求解器先以第一階段（Phase I）引入人工變數尋找可行基；' +
      '若第一階段的最終目標值仍小於 0，代表人工變數無法完全退出，即證明此問題無可行解。</p>' +
      '</div>'
    );
  }

  function renderUnbounded(model, result) {
    return (
      '<div class="view">' +
      '<div class="callout is-warn">' +
      '<div class="callout-title">無界解（Unbounded）</div>' +
      '<p>目標函數可以無限改善，代表模型缺少真正的限制。常見原因：忘了設定資源上限、' +
      '限制式方向設反，或某個變數完全沒有被任何限制式約束。</p>' +
      '</div>' +
      '<div class="section-divider">檢查方向</div>' +
      '<ul style="padding-left:20px;font-size:13.5px;line-height:1.9">' +
      '<li>確認每條限制式的 <b>≤ / ≥</b> 是否正確。</li>' +
      '<li>確認右端值是否為正數，且與變數單位一致。</li>' +
      '<li>若是最大化問題，檢查是否漏掉產能、預算或需求上限。</li>' +
      '</ul></div>'
    );
  }

  /* --------------------------------------------------------------------- */
  /* 範本專屬的結果呈現                                                    */
  /* --------------------------------------------------------------------- */

  function renderTransportGrid(model, result) {
    var grid = model.meta.grid;
    var colCount = grid.colNames.length;
    var rowSum = grid.rowNames.map(function () {
      return 0;
    });
    var colSum = grid.colNames.map(function () {
      return 0;
    });
    var cells = [];
    grid.rowNames.forEach(function (rowName, rowIndex) {
      var line = [];
      grid.colNames.forEach(function (colName, colIndex) {
        var value = result.x[rowIndex * colCount + colIndex];
        var amount = value ? Number(value) : 0;
        rowSum[rowIndex] += amount;
        colSum[colIndex] += amount;
        line.push(
          '<td class="' +
            (amount > 0 ? 'has-flow' : 'is-zero') +
            '">' +
            (amount > 0 ? fmtGrouped(value) : '<span class="muted">·</span>') +
            '<span class="cell-sub">' + fmtGrouped(grid.cost[rowIndex][colIndex]) + '</span></td>'
        );
      });
      line.push('<td class="row-total">' + fmtGrouped(Frac.fromInt(Math.round(rowSum[rowIndex] * 1000) / 1000)) + '</td>');
      cells.push(
        '<tr><th class="row-head">' + h(rowName) + '</th>' + line.join('') + '</tr>'
      );
    });

    var totalDemand = grid.demand.reduce(function (sum, value) {
      return sum + Number(value);
    }, 0);

    return (
      '<div class="table-scroll"><table class="matrix-table result-matrix">' +
      '<thead><tr><th class="corner">供給＼需求</th>' +
      grid.colNames
        .map(function (name) {
          return '<th>' + h(name) + '</th>';
        })
        .join('') +
      '<th class="row-total">合計</th></tr></thead>' +
      '<tbody>' + cells.join('') +
      '<tr><th class="corner">需求量</th>' +
      colSum
        .map(function (sum, index) {
          return '<td class="col-total">' + fmtGrouped(Frac.fromInt(Math.round(sum * 1000) / 1000)) + '</td>';
        })
        .join('') +
      '<td class="col-total">' + fmtGrouped(Frac.fromInt(Math.round(totalDemand * 1000) / 1000)) + '</td></tr>' +
      '</tbody></table></div>' +
      '<p style="font-size:12px;color:var(--ink-3);margin-top:8px">' +
      '每格上方為最佳運輸量，下方小字為該路線的單位成本；「·」代表這條路線没有被使用。</p>'
    );
  }

  function renderAssignmentResult(model, result) {
    var grid = model.meta.grid;
    var size = grid.colNames.length;
    var pairs = [];
    for (var i = 0; i < grid.rowNames.length; i += 1) {
      for (var j = 0; j < size; j += 1) {
        var value = result.x[i * size + j];
        if (value && Number(value) > 0.5) {
          pairs.push({
            person: grid.rowNames[i],
            task: grid.colNames[j],
            cost: grid.cost[i] ? grid.cost[i][j] : 0,
            value: value
          });
        }
      }
    }
    return (
      '<div class="table-scroll"><table class="data-table">' +
      '<thead><tr><th>人員</th><th>指派工作</th><th class="num">成本</th></tr></thead><tbody>' +
      pairs
        .map(function (pair) {
          return (
            '<tr><td class="strong">' + h(pair.person) + '</td><td>' + h(pair.task) +
            '</td><td class="num">' + fmtGrouped(Frac.fromInt(Number(pair.cost))) + '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>' +
      '<p style="font-size:12px;color:var(--ink-3);margin-top:8px">' +
      '指派問題的 LP 鬆弛本身就是整數解（全單模性），因此不需分支即可得到 0-1 的最適分派。</p>'
    );
  }

  /* --------------------------------------------------------------------- */
  /* 最佳解                                                                */
  /* --------------------------------------------------------------------- */

  function renderSolution(model, result) {
    var info = modelLib.metaOf(model);
    var summary = [
      {
        label: info.objectiveLabel + '（Z*）',
        value: fmtGrouped(result.z),
        note: info.objectiveUnit || ''
      },
      {
        label: '決策變數',
        value: model.varNames.length + ' 個',
        note: result.varInfo.filter(function (variable) {
          return variable.value.isPos();
        }).length + ' 個為正值'
      },
      {
        label: '求解方法',
        value: result.integer ? '分支定界' : model.constraints.some(function (constraint) {
          return constraint.op !== '<=';
        })
          ? '兩階段單純形法'
          : '單純形法',
        note: result.integer
          ? 'LP 鬆弛 + 分支，共 ' + (result.nodes || 0) + ' 節點'
          : result.iterations && result.iterations.length
            ? '精確有理數，' + result.iterations.length + ' 張單純形表'
            : '精確有理數運算'
      }
    ];

    var variableRows = result.varInfo
      .map(function (variable) {
        var typeLabel = model.binary[variable.index]
          ? '0-1'
          : model.integer[variable.index]
            ? '整數'
            : '連續';
        var reducedCost = variable.reducedCost;
        var reducedText = reducedCost.isZero()
          ? '<span class="muted">0</span>'
          : (reducedCost.isNeg() ? '−' : '+') + fmt(reducedCost.abs());
        var statusTagHTML;
        if (variable.basic) {
          statusTagHTML = variable.value.isZero()
            ? '<span class="tag tag-slack">基變數（退化為 0）</span>'
            : '<span class="tag tag-binding">基變數</span>';
        } else {
          statusTagHTML = '<span class="tag tag-slack">非基變數</span>';
        }
        return (
          '<tr' + (variable.value.isPos() ? ' class="row-binding"' : '') + '>' +
          '<td class="strong">' + h(modelLib.variableLabel(model, variable.index)) + '</td>' +
          '<td class="num">' + fmtGrouped(variable.value) + '</td>' +
          '<td class="num muted">' + (info.variableUnit ? info.variableUnit : '—') + '</td>' +
          '<td>' + typeLabel + '</td>' +
          '<td>' + statusTagHTML + '</td>' +
          '<td class="num">' + reducedText + '</td>' +
          '</tr>'
        );
      })
      .join('');

    var notes = modelLib
      .interpret(model, result)
      .map(function (note) {
        return (
          '<div class="note">' +
          '<div class="note-title">' + h(note.title) + '</div>' +
          '<div class="note-text">' + h(note.text) + '</div>' +
          '</div>'
        );
      })
      .join('');

    var isTransport = model.meta && model.meta.kind === 'transport' && model.meta.grid;
    var isAssignment = model.meta && model.meta.kind === 'assignment' && model.meta.grid;

    var detailBlock;
    if (isTransport) {
      detailBlock =
        '<div class="section-divider">最佳運輸方案</div>' +
        renderTransportGrid(model, result);
    } else if (isAssignment) {
      detailBlock =
        '<div class="section-divider">最佳指派結果</div>' +
        renderAssignmentResult(model, result);
    } else {
      detailBlock =
        '<div class="section-divider">決策變數</div>' +
        '<div class="table-scroll"><table class="data-table">' +
        '<thead><tr>' +
        '<th>變數</th><th class="num">最佳值</th><th class="num">單位</th><th>類型</th><th>狀態</th><th class="num">減價成本</th>' +
        '</tr></thead><tbody>' + variableRows + '</tbody></table></div>';
    }

    return (
      '<div class="view">' +
      '<div class="view-head">' +
      '<h3 class="view-title">最佳解</h3>' +
      '<span class="view-desc">由求解器計算而得的決策組合，以及對應的管理解讀。</span>' +
      '</div>' +
      '<div class="summary-grid">' +
      summary
        .map(function (cell) {
          return (
            '<div class="summary-cell">' +
            '<div class="summary-label">' + h(cell.label) + '</div>' +
            '<div class="summary-value' + (cell.label.indexOf('Z*') >= 0 ? ' is-serif' : '') + '">' + cell.value + '</div>' +
            (cell.note ? '<div class="summary-note">' + h(cell.note) + '</div>' : '') +
            '</div>'
          );
        })
        .join('') +
      '</div>' +
      detailBlock +
      (result.alternative
        ? '<div class="callout"><div class="callout-title">多重最佳解</div>' +
          '非基變數 ' +
          h(result.alternativeVariables.map(function (index) {
            return model.varNames[index];
          }).join('、')) +
          ' 的檢定數為 0，表示存在另一組同樣好的解；在不改變目標值的前提下，可依其他管理條件調整。</div>'
        : '') +
      '<div class="section-divider">管理意涵</div>' +
      '<div class="notes">' + notes + '</div>' +
      '</div>'
    );
  }

  /* --------------------------------------------------------------------- */
  /* 限制式分析                                                            */
  /* --------------------------------------------------------------------- */

  function renderConstraints(model, result) {
    var info = modelLib.metaOf(model);
    var rows = model.constraints
      .map(function (constraint, index) {
        var analysis = result.constraints[index];
        if (!analysis) {
          return '';
        }
        return (
          '<tr class="' + (analysis.binding ? 'row-binding' : '') + '">' +
          '<td class="muted">(' + (index + 1) + ')</td>' +
          '<td>' +
          '<div>' + h(modelLib.resourceLabel(model, index)) + '</div>' +
          '<div class="math-inline">' + modelLib.constraintHTML(model, constraint, index, { withIndex: false, hideLabel: true }) + '</div>' +
          '</td>' +
          '<td class="num">' + fmtGrouped(analysis.lhs) + '</td>' +
          '<td class="num">' + fmtGrouped(analysis.rhs) + '</td>' +
          '<td class="num">' + fmtGrouped(analysis.slack.abs()) + '</td>' +
          '<td>' + statusTag(analysis.binding, analysis.op) + '</td>' +
          '<td class="num">' + (analysis.shadow.isZero() ? '<span class="muted">0</span>' : fmtGrouped(analysis.shadow)) + '</td>' +
          '</tr>'
        );
      })
      .join('');

    var bindingCount = result.constraints.filter(function (constraint) {
      return constraint.binding;
    }).length;

    return (
      '<div class="view">' +
      '<div class="view-head">' +
      '<h3 class="view-title">限制式分析</h3>' +
      '<span class="view-desc">在最佳解下，每一條限制式用掉多少資源、是否成為瓶頸。</span>' +
      '</div>' +
      '<div class="summary-grid">' +
      '<div class="summary-cell"><div class="summary-label">限制式總數</div>' +
      '<div class="summary-value">' + model.constraints.length + '</div></div>' +
      '<div class="summary-cell"><div class="summary-label">緊束（瓶頸）</div>' +
      '<div class="summary-value">' + bindingCount + ' <span style="font-size:12px;color:var(--ink-3)">條</span></div></div>' +
      '<div class="summary-cell"><div class="summary-label">仍有餘裕</div>' +
      '<div class="summary-value">' + (model.constraints.length - bindingCount) + ' <span style="font-size:12px;color:var(--ink-3)">條</span></div></div>' +
      '</div>' +
      '<div class="table-scroll"><table class="data-table">' +
      '<thead><tr>' +
      '<th></th><th>限制式</th><th class="num">左側值</th><th class="num">右側值</th>' +
      '<th class="num">鬆弛／盈餘</th><th>狀態</th><th class="num">影子價格</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="callout">' +
      '<div class="callout-title">怎麼讀這張表</div>' +
      '左側值是把最佳解代回限制式得到的用量；<b>鬆弛變數</b>（slack）用於「≤」型限制，代表尚未用完的資源；' +
      '<b>盈餘變數</b>（surplus）用於「≥」型限制，代表超出最低要求的部分。' +
      '鬆弛量為 0 者即為緊束限制式，也就是真正的瓶頸。' +
      (result.integer ? '<br><br>此為整數規劃，限制式以最終分支節點的 LP 鬆弛呈現。' : '') +
      '</div>' +
      '</div>'
    );
  }

  /* --------------------------------------------------------------------- */
  /* 敏感度分析                                                            */
  /* --------------------------------------------------------------------- */

  function renderSensitivity(model, result) {
    var info = modelLib.metaOf(model);
    var shadowRows = model.constraints
      .map(function (constraint, index) {
        var analysis = result.constraints[index];
        if (!analysis) {
          return '';
        }
        var range = analysis.range;
        var rangeLabel = range
          ? rangeText(
              range.down === null ? null : Frac.coerce(constraint.b).sub(range.down),
              range.up === null ? null : Frac.coerce(constraint.b).add(range.up),
              ''
            )
          : '—';
        return (
          '<tr' +
          (analysis.binding ? ' class="row-binding"' : '') +
          '>' +
          '<td class="strong">' + h(modelLib.resourceLabel(model, index)) + '</td>' +
          '<td class="num">' + fmtGrouped(analysis.shadow) + '</td>' +
          '<td class="num muted">' + rangeLabel + '</td>' +
          '<td>' + statusTag(analysis.binding, analysis.op) + '</td>' +
          '</tr>'
        );
      })
      .join('');

    var objectiveRows = result.varInfo
      .map(function (variable) {
        var current = Frac.coerce(model.c[variable.index]);
        var range = variable.objRange;
        var low = range && range.down !== null ? current.sub(range.down) : null;
        var high = range && range.up !== null ? current.add(range.up) : null;
        return (
          '<tr' +
          (variable.basic ? ' class="row-binding"' : '') +
          '>' +
          '<td class="strong">' + h(modelLib.variableLabel(model, variable.index)) + '</td>' +
          '<td class="num">' + fmtGrouped(current) + '</td>' +
          '<td class="num muted">' + (range ? rangeText(low, high, '') : '—') + '</td>' +
          '<td>' + (variable.basic ? '基變數' : '非基變數') + '</td>' +
          '</tr>'
        );
      })
      .join('');

    var description = result.integer
      ? '以下數值取自整數規劃的根節點 LP 鬆弛，僅供方向性參考；整數問題的敏感度並非連續可微。'
      : '以下是「一次只改一個參數、其他條件不變」的局部敏感度，也是管理者判斷「該往哪裡加資源」的主要依據。';

    return (
      '<div class="view">' +
      '<div class="view-head">' +
      '<h3 class="view-title">敏感度分析</h3>' +
      '<span class="view-desc">' + h(description) + '</span>' +
      '</div>' +
      '<div class="section-divider">影子價格與右端允許範圍</div>' +
      '<div class="table-scroll"><table class="data-table">' +
      '<thead><tr><th>限制式</th><th class="num">影子價格</th><th class="num">右端允許範圍</th><th>狀態</th></tr></thead>' +
      '<tbody>' + shadowRows + '</tbody></table></div>' +
      '<p style="font-size:12.5px;color:var(--ink-3);margin-top:8px">' +
      '影子價格＝右端常數每增加 1 單位時，' + h(info.objectiveLabel) + '的變化量。允許範圍表示在這段區間內，' +
      '影子價格維持不變（基變數組合不變）。</p>' +
      '<div class="section-divider">目標係數允許範圍</div>' +
      '<div class="table-scroll"><table class="data-table">' +
      '<thead><tr><th>變數</th><th class="num">目前係數</th><th class="num">允許範圍</th><th>在最佳解的狀態</th></tr></thead>' +
      '<tbody>' + objectiveRows + '</tbody></table></div>' +
      '<p style="font-size:12.5px;color:var(--ink-3);margin-top:8px">' +
      '目標係數在此區間內變動時，最佳解的變數組合不變（目標值會改變）。' +
      '非基變數的上限值即為「要改善到多少才會進入最佳解」的門檻。</p>' +
      '<div class="callout">' +
      '<div class="callout-title">管理上的用法</div>' +
      '影子價格可視為資源的<b>邊際價值</b>：若某資源的影子價格高於取得成本，就值得追加；' +
      '反之若影子價格為 0，表示該資源仍有餘裕，加購不會改善目標值。' +
      '允許範圍則回答了「追加多少以內仍然划算」。' +
      '</div>' +
      '</div>'
    );
  }

  /* --------------------------------------------------------------------- */
  /* 圖形分析                                                              */
  /* --------------------------------------------------------------------- */

  function renderGraph(model, result, options) {
    var opts = options || {};
    if (model.varNames.length !== 2) {
      return (
        '<div class="view">' +
        renderPending(
          '圖形分析僅支援兩個決策變數',
          '目前模型有 <b>' + model.varNames.length + '</b> 個變數。圖形分析是為了讓 2D 問題的幾何意義更清楚；' +
            '三個變數以上請改用「最佳解」與「敏感度」分頁檢視代數結果。'
        ) +
        '</div>'
      );
    }
    if (result.status !== 'optimal') {
      return (
        '<div class="view">' +
        renderPending(
          '尚未取得最佳解，無法標示最佳點',
          '限制式與可行區域仍可先檢視，但最佳解位置需要先成功求解。'
        ) +
        '</div>'
      );
    }
    var rendered = LPC.graph.render({
      model: model,
      result: result,
      isoLevel: opts.isoLevel,
      showIntegers: true
    });
    var objectiveLevel = opts.isoLevel === undefined || opts.isoLevel === null ? Number(result.z) : opts.isoLevel;
    var isoLabel = Number(result.z);
    var isoMin = Math.min(0, isoLabel);
    var isoMax = Math.max(0, isoLabel);
    var isoStep = Math.max(0.01, (isoMax - isoMin) / 200);
    return (
      '<div class="view">' +
      '<div class="view-head">' +
      '<h3 class="view-title">圖形分析</h3>' +
      '<span class="view-desc">限制式、可行區域、等利潤線與最佳解在同一個平面上。' +
      '拖動滑桿可以看到等利潤線平移，直到與可行區域相切的位置就是最佳解。</span>' +
      '</div>' +
      '<div class="graph-layout">' +
      '<div class="graph-frame">' +
      rendered.svg +
      '<div class="graph-legend">' +
      '<span class="legend-item"><span class="legend-swatch is-region"></span>可行區域</span>' +
      '<span class="legend-item"><span class="legend-swatch"></span>限制式</span>' +
      '<span class="legend-item"><span class="legend-swatch is-binding"></span>緊束限制式</span>' +
      '<span class="legend-item"><span class="legend-swatch is-iso"></span>等利潤線</span>' +
      '<span class="legend-item"><span class="legend-dot"></span>最佳解</span>' +
      '</div>' +
      '</div>' +
      '<div class="graph-controls">' +
      '<label class="field-label" for="iso-slider">等利潤線 Z</label>' +
      '<input type="range" class="slider" id="iso-slider" min="' + isoMin + '" max="' + isoMax + '" step="' +
      isoStep + '" value="' + objectiveLevel + '">' +
      '<span class="graph-readout" id="iso-readout">Z = ' + fmtGrouped(objectiveLevel) + '</span>' +
      '</div>' +
      '<p style="font-size:12px;color:var(--ink-3)">' +
      '圖形以裁切視窗繪製；若可行區域延伸至無窮遠，畫面只顯示目前視窗內的範圍。' +
      '</p>' +
      '</div>' +
      '</div>'
    );
  }

  /* --------------------------------------------------------------------- */
  /* 單純形法（教學）                                                      */
  /* --------------------------------------------------------------------- */

  var MAX_TABLEAU_COLUMNS = 26;

  function renderSimplex(model, result, options) {
    var opts = options || {};
    if (!result.iterations || !result.iterations.length) {
      return (
        '<div class="view">' +
        renderPending(
          '這一題沒有可顯示的單純形表',
          '可能是模型沒有設定限制式，或規模過大而未保留迭代過程。'
        ) +
        '</div>'
      );
    }
    var steps = result.iterations;
    var activeIndex = Math.min(
      steps.length - 1,
      opts.iterationIndex === undefined ? steps.length - 1 : opts.iterationIndex
    );
    var snapshot = steps[activeIndex];
    var labels = result.columnLabels || [];
    var showColumns = Math.min(labels.length, MAX_TABLEAU_COLUMNS);

    var chips = steps
      .map(function (step, index) {
        return (
          '<button type="button" class="iteration-chip' +
          (step.phase === 1 ? ' is-phase-one' : '') +
          (index === activeIndex ? ' is-active' : '') +
          '" data-iteration="' +
          index +
          '" title="' +
          (step.phase === 1 ? '第一階段' : '第二階段') +
          '第 ' +
          (index + 1) +
          ' 張表">' +
          (index + 1) +
          '</button>'
        );
      })
      .join('');

    var header =
      '<tr><th>基變數</th>' +
      labels
        .slice(0, showColumns)
        .map(function (label) {
          var columnIndex = labels.indexOf(label);
          return (
            '<th class="' + (columnIndex === snapshot.entering ? 'is-entering' : '') + '">' + h(label) + '</th>'
          );
        })
        .join('') +
      '<th class="rhs-col">右端值</th></tr>';

    var body = snapshot.basis
      .map(function (basisColumn, rowIndex) {
        var cells = snapshot.A[rowIndex]
          .slice(0, showColumns)
          .map(function (value, columnIndex) {
            var classes = [];
            if (columnIndex === snapshot.entering) {
              classes.push('is-entering');
            }
            return '<td class="' + classes.join(' ') + '">' + num(value) + '</td>';
          })
          .join('');
        return (
          '<tr class="' + (rowIndex === snapshot.leaving ? 'is-leaving' : '') + '">' +
          '<th class="basic-name">' + h(labels[basisColumn] || '—') + '</th>' +
          cells +
          '<td class="rhs-col">' + num(snapshot.b[rowIndex]) + '</td>' +
          '</tr>'
        );
      })
      .join('');

    var reducedRow =
      '<tr class="d-row"><th>檢定數 c−z</th>' +
      snapshot.d
        .slice(0, showColumns)
        .map(function (value, columnIndex) {
          return '<td class="' + (columnIndex === snapshot.entering ? 'is-entering' : '') + '">' + num(value) + '</td>';
        })
        .join('') +
      '<td class="rhs-col" title="目前解的目標值">Z ' +
      num(result.sense === 'min' ? snapshot.z.neg() : snapshot.z) +
      '</td></tr>';

    var explain;
    if (snapshot.final) {
      explain =
        snapshot.terminal === 'unbounded'
          ? '此欄所有係數皆 ≤ 0，變數可以無限增大，因此為無界解。'
          : '所有檢定數皆 ≤ 0，沒有變數可以再改善目標值：<b>這張表就是最佳解</b>，' +
            '基變數欄位與右端值即為最終的變數值。';
    } else if (snapshot.entering >= 0 && snapshot.leaving >= 0) {
      explain =
        '這一張表要換入 <b>' + h(labels[snapshot.entering]) + '</b>（檢定數 ' + num(snapshot.d[snapshot.entering]) +
        ' 為正，代表進入後可改善目標值）；以最小比值測試決定換出第 <b>' + (snapshot.leaving + 1) +
        '</b> 列的基變數 <b>' + h(labels[snapshot.basis[snapshot.leaving]]) + '</b>，' +
        '樞紐元素為 <b>' + num(snapshot.pivotValue) + '</b>，換入值最大可增加 <b>' + num(snapshot.step) + '</b>。';
    } else if (snapshot.entering < 0) {
      explain = '所有檢定數皆 ≤ 0，沒有變數可以再改善目標值，這就是最佳解。';
    } else {
      explain = '此欄所有係數皆 ≤ 0，變數可以無限增大，因此為無界解。';
    }

    var note = '';
    if (labels.length > MAX_TABLEAU_COLUMNS) {
      note =
        '此模型欄位較多，僅顯示前 ' + MAX_TABLEAU_COLUMNS + ' 欄（共 ' + labels.length + ' 欄）。';
    }

    return (
      '<div class="view">' +
      '<div class="view-head">' +
      '<h3 class="view-title">單純形法逐步檢查</h3>' +
      '<span class="view-desc">系統保留每一次 pivot 的單純形表，可以逐步檢視演算法的推導過程。' +
      (result.phaseOneUsed ? '此題含「≥」限制式，所以先以第一階段（虛線編號）建立可行基。' : '') +
      '</span>' +
      '</div>' +
      '<div class="iteration-bar">' +
      '<span class="field-label">第</span>' +
      '<div class="iteration-steps">' + chips + '</div>' +
      '<span class="field-label">張表</span>' +
      '<span class="tag tag-info" style="margin-left:auto">' +
      (snapshot.phase === 1 ? '第一階段：最小化人工變數' : '第二階段：最大化目標函數') +
      '</span>' +
      '</div>' +
      '<div class="iteration-explain">' + explain + '</div>' +
      '<div class="tableau-wrap"><table class="tableau">' +
      '<thead>' + header + '</thead>' +
      '<tbody>' + body + reducedRow + '</tbody></table></div>' +
      (note ? '<div class="tableau-note">' + note + '</div>' : '') +
      '<div class="tableau-note">' +
      '檢定數：最大化問題中，欄位檢定數 &gt; 0 表示該變數進入可增加目標值；' +
      '「基變數」欄列出目前留在基底中的變數，其右端值就是目前的解。' +
      '黃色標示為換入欄，藍色標示為換出列。' +
      '</div>' +
      '</div>'
    );
  }

  /* --------------------------------------------------------------------- */
  /* 整數規劃                                                              */
  /* --------------------------------------------------------------------- */

  function renderInteger(model, result) {
    var relaxed = result.lpRelaxation;
    var rows = (result.branchLog || [])
      .map(function (entry) {
        var verdictText = {
          branch: '分支',
          integer: '整數解',
          infeasible: '無可行解',
          unbounded: '無界'
        }[entry.verdict] || entry.verdict;
        var detail = '';
        if (entry.verdict === 'branch') {
          detail = model.varNames[entry.variable] + ' = ' + fmt(entry.value);
        }
        return (
          '<tr>' +
          '<td class="num muted">' + entry.depth + '</td>' +
          '<td>' + verdictText + '</td>' +
          '<td>' + h(detail) + '</td>' +
          '<td class="num">' + (entry.z === undefined ? '—' : fmtGrouped(entry.z)) + '</td>' +
          '</tr>'
        );
      })
      .join('');

    var gapText = '—';
    if (relaxed && relaxed.status === 'optimal' && result.z && relaxed.z) {
      var gap = Frac.coerce(relaxed.z).sub(result.z);
      gapText = fmtGrouped(gap.abs());
    }

    return (
      '<div class="view">' +
      '<div class="view-head">' +
      '<h3 class="view-title">分支定界過程</h3>' +
      '<span class="view-desc">整數規劃無法直接使用單純形法，系統以 LP 鬆弛搭配分支定界求出整數最佳解。</span>' +
      '</div>' +
      '<div class="summary-grid is-four">' +
      '<div class="summary-cell"><div class="summary-label">LP 鬆弛最佳值</div>' +
      '<div class="summary-value">' + (relaxed && relaxed.z !== null ? fmtGrouped(relaxed.z) : '—') + '</div>' +
      '<div class="summary-note">允許小數時的答案</div></div>' +
      '<div class="summary-cell"><div class="summary-label">整數最佳值</div>' +
      '<div class="summary-value is-serif">' + (result.z ? fmtGrouped(result.z) : '—') + '</div>' +
      '<div class="summary-note">切割後的最佳解</div></div>' +
      '<div class="summary-cell"><div class="summary-label">整數差距</div>' +
      '<div class="summary-value">' + gapText + '</div>' +
      '<div class="summary-note">鬆弛與整數解的落差</div></div>' +
      '<div class="summary-cell"><div class="summary-label">搜尋節點</div>' +
      '<div class="summary-value">' + (result.nodes || 0) + '</div>' +
      '<div class="summary-note">剪枝 ' + (result.pruned || 0) + ' 次</div></div>' +
      '</div>' +
      '<div class="section-divider">分支紀錄</div>' +
      '<div class="table-scroll"><table class="data-table">' +
      '<thead><tr><th class="num">深度</th><th>節點結果</th><th>分支條件</th><th class="num">該節點 Z</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
      '<div class="callout">' +
      '<div class="callout-title">方法說明</div>' +
      '分支定界先解 LP 鬆弛。若解的整數變數出現小數，就固定「≤ 下界」與「≥ 上界」兩個方向各開一個子問題；' +
      '一旦某節點得到整數解，就成為目前的最佳候選，後續節點的 LP 值若無法超越它即可剪枝。' +
      '</div>' +
      '</div>'
    );
  }

  /* --------------------------------------------------------------------- */
  /* 列印用報告                                                            */
  /* --------------------------------------------------------------------- */

  function buildPrintReport(model, result) {
    var info = modelLib.metaOf(model);
    var now = new Date();
    var stamp =
      now.getFullYear() +
      ' 年 ' +
      (now.getMonth() + 1) +
      ' 月 ' +
      now.getDate() +
      ' 日 ' +
      String(now.getHours()).padStart(2, '0') +
      ':' +
      String(now.getMinutes()).padStart(2, '0');

    var head =
      '<h1>線性規劃求解報告</h1>' +
      '<div class="print-meta">管理數學作業一 · 線性規劃計算器　|　產生時間：' +
      stamp +
      '　|　學號／姓名：____________________</div>';

    var modelBlock =
      '<h2>一、數學模型</h2><div class="print-model">' +
      h(modelLib.modelText(model).replace(/<=/g, '\u2264').replace(/>=/g, '\u2265')) +
      '</div>';

    if (!result || result.status !== 'optimal') {
      var statusText = {
        infeasible: '無可行解（Infeasible）',
        unbounded: '無界解（Unbounded）',
        'empty-model': '模型尚未完成'
      }[result ? result.status : ''];
      return (
        head +
        modelBlock +
        '<h2>二、求解結果</h2><p>' +
        h(statusText || '尚未求解') +
        '</p>'
      );
    }

    var variableRows = result.varInfo
      .map(function (variable) {
        return (
          '<tr><td>' +
          h(modelLib.variableLabel(model, variable.index)) +
          '</td><td class="num">' +
          fmtGrouped(variable.value) +
          '</td><td class="num">' +
          (variable.reducedCost.isZero() ? '0' : fmtGrouped(variable.reducedCost)) +
          '</td></tr>'
        );
      })
      .join('');

    var constraintRows = model.constraints
      .map(function (constraint, index) {
        var analysis = result.constraints[index];
        if (!analysis) {
          return '';
        }
        return (
          '<tr><td>(' +
          (index + 1) +
          ') ' +
          h(modelLib.constraintText(model, constraint)) +
          '</td><td class="num">' +
          fmtGrouped(analysis.lhs) +
          '</td><td class="num">' +
          fmtGrouped(analysis.slack.abs()) +
          '</td><td>' +
          (analysis.binding ? '緊束' : '未緊束') +
          '</td><td class="num">' +
          fmtGrouped(analysis.shadow) +
          '</td></tr>'
        );
      })
      .join('');

    var notes = modelLib
      .interpret(model, result)
      .map(function (note) {
        return '<li><b>' + h(note.title) + '：</b>' + h(note.text) + '</li>';
      })
      .join('');

    var graphBlock = '';
    if (model.varNames.length === 2) {
      var rendered = LPC.graph.render({
        model: model,
        result: result,
        isoLevel: Number(result.z),
        showIntegers: true
      });
      graphBlock =
        '<h2>四、圖形分析</h2><div class="print-graph">' + rendered.svg + '</div>';
    }

    var solutionBlock =
      '<h2>二、最佳解</h2>' +
      '<table><thead><tr><th>變數</th><th class="num">最佳值</th><th class="num">減價成本</th></tr></thead><tbody>' +
      variableRows +
      '</tbody></table>' +
      '<p style="margin-top:3mm">' +
      h(info.objectiveLabel) +
      ' Z* = <b>' +
      fmtGrouped(result.z) +
      (info.objectiveUnit ? ' ' + info.objectiveUnit : '') +
      '</b>，' +
      (result.integer ? '此為整數最佳解。' : '以單純形法求得，全程為精確有理數運算。') +
      '</p>';

    var constraintBlock =
      '<h2>三、限制式分析與敏感度</h2>' +
      '<table><thead><tr><th>限制式</th><th class="num">左側值</th><th class="num">鬆弛／盈餘</th><th>狀態</th><th class="num">影子價格</th></tr></thead><tbody>' +
      constraintRows +
      '</tbody></table>';

    var notesBlock =
      '<h2>' + (graphBlock ? '五' : '四') + '、管理意涵</h2><ul class="print-notes">' +
      notes +
      '</ul>';

    return head + modelBlock + solutionBlock + constraintBlock + graphBlock + notesBlock;
  }

  LPC.views = {
    renderPending: renderPending,
    renderInvalid: renderInvalid,
    renderInfeasible: renderInfeasible,
    renderUnbounded: renderUnbounded,
    renderSolution: renderSolution,
    renderConstraints: renderConstraints,
    renderSensitivity: renderSensitivity,
    renderGraph: renderGraph,
    renderSimplex: renderSimplex,
    renderInteger: renderInteger,
    buildPrintReport: buildPrintReport
  };
})(typeof window !== 'undefined' ? window : globalThis);
