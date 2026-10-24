/* 个股技术分析页 —— 数据来自云端 K线包，指标由 ta.js 本地确定性计算 */

/* 等待 SDK 就绪（SDK 为异步多源加载，业务逻辑必须等它可用） */
function whenSDK() {
  if (window.WorkBuddyCloud) return Promise.resolve();
  if (window.__SDK_FAILED) return Promise.reject(new Error('云服务 SDK 加载失败，请检查网络后刷新'));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('云服务 SDK 加载超时，请刷新重试')), 20000);
    const ok = () => { if (window.WorkBuddyCloud) { clearTimeout(t); document.removeEventListener('wb-sdk-failed', bad); res(); } };
    const bad = () => { clearTimeout(t); rej(new Error('云服务 SDK 加载失败，请检查网络后刷新')); };
    document.addEventListener('wb-sdk-failed', bad, { once: true });
    const iv = setInterval(() => { if (window.WorkBuddyCloud) { clearInterval(iv); ok(); } }, 120);
  });
}

const CFG = {
  /* 应用在 2026-10-22 重建过（旧应用已删除），端点必须跟着换，
   * 否则所有云端请求都打到已经不存在的域名上，整页拿不到数据。 */
  endpoint: 'https://stock-radar-93660.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_H9e0cje1nyLzxZcHf70i5Z_mYZE81FJOwiaOn2OmvQY3wwP1VL8uhOm',
};
let cloud = null;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f2 = (v) => (v == null || !isFinite(v) ? '--' : Number(v).toFixed(2));

let INSTRUMENTS = [];   // 全A标的清单 {code,name,market,kind,board}
let CACHE = {};         // code -> bars
let MODEL_ID = null;
let busy = false;

/* 全A清单较大，缓存到 localStorage 避免每次进页面都拉 5900+ 条 */
const LS_KEY = 'wb_instrument_v3';
const LS_TTL = 7 * 24 * 3600 * 1000;

/* 云端后端（登录 / 自选同步 / AI 点评）只存在于 *.app.workbuddy.host，
 * 而那个域名在公网没有 DNS 记录。一旦站点部署到 GitHub Pages 或本机静态服务，
 * 云端必然连不上 —— 所以直接判定为「本机模式」，不去发那些注定失败的请求，
 * 也不给一个点了没反应的登录按钮。 */
const CLOUD_ON = /(^|\.)app\.workbuddy\.host$/.test(location.hostname);

const BOARD_LABEL = {
  '沪市主板': '沪主板', '深市主板': '深主板', '创业板': '创业板',
  '科创板': '科创板', '北交所': '北交所', '指数': '指数',
};
const BOARD_ORDER = ['创业板', '科创板', '北交所', '深市主板', '沪市主板'];

function readLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.ts || Date.now() - o.ts > LS_TTL || !Array.isArray(o.rows)) return null;
    return o.rows;
  } catch (e) { return null; }
}

function writeLS(rows) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), rows })); }
  catch (e) { /* 配额不足时忽略，不影响功能 */ }
}

/* ---------- 初始化 ---------- */

/* 指数快捷入口。云端 instrument 表里本来就有，现在内置，
 * 不依赖任何一张云表也能用。 */
const INDEX_LIST = [
  { code: 'sh000001', name: '上证指数', market: 'SH', kind: 'index', board: '指数' },
  { code: 'sz399001', name: '深证成指', market: 'SZ', kind: 'index', board: '指数' },
  { code: 'sz399006', name: '创业板指', market: 'SZ', kind: 'index', board: '指数' },
  { code: 'sh000688', name: '科创50', market: 'SH', kind: 'index', board: '指数' },
  { code: 'sh000300', name: '沪深300', market: 'SH', kind: 'index', board: '指数' },
  { code: 'sh000016', name: '上证50', market: 'SH', kind: 'index', board: '指数' },
];

/* 标的清单来源：本机缓存 → 随站发布的 a_share_all.json。
 * 以前还有一条「云端 instrument 表」，但应用重建后那张表已经不存在，
 * 每次进页面都先撞一个 404 再回落，纯粹拖慢首屏 —— 去掉。
 * 本地那份 5900+ 只跟站点一起发布，永远可用。 */
