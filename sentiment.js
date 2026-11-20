/* ==========================================================================
 * sentiment.js —— 首页「市场情绪看板」
 *
 * 对标的是「涨停/跌停家数 + 连板高度 + 封板质量 + 赚钱效应」这一套打板情绪框架，
 * 而不是再复述一遍指数涨跌。页面所有数字都是现算的，没有预置快照。
 *
 * 数据源（2026-11-20 本机逐条实测可直连、浏览器 CORS 放行）：
 *   1) 涨停池 / 跌停池 / 炸板池
 *      https://push2ex.eastmoney.com/getTopicZTPool|DTPool|ZBPool
 *      —— tc=当日家数，pool 里带 lbc(连板数)、fbt(首次封板时间)、zbc(炸板次数)、
 *         hybk(所属行业)、fund(封板资金)、zttj{days,ct}(几天几板)
 *      —— date=YYYYMMDD 支持回补历史，实测可回溯约 20 个交易日（再往前返回空）
 *   2) 腾讯行情 qt.gtimg.cn —— 昨日涨停股今日涨幅（算「昨日涨停溢价」）
 *   3) 东财 push2 ulist —— 涨跌家数（由 app.js 的 Live.build 算好，通过 feed() 传进来）
 *
 * 口径说明（写在页面上，避免看完不知道数字怎么来的）：
 *   情绪温度 = 市场宽度30 + 涨跌停结构25 + 连板高度15 + 封板质量15 + 量能15
 *   中性锚定：涨跌各半、涨停比跌停多 10 家、最高 4 板、炸板率 30%、成交 1.2 万亿 ≈ 50 分
 *
 * 所有请求失败都只降级、不抛错：拿不到涨停池就只显示宽度与量能，并明确标注缺哪块。
 * ========================================================================== */
