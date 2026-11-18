/* ============================================================================
 * tests/parser.test.js — 文字建模（parser.js）檢測：node tests/parser.test.js
 * ----------------------------------------------------------------------------
 * 以「常見管理科學題型」的多種寫法，檢查解析出的模型是否與預期完全一致：
 *   目標係數、每條限制式的係數／關係符號／右端值、整數與 0-1 旗標、警告內容。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
['assets/js/fraction.js', 'assets/js/model.js', 'assets/js/parser.js'].forEach((file) => {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
});
const P = globalThis.LPC.parser;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push('  ✗ ' + name + (extra === undefined ? '' : '  → ' + extra));
  }
}

function nums(list) {
  return (list || []).map(Number);
}

function sameList(a, b) {
  return JSON.stringify(nums(a)) === JSON.stringify(nums(b));
}

function describe(result) {
  if (!result || !result.model) {
    return 'model=null';
  }
  const m = result.model;
  return (
    m.sense + ' c=' + JSON.stringify(m.c) + ' ' +
    m.constraints.map((k) => k.label + JSON.stringify(k.a) + k.op + k.b).join(' ; ') +
    ' int=' + JSON.stringify(m.integer) + ' bin=' + JSON.stringify(m.binary)
  );
}

/**
 * spec: { sense, c, cons:[{name,a,op,b}], integer, binary, warn:[字串], noWarn:[字串] }
 * cons 以名稱子字串對應 label；name 為 '' 時表示「任何一條」。
 */
function expectModel(title, text, spec, fn) {
  let result;
  try {
    result = (fn || P.parse)(text);
  } catch (error) {
    check(title + '：不可丟出例外', false, error && error.message);
    return;
  }
  const m = result && result.model;
  if (!m) {
    check(title + '：應解析出模型', false, JSON.stringify(result && result.warnings));
    return;
  }
  if (spec.sense) {
    check(title + '：目標方向', m.sense === spec.sense, m.sense);
  }
  if (spec.c) {
    check(title + '：目標係數', sameList(m.c, spec.c), describe(result));
  }
  if (spec.cons) {
    check(title + '：限制式數量', m.constraints.length === spec.cons.length, describe(result));
    const used = new Set();
    spec.cons.forEach((want) => {
      const index = m.constraints.findIndex(
        (k, i) => !used.has(i) && (want.name === '' || k.label.indexOf(want.name) >= 0)
      );
      if (index < 0) {
        check(title + '：找不到限制式「' + want.name + '」', false, describe(result));
        return;
      }
      used.add(index);
      const got = m.constraints[index];
      check(
        title + '：「' + want.name + '」',
        sameList(got.a, want.a) && got.op === want.op && Number(got.b) === Number(want.b),
        JSON.stringify(got)
      );
    });
  }
  if (spec.integer) {
    check(title + '：整數旗標', JSON.stringify(m.integer.map(Boolean)) === JSON.stringify(spec.integer), JSON.stringify(m.integer));
  }
  if (spec.binary) {
    check(title + '：0-1 旗標', JSON.stringify(m.binary.map(Boolean)) === JSON.stringify(spec.binary), JSON.stringify(m.binary));
  }
  const warnText = (result.warnings || []).join('\n');
  (spec.warn || []).forEach((piece) => check(title + '：警告應包含「' + piece + '」', warnText.indexOf(piece) >= 0, warnText));
  (spec.noWarn || []).forEach((piece) => check(title + '：不應警告「' + piece + '」', warnText.indexOf(piece) < 0, warnText));
  if (spec.minConf !== undefined) {
    check(title + '：信心度 ≥ ' + spec.minConf, result.confidence >= spec.minConf, result.confidence);
  }
  if (spec.maxConf !== undefined) {
    check(title + '：信心度 ≤ ' + spec.maxConf, result.confidence <= spec.maxConf, result.confidence);
  }
}

/* ------------------------------------------------------------------------- */
/* 1. 既有範例（不可退步）                                                   */
/* ------------------------------------------------------------------------- */
expectModel('範例：生產', P.SAMPLE_TEXTS.production, {
  sense: 'max', c: [30, 50],
  cons: [{ name: '人力', a: [2, 3], op: '<=', b: 120 }, { name: '原料', a: [1, 2], op: '<=', b: 80 }],
  integer: [false, false], minConf: 0.9
});
expectModel('範例：飼料', P.SAMPLE_TEXTS.diet, {
  sense: 'min', c: [30, 20],
  cons: [{ name: '蛋白質', a: [3, 1], op: '>=', b: 18 }, { name: '熱量', a: [1, 2], op: '>=', b: 16 }],
  minConf: 0.9
});

