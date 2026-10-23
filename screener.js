/* ==========================================================================
 * screener.js —— 量化选股漏斗（缠论 × 威科夫 × 多因子）
 *
 * 四层结构（浏览器端算力决定了必须分层，全市场 5900 只逐只拉多周期K线不可行）：
 *   L0 全市场快照     东财 clist 一次拿回全市场报价与资金字段
 *   L1 量价粗筛       静态条件剔除 + 快照因子排序，收敛到 60 只
 *   L2 多周期精算     月/周/日/30F 后复权K线 → 缠论结构 + 威科夫事件
 *   L3 打分排序       多因子加权，输出 8~12 只，附支撑压力与交易计划
 *
 * 口径声明：
 *   - 结构计算统一用后复权(hfq)，前复权会在除权日造假笔假中枢；
 *     页面展示的真实价另行用快照价换算，两者不混用。
 *   - 30 分钟线为不复权数据（行情源限制），仅用于 4 个月内的入场时机判断，
 *     窗口内若有除权会在证据里提示。
 *   - 盘中最后一根日线是未完成K线，所有依赖它的判定标记 partial=true。
 *   - 不做"必选"式硬过滤：四级结构按满足程度分级给分，避免筛选结果为空，
 *     但低于等级门槛的标的不进榜。
 * ========================================================================== */
var Screener = (function () {
  'use strict';

  var CFG = {
    POOL: 60,             // L2 精算标的数
    TOP: 10,              // L3 入榜数
    MIN_SCORE: 45,        // 入榜最低综合分
    MIN_AMOUNT: 8000,     // 最小成交额（万元）＝ 8000 万
    MIN_FLOAT_CAP: 20,    // 最小流通市值（亿）
    MAX_RISE: 9.0,        // 涨幅超过该值视为接近涨停，降权
    LIMIT_UP_MAIN: 9.7,
    LIMIT_UP_GEM: 19.5,
    CONCURRENCY: 8,
    INCLUDE_BJ: false,    // 北交所流动性不足，默认不参与
    KLINE_TTL: 180000,    // K线内存缓存有效期（3 分钟）
  };

  /* 数据源名称。多源是必须的：东财 push2 系会间歇性全线不可达，
   * 单源时代整个选股会直接停摆。页面要把当前用的是哪个源、
   * 有没有做交叉校验都显示出来，用户才能判断这批数字可信度。 */
  var SRC_TEXT = {
    em: '东财', sina: '新浪', tx: '腾讯', ths: '同花顺', tencent: '腾讯',
    'em+daily': '东财+日线', 'sina+daily': '新浪+日线', 'tx+daily': '腾讯+日线',
  };

  /* --------------------------- 工具 --------------------------- */
  var KLINE_CACHE = {};   // code|period -> {t, bars}
  var BAR_CACHE = {};

  function now() { return Date.now(); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function pctText(v) { return (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }

  function prefix(code, market) {
    code = String(code).trim();
    if (/^(sh|sz|bj)/.test(code)) return code;
    if (market === 'SH' || market === 1 || market === '1') return 'sh' + code;
    if (market === 'SZ' || market === 0 || market === '0') return 'sz' + code;
    if (/^6/.test(code)) return 'sh' + code;
    if (/^(0|3)/.test(code)) return 'sz' + code;
    if (/^(4|8|9)/.test(code)) return 'bj' + code;
    return 'sz' + code;
  }

  function ymdToNum(s) {
    var m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    if (!m) return String(s).slice(0, 6);
    return m[1].slice(2) + m[2] + m[3];
  }

  /* --------------------- L0：全市场快照 --------------------- */
  /* 数据源统一走 Feeds（多源 + 交叉验证）。这里只保留业务侧的字段清洗：
   * Feeds 负责「哪个源能用、数据对不对得上」，Screener 负责「这些数字能不能用来选股」。
   * 单源时代已经踩过的坑：东财不可达就没有备选、只返回 100 条被当成全市场。 */
  function emUniverse() {
    return Feeds.emUniverse(prefix);
  }

  /* 降级方案：内置清单全市场，用腾讯批量报价补实时价。
   * 只有东财、新浪同时不可用时才会走到这里（此时无资金流与量比）。 */
  function txBulkQuotes(codes) {
    return Feeds.txQuotes(codes, 4);
  }

  function fallbackUniverse() {
    return fetch('a_share_all.json', { cache: 'force-cache' })
      .then(function (r) { return r.json(); })
      .then(function (list) {
        var rows = list.filter(function (r) {
          return CFG.INCLUDE_BJ || !/北交所|^bj/.test(r.board || r.norm || '');
        });
        var codes = rows.map(function (r) { return r.norm; });
        return txBulkQuotes(codes).then(function (q) {
          return rows.map(function (r) {
            var x = q[r.norm] || {};
            return {
              code: r.norm, raw: r.code, name: x.name || r.name,
              price: x.price, pct: x.pct || 0, volume: 0,
              amount: x.amount, amp: x.amp, turnover: x.turnover,
              pe: null, volRatio: x.volRatio, pct5min: 0,
              high: x.high, low: x.low, open: null, prevClose: x.prevClose,
              totalCap: 0, floatCap: 0, speed: 0, pb: null, mainNet: null,
              industry: r.board, src: 'tx',
            };
          });
        });
      });
  }

  /* 备选源：新浪全市场列表（现在由 Feeds 统一调度）。
   * 单位坑：amount 是元、nmc/mktcap 是万元，两者除以的量级不同，
   * 在 Feeds 里已经分别处理，这里不再重复换算。 */
  function sinaUniverse(onProgress) {
    return Feeds.sinaUniverse(prefix, onProgress);
  }

  /* 快照可用度：有成交额的标的占比。
   * 盘前（9:15 前）全部实时源都没有当日成交，amount 恒为 0，
   * 此时若还按「成交额 ≥ 8000 万」硬过滤，全市场会被筛成 0 只——
   * 页面上表现为「一只都没有」，但真实原因是根本没有当日数据。 */
  function liveRatioOf(rows) {
    if (!rows || !rows.length) return 0;
    var n = 0;
    for (var i = 0; i < rows.length; i++) if (rows[i].amount > 0) n++;
    return n / rows.length;
  }

  /* 全市场补全：新浪分页会被限流，实测覆盖在 70%~95% 之间波动，
   * 直接拿残样本当「全市场」会漏掉大量标的。
   * 做法是用内置清单（5918 只）做差集，再用东财 ulist 批量补价 ——
   * 一次可带 100 只，16 批 4 路并发约 2 秒，比逐只用腾讯快两个数量级。 */
  function patchMissing(rows, onProgress) {
    return fetch('a_share_all.json', { cache: 'force-cache' })
      .then(function (r) { return r.json(); })
      .then(function (list) {
        var have = {};
        rows.forEach(function (r) {
          have[r.raw || String(r.code).replace(/^(sh|sz|bj)/, '')] = 1;
        });

        var miss = [];
        list.forEach(function (x) {
          if (have[x.code]) return;
          if (!CFG.INCLUDE_BJ && /北交所/.test(x.board || '')) return;
          if (isBadName(x.name)) return;
          miss.push(x);
        });
        if (!miss.length) return rows;

        if (onProgress) {
          onProgress({
            stage: 'prepare', done: 0, total: miss.length,
            msg: '补全未覆盖标的 ' + miss.length + ' 只（东财批量）',
          });
        }

        var BATCH = 100;
        var batches = [];
        for (var i = 0; i < miss.length; i += BATCH) batches.push(miss.slice(i, i + BATCH));

        var idx = 0, added = 0;
        function worker() {
          if (idx >= batches.length) return Promise.resolve();
          var b = batches[idx++];
          return Feeds.emQuotes(b.map(function (x) { return x.norm; }), prefix)
            .then(function (got) {
              b.forEach(function (x) {
                var q = got[x.norm];
                if (!q || !(q.price > 0)) return;
                rows.push({
                  code: x.norm, raw: x.code, name: q.name || x.name,
                  price: q.price, prevClose: q.prevClose, open: q.open,
                  high: q.high, low: q.low, pct: q.pct,
                  volume: q.volume, amount: q.amount,
                  turnover: q.turnover, volRatio: q.volRatio,
                  floatCap: q.floatCap, totalCap: q.totalCap,
                  pb: q.pb, mainNet: q.mainNet, pe: null, industry: '',
                  _src: 'em',
                });
                have[x.code] = 1;
                added++;
              });
              if (onProgress && (idx % 4 === 0 || idx >= batches.length)) {
                onProgress({
                  stage: 'prepare', done: Math.min(idx * BATCH, miss.length), total: miss.length,
                  msg: '补全未覆盖标的 ' + Math.min(idx * BATCH, miss.length) + '/' + miss.length,
                });
              }
              return worker();
            }, function () { return worker(); });
        }

        var ws = [];
        for (var w = 0; w < 4; w++) ws.push(worker());
        return Promise.all(ws).then(function () {
          rows._patched = added;
          return rows;
        });
      })
      .catch(function () { return rows; });
  }

  /* 全市场入口：Feeds 内部并行拉东财与新浪，成功几家用几家，并对重叠部分做交叉。
   * 只有全部失败时才退到内置清单 + 腾讯报价（此时无资金流、无量比，页面会标注）。 */
  function getUniverse(onPage, onPatch) {
    return Feeds.universe(prefix, onPage)
      .then(function (rows) {
        rows._liveRatio = liveRatioOf(rows);
        /* 覆盖不足时补全。阈值取 4800：沪深京实际约 5400~5600 只，
         * 低于这个数说明分页确实丢了，而不是市场变小了。 */
        if (rows.length >= 4800) return rows;
        return patchMissing(rows, onPatch).then(function (r2) {
          r2._liveRatio = liveRatioOf(r2);
          return r2;
        });
      })
      .catch(function (e) {
        console.warn('[Screener] 全市场数据源均不可用（' + (e && e.message) + '），退化到内置清单');
        return fallbackUniverse().then(function (rows) {
          rows._src = 'tencent';
          rows._srcList = ['tencent'];
          rows._cross = null;
          rows._failed = [{ src: 'all', err: (e && e.message) || '' }];
          rows._liveRatio = liveRatioOf(rows);
          return rows;
        });
      });
  }

  /* 不复权日线：只用于把「上一交易日真实价与真实成交额」回填进快照。
   * 结构计算必须用后复权，但快照展示与交易计划必须是真实价，
   * 两者一旦混用，止损会算到后复权价上去（详见 buildPlan 的复权映射）。 */
  function fetchBarsRaw(code, period, lmt) {
    var key = 'raw|' + code + '|' + period + '|' + lmt;
    var hit = KLINE_CACHE[key];
    if (hit && now() - hit.t < CFG.KLINE_TTL) return Promise.resolve(hit.bars);
    return Feeds.txBarsRaw(code, period, lmt)
      .then(function (bars) {
        if (bars) KLINE_CACHE[key] = { t: now(), bars: bars };
        return bars;
      })
      .catch(function () { return null; });
  }

  /* 盘前补偿：用日线最后一根（上一交易日）重建量价快照。
   * 浏览器不可能为 5561 只逐个拉日线，因此按流通市值取前 N 只，
   * 覆盖当日活跃主体。这是「可以接受的折中」，不是全市场普查，
   * 页面必须把这个口径写在明处。 */
  function seedFromDaily(rows, limit, onProgress) {
    /* 注意不能把这个数组叫 pool——会遮蔽并发池函数 pool()，调用直接报错 */
    var picks = rows.filter(function (r) {
      return r.price > 0 && r.prevClose > 0 && !isBadName(r.name);
    }).sort(function (a, b) {
      return (b.floatCap || 0) - (a.floatCap || 0);
    }).slice(0, limit || 280);

    var done = 0;
    var total = picks.length;
    var tasks = picks.map(function (row) {
      return function () {
        return fetchBarsRaw(row.code, 'day', 30).then(function (bars) {
          done++;
          if (onProgress && done % 20 === 0) onProgress(done, total);
          if (!bars || bars.length < 6) return null;
          var n = bars.length;
          /* 腾讯日线在盘中就会生成当日这根（未完成）。回填要的是「上一交易日」，
           * 若最后一根就是今天，必须退一根，否则会把今天的半截成交当成昨日全天。 */
          var bi = n - 1;
          if (bi > 0 && String(bars[bi].d).slice(0, 10) === Feeds.session().today) bi = n - 2;
          var base = bars[bi], prev = bars[bi - 1];
          var sum = 0, cnt = 0;
          for (var k = Math.max(0, n - 6); k < n - 1; k++) { sum += bars[k].v || 0; cnt++; }
          var avgV = cnt ? sum / cnt : 0;
          row.price = base.c;
          row.prevClose = prev && prev.c > 0 ? prev.c : base.c;
          row.pct = row.prevClose > 0 ? (base.c - row.prevClose) / row.prevClose * 100 : 0;
          row.amount = base.a > 0 ? base.a : (base.v && base.c ? base.v * base.c / 100 : 0);
          row.volRatio = avgV > 0 && base.v ? base.v / avgV : null;
          /* 换手率：成交额(万元)→亿 除以流通市值(亿) */
          row.turnover = (row.floatCap > 0 && row.amount > 0)
            ? row.amount / 1e4 / row.floatCap * 100 : (base.t || null);
          row.high = base.h; row.low = base.l;
          row.open = base.o;
          row._prevBar = base.d;
          return row;
        }).catch(function () { return null; });
      };
    });

    return pool(tasks, 10).then(function (list) {
      var ok = list.filter(Boolean);
      ok._src = (rows._src || '') + '+daily';
      ok._liveRatio = liveRatioOf(ok);
      return ok;
    });
  }

  function isBadName(name) {
    return /ST|\*ST|退$|退市|PT|^N|^C/.test(String(name || ''));
  }

  /* --------------------- L1：过滤 + 粗筛 --------------------- */
  /* 过滤条件必须随「数据有没有当日成交」自适应。
   * 盘前所有实时源 amount 恒为 0，此时仍按成交额硬卡会得到 0 只，
   * 页面看上去是「今天一只都没有」，其实是根本没有当日数据。 */
  function filterUniverse(rows, opts) {
    opts = opts || {};
    var requireAmount = opts.requireAmount;
    if (requireAmount == null) {
      var lr = rows && rows._liveRatio;
      requireAmount = (lr == null ? 1 : lr) >= 0.3;
    }
    /* 门槛按当日已交易时间折算：开盘 10 分钟只累积了全天约 8% 的成交额，
     * 用全天门槛等于要求它在 10 分钟内成交出 8000 万，绝大多数票过不了。 */
    var prog = opts.progress == null ? 1 : Math.min(1, Math.max(0.05, opts.progress));
    var minAmt = CFG.MIN_AMOUNT * prog;
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.price || r.price <= 0) continue;                  // 停牌/无价
      if (requireAmount && (!(r.amount > 0) || r.amount < minAmt)) continue;
      if (r.floatCap && r.floatCap < CFG.MIN_FLOAT_CAP) continue;
      if (isBadName(r.name)) continue;                          // ST/退市/新股
      if (r.pct != null && r.pct < -6) continue;                // 明显破位不选
      r._minAmt = minAmt;
      out.push(r);
    }
    return out;
  }

  /* 快照打分：不需要K线，只用全市场横向比较。各项先归一化再加权。 */
  function prescreen(rows, opts) {
    if (!rows.length) return [];
    var prog = (opts && opts.progress != null) ? Math.min(1, Math.max(0.05, opts.progress)) : 1;
    var minAmt = CFG.MIN_AMOUNT * prog;
    var arr = rows.slice();
    var by = function (f) { return arr.map(function (r) { return f(r) || 0; }); };
    var rank = function (vals) {
      var idx = vals.map(function (v, i) { return [v, i]; }).sort(function (a, b) { return a[0] - b[0]; });
      var out = new Array(vals.length);
      idx.forEach(function (p, i) { out[p[1]] = vals.length > 1 ? i / (vals.length - 1) : 0.5; });
      return out;
    };

    var rPct = rank(by(function (r) { return r.pct; }));
    var rMain = rank(by(function (r) { return r.mainNet; }));
    var rAmt = rank(by(function (r) { return r.amount; }));

    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      var vr = r.volRatio == null ? 1 : r.volRatio;
      var to = r.turnover == null ? 3 : r.turnover;

      /* 量比：1.2~3 最佳，过低无人气，过高多为出货 */
      var sVol = vr < 0.8 ? 0.15 : vr < 1.2 ? 0.5 : vr <= 3 ? 1 : vr <= 5 ? 0.6 : 0.25;
      /* 换手：3%~15% 为健康活跃区间 */
      var sTurn = to < 1 ? 0.2 : to < 3 ? 0.6 : to <= 15 ? 1 : to <= 25 ? 0.5 : 0.2;
      /* 振幅：3%~9% 有波动可做，过小无空间，过大风险高 */
      var sAmp = r.amp < 1.5 ? 0.2 : r.amp < 3 ? 0.6 : r.amp <= 9 ? 1 : 0.5;
      /* 涨幅：0~7% 为可介入区间，接近涨停降权 */
      var sPct = r.pct <= 0 ? 0.3 : r.pct <= 7 ? 1 : r.pct <= CFG.MAX_RISE ? 0.5 : 0.15;
      /* 主力净流入占成交额比例 */
      var inflow = r.amount > 0 ? r.mainNet / r.amount : 0;
      var sFlow = clamp(0.5 + inflow * 4, 0, 1);

      r._pre = 100 * (
        0.30 * rPct[i] + 0.10 * rMain[i] + 0.08 * rAmt[i] +
        0.14 * sVol + 0.14 * sTurn + 0.10 * sAmp + 0.08 * sPct + 0.06 * sFlow
      );
      r._preDetail = { sVol: sVol, sTurn: sTurn, sAmp: sAmp, sPct: sPct, inflow: inflow };
    }

    arr.sort(function (a, b) { return b._pre - a._pre; });

    /* 候选池分两类，否则入选的全是当日涨幅榜，会系统性偏向追涨：
     *   强势组：量价强度前列，抓突破与加速；
     *   回踩组：当日微涨微跌但缩量、成交额仍充足，抓缩量回踩的优质买点。
     * 真实的好买点往往是后者，只留强势组会把这个来源整个丢掉。 */
    var strongN = Math.round(CFG.POOL * 0.75);
    var strong = arr.slice(0, strongN);
    var taken = {};
    strong.forEach(function (r) { taken[r.code] = 1; });
    var pullback = arr.filter(function (r) {
      if (taken[r.code]) return false;
      var vr = r.volRatio == null ? 1 : r.volRatio;
      return r.pct >= -3.5 && r.pct <= 1.5 && vr < 1.05 && r.amount >= minAmt * 1.5;
    }).slice(0, CFG.POOL - strongN);
    pullback.forEach(function (r) { r._kind = 'pullback'; });
    strong.forEach(function (r) { r._kind = 'strong'; });

    return strong.concat(pullback);
  }

  /* --------------------- K 线获取 --------------------- */
  /* 结构用 K 线：腾讯后复权为主，东财后复权为备。
   * 同花顺那条线是前复权（早期数据会出现负价），只能用来核对最近价格，
   * 绝不能拿来算笔和中枢 —— 混用会让结构整体失真。
   * URL 构造与解析都收敛到 Feeds，这里只管缓存与降级。 */
  function fetchBars(code, period, lmt) {
    var key = code + '|' + period + '|' + lmt;
    var hit = KLINE_CACHE[key];
    if (hit && now() - hit.t < CFG.KLINE_TTL) return Promise.resolve(hit.bars);

    return Feeds.txBars(code, period, lmt)
      .then(function (bars) {
        if (bars && bars.length) { KLINE_CACHE[key] = { t: now(), bars: bars }; return bars; }
        throw new Error('empty');
      })
      .catch(function () {
        return Feeds.emBars(code, period, lmt)
          .then(function (bars) {
            if (bars && bars.length) { KLINE_CACHE[key] = { t: now(), bars: bars }; return bars; }
            return null;
          })
          .catch(function () { return null; });
      });
  }

  /* 并发池：控制同时进行的请求数，避免被行情源限流 */
  function pool(tasks, limit, onEach) {
    var i = 0, done = 0, results = new Array(tasks.length);
    return new Promise(function (resolve) {
      function next() {
        if (i >= tasks.length && done >= tasks.length) return resolve(results);
        while (i < tasks.length && (i - done) < limit) {
          (function (idx) {
            Promise.resolve()
              .then(tasks[idx])
              .then(function (v) { results[idx] = v; })
              .catch(function () { results[idx] = null; })
              .then(function () {
                done++;
                if (onEach) onEach(done, tasks.length, idx);
                next();
              });
          })(i++);
        }
      }
      next();
    });
  }

  /* --------------------- 市场环境统计 --------------------- */
  function envOf(rows) {
    var act = rows.filter(function (r) { return r.price > 0; });
    var up = 0, down = 0, lu = 0, ld = 0, amt = 0;
    act.forEach(function (r) {
      if (r.pct > 0) up++;
      else if (r.pct < 0) down++;
      if (r.pct >= 9.7) lu++;
      if (r.pct <= -9.7) ld++;
      amt += (r.amount || 0);
    });
    return {
      total: act.length, up: up, down: down,
      limitUp: lu, limitDown: ld,
      amountSum: amt,
      upRatio: (up + down) ? up / (up + down) : 0.5,
    };
  }

  /* --------------------- ATR --------------------- */
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

  /* --------------------- 支撑压力聚类 --------------------- */
  function clusterLevels(cands, price, side) {
    var list = cands.filter(function (c) { return c && isFinite(c.price) && c.price > 0; });
    if (side === 'up') list = list.filter(function (c) { return c.price > price * 1.002; });
    else list = list.filter(function (c) { return c.price < price * 0.998; });

    list.sort(function (a, b) { return a.price - b.price; });
    var groups = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var hitG = null;
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
    /* 由近到远排序：支撑从高到低，压力从低到高 */
    groups.sort(function (a, b) { return side === 'up' ? a.price - b.price : b.price - a.price; });
    return groups;
  }

  /* --------------------- 交易计划 --------------------- */
  function buildPlan(ctx) {
    var price = ctx.price, day = ctx.day, week = ctx.week, month = ctx.month, wy = ctx.wyckoff, a = ctx.atr;
    var cands = [];

    function add(p, label, w) {
      if (p == null || !isFinite(p) || p <= 0) return;
      cands.push({ price: p, label: label, weight: w });
    }

    /* 缠论各级别中枢边界：最硬的结构位 */
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
    /* 笔的端点：最近的转折低/高点 */
    if (day && day.pens.length) {
      var pens = day.pens;
      for (var i = pens.length - 1; i >= Math.max(0, pens.length - 4); i--) {
        add(pens[i].low, '日线笔低点', 4);
        add(pens[i].high, '日线笔高点', 4);
      }
    }
    /* 威科夫交易区间边界 */
    if (wy) {
      add(wy.rangeLo, '60日区间下沿', 5);
      add(wy.rangeHi, '60日区间上沿', 5);
      add(wy.priorLo, '20日前低', 3);
      add(wy.priorHi, '20日前高', 3);
    }
    /* 均线动态位：只作为回调支撑，不作为上方压力。
     * 均线是跟随指标，在上涨途中 MA5/MA10 常常就贴在现价上方一点点，
     * 若参与压力位计算，最近压力会变成「明天均线」，盈亏比被系统性压到 0.3 以下，
     * 结果是所有票都不合格。上方压力只能是真实的结构位（中枢/笔高点/区间上沿）。 */
    if (ctx.ma) {
      ctx.ma.forEach(function (m) {
        if (m.value < price) add(m.value, 'MA' + m.n, m.n >= 60 ? 3 : 2);
      });
    }

    var sup = clusterLevels(cands, price, 'down').slice(0, 3);
    var res = clusterLevels(cands, price, 'up').slice(0, 3);

    var s1 = sup[0] ? sup[0].price : price * 0.95;
    var r1 = res[0] ? res[0].price : price * 1.08;

    /* 止损：日线买点低点失效位，其次日线中枢下沿，两者取更近且必须低于买区 */
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

    /* 买入区间：宽度硬性上限 3%。支撑若离现价很远（等回踩型），区间不能跟着
     * 拉成 8%，否则就是一串无法执行的数字。上沿不追过现价 1.5%，也不超过最近压力。 */
    var hi = Math.min(price * 1.015, r1 * 0.995);
    var loRaw = Math.max(stop.p * 1.008, s1 * 1.002);
    if (!(hi > loRaw)) { hi = price * 1.01; loRaw = price * 0.985; }
    var lo = Math.max(loRaw, hi * 0.97);

    var mid = (lo + hi) / 2;

    /* 止损距离用 ATR 归一化。
     * 只看结构位会出两种极端：结构位贴着现价时止损仅 1~2%，一根日内插针就打掉；
     * 结构位很远时止损 -15%，风险敞口过大。这里把距离夹在 [1.1ATR, 12%] 内。 */
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

    /* 目标位同样要夹住。
     * 最近压力可能是几个月前的高点，一路 +29% 的「目标」不是目标，是幻想；
     * 用 6 倍 ATR 与 +15% 双重封顶，宁可能看到的空间小一点，也不给不可执行的价格。 */
    var t1 = r1;
    if (a) t1 = Math.min(t1, mid + a * 6);
    t1 = Math.min(t1, mid * 1.15);
    if (t1 <= mid * 1.01) t1 = mid * 1.01;      // 只防止目标低于成本价

    var t2 = res[1] ? res[1].price : r1 * 1.06;
    if (a) t2 = Math.min(t2, mid + a * 12);
    t2 = Math.min(t2, mid * 1.30);
    if (t2 <= t1 * 1.02) t2 = t1 * 1.02;

    var risk = gap;
    var rr = risk > 0 ? (t1 - mid) / risk : null;
    var rr2 = risk > 0 ? (t2 - mid) / risk : null;

    /* 回踩型：现价高于买入区间上沿（最近压力太近），或最近支撑明显低于现价，
     * 两种情况都说明现价不是买点，要等回到区间里 */
    var waitPullback = (hi < price * 0.998) || (s1 < price * 0.98);

    return {
      supports: sup, resistances: res,
      buyLo: lo, buyHi: hi, buyMid: mid,
      stop: stop.p, stopReason: stop.label,
      target1: t1, target2: t2,
      rr: rr, rr2: rr2,
      riskPct: mid > 0 ? risk / mid * 100 : null,
      atr: a,
      waitPullback: waitPullback,
      targetNote: (t1 >= r1 - 1e-9) ? '目标为最近压力位'
        : '最近压力过远，目标已按 6 倍 ATR / +15% 封顶',
      widthPct: (hi - lo) / mid * 100,
    };
  }

  /* --------------------- L2：单只精算 --------------------- */
  function analyzeOne(row, opts) {
    opts = opts || {};
    var code = row.code;
    return Promise.all([
      fetchBars(code, 'month', 200),
      fetchBars(code, 'week', 320),
      fetchBars(code, 'day', 400),
      fetchBars(code, 'm30', 640),
    ]).then(function (res) {
      var mb = res[0], wb = res[1], db = res[2], m30 = res[3];
      if (!db || db.length < 80) return null;

      /* ---- 复权系数：把后复权价映射回真实可交易价格 ----
       * 结构计算必须用 hfq（前复权在除权日会造假笔假中枢），但用户看到的中枢、
       * 支撑压力、止损位必须是今天的真实价格。两者之间的比例就是复权因子，
       * 对同一只票的所有周期通用（后复权以历史首日为基准，比例唯一）。
       * 基准取「上一交易日收盘」：最后一根是当日未完成K线时用倒数第二根，
       * 否则用最后一根，避免用未完成K线自己除自己。 */
      var scale = 1;
      if (row.prevClose > 0 && db.length >= 2) {
        var lastD0 = db[db.length - 1].d.slice(0, 10);
        var isToday0 = !!(opts.today && lastD0 === opts.today);
        var refBar = isToday0 ? db[db.length - 2] : db[db.length - 1];
        if (refBar && refBar.c > 0) scale = row.prevClose / refBar.c;
        /* 复权因子跨度很大：多次高送转的老股可低到 0.005，部分品种可到数十倍。
           区间设得过窄会把合法因子当异常丢掉，这里只拦真正的脏数据。 */
        if (!(scale > 1e-4 && scale < 1e4)) scale = 1;
      }
      function rescale(arr) {
        if (!arr || scale === 1) return arr;
        return arr.map(function (b) {
          return { d: b.d, o: b.o * scale, h: b.h * scale, l: b.l * scale, c: b.c * scale, v: b.v };
        });
      }
      /* 重要：30 分钟线走的接口本来就不复权（腾讯 mkline 无 fqt 参数），
       * 它返回的已经是真实价。若再乘一次复权因子，价格会被压缩成几分之一，
       * 30F 的中枢与回踩判定全部失真——这里必须排除。 */
      db = rescale(db); wb = rescale(wb); mb = rescale(mb);
      m30 = m30 || [];

      /* 价格口径分三态，不能只分「盘中/盘前」：
       *   pre  盘前/休市   当日无成交，快照是上一交易日收盘，不拼接任何K线
       *   live 盘中        当日K线未完成，用实时价覆盖末根并标记 partial
       *   post 已收盘      快照即当日收盘价，拼出的当日K线是完整K线，partial=false
       * 之前把 post 当 live 处理，页面会把收盘价标成「盘中实时」，
       * 而 partial=true 还会让威科夫对「未完成K线」降权，等于收盘后自己骗自己。 */
      var partial = false, progress = 1;
      var mode = opts.basis || (opts.today ? 'live' : 'pre');
      if (opts.live && opts.live.price && opts.live.prevClose) {
        progress = opts.progress == null ? 1 : opts.progress;
        var today = opts.today || '';
        if (mode === 'pre' || !today) {
          partial = false;
        } else {
          var lastD = db[db.length - 1].d.slice(0, 10);
          var lb0 = opts.live;
          if (lastD !== today) {
            /* 日线还没生成今日这根：补一根。盘后补的是完整K线。 */
            db = db.concat([{
              d: today,
              o: lb0.open || lb0.prevClose,
              h: lb0.high || lb0.price,
              l: lb0.low || lb0.price,
              c: lb0.price,
              v: 0,
            }]);
          } else {
            /* 已经有今日这根（腾讯盘中就会生成）：用最新价与最高最低刷新它 */
            var lb = db[db.length - 1];
            lb.c = lb0.price;
            if (lb0.high) lb.h = Math.max(lb.h, lb0.high);
            if (lb0.low) lb.l = Math.min(lb.l, lb0.low);
          }
          partial = (mode === 'live');
        }
      }

      var day = Chan.structure(db);
      var week = Chan.structure(wb || []);
      var month = Chan.structure(mb || []);
      if (!day) return null;

      var wy = Wyckoff.analyze(db, { partial: partial, progress: progress });

      /* 均线 */
      var ma = [];
      [5, 10, 20, 60].forEach(function (n) {
        if (db.length >= n) {
          var s = 0;
          for (var i = db.length - n; i < db.length; i++) s += db[i].c;
          ma.push({ n: n, value: s / n });
        }
      });

      var price = row.price || db[db.length - 1].c;
      var a = atr(db, 14);
      var plan = buildPlan({ price: price, day: day, week: week, month: month, wyckoff: wy, atr: a, ma: ma });
      var m30st = (m30 && m30.length >= 40) ? Chan.structure(m30) : null;

      return {
        code: code, name: row.name, industry: row.industry || '',
        price: price, pct: row.pct, prevClose: row.prevClose,
        amount: row.amount, turnover: row.turnover, volRatio: wy ? wy.volRatio : row.volRatio,
        mainNet: row.mainNet, floatCap: row.floatCap, totalCap: row.totalCap,
        month: month, week: week, day: day, m30: m30st,
        wyckoff: wy, ma: ma, plan: plan, partial: partial,
        atr: a,
        _bars: db,      // 原始日线（正序，含盘中未完成K线），供动量和回测使用
      };
    });
  }

  /* --------------------- L3：多因子打分 --------------------- */
  function scoreOf(it) {
    var m = it.month, w = it.week, d = it.day, wy = it.wyckoff, p = it.plan;
    var detail = [];

    /* 1. 结构分（40）：四级联立 */
    var s = 0;
    if (m) {
      if (m.dir > 0) { s += 12; detail.push({ k: '月线', v: '+12', t: '月线笔向上，大级别方向不逆势' }); }
      else if (m.position === 'inside') { s += 5; detail.push({ k: '月线', v: '+5', t: '月线中枢内震荡，方向中性' }); }
      else { s -= 4; detail.push({ k: '月线', v: '-4', t: '月线位于中枢下方且笔向下，逆势风险' }); }
      if (m.buy && m.buy.grade) { s += 3; detail.push({ k: '月线', v: '+3', t: '月线出现 ' + m.buy.type + ' 买点' }); }
    }
    if (w) {
      if (w.dir > 0) { s += 10; detail.push({ k: '周线', v: '+10', t: '周线笔向上，中级趋势配合' }); }
      else if (w.position === 'inside') { s += 3; detail.push({ k: '周线', v: '+3', t: '周线中枢内震荡' }); }
      else { s -= 3; detail.push({ k: '周线', v: '-3', t: '周线向下且在中枢下方' }); }
      if (w.buy && w.buy.grade >= 2) { s += 4; detail.push({ k: '周线', v: '+4', t: '周线 ' + w.buy.type + ' 买点成立' }); }
    }
    if (d) {
      var g = d.buy && d.buy.grade ? d.buy.grade : 0;
      if (g === 3) { s += 15; detail.push({ k: '日线', v: '+15', t: '日线三买：回调不进中枢，结构最健康' }); }
      else if (g === 2) { s += 11; detail.push({ k: '日线', v: '+11', t: '日线二买：不破前低' }); }
      else if (g === 1) { s += 5; detail.push({ k: '日线', v: '+5', t: '日线一买：背驰反弹，需次级别确认' }); }
      else if (d.buy && d.buy.running) { s += 3; detail.push({ k: '日线', v: '+3', t: '日线笔向上运行中，等回调不破' }); }
      else { s -= 3; detail.push({ k: '日线', v: '-3', t: '日线无买点，结构走弱' }); }

      if (d.position === 'above') { s += 4; detail.push({ k: '日线', v: '+4', t: '价格站上日线中枢上沿，强势区' }); }
      if (d.diverg && d.diverg.type === 'top') { s -= 5; detail.push({ k: '日线', v: '-5', t: '日线顶背驰，上攻动能衰竭' }); }
    }
    var structure = clamp(s, 0, 40);
    detail.push({ k: '结构合计', v: structure + '/40', t: '月→周→日 三级结构联立得分' });

    /* 2. 量价分（25） */
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
    }
    var volume = clamp(v, 0, 25);

    /* 3. 动量分（20）：相对 20/60 日涨幅，由 attachMomentum 预先算好 */
    var mom = 10, m20 = it._chg20, m60 = it._chg60;
    if (m20 != null) {
      mom += clamp(m20 / 2, -6, 6);
      detail.push({ k: '动量', v: (m20 >= 0 ? '+' : '') + (m20 / 2).toFixed(1), t: '近20日涨幅 ' + m20.toFixed(1) + '%' });
    }
    if (m60 != null) {
      mom += clamp(m60 / 4, -4, 4);
      detail.push({ k: '动量', v: (m60 >= 0 ? '+' : '') + (m60 / 4).toFixed(1), t: '近60日涨幅 ' + m60.toFixed(1) + '%' });
    }
    var momentum = clamp(mom, 0, 20);

    /* 4. 资金分（15） */
    var fund = 7.5;
    if (it.mainNet != null && it.amount) {
      var ratio = it.mainNet / it.amount;
      fund += clamp(ratio * 30, -7.5, 7.5);
      detail.push({ k: '资金', v: (ratio >= 0 ? '+' : '') + (clamp(ratio * 30, -7.5, 7.5)).toFixed(1), t: '主力净流入占成交额 ' + (ratio * 100).toFixed(1) + '%' });
    } else {
      detail.push({ k: '资金', v: '±0', t: '无主力资金数据，按中位计' });
    }
    var money = clamp(fund, 0, 15);

    /* 5. 风险分（12 起，盈亏比优良可加到 15，风险项逐条扣） */
    var risk = 12;
    if (p.riskPct != null) {
      if (p.riskPct > 8) { risk -= 6; detail.push({ k: '风险', v: '-6', t: '止损距离 ' + p.riskPct.toFixed(1) + '%，单笔风险过大' }); }
      else if (p.riskPct > 5) { risk -= 3; detail.push({ k: '风险', v: '-3', t: '止损距离 ' + p.riskPct.toFixed(1) + '%，偏高' }); }
      else { detail.push({ k: '风险', v: '0', t: '止损距离 ' + p.riskPct.toFixed(1) + '%，可控' }); }
    }
    if (it.atr != null && it.price) {
      var atrPct = it.atr / it.price * 100;
      if (atrPct > 6) { risk -= 4; detail.push({ k: '风险', v: '-4', t: '日均波动 ' + atrPct.toFixed(1) + '%，波动过大' }); }
    }
    if (it.pct != null && it.pct > CFG.MAX_RISE) { risk -= 3; detail.push({ k: '风险', v: '-3', t: '当日涨幅 ' + it.pct.toFixed(1) + '%，追高风险' }); }
    if (it.pct != null && it.pct > 0 && it.pct >= (it.code.indexOf('sz30') === 0 || it.code.indexOf('sh688') === 0 ? CFG.LIMIT_UP_GEM : CFG.LIMIT_UP_MAIN)) {
      risk -= 5; detail.push({ k: '风险', v: '-5', t: '已涨停，次日不可控且大概率买不进' });
    }
    /* 盈亏比：买区贴着压力时，结构再好也没有可赚空间 */
    if (p.rr != null) {
      if (p.rr >= 2) { risk += 3; detail.push({ k: '盈亏比', v: '+3', t: '盈亏比 ' + p.rr.toFixed(2) + '，赔率优良' }); }
      else if (p.rr >= 1.5) { risk += 1; detail.push({ k: '盈亏比', v: '+1', t: '盈亏比 ' + p.rr.toFixed(2) + '，可接受' }); }
      else if (p.rr < 0.9) { risk -= 8; detail.push({ k: '盈亏比', v: '-8', t: '盈亏比仅 ' + p.rr.toFixed(2) + '，买区已贴压力，无交易价值' }); }
      else if (p.rr < 1.2) { risk -= 4; detail.push({ k: '盈亏比', v: '-4', t: '盈亏比 ' + p.rr.toFixed(2) + '，空间不足' }); }
      else { detail.push({ k: '盈亏比', v: '0', t: '盈亏比 ' + p.rr.toFixed(2) }); }
    }
    risk = clamp(risk, 0, 15);

    var total = Math.round(structure + volume + momentum + money + risk);

    /* 等级：按四级联立的实际满足数 */
    var lv = 0;
    if (m && m.dir > 0) lv++;
    if (w && w.dir > 0) lv++;
    if (d && d.buy && d.buy.grade >= 2) lv++;
    if (d && d.position === 'above') lv++; else if (d && d.buy && d.buy.grade >= 3) lv++;
    var grade = lv >= 4 ? 'A' : lv === 3 ? 'B' : lv === 2 ? 'C' : 'D';
    var gradeText = { A: '四级共振', B: '三级配合', C: '两级确认', D: '结构不足' }[grade];

    return {
      total: total, structure: structure, volume: volume, momentum: momentum,
      money: money, risk: risk, detail: detail, grade: grade, gradeText: gradeText, levelHit: lv,
    };
  }

  /* 资金流与量比回填。
   * 工作集主要来自新浪，而新浪列表接口不带主力净流入；腾讯批量接口也没有。
   * 缺这一项时打分里的资金分（15 分）恒为 7.5，等于整项权重白给。
   * 东财 ulist 支持按代码点名批量取，60 只只要 1 个请求，顺手把量比、
   * 换手补齐。注意：只补缺失项，不覆盖已有值，避免多源打架。 */
  function applyFlow(rows, emq) {
    if (!emq) return 0;
    var n = 0;
    rows.forEach(function (r) {
      var q = emq[r.code];
      if (!q) return;
      var hit = false;
      if (r.mainNet == null) { r.mainNet = q.mainNet; hit = true; }
      if (r.volRatio == null) { r.volRatio = q.volRatio; hit = true; }
      if (r.turnover == null) { r.turnover = q.turnover; hit = true; }
      if (hit) n++;
    });
    return n;
  }

  /* 候选级交叉校验：工作集之外再拉腾讯与东财两条线，逐只比对价格。
   * 60 只只需 2~3 个请求（两家都支持批量），成本极低但价值很高：
   * 只要有一家的报价对不上，就说明这批数据不能直接拿去下单。
   * emP 可传入已取好的东财报价 Promise，避免和资金回填重复请求一次。 */
  function crossCandidates(cand, emP) {
    if (!cand || !cand.length) return Promise.resolve(null);
    var codes = cand.map(function (r) { return r.code; });
    var t1 = now();
    var pEm = emP || Feeds.emQuotes(codes, prefix).catch(function () { return {}; });
    return Promise.all([
      Feeds.txQuotes(codes, 3).catch(function () { return {}; }),
      pEm.catch(function () { return {}; }),
    ]).then(function (res) {
      var tx = res[0] || {}, em = res[1] || {};
      var byCode = {}, agg = { txN: 0, txOk: 0, emN: 0, emOk: 0, worst: [] };

      cand.forEach(function (r) {
        var ref = { code: r.code, price: r.price, _t: null };
        var a = tx[r.code] ? Feeds.crossQuote(ref, tx[r.code]) : null;
        /* 若这只票的价格本身就是东财补全来的，再用东财校验等于自己跟自己比，
         * 会得到 100% 一致的假结论。这种情况明确标出来，不算校验通过。 */
        var b = (r._src === 'em')
          ? { state: 'na', dev: null, tol: null, note: '价格来自东财，跳过以免自证' }
          : (em[r.code] ? Feeds.crossQuote(ref, em[r.code]) : null);
        /* 把腾讯的时间戳带出去。工作集快照本身没有精确时刻，
         * 拿不到 ref 时间去算容差；腾讯这条有，可以让入榜层的同花顺复核
         * 按真实时间差放大容差，而不是死守 0.35% 误报。 */
        byCode[r.code] = { tx: a, em: b, txT: (tx[r.code] && tx[r.code]._t) || null };

        if (a && a.dev != null) {
          agg.txN++;
          if (a.state === 'ok') agg.txOk++;
          if (a.dev > 0.8) agg.worst.push({ code: r.code, name: r.name, src: '腾讯', dev: a.dev });
        }
        if (b && b.dev != null) {
          agg.emN++;
          if (b.state === 'ok') agg.emOk++;
          if (b.dev > 0.8) agg.worst.push({ code: r.code, name: r.name, src: '东财', dev: b.dev });
        }
      });

      agg.worst.sort(function (a, b) { return b.dev - a.dev; });
      agg.worst = agg.worst.slice(0, 6);
      agg.ms = now() - t1;
      agg.reliable = (agg.txN + agg.emN) === 0 ? null
        : ((agg.txOk + agg.emOk) / (agg.txN + agg.emN)) >= 0.9;
      return { byCode: byCode, agg: agg };
    }).catch(function () { return null; });
  }

  /* --------------------- 主流程 --------------------- */
  function run(opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var poolSize = opts.pool || CFG.POOL;
    var topN = opts.top || CFG.TOP;
    var t0 = now();
    var sess = Feeds.session();

    /* 每次选股都取新快照。全市场列表与报价必须反映当下，
     * 缓存只对同一轮内的 K 线复用有意义（回测与精算会重复要同一只票）。 */
    Feeds.clearCache();

    return getUniverse(
      function (done, total) {
        onProgress({
          stage: 'universe', done: done, total: total,
          msg: '全市场快照同步 ' + done + '/' + total + ' 页',
        });
      },
      onProgress
    ).then(function (all) {
      var liveRatio = all._liveRatio || 0;
      var src = all._src || '';
      /* 三态口径。只看「有没有当日成交」无法区分盘前与盘后：
       * 收盘后成交额依然是满的，但那时快照价就是收盘价，不该标成「盘中实时」。 */
      var basis = liveRatio < 0.3 ? 'pre' : (sess.state === 'post' ? 'post' : 'live');
      var basisText = basis === 'live' ? '盘中实时' : (basis === 'post' ? '当日收盘' : '上一交易日');
      var crossText = (all._srcList && all._srcList.length > 1)
        ? '，' + all._srcList.join('+') : '';

      onProgress({
        stage: 'universe', done: 1, total: 1,
        msg: '全市场 ' + all.length + ' 只（' + (SRC_TEXT[src] || src) + crossText + '｜' + basisText + '）',
      });

      /* 东财 clist 经常只回 100 条，两源交集太小，一致率只能代表那 100 只。
       * 这里补一次按代码点名的抽样核对（东财 ulist，不再受分页限制），
       * 把全市场层的样本量拉到 150 只以上，结论才有说服力。 */
      var pSample = (!all._cross || all._cross.common < 500)
        ? Feeds.sampleCross(all, prefix, 150).catch(function () { return null; })
        : Promise.resolve(null);

      var prepared;
      if (basis === 'pre') {
        /* 盘前/休市：实时快照里没有当日成交额，量价粗筛无从判断。
         * 用大市值标的的最后一根日线重建「上一交易日快照」，让选股仍有依据。 */
        prepared = seedFromDaily(all, 420, function (done, total) {
          onProgress({
            stage: 'prepare', done: done, total: total,
            msg: '重建上一交易日量价快照 ' + done + '/' + total,
          });
        }).then(function (seeded) {
          return (seeded && seeded.length >= 40) ? seeded : all;
        }).catch(function () { return all; });
      } else {
        prepared = Promise.resolve(all);
      }

      return prepared.then(function (snap) {
        /* 口径只看原始快照：回填之后 liveRatio 会被填到 100%，
         * 但那批数字是上一交易日的，不能因此标成「盘中实时」。 */
        var snapBasis = basis;
        var hasAmount = (snap._liveRatio || 0) >= 0.3;
        /* 盘前/盘后用全天口径，盘中按当前时点折算 */
        var progress = opts.progress == null
          ? (basis === 'live' ? sess.progress : 1)
          : opts.progress;

        /* 成交额门槛必须随交易进度缩放。
         * 刚开盘 5 分钟时，全市场成交额普遍不到 8000 万，硬卡这个数会把
         * 99% 的票直接筛掉，表现就是「开盘后候选只剩十几只」。 */
        var mopts = { requireAmount: hasAmount, progress: progress };
        var filtered = filterUniverse(snap, mopts);
        if (!filtered.length && snap !== all) {
          /* 重建快照仍筛不出东西：退回宽松口径，至少让精算有标的可跑 */
          filtered = filterUniverse(snap, { requireAmount: false, progress: progress });
        }
        var cand = prescreen(filtered, mopts).slice(0, poolSize);
        onProgress({
          stage: 'prescreen', done: 1, total: 1,
          msg: '静态过滤后 ' + filtered.length + ' 只，量价粗筛保留 ' + cand.length + ' 只',
        });

        /* 资金流回填必须早于打分，否则资金分只能按中位计入。
         * 一个共享 Promise，首个精算任务等它落地，后续任务直接复用结果。 */
        var flowP = (cand.length
          ? Feeds.emQuotes(cand.map(function (r) { return r.code; }), prefix)
          : Promise.resolve({}))
          .then(function (emq) {
            var n = applyFlow(cand, emq);
            onProgress({
              stage: 'prescreen', done: 1, total: 1,
              msg: '主力资金回填 ' + n + '/' + cand.length + ' 只' + (n ? '（东财）' : '（无可用源）'),
            });
            return emq;
          })
          .catch(function () { return {}; });

        /* 只有确认「当日已有真实成交」时才允许把实时价拼进K线。
         * 盘前 basis=pre，此时实时价就是昨收，拼上去等于在历史序列末尾
         * 复制一根前一日收盘价，会污染分型与笔的判定。 */
        var today = (snapBasis === 'live' || snapBasis === 'post') ? (opts.today || sess.today) : '';

        var tasks = cand.map(function (row) {
          return function () {
            return flowP
              .then(function () {
                return analyzeOne(row, {
                  live: row, today: today, basis: snapBasis, progress: progress,
                });
              })
              .catch(function () { return null; });
          };
        });

        var t1 = now();
        return pool(tasks, CFG.CONCURRENCY, function (done, total) {
          onProgress({ stage: 'analyze', done: done, total: total, msg: '多周期结构精算 ' + done + '/' + total });
        }).then(function (list) {
          var valid = list.filter(Boolean);
          valid.forEach(attachMomentum);
          valid.forEach(function (it) { it.score = scoreOf(it); });
          valid.sort(function (a, b) { return b.score.total - a.score.total; });

          /* 入榜分两组，而不是硬凑一个榜单：
           *   可买：分数达标 + 盈亏比 >= 1.2 + 日线结构未破坏，可直接按计划执行；
           *   观察：结构尚可但赔率或门槛不足，只跟踪不建仓。
           * 一只都不达标时宁可出观察名单并明确提示，也不硬凑满 10 只。 */
          var qualified = valid.filter(function (it) {
            var goodRR = it.plan.rr != null && it.plan.rr >= 1.2;
            var dayOK = !(it.day.buy && it.day.buy.type === 'none' && !it.day.buy.running);
            return it.score.total >= CFG.MIN_SCORE && goodRR && dayOK && it.score.levelHit >= 2;
          }).slice(0, topN);

          var pickedCodes = {};
          qualified.forEach(function (it) { pickedCodes[it.code] = 1; });
          var watch = valid.filter(function (it) {
            return !pickedCodes[it.code] && it.score.levelHit >= 1 && it.score.total >= CFG.MIN_SCORE - 12;
          }).slice(0, 6);

          /* ---------------- 交叉校验 ----------------
           * 第一层：候选池 60 只，腾讯 + 东财两条线逐只比价；
           * 第二层：入榜的几只用同花顺再核一次（带精确时间戳，可算时间差容差）。
           * 校验失败不影响出榜，但必须在页面上标出来——数据不对的时候，
           * 再漂亮的分数也不能用。 */
          onProgress({ stage: 'verify', done: 0, total: 2, msg: '多源交叉校验中' });
          return crossCandidates(cand, flowP).then(function (poolCross) {
            if (poolCross) {
              valid.forEach(function (it) {
                var v = poolCross.byCode[it.code] || null;
                it.verify = v;
                /* 同花顺带精确时间戳，ref 这边若也有时刻，容差就能按
                 * 两家快照的实际时间差放大，避免把「时刻差」误判成「数据错」。 */
                if (v && v.txT) it._t = v.txT;
              });
            }
            var top = qualified.slice(0, 10);
            onProgress({ stage: 'verify', done: 1, total: 2, msg: '入榜标的第三方复核（同花顺）' });
            return Feeds.verifyBatch(top, { conc: 4 }).then(function (thsVer) {
              top.forEach(function (it) {
                it.verify = it.verify || {};
                it.verify.ths = thsVer[it.code] || null;
              });

              var thsOk = 0, thsN = 0;
              top.forEach(function (it) {
                var v = it.verify && it.verify.ths;
                if (v && v.dev != null) { thsN++; if (v.state === 'ok') thsOk++; }
              });

              return pSample.then(function (sample) {
                onProgress({
                  stage: 'done', done: 1, total: 1,
                  msg: '完成：精算 ' + valid.length + ' 只，可买 ' + qualified.length +
                    ' 只 / 观察 ' + watch.length + ' 只，耗时 ' + ((now() - t0) / 1000).toFixed(1) + 's',
                });

                return {
                  picked: qualified, watch: watch, all: valid,
                  universe: all.length, filtered: filtered.length,
                  pool: cand.length, elapsed: now() - t0, analyzeMs: now() - t1,
                  ts: now(),
                  env: envOf(snap.length >= 100 ? snap : all),
                  envBasis: snapBasis,
                  envSample: (snap.length >= 100 ? snap : all).length,
                  seedN: snap === all ? 0 : snap.length,
                  /* 口径必须回传给页面：数据基准是盘中实时、当日收盘还是上一交易日，
                   * 三者对交易的含义完全不同。 */
                  basis: snapBasis,
                  sessionLabel: sess.label,
                  src: snap._src || src,
                  srcList: all._srcList || [snap._src || src],
                  srcFailed: all._failed || [],
                  prevBar: snap[0] && snap[0]._prevBar || null,
                  /* 校验结果分三层，每层都留证据，页面才能说清「凭什么信这批数字」：
                   *   universe 两源全域交叉（东财 clist 全量时）
                   *   sample   东财按代码抽查（clist 被截断时的补强）
                   *   pool     候选 60 只，腾讯 + 东财逐只比价
                   *   ths      入榜标的，同花顺带时间戳复核 */
                  cross: {
                    universe: all._cross || null,
                    sample: sample || null,
                    pool: poolCross ? poolCross.agg : null,
                    ths: { n: thsN, ok: thsOk, rate: thsN ? thsOk / thsN : null },
                  },
                  feeds: Feeds.status(),
                };
              });
            });
          });
        });          /* pool(...).then */
      });            /* prepared.then */
    });              /* getUniverse().then */
  }

  function attachMomentum(it) {
    var bars = it._bars;
    if (!bars || bars.length < 61) return;
    var n = bars.length, last = bars[n - 1].c;
    it._chg20 = (last - bars[n - 21].c) / bars[n - 21].c * 100;
    it._chg60 = (last - bars[n - 61].c) / bars[n - 61].c * 100;
  }

  var api = {
    CFG: CFG, run: run, getUniverse: getUniverse, filterUniverse: filterUniverse,
    prescreen: prescreen, analyzeOne: analyzeOne, scoreOf: scoreOf,
    fetchBars: fetchBars, fetchBarsRaw: fetchBarsRaw, buildPlan: buildPlan,
    prefix: prefix, pool: pool, seedFromDaily: seedFromDaily, liveRatioOf: liveRatioOf,
    crossCandidates: crossCandidates,
    clearCache: function () { KLINE_CACHE = {}; Feeds.clearCache(); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