async function loadInstruments() {
  const cached = readLS();
  if (cached && cached.length) return cached;

  try {
    const r = await fetch('a_share_all.json', { cache: 'force-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const raw = await r.json();
    const rows = INDEX_LIST.concat((raw || []).map((x) => ({
      code: x.norm || (String(x.market || '').toLowerCase() + x.code),
      name: x.name || '', market: x.market || '',
      kind: 'stock', board: x.board || '',
    })));
    if (rows.length > 100) writeLS(rows);
    return rows;
  } catch (e) {
    console.error('[Analyze] 本地标的清单也不可用', e && e.message);
    return [];
  }
}

async function init() {
  /* SDK 只管账户与 AI 两个能力，标的清单与 K 线都不依赖它。
   * 所以这里不再「SDK 一失败就整页退出」，而是降级继续。 */
  try {
    if (!CLOUD_ON) throw new Error('外部托管，云端不可达');
    await whenSDK();
    cloud = WorkBuddyCloud.createWorkBuddyCloud(CFG);
  } catch (e) {
    console.warn('[Analyze] 云服务不可用，账户与 AI 能力关闭', e && e.message);
  }

  const models = cloud ? await cloud.llm.models.list().catch(() => []) : [];
  const rows = await loadInstruments();

  if (!rows.length) {
    $('#ph').innerHTML = '<div class="ph-icon">⚠️</div><h2>标的列表加载失败</h2><p>请刷新页面重试</p>';
    return;
  }
  INSTRUMENTS = rows;
  const pick = models.find((m) => m.id === 'glm-5.3') || models.find((m) => m.disabled !== true);
  MODEL_ID = pick ? pick.id : null;

  renderChips();
  watchBoot();                 // 右侧自选栏：不依赖云服务，先挂上
  $('#asof').textContent = latestDateGuess();

  // URL 参数直达：analyze.html?code=sh600519
  const code = new URLSearchParams(location.search).get('code');
  if (code) { $('#q').value = code; run(code); }

  if (!cloud) return;
  cloud.auth.onAuthStateChange((e) => {
    if (e === 'SIGNED_OUT') { $('#loginTip')?.remove(); watchSess = false; watchLoad(); }
  });
  const { data: sess } = await cloud.auth.getSession().catch(() => ({ data: null }));
  if (!sess) {
    const b = document.createElement('div');
    b.className = 'login-tip';
    b.id = 'loginTip';
    b.textContent = CLOUD_ON
      ? '未登录：自选只存在这台设备的浏览器里，登录后可跨设备同步'
      : '自选存在本机。换设备时点右上「分享」生成链接，在另一台设备打开即可导入';
    $('#chips').after(b);
  } else {
    watchLoad();
  }
}

function latestDateGuess() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function renderChips() {
  const hot = INSTRUMENTS.filter((i) => i.kind === 'index').slice(0, 6);
  /* 热门不要取清单前 8 条 —— 那按代码排序出来是「PT金田A / 国华退」这类
   * 老股东西，看着像坏数据。固定几个真正常看的龙头。 */
  const HOT_LIST = ['sh600519', 'sz300750', 'sz002594', 'sh688981',
    'sz002475', 'sz300059', 'sh688256', 'sz300308'];
  let top = HOT_LIST.map((c) => INSTRUMENTS.find((i) => i.code === c)).filter(Boolean);
  if (!top.length) {
    top = INSTRUMENTS.filter((i) => i.kind === 'stock' && !/ST|退/.test(i.name)).slice(0, 8);
  }
  const mk = (arr) => arr.map((i) =>
    `<button class="chip" data-code="${esc(i.code)}">${esc(i.name)}</button>`).join('');
  $('#chips').innerHTML =
    '<span class="chip-label">指数</span>' + mk(hot) +
    '<span class="chip-label">热门</span>' + mk(top);

  const cnt = (b) => INSTRUMENTS.filter((i) => i.board === b).length;
  const total = INSTRUMENTS.filter((i) => i.kind === 'stock').length;
  const bar = $('#boardBar');
  bar.innerHTML =
    '<button class="bb active" data-b="">全市场 <b>' + total + '</b></button>' +
    BOARD_ORDER.map((b) => cnt(b)
      ? `<button class="bb" data-b="${esc(b)}">${BOARD_LABEL[b]} <b>${cnt(b)}</b></button>` : '').join('');
}

/* ---------- 板块筛选 ---------- */
let BOARD = '';
function renderBoardList() {
  const box = $('#boardList');
  if (!BOARD) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const rows = INSTRUMENTS.filter((i) => i.board === BOARD).slice(0, 300);
  box.innerHTML = `<div class="bl-head">${esc(BOARD_LABEL[BOARD] || BOARD)} · 共 ${rows.length}${rows.length >= 300 ? '+' : ''} 只</div>` +
    rows.map((i) => `<button class="bl-row" data-code="${esc(i.code)}">
      <span class="bl-name">${esc(i.name)}</span><span class="bl-code mono">${esc(i.code.replace(/^[a-z]+/, ''))}</span></button>`).join('');
  box.classList.remove('hidden');
}

/* ---------- 输入建议下拉 ---------- */
function renderSug() {
  const q = $('#q').value.trim();
  const box = $('#sug');
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const hits = search(q, 10);
  if (!hits.length) {
    box.innerHTML = '<div class="sug-empty">没有匹配的标的，请检查代码或名称</div>';
  } else {
    box.innerHTML = hits.map((i) => `
      <button class="sug-row" data-code="${esc(i.code)}">
        <span class="sg-name">${esc(i.name)}</span>
        <span class="sg-tag">${esc(BOARD_LABEL[i.board] || i.board || '')}</span>
        <span class="sg-code mono">${esc(i.code)}</span>
      </button>`).join('');
  }
  box.classList.remove('hidden');
}

/* ---------- 检索（全A 5900+ 标的） ---------- */

/* 去掉常见后缀做简称匹配：贵州茅台→茅台，平安银行→平安 */
function stripSuffix(s) {
  return s.replace(/(股份|集团|科技|银行|证券|保险|控股|发展|有限公司|公司)$/g, '');
}

/* 返回排序后的候选列表：越靠前越可能命中 */
function search(q, limit) {
  limit = limit || 12;
  const s = (q || '').trim();
  if (!s) return [];
  const lower = s.toLowerCase().replace(/\s/g, '');
  const out = [];

  for (const i of INSTRUMENTS) {
    const code = i.code;
    const num = code.replace(/^[a-z]+/, '');
    const nm = i.name || '';
    let rank = 0;

    if (code === lower) rank = 100;                       // sh600519
    else if (num === lower) rank = 95;                    // 600519
    else if (nm === s) rank = 92;                         // 贵州茅台
    else if (nm.startsWith(s)) rank = 80;                 // 名称前缀
    else if (nm.includes(s)) rank = 60;                   // 名称包含
    else {
      const sh = stripSuffix(nm);
      if (sh && (sh === s || sh.startsWith(s))) rank = 55;
      else if (num.startsWith(lower) && /^\d{2,}$/.test(lower)) rank = 40; // 代码前缀
      else if (sh.includes(s)) rank = 30;
    }
    // 板块微调：主板权重略高（同名前缀时优先常见标的）
    if (rank && i.kind === 'index') rank += 2;
    if (rank) out.push({ it: i, rank });
  }

  out.sort((a, b) => b.rank - a.rank);
  return out.slice(0, limit).map((x) => x.it);
}

/* 单命中：唯一结果直接返回；多结果交给下拉让用户选 */
function resolve(q) {
  const hits = search(q, 2);
  return hits.length ? hits[0] : null;
}

/* ---------- 拉取K线 ---------- */

let NAME = {};   // code -> 行情源返回的名称（补全本地清单里查不到的标的）

/* 沪/深/京 三家交易所的东财市场号 */
const EM_MKT = { sh: '1', sz: '0', bj: '0' };

/* 东财日K地址 */
function emUrl(code, host) {
  const m = /^([a-z]{2})(\d{4,6})$/.exec(code);
  if (!m) return null;
  return host + '?secid=' + (EM_MKT[m[1]] ?? '0') + '.' + m[2] +
    '&fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&end=20500101&lmt=140';
}

/* 腾讯日K：[date, open, close, high, low, volume]，时间正序 */
function parseTx(j, code) {
  const d = j && j.data && j.data[code];
  if (!d) return null;
  if (d.qt && d.qt[code] && d.qt[code][1]) NAME[code] = String(d.qt[code][1]);
  const arr = d.qfqday || d.day || d.hfqday;
  if (!Array.isArray(arr) || arr.length < 30) return null;
  return arr.map((r) => [String(r[0]).slice(2).replace(/-/g, ''), +r[1], +r[3], +r[4], +r[2], Math.round(+r[5])]);
}

/* 东财日K：字符串 "date,open,close,high,low,volume,..."，时间正序 */
function parseEm(j) {
  const kl = j && j.data && j.data.klines;
  if (!Array.isArray(kl) || kl.length < 30) return null;
  return kl.map((s) => {
    const p = s.split(',');
    return [String(p[0]).slice(2).replace(/-/g, ''), +p[1], +p[3], +p[4], +p[2], +p[5]];
  });
}

/* 行情源按优先级排列。
 * 首选腾讯：该域名对浏览器跨域开放，且沪深京三个板都能取到日K（东财 push2his
 * 在部分网络/设备上会被拦成 ERR_EMPTY_RESPONSE，故退为备选）。 */
const KLINE_SRC = [
  { url: (c) => 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=' + c + ',day,,,640,qfq', parse: parseTx },
  { url: (c) => 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + c + ',day,,,640,qfq', parse: parseTx },
  { url: (c) => emUrl(c, 'https://push2his.eastmoney.com/api/qt/stock/kline/get'), parse: parseEm },
];

/* 依次尝试各源。本项目统一格式 [YYMMDD, open, high, low, close, volume]，最新在前 */
async function fetchBarsOnline(code) {
  for (const src of KLINE_SRC) {
    const u = src.url(code);
    if (!u) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(u, { cache: 'no-store' });
        if (!r.ok) break;
        const bars = src.parse(await r.json(), code);
        if (bars) {
          const newest = bars.slice().reverse();
          if (isFresh(newest)) return newest;
        }
        break; // 该源没有数据（或数据过旧），换源而不是重试
      } catch (e) {
        if (attempt === 1) break;
        await new Promise((r2) => setTimeout(r2, 400));
      }
    }
  }
  return null;
}

/* 最近的K线是否够新（超过 30 天视为已停牌/已退市，不参与分析） */
function isFresh(bars) {
  if (!bars || !bars.length) return false;
  const d = String(bars[0][0]);
  if (d.length !== 6) return true;
  const t = new Date(2000 + +d.slice(0, 2), +d.slice(2, 4) - 1, +d.slice(4, 6)).getTime();
  return Date.now() - t < 1000 * 3600 * 24 * 30;
}

/* 实时行情优先（保证拿到最新交易日的数据）。
 * 原来的「云端 kline_pack 兜底」在新应用里没有这张表，每次都会 404，
 * 留着只会让 Network 面板一片红、还拖慢失败路径 —— 去掉，只留三个实时源。 */
async function loadBars(code) {
  if (CACHE[code]) return CACHE[code];
  let bars = null;
  try {
    const live = await fetchBarsOnline(code);
    if (live && live.length >= 30) bars = live;
  } catch (e) {
    console.warn('[Analyze] 实时行情获取失败', { code, message: e && e.message });
  }
  if (bars && bars.length >= 30) CACHE[code] = bars;
  return bars;
}

/* ---------- 主流程 ---------- */
/* runSeq 代替原来的 busy 锁。
 * 原来的 busy 会在分析中直接 return —— 用户从右侧自选连点两只，
 * 第二下悄无声息地什么都不发生，看着就像坏了。
 * 现在改成「后来者覆盖」：新请求立刻生效，旧请求回来时发现序号过期就丢弃。 */
let runSeq = 0;

async function run(code) {
  /* 注意：run 被直接挂在 click 上，第一个参数会是 MouseEvent。
   * 只有字符串才当作标的代码，否则会被写成 "[object MouseEvent]" 直接搜不到。 */
  if (typeof code === 'string' && code) $('#q').value = code;
  const seq = ++runSeq;
  const q = $('#q').value;
  const inst = resolve(q);
  if (!inst) {
    $('#sug').classList.add('hidden');
    $('#ph').classList.remove('hidden');
    $('#result').classList.add('hidden');
    $('#ph').innerHTML = `<div class="ph-icon">🔍</div>
      <h2>未找到「${esc(q)}」</h2>
      <p>已覆盖沪深京全市场 ${INSTRUMENTS.length} 只标的，请输入 6 位代码或股票简称</p>`;
    renderSug();
    return;
  }
  busy = true;
  $('#goBtn').textContent = '分析中';
  $('#ph').classList.add('hidden');
  $('#result').classList.remove('hidden');
  $('#result').innerHTML = '<div class="loading">正在计算技术指标…</div>';

  try {
    const bars = await loadBars(inst.code);
    if (seq !== runSeq) return;      // 已经被后来的点击取代
    if (!bars || bars.length < 30) {
      $('#result').innerHTML = `<div class="placeholder"><div class="ph-icon">📉</div>
        <h2>${esc(inst.name)} 暂无法获取K线</h2>
        <p>可能是网络波动或标的已停牌，请点右上角 ↻ 重试</p></div>`;
      return;
    }
    const a = TA.analyze(bars);
    a.code = inst.code;
    a.name = NAME[inst.code] || inst.name;
    /* 接入统一模型：缠论结构 + 威科夫量价 + 交易计划 + 评分。
     * 这一步是「两页打架」的根治处 —— 以前本页只算均线七项，
     * 选股页却用缠论×威科夫 100 分制，同一只票能给出一多一空。
     * 现在本页也算同一套结构，并调 Model.score / Model.plan（与选股页同源）。 */
    attachModels(a, bars);
    // 页脚显示本条数据的实际最新交易日
    const asof = document.getElementById('asof');
    if (asof) asof.textContent = fmtDate(bars[0][0]);
    const base = Advice.rule(a);
    CUR_CODE = a.code;
    render(a, base, null);
    watchMarkActive();
    syncUrl(a.code);

    // 模型润色（异步，不阻塞核心结果）
    if (MODEL_ID && cloud) {
      Advice.polish(a, base, cloud, MODEL_ID).then((txt) => {
        if (txt && seq === runSeq) render(a, base, txt);
      }).catch(() => {});
    }
  } catch (e) {
    if (seq !== runSeq) return;
    console.error('[Analyze] 失败', { message: e?.message });
    $('#result').innerHTML = `<div class="placeholder"><div class="ph-icon">⚠️</div>
      <h2>分析失败</h2><p>${esc(e?.message || '数据读取异常')}</p></div>`;
  } finally {
    if (seq === runSeq) {
      busy = false;
      $('#goBtn').textContent = '分析';
    }
  }
}

/* ---------- 统一模型接入 ---------- */
/* TA 的 bars 是 [YYMMDD, o, h, l, c, v] 且日期倒序；
 * 缠论/威科夫/周期聚合统一要求 {d:'YYYY-MM-DD', o,h,l,c,v} 且正序。
 * 日期必须补全成 YYYY-MM-DD：周线聚合靠 Date 解析，六位数字会被解析成
 * 1901 年之类的乱值，导致周线/月线全部落在同一根上。 */
function ymdOf(d) {
  const s = String(d);
  if (s.length === 6) return '20' + s.slice(0, 2) + '-' + s.slice(2, 4) + '-' + s.slice(4, 6);
  return s;
}

function toAscBars(bars) {
  const out = [];
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    out.push({ d: ymdOf(b[0]), o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +b[5] || 0 });
  }
  return out;
}