/* ------------------------------------------------------------------------- */
/* 2. 不同產品命名方式                                                       */
/* ------------------------------------------------------------------------- */
expectModel(
  '甲乙產品＋長資源名稱',
  '某公司生產甲、乙兩種產品。甲產品每件獲利 40 元，乙產品每件獲利 30 元。' +
    '每件甲需機器加工時間 2 小時、組裝時間 1 小時；每件乙需機器加工時間 1 小時、組裝時間 3 小時。' +
    '機器加工時間最多 100 小時，組裝時間最多 90 小時。求最大利潤。',
  { sense: 'max', c: [40, 30], cons: [{ name: '機器加工時間', a: [2, 1], op: '<=', b: 100 }, { name: '組裝時間', a: [1, 3], op: '<=', b: 90 }] }
);
expectModel(
  '中文名稱產品（桌子與椅子）',
  '工廠生產桌子和椅子兩種家具。每張桌子利潤 80 元，每張椅子利潤 50 元。' +
    '每張桌子需要木材 4 單位、勞力 2 小時；每張椅子需要木材 3 單位、勞力 1 小時。' +
    '木材共有 240 單位，勞力最多 100 小時。目標是利潤最大。',
  { sense: 'max', c: [80, 50], cons: [{ name: '木材', a: [4, 3], op: '<=', b: 240 }, { name: '勞力', a: [2, 1], op: '<=', b: 100 }] }
);
expectModel(
  '三種產品',
  '工廠生產 A、B、C 三種產品。A 的利潤為 10 元，B 的利潤為 20 元，C 的利潤為 30 元。' +
    '每單位 A 需要 1 小時人力與 3 公斤原料，每單位 B 需要 2 小時人力與 2 公斤原料，每單位 C 需要 3 小時人力與 1 公斤原料。' +
    '人力共有 100 小時，原料共有 90 公斤。求利潤最大。',
  { sense: 'max', c: [10, 20, 30], cons: [{ name: '人力', a: [1, 2, 3], op: '<=', b: 100 }, { name: '原料', a: [3, 2, 1], op: '<=', b: 90 }] }
);
expectModel(
  'x1、x2 變數名稱',
  '決策變數為 x1、x2。x1 的利潤為 30 元，x2 的利潤為 50 元。x1 需要 2 小時人力，x2 需要 3 小時人力。人力最多 120 小時。求利潤最大。',
  { sense: 'max', c: [30, 50], cons: [{ name: '人力', a: [2, 3], op: '<=', b: 120 }] }
);

/* ------------------------------------------------------------------------- */
/* 3. 句型變化                                                               */
/* ------------------------------------------------------------------------- */
expectModel(
  'B 省略利潤字眼',
  '生產 A、B 兩種產品。A 每單位利潤為 30 元，B 為 50 元。A 每單位需 2 小時人力，B 需 3 小時人力。人力總量為 120 小時。求利潤最大。',
  { sense: 'max', c: [30, 50], cons: [{ name: '人力', a: [2, 3], op: '<=', b: 120 }] }
);
expectModel(
  '「分別」句型',
  'A、B 兩種產品的單位利潤分別為 30 元和 50 元。生產 A、B 每單位分別需要 2 和 3 小時人力。人力上限為 120 小時。求利潤最大。',
  { sense: 'max', c: [30, 50], cons: [{ name: '人力', a: [2, 3], op: '<=', b: 120 }] }
);
expectModel(
  '資源名稱在數字前面',
  '生產 A、B 兩種產品，利潤各為 30 元與 50 元。A 需要人力 2 小時、原料 1 公斤；B 需要人力 3 小時、原料 2 公斤。人力上限 120 小時，原料上限 80 公斤。求利潤最大。',
  { sense: 'max', c: [30, 50], cons: [{ name: '人力', a: [2, 3], op: '<=', b: 120 }, { name: '原料', a: [1, 2], op: '<=', b: 80 }] }
);
expectModel(
  '千分位與中文數字',
  '生產 A、B 兩種產品。A 的利潤為 30 元，B 的利潤為 50 元。每單位 A 需要兩小時人力，每單位 B 需要三小時人力。人力最多 1,200 小時。求利潤最大。',
  { sense: 'max', c: [30, 50], cons: [{ name: '人力', a: [2, 3], op: '<=', b: 1200 }] }
);
expectModel(
  '數字在資源名稱前的上限寫法',
  '生產 A、B 兩種產品。A 的利潤為 30 元，B 的利潤為 50 元。A 需要 2 小時人力與 1 公斤原料，B 需要 3 小時人力與 2 公斤原料。' +
    '共有 120 小時的人力可用，最多可使用 80 公斤原料。求利潤最大。',
  { sense: 'max', c: [30, 50], cons: [{ name: '人力', a: [2, 3], op: '<=', b: 120 }, { name: '原料', a: [1, 2], op: '<=', b: 80 }] }
);
expectModel(
  '資源只寫單位、沒寫名稱',
  '生產 A、B 兩種產品。A 的利潤為 30 元，B 的利潤為 50 元。A 每單位需要 2 小時，B 需要 3 小時，總共可用 120 小時。求利潤最大。',
  { sense: 'max', c: [30, 50], cons: [{ name: '', a: [2, 3], op: '<=', b: 120 }], warn: ['沒有寫出資源名稱'] }
);

