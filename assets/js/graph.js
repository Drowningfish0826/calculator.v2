/* ============================================================================
 * graph.js — 兩變數線性規劃的圖形分析（SVG，零依賴）
 * ----------------------------------------------------------------------------
 * 繪製：限制式直線、可行區域、頂點、最佳解、等利潤線（可拖動 Z 值）
 * 幾何計算全部以「半平面裁切」完成，因此任意數量的限制式都能正確求交。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});
  var Frac = LPC.Frac;
  var fmt = LPC.model.fmt;

  var VIEW = { width: 700, height: 405, margin: { top: 16, right: 22, bottom: 40, left: 48 } };

  function toNumber(value) {
    try {
      return Frac.coerce(value).toNumber();
    } catch (error) {
      return NaN;
    }
  }

  function niceStep(rawStep) {
    if (!isFinite(rawStep) || rawStep <= 0) {
      return 1;
    }
    var exponent = Math.floor(Math.log10(rawStep));
    var base = Math.pow(10, exponent);
    var candidates = [1, 2, 2.5, 5, 10];
    for (var index = 0; index < candidates.length; index += 1) {
      if (rawStep <= candidates[index] * base) {
        return candidates[index] * base;
      }
    }
    return 10 * base;
  }

  /** 蒐集繪圖視窗：原點、各限制式的截距、最佳解，再加邊界留白。 */
  function computeWindow(model, result) {
    var xs = [0];
    var ys = [0];
    model.constraints.forEach(function (constraint) {
      var a1 = toNumber(constraint.a[0]);
      var a2 = toNumber(constraint.a[1]);
      var b = toNumber(constraint.b);
      if (a1 !== 0 && isFinite(b / a1)) {
        xs.push(b / a1);
      }
      if (a2 !== 0 && isFinite(b / a2)) {
        ys.push(b / a2);
      }
    });
    if (result && result.status === 'optimal' && result.x) {
      xs.push(toNumber(result.x[0]));
      ys.push(toNumber(result.x[1]));
    }
    var xMin = Math.min.apply(null, xs);
    var xMax = Math.max.apply(null, xs);
    var yMin = Math.min.apply(null, ys);
    var yMax = Math.max.apply(null, ys);
    if (!isFinite(xMin) || !isFinite(xMax) || xMax - xMin < 1e-9) {
      xMin = 0;
      xMax = 10;
    }
    if (!isFinite(yMin) || !isFinite(yMax) || yMax - yMin < 1e-9) {
      yMin = 0;
      yMax = 10;
    }
    if (model.nonNeg !== false) {
      xMin = Math.max(0, xMin);
      yMin = Math.max(0, yMin);
    }
    var padX = (xMax - xMin) * 0.12 || 1;
    var padY = (yMax - yMin) * 0.14 || 1;
    return {
      xMin: xMin - padX * 0.2,
      xMax: xMax + padX,
      yMin: yMin - padY * 0.2,
      yMax: yMax + padY
    };
  }

  function makeScale(window, plot) {
    return {
      x: function (value) {
        return plot.left + ((value - window.xMin) / (window.xMax - window.xMin)) * plot.width;
      },
      y: function (value) {
        return plot.top + plot.height - ((value - window.yMin) / (window.yMax - window.yMin)) * plot.height;
      }
    };
  }

  /* ---- 半平面裁切（Sutherland–Hodgman） ---- */
  function clipPolygon(polygon, evaluate) {
    var output = [];
    for (var index = 0; index < polygon.length; index += 1) {
      var current = polygon[index];
      var previous = polygon[(index + polygon.length - 1) % polygon.length];
      var currentValue = evaluate(current);
      var previousValue = evaluate(previous);
      var currentInside = currentValue >= -1e-12;
      var previousInside = previousValue >= -1e-12;
      if (currentInside) {
        if (!previousInside) {
          output.push(intersect(previous, current, previousValue, currentValue));
        }
        output.push(current);
      } else if (previousInside) {
        output.push(intersect(previous, current, previousValue, currentValue));
      }
    }
    return output;
  }

  function intersect(from, to, fromValue, toValue) {
    var ratio = fromValue / (fromValue - toValue);
    return {
      x: from.x + (to.x - from.x) * ratio,
      y: from.y + (to.y - from.y) * ratio
    };
  }

  function constraintEvaluator(constraint) {
    var a1 = toNumber(constraint.a[0]);
    var a2 = toNumber(constraint.a[1]);
    var b = toNumber(constraint.b);
    if (constraint.op === '>=') {
      return function (point) {
        return a1 * point.x + a2 * point.y - b;
      };
    }
    if (constraint.op === '=') {
      return null;
    }
    return function (point) {
      return b - (a1 * point.x + a2 * point.y);
    };
  }

  function feasiblePolygon(model, window) {
    var polygon = [
      { x: window.xMin, y: window.yMin },
      { x: window.xMax, y: window.yMin },
      { x: window.xMax, y: window.yMax },
      { x: window.xMin, y: window.yMax }
    ];
    if (model.nonNeg !== false) {
      polygon = clipPolygon(polygon, function (point) {
        return point.x;
      });
      polygon = clipPolygon(polygon, function (point) {
        return point.y;
      });
    }
    for (var index = 0; index < model.constraints.length; index += 1) {
      var evaluate = constraintEvaluator(model.constraints[index]);
      if (!evaluate) {
        return null;
      }
      polygon = clipPolygon(polygon, evaluate);
      if (!polygon.length) {
        return [];
      }
    }
    return polygon;
  }

  function lineSegment(a1, a2, b, window) {
    var points = [];
    function addIfInside(x, y) {
      if (
        x >= window.xMin - 1e-9 &&
        x <= window.xMax + 1e-9 &&
        y >= window.yMin - 1e-9 &&
        y <= window.yMax + 1e-9
      ) {
        points.push({ x: x, y: y });
      }
    }
    if (Math.abs(a2) > 1e-12) {
      addIfInside(window.xMin, (b - a1 * window.xMin) / a2);
      addIfInside(window.xMax, (b - a1 * window.xMax) / a2);
    }
    if (Math.abs(a1) > 1e-12) {
      addIfInside((b - a2 * window.yMin) / a1, window.yMin);
      addIfInside((b - a2 * window.yMax) / a1, window.yMax);
    }
    if (points.length < 2) {
      return null;
    }
    var first = points[0];
    var farthest = first;
    var best = -1;
    points.forEach(function (point) {
      var distance = Math.hypot(point.x - first.x, point.y - first.y);
      if (distance > best) {
        best = distance;
        farthest = point;
      }
    });
    return [first, farthest];
  }

  function verticesOf(model, window) {
    var lines = [];
    var index;
    for (index = 0; index < model.constraints.length; index += 1) {
      lines.push({
        a1: toNumber(model.constraints[index].a[0]),
        a2: toNumber(model.constraints[index].a[1]),
        b: toNumber(model.constraints[index].b),
        op: model.constraints[index].op
      });
    }
    if (model.nonNeg !== false) {
      lines.push({ a1: 1, a2: 0, b: 0, op: '>=' });
      lines.push({ a1: 0, a2: 1, b: 0, op: '>=' });
    }
    var points = [];
    var seen = {};
    function consider(x, y) {
      lines.forEach(function (line) {
        var value = line.a1 * x + line.a2 * y;
        var ok =
          line.op === '<=' ? value <= line.b + 1e-7 : line.op === '>=' ? value >= line.b - 1e-7 : Math.abs(value - line.b) <= 1e-7;
        if (!ok) {
          // 允許誤差範圍內的邊界點
          ok = Math.abs(value - line.b) <= 1e-7;
        }
        if (!ok) {
          throw new Error('infeasible');
        }
      });
      if (
        x < window.xMin - 1e-7 ||
        x > window.xMax + 1e-7 ||
        y < window.yMin - 1e-7 ||
        y > window.yMax + 1e-7
      ) {
        return;
      }
      var key = x.toFixed(6) + ',' + y.toFixed(6);
      if (seen[key]) {
        return;
      }
      seen[key] = true;
      points.push({ x: x, y: y });
    }
    for (var i = 0; i < lines.length; i += 1) {
      for (var j = i + 1; j < lines.length; j += 1) {
        var det = lines[i].a1 * lines[j].a2 - lines[i].a2 * lines[j].a1;
        if (Math.abs(det) < 1e-12) {
          continue;
        }
        var x = (lines[i].b * lines[j].a2 - lines[i].a2 * lines[j].b) / det;
        var y = (lines[i].a1 * lines[j].b - lines[i].b * lines[j].a1) / det;
        try {
          consider(x, y);
        } catch (error) {
          /* 不在可行區域內 */
        }
      }
    }
    return points;
  }

  function formatTick(value) {
    if (Math.abs(value) < 1e-12) {
      return '0';
    }
    var rounded = Math.round(value * 1000) / 1000;
    return String(rounded);
  }

  function escapeHTML(text) {
    return LPC.model.escapeHTML(text);
  }

  function render(options) {
    var model = options.model;
    var result = options.result;
    var isoLevel = options.isoLevel;
    var showIntegers = options.showIntegers !== false;
    var window = computeWindow(model, result);

    var plot = {
      left: VIEW.margin.left,
      top: VIEW.margin.top,
      width: VIEW.width - VIEW.margin.left - VIEW.margin.right,
      height: VIEW.height - VIEW.margin.top - VIEW.margin.bottom
    };
    var scale = makeScale(window, plot);
    var parts = [];

    parts.push(
      '<svg class="graph-svg" viewBox="0 0 ' +
        VIEW.width +
        ' ' +
        VIEW.height +
        '" role="img" aria-label="線性規劃可行區域與最佳解圖形">'
    );

    /* ---- 網格 ---- */
    var xStep = niceStep((window.xMax - window.xMin) / 8);
    var yStep = niceStep((window.yMax - window.yMin) / 7);
    var tickValue;
    for (tickValue = Math.ceil(window.xMin / xStep) * xStep; tickValue <= window.xMax; tickValue += xStep) {
      var gridX = scale.x(tickValue);
      parts.push(
        '<line class="grid-line" x1="' + gridX + '" y1="' + plot.top + '" x2="' + gridX + '" y2="' + (plot.top + plot.height) + '"/>'
      );
      parts.push(
        '<text x="' + gridX + '" y="' + (plot.top + plot.height + 15) + '" text-anchor="middle">' +
          formatTick(tickValue) +
          '</text>'
      );
    }
    for (tickValue = Math.ceil(window.yMin / yStep) * yStep; tickValue <= window.yMax; tickValue += yStep) {
      var gridY = scale.y(tickValue);
      parts.push(
        '<line class="grid-line" x1="' + plot.left + '" y1="' + gridY + '" x2="' + (plot.left + plot.width) + '" y2="' + gridY + '"/>'
      );
      parts.push(
        '<text x="' + (plot.left - 9) + '" y="' + (gridY + 3.5) + '" text-anchor="end">' +
          formatTick(tickValue) +
          '</text>'
      );
    }

    /* ---- 座標軸 ---- */
    var axisY = scale.y(Math.max(0, window.yMin));
    var axisX = scale.x(Math.max(0, window.xMin));
    if (window.yMin <= 0 && window.yMax >= 0) {
      parts.push(
        '<line class="axis-line" x1="' + plot.left + '" y1="' + axisY + '" x2="' + (plot.left + plot.width) + '" y2="' + axisY + '"/>'
      );
    }
    if (window.xMin <= 0 && window.xMax >= 0) {
      parts.push(
        '<line class="axis-line" x1="' + axisX + '" y1="' + plot.top + '" x2="' + axisX + '" y2="' + (plot.top + plot.height) + '"/>'
      );
    }
    parts.push(
      '<text x="' + (plot.left + plot.width) + '" y="' + (axisY - 8) + '" text-anchor="end">' +
        escapeHTML(model.varNames[0]) +
        '</text>'
    );
    parts.push(
      '<text x="' + (axisX + 8) + '" y="' + (plot.top + 10) + '">' + escapeHTML(model.varNames[1]) + '</text>'
    );

    /* ---- 可行區域 ---- */
    var polygon = feasiblePolygon(model, window);
    if (polygon === null) {
      parts.push(
        '<text x="' + (plot.left + plot.width / 2) + '" y="' + (plot.top + plot.height / 2) +
          '" text-anchor="middle" fill="var(--ink-3)">含等式限制式，可行區域退化為線段</text>'
      );
    } else if (polygon.length >= 3) {
      parts.push(
        '<polygon class="feasible-region" points="' +
          polygon
            .map(function (point) {
              return scale.x(point.x) + ',' + scale.y(point.y);
            })
            .join(' ') +
          '"/>'
      );
    }

    /* ---- 限制式直線 ---- */
    model.constraints.forEach(function (constraint, index) {
      var a1 = toNumber(constraint.a[0]);
      var a2 = toNumber(constraint.a[1]);
      var b = toNumber(constraint.b);
      var segment = lineSegment(a1, a2, b, window);
      if (!segment) {
        return;
      }
      var binding = false;
      if (result && result.status === 'optimal' && result.constraints[index]) {
        binding = result.constraints[index].binding;
      }
      parts.push(
        '<line class="constraint-line' +
          (binding ? ' is-binding' : '') +
          '" x1="' +
          scale.x(segment[0].x) +
          '" y1="' +
          scale.y(segment[0].y) +
          '" x2="' +
          scale.x(segment[1].x) +
          '" y2="' +
          scale.y(segment[1].y) +
          '"/>'
      );
      var anchor = {
        x: segment[0].x + (segment[1].x - segment[0].x) * 0.82,
        y: segment[0].y + (segment[1].y - segment[0].y) * 0.82
      };
      parts.push(
        '<text x="' +
          (scale.x(anchor.x) + 6) +
          '" y="' +
          (scale.y(anchor.y) - 6) +
          '">(' +
          (index + 1) +
          ')' +
          (constraint.label ? ' ' + escapeHTML(constraint.label) : '') +
          '</text>'
      );
    });

    /* ---- 頂點 ---- */
    var vertices = verticesOf(model, window);
    vertices.forEach(function (point) {
      parts.push(
        '<circle class="vertex-point" cx="' + scale.x(point.x) + '" cy="' + scale.y(point.y) + '" r="2.6"/>'
      );
    });

    /* ---- 整數點 ---- */
    if (showIntegers && model.integer.some(Boolean)) {
      var xStepInt = Math.max(1, Math.round((window.xMax - window.xMin) / 22));
      var yStepInt = Math.max(1, Math.round((window.yMax - window.yMin) / 18));
      for (var gx = Math.ceil(Math.max(0, window.xMin)); gx <= window.xMax; gx += xStepInt) {
        for (var gy = Math.ceil(Math.max(0, window.yMin)); gy <= window.yMax; gy += yStepInt) {
          var feasible = model.constraints.every(function (constraint) {
            var value = toNumber(constraint.a[0]) * gx + toNumber(constraint.a[1]) * gy;
            var target = toNumber(constraint.b);
            if (constraint.op === '<=') {
              return value <= target + 1e-9;
            }
            if (constraint.op === '>=') {
              return value >= target - 1e-9;
            }
            return Math.abs(value - target) <= 1e-9;
          });
          if (feasible) {
            parts.push(
              '<circle class="integer-point" cx="' + scale.x(gx) + '" cy="' + scale.y(gy) + '" r="1.9"/>'
            );
          }
        }
      }
    }

    /* ---- 等利潤線 ---- */
    var c1 = toNumber(model.c[0]);
    var c2 = toNumber(model.c[1]);
    if ((c1 !== 0 || c2 !== 0) && isoLevel !== undefined && isoLevel !== null) {
      var iso = isFinite(isoLevel) ? isoLevel : 0;
      var isoPoint;
      var isoEnd;
      if (Math.abs(c2) < 1e-12) {
        isoPoint = { x: iso / c1, y: window.yMin };
        isoEnd = { x: iso / c1, y: window.yMax };
      } else {
        isoPoint = { x: window.xMin, y: (iso - c1 * window.xMin) / c2 };
        isoEnd = { x: window.xMax, y: (iso - c1 * window.xMax) / c2 };
      }
      parts.push(
        '<line class="iso-line" x1="' + scale.x(isoPoint.x) + '" y1="' + scale.y(isoPoint.y) +
          '" x2="' + scale.x(isoEnd.x) + '" y2="' + scale.y(isoEnd.y) + '"/>'
      );
    }

    /* ---- 最佳解 ---- */
    if (result && result.status === 'optimal') {
      var px = toNumber(result.x[0]);
      var py = toNumber(result.x[1]);
      var cx = scale.x(px);
      var cy = scale.y(py);
      parts.push(
        '<line x1="' + cx + '" y1="' + cy + '" x2="' + cx + '" y2="' + (plot.top + plot.height) +
          '" stroke="var(--ink-3)" stroke-width="0.8" stroke-dasharray="2 3"/>'
      );
      parts.push(
        '<line x1="' + cx + '" y1="' + cy + '" x2="' + plot.left + '" y2="' + cy +
          '" stroke="var(--ink-3)" stroke-width="0.8" stroke-dasharray="2 3"/>'
      );
      parts.push('<circle class="optimal-point" cx="' + cx + '" cy="' + cy + '" r="5"/>');
      parts.push(
        '<text x="' + (cx + 9) + '" y="' + (cy - 9) + '" fill="var(--ink)" font-weight="500">最佳解 (' +
          fmt(Frac.coerce(result.x[0]), { digits: 3 }) +
          ', ' +
          fmt(Frac.coerce(result.x[1]), { digits: 3 }) +
          ')</text>'
      );
    }

    parts.push('</svg>');

    return {
      svg: parts.join(''),
      window: window,
      maxIso: result && result.status === 'optimal' ? toNumber(result.z) : null
    };
  }

  LPC.graph = {
    render: render,
    computeWindow: computeWindow
  };
})(typeof window !== 'undefined' ? window : globalThis);
