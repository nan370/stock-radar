/* ==========================================================================
 * live.js —— 首页「关键信号 / 板块异动 / 财经资讯」实时推导层
 *
 * 设计原则：页面展示的每一项都是当下现算的，不再读云端静态快照
 * （market_signal / sector_anomaly / market_news 三张表已不参与展示，
 *   仅作为接口全部失败时的降级兜底）。
 *
 * 数据源（均在真实浏览器里逐条实测可直连）：
 *   1) 腾讯行情   https://qt.gtimg.cn/q=<codes>                CORS:*  GBK
 *      —— 指数 / 板块 / 个股实时报价，由 app.js 拉好后放在全局 QUOTES
 *   2) 东方财富   https://push2.eastmoney.com/api/qt/...       CORS:回显请求 Origin
 *      —— 两市涨跌家数、全市场涨跌幅榜
 *      https://push2ex.eastmoney.com/getTopicZTPool/DTPool   —— 涨停池 / 跌停池
 *   3) 同花顺     https://news.10jqka.com.cn/tapp/news/push/stock/  CORS:*
 *      —— 实时财经资讯（含 A股/公司/宏观/海外）
 *
 * 所有网络失败都会降级为空数组并保留原有兜底逻辑，不影响页面其它部分。
 * ========================================================================== */