expectModel(
  '動詞直接列舉產品（種植小麥和玉米）',
  '某農場種植小麥和玉米。小麥每公頃利潤 300 元，玉米每公頃利潤 200 元。小麥每公頃需要 2 個勞力，玉米每公頃需要 3 個勞力。總共有 240 個勞力可用。求最大利潤。',
  { sense: 'max', c: [300, 200], cons: [{ name: '勞力', a: [2, 3], op: '<=', b: 240 }] }
);
expectModel(
  '「生產一台手機需要…」的「一台」不是資源',
  '公司生產手機和平板兩種產品。手機每台利潤 2000 元，平板每台利潤 1500 元。生產一台手機需要 3 小時組裝時間，生產一台平板需要 2 小時組裝時間。每週組裝時間上限為 120 小時。求最大利潤。',
  { sense: 'max', c: [2000, 1500], cons: [{ name: '組裝時間', a: [3, 2], op: '<=', b: 120 }] }
);
expectModel(
  '量詞（每扇門、每名司機）不混進資源名稱',
  '玻璃公司生產門和窗兩種產品。門的利潤為 300 元，窗的利潤為 500 元。每扇門需要廠一 1 小時，每扇窗需要廠二 2 小時，廠一每週可用 4 小時，廠二 12 小時。求最大利潤。',
  { sense: 'max', c: [300, 500], cons: [{ name: '廠一', a: [1, 0], op: '<=', b: 4 }, { name: '廠二', a: [0, 2], op: '<=', b: 12 }] }
);
expectModel(
  '名稱有空白、單位是「名」、整數',
  '運輸公司有 大型車 與 小型車 兩種車輛。大型車每輛運費收入 5000 元，小型車每輛運費收入 3000 元。大型車每輛需要 2 名司機，小型車每輛需要 1 名司機。公司共有 20 名司機。車輛數必須為整數。目標是收入最大。',
  { sense: 'max', c: [5000, 3000], cons: [{ name: '司機', a: [2, 1], op: '<=', b: 20 }], integer: [true, true] }
);
expectModel(
  '機器加工時間不會被當成「工時」同義詞而與人力合併',
  '生產 A、B 兩種產品。A 的利潤為 30 元，B 的利潤為 50 元。A 需要 2 小時人力與 3 小時機器加工時間，B 需要 3 小時人力與 1 小時機器加工時間。人力最多 120 小時，機器加工時間最多 90 小時。求利潤最大。',
  { c: [30, 50], cons: [{ name: '人力', a: [2, 3], op: '<=', b: 120 }, { name: '機器加工時間', a: [3, 1], op: '<=', b: 90 }] }
);
expectModel(
  '人力與勞力同時存在時各自對應自己的上限',
  '生產 A、B 兩種產品。A 的利潤為 30 元，B 的利潤為 50 元。A 需要 2 小時人力與 1 小時勞力，B 需要 3 小時人力與 2 小時勞力。人力最多 120 小時，勞力最多 70 小時。求利潤最大。',
  { c: [30, 50], cons: [{ name: '人力', a: [2, 3], op: '<=', b: 120 }, { name: '勞力', a: [1, 2], op: '<=', b: 70 }] }
);
expectModel(
  '同一資源同時有下限與上限',
  '調配 A、B 兩種原料。每公斤成本 A 為 5 元、B 為 8 元。每公斤 A 含 2 單位營養素，B 含 3 單位營養素。每日營養素至少 60 單位，至多 90 單位。求成本最低。',
  { sense: 'min', c: [5, 8], cons: [{ name: '營養素 下限', a: [2, 3], op: '>=', b: 60 }, { name: '營養素 上限', a: [2, 3], op: '<=', b: 90 }] }
);