function maList(asc) {
  const out = [];
  [5, 10, 20, 60].forEach((n) => {
    if (asc.length < n) return;
    let s = 0;
    for (let i = asc.length - n; i < asc.length; i++) s += asc[i].c;
    out.push({ n: n, value: s / n });
  });
  return out;
}

/* 把结构、量价、计划、评分一次性算好挂到 a 上。
 * 任何一步失败都不阻断主流程：拿不到结构就退回纯均线结论，页面上会标出来。 */
function attachModels(a, bars) {
  a.plan = null; a.score = null; a.day = null; a.week = null; a.month = null; a.wyckoff = null;
  try {
    const asc = toAscBars(bars);
    a.asc = asc;
    const wb = Model.aggregate(asc, 'week');
    const mb = Model.aggregate(asc, 'month');
    a.day = Chan.structure(asc);
    a.week = wb.length >= 30 ? Chan.structure(wb) : null;
    a.month = mb.length >= 30 ? Chan.structure(mb) : null;
    a.wyckoff = Wyckoff.analyze(asc, {});
    a.ma = maList(asc);
    a.plan = Model.plan({
      price: a.price, day: a.day, week: a.week, month: a.month,
      wyckoff: a.wyckoff, atr: a.atr, ma: a.ma,
    });
    a.score = Model.score({
      month: a.month, week: a.week, day: a.day, wyckoff: a.wyckoff, plan: a.plan,
      atr: a.atr, price: a.price, pct: a.changePct, code: a.code,
      mainNet: null, amount: null,
      _chg20: a.trend.mom20, _chg60: a.trend.chg60,
    });
    a.modelNote = a.month ? '' : '月线样本不足（需 30 个月），评分按两级别联立';
  } catch (e) {
    console.warn('[Analyze] 统一模型计算失败，退回均线结论', e && e.message);
    a.modelNote = '结构引擎计算失败，本页仅显示均线与量价指标';
  }
}

/* ---------- 渲染 ---------- */
const TREND_CN = {
  'strong-bull': '强势多头', 'mild-bull': '温和上行', neutral: '震荡整理',
  'mild-bear': '温和下行', 'strong-bear': '弱势空头',
};
const POS_CN = { above: '中枢上方', inside: '中枢内部', below: '中枢下方' };
const SUB_CN = { structure: '结构', volume: '量价', momentum: '动量', money: '资金', risk: '风险' };
const SUB_MAX = { structure: 35, volume: 22, momentum: 17, money: 13, risk: 13 };
const buyCnOf = (t) => ({ first: '一买', second: '二买', third: '三买' })[t] || '无买点';

/* 三模型一致性：缠论方向 / 威科夫量价 / 多因子评分各投一票。
 * 三票全同才叫共振；两票同向要说清是哪两个；全不同就直说分歧。
 * 不用「大概率偏多」这类话糊过去 —— 用户要的是能不能动手。 */
function consensusOf(a) {
  const dDir = a.day ? a.day.dir : 0;
  const wyS = a.wyckoff ? a.wyckoff.score : 0;
  const tot = a.score ? a.score.total : 50;
  const votes = [
    { k: '缠论结构', v: dDir, txt: a.day ? (a.day.dirText + ' · ' + (POS_CN[a.day.position] || '—')) : '样本不足' },
    { k: '威科夫量价', v: Math.abs(wyS) < 10 ? 0 : wyS > 0 ? 1 : -1, txt: a.wyckoff ? ('量价分 ' + wyS + (a.wyckoff.cycle ? ' · ' + a.wyckoff.cycle.name : '')) : '样本不足' },
    { k: '多因子评分', v: tot >= 55 ? 1 : tot <= 42 ? -1 : 0, txt: '综合 ' + tot + ' 分 · ' + (a.score ? a.score.grade + ' 级 ' + a.score.gradeText : '—') },
  ];
  const bull = votes.filter((x) => x.v > 0).length;
  const bear = votes.filter((x) => x.v < 0).length;
  let cls = 'flat', txt = '三个模型分歧，方向未定';
  if (bull === 3) { cls = 'bull'; txt = '三模型一致看多'; }
  else if (bear === 3) { cls = 'bear'; txt = '三模型一致看空'; }
  else if (bull === 2) { cls = 'bull'; txt = bear ? '两多一空，偏多但有分歧' : '两多一中，偏多'; }
  else if (bear === 2) { cls = 'bear'; txt = bull ? '两空一多，偏空但有分歧' : '两空一中，偏空'; }
  return { votes, cls, txt, bull, bear };
}

/* 交易计划卡：买区 / 止损 / 目标 / 盈亏比 / 仓位，全部来自 Model.plan。
 * 与选股页同一套推导，所以同一只票在两页看到的价位是一致的。 */
function planHtml(a) {
  const p = a.plan;
  if (!p) return '';
  const pos = Model.position(p, 1);
  let stateTxt, stateCls;
  /* 赔率不够时不能给绿标签「可按计划分批」—— 同一张卡右边就是红标签
   * 「赔率不足，建议放弃这次机会」，一绿一红并列等于自相矛盾。 */
  const lowRR = p.rr != null && p.rr < 1.2;
  if (a.price > p.buyHi) { stateTxt = '现价高于买入区间，等回踩再动手'; stateCls = 'warn'; }
  else if (a.price < p.buyLo) { stateTxt = '现价已跌破买入区间，先确认止损位是否守住'; stateCls = 'bad'; }
  else if (lowRR) { stateTxt = '位置已到买入区间内，但赔率不够，先别动手'; stateCls = 'warn'; }
  else { stateTxt = '现价落在买入区间内，可按计划分批'; stateCls = 'ok'; }

  /* 赔率闸门：盈亏比不够时，上面那串漂亮的买区/目标/止损全是纸面数字。
   * 与其让人照着 0.3 的盈亏比去下单，不如把结论直接写出来。 */
  let verdict, vCls;
  if (p.rr == null) { verdict = '赔率无法计算（样本不足）'; vCls = 'warn'; }
  else if (p.rr >= 1.5) { verdict = '赔率合格，可按计划执行'; vCls = 'ok'; }
  else if (p.rr >= 1.2) { verdict = '赔率勉强够，仓位减半执行'; vCls = 'warn'; }
  else { verdict = '赔率不足，建议放弃这次机会'; vCls = 'bad'; }

  return `
    <section class="block">
      <div class="sec-head"><h2>交易计划</h2>
        <span class="hint">与「量化选股」同一套推导 · 可直接照着挂单</span></div>
      <div class="plan-card">
        <div class="plan-verdict">
          <span class="plan-state ${vCls}">${esc(verdict)}</span>
          <span class="plan-state ${stateCls}">${esc(stateTxt)}</span>
        </div>
        <div class="plan-grid">
          <div class="pg-item">
            <span class="pg-k">买入区间</span>
            <b class="pg-v">${f2(p.buyLo)} ~ ${f2(p.buyHi)}</b>
            <span class="pg-n">宽 ${p.widthPct.toFixed(1)}%（上限 3%）</span>
          </div>
          <div class="pg-item">
            <span class="pg-k">止损</span>
            <b class="pg-v down">${f2(p.stop)}</b>
            <span class="pg-n">${esc(p.stopReason)} · 距中值 ${p.riskPct.toFixed(1)}%</span>
          </div>
          <div class="pg-item">
            <span class="pg-k">目标一</span>
            <b class="pg-v up">${f2(p.target1)}</b>
            <span class="pg-n">盈亏比 ${p.rr ? p.rr.toFixed(2) : '—'} · ${esc(p.targetNote)}</span>
          </div>
          <div class="pg-item">
            <span class="pg-k">目标二</span>
            <b class="pg-v up">${f2(p.target2)}</b>
            <span class="pg-n">盈亏比 ${p.rr2 ? p.rr2.toFixed(2) : '—'}</span>
          </div>
          <div class="pg-item">
            <span class="pg-k">建议仓位</span>
            <b class="pg-v">≤ ${pos ? pos.pct.toFixed(0) : '—'}%</b>
            <span class="pg-n">按单笔账户风险 ${pos ? pos.budget : 1}% ÷ 止损距离推算</span>
          </div>
          <div class="pg-item">
            <span class="pg-k">最近支撑 / 压力</span>
            <b class="pg-v">${p.supports[0] ? f2(p.supports[0].price) : '--'} / ${p.resistances[0] ? f2(p.resistances[0].price) : '--'}</b>
            <span class="pg-n">${p.supports[0] ? esc(p.supports[0].labels.slice(0, 2).join('、')) : '下方无聚集'} / ${p.resistances[0] ? esc(p.resistances[0].labels.slice(0, 2).join('、')) : '上方无聚集'}</span>
          </div>
        </div>
        <div class="plan-bar" aria-hidden="true">
          <i class="pb-track"></i>
          <i class="pb-range" style="left:${barPos(p.stop, p.target1, p.buyLo)}%;width:${barPos(p.stop, p.target1, p.buyHi) - barPos(p.stop, p.target1, p.buyLo)}%"></i>
          <i class="pb-price" style="left:${barPos(p.stop, p.target1, a.price)}%"></i>
        </div>
        <div class="plan-legend"><span>止损 ${f2(p.stop)}</span><span>买区</span><span>目标 ${f2(p.target1)}</span></div>
        <p class="plan-note">计划失效条件：收盘跌破 ${f2(p.stop)}（${esc(p.stopReason)}）。到目标一先减半仓，剩余仓位按 ${f2(p.stop)} 之上移动止损跟踪。区间宽度超过 3% 或止损距离超过 12% 时，本引擎会自动收窄，不再提示。</p>
      </div>
    </section>`;
}

