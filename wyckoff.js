/* ==========================================================================
 * wyckoff.js —— 威科夫量价事件引擎
 *
 * 设计原则：所有事件必须是「可复算的阈值判定」，不允许出现"看起来像吸筹"
 * 这类主观描述。每个事件都给出触发数值，便于在页面上逐条核对。
 *
 * 两个关键口径：
 *   1) 事件在「最近 EVENT_WINDOW 根K线」内检测并做时间衰减。只测当日会让信号
 *      极度稀疏（实测 60 个交易日仅 7 次触发），选股就失去区分度；而 Spring
 *      之后第 2 日介入本来也是有效买点。
 *   2) 盘中最后一根是未完成K线，成交量按 opts.progress（0~1）折算全天预估量，
 *      否则量比会被系统性低估，把放量误判成缩量。
 *   3) 每根K线的判定只使用该根及之前的数据，不存在未来函数。
 * ========================================================================== */
var Wyckoff = (function () {
  'use strict';

  var CFG = {
    RANGE_N: 60,        // 交易区间回看根数
    PIVOT_N: 20,        // 前高前低回看根数
    VOL_N: 20,          // 均量窗口
    EVENT_WINDOW: 5,    // 事件检测窗口（根）
    DECAY: 0.15,        // 每远一日的权重衰减
    BREAK_MIN: 0.002,   // 假突破/假跌破幅度门槛（0.2%），过滤噪声
    RECOVER_MIN: 0.6,   // 收回/回落幅度需达到影线幅度的比例
    VOL_EXPAND: 1.2,    // 放量门槛
    VOL_DRY: 0.75,      // 缩量门槛
    VOL_CLIMAX: 2.5,    // 高潮量门槛
    VOL_EFFORT: 1.8,    // 努力无结果门槛
    NO_DEMAND_CHG: 1.0, // 无需求：涨幅下限 %
    NO_SUPPLY_CHG: -1.0,// 无供给：跌幅上限 %
    FLAT_CHG: 0.5,      // 放量滞涨：涨跌幅绝对值上限 %
    HI_POS: 0.85,       // 高位区间阈值
    LO_POS: 0.25,       // 低位区间阈值
  };

  function mean(a) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return a.length ? s / a.length : 0;
  }
  function maxOf(a) { return a.length ? Math.max.apply(null, a) : 0; }
  function minOf(a) { return a.length ? Math.min.apply(null, a) : 0; }

  function rangePos(price, lo, hi) {
    return hi > lo ? (price - lo) / (hi - lo) : 0.5;
  }

  /* 单根K线的全部事件判定。只用 i 及之前的数据。 */
  function detectAt(bars, vols, i) {
    var out = [];
    if (i < CFG.RANGE_N + 2) return out;

    var b = bars[i], prevC = bars[i - 1].c;
    var price = b.c;
    var chgPct = prevC ? (price - prevC) / prevC * 100 : 0;
    var amp = prevC ? (b.h - b.l) / prevC * 100 : 0;

    var volMA = mean(vols.slice(i - CFG.VOL_N, i));
    var volRatio = volMA > 0 ? vols[i] / volMA : 1;

    var win = bars.slice(i - CFG.RANGE_N, i);
    var rangeHi = maxOf(win.map(function (x) { return x.h; }));
    var rangeLo = minOf(win.map(function (x) { return x.l; }));
    var pos = rangePos(price, rangeLo, rangeHi);

    var pw = bars.slice(i - CFG.PIVOT_N, i);
    var priorHi = maxOf(pw.map(function (x) { return x.h; }));
    var priorLo = minOf(pw.map(function (x) { return x.l; }));

    function push(key, name, dir, strength, detail) {
      out.push({ key: key, name: name, dir: dir, strength: strength, detail: detail });
    }

    /* Spring：跌破前低后收回 + 放量 —— 最强的多头量价信号 */
    var breakDepth = priorLo > 0 ? (priorLo - b.l) / priorLo : 0;
    var recover = b.h > b.l ? (b.c - b.l) / (b.h - b.l) : 0;
    if (breakDepth > CFG.BREAK_MIN && b.c > priorLo && recover >= CFG.RECOVER_MIN && volRatio >= CFG.VOL_EXPAND) {
      push('spring', 'Spring 弹簧（假跌破收回）', 1, 3,
        '最低 ' + b.l.toFixed(2) + ' 跌破20日前低 ' + priorLo.toFixed(2) +
        '（深 ' + (breakDepth * 100).toFixed(1) + '%），收盘 ' + b.c.toFixed(2) +
        ' 收回前低上方，收回幅度占当日振幅 ' + (recover * 100).toFixed(0) +
        '%，量比 ' + volRatio.toFixed(2) + '。空头陷阱，浮动筹码被吸收。');
    }

    /* Upthrust：突破前高后回落 + 放量 */
    var upDepth = priorHi > 0 ? (b.h - priorHi) / priorHi : 0;
    var fade = b.h > b.l ? (b.h - b.c) / (b.h - b.l) : 0;
    if (upDepth > CFG.BREAK_MIN && b.c < priorHi && fade >= CFG.RECOVER_MIN && volRatio >= CFG.VOL_EXPAND) {
      push('upthrust', 'Upthrust 上冲回落（假突破）', -1, 3,
        '最高 ' + b.h.toFixed(2) + ' 突破20日前高 ' + priorHi.toFixed(2) +
        '（超 ' + (upDepth * 100).toFixed(1) + '%），收盘 ' + b.c.toFixed(2) +
        ' 回落前高下方，回落幅度占振幅 ' + (fade * 100).toFixed(0) +
        '%，量比 ' + volRatio.toFixed(2) + '。多头陷阱，上方抛压沉重。');
    }

    /* No Demand：上涨但缩量，且位于区间高位 */
    if (chgPct > CFG.NO_DEMAND_CHG && volRatio < CFG.VOL_DRY && pos > CFG.HI_POS) {
      push('nodemand', 'No Demand 无需求上涨', -1, 2,
        '收涨 ' + chgPct.toFixed(2) + '% 但量比仅 ' + volRatio.toFixed(2) +
        '，价格处于 ' + CFG.RANGE_N + ' 日区间 ' + (pos * 100).toFixed(0) +
        '% 分位。上涨缺买盘承接，无量虚涨。');
    }

    /* No Supply：下跌但极度缩量，且位于区间低位 */
    if (chgPct < CFG.NO_SUPPLY_CHG && volRatio < CFG.VOL_DRY && pos < CFG.LO_POS) {
      push('nosupply', 'No Supply 无供给下跌', 1, 2,
        '收跌 ' + chgPct.toFixed(2) + '% 但量比仅 ' + volRatio.toFixed(2) +
        '，价格处于区间 ' + (pos * 100).toFixed(0) + '% 分位。下跌无人抛售，卖压枯竭。');
    }

    /* Climax Volume：巨量高潮，按位置分卖出/买入高潮 */
    if (volRatio >= CFG.VOL_CLIMAX && amp >= 4) {
      if (pos < 0.4) {
        push('sellingclimax', 'Selling Climax 放量恐慌（低位）', 1, 3,
          '量比 ' + volRatio.toFixed(2) + '、振幅 ' + amp.toFixed(1) + '%，处于区间 ' +
          (pos * 100).toFixed(0) + '% 分位低位。恐慌盘集中出清，常见于阶段底部。');
      } else {
        push('buyingclimax', 'Buying Climax 放量亢奋（高位）', -1, 3,
          '量比 ' + volRatio.toFixed(2) + '、振幅 ' + amp.toFixed(1) + '%，处于区间 ' +
          (pos * 100).toFixed(0) + '% 分位高位。追买情绪到极值，警惕派发。');
      }
    }

    /* SOS / SOW：放量突破或跌破区间边界 */
    if (b.c > rangeHi && volRatio >= 1.5) {
      push('sos', 'SOS 强势突破', 1, 3,
        '收盘 ' + b.c.toFixed(2) + ' 突破 ' + CFG.RANGE_N + ' 日区间上沿 ' +
        rangeHi.toFixed(2) + '，量比 ' + volRatio.toFixed(2) + '。需求主动吞掉上方供给。');
    }
    if (b.c < rangeLo && volRatio >= 1.5) {
      push('sow', 'SOW 弱势破位', -1, 3,
        '收盘 ' + b.c.toFixed(2) + ' 跌破 ' + CFG.RANGE_N + ' 日区间下沿 ' +
        rangeLo.toFixed(2) + '，量比 ' + volRatio.toFixed(2) + '。供给压倒需求，注意止损。');
    }

    /* Effort≠Result：大幅放量但价格几乎不动 */
    if (volRatio >= CFG.VOL_EFFORT && Math.abs(chgPct) < CFG.FLAT_CHG) {
      push('effort', 'Effort≠Result 放量滞涨', -1, 2,
        '量比 ' + volRatio.toFixed(2) + ' 但涨跌幅仅 ' + chgPct.toFixed(2) +
        '%。大量换手没推动价格，上方有等量抛压吸走买盘。');
    }

    /* 量价背离：创 20 日新高但量能低于前次新高 20% 以上 */
    var prevHighIdx = -1;
    for (var k = i - 2; k >= Math.max(0, i - CFG.PIVOT_N); k--) {
      var isH = true;
      for (var m = Math.max(0, k - 2); m <= Math.min(i - 1, k + 2); m++) {
        if (m !== k && bars[m].h >= bars[k].h) { isH = false; break; }
      }
      if (isH) { prevHighIdx = k; break; }
    }
    if (prevHighIdx > 0 && b.h >= bars[prevHighIdx].h && vols[i] < vols[prevHighIdx] * 0.8 && pos > 0.6) {
      push('divergence', '量价背离（新高缩量）', -1, 2,
        '价格创 ' + CFG.PIVOT_N + ' 日新高，但成交量 ' + vols[i].toFixed(0) +
        ' 仅为前高日 ' + vols[prevHighIdx].toFixed(0) + ' 的 ' +
        (vols[i] / vols[prevHighIdx] * 100).toFixed(0) + '%。价升量缩，上攻乏力。');
    }

    return out;
  }

  function analyze(bars, opts) {
    opts = opts || {};
    if (!bars || bars.length < CFG.RANGE_N + 5) return null;

    var n = bars.length;
    var partial = !!opts.partial;
    var progress = Math.max(0.15, Math.min(1, opts.progress == null ? 1 : opts.progress));

    /* 盘中把未完成K线的量折算为全天预估量 */
    var vols = bars.map(function (b, i) {
      return (i === n - 1 && partial) ? b.v / progress : b.v;
    });
    var closes = bars.map(function (b) { return b.c; });
    var last = bars[n - 1], prev = bars[n - 2];
    var price = last.c, prevClose = prev.c;
    var chgPct = prevClose ? (price - prevClose) / prevClose * 100 : 0;

    var volMA = mean(vols.slice(n - 1 - CFG.VOL_N, n - 1));
    var volRatio = volMA > 0 ? vols[n - 1] / volMA : 1;

    var win = bars.slice(n - 1 - CFG.RANGE_N, n - 1);
    var rangeHi = maxOf(win.map(function (b) { return b.h; }));
    var rangeLo = minOf(win.map(function (b) { return b.l; }));
    var pos = rangePos(price, rangeLo, rangeHi);

    var pw = bars.slice(n - 1 - CFG.PIVOT_N, n - 1);
    var priorHi = maxOf(pw.map(function (b) { return b.h; }));
    var priorLo = minOf(pw.map(function (b) { return b.l; }));

    /* 窗口内逐根检测，按距今天数衰减 */
    var events = [];
    var start = Math.max(CFG.RANGE_N + 2, n - CFG.EVENT_WINDOW);
    for (var i = start; i < n; i++) {
      var daysAgo = n - 1 - i;
      var list = detectAt(bars, vols, i);
      for (var q = 0; q < list.length; q++) {
        var e = list[q];
        e.daysAgo = daysAgo;
        e.d = bars[i].d;
        e.weight = e.strength * Math.max(0.3, 1 - daysAgo * CFG.DECAY);
        events.push(e);
      }
    }

    var bull = events.filter(function (e) { return e.dir > 0; });
    var bear = events.filter(function (e) { return e.dir < 0; });

    /* 得分：满分 ±100，同一事件重复出现只按最强的一次计，避免刷分 */
    var best = {};
    events.forEach(function (e) {
      var key = e.key;
      if (!best[key] || Math.abs(e.weight) > Math.abs(best[key].weight)) best[key] = e;
    });
    var score = 0;
    Object.keys(best).forEach(function (k) { score += best[k].dir * best[k].weight * 9; });
    score = Math.max(-100, Math.min(100, Math.round(score)));

    var ma60 = mean(closes.slice(Math.max(0, n - 60)));
    var phase, phaseText;
    if (pos > 0.7 && price > ma60) { phase = 'markup'; phaseText = '上升段（需求主导）'; }
    else if (pos < 0.3 && price < ma60) { phase = 'markdown'; phaseText = '下降段（供给主导）'; }
    else if (pos > 0.6 && bear.length > bull.length) { phase = 'distribution'; phaseText = '派发嫌疑（高位滞涨）'; }
    else if (pos < 0.45 && bull.length > bear.length) { phase = 'accumulation'; phaseText = '吸筹迹象（低位承接）'; }
    else { phase = 'neutral'; phaseText = '区间震荡（方向未定）'; }

    return {
      price: price, chgPct: chgPct,
      volRatio: volRatio, volMA: volMA,
      amp: prevClose ? (last.h - last.l) / prevClose * 100 : 0,
      rangeHi: rangeHi, rangeLo: rangeLo, pos: pos,
      priorHi: priorHi, priorLo: priorLo,
      events: events.slice().sort(function (a, b) { return a.daysAgo - b.daysAgo; }),
      bullCount: bull.length, bearCount: bear.length,
      score: score, phase: phase, phaseText: phaseText,
      partial: partial,
    };
  }

  var api = { CFG: CFG, analyze: analyze, detectAt: detectAt, rangePos: rangePos };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
