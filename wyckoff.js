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
    RANGE_MAX_W: 0.25,  // 区间成立上限：（高-低)/低 超过该值视为单边趋势
    A_BARS: 25,         // A 段判定的区间存续根数上限
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

  /* ---------------- 阶段状态机（Phase A ~ E） ----------------
   * 老版本只给一句「吸筹迹象 / 派发嫌疑」，那是形容词，不是结构。这里按威科夫
   * 原始的「交易区间生命周期」给出可复算的分段：
   *
   *   区间成立的前提：近 RANGE_N 根的振幅（(高-低)/低）不超过 RANGE_MAX_W。
   *   超过就不是区间，是单边趋势 —— 此时硬套 A~E 会把上涨趋势说成「吸筹」，
   *   所以直接判 trend-up / trend-down，并明说「不存在有效区间」。
   *
   *   A 段 区间形成：区间存续不足 A_BARS 根，且期间出现过高潮量或首个假突破。
   *   B 段 区间反复：存续 ≥ A_BARS 根，无有效 Spring/Upthrust，价格在中段反复。
   *   C 段 测试：近 EVENT_WINDOW 根内有 Spring（或 Upthrust），且其后 3 根内
   *            出现「缩量测试」——量比 < VOL_DRY、不破 Spring 低点、收回其上。
   *   D 段 区间内推进：近窗口内有 SOS/SOW，且价格已推到区间一侧（pos > .72 / < .28）。
   *   E 段 离开区间：最近 2 根收盘均在区间外 2% 以上。
   *
   * 分段只描述「现在处在什么位置」，不直接给买卖结论；买卖结论仍由买点与
   * 交易计划给。两者一致时页面会说「结构共振」，冲突时会如实标注。
   */
  function cycleOf(bars, vols, ctx) {
    var n = bars.length;
    var R = CFG.RANGE_N, W = CFG.RANGE_MAX_W, A_BARS = CFG.A_BARS;
    var rangeHi = ctx.rangeHi, rangeLo = ctx.rangeLo, price = ctx.price;
    var pos = ctx.pos, width = rangeLo > 0 ? (rangeHi - rangeLo) / rangeLo : 0;
    var ma20 = mean(bars.slice(Math.max(0, n - 20)).map(function (b) { return b.c; }));
    var ma60 = mean(bars.slice(Math.max(0, n - 60)).map(function (b) { return b.c; }));
    var ref20 = bars[Math.max(0, n - 21)].c;
    var mom20 = ref20 ? (price - ref20) / ref20 : 0;

    var ev = ctx.events || [];
    function near(key, win) {
      for (var i = 0; i < ev.length; i++) {
        if (ev[i].key === key && ev[i].daysAgo <= (win == null ? CFG.EVENT_WINDOW : win)) return ev[i];
      }
      return null;
    }

    var evd = [];

    /* 无有效区间：单边趋势 */
    if (width > W) {
      var up = (price > ma60 && mom20 > 0) || (price > ma20 && price > ma60);
      evd.push('近 ' + R + ' 日振幅 ' + (width * 100).toFixed(1) + '%，超过 ' + (W * 100).toFixed(0) +
        '% 的区间上限，说明当前是单边行情而非交易区间');
      evd.push('收盘 ' + price.toFixed(2) + ' / MA20 ' + ma20.toFixed(2) + ' / MA60 ' + ma60.toFixed(2) +
        '；20 日动量 ' + (mom20 * 100).toFixed(1) + '%');
      return {
        code: up ? 'trend-up' : 'trend-down', hasRange: false, width: width, pos: pos,
        rangeBars: R, name: up ? '单边上行' : '单边下行',
        text: up ? '单边上行：不存在有效交易区间，回踩均线即为加仓点'
          : '单边下行：不存在有效交易区间，反弹均线附近即减仓点',
        evidence: evd,
      };
    }

    /* 区间存续根数：从末端向前数，收盘仍在区间内的连续根数 */
    var keep = 0;
    for (var i = n - 1; i >= Math.max(0, n - R); i--) {
      var c = bars[i].c;
      if (c >= rangeLo * 0.98 && c <= rangeHi * 1.02) keep++;
      else break;
    }
    var rangeBars = keep;

    /* E 段：连续 2 根收盘在区间外 */
    var outside = 0;
    for (var j = n - 1; j >= Math.max(0, n - 2); j--) {
      if (bars[j].c > rangeHi * 1.02 || bars[j].c < rangeLo * 0.98) outside++;
    }
    var sod = near('sos', 8) || near('sow', 8);
    if (outside >= 2) {
      var upSide = price > rangeHi;
      evd.push('最近 2 根收盘均在区间' + (upSide ? '上沿 ' + rangeHi.toFixed(2) + ' 上方' : '下沿 ' + rangeLo.toFixed(2) + ' 下方') + '（超出 2%）');
      if (sod) evd.push('区间边缘出现 ' + sod.name + '（' + sod.daysAgo + ' 日前，量比 ' +
        (ctx.volRatio || 0).toFixed(2) + '）');
      return {
        code: 'E', hasRange: true, width: width, pos: pos, rangeBars: rangeBars,
        rangeHi: rangeHi, rangeLo: rangeLo,
        name: upSide ? 'E 段 上行离开区间' : 'E 段 下行离开区间',
        text: upSide
          ? '已向上离开区间，进入趋势延续段；回到区间上沿 ' + rangeHi.toFixed(2) + ' 附近不破即为回踩买点'
          : '已向下离开区间，进入下跌延续段；反抽区间下沿 ' + rangeLo.toFixed(2) + ' 不过即为减仓点',
        evidence: evd,
      };
    }

    /* C 段：Spring / Upthrust + 缩量测试 */
    var sp = near('spring', CFG.EVENT_WINDOW);
    var ut = near('upthrust', CFG.EVENT_WINDOW);
    function tested(key, kind) {
      var e = near(key, CFG.EVENT_WINDOW);
      if (!e) return null;
      var idx = n - 1 - e.daysAgo;
      var lowBase = bars[idx].l, hiBase = bars[idx].h;
      for (var k = idx + 1; k <= Math.min(n - 1, idx + 3); k++) {
        var vma = mean(vols.slice(Math.max(0, k - CFG.VOL_N), k));
        var vr = vma > 0 ? vols[k] / vma : 1;
        var hold = kind === 'bottom'
          ? (bars[k].l >= lowBase * 0.995 && bars[k].c > lowBase)
          : (bars[k].h <= hiBase * 1.005 && bars[k].c < hiBase);
        if (vr < CFG.VOL_DRY && hold) {
          return { e: e, testIdx: k, vr: vr, daysAgo: n - 1 - k };
        }
      }
      return { e: e, testIdx: -1, vr: null, daysAgo: null };
    }
    var tSp = sp ? tested('spring', 'bottom') : null;
    var tUt = ut ? tested('upthrust', 'top') : null;
    if (tSp && tSp.testIdx >= 0) {
      evd.push(sp.daysAgo + ' 日前出现 ' + sp.name + '，' + tSp.daysAgo + ' 日前缩量测试（量比 ' +
        tSp.vr.toFixed(2) + '，未破 ' + bars[n - 1 - sp.daysAgo].l.toFixed(2) + '）');
      evd.push('区间 ' + rangeLo.toFixed(2) + ' ~ ' + rangeHi.toFixed(2) + '，现价处于 ' + (pos * 100).toFixed(0) + '% 分位');
      return {
        code: 'C', hasRange: true, width: width, pos: pos, rangeBars: rangeBars,
        rangeHi: rangeHi, rangeLo: rangeLo,
        name: 'C 段 测试完成（吸筹）',
        text: 'Spring 假跌破后缩量测试成立，浮动筹码已被吸收；只要不破 ' +
          bars[n - 1 - sp.daysAgo].l.toFixed(2) + '，这段结构的失效条件就很明确',
        evidence: evd,
      };
    }
    if (tUt && tUt.testIdx >= 0) {
      evd.push(ut.daysAgo + ' 日前出现 ' + ut.name + '，' + tUt.daysAgo + ' 日前缩量反抽（量比 ' +
        tUt.vr.toFixed(2) + '，未过 ' + bars[n - 1 - ut.daysAgo].h.toFixed(2) + '）');
      return {
        code: 'C', hasRange: true, width: width, pos: pos, rangeBars: rangeBars,
        rangeHi: rangeHi, rangeLo: rangeLo,
        name: 'C 段 测试完成（派发）',
        text: 'Upthrust 假突破后缩量反抽成立，上方供给仍在；突破 ' +
          bars[n - 1 - ut.daysAgo].h.toFixed(2) + ' 才能推翻这个判断',
        evidence: evd,
      };
    }
    if (sp || ut) {
      var e0 = sp || ut;
      evd.push(e0.daysAgo + ' 日前出现 ' + e0.name + '，但随后 3 根内没有出现缩量测试（量比未降至 ' +
        CFG.VOL_DRY + ' 以下），测试尚未完成');
      return {
        code: 'B', hasRange: true, width: width, pos: pos, rangeBars: rangeBars,
        rangeHi: rangeHi, rangeLo: rangeLo,
        name: 'B~C 段 假突破已出、测试未完成',
        text: '假突破发生了，但还缺一次缩量测试来确认；此时介入属于抢跑，等测试完成再动',
        evidence: evd,
      };
    }

    /* D 段：SOS/SOW + 已到区间一侧 */
    if (sod && (pos > 0.72 || pos < 0.28)) {
      evd.push(sod.daysAgo + ' 日前出现 ' + sod.name + '，现价处于区间 ' + (pos * 100).toFixed(0) + '% 分位');
      evd.push('区间 ' + rangeLo.toFixed(2) + ' ~ ' + rangeHi.toFixed(2) + '，存续约 ' + rangeBars + ' 根');
      return {
        code: 'D', hasRange: true, width: width, pos: pos, rangeBars: rangeBars,
        rangeHi: rangeHi, rangeLo: rangeLo,
        name: sod.dir > 0 ? 'D 段 区间内走强' : 'D 段 区间内走弱',
        text: sod.dir > 0
          ? '需求已把价格推到区间上沿，突破 ' + rangeHi.toFixed(2) + ' 即进入 E 段'
          : '供给已把价格压到区间下沿，失守 ' + rangeLo.toFixed(2) + ' 即进入 E 段（下行）',
        evidence: evd,
      };
    }

    /* 高潮量 → A 段 */
    var cl = near('sellingclimax', CFG.EVENT_WINDOW) || near('buyingclimax', CFG.EVENT_WINDOW);
    if (cl || rangeBars < A_BARS) {
      if (cl) evd.push(cl.daysAgo + ' 日前出现 ' + cl.name + '，量比 ' + (ctx.volRatio || 0).toFixed(2));
      evd.push('当前区间仅存续约 ' + rangeBars + ' 根（< ' + A_BARS + ' 根），属区间刚形成的初期');
      return {
        code: 'A', hasRange: true, width: width, pos: pos, rangeBars: rangeBars,
        rangeHi: rangeHi, rangeLo: rangeLo,
        name: 'A 段 区间形成初期',
        text: '区间刚成立，方向未定。A 段的任务是画边界，不是做交易 —— 等 B 段回踩与 C 段测试',
        evidence: evd,
      };
    }

    /* 其余 → B 段 */
    evd.push('区间已存续约 ' + rangeBars + ' 根，价格在区间 ' + (pos * 100).toFixed(0) +
      '% 分位反复，无有效 Spring/Upthrust');
    evd.push('区间 ' + rangeLo.toFixed(2) + ' ~ ' + rangeHi.toFixed(2) + '，宽度 ' + (width * 100).toFixed(1) + '%');
    return {
      code: 'B', hasRange: true, width: width, pos: pos, rangeBars: rangeBars,
      rangeHi: rangeHi, rangeLo: rangeLo,
      name: 'B 段 区间反复（建仓/派发进行中）',
      text: '区间内反复是最耗时的阶段，也是最容易被震出去的地方；只在区间下沿附近参与，中段不做',
      evidence: evd,
    };
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

    /* 阶段状态机：把「吸筹/派发」这类形容词换成可复算的 A~E 分段 */
    var cycle = cycleOf(bars, vols, {
      rangeHi: rangeHi, rangeLo: rangeLo, price: price, pos: pos,
      events: events.slice().sort(function (a, b) { return a.daysAgo - b.daysAgo; }),
      volRatio: volRatio,
    });

    return {
      price: price, chgPct: chgPct,
      volRatio: volRatio, volMA: volMA,
      amp: prevClose ? (last.h - last.l) / prevClose * 100 : 0,
      rangeHi: rangeHi, rangeLo: rangeLo, pos: pos,
      priorHi: priorHi, priorLo: priorLo,
      events: events.slice().sort(function (a, b) { return a.daysAgo - b.daysAgo; }),
      bullCount: bull.length, bearCount: bear.length,
      score: score, phase: phase, phaseText: phaseText,
      cycle: cycle,
      partial: partial,
    };
  }

  var api = { CFG: CFG, analyze: analyze, detectAt: detectAt, rangePos: rangePos, cycleOf: cycleOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