/* 价格在「止损~目标」区间里的百分比位置，用于画计划条 */
function barPos(lo, hi, v) {
  if (!(hi > lo)) return 50;
  return Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
}

function scoreHtml(a) {
  const sc = a.score;
  if (!sc) return '';
  const bars = ['structure', 'volume', 'momentum', 'money', 'risk'].map((k) => {
    const v = sc[k], mx = SUB_MAX[k];
    if (v == null) {
      return `<div class="sb-row muted"><span class="sb-name">${SUB_CN[k]}</span>
        <span class="sb-track"><i class="sb-fill ${k}" style="width:0"></i></span>
        <span class="sb-val mono">缺数据</span></div>`;
    }
    return `<div class="sb-row">
      <span class="sb-name">${SUB_CN[k]}</span>
      <span class="sb-track"><i class="sb-fill ${k}" style="width:${Math.max(0, Math.min(100, v / mx * 100))}%"></i></span>
      <span class="sb-val mono">${v.toFixed(1)}<em>/${mx}</em></span>
    </div>`;
  }).join('');

  const rows = sc.detail.map((d) => `<tr>
      <td>${esc(d.k)}</td>
      <td class="num mono">${esc(d.v)}</td>
      <td class="labels">${esc(d.t)}</td>
    </tr>`).join('');

  return `
    <div class="two-col">
      <section class="block">
        <div class="sec-head"><h2>多因子评分</h2>
          <span class="hint">${sc.moneyMissing ? '资金项缺数据，总分按其余四项折算 · ' : ''}100 分制 · 与选股页同源</span></div>
        <div class="lv-card">
          <div class="score-head">
            <b class="score-big">${sc.total}</b>
            <div class="score-meta"><span class="grade ${sc.grade}">${sc.grade}</span>
              <span>${esc(sc.gradeText)} · 满足 ${sc.levelHit}/4 级</span></div>
          </div>
          <div class="score-bars">${bars}</div>
        </div>
      </section>
      <section class="block">
        <div class="sec-head"><h2>评分依据逐条核对</h2><span class="hint">原始分 → 归一化</span></div>
        <div class="lv-card">
          <table class="lv-table"><thead><tr><th>项目</th><th class="num">原始分</th><th>依据</th></tr></thead>
          <tbody>${rows}</tbody></table>
        </div>
      </section>
    </div>`;
}

