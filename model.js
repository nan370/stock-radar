/* ==========================================================================
 * model.js —— 统一评分与交易计划引擎（选股页与个股分析页共用同一套口径）
 *
 * 为什么要有这个文件：
 *   以前「量化选股」和「个股分析」各算各的 —— 选股页用缠论+威科夫给 100 分制，
 *   个股分析页用七项均线打分给 -8~+8，同一只票在两页能给出完全相反的结论。
 *   同一套数据出现两个答案，比给不出答案更伤判断。现在两页都调 Model.score /
 *   Model.plan，权重、阈值、分级、买卖价推导全部只有一份实现。
 *
 * 口径声明（页面原样展示，不做隐藏）：
 *   1) 五个分项内部仍按原始分计算（结构 40 / 量价 25 / 动量 20 / 资金 15 / 风险 15），
 *      最后按各项满分归一化到 100 —— 旧版直接把五项相加，满分其实是 115，
 *      出现过「96 分」却仍被当成 100 分制去比较的情况，这是明确的算错。
 *   2) 动量分用「趋势效率」而非原始涨幅：涨幅 ÷ (ATR% × √N)，等价于漂移的 t 值。
 *      原始涨幅与结构分高度共线（都是「涨得多 → 结构好」），会让同一件事被计两次；
 *      效率化之后，同样涨 20%，日均波动 2% 的票得分远高于日均波动 8% 的票 ——
 *      前者是稳定推进，后者是宽幅震荡里的运气。
 *   3) 所有输入仍是浏览器本地计算，不上传任何数据。
 * ========================================================================== */