/* ------------------------------------------------------------------------- */
/* 4. 最大化／最小化判斷                                                     */
/* ------------------------------------------------------------------------- */
expectModel(
  '成本最小（逐項成本、「至少」限制）',
  '調配 A、B 兩種原料。每公斤成本 A 為 5 元、B 為 8 元。每公斤 A 含 2 單位營養素，B 含 3 單位營養素。每日至少需要 60 單位營養素。使成本最低。',
  { sense: 'min', c: [5, 8], cons: [{ name: '營養素', a: [2, 3], op: '>=', b: 60 }] }
);
expectModel(
  '最大化題目中的「至少」不應翻成最小化',
  '生產 A、B 兩種產品。A 的利潤為 30 元，B 的利潤為 50 元。A 需要 2 小時人力，B 需要 3 小時人力。人力最多 120 小時。A 至少要生產 10 件。求利潤最大。',
  { sense: 'max', c: [30, 50], cons: [{ name: '人力', a: [2, 3], op: '<=', b: 120 }, { name: 'A', a: [1, 0], op: '>=', b: 10 }] }
);
expectModel(
  '單一產品的上限',
  '生產 A、B 兩種產品。A 的利潤為 30 元，B 的利潤為 50 元。A 需要 2 小時人力，B 需要 3 小時人力。人力最多 120 小時。B 的市場需求上限為 25 件。求利潤最大。',
  { sense: 'max', cons: [{ name: '人力', a: [2, 3], op: '<=', b: 120 }, { name: 'B', a: [0, 1], op: '<=', b: 25 }] }
);
expectModel(
  '沒有明說目標時給提醒',
  '生產 A、B 兩種產品。A 的利潤為 30 元，B 的利潤為 50 元。A 需要 2 小時人力，B 需要 3 小時人力。人力最多 120 小時。',
  { sense: 'max', warn: ['最大化或最小化'] }
);

/* ------------------------------------------------------------------------- */
/* 5. 整數與 0-1                                                             */
/* ------------------------------------------------------------------------- */
const BASE = '生產 A、B 兩種產品。A 的利潤為 30 元，B 的利潤為 50 元。A 需要 2 小時人力，B 需要 3 小時人力。人力最多 120 小時。求利潤最大。';
expectModel('整數：全部', BASE + '產量必須為整數。', { integer: [true, true], binary: [false, false] });
expectModel('整數：不可分割', BASE + '產品不可分割。', { integer: [true, true] });
expectModel('整數：只有 A', BASE + 'A 必須為整數，B 可以是小數。', { integer: [true, false] });
expectModel('整數：否定', BASE + '產量不必為整數。', { integer: [false, false] });
expectModel('整數：沒有提到', BASE, { integer: [false, false], binary: [false, false] });
expectModel(
  '0-1：投資專案',
  '某公司考慮投資 A、B、C 三個專案，每個專案只能投資或不投資。A 的報酬為 12 萬元，B 為 15 萬元，C 為 9 萬元。' +
    'A 需要資金 5 萬元、B 需要資金 8 萬元、C 需要資金 4 萬元。可用資金共 12 萬元。求報酬最大。',
  { sense: 'max', c: [12, 15, 9], cons: [{ name: '資金', a: [5, 8, 4], op: '<=', b: 12 }], binary: [true, true, true], integer: [false, false, false] }
);
expectModel(
  '0-1：明寫 0-1 變數',
  BASE + '所有決策變數皆為 0-1 變數。',
  { binary: [true, true] }
);
expectModel(
  '0-1：只有 B',
  BASE + '是否生產 B 為 0-1 決策。',
  { binary: [false, true] }
);

/* ------------------------------------------------------------------------- */
/* 6. 速記格式                                                               */
/* ------------------------------------------------------------------------- */
expectModel(
  '速記：冒號與 ≤',
  '最大化\n利潤: 30 50\n人力: 2 3 ≤120\n原料: 1 2 <= 80',
  { sense: 'max', c: [30, 50], cons: [{ name: '人力', a: [2, 3], op: '<=', b: 120 }, { name: '原料', a: [1, 2], op: '<=', b: 80 }] }
);
expectModel(
  '速記：沒有 max/min 行',
  '利潤 30 50\n人力 2 3 <= 120\n原料 1 2 <= 80',
  { sense: 'max', c: [30, 50], cons: [{ name: '人力', a: [2, 3], op: '<=', b: 120 }, { name: '原料', a: [1, 2], op: '<=', b: 80 }] }
);
expectModel(
  '速記：min 與 >=',
  'min\n成本 30 20\n蛋白質 3 1 >= 18\n熱量 1 2 >= 16',
  { sense: 'min', c: [30, 20], cons: [{ name: '蛋白質', a: [3, 1], op: '>=', b: 18 }, { name: '熱量', a: [1, 2], op: '>=', b: 16 }] }
);
expectModel(
  '速記：整數宣告',
  'max\n利潤 30 50\n人力 2 3 <= 120\n整數 1',
  { c: [30, 50], integer: [true, false] }
);
expectModel(
  '速記：缺右端值要警告',
  'max\n利潤 30 50\n人力 2 3 <= 120\n原料 1 2',
  { c: [30, 50], warn: ['原料', '右端值'] },
  P.parseShorthand
);
expectModel(
  '速記：等號與全形',
  'max\n利潤 30 50\n人力 2 3 ＝ 120',
  { cons: [{ name: '人力', a: [2, 3], op: '=', b: 120 }] }
);