function structureHtml(a) {
  const d = a.day, w = a.week, m = a.month, wy = a.wyckoff;
  if (!d && !wy) return '';
  const cy = wy && wy.cycle;
  const lv = (st, name) => st
    ? `<div class="cs-lv"><b>${name}</b><span class="${st.dir > 0 ? 'up' : st.dir < 0 ? 'down' : ''}">${st.dirText}</span>
        <span>${POS_CN[st.position] || '—'}</span>
        ${st.buy && st.buy.grade ? `<span class="mini-tag">${buyCnOf(st.buy.type)}</span>` : ''}</div>`
    : `<div class="cs-lv muted"><b>${name}</b><span>样本不足</span></div>`;

  const evs = (wy && wy.events || []).slice(0, 5).map((e) =>
    `<li class="${e.dir > 0 ? 'ev-bull' : 'ev-bear'}"><b>${esc(e.name)}</b>
      <span class="ev-d">${e.daysAgo === 0 ? '今日' : e.daysAgo + ' 日前'}</span>
      <p>${esc(e.detail)}</p></li>`).join('') ||
    '<li class="ev-none">最近 5 个交易日内没有触发任何量价事件 —— 这本身是信息：没有异常量，也没有假突破。</li>';

  const piv = d && d.lastPivot
    ? `日线中枢 ${f2(d.lastPivot.zd)} ~ ${f2(d.lastPivot.zg)}（${d.lastPivot.d0} 起，${d.lastPivot.endPen - d.lastPivot.startPen + 1} 笔）`
    : '日线暂无中枢（笔数不足 3 或区间不重叠）';

  return `
    <div class="two-col">
      <section class="block">
        <div class="sec-head"><h2>缠论结构</h2><span class="hint">笔 → 中枢 两级，不做线段递归</span></div>
        <div class="lv-card cs-card">
          ${lv(m, '月线')}${lv(w, '周线')}${lv(d, '日线')}
          <div class="cs-foot">
            <p>${esc(piv)}</p>
            ${d && d.diverg && d.diverg.type
              ? `<p class="cs-warn">${esc(d.diverg.note)}</p>`
              : '<p class="muted">日线无背驰</p>'}
            ${d && d.buy && d.buy.text ? `<p class="cs-buy">${esc(d.buy.text)}</p>` : ''}
          </div>
        </div>
      </section>
      <section class="block">
        <div class="sec-head"><h2>威科夫量价</h2>
          <span class="hint">${cy ? esc(cy.name) : '阶段未判定'}</span></div>
        <div class="lv-card cs-card">
          ${cy ? `<div class="cy-head"><b>${esc(cy.name)}</b><span class="cy-pos">区间 ${f2(cy.rangeLo)} ~ ${f2(cy.rangeHi)} · ${(cy.pos * 100).toFixed(0)}% 分位</span></div>
          <p class="cy-text">${esc(cy.text)}</p>
          <ul class="cy-ev">${(cy.evidence || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
          : '<p class="empty">样本不足，无法判定区间与阶段</p>'}
          <div class="cs-foot"><p>量比 <b>${wy ? wy.volRatio.toFixed(2) : '--'}</b> · 多头事件 ${wy ? wy.bullCount : 0} / 空头事件 ${wy ? wy.bearCount : 0}</p></div>
          <ul class="ev-list">${evs}</ul>
        </div>
      </section>
    </div>`;
}

function render(a, base, aiText) {
  const up = a.changePct >= 0;
  const dirCls = up ? 'up' : 'down';
  const t = a.trend;
  const sc = a.score;
  const plan = a.plan;
  const con = consensusOf(a);

  const chart = buildChart(a);

  const supRows = a.supports.map((s, i) => `
    <tr>
      <td><span class="lv-badge sup">S${i + 1}</span></td>
      <td class="num mono">${f2(s.price)}</td>
      <td class="num">${s.distance.toFixed(2)}%</td>
      <td class="num"><span class="strength">${'●'.repeat(Math.min(4, Math.round(s.strength / 2)))}</span>${s.strength}</td>
      <td class="labels">${esc(s.labels.join(' · '))}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">现价下方暂无有效支撑聚集</td></tr>';

  const resRows = a.resistances.map((r, i) => `
    <tr>
      <td><span class="lv-badge res">R${i + 1}</span></td>
      <td class="num mono">${f2(r.price)}</td>
      <td class="num">+${r.distance.toFixed(2)}%</td>
      <td class="num"><span class="strength">${'●'.repeat(Math.min(4, Math.round(r.strength / 2)))}</span>${r.strength}</td>
      <td class="labels">${esc(r.labels.join(' · '))}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">现价上方暂无有效压力聚集</td></tr>';

  const maArr = a.ma || (t.ma ? t.ma.all : []);
  const maRows = maArr.map((m) => `
    <tr><td>MA${m.n}</td><td class="num mono">${f2(m.value)}</td>
    <td class="num ${m.value > a.price ? 'up' : 'down'}">${m.value > a.price ? '上方' : '下方'} ${Math.abs((m.value - a.price) / a.price * 100).toFixed(2)}%</td></tr>`).join('');

  const rsiTxt = a.rsi == null ? '样本不足'
    : a.rsi > 70 ? `<span class="tag warn">超买 ${a.rsi.toFixed(1)}</span>`
    : a.rsi < 30 ? `<span class="tag good">超卖 ${a.rsi.toFixed(1)}</span>`
    : `<span class="tag">中性 ${a.rsi.toFixed(1)}</span>`;

  const inWatch = WATCH.some((w) => w.code === a.code);

  const conCards = con.votes.map((v) => `
    <div class="cs-vote ${v.v > 0 ? 'bull' : v.v < 0 ? 'bear' : 'flat'}">
      <span class="cv-k">${esc(v.k)}</span>
      <b class="cv-v">${v.v > 0 ? '偏多' : v.v < 0 ? '偏空' : '中性'}</b>
      <span class="cv-t">${esc(v.txt)}</span>
    </div>`).join('');

  $('#result').innerHTML = `
    <!-- 头部 -->
    <div class="head-card">
      <div class="head-main">
        <div class="name-row">
          <h2>${esc(a.name)}</h2>
          <span class="code">${esc(a.code)}</span>
          ${sc ? `<span class="tag grade-tag ${sc.grade}">${sc.grade} 级 · ${esc(sc.gradeText)}</span>` : ''}
          <span class="tag ${a.trend.cls}">日线均线 ${TREND_CN[a.trend.cls]}</span>
          <button class="w-add-btn${inWatch ? ' on' : ''}" data-add="${esc(a.code)}"
                  data-addname="${esc(a.name)}">${inWatch ? '✓ 已加自选' : '+ 加自选'}</button>
        </div>
        <div class="price-row ${dirCls}">
          <span class="price">${f2(a.price)}</span>
          <span class="chg">${up ? '+' : ''}${a.changePct.toFixed(2)}%</span>
        </div>
      </div>
      <div class="head-side">
        <div class="kv"><span>买点评分</span><b class="mono ${sc && sc.total >= 55 ? 'up' : sc && sc.total <= 42 ? 'down' : ''}">${sc ? sc.total : '--'}<small>/100</small></b></div>
        <div class="kv"><span>盈亏比</span><b class="mono">${plan && plan.rr ? plan.rr.toFixed(2) : '--'}</b></div>
        <div class="kv"><span>20日动量</span><b class="mono ${t.mom20 > 0 ? 'up' : 'down'}">${t.mom20 != null ? (t.mom20 > 0 ? '+' : '') + t.mom20.toFixed(2) + '%' : '--'}</b></div>
        <div class="kv"><span>ATR波动</span><b class="mono">${f2(a.atr)}</b></div>
      </div>
    </div>

    <!-- 模型共识 -->
    <div class="consensus ${con.cls}">
      <div class="cons-head"><b>${esc(con.txt)}</b>
        <span>缠论方向 · 威科夫量价 · 多因子评分，三票独立给出</span></div>
      <p class="cons-foot">买点评分衡量的是「此刻这个位置值不值得买」，不是「这只股票好不好」——
        趋势很强但已经贴着压力的票，评分同样会低，那是当前价位性价比的问题，不是公司的问题。</p>
      <div class="cons-grid">${conCards}</div>
    </div>

    <!-- 操作建议 -->
    <div class="action-card ${base.tone}">
      <div class="action-head">
        <span class="action-badge">操作建议</span>
        <strong>${esc(base.action)}</strong>
      </div>
      <div class="action-headline">${esc(base.headline)}</div>
      <ul class="reasons">${base.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      ${aiText ? `<div class="ai-block"><div class="ai-tag">AI 分析师点评</div><p>${esc(aiText)}</p></div>`
        : (MODEL_ID && cloud ? `<div class="ai-block pending"><div class="ai-tag">AI 点评生成中…</div></div>` : '')}
      <div class="risk-note">⚠ ${esc(base.risk)}</div>
    </div>

    ${planHtml(a)}

    <!-- K线图 -->
    <section class="block">
      <div class="sec-head"><h2>K线与量能</h2>
        <span class="hint">近 ${Math.min(60, a.bars.length)} 个交易日 · K线 + 成交量 + MACD，标注均线与关键位</span></div>
      <div class="chart-card">${chart}</div>
    </section>

    ${structureHtml(a)}

    <!-- 支撑压力 -->
    <div class="two-col">
      <section class="block">
        <div class="sec-head"><h2><span class="lv-sup-text">▼</span> 支撑位</h2><span class="hint">由近到远</span></div>
        <div class="lv-card">
          <table class="lv-table"><thead><tr>
            <th>档</th><th class="num">价位</th><th class="num">距现价</th><th class="num">强度</th><th>依据</th>
          </tr></thead><tbody>${supRows}</tbody></table>
        </div>
      </section>
      <section class="block">
        <div class="sec-head"><h2><span class="lv-res-text">▲</span> 压力位</h2><span class="hint">由近到远</span></div>
        <div class="lv-card">
          <table class="lv-table"><thead><tr>
            <th>档</th><th class="num">价位</th><th class="num">距现价</th><th class="num">强度</th><th>依据</th>
          </tr></thead><tbody>${resRows}</tbody></table>
        </div>
      </section>
    </div>

    <!-- 指标 -->
    <div class="two-col">
      <section class="block">
        <div class="sec-head"><h2>均线系统</h2></div>
        <div class="lv-card">
          <table class="lv-table"><thead><tr>
            <th>均线</th><th class="num">数值</th><th class="num">相对现价</th>
          </tr></thead><tbody>${maRows}</tbody></table>
        </div>
      </section>
      <section class="block">
        <div class="sec-head"><h2>关键指标</h2></div>
        <div class="lv-card">
          <div class="metric-grid">
            <div class="metric"><span>RSI(14)</span>${rsiTxt}</div>
            <div class="metric"><span>布林上轨</span><b class="mono">${f2(a.boll.up)}</b></div>
            <div class="metric"><span>布林中轨</span><b class="mono">${f2(a.boll.mid)}</b></div>
            <div class="metric"><span>布林下轨</span><b class="mono">${f2(a.boll.dn)}</b></div>
            <div class="metric"><span>筹码密集区</span><b class="mono">${f2(a.vpSplit.support)} ~ ${f2(a.vpSplit.resistance)}</b></div>
            <div class="metric"><span>60日区间</span><b class="mono">${f2(a.swing && a.swing.lowest)} ~ ${f2(a.swing && a.swing.highest)}</b></div>
          </div>
        </div>
      </section>
    </div>

    ${scoreHtml(a)}

    <!-- 均线判定依据 -->
    <section class="block">
      <div class="sec-head"><h2>均线与动能判定依据</h2>
        <span class="hint">八项加权，得分 ${t.score}（-8 ~ +8）${a.modelNote ? ' · ' + esc(a.modelNote) : ''}</span></div>
      <div class="lv-card">
        <ul class="check-list">${t.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        <p class="caliber-line">这一项只回答「均线排列与 MACD 动能如何」，不是买卖结论。买卖结论在上方「模型共识」与「交易计划」——两者口径不同，不要拿这里的 -8~+8 当评分用。</p>
      </div>
    </section>
  `;
  $('#result').classList.remove('hidden');
}

/* ---------- SVG 走势图：K 线 + 成交量 + MACD ----------
 * 以前这里画的是收盘价折线加一块面积，配文却写「走势与关键价位」：
 * 看不出开盘/最高/最低，没有量，也没有动能 —— 决定买卖的三件事全缺。
 * 现在按 A 股看盘的习惯重画成三联图：
 *   上：K 线（红涨绿跌）+ MA5/20/60 + 支撑压力虚线
 *   中：成交量柱 + 5 日均量线
 *   下：MACD 柱 + DIF/DEA
 * 颜色分工同步重排：涨跌只用红绿（A 股惯例），结构位改用青/橙，
 * 不再让「支撑=绿、压力=红」跟「涨=红、跌=绿」在同一张图里互相打脸。 */
const C_UP = '#e03131', C_DN = '#2f9e44';
const C_SUP = '#0b7285', C_RES = '#d9480f';
const C_MA5 = '#f59f00', C_MA20 = '#4a90d9', C_MA60 = '#7048e8';

function buildChart(a) {
  const asc = a.bars.slice().reverse();
  const N = Math.min(60, asc.length);
  const start = asc.length - N;
  const win = asc.slice(start);
  const n = win.length;

  const W = 780, padL = 56, padR = 66;
  const yM = 14, hM = 234;
  const yV = yM + hM + 22, hV = 62;
  const yC = yV + hV + 26, hC = 86;
  const HH = yC + hC + 30;
  const iw = W - padL - padR;
  const step = iw / n;
  const bw = Math.max(2, Math.min(9, step * 0.62));
  const X = (i) => padL + step * (i + 0.5);

  // 均线在全量序列上算完再切窗口，否则窗口首端 20/60 根会是空值
  const allC = asc.map((b) => b[4]);
  const maOf = (k) => {
    const out = new Array(allC.length).fill(null);
    let sum = 0;
    for (let i = 0; i < allC.length; i++) {
      sum += allC[i];
      if (i >= k) sum -= allC[i - k];
      if (i >= k - 1) out[i] = sum / k;
    }
    return out.slice(start);
  };
  const ma5 = maOf(5), ma20 = maOf(20), ma60 = maOf(60);

  // 主图纵轴：K 线高低 + 均线 + 落在合理范围内的关键位
  let lo = Infinity, hi = -Infinity;
  win.forEach((b) => { if (b[3] < lo) lo = b[3]; if (b[2] > hi) hi = b[2]; });
  [ma5, ma20, ma60].forEach((arr) => arr.forEach((v) => {
    if (v != null && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }));
  const rawSpan = (hi - lo) || 1;
  const keyPrices = [...a.supports.map((x) => x.price), ...a.resistances.map((x) => x.price)]
    .filter((v) => isFinite(v) && v > lo - rawSpan * 0.5 && v < hi + rawSpan * 0.5);
  keyPrices.forEach((v) => { if (v < lo) lo = v; if (v > hi) hi = v; });
  const padY = (hi - lo) * 0.06 || Math.abs(hi) * 0.02 || 1;
  lo -= padY; hi += padY;
  const Y = (v) => yM + hM - ((v - lo) / (hi - lo)) * hM;

  // 成交量
  const vols = win.map((b) => b[5]);
  const vmax = Math.max.apply(null, vols.concat([1]));
  const YV = (v) => yV + hV - (v / vmax) * hV;
  const vma = [];
  for (let i = 0; i < n; i++) {
    const s0 = Math.max(0, i - 4);
    let t = 0;
    for (let k = s0; k <= i; k++) t += vols[k];
    vma.push(t / (i - s0 + 1));
  }

  // MACD（与指标引擎同一套参数，避免图上柱子和表里数值对不上）
  const mc = TA.macd(allC);
  const dif = mc.dif.slice(start), dea = mc.dea.slice(start), hist = mc.hist.slice(start);
  let mmax = 1e-9;
  for (let i = 0; i < n; i++) {
    mmax = Math.max(mmax, Math.abs(dif[i] || 0), Math.abs(dea[i] || 0), Math.abs(hist[i] || 0));
  }
  const midY = yC + hC / 2;
  const YC = (v) => midY - (v / mmax) * (hC / 2 - 4);

  const pathOf = (arr, Yf) => {
    let d = '', pen = false;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v == null || !isFinite(v)) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ',' + Yf(v).toFixed(1) + ' ';
      pen = true;
    }
    return d.trim();
  };

  // 主图网格与刻度
  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const v = lo + (hi - lo) * t;
    const y = Y(v).toFixed(1);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#eef0f3" stroke-width="1"/>
      <text x="${padL - 8}" y="${y}" font-size="10" fill="#98a2b3" text-anchor="end"
        dominant-baseline="central">${v.toFixed(v >= 100 ? 1 : 2)}</text>`;
  }).join('');

  // K 线与成交量柱
  let candles = '', vbars = '';
  win.forEach((b, i) => {
    const o = b[1], h = b[2], l = b[3], c = b[4];
    const rise = c >= o;
    const col = rise ? C_UP : C_DN;
    const x = X(i);
    const yO = Y(o), yC2 = Y(c);
    const top = Math.min(yO, yC2);
    const hgt = Math.max(1.2, Math.abs(yC2 - yO));
    candles += `<line x1="${x.toFixed(1)}" y1="${Y(h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${Y(l).toFixed(1)}"
        stroke="${col}" stroke-width="1"/>` +
      `<rect x="${(x - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}"
        fill="${col}" opacity="${rise ? 0.92 : 1}"/>`;
    vbars += `<rect x="${(x - bw / 2).toFixed(1)}" y="${YV(vols[i]).toFixed(1)}" width="${bw.toFixed(1)}"
        height="${Math.max(0.8, yV + hV - YV(vols[i])).toFixed(1)}" fill="${col}" opacity=".5"/>`;
  });

  // MACD 柱
  let histBars = '';
  for (let i = 0; i < n; i++) {
    const v = hist[i] || 0;
    const y0 = YC(0), y1 = YC(v);
    histBars += `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}"
      height="${Math.max(0.6, Math.abs(y1 - y0)).toFixed(1)}" fill="${v >= 0 ? C_UP : C_DN}" opacity=".75"/>`;
  }

  // 关键位虚线：标签放到右侧留白区，避免压在 K 线上
  const drawn = [];
  const priceLabel = (price, color, txt) => {
    if (price == null || !isFinite(price)) return '';
    const y = Y(price);
    if (y < yM - 2 || y > yM + hM + 2) return '';
    if (drawn.some((d) => Math.abs(d - y) < 13)) return '';
    drawn.push(y);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"
        stroke="${color}" stroke-width="1" stroke-dasharray="4 3" opacity=".85"/>
      <text x="${W - padR + 4}" y="${y.toFixed(1)}" font-size="9.5" fill="${color}"
        dominant-baseline="central">${txt} ${price.toFixed(2)}</text>`;
  };

  /* 顺序很重要：priceLabel 内部用 drawn 做 13px 去重，先算的占位。
   * 现价是这张图上最该看见的数字，所以必须第一个算 —— 之前写在最后，被
   * 贴着现价的 R1 / S1 抢了位置，图上根本没有「现价」这条线。 */
  const nowLv = priceLabel(a.price, a.price >= a.prevClose ? C_UP : C_DN, '现价');
  const supLv = a.supports.slice(0, 2).map((x, i) => priceLabel(x.price, C_SUP, 'S' + (i + 1))).join('');
  const resLv = a.resistances.slice(0, 2).map((x, i) => priceLabel(x.price, C_RES, 'R' + (i + 1))).join('');

  // 横轴日期：只在最下方标 4 个，三层图共用一套
  const xi = [0, Math.floor(n / 3), Math.floor(n * 2 / 3), n - 1];
  const xLabels = xi.map((i) => `<text x="${X(i).toFixed(1)}" y="${HH - 8}" font-size="10"
      fill="#98a2b3" text-anchor="middle">${fmtDate(win[i][0])}</text>`).join('');

  const volTop = vmax >= 1e4 ? (vmax / 1e4).toFixed(0) + '万手' : vmax.toFixed(0);

  return `<svg viewBox="0 0 ${W} ${HH}" width="100%" style="display:block">
    ${grid}
    ${candles}
    ${ma60.some((v) => v != null) ? `<path d="${pathOf(ma60, Y)}" fill="none" stroke="${C_MA60}" stroke-width="1.1" opacity=".85"/>` : ''}
    ${ma20.some((v) => v != null) ? `<path d="${pathOf(ma20, Y)}" fill="none" stroke="${C_MA20}" stroke-width="1.1" opacity=".9"/>` : ''}
    <path d="${pathOf(ma5, Y)}" fill="none" stroke="${C_MA5}" stroke-width="1.1" opacity=".9"/>
    ${nowLv}${supLv}${resLv}

    <line x1="${padL}" y1="${yV - 8}" x2="${W - padR}" y2="${yV - 8}" stroke="#e6e8ec"/>
    <text x="${padL - 8}" y="${yV + 8}" font-size="9.5" fill="#98a2b3" text-anchor="end">成交量</text>
    <text x="${padL - 8}" y="${yV + 20}" font-size="9" fill="#c1c7d0" text-anchor="end">${volTop}</text>
    ${vbars}
    <path d="${pathOf(vma, YV)}" fill="none" stroke="#868e96" stroke-width="1" opacity=".85"/>

    <line x1="${padL}" y1="${yC - 8}" x2="${W - padR}" y2="${yC - 8}" stroke="#e6e8ec"/>
    <text x="${padL - 8}" y="${yC + 10}" font-size="9.5" fill="#98a2b3" text-anchor="end">MACD</text>
    <line x1="${padL}" y1="${YC(0).toFixed(1)}" x2="${W - padR}" y2="${YC(0).toFixed(1)}" stroke="#dee2e6"/>
    ${histBars}
    <path d="${pathOf(dif, YC)}" fill="none" stroke="${C_MA5}" stroke-width="1.2"/>
    <path d="${pathOf(dea, YC)}" fill="none" stroke="${C_MA20}" stroke-width="1.2"/>

    ${xLabels}
  </svg>
  <div class="legend">
    <span><i style="background:${C_UP}"></i>阳线</span>
    <span><i style="background:${C_DN}"></i>阴线</span>
    <span><i style="background:${C_MA5}"></i>MA5</span>
    <span><i style="background:${C_MA20}"></i>MA20</span>
    <span><i style="background:${C_MA60}"></i>MA60</span>
    <span><i class="dash" style="color:${C_SUP}"></i>支撑</span>
    <span><i class="dash" style="color:${C_RES}"></i>压力</span>
    <span><i style="background:#868e96"></i>5日均量</span>
  </div>
  <p class="chart-note">三维对齐着看：<b>价</b>在均线之上、<b>量</b>却在 5 日均量之下，是缩量上行，不追；<b>MACD 柱</b>由绿转红的当根，通常就是这段回调的结束点。红涨绿跌为 A 股惯例，支撑/压力改用青/橙，不与涨跌色混用。</p>`;
}

function fmtDate(d) {
  const s = String(d);
  return s.length === 6 ? `${s.slice(0, 2)}/${s.slice(2, 4)}/${s.slice(4, 6)}` : s;
}

/* ==================== 右侧自选栏 ====================
 * 自选股不再是首页弹窗里一个孤立的清单，而是个股分析页的常驻侧栏：
 * 点右侧某只，左侧立刻换成它的分析，路径不打断。
 * 存储：有云端会话走 watchlist 表（多设备同步），没有就落本机 localStorage。
 * 两份的 key 与首页弹窗完全一致，所以在首页加的自选这里也能看到。 */
const LS_WATCH = 'stockradar.watchlist.v1';
const watchLS = () => { try { return JSON.parse(localStorage.getItem(LS_WATCH) || '[]'); } catch (e) { return []; } };
const watchLSWrite = (arr) => { try { localStorage.setItem(LS_WATCH, JSON.stringify(arr)); } catch (e) {} };
const marketOf = (code) => (/^hk/.test(code) ? '港股' : /^us/.test(code) ? '美股' : 'A股');

let WATCH = [];        // [{code,name,market,id?}]
let CUR_CODE = '';     // 左侧当前正在看的标的
let watchSess = false; // 是否已登录（决定写入云端还是本机）
let watchBusy = false;

/* 代码归一化：600519 / sh600519 / SH600519 / 00700 都能收 */
function normWatchCode(raw) {
  const c = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!c) return '';
  if (/^(sh|sz|bj|hk|us)/.test(c)) return c;
  if (/^\d{6}$/.test(c)) {
    if (/^(6|9)/.test(c)) return 'sh' + c;
    if (/^(0|2|3)/.test(c)) return 'sz' + c;
    if (/^(4|8)/.test(c)) return 'bj' + c;
  }
  if (/^\d{5}$/.test(c)) return 'hk' + c;
  return c;
}

const pctTxt = (v) => (v == null || !isFinite(v) ? '--' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%');
const quoteCls = (v) => (v == null || !isFinite(v) || v === 0 ? '' : v > 0 ? 'pos' : 'neg');

/* 腾讯行情：批量取现价与涨跌幅（与首页同一接口，浏览器可直连） */
const GBK_DEC = (() => { try { return new TextDecoder('gbk'); } catch (e) { return null; } })();
async function fetchQuote(codes) {
  const out = {};
  const list = (codes || []).filter(Boolean);
  if (!list.length) return out;
  for (let i = 0; i < list.length; i += 60) {
    const chunk = list.slice(i, i + 60);
    try {
      const r = await fetch('https://qt.gtimg.cn/q=' + chunk.join(','), { cache: 'no-store' });
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      const txt = GBK_DEC ? GBK_DEC.decode(buf) : new TextDecoder('utf-8').decode(buf);
      for (const line of txt.split(';')) {
        const m = /^v_([A-Za-z0-9]+)="([\s\S]*)"$/.exec(line.trim());
        if (!m) continue;
        const f = m[2].split('~');
        if (f.length < 40) continue;
        let ti = 30;
        for (let k = 26; k < 40; k++) {
          const s = (f[k] || '').trim();
          if (/^\d{14}$/.test(s) || /^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}/.test(s)) { ti = k; break; }
        }
        const price = Number(f[3]);
        const changePct = Number(f[ti + 2]);
        out[m[1]] = {
          name: (f[1] || '').trim(),
          price: isFinite(price) ? price : null,
          changePct: isFinite(changePct) ? changePct : null,
        };
      }
    } catch (e) { /* 单批失败：这一批显示 -- 即可，不影响其余 */ }
  }
  return out;
}

/* 读自选：云端优先，读到就镜像回本机；云端空而本机有，则把本机搬上去 */
async function watchLoad() {
  const local = watchLS();
  WATCH = local;
  if (cloud) {
    const { data: sess } = await cloud.auth.getSession().catch(() => ({ data: null }));
    watchSess = !!sess;
    if (sess) {
      try {
        const { data, error } = await cloud.database.from('watchlist').select('*').order('id');
        if (!error) {
          WATCH = (data || []).map((w) => ({ id: w.id, code: w.code, name: w.name, market: w.market }));
          if (WATCH.length) watchLSWrite(WATCH.map((w) => ({ code: w.code, name: w.name, market: w.market })));
          else if (local.length) await watchRestore(local);
        } else {
          $('#wSideTip').textContent = '云端自选读取失败，先显示本机自选。';
        }
      } catch (e) { /* 网络异常：退回本机 */ }
    }
  }
  watchRender();
}

/* 把本机自选补传回云端（换应用/换域名后云端是空的，本机这份就是备份） */
async function watchRestore(list) {
  let ok = 0;
  for (const w of list) {
    try {
      const { error } = await cloud.database.from('watchlist')
        .insert({ code: w.code, name: w.name, market: w.market || marketOf(w.code) });
      if (!error || error.code === '23505') ok++;
    } catch (e) { /* 单条失败继续 */ }
  }
  if (ok) toast('已把本机 ' + ok + ' 只自选同步到云端账户');
  const { data } = await cloud.database.from('watchlist').select('*').order('id').catch(() => ({ data: [] }));
  if (data && data.length) {
    WATCH = data.map((w) => ({ id: w.id, code: w.code, name: w.name, market: w.market }));
    watchLSWrite(WATCH.map((w) => ({ code: w.code, name: w.name, market: w.market })));
  }
}

function watchRender() {
  const ul = $('#wSideList');
  const cnt = $('#wSideCount');
  if (!ul) return;
  if (cnt) cnt.textContent = WATCH.length ? WATCH.length + ' 只' : '';
  const badge = $('#wToggleNum');
  if (badge) badge.textContent = WATCH.length;

  $('#wSideTip').textContent = watchSess
    ? '已登录：自选存在云端账户，换设备也在。点一只即可分析。'
    : (CLOUD_ON
        ? '未登录：自选只存在这台设备。点一只即可分析。'
        : '自选存在本机。换设备点上方「分享」，打开链接即可导入。');

  if (!WATCH.length) {
    ul.innerHTML = '<li class="wside-empty">还没有自选股。<br>在上方输入代码或名称（如 600519 / 茅台），' +
      '或者直接点左侧的「+ 加自选」。</li>';
    return;
  }
  ul.innerHTML = WATCH.map((w) => `
    <li class="wrow${w.code === CUR_CODE ? ' active' : ''}" data-code="${esc(w.code)}" title="点击查看分析">
      <span class="w-main"><b>${esc(w.name || w.code)}</b><i>${esc(w.code)}</i></span>
      <span class="w-quote" data-q="${esc(w.code)}">--</span>
      <button class="rm" data-del="${esc(w.code)}" title="移出自选">×</button>
    </li>`).join('');
  watchFill();
  watchSyncAddBtn();
  fitSidebar();
}

/* 左侧分析卡上的「+ 加自选」要跟着自选变化：加完立刻变「✓ 已加自选」，
 * 从侧栏删掉后要变回来，否则按钮状态和列表对不上。 */
function watchSyncAddBtn() {
  const b = document.querySelector('#result .w-add-btn');
  if (!b) return;
  const on = WATCH.some((w) => w.code === b.dataset.add);
  b.classList.toggle('on', on);
  b.textContent = on ? '✓ 已加自选' : '+ 加自选';
}

/* 补实时价：只有名字的清单跟记事本没区别 */
async function watchFill() {
  const codes = WATCH.map((w) => w.code);
  if (!codes.length) return;
  const q = await fetchQuote(codes).catch(() => ({}));
  for (const c of codes) {
    const el = document.querySelector(`#wSideList [data-q="${c}"]`);
    if (!el) continue;
    const d = q[c];
    if (!d || d.price == null || d.changePct == null) { el.textContent = '--'; el.className = 'w-quote'; continue; }
    el.className = 'w-quote ' + quoteCls(d.changePct);
    el.innerHTML = `<b>${d.price.toFixed(2)}</b><i>${pctTxt(d.changePct)}</i>`;
  }
}

function watchMarkActive() {
  document.querySelectorAll('#wSideList .wrow').forEach((li) => {
    li.classList.toggle('active', li.dataset.code === CUR_CODE);
  });
}

/* 输入候选：代码、名称前缀、名称包含都能中（复用页面上那个 search） */
function watchSug(q) {
  const box = $('#wSideSug');
  if (!box) return;
  const s = String(q || '').trim();
  if (!s) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const hits = (typeof INSTRUMENTS !== 'undefined' && INSTRUMENTS.length) ? search(s, 8) : [];
  box.innerHTML = hits.length
    ? hits.map((i) => `<button type="button" data-c="${esc(i.code)}" data-n="${esc(i.name)}">
        <span class="sg-n">${esc(i.name)}</span>
        <span class="sg-b">${esc(BOARD_LABEL[i.board] || i.board || '')}</span>
        <span class="sg-c">${esc(i.code)}</span></button>`).join('')
    : '<div class="sg-empty">没有匹配的股票，试试 6 位代码</div>';
  box.classList.remove('hidden');
}

async function watchAdd(raw, nameRaw) {
  if (watchBusy) return;
  let code = normWatchCode(raw);
  let name = String(nameRaw || '').trim();
  /* 传进来的可能是名字而不是代码（"茅台""宁德"）：先在清单里解析 */
  if (!/^(sh|sz|bj|hk|us)\d+$/.test(code) && INSTRUMENTS.length) {
    const hit = search(String(raw || '').trim(), 1)[0];
    if (hit) { code = hit.code; name = name || hit.name; }
  }
  if (!code) return toast('请输入代码或名称，如 600519 / 茅台');
  if (WATCH.some((w) => w.code === code)) {
    toast('这只已在自选里');
    return;
  }
  watchBusy = true;
  const btn = $('#wSideAddBtn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    if (!name) {
      const hit = INSTRUMENTS.find((i) => i.code === code);
      name = (hit && hit.name) || '';
    }
    if (!name) {
      const q = await fetchQuote([code]);
      name = (q[code] && q[code].name) || '';
    }
    if (!name) { toast('没查到「' + raw + '」，换个代码或名称试试'); return; }

    /* 云端与本地都写：云端负责跨设备，本机负责断网/换域名时不丢 */
    if (watchSess && cloud) {
      try {
        const { error } = await cloud.database.from('watchlist')
          .insert({ code, name, market: marketOf(code) });
        if (error && error.code !== '23505') console.warn('[Watch] 云端写入失败', error.message);
      } catch (e) { /* 落本机 */ }
    }
    const local = watchLS();
    if (!local.some((w) => w.code === code)) {
      local.unshift({ code, name, market: marketOf(code) });
      watchLSWrite(local);
    }
    if ($('#wSideCode')) $('#wSideCode').value = '';
    await watchLoad();
    toast('已加入自选：' + name);
  } finally {
    watchBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '加'; }
  }
}