(function (global) {
  'use strict';

  var EM_POOL = 'https://push2ex.eastmoney.com';
  var EM_UT = '7eea3edcaed734bea9cbfc24409ed989';
  var HKEY = 'radar_sent_hist_v3';   // 历史日度缓存：{ 'YYYYMMDD': {zt,dt,zb,lb} }
  var TKEY = 'radar_sent_ts_v3';     // 当日缓存时间戳，避免反复打接口
  var BKEY = 'radar_sent_board_v1';  // 东财行业板块全量表：{t:时间戳, m:{板块名:[代码, 涨跌幅]}}
  var BOARD_TTL = 300000;            // 板块行情缓存 5 分钟（板块涨跌幅按分钟级更新，够用）
  var BACKFILL = 20;                 // 回补多少个交易日（东财实测约 20 日可取）
  var QUIET_MS = 45000;              // 交易时段内两次拉取的间隔下限

  var state = {
    br: null,            // {up,down,flat,total} 涨跌家数
    idxRows: [],
    zt: null,            // 涨停池 {tc,list}
    dt: null,            // 跌停池
    zb: null,            // 炸板池
    yzt: null,           // 昨日涨停池（用于溢价/晋级）
    prem: null,          // {avg, n, up, down, promote, base}
    boards: null,        // 东财行业板块全量：{板块名: [代码, 涨跌幅]}
    boardsTs: 0,
    hist: {},            // 日度历史
    loaded: false,
    err: '',
    ts: 0,
    busy: false
  };

  /* ------------------------------ 工具 ------------------------------ */
  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  var ymdOf = function (d) { return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()); };
  var num = function (v, d) { var n = Number(v); return isFinite(n) ? n : (d === undefined ? 0 : d); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var esc = function (s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var pctTxt = function (v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + Number(v).toFixed(d === undefined ? 2 : d) + '%';
  };
  var yi = function (wan) {
    if (wan === null || wan === undefined || !isFinite(wan) || wan <= 0) return null;
    var y = wan / 10000;
    return y >= 10000 ? (y / 10000).toFixed(2) + ' 万亿' : y.toFixed(0) + ' 亿';
  };
  var hhmm = function (v) {
    var s = String(v || '');
    if (!/^\d{5,6}$/.test(s)) return '—';
    if (s.length === 5) s = '0' + s;
    return s.slice(0, 2) + ':' + s.slice(2, 4);
  };

  function getJson(url, ms) {
    var c = new AbortController();
    var t = setTimeout(function () { c.abort(); }, ms || 10000);
    return fetch(url, { cache: 'no-store', signal: c.signal }).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function (e) { clearTimeout(t); throw e; });
  }

  /* --------------------------- 涨跌停池抓取 --------------------------- */
  /* kind: zt 涨停 / dt 跌停 / zb 炸板
   * size=1 + sort=lbc:desc 是回补历史时用的轻量参数（单条约 400 字节） */
  function fetchPool(kind, date, size, sort) {
    var api = kind === 'zt' ? '/getTopicZTPool' : kind === 'dt' ? '/getTopicDTPool' : '/getTopicZBPool';
    var url = EM_POOL + api + '?ut=' + EM_UT + '&dpt=wz.ztzt&Pageindex=0&pagesize=' + (size || 200)
      + '&sort=' + encodeURIComponent(sort || 'fbt:asc') + '&date=' + date;
    return getJson(url, 11000).then(function (j) {
      var d = (j && j.data) || null;
      if (!d) return null;
      return { tc: num(d.tc, 0), list: d.pool || [] };
    });
  }

  /* 由今天往前数 n 个「工作日」（节假日接口会返回空，渲染时自动跳过） */
  function recentDays(n) {
    var out = [], d = new Date();
    while (out.length < n) {
      var w = d.getDay();
      if (w !== 0 && w !== 6) out.push(ymdOf(d));
      d.setDate(d.getDate() - 1);
    }
    return out;
  }

  /* ------------------------------ 历史缓存 ------------------------------ */
  function loadHist() {
    var raw = null;
    try { raw = localStorage.getItem(HKEY); } catch (e) { return {}; }
    try { var o = JSON.parse(raw || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
  }
  function saveHist(h) {
    try {
      var keys = Object.keys(h).sort();
      /* 只留最近 40 天，避免 localStorage 无限膨胀 */
      while (keys.length > 40) { delete h[keys.shift()]; }
      localStorage.setItem(HKEY, JSON.stringify(h));
    } catch (e) { /* 隐私模式写不进去就算了，不影响本次渲染 */ }
  }

  /* ---------------------------- 抓取主流程 ---------------------------- */
  function loadAll(force) {
    var now = Date.now();
    if (state.busy && !force) return Promise.resolve();
    if (!force && state.ts && now - state.ts < QUIET_MS) return Promise.resolve();
    state.busy = true;
    state.ts = now;

    var today = ymdOf(new Date());
    state.hist = loadHist();
    /* 今天的数据以实时池为准，历史缓存只覆盖已过去的交易日 */

    var jobs = [
      fetchPool('zt', today, 200, 'fbt:asc').then(function (r) { state.zt = r; }).catch(function () { state.zt = null; }),
      fetchPool('dt', today, 100, 'fund:asc').then(function (r) { state.dt = r; }).catch(function () { state.dt = null; }),
      fetchPool('zb', today, 100, 'fbt:asc').then(function (r) { state.zb = r; }).catch(function () { state.zb = null; }),
      /* 板块行情与涨停池并行拉，画「板块赚钱效应」时才有涨跌幅可用 */
      loadBoards(force)
    ];

    return Promise.all(jobs).then(function () {
      /* 今日结果写回历史缓存（涨停数/最高连板/跌停数/炸板数），跨设备共享不了但当日够用 */
      if (state.zt || state.dt || state.zb) {
        state.hist[today] = {
          zt: state.zt ? state.zt.tc : null,
          dt: state.dt ? state.dt.tc : null,
          zb: state.zb ? state.zb.tc : null,
          lb: maxBoard(state.zt)
        };
        saveHist(state.hist);
      }
      state.loaded = true;
      render();
      /* 溢价与历史回补都比较重，放到第二帧，先把主结构画出来 */
      return Promise.all([loadPremium(), backfill()]);
    }).then(function () {
      state.busy = false;
      render();
    }).catch(function (e) {
      state.busy = false;
      state.err = (e && e.message) || '情绪数据获取失败';
      render();
    });
  }

  function maxBoard(pool) {
    if (!pool || !pool.list || !pool.list.length) return null;
    var m = 1;
    pool.list.forEach(function (x) { var v = num(x.lbc, 1); if (v > m) m = v; });
    return m;
  }

  /* -------------------- 行业板块全量行情（板块赚钱效应用） --------------------
   * 为什么不直接用首页的 SECTORS：那是首页板块页签自己的那几十个行业 + 概念，
   * 覆盖不到涨停池里出现的全部申万行业，一半行只能显示「—」。
   *
   * 这里拉东财行业板块全量（fs=m:90+t:2，实测共 496 个），翻 5 页取完：
   *   https://push2.eastmoney.com/api/qt/clist/get?...&fields=f12,f14,f3
   * 结果按「板块名 → [代码, 涨跌幅]」缓存 5 分钟，接口挂了就退回上一次的旧数据。 */
  function loadBoards(force) {
    var now = Date.now();
    if (!force && state.boards && now - state.boardsTs < BOARD_TTL) return Promise.resolve(state.boards);
    var stale = null;
    try { stale = JSON.parse(localStorage.getItem(BKEY) || 'null'); } catch (e) { stale = null; }
    if (!force && stale && stale.m && now - stale.t < BOARD_TTL) {
      state.boards = stale.m; state.boardsTs = stale.t;
      return Promise.resolve(stale.m);
    }
    var lanes = [];
    for (var pn = 1; pn <= 5; pn++) {
      var q = 'pn=' + pn + '&pz=100&po=1&np=1&fltt=2&invt=2'
        + '&fs=' + encodeURIComponent('m:90+t:2') + '&fields=f12,f14,f3';
      lanes.push(
        fetch('https://push2.eastmoney.com/api/qt/clist/get?' + q, { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; })
      );
    }
    return Promise.all(lanes).then(function (arr) {
      var m = {};
      arr.forEach(function (j) {
        var diff = (j && j.data && j.data.diff) || [];
        diff.forEach(function (x) { if (x && x.f14) m[x.f14] = [x.f12, num(x.f3, null)]; });
      });
      if (!Object.keys(m).length) throw new Error('板块行情为空');
      state.boards = m; state.boardsTs = now;
      try { localStorage.setItem(BKEY, JSON.stringify({ t: now, m: m })); } catch (e) { /* 存不下就算了 */ }
      return m;
    }).catch(function () {
      if (stale && stale.m) { state.boards = stale.m; return stale.m; }  // 过期也用，别让整行空着
      state.boards = null;
      return null;
    });
  }

  /* 板块名对齐（关键）：涨停池返回的 hybk 被东财截断到 4 个字，
   * 出现的是「电子化学」「汽车零部」「农产品加」，而板块表里是全名。
   * 所以先用「去 ⅠⅡⅢ 后缀后完全相等」，再退到「板块名以这 4 字开头」取最短的一个
   * （取最短是为了避免「电子化学」被更泛的板块名吃掉）。 */
  function boardMatch(raw) {
    var m = state.boards;
    if (!m) return null;
    var k = String(raw || '').replace(/[ⅠⅡⅢ]/g, '').trim();
    if (!k) return null;
    if (m[k]) return { name: k, pct: num(m[k][1], null) };
    /* 注意：循环里比较的是「去掉后缀的名字」，但取数据必须用原始键
     * （板块表里的键是「电子化学品Ⅱ」，规范化之后是「电子化学品」，直接用规范化名会取到 undefined） */
    var bestKey = null, bestLen = Infinity;
    for (var name in m) {
      var nn = String(name).replace(/[ⅠⅡⅢ]/g, '');
      if (nn.length >= k.length && nn.indexOf(k) === 0 && nn.length < bestLen) { bestLen = nn.length; bestKey = name; }
    }
    return bestKey ? { name: bestKey.replace(/[ⅠⅡⅢ]/g, ''), pct: num(m[bestKey][1], null) } : null;
  }

  /* 回补历史：逐日取 zt/dt/zb 的家数与最高板，写进 localStorage。
   * 每天只补缺失的日子，第二次打开页面就是 0 请求。 */
  function backfill() {
    var days = recentDays(BACKFILL).slice(1);   // 今天已经有实时数据，从昨天开始
    var todo = days.filter(function (d) { return !state.hist[d] || state.hist[d].zt == null; }).slice(0, 12);
    if (!todo.length) return Promise.resolve();

    var idx = 0, touched = false;
    function worker() {
      if (idx >= todo.length) return Promise.resolve();
      var d = todo[idx++];
      return Promise.all([
        fetchPool('zt', d, 1, 'lbc:desc').catch(function () { return null; }),
        fetchPool('dt', d, 1, 'fund:asc').catch(function () { return null; }),
        fetchPool('zb', d, 1, 'fbt:asc').catch(function () { return null; })
      ]).then(function (rs) {
        var zt = rs[0], dt = rs[1], zb = rs[2];
        /* 节假日/超出可回溯范围会返回 tc=0 或 null —— 不写入缓存，下次也不会再问同一句 */
        if (zt && zt.tc > 0) {
          state.hist[d] = {
            zt: zt.tc,
            dt: dt ? dt.tc : null,
            zb: zb ? zb.tc : null,
            lb: (zt.list && zt.list.length) ? num(zt.list[0].lbc, null) : null
          };
          touched = true;
        }
        return worker();
      });
    }
    var lanes = [];
    for (var k = 0; k < 3; k++) lanes.push(worker());
    return Promise.all(lanes).then(function () { if (touched) saveHist(state.hist); });
  }

  /* 昨日涨停溢价：昨日涨停的票今天平均涨多少 —— 打板情绪最灵的一个指标 */
  function loadPremium() {
    var days = recentDays(3);
    var yday = days[1];
    return fetchPool('zt', yday, 200, 'fbt:asc').then(function (p) {
      state.yzt = p;
      if (!p || !p.list || !p.list.length) return null;
      var codes = p.list.map(function (x) {
        var c = String(x.c || '');
        return (num(x.m, 0) === 1 ? 'sh' : 'sz') + c;
      }).filter(Boolean);
      if (typeof global.fetchQuotes !== 'function') return null;
      return global.fetchQuotes(codes, 60).then(function (q) {
        var sum = 0, n = 0, up = 0, down = 0;
        var todayCode = {};
        (state.zt && state.zt.list || []).forEach(function (x) { todayCode[String(x.c)] = num(x.lbc, 1); });
        var promote = 0;
        codes.forEach(function (code) {
          var qq = q && q[code];
          if (!qq || qq.changePct === null || qq.changePct === undefined) return;
          sum += qq.changePct; n++;
          if (qq.changePct > 0) up++; else if (qq.changePct < 0) down++;
        });
        Object.keys(todayCode).forEach(function (c) { if (todayCode[c] >= 2) promote++; });
        state.prem = n ? { avg: sum / n, n: n, up: up, down: down, promote: promote, base: p.tc || codes.length } : null;
        return null;
      });
    }).catch(function () { state.prem = null; return null; });
  }

  /* ------------------------------ 指标计算 ------------------------------ */
  function amtWan() {
    var Q = {};
    try { Q = (typeof QUOTES !== 'undefined' && QUOTES) || {}; } catch (e) { Q = {}; }
    var a = num((Q['sh000001'] || {}).amountWan, 0) + num((Q['sz399001'] || {}).amountWan, 0);
    return a > 0 ? a : null;
  }

  function compute() {
    var br = state.br || { up: 0, down: 0, flat: 0, total: 0 };
    var ztN = state.zt ? state.zt.tc : null;
    var dtN = state.dt ? state.dt.tc : null;
    var zbN = state.zb ? state.zb.tc : null;
    var lb = maxBoard(state.zt);
    var zbRate = (ztN !== null && zbN !== null && (ztN + zbN) > 0) ? zbN / (ztN + zbN) : null;
    var aw = amtWan();
    var amtYi = aw ? aw / 10000 : null;   // 万元 → 亿元

    var upRatio = (br.up + br.down) > 0 ? br.up / (br.up + br.down) : null;

    /* 五维：每一项都是 0~满分 的线性/分段映射，锚点写在注释里方便校准 */
    var dims = [];
    dims.push({
      key: 'width', name: '市场宽度', max: 30,
      val: upRatio === null ? null : upRatio * 30,
      txt: upRatio === null ? '—' : (upRatio * 100).toFixed(1) + '% 上涨',
      note: '上涨家数占比'
    });
    dims.push({
      key: 'limit', name: '涨跌停结构', max: 25,
      val: (ztN === null || dtN === null) ? null : 25 * clamp((ztN - dtN + 20) / 60, 0, 1),
      txt: ztN === null ? '—' : ztN + ' / ' + (dtN === null ? '—' : dtN),
      note: '涨停 / 跌停'
    });
    dims.push({
      key: 'height', name: '连板高度', max: 15,
      val: lb === null ? null : 15 * clamp((lb - 2) / 6, 0, 1),
      txt: lb === null ? '—' : lb + ' 板',
      note: '最高连板'
    });
    dims.push({
      key: 'seal', name: '封板质量', max: 15,
      val: zbRate === null ? null : 15 * clamp(1 - zbRate / 0.6, 0, 1),
      txt: zbRate === null ? '—' : '炸板率 ' + (zbRate * 100).toFixed(1) + '%',
      note: '炸板 / (涨停+炸板)'
    });
    dims.push({
      key: 'vol', name: '量能', max: 15,
      val: amtYi === null ? null : 15 * clamp((amtYi - 6000) / 12000, 0, 1),
      txt: amtYi === null ? '—' : amtYi.toFixed(0) + ' 亿',
      note: '两市成交额'
    });

    /* 缺数据的维度按权重折算，而不是当 0 分 —— 否则接口一抖动温度就假崩 */
    var got = dims.filter(function (d) { return d.val !== null; });
    var wGot = got.reduce(function (s, d) { return s + d.max; }, 0);
    var sGot = got.reduce(function (s, d) { return s + d.val; }, 0);
    var score = wGot > 0 ? Math.round(sGot / wGot * 100) : null;
    if (score !== null) score = clamp(score, 0, 100);

    /* 连续跌停最多几天：跌停池的 days 字段，用于跌停梯队标题右侧的提示 */
    var dtMax = null;
    if (state.dt && state.dt.list.length) {
      dtMax = state.dt.list.reduce(function (m, x) { var v = num(x.days, 1); return v > m ? v : m; }, 1);
    }

    return {
      br: br, ztN: ztN, dtN: dtN, zbN: zbN, lb: lb, zbRate: zbRate,
      dtMax: dtMax,
      amtYi: amtYi, amtWan: aw, upRatio: upRatio, dims: dims, score: score,
      missing: dims.filter(function (d) { return d.val === null; }).map(function (d) { return d.name; })
    };
  }

  /* 阶段判定：位置看温度，方向看「今天 vs 昨天」的涨停数与连板高度 */
  function stageOf(c, yday) {
    var s = c.score;
    var yZt = yday && yday.zt !== null && yday.zt !== undefined ? yday.zt : null;
    var yLb = yday && yday.lb !== null && yday.lb !== undefined ? yday.lb : null;

    var dir = '走平', dirTone = 'mute';
    if (yZt !== null && c.ztN !== null) {
      var dz = c.ztN - yZt;
      var dl = (yLb !== null && c.lb !== null) ? c.lb - yLb : 0;
      var vote = (dz >= 5 ? 1 : dz <= -5 ? -1 : 0) + (dl >= 1 ? 1 : dl <= -1 ? -1 : 0);
      if (vote > 0) { dir = '回暖'; dirTone = 'up'; }
      else if (vote < 0) { dir = '走弱'; dirTone = 'down'; }
      else { dir = '分化'; dirTone = 'mute'; }
    }

    var pos = '中位', posTone = 'mute';
    if (s === null) { pos = '待定'; }
    else if (s >= 66) { pos = '高位'; posTone = 'hot'; }
    else if (s >= 38) { pos = '中位'; posTone = 'mute'; }
    else { pos = '低位'; posTone = 'cool'; }

    var name = '轮动', tone = '', note = '', advice = '';
    if (s === null) {
      name = '待定'; note = '情绪数据不足，暂不判定阶段';
    } else if (s >= 70) {
      name = '高潮'; tone = 'hot';
      note = '温度进入过热区，赚钱效应最好但接力风险最高';
      advice = '高潮期只做最强主线的分歧回封，追一字板容易吃面，仓位别加';
    } else if (s >= 52) {
      name = '发酵'; tone = 'warm';
      note = '赚钱效应扩散，连板梯队成形，属于可参与的阶段';
      advice = '发酵期可以打板/做连板，但只在回踩或分歧回封时下手，不追高';
    } else if (s >= 38) {
      name = '轮动'; tone = '';
      note = '没有明显主线，资金在板块间换来换去';
      advice = '轮动期降低预期，做低位首板或强势股回踩，别恋战';
    } else if (s >= 22) {
      name = '修复'; tone = 'cool';
      note = '情绪从低位往上修，赚钱效应还在恢复，右侧信号未确立';
      advice = '修复期只做低吸不做追涨，等涨停家数与连板高度同时回升再加大仓位';
    } else {
      name = '冰点'; tone = 'cold';
      note = '普跌格局，封板率与赚钱效应双低';
      advice = '冰点期空仓等右侧，抢反弹的胜率远低于等情绪回暖';
    }

    return { name: name, tone: tone, pos: pos, posTone: posTone, dir: dir, dirTone: dirTone, note: note, advice: advice };
  }

  /* ------------------------------ 图表：近 20 日涨停/跌停 ------------------------------ */
  function chart(days) {
    if (!days.length) return '<div class="sent-empty">历史数据回补中，稍后自动刷新</div>';
    var W = 760, H = 200, padL = 30, padR = 12, padT = 12, padB = 24;
    var n = days.length;
    var maxUp = Math.max(10, Math.max.apply(null, days.map(function (d) { return d.zt || 0; })));
    var maxDn = Math.max(5, Math.max.apply(null, days.map(function (d) { return d.dt || 0; })));
    var maxLb = Math.max(3, Math.max.apply(null, days.map(function (d) { return d.lb || 0; })));
    var innerH = H - padT - padB;
    var base = padT + innerH * 0.70;
    var upH = base - padT, dnH = (H - padB) - base;
    var slot = (W - padL - padR) / n;
    var bw = Math.max(4, Math.min(15, slot * 0.56));

    var s = '<svg class="sent-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="近 ' + n + ' 个交易日涨停跌停家数与最高连板">';
    /* 横向网格：只画涨停侧 2 条 + 跌停侧 1 条，避免糊成一片 */
    [0.5, 1].forEach(function (k) {
      var y = base - upH * k;
      s += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="#eef0f3" stroke-width="1"/>';
      s += '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="#adb5bd">' + Math.round(maxUp * k) + '</text>';
    });
    s += '<line x1="' + padL + '" y1="' + base.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + base.toFixed(1) + '" stroke="#dee2e6" stroke-width="1"/>';

    var linePts = [];
    days.forEach(function (d, i) {
      var x = padL + slot * i + (slot - bw) / 2;
      var zt = d.zt || 0, dt = d.dt || 0, lb = d.lb;
      if (zt > 0) {
        var h1 = Math.max(1, upH * (zt / maxUp));
        s += '<rect x="' + x.toFixed(1) + '" y="' + (base - h1).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h1.toFixed(1) + '" rx="1" fill="#e03131" opacity="0.82"/>';
      }
      if (dt > 0) {
        var h2 = Math.max(1, dnH * (dt / maxDn));
        s += '<rect x="' + x.toFixed(1) + '" y="' + base.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h2.toFixed(1) + '" rx="1" fill="#2f9e44" opacity="0.72"/>';
      }
      if (lb) {
        var ly = base - upH * (lb / maxLb) * 0.92;
        linePts.push([padL + slot * i + slot / 2, ly]);
      }
      if (i === 0 || i === n - 1 || i % Math.ceil(n / 5) === 0) {
        s += '<text x="' + (padL + slot * i + slot / 2).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="9" fill="#adb5bd">'
          + d.d.slice(4, 6) + '-' + d.d.slice(6, 8) + '</text>';
      }
    });
    if (linePts.length > 1) {
      s += '<polyline points="' + linePts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ')
        + '" fill="none" stroke="#f08c00" stroke-width="1.8" stroke-linejoin="round" opacity="0.9"/>';
      var last = linePts[linePts.length - 1];
      s += '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.8" fill="#f08c00"/>';
    }
    s += '</svg>';
    return s;
  }

  /* ------------------------------ 渲染 ------------------------------ */
  function histDays() {
    var days = recentDays(BACKFILL).map(function (d) {
      var h = state.hist[d];
      if (!h) return null;
      if (h.zt === null || h.zt === undefined) return null;
      return { d: d, zt: h.zt, dt: h.dt, zb: h.zb, lb: h.lb };
    }).filter(Boolean);
    return days.reverse();
  }

  function kpi(label, value, sub, tone) {
    return '<div class="sent-kpi">'
      + '<span class="sent-kpi-label">' + esc(label) + '</span>'
      + '<b class="sent-kpi-val ' + (tone || '') + '">' + value + '</b>'
      + '<span class="sent-kpi-sub">' + (sub || '&nbsp;') + '</span>'
      + '</div>';
  }

  function ladderHtml() {
    if (!state.zt || !state.zt.list.length) return '<div class="sent-empty">今日涨停池暂无数据</div>';
    var groups = {};
    state.zt.list.forEach(function (x) {
      var b = num(x.lbc, 1);
      (groups[b] = groups[b] || []).push(x);
    });
    var keys = Object.keys(groups).map(Number).sort(function (a, b) { return b - a; });
    return keys.map(function (b) {
      var arr = groups[b].sort(function (x, y) { return num(y.fund, 0) - num(x.fund, 0); });
      var chips = arr.slice(0, 40).map(function (x) {
        return '<span class="sent-chip' + (b >= 3 ? ' hi' : '') + '" title="' + esc((x.hybk || '') + ' · 封板 ' + hhmm(x.fbt) + ' · 封单 ' + (num(x.fund, 0) / 1e8).toFixed(2) + ' 亿') + '">'
          + esc(x.n || x.c)
          + '<i>' + (num(x.zbc, 0) > 0 ? '炸' + num(x.zbc, 0) + '次' : hhmm(x.fbt)) + '</i>'
          + '</span>';
      }).join('');
      var more = arr.length > 40 ? '<span class="sent-chip more">+' + (arr.length - 40) + '</span>' : '';
      return '<div class="sent-ladder-row">'
        + '<span class="sent-ladder-tag' + (b >= 3 ? ' hi' : '') + '">' + b + ' 板</span>'
        + '<div class="sent-ladder-chips">' + chips + more + '</div>'
        + '</div>';
    }).join('');
  }

  /* 跌停梯队：按「连续跌停天数」分组（东财跌停池的 days 字段，
   * 实测 11-18/19/20 依次是 1/2/3，确认就是连续天数，不是「几天几板」那种口径）。
   * 跌停池没有 lbc，封单额在 fba（元），时间是 lbt（最后封板时间），与涨停池字段名不同。 */
  function dtLadderHtml() {
    if (!state.dt || !state.dt.list.length) return '<div class="sent-empty">今日跌停池暂无数据</div>';
    var groups = {};
    state.dt.list.forEach(function (x) {
      var b = num(x.days, 1);
      (groups[b] = groups[b] || []).push(x);
    });
    var keys = Object.keys(groups).map(Number).sort(function (a, b) { return b - a; });
    return keys.map(function (b) {
      /* 按封单额从小到大排：封单越小 = 越容易开板，最该盯的是它 */
      var arr = groups[b].sort(function (x, y) { return num(x.fba, 0) - num(y.fba, 0); });
      var chips = arr.slice(0, 40).map(function (x) {
        return '<span class="sent-chip dn' + (b >= 3 ? ' hi' : '') + '" title="' + esc((x.hybk || '') + ' · 最后封板 ' + hhmm(x.lbt) + ' · 封单 ' + (num(x.fba, 0) / 1e8).toFixed(2) + ' 亿') + '">'
          + esc(x.n || x.c)
          + '<i>' + hhmm(x.lbt) + '</i>'
          + '</span>';
      }).join('');
      var more = arr.length > 40 ? '<span class="sent-chip more">+' + (arr.length - 40) + '</span>' : '';
      return '<div class="sent-ladder-row">'
        + '<span class="sent-ladder-tag dn' + (b >= 3 ? ' hi' : '') + '">' + b + ' 天</span>'
        + '<div class="sent-ladder-chips">' + chips + more + '</div>'
        + '</div>';
    }).join('');
  }

  function sectorHtml() {
    var list = (state.zt && state.zt.list) || [];
    if (!list.length) return '<div class="sent-empty">今日涨停池暂无数据</div>';
    var agg = {};
    list.forEach(function (x) {
      var k = x.hybk || '其他';
      var o = agg[k] = agg[k] || { n: 0, lb: 0, rep: null, fund: 0 };
      o.n++;
      o.fund += num(x.fund, 0);
      if (num(x.lbc, 1) > o.lb) { o.lb = num(x.lbc, 1); o.rep = x.n || x.c; }
    });

    var rows = Object.keys(agg).map(function (k) {
      var o = agg[k];
      var hit = boardMatch(k);
      return {
        /* 显示板块表里的全名（「电子化学品」），源数据只有 4 字（「电子化学」） */
        name: hit ? hit.name : k.replace(/[ⅠⅡⅢ]/g, ''),
        raw: k.replace(/[ⅠⅡⅢ]/g, ''),
        n: o.n, lb: o.lb, rep: o.rep, fund: o.fund,
        pct: hit ? hit.pct : null
      };
    }).sort(function (a, b) { return b.n - a.n || b.lb - a.lb; }).slice(0, 9);

    var top = rows[0] ? rows[0].n : 1;
    return rows.map(function (r) {
      /* 最高板放在代表股后面：「真视通 · 4板」，比塞进名称列更不容易挤爆 */
      var rep = r.rep ? esc(r.rep) + (r.lb >= 2 ? ' · ' + r.lb + '板' : '') : '';
      return '<div class="sent-row">'
        + '<span class="sent-row-name">' + esc(r.name) + '</span>'
        + '<span class="sent-row-bar"><i style="width:' + (r.n / top * 100).toFixed(0) + '%"></i></span>'
        + '<span class="sent-row-val">' + r.n + ' 家</span>'
        + '<span class="sent-row-pct ' + (r.pct > 0 ? 'up' : r.pct < 0 ? 'down' : '') + '">' + (r.pct === null || r.pct === undefined ? '—' : pctTxt(r.pct)) + '</span>'
        + '<span class="sent-row-rep">' + rep + '</span>'
        + '</div>';
    }).join('');
  }

  function brokenHtml() {
    var list = (state.zb && state.zb.list) || [];
    if (!list.length) return '';
    var agg = {};
    list.forEach(function (x) { var k = x.hybk || '其他'; agg[k] = (agg[k] || 0) + 1; });
    var rows = Object.keys(agg).map(function (k) { return { k: k, n: agg[k] }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 5);
    return '<div class="sent-sub-title">炸板集中板块</div>'
      + rows.map(function (r) {
        return '<span class="sent-tag warn">' + esc(r.k) + ' ' + r.n + '</span>';
      }).join(' ');
  }

  /* 跌停集中板块：与「炸板集中板块」对称，跌停池同样是 4 字截断的 hybk，
   * 用 boardMatch 换成板块全名，避免「电子化学 / 汽车零部」这种半截名 */
  function dtSectorHtml() {
    var list = (state.dt && state.dt.list) || [];
    if (!list.length) return '';
    var agg = {};
    list.forEach(function (x) { var k = x.hybk || '其他'; agg[k] = (agg[k] || 0) + 1; });
    var rows = Object.keys(agg).map(function (k) {
      var hit = boardMatch(k);
      return { k: hit ? hit.name : k.replace(/[ⅠⅡⅢ]/g, ''), n: agg[k] };
    }).sort(function (a, b) { return b.n - a.n; }).slice(0, 5);
    return '<div class="sent-sub-title">跌停集中板块</div>'
      + rows.map(function (r) {
        return '<span class="sent-tag dn">' + esc(r.k) + ' ' + r.n + '</span>';
      }).join(' ');
  }

  function todoHtml(c, st) {
    var items = [];
    var yday = state.hist[recentDays(3)[1]] || {};

    items.push({
      t: '连板高度',
      v: c.lb === null ? '—' : c.lb + ' 板',
      s: c.lb === null ? '缺数据' : (c.lb >= 5 ? '有空间' : c.lb >= 3 ? '中性' : '偏低'),
      tone: c.lb === null ? 'mute' : (c.lb >= 5 ? 'up' : c.lb >= 3 ? 'mute' : 'down'),
      d: c.lb === null ? '涨停池未返回' : (yday.lb ? '昨日最高 ' + yday.lb + ' 板，' + (c.lb > yday.lb ? '高度抬升' : c.lb < yday.lb ? '高度压缩' : '高度持平') : '昨日高度未取到')
    });

    items.push({
      t: '赚钱效应',
      v: state.prem ? pctTxt(state.prem.avg) : '—',
      s: state.prem ? (state.prem.avg > 2 ? '强' : state.prem.avg > -1 ? '一般' : '偏弱') : '缺数据',
      tone: state.prem ? (state.prem.avg > 2 ? 'up' : state.prem.avg > -1 ? 'mute' : 'down') : 'mute',
      d: state.prem ? ('昨日涨停 ' + state.prem.n + ' 只今日平均，红 ' + state.prem.up + ' / 绿 ' + state.prem.down
        + (state.prem.base ? ' · 晋级 ' + state.prem.promote + '/' + state.prem.base : '')) : '昨日涨停池或报价未取到'
    });

    items.push({
      t: '封板质量',
      v: c.zbRate === null ? '—' : (c.zbRate * 100).toFixed(1) + '%',
      s: c.zbRate === null ? '缺数据' : (c.zbRate > 0.45 ? '偏差' : c.zbRate > 0.3 ? '一般' : '健康'),
      tone: c.zbRate === null ? 'mute' : (c.zbRate > 0.45 ? 'down' : c.zbRate > 0.3 ? 'warn' : 'up'),
      d: c.zbN === null ? '炸板池未返回' : ('炸板 ' + c.zbN + ' 家，与涨停 ' + (c.ztN === null ? '—' : c.ztN) + ' 家相比')
    });

    items.push({
      t: '量能',
      v: c.amtYi === null ? '—' : c.amtYi.toFixed(0) + ' 亿',
      s: c.amtYi === null ? '缺数据' : (c.amtYi >= 16000 ? '活跃' : c.amtYi >= 10000 ? '正常' : '地量'),
      tone: c.amtYi === null ? 'mute' : (c.amtYi >= 16000 ? 'up' : c.amtYi >= 10000 ? 'mute' : 'warn'),
      d: '两市成交额，6000 亿以下算地量、1.6 万亿以上算活跃'
    });

    items.push({
      t: '赚钱面',
      v: c.br.up + ' / ' + c.br.down,
      s: c.upRatio === null ? '缺数据' : (c.upRatio > 0.6 ? '普涨' : c.upRatio > 0.4 ? '分化' : '普跌'),
      tone: c.upRatio === null ? 'mute' : (c.upRatio > 0.6 ? 'up' : c.upRatio > 0.4 ? 'mute' : 'down'),
      d: '上涨 / 下跌家数，覆盖沪深 ' + c.br.total + ' 只'
    });

    return items.map(function (x) {
      return '<div class="sent-todo-row">'
        + '<span class="sent-todo-t">' + esc(x.t) + '</span>'
        + '<b class="sent-todo-v ' + (x.tone === 'up' ? 'up' : x.tone === 'down' ? 'down' : '') + '">' + x.v + '</b>'
        + '<span class="sent-tag ' + x.tone + '">' + esc(x.s) + '</span>'
        + '<span class="sent-todo-d">' + esc(x.d) + '</span>'
        + '</div>';
    }).join('');
  }

  function render() {
    var box = document.getElementById('sentBody');
    if (!box) return;
    var c = compute();
    var yday = state.hist[recentDays(3)[1]] || null;
    var st = stageOf(c, yday);
    var days = histDays();

    var now = new Date();
    var hmNow = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    var inSession = now.getDay() >= 1 && now.getDay() <= 5
      && ((now.getHours() * 60 + now.getMinutes()) >= 555 && (now.getHours() * 60 + now.getMinutes()) <= 900);
    var dataTag = inSession ? '<span class="sent-live">盘中 · ' + hmNow + '</span>' : '<span class="sent-live off">收盘 · ' + hmNow + '</span>';

    var hint = document.getElementById('sentHint');
    if (hint) {
      hint.innerHTML = dataTag
        + ' <span>涨停/跌停/炸板来自东财涨停池 · 涨跌家数来自东财宽度接口 · 每 60 秒随行情刷新</span>';
    }

    /* 五维分解条 */
    var dimHtml = c.dims.map(function (d) {
      var w = d.val === null ? 0 : clamp(d.val / d.max * 100, 0, 100);
      return '<div class="sent-dim">'
        + '<span class="sent-dim-name">' + esc(d.name) + '</span>'
        + '<span class="sent-dim-track"><i style="width:' + w.toFixed(0) + '%"></i></span>'
        + '<span class="sent-dim-score">' + (d.val === null ? '—' : d.val.toFixed(0)) + '<i>/' + d.max + '</i></span>'
        + '<span class="sent-dim-txt">' + esc(d.txt) + '</span>'
        + '</div>';
    }).join('');

    var scoreTxt = c.score === null ? '--' : c.score;
    var missing = c.missing.length ? '<p class="sent-warn">未取到：' + esc(c.missing.join('、')) + '，温度已按其余维度折算，不用当 0 分看。</p>' : '';

    /* 五维里最拖后腿和最撑住的两项 —— 让人一眼看到「为什么是这个分数」 */
    var ranked = c.dims.filter(function (d) { return d.val !== null; })
      .map(function (d) { return { d: d, r: d.val / d.max }; })
      .sort(function (a, b) { return a.r - b.r; });
    var whyHtml = '';
    if (ranked.length >= 2) {
      var low = ranked.slice(0, 2), high = ranked.slice(-2).reverse();
      var fmt = function (x) { return x.d.name + ' ' + x.d.val.toFixed(0) + '/' + x.d.max; };
      whyHtml = '<div class="sent-stage-why">'
        + '<div><i class="w">拖累</i>' + esc(low.map(fmt).join(' · ')) + '</div>'
        + '<div><i class="s">支撑</i>' + esc(high.map(fmt).join(' · ')) + '</div>'
        + '</div>';
    }

    /* 最高板那只票的名字（封板最早/封单最大的一只，仅用于卡片副标题） */
    var topName = '';
    if (state.zt && state.zt.list.length && c.lb !== null) {
      var tp = state.zt.list.filter(function (x) { return num(x.lbc, 1) === c.lb; })[0];
      if (tp) topName = tp.n || tp.c;
    }

    var prem = state.prem;
    var premVal = prem ? pctTxt(prem.avg) : '—';
    var premTone = prem ? (prem.avg > 0 ? 'up' : prem.avg < 0 ? 'down' : '') : '';
    var premSub = prem
      ? ('红 ' + prem.up + ' / 绿 ' + prem.down + ' · 晋级 ' + prem.promote + '/' + (prem.base || prem.n))
      : '昨日涨停池未取到';

    box.innerHTML = ''
      /* ---------- 第一屏：温度 + 阶段 ---------- */
      + '<div class="sent-hero">'
      +   '<div class="sent-gauge">'
      +     '<div class="sent-score-row">'
      +       '<div class="sent-score-box">'
      +         '<b class="sent-score">' + scoreTxt + '</b>'
      +         '<span class="sent-score-side"><i class="sent-label ' + st.tone + '">' + esc(st.name) + '</i><em>情绪温度 / 100</em></span>'
      +       '</div>'
      +       '<p class="sent-advice">' + esc(st.advice || st.note) + '</p>'
      +     '</div>'
      +     '<div class="sent-dims">' + dimHtml + '</div>'
      +     missing
      +     '<div class="sent-chart-head"><span>涨停 / 跌停 · 近 ' + BACKFILL + ' 个交易日</span>'
      +       '<span class="sent-legend"><i class="up"></i>涨停<i class="down"></i>跌停<i class="line"></i>最高连板</span></div>'
      +     '<div class="sent-chart">' + chart(days) + '</div>'
      +   '</div>'
      +   '<aside class="sent-stage">'
      +     '<div class="sent-stage-head">阶段判定 · 位置 · 方向</div>'
      +     '<div class="sent-stage-name ' + st.tone + '">' + esc(st.name) + '</div>'
      +     '<div class="sent-stage-tags"><span class="' + st.posTone + '">位置：' + esc(st.pos) + '</span><span class="' + st.dirTone + '">方向：' + esc(st.dir) + '</span></div>'
      +     '<p class="sent-stage-note">' + esc(st.note) + '</p>'
      +     '<ul class="sent-stage-list">'
      +       '<li>涨停 <b class="up">' + (c.ztN === null ? '—' : c.ztN) + '</b> 家 / 跌停 <b class="down">' + (c.dtN === null ? '—' : c.dtN) + '</b> 家</li>'
      +       '<li>最高 <b>' + (c.lb === null ? '—' : c.lb) + '</b> 板 · 炸板率 <b>' + (c.zbRate === null ? '—' : (c.zbRate * 100).toFixed(0) + '%') + '</b></li>'
      +       '<li>上涨 <b class="up">' + c.br.up + '</b> / 下跌 <b class="down">' + c.br.down + '</b></li>'
      +     '</ul>'
      +     whyHtml
      +     '<p class="sent-stage-foot">方向 = 今日与昨日「涨停家数 + 最高连板」的合力，不预测，只描述已经发生的变化。</p>'
      +   '</aside>'
      + '</div>'

      /* ---------- 第二屏：五张指标卡 ---------- */
      + '<div class="sent-kpis">'
      +   kpi('最高连板', c.lb === null ? '—' : (c.lb + ' 板'), topName || '&nbsp;', c.lb >= 4 ? 'up' : '')
      +   kpi('涨停 / 跌停', '<span class="up">' + (c.ztN === null ? '—' : c.ztN) + '</span> / <span class="down">' + (c.dtN === null ? '—' : c.dtN) + '</span>',
              '炸板 ' + (c.zbN === null ? '—' : c.zbN) + ' 家', '')
      +   kpi('炸板率', c.zbRate === null ? '—' : (c.zbRate * 100).toFixed(1) + '%',
              '封板 ' + (c.ztN === null || c.zbN === null ? '—' : (100 - c.zbRate * 100).toFixed(0) + '%'),
              c.zbRate === null ? '' : (c.zbRate > 0.45 ? 'down' : c.zbRate > 0.3 ? '' : 'up'))
      +   kpi('昨日涨停溢价', premVal, premSub, premTone)
      +   kpi('两市成交额', c.amtYi === null ? '—' : (c.amtYi >= 10000 ? (c.amtYi / 10000).toFixed(2) + ' 万亿' : c.amtYi.toFixed(0) + ' 亿'),
              c.amtYi === null ? '行情未取到' : (c.amtYi >= 16000 ? '放量' : c.amtYi >= 10000 ? '正常' : '地量'),
              c.amtYi === null ? '' : (c.amtYi >= 16000 ? 'up' : c.amtYi < 8000 ? 'down' : ''))
      + '</div>'

      /* ---------- 第三屏：涨停梯队 + 跌停梯队 / 板块赚钱效应 ---------- */
      + '<div class="sent-two">'
      +   '<div class="sent-panel">'
      +     '<div class="sent-panel-head"><h3>涨停梯队</h3><span class="hint">按连板数分组 · 悬停看封板时间与封单</span></div>'
      +     '<div class="sent-ladder">' + ladderHtml() + '</div>'
      +     '<div class="sent-sub-title">跌停梯队'
      +       (c.dtN ? '<span class="sent-sub-n ' + (c.dtN >= 20 ? 'down' : '') + '">' + c.dtN + ' 家</span>' : '')
      +       (c.dtMax ? '<span class="sent-sub-hint">最多连续 ' + c.dtMax + ' 天</span>' : '')
      +     '</div>'
      +     '<div class="sent-ladder">' + dtLadderHtml() + '</div>'
      +   '</div>'
      +   '<div class="sent-panel">'
      +     '<div class="sent-panel-head"><h3>板块赚钱效应</h3><span class="hint">按行业聚合 · 涨停家数排序</span></div>'
      +     '<div class="sent-rows">' + sectorHtml() + '</div>'
      +     brokenHtml()
      +     dtSectorHtml()
      +   '</div>'
      + '</div>'

      /* ---------- 第四屏：观察清单 ---------- */
      + '<div class="sent-panel sent-todo">'
      +   '<div class="sent-panel-head"><h3>今日观察清单</h3><span class="hint">全部由当前数据推出，不预测个股</span></div>'
      +   '<div class="sent-todo-list">' + todoHtml(c, st) + '</div>'
      +   '<p class="sent-foot">温度口径：市场宽度 30 + 涨跌停结构 25 + 连板高度 15 + 封板质量 15 + 量能 15；'
      +   '中性锚定（涨跌各半、涨停比跌停多 10 家、最高 4 板、炸板率 30%、成交 1.2 万亿）≈ 50 分。'
      +   '数据为盘中实时值，收盘后 15 分钟内的快照视为当日收盘数据。</p>'
      + '</div>';
  }

  /* ------------------------------ 对外接口 ------------------------------ */
  function feed(payload) {
    if (!payload) return;
    if (payload.breadth) state.br = payload.breadth;
    if (payload.idxRows) state.idxRows = payload.idxRows;
    if (!state.loaded && !state.busy) {
      render();          // 先用宽度把骨架画出来，别让区块空着
      loadAll(true);
    } else {
      render();
      loadAll(false);
    }
  }

  function refresh() { return loadAll(true); }

  var Sentiment = { feed: feed, refresh: refresh, _state: state, _compute: compute };
  global.Sentiment = Sentiment;

  /* 刷新按钮：清掉节流时间戳，让用户点了就一定重取 */
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document) {
      if (t.id === 'refreshBtn') { state.ts = 0; setTimeout(function () { loadAll(true); }, 60); return; }
      t = t.parentNode;
    }
  });
})(window);