const Live = (function () {
  'use strict';

  /* ---------------------------- 基础工具 ---------------------------- */
  const EM_PUSH2 = 'https://push2.eastmoney.com/api/qt';
  const EM_POOL = 'https://push2ex.eastmoney.com';
  const EM_UT = '7eea3edcaed734bea9cbfc24409ed989';
  const HS_A = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';   // 沪深 A 股（深主板/创业板/沪主板/科创板）
  const THS_NEWS = 'https://news.10jqka.com.cn/tapp/news/push/stock/';

  const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
  const fmtPct = (v) => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%');
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const nowHM = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const hm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const ymd = () => { const d = new Date(); return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); };

  function withTimeout(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }
  async function getJson(url, ms) {
    const r = await fetch(url, { cache: 'no-store', signal: withTimeout(ms || 12000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /* ---------------------- 东方财富：市场宽度统计 ---------------------- */
  /* 指数 secid 上的 f104/f105/f106 = 该指数覆盖市场的 上涨/下跌/平盘 家数 */
  async function emBreadth() {
    const url = EM_PUSH2 + '/ulist.np/get?fltt=2&fields=f12,f14,f104,f105,f106&secids=1.000001,0.399001';
    const d = await getJson(url, 9000);
    const rows = (d && d.data && d.data.diff) || [];
    if (!rows.length) return null;
    let up = 0, down = 0, flat = 0;
    rows.forEach((r) => { up += num(r.f104, 0); down += num(r.f105, 0); flat += num(r.f106, 0); });
    const total = up + down + flat;
    if (!total) return null;
    return { total: total, up: up, down: down, flat: flat };
  }

  /* 涨停池 / 跌停池：tc 就是当日家数，pool 用于取连板龙头 */
  async function emPool(kind) {
    const api = kind === 'up' ? '/getTopicZTPool' : '/getTopicDTPool';
    const url = EM_POOL + api + '?ut=' + EM_UT + '&dpt=wz.ztzt&Pageindex=0&pagesize=30&sort=fund:asc&date=' + ymd();
    const d = await getJson(url, 9000);
    const data = (d && d.data) || null;
    if (!data) return { n: 0, list: [] };
    return { n: num(data.tc, (data.pool || []).length), list: data.pool || [] };
  }

  /* 全市场涨跌幅榜（po=1 从高到低，po=0 从低到高） */
  async function emRank(po, size) {
    const url = EM_PUSH2 + '/clist/get?pn=1&pz=' + size + '&po=' + po + '&np=1&fltt=2&invt=2&fid=f3'
      + '&fs=' + HS_A + '&fields=f12,f14,f2,f3,f8,f6,f10';
    const d = await getJson(url, 9000);
    return ((d && d.data && d.data.diff) || []).map((x) => ({
      code: x.f12, name: x.f14, price: x.f2, pct: num(x.f3, 0),
      turnover: x.f8, amount: x.f6, volRatio: x.f10,
    }));
  }

  /* ------------------------- 同花顺：实时资讯 ------------------------- */
  const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  function classify(it) {
    /* 注意：同花顺返回的 tag 是「频道标签」（几乎每条都带 A股/港股/美股），
       不能用来判类别，只能按标题+摘要的关键词判。 */
    const t = (it.title || '') + stripTags(it.digest || '');
    if (/央行|国务院|国常会|证监会|金融监管|人民银行|发改委|财政部|工信部|商务部|统计局|习近平|中央|两会|货币政策|降准|降息|LPR|逆回购|MLF|财政|专项债|试点|规划|政策|监管|立案调查|目录/.test(t)) return '宏观政策';
    if ((it.stock && it.stock.length)
      || /公司|集团|股份|增持|减持|回购|重组|并购|收购|定增|募资|上市|IPO|过会|业绩|营收|净利|亏损|分红|派息|签署|中标|合同|公告|举牌|易主|退市|停牌|复牌|涨停|跌停|成立|设立|投资|参股|控股|合作|股东/.test(t)) return '上市公司大事';
    if (/美股|港股|欧股|日股|海外|美联储|纳斯达克|道琼斯|道指|标普|特朗普|美债|美元|欧元|日元|英镑|原油|黄金|国际|全球|外交部|关税|以色列|伊朗|沙特|俄罗斯|乌克兰/.test(t)) return '海外市场';
    return '行业动态';
  }
  const IMPORTANT = /重磅|暴涨|暴跌|涨停潮|央行|降准|降息|证监会|国常会|立案|停牌|退市|突破|新高|新低|亏损|爆雷|违约|重组|关税|获批|发布|落地/;

  function relStock(it) {
    const s = it.stock;
    if (!Array.isArray(s) || !s.length) return '';
    return s.slice(0, 2).map((x) => (typeof x === 'string' ? x : (x && (x.name || x.code)) || '')).filter(Boolean).join(' ');
  }

  async function thsNews() {
    const pages = await Promise.all([1, 2, 3].map((p) =>
      getJson(THS_NEWS + '?page=' + p + '&tag=&track=website&pagesize=40', 11000).catch(() => null)));
    const out = [], seen = {};
    pages.forEach((res) => {
      const list = (res && res.data && res.data.list) || [];
      list.forEach((it) => {
        const key = it.id || it.url;
        if (!key || seen[key]) return;
        seen[key] = 1;
        const title = stripTags(it.title);
        if (!title || title.length < 6) return;
        out.push({
          title: title,
          summary: stripTags(it.short || it.digest).slice(0, 110),
          category: classify(it),
          source: it.source || '同花顺财经',
          importance: (it.color === '1' || IMPORTANT.test(title)) ? 5 : 3,
          related_stock: relStock(it),
          published_at: num(it.rtime, num(it.ctime, 0)) * 1000,
          url: it.url || it.shareUrl || '',
        });
      });
    });
    out.sort((a, b) => b.published_at - a.published_at);
    return out.slice(0, 48);
  }

  /* ---------------------- 盘面数据（腾讯实时行情） ---------------------- */
  const MAIN_IDX = ['sh000001', 'sz399001', 'sz399006', 'sh000688', 'sh000300'];
  const MAIN_CN = { sh000001: '上证指数', sz399001: '深证成指', sz399006: '创业板指', sh000688: '科创50', sh000300: '沪深300' };

  function liveOf(code) {
    try { return (typeof QUOTES !== 'undefined' && QUOTES[code]) || null; } catch (e) { return null; }
  }
  function idxRow(code, name) {
    const q = liveOf(code) || {};
    return {
      code: code, name: q.name || name, value: q.price, pct: q.changePct, change: q.change,
      amountWan: q.amountWan, volumeRatio: q.volumeRatio, time: q.time,
    };
  }
  const fmtYi = (wan) => {
    if (wan == null || !isFinite(wan)) return '—';
    const y = wan / 10000;
    return y >= 10000 ? (y / 10000).toFixed(2) + ' 万亿' : Math.round(y).toLocaleString() + ' 亿';
  };

  /* ------------------- 板块：腾讯批量报价 + 随站清单 -------------------
   * 这条路是试出来的，记一下免得以后再踩：
   *   · 新浪 newSinaHy.php、腾讯 proxy.finance.qq.com 板块排行：字段都好，
   *     但响应都没有 Access-Control-Allow-Origin，浏览器直接读不到；
   *   · 东财 clist：有 CORS，但连续请求会被整段掐断（ERR_EMPTY_RESPONSE），
   *     一次要 9 个请求，首页板块区因此经常整块空白；
   *   · 腾讯 qt.gtimg.cn 支持板块代码（pt01801120 这种），有 CORS、单批 100 个、
   *     字段与指数完全同构 —— 换手率、振幅、成交额一次拿全。
   * 板块清单本身几乎不变（行业 31 / 概念 805），做成 boards_tx.json 跟站点一起发布，
   * 运行时只需报价，不再依赖任何"列表接口"。 */
  let BOARD_LIST = null;

  async function boardList() {
    if (BOARD_LIST) return BOARD_LIST;
    const r = await fetch('boards_tx.json', { cache: 'force-cache' });
    if (!r.ok) throw new Error('板块清单读取失败 HTTP ' + r.status);
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) throw new Error('板块清单为空');
    BOARD_LIST = arr;
    return arr;
  }

  async function fetchBoards(force) {
    const FRESH_KEY = 'stockradar.boards.v5';
    const TTL_FRESH = 180 * 1000;         // 3 分钟内复用（自动刷新 60 秒一轮，不必每分钟重拉）
    const TTL_STALE = 6 * 3600 * 1000;

    const read = (ttl) => {
      try {
        const o = JSON.parse(sessionStorage.getItem(FRESH_KEY) || 'null');
        if (!o || !Array.isArray(o.rows) || !o.rows.length) return null;
        if (ttl && Date.now() - o.ts > ttl) return null;
        return o;
      } catch (e) { return null; }
    };

    if (!force) {
      const fresh = read(TTL_FRESH);
      if (fresh) return fresh.rows;
    }

    const list = await boardList();
    const codes = list.map((b) => b.code);
    let quotes = {};
    if (typeof fetchQuotes === 'function') {
      /* 100 个一批，836 个板块约 9 个请求；腾讯 qt 单批再多 URL 就偏长了 */
      quotes = await fetchQuotes(codes, 100);
    }

    let live = 0;
    const rows = list.map((b) => {
      const q = quotes[b.code] || {};
      if (q.changePct != null) live++;
      return {
        code: b.code,
        name: b.name,
        sector_type: b.type,
        change_pct: q.changePct != null ? q.changePct : null,
        turnover: q.amountWan != null ? q.amountWan / 1e4 : null,   // 万元 → 亿
        turnover_rate: q.turnoverRate != null ? q.turnoverRate : null,
        amplitude: q.amplitude != null ? q.amplitude : null,
        leader: '', leaderCode: '', leaderPct: null,
      };
    });

    if (!live) {
      const stale = read(TTL_STALE);
      if (stale) return stale.rows;
      throw new Error('板块行情获取失败');
    }
    try { sessionStorage.setItem(FRESH_KEY, JSON.stringify({ ts: Date.now(), rows: rows })); } catch (e) {}
    return rows;
  }

  function boardRows(secRows) {
    return (secRows || []).map((s) => {
      const q = liveOf(s.code) || {};
      return {
        name: s.name, type: s.sector_type,
        /* 板块代码是东财的 BK 码，腾讯行情没有对价，走快照值；
         * 能拿到腾讯报价时仍以实时价为准。 */
        pct: q.changePct != null ? q.changePct : num(s.change_pct, 0),
        turn: q.turnoverRate != null ? q.turnoverRate : num(s.turnover_rate, null),
        amp: q.amplitude != null ? q.amplitude : num(s.amplitude, null),
        amtWan: q.amountWan != null ? q.amountWan : (s.turnover != null ? num(s.turnover, 0) * 10000 : null),
      };
    });
  }

  /* --------------------- 关键信号与操作建议（实时推导） --------------------- */
  function buildSignals(ctx) {
    const out = [];
    const boards = ctx.boards || [];
    const br = ctx.breadth, poolUp = ctx.poolUp, poolDn = ctx.poolDn;
    const gainers = ctx.gainers || [], losers = ctx.losers || [];

    const idxs = MAIN_IDX.map((c) => idxRow(c, MAIN_CN[c]));
    const sh = idxs[0], cyb = idxs[2];
    /* 深市总成交额用深证综指（覆盖深市全部个股），而非只含 500 只成分股的深证成指 */
    const szAll = idxRow('sz399106', '深证综指');
    const sz = szAll.amountWan != null ? szAll : idxs[1];

    const upB = boards.filter((b) => b.pct > 0).length;
    const dnB = boards.filter((b) => b.pct < 0).length;
    const amount = (sh.amountWan != null && sz.amountWan != null) ? sh.amountWan + sz.amountWan : null;
    const vr = sh.volumeRatio;
    const shPct = sh.pct == null ? 0 : sh.pct;

    /* 1. 大盘方向 */
    let dir = '震荡整理', dirSig = 'neutral';
    if (shPct > 0.3) { dir = '多头占优'; dirSig = 'bullish'; }
    if (shPct > 0.8) { dir = '强势上行'; dirSig = 'bullish'; }
    if (shPct < -0.3) { dir = '空头占优'; dirSig = 'bearish'; }
    if (shPct < -0.8) { dir = '弱势下行'; dirSig = 'bearish'; }
    const style = (cyb.pct != null && sh.pct != null)
      ? (cyb.pct - sh.pct > 0.5 ? '成长风格更强' : (sh.pct - cyb.pct > 0.5 ? '权重蓝筹更强' : '大小盘同步'))
      : '';
    out.push({
      signal_type: dirSig,
      risk_level: Math.abs(shPct) > 1.2 ? 'high' : (Math.abs(shPct) > 0.6 ? 'medium' : 'low'),
      title: '大盘方向：' + dir + (style ? '｜' + style : ''),
      target: '上证指数 / 深证成指 / 创业板指',
      content: '上证 ' + fmtPct(sh.pct) + '（' + (sh.value != null ? sh.value.toFixed(2) : '—') + '）、深成 ' + fmtPct(idxs[1].pct)
        + '、创业板 ' + fmtPct(cyb.pct)
        /* 板块列表取不到时不要写「0 涨 0 跌」——那看着像全市场平盘，是假信息 */
        + (boards.length ? '；板块层面 ' + upB + ' 涨 ' + dnB + ' 跌（共 ' + boards.length + ' 个板块）。'
          : '；板块数据本次未取到，仅按指数判断方向。'),
      advice: dirSig === 'bullish'
        ? '指数走强，可维持中性偏多仓位，优先选择同步放量走强的板块龙头，不追单一拉升的补涨股。'
        : dirSig === 'bearish'
          ? '指数走弱，先降低仓位、控制回撤，等待指数放量止跌并收复短期均线再考虑加仓。'
          : '指数在窄幅区间内反复，建议半仓以下波段操作，方向明确后再顺势加仓。',
    });

    /* 2. 市场宽度（涨跌家数 + 涨跌停） */
    if (br) {
      const ratio = br.up / (br.up + br.down || 1);
      out.push({
        signal_type: ratio > 0.6 ? 'bullish' : (ratio < 0.4 ? 'bearish' : 'neutral'),
        risk_level: ratio > 0.75 || ratio < 0.25 ? 'medium' : 'low',
        title: ratio > 0.6 ? '市场宽度健康，普涨格局' : (ratio < 0.4 ? '市场宽度偏弱，普跌格局' : '市场宽度中性，结构性行情'),
        target: '沪深两市涨跌家数',
        content: '全市场 ' + br.total + ' 只个股：上涨 ' + br.up + ' 只、下跌 ' + br.down + ' 只、平盘 ' + br.flat
          + ' 只（上涨占比 ' + (ratio * 100).toFixed(1) + '%）；涨停 ' + poolUp.n + ' 只、跌停 ' + poolDn.n + ' 只。',
        advice: ratio > 0.6
          ? '赚钱效应扩散，持股体验较好，可适当提高仓位，但要盯住领涨板块的持续性。'
          : ratio < 0.4
            ? '多数个股下跌，即使指数不跌也应以防守为主，规避补跌风险。'
            : '涨跌各半，指数与个股体验背离，建议聚焦少数强势主线，避免平均分散。',
      });
    }

    /* 3. 量能与资金 */
    if (amount != null) {
      out.push({
        signal_type: vr != null ? (vr > 1.1 ? 'bullish' : (vr < 0.9 ? 'bearish' : 'neutral')) : 'neutral',
        risk_level: 'low',
        title: vr != null
          ? (vr > 1.1 ? '量能放大，资金参与度提升' : (vr < 0.9 ? '量能萎缩，观望情绪浓' : '量能平稳'))
          : '两市成交额',
        target: '沪深两市成交额',
        content: '两市合计成交 ' + fmtYi(amount) + '（沪市 ' + fmtYi(sh.amountWan) + '、深市 ' + fmtYi(sz.amountWan) + '）'
          + (vr != null ? '；沪指量比 ' + vr.toFixed(2) : '') + '。',
        advice: vr != null && vr > 1.1
          ? '放量说明分歧与承接同时增加，趋势延续概率上升，可顺势参与强势板块。'
          : vr != null && vr < 0.9
            ? '缩量反弹持续性通常有限，宜等放量信号确认再加仓。'
            : '量能平淡，以低吸为主，不宜在冲高时追买。',
      });
    }

    /* 4. 板块主线 */
    if (boards.length) {
      const up = boards.slice().sort((a, b) => b.pct - a.pct);
      const dn = boards.slice().sort((a, b) => a.pct - b.pct);
      const lead = up.slice(0, 3).map((b) => b.name + ' ' + fmtPct(b.pct)).join('、');
      const lag = dn.slice(0, 3).map((b) => b.name + ' ' + fmtPct(b.pct)).join('、');
      const strong = up[0];
      out.push({
        signal_type: strong && strong.pct > 1 ? 'bullish' : (strong && strong.pct > 0 ? 'neutral' : 'bearish'),
        risk_level: strong && strong.pct > 3 ? 'medium' : 'low',
        title: strong ? '板块主线：' + strong.name + '领涨' : '板块主线',
        target: '行业 / 概念板块',
        content: '领涨：' + lead + '；领跌：' + lag + '。',
        advice: strong && strong.pct > 2
          ? '资金集中流向 ' + strong.name + '，可沿该主线选择量价配合的品种，涨幅超过 5% 后不宜追高。'
          : '当日无明显主线，建议降低交易频率，等待板块效应重新聚集。',
      });
    }

    /* 5. 强势 / 弱势个股（含连板梯队） */
    if (gainers.length || losers.length) {
      const clean = (arr) => arr.filter((x) => !/^N/.test(String(x.name || '')));   // 剔除当日新股
      const g = clean(gainers).slice(0, 3).map((x) => x.name + ' ' + fmtPct(x.pct)).join('、');
      const l = clean(losers).slice(0, 3).map((x) => x.name + ' ' + fmtPct(x.pct)).join('、');
      const tops = (poolUp.list || []).slice()
        .sort((a, b) => (num(b.lbc, 1) - num(a.lbc, 1)) || (num(a.fbt, 0) - num(b.fbt, 0)))
        .slice(0, 3)
        .map((x) => x.n + '（' + (num(x.lbc, 1) > 1 ? num(x.lbc, 1) + '连板' : '首板') + (x.hybk ? '·' + x.hybk : '') + '）')
        .join('、');
      out.push({
        signal_type: 'bullish',
        risk_level: 'medium',
        title: '个股层面：最强梯队与最弱个股',
        target: '全市场涨跌幅榜 · 涨停池',
        content: (tops ? '涨停梯队：' + tops + '；' : '') + '涨幅前列：' + g + '；跌幅前列：' + l + '。',
        advice: '榜单前列多为题材或事件驱动，波动大、隔日风险高，仅适合短打且需严格止损，不建议作为配置方向。',
      });
    }

    /* 6. 风险提示 */
    const ratio2 = br ? br.up / (br.up + br.down || 1) : 0.5;
    const risky = Math.abs(shPct) > 1.5 || (br && ratio2 < 0.3);
    let spreadTxt = '资金在板块间的切换速度快，追涨容易被套。';
    if (boards.length) {
      const pcts = boards.map((b) => b.pct);
      spreadTxt = '板块首尾涨跌幅相差 ' + (Math.max.apply(null, pcts) - Math.min.apply(null, pcts)).toFixed(2) + ' 个百分点，资金在板块间切换速度快，追涨容易被套。';
    }
    out.push({
      signal_type: risky ? 'bearish' : 'neutral',
      risk_level: risky ? 'high' : 'low',
      title: risky ? '风险提示：波动加剧，注意仓位' : '风险提示：结构分化，注意个股风险',
      target: '全市场',
      content: spreadTxt,
      advice: '以上内容由实时行情按固定规则推导，仅作盘面解读参考，不构成投资建议；决策请结合自身持仓与风险承受能力。',
    });

    return out;
  }

  /* --------------------- 板块异动监控（实时推导） --------------------- */
  function buildAnomalies(boards) {
    const out = [];
    boards.forEach((b) => {
      const pct = num(b.pct, 0);
      const amp = b.amp == null ? 0 : num(b.amp, 0);
      const turn = b.turn == null ? 0 : num(b.turn, 0);
      let severity = '', type = '', desc = '', signal = '', sugg = '';
      if (pct >= 5) {
        severity = 'high'; type = '急涨';
        desc = b.name + '（' + b.type + '）实时涨幅 ' + fmtPct(pct) + (amp ? '，日内振幅 ' + amp.toFixed(2) + '%' : '') + (turn ? '，换手率 ' + turn.toFixed(2) + '%' : '') + '，资金短线集中涌入。';
        signal = '板块进入加速段，通常是题材发酵或多头资金抢筹的信号，但短期涨幅过大后回撤风险同步上升。';
        sugg = '已持有可继续持股并用均线跟随止盈；未持有不建议盘中追高，等待回踩不破后再介入。';
      } else if (pct >= 3) {
        severity = 'medium'; type = '放量走强';
        desc = b.name + '（' + b.type + '）实时涨幅 ' + fmtPct(pct) + (amp ? '，振幅 ' + amp.toFixed(2) + '%' : '') + '，明显强于大盘。';
        signal = '板块相对强度突出，属于当日主线候选。';
        sugg = '可关注板块内量价配合的龙头，止损设于当日均价下方。';
      } else if (pct <= -5) {
        severity = 'high'; type = '急跌';
        desc = b.name + '（' + b.type + '）实时跌幅 ' + fmtPct(pct) + (amp ? '，日内振幅 ' + amp.toFixed(2) + '%' : '') + '，抛压集中释放。';
        signal = '板块遭遇集中卖出，可能是利空发酵或前期涨幅兑现。';
        sugg = '短线规避该板块，持仓者逢反弹降低仓位，不在下跌途中抄底。';
      } else if (pct <= -3) {
        severity = 'medium'; type = '放量走弱';
        desc = b.name + '（' + b.type + '）实时跌幅 ' + fmtPct(pct) + '，弱于大盘。';
        signal = '板块资金流出，相对强度转弱。';
        sugg = '暂不参与，观察是否跌破前低。';
      } else if (amp >= 6) {
        severity = 'medium'; type = '大幅震荡';
        desc = b.name + '（' + b.type + '）日内振幅 ' + amp.toFixed(2) + '%，多空分歧剧烈' + (turn ? '，换手率 ' + turn.toFixed(2) + '%' : '') + '。';
        signal = '高振幅往往对应资金博弈加剧，方向未定。';
        sugg = '区间内高抛低吸，避免在振幅高点上追单。';
      } else if (turn >= 5) {
        severity = 'medium'; type = '换手活跃';
        desc = b.name + '（' + b.type + '）换手率 ' + turn.toFixed(2) + '%，交投显著活跃。';
        signal = '筹码快速换手，短线关注度提升。';
        sugg = '可跟踪成交是否持续放大，若量能回落则降低关注。';
      }
      if (severity) {
        out.push({
          severity: severity, sector_name: b.name, anomaly_type: type, change_pct: pct,
          description: desc, signal: signal, suggestion: sugg, created_at: Date.now(),
        });
      }
    });
    out.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
    return out.slice(0, 8);
  }

  /* ------------------------------ 主流程 ------------------------------ */
  async function build(ctx) {
    ctx = ctx || {};
    const secRows = ctx.secRows || [];

    /* 补一个深证综指，用于计算深市总成交额 */
    try {
      if (typeof fetchQuotes === 'function') {
        const need = ['sz399106'].filter((c) => !QUOTES[c]);
        if (need.length) Object.assign(QUOTES, await fetchQuotes(need));
      }
    } catch (e) { /* 忽略 */ }

    const boards = boardRows(secRows);

    const [ns, br, pUp, pDn, gainers, losers] = await Promise.all([
      thsNews().catch(() => []),
      emBreadth().catch(() => null),
      emPool('up').catch(() => ({ n: 0, list: [] })),
      emPool('down').catch(() => ({ n: 0, list: [] })),
      emRank(1, 30).catch(() => []),
      emRank(0, 30).catch(() => []),
    ]);

    const signals = buildSignals({ boards: boards, breadth: br, poolUp: pUp, poolDn: pDn, gainers: gainers, losers: losers });
    const anomalies = buildAnomalies(boards);

    return {
      signals: signals,
      anomalies: anomalies,
      news: ns,
      /* 市场宽度原本只喂给信号文字，首页看不见。这里原样带出去，
       * 由 app.js 画成温度条 —— 同一个数字不要在两处各算一遍。 */
      breadth: br ? {
        total: br.total, up: br.up, down: br.down, flat: br.flat,
        limitUp: pUp.n || 0, limitDown: pDn.n || 0,
      } : null,
      hint: {
        signal: '实时推导 · 更新 ' + nowHM() + ' · 共 ' + signals.length + ' 项',
        anomaly: '实时推导 · 更新 ' + nowHM() + ' · ' + anomalies.length + ' 项异动',
        news: ns.length ? '实时抓取 · 最新 ' + hm(ns[0].published_at) : '实时抓取失败，暂显示历史资讯',
      },
    };
  }

  function applyHint(h) {
    if (!h) return;
    const set = (sel, txt) => { const el = document.querySelector(sel); if (el && txt) el.textContent = txt; };
    set('#signalHint', h.signal);
    set('#anomalyHint', h.anomaly);
    set('#newsHint', h.news);
  }

  /* 交易时段自动刷新：盘中 60 秒，其余时段 5 分钟 */
  function startAutoRefresh() {
    function gap() {
      const d = new Date();
      const day = d.getDay();
      const m = d.getHours() * 60 + d.getMinutes();
      const trading = day >= 1 && day <= 5 && ((m >= 555 && m <= 690) || (m >= 780 && m <= 930));
      return trading ? 60000 : 300000;
    }
    (function loop() {
      setTimeout(function () {
        try { if (typeof loadAll === 'function' && !document.hidden) loadAll(); } catch (e) { /* 忽略 */ }
        loop();
      }, gap());
    })();
  }

  return {
    build: build, applyHint: applyHint, startAutoRefresh: startAutoRefresh,
    fmtPct: fmtPct, fetchBoards: fetchBoards,
  };
})();
