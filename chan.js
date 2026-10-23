/* ==========================================================================
 * chan.js —— 缠论结构引擎
 *
 * 口径声明（重要，决定了指标可复算）：
 *   1) 输入 K 线必须为正序数组 [{d,o,h,l,c,v}]，且价格已做后复权（hfq）。
 *      前复权在除权日会产生跳空，会凭空造出假笔、假中枢，结构判定全部失真。
 *   2) 本引擎做「笔 → 中枢」两级结构，不做线段递归与走势类型递归。
 *      线段/走势需要特征序列处理，参数敏感且对选股无增量贡献；笔+中枢
 *      已足以判定一二三买。此取舍在页面口径说明中如实标注。
 *   3) 所有阈值常量化在 CFG 内，页面展示与回测共用同一套参数，不存在两套口径。
 * ========================================================================== */
var Chan = (function () {
  'use strict';

  var CFG = {
    MIN_GAP: 4,        // 成笔要求：两个分型之间至少间隔的合并K线根数
    PIVOT_MIN: 3,      // 构成中枢的最少笔数
    PIVOT_MAX_EXT: 9,  // 中枢最多延伸的笔数（不加限制会让月线中枢横跨数年、失去时效）
    DIV_RATIO: 0.85,   // 背驰判定：后段 MACD 面积 < 前段 × 该系数视为背驰
  };

  /* ---------------- 基础指标（内部自算，避免外部依赖口径不一致） ---------------- */
  function ema(arr, n) {
    var out = new Array(arr.length), k = 2 / (n + 1), prev = null;
    for (var i = 0; i < arr.length; i++) {
      prev = prev === null ? arr[i] : arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function macdOf(closes) {
    var e12 = ema(closes, 12), e26 = ema(closes, 26);
    var dif = [], i;
    for (i = 0; i < closes.length; i++) dif.push(e12[i] - e26[i]);
    var dea = ema(dif, 9), hist = [];
    for (i = 0; i < closes.length; i++) hist.push((dif[i] - dea[i]) * 2);
    return { dif: dif, dea: dea, hist: hist };
  }

  /* ---------------- 1. K 线包含关系处理 ----------------
   * 按当前趋势方向合并：向上取高高，向下取低低。合并后保留原始索引范围，
   * 使后续取价能回到未合并的真实高低点。 */
  function merge(bars) {
    var out = [];
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      if (out.length < 2) {
        out.push({ h: b.h, l: b.l, c: b.c, d: b.d, v: b.v, i0: i, i1: i });
        continue;
      }
      var p = out[out.length - 1], pp = out[out.length - 2];
      var dir = p.h >= pp.h ? 1 : -1;
      var contained = (b.h <= p.h && b.l >= p.l) || (b.h >= p.h && b.l <= p.l);
      if (contained) {
        if (dir > 0) {
          p.h = Math.max(p.h, b.h);
          p.l = Math.max(p.l, b.l);
        } else {
          p.h = Math.min(p.h, b.h);
          p.l = Math.min(p.l, b.l);
        }
        p.c = b.c; p.d = b.d; p.v += b.v; p.i1 = i;
      } else {
        out.push({ h: b.h, l: b.l, c: b.c, d: b.d, v: b.v, i0: i, i1: i });
      }
    }
    return out;
  }

  /* ---------------- 2. 分型 ----------------
   * 顶分型：中间K线的高点最高且低点也最高；底分型反之。两者必须同时满足，
   * 只判高点会在一字横盘区域产生大量伪分型。 */
  function fractals(ks) {
    var fs = [];
    for (var i = 1; i < ks.length - 1; i++) {
      var a = ks[i - 1], b = ks[i], c = ks[i + 1];
      if (b.h > a.h && b.h > c.h && b.l > a.l && b.l > c.l) {
        fs.push({ k: i, type: 1, price: b.h, d: b.d, i0: b.i0, i1: b.i1 });
      } else if (b.l < a.l && b.l < c.l && b.h < a.h && b.h < c.h) {
        fs.push({ k: i, type: -1, price: b.l, d: b.d, i0: b.i0, i1: b.i1 });
      }
    }
    return fs;
  }

  /* ---------------- 3. 笔 ----------------
   * 相邻反向分型且间隔达到 MIN_GAP 才成笔；同类分型取更极端者，保证顶底交替。 */
  function buildPens(fs) {
    var seq = [], i;
    for (i = 0; i < fs.length; i++) {
      var f = fs[i];
      if (!seq.length) { seq.push(f); continue; }
      var last = seq[seq.length - 1];
      if (f.type === last.type) {
        if ((f.type === 1 && f.price > last.price) || (f.type === -1 && f.price < last.price)) {
          seq[seq.length - 1] = f;
        }
      } else if (f.k - last.k >= CFG.MIN_GAP) {
        seq.push(f);
      }
    }
    var pens = [];
    for (i = 1; i < seq.length; i++) {
      var a = seq[i - 1], b = seq[i];
      if (b.type === 1 && b.price > a.price) {
        pens.push({ dir: 1, from: a, to: b, high: b.price, low: a.price,
          d0: a.d, d1: b.d, i0: a.i1, i1: b.i1, amp: (b.price - a.price) / a.price });
      } else if (b.type === -1 && b.price < a.price) {
        pens.push({ dir: -1, from: a, to: b, high: a.price, low: b.price,
          d0: a.d, d1: b.d, i0: a.i1, i1: b.i1, amp: (a.price - b.price) / a.price });
      }
    }
    /* 同向笔之间若被更小级别噪音打断，会留下同名相邻笔，此处做一次收敛 */
    var clean = [];
    for (i = 0; i < pens.length; i++) {
      var p = pens[i], q = clean[clean.length - 1];
      if (q && q.dir === p.dir) {
        if ((p.dir > 0 && p.high > q.high) || (p.dir < 0 && p.low < q.low)) clean[clean.length - 1] = p;
      } else clean.push(p);
    }
    return clean;
  }

  /* ---------------- 4. 中枢 ----------------
   * 连续三笔的重叠区间：ZG = 三笔高点最小，ZD = 三笔低点最大。ZG > ZD 才成立。
   * 中枢形成后允许后续笔延伸（不扩展中枢区间，只延长时间）。 */
  function buildPivots(pens) {
    var out = [], i = 0;
    while (i + CFG.PIVOT_MIN - 1 < pens.length) {
      var g = pens.slice(i, i + CFG.PIVOT_MIN);
      var highs = g.map(function (p) { return p.high; });
      var lows = g.map(function (p) { return p.low; });
      var zg = Math.min.apply(null, highs), zd = Math.max.apply(null, lows);
      if (zg > zd) {
        var piv = {
          zg: zg, zd: zd,
          gg: Math.max.apply(null, highs), dd: Math.min.apply(null, lows),
          startPen: i, endPen: i + CFG.PIVOT_MIN - 1,
          d0: g[0].d0, d1: g[g.length - 1].d1,
          mid: (zg + zd) / 2,
        };
        /* 延伸：后续笔若仍与区间重叠则并入，直到向上/向下离开或达到笔数上限 */
        var j = i + CFG.PIVOT_MIN;
        while (j < pens.length && j - i < CFG.PIVOT_MAX_EXT) {
          var pj = pens[j];
          if (pj.low <= zg && pj.high >= zd) { piv.endPen = j; piv.d1 = pj.d1; j++; }
          else break;
        }
        out.push(piv);
        i = piv.endPen + 1;
      } else {
        i++;
      }
    }
    return out;
  }

  /* ---------------- 5. 背驰 ----------------
   * 同向相邻两笔比较 MACD 红绿柱面积：后段价格创新极值但面积明显缩小 = 背驰。 */
  function divergence(pens, bars, macd) {
    var res = { type: null, ratio: null, note: '' };
    if (pens.length < 3) return res;
    var last = pens[pens.length - 1], prevSame = null, i;
    for (i = pens.length - 2; i >= 0; i--) {
      if (pens[i].dir === last.dir) { prevSame = pens[i]; break; }
    }
    if (!prevSame) return res;
    function area(p) {
      var s = 0;
      for (var k = p.i0; k <= p.i1 && k < macd.hist.length; k++) {
        var h = macd.hist[k];
        if (p.dir < 0 && h < 0) s += -h;
        if (p.dir > 0 && h > 0) s += h;
      }
      return s;
    }
    var a1 = area(prevSame), a2 = area(last);
    if (a1 <= 0) return res;
    var r = a2 / a1;
    var newExtreme = last.dir < 0 ? (last.low < prevSame.low) : (last.high > prevSame.high);
    if (newExtreme && r < CFG.DIV_RATIO) {
      res.type = last.dir < 0 ? 'bottom' : 'top';
      res.ratio = r;
      res.note = (last.dir < 0 ? '下跌' : '上涨') + '创新' + (last.dir < 0 ? '低' : '高') +
        '但 MACD 动能仅为前段的 ' + (r * 100).toFixed(0) + '%，' +
        (last.dir < 0 ? '底背驰' : '顶背驰');
    }
    return res;
  }

  /* ---------------- 6. 买点判定 ----------------
   * 三买：向上离开中枢后，回调笔低点仍高于中枢上沿 ZG；
   * 二买：回调笔低点高于前一同向笔低点（不破前低）；
   * 一买：下跌笔创新低但出现底背驰。
   * 只判定最后一个「已完成笔」，未完成笔不参与（避免未来函数）。 */
  function buyPoint(pens, pivots, diverg, price) {
    if (!pens.length) return { type: 'none', text: '结构不足' };
    var last = pens[pens.length - 1];
    var piv = pivots.length ? pivots[pivots.length - 1] : null;

    if (last.dir > 0) {
      return { type: 'none', text: '当前笔向上运行中，处于持仓/等待回调阶段，非新买点', running: true };
    }

    /* 三买：回调笔的低点未回到最近中枢内部 */
    if (piv && last.low > piv.zg && piv.endPen < pens.length - 1) {
      return {
        type: 'third', grade: 3,
        price: last.low, d: last.d1,
        text: '三买：向上离开中枢（上沿 ' + piv.zg.toFixed(2) + '）后回调低点 ' + last.low.toFixed(2) +
          ' 未回中枢，回踩确认，结构最健康',
      };
    }

    /* 二买：不破前一低点 */
    var prevDown = null;
    for (var i = pens.length - 2; i >= 0; i--) {
      if (pens[i].dir === -1) { prevDown = pens[i]; break; }
    }
    if (prevDown && last.low > prevDown.low) {
      return {
        type: 'second', grade: 2,
        price: last.low, d: last.d1,
        text: '二买：回调低点 ' + last.low.toFixed(2) + ' 高于前低 ' + prevDown.low.toFixed(2) +
          '，不破前低，趋势延续概率较高',
      };
    }

    /* 一买：底背驰 */
    if (diverg && diverg.type === 'bottom') {
      return {
        type: 'first', grade: 1,
        price: last.low, d: last.d1,
        text: '一买：' + diverg.note + '，属超跌反弹性质，需等待次级别回踩不创新低再介入',
      };
    }

    return { type: 'none', text: '无有效买点，当前结构为下跌笔延续或中枢震荡' };
  }

  /* ---------------- 7. 级别摘要 ----------------
   * 供多级别联立使用：给出该级别的方向、是否在上升笔、相对中枢位置。 */
  function structure(bars) {
    if (!bars || bars.length < 30) return null;
    var closes = bars.map(function (b) { return b.c; });
    var macd = macdOf(closes);
    var ks = merge(bars);
    var fs = fractals(ks);
    var pens = buildPens(fs);
    var pivots = buildPivots(pens);
    var last = pens.length ? pens[pens.length - 1] : null;
    var piv = pivots.length ? pivots[pivots.length - 1] : null;
    var price = closes[closes.length - 1];
    var div = divergence(pens, bars, macd);

    var position = 'unknown';
    if (piv) position = price > piv.zg ? 'above' : (price < piv.zd ? 'below' : 'inside');

    /* 级别方向：以最后一笔方向为主，结合是否站上中枢上沿 */
    var dir = 0;
    if (last) {
      dir = last.dir;
      if (piv) {
        if (position === 'above' && last.dir < 0) dir = 1;        // 回踩不破，仍属上行
        if (position === 'below' && last.dir > 0) dir = -1;       // 反抽未过，仍属下行
      }
    }

    var buy = buyPoint(pens, pivots, div, price);
    /* 方向与买点冲突时降级：下降趋势里的二买/三买需要上级别配合才成立 */
    if (buy.grade && dir < 0) {
      buy.grade = Math.max(1, buy.grade - 1);
      buy.text += '（注意：本级别方向仍向下，此买点需上级别转强配合，单独使用风险偏高）';
      buy.conflict = true;
    }

    return {
      bars: bars.length, pens: pens, pivots: pivots,
      penCount: pens.length, pivotCount: pivots.length,
      lastPen: last, lastPivot: piv, position: position,
      dir: dir, dirText: dir > 0 ? '向上' : dir < 0 ? '向下' : '不明',
      price: price, diverg: div,
      buy: buy,
      ks: ks, macd: macd,
    };
  }

  /* 级别内的相对强弱：最后一笔幅度 / 该级别 ATR 的倍数，用于多级别打分 */
  function penStrength(st) {
    if (!st || !st.lastPen) return 0;
    var p = st.lastPen;
    var span = Math.max(p.high - p.low, 1e-9);
    var ks = st.ks;
    var sum = 0, n = 0;
    for (var i = Math.max(1, ks.length - 20); i < ks.length; i++) {
      sum += ks[i].h - ks[i].l; n++;
    }
    var atr = n ? sum / n : span;
    return span / (atr || span);
  }

  var api = {
    CFG: CFG, structure: structure, merge: merge, fractals: fractals,
    buildPens: buildPens, buildPivots: buildPivots, divergence: divergence,
    penStrength: penStrength, macd: macdOf, ema: ema,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