async function watchDel(code) {
  const hit = WATCH.find((w) => w.code === code);
  watchLSWrite(watchLS().filter((w) => w.code !== code));
  WATCH = WATCH.filter((w) => w.code !== code);
  watchRender();
  toast('已移出自选：' + (hit ? hit.name : code));
  if (watchSess && cloud) {
    try { await cloud.database.from('watchlist').delete().eq('code', code); } catch (e) { /* 云端失败不影响本机 */ }
    await watchLoad();
  }
}

/* 点右侧 → 左侧换分析。用 replaceState 保住 sharecode，刷新/收藏还能打开。 */
function goStock(code) {
  CUR_CODE = code;
  $('#q').value = code;
  watchMarkActive();
  closeDrawer();
  run(code);
}

function syncUrl(code) {
  try {
    const p = new URLSearchParams(location.search);
    p.set('code', code);
    history.replaceState(null, '', location.pathname + '?' + p.toString());
  } catch (e) { /* 无 history 支持时忽略 */ }
}

/* 窄屏：右栏收成抽屉 */
function openDrawer() {
  $('#wside').classList.add('open');
  $('#wSideMask').classList.add('show');
}
function closeDrawer() {
  $('#wside').classList.remove('open');
  $('#wSideMask').classList.remove('show');
}

