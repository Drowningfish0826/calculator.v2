/* ============================================================================
 * app.js — 介面控制、狀態管理與事件綁定
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = global.LPC;
  var modelLib = LPC.model;
  var views = LPC.views;
  var solver = LPC.solver;

  var STORAGE_MODEL = 'lpc.model.v1';
  var STORAGE_THEME = 'lpc.theme.v1';
  var DEBOUNCE_MS = 140;

  /* --------------------------------------------------------------------- */
  /* 小工具                                                                */
  /* --------------------------------------------------------------------- */

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function escapeHTML(text) {
    return modelLib.escapeHTML(text);
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var context = this;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(context, args);
      }, wait);
    };
  }

  function toast(message, kind) {
    var stack = qs('#toast-stack');
    if (!stack) {
      return;
    }
    var node = document.createElement('div');
    node.className = 'toast' + (kind === 'error' ? ' is-error' : '');
    node.textContent = message;
    stack.appendChild(node);
    setTimeout(function () {
      node.remove();
    }, 2600);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    var area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } catch (error) {
      /* 忽略：瀏覽器不支援時由上層提示 */
    }
    area.remove();
    return Promise.resolve();
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  /* --------------------------------------------------------------------- */
  /* 狀態                                                                  */
  /* --------------------------------------------------------------------- */

  var state = {
    mode: 'model',
    model: null,
    result: null,
    validation: null,
    activeView: 'solution',
    iterationIndex: null,
    isoLevel: null,
    autoSolve: true,
    source: null,
    templateId: null,
    templateDraft: null,
    nlResult: null,
    lastSolveMs: 0
  };

  var exampleCount = LPC.examples.length;

  /* --------------------------------------------------------------------- */
  /* 初始化                                                                */
  /* --------------------------------------------------------------------- */

  function init() {
    applyStoredTheme();

    var fromHash = readHashModel();
    var stored = fromHash || readStoredModel();
    state.model = stored || LPC.examples[1].build();
    if (fromHash) {
      state.source = { kind: 'link', label: '由分享連結載入的模型' };
    }

    renderInputs();
    renderSourceBanner();
    bindEvents();
    solveNow();
    renderModeChrome();
  }

  function readHashModel() {
    var hash = location.hash || '';
    var match = /[#&]m=([A-Za-z0-9\-_]+)/.exec(hash);
    if (!match) {
      return null;
    }
    var decoded = modelLib.decode(match[1]);
    return decoded;
  }

  function readStoredModel() {
    try {
      var raw = localStorage.getItem(STORAGE_MODEL);
      if (!raw) {
        return null;
      }
      var parsed = JSON.parse(raw);
      return modelLib.create(parsed);
    } catch (error) {
      return null;
    }
  }

  function persistModel() {
    try {
      localStorage.setItem(STORAGE_MODEL, JSON.stringify(state.model));
    } catch (error) {
      /* 無痕模式等情況忽略 */
    }
  }

  function applyStoredTheme() {
    var stored = null;
    try {
      stored = localStorage.getItem(STORAGE_THEME);
    } catch (error) {
      stored = null;
    }
    if (!stored) {
      var prefersDark = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches;
      stored = prefersDark ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', stored);
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', current);
    try {
      localStorage.setItem(STORAGE_THEME, current);
    } catch (error) {
      /* 忽略 */
    }
  }

  /* --------------------------------------------------------------------- */
  /* 左側輸入區                                                            */
  /* --------------------------------------------------------------------- */

  function renderInputs() {
    renderSense();
    renderMetaFields();
    renderVarTable();
    renderObjectiveInputs();
    renderConstraintList();
    renderModelPreview();
    updateVarLabels();
  }

  function renderSense() {
    qsa('[data-sense]').forEach(function (button) {
      var active = button.getAttribute('data-sense') === state.model.sense;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }

  function renderMetaFields() {
    var meta = state.model.meta || {};
    qs('#objective-label').value = meta.objectiveLabel || '';
    qs('#objective-unit').value = meta.objectiveUnit || '';
    qs('#nonneg').checked = state.model.nonNeg !== false;
  }

  function renderVarTable() {
    var body = qs('#var-body');
    body.innerHTML = state.model.varNames
      .map(function (name, index) {
        return (
          '<tr>' +
          '<td>' + (index + 1) + '</td>' +
          '<td><input class="input" type="text" data-var-name="' + index + '" value="' + escapeHTML(name) +
          '" aria-label="第 ' + (index + 1) + ' 個變數的名稱" autocomplete="off"></td>' +
          '<td><input type="checkbox" class="check" data-var-int="' + index + '"' +
          (state.model.integer[index] || state.model.binary[index] ? ' checked' : '') +
          ' aria-label="' + escapeHTML(name) + ' 限制為整數"></td>' +
          '<td><input type="checkbox" class="check" data-var-bin="' + index + '"' +
          (state.model.binary[index] ? ' checked' : '') + ' aria-label="' + escapeHTML(name) + ' 限制為 0 或 1"></td>' +
          '</tr>'
        );
      })
      .join('');
    qs('#var-count').textContent = String(state.model.varNames.length);
    qs('#var-minus').disabled = state.model.varNames.length <= 1;
    qs('#var-plus').disabled = state.model.varNames.length >= modelLib.MAX_MANUAL_VARIABLES;
  }

  function renderObjectiveInputs() {
    var wrap = qs('#objective-inputs');
    wrap.innerHTML = state.model.varNames
      .map(function (name, index) {
        return (
          '<label class="coef-cell">' +
          '<input class="input input-num" type="text" inputmode="decimal" data-obj="' + index +
          '" value="' + escapeHTML(String(state.model.c[index])) + '" aria-label="' + escapeHTML(name) + ' 的目標係數" autocomplete="off">' +
          '<span class="coef-var" data-var-label="' + index + '">' + variableInline(name) + '</span>' +
          '</label>'
        );
      })
      .join('');
  }

  function variableInline(name) {
    var base = escapeHTML(String(name).replace(/[0-9]+$/, ''));
    var digits = /([0-9]+)$/.exec(String(name));
    return base + (digits ? '<sub>' + digits[1] + '</sub>' : '');
  }

  function renderConstraintList() {
    var list = qs('#constraint-list');
    var count = state.model.constraints.length;
    if (!count) {
      list.innerHTML =
        '<div class="callout"><div class="callout-title">還沒有任何限制式</div>' +
        '沒有資源上限或需求下限時，線性規劃通常會得到無界解。點下面的「新增限制式」開始建立模型。</div>';
      return;
    }
    list.innerHTML = state.model.constraints
      .map(function (constraint, rowIndex) {
        var cells = state.model.varNames
          .map(function (name, index) {
            return (
              '<span class="expr-cell">' +
              '<input class="input input-coef" type="text" inputmode="decimal" data-con-coef="' + rowIndex + '-' + index +
              '" value="' + escapeHTML(String(constraint.a[index])) + '" aria-label="第 ' + (rowIndex + 1) + ' 條限制式中 ' +
              escapeHTML(name) + ' 的係數" autocomplete="off">' +
              '<span class="coef-var" data-var-label="' + index + '">' + variableInline(name) + '</span>' +
              '</span>'
            );
          })
          .join('');
        return (
          '<div class="constraint">' +
          '<div class="constraint-head">' +
          '<span class="constraint-index">(' + (rowIndex + 1) + ')</span>' +
          '<input class="input constraint-label" type="text" data-con-label="' + rowIndex + '" value="' +
          escapeHTML(constraint.label || '') + '" placeholder="這條限制式的名稱（例：人力上限）" aria-label="第 ' +
          (rowIndex + 1) + ' 條限制式的名稱" autocomplete="off">' +
          '<button type="button" class="btn btn-icon btn-danger-quiet" data-remove-con="' + rowIndex +
          '" aria-label="刪除第 ' + (rowIndex + 1) + ' 條限制式" title="刪除">✕</button>' +
          '</div>' +
          '<div class="constraint-body">' +
          cells +
          '<select class="select constraint-op" data-con-op="' + rowIndex + '" aria-label="第 ' + (rowIndex + 1) + ' 條限制式的關係符號">' +
          '<option value="<="' + (constraint.op === '<=' ? ' selected' : '') + '>≤</option>' +
          '<option value="="' + (constraint.op === '=' ? ' selected' : '') + '>=</option>' +
          '<option value=">="' + (constraint.op === '>=' ? ' selected' : '') + '>≥</option>' +
          '</select>' +
          '<input class="input input-num constraint-rhs" type="text" inputmode="decimal" data-con-rhs="' + rowIndex +
          '" value="' + escapeHTML(String(constraint.b)) + '" aria-label="第 ' + (rowIndex + 1) + ' 條限制式的右端值" autocomplete="off">' +
          '</div>' +
          '</div>'
        );
      })
      .join('');
  }

  function updateVarLabels() {
    qsa('[data-var-label]').forEach(function (node) {
      var index = Number(node.getAttribute('data-var-label'));
      node.innerHTML = variableInline(state.model.varNames[index] || 'x' + (index + 1));
    });
    qsa('[data-var-name]').forEach(function (input) {
      var index = Number(input.getAttribute('data-var-name'));
      input.setAttribute('aria-label', '第 ' + (index + 1) + ' 個變數的名稱');
    });
  }

  function renderModelPreview() {
    qs('#model-preview').innerHTML = modelLib.modelHTML(state.model);
    if (!state.model.constraints.length) {
      qs('#objective-preview').innerHTML = modelLib.objectiveHTML(state.model, { withCount: true });
    } else {
      qs('#objective-preview').innerHTML = modelLib.objectiveHTML(state.model, { withCount: true });
    }
  }

  function renderModelPreviewObjective() {
    qs('#objective-preview').innerHTML = modelLib.objectiveHTML(state.model, { withCount: true });
  }

  /* --------------------------------------------------------------------- */
  /* 求解                                                                  */
  /* --------------------------------------------------------------------- */

  function solveNow() {
    var validation = modelLib.validate(state.model);
    state.validation = validation;

    if (!validation.ok) {
      state.result = null;
      renderResultHeader();
      renderResultBody();
      setStatus('模型尚未完成', 'is-warn');
      return;
    }

    var input = modelLib.toSolverInput(state.model);
    var needsInteger = input.integer.some(Boolean) || input.binary.some(Boolean);
    var record = state.model.varNames.length <= 6 && state.model.constraints.length <= 9;
    var started = performance.now();
    var result;
    try {
      result = needsInteger
        ? solver.solveInteger(input, { record: false, nodeLimit: 5000 })
        : solver.solveLP(input, { record: record });
    } catch (error) {
      result = { ok: false, status: 'iteration-limit', message: error.message };
    }
    state.lastSolveMs = Math.round(performance.now() - started);
    state.result = result;
    state.iterationIndex = null;

    if (result && result.status === 'optimal' && state.activeView === 'graph') {
      state.isoLevel = Number(result.z);
    }

    persistModel();
    renderResultHeader();
    renderResultBody();
    renderStatusLine();
  }

  var scheduleSolve = debounce(solveNow, DEBOUNCE_MS);

  function onModelEdit() {
    renderModelPreviewObjective();
    renderModelPreview();
    renderSourceBanner();
    if (state.autoSolve) {
      scheduleSolve();
    } else {
      setStatus('已修改，按「求解」更新結果', 'is-warn');
    }
  }

  /* --------------------------------------------------------------------- */
  /* 右側結果                                                              */
  /* --------------------------------------------------------------------- */

  function setStatus(text, tone) {
    var node = qs('#solve-status');
    if (!node) {
      return;
    }
    var dotClass = 'status-dot' + (tone === 'is-warn' ? ' is-warn' : tone === 'is-error' ? ' is-error' : '');
    node.innerHTML = '<span class="' + dotClass + '"></span>' + escapeHTML(text);
  }

  function renderStatusLine() {
    if (!state.result) {
      return;
    }
    if (state.result.status === 'optimal') {
      var parts = ['已求得最佳解'];
      if (state.result.integer) {
        parts.push('分支定界 ' + (state.result.nodes || 0) + ' 節點');
      } else if ((state.result.iterations || []).length) {
        parts.push(state.result.iterations.length + ' 張單純形表');
      } else {
        parts.push('單純形法（未保留逐表過程）');
      }
      parts.push('精確運算 ' + state.lastSolveMs + ' ms');
      setStatus(parts.join(' · '));
    } else if (state.result.status === 'infeasible') {
      setStatus('無可行解', 'is-error');
    } else if (state.result.status === 'unbounded') {
      setStatus('無界解', 'is-warn');
    } else if (state.result.status === 'empty-model') {
      setStatus('模型尚未完成', 'is-warn');
    } else {
      setStatus('求解失敗', 'is-error');
    }
  }

  function renderResultHeader() {
    renderResultHeaderContent();
    updateMobileBar();
  }

  function updateMobileBar() {
    var label = qs('#mobile-bar-label');
    var value = qs('#mobile-bar-value');
    if (!label || !value) {
      return;
    }
    var info = modelLib.metaOf(state.model);
    var result = state.result;
    if (result && result.status === 'optimal') {
      label.textContent = info.objectiveLabel + ' Z*';
      value.textContent =
        modelLib.fmtGrouped(result.z) + (info.objectiveUnit ? ' ' + info.objectiveUnit : '');
      return;
    }
    if (result && result.status === 'infeasible') {
      label.textContent = '求解結果';
      value.textContent = '無可行解';
      return;
    }
    if (result && result.status === 'unbounded') {
      label.textContent = '求解結果';
      value.textContent = '無界解';
      return;
    }
    label.textContent = '模型狀態';
    value.textContent = '待修正';
  }

  function renderResultHeaderContent() {
    var verdictLabel = qs('#verdict-label');
    var verdictValue = qs('#verdict-value');
    var verdictSub = qs('#verdict-sub');
    var result = state.result;
    var info = modelLib.metaOf(state.model);

    verdictValue.classList.remove('is-muted', 'is-error');

    if (!result) {
      var errors = state.validation ? state.validation.errors : [];
      verdictLabel.textContent = '模型狀態';
      verdictValue.textContent = '待修正';
      verdictValue.classList.add('is-muted');
      verdictSub.innerHTML =
        errors.length
          ? '<span class="kv"><span class="k">需要處理</span><span class="v">' + errors.length + ' 項</span></span>'
          : '';
      return;
    }

    if (result.status === 'optimal') {
      verdictLabel.textContent = info.objectiveLabel + '（最佳值）';
      verdictValue.innerHTML =
        escapeHTML(modelLib.fmtGrouped(result.z)) +
        (info.objectiveUnit
          ? '<span style="font-size:0.42em;font-family:var(--font-sans);font-weight:400;color:var(--ink-3);margin-left:8px">' +
            escapeHTML(info.objectiveUnit) + '</span>'
          : '');
      var parts = result.varInfo
        .filter(function (variable) {
          return variable.value.isPos();
        })
        .slice(0, 5)
        .map(function (variable) {
          return (
            '<span class="kv"><span class="k">' + escapeHTML(modelLib.variableLabel(state.model, variable.index)) +
            '</span><span class="eq">=</span><span class="v">' + escapeHTML(modelLib.fmtGrouped(variable.value)) + '</span></span>'
          );
        });
      if (!parts.length) {
        parts.push('<span class="kv"><span class="k">所有變數</span><span class="eq">=</span><span class="v">0</span></span>');
      }
      var positiveCount = result.varInfo.filter(function (variable) {
        return variable.value.isPos();
      }).length;
      if (positiveCount > 5) {
        parts.push('<span class="kv"><span class="k">另有</span><span class="v">' + (positiveCount - 5) + ' 個正值</span></span>');
      }
      if (result.integer) {
        parts.push('<span class="kv"><span class="k">類型</span><span class="v">整數解</span></span>');
      }
      verdictSub.innerHTML = parts.join('');
      return;
    }

    if (result.status === 'infeasible') {
      verdictLabel.textContent = '求解結果';
      verdictValue.textContent = '無可行解';
      verdictValue.classList.add('is-error');
      verdictSub.innerHTML =
        '<span class="kv"><span class="k">原因</span><span class="v">限制式彼此衝突</span></span>';
      return;
    }

    if (result.status === 'unbounded') {
      verdictLabel.textContent = '求解結果';
      verdictValue.textContent = '無界解';
      verdictValue.classList.add('is-error');
      verdictSub.innerHTML =
        '<span class="kv"><span class="k">原因</span><span class="v">目標函數可無限改善</span></span>';
      return;
    }

    verdictLabel.textContent = '求解結果';
    verdictValue.textContent = result.message || '無法求解';
    verdictValue.classList.add('is-muted');
    verdictSub.innerHTML = '';
  }

  function renderResultBody() {
    var body = qs('#result-body');
    var result = state.result;
    updateTabsChrome();

    if (!result) {
      body.innerHTML = views.renderInvalid(state.validation ? state.validation.errors : []);
      return;
    }
    if (result.status === 'infeasible') {
      body.innerHTML = views.renderInfeasible(state.model, result);
      return;
    }
    if (result.status === 'unbounded') {
      body.innerHTML = views.renderUnbounded(state.model, result);
      return;
    }
    if (result.status === 'empty-model') {
      body.innerHTML = views.renderPending(
        '請先設定決策變數',
        '在最左側的「決策變數」區塊增加變數，並填入目標函數係數與限制式。'
      );
      return;
    }
    if (result.status !== 'optimal') {
      body.innerHTML = views.renderPending(
        '求解未完成',
        escapeHTML(result.message || '模型規模可能過大，請簡化後再試。')
      );
      return;
    }

    if (state.activeView === 'solution') {
      body.innerHTML = views.renderSolution(state.model, result);
    } else if (state.activeView === 'constraints') {
      body.innerHTML = views.renderConstraints(state.model, result);
    } else if (state.activeView === 'sensitivity') {
      body.innerHTML = views.renderSensitivity(state.model, result);
    } else if (state.activeView === 'graph') {
      body.innerHTML = views.renderGraph(state.model, result, { isoLevel: state.isoLevel });
      bindGraphControls();
    } else if (state.activeView === 'simplex') {
      body.innerHTML = views.renderSimplex(state.model, result, {
        iterationIndex: state.iterationIndex === null ? undefined : state.iterationIndex
      });
    } else if (state.activeView === 'integer') {
      body.innerHTML = views.renderInteger(state.model, result);
    }
    updateTabsChrome();
  }

  function updateTabsChrome() {
    var isInteger = !!(
      state.result &&
      state.result.status === 'optimal' &&
      (state.result.integer || state.model.integer.some(Boolean) || state.model.binary.some(Boolean))
    );
    var integerTab = qs('#tab-integer');
    var simplexTab = qs('[data-view="simplex"]');
    integerTab.hidden = !isInteger;
    if (simplexTab) {
      simplexTab.hidden = isInteger || state.model.varNames.length > 6;
    }
    var graphTab = qs('[data-view="graph"]');
    if (graphTab) {
      graphTab.hidden = state.model.varNames.length !== 2;
    }
  }

  function activateView(viewName) {
    state.activeView = viewName;
    qsa('.result-tabs [data-view]').forEach(function (button) {
      var active = button.getAttribute('data-view') === viewName;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderResultBody();
  }

  /* --------------------------------------------------------------------- */
  /* 圖形互動                                                              */
  /* --------------------------------------------------------------------- */

  function bindGraphControls() {
    var slider = qs('#iso-slider');
    if (!slider || !state.result) {
      return;
    }
    slider.addEventListener('input', function () {
      var value = Number(slider.value);
      state.isoLevel = value;
      var readout = qs('#iso-readout');
      if (readout) {
        readout.textContent = 'Z = ' + modelLib.fmtGrouped(value);
      }
      var frame = qs('.graph-frame');
      if (frame) {
        var rendered = LPC.graph.render({
          model: state.model,
          result: state.result,
          isoLevel: value,
          showIntegers: true
        });
        var svgHost = frame.querySelector('.graph-svg');
        if (svgHost) {
          var wrapper = document.createElement('div');
          wrapper.innerHTML = rendered.svg;
          svgHost.replaceWith(wrapper.firstChild);
        }
      }
    });
  }

  /* --------------------------------------------------------------------- */
  /* 模式切換                                                              */
  /* --------------------------------------------------------------------- */

  function renderModeChrome() {
    qsa('.mode-switch [data-mode]').forEach(function (button) {
      var active = button.getAttribute('data-mode') === state.mode;
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    qsa('.panel').forEach(function (panel) {
      var id = panel.id.replace('panel-', '');
      var active = id === state.mode;
      panel.classList.toggle('is-active', active);
      panel.hidden = !active;
    });
  }

  function switchMode(mode) {
    state.mode = mode;
    renderModeChrome();
    if (mode === 'library') {
      renderLibrary();
    }
    if (mode === 'text') {
      renderNlResult();
    }
  }

  /* --------------------------------------------------------------------- */
  /* 輸入事件                                                              */
  /* --------------------------------------------------------------------- */

  function bindEvents() {
    qsa('.mode-switch [data-mode]').forEach(function (button) {
      button.addEventListener('click', function () {
        switchMode(button.getAttribute('data-mode'));
      });
    });

    qsa('[data-sense]').forEach(function (button) {
      button.addEventListener('click', function () {
        state.model.sense = button.getAttribute('data-sense');
        renderSense();
        onModelEdit();
      });
    });

    qs('#objective-label').addEventListener('input', function (event) {
      state.model.meta.objectiveLabel = event.target.value;
      onModelEdit();
    });
    qs('#objective-unit').addEventListener('input', function (event) {
      state.model.meta.objectiveUnit = event.target.value;
      onModelEdit();
    });

    qs('#nonneg').addEventListener('change', function (event) {
      state.model.nonNeg = event.target.checked;
      onModelEdit();
    });

    qs('#var-minus').addEventListener('click', function () {
      resizeVariables(state.model.varNames.length - 1);
    });
    qs('#var-plus').addEventListener('click', function () {
      resizeVariables(state.model.varNames.length + 1);
    });

    qs('#add-constraint').addEventListener('click', function () {
      addConstraint();
    });

    qs('#clear-constraints').addEventListener('click', function () {
      if (!state.model.constraints.length) {
        return;
      }
      openDialog({
        title: '清除所有限制式？',
        body:
          '<p>這會移除全部 ' +
          state.model.constraints.length +
          ' 條限制式，目標函數與變數設定會保留。此操作無法復原。</p>',
        foot: [
          { label: '取消', className: 'btn btn-quiet', onClick: closeDialog },
          {
            label: '清除限制式',
            className: 'btn btn-primary',
            onClick: function () {
              state.model.constraints = [];
              renderConstraintList();
              onModelEdit();
              closeDialog();
              toast('已清除所有限制式');
            }
          }
        ]
      });
    });

    qs('#btn-solve').addEventListener('click', function () {
      solveNow();
      toast('已重新求解');
    });

    qs('#auto-solve').addEventListener('change', function (event) {
      state.autoSolve = event.target.checked;
      if (state.autoSolve) {
        solveNow();
      }
    });

    qs('#copy-model').addEventListener('click', function () {
      copyText(modelLib.modelText(state.model)).then(function () {
        toast('模型文字已複製');
      });
    });

    qs('#download-json').addEventListener('click', function () {
      download('lp-model.json', JSON.stringify(state.model, null, 2));
      toast('已下載模型 JSON');
    });

    qs('#source-banner-reset').addEventListener('click', function () {
      state.model = modelLib.create({
        sense: 'max',
        varNames: ['x1', 'x2'],
        c: ['0', '0'],
        constraints: [{ a: ['1', '0'], op: '<=', b: '10', label: '' }],
        meta: {}
      });
      state.source = null;
      renderInputs();
      renderSourceBanner();
      solveNow();
    });

    bindDelegatedInputs();
    bindResultTabs();
    bindTopbarDialogs();
    bindKeyboard();
    bindLibrary();
    bindTextMode();
  }

  function bindDelegatedInputs() {
    var paneInput = qs('.pane-input');

    paneInput.addEventListener('input', function (event) {
      var target = event.target;
      if (target.matches('[data-obj]')) {
        state.model.c[Number(target.getAttribute('data-obj'))] = target.value;
        markValid(target, isValidNumber(target.value));
        onModelEdit();
        return;
      }
      if (target.matches('[data-con-coef]')) {
        var coefKey = target.getAttribute('data-con-coef').split('-');
        state.model.constraints[Number(coefKey[0])].a[Number(coefKey[1])] = target.value;
        markValid(target, isValidNumber(target.value));
        onModelEdit();
        return;
      }
      if (target.matches('[data-con-rhs]')) {
        state.model.constraints[Number(target.getAttribute('data-con-rhs'))].b = target.value;
        markValid(target, isValidNumber(target.value));
        onModelEdit();
        return;
      }
      if (target.matches('[data-con-label]')) {
        state.model.constraints[Number(target.getAttribute('data-con-label'))].label = target.value;
        onModelEdit();
        return;
      }
      if (target.matches('[data-var-name]')) {
        var index = Number(target.getAttribute('data-var-name'));
        state.model.varNames[index] = target.value || 'x' + (index + 1);
        updateVarLabels();
        renderModelPreview();
        onModelEdit();
      }
    });

    paneInput.addEventListener('change', function (event) {
      var target = event.target;
      if (target.matches('[data-con-op]')) {
        state.model.constraints[Number(target.getAttribute('data-con-op'))].op = target.value;
        onModelEdit();
        return;
      }
      if (target.matches('[data-var-int]')) {
        var intIndex = Number(target.getAttribute('data-var-int'));
        state.model.integer[intIndex] = target.checked;
        if (target.checked) {
          state.model.binary[intIndex] = false;
          qs('[data-var-bin="' + intIndex + '"]').checked = false;
        }
        onModelEdit();
        return;
      }
      if (target.matches('[data-var-bin]')) {
        var binIndex = Number(target.getAttribute('data-var-bin'));
        state.model.binary[binIndex] = target.checked;
        if (target.checked) {
          state.model.integer[binIndex] = true;
          qs('[data-var-int="' + binIndex + '"]').checked = true;
        }
        onModelEdit();
      }
    });

    paneInput.addEventListener('click', function (event) {
      var removeButton = event.target.closest('[data-remove-con]');
      if (!removeButton) {
        return;
      }
      var index = Number(removeButton.getAttribute('data-remove-con'));
      state.model.constraints.splice(index, 1);
      renderConstraintList();
      onModelEdit();
    });
  }

  function isValidNumber(text) {
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

  function resizeVariables(count) {
    var target = Math.max(1, Math.min(modelLib.MAX_MANUAL_VARIABLES, count));
    var current = state.model.varNames.length;
    if (target === current) {
      return;
    }
    if (target > current) {
      for (var index = current; index < target; index += 1) {
        state.model.varNames.push('x' + (index + 1));
        state.model.c.push('0');
        state.model.integer.push(false);
        state.model.binary.push(false);
        state.model.constraints.forEach(function (constraint) {
          constraint.a.push('0');
        });
      }
    } else {
      state.model.varNames.length = target;
      state.model.c.length = target;
      state.model.integer.length = target;
      state.model.binary.length = target;
      state.model.constraints.forEach(function (constraint) {
        constraint.a.length = target;
      });
      if (state.model.meta.variableLabels) {
        state.model.meta.variableLabels.length = target;
      }
    }
    renderInputs();
    onModelEdit();
  }

  function addConstraint() {
    var zeros = state.model.varNames.map(function () {
      return '0';
    });
    state.model.constraints.push({
      a: zeros,
      op: '<=',
      b: '',
      label: ''
    });
    renderConstraintList();
    var inputs = qsa('[data-con-coef]');
    var last = qsa('[data-con-rhs]');
    if (last.length) {
      last[last.length - 1].focus();
    }
    void inputs;
    onModelEdit();
  }

  /* --------------------------------------------------------------------- */
  /* 結果分頁                                                              */
  /* --------------------------------------------------------------------- */

  function bindResultTabs() {
    qsa('.result-tabs [data-view]').forEach(function (button) {
      button.addEventListener('click', function () {
        activateView(button.getAttribute('data-view'));
      });
    });

    qs('#result-body').addEventListener('click', function (event) {
      var chip = event.target.closest('[data-iteration]');
      if (chip) {
        state.iterationIndex = Number(chip.getAttribute('data-iteration'));
        renderResultBody();
      }
    });
  }

  /* --------------------------------------------------------------------- */
  /* 例題、範本、文字建模                                                  */
  /* --------------------------------------------------------------------- */

  function bindTopbarDialogs() {
    qs('#btn-examples').addEventListener('click', openExamplesDialog);
    qs('#btn-share').addEventListener('click', openShareDialog);
    qs('#btn-export').addEventListener('click', openExportDialog);
    qs('#btn-help').addEventListener('click', openHelpDialog);
    qs('#btn-theme').addEventListener('click', toggleTheme);
    qs('#mobile-bar-jump').addEventListener('click', function () {
      var target = qs('.pane-result');
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    });
    qs('#dialog-close').addEventListener('click', closeDialog);
    qs('#dialog-backdrop').addEventListener('click', function (event) {
      if (event.target === qs('#dialog-backdrop')) {
        closeDialog();
      }
    });
  }

  function openExamplesDialog() {
    var items = LPC.examples
      .map(function (example, index) {
        return (
          '<button type="button" class="example-item" data-example="' + example.id + '">' +
          '<div class="example-name">' + escapeHTML(example.name) + '</div>' +
          '<div class="example-tagline">' + escapeHTML(example.tagline) + '</div>' +
          '<div class="example-tags">' +
          example.tags
            .map(function (tag) {
              return '<span class="example-tag">' + escapeHTML(tag) + '</span>';
            })
            .join('') +
          '</div></button>'
        );
      })
      .join('');
    openDialog({
      title: '例題庫（' + LPC.examples.length + ' 題）',
      body:
        '<p style="color:var(--ink-2);font-size:13px;margin-bottom:12px">' +
        '選一題載入，系統會直接帶入完整模型並求解。全部例題皆為管理數學課程常見題型。</p>' +
        '<div class="example-list">' + items + '</div>',
      foot: [{ label: '關閉', className: 'btn btn-quiet', onClick: closeDialog }],
      onMount: function (body) {
        qsa('[data-example]', body).forEach(function (button) {
          button.addEventListener('click', function () {
            var example = LPC.findExample(button.getAttribute('data-example'));
            if (!example) {
              return;
            }
            state.model = example.build();
            state.source = { kind: 'example', label: '例題：' + example.name };
            state.activeView = 'solution';
            renderInputs();
            renderSourceBanner();
            solveNow();
            switchMode('model');
            activateView('solution');
            closeDialog();
            toast('已載入「' + example.name + '」');
          });
        });
      }
    });
    void exampleCount;
  }

  function renderSourceBanner() {
    var banner = qs('#source-banner');
    if (!state.source) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    qs('#source-banner-text').textContent = state.source.label + '　（可繼續編輯）';
  }

  function openShareDialog() {
    var token = modelLib.encode(state.model);
    var url = location.origin + location.pathname + '#m=' + token;
    openDialog({
      title: '分享這個模型',
      body:
        '<p>底下的連結包含完整的模型設定（係數、限制式、變數型態），' +
        '貼給同學或組員就能直接開啟同一個題目。</p>' +
        '<div class="share-field">' +
        '<input class="input" id="share-url" readonly value="' + escapeHTML(url) + '">' +
        '</div>' +
        '<p style="font-size:12px;color:var(--ink-3);margin-top:8px">連結長度 ' + url.length + ' 字元。' +
        '若在沒有網路的情況下使用，請改用「匯出 → 下載 JSON」交換模型檔。</p>',
      foot: [
        { label: '關閉', className: 'btn btn-quiet', onClick: closeDialog },
        {
          label: '複製連結',
          className: 'btn btn-primary',
          onClick: function () {
            copyText(url).then(function () {
              toast('分享連結已複製');
              closeDialog();
            });
          }
        }
      ],
      onMount: function (body) {
        var input = qs('#share-url', body);
        if (input) {
          input.addEventListener('focus', function () {
            input.select();
          });
        }
      }
    });
  }

  function buildCsv() {
    if (!state.result || state.result.status !== 'optimal') {
      return '變數,最佳值\n';
    }
    var lines = ['變數,最佳值,減價成本'];
    state.result.varInfo.forEach(function (variable) {
      lines.push(
        [
          state.model.varNames[variable.index],
          modelLib.fmt(variable.value),
          modelLib.fmt(variable.reducedCost)
        ].join(',')
      );
    });
    lines.push('');
    lines.push('限制式,左側值,右側值,鬆弛或盈餘,是否緊束,影子價格');
    state.model.constraints.forEach(function (constraint, index) {
      var analysis = state.result.constraints[index];
      lines.push(
        [
          '"' + modelLib.constraintText(state.model, constraint).replace(/"/g, "'") + '"',
          modelLib.fmt(analysis.lhs),
          modelLib.fmt(analysis.rhs),
          modelLib.fmt(analysis.slack),
          analysis.binding ? '是' : '否',
          modelLib.fmt(analysis.shadow)
        ].join(',')
      );
    });
    return lines.join('\n');
  }

  function openExportDialog() {
    openDialog({
      title: '匯出與列印',
      body:
        '<h3>列印成 PDF 報告</h3>' +
        '<p>產生一頁式求解報告，內容包含數學模型、最佳解、限制式分析、敏感度與圖形。' +
        '在列印對話框中選擇「另存為 PDF」即可。</p>' +
        '<h3>下載資料</h3>' +
        '<p>JSON 檔可完整還原模型（可再匯入）；CSV 適合貼到 Excel 或報告中。</p>' +
        '<h3>複製</h3>' +
        '<p>可直接複製純文字的數學模型，貼到 Word 或報告裡。</p>',
      foot: [
        { label: '關閉', className: 'btn btn-quiet', onClick: closeDialog },
        {
          label: '複製模型文字',
          className: 'btn btn-outline',
          onClick: function () {
            copyText(modelLib.modelText(state.model)).then(function () {
              toast('模型文字已複製');
            });
          }
        },
        {
          label: '下載 CSV',
          className: 'btn btn-outline',
          onClick: function () {
            download('lp-solution.csv', '\ufeff' + buildCsv(), 'text/csv;charset=utf-8');
            toast('已下載 CSV');
          }
        },
        {
          label: '列印／存成 PDF',
          className: 'btn btn-primary',
          onClick: function () {
            printReport();
          }
        }
      ]
    });
  }

  function printReport() {
    var host = qs('#print-report');
    host.innerHTML = views.buildPrintReport(state.model, state.result);
    host.setAttribute('aria-hidden', 'false');
    closeDialog();
    setTimeout(function () {
      global.print();
    }, 120);
  }

  function openHelpDialog() {
    openDialog({
      title: '操作說明',
      body:
        '<h3>建立模型的順序</h3>' +
        '<ol>' +
        '<li><b>問題設定</b>：選擇最大化或最小化，必要時填寫目標名稱與單位（這些文字會出現在結果解讀中）。</li>' +
        '<li><b>決策變數</b>：設定變數個數；可個別勾選「整數」或「0-1」，系統會自動改用分支定界法。</li>' +
        '<li><b>目標函數</b>：填入每個變數的單位貢獻（可輸入分數，例如 <span class="kbd">7/3</span>）。</li>' +
        '<li><b>限制式</b>：設定係數、≤／=／≥ 與右端值；右端值可留白，系統視為 0。</li>' +
        '</ol>' +
        '<h3>結果分頁</h3>' +
        '<ul>' +
        '<li><b>最佳解</b>：決策組合與管理意涵（自動把數學結果翻譯成管理語言）。</li>' +
        '<li><b>限制分析</b>：每條限制式的用量、鬆弛量與是否成為瓶頸。</li>' +
        '<li><b>敏感度</b>：影子價格、右端與目標係數的允許範圍。</li>' +
        '<li><b>圖形</b>（兩變數）：可行區域、等利潤線；拖動滑桿可看到等利潤線平移。</li>' +
        '<li><b>單純形法</b>：逐張檢視 pivot 過程，適合對照課本驗算。</li>' +
        '</ul>' +
        '<h3>鍵盤快捷鍵</h3>' +
        '<div class="shortcut-list">' +
        '<span><span class="kbd">Ctrl</span> / <span class="kbd">⌘</span> + <span class="kbd">Enter</span></span><span>立即求解</span>' +
        '<span><span class="kbd">1</span> ~ <span class="kbd">6</span></span><span>切換結果分頁</span>' +
        '<span><span class="kbd">E</span></span><span>開啟例題庫</span>' +
        '<span><span class="kbd">T</span></span><span>切換深色模式</span>' +
        '<span><span class="kbd">?</span></span><span>顯示這份說明</span>' +
        '<span><span class="kbd">Esc</span></span><span>關閉對話框</span>' +
        '</div>' +
        '<h3>計算方式</h3>' +
        '<p>求解器以 BigInt 分數進行精確運算，因此影子價格與敏感度範圍不會出現浮點誤差；' +
        '例如 50/3 會顯示為 <b>50/3</b> 而不是 16.6667。</p>',
      foot: [{ label: '開始使用', className: 'btn btn-primary', onClick: closeDialog }]
    });
  }

  /* --------------------------------------------------------------------- */
  /* 對話框                                                                */
  /* --------------------------------------------------------------------- */

  var dialogState = { onClose: null };

  function openDialog(options) {
    var backdrop = qs('#dialog-backdrop');
    qs('#dialog-title').textContent = options.title || '';
    var body = qs('#dialog-body');
    body.innerHTML = options.body || '';
    var foot = qs('#dialog-foot');
    foot.innerHTML = '';
    (options.foot || []).forEach(function (action) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = action.className || 'btn btn-quiet';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      foot.appendChild(button);
    });
    backdrop.hidden = false;
    dialogState.onClose = options.onClose || null;
    if (options.onMount) {
      options.onMount(body);
    }
    var focusTarget = body.querySelector('input, button, select, textarea') || qs('#dialog-close');
    if (focusTarget) {
      setTimeout(function () {
        focusTarget.focus();
      }, 40);
    }
  }

  function closeDialog() {
    qs('#dialog-backdrop').hidden = true;
    if (dialogState.onClose) {
      dialogState.onClose();
      dialogState.onClose = null;
    }
  }

  /* --------------------------------------------------------------------- */
  /* 範本庫                                                                */
  /* --------------------------------------------------------------------- */

  function renderLibrary() {
    var host = qs('#library-cards');
    host.innerHTML = LPC.templates
      .map(function (template) {
        return (
          '<button type="button" class="template-card' +
          (state.templateId === template.id ? ' is-selected' : '') +
          '" data-template="' + template.id + '">' +
          '<div class="template-name">' + escapeHTML(template.name) +
          '<span class="template-sub">' + escapeHTML(template.subtitle) + '</span></div>' +
          '<div class="template-desc">' + escapeHTML(template.description) + '</div>' +
          '</button>'
        );
      })
      .join('');
    qsa('[data-template]', host).forEach(function (card) {
      card.addEventListener('click', function () {
        selectTemplate(card.getAttribute('data-template'));
      });
    });
    if (state.templateId) {
      var template = LPC.findTemplate(state.templateId);
      if (template) {
        renderTemplateForm(template);
      }
    }
  }

  function selectTemplate(id) {
    var template = LPC.findTemplate(id);
    if (!template) {
      return;
    }
    state.templateId = id;
    state.templateDraft = {
      rows: template.form.rows.map(function (name, index) {
        return { name: name, total: String(template.form.rowTotals[index]) };
      }),
      cols: template.form.cols.map(function (name, index) {
        return { name: name, total: String(template.form.colTotals[index]) };
      }),
      cells: template.form.cells.map(function (line) {
        return line.map(function (value) {
          return String(value);
        });
      })
    };
    renderLibrary();
    qs('#template-form-section').hidden = false;
    qs('#template-form-title').textContent = template.name + ' · 資料輸入';
    qs('#template-form-hint').textContent = template.form.cellLabel + '（可直接修改表格內容）';
  }

  function renderTemplateForm(template) {
    var draft = state.templateDraft;
    var section = qs('#template-form-section');
    section.hidden = false;
    var showTotals = template.id !== 'assignment';

    var head =
      '<tr><th class="corner">' + escapeHTML(template.form.cellLabel) + '</th>' +
      draft.cols
        .map(function (col, index) {
          return (
            '<th><input class="input input-name" data-col-name="' + index + '" value="' +
            escapeHTML(col.name) + '" aria-label="第 ' + (index + 1) + ' 個' + escapeHTML(template.form.colAxis.label) + '名稱"></th>'
          );
        })
        .join('') +
      (showTotals ? '<th class="row-total">' + escapeHTML(template.form.rowAxis.totalLabel) + '</th>' : '') +
      '</tr>';

    var totalRow = '';
    if (showTotals) {
      totalRow =
        '<tr><th class="corner">' + escapeHTML(template.form.colAxis.totalLabel) + '</th>' +
        draft.cols
          .map(function (col, index) {
            return (
              '<td class="col-total"><input class="input" data-col-total="' + index + '" value="' +
              escapeHTML(col.total) + '" aria-label="' + escapeHTML(col.name) + ' 的' +
              escapeHTML(template.form.colAxis.totalLabel) + '"></td>'
            );
          })
          .join('') +
        '<td class="col-total muted" id="col-total-sum">Σ</td></tr>';
    }

    var body = draft.rows
      .map(function (row, rowIndex) {
        return (
          '<tr>' +
          '<th class="row-head"><input class="input input-name" data-row-name="' + rowIndex + '" value="' +
          escapeHTML(row.name) + '" aria-label="第 ' + (rowIndex + 1) + ' 個' + escapeHTML(template.form.rowAxis.label) + '名稱"></th>' +
          draft.cols
            .map(function (col, colIndex) {
              return (
                '<td><input class="input" data-cell="' + rowIndex + '-' + colIndex + '" value="' +
                escapeHTML(String(draft.cells[rowIndex][colIndex] === undefined ? 0 : draft.cells[rowIndex][colIndex])) +
                '" aria-label="' + escapeHTML(row.name) + ' 到 ' + escapeHTML(col.name) + ' 的成本"></td>'
              );
            })
            .join('') +
          (showTotals
            ? '<td class="row-total"><input class="input" data-row-total="' + rowIndex + '" value="' +
              escapeHTML(row.total) + '" aria-label="' + escapeHTML(row.name) + ' 的' +
              escapeHTML(template.form.rowAxis.totalLabel) + '"></td>'
            : '') +
          '</tr>'
        );
      })
      .join('');

    qs('#template-form').innerHTML =
      '<div class="table-scroll"><table class="matrix-table"><thead>' + head + '</thead><tbody>' +
      totalRow + body + '</tbody></table></div>' +
      '<div class="matrix-hint">' +
      '<span>列：' + escapeHTML(template.form.rowAxis.label) + '；欄：' + escapeHTML(template.form.colAxis.label) + '</span>' +
      '<span id="matrix-balance"></span>' +
      '</div>' +
      '<div class="step-actions" style="margin-top:10px">' +
      '<button type="button" class="btn btn-small btn-outline" id="matrix-add-row">＋ 新增一列</button>' +
      '<button type="button" class="btn btn-small btn-outline" id="matrix-add-col">＋ 新增一欄</button>' +
      '<button type="button" class="btn btn-small btn-quiet" id="matrix-remove-row">移除最後一列</button>' +
      '<button type="button" class="btn btn-small btn-quiet" id="matrix-remove-col">移除最後一欄</button>' +
      '</div>';

    bindMatrixEvents(template);
    updateMatrixBalance(template);
  }

  function bindMatrixEvents() {
    var host = qs('#template-form');
    if (host.dataset.bound === 'true') {
      return;
    }
    host.dataset.bound = 'true';

    host.addEventListener('input', function (event) {
      var target = event.target;
      var draft = state.templateDraft;
      if (!draft) {
        return;
      }
      if (target.matches('[data-cell]')) {
        var cellKey = target.getAttribute('data-cell').split('-');
        draft.cells[Number(cellKey[0])][Number(cellKey[1])] = target.value;
      } else if (target.matches('[data-row-total]')) {
        draft.rows[Number(target.getAttribute('data-row-total'))].total = target.value;
      } else if (target.matches('[data-col-total]')) {
        draft.cols[Number(target.getAttribute('data-col-total'))].total = target.value;
      } else if (target.matches('[data-row-name]')) {
        draft.rows[Number(target.getAttribute('data-row-name'))].name = target.value;
      } else if (target.matches('[data-col-name]')) {
        draft.cols[Number(target.getAttribute('data-col-name'))].name = target.value;
      }
      updateMatrixBalance(LPC.findTemplate(state.templateId));
    });

    host.addEventListener('click', function (event) {
      var button = event.target.closest('button');
      if (!button || !button.id) {
        return;
      }
      var template = LPC.findTemplate(state.templateId);
      var draft = state.templateDraft;
      if (!template || !draft) {
        return;
      }
      if (button.id === 'matrix-add-row') {
        draft.rows.push({ name: 'R' + (draft.rows.length + 1), total: '0' });
        draft.cells.push(
          draft.cols.map(function () {
            return '0';
          })
        );
        renderTemplateForm(template);
      } else if (button.id === 'matrix-add-col') {
        draft.cols.push({ name: 'C' + (draft.cols.length + 1), total: '0' });
        draft.cells.forEach(function (line) {
          line.push('0');
        });
        renderTemplateForm(template);
      } else if (button.id === 'matrix-remove-row') {
        if (draft.rows.length <= 2) {
          toast('至少要保留兩列', 'error');
          return;
        }
        draft.rows.pop();
        draft.cells.pop();
        renderTemplateForm(template);
      } else if (button.id === 'matrix-remove-col') {
        if (draft.cols.length <= 2) {
          toast('至少要保留兩欄', 'error');
          return;
        }
        draft.cols.pop();
        draft.cells.forEach(function (line) {
          line.pop();
        });
        renderTemplateForm(template);
      }
    });
  }

  function updateMatrixBalance(template) {
    var node = qs('#matrix-balance');
    if (!node) {
      return;
    }
    var draft = state.templateDraft;
    if (template.id === 'assignment') {
      node.textContent = draft.rows.length + ' × ' + draft.cols.length + ' 指派組合';
      return;
    }
    var supply = draft.rows.reduce(function (sum, row) {
      return sum + (Number(row.total) || 0);
    }, 0);
    var demand = draft.cols.reduce(function (sum, col) {
      return sum + (Number(col.total) || 0);
    }, 0);
    var sumCell = qs('#col-total-sum');
    if (sumCell) {
      sumCell.textContent = 'Σ ' + demand;
    }
    if (template.id === 'transport') {
      node.textContent = supply === demand
        ? '供需平衡：' + supply + ' = ' + demand
        : '供需不平衡：供給 ' + supply + '、需求 ' + demand + '（系統會自動補虛擬列／欄）';
    } else {
      node.textContent = '資源 ' + draft.rows.length + ' 項、產品 ' + draft.cols.length + ' 項';
    }
  }

  function bindLibrary() {
    qs('#template-build').addEventListener('click', function () {
      var template = LPC.findTemplate(state.templateId);
      if (!template) {
        return;
      }
      var draft = state.templateDraft;
      var input = {
        rows: draft.rows.map(function (row) {
          return { name: row.name, total: row.total };
        }),
        cols: draft.cols.map(function (col) {
          return { name: col.name, total: col.total };
        }),
        cells: draft.cells
      };
      var built = template.build(input);
      state.model = built.model;
      state.source = {
        kind: 'template',
        label: '範本：' + template.name + '（' + draft.rows.length + ' × ' + draft.cols.length + '）'
      };
      state.activeView = 'solution';
      renderInputs();
      renderSourceBanner();
      solveNow();
      switchMode('model');
      activateView('solution');
      if (built.notes && built.notes.length) {
        toast(built.notes[0]);
      } else {
        toast('已建立模型並求解');
      }
    });

    qs('#template-cancel').addEventListener('click', function () {
      state.templateId = null;
      state.templateDraft = null;
      qs('#template-form-section').hidden = true;
      renderLibrary();
    });
  }

  /* --------------------------------------------------------------------- */
  /* 文字建模                                                              */
  /* --------------------------------------------------------------------- */

  function bindTextMode() {
    qsa('[data-sample]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var key = chip.getAttribute('data-sample');
        var input = qs('#nl-input');
        if (key === 'shorthand') {
          input.value =
            'max\n' +
            '利潤 30 50\n' +
            '人力 2 3 <= 120\n' +
            '原料 1 2 <= 80';
        } else {
          input.value = LPC.parser.SAMPLE_TEXTS[key] || '';
        }
        input.focus();
      });
    });

    qs('#nl-parse').addEventListener('click', function () {
      var text = qs('#nl-input').value;
      if (!text.trim()) {
        toast('請先輸入問題描述', 'error');
        return;
      }
      state.nlResult = LPC.parser.parse(text);
      renderNlResult();
    });
  }

  function renderNlResult() {
    var section = qs('#nl-result-section');
    if (!state.nlResult) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    var result = state.nlResult;
    var confidence = Math.round((result.confidence || 0) * 100);
    qs('#nl-confidence').innerHTML =
      '<span class="confidence-bar"><span>解析信心度 ' + confidence + '%</span>' +
      '<span class="confidence-track"><span class="confidence-fill' +
      (confidence < 70 ? ' is-low' : '') + '" style="width:' + confidence + '%"></span></span></span>';

    var findings = (result.findings || [])
      .map(function (finding) {
        return (
          '<div class="parse-finding"><div class="k">' + escapeHTML(finding.label) + '</div>' +
          '<div class="v">' + escapeHTML(String(finding.value)) + '</div></div>'
        );
      })
      .join('');

    var warnings = (result.warnings || []).length
      ? '<div class="callout is-warn"><div class="callout-title">需要人工確認</div><ul style="margin:6px 0 0;padding-left:20px">' +
        result.warnings
          .map(function (warning) {
            return '<li>' + escapeHTML(warning) + '</li>';
          })
          .join('') +
        '</ul></div>'
      : '';

    var preview = result.model
      ? '<div class="section-divider">解析出的模型</div><div class="model-sheet"><div class="mathblock">' +
        modelLib.modelHTML(result.model) +
        '</div></div>'
      : '';

    qs('#nl-result').innerHTML =
      '<div class="parse-findings">' + findings + '</div>' +
      warnings +
      preview +
      (result.model
        ? '<div class="step-actions" style="margin-top:16px">' +
          '<button type="button" class="btn btn-primary" id="nl-apply">套用到模型並求解</button>' +
          '<button type="button" class="btn btn-quiet" id="nl-copy">複製模型文字</button>' +
          '</div>' +
          '<p style="font-size:12px;color:var(--ink-3);margin-top:8px">' +
          (result.mode === 'shorthand'
            ? '速記格式：第一行為 max／min，第二行為「目標名稱 + 各變數係數」，其餘每行為「名稱 + 係數 + 關係符號 + 右端值」。'
            : '自然語言解析為規則式推論，僅抽取常見句型；若數值有誤，套用後可直接在左側表單修改。') +
          '</p>'
        : '');

    var applyButton = qs('#nl-apply');
    if (applyButton) {
      applyButton.addEventListener('click', function () {
        state.model = result.model;
        state.source = { kind: 'text', label: '文字建模解析結果' };
        renderInputs();
        renderSourceBanner();
        solveNow();
        switchMode('model');
        activateView('solution');
        toast('已套用解析結果');
      });
    }
    var copyButton = qs('#nl-copy');
    if (copyButton) {
      copyButton.addEventListener('click', function () {
        copyText(modelLib.modelText(result.model)).then(function () {
          toast('模型文字已複製');
        });
      });
    }
  }

  /* --------------------------------------------------------------------- */
  /* 鍵盤                                                                  */
  /* --------------------------------------------------------------------- */

  function bindKeyboard() {
    document.addEventListener('keydown', function (event) {
      var target = event.target;
      var typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);

      if (event.key === 'Escape') {
        if (!qs('#dialog-backdrop').hidden) {
          closeDialog();
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        solveNow();
        toast('已重新求解');
        return;
      }
      if (typing) {
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        openHelpDialog();
        return;
      }
      if (event.key === 'e' || event.key === 'E') {
        openExamplesDialog();
        return;
      }
      if (event.key === 't' || event.key === 'T') {
        toggleTheme();
        return;
      }
      var index = Number(event.key);
      if (index >= 1 && index <= 6) {
        var buttons = qsa('.result-tabs [data-view]').filter(function (button) {
          return !button.hidden;
        });
        if (buttons[index - 1]) {
          activateView(buttons[index - 1].getAttribute('data-view'));
        }
      }
    });

    global.addEventListener('afterprint', function () {
      qs('#print-report').innerHTML = '';
      qs('#print-report').setAttribute('aria-hidden', 'true');
    });
  }

  /* --------------------------------------------------------------------- */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  LPC.app = {
    state: state,
    solveNow: solveNow,
    renderInputs: renderInputs
  };
})(typeof window !== 'undefined' ? window : globalThis);
