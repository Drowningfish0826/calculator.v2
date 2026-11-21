/* ============================================================================
 * tests/ai.test.js — AI 解析（ai.js）檢測：node tests/ai.test.js
 * ----------------------------------------------------------------------------
 * 不會真的連到 Claude API：以模擬的 fetch 回傳各種回應，檢查
 *   請求格式、回應轉換、本機驗證（不合格就不套用）、錯誤訊息、逾時。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
['fraction', 'model', 'solver', 'network', 'parser', 'ai'].forEach((name) => {
  const file = 'assets/js/' + name + '.js';
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
});
const { ai: AI, parser: P, network: N } = globalThis.LPC;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, extra) {
  if (condition) passed += 1;
  else {
    failed += 1;
    failures.push('  ✗ ' + name + (extra === undefined ? '' : '  → ' + extra));
  }
}

const SETTINGS = { key: 'sk-ant-test-0000000000000000', model: 'claude-haiku-5-5', remember: false };

function reply(input, extra) {
  return Object.assign({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'submit_model', input }],
    usage: { input_tokens: 900, output_tokens: 300 }
  }, extra || {});
}

function fakeFetch(status, body, capture) {
  return (url, init) => {
    if (capture) capture.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
    });
  };
}

const PRODUCTION = {
  kind: 'lp',
  title: '生產組合',
  sense: 'max',
  objective_label: '總利潤',
  objective_unit: '元',
  variables: [{ label: '產品 A' }, { label: '產品 B' }],
  objective: [30, 50],
  constraints: [
    { label: '人力', coefficients: [2, 3], op: '<=', rhs: 120, unit: '小時' },
    { label: '原料', coefficients: [1, 2], op: '<=', rhs: 80, unit: '公斤' }
  ],
  assumptions: [],
  questions: [],
  confidence: 0.97
};

const SHORTEST = {
  kind: 'network',
  network: {
    type: 'shortest',
    unit: '公里',
    nodes: ['1', '2', '3', '4', '5', '6', '7'].map((name) => ({ name })),
    arcs: [[1, 2, 21], [1, 3, 17], [1, 4, 30], [2, 4, 10], [2, 5, 25], [3, 4, 12], [3, 6, 25], [4, 5, 18], [4, 6, 10], [4, 7, 9], [5, 7, 12], [6, 7, 15]]
      .map(([from, to, value]) => ({ from: String(from), to: String(to), value })),
    source: '1',
    sink: '7'
  },
  variables: [],
  objective: [],
  constraints: [],
  assumptions: ['弧線皆為單向'],
  questions: [],
  confidence: 0.9
};

async function run() {
  /* 1. 請求格式 */
  const calls = [];
  const result = await AI.parse('某工廠生產 A、B 兩種產品……', { settings: SETTINGS, fetch: fakeFetch(200, reply(PRODUCTION), calls) });
  const call = calls[0];
  check('請求送到 Messages API', call && call.url === 'https://api.anthropic.com/v1/messages', call && call.url);
  check('帶有 x-api-key', call.init.headers['x-api-key'] === SETTINGS.key);
  check('帶有 anthropic-version', call.init.headers['anthropic-version'] === '2023-06-01');
  check('允許瀏覽器直接呼叫的標頭', call.init.headers['anthropic-dangerous-direct-browser-access'] === 'true');
  const body = JSON.parse(call.init.body);
  check('使用設定的模型', body.model === 'claude-haiku-5-5', body.model);
  check('強制使用 submit_model 工具', body.tool_choice && body.tool_choice.type === 'tool' && body.tool_choice.name === 'submit_model');
  check('工具格式含 kind／constraints／network', body.tools[0].input_schema.properties.kind && body.tools[0].input_schema.properties.constraints && body.tools[0].input_schema.properties.network);
  check('題目放在 user 訊息', body.messages[0].role === 'user' && body.messages[0].content.indexOf('A、B') >= 0);
  check('系統提示要求只建模不求解', /不要求解/.test(body.system));

  /* 2. 一般 LP 轉換 */
  check('LP：轉換成功', result.ok === true && result.mode === 'ai', JSON.stringify(result.warnings));
  check('LP：與規則引擎解析的範例模型完全相同', AI.sameModel(result.model, P.parse(P.SAMPLE_TEXTS.production).model));
  check('LP：信心度上限 95%', result.confidence <= 0.95 && result.confidence >= 0.9, result.confidence);
  check('LP：findings 有解析方式', result.findings[0].value.indexOf('AI 解析') === 0);
  check('LP：findings 有限制式與符號', result.findings.some((f) => /人力/.test(f.label) && /≤ 120 小時/.test(f.value)), JSON.stringify(result.findings));
  check('LP：變數名稱保留題目用語', result.model.meta.variableLabels.join() === '產品 A,產品 B');
  check('LP：可以用本機求解器求解', LPC.solver.solveLP(LPC.model.toSolverInput(result.model), {}).status === 'optimal');

  /* 3. 網路模型轉換 */
  const net = await AI.parse('最短路徑……', { settings: SETTINGS, fetch: fakeFetch(200, reply(SHORTEST)) });
  check('網路：轉換成功', net.ok && net.network && net.network.type === 'shortest', JSON.stringify(net.warnings));
  check('網路：求解得 38', Number(N.solve(net.network).z) === 38);
  check('網路：AI 的假設會列出來', net.warnings.some((w) => w.indexOf('AI 的假設：弧線皆為單向') === 0));

  /* 4. 本機驗證：不合格就不套用 */
  const bad = async (title, mutate, piece) => {
    const input = JSON.parse(JSON.stringify(PRODUCTION));
    mutate(input);
    const r = await AI.parse('x', { settings: SETTINGS, fetch: fakeFetch(200, reply(input)) });
    check(title + '：不套用', r.ok === false && r.model === null, JSON.stringify(r.warnings));
    check(title + '：說明原因含「' + piece + '」', r.warnings.join('|').indexOf(piece) >= 0, r.warnings.join('|'));
  };
  await bad('目標係數數量不符', (i) => { i.objective = [30]; }, '目標係數');
  await bad('係數多於變數', (i) => { i.constraints[0].coefficients = [2, 3, 4]; }, '多於變數');
  await bad('關係符號錯誤', (i) => { i.constraints[0].op = '≦≦'; }, '關係符號');
  await bad('數字不是數字', (i) => { i.constraints[1].rhs = 'abc'; }, '不是有效數字');
  await bad('沒有變數', (i) => { i.variables = []; }, '決策變數');
  await bad('沒有限制式', (i) => { i.constraints = []; }, '限制式');
  await bad('種類無法辨識', (i) => { i.kind = 'qp'; }, '無法辨識');
  (async () => {})();
  const netBad = JSON.parse(JSON.stringify(SHORTEST));
  netBad.network.arcs.push({ from: '7', to: '99', value: 3 });
  const nb = await AI.parse('x', { settings: SETTINGS, fetch: fakeFetch(200, reply(netBad)) });
  check('網路弧線指到不存在的節點：不套用', nb.ok === false && /99/.test(nb.warnings.join('')), nb.warnings.join('|'));
  const unsupported = await AI.parse('x', { settings: SETTINGS, fetch: fakeFetch(200, reply({ kind: 'unsupported', assumptions: [], questions: ['這是非線性問題'], confidence: 0.2 })) });
  check('unsupported：不套用並轉述原因', unsupported.ok === false && unsupported.warnings.join('').indexOf('非線性') >= 0);

  /* 5. 寬鬆處理 */
  const shortRow = JSON.parse(JSON.stringify(PRODUCTION));
  shortRow.constraints[1].coefficients = [1];
  const sr = await AI.parse('x', { settings: SETTINGS, fetch: fakeFetch(200, reply(shortRow)) });
  check('係數不足：補 0 並提醒', sr.ok && sr.model.constraints[1].a.join() === '1,0' && /補上/.test(sr.warnings.join('')), sr.warnings.join('|'));
  const floaty = JSON.parse(JSON.stringify(PRODUCTION));
  floaty.objective = [0.1 + 0.2, 50];
  const fl = await AI.parse('x', { settings: SETTINGS, fetch: fakeFetch(200, reply(floaty)) });
  check('浮點誤差 0.1+0.2 轉成 0.3', fl.ok && fl.model.c[0] === '0.3', fl.model && fl.model.c[0]);
  const withQuestions = JSON.parse(JSON.stringify(PRODUCTION));
  withQuestions.questions = ['題目沒有給 B 的利潤'];
  withQuestions.confidence = 0.99;
  const wq = await AI.parse('x', { settings: SETTINGS, fetch: fakeFetch(200, reply(withQuestions)) });
  check('AI 有疑問時信心度最高 70%', wq.confidence <= 0.7, wq.confidence);
  check('AI 的疑問列入需要人工確認', wq.warnings.some((w) => /缺少的資訊：題目沒有給 B 的利潤/.test(w)));
  const typed = JSON.parse(JSON.stringify(PRODUCTION));
  typed.variables = [{ label: 'A', integer: true }, { label: 'B', integer: true, binary: true }];
  const ty = await AI.parse('x', { settings: SETTINGS, fetch: fakeFetch(200, reply(typed)) });
  check('整數與 0-1：0-1 優先、不重複標整數', ty.model.integer.join() === 'true,false' && ty.model.binary.join() === 'false,true');

  /* 6. 錯誤訊息 */
  const expectError = async (title, fetchImpl, piece, opts) => {
    try {
      await AI.parse('x', Object.assign({ settings: SETTINGS, fetch: fetchImpl }, opts || {}));
      check(title + '：應該失敗', false);
    } catch (error) {
      check(title + '：訊息含「' + piece + '」', error.message.indexOf(piece) >= 0, error.message);
    }
  };
  await expectError('401', fakeFetch(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), '金鑰無效');
  await expectError('404 模型', fakeFetch(404, { type: 'error', error: { type: 'not_found_error', message: 'model: nope' } }), '改選其他模型');
  await expectError('429', fakeFetch(429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }), '太頻繁');
  await expectError('529', fakeFetch(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), '忙碌');
  await expectError('400 餘額', fakeFetch(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }), 'credit');
  await expectError('非 JSON 錯誤頁', fakeFetch(502, '<html>Bad gateway</html>'), '忙碌');
  await expectError('網路中斷', () => Promise.reject(new TypeError('Failed to fetch')), '連不到');
  await expectError('沒有工具呼叫', fakeFetch(200, reply(PRODUCTION, { content: [{ type: 'text', text: 'hi' }] })), '沒有回傳模型');
  await expectError('回答被截斷', fakeFetch(200, reply(PRODUCTION, { stop_reason: 'max_tokens' })), '截斷');
  await expectError('沒有金鑰', fakeFetch(200, reply(PRODUCTION)), '尚未設定', { settings: { key: '', model: 'x' } });
  await expectError(
    '逾時',
    (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
    '逾時',
    { timeout: 30 }
  );

  /* 7. 設定 */
  AI.saveSettings({ key: '  sk-ant-abc1234567890xyz  ', model: 'claude-sonnet-5-5', remember: false });
  check('設定：去除空白並保存', AI.getSettings().key === 'sk-ant-abc1234567890xyz' && AI.getSettings().model === 'claude-sonnet-5-5');
  check('設定：已設定', AI.isConfigured());
  check('設定：遮蔽顯示金鑰', AI.maskKey(AI.getSettings().key) === 'sk-ant-…0xyz', AI.maskKey(AI.getSettings().key));
  AI.clearSettings();
  check('設定：清除後未設定', !AI.isConfigured() && AI.getSettings().key === '');
  check('模型清單含 Haiku 預設', AI.DEFAULT_MODEL === 'claude-haiku-5-5' && AI.MODELS.length >= 2);
  check('sameModel：不同模型判定不同', !AI.sameModel(P.parse(P.SAMPLE_TEXTS.production).model, P.parse(P.SAMPLE_TEXTS.diet).model));

  failures.forEach((line) => console.log(line));
  console.log('\nAI 解析檢測：通過 ' + passed + ' 項，失敗 ' + failed + ' 項');
  process.exit(failed ? 1 : 0);
}

run().catch((error) => {
  console.log('測試程式發生例外：', error);
  process.exit(1);
});
