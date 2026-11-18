/* ============================================================================
 * goalui.js — 「目標規劃」分頁的介面（左：建模表單；右：求解結果）
 * ----------------------------------------------------------------------------
 * 與原本的線性規劃分頁完全獨立：自己的狀態、自己的儲存鍵、自己的結果面板，
 * 只共用版面樣式與 LPC.goal 求解引擎。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});
  var GP = LPC.goal;
  var modelLib = LPC.model;
  var fmt = modelLib.fmt;
  var fmtGrouped = modelLib.fmtGrouped;
  var esc = modelLib.escapeHTML;

  var STORAGE_KEY = 'lpc.goal.v1';
  var SOLVE_DELAY = 160;

  var gs = {
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(gs.spec));
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
      var spec = GP.create(JSON.parse(raw));
      return spec.goals.length || spec.varNames.length ? spec : null;
    } catch (error) {
      return null;
    }
  }

  function goalName(index) {
    var goal = gs.spec.goals[index];
    return goal && goal.label ? goal.label : '目標 ' + (index + 1);
  }

  function relationText(op) {
    return op === '>=' ? '≥' : op === '<=' ? '≤' : '=';
  }

  function variableInline(name) {
    return GP.varHTML(name);
  }

  /* --------------------------------------------------------------------- */
  /* 左側：建模表單                                                        */
  /* --------------------------------------------------------------------- */

  function renderPanel() {
    var host = qs('#panel-goal');
    if (!host) {
      return;
    }
    var spec = gs.spec;
    var n = spec.varNames.length;

    var exampleChips = GP.examples
      .map(function (example) {
        return (
          '<button type="button" class="chip' + (gs.exampleId === example.id ? ' is-on' : '') +
          '" data-g-example="' + example.id + '" title="' + esc(example.description) + '">' + esc(example.title) + '</button>'
        );
      })
      .join('');

    var currentExample = GP.examples.filter(function (example) {
      return example.id === gs.exampleId;
    })[0];

    var varRows = spec.varNames
      .map(function (name, index) {
        return (
          '<tr>' +
          '<td>' + (index + 1) + '</td>' +
          '<td><input class="input" type="text" data-g-var-name="' + index + '" value="' + esc(name) +
          '" aria-label="第 ' + (index + 1) + ' 個變數的名稱" autocomplete="off"></td>' +
          '<td><input type="checkbox" class="check" data-g-var-int="' + index + '"' + (spec.integer[index] ? ' checked' : '') +
          ' aria-label="' + esc(name) + ' 限制為整數"></td>' +
          '</tr>'
        );
      })
      .join('');

    host.innerHTML =
      /* 01 範例與名稱 */
      '<section class="step">' +
      '<header class="step-head"><span class="step-index">01</span><h2 class="step-title">目標規劃問題</h2>' +
      '<span class="step-hint">多個目標、有優先順序，求「最滿意解」</span></header>' +
      '<div class="field-group">' +
      '<div class="field-row"><label class="field"><span class="field-label">問題名稱</span>' +
      '<input type="text" class="input" data-g-title value="' + esc(spec.title) + '" placeholder="例：Beaver Creek 陶器製造公司" autocomplete="off"></label></div>' +
      '<div class="sample-row"><span class="field-label">講義例題</span>' + exampleChips + '</div>' +
      (currentExample
        ? '<div class="callout"><div class="callout-title">' + esc(currentExample.title) + '</div>' +
          esc(currentExample.description) + (currentExample.note ? '<br><span class="goal-example-note">' + esc(currentExample.note) + '</span>' : '') + '</div>'
        : '') +
      '<div class="goal-legend">' +
      '<div><b>d<sub>i</sub><sup>−</sup></b> 不足量：實際值低於目標值的部分</div>' +
      '<div><b>d<sub>i</sub><sup>+</sup></b> 超額量：實際值高於目標值的部分</div>' +
      '<div><b>優先順序</b> 填 1、2、3…（1 最優先）；<b>空白</b> 表示不去最小化這個偏離量</div>' +
      '<div><b>權重</b> 同一個優先順序內的偏離量會加權相加，例如 min 4d<sub>5</sub><sup>−</sup> + 5d<sub>6</sub><sup>−</sup></div>' +
      '</div>' +
      '</div></section>' +
      /* 02 決策變數 */
      '<section class="step">' +
      '<header class="step-head"><span class="step-index">02</span><h2 class="step-title">決策變數</h2>' +
      '<span class="step-hint">最多 ' + GP.MAX_VARIABLES + ' 個，可設為整數</span></header>' +
      '<div class="field-group">' +
      '<div class="var-toolbar"><div class="stepper"><span class="field-label">變數個數</span>' +
      '<div class="stepper-control">' +
      '<button type="button" class="stepper-button" data-g-var-minus aria-label="減少一個變數"' + (n <= 1 ? ' disabled' : '') + '>−</button>' +
      '<output class="stepper-value" aria-live="polite">' + n + '</output>' +
      '<button type="button" class="stepper-button" data-g-var-plus aria-label="增加一個變數"' + (n >= GP.MAX_VARIABLES ? ' disabled' : '') + '>＋</button>' +
      '</div></div></div>' +
      '<div class="var-table-wrap"><table class="var-table goal-var-table"><thead><tr>' +
      '<th scope="col">變數</th><th scope="col">名稱</th><th scope="col">整數</th></tr></thead><tbody>' + varRows + '</tbody></table></div>' +
      '</div></section>' +
      /* 03 系統限制式 */
      '<section class="step">' +
      '<header class="step-head"><span class="step-index">03</span><h2 class="step-title">系統限制式（選填）</h2>' +
      '<span class="step-hint">絕對不能違反的硬限制；可偏離的請放在「目標」</span></header>' +
      '<div class="field-group"><div class="constraint-list">' + renderHardList() + '</div>' +
      '<div class="step-actions"><button type="button" class="btn btn-outline" data-g-add-hard>＋ 新增系統限制式</button></div>' +
      '</div></section>' +
      /* 04 目標 */
      '<section class="step">' +
      '<header class="step-head"><span class="step-index">04</span><h2 class="step-title">目標</h2>' +
      '<span class="step-hint">每個目標建立一條「目標限制式」，並指定要最小化哪個偏離量</span></header>' +
      '<div class="field-group"><div class="constraint-list">' + renderGoalList() + '</div>' +
      '<div class="step-actions"><button type="button" class="btn btn-outline" data-g-add-goal>＋ 新增目標</button></div>' +
      '</div></section>' +
      /* 05 預覽 */
      '<section class="step step-last">' +
      '<header class="step-head"><span class="step-index">05</span><h2 class="step-title">完整目標規劃模式</h2>' +
      '<span class="step-hint">系統自動加上離差變數並排版</span></header>' +
      '<div class="model-sheet"><div id="goal-model-preview" aria-live="polite"></div>' +
      '<div class="model-sheet-actions">' +
      '<button type="button" class="btn btn-quiet btn-small" data-g-copy>複製模型文字</button>' +
      '<button type="button" class="btn btn-quiet btn-small" data-g-json>下載 JSON</button>' +
      '<button type="button" class="btn btn-quiet btn-small" data-g-reset>清空重填</button>' +
      '</div></div></section>';

    renderModelPreview();
  }

  function coefCells(row, rowIndex, prefix, labelPrefix) {
    return gs.spec.varNames
      .map(function (name, index) {
        return (
          '<span class="expr-cell">' +
          '<input class="input input-coef" type="text" inputmode="decimal" data-g-' + (prefix ? prefix + '-' : '') + 'coef="' + rowIndex + '-' + index +
          '" value="' + esc(String(row.a[index])) + '" aria-label="' + labelPrefix + '中 ' + esc(name) + ' 的係數" autocomplete="off">' +
          '<span class="coef-var">' + variableInline(name) + '</span>' +
          '</span>'
        );
      })
      .join('');
  }

  function opSelect(attribute, rowIndex, op, symbols) {
    var options = symbols
      .map(function (value) {
        return '<option value="' + value + '"' + (op === value ? ' selected' : '') + '>' + relationText(value) + '</option>';
      })
      .join('');
    return '<select class="select constraint-op" data-g-' + attribute + '="' + rowIndex + '" aria-label="關係符號">' + options + '</select>';
  }

  function renderHardList() {
    if (!gs.spec.hard.length) {
      return '<div class="callout"><div class="callout-title">沒有系統限制式</div>' +
        '所有條件都當作「可以偏離的目標」處理。若某個條件絕不能違反（例如人力、原料的絕對上限），才需要在這裡新增。</div>';
    }
    return gs.spec.hard
      .map(function (row, rowIndex) {
        return (
          '<div class="constraint">' +
          '<div class="constraint-head"><span class="constraint-index">(' + (rowIndex + 1) + ')</span>' +
          '<input class="input constraint-label" type="text" data-g-h-label="' + rowIndex + '" value="' + esc(row.label) +
          '" placeholder="這條限制式的名稱（例：人力上限）" autocomplete="off">' +
          '<button type="button" class="btn btn-icon btn-danger-quiet" data-g-h-remove="' + rowIndex + '" aria-label="刪除第 ' + (rowIndex + 1) + ' 條系統限制式" title="刪除">✕</button></div>' +
          '<div class="constraint-body">' + coefCells(row, rowIndex, 'h', '系統限制式 ' + (rowIndex + 1)) +
          opSelect('h-op', rowIndex, row.op, ['<=', '=', '>=']) +
          '<input class="input input-num constraint-rhs" type="text" inputmode="decimal" data-g-h-rhs="' + rowIndex + '" value="' + esc(row.b) +
          '" aria-label="右端值" autocomplete="off"></div></div>'
        );
      })
      .join('');
  }

  function penaltyCell(rowIndex, side, penalty) {
    var name = GP.devHTML(rowIndex, side);
    var desc = side === '-' ? '不足' : '超額';
    return (
      '<div class="goal-pen-cell' + (penalty.p !== '' ? ' is-on' : '') + '">' +
      '<span class="goal-pen-name">' + name + '<span class="goal-pen-desc">' + desc + '</span></span>' +
      '<label class="goal-pen-field"><span>優先</span>' +
      '<input class="input input-pen" type="text" inputmode="numeric" data-g-pen="' + rowIndex + ':' + side + ':p" value="' + esc(penalty.p) +
      '" placeholder="—" aria-label="目標 ' + (rowIndex + 1) + ' 的 d' + (side === '-' ? '⁻' : '⁺') + ' 優先順序（空白＝不最小化）" autocomplete="off"></label>' +
      '<label class="goal-pen-field"><span>權重</span>' +
      '<input class="input input-pen" type="text" inputmode="decimal" data-g-pen="' + rowIndex + ':' + side + ':w" value="' + esc(penalty.w) +
      '" aria-label="目標 ' + (rowIndex + 1) + ' 的 d' + (side === '-' ? '⁻' : '⁺') + ' 權重" autocomplete="off"></label>' +
      '</div>'
    );
  }

  function renderGoalList() {
    if (!gs.spec.goals.length) {
      return '<div class="callout is-warn"><div class="callout-title">還沒有任何目標</div>點下面的「新增目標」，或從上方挑一個講義例題開始。</div>';
    }
    return gs.spec.goals
      .map(function (goal, rowIndex) {
        return (
          '<div class="constraint goal-card">' +
          '<div class="constraint-head"><span class="constraint-index">G' + (rowIndex + 1) + '</span>' +
          '<input class="input constraint-label" type="text" data-g-label="' + rowIndex + '" value="' + esc(goal.label) +
          '" placeholder="這個目標的名稱（例：勞力工時至少 40 小時）" autocomplete="off">' +
          '<button type="button" class="btn btn-icon btn-danger-quiet" data-g-remove="' + rowIndex + '" aria-label="刪除目標 ' + (rowIndex + 1) + '" title="刪除">✕</button></div>' +
          '<div class="constraint-body">' + coefCells(goal, rowIndex, '', '目標 ' + (rowIndex + 1)) +
          opSelect('op', rowIndex, goal.op, ['>=', '<=', '=']) +
          '<input class="input input-num constraint-rhs" type="text" inputmode="decimal" data-g-target="' + rowIndex + '" value="' + esc(goal.target) +
          '" aria-label="目標值" autocomplete="off"></div>' +
          '<details class="goal-adv"' + (goal.dev ? ' open' : '') + '><summary>進階：目標限制式含其他目標的離差變數</summary>' +
          '<div class="goal-adv-body"><input class="input" type="text" data-g-dev="' + rowIndex + '" value="' + esc(goal.dev) +
          '" placeholder="例：d1+　或　2*d3-, d2+" autocomplete="off" aria-label="目標 ' + (rowIndex + 1) + ' 含有的離差變數">' +
          '<span class="field-note">用於「目標中的目標」，如講義的 d₁⁺ + d₄⁻ − d₄⁺ = 10。以逗號分隔多項。</span></div></details>' +
          '<div class="goal-pen">' + penaltyCell(rowIndex, '-', goal.under) + penaltyCell(rowIndex, '+', goal.over) + '</div>' +
          '</div>'
        );
      })
      .join('');
  }

  function renderModelPreview() {
    var host = qs('#goal-model-preview');
    if (host) {
      host.innerHTML = GP.modelHTML(gs.spec);
    }
  }

  /* --------------------------------------------------------------------- */
  /* 右側：結果                                                            */
  /* --------------------------------------------------------------------- */

  function levelPlainText(level) {
    return level.name;
  }

  function renderHead() {
    var label = qs('#goal-verdict-label');
    var value = qs('#goal-verdict-value');
    var sub = qs('#goal-verdict-sub');
    var status = qs('#goal-solve-status');
    var result = gs.result;

    value.className = 'verdict-value';
    sub.innerHTML = '';

    if (!result) {
      label.textContent = '最滿意解';
      value.textContent = '—';
      value.classList.add('is-muted');
      status.textContent = '';
      return;
    }
    if (result.status === 'invalid' || result.status === 'error') {
      label.textContent = '模型尚未完成';
      value.textContent = '請修正輸入';
      value.classList.add('is-muted');
      sub.textContent = (result.errors && result.errors[0]) || '';
      status.textContent = '';
      return;
    }
    if (result.status === 'infeasible') {
      label.textContent = '求解結果';
      value.textContent = '無可行解';
      value.classList.add('is-error');
      sub.textContent = '系統限制式（與整數條件）互相矛盾。';
      status.textContent = '';
      return;
    }
    if (result.status !== 'optimal') {
      label.textContent = '求解結果';
      value.textContent = '無法求解';
      value.classList.add('is-muted');
      sub.textContent = result.message || '';
      status.textContent = '';
      return;
    }

    label.textContent = (gs.spec.title ? gs.spec.title + ' · ' : '') + '最滿意解 (Most Satisfactory Solution)';
    value.innerHTML = result.x
      .map(function (amount, index) {
        return '<span class="goal-xv">' + variableInline(result.varNames[index]) + ' = ' + fmtGrouped(amount) + '</span>';
      })
      .join('');
    var chips = result.levels
      .map(function (level) {
        return level.met
          ? '<span class="goal-chip is-met">' + esc(level.name) + ' ✓</span>'
          : '<span class="goal-chip is-miss">' + esc(level.name) + ' 偏離 ' + fmtGrouped(level.achieved) + '</span>';
      })
      .join('');
    sub.innerHTML =
      '<span class="goal-sub-line">' + result.metCount + ' / ' + result.goalCount + ' 個目標限制式達成</span>' + chips;
    status.textContent = result.levels.length + ' 層逐層求解 · ' + gs.solveMs.toFixed(0) + ' ms';
  }

  function goalStatus(goal) {
    if (goal.met) {
      if (goal.op === '>=' && goal.over.isPos()) {
        return '<span class="tag tag-binding">達成（超出 ' + fmtGrouped(goal.over) + '）</span>';
      }
      if (goal.op === '<=' && goal.under.isPos()) {
        return '<span class="tag tag-binding">達成（尚餘 ' + fmtGrouped(goal.under) + '）</span>';
      }
      return '<span class="tag tag-binding">達成</span>';
    }
    if (goal.op === '>=') {
      return '<span class="tag tag-warn">未達成（不足 ' + fmtGrouped(goal.under) + '）</span>';
    }
    if (goal.op === '<=') {
      return '<span class="tag tag-warn">未達成（超出 ' + fmtGrouped(goal.over) + '）</span>';
    }
    return '<span class="tag tag-warn">未達成（' + (goal.under.isPos() ? '不足 ' + fmtGrouped(goal.under) : '超出 ' + fmtGrouped(goal.over)) + '）</span>';
  }

  function deviationCell(amount) {
    return amount.isZero() ? '<span class="muted">0</span>' : fmtGrouped(amount);
  }

  function renderWarnings(result) {
    return (result.warnings || [])
      .map(function (text) {
        return '<div class="callout is-warn"><div class="callout-title">提醒</div>' + esc(text) + '</div>';
      })
      .join('');
  }

  function interpretation(result) {
    var notes = [];
    result.goals.forEach(function (goal, index) {
      var name = goalName(index);
      if (goal.met) {
        notes.push({
          title: name + '：達成',
          text: '實際值 ' + fmtGrouped(goal.actual) + '，目標 ' + relationText(goal.op) + ' ' + fmtGrouped(goal.target) + '。'
        });
      } else {
        var gap = goal.under.isPos() ? goal.under : goal.over;
        notes.push({
          title: name + '：未達成',
          text:
            '實際值 ' + fmtGrouped(goal.actual) + '，目標 ' + relationText(goal.op) + ' ' + fmtGrouped(goal.target) +
            '，偏離 ' + fmtGrouped(gap) + '（' + (goal.under.isPos() ? '不足' : '超出') + '）。'
        });
      }
    });
    var missed = result.levels.filter(function (level) {
      return !level.met;
    });
    if (missed.length) {
      notes.push({
        title: '為什麼有些優先層無法完全達成？',
        text:
          missed
            .map(function (level) {
              return level.name + '（' + level.objectiveText + '）最小只能降到 ' + fmtGrouped(level.optimum);
            })
            .join('；') +
          '。想再降低，就必須犧牲更高優先順序的目標，所以這就是在優先順序下的最滿意解。'
      });
    } else if (result.levels.length) {
      notes.push({
        title: '所有優先層都完全達成',
        text: '每個要最小化的偏離量都降到 0，表示所有目標同時被滿足。'
      });
    }
    return notes;
  }

  function renderSolutionView(result) {
    var varRows = result.x
      .map(function (amount, index) {
        return (
          '<tr' + (amount.isPos() ? ' class="row-binding"' : '') + '>' +
          '<td class="strong">' + variableInline(result.varNames[index]) + '</td>' +
          '<td class="num">' + fmtGrouped(amount) + '</td>' +
          '<td>' + (gs.spec.integer[index] ? '整數' : '連續') + '</td></tr>'
        );
      })
      .join('');

    var goalRows = result.goals
      .map(function (goal, index) {
        return (
          '<tr' + (goal.met ? '' : ' class="goal-row-miss"') + '>' +
          '<td class="strong">G' + (index + 1) + '　' + esc(goalName(index)) + '</td>' +
          '<td class="num">' + fmtGrouped(goal.actual) + '</td>' +
          '<td class="num">' + relationText(goal.op) + ' ' + fmtGrouped(goal.target) + '</td>' +
          '<td class="num">' + deviationCell(goal.under) + '</td>' +
          '<td class="num">' + deviationCell(goal.over) + '</td>' +
          '<td>' + goalStatus(goal) + '</td></tr>'
        );
      })
      .join('');

    var levelRows = result.levels.length
      ? result.levels
          .map(function (level) {
            return (
              '<tr' + (level.met ? ' class="row-binding"' : '') + '>' +
              '<td class="strong">' + esc(level.name) + '</td>' +
              '<td>' + esc(level.objectiveText) + '</td>' +
              '<td class="num">' + fmtGrouped(level.achieved) + '</td>' +
              '<td>' + (level.met ? '<span class="tag tag-binding">完全達成</span>' : '<span class="tag tag-warn">無法降到 0</span>') + '</td></tr>'
            );
          })
          .join('')
      : '<tr><td colspan="4" class="muted">沒有指定要最小化的偏離量。</td></tr>';

    var hardBlock = '';
    if (result.hard.length) {
      hardBlock =
        '<div class="section-divider">系統限制式</div>' +
        '<div class="table-scroll"><table class="data-table"><thead><tr><th>限制式</th><th class="num">左側值</th><th class="num">右端值</th><th>狀態</th></tr></thead><tbody>' +
        result.hard
          .map(function (row, index) {
            return (
              '<tr><td class="strong">(' + (index + 1) + ')' + (row.label ? '　' + esc(row.label) : '') + '</td>' +
              '<td class="num">' + fmtGrouped(row.lhs) + '</td>' +
              '<td class="num">' + relationText(row.op) + ' ' + fmtGrouped(row.rhs) + '</td>' +
              '<td>' + (row.binding ? '<span class="tag tag-binding">緊束</span>' : '<span class="tag tag-slack">未緊束（餘裕 ' + fmtGrouped(row.slack) + '）</span>') + '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>';
    }

    var notes = interpretation(result)
      .map(function (note) {
        return '<div class="note"><div class="note-title">' + esc(note.title) + '</div><div class="note-text">' + esc(note.text) + '</div></div>';
      })
      .join('');

    return (
      '<div class="view">' +
      '<div class="view-head"><h3 class="view-title">最滿意解</h3>' +
      '<span class="view-desc">依優先順序逐層求解得到的決策組合，以及每個目標的達成情形。</span></div>' +
      renderWarnings(result) +
      '<div class="section-divider">決策變數</div>' +
      '<div class="table-scroll"><table class="data-table"><thead><tr><th>變數</th><th class="num">數值</th><th>類型</th></tr></thead><tbody>' + varRows + '</tbody></table></div>' +
      '<div class="section-divider">各目標達成情形</div>' +
      '<div class="table-scroll"><table class="data-table"><thead><tr><th>目標</th><th class="num">實際值</th><th class="num">目標值</th>' +
      '<th class="num">d<sup>−</sup> 不足</th><th class="num">d<sup>+</sup> 超額</th><th>狀態</th></tr></thead><tbody>' + goalRows + '</tbody></table></div>' +
      '<div class="section-divider">各優先層結果</div>' +
      '<div class="table-scroll"><table class="data-table"><thead><tr><th>優先順序</th><th>最小化</th><th class="num">最小偏離值</th><th>狀態</th></tr></thead><tbody>' + levelRows + '</tbody></table></div>' +
      hardBlock +
      '<div class="section-divider">管理意涵</div><div class="notes">' + notes + '</div>' +
      '</div>'
    );
  }

  function xText(result, values) {
    return values
      .slice(0, result.varNames.length)
      .map(function (amount, index) {
        return result.varNames[index] + ' = ' + fmtGrouped(amount);
      })
      .join('，');
  }

  function renderStepsView(result) {
    var items = result.steps
      .map(function (step, index) {
        var title = step.level ? step.level.name + '：' + step.objectiveText : step.objectiveText;
        return (
          '<li class="goal-step">' +
          '<div class="goal-step-no">第 ' + (index + 1) + ' 次求解</div>' +
          '<div class="goal-step-body">' +
          '<div class="goal-step-title">' + esc(title) + '</div>' +
          '<div class="goal-step-line">最佳值 <b>' + fmtGrouped(step.optimum) + '</b>' +
          (step.level
            ? (step.optimum.isZero() ? '（完全達成）' : '（無法降到 0）')
            : '') + '</div>' +
          (step.added
            ? '<div class="goal-step-line">' +
              (index < result.steps.length - 1
                ? '鎖定為新增限制式：<code>' + esc(step.added) + '</code>，再進行下一次求解'
                : '鎖定：<code>' + esc(step.added) + '</code>（最後一層，求解完成）') +
              '</div>'
            : '') +
          '<div class="goal-step-line muted">此時的解：' + esc(xText(result, step.values)) +
          (step.nodes ? '（分支定界 ' + step.nodes + ' 個節點）' : '') + '</div>' +
          '</div></li>'
        );
      })
      .join('');
    return (
      '<div class="view">' +
      '<div class="view-head"><h3 class="view-title">逐層求解過程</h3>' +
      '<span class="view-desc">相當於講義的 Excel Solver 程序：先解最高優先層，把最佳值鎖成限制式，再解下一層。</span></div>' +
      renderWarnings(result) +
      '<ol class="goal-steps">' + items + '</ol>' +
      '<div class="callout"><div class="callout-title">為什麼逐層求解會得到最滿意解？</div>' +
      'Preemptive Goal Programming 假設高優先目標遠比低優先目標重要：先找出第一優先目標的最佳成果並固定，' +
      '再在不犧牲它的前提下改善第二優先目標，依此逐層進行。</div>' +
      '</div>'
    );
  }

  function renderModelView() {
    var devLines = gs.spec.goals
      .map(function (goal, index) {
        return (
          '<tr><td class="strong">G' + (index + 1) + '　' + esc(goalName(index)) + '</td>' +
          '<td>' + GP.devHTML(index, '-') + ' = 不足量</td><td>' + GP.devHTML(index, '+') + ' = 超額量</td>' +
          '<td>' + penaltyDescription(goal) + '</td></tr>'
        );
      })
      .join('');
    return (
      '<div class="view">' +
      '<div class="view-head"><h3 class="view-title">完整目標規劃模式</h3>' +
      '<span class="view-desc">目標函數只最小化管理者「不希望發生」的偏離量；所有目標都寫成等式。</span></div>' +
      '<div class="model-sheet"><div class="goal-model-big">' + GP.modelHTML(gs.spec) + '</div>' +
      '<div class="model-sheet-actions"><button type="button" class="btn btn-quiet btn-small" data-g-copy>複製模型文字</button></div></div>' +
      '<div class="section-divider">離差變數與優先順序</div>' +
      '<div class="table-scroll"><table class="data-table"><thead><tr><th>目標</th><th>不足</th><th>超額</th><th>最小化</th></tr></thead><tbody>' + devLines + '</tbody></table></div>' +
      '</div>'
    );
  }

  function penaltyDescription(goal) {
    var pieces = [];
    var index = gs.spec.goals.indexOf(goal);
    [['-', goal.under], ['+', goal.over]].forEach(function (pair) {
      if (pair[1].p !== '') {
        var weight = pair[1].w && pair[1].w !== '1' ? '，權重 ' + esc(pair[1].w) : '';
        pieces.push('P' + esc(pair[1].p) + '：' + GP.devHTML(index, pair[0]) + weight);
      }
    });
    return pieces.length ? pieces.join('<br>') : '<span class="muted">（不最小化）</span>';
  }

  function renderProblem(result) {
    var title = result.status === 'invalid' || result.status === 'error' ? '請修正下列輸入' : '無法完成求解';
    var lines = (result.errors || [result.message || ''])
      .map(function (text) {
        return '<li>' + esc(text) + '</li>';
      })
      .join('');
    return (
      '<div class="view"><div class="callout is-error"><div class="callout-title">' + title + '</div>' +
      '<ul class="goal-error-list">' + lines + '</ul></div></div>'
    );
  }

  function renderBody() {
    var body = qs('#goal-result-body');
    var result = gs.result;
    if (!result) {
      body.innerHTML = '';
      return;
    }
    if (result.status === 'invalid' || result.status === 'error') {
      body.innerHTML = renderProblem(result);
      return;
    }
    if (result.status === 'infeasible' || result.status === 'unbounded') {
      body.innerHTML =
        '<div class="view"><div class="callout is-error"><div class="callout-title">' +
        (result.status === 'infeasible' ? '無可行解' : '目標函數無界') + '</div>' + esc(result.message || '') + '</div>' +
        renderWarnings(result) + '</div>';
      return;
    }
    if (gs.view === 'steps') {
      body.innerHTML = renderStepsView(result);
    } else if (gs.view === 'model') {
      body.innerHTML = renderModelView();
    } else {
      body.innerHTML = renderSolutionView(result);
    }
  }

  function renderTabs() {
    qsa('#goal-tabs [data-gview]').forEach(function (button) {
      var active = button.getAttribute('data-gview') === gs.view;
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
  /* 求解                                                                  */
  /* --------------------------------------------------------------------- */

  function solveNow(manual) {
    var started = global.performance ? global.performance.now() : Date.now();
    try {
      gs.result = GP.solve(gs.spec);
    } catch (error) {
      gs.result = { ok: false, status: 'error', errors: ['求解時發生錯誤：' + error.message] };
    }
    var finished = global.performance ? global.performance.now() : Date.now();
    gs.solveMs = finished - started;
    renderResult();
    if (manual) {
      toast('已重新求解');
    }
  }

  function scheduleSolve() {
    clearTimeout(gs.timer);
    gs.timer = setTimeout(function () {
      solveNow(false);
    }, SOLVE_DELAY);
  }

  /** 每次編輯後：更新預覽、儲存、重新求解。 */
  function onEdit() {
    renderModelPreview();
    save();
    scheduleSolve();
  }

  /** 結構改變（新增／刪除／載入）：整塊重畫。 */
  function onStructureChange() {
    renderPanel();
    save();
    solveNow(false);
  }

  /* --------------------------------------------------------------------- */
  /* 編輯操作                                                              */
  /* --------------------------------------------------------------------- */

  function resizeVariables(count) {
    var spec = gs.spec;
    var target = Math.max(1, Math.min(GP.MAX_VARIABLES, count));
    while (spec.varNames.length < target) {
      spec.varNames.push('x' + (spec.varNames.length + 1));
      spec.integer.push(false);
      spec.hard.forEach(function (row) {
        row.a.push('0');
      });
      spec.goals.forEach(function (goal) {
        goal.a.push('0');
      });
    }
    while (spec.varNames.length > target) {
      spec.varNames.pop();
      spec.integer.pop();
      spec.hard.forEach(function (row) {
        row.a.pop();
      });
      spec.goals.forEach(function (goal) {
        goal.a.pop();
      });
    }
    gs.exampleId = null;
    onStructureChange();
  }

  function addGoal() {
    if (gs.spec.goals.length >= GP.MAX_GOALS) {
      toast('目標最多 ' + GP.MAX_GOALS + ' 個', 'error');
      return;
    }
    var defaults = GP.defaultPenalties('>=', gs.spec.goals.length + 1);
    gs.spec.goals.push({
      label: '',
      a: gs.spec.varNames.map(function () {
        return '0';
      }),
      dev: '',
      op: '>=',
      target: '0',
      under: defaults.under,
      over: defaults.over
    });
    gs.exampleId = null;
    onStructureChange();
  }

  function addHard() {
    if (gs.spec.hard.length >= GP.MAX_HARD) {
      toast('系統限制式最多 ' + GP.MAX_HARD + ' 條', 'error');
      return;
    }
    gs.spec.hard.push({
      label: '',
      a: gs.spec.varNames.map(function () {
        return '0';
      }),
      op: '<=',
      b: '0'
    });
    gs.exampleId = null;
    onStructureChange();
  }

  function loadExample(id) {
    var example = GP.examples.filter(function (item) {
      return item.id === id;
    })[0];
    if (!example) {
      return;
    }
    gs.spec = example.build();
    gs.exampleId = id;
    gs.view = 'solution';
    onStructureChange();
    var pane = qs('.pane-input');
    if (pane) {
      pane.scrollTop = 0;
    }
  }

  function applyOperator(goal, op) {
    /* 改變目標型態時，沿用目前最前面的優先順序數字，重設「要最小化哪個偏離量」 */
    var existing = [goal.under.p, goal.over.p].filter(function (value) {
      return value !== '';
    });
    var level = existing.length ? existing[0] : '1';
    var defaults = GP.defaultPenalties(op, level);
    goal.op = op;
    goal.under = defaults.under;
    goal.over = defaults.over;
  }

  function bindPanelEvents() {
    var host = qs('#panel-goal');

    host.addEventListener('input', function (event) {
      var target = event.target;
      var spec = gs.spec;
      var key;
      if (target.matches('[data-g-title]')) {
        spec.title = target.value;
        save();
        return;
      }
      if (target.matches('[data-g-var-name]')) {
        var nameIndex = Number(target.getAttribute('data-g-var-name'));
        spec.varNames[nameIndex] = target.value || 'x' + (nameIndex + 1);
        updateVariableLabels();
        onEdit();
        return;
      }
      if (target.matches('[data-g-coef]')) {
        key = target.getAttribute('data-g-coef').split('-');
        spec.goals[Number(key[0])].a[Number(key[1])] = target.value;
        markValid(target, isNumber(target.value));
        gs.exampleId = null;
        onEdit();
        return;
      }
      if (target.matches('[data-g-target]')) {
        spec.goals[Number(target.getAttribute('data-g-target'))].target = target.value;
        markValid(target, isNumber(target.value));
        onEdit();
        return;
      }
      if (target.matches('[data-g-label]')) {
        spec.goals[Number(target.getAttribute('data-g-label'))].label = target.value;
        onEdit();
        return;
      }
      if (target.matches('[data-g-dev]')) {
        var devIndex = Number(target.getAttribute('data-g-dev'));
        spec.goals[devIndex].dev = target.value;
        var parsed = GP.parseDeviationTerms(target.value, spec.goals.length);
        markValid(target, parsed.errors.length === 0);
        onEdit();
        return;
      }
      if (target.matches('[data-g-pen]')) {
        key = target.getAttribute('data-g-pen').split(':');
        var goal = spec.goals[Number(key[0])];
        var penalty = key[1] === '-' ? goal.under : goal.over;
        penalty[key[2]] = target.value;
        if (key[2] === 'p') {
          var okPriority = target.value.trim() === '' || /^[1-9]\d*$/.test(target.value.trim());
          markValid(target, okPriority);
          var cell = target.closest('.goal-pen-cell');
          if (cell) {
            cell.classList.toggle('is-on', target.value.trim() !== '');
          }
        } else {
          markValid(target, isNumber(target.value) && LPC.Frac.coerce(target.value).isPos());
        }
        onEdit();
        return;
      }
      if (target.matches('[data-g-h-coef]')) {
        key = target.getAttribute('data-g-h-coef').split('-');
        spec.hard[Number(key[0])].a[Number(key[1])] = target.value;
        markValid(target, isNumber(target.value));
        onEdit();
        return;
      }
      if (target.matches('[data-g-h-rhs]')) {
        spec.hard[Number(target.getAttribute('data-g-h-rhs'))].b = target.value;
        markValid(target, isNumber(target.value));
        onEdit();
        return;
      }
      if (target.matches('[data-g-h-label]')) {
        spec.hard[Number(target.getAttribute('data-g-h-label'))].label = target.value;
        onEdit();
      }
    });

    host.addEventListener('change', function (event) {
      var target = event.target;
      var spec = gs.spec;
      if (target.matches('[data-g-op]')) {
        applyOperator(spec.goals[Number(target.getAttribute('data-g-op'))], target.value);
        gs.exampleId = null;
        onStructureChange();
        return;
      }
      if (target.matches('[data-g-h-op]')) {
        spec.hard[Number(target.getAttribute('data-g-h-op'))].op = target.value;
        onEdit();
        return;
      }
      if (target.matches('[data-g-var-int]')) {
        spec.integer[Number(target.getAttribute('data-g-var-int'))] = target.checked;
        onEdit();
      }
    });

    host.addEventListener('click', function (event) {
      var target = event.target;
      var button;
      if ((button = target.closest('[data-g-example]'))) {
        loadExample(button.getAttribute('data-g-example'));
        return;
      }
      if (target.closest('[data-g-var-minus]')) {
        resizeVariables(gs.spec.varNames.length - 1);
        return;
      }
      if (target.closest('[data-g-var-plus]')) {
        resizeVariables(gs.spec.varNames.length + 1);
        return;
      }
      if (target.closest('[data-g-add-goal]')) {
        addGoal();
        return;
      }
      if (target.closest('[data-g-add-hard]')) {
        addHard();
        return;
      }
      if ((button = target.closest('[data-g-remove]'))) {
        gs.spec.goals.splice(Number(button.getAttribute('data-g-remove')), 1);
        gs.exampleId = null;
        onStructureChange();
        return;
      }
      if ((button = target.closest('[data-g-h-remove]'))) {
        gs.spec.hard.splice(Number(button.getAttribute('data-g-h-remove')), 1);
        gs.exampleId = null;
        onStructureChange();
        return;
      }
      if (target.closest('[data-g-reset]')) {
        gs.spec = GP.create({ varNames: ['x1', 'x2'], goals: [], hard: [] });
        gs.exampleId = null;
        onStructureChange();
        return;
      }
      if (target.closest('[data-g-copy]')) {
        copyModel();
        return;
      }
      if (target.closest('[data-g-json]')) {
        downloadJSON();
      }
    });
  }

  function updateVariableLabels() {
    qsa('#panel-goal .coef-var').forEach(function (node, position) {
      var perRow = gs.spec.varNames.length;
      node.innerHTML = variableInline(gs.spec.varNames[position % perRow]);
    });
  }

  function copyModel() {
    var text = (gs.spec.title ? gs.spec.title + '\n' : '') + GP.modelText(gs.spec);
    if (util().copyText) {
      util().copyText(text).then(function () {
        toast('已複製模型文字');
      });
    }
  }

  function downloadJSON() {
    if (util().download) {
      util().download('goal-programming-model.json', JSON.stringify(gs.spec, null, 2));
      toast('已下載 JSON');
    }
  }

  function bindResultEvents() {
    qsa('#goal-tabs [data-gview]').forEach(function (button) {
      button.addEventListener('click', function () {
        gs.view = button.getAttribute('data-gview');
        renderTabs();
        renderBody();
      });
    });
    qs('#goal-btn-solve').addEventListener('click', function () {
      solveNow(true);
    });
    qs('#goal-result-body').addEventListener('click', function (event) {
      if (event.target.closest('[data-g-copy]')) {
        copyModel();
      }
    });
  }

  /* --------------------------------------------------------------------- */
  /* 初始化                                                                */
  /* --------------------------------------------------------------------- */

  function init() {
    if (gs.ready || !qs('#panel-goal') || !qs('#goal-result')) {
      return;
    }
    gs.ready = true;
    var stored = load();
    if (stored) {
      gs.spec = stored;
    } else {
      gs.spec = GP.examples[0].build();
      gs.exampleId = GP.examples[0].id;
    }
    renderPanel();
    bindPanelEvents();
    bindResultEvents();
    solveNow(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  LPC.goalUI = {
    state: gs,
    solve: function (manual) {
      solveNow(manual !== false);
    },
    init: init
  };
})(typeof window !== 'undefined' ? window : globalThis);
