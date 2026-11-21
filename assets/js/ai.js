/* ============================================================================
 * ai.js — 文字建模的「AI 解析」（選用功能，使用者自備 Claude API 金鑰）
 * ----------------------------------------------------------------------------
 * 分工原則：AI 只負責「讀懂題目、轉成模型」，求解仍交給本機的精確分數求解器。
 *   1. 以 tool use 強制 Claude 回傳固定格式的 JSON（submit_model 工具）
 *   2. 本機嚴格驗證：數字、長度、關係符號、網路節點……任何一項不合格就不套用
 *   3. 轉成與規則引擎相同的結果格式 { ok, mode, model, network?, findings, warnings, confidence }
 * 金鑰只存在使用者自己的瀏覽器（預設只保留到分頁關閉），不會寫進程式碼或上傳到 GitHub。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});
  var Frac = LPC.Frac;
  var modelLib = LPC.model;

  var API_URL = 'https://api.anthropic.com/v1/messages';
  var API_VERSION = '2023-06-01';
  var STORAGE_KEY = 'lpc.ai.v1';
  var TIMEOUT_MS = 60000;

  var MODELS = [
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', note: '快速便宜・建議' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: '較準確' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: '最強・較貴' }
  ];
  var DEFAULT_MODEL = MODELS[0].id;

  /* --------------------------------------------------------------------- */
  /* 設定（金鑰、模型）                                                    */
  /* --------------------------------------------------------------------- */

  var memory = { key: '', model: DEFAULT_MODEL, remember: false };

  function storageFor(remember) {
    try {
      return remember ? global.localStorage : global.sessionStorage;
    } catch (error) {
      return null;
    }
  }

  function loadSettings() {
    var stores = [storageFor(true), storageFor(false)];
    for (var index = 0; index < stores.length; index += 1) {
      try {
        var raw = stores[index] && stores[index].getItem(STORAGE_KEY);
        if (raw) {
          var data = JSON.parse(raw);
          memory = {
            key: String(data.key || ''),
            model: String(data.model || DEFAULT_MODEL),
            remember: index === 0
          };
          return getSettings();
        }
      } catch (error) {
        /* 讀不到就用預設值 */
      }
    }
    return getSettings();
  }

  function getSettings() {
    return { key: memory.key, model: memory.model, remember: memory.remember };
  }

  function saveSettings(settings) {
    memory = {
      key: String(settings.key || '').trim(),
      model: String(settings.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
      remember: Boolean(settings.remember)
    };
    [true, false].forEach(function (remember) {
      var store = storageFor(remember);
      try {
        if (store) {
          store.removeItem(STORAGE_KEY);
        }
      } catch (error) {
        /* 忽略 */
      }
    });
    var target = storageFor(memory.remember);
    try {
      if (target && memory.key) {
        target.setItem(STORAGE_KEY, JSON.stringify({ key: memory.key, model: memory.model }));
      }
    } catch (error) {
      /* 無痕模式等情況：只留在記憶體 */
    }
    return getSettings();
  }

  function clearSettings() {
    return saveSettings({ key: '', model: memory.model, remember: false });
  }

  function isConfigured() {
    return /^sk-/.test(memory.key) || memory.key.length > 20;
  }

  function maskKey(key) {
    var text = String(key || '');
    if (text.length <= 10) {
      return text ? '••••' : '';
    }
    return text.slice(0, 7) + '…' + text.slice(-4);
  }

  /* --------------------------------------------------------------------- */
  /* 提示詞與工具格式                                                      */
  /* --------------------------------------------------------------------- */

  var SYSTEM_PROMPT = [
    '你是管理科學／作業研究的建模助手。使用者會用中文（偶爾夾雜英文）描述一個最佳化問題，',
    '你的工作是把它轉成線性規劃模型或網路模型，並且只能呼叫 submit_model 工具回答。你只負責建模，不要求解。',
    '',
    '一般線性規劃（kind = "lp"）：',
    '- variables 依題目出現順序列出每個決策變數，label 用題目中的名稱（例如「產品 A」「桌子」）。',
    '- objective 為各變數的目標係數，長度必須等於變數數；sense 為 "max" 或 "min"。',
    '- 每條限制式的 coefficients 長度必須等於變數數，沒用到的變數填 0。',
    '- 關係符號：最多／不超過／上限／可用／預算 → "<="；至少／不少於／下限／需求須滿足 → ">="；恰好／等於 → "="。',
    '- 不要把「變數 ≥ 0」寫成限制式（系統會自動加上）。單一變數的上下限（例如 A 至少生產 10 件）要寫成限制式。',
    '- 比例或比較條件（例如「A 的產量不超過 B 的 2 倍」→ A − 2B ≤ 0）要移項成標準形式。',
    '- 數字保持題目的原始單位；若題目給售價與成本而目標是利潤，請自行相減並在 assumptions 說明。',
    '- 題目要求整數或不可分割 → integer = true；「是否選擇／投資」這類決策 → binary = true。',
    '',
    '網路模型（kind = "network"，填 network 欄位，variables／objective／constraints 留空陣列）：',
    '- type：轉運問題 "transship"、最短路徑 "shortest"、最大流量 "maxflow"。',
    '- 轉運問題的 nodes 要標 role（supply／transship／demand）與 amount（供應量或需求量）。',
    '- 最短路徑與最大流量要填 source 與 sink（節點名稱）。',
    '- arcs 的 value 為成本、距離或容量；反方向也能走時把反向數值填在 reverse，只能單向時不要填 reverse。',
    '  最短路徑若題目說是無方向（雙向）道路，reverse 填與 value 相同的數字。',
    '',
    '共同規則：',
    '- 題目缺少的數字先填 0，並在 questions 用一句話說明缺了什麼。',
    '- 你做的任何推論或假設（例如把「工時」視為人力）都寫進 assumptions，每點一句、使用繁體中文。',
    '- 若題目無法用線性規劃或上述網路模型表示，kind 填 "unsupported"，並在 questions 說明原因。',
    '- confidence 填 0 到 1：題目資訊完整且無歧義時接近 1，需要猜測時降低。'
  ].join('\n');

  var NUMBER_ARRAY = { type: 'array', items: { type: 'number' } };

  var TOOL = {
    name: 'submit_model',
    description: '回傳由題目建立的線性規劃模型或網路模型（只建模、不求解）。',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['lp', 'network', 'unsupported'], description: '模型種類' },
        title: { type: 'string', description: '題目的簡短名稱' },
        sense: { type: 'string', enum: ['max', 'min'] },
        objective_label: { type: 'string', description: '目標的名稱，例如「總利潤」「總成本」' },
        objective_unit: { type: 'string', description: '目標的單位，例如「元」「千元」' },
        variables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              unit: { type: 'string' },
              integer: { type: 'boolean' },
              binary: { type: 'boolean' }
            },
            required: ['label']
          }
        },
        objective: NUMBER_ARRAY,
        constraints: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '限制式名稱，例如「人力」「A 產量下限」' },
              coefficients: NUMBER_ARRAY,
              op: { type: 'string', enum: ['<=', '>=', '='] },
              rhs: { type: 'number' },
              unit: { type: 'string' }
            },
            required: ['label', 'coefficients', 'op', 'rhs']
          }
        },
        network: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['transship', 'shortest', 'maxflow'] },
            unit: { type: 'string' },
            nodes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  role: { type: 'string', enum: ['supply', 'transship', 'demand'] },
                  amount: { type: 'number' }
                },
                required: ['name']
              }
            },
            arcs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  value: { type: 'number' },
                  reverse: { type: 'number', description: '反方向的數值；只能單向時省略這個欄位' }
                },
                required: ['from', 'to', 'value']
              }
            },
            source: { type: 'string' },
            sink: { type: 'string' }
          }
        },
        assumptions: { type: 'array', items: { type: 'string' } },
        questions: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number', minimum: 0, maximum: 1 }
      },
      required: ['kind', 'assumptions', 'questions', 'confidence']
    }
  };

  function buildRequest(text, settings) {
    return {
      model: (settings && settings.model) || DEFAULT_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: String(text) }]
    };
  }

  /* --------------------------------------------------------------------- */
  /* 呼叫 API                                                              */
  /* --------------------------------------------------------------------- */

  function friendlyError(status, apiMessage) {
    var detail = apiMessage ? '（' + apiMessage + '）' : '';
    if (status === 401) {
      return 'API 金鑰無效或已被停用，請到「AI 設定」重新貼上金鑰。' + detail;
    }
    if (status === 403) {
      return '這把金鑰沒有使用權限。' + detail;
    }
    if (status === 404) {
      return '找不到指定的模型，請到「AI 設定」改選其他模型。' + detail;
    }
    if (status === 429) {
      return '請求太頻繁或額度已用完，請稍後再試，或到 Claude Console 檢查帳戶餘額。' + detail;
    }
    if (status === 400) {
      return '請求格式被拒絕' + detail + '。若訊息提到 credit 或 billing，表示帳戶餘額不足。';
    }
    if (status === 529 || status >= 500) {
      return 'Claude 服務暫時忙碌，請稍後再試。' + detail;
    }
    return 'AI 解析失敗（HTTP ' + status + '）' + detail;
  }

  /**
   * 送出題目並取得 submit_model 的輸入。fetchImpl 可替換（測試用）。
   * 回傳 Promise<{ input, usage, model }>，失敗時 reject 一個帶有中文訊息的 Error。
   */
  function requestModel(text, options) {
    var opts = options || {};
    var settings = opts.settings || getSettings();
    var fetchImpl = opts.fetch || (global.fetch ? global.fetch.bind(global) : null);
    if (!fetchImpl) {
      return Promise.reject(new Error('這個瀏覽器不支援網路請求。'));
    }
    if (!settings.key) {
      return Promise.reject(new Error('尚未設定 API 金鑰，請先到「AI 設定」貼上金鑰。'));
    }
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) {
        controller.abort();
      }
    }, opts.timeout || TIMEOUT_MS);

    return fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.key,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(buildRequest(text, settings)),
      signal: controller ? controller.signal : undefined
    })
      .then(
        function (response) {
          return response.text().then(function (body) {
            var data = null;
            try {
              data = body ? JSON.parse(body) : null;
            } catch (error) {
              data = null;
            }
            if (!response.ok) {
              var message = data && data.error && data.error.message;
              throw new Error(friendlyError(response.status, message));
            }
            return data;
          });
        },
        function (error) {
          if (error && error.name === 'AbortError') {
            throw new Error('AI 回應逾時（超過 ' + Math.round((opts.timeout || TIMEOUT_MS) / 1000) + ' 秒），請再試一次或改用較快的模型。');
          }
          throw new Error('連不到 Claude API，請檢查網路連線。（' + (error && error.message ? error.message : '網路錯誤') + '）');
        }
      )
      .then(function (data) {
        clearTimeout(timer);
        if (!data || !Array.isArray(data.content)) {
          throw new Error('AI 回傳的內容格式不正確。');
        }
        if (data.stop_reason === 'max_tokens') {
          throw new Error('題目太長，AI 的回答被截斷了。請把題目拆短一點再試。');
        }
        var call = data.content.filter(function (block) {
          return block && block.type === 'tool_use' && block.name === TOOL.name;
        })[0];
        if (!call || !call.input) {
          throw new Error('AI 沒有回傳模型資料，請再試一次。');
        }
        return { input: call.input, usage: data.usage || null, model: data.model || settings.model };
      })
      .catch(function (error) {
        clearTimeout(timer);
        throw error;
      });
  }

  /* --------------------------------------------------------------------- */
  /* 驗證與轉換                                                            */
  /* --------------------------------------------------------------------- */

  function numberText(value, where, errors) {
    if (typeof value === 'string' && value.trim() !== '') {
      value = Number(value);
    }
    if (typeof value !== 'number' || !isFinite(value)) {
      errors.push(where + ' 不是有效數字（' + JSON.stringify(value) + '）。');
      return '0';
    }
    /* 0.1 + 0.2 這類浮點誤差：四捨五入到 10 位小數再轉成精確分數 */
    var rounded = Math.round(value * 1e10) / 1e10;
    var text = String(rounded);
    if (/e/i.test(text)) {
      text = rounded.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
    }
    try {
      Frac.coerce(text);
    } catch (error) {
      errors.push(where + ' 無法轉成精確數字（' + text + '）。');
      return '0';
    }
    return text;
  }

  function cleanList(list) {
    return (Array.isArray(list) ? list : [])
      .map(function (item) {
        return String(item == null ? '' : item).trim();
      })
      .filter(Boolean)
      .slice(0, 12);
  }

  var OP_SYMBOL = { '<=': '≤', '>=': '≥', '=': '=' };

  function formatTerms(coefficients, labels) {
    var parts = [];
    coefficients.forEach(function (text, index) {
      if (Number(text) === 0) {
        return;
      }
      var negative = text.charAt(0) === '-';
      var magnitude = negative ? text.slice(1) : text;
      var term = (magnitude === '1' ? '' : magnitude + ' ') + labels[index];
      parts.push(parts.length ? (negative ? '− ' : '+ ') + term : (negative ? '−' : '') + term);
    });
    return parts.length ? parts.join(' ') : '0';
  }

  function shortLabel(label, index) {
    var text = String(label || '').replace(/^產品\s*/, '').trim();
    return text || 'x' + (index + 1);
  }

  function convertLP(input, errors, warnings, findings) {
    var variables = Array.isArray(input.variables) ? input.variables : [];
    var count = variables.length;
    if (!count) {
      errors.push('AI 沒有列出任何決策變數。');
      return null;
    }
    if (count > modelLib.MAX_VARIABLES) {
      errors.push('決策變數太多（' + count + ' 個，上限 ' + modelLib.MAX_VARIABLES + '）。');
      return null;
    }
    var labels = variables.map(function (variable, index) {
      return String((variable && variable.label) || 'x' + (index + 1)).trim();
    });
    var shortLabels = labels.map(shortLabel);

    var objective = Array.isArray(input.objective) ? input.objective : [];
    if (objective.length !== count) {
      errors.push('目標係數有 ' + objective.length + ' 個，但決策變數有 ' + count + ' 個。');
      return null;
    }
    var c = objective.map(function (value, index) {
      return numberText(value, '「' + labels[index] + '」的目標係數', errors);
    });

    var rawConstraints = Array.isArray(input.constraints) ? input.constraints : [];
    if (!rawConstraints.length) {
      errors.push('AI 沒有列出任何限制式。');
      return null;
    }
    if (rawConstraints.length > modelLib.MAX_CONSTRAINTS) {
      errors.push('限制式太多（' + rawConstraints.length + ' 條，上限 ' + modelLib.MAX_CONSTRAINTS + '）。');
      return null;
    }
    var constraints = rawConstraints.map(function (raw, row) {
      var item = raw || {};
      var label = String(item.label || '限制式' + (row + 1)).trim();
      var coefficients = Array.isArray(item.coefficients) ? item.coefficients.slice() : [];
      if (coefficients.length > count) {
        errors.push('限制式「' + label + '」有 ' + coefficients.length + ' 個係數，多於變數數 ' + count + '。');
      } else if (coefficients.length < count) {
        warnings.push('限制式「' + label + '」只有 ' + coefficients.length + ' 個係數，不足的部分以 0 補上，請確認。');
        while (coefficients.length < count) {
          coefficients.push(0);
        }
      }
      if (!OP_SYMBOL[item.op]) {
        errors.push('限制式「' + label + '」的關係符號「' + item.op + '」無法辨識。');
      }
      return {
        label: label,
        a: coefficients.slice(0, count).map(function (value, index) {
          return numberText(value, '限制式「' + label + '」中「' + labels[index] + '」的係數', errors);
        }),
        op: OP_SYMBOL[item.op] ? item.op : '<=',
        b: numberText(item.rhs, '限制式「' + label + '」的右端值', errors),
        unit: String(item.unit || '').trim()
      };
    });
    if (errors.length) {
      return null;
    }

    var binary = variables.map(function (variable) {
      return Boolean(variable && variable.binary);
    });
    var integer = variables.map(function (variable, index) {
      return Boolean(variable && variable.integer) && !binary[index];
    });
    var sense = input.sense === 'min' ? 'min' : 'max';
    if (input.sense !== 'max' && input.sense !== 'min') {
      warnings.push('AI 沒有指定最大化或最小化，暫以最大化計算。');
    }

    var built = modelLib.create({
      sense: sense,
      varNames: labels.map(function (label, index) {
        return 'x' + (index + 1);
      }),
      c: c,
      constraints: constraints.map(function (constraint) {
        return { a: constraint.a, op: constraint.op, b: constraint.b, label: constraint.label };
      }),
      integer: integer,
      binary: binary,
      meta: {
        objectiveLabel: String(input.objective_label || (sense === 'max' ? '總利潤' : '總成本')),
        objectiveUnit: String(input.objective_unit || ''),
        variableUnit: String((variables[0] && variables[0].unit) || '單位'),
        variableLabels: labels,
        resourceLabels: constraints.map(function (constraint) {
          return constraint.label;
        })
      }
    });
    modelLib.validate(built).errors.forEach(function (issue) {
      errors.push(issue.message);
    });
    if (errors.length) {
      return null;
    }

    findings.push({ label: '問題類型', value: (sense === 'max' ? '最大化' : '最小化') + '（' + (input.objective_label || '目標') + '）' });
    findings.push({ label: '決策變數', value: labels.join('、') + '（共 ' + count + ' 個）' });
    findings.push({
      label: '目標係數',
      value: shortLabels.map(function (label, index) {
        return label + ' = ' + c[index];
      }).join('、') + (input.objective_unit ? '（' + input.objective_unit + '）' : '')
    });
    constraints.forEach(function (constraint, index) {
      findings.push({
        label: '限制 ' + (index + 1) + '・' + constraint.label,
        value: formatTerms(constraint.a, shortLabels) + ' ' + OP_SYMBOL[constraint.op] + ' ' + constraint.b + (constraint.unit ? ' ' + constraint.unit : '')
      });
    });
    var typeNotes = [];
    if (integer.some(Boolean)) {
      typeNotes.push('整數：' + shortLabels.filter(function (label, index) {
        return integer[index];
      }).join('、'));
    }
    if (binary.some(Boolean)) {
      typeNotes.push('0-1：' + shortLabels.filter(function (label, index) {
        return binary[index];
      }).join('、'));
    }
    if (typeNotes.length) {
      findings.push({ label: '變數型態', value: typeNotes.join('；') });
    }
    return { model: built };
  }

  function convertNetwork(input, errors, warnings, findings) {
    var NET = LPC.network;
    var raw = input.network || {};
    if (!NET) {
      errors.push('網路模型模組未載入。');
      return null;
    }
    if (!NET.TYPES[raw.type]) {
      errors.push('AI 沒有指定網路題型（轉運、最短路徑或最大流量）。');
      return null;
    }
    var nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map(function (node, index) {
      var item = node || {};
      return {
        name: String(item.name || '').trim(),
        role: item.role,
        amount: item.amount === undefined || item.amount === null ? '' : numberText(item.amount, '節點「' + (item.name || index + 1) + '」的數量', errors)
      };
    });
    var arcs = (Array.isArray(raw.arcs) ? raw.arcs : []).map(function (arc) {
      var item = arc || {};
      var label = String(item.from) + ' → ' + String(item.to);
      return {
        from: String(item.from || '').trim(),
        to: String(item.to || '').trim(),
        value: numberText(item.value, '弧線 ' + label + ' 的數值', errors),
        reverse: item.reverse === undefined || item.reverse === null ? '' : numberText(item.reverse, '弧線 ' + label + ' 的反向數值', errors)
      };
    });
    if (errors.length) {
      return null;
    }
    var spec = NET.create({
      type: raw.type,
      title: String(input.title || ''),
      unit: String(raw.unit || input.objective_unit || ''),
      nodes: nodes,
      arcs: arcs,
      source: String(raw.source || ''),
      sink: String(raw.sink || '')
    });
    var built = NET.buildModel(spec);
    if (!built.ok) {
      built.compiled.errors.forEach(function (message) {
        errors.push(message);
      });
      return null;
    }
    built.compiled.warnings.forEach(function (message) {
      warnings.push(message);
    });
    findings.push({ label: '問題類型', value: NET.TYPES[spec.type].name + '（' + NET.TYPES[spec.type].en + '）' });
    findings.push({ label: '節點', value: spec.nodes.map(function (node) {
      return node.name;
    }).join('、') + '（共 ' + spec.nodes.length + ' 個）' });
    findings.push({ label: '弧線', value: built.compiled.arcs.length + ' 條（含反向）' });
    if (spec.type === 'transship') {
      findings.push({ label: '供應點', value: spec.nodes.filter(function (node) {
        return node.role === 'supply';
      }).map(function (node) {
        return node.name + ' ' + node.amount;
      }).join('、') || '？' });
      findings.push({ label: '需求點', value: spec.nodes.filter(function (node) {
        return node.role === 'demand';
      }).map(function (node) {
        return node.name + ' ' + node.amount;
      }).join('、') || '？' });
    } else {
      findings.push({ label: spec.type === 'shortest' ? '起點 → 終點' : 'Source → Sink', value: spec.source + ' → ' + spec.sink });
    }
    findings.push({ label: '建立的模型', value: built.model.varNames.length + ' 個變數、' + built.model.constraints.length + ' 條限制式' });
    return { model: built.model, network: spec };
  }

  /** 把 submit_model 的輸入轉成與規則引擎相同格式的結果 */
  function toResult(input, meta) {
    var info = meta || {};
    var errors = [];
    var warnings = [];
    var findings = [{ label: '解析方式', value: 'AI 解析（' + (info.model || memory.model) + '）' }];
    var data = input && typeof input === 'object' ? input : {};
    var assumptions = cleanList(data.assumptions);
    var questions = cleanList(data.questions);
    var converted = null;

    if (data.kind === 'unsupported') {
      return {
        ok: false,
        mode: 'ai',
        model: null,
        findings: findings,
        warnings: ['AI 判斷這個題目無法用線性規劃或網路模型表示。'].concat(questions.map(function (text) {
          return 'AI 說明：' + text;
        })),
        confidence: 0,
        assumptions: assumptions,
        questions: questions
      };
    }
    if (data.kind === 'network') {
      converted = convertNetwork(data, errors, warnings, findings);
    } else if (data.kind === 'lp') {
      converted = convertLP(data, errors, warnings, findings);
    } else {
      errors.push('AI 回傳了無法辨識的模型種類（' + data.kind + '）。');
    }

    if (!converted) {
      return {
        ok: false,
        mode: 'ai',
        model: null,
        findings: findings,
        warnings: ['AI 回傳的模型沒有通過本機檢查，因此不套用：'].concat(errors),
        confidence: 0,
        assumptions: assumptions,
        questions: questions
      };
    }

    questions.forEach(function (text) {
      warnings.push('題目可能缺少的資訊：' + text);
    });
    assumptions.forEach(function (text) {
      warnings.push('AI 的假設：' + text);
    });

    var selfRated = typeof data.confidence === 'number' && isFinite(data.confidence) ? data.confidence : 0.7;
    var confidence = Math.max(0.05, Math.min(0.95, selfRated));
    if (questions.length) {
      confidence = Math.min(confidence, 0.7);
    }

    var result = {
      ok: true,
      mode: 'ai',
      model: converted.model,
      findings: findings,
      warnings: warnings,
      confidence: confidence,
      assumptions: assumptions,
      questions: questions,
      usage: info.usage || null
    };
    if (converted.network) {
      result.network = converted.network;
    }
    return result;
  }

  /** 一次完成：呼叫 API → 驗證 → 轉換 */
  function parse(text, options) {
    return requestModel(text, options).then(function (reply) {
      return toResult(reply.input, { model: reply.model, usage: reply.usage });
    });
  }

  /* --------------------------------------------------------------------- */
  /* 兩種解析結果是否相同（用於比較）                                      */
  /* --------------------------------------------------------------------- */

  function signature(model) {
    if (!model) {
      return null;
    }
    var number = function (text) {
      try {
        return Frac.coerce(text).toString();
      } catch (error) {
        return String(text);
      }
    };
    var rows = model.constraints
      .map(function (constraint) {
        return constraint.a.map(number).join(',') + constraint.op + number(constraint.b);
      })
      .sort();
    return [
      model.sense,
      model.c.map(number).join(','),
      rows.join(';'),
      (model.integer || []).map(Boolean).join(','),
      (model.binary || []).map(Boolean).join(',')
    ].join('|');
  }

  function sameModel(left, right) {
    var a = signature(left);
    return a !== null && a === signature(right);
  }

  loadSettings();

  LPC.ai = {
    MODELS: MODELS,
    DEFAULT_MODEL: DEFAULT_MODEL,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    TOOL: TOOL,
    getSettings: getSettings,
    saveSettings: saveSettings,
    clearSettings: clearSettings,
    loadSettings: loadSettings,
    isConfigured: isConfigured,
    maskKey: maskKey,
    buildRequest: buildRequest,
    requestModel: requestModel,
    toResult: toResult,
    parse: parse,
    sameModel: sameModel
  };
})(typeof window !== 'undefined' ? window : globalThis);