/* ------------------------------------------------------------------------- */
/* 7. 警告、信心度與失敗情境                                                  */
/* ------------------------------------------------------------------------- */
expectModel(
  '沒轉成限制式的句子要列出來',
  BASE + 'A 的產量不得超過 B 的 2 倍。',
  { warn: ['A 的產量不得超過 B 的 2 倍'], maxConf: 0.97 }
);
expectModel(
  '缺少資源上限',
  '生產 A、B 兩種產品。A 的利潤為 30 元，B 的利潤為 50 元。A 需要 2 小時人力與 1 公斤原料，B 需要 3 小時人力與 2 公斤原料。人力最多 120 小時。求利潤最大。',
  { warn: ['原料'], maxConf: 0.85 }
);
expectModel(
  '缺少某產品的利潤',
  '生產 A、B 兩種產品。A 的利潤為 30 元。A 需要 2 小時人力，B 需要 3 小時人力。人力最多 120 小時。求利潤最大。',
  { c: [30, 0], warn: ['B'] }
);
expectModel(
  '資源只出現部分產品要提醒',
  '生產 A、B 兩種產品。A 的利潤為 30 元，B 的利潤為 50 元。A 需要 2 小時人力與 1 公斤原料，B 需要 3 小時人力。人力最多 120 小時，原料最多 80 公斤。求利潤最大。',
  { warn: ['原料', 'B'] }
);

(function garbage() {
  ['今天天氣很好，我想出去玩。', '', '   ', '12345', 'A'].forEach((text) => {
    let result = null;
    try {
      result = P.parse(text);
    } catch (error) {
      check('亂碼輸入不可丟例外：「' + text + '」', false, error.message);
      return;
    }
    check('亂碼輸入：「' + text + '」不應宣稱成功', result.ok === false);
    check('亂碼輸入：「' + text + '」必須有說明', (result.warnings || []).length > 0);
    check('亂碼輸入：「' + text + '」信心度為 0', result.confidence === 0 || result.confidence === undefined);
  });
})();

/* findings 要可讀：每條限制式一行，並帶有關係符號與單位 */
(function findingsReadable() {
  const result = P.parse(P.SAMPLE_TEXTS.production);
  const rows = (result.findings || []).map((f) => f.label + '｜' + f.value);
  check('findings：有目標係數列', rows.some((r) => /目標係數/.test(r) && /30/.test(r) && /50/.test(r)), rows.join(' / '));
  check('findings：人力限制式含符號與單位', rows.some((r) => /人力/.test(r) && /≤/.test(r) && /120/.test(r) && /小時/.test(r)), rows.join(' / '));
  check('findings：每筆都有 label 與 value', (result.findings || []).every((f) => f.label && String(f.value).length > 0));
  check('介面相容：warnings 皆為字串', (result.warnings || []).every((w) => typeof w === 'string'));
})();

/* 介面相容：既有三個入口都在、回傳形狀不變 */
check('API：parse/parseNatural/parseShorthand 皆存在', typeof P.parse === 'function' && typeof P.parseNatural === 'function' && typeof P.parseShorthand === 'function');
check('API：SAMPLE_TEXTS 保留', !!P.SAMPLE_TEXTS.production && !!P.SAMPLE_TEXTS.diet);
(function shape() {
  const result = P.parseNatural(P.SAMPLE_TEXTS.production);
  ['ok', 'mode', 'model', 'findings', 'warnings', 'confidence'].forEach((key) => check('回傳欄位：' + key, key in result));
  check('mode 為 natural', result.mode === 'natural');
  const shorthand = P.parseShorthand('max\n利潤 30 50\n人力 2 3 <= 120');
  check('速記 mode 為 shorthand', shorthand.mode === 'shorthand' && shorthand.ok === true && shorthand.confidence === 1);
})();

failures.forEach((line) => console.log(line));
console.log('\n文字建模檢測：通過 ' + passed + ' 項，失敗 ' + failed + ' 項');
process.exit(failed ? 1 : 0);
