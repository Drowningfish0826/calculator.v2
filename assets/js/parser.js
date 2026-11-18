/* ============================================================================
 * parser.js — 文字建模（離線規則引擎）
 * ----------------------------------------------------------------------------
 * 兩種輸入方式：
 *   1. 自然語言：抽取產品、單位利潤、資源耗用、資源上下限、單一產品的上下限、
 *      以及整數／0-1 條件
 *   2. 速記格式：一行一條限制式，適合快速輸入
 * 解析結果一律轉成可再編輯的模型，並回報「找到了什麼」與警告，
 * 讓使用者知道系統的判斷依據，而不是黑箱。
 *
 * 設計原則：
 *   - 不用「整段文字配對一次」的大型正規式，而是先切成句子、再切成子句，
 *     逐階段抽取（目標係數 → 單一產品上下限 → 資源耗用 → 資源上下限 → 變數型態），
 *     每個階段都會記錄「哪些子句已被使用」，沒被使用卻含有數字的句子會列入警告。
 *   - 資源名稱不再截斷成固定字數，而是依連接詞、動詞與標點自然斷開。
 *   - 全程離線、純規則；對外介面（parse／parseNatural／parseShorthand）不變。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});
  var model = LPC.model;

  /* --------------------------------------------------------------------- */
  /* 詞庫                                                                  */
  /* --------------------------------------------------------------------- */

  var UNIT_WORDS = [
    '小時', '工時', '人時', '人日', '機時', '分鐘', '公斤', '公克', '公噸', '噸', 'kg', 'g',
    '單位', '箱', '件', '台', '部', '度', '桶', '人', '天', '日', '元', '萬元', '千元', '美元', '塊',
    '％', '%', '平方公尺', '立方公尺', '公升', '毫升', '個', '包', '袋', '張', '輛', '間',
    '份', '套', '批', '盒', '瓶', '斤', '公頃', '坪', '公尺', '公里', '組', '次', '條', '支', '片', '名', '位', '則', '座', '戶', '頭'
  ]
    .filter(function (word, index, list) {
      return list.indexOf(word) === index;
    })
    .sort(function (left, right) {
      return right.length - left.length;
    });

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  var UNIT_SRC = UNIT_WORDS.map(escapeRegExp).join('|');
  var NUM = '\\d+(?:\\.\\d+)?(?:\\/\\d+)?';
  var LIST_SEP = '(?:、|,|，|和|及|與|以及|跟)';
  var NUM_LIST = '(?:' + NUM + '\\s*(?:' + UNIT_SRC + ')?\\s*' + LIST_SEP + '\\s*)+' + NUM;
  var MONEY_SRC = '(?:萬元|千元|美元|元|塊)';

  var PROFIT_RE = new RegExp(
    '利潤|毛利|收益|獲利|淨利|售價|單價|貢獻|報酬|產值|附加價值|利差|成本|費用|支出|收入|營收|價格|效益|利益|盈餘|得分'
  );
  var PROFIT_SRC = PROFIT_RE.source;

  /* 判斷「這句話在說資源耗用」的線索 */
  var USAGE_CUE_RE = new RegExp(
    '需要|需|耗用|消耗|使用|投入|佔用|占用|花費|用掉|要用|製造|生產|含有|含|提供|搭配|耗費|耗時|所需|用量|' +
      '每單位|每件|每個|每張|每台|每部|每公斤|每噸|每份|每箱|每包|每組|單位產品|加工|組裝|配置'
  );
  /* 解析資源名稱時要拿掉的動詞（刻意不含「加工」「組裝」，它們常是名稱的一部分） */
  var USAGE_STRIP = [
    '需要', '需', '耗用', '消耗掉', '消耗', '使用', '投入', '佔用', '占用', '花費', '用掉', '要用',
    '製造', '生產', '含有', '含', '提供', '搭配', '耗費', '所需'
  ];

  var UPPER_WORDS = [
    '不得超過', '不可超過', '不能超過', '不超過', '至多', '最多', '最高', '不高於', '不得高於', '以內', '以下', '上限',
    '可用', '可使用', '可供', '供應', '庫存', '限額', '限量', '限制', '共有', '僅有', '總共', '總量', '預算', '產能', '容量', '最大'
  ];
  var LOWER_WORDS = [
    '不得低於', '不可低於', '不能低於', '不得少於', '不可少於', '不少於', '不低於', '至少', '最少', '最低', '下限', '以上',
    '需求', '須達', '需達', '需滿足', '須滿足', '必須滿足'
  ];
  var EQUAL_WORDS = ['恰好', '剛好', '正好', '恰為', '恰有', '等於'];
  var TIME_WORDS = ['每天', '每日', '每週', '每周', '每月', '每年', '本週', '本周', '本月', '今日', '今天', '當日', '每班'];
  var QUANTIFIERS = ['每單位', '每件', '每個', '每張', '每台', '每部', '每公斤', '每噸', '每份', '每箱', '每包', '每組', '每'];
  var CONNECTORS = ['以及', '還有', '另外', '並且', '同時', '與', '和', '及', '並', '且', '跟', '再', '共', '僅', '只', '約', '大約'];
  var PARTICLES = ['用於', '在', '於', '由', '從', '經', '用', '可', '能', '得', '的', '為', '是', '有', '之', '等', '其中', '所', '須', '必須', '應', '要'];

  function alternation(list) {
    return list
      .slice()
      .sort(function (left, right) {
        return right.length - left.length;
      })
      .map(escapeRegExp)
      .join('|');
  }

  var UPPER_RE_SRC = alternation(UPPER_WORDS);
  var LOWER_RE_SRC = alternation(LOWER_WORDS);
  var EQUAL_RE_SRC = alternation(EQUAL_WORDS);
  var CAPACITY_RE = new RegExp(UPPER_RE_SRC + '|' + LOWER_RE_SRC + '|' + EQUAL_RE_SRC);
  var STRIP_RE = new RegExp(
    '(?:' +
      alternation(
        USAGE_STRIP.concat(UPPER_WORDS, LOWER_WORDS, EQUAL_WORDS, TIME_WORDS, QUANTIFIERS, CONNECTORS, PARTICLES)
      ) +
      ')',
    'g'
  );
  /* 名稱結尾的「需求／用量」等字樣不是資源名稱本身，統一拿掉才能與「人力上限」對得起來 */
  var NAME_SUFFIX_RE = /(?:耗用量|使用量|消耗量|需求量|需求|用量|耗用|數量)$/;
  var STOP_RE = /與|和|及|並|且|同時|而|還|另外|以及|以|來|才|可|會|每|共|總共|其中|於|在|生產|製造|製成|做成|完成|使|讓|供|能|得|就|即|便|但|若|如果|因|所以|因此|跟/;
  var SINGLE_CHAR_NAMES = '水電油煤糖鹽米麵肉蛋奶金銀銅鐵鋼木土糧錢氣';

  var UNIT_AS_NAME = { '小時': '工時', '分鐘': '工時', '元': '資金', '萬元': '資金', '千元': '資金', '美元': '資金', '塊': '資金' };

  /* 同義資源：「人力」與「勞力」視為同一種，避免耗用與上限對不起來 */
  var ALIASES = [
    ['人力', '勞力', '人工', '工時', '人時', '勞動力', '勞動', '人員', '人手'],
    ['機器', '機時', '設備', '機台', '機械', '機器時間', '機器工時'],
    ['原料', '原物料', '材料', '物料', '原材料'],
    ['資金', '預算', '經費', '資本', '金額']
  ];

  /* --------------------------------------------------------------------- */
  /* 文字正規化與切句                                                      */
  /* --------------------------------------------------------------------- */

  var CN_DIGITS = { '〇': 0, '零': 0, '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

  function chineseToNumber(text) {
    var index;
    var character;
    if (!/[十百]/.test(text)) {
      var digits = '';
      for (index = 0; index < text.length; index += 1) {
        digits += CN_DIGITS[text.charAt(index)];
      }
      return Number(digits);
    }
    var total = 0;
    var current = 0;
    for (index = 0; index < text.length; index += 1) {
      character = text.charAt(index);
      if (character === '十') {
        total += (current || 1) * 10;
        current = 0;
      } else if (character === '百') {
        total += (current || 1) * 100;
        current = 0;
      } else {
        current = CN_DIGITS[character];
      }
    }
    return total + current;
  }

  var CN_NUMBER_BEFORE_UNIT = new RegExp('([〇零一二兩三四五六七八九十百]+)(?=\\s*(?:' + UNIT_SRC + '))', 'g');

  function normalizeText(text) {
    var result = String(text == null ? '' : text)
      .replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (character) {
        return String.fromCharCode(character.charCodeAt(0) - 0xfee0);
      })
      .replace(/　/g, ' ')
      .replace(/＝/g, '=')
      .replace(/＜/g, '<')
      .replace(/＞/g, '>')
      .replace(/＋/g, '+')
      .replace(/－/g, '-')
      .replace(/％/g, '%')
      .replace(/≤|≦/g, '<=')
      .replace(/≥|≧/g, '>=')
      .replace(/：/g, ':');
    /* 1,200 → 1200（只處理三位一組的千分位） */
    var previous;
    do {
      previous = result;
      result = result.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
    } while (result !== previous);
    result = result.replace(CN_NUMBER_BEFORE_UNIT, function (match) {
      return String(chineseToNumber(match));
    });
    /* 「產品 1」「產品1」寫法統一 */
    result = result.replace(/(產品|商品|方案|專案|項目|作物|型號)\s+(\d+)/g, '$1$2');
    return result;
  }

  function splitSentences(text) {
    return text
      .replace(/([^\d])\.(\s|$)/g, '$1。$2')
      .split(/[。；;\n!！?？]+/)
      .map(function (line) {
        return line.replace(/^\s*(?:\d+[.、)）]|[（(]\d+[)）]|[•\-*])\s*/, '').trim();
      })
      .filter(Boolean);
  }

  /** 把句子切成子句，並記住每個子句前面的分隔符（逗號與頓號的意義不同） */
  function splitParts(sentence) {
    var pieces = sentence.split(/([，,、])/);
    var parts = [];
    var separator = '';
    for (var index = 0; index < pieces.length; index += 1) {
      if (index % 2 === 1) {
        separator = pieces[index];
      } else {
        parts.push({ t: pieces[index], sep: separator });
      }
    }
    return parts;
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

  function isNumeric(token) {
    return /^[+-]?\d+(?:\.\d+)?(?:\/\d+)?$/.test(token);
  }

  /* --------------------------------------------------------------------- */
  /* 產品名稱                                                              */
  /* --------------------------------------------------------------------- */

  var ORDINALS = '甲乙丙丁戊己庚辛';
  var TOKEN = '(?:[A-Z]\\d{0,2}|[xX]\\d{1,2}|[' + ORDINALS + '])';
  var RUN_SEP = '\\s*(?:、|,|，|和|與|及|或|以及|\\/)\\s*';
  var NAME_COUNT = '(?:[二兩三四五六七八九十]|\\d+)';
  var NAME_VERBS = ['生產', '製造', '製作', '銷售', '販售', '種植', '栽種', '調配', '經營', '供應', '提供', '組裝', '加工', '出售', '購買', '投資', '推出', '研發', '開發'];
  var NOT_PRODUCT_RE = /^(?:資源|原料|材料|限制|條件|約束|成分|營養|設備|機器|原物料)/;

  function productKind(name) {
    return /^[A-Za-z]\d{0,2}$/.test(name) || new RegExp('^[' + ORDINALS + ']$').test(name) ? 'symbol' : 'named';
  }

  function cleanProductName(raw, isFirst) {
    var name = raw.replace(/\s+/g, '').replace(/^(?:在|於|有|是|共有|分別|對|為|和|與)+/, '');
    if (isFirst) {
      var cut = -1;
      NAME_VERBS.forEach(function (verb) {
        var position = name.lastIndexOf(verb);
        if (position >= 0 && position + verb.length > cut) {
          cut = position + verb.length;
        }
      });
      if (cut >= 0) {
        name = name.slice(cut);
      } else {
        var owner = /^.*?(?:公司|工廠|農場|商店|餐廳|廠|店)(?=[一-龥])/.exec(name);
        if (owner) {
          name = name.slice(owner[0].length);
        }
      }
    }
    name = name.replace(/^(?:在|於|有|是|共有|分別|對|為|和|與)+/, '');
    if (!/^[一-龥]{1,6}$/.test(name) || /需|利潤|成本|每|的|可用|資源/.test(name)) {
      return '';
    }
    return name;
  }

  function splitNamedList(raw) {
    var pieces = raw.split(/\s*(?:、|,|，|和|與|及|跟)\s*/).filter(Boolean);
    var names = [];
    for (var index = 0; index < pieces.length; index += 1) {
      var name = cleanProductName(pieces[index], index === 0);
      if (!name) {
        return [];
      }
      names.push(name);
    }
    return unique(names);
  }

  function detectProducts(text) {
    var match;

    /* 1. 連續列舉：A、B、C ／ 甲、乙 ／ x1、x2 */
    var runPattern = new RegExp('(?:^|[^A-Za-z0-9])(' + TOKEN + '(?:' + RUN_SEP + TOKEN + ')+)(?![A-Za-z0-9])', 'g');
    var best = [];
    while ((match = runPattern.exec(text)) !== null) {
      var tokens = unique(
        match[1]
          .split(new RegExp(RUN_SEP))
          .map(function (token) {
            return token.trim();
          })
          .filter(Boolean)
      );
      if (tokens.length > best.length) {
        best = tokens;
      }
    }
    if (best.length >= 2) {
      return { names: best.slice(0, model.MAX_VARIABLES), kind: 'symbol' };
    }

    /* 2. 中文名稱：「桌子和椅子兩種家具」「兩種產品：標準型、豪華型」 */
    var named = new RegExp(
      '([\\u4e00-\\u9fa5]{1,14}(?:\\s*(?:、|,|，|和|與|及|跟)\\s*[\\u4e00-\\u9fa5]{1,6})+)\\s*' + NAME_COUNT + '\\s*(?:種|款|類|項|樣|個)([\\u4e00-\\u9fa5]{0,4})',
      'g'
    );
    while ((match = named.exec(text)) !== null) {
      if (NOT_PRODUCT_RE.test(match[2] || '')) {
        continue;
      }
      var names = splitNamedList(match[1]);
      if (names.length >= 2) {
        return { names: names.slice(0, model.MAX_VARIABLES), kind: 'named' };
      }
    }
    var colonList = new RegExp(NAME_COUNT + '\\s*(?:種|款|類|項|樣)[\\u4e00-\\u9fa5]{0,6}:\\s*([^。\\n；;]+)').exec(text);
    if (colonList) {
      var listed = splitNamedList(colonList[1].replace(/等.*$/, ''));
      if (listed.length >= 2) {
        return { names: listed.slice(0, model.MAX_VARIABLES), kind: 'named' };
      }
    }

    /* 2b. 「種植小麥和玉米」：動詞後直接列舉，沒有「兩種」 */
    var verbList = new RegExp(
      '(?:' + alternation(NAME_VERBS.concat(['種植', '栽種', '飼養', '養殖', '採購', '選購'])) + ')\\s*([\\u4e00-\\u9fa5]{1,6})((?:\\s*(?:、|和|與|及|跟)\\s*[\\u4e00-\\u9fa5]{1,6}){1,3})(?=[，,。；;\\s]|$|等)',
      'g'
    );
    while ((match = verbList.exec(text)) !== null) {
      var direct = splitNamedList(match[1] + match[2]);
      if (direct.length >= 2) {
        return { names: direct.slice(0, model.MAX_VARIABLES), kind: 'named' };
      }
    }

    /* 3. 「產品 A … 產品 B」 */
    var labeled = [];
    var labelPattern = new RegExp(
      '(?:產品|商品|方案|作物|專案|房型|機型|車型|品項|項目|飼料|食物|型號|款式)\\s*([A-Z]\\d{0,2}|[' + ORDINALS + '])(?![A-Za-z0-9])',
      'g'
    );
    while ((match = labelPattern.exec(text)) !== null) {
      labeled.push(match[1]);
    }
    if (unique(labeled).length >= 2) {
      return { names: unique(labeled).slice(0, model.MAX_VARIABLES), kind: 'symbol' };
    }

    /* 4. 「產品1、產品2」 */
    var indexed = [];
    var indexPattern = /(?:產品|商品|方案|專案|項目|作物|型號)\d+/g;
    while ((match = indexPattern.exec(text)) !== null) {
      indexed.push(match[0]);
    }
    if (unique(indexed).length >= 2) {
      return { names: unique(indexed).slice(0, model.MAX_VARIABLES), kind: 'named' };
    }

    /* 5. 最後手段：文中零星出現的大寫字母 */
    var loose = [];
    var loosePattern = /(?:^|[^A-Za-z0-9])([A-Z])(?![A-Za-z0-9])/g;
    while ((match = loosePattern.exec(text)) !== null) {
      loose.push(match[1]);
    }
    loose = unique(loose);
    if (loose.length >= 2) {
      return { names: loose.slice(0, model.MAX_VARIABLES), kind: 'symbol', loose: true };
    }
    return { names: [], kind: 'symbol' };
  }

  function productRegex(name) {
    if (/^[A-Za-z0-9]+$/.test(name)) {
      return new RegExp('(^|[^A-Za-z0-9])(' + escapeRegExp(name) + ')(?![A-Za-z0-9])', 'g');
    }
    return new RegExp('()(' + escapeRegExp(name) + ')', 'g');
  }

  /** 找出一段文字裡提到的所有產品（依出現順序） */
  function mentionsIn(text, products) {
    var found = [];
    products.forEach(function (name, index) {
      var pattern = productRegex(name);
      var match;
      while ((match = pattern.exec(text)) !== null) {
        var start = match.index + match[1].length;
        found.push({ index: index, name: name, pos: start, end: start + name.length });
      }
    });
    found.sort(function (left, right) {
      return left.pos - right.pos;
    });
    return found;
  }

  function distinctIndexes(mentions) {
    return unique(
      mentions.map(function (item) {
        return String(item.index);
      })
    ).map(Number);
  }

  function blankOut(text, mentions) {
    var chars = text.split('');
    mentions.forEach(function (item) {
      for (var position = item.pos; position < item.end; position += 1) {
        chars[position] = ' ';
      }
    });
    return chars.join('');
  }

  /* --------------------------------------------------------------------- */
  /* 資源名稱                                                              */
  /* --------------------------------------------------------------------- */

  function canonicalName(name) {
    var trimmed = name.replace(NAME_SUFFIX_RE, '');
    return trimmed.length >= 2 ? trimmed : name;
  }

  function cleanName(raw) {
    var text = String(raw || '')
      .replace(/每(?:單位|公斤|公頃|公尺|平方公尺|[\u4e00-\u9fa5])/g, ' ')
      .replace(STRIP_RE, ' ')
      .replace(/[\s:=、，,()（）「」『』"'+\-–—~*]/g, '')
      .replace(/^(?:的|之)+|(?:的|之)+$/g, '');
    if (!text) {
      return '';
    }
    if (/\d/.test(text)) {
      return '';
    }
    text = canonicalName(text);
    if (/^[一-龥A-Za-z]{2,12}$/.test(text)) {
      return text;
    }
    if (text.length === 1 && SINGLE_CHAR_NAMES.indexOf(text) >= 0) {
      return text;
    }
    return '';
  }

  function cutName(tail) {
    var text = String(tail || '').replace(/^的/, '');
    var stop = STOP_RE.exec(text);
    if (stop && stop.index > 0) {
      text = text.slice(0, stop.index);
    }
    if (text.length > 12) {
      text = text.slice(0, 12);
    }
    return cleanName(text);
  }

  var COUNT_NOUN_RE = /^(?:專案|產品|商品|方案|項目|品項|作物|選項|地點|據點|倉庫|工廠|種類|類型)$/;

  /** 「3 個專案」「兩種產品」是在數有幾個決策項目，不是資源用量 */
  function isCountPhrase(amount) {
    return /^[個種款類項樣]$/.test(amount.unit) && COUNT_NOUN_RE.test(amount.name);
  }

  /** 名稱相同，或其中一個完整包含另一個（人力／人力資源） */
  function sameName(left, right) {
    if (!left || !right) {
      return false;
    }
    if (left === right) {
      return true;
    }
    return left.length >= 2 && right.length >= 2 && (left.indexOf(right) >= 0 || right.indexOf(left) >= 0);
  }

  /**
   * 是否為同義詞（人力＝勞力＝人工…）。必須「整個名稱」都是同義詞表中的字，
   * 不能用子字串比對，否則「機器加工時間」會因為含有「工時」而被誤判成人力。
   */
  function isAlias(left, right) {
    return ALIASES.some(function (group) {
      return group.indexOf(left) >= 0 && group.indexOf(right) >= 0;
    });
  }

  /** 對應「耗用的資源」與「可用量的資源」時才容許同義詞；合併兩個耗用名稱時只看 sameName */
  function sameResource(left, right) {
    return sameName(left, right) || isAlias(left, right);
  }

  /**
   * 從一段（已拿掉產品名稱的）文字中取出「數量＋單位＋資源名稱」。
   * 資源名稱可以在數字後面（2 小時人力）或前面（人力 2 小時），
   * 兩者同時存在時優先採用數字前面那個，避免把「2 小時加工」的「加工」當成名稱。
   */
  function extractAmounts(work) {
    var pattern = new RegExp('(' + NUM + ')\\s*(' + UNIT_SRC + ')', 'g');
    var amounts = [];
    var cursor = 0;
    var match;
    while ((match = pattern.exec(work)) !== null) {
      var unit = match[2];
      var after = work.slice(pattern.lastIndex);
      var tailRaw = /^(?:的)?([一-龥A-Za-z]*)/.exec(after)[0];
      var before = work.slice(cursor, match.index);
      var name = cleanName(before);
      var guessed = false;
      var consumed = pattern.lastIndex;
      if (unit === '人' && /^[力工手]/.test(tailRaw.replace(/^的/, '')) && !name) {
        name = '人' + tailRaw.replace(/^的/, '').charAt(0);
        consumed += tailRaw.length;
      } else if (!name) {
        name = cutName(tailRaw);
        if (name) {
          consumed += tailRaw.length;
        }
      }
      if (!name) {
        if (Number(match[1]) === 1 && /^(?:單位|件|台|個|份|張|箱|組|套|批|輛|間|條|支|片|名|位|則|座|戶|頭|部|包|袋|桶)$/.test(unit)) {
          /* 「生產一台手機需要…」的「一台」只是在說「每一個」，不是資源 */
          cursor = consumed;
          continue;
        }
        name = UNIT_AS_NAME[unit] || unit;
        guessed = true;
      }
      amounts.push({ name: name, value: match[1], unit: unit, pos: match.index, guessed: guessed });
      cursor = consumed;
      pattern.lastIndex = Math.max(pattern.lastIndex, consumed);
    }
    return amounts;
  }

  /* --------------------------------------------------------------------- */
  /* 目標方向                                                              */
  /* --------------------------------------------------------------------- */

  var MIN_GOAL_RE = /(?:成本|費用|支出|開銷|花費|代價|距離|損失|浪費|風險|油耗|能耗)[^。；，,\n]{0,6}?(?:最小|最低|最少|最省|最短|極小|越低越好|越小越好)|最小化|極小化|minimi[sz]e|\bmin\b|省錢|降低成本|最省|最低成本|最小成本|最少成本|最短/i;
  var MAX_GOAL_RE = /(?:利潤|獲利|收益|利益|報酬|收入|營收|產值|效益|銷售額|貢獻|淨利|毛利|盈餘|得分|效用|總價值|價值)[^。；，,\n]{0,6}?(?:最大|最高|最多|最佳|極大|越高越好|越大越好)|最大化|極大化|maximi[sz]e|\bmax\b|最大利潤|最高利潤|最大收益|最大化/i;
  var GOAL_SENTENCE_RE = /求|試問|問|目標|如何|希望|使|讓|為了|目的/;

  function detectSense(text, sentences, defaultMin) {
    var minHit = null;
    var maxHit = null;
    sentences.forEach(function (sentence, index) {
      var minMatch = MIN_GOAL_RE.exec(sentence);
      var maxMatch = MAX_GOAL_RE.exec(sentence);
      var goal = GOAL_SENTENCE_RE.test(sentence);
      if (minMatch) {
        minHit = { index: index, snippet: minMatch[0], goal: goal };
      }
      if (maxMatch) {
        maxHit = { index: index, snippet: maxMatch[0], goal: goal };
      }
    });
    if (minHit && maxHit) {
      var preferMin = minHit.goal !== maxHit.goal ? minHit.goal : minHit.index >= maxHit.index;
      return {
        sense: preferMin ? 'min' : 'max',
        explicit: true,
        conflict: true,
        basis: (preferMin ? minHit : maxHit).snippet
      };
    }
    if (minHit) {
      return { sense: 'min', explicit: true, basis: minHit.snippet };
    }
    if (maxHit) {
      return { sense: 'max', explicit: true, basis: maxHit.snippet };
    }
    var generic = /(?:求|使|讓|目標[是為]?|目的[是為]?|希望)[^。；，,\n]{1,10}?(最大|最高|最多|最小|最低|最少|最省|最短)/.exec(text);
    if (generic) {
      var isMin = /最小|最低|最少|最省|最短/.test(generic[1]);
      return { sense: isMin ? 'min' : 'max', explicit: true, basis: generic[0] };
    }
    var profitWords = (text.match(/利潤|獲利|收益|報酬|收入|營收|毛利|淨利/g) || []).length;
    var costWords = (text.match(/成本|費用|支出/g) || []).length;
    var lowerWords = (text.match(new RegExp(LOWER_RE_SRC, 'g')) || []).length;
    var upperWords = (text.match(new RegExp(UPPER_RE_SRC, 'g')) || []).length;
    if (costWords > 0 && profitWords === 0) {
      return { sense: 'min', explicit: false, basis: '題目只出現成本、沒有利潤' };
    }
    if (profitWords === 0 && costWords === 0 && lowerWords > upperWords) {
      return { sense: 'min', explicit: false, basis: '限制條件多為「至少」' };
    }
    return { sense: defaultMin ? 'min' : 'max', explicit: false, basis: profitWords > 0 ? '題目出現利潤' : '預設' };
  }

  /* --------------------------------------------------------------------- */
  /* 整數／0-1 變數                                                        */
  /* --------------------------------------------------------------------- */

  var INT_NEG_RE = /(?:不必|不需要?|不用|無需|無須|不須|不要求|不一定要?|毋須|可以不|可不)[^，。；,]{0,6}?(?:整數|取整)/;
  var INT_RE = /整數|不可分割|不能分割|不可切割|不能切割|不可拆分|不能拆分|無法分割|取整|整台|整輛|整件|整箱|integer|whole\s+number/i;
  var INT_SOFT_NEG_RE = /可分割|可以分割|可切割|可為小數|可以是小數|可是小數|小數也可|允許小數|可為分數|連續變數|非整數|可以取小數/;
  var BIN_RE = new RegExp(
    '0\\s*[-–—~\\/]\\s*1(?!\\d)|二元|二進位|binary|零壹|零一變數|' +
      '是否(?:要|應|該|需要)?(?:選|投資|採用|建置|開設|購買|選擇|選取|生產|進行|執行|承接|加入|設置|設立|興建|租用|聘用|雇用|僱用|啟用|開發|導入|租|買|做|取)|' +
      '與否|要不要|做或不做|選或不選|([\\u4e00-\\u9fa5]{1,3})或不\\1|' +
      '(?:最多|只能|僅能)(?:只能)?(?:選|投資|被選|採用|生產|開設)(?:擇)?(?:一次|1次|1 次|一個)',
    'i'
  );

  function detectVariableTypes(sentences, products, used) {
    var explicitInt = {};
    var explicitBin = {};
    var globalInt = false;
    var globalNeg = false;
    var globalBin = false;
    var reasons = { integer: [], binary: [] };

    sentences.forEach(function (sentence, sentenceIndex) {
      sentence.split(/[，,；]/).forEach(function (clause) {
        var targets = distinctIndexes(mentionsIn(clause, products));
        var isBin = BIN_RE.test(clause);
        var isIntNeg = INT_NEG_RE.test(clause);
        var isInt = !isIntNeg && INT_RE.test(clause);
        var isSoftNeg = !isIntNeg && !isInt && INT_SOFT_NEG_RE.test(clause);
        if (!isBin && !isIntNeg && !isInt && !isSoftNeg) {
          return;
        }
        used[sentenceIndex] = true;
        var snippet = clause.trim();
        if (isBin) {
          if (targets.length) {
            targets.forEach(function (index) {
              explicitBin[index] = true;
            });
          } else {
            globalBin = true;
          }
          reasons.binary.push(snippet);
        } else if (isInt) {
          if (targets.length) {
            targets.forEach(function (index) {
              explicitInt[index] = true;
            });
          } else {
            globalInt = true;
          }
          reasons.integer.push(snippet);
        } else {
          if (targets.length) {
            targets.forEach(function (index) {
              if (explicitInt[index] === undefined) {
                explicitInt[index] = false;
              }
              if (explicitBin[index] === undefined) {
                explicitBin[index] = false;
              }
            });
          } else {
            globalNeg = true;
          }
        }
      });
    });

    var binary = [];
    var integer = [];
    products.forEach(function (name, index) {
      var isBinary = explicitBin[index] !== undefined ? explicitBin[index] : globalBin;
      var isInteger = explicitInt[index] !== undefined ? explicitInt[index] : globalInt && !globalNeg;
      binary.push(Boolean(isBinary));
      integer.push(Boolean(isInteger) && !isBinary);
    });
    return { integer: integer, binary: binary, reasons: reasons };
  }

  /* --------------------------------------------------------------------- */
  /* 自然語言解析                                                          */
  /* --------------------------------------------------------------------- */

  function formatTerms(coefficients, labels) {
    var parts = [];
    coefficients.forEach(function (coefficient, index) {
      var text = String(coefficient);
      if (Number(text) === 0 || text === '0') {
        return;
      }
      var negative = text.charAt(0) === '-';
      var magnitude = negative ? text.slice(1) : text;
      var term = (magnitude === '1' ? '' : magnitude + ' ') + labels[index];
      if (!parts.length) {
        parts.push((negative ? '−' : '') + term);
      } else {
        parts.push((negative ? '− ' : '+ ') + term);
      }
    });
    return parts.length ? parts.join(' ') : '0';
  }

  var OP_SYMBOL = { '<=': '≤', '>=': '≥', '=': '=' };

  function nearestOp(text, position, fallbackText) {
    var candidates = [];
    [
      { op: '=', source: EQUAL_RE_SRC },
      { op: '>=', source: LOWER_RE_SRC },
      { op: '<=', source: UPPER_RE_SRC }
    ].forEach(function (group) {
      var pattern = new RegExp(group.source, 'g');
      var match;
      while ((match = pattern.exec(text)) !== null) {
        candidates.push({ op: group.op, distance: Math.abs(match.index - position) });
      }
    });
    if (!candidates.length && fallbackText) {
      return nearestOp(fallbackText, 0, null);
    }
    if (!candidates.length) {
      return null;
    }
    candidates.sort(function (left, right) {
      return left.distance - right.distance;
    });
    return candidates[0].op;
  }

  function parseNatural(rawText) {
    var text = normalizeText(rawText);
    var sentences = splitSentences(text);
    var findings = [];
    var warnings = [];
    var used = {};
    var consumed = {};

    var products = detectProducts(text);
    var senseInfo = detectSense(text, sentences, false);
    var sense = senseInfo.sense;

    function markPart(sentenceIndex, partIndex, reason) {
      consumed[sentenceIndex + ':' + partIndex] = reason;
      used[sentenceIndex] = true;
    }
    function isConsumed(sentenceIndex, partIndex) {
      return Boolean(consumed[sentenceIndex + ':' + partIndex]);
    }

    if (!products.names.length) {
      warnings.push(
        '找不到產品或決策項目。請用「A、B 兩種產品」「桌子和椅子兩種家具」這類寫法列出，或改用速記格式，也可以直接在表單設定。'
      );
      return { ok: false, mode: 'natural', model: null, findings: findings, warnings: warnings, confidence: 0 };
    }

    var names = products.names;
    var count = names.length;
    var partsBySentence = sentences.map(splitParts);

    findings.push({
      label: '問題類型',
      value: (sense === 'max' ? '最大化' : '最小化') + (senseInfo.explicit ? '（依據：「' + senseInfo.basis + '」）' : '（推測：' + senseInfo.basis + '）')
    });
    findings.push({ label: '決策項目', value: names.join('、') + '（共 ' + count + ' 個）' });
    if (!senseInfo.explicit) {
      warnings.push(
        '題目沒有明說要最大化或最小化，系統依「' + senseInfo.basis + '」推測為' + (sense === 'max' ? '最大化' : '最小化') + '。若不對，請在模型表單切換。'
      );
    }
    if (senseInfo.conflict) {
      warnings.push('題目同時出現最大化與最小化的字眼，系統採用「' + senseInfo.basis + '」。請確認目標方向。');
    }
    if (products.loose) {
      warnings.push('產品名稱是從文中零星出現的大寫字母推測的（' + names.join('、') + '），建議在題目中寫成「A、B 兩種產品」。');
    }

    /* ---------------- 階段一：單位利潤／單位成本 ---------------- */
    var profits = {};
    var profitKinds = {};
    var profitUnits = [];
    var moneyUnit = '(?:' + MONEY_SRC + ')?';

    function setProfit(productIndex, value, kind, unit, sentenceIndex, partIndex) {
      if (profits[productIndex] === undefined) {
        profits[productIndex] = value;
        profitKinds[productIndex] = kind;
        if (unit) {
          profitUnits.push(unit);
        }
      } else if (profitKinds[productIndex] !== kind && /售價|單價|價格|收入|營收/.test(kind) !== /售價|單價|價格|收入|營收/.test(profitKinds[productIndex])) {
        warnings.push(
          '「' + names[productIndex] + '」同時出現「' + profitKinds[productIndex] + '」與「' + kind + '」，目前採用「' + profitKinds[productIndex] +
            '」的數字。若目標是淨利，請自行用「售價 − 成本」算好後填入。'
        );
      }
      if (sentenceIndex !== undefined) {
        markPart(sentenceIndex, partIndex, 'profit');
      }
    }

    sentences.forEach(function (sentence, sentenceIndex) {
      var profitWord = PROFIT_RE.exec(sentence);
      if (!profitWord) {
        return;
      }
      /* 「分別／各」+ 數字列：A、B 的利潤分別為 30 元和 50 元 */
      var listMatch = new RegExp('(?:分別|各自|依序|依次|各)(?:為|是|:)?[^0-9]{0,8}?(' + NUM_LIST + ')\\s*(' + UNIT_SRC + ')?').exec(sentence);
      if (listMatch) {
        var tailUnit = listMatch[2];
        var tailIsMoney = !tailUnit || new RegExp('^' + MONEY_SRC + '$').test(tailUnit);
        var listed = distinctIndexes(mentionsIn(sentence, names));
        var values = listMatch[1].match(new RegExp(NUM, 'g')) || [];
        if (tailIsMoney && listed.length >= 2 && values.length >= listed.length) {
          listed.forEach(function (productIndex, order) {
            setProfit(productIndex, values[order], profitWord[0], tailUnit || '元');
          });
          used[sentenceIndex] = true;
          partsBySentence[sentenceIndex].forEach(function (part, partIndex) {
            if (PROFIT_RE.test(part.t)) {
              consumed[sentenceIndex + ':' + partIndex] = 'profit';
            }
          });
          return;
        }
      }

      var profitContext = false;
      var lastProduct = null;
      partsBySentence[sentenceIndex].forEach(function (part, partIndex) {
        var clause = part.t;
        var mentions = mentionsIn(clause, names);
        var targets = distinctIndexes(mentions);
        var wordMatch = PROFIT_RE.exec(clause);
        var hasCapacityWord = CAPACITY_RE.test(clause);
        var assigned = false;

        if (targets.length === 1) {
          lastProduct = targets[0];
        }
        if (wordMatch && targets.length) {
          targets.forEach(function (productIndex) {
            var name = escapeRegExp(names[productIndex]);
            var boundary = /^[A-Za-z0-9]+$/.test(names[productIndex]) ? '(?![A-Za-z0-9])' : '';
            var forward = new RegExp(name + boundary + '[^0-9]{0,24}?(?:' + PROFIT_SRC + ')[^0-9]{0,8}(' + NUM + ')\\s*(' + MONEY_SRC + ')?').exec(clause);
            var reversed = new RegExp('(?:' + PROFIT_SRC + ')[^0-9]{0,12}?' + name + boundary + '[^0-9]{0,10}(' + NUM + ')\\s*(' + MONEY_SRC + ')?').exec(clause);
            var hit = forward || reversed;
            if (hit) {
              setProfit(productIndex, hit[1], wordMatch[0], hit[2]);
              assigned = true;
            }
          });
          if (!assigned && targets.length > 1 && /各|都|皆|均/.test(clause)) {
            var shared = new RegExp('(?:' + PROFIT_SRC + ')[^0-9]{0,8}(' + NUM + ')\\s*(' + MONEY_SRC + ')?').exec(clause);
            if (shared) {
              targets.forEach(function (productIndex) {
                setProfit(productIndex, shared[1], wordMatch[0], shared[2]);
              });
              assigned = true;
            }
          }
        } else if (wordMatch && !targets.length && lastProduct !== null && !hasCapacityWord) {
          /* 「每單位 A 需 2 小時人力，利潤 30 元」：利潤算在前面最近提到的產品 */
          var carried = new RegExp('(?:' + PROFIT_SRC + ')[^0-9]{0,8}(' + NUM + ')\\s*(' + MONEY_SRC + ')?').exec(clause);
          if (carried && profits[lastProduct] === undefined) {
            setProfit(lastProduct, carried[1], wordMatch[0], carried[2]);
            assigned = true;
          }
        } else if (!wordMatch && targets.length === 1 && profitContext && !USAGE_CUE_RE.test(clause) && !hasCapacityWord) {
          /* 「A 利潤 30 元，B 為 50 元」：沒有利潤字眼的子句沿用前面的語意 */
          var bare = new RegExp('^[^0-9]{0,6}?(?:為|是|:|=)?\\s*(' + NUM + ')\\s*(' + MONEY_SRC + ')?\\s*$').exec(blankOut(clause, mentions));
          if (bare && profits[targets[0]] === undefined) {
            setProfit(targets[0], bare[1], profitWord[0], bare[2]);
            assigned = true;
          }
        }
        if (wordMatch) {
          profitContext = true;
        }
        if (assigned) {
          markPart(sentenceIndex, partIndex, 'profit');
        }
      });
    });

    /* ---------------- 階段二：單一產品的上下限 ---------------- */
    var bounds = [];
    var BOUND_WORDS = alternation(UPPER_WORDS.concat(LOWER_WORDS, EQUAL_WORDS).filter(function (word) {
      return ['可用', '可使用', '可供', '供應', '庫存', '限額', '限量', '限制', '共有', '僅有', '總共', '總量', '預算', '產能', '容量', '需求'].indexOf(word) < 0;
    }));
    var LEFT_OK = /^[\s的每日週周月天市場產量銷售需求數生出能供應訂單購買採投資額要須必應只可得不用]*$/;
    var RIGHT_OK = /^[\s要生產銷售供應訂購買採投資製造量數為是:達到超過少低多高於得至]*$/;

    function addBound(productIndex, op, value, unit, sentenceIndex, partIndex) {
      var duplicate = bounds.some(function (bound) {
        return bound.index === productIndex && bound.op === op && Number(bound.value) === Number(value);
      });
      if (!duplicate) {
        bounds.push({ index: productIndex, op: op, value: value, unit: unit || '' });
      }
      markPart(sentenceIndex, partIndex, 'bound');
    }
    function opOfWord(word) {
      if (new RegExp('^(?:' + EQUAL_RE_SRC + ')$').test(word)) {
        return '=';
      }
      if (new RegExp('^(?:' + LOWER_RE_SRC + ')$').test(word)) {
        return '>=';
      }
      return '<=';
    }

    sentences.forEach(function (sentence, sentenceIndex) {
      partsBySentence[sentenceIndex].forEach(function (part, partIndex) {
        if (isConsumed(sentenceIndex, partIndex)) {
          return;
        }
        var clause = part.t;
        var mentions = mentionsIn(clause, names);
        var targets = distinctIndexes(mentions);
        var done = false;
        /* 每種產品／各產品 至少 N */
        var everyone = new RegExp('(?:每種|各種|每個|所有|各)(?:產品|商品|專案|方案)?([^0-9,，、。；;]{0,6}?)(' + BOUND_WORDS + ')([^0-9,，、。；;]{0,6}?)(' + NUM + ')\\s*(' + UNIT_SRC + ')?').exec(clause);
        if (everyone && LEFT_OK.test(everyone[1]) && RIGHT_OK.test(everyone[3]) && !USAGE_CUE_RE.test(everyone[3])) {
          names.forEach(function (name, productIndex) {
            addBound(productIndex, opOfWord(everyone[2]), everyone[4], everyone[5], sentenceIndex, partIndex);
          });
          return;
        }
        targets.forEach(function (productIndex) {
          var name = escapeRegExp(names[productIndex]);
          var boundary = /^[A-Za-z0-9]+$/.test(names[productIndex]) ? '(?![A-Za-z0-9])' : '';
          var forward = new RegExp(name + boundary + '([^0-9,，、。；;]{0,8}?)(' + BOUND_WORDS + ')([^0-9,，、。；;]{0,6}?)(' + NUM + ')\\s*(' + UNIT_SRC + ')?').exec(clause);
          if (forward && LEFT_OK.test(forward[1]) && RIGHT_OK.test(forward[3])) {
            addBound(productIndex, opOfWord(forward[2]), forward[4], forward[5], sentenceIndex, partIndex);
            done = true;
            return;
          }
          var backward = new RegExp('(' + BOUND_WORDS + ')([^0-9,，、。；;]{0,8}?)(' + NUM + ')\\s*(?:' + UNIT_SRC + ')?\\s*(?:的)?' + name + boundary).exec(clause);
          if (backward && RIGHT_OK.test(backward[2].replace(/市場|只能|最多|能/g, ''))) {
            addBound(productIndex, opOfWord(backward[1]), backward[3], '', sentenceIndex, partIndex);
            done = true;
          }
        });
        return done;
      });
    });

    /* ---------------- 階段三：資源耗用 ---------------- */
    var usage = {};
    var resourceOrder = [];
    var unitGuessed = {};

    function resourceKey(name) {
      for (var index = 0; index < resourceOrder.length; index += 1) {
        if (sameName(resourceOrder[index], name)) {
          return resourceOrder[index];
        }
      }
      return null;
    }
    function recordUsage(productIndex, amount) {
      var key = resourceKey(amount.name);
      if (!key) {
        key = amount.name;
        resourceOrder.push(key);
        usage[key] = { name: key, amount: {}, unit: amount.unit, spellings: [] };
      }
      if (usage[key].spellings.indexOf(amount.name) < 0) {
        usage[key].spellings.push(amount.name);
      }
      if (amount.guessed) {
        unitGuessed[key] = amount.unit;
      }
      if (usage[key].amount[productIndex] === undefined) {
        usage[key].amount[productIndex] = amount.value;
      }
    }

    sentences.forEach(function (sentence, sentenceIndex) {
      /* 「分別需要 2 和 3 小時人力」 */
      var listUsage = new RegExp('(?:分別|各自|依序|依次|各)[^0-9]{0,12}?(' + NUM_LIST + ')\\s*(' + UNIT_SRC + ')([\\u4e00-\\u9fa5A-Za-z]{0,12})').exec(sentence);
      if (listUsage && !(PROFIT_RE.test(sentence) && new RegExp('^' + MONEY_SRC + '$').test(listUsage[2]))) {
        var listed = distinctIndexes(mentionsIn(sentence.slice(0, listUsage.index), names));
        var values = listUsage[1].match(new RegExp(NUM, 'g')) || [];
        if (listed.length >= 2 && values.length >= listed.length) {
          var between = sentence.slice(0, listUsage.index);
          var lastMention = mentionsIn(between, names).pop();
          var name = cutName(listUsage[3]) || cleanName(between.slice(lastMention ? lastMention.end : 0));
          var guessed = false;
          if (!name) {
            name = UNIT_AS_NAME[listUsage[2]] || listUsage[2];
            guessed = true;
          }
          listed.forEach(function (productIndex, order) {
            recordUsage(productIndex, { name: name, value: values[order], unit: listUsage[2], guessed: guessed });
          });
          used[sentenceIndex] = true;
          partsBySentence[sentenceIndex].forEach(function (part, partIndex) {
            consumed[sentenceIndex + ':' + partIndex] = consumed[sentenceIndex + ':' + partIndex] || 'usage';
          });
          return;
        }
      }

      var sentenceHasCue = USAGE_CUE_RE.test(sentence);
      var context = null;
      partsBySentence[sentenceIndex].forEach(function (part, partIndex) {
        var clause = part.t;
        if (isConsumed(sentenceIndex, partIndex)) {
          return;
        }
        var mentions = mentionsIn(clause, names);
        var targets = distinctIndexes(mentions);
        if (targets.length === 1) {
          context = targets;
        } else if (targets.length > 1) {
          context = /各|都|皆|均/.test(clause) ? targets : null;
        } else if (part.sep === '、' && context) {
          /* 「A 需要人力 2 小時、原料 1 公斤」：頓號後面沿用同一個產品 */
        } else if (context && /^\s*(?:再|另|還|以及|並)?\s*(?:需|要|用|耗)?\s*\d/.test(clause) && !CAPACITY_RE.test(clause)) {
          /* 「A 需要 2 小時人力，3 公斤原料」 */
        } else {
          context = null;
          return;
        }
        if (!context || !(sentenceHasCue || USAGE_CUE_RE.test(clause))) {
          return;
        }
        var amounts = extractAmounts(blankOut(clause, mentions)).filter(function (amount) {
          return !isCountPhrase(amount) && !(PROFIT_RE.test(clause) && new RegExp('^' + MONEY_SRC + '$').test(amount.unit) && amount.guessed);
        });
        if (!amounts.length) {
          return;
        }
        amounts.forEach(function (amount) {
          context.forEach(function (productIndex) {
            recordUsage(productIndex, amount);
          });
        });
        markPart(sentenceIndex, partIndex, 'usage');
      });
    });

    /* ---------------- 階段四：資源上下限 ---------------- */
    var capacities = {};
    var defaultOp = sense === 'max' ? '<=' : '>=';

    function takenByOtherStage(sentenceIndex, partIndex) {
      var reason = consumed[sentenceIndex + ':' + partIndex];
      return Boolean(reason) && reason !== 'capacity';
    }

    /** 可用量的名稱對應到哪一種耗用資源：先找名稱相同的，找不到才容許同義詞 */
    function spellingsOf(key) {
      return usage[key].spellings.concat([key]);
    }
    function resourceForCapacity(name) {
      var exact = resourceOrder.filter(function (key) {
        return spellingsOf(key).some(function (spelling) {
          return sameName(spelling, name);
        });
      })[0];
      if (exact) {
        return exact;
      }
      return resourceOrder.filter(function (key) {
        return spellingsOf(key).some(function (spelling) {
          return isAlias(spelling, name);
        });
      })[0];
    }

    resourceOrder.forEach(function (key) {
      var candidates = [];
      sentences.forEach(function (sentence, sentenceIndex) {
        var sentenceHasCap = CAPACITY_RE.test(sentence);
        var previousOwner = null;
        partsBySentence[sentenceIndex].forEach(function (part, partIndex) {
          if (takenByOtherStage(sentenceIndex, partIndex) || mentionsIn(part.t, names).length) {
            return;
          }
          extractAmounts(part.t).forEach(function (amount) {
            if (isCountPhrase(amount)) {
              return;
            }
            /* 「營養素至少 60 單位，至多 90 單位」：後半句沒寫名稱，沿用前面最近的資源 */
            var owner = amount.guessed ? previousOwner || resourceForCapacity(amount.name) : resourceForCapacity(amount.name);
            if (!amount.guessed) {
              previousOwner = owner || null;
            }
            if (owner !== key) {
              return;
            }
            var partHasCap = CAPACITY_RE.test(part.t);
            var op = nearestOp(part.t, amount.pos, sentence) || defaultOp;
            candidates.push({
              op: op,
              value: amount.value,
              unit: amount.unit,
              sentenceIndex: sentenceIndex,
              partIndex: partIndex,
              score: (partHasCap ? 4 : 0) + (sentenceHasCap ? 2 : 0) + (amount.unit === usage[key].unit ? 2 : 0)
            });
          });
        });
      });
      /* 沒有單位時，退回「離資源名稱最近的數字」 */
      if (!candidates.length) {
        sentences.forEach(function (sentence, sentenceIndex) {
          if (!CAPACITY_RE.test(sentence)) {
            return;
          }
          partsBySentence[sentenceIndex].forEach(function (part, partIndex) {
            if (takenByOtherStage(sentenceIndex, partIndex) || mentionsIn(part.t, names).length) {
              return;
            }
            var spellingHit = spellingsOf(key).filter(function (spelling) {
              return part.t.indexOf(spelling) >= 0;
            })[0];
            if (!spellingHit) {
              return;
            }
            var nameIndex = part.t.indexOf(spellingHit);
            var pattern = new RegExp(NUM, 'g');
            var number;
            var bestValue = null;
            var bestDistance = Infinity;
            var bestPosition = 0;
            while ((number = pattern.exec(part.t)) !== null) {
              var distance = Math.abs(number.index - nameIndex);
              if (distance < bestDistance) {
                bestDistance = distance;
                bestValue = number[0];
                bestPosition = number.index;
              }
            }
            if (bestValue !== null) {
              candidates.push({
                op: nearestOp(part.t, bestPosition, sentence) || defaultOp,
                value: bestValue,
                unit: '',
                sentenceIndex: sentenceIndex,
                partIndex: partIndex,
                score: 1
              });
            }
          });
        });
      }
      var byOp = {};
      candidates.forEach(function (candidate) {
        if (!byOp[candidate.op] || candidate.score > byOp[candidate.op].score) {
          byOp[candidate.op] = candidate;
        }
      });
      capacities[key] = Object.keys(byOp).map(function (op) {
        var chosen = byOp[op];
        markPart(chosen.sentenceIndex, chosen.partIndex, 'capacity');
        return chosen;
      });
    });

    /* ---------------- 變數型態 ---------------- */
    var types = detectVariableTypes(sentences, names, used);

    /* ---------------- 組裝模型 ---------------- */
    var labels = names.map(function (name) {
      return name;
    });
    var variableLabels = names.map(function (name) {
      return products.kind === 'symbol' || /^[A-Za-z]/.test(name) ? '產品 ' + name : name;
    });
    var varNames = names.map(function (name, index) {
      return 'x' + (index + 1);
    });
    var objectiveValues = names.map(function (name, index) {
      return profits[index] !== undefined ? profits[index] : '0';
    });

    var constraints = [];
    var constraintInfo = [];
    resourceOrder.forEach(function (key) {
      var list = capacities[key];
      var coefficients = names.map(function (name, index) {
        return usage[key].amount[index] !== undefined ? usage[key].amount[index] : '0';
      });
      if (!list.length) {
        constraints.push({ a: coefficients, op: defaultOp, b: '0', label: key });
        constraintInfo.push({ key: key, op: defaultOp, value: null, unit: usage[key].unit, coefficients: coefficients });
        return;
      }
      list.forEach(function (candidate) {
        constraints.push({
          a: coefficients,
          op: candidate.op,
          b: candidate.value,
          label: list.length > 1 ? key + (candidate.op === '>=' ? ' 下限' : candidate.op === '<=' ? ' 上限' : '') : key
        });
        constraintInfo.push({ key: key, op: candidate.op, value: candidate.value, unit: candidate.unit || usage[key].unit, coefficients: coefficients });
      });
    });
    bounds.forEach(function (bound) {
      var coefficients = names.map(function (name, index) {
        return index === bound.index ? '1' : '0';
      });
      var label = names[bound.index] + (bound.op === '>=' ? ' 產量下限' : bound.op === '<=' ? ' 產量上限' : ' 產量');
      constraints.push({ a: coefficients, op: bound.op, b: bound.value, label: label });
      constraintInfo.push({ key: label, op: bound.op, value: bound.value, unit: bound.unit, coefficients: coefficients, isBound: true });
    });

    var objectiveUnit = unique(profitUnits)[0] || '元';
    var built = model.create({
      sense: sense,
      varNames: varNames,
      c: objectiveValues,
      constraints: constraints,
      integer: types.integer,
      binary: types.binary,
      meta: {
        objectiveLabel: sense === 'max' ? '總利潤' : '總成本',
        objectiveUnit: objectiveUnit,
        variableUnit: '單位',
        variableLabels: variableLabels,
        resourceLabels: constraints.map(function (constraint) {
          return constraint.label;
        })
      }
    });

    /* ---------------- findings ---------------- */
    var profitParts = names.map(function (name, index) {
      return name + ' = ' + (profits[index] !== undefined ? profits[index] : '？');
    });
    findings.push({ label: sense === 'max' ? '目標係數（單位利潤）' : '目標係數（單位成本）', value: profitParts.join('、') + '（' + objectiveUnit + '）' });
    constraintInfo.forEach(function (info, index) {
      findings.push({
        label: '限制 ' + (index + 1) + '・' + info.key,
        value:
          formatTerms(info.coefficients, labels) + ' ' + OP_SYMBOL[info.op] + ' ' + (info.value === null ? '？' : info.value) +
          (info.unit ? ' ' + info.unit : '')
      });
    });
    var typeNotes = [];
    var integerNames = names.filter(function (name, index) {
      return types.integer[index];
    });
    var binaryNames = names.filter(function (name, index) {
      return types.binary[index];
    });
    if (integerNames.length) {
      typeNotes.push('整數：' + integerNames.join('、'));
    }
    if (binaryNames.length) {
      typeNotes.push('0-1：' + binaryNames.join('、'));
    }
    if (typeNotes.length) {
      findings.push({ label: '變數型態', value: typeNotes.join('；') });
    }

    /* ---------------- warnings ---------------- */
    names.forEach(function (name, index) {
      if (profits[index] === undefined) {
        warnings.push(
          '找不到「' + name + '」的' + (sense === 'max' ? '單位利潤' : '單位成本') + '，暫以 0 代入。可在題目補上「' + name + ' 每單位' + (sense === 'max' ? '利潤' : '成本') + '為 … 元」，或直接在表單修改。'
        );
      }
    });
    if (!resourceOrder.length && !bounds.length) {
      warnings.push('找不到資源耗用描述（例如「A 每單位需要 2 小時人力」）。請確認每個產品的資源用量是否寫成「數字＋單位＋資源名稱」。');
    }
    resourceOrder.forEach(function (key) {
      var missing = names.filter(function (name, index) {
        return usage[key].amount[index] === undefined;
      });
      if (missing.length && missing.length < count) {
        warnings.push('「' + key + '」只找到部分產品的耗用量，' + missing.join('、') + ' 以 0 代入。若它們也會用到「' + key + '」，請在表單補上。');
      } else if (missing.length === count) {
        warnings.push('「' + key + '」沒有對應到任何產品的耗用量。');
      }
      if (unitGuessed[key]) {
        warnings.push('題目只寫了單位「' + unitGuessed[key] + '」、沒有寫出資源名稱，系統暫時命名為「' + key + '」，請確認這是不是同一種資源。');
      }
      if (!capacities[key].length) {
        warnings.push('找不到「' + key + '」的可用量上限（或下限），暫以 0 代入，這會讓模型無可行解。請在題目補上「' + key + '最多 … ' + (usage[key].unit || '') + '」，或直接在表單修改。');
      }
    });
    names.forEach(function (name, index) {
      var appears = resourceOrder.some(function (key) {
        return usage[key].amount[index] !== undefined;
      }) || bounds.some(function (bound) {
        return bound.index === index;
      });
      if (!appears && resourceOrder.length) {
        warnings.push('「' + name + '」沒有出現在任何限制式中' + (sense === 'max' ? '，若利潤為正，模型可能會變成無界' : '') + '。');
      }
    });

    /* 含數字、卻沒有被轉成模型的句子 */
    var ignored = [];
    sentences.forEach(function (sentence, sentenceIndex) {
      if (used[sentenceIndex]) {
        return;
      }
      var stripped = sentence;
      names.forEach(function (name) {
        stripped = stripped.replace(new RegExp(escapeRegExp(name), 'g'), '');
      });
      stripped = stripped.replace(/\d+\s*(?:種|款|類|項|樣|個(?:專案|產品|方案|品項|項目|作物|選項|地點|據點|倉庫|工廠))/g, '');
      if (/\d/.test(stripped)) {
        ignored.push(sentence);
      }
    });
    ignored.forEach(function (sentence) {
      warnings.push('這句話含有數字，但沒有被轉成模型：「' + sentence + '」。若它是限制條件，請在套用後於表單手動新增。');
    });

    /* ---------------- 信心度 ---------------- */
    var total = 1 + count * 2 + resourceOrder.length * 4;
    var earned = senseInfo.explicit ? 1 : 0.5;
    names.forEach(function (name, index) {
      if (profits[index] !== undefined) {
        earned += 2;
      }
    });
    resourceOrder.forEach(function (key) {
      var covered = names.filter(function (name, index) {
        return usage[key].amount[index] !== undefined;
      }).length;
      earned += 2 * (covered / count);
      if (capacities[key].length) {
        earned += 2;
      }
    });
    var confidence = 0;
    if (resourceOrder.length || bounds.length) {
      if (!resourceOrder.length) {
        total += 2;
        earned += 2;
      }
      confidence = Math.max(0, Math.min(1, earned / total - Math.min(0.3, ignored.length * 0.08)));
    }
    if (!resourceOrder.length && !bounds.length) {
      confidence = 0;
    }

    return {
      ok: constraints.length > 0 && confidence > 0,
      mode: 'natural',
      model: built,
      findings: findings,
      warnings: warnings,
      confidence: confidence
    };
  }

  /* --------------------------------------------------------------------- */
  /* 速記格式解析                                                          */
  /* --------------------------------------------------------------------- */

  var SENSE_LINE_RE = /^(max|min|maximi[sz]e|minimi[sz]e|最大化|最小化|最大|最小|極大|極小|求最大|求最小)\s*:?$/i;
  var OBJECTIVE_LABEL_RE = /^(利潤|毛利|收益|獲利|目標|成本|費用|報酬|收入|objective|obj|profit|cost|z)(?![a-z])/i;
  var INTEGER_LINE_RE = /^(整數變數|整數|integer|int)(?![A-Za-z])\s*:?\s*(.*)$/i;
  var BINARY_LINE_RE = /^(0-1|01|二元|binary|bin)(?![A-Za-z])(?:\s*變數)?\s*:?\s*(.*)$/i;

  function normalizeShorthandLine(line) {
    return normalizeText(line)
      .replace(/小於等於/g, '<=')
      .replace(/大於等於/g, '>=')
      .replace(/=</g, '<=')
      .replace(/=>/g, '>=')
      .replace(/==+/g, '=')
      .replace(/(<=|>=|<|>|=)/g, ' $1 ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function splitLabel(line, fallback) {
    var colon = /^([^:\d+\-<>=][^:<>=]{0,14}?)\s*:\s*(.*)$/.exec(line);
    if (colon) {
      return { label: colon[1].trim(), rest: colon[2] };
    }
    var token = /^(\S+)\s+(.*)$/.exec(line);
    if (token && !isNumeric(token[1]) && !/^(<=|>=|<|>|=)$/.test(token[1])) {
      return { label: token[1], rest: token[2] };
    }
    return { label: fallback, rest: line };
  }

  function parseIndexList(text, varCount) {
    var flags = [];
    var tokens = text.split(/[\s,，、]+/).filter(Boolean);
    if (!tokens.length) {
      for (var all = 0; all < varCount; all += 1) {
        flags.push(all);
      }
      return flags;
    }
    tokens.forEach(function (token) {
      var match = /^x?(\d+)$/i.exec(token);
      if (match && Number(match[1]) >= 1 && Number(match[1]) <= varCount) {
        flags.push(Number(match[1]) - 1);
      }
    });
    return flags;
  }

  function parseShorthand(rawText) {
    var lines = String(rawText || '')
      .split(/\n/)
      .map(function (line) {
        return line.trim();
      })
      .filter(function (line) {
        return line && line.charAt(0) !== '#' && line.slice(0, 2) !== '//' && line.charAt(0) !== '／';
      });
    if (!lines.length) {
      return { ok: false, mode: 'shorthand', model: null, warnings: ['沒有輸入內容。'], findings: [], confidence: 0 };
    }

    var findings = [];
    var warnings = [];
    var sense = null;
    var senseExplicit = false;
    var integerLines = [];
    var binaryLines = [];
    var body = [];

    lines.forEach(function (line) {
      var normalized = normalizeShorthandLine(line);
      if (sense === null && body.length === 0 && SENSE_LINE_RE.test(normalized)) {
        sense = /^(min|minimi|最小|極小|求最小)/i.test(normalized) ? 'min' : 'max';
        senseExplicit = true;
        return;
      }
      if (INTEGER_LINE_RE.test(normalized) && !/(<=|>=|=|<|>)/.test(normalized)) {
        integerLines.push(INTEGER_LINE_RE.exec(normalized)[2]);
        return;
      }
      if (BINARY_LINE_RE.test(normalized) && !/(<=|>=|=|<|>)/.test(normalized)) {
        binaryLines.push(BINARY_LINE_RE.exec(normalized)[2]);
        return;
      }
      body.push(normalized);
    });

    if (!body.length) {
      return { ok: false, mode: 'shorthand', model: null, warnings: ['找不到目標函數行（請以「利潤 30 50」這樣的格式輸入）。'], findings: [], confidence: 0 };
    }

    var objectiveIndex = -1;
    body.forEach(function (line, index) {
      if (objectiveIndex < 0 && OBJECTIVE_LABEL_RE.test(splitLabel(line, '').label)) {
        objectiveIndex = index;
      }
    });
    if (objectiveIndex < 0) {
      if (/(<=|>=|=|<|>)/.test(body[0])) {
        return { ok: false, mode: 'shorthand', model: null, warnings: ['找不到目標函數行（請以「利潤 30 50」開頭，或用 max／min 起頭並把目標放第一行）。'], findings: [], confidence: 0 };
      }
      objectiveIndex = 0;
      warnings.push('沒有標明目標函數的名稱，已把第一行「' + body[0] + '」當作目標函數。建議寫成「利潤 30 50」或「成本 30 20」。');
    }

    var objectiveSplit = splitLabel(body[objectiveIndex], '目標');
    var objectiveValues = objectiveSplit.rest.split(/[\s,]+/).filter(isNumeric);
    if (!objectiveValues.length) {
      return { ok: false, mode: 'shorthand', model: null, warnings: ['目標函數行沒有數字。'], findings: [], confidence: 0 };
    }
    if (sense === null) {
      sense = /成本|費用|cost/i.test(objectiveSplit.label) ? 'min' : 'max';
      if (sense === 'min') {
        warnings.push('目標列名稱是「' + objectiveSplit.label + '」，沒有寫 max／min，已推測為最小化。若要改成最大化，請在第一行加上 max。');
      }
    }

    var varCount = objectiveValues.length;
    var constraintLines = body.filter(function (line, index) {
      return index !== objectiveIndex;
    });
    var constraints = constraintLines.map(function (line, index) {
      var split = splitLabel(line, '限制式' + (index + 1));
      var op = null;
      var before = [];
      var after = [];
      split.rest.split(/\s+/).forEach(function (token) {
        if (token === '<=' || token === '<') {
          op = op || '<=';
        } else if (token === '>=' || token === '>') {
          op = op || '>=';
        } else if (token === '=') {
          op = op || '=';
        } else if (isNumeric(token)) {
          (op ? after : before).push(token);
        }
      });
      var rhs = '0';
      var coefficients;
      if (op) {
        coefficients = before;
        if (after.length) {
          rhs = after[0];
        } else {
          warnings.push('「' + split.label + '」缺少右端值，暫以 0 代入。');
        }
      } else {
        op = sense === 'max' ? '<=' : '>=';
        coefficients = before.slice();
        if (coefficients.length > varCount) {
          rhs = coefficients.pop();
          warnings.push('「' + split.label + '」沒有寫關係符號，預設為 ' + OP_SYMBOL[op] + '。');
        } else if (coefficients.length === varCount) {
          warnings.push('「' + split.label + '」缺少關係符號與右端值（例如「<= 120」），右端值暫以 0 代入。');
        }
      }
      if (coefficients.length < varCount) {
        warnings.push('「' + split.label + '」的係數只有 ' + coefficients.length + ' 個（目標函數有 ' + varCount + ' 個變數），不足的部分已補 0。');
      } else if (coefficients.length > varCount) {
        warnings.push('「' + split.label + '」的係數有 ' + coefficients.length + ' 個，超過變數數 ' + varCount + '，多餘的已忽略。');
      }
      while (coefficients.length < varCount) {
        coefficients.push('0');
      }
      return { a: coefficients.slice(0, varCount), op: op, b: rhs, label: split.label };
    });

    var integer = [];
    var binary = [];
    var index;
    for (index = 0; index < varCount; index += 1) {
      integer.push(false);
      binary.push(false);
    }
    integerLines.forEach(function (text) {
      parseIndexList(text, varCount).forEach(function (position) {
        integer[position] = true;
      });
    });
    binaryLines.forEach(function (text) {
      parseIndexList(text, varCount).forEach(function (position) {
        binary[position] = true;
        integer[position] = false;
      });
    });

    var varNames = [];
    for (index = 0; index < varCount; index += 1) {
      varNames.push('x' + (index + 1));
    }

    findings.push({ label: '問題類型', value: sense === 'max' ? '最大化' : '最小化' });
    findings.push({ label: '決策變數', value: varCount + ' 個' });
    findings.push({ label: '目標係數', value: objectiveValues.join(', ') });
    constraints.forEach(function (constraint, position) {
      findings.push({
        label: '限制 ' + (position + 1) + '・' + constraint.label,
        value: formatTerms(constraint.a, varNames) + ' ' + OP_SYMBOL[constraint.op] + ' ' + constraint.b
      });
    });
    var typeNotes = [];
    if (integer.some(Boolean)) {
      typeNotes.push('整數：' + varNames.filter(function (name, position) { return integer[position]; }).join('、'));
    }
    if (binary.some(Boolean)) {
      typeNotes.push('0-1：' + varNames.filter(function (name, position) { return binary[position]; }).join('、'));
    }
    if (typeNotes.length) {
      findings.push({ label: '變數型態', value: typeNotes.join('；') });
    }

    var built = model.create({
      sense: sense,
      varNames: varNames,
      c: objectiveValues,
      constraints: constraints,
      integer: integer,
      binary: binary,
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
      confidence: constraints.length > 0 ? Math.max(0.5, 1 - 0.1 * warnings.length) : 0
    };
  }

  /* --------------------------------------------------------------------- */
  /* 入口：判斷是速記還是自然語言                                          */
  /* --------------------------------------------------------------------- */

  function looksLikeShorthand(text) {
    var lines = String(text || '')
      .split(/\n/)
      .map(function (line) {
        return line.trim();
      })
      .filter(function (line) {
        return line && line.charAt(0) !== '#' && line.slice(0, 2) !== '//';
      });
    if (lines.length < 2) {
      return false;
    }
    var hasSenseLine = lines.some(function (line) {
      return SENSE_LINE_RE.test(normalizeShorthandLine(line));
    });
    var numeric = lines.filter(function (line) {
      var normalized = normalizeShorthandLine(line);
      if (/[。；;]/.test(normalized) || normalized.length > 60) {
        return false;
      }
      return /^[^\d\s:+\-<>=][^:\d<>=]{0,14}?\s*:?\s*[+-]?\d/.test(normalized) && (normalized.match(/\d+(?:\.\d+)?/g) || []).length >= 2;
    });
    var others = lines.filter(function (line) {
      var normalized = normalizeShorthandLine(line);
      return !SENSE_LINE_RE.test(normalized) && !INTEGER_LINE_RE.test(normalized) && !BINARY_LINE_RE.test(normalized);
    });
    if (hasSenseLine) {
      return numeric.length >= 2;
    }
    return others.length >= 2 && numeric.length === others.length;
  }

  function parse(rawText) {
    var text = String(rawText || '');
    var shorthandWarnings = [];
    if (looksLikeShorthand(text)) {
      var shorthand = parseShorthand(text);
      if (shorthand.ok) {
        return shorthand;
      }
      shorthandWarnings = (shorthand.warnings || []).map(function (warning) {
        return '（速記格式）' + warning;
      });
    }
    var natural = parseNatural(text);
    if (!natural.ok && shorthandWarnings.length) {
      natural.warnings = shorthandWarnings.concat(natural.warnings || []);
    }
    return natural;
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