var Model = (function () {
  'use strict';

  var CFG = {
    MIN_SCORE: 42,        // 入榜最低综合分（100 分制，归一化后重定）
    MIN_RR: 1.2,          // 最低盈亏比
    /* 归一化权重：合计 100 */
    W: { structure: 35, volume: 22, momentum: 17, money: 13, risk: 13 },
    /* 各分项原始满分（内部计算用） */
    RAW: { structure: 40, volume: 25, momentum: 20, money: 15, risk: 15 },
    MAX_RISE: 9.0,
    LIMIT_UP_MAIN: 9.7,
    LIMIT_UP_GEM: 19.5,
  };

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function r1(v) { return Math.round(v * 10) / 10; }

  /* ---------------- 周期聚合：日线 → 周线 / 月线 ----------------
   * 个股分析页只有日线（腾讯 140 根），要参与「月→周→日」三级联立就必须自己聚合。
   * 与选股页直接拉周/月线相比会略粗（首尾不完整的周期），但口径一致、零额外请求。 */
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

  /* ---------------- ATR ---------------- */
  function atr(bars, n) {
    n = n || 14;
    if (!bars || bars.length < n + 2) return null;
    var s = 0;
    for (var i = bars.length - n; i < bars.length; i++) {
      var b = bars[i], pc = bars[i - 1].c;
      s += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    }
    return s / n;
  }

  /* ---------------- 支撑压力聚类 ---------------- */
  function clusterLevels(cands, price, side) {
    var list = (cands || []).filter(function (c) { return c && isFinite(c.price) && c.price > 0; });
    if (side === 'up') list = list.filter(function (c) { return c.price > price * 1.002; });
    else list = list.filter(function (c) { return c.price < price * 0.998; });

    list.sort(function (a, b) { return a.price - b.price; });
    var groups = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i], hitG = null;
      for (var g = 0; g < groups.length; g++) {
        if (Math.abs(groups[g].price - c.price) / groups[g].price < 0.015) { hitG = groups[g]; break; }
      }
      if (hitG) {
        hitG.members.push(c);
        hitG.weight += c.weight;
        var tw = hitG.members.reduce(function (a, m) { return a + m.weight; }, 0);
        hitG.price = hitG.members.reduce(function (a, m) { return a + m.price * m.weight; }, 0) / tw;
      } else {
        groups.push({ price: c.price, weight: c.weight, members: [c] });
      }
    }
    groups.forEach(function (g) {
      g.labels = g.members.map(function (m) { return m.label; })
        .filter(function (v, i, a) { return a.indexOf(v) === i; });
    });
    groups.sort(function (a, b) { return side === 'up' ? a.price - b.price : b.price - a.price; });
    return groups;
  }

  /* ---------------- 交易计划 ----------------
   * ctx: { price, day, week, month, wyckoff, atr, ma }
   * 结构位全部来自缠论中枢/笔端点 + 威科夫区间边界，均线的角色被刻意限制为
   * 「下方动态支撑」，不参与上方压力 —— 理由见下方注释。 */
  function plan(ctx) {
    var price = ctx.price, day = ctx.day, week = ctx.week, month = ctx.month;
    var wy = ctx.wyckoff, a = ctx.atr;
    var cands = [];

    function add(p, label, w) {
      if (p == null || !isFinite(p) || p <= 0) return;
      cands.push({ price: p, label: label, weight: w });
    }

    if (month && month.lastPivot) {
      add(month.lastPivot.zd, '月线中枢下沿', 9);
      add(month.lastPivot.zg, '月线中枢上沿', 9);
    }
    if (week && week.lastPivot) {
      add(week.lastPivot.zd, '周线中枢下沿', 7);
      add(week.lastPivot.zg, '周线中枢上沿', 7);
    }
    if (day && day.lastPivot) {
      add(day.lastPivot.zd, '日线中枢下沿', 6);
      add(day.lastPivot.zg, '日线中枢上沿', 6);
    }
    if (day && day.pens && day.pens.length) {
      var pens = day.pens;
      for (var i = pens.length - 1; i >= Math.max(0, pens.length - 4); i--) {
        add(pens[i].low, '日线笔低点', 4);
        add(pens[i].high, '日线笔高点', 4);
      }
    }
    if (wy) {
      add(wy.rangeLo, '60日区间下沿', 5);
      add(wy.rangeHi, '60日区间上沿', 5);
      add(wy.priorLo, '20日前低', 3);
      add(wy.priorHi, '20日前高', 3);
    }
    /* 均线是跟随指标：上涨途中 MA5/MA10 常贴在现价上方一点点，若参与压力位，
     * 最近压力就变成「明天均线」，盈亏比会被系统性压到 0.3 以下，所有票都不合格。
     * 所以均线只做下方支撑。 */
    if (ctx.ma) {
      ctx.ma.forEach(function (m) {
        if (m.value < price) add(m.value, 'MA' + m.n, m.n >= 60 ? 3 : 2);
      });
    }

    var sup = clusterLevels(cands, price, 'down').slice(0, 3);
    var res = clusterLevels(cands, price, 'up').slice(0, 3);

    var s1 = sup[0] ? sup[0].price : price * 0.95;
    var r1 = res[0] ? res[0].price : price * 1.08;

    var stopCands = [];
    if (day && day.buy && day.buy.price) stopCands.push({ p: day.buy.price * 0.985, label: '跌破日线买点低点' });
    if (day && day.lastPivot) stopCands.push({ p: day.lastPivot.zd * 0.99, label: '跌破日线中枢下沿' });
    if (wy) stopCands.push({ p: wy.rangeLo * 0.985, label: '跌破60日区间下沿' });
    if (a) stopCands.push({ p: price - a * 2, label: '2倍ATR止损' });

    var stop = null;
    stopCands.forEach(function (c) {
      if (c.p < s1 && (stop == null || c.p > stop.p)) stop = c;
    });
    if (!stop) stop = { p: s1 * 0.97, label: '支撑位下方 3%' };

    /* 买入区间：宽度硬性上限 3%，上沿不追过现价 1.5%、也不超过最近压力 */
    var hi = Math.min(price * 1.015, r1 * 0.995);
    var loRaw = Math.max(stop.p * 1.008, s1 * 1.002);
    if (!(hi > loRaw)) { hi = price * 1.01; loRaw = price * 0.985; }
    var lo = Math.max(loRaw, hi * 0.97);
    var mid = (lo + hi) / 2;

    /* 止损距离用 ATR 归一化，夹在 [1.1ATR, 12%] */
    var gap = mid - stop.p;
    var gapMin = a ? Math.max(a * 1.1, mid * 0.012) : mid * 0.015;
    var gapMax = mid * 0.12;
    if (gap < gapMin) {
      stop = { p: mid - Math.min(gapMin, gapMax), label: stop.label + '（按1.1倍ATR放宽）' };
      gap = mid - stop.p;
    } else if (gap > gapMax) {
      stop = { p: mid - gapMax, label: stop.label + '（止损超过12%，已收窄）' };
      gap = mid - stop.p;
    }

    /* 目标位同样要夹住：最近压力可能是几个月前的高点，+29% 的不是目标是幻想 */
    var t1 = r1;
    if (a) t1 = Math.min(t1, mid + a * 6);
    t1 = Math.min(t1, mid * 1.15);
    if (t1 <= mid * 1.01) t1 = mid * 1.01;

    var t2 = res[1] ? res[1].price : r1 * 1.06;
    if (a) t2 = Math.min(t2, mid + a * 12);
    t2 = Math.min(t2, mid * 1.30);
    if (t2 <= t1 * 1.02) t2 = t1 * 1.02;

    var risk = gap;
    var rr = risk > 0 ? (t1 - mid) / risk : null;
    var rr2 = risk > 0 ? (t2 - mid) / risk : null;

    /* waitPullback 只表示「买区被压在现价下方，需要等回踩」这一种情况。
     * 2026-10-24 修：旧版还并入了「最近支撑深于现价 2%」—— 那只说明下方有回踩空间，
     * 不代表现价高于买区；而买区上沿本来就允许到现价 +1.5%（见上面的 hi），
     * 现价通常就落在区间内。误判的后果是选股页标「等回踩」、分析页写
     * 「现价 290 高于计划买区上沿 294.35」，与交易计划区的「已在区间内」自相矛盾。 */
    var waitPullback = hi < price * 0.998;

    return {
      supports: sup, resistances: res,
      buyLo: lo, buyHi: hi, buyMid: mid,
      stop: stop.p, stopReason: stop.label,
      target1: t1, target2: t2,
      rr: rr, rr2: rr2,
      riskPct: mid > 0 ? risk / mid * 100 : null,
      atr: a,
      waitPullback: waitPullback,
      /* 现价是否落在买区内：给下游做文案判断用，避免各自重复写比较、写出不一致的结论 */
      inBuyZone: price >= lo && price <= hi,
      targetNote: (t1 >= r1 - 1e-9) ? '目标为最近压力位'
        : '最近压力过远，目标已按 6 倍 ATR / +15% 封顶',
      widthPct: (hi - lo) / mid * 100,
    };
  }

  /* ---------------- 综合打分 ----------------
   * it: { month, week, day, wyckoff, plan, atr, price, pct, code, mainNet, amount,
   *       _chg20, _chg60 }
   * 返回：{ total, structure, volume, momentum, money, risk, detail, grade,
   *         gradeText, levelHit, raw }
   */
  function score(it) {
    var m = it.month, w = it.week, d = it.day, wy = it.wyckoff, p = it.plan || {};
    var detail = [];

    /* 1. 结构分（原始 40）：月→周→日 三级联立 */
    var s = 0;
    /* 方向不明（dir === 0：笔数不足、没有成笔）必须按 0 分处理。
     * 旧写法用 else 兜底，会把「结构尚未形成」直接算成「逆势」，
     * 于是新股、长期一字板、超强趋势（回调太浅、根本成不了笔）全被扣分。 */
    if (m) {
      if (m.dir > 0) { s += 12; detail.push({ k: '月线', v: '+12', t: '月线笔向上，大级别方向不逆势' }); }
      else if (m.position === 'inside') { s += 5; detail.push({ k: '月线', v: '+5', t: '月线中枢内震荡，方向中性' }); }
      else if (m.dir < 0) { s -= 4; detail.push({ k: '月线', v: '-4', t: '月线位于中枢下方且笔向下，逆势风险' }); }
      else { detail.push({ k: '月线', v: '0', t: '月线尚未成笔（结构未形成），不计分' }); }
      if (m.buy && m.buy.grade) { s += 3; detail.push({ k: '月线', v: '+3', t: '月线出现 ' + buyCn(m.buy.type) + '买点' }); }
    }
    if (w) {
      if (w.dir > 0) { s += 10; detail.push({ k: '周线', v: '+10', t: '周线笔向上，中级趋势配合' }); }
      else if (w.position === 'inside') { s += 3; detail.push({ k: '周线', v: '+3', t: '周线中枢内震荡' }); }
      else if (w.dir < 0) { s -= 3; detail.push({ k: '周线', v: '-3', t: '周线向下且在中枢下方' }); }
      else { detail.push({ k: '周线', v: '0', t: '周线尚未成笔，不计分' }); }
      if (w.buy && w.buy.grade >= 2) { s += 4; detail.push({ k: '周线', v: '+4', t: '周线 ' + buyCn(w.buy.type) + '买点成立' }); }
    }
    if (d) {
      var g = d.buy && d.buy.grade ? d.buy.grade : 0;
      if (g === 3) { s += 15; detail.push({ k: '日线', v: '+15', t: '日线三买：回调不进中枢，结构最健康' }); }
      else if (g === 2) { s += 11; detail.push({ k: '日线', v: '+11', t: '日线二买：不破前低' }); }
      else if (g === 1) { s += 5; detail.push({ k: '日线', v: '+5', t: '日线一买：背驰反弹，需次级别确认' }); }
      else if (d.buy && d.buy.running) { s += 3; detail.push({ k: '日线', v: '+3', t: '日线笔向上运行中，等回调不破' }); }
      else if (d.dir < 0) { s -= 3; detail.push({ k: '日线', v: '-3', t: '日线无买点且笔向下，结构走弱' }); }
      else { detail.push({ k: '日线', v: '0', t: '日线无有效买点，方向未明，不计分' }); }

      if (d.position === 'above') { s += 4; detail.push({ k: '日线', v: '+4', t: '价格站上日线中枢上沿，强势区' }); }
      if (d.diverg && d.diverg.type === 'top') { s -= 5; detail.push({ k: '日线', v: '-5', t: '日线顶背驰，上攻动能衰竭' }); }
    }
    var rawStructure = clamp(s, 0, CFG.RAW.structure);
    detail.push({ k: '结构合计', v: r1(rawStructure) + '/' + CFG.RAW.structure, t: '月→周→日 三级结构联立' });

    /* 2. 量价分（原始 25） */
    var v = 12.5;
    if (wy) {
      v += wy.score / 8;
      if (wy.bullCount > wy.bearCount) { v += 2; detail.push({ k: '威科夫', v: '+2', t: '多头量价事件占优（' + wy.bullCount + ':' + wy.bearCount + '）' }); }
      else if (wy.bearCount > wy.bullCount) { v -= 2; detail.push({ k: '威科夫', v: '-2', t: '空头量价事件占优（' + wy.bullCount + ':' + wy.bearCount + '）' }); }
      if (wy.phase === 'accumulation') { v += 3; detail.push({ k: '威科夫', v: '+3', t: '处于吸筹阶段：' + wy.phaseText }); }
      if (wy.phase === 'distribution') { v -= 4; detail.push({ k: '威科夫', v: '-4', t: '处于派发阶段：' + wy.phaseText }); }
      var vr = wy.volRatio;
      if (vr >= 1.2 && vr <= 2.5) { v += 2; detail.push({ k: '量比', v: '+2', t: '量比 ' + vr.toFixed(2) + '，温和放量' }); }
      else if (vr > 4) { v -= 3; detail.push({ k: '量比', v: '-3', t: '量比 ' + vr.toFixed(2) + '，巨量多为分歧' }); }

      /* 阶段：A~E 只做小幅加减，且必须与量价事件方向一致才给分，
       * 避免「C 段」这三个字单独成为买入理由。 */
      if (wy.cycle && wy.cycle.hasRange) {
        var cc = wy.cycle.code;
        var cn = wy.cycle.name || '';
        if (cc === 'C' && /吸筹/.test(cn)) { v += 3; detail.push({ k: '阶段', v: '+3', t: cn + '：Spring 后缩量测试成立' }); }
        else if (cc === 'C' && /派发/.test(cn)) { v -= 4; detail.push({ k: '阶段', v: '-4', t: cn + '：Upthrust 后缩量反抽成立' }); }
        else if (cc === 'E' && /上行/.test(cn)) { v += 2; detail.push({ k: '阶段', v: '+2', t: cn }); }
        else if (cc === 'E' && /下行/.test(cn)) { v -= 3; detail.push({ k: '阶段', v: '-3', t: cn }); }
        else if (cc === 'D') { detail.push({ k: '阶段', v: '0', t: cn }); }
      }
    }
    var rawVolume = clamp(v, 0, CFG.RAW.volume);

    /* 3. 动量分（原始 20）：趋势效率，不是原始涨幅 */
    var mom = 10, m20 = it._chg20, m60 = it._chg60;
    var atrPct = (it.atr && it.price) ? it.atr / it.price * 100 : null;
    var effNote = atrPct ? '（按日均波动 ' + atrPct.toFixed(2) + '% 归一）' : '';
    if (m20 != null) {
      var e20 = atrPct ? m20 / (atrPct * Math.sqrt(20)) : m20 / 2;
      var add20 = clamp(e20 * 3, -6, 6);
      mom += add20;
      detail.push({
        k: '动量', v: (add20 >= 0 ? '+' : '') + add20.toFixed(1),
        t: '近20日 ' + m20.toFixed(1) + '%' + effNote + '，趋势效率 ' + e20.toFixed(2),
      });
    }
    if (m60 != null) {
      var e60 = atrPct ? m60 / (atrPct * Math.sqrt(60)) : m60 / 4;
      var add60 = clamp(e60 * 3, -4, 4);
      mom += add60;
      detail.push({
        k: '动量', v: (add60 >= 0 ? '+' : '') + add60.toFixed(1),
        t: '近60日 ' + m60.toFixed(1) + effNote + '，趋势效率 ' + e60.toFixed(2),
      });
    }
    var rawMomentum = clamp(mom, 0, CFG.RAW.momentum);

    /* 4. 资金分（原始 15） */
    var fund = 7.5;
    if (it.mainNet != null && it.amount) {
      var ratio = it.mainNet / it.amount;
      var addF = clamp(ratio * 30, -7.5, 7.5);
      fund += addF;
      detail.push({ k: '资金', v: (addF >= 0 ? '+' : '') + addF.toFixed(1), t: '主力净流入占成交额 ' + (ratio * 100).toFixed(1) + '%' });
    } else {
      detail.push({ k: '资金', v: '±0', t: '无主力资金数据，按中位计' });
    }
    var rawMoney = clamp(fund, 0, CFG.RAW.money);
    /* 资金项缺数据时不能按「中位 7.5 分」计入总和：
     * 个股分析页拿不到主力净流入，恒定中位会把总分系统性压掉 6.5 分，
     * 于是同一只票在选股页 60 分、在分析页 53 分 —— 这正是「两页打架」的老问题。
     * 处理办法是按可得分项重新折算到 100，并在返回值里标明缺项。 */
    var moneyMissing = !(it.mainNet != null && it.amount);

    /* 5. 风险分（原始 15） */
    var risk = 12;
    if (p.riskPct != null) {
      if (p.riskPct > 8) { risk -= 6; detail.push({ k: '风险', v: '-6', t: '止损距离 ' + p.riskPct.toFixed(1) + '%，单笔风险过大' }); }
      else if (p.riskPct > 5) { risk -= 3; detail.push({ k: '风险', v: '-3', t: '止损距离 ' + p.riskPct.toFixed(1) + '%，偏高' }); }
      else { detail.push({ k: '风险', v: '0', t: '止损距离 ' + p.riskPct.toFixed(1) + '%，可控' }); }
    }
    if (atrPct != null && atrPct > 6) { risk -= 4; detail.push({ k: '风险', v: '-4', t: '日均波动 ' + atrPct.toFixed(1) + '%，波动过大' }); }
    if (it.pct != null && it.pct > CFG.MAX_RISE) { risk -= 3; detail.push({ k: '风险', v: '-3', t: '当日涨幅 ' + it.pct.toFixed(1) + '%，追高风险' }); }
    if (it.pct != null && it.pct > 0 && it.pct >= (/^(sz30|sh688)/.test(it.code || '') ? CFG.LIMIT_UP_GEM : CFG.LIMIT_UP_MAIN)) {
      risk -= 5; detail.push({ k: '风险', v: '-5', t: '已涨停，次日不可控且大概率买不进' });
    }
    if (p.rr != null) {
      if (p.rr >= 2) { risk += 3; detail.push({ k: '盈亏比', v: '+3', t: '盈亏比 ' + p.rr.toFixed(2) + '，赔率优良' }); }
      else if (p.rr >= 1.5) { risk += 1; detail.push({ k: '盈亏比', v: '+1', t: '盈亏比 ' + p.rr.toFixed(2) + '，可接受' }); }
      else if (p.rr < 0.9) { risk -= 8; detail.push({ k: '盈亏比', v: '-8', t: '盈亏比仅 ' + p.rr.toFixed(2) + '，买区已贴压力，无交易价值' }); }
      else if (p.rr < 1.2) { risk -= 4; detail.push({ k: '盈亏比', v: '-4', t: '盈亏比 ' + p.rr.toFixed(2) + '，空间不足' }); }
      else { detail.push({ k: '盈亏比', v: '0', t: '盈亏比 ' + p.rr.toFixed(2) }); }
    }
    var rawRisk = clamp(risk, 0, CFG.RAW.risk);

    /* 归一化：各项 / 原始满分 × 目标权重，合计恰好 100 */
    var W = CFG.W, RAW = CFG.RAW;
    var structure = rawStructure / RAW.structure * W.structure;
    var volume = rawVolume / RAW.volume * W.volume;
    var momentum = rawMomentum / RAW.momentum * W.momentum;
    var money = rawMoney / RAW.money * W.money;
    var riskF = rawRisk / RAW.risk * W.risk;
    var parts = [[structure, W.structure], [volume, W.volume], [momentum, W.momentum], [riskF, W.risk]];
    if (!moneyMissing) parts.push([money, W.money]);
    var availW = parts.reduce(function (a, x) { return a + x[1]; }, 0) || 100;
    var total = Math.round(parts.reduce(function (a, x) { return a + x[0]; }, 0) / availW * 100);

    /* 等级：按四级联立的实际满足数，与分数独立 —— 高分但只有两级配合的，
     * 仍然是 C 级。这是刻意的：分数回答「有多强」，等级回答「几个人同意」。 */
    var lv = 0;
    if (m && m.dir > 0) lv++;
    if (w && w.dir > 0) lv++;
    if (d && d.buy && d.buy.grade >= 2) lv++;
    if (d && d.position === 'above') lv++; else if (d && d.buy && d.buy.grade >= 3) lv++;
    var grade = lv >= 4 ? 'A' : lv === 3 ? 'B' : lv === 2 ? 'C' : 'D';
    var gradeText = { A: '四级共振', B: '三级配合', C: '两级确认', D: '结构不足' }[grade];

    return {
      total: total,
      structure: r1(structure), volume: r1(volume), momentum: r1(momentum),
      money: moneyMissing ? null : r1(money), risk: r1(riskF),
      moneyMissing: moneyMissing, weightUsed: availW,
      raw: { structure: r1(rawStructure), volume: r1(rawVolume), momentum: r1(rawMomentum), money: r1(rawMoney), risk: r1(rawRisk) },
      detail: detail, grade: grade, gradeText: gradeText, levelHit: lv,
      max: 100,
    };
  }

  function buyCn(t) {
    return { first: '一', second: '二', third: '三' }[t] || '';
  }

  /* 位置建议仓位：单笔账户风险固定 1%，仓位 = 1% ÷ 止损距离。
   * 这是仓位管理的标准做法，比「轻仓/半仓」这种形容词可执行。 */
  function position(planObj, riskBudgetPct) {
    var budget = riskBudgetPct == null ? 1 : riskBudgetPct;
    if (!planObj || !(planObj.riskPct > 0)) return null;
    var pct = budget / planObj.riskPct * 100;
    return { pct: Math.min(100, Math.max(0, pct)), budget: budget };
  }

  return {
    CFG: CFG, aggregate: aggregate, atr: atr, clusterLevels: clusterLevels,
    plan: plan, score: score, position: position, clamp: clamp,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Model;