/* 侧栏高度按视口实算。
 * 纯 CSS 的 max-height:calc(100vh - 96px) 只在「已经吸顶」时才对；
 * 首次进页面时侧栏还在搜索区下方（top≈270），按 100vh 定高会直接冲出屏幕底部，
 * 25 只自选时实测下沿到 1076px、视口只有 900 —— 最后几条点不到。
 * 这里按「当前实际 top」算可用高度，吸顶后自动放宽。 */
function fitSidebar() {
  const s = $('#wside');
  if (!s) return;
  if (window.innerWidth <= 1000) { s.style.maxHeight = ''; return; }
  const top = Math.max(s.getBoundingClientRect().top, 74);
  s.style.maxHeight = Math.max(300, window.innerHeight - top - 18) + 'px';
}

function watchBoot() {
  /* 从分享链接进来：先把清单合并进本机再渲染，否则会先闪一下空列表 */
  var imported = (window.WatchSync && WatchSync.applyFromUrl()) || 0;
  watchLoad();
  if (imported) setTimeout(function () { toast('已导入 ' + imported + ' 只自选股'); }, 700);

  var shareBtn = $('#wSideShare');
  if (shareBtn) shareBtn.addEventListener('click', function () { WatchSync.openSheet(); });

  fitSidebar();
  window.addEventListener('scroll', fitSidebar, { passive: true });
  window.addEventListener('resize', fitSidebar);
  /* 页面布局还会变（自选提示插入、板块行渲染、K线结果出来），
   * 每一次都可能把侧栏往下推，所以再挂一个尺寸监听兜住。 */
  if (window.ResizeObserver) {
    try { new ResizeObserver(() => fitSidebar()).observe(document.querySelector('.an-layout')); } catch (e) {}
  }

  /* 输入框实时候选：输名字（茅台 / 宁德）也能搜到，不用先知道代码。
   * 用的是随站发布的 a_share_all.json 全A清单，5910 只，离线也能搜。 */
  $('#wSideCode').addEventListener('input', (e) => watchSug(e.target.value));
  $('#wSideCode').addEventListener('focus', (e) => { if (e.target.value.trim()) watchSug(e.target.value); });
  $('#wSideCode').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('#wSideSug').classList.add('hidden'); e.target.blur(); }
  });
  $('#wSideSug').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-c]');
    if (!b) return;
    $('#wSideCode').value = '';
    $('#wSideSug').classList.add('hidden');
    watchAdd(b.dataset.c, b.dataset.n);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.wside-addwrap')) $('#wSideSug').classList.add('hidden');
  });

  $('#wSideAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('#wSideCode').value.trim();
    if (!raw) return;
    const hits = search(raw, 8);
    const lower = raw.toLowerCase();
    /* 精确命中（完整代码 / 纯代码 / 完全同名）优先，其次唯一结果。
     * 注意歧义：000001 既是「上证指数」也是「平安银行」，而 search() 给指数
     * 加权 +2，指数会排前面。加自选要的是个股，所以精确命中里优先非指数。 */
    const exactHits = hits.filter((i) => i.code === lower
      || i.code.replace(/^[a-z]+/, '') === lower
      || i.name === raw);
    const exact = exactHits.find((i) => i.kind !== 'index') || exactHits[0];
    const pick = exact || (hits.length === 1 ? hits[0] : null);
    if (pick) {
      $('#wSideCode').value = '';
      $('#wSideSug').classList.add('hidden');
      return watchAdd(pick.code, pick.name);
    }
    if (hits.length > 1) {
      watchSug(raw);
      toast('匹配到 ' + hits.length + ' 只，点一个');
      return;
    }
    watchAdd(raw);   // 清单里没有：再按代码直接试一次行情接口
  });

  $('#wSideList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); return watchDel(del.dataset.del); }
    const row = e.target.closest('.wrow');
    if (row) goStock(row.dataset.code);
  });

  /* 分析卡头部的「+ 加自选」 */
  $('#result').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (b) watchAdd(b.dataset.add, b.dataset.addname || '');
  });

  $('#wToggle').addEventListener('click', openDrawer);
  $('#wSideClose').addEventListener('click', closeDrawer);
  $('#wSideMask').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  /* 侧栏报价每 60 秒刷一次；页面在后台时不刷，切回来立刻补一次 */
  setInterval(() => { if (!document.hidden && WATCH.length) watchFill(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && WATCH.length) watchFill();
  });
}

