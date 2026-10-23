/* 技术指标引擎 —— 纯确定性计算，所有支撑压力位均可复算
 *
 * bars格式: [date(YYMMDD), open, high, low, close, volume]，按日期倒序（最新在前）
 */
const TA = (() => {

  /* ---------- 基础统计 ---------- */
  const closes = (b) => b.map((x) => x[4]);
  const highs = (b) => b.map((x) => x[2]);
  const lows = (b) => b.map((x) => x[3]);
  const vols = (b) => b.map((x) => x[5]);

  function sma(arr, n) {
    const out = new Array(arr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= n) sum -= arr[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  /* 指数移动平均 */
  function ema(arr, n) {
    const out = new Array(arr.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null;
    for (let i = 0; i < arr.length; i++) {
      prev = prev == null ? arr[i] : arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /* RSI(14) —— Wilder 平滑 */
  function rsi(closes, n = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < n + 1) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = n + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
      loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  /* MACD(12,26,9) */
  function macd(closes) {
    const e12 = ema(closes, 12), e26 = ema(closes, 26);
    const dif = closes.map((_, i) => e12[i] - e26[i]);
    const dea = ema(dif, 9);
    const hist = dif.map((v, i) => (v - dea[i]) * 2);
    return { dif, dea, hist };
  }

  /* 布林带(20,2) */
  function boll(closes, n = 20, k = 2) {
    const mid = sma(closes, n);
    const up = new Array(closes.length).fill(null);
    const dn = new Array(closes.length).fill(null);
    for (let i = n - 1; i < closes.length; i++) {
      const win = closes.slice(i - n + 1, i + 1);
      const m = mid[i];
      const sd = Math.sqrt(win.reduce((a, v) => a + (v - m) ** 2, 0) / n);
      up[i] = m + k * sd; dn[i] = m - k * sd;
    }
    return { mid, up, dn };
  }

  /* ATR(14) —— 真实波幅均值
   * asc 需为时间正序（最早在前），用前一交易日收盘价计算真实波幅 */
  function atr(asc, n = 14) {
    if (asc.length < n + 1) return null;
    let s = 0;
    for (let i = 1; i <= n; i++) {
      const h = asc[i][2], l = asc[i][3], pc = asc[i - 1][4];
      s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    return s / n;
  }

  /* 支撑压力位：成交量加权直方图法
   * 把近N 日价格按固定幅度分箱，每个箱累加成交量。
   * 峰值区 = 筹码最密集处 = 最强支撑或压力。
   * 该方法完全可复现、参数明确，优于模型估计。
   * 注意：bars 为日期倒序（最新在前），下方计算需先反转为时间正序。
   */
  function volumeProfile(bars, lookback = 120, binPct = 0.005) {
    // 反转成时间正序（最早在前）
    const win = bars.slice(0, lookback).slice().reverse();
    if (win.length < 20) return null;
    let lo = Infinity, hi = -Infinity;
    for (const b of win) { if (b[3] < lo) lo = b[3]; if (b[2] > hi) hi = b[2]; }
    if (!(hi > lo)) return null;

    const nb = Math.max(10, Math.min(200, Math.round(1 / binPct)));
    const size = (hi - lo) / nb;
    const bins = new Array(nb).fill(0);
    for (const b of win) {
      const mid = (b[2] + b[3] + b[4]) / 3;   // (high+low+close)/3
      let idx = Math.floor((mid - lo) / size);
      if (idx < 0) idx = 0;
      if (idx > nb - 1) idx = nb - 1;
      bins[idx] += b[5];
    }
    const peak = bins.indexOf(Math.max(...bins));

    // 合并相邻高量箱，取峰值区上下沿
    const thresh = bins[peak] * 0.55;
    let a = peak, b = peak;
    while (a > 0 && bins[a - 1] >= thresh) a--;
    while (b < nb - 1 && bins[b + 1] >= thresh) b++;

    const clamp = (p) => Math.min(Math.max(p, lo), hi);
    return {
      support: clamp(lo + a * size + size / 2),
      resistance: clamp(lo + b * size + size / 2),
      peakPrice: clamp(lo + peak * size + size / 2),
      low: lo, high: hi, bins, binSize: size, nb,
      totalVol: bins.reduce((x, y) => x + y, 0),
    };
  }

  /* 按现价切分筹码密集区：下方为支撑，上方为压力 */
  function splitProfile(vp, price) {
    if (!vp) return { support: null, resistance: null };
    const mid = (vp.support + vp.resistance) / 2;
    if (price < vp.support) return { support: null, resistance: mid };
    if (price > vp.resistance) return { support: mid, resistance: null };
    return { support: vp.support, resistance: vp.resistance };
  }

  /* 均线支撑：取价格下方的均线作为动态支撑，上方作为压力
     bars 为日期倒序，最新 K 线在数组头部 */
  function maLevels(bars, price) {
    const defs = [[5, 'MA5'], [10, 'MA10'], [20, 'MA20'],
                  [30, 'MA30'], [60, 'MA60'], [120, 'MA120']];
    const out = [];
    for (const [n, label] of defs) {
      if (bars.length < n) continue;
      const win = bars.slice(0, n);
      let s = 0;
      for (const b of win) s += b[4];
      out.push({ n, label, value: s / n });
    }
    return {
      all: out,
      support: out.filter((x) => x.value < price).sort((a, b) => b.value - a.value),
      resistance: out.filter((x) => x.value > price).sort((a, b) => a.value - b.value),
    };
  }

  /* 前高前低：近 N 日极值 */
  function swingLevels(bars, lookback = 60) {
    const win = bars.slice(0, lookback);
    if (win.length < 10) return null;
    return {
      highest: Math.max(...win.map((b) => b[2])),
      lowest: Math.min(...win.map((b) => b[3])),
    };
  }

  /* 斐波那契回撤（基于近 N 日高低点） */
  function fib(bars, lookback = 120) {
    const win = bars.slice(0, lookback);
    if (win.length < 20) return null;
    let hi = -Infinity, lo = Infinity;
    for (const b of win) { if (b[2] > hi) hi = b[2]; if (b[3] < lo) lo = b[3]; }
    const d = hi - lo;
    if (d <= 0) return null;
    return {
      hi, lo,
      levels: [
        { r: 0.236, p: hi - d * 0.236 },
        { r: 0.382, p: hi - d * 0.382 },
        { r: 0.5, p: hi - d * 0.5 },
        { r: 0.618, p: hi - d * 0.618 },
        { r: 0.786, p: hi - d * 0.786 },
      ],
    };
  }

  /* 趋势判定：七项加权打分
       评分项：站上MA5/MA20/MA60(各1分)、MA5>MA20(1分)、MACD柱>0(1分)、
               DIF>DEA(1分)、MACD柱走阔(1分)、20日涨跌>0(1分)
       总分 -8 ~ +8，映射为五档趋势。所有指标均基于时间正序数据计算。 */
  function trend(bars) {
    const price = bars[0][4];
    const ma = maLevels(bars, price);
    const maOf = (n) => ma.all.find((x) => x.n === n)?.value;
    const ma5 = maOf(5), ma20 = maOf(20), ma60 = maOf(60);

    // 全部指标基于时间正序（最早在前）
    const asc = bars.slice().reverse();
    const ac = asc.map((b) => b[4]);

    let score = 0;
    const reasons = [];
    const add = (cond, upReason, downReason, pts) => {
      if (cond == null) return;
      if (cond) { score += pts; reasons.push(upReason); }
      else { score -= pts; reasons.push(downReason); }
    };

    add(ma5 != null ? price > ma5 : null,
      `股价${price.toFixed(2)} 位于5日均线（${ma5?.toFixed(2)}）上方，短期偏强`,
      `股价${price.toFixed(2)} 跌破5日均线（${ma5?.toFixed(2)}），短期动能转弱`, 1);
    add(ma20 != null ? price > ma20 : null,
      `股价站上20日均线（${ma20?.toFixed(2)}），中期结构良好`,
      `股价跌破20日均线（${ma20?.toFixed(2)}），中期承压`, 1);
    add(ma60 != null ? price > ma60 : null,
      `股价站上60日均线（${ma60?.toFixed(2)}），中期趋势健康`,
      `股价跌破60日均线（${ma60?.toFixed(2)}），中期趋势偏弱`, 1);
    add(ma5 != null && ma20 != null ? ma5 > ma20 : null,
      '5日均线上穿20日均线，短线动能向上',
      '5日均线位于20日均线下方，短线动能向下', 1);

    const m = macd(ac);
    const histLast = m.hist[m.hist.length - 1];
    const prevHist = m.hist[m.hist.length - 2] ?? 0;
    add(histLast > 0,
      'MACD柱为正，多头动能占优',
      'MACD柱为负，空头动能占优', 1);
    add(m.dif[m.dif.length - 1] > m.dea[m.dea.length - 1],
      'DIF位于DEA上方，趋势结构完好',
      'DIF位于DEA下方，趋势结构转弱', 1);
    add(histLast > prevHist,
      'MACD柱较前一日走阔，上涨动能增强',
      'MACD柱较前一日收缩，上涨动能衰减', 1);

    // 20 日动量
    const mom20 = bars.length > 20 ? ((price - bars[20][4]) / bars[20][4]) * 100 : null;
    add(mom20 != null ? mom20 > 0 : null,
      `近20日累计上涨 ${mom20.toFixed(2)}%，中期动量为正`,
      `近20日累计下跌 ${Math.abs(mom20).toFixed(2)}%，中期动量为负`, 1);

    const chg60 = bars.length > 60 ? ((price - bars[60][4]) / bars[60][4]) * 100 : null;

    let label, cls;
    if (score >= 4) { label = '强势多头'; cls = 'strong-bull'; }
    else if (score >= 1) { label = '温和上行'; cls = 'mild-bull'; }
    else if (score >= -2) { label = '震荡整理'; cls = 'neutral'; }
    else if (score >= -5) { label = '温和下行'; cls = 'mild-bear'; }
    else { label = '弱势空头'; cls = 'strong-bear'; }

    return { label, cls, score, reasons, ma, mom20, chg60, macd: m };
  }

  /* ---------- 汇总分析 ---------- */
  function analyze(bars) {
    if (!bars || bars.length < 30) return null;
    // bars 为日期倒序（最新在前）→ 全部技术指标按时间正序计算
    const asc = bars.slice().reverse();
    const ac = asc.map((b) => b[4]);
    const price = bars[0][4];
    const prevClose = bars[1] ? bars[1][4] : price;

    const t = trend(bars);
    const vp = volumeProfile(bars, Math.min(120, bars.length));
    const vpSplit = splitProfile(vp, price);
    const fibo = fib(bars, Math.min(120, bars.length));
    const sw = swingLevels(bars, Math.min(60, bars.length));
    const ma = t.ma;

    const a = atr(asc, 14);
    const r = rsi(ac, 14);
    const bb = boll(ac, 20, 2);
    const last = (arr) => arr[arr.length - 1];

    // 聚合支撑压力候选
    const supCands = [], resCands = [];
    const push = (arr, price2, label, weight) => {
      if (price2 == null || !isFinite(price2)) return;
      if (price2 <= 0) return;
      arr.push({ price: price2, label, weight });
    };

    push(supCands, vpSplit.support, '筹码密集区下沿', 3);
    push(resCands, vpSplit.resistance, '筹码密集区上沿', 3);
    ma.support.slice(0, 3).forEach((x) => push(supCands, x.value, x.label, 2));
    ma.resistance.slice(0, 3).forEach((x) => push(resCands, x.value, x.label, 2));
    if (sw) {
      push(supCands, sw.lowest, '60日最低点', 2);
      push(resCands, sw.highest, '60日最高点', 2);
    }
    if (fibo) {
      fibo.levels.forEach((f) => {
        if (f.p < price) push(supCands, f.p, `${(f.r * 100).toFixed(1)}%回撤位`, 1);
        else push(resCands, f.p, `${(f.r * 100).toFixed(1)}%回撤位`, 1);
      });
    }

    // 聚合相近价位（容差 1.2%）。支撑与压力分开聚类，避免相互污染。
    const cluster = (cands) => {
      if (!cands.length) return [];
      const sorted = [...cands].sort((x, y) => y.price - x.price);
      const groups = [];
      for (const c2 of sorted) {
        const hit = groups.find((g) => Math.abs(g.price - c2.price) / g.price < 0.012);
        if (hit) {
          hit.members.push(c2);
          hit.weight += c2.weight;
          const tw = hit.members.reduce((acc, m) => acc + m.weight, 0);
          hit.price = hit.members.reduce((acc, m) => acc + m.price * m.weight, 0) / tw;
        } else groups.push({ price: c2.price, weight: c2.weight, members: [c2] });
      }
      return groups;
    };

    // 支撑位：从现价向下最近者优先（正序）
    const supports = cluster(supCands)
      .sort((x, y) => y.price - x.price)          // 价格降序 = 距现价由近到远
      .slice(0, 4)
      .map((g) => ({
        price: g.price,
        strength: g.weight,
        distance: (price - g.price) / price * 100,
        labels: [...new Set(g.members.map((m) => m.label))],
      }));
    // 压力位：从现价向上最近者优先（升序）
    const resistances = cluster(resCands)
      .sort((x, y) => x.price - y.price)          // 价格升序 = 距现价由近到远
      .slice(0, 4)
      .map((g) => ({
        price: g.price,
        strength: g.weight,
        distance: (g.price - price) / price * 100,
        labels: [...new Set(g.members.map((m) => m.label))],
      }));

    return {
      price, prevClose,
      changePct: ((price - prevClose) / prevClose) * 100,
      date: bars[0][0],
      bars: bars.length,
      trend: t,
      volumeProfile: vp,
      vpSplit,
      fib: fibo,
      swing: sw,
      supports, resistances,
      rsi: last(r),
      boll: { up: last(bb.up), mid: last(bb.mid), dn: last(bb.dn) },
      atr: a,
      chg20: t.chg20, chg60: t.chg60,
      bars,          // 原始K线（日期倒序），供前端绘图使用
    };
  }

  return { analyze, sma, ema, rsi, macd, boll, atr, volumeProfile, trend, maLevels, fib };
})();