/* ============================================================================
 * fraction.js — 精確有理數運算（BigInt 分子／分母）
 * ----------------------------------------------------------------------------
 * 線性規劃的求解若使用浮點數，容易在退化（degenerate）情境累積誤差，
 * 導致影子價格出現 0.9999999 這類不可信的數字。本模組以 BigInt 分數
 * 進行精確運算，使最佳解、影子價格與敏感度範圍都能「剛剛好」精確呈現。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});

  var ZERO_BIG = BigInt(0);
  var ONE_BIG = BigInt(1);
  var MINUS_ONE_BIG = BigInt(-1);

  function absBig(value) {
    return value < ZERO_BIG ? -value : value;
  }

  function gcdBig(a, b) {
    a = absBig(a);
    b = absBig(b);
    while (b !== ZERO_BIG) {
      var rest = a % b;
      a = b;
      b = rest;
    }
    return a === ZERO_BIG ? ONE_BIG : a;
  }

  function pow10(exponent) {
    return BigInt(10) ** BigInt(exponent);
  }

  /* --------------------------------------------------------------------- */
  /* 建構與解析                                                            */
  /* --------------------------------------------------------------------- */

  function Frac(numerator, denominator) {
    var n = numerator === undefined ? ZERO_BIG : numerator;
    var d = denominator === undefined ? ONE_BIG : denominator;
    if (d === ZERO_BIG) {
      throw new Error('分母不可為零');
    }
    if (d < ZERO_BIG) {
      n = -n;
      d = -d;
    }
    if (n === ZERO_BIG) {
      this.n = ZERO_BIG;
      this.d = ONE_BIG;
      return;
    }
    var divisor = gcdBig(n, d);
    this.n = n / divisor;
    this.d = d / divisor;
  }

  Frac.ZERO = null;
  Frac.ONE = null;

  Frac.fromBig = function (n, d) {
    return new Frac(n, d === undefined ? ONE_BIG : d);
  };

  Frac.fromInt = function (value) {
    var asNumber = Number(value);
    if (!isFinite(asNumber)) {
      throw new Error('數值必須是有限數');
    }
    if (!Number.isInteger(asNumber)) {
      return Frac.parse(String(asNumber));
    }
    return new Frac(BigInt(Math.trunc(asNumber)));
  };

  /**
   * 解析使用者輸入：支援「12」「-3.5」「7/3」「1e-3」「−4」（全形負號）。
   */
  Frac.parse = function (input) {
    if (input instanceof Frac) {
      return input;
    }
    if (typeof input === 'number') {
      if (!isFinite(input)) {
        throw new Error('數值必須是有限數');
      }
      return Frac.parse(String(input));
    }
    if (input === null || input === undefined) {
      throw new Error('缺少數值');
    }
    var text = String(input)
      .trim()
      .replace(/[\s,，]/g, '')
      .replace(/[−–—]/g, '-')
      .replace(/／/g, '/');
    if (!text) {
      throw new Error('缺少數值');
    }
    var fractionMatch = /^([+-]?\d+)\/([+-]?\d+)$/.exec(text);
    if (fractionMatch) {
      return new Frac(BigInt(fractionMatch[1]), BigInt(fractionMatch[2]));
    }
    var decimalMatch = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!decimalMatch || (!decimalMatch[2] && !decimalMatch[3])) {
      throw new Error('無法解析數值「' + input + '」');
    }
    var isNegative = decimalMatch[1] === '-';
    var integerPart = decimalMatch[2] || '0';
    var fractionPart = decimalMatch[3] || '';
    var exponent = decimalMatch[4] ? parseInt(decimalMatch[4], 10) : 0;
    var numerator = BigInt(integerPart + fractionPart);
    var denominator = pow10(fractionPart.length);
    if (exponent > 0) {
      numerator *= pow10(exponent);
    } else if (exponent < 0) {
      denominator *= pow10(-exponent);
    }
    return new Frac(isNegative ? -numerator : numerator, denominator);
  };

  /** 把任意可解析值轉成 Frac；null/空字串視為 0。 */
  Frac.coerce = function (input) {
    if (input === null || input === undefined || input === '') {
      return Frac.zero();
    }
    return Frac.parse(input);
  };

  Frac.zero = function () {
    return new Frac();
  };
  Frac.one = function () {
    return new Frac(ONE_BIG);
  };
  Frac.minusOne = function () {
    return new Frac(MINUS_ONE_BIG);
  };

  /* --------------------------------------------------------------------- */
  /* 四則運算                                                              */
  /* --------------------------------------------------------------------- */

  Frac.prototype.add = function (other) {
    var rhs = Frac.parse(other);
    return new Frac(this.n * rhs.d + rhs.n * this.d, this.d * rhs.d);
  };

  Frac.prototype.sub = function (other) {
    var rhs = Frac.parse(other);
    return new Frac(this.n * rhs.d - rhs.n * this.d, this.d * rhs.d);
  };

  Frac.prototype.mul = function (other) {
    var rhs = Frac.parse(other);
    return new Frac(this.n * rhs.n, this.d * rhs.d);
  };

  Frac.prototype.div = function (other) {
    var rhs = Frac.parse(other);
    if (rhs.n === ZERO_BIG) {
      throw new Error('除以零');
    }
    return new Frac(this.n * rhs.d, this.d * rhs.n);
  };

  Frac.prototype.neg = function () {
    return new Frac(-this.n, this.d);
  };

  Frac.prototype.abs = function () {
    return new Frac(absBig(this.n), this.d);
  };

  Frac.prototype.inv = function () {
    if (this.n === ZERO_BIG) {
      throw new Error('零沒有倒數');
    }
    return new Frac(this.d, this.n);
  };

  /* --------------------------------------------------------------------- */
  /* 比較與判斷                                                            */
  /* --------------------------------------------------------------------- */

  Frac.prototype.cmp = function (other) {
    var rhs = Frac.parse(other);
    var left = this.n * rhs.d;
    var right = rhs.n * this.d;
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  };

  Frac.prototype.eq = function (other) {
    return this.cmp(other) === 0;
  };
  Frac.prototype.lt = function (other) {
    return this.cmp(other) < 0;
  };
  Frac.prototype.lte = function (other) {
    return this.cmp(other) <= 0;
  };
  Frac.prototype.gt = function (other) {
    return this.cmp(other) > 0;
  };
  Frac.prototype.gte = function (other) {
    return this.cmp(other) >= 0;
  };

  Frac.prototype.sign = function () {
    if (this.n === ZERO_BIG) {
      return 0;
    }
    return this.n < ZERO_BIG ? -1 : 1;
  };
  Frac.prototype.isZero = function () {
    return this.n === ZERO_BIG;
  };
  Frac.prototype.isPos = function () {
    return this.n > ZERO_BIG;
  };
  Frac.prototype.isNeg = function () {
    return this.n < ZERO_BIG;
  };
  Frac.prototype.isInteger = function () {
    return this.d === ONE_BIG;
  };
  Frac.prototype.isOne = function () {
    return this.n === ONE_BIG && this.d === ONE_BIG;
  };
  Frac.prototype.isMinusOne = function () {
    return this.n === MINUS_ONE_BIG && this.d === ONE_BIG;
  };

  /** 向下取整（負數亦正確）。 */
  Frac.prototype.floor = function () {
    var quotient = this.n / this.d;
    if (this.n < ZERO_BIG && quotient * this.d !== this.n) {
      quotient -= ONE_BIG;
    }
    return new Frac(quotient);
  };

  /** 向上取整。 */
  Frac.prototype.ceil = function () {
    var quotient = this.n / this.d;
    if (this.n > ZERO_BIG && quotient * this.d !== this.n) {
      quotient += ONE_BIG;
    }
    return new Frac(quotient);
  };

  Frac.prototype.round = function () {
    return this.add(Frac.parse('0.5')).floor();
  };

  /* --------------------------------------------------------------------- */
  /* 輸出                                                                  */
  /* --------------------------------------------------------------------- */

  Frac.prototype.toNumber = function () {
    return Number(this.n) / Number(this.d);
  };

  Frac.prototype.valueOf = function () {
    return this.toNumber();
  };

  Frac.prototype.toString = function () {
    if (this.d === ONE_BIG) {
      return this.n.toString();
    }
    return this.n.toString() + '/' + this.d.toString();
  };

  Frac.prototype.toJSON = function () {
    return this.toString();
  };

  /** 分母只含 2 與 5 的因數 → 可寫成有限小數。 */
  Frac.prototype.hasFiniteDecimal = function () {
    var rest = this.d;
    while (rest % BigInt(2) === ZERO_BIG) {
      rest /= BigInt(2);
    }
    while (rest % BigInt(5) === ZERO_BIG) {
      rest /= BigInt(5);
    }
    return rest === ONE_BIG;
  };

  /**
   * 轉成小數字串，四捨五入到指定小數位，並去除尾端多餘的 0。
   */
  Frac.prototype.toDecimal = function (maxDigits) {
    var digits = maxDigits === undefined ? 4 : maxDigits;
    if (this.d === ONE_BIG) {
      return this.n.toString();
    }
    var negative = this.n < ZERO_BIG;
    var absN = absBig(this.n);
    var scale = pow10(digits);
    var scaled = (absN * scale * BigInt(2) + this.d) / (this.d * BigInt(2));
    var text = scaled.toString();
    if (text.length <= digits) {
      text = '0'.repeat(digits - text.length + 1) + text;
    }
    var whole = text.slice(0, text.length - digits);
    var decimal = text.slice(text.length - digits).replace(/0+$/, '');
    var result = decimal ? whole + '.' + decimal : whole;
    if (result === '0') {
      negative = false;
    }
    return negative ? '-' + result : result;
  };

  /** 混合顯示：整數直接顯示；有限小數顯示小數；其餘顯示分數（附近似值）。 */
  Frac.prototype.toPretty = function (options) {
    var opts = options || {};
    if (this.d === ONE_BIG) {
      return this.n.toString();
    }
    if (opts.mode === 'fraction') {
      return this.toString();
    }
    if (this.hasFiniteDecimal() && Math.abs(this.toNumber()) < 1e12) {
      return this.toDecimal(opts.digits === undefined ? 4 : opts.digits);
    }
    return this.toString();
  };

  Frac.prototype.toApprox = function (digits) {
    return this.toDecimal(digits === undefined ? 4 : digits);
  };

  Frac.zero = function () {
    return new Frac();
  };

  LPC.Frac = Frac;
})(typeof window !== 'undefined' ? window : globalThis);