/* ---------- 交互 ---------- */
let toastTimer;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

$('#goBtn').addEventListener('click', run);
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
$('#q').addEventListener('input', renderSug);
$('#q').addEventListener('focus', renderSug);
$('#sug').addEventListener('click', (e) => {
  const r = e.target.closest('.sug-row');
  if (!r) return;
  $('#q').value = r.dataset.code;
  $('#sug').classList.add('hidden');
  run();
});
$('#boardBar').addEventListener('click', (e) => {
  const b = e.target.closest('.bb');
  if (!b) return;
  BOARD = b.dataset.b;
  document.querySelectorAll('.bb').forEach((x) => x.classList.toggle('active', x === b));
  renderBoardList();
});
$('#boardList').addEventListener('click', (e) => {
  const r = e.target.closest('.bl-row');
  if (!r) return;
  $('#q').value = r.dataset.code;
  renderBoardList();
  run();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) $('#sug').classList.add('hidden');
});
$('#chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  $('#q').value = c.dataset.code;
  run();
});
$('#homeBtn').addEventListener('click', () => { location.href = 'index.html'; });
$('#refreshBtn').addEventListener('click', () => {
  CACHE = {};
  $('#refreshBtn').style.transform = 'rotate(360deg)';
  setTimeout(() => ($('#refreshBtn').style.transform = ''), 500);
  run();
});

init();