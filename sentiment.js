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
 *   4) breadth_seed.json —— 全A涨跌家数历史（build_breadth_seed.py 用腾讯日K逐日统计，
 *      口径≈通达信 880005），解决「东财只给当日值、历史无从回补」的问题
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
  var AKEY = 'radar_sent_amt_v1';    // 两市成交额日线：{t:时间戳, m:{YYYYMMDD: 亿元}}
  var SKEY = 'radar_breadth_seed_v1'; // 全A涨跌家数历史（脚本预生成，口径≈通达信 880005）
  var SEED_URL = 'breadth_seed.json';
  var BOARD_TTL = 300000;            // 板块行情缓存 5 分钟（板块涨跌幅按分钟级更新，够用）
  var AMT_TTL = 180000;              // 成交额日线缓存 3 分钟（盘中当日那根一直在长，别缓存太久）
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
    amt: null,           // 两市成交额日线：{YYYYMMDD: 亿元}
    amtTs: 0,
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
      loadBoards(force),
      /* 成交额日线：给量能卡做「较前日放量/缩量」对比 */
      loadAmounts(force),
      /* 涨跌家数兜底重试：Live 那次失败的话，这里再试两次 */
      fetchBreadthFallback(),
      /* 全A涨跌家数历史：脚本按腾讯日K预生成，补上「当天之前」的 20 多根柱 */
      loadBreadthSeed()
    ];

    return Promise.all(jobs).then(function () {
      /* 今日结果写回历史缓存（涨停数/最高连板/跌停数/炸板数 + 涨跌家数），跨设备共享不了但当日够用 */
      if (state.zt || state.dt || state.zb) {
        var keep = state.hist[today] || {};
        state.hist[today] = {
          zt: state.zt ? state.zt.tc : null,
          dt: state.dt ? state.dt.tc : null,
          zb: state.zb ? state.zb.tc : null,
          lb: maxBoard(state.zt),
          /* 涨跌家数保留上次采到的，别被这一轮覆盖掉 */
          up: keep.up, down: keep.down, flat: keep.flat
        };
        saveHist(state.hist);
      }
      /* 涨跌家数单独写：东财收盘后 f104/f105 会归零，所以只在「确实是有效家数」时覆盖，
       * 不会把已经存好的当日数字冲成 0。涨跌家数没有历史接口可回补，
       * 只能每天打开页面时采一次，攒够一段时间才有完整曲线。 */
      sampleBreadth();
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

  /* 两市成交额日线：上证综指 + 深证综指 的成交额相加。
   *
   * 主源用同花顺 v6/line（实测浏览器直连可用，且一次给 140 天）：
   *   https://d.10jqka.com.cn/v6/line/hs_1A0001/01/last.js   上证综指
   *   https://d.10jqka.com.cn/v6/line/hs_399106/01/last.js   深证综指
   *   —— 内容是 JSONP：quotebridge_xxx({...})，data 里每行
   *      「日期,开,高,低,收,成交量(股),成交额(元),换手率,...」
   *      2026-11-20 沪深各 7025.7 亿 / 7196.3 亿，合计 1.42 万亿，与东财 f57 完全对上。
   *
   * 备源是东财 kline（push2his），本机实测 ERR_EMPTY_RESPONSE 不通，但别的网络环境可能可用，
   * 所以留着当兜底，不通就走同花顺。
   *
   * 为什么不用首页 QUOTES 的 amountWan：那是「当日实时」一个点，没有历史就没法比前日。
   * 这里统一用日线口径，当日与前一日同源，放量缩量才不会判反。 */
  function parseJsonp(txt) {
    var str = String(txt || '');
    var i = str.indexOf('('), j = str.lastIndexOf(')');
    if (i < 0 || j <= i) return null;
    try { return JSON.parse(str.slice(i + 1, j)); } catch (e) { return null; }
  }

  function loadAmounts(force) {
    var now = Date.now();
    if (!force && state.amt && now - state.amtTs < AMT_TTL) return Promise.resolve(state.amt);
    var stale = null;
    try { stale = JSON.parse(localStorage.getItem(AKEY) || 'null'); } catch (e) { stale = null; }
    if (!force && !state.amt && stale && stale.m) { state.amt = stale.m; state.amtTs = stale.t || 0; }

    /* 同花顺：两个综指各一份日线 */
    var THS = ['hs_1A0001', 'hs_399106'];
    var lanes = THS.map(function (c) {
      return fetch('https://d.10jqka.com.cn/v6/line/' + c + '/01/last.js', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.text() : null; })
        .catch(function () { return null; });
    });

    return Promise.all(lanes).then(function (arr) {
      var m = {};
      var got = 0;
      arr.forEach(function (txt) {
        if (!txt) return;
        var j = parseJsonp(txt);
        var rows = (j && j.data) ? String(j.data).split(';') : [];
        if (!rows.length) return;
        got++;
        rows.forEach(function (line) {
          var p = String(line).split(',');
          var d = String(p[0] || '');
          var v = num(p[6], 0);          // 成交额，单位元
          if (d.length === 8 && v > 0) m[d] = (m[d] || 0) + v / 1e8;   // → 亿元
        });
      });
      if (got < 2 || !Object.keys(m).length) throw new Error('成交额日线不完整');
      /* 只保留最近 40 天，别把缓存撑大 */
      var keys = Object.keys(m).sort();
      while (keys.length > 40) delete m[keys.shift()];
      state.amt = m; state.amtTs = now;
      try { localStorage.setItem(AKEY, JSON.stringify({ t: now, m: m })); } catch (e) { /* 存不下就算了 */ }
      return m;
    }).catch(function () {
      /* 同花顺挂了再试东财，不行就用上一次的旧数据 */
      return Promise.all(['1.000001', '0.399106'].map(function (sec) {
        return fetch('https://push2his.eastmoney.com/api/qt/stock/kline/get?fields1=f1,f2'
          + '&fields2=f51,f57&klt=101&fqt=0&end=20500101&lmt=30&secid=' + sec, { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });
      })).then(function (arr) {
        var m = {};
        arr.forEach(function (j) {
          var kl = (j && j.data && j.data.klines) || [];
          kl.forEach(function (line) {
            var p = String(line).split(',');
            var d = String(p[0] || '').replace(/-/g, '');
            var v = num(p[1], 0);
            if (d.length === 8 && v > 0) m[d] = (m[d] || 0) + v / 1e8;
          });
        });
        if (!Object.keys(m).length) {
          if (stale && stale.m) { state.amt = stale.m; return stale.m; }
          return null;
        }
        state.amt = m; state.amtTs = now;
        try { localStorage.setItem(AKEY, JSON.stringify({ t: now, m: m })); } catch (e) { /* 忽略 */ }
        return m;
      });
    });
  }

  /* ----------------------- 全A涨跌家数历史（≈ 通达信 880005） -----------------------
   * 浏览器直连不上海通达信的板块指数 880005，所以由 build_breadth_seed.py 在本地把
   * 沪深全部 A 股最近 40 个交易日的「收盘 vs 前收」逐日统计一遍，落成 breadth_seed.json
   * 随站点一起分发。这里只负责读文件、合并进 hist。
   *   - 历史日一律以 seed 为准（那是收盘定稿，比之前盘中随手采的半截数靠谱）；
   *   - 当天盘中不覆盖，留给实时接口（东财 f104/f105）；
   *   - 文件拿不到就退到 localStorage 里的上一份，仍没有就维持原来的自采累积。 */
  function inSession() {
    var now = new Date(), w = now.getDay();
    var mins = now.getHours() * 60 + now.getMinutes();
    return w >= 1 && w <= 5 && mins >= 555 && mins <= 930;
  }

  function applySeed(rows) {
    if (!rows) return 0;
    if (!state.hist || !Object.keys(state.hist).length) state.hist = loadHist();
    var today = ymdOf(new Date());
    var live = inSession();
    var n = 0;
    Object.keys(rows).forEach(function (d) {
      var v = rows[d];
      if (!v || v.length < 2) return;
      var key = String(d).replace(/-/g, '');           // seed 里可能带横线，hist 统一 8 位
      if (key.length !== 8) return;
      if (key === today && live) return;               // 盘中实时优先
      var rec = state.hist[key] || {};
      var up = num(v[0], -1), dn = num(v[1], -1);
      if (up < 0 || dn < 0 || up + dn < 500) return;   // 数据明显不全的丢掉
      rec.up = up;
      rec.down = dn;
      rec.flat = num(v[2], 0);
      rec.bdSrc = 'seed';
      state.hist[key] = rec;
      n++;
    });
    if (n) saveHist(state.hist);
    return n;
  }

  function seedFromCache() {
    try {
      var c = JSON.parse(localStorage.getItem(SKEY) || 'null');
      if (c && c.rows) return applySeed(c.rows);
    } catch (e) { /* 缓存坏了就当没有 */ }
    return 0;
  }

  function loadBreadthSeed() {
    return fetch(SEED_URL + '?t=' + Math.floor(Date.now() / 600000), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var rows = (j && j.rows) || null;
        if (!rows) return seedFromCache();
        try {
          localStorage.setItem(SKEY, JSON.stringify({ t: Date.now(), rows: rows, src: j.src, up: j.updated }));
        } catch (e) { /* 存不下不影响本次渲染 */ }
        return applySeed(rows);
      })
      .catch(function () { return seedFromCache(); });
  }

  /* 涨跌家数兜底：Live 那边只请求一次东财宽度接口，被掐断就退化成「板块口径」的假家数。
   * 这里自己再试两次（间隔 500ms），成功就覆盖掉代理值 —— 实测这个接口是间歇性失败，
   * 多试一次往往就通了，通了才是真的全市场 5000+ 家。 */
  function fetchBreadthFallback() {
    if (state.br && (num(state.br.up, 0) + num(state.br.down, 0)) >= 3000) return Promise.resolve(true);
    var url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2'
      + '&fields=f12,f14,f104,f105,f106&secids=1.000001,0.399001';
    var attempt = function (left) {
      return fetch(url, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          var rows = (j && j.data && j.data.diff) || [];
          if (!rows.length) throw new Error('empty');
          var up = 0, dn = 0, fl = 0;
          rows.forEach(function (x) { up += num(x.f104, 0); dn += num(x.f105, 0); fl += num(x.f106, 0); });
          if (up + dn < 3000) throw new Error('partial');
          state.br = { total: up + dn + fl, up: up, down: dn, flat: fl };
          return true;
        })
        .catch(function () {
          return left > 0
            ? new Promise(function (r) { setTimeout(r, 500); }).then(function () { return attempt(left - 1); })
            : false;
        });
    };
    return attempt(2);
  }

  /* 把「当前的涨跌家数」落到某个交易日上。
   * 只在数据像样时写（两市约 5400 只，低于 3000 说明接口只回了一半）；
   * 历史日已经记过就不再覆盖，免得同一根柱子被反复刷成不同数字。 */
  function sampleBreadth() {
    if (!state.br) return false;
    var up = num(state.br.up, 0), dn = num(state.br.down, 0);
    if (up + dn < 3000) return false;
    if (!state.hist || !Object.keys(state.hist).length) state.hist = loadHist();
    var d = brTargetDay();
    var rec = state.hist[d] || {};
    var todayK0 = ymdOf(new Date());
    if (d !== todayK0 && rec.up != null) return false;   // 历史日只记一次
    if (rec.up === up && rec.down === dn) return false;  // 没变化就别折腾
    rec.up = up;
    rec.down = dn;
    rec.flat = num(state.br.flat, 0);
    state.hist[d] = rec;
    saveHist(state.hist);
    return true;
  }

  /* 涨跌家数该记到哪一天：
   * 工作日 09:15~15:30 直接记今天；其余时间（夜里、周末）记「最近一个已经有涨停数据的交易日」，
   * 这样周六打开也能把周五那次家数补上，不会写到周六这个空键里。
   * 为什么这么绕：涨跌家数只有「当前值」没有历史接口，采一次就少一次，
   * 采错日子就等于污染了那根柱子。 */
  function brTargetDay() {
    var now = new Date();
    if (inSession()) return ymdOf(now);
    var ks = Object.keys(state.hist).filter(function (k) {
      return state.hist[k] && state.hist[k].zt != null;
    }).sort();
    if (ks.length) return ks[ks.length - 1];
    /* 一条历史都没有时，周末别写到今天这个空键上，退到最近的周五 */
    var d = new Date(now.getTime());
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    return ymdOf(d);
  }

  /* 最新交易日 vs 上一交易日的两市成交额对比
   * 只用「日线里最后两根」，所以周末、节假日打开也照样显示「最近一个交易日 vs 前一日」，
   * 不会出现「今天没成交额」的空窗。 */
  function amtCompare() {
    var m = state.amt;
    if (!m) return null;
    var ks = Object.keys(m).filter(function (k) { return isFinite(m[k]) && m[k] > 0; }).sort();
    if (ks.length < 2) return null;
    var curD = ks[ks.length - 1], prevD = ks[ks.length - 2];
    var cur = m[curD], prev = m[prevD];
    var diff = cur - prev;
    var pct = prev > 0 ? diff / prev * 100 : null;
    /* 放量缩量的判定用相对幅度，不用绝对值：成交额本身有季节性（月末、节前都偏低） */
    var tag = null, tone = '';
    if (pct !== null) {
      if (pct >= 10) { tag = '大幅放量'; tone = 'up'; }
      else if (pct >= 3) { tag = '放量'; tone = 'up'; }
      else if (pct <= -10) { tag = '大幅缩量'; tone = 'down'; }
      else if (pct <= -3) { tag = '缩量'; tone = 'down'; }
      else { tag = '平量'; tone = ''; }
    }
    return { cur: cur, prev: prev, diff: diff, pct: pct, tag: tag, tone: tone, d: curD, prevD: prevD };
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
          var keep = state.hist[d] || {};
          state.hist[d] = {
            zt: zt.tc,
            dt: dt ? dt.tc : null,
            zb: zb ? zb.tc : null,
            lb: (zt.list && zt.list.length) ? num(zt.list[0].lbc, null) : null,
            /* 涨跌家数由 seed / 实时采样单独维护，这里必须原样带过去，否则一回补就冲掉 */
            up: keep.up, down: keep.down, flat: keep.flat, bdSrc: keep.bdSrc
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
    /* 涨跌家数的可信度：东财收盘后 f104/f105 会归零，此时 Live 会退化成一份几百只的代理样本
     * （br.proxy=true，total 只有 800 多），拿它算「1.3% 上涨」会得出完全错误的宽度分。
     * 两市正常在 5000 家以上，低于 3000 一律当没有，让宽度维度显示「—」而不是假数字。 */
    var brOk = !!(state.br && (num(state.br.up, 0) + num(state.br.down, 0)) >= 3000);
    var br = brOk ? state.br : { up: 0, down: 0, flat: 0, total: 0 };
    var ztN = state.zt ? state.zt.tc : null;
    var dtN = state.dt ? state.dt.tc : null;
    var zbN = state.zb ? state.zb.tc : null;
    var lb = maxBoard(state.zt);
    var zbRate = (ztN !== null && zbN !== null && (ztN + zbN) > 0) ? zbN / (ztN + zbN) : null;
    /* 成交额优先用「两综指日线」口径（当日与昨日同源，能算放量缩量）；
     * 日线还没回来时退回首页 QUOTES 的实时值，至少有个数。 */
    var amt = amtCompare();
    var amtYi = amt ? amt.cur : (function () {
      var aw = amtWan();
      return aw ? aw / 10000 : null;
    })();

    var upRatio = (brOk && (br.up + br.down) > 0) ? br.up / (br.up + br.down) : null;

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
      amtYi: amtYi, amt: amt, upRatio: upRatio, brOk: brOk, dims: dims, score: score,
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

  /* ------------------------ 图表：涨停/跌停 + 涨跌家数 ------------------------
   * 上下两段共用一条时间轴：
   *   上段 = 涨停(红，向上) / 跌停(绿，向下) 家数 + 最高连板折线
   *   下段 = 每个交易日的涨跌家数（100% 堆叠：红=上涨，绿=下跌，灰=平盘），
   *          柱子上方标上涨家数、下方标下跌家数，柱体高度比例就是当天的赚钱面。
   * 涨跌家数：历史段来自 breadth_seed.json（脚本按沪深全A日线逐日统计，口径≈通达信 880005），
   * 当日由东财宽度接口实时给；两边都没有的日子画一条浅灰短线占位。 */
  function chart(days) {
    if (!days.length) return '<div class="sent-empty">历史数据回补中，稍后自动刷新</div>';
    var W = 760, padL = 30, padR = 12, padT = 12, padB = 36;
    var mainH = 124, bandGap = 18, bandH = 46;
    var n = days.length;

    /* 一天涨跌家数都没有时，不留那条空带子 */
    var hasBreadth = false;
    for (var bi = 0; bi < days.length; bi++) {
      var bd0 = days[bi];
      if (bd0.up != null && bd0.down != null && (bd0.up + bd0.down) > 0) { hasBreadth = true; break; }
    }
    var H = padT + mainH + (hasBreadth ? bandGap + bandH : 0) + padB;

    var maxUp = Math.max(10, Math.max.apply(null, days.map(function (d) { return d.zt || 0; })));
    var maxDn = Math.max(5, Math.max.apply(null, days.map(function (d) { return d.dt || 0; })));
    var maxLb = Math.max(3, Math.max.apply(null, days.map(function (d) { return d.lb || 0; })));
    var mainTop = padT, mainBottom = padT + mainH;
    var base = mainTop + mainH * 0.70;
    var upH = base - mainTop, dnH = mainBottom - base;
    var bandTop = mainBottom + bandGap, bandBottom = bandTop + bandH;
    var slot = (W - padL - padR) / n;
    var bw = Math.max(4, Math.min(15, slot * 0.56));

    var s = '<svg class="sent-svg' + (hasBreadth ? ' with-bd' : '') + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="近 ' + n + ' 个交易日涨停跌停家数、最高连板与涨跌家数">';

    /* 横向网格：只画涨停侧 2 条，避免糊成一片 */
    [0.5, 1].forEach(function (k) {
      var y = base - upH * k;
      s += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="#eef0f3" stroke-width="1"/>';
      s += '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="#adb5bd">' + Math.round(maxUp * k) + '</text>';
    });
    /* 零轴：涨停/跌停的分界，同时是涨停家数的 0 线 */
    s += '<line x1="' + padL + '" y1="' + base.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + base.toFixed(1) + '" stroke="#dee2e6" stroke-width="1"/>';

    /* 涨跌家数带的分隔与标注 */
    if (hasBreadth) {
      s += '<line x1="' + padL + '" y1="' + (bandTop - bandGap / 2).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + (bandTop - bandGap / 2).toFixed(1) + '" stroke="#f1f3f5" stroke-width="1"/>';
      /* 50% 中位线：柱子的红绿分界越靠上 = 当天上涨家数越多 */
      var midY = bandTop + bandH / 2;
      s += '<line x1="' + padL + '" y1="' + midY.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + midY.toFixed(1) + '" stroke="#e9ecef" stroke-width="0.8" stroke-dasharray="2 3"/>';
    }

    var linePts = [];
    days.forEach(function (d, i) {
      var x = padL + slot * i + (slot - bw) / 2;
      var cx = padL + slot * i + slot / 2;
      var zt = d.zt || 0, dt = d.dt || 0, lb = d.lb;

      /* 涨停柱（向上） */
      if (zt > 0) {
        var h1 = Math.max(1, upH * (zt / maxUp));
        s += '<rect x="' + x.toFixed(1) + '" y="' + (base - h1).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h1.toFixed(1) + '" rx="1" fill="#e03131" opacity="0.82"/>';
      }
      /* 跌停柱（向下） */
      if (dt > 0) {
        var h2 = Math.max(1, dnH * (dt / maxDn));
        s += '<rect x="' + x.toFixed(1) + '" y="' + base.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h2.toFixed(1) + '" rx="1" fill="#2f9e44" opacity="0.72"/>';
      }
      /* 最高连板折线（只取点位，最后统一画） */
      if (lb) {
        var ly = base - upH * (lb / maxLb) * 0.92;
        linePts.push([cx, ly]);
      }

      /* 涨跌家数 100% 堆叠条 + 上下数字 */
      if (hasBreadth) {
        var up = num(d.up, -1), dn = num(d.down, -1), fl = num(d.flat, 0);
        if (up >= 0 && dn >= 0 && (up + dn) > 0) {
          var tot = up + dn + (fl > 0 ? fl : 0);
          var hu = bandH * up / tot;
          var hf = fl > 0 ? bandH * fl / tot : 0;
          var hd = bandH - hu - hf;
          s += '<rect x="' + x.toFixed(1) + '" y="' + bandTop.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hu.toFixed(1) + '" fill="#e03131" opacity="0.62"/>';
          if (hf > 0) s += '<rect x="' + x.toFixed(1) + '" y="' + (bandTop + hu).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hf.toFixed(1) + '" fill="#dee2e6"/>';
          s += '<rect x="' + x.toFixed(1) + '" y="' + (bandBottom - hd).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hd.toFixed(1) + '" fill="#2f9e44" opacity="0.62"/>';
          /* 数字：上涨标在柱子上方、下跌标在下方，都是纯数字，不带单位省宽度 */
          if (bw >= 5) {
            s += '<text x="' + cx.toFixed(1) + '" y="' + (bandTop - 3).toFixed(1) + '" text-anchor="middle" class="bd-num" font-size="8.5" font-weight="600" fill="#c92a2a">' + up + '</text>';
            s += '<text x="' + cx.toFixed(1) + '" y="' + (bandBottom + 9).toFixed(1) + '" text-anchor="middle" class="bd-num" font-size="8.5" font-weight="600" fill="#2b8a3e">' + dn + '</text>';
          }
        } else {
          /* 没采到：一条浅灰短线，明确表示「这天没有数据」而不是 0 家 */
          s += '<rect x="' + x.toFixed(1) + '" y="' + (bandTop + bandH / 2 - 1).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="2" fill="#e9ecef"/>';
        }
      }

      /* 日期轴：首尾 + 每 1/5 一格 */
      if (i === 0 || i === n - 1 || i % Math.ceil(n / 5) === 0) {
        s += '<text x="' + cx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="9" fill="#adb5bd">'
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
      /* 涨停池与涨跌家数各有各的来源：只要两者之一有数据，这根柱子就该画出来 */
      if (h.zt == null && h.up == null) return null;
      return { d: d, zt: h.zt, dt: h.dt, zb: h.zb, lb: h.lb, up: h.up, down: h.down, flat: h.flat, bdSrc: h.bdSrc };
    }).filter(Boolean);
    return days.reverse();
  }

  function kpi(label, value, sub, tone, tip) {
    return '<div class="sent-kpi"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>'
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
      v: c.brOk ? (c.br.up + ' / ' + c.br.down) : '—',
      s: c.upRatio === null ? '缺数据' : (c.upRatio > 0.6 ? '普涨' : c.upRatio > 0.4 ? '分化' : '普跌'),
      tone: c.upRatio === null ? 'mute' : (c.upRatio > 0.6 ? 'up' : c.upRatio > 0.4 ? 'mute' : 'down'),
      d: c.brOk
        ? ('上涨 / 下跌家数，覆盖沪深 ' + c.br.total + ' 只')
        : '非交易时段东财只回部分样本，涨跌家数暂不可用，不参与温度计算'
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
    /* 有没有任何一天的涨跌家数（决定要不要画下带、图例要不要列它） */
    var hasBreadth = days.some(function (d) { return d.up != null && d.down != null && (d.up + d.down) > 0; });
    /* 最新一天有家数的记录，用来在图注里直接给一个具体数字（窄屏会把柱上数字隐掉） */
    var lastBr = null;
    for (var li = days.length - 1; li >= 0; li--) {
      if (days[li].up != null && days[li].down != null && (days[li].up + days[li].down) > 0) { lastBr = days[li]; break; }
    }

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

    /* 成交额：主值 + 「较前日放量/缩量」。对比取日线最后两根，
     * 所以周末打开显示的是「最近一个交易日 vs 上一交易日」，不会出现空窗；
     * 日线还没切到当天时（盘中有时会滞后），标签上补一个日期，避免误读成今天。 */
    var A = c.amt;
    var fmtYi = function (v) { return v >= 10000 ? (v / 10000).toFixed(2) + ' 万亿' : v.toFixed(0) + ' 亿'; };
    var todayK = ymdOf(new Date());
    var amtLabel = '两市成交额', amtMain, amtSub, amtTip;
    if (A) {
      var dv = Math.abs(A.diff);
      amtMain = fmtYi(A.cur);
      amtSub = '较前日 ' + (A.diff >= 0 ? '+' : '-') + fmtYi(dv)
        + ' · ' + (A.pct >= 0 ? '+' : '') + A.pct.toFixed(1) + '% ' + A.tag;
      amtTip = '基准 ' + A.d + ' ' + fmtYi(A.cur)
        + ' vs 前一日 ' + A.prevD + ' ' + fmtYi(A.prev)
        + '（口径：上证综指 + 深证综指成交额之和）';
      if (A.d !== todayK) amtLabel = '两市成交额 · ' + A.d.slice(4, 6) + '/' + A.d.slice(6, 8);
    } else if (c.amtYi !== null) {
      amtMain = fmtYi(c.amtYi);
      amtSub = c.amtYi >= 16000 ? '放量' : c.amtYi >= 10000 ? '正常' : '地量';
      amtTip = '成交额日线未取到，这里退回首页实时值，暂无法与前日对比';
    } else {
      amtMain = '—'; amtSub = '行情未取到'; amtTip = '行情接口未返回成交额';
    }
    var amtTone = A ? A.tone : (c.amtYi === null ? '' : (c.amtYi >= 16000 ? 'up' : c.amtYi < 8000 ? 'down' : ''));

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
      +     '<div class="sent-chart-head"><span>涨停 / 跌停 / 涨跌家数 · 近 ' + BACKFILL + ' 个交易日</span>'
      +       '<span class="sent-legend"><i class="up"></i>涨停<i class="down"></i>跌停<i class="line"></i>最高连板'
      +       (hasBreadth ? '<i class="bd"></i>涨跌家数(880005口径)' : '') + '</span></div>'
      +     '<div class="sent-chart">' + chart(days) + '</div>'
      +     '<p class="sent-chart-tip">' + (hasBreadth
              ? (lastBr
                  ? '最新 ' + lastBr.d.slice(4, 6) + '-' + lastBr.d.slice(6, 8) + '：上涨 ' + lastBr.up + ' / 下跌 ' + lastBr.down
                    + '（上涨占比 ' + (lastBr.up / (lastBr.up + lastBr.down) * 100).toFixed(1) + '%）· '
                  : '')
                + '下带为沪深全A涨跌家数（口径同通达信 880005），红=上涨、绿=下跌，比例即当天赚钱面；灰色短线表示那天没有数据。'
              : '涨跌家数历史由脚本按全A日线逐日统计后随站点分发（口径同通达信 880005），文件缺失时会退回当日实时采集累积。') + '</p>'
      +   '</div>'
      +   '<aside class="sent-stage">'
      +     '<div class="sent-stage-head">阶段判定 · 位置 · 方向</div>'
      +     '<div class="sent-stage-name ' + st.tone + '">' + esc(st.name) + '</div>'
      +     '<div class="sent-stage-tags"><span class="' + st.posTone + '">位置：' + esc(st.pos) + '</span><span class="' + st.dirTone + '">方向：' + esc(st.dir) + '</span></div>'
      +     '<p class="sent-stage-note">' + esc(st.note) + '</p>'
      +     '<ul class="sent-stage-list">'
      +       '<li>涨停 <b class="up">' + (c.ztN === null ? '—' : c.ztN) + '</b> 家 / 跌停 <b class="down">' + (c.dtN === null ? '—' : c.dtN) + '</b> 家</li>'
      +       '<li>最高 <b>' + (c.lb === null ? '—' : c.lb) + '</b> 板 · 炸板率 <b>' + (c.zbRate === null ? '—' : (c.zbRate * 100).toFixed(0) + '%') + '</b></li>'
      +       '<li>上涨 <b class="up">' + (c.brOk ? c.br.up : '—') + '</b> / 下跌 <b class="down">' + (c.brOk ? c.br.down : '—') + '</b></li>'
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
      +   kpi(amtLabel, amtMain,
              '<span class="' + (amtTone || '') + '">' + amtSub + '</span>', '', amtTip)
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
    if (payload.breadth) {
      state.br = payload.breadth;
      /* 宽度是 Live 分几次推过来的，第一次可能还没数据；
       * 这里每次都试一下，只要拿到像样的家数就落盘，不用等 loadAll 那一轮 */
      sampleBreadth();
    }
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
