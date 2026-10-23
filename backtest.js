/* ==========================================================================
 * backtest.js —— 信号重放回测
 *
 * 口径（页面会原样展示，避免误读）：
 *   · 成交价：信号确认后的**次日开盘价**。信号日收盘价成交属于未来函数，一律不用。
 *   · 费用：往返佣金 0.05% + 印花税 0.05% + 滑点 0.1%，合计 0.2%。
 *   · 止损：信号笔低点下方 1.5%；止盈：2R（两倍风险距离）；时间止损 20 个交易日。
 *   · 一字板买不进、跌停卖不出，均按"未成交"跳过。
 *   · 信号判定与实盘同源：向下笔结束 + 二买(不破前低)/三买(回调不进中枢)，
 *     周线/月线笔方向作为可选过滤，两套结果分别统计以体现过滤价值。
 *   · 参数未做样本外调优，结论标注为「样本内」，不作为收益承诺。
 * ========================================================================== */
var Backtest = (function () {
  'use strict';

  var CFG = {
    FEE: 0.002,        // 往返总成本（佣金+印花+滑点）
    STOP_PCT: 0.015,   // 止损距信号笔低点
    R_MULT: 2,         // 止盈 = 2R
    MAX_HOLD: 20,      // 最长持有交易日
    MIN_BARS: 260,     // 少于该根数不参与回测
    MIN_GAP: 10,       // 信号最小间隔（交易日），避免同一段结构反复开仓
    MIN_PULLBACK: 0.025, // 回调笔最小幅度：小于 2.5% 的回调无交易价值
    MIN_RALLY: 0.04,   // 前段上涨笔最小幅度：没有力度的上涨后面不接
    MAX_ENTRY_GAP: 0.04, // 入场价距买点结构低点的最大距离，超过视为追高
  };

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  /* ---------------- 日线聚合出周线 / 月线（用于趋势过滤，避免额外请求） ---------------- */
  function weekKey(d) {
    var t = new Date(String(d).replace(/-/g, '/'));
    if (isNaN(t.getTime())) return String(d).slice(0, 7);
    var onejan = new Date(t.getFullYear(), 0, 1);
    var w = Math.ceil((((t - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    return t.getFullYear() + '-' + w;
  }

  function aggregate(bars, type) {
    var out = [], cur = null;
    function finish(c) { return { d: c.d, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }; }
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      var key = type === 'week' ? weekKey(b.d) : String(b.d).slice(0, 7);
      if (!cur || cur.k !== key) {
        if (cur) out.push(finish(cur));
        cur = { k: key, d: b.d, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      } else {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c; cur.v += b.v; cur.d = b.d;
      }
    }
    if (cur) out.push(finish(cur));
    return out;
  }

  /* 某日期之前最后一个已完成笔的方向（保留供参考） */
  function dirAt(pens, date) {
    for (var i = pens.length - 1; i >= 0; i--) {
      if (String(pens[i].d1) <= String(date)) return pens[i].dir;
    }
    return 0;
  }

  /* 截至某日的级别结构：与实盘用同一套 Chan.structure，保证回测口径不打折。
   * 只取 date 之前已收盘的周期，当周/当月数据不完整则不参与。
   * 结果按「该周期根数」缓存，同一周内的多个信号复用同一次计算。
   * 数据不足时返回 null —— 调用方必须把"数据不足"当作不拦截，而不是判不通过，
   * 否则样本前段会被整体误杀。 */
  function structAt(aggBars, date, cache, minN) {
    var k = -1;
    for (var i = 0; i < aggBars.length; i++) {
      if (String(aggBars[i].d) < String(date)) k = i;
      else break;
    }
    if (k < (minN == null ? 20 : minN)) return null;
    if (cache[k]) return cache[k];
    var st = Chan.structure(aggBars.slice(0, k + 1));
    cache[k] = st;
    return st;
  }

  /* 级别趋势是否配合：上级别不能处于「中枢下方且笔向下」的逆势状态。
   * structure 的 dir 已把"中枢上方回调"计为向上，这里只做兜底判断。 */
  function levelOK(st) {
    if (!st) return false;
    if (st.dir > 0) return true;
    return st.position === 'inside' && st.dir === 0;
  }

  /* ---------------- 信号提取 ----------------
   * 只跑一次完整结构计算，然后沿着笔序列回溯每个向下笔的结束点判定买点，
   * 避免"每根K线重算一遍结构"的 O(n²) 开销（400 根日线会从 40ms 升到 800ms）。
   *
   * 两道幅度门槛是必需的：不加的话任何"低点抬高"的回调都会算成二买，
   * 实测 30 只票 3 年能刷出近 5000 笔信号（每只每年 50 次），完全不具可操作性。
   * 这里要求回调本身有幅度（>=2.5%）、且前一段上涨有力度（>=4%），
   * 只保留有交易价值的结构。 */
  function extractSignals(bars) {
    var st = Chan.structure(bars);
    if (!st || !st.pens.length) return [];
    var pens = st.pens, sigs = [];

    for (var i = 2; i < pens.length; i++) {
      var last = pens[i];
      if (last.dir > 0) continue;                    // 只判定向下笔（回调）结束
      if (last.amp < CFG.MIN_PULLBACK) continue;     // 回调幅度不足，不是有效买点

      var prevUp = null;
      for (var q = i - 1; q >= 0; q--) {
        if (pens[q].dir === 1) { prevUp = pens[q]; break; }
      }
      if (!prevUp || prevUp.amp < CFG.MIN_RALLY) continue;   // 前段上涨没力度，不做

      var sub = pens.slice(0, i + 1);
      var pvs = Chan.buildPivots(sub);
      var piv = pvs.length ? pvs[pvs.length - 1] : null;

      var prevDown = null;
      for (var k = i - 1; k >= 0; k--) {
        if (pens[k].dir === -1) { prevDown = pens[k]; break; }
      }

      var type = null;
      if (piv && last.low > piv.zg && piv.endPen < i) type = 'third';
      else if (prevDown && last.low > prevDown.low) type = 'second';
      if (!type) continue;

      /* 分型确认滞后一根：信号在 to 分型的下一根K线才可执行 */
      var sigIdx = last.to.i1 + 1;
      if (sigIdx >= bars.length - 1) continue;
      sigs.push({
        idx: sigIdx, date: bars[sigIdx].d, type: type,
        penLow: last.low, penHigh: last.high,
        penDir: last.dir,
      });
    }
    return sigs;
  }

  /* ---------------- 单笔交易模拟 ---------------- */
  function simulate(bars, sig, opts) {
    var entryIdx = sig.idx + 1;                      // 次日
    if (entryIdx >= bars.length) return null;

    var eb = bars[entryIdx];
    var entry = eb.o;
    if (!(entry > 0)) return null;

    /* 入场价必须贴着买点结构。信号确认要滞后一根K线，强势股次日常高开 5% 以上，
     * 此时入场价已远离结构低点，等于在追高：风险基数被放大，回测出来的
     * "2R 止盈"也就变成了不切实际的大目标。这类信号直接跳过。 */
    if (sig.penLow > 0 && (entry - sig.penLow) / sig.penLow > CFG.MAX_ENTRY_GAP) {
      return { skipped: '次日开盘已高于买点 ' + (CFG.MAX_ENTRY_GAP * 100).toFixed(0) + '%，属追高' };
    }

    /* 一字涨停买不进：开盘=最高=最低 且较前收涨停 */
    var prevC = bars[entryIdx - 1].c;
    var limitUp = prevC * (opts.gem ? 1.195 : 1.095);
    var oneWord = (eb.h === eb.l) && (eb.c >= limitUp * 0.995);
    if (oneWord) return { skipped: '一字板买不进', date: eb.d };

    var stop = sig.penLow * (1 - CFG.STOP_PCT);
    if (!(stop < entry)) stop = entry * 0.97;
    var risk = entry - stop;
    var target = entry + risk * CFG.R_MULT;

    var exitIdx = -1, exitPx = null, reason = '';
    for (var j = entryIdx; j < Math.min(bars.length, entryIdx + CFG.MAX_HOLD + 1); j++) {
      var b = bars[j];
      /* 当日先判止损再判止盈：同一根K线内无法确定先后，按最坏情况处理 */
      if (b.l <= stop) { exitIdx = j; exitPx = Math.min(stop, b.o); reason = '止损'; break; }
      if (b.h >= target) { exitIdx = j; exitPx = Math.max(target, b.o); reason = '止盈'; break; }
      if (j === Math.min(bars.length, entryIdx + CFG.MAX_HOLD + 1) - 1) {
        exitIdx = j; exitPx = b.c; reason = '时间止损';
      }
    }
    if (exitIdx < 0) return null;

    var gross = (exitPx - entry) / entry;
    var net = gross - CFG.FEE;
    return {
      date: eb.d, entryDate: eb.d, exitDate: bars[exitIdx].d,
      entry: entry, exit: exitPx, stop: stop, target: target,
      grossPct: gross * 100, netPct: net * 100,
      holdDays: exitIdx - entryIdx, reason: reason, type: sig.type,
      rMultiple: risk > 0 ? (exitPx - entry) / risk : 0,
    };
  }

  /* ---------------- 统计 ---------------- */
  function statsOf(trades) {
    if (!trades.length) return { n: 0 };
    var wins = trades.filter(function (t) { return t.netPct > 0; });
    var losses = trades.filter(function (t) { return t.netPct <= 0; });
    var sum = trades.reduce(function (a, t) { return a + t.netPct; }, 0);
    var avgWin = wins.length ? wins.reduce(function (a, t) { return a + t.netPct; }, 0) / wins.length : 0;
    var avgLoss = losses.length ? losses.reduce(function (a, t) { return a + t.netPct; }, 0) / losses.length : 0;

    /* 最大回撤：按交易发生顺序累乘净值 */
    var eq = 1, peak = 1, mdd = 0;
    var sorted = trades.slice().sort(function (a, b) { return String(a.exitDate) < String(b.exitDate) ? -1 : 1; });
    sorted.forEach(function (t) {
      eq *= (1 + t.netPct / 100);
      if (eq > peak) peak = eq;
      var dd = (peak - eq) / peak;
      if (dd > mdd) mdd = dd;
    });

    var byYear = {};
    trades.forEach(function (t) {
      var y = String(t.exitDate).slice(0, 4);
      if (!byYear[y]) byYear[y] = [];
      byYear[y].push(t.netPct);
    });
    var yearStats = Object.keys(byYear).sort().map(function (y) {
      var arr = byYear[y];
      var w = arr.filter(function (v) { return v > 0; }).length;
      return {
        year: y, n: arr.length,
        winRate: arr.length ? w / arr.length : 0,
        avg: arr.reduce(function (a, v) { return a + v; }, 0) / arr.length,
      };
    });

    var byType = {};
    trades.forEach(function (t) {
      if (!byType[t.type]) byType[t.type] = [];
      byType[t.type].push(t.netPct);
    });
    var typeStats = Object.keys(byType).map(function (k) {
      var arr = byType[k];
      var w = arr.filter(function (v) { return v > 0; }).length;
      return { type: k === 'third' ? '三买' : '二买', n: arr.length, winRate: arr.length ? w / arr.length : 0,
        avg: arr.reduce(function (a, v) { return a + v; }, 0) / arr.length };
    });

    return {
      n: trades.length,
      winRate: wins.length / trades.length,
      avgWin: avgWin, avgLoss: avgLoss,
      payoff: avgLoss < 0 ? Math.abs(avgWin / avgLoss) : null,
      expectancy: sum / trades.length,
      seqReturn: (eq - 1) * 100,     // 按平仓顺序连乘，非组合净值（多只并行持仓时不可直接当账户收益）
      maxDD: mdd * 100,
      avgHold: trades.reduce(function (a, t) { return a + t.holdDays; }, 0) / trades.length,
      yearStats: yearStats, typeStats: typeStats,
      stopCount: trades.filter(function (t) { return t.reason === '止损'; }).length,
      targetCount: trades.filter(function (t) { return t.reason === '止盈'; }).length,
      timeCount: trades.filter(function (t) { return t.reason === '时间止损'; }).length,
    };
  }

  /* ---------------- 单只股票回测 ---------------- */
  function runOne(item) {
    var bars = item._bars;
    if (!bars || bars.length < CFG.MIN_BARS) return null;

    var wAgg = aggregate(bars, 'week');
    var mAgg = aggregate(bars, 'month');
    var wCache = {}, mCache = {};
    var sigs = extractSignals(bars);
    if (!sigs.length) return null;

    /* 同段结构只取第一个信号，避免连续多日重复开仓 */
    var filtered = [];
    var lastIdx = -999;
    sigs.forEach(function (s) {
      if (s.idx - lastIdx < CFG.MIN_GAP) return;
      lastIdx = s.idx;
      filtered.push(s);
    });

    var gem = /^(sz30|sh688|bj)/.test(item.code) || false;
    var all = [], trend = [];

    filtered.forEach(function (s) {
      var t = simulate(bars, s, { gem: gem });
      if (!t || t.skipped) return;
      all.push(t);

      /* 叠加级别过滤：月线、周线均不逆势。某一级别数据不足时不拦截该条件，
       * 否则回测区间前段会被整体误杀（实测会让过滤组变成 0 笔）。 */
      var ws = structAt(wAgg, s.date, wCache, 24);
      var ms = structAt(mAgg, s.date, mCache, 30);
      var wOK = ws ? levelOK(ws) : true;
      var mOK = ms ? levelOK(ms) : true;
      if (wOK && mOK) trend.push(t);
    });

    return {
      code: item.code, name: item.name,
      bars: bars.length,
      signalCount: filtered.length,
      all: statsOf(all),
      trend: statsOf(trend),
      allTrades: all,
      trendTrades: trend,
      trades: all.slice(-12),
    };
  }

  /* ---------------- 组合汇总 ---------------- */
  function run(items) {
    var t0 = Date.now();
    var rows = (items || []).map(runOne).filter(Boolean);
    if (!rows.length) return { rows: [], summary: { n: 0 }, elapsed: Date.now() - t0 };

    var allTrades = [], trendTrades = [];
    rows.forEach(function (r) {
      allTrades = allTrades.concat(r.allTrades);
      trendTrades = trendTrades.concat(r.trendTrades);
    });

    return {
      rows: rows,
      summary: { all: statsOf(allTrades), trend: statsOf(trendTrades) },
      totalTrades: allTrades.length,
      elapsed: Date.now() - t0,
      range: items.length && items[0]._bars ? {
        from: items[0]._bars[0].d, to: items[0]._bars[items[0]._bars.length - 1].d,
      } : null,
    };
  }

  var api = { CFG: CFG, run: run, runOne: runOne, extractSignals: extractSignals,
    simulate: simulate, statsOf: statsOf, aggregate: aggregate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
