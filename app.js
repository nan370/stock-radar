/* 股票看盘 — 云端数据 + 用户系统 */

/* 等待 SDK 就绪（异步多源加载，业务逻辑必须等它可用） */
function whenSDK() {
  if (window.WorkBuddyCloud) return Promise.resolve();
  if (window.__SDK_FAILED) return Promise.reject(new Error('云服务 SDK 加载失败'));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('云服务 SDK 加载超时')), 20000);
    const bad = () => { clearTimeout(t); rej(new Error('云服务 SDK 加载失败')); };
    document.addEventListener('wb-sdk-failed', bad, { once: true });
    const iv = setInterval(() => {
      if (window.WorkBuddyCloud) { clearInterval(iv); clearTimeout(t); res(); }
    }, 120);
  });
}

/* 云端后端（登录 / 自选同步 / AI 点评）只存在于 *.app.workbuddy.host，
 * 而那个域名在公网没有 DNS 记录。一旦站点部署到 GitHub Pages 或本机静态服务，
 * 云端必然连不上 —— 所以直接判定为「本机模式」，不去发那些注定失败的请求，
 * 也不给一个点了没反应的登录按钮。 */
const CLOUD_ON = /(^|\.)app\.workbuddy\.host$/.test(location.hostname);

const CFG = {
  /* 应用 2026-10-22 重建过（旧应用已删除），端点必须跟着换。
   * 行情数据已不再走云端，这里只剩登录与自选股会用。 */
  endpoint: 'https://stock-radar-93660.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  /* 2026-10-22 11:50 重新开通云服务后换的新密钥。
   * 旧密钥属于已删除的应用，服务端会直接返回 invalid_client，表现为「登录不上去」。 */
  publishableKey: 'wbpk_H9e0cje1nyLzxZcHf70i5Z_mYZE81FJOwiaOn2OmvQY3wwP1VL8uhOm',
};

let cloud = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => (v == null ? '--' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%');
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const wan = (v) => {
  if (v == null) return '--';
  const a = Number(v);
  return (a > 0 ? '+' : '') + (a / 10000).toFixed(2) + '亿';
};

let SECTORS = [], NEWS = [], user = null;
let QUOTES = {};      // code -> 实时行情（腾讯行情接口）
let QUOTE_TIME = '';  // 实时行情时间

/* ---------- 实时行情（腾讯行情接口 qt.gtimg.cn，浏览器可直连） ---------- */
const GBK_DEC = (() => { try { return new TextDecoder('gbk'); } catch (e) { return null; } })();
const nz = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
const QUOTE_BATCH = 60;   // 单次请求标的数，避免 URL 过长

async function fetchQuotes(codes, batch) {
  const out = {};
  const list = (codes || []).filter(Boolean);
  const step = Math.max(1, Math.min(batch || QUOTE_BATCH, 120));
  for (let i = 0; i < list.length; i += step) {
    const chunk = list.slice(i, i + step);
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
        // 时间字段位置随品种（指数/板块/个股/港美股）略有差异：先定位再取后续
        let ti = 30;
        for (let k = 26; k < 40; k++) {
          const s = (f[k] || '').trim();
          if (/^\d{14}$/.test(s) || /^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}/.test(s)) { ti = k; break; }
        }
        out[m[1]] = {
          name: (f[1] || '').trim(),
          price: nz(f[3], null),
          prevClose: nz(f[4], null),
          time: (f[ti] || '').trim(),
          change: nz(f[ti + 1], null),
          changePct: nz(f[ti + 2], null),
          high: nz(f[ti + 3], null),
          low: nz(f[ti + 4], null),
          amountWan: nz(f[ti + 7], null),      // 成交额（万元）
          turnoverRate: nz(f[ti + 8], null),   // 换手率 %
          amplitude: nz(f[ti + 13], null),     // 振幅 %
          volumeRatio: nz(f[ti + 19], null),   // 量比
        };
      }
    } catch (e) { /* 该批失败：由云端快照兜底，不阻塞页面 */ }
  }
  return out;
}

/* 成交额：万元 → 亿/万亿 */
function fmtAmount(wanVal) {
  if (wanVal == null || !isFinite(wanVal)) return null;
  const yi = wanVal / 10000;
  return yi >= 10000 ? (yi / 10000).toFixed(2) + '万亿' : yi.toFixed(yi >= 1000 ? 0 : 1) + '亿';
}

/* 行情时间 → HH:MM */
function hhmm(t) {
  const s = String(t || '').trim();
  if (/^\d{14}$/.test(s)) return s.slice(8, 10) + ':' + s.slice(10, 12);
  const m = /\s(\d{1,2}):(\d{2})/.exec(s);
  return m ? m[1].padStart(2, '0') + ':' + m[2] : '';
}

const dateOnly = (v) => {
  const d = new Date(v);
  return isNaN(d.getTime()) ? ''
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const liveOf = (code) => QUOTES[code] || null;

/* 指数/板块：实时值优先，取不到时回落云端快照 */
function liveNums(code, snap) {
  const q = liveOf(code) || {};
  return {
    live: q.price != null,
    name: q.name || (snap && snap.name) || '',
    value: q.price != null ? q.price : (snap ? Number(snap.last_value) : null),
    pct: q.changePct != null ? q.changePct : (snap ? Number(snap.change_pct) : null),
    chg: q.change != null ? q.change : (snap ? Number(snap.change_value) : null),
    amountWan: q.amountWan != null ? q.amountWan : null,
    turnoverRate: q.turnoverRate != null ? q.turnoverRate : null,
    amplitude: q.amplitude != null ? q.amplitude : null,
  };
}

/* ---------- 时钟 ---------- */
function tick() {
  const d = new Date();
  const w = '日一二三四五六'[d.getDay()];
  $('#clock').textContent =
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 周${w} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
setInterval(tick, 30000); tick();

/* ---------- 数据加载 ----------
 * 首页曾经完全靠云端表（market_index / sector_index / ...）撑起骨架，
 * 表一没建整个页面就是空白，而且报错只落在控制台，用户看到的是「什么都没有」。
 * 现在骨架内置、数据全部实时取：指数走腾讯，板块走东财，资讯走同花顺，
 * 云端只留给登录与自选股这些真正需要账户的功能。 */

const DEFAULT_INDEX = [
  { code: 'sh000001', name: '上证指数', market: 'SH' },
  { code: 'sz399001', name: '深证成指', market: 'SZ' },
  { code: 'sz399006', name: '创业板指', market: 'SZ' },
  { code: 'sh000688', name: '科创50', market: 'SH' },
  { code: 'sh000300', name: '沪深300', market: 'SH' },
  { code: 'sh000016', name: '上证50', market: 'SH' },
  { code: 'sz399905', name: '中证500', market: 'SZ' },
  { code: 'sz399106', name: '深证综指', market: 'SZ' },
];

async function loadAll(force) {
  const idxRows = DEFAULT_INDEX.map((r) => Object.assign({}, r));

  /* 指数报价与板块列表并行；任一失败都不影响另一块渲染 */
  const [qi, boards] = await Promise.all([
    fetchQuotes(idxRows.map((r) => r.code)).catch(() => ({})),
    (typeof Live !== 'undefined' && Live.fetchBoards)
      ? Live.fetchBoards(!!force).catch(() => [])
      : Promise.resolve([]),
  ]);
  QUOTES = Object.assign({}, qi);
  const secRows = boards || [];

  const probe = qi['sh000001'] || qi[idxRows[0].code];
  QUOTE_TIME = hhmm(probe && probe.time);

  /* 按实时涨跌幅重排，跌得最多的排最后，一眼看到强弱 */
  idxRows.sort((a, b) => (liveNums(b.code, b).pct || 0) - (liveNums(a.code, a).pct || 0));

  renderIndex(idxRows);
  SECTORS = secRows;
  renderSectors('行业');
  renderGainersLosers();

  /* 关键信号 / 板块异动 / 财经资讯：全部实时推导 */
  let live = { signals: [], anomalies: [], news: [], hint: {} };
  try {
    live = await Live.build({ idxRows: idxRows, secRows: secRows });
  } catch (e) {
    console.error('[Live] 推导失败', e && e.message);
  }
  NEWS = live.news || [];
  renderAnomalies(live.anomalies || []);
  renderSignals(live.signals || []);
  renderNews('全部');
  Live.applyHint(live.hint || {});
  buildMarquee(idxRows);

  /* 极端情况：连指数都取不到，必须明确告知，而不是留一片空白 */
  if (!Object.keys(QUOTES).length) {
    $('#indexHint').textContent = '行情接口暂时不可达，请稍后点「刷新数据」重试';
  }
  if (!secRows.length) {
    const sh = $('#sectorHint');
    if (sh) sh.textContent = '板块数据获取失败，请稍后重试';
  }
}

function buildMarquee(idx) {
  const html = idx.map((i) => {
    const m = liveNums(i.code, i);
    const c = m.pct > 0 ? 'u' : m.pct < 0 ? 'd' : '';
    return `<span><b>${esc(m.name)}</b> <span class="${c}">${Number(m.value).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${pct(m.pct)}</span></span>`;
  }).join('');
  $('#marquee').innerHTML = html + html;
}

function renderIndex(rows) {
  const hint = $('#indexHint');
  if (hint) hint.textContent = QUOTE_TIME ? `行情更新 ${QUOTE_TIME}` : '';
  $('#indexRow').innerHTML = rows.map((i) => {
    const m = liveNums(i.code, i);
    const amt = /^(sh|sz|bj|hk)/.test(i.code) ? fmtAmount(m.amountWan) : null;
    const volTxt = amt ? ` · 成交 ${amt}` : (i.volume && !m.live ? ` · 成交 ${esc(i.volume)}` : '');
    return `
    <div class="idx-card">
      <div class="idx-name">${esc(m.name)}<span class="idx-market">${esc(i.market)}</span></div>
      <div class="idx-val ${cls(m.pct)}">${Number(m.value).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
      <div class="idx-chg ${cls(m.pct)}">${pct(m.pct)} · ${m.chg > 0 ? '+' : ''}${Number(m.chg).toFixed(2)}${volTxt}</div>
    </div>`;
  }).join('');
}

/* 板块实时指标：涨跌幅/成交额(亿)/换手率/振幅，实时优先、云端兜底 */
function sectorNums(s) {
  const q = liveOf(s.code) || {};
  return {
    live: q.changePct != null || s._live,
    /* 拿不到报价时必须给 null，不能给 0：
     * 0.00% 看起来像「平盘」，会把「数据没取到」伪装成真实行情。 */
    pct: q.changePct != null ? q.changePct : (s.change_pct == null ? null : Number(s.change_pct)),
    amt: q.amountWan != null ? q.amountWan / 10000 : (s.turnover != null ? Number(s.turnover) : null),
    turn: q.turnoverRate != null ? q.turnoverRate : (s.turnover_rate != null ? Number(s.turnover_rate) : null),
    amp: q.amplitude != null ? q.amplitude : (s.amplitude != null ? Number(s.amplitude) : null),
  };
}

function renderSectors(type) {
  const rows = SECTORS.filter((s) => s.sector_type === type)
    .map((s) => ({ s, m: sectorNums(s) }))
    .sort((a, b) => (b.m.pct == null ? -999 : b.m.pct) - (a.m.pct == null ? -999 : a.m.pct));
  const hint = $('#sectorHint');
  if (hint) {
    if (!SECTORS.length) hint.textContent = '板块数据获取失败，点右上角「刷新数据」重试';
    else {
      const nI = SECTORS.filter((s) => s.sector_type === '行业').length;
      const nC = SECTORS.filter((s) => s.sector_type === '概念').length;
      hint.textContent = `实时行情 · 行业 ${nI} / 概念 ${nC} · 表格可滚动 · 更新 ${QUOTE_TIME || '—'}`;
    }
  }
  $('#sectorBody').innerHTML = rows.map(({ s, m }) => `
    <tr>
      <td><b>${esc(s.name)}</b></td>
      <td><span class="tag">${esc(s.sector_type)}</span></td>
      <td class="num ${cls(m.pct)}">${pct(m.pct)}</td>
      <td class="num">${m.amt != null ? Number(m.amt).toFixed(m.amt >= 100 ? 0 : 1) : '--'}</td>
      <td class="num">${m.turn != null ? Number(m.turn).toFixed(2) + '%' : '--'}</td>
      <td class="num">${m.amp != null ? Number(m.amp).toFixed(2) + '%' : '--'}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">暂无数据</td></tr>';
}

function renderGainersLosers() {
  const all = SECTORS.map((s) => ({ s, m: sectorNums(s) }));
  const list = (arr, n) => arr.slice(0, n).map((x, i) => `
    <div class="rank-item">
      <span class="rank-no">${i + 1}</span>
      <span class="rank-name">${esc(x.s.name)}<span class="rank-tag">${esc(x.s.sector_type)}</span></span>
      <span class="rank-pct ${cls(x.m.pct)}">${pct(x.m.pct)}</span>
    </div>`).join('');
  const up = all.filter((x) => x.m.pct > 0).sort((a, b) => b.m.pct - a.m.pct);
  const dn = all.filter((x) => x.m.pct < 0).sort((a, b) => a.m.pct - b.m.pct);
  $('#gainers').innerHTML = list(up, 8) || '<div class="empty">' + (SECTORS.length ? '暂无领涨板块' : '板块数据获取失败，点右上角「刷新数据」重试') + '</div>';
  $('#losers').innerHTML = list(dn, 8) || '<div class="empty">' + (SECTORS.length ? '暂无领跌板块' : '板块数据获取失败，点右上角「刷新数据」重试') + '</div>';
}

const SIG_CN = { bullish: '看多', bearish: '看空', neutral: '中性' };
const RISK_CN = { high: '高风险', medium: '中风险', low: '低风险' };

function renderSignals(rows) {
  const asof = rows.length ? dateOnly(rows[0].created_at) : '';
  $('#signalHint').textContent = rows.length
    ? `共 ${rows.length} 条 · 生成于 ${asof || '—'}`
    : '暂无信号';
  $('#signalGrid').innerHTML = rows.map((s) => `
    <div class="signal-card ${esc(s.signal_type)}">
      <div class="sig-top">
        <span class="sig-type ${esc(s.signal_type)}">${SIG_CN[s.signal_type] || esc(s.signal_type)}</span>
        <span class="risk">${RISK_CN[s.risk_level] || ''}</span>
      </div>
      <div class="sig-title">${esc(s.title)}</div>
      <div class="sig-target">影响对象：${esc(s.target || '全市场')}</div>
      <div class="sig-body">${esc(s.content)}</div>
      <div class="sig-advice"><b>操作建议：</b>${esc(s.advice)}</div>
    </div>`).join('');
}

function renderAnomalies(rows) {
  const hint = $('#anomalyHint');
  if (hint) hint.textContent = rows.length ? `生成于 ${dateOnly(rows[0].created_at) || '—'}` : '';
  $('#anomalyGrid').innerHTML = rows.map((a) => `
    <div class="anom-card ${esc(a.severity)}">
      <div class="anom-top">
        <span class="anom-name">${esc(a.sector_name)}</span>
        <span class="sev ${esc(a.severity)}">${a.anomaly_type} · ${Number(a.change_pct) > 0 ? '+' : ''}${Number(a.change_pct).toFixed(2)}%</span>
      </div>
      <div class="anom-desc">${esc(a.description)}</div>
      <div class="anom-row"><b>信号解读：</b>${esc(a.signal)}</div>
      <div class="anom-row"><b>操作建议：</b>${esc(a.suggestion)}</div>
    </div>`).join('');
}

function renderNews(cat) {
  const rows = cat === '全部' ? NEWS : NEWS.filter((n) => n.category === cat);
  const hint = $('#newsHint');
  if (hint) hint.textContent = NEWS.length ? `最新一条 ${dateOnly(NEWS[0].published_at) || '—'}` : '';
  $('#newsList').innerHTML = rows.map((n) => `
    <li class="news-item" data-url="${esc(n.url || '')}">
      <div class="news-body">
        <div class="news-title">${esc(n.title)}</div>
        <div class="news-sum">${esc(n.summary || '')}</div>
        <div class="news-meta">
          <span class="cat ${Number(n.importance) >= 5 ? 'important' : ''}">${esc(n.category)}</span>
          <span>${esc(n.source || '')}</span>
          ${Number(n.importance) >= 5 ? '<span class="imp">重要</span>' : ''}
          ${n.related_stock ? `<span>关联 ${esc(n.related_stock)}</span>` : ''}
        </div>
      </div>
    </li>`).join('') || '<li class="empty">暂无资讯</li>';
}

$$('#newsList')[0]?.addEventListener;
document.addEventListener('click', (e) => {
  const item = e.target.closest('.news-item');
  if (item && item.dataset.url) window.open(item.dataset.url, '_blank', 'noopener');
});

/* ---------- 标签页 ---------- */
$$('#sectorTabs .tab').forEach((t) => t.addEventListener('click', () => {
  $$('#sectorTabs .tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  renderSectors(t.dataset.type);
}));
$$('#newsTabs .tab').forEach((t) => t.addEventListener('click', () => {
  $$('#newsTabs .tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  renderNews(t.dataset.cat);
}));
$('#refreshBtn').addEventListener('click', () => {
  $('#refreshBtn').textContent = '刷新中…';
  loadAll(true).finally(() => setTimeout(() => ($('#refreshBtn').textContent = '刷新数据'), 600));
});

/* ---------- 登录 ---------- */
const showErr = (m) => ($('#loginErr').textContent = m || '');
const openModal = (id) => $('#' + id).classList.add('show');
const closeModal = (id) => $('#' + id).classList.remove('show');

$('#loginBtn').addEventListener('click', () => { showErr(''); openModal('loginModal'); });
$('#loginClose').addEventListener('click', () => closeModal('loginModal'));
$('#watchBtn').addEventListener('click', () => {
  openModal('watchModal');
  /* 每次打开都重新读一遍：登录状态可能变了、云端也可能在别的设备加过 */
  loadWatch();
  /* 顺手把标的清单备好，输入名字时才不用等 */
  loadInsts().catch(() => {});
});
$('#watchClose').addEventListener('click', () => closeModal('watchModal'));
$$('.modal').forEach((m) => m.addEventListener('click', (e) => {
  if (e.target === m) m.classList.remove('show');
}));

$$('.ltab').forEach((t) => t.addEventListener('click', () => {
  $$('.ltab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $$('.lpane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== t.dataset.method));
  showErr('');
}));

/* 密码登录 */
$('#pLoginBtn').addEventListener('click', async () => {
  const email = $('#pEmail').value.trim();
  const password = $('#pPass').value;
  if (!email || !password) return showErr('请填写邮箱和密码');
  showErr('');
  const btn = $('#pLoginBtn'); btn.textContent = '登录中…'; btn.disabled = true;
  const { data, error } = await cloud.auth.signInWithPassword({ email, password });
  btn.textContent = '登录 / 注册'; btn.disabled = false;
  if (error) {
    /* 应用重建过之后云库是空的，老账号已经不存在了 —— 这时服务端返回的也是
     * invalid_username_or_password，跟「密码打错」长得一样。提示里必须给出出路，
     * 否则用户会一直试密码。 */
    const bad = error.code === 'invalid_username_or_password' || error.kind === 'unauthenticated';
    return showErr(bad
      ? '邮箱或密码不正确。如果这个邮箱是第一次在这个站点登录，请改用「验证码登录」重新注册一次。'
      : (error.message || '登录失败，请稍后再试'));
  }
  onSignedIn(data.user);
});

/* 验证码登录 */
let pendingEmailOtp = null;
$('#oSendBtn').addEventListener('click', async () => {
  const email = $('#oEmail').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return showErr('请输入正确的邮箱地址');
  showErr('');
  const btn = $('#oSendBtn'); btn.textContent = '发送中…'; btn.disabled = true;
  const sent = await cloud.auth.sendOtp({ email });
  btn.disabled = false;
  if (sent.error) return showErr(sent.error.message);
  pendingEmailOtp = {
    email,
    verificationId: sent.data.verificationId,
    isExistingUser: sent.data.isExistingUser,
  };
  $('#oTip').textContent = sent.data.isExistingUser
    ? '验证码已发送至邮箱，请查收后输入'
    : '验证码已发送，请设置密码后完成注册';
  let n = 60;
  btn.textContent = `${n}s 后重发`;
  const timer = setInterval(() => {
    if (--n <= 0) { clearInterval(timer); btn.textContent = '重新获取'; btn.disabled = false; }
  }, 1000);
});

$('#oSubmitBtn').addEventListener('click', async () => {
  const p = pendingEmailOtp;
  const email = $('#oEmail').value.trim();
  const token = $('#oCode').value.trim();
  const password = $('#oPass').value;
  if (!p || p.email !== email) return showErr('请先为当前邮箱获取验证码');
  if (!token) return showErr('请输入验证码');
  if (!p.isExistingUser && password.length < 6) return showErr('新账号请设置至少 6 位密码');
  showErr('');
  const btn = $('#oSubmitBtn'); btn.textContent = '处理中…'; btn.disabled = true;
  const done = await cloud.auth.verifyOtp({
    email: p.email,
    verificationId: p.verificationId,
    isExistingUser: p.isExistingUser,
    token,
    password: p.isExistingUser ? undefined : password,
  });
  btn.textContent = '登录 / 注册'; btn.disabled = false;
  if (done.error) return showErr(done.error.message);
  pendingEmailOtp = null;
  onSignedIn(done.data.user);
});

/* 微信登录 */
$('#wxBtn').addEventListener('click', async () => {
  showErr('');
  const { data, error } = await cloud.auth.signInWithOAuth({ provider: 'wechat', redirectTo: location.origin });
  if (error) return showErr(error.message === '未打开微信登录' ? '该应用暂未开启微信登录，请使用邮箱登录' : error.message);
  location.assign(data.url);
});

function onSignedIn(u) {
  user = u;
  const name = (u.email || u.phone || '微信用户');
  $('#loginBtn').textContent = name.length > 12 ? name.slice(0, 12) + '…' : name;
  $('#loginBtn').classList.remove('primary');
  $('#loginBtn').classList.add('ghost');
  $('#loginBtn').onclick = async () => {
    await cloud.auth.signOut();
    user = null;
    $('#loginBtn').textContent = '登录';
    $('#loginBtn').classList.add('primary');
    $('#loginBtn').classList.remove('ghost');
    $('#loginBtn').onclick = null;
    showLogin();
  };
  $('#watchTip').textContent = `已登录：${name}。自选股保存在你的云端账户中，仅你可见。`;
  closeModal('loginModal');
  loadWatch();
}
function showLogin() {
  /* 退出登录后不再显示「请先登录」，直接回落到本机自选 */
  loadWatch();
}

/* ---------- 自选股 ----------
 * 有云端账户就存云端（多设备同步），没有就落本机 localStorage。
 * 以前没登录整个面板是一句「请先登录」，功能等于不存在。 */
const LS_WATCH = 'stockradar.watchlist.v1';
const lsRead = () => { try { return JSON.parse(localStorage.getItem(LS_WATCH) || '[]'); } catch (e) { return []; } };
const lsWrite = (arr) => { try { localStorage.setItem(LS_WATCH, JSON.stringify(arr)); } catch (e) {} };
const marketOf = (code) => (code.startsWith('hk') ? '港股' : code.startsWith('us') ? '美股' : 'A股');

let restoring = false;
async function loadWatch() {
  const local = lsRead();
  if (cloud) {
    const { data: s } = await cloud.auth.getSession().catch(() => ({ data: null }));
    if (s) {
      const { data, error } = await cloud.database.from('watchlist').select('*').order('id');
      if (!error) {
        const rows = data || [];
        /* 读到就镜像一份到本机。自选股以前只存云端，应用一重建就全没了
         * （云端库随应用删除、localStorage 又跟着域名走），这份镜像就是兜底。 */
        if (rows.length) lsWrite(rows.map((w) => ({ code: w.code, name: w.name, market: w.market })));
        /* 云端空、本机有：多半是换了应用或换了域名，把本机自选搬回云端 */
        if (!rows.length && local.length && !restoring) return restoreLocal(local);
        $('#watchTip').textContent = '已登录：自选股存在你的云端账户里，换设备也在。';
        return renderWatch(rows, false);
      }
      $('#watchTip').textContent = '云端自选读取失败，先显示本机自选。';
      return renderWatch(local, true);
    }
  }
  $('#watchTip').textContent = CLOUD_ON
    ? '未登录：自选股只存在这台设备的浏览器里，登录后可跨设备同步。'
    : '自选存在这台设备的浏览器里。换设备点「分享到其他设备」，打开链接即可导入。';
  renderWatch(local, true);
}

/* 把本机自选补传回云端账户 */
async function restoreLocal(list) {
  restoring = true;
  let ok = 0;
  for (const w of list) {
    const { error } = await cloud.database.from('watchlist')
      .insert({ code: w.code, name: w.name, market: w.market || marketOf(w.code) });
    if (!error || error.code === '23505') ok++;
  }
  restoring = false;
  if (ok) alert('已把本机保存的 ' + ok + ' 只自选股同步到你的云端账户。');
  loadWatch();
}
/* 代码归一化：600519 / sh600519 / SH600519 / 00700 都能收 */
function normCode(raw) {
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

function renderWatch(rows, local) {
  const list = Array.isArray(rows) ? rows : [];
  const ul = $('#watchList');
  const cnt = $('#watchCount');
  if (cnt) cnt.textContent = list.length ? `已添加 ${list.length} 只` : '';
  if (!list.length) {
    ul.innerHTML = '<li class="empty">还没有自选股。在上方输入代码（如 600519）后点「添加到自选」，' +
      '也可以在看个股分析时加进来。</li>';
    return;
  }
  ul.innerHTML = list.map((w) => {
    const id = w.id != null ? ` data-id="${esc(w.id)}"` : '';
    return `<li class="wrow" data-code="${esc(w.code)}"${id} title="点击查看个股分析">` +
      `<span class="w-main"><b>${esc(w.name || w.code)}</b>` +
      `<i>${esc(w.code)}${w.market ? ' · ' + esc(w.market) : ''}</i></span>` +
      `<span class="w-quote" data-q="${esc(w.code)}">--</span>` +
      `<span class="rm">删除</span></li>`;
  }).join('');
  fillQuotes(list.map((w) => w.code));
}

/* 自选列表里补实时价：只有名字没有价格的话，这个面板等于一个笔记本 */
async function fillQuotes(codes) {
  const q = await fetchQuotes(codes).catch(() => ({}));
  for (const c of codes) {
    const el = document.querySelector(`#watchList [data-q="${c}"]`);
    if (!el) continue;
    const d = q[c];
    if (!d || d.price == null || d.changePct == null) { el.textContent = '--'; continue; }
    el.className = 'w-quote ' + cls(d.changePct);
    el.innerHTML = `<b>${Number(d.price).toFixed(2)}</b><i>${pct(d.changePct)}</i>`;
  }
}
/* ---------- 自选：代码和名称都能加 ----------
 * 以前只认代码，输「茅台」会被当成一个叫"茅台"的代码，查不到名称就报错。
 * 这里用随站点发布的 a_share_all.json（5910 只）做本地检索，
 * 与个股分析页共用 localStorage 缓存，用户在那边看过清单这里就直接命中。 */
let INSTS = null;
const INST_KEY = 'wb_instrument_v3';

async function loadInsts() {
  if (INSTS) return INSTS;
  try {
    const raw = localStorage.getItem(INST_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && Array.isArray(o.rows) && o.rows.length > 100) { INSTS = o.rows; return INSTS; }
    }
  } catch (e) { /* 缓存坏了就重新拉 */ }
  try {
    const r = await fetch('a_share_all.json', { cache: 'force-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const arr = await r.json();
    INSTS = (arr || []).map((x) => ({
      code: x.norm || (String(x.market || '').toLowerCase() + x.code),
      name: x.name || '', board: x.board || '',
    }));
  } catch (e) {
    console.warn('[Watch] 标的清单不可用，只能按代码添加', e && e.message);
    INSTS = [];
  }
  return INSTS;
}

/* 名称前缀 / 名称包含 / 完整代码 / 纯代码 / 代码前缀 都能命中 */
function instSearch(list, q, limit) {
  const s = String(q || '').trim();
  if (!s || !list || !list.length) return [];
  const lower = s.toLowerCase();
  const out = [];
  for (const i of list) {
    const num = i.code.replace(/^[a-z]+/, '');
    let rank = 0;
    if (i.code === lower || num === lower) rank = 100;
    else if (i.name === s) rank = 95;
    else if (i.name.startsWith(s)) rank = 80;
    else if (i.name.includes(s)) rank = 60;
    else if (num.startsWith(lower) && /^\d{2,}$/.test(lower)) rank = 40;
    if (rank) out.push({ i, rank });
  }
  out.sort((a, b) => b.rank - a.rank);
  return out.slice(0, limit || 8).map((x) => x.i);
}

function renderMSug(q) {
  const box = $('#wSug');
  if (!box) return;
  const s = String(q || '').trim();
  if (!s) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const hits = instSearch(INSTS || [], s, 8);
  box.innerHTML = hits.length
    ? hits.map((i) => `<button type="button" class="msug-row" data-c="${esc(i.code)}" data-n="${esc(i.name)}">
        <span class="sg-name">${esc(i.name)}</span>
        <span class="sg-tag">${esc(i.board || '')}</span>
        <span class="sg-code mono">${esc(i.code)}</span></button>`).join('')
    : '<div class="sug-empty">没有匹配的股票，试试 6 位代码</div>';
  box.classList.remove('hidden');
}

async function addWatchEntry(raw, nameRaw) {
  const list = await loadInsts();
  let code = normCode(raw);
  let name = String(nameRaw || '').trim();
  /* 进来的是名字而不是代码：先在清单里解析成代码 */
  if (!/^(sh|sz|bj|hk|us)\d+$/.test(code) && list.length) {
    const hit = instSearch(list, String(raw || '').trim(), 1)[0];
    if (hit) { code = hit.code; name = name || hit.name; }
  }
  if (!code) return alert('请输入代码或名称，如 600519 / 茅台');
  if (!name) {
    const hit = (list || []).find((i) => i.code === code);
    name = (hit && hit.name) || '';
  }
  /* 名称不填就自己去行情里取，别逼用户手打「贵州茅台」 */
  if (!name) {
    const q = await fetchQuotes([code]).catch(() => ({}));
    name = (q[code] && q[code].name) || '';
  }
  if (!name) return alert('没查到「' + raw + '」，换个代码或名称试试');

  const btn = $('#wAddBtn'); btn.disabled = true; btn.textContent = '添加中…';
  try {
    if (cloud) {
      const { data: s } = await cloud.auth.getSession().catch(() => ({ data: null }));
      if (s) {
        const { error } = await cloud.database.from('watchlist').insert({ code, name, market: marketOf(code) });
        if (error && error.code !== '23505') return alert(error.message);
        if (error) return alert('该代码已在自选中');
        $('#wCode').value = ''; $('#wName').value = '';
        return loadWatch();
      }
    }
    const local = lsRead();
    if (local.some((w) => w.code === code)) return alert('该代码已在自选中');
    local.unshift({ code, name, market: marketOf(code) });
    lsWrite(local);
    $('#wCode').value = ''; $('#wName').value = '';
    loadWatch();
  } finally {
    btn.disabled = false; btn.textContent = '添加到自选';
  }
}

$('#wAddBtn').addEventListener('click', () => addWatchEntry($('#wCode').value, $('#wName').value));
/* 换设备（电脑⇄手机）时把自选清单搬过去：生成一个带清单的网址 */
if ($('#wShareBtn')) $('#wShareBtn').addEventListener('click', () => {
  if (!lsRead().length) return alert('自选股还是空的，先加几只再分享');
  WatchSync.openSheet();
});
$('#wCode').addEventListener('input', async (e) => {
  await loadInsts();
  renderMSug(e.target.value);
});
$('#wCode').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#wSug').classList.add('hidden'); e.target.blur(); }
  if (e.key === 'Enter') { e.preventDefault(); addWatchEntry($('#wCode').value, $('#wName').value); }
});
$('#wSug').addEventListener('click', (e) => {
  const b = e.target.closest('.msug-row');
  if (!b) return;
  $('#wCode').value = b.dataset.c;
  $('#wName').value = b.dataset.n;
  $('#wSug').classList.add('hidden');
  addWatchEntry(b.dataset.c, b.dataset.n);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.add-wrap')) $('#wSug')?.classList.add('hidden');
});
$('#watchList').addEventListener('click', async (e) => {
  const row = e.target.closest('.wrow');
  if (!row) return;
  const code = row.dataset.code;
  if (e.target.closest('.rm')) {
    lsWrite(lsRead().filter((w) => w.code !== code));
    if (row.dataset.id && cloud) {
      await cloud.database.from('watchlist').delete().eq('id', Number(row.dataset.id)).catch(() => {});
    }
    return loadWatch();
  }
  /* 点行直接看个股分析；sharelink.js 会补上 sharecode */
  location.href = 'analyze.html?code=' + encodeURIComponent(code);
});

/* ---------- 启动 ---------- */
async function boot() {
  /* 分享链接带进来的自选：先并进本机，再走原来的加载流程 */
  const imported = (window.WatchSync && WatchSync.applyFromUrl()) || 0;
  if (imported) {
    setTimeout(() => {
      try { openModal('watchModal'); } catch (e) {}
      const t = $('#watchTip');
      if (t) t.textContent = '已从这个分享链接导入 ' + imported + ' 只自选股。';
    }, 2600);
  }

  /* 行情先上，账户后管。
   * 以前的顺序是先 await 云 SDK、再鉴权，任何一步失败就直接 return，
   * 结果云服务一出问题整页空白 —— 行情数据根本不该依赖账户系统。 */
  loadAll().catch((e) => console.error('[loadAll] 失败', e && e.message));
  Live.startAutoRefresh();

  try {
    await whenSDK();
  } catch (e) {
    console.warn('[WorkBuddy Cloud] SDK 不可用，账户功能关闭', e && e.message);
    $('#loginBtn').textContent = '登录不可用';
    $('#loginBtn').title = '云服务 SDK 加载失败';
    $('#loginBtn').disabled = true;
    return loadWatch();
  }
  if (!CLOUD_ON) {
    /* 外部托管：账号系统不存在，自选用本机存储 + 分享链接搬移 */
    const b = $('#loginBtn');
    if (b) {
      b.textContent = '本机模式';
      b.title = '当前部署没有云端账号服务，无需登录。自选存在本机，换设备请用「分享到其他设备」。';
      b.addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        alert('当前是通过外部托管访问的，没有可用的云端账号，所以不需要登录。\n\n' +
              '自选股存在这台设备的浏览器里。换设备时：打开「我的自选」→ 点「分享到其他设备」→ 复制生成的链接，' +
              '在另一台设备上打开即可导入。');
      }, true);
    }
    return loadWatch();
  }
  cloud = WorkBuddyCloud.createWorkBuddyCloud(CFG);

  // 微信回调必须先于任何路由守卫执行
  const cb = await cloud.auth.handleWechatWebCallback().catch(() => ({}));
  if (cb && cb.error) console.error('[WorkBuddy Cloud] 微信回调失败', { message: cb.error.message });
  else if (cb && cb.data) {
    history.replaceState(null, '', location.pathname);
    onSignedIn(cb.data.user);
  }

  cloud.auth.onAuthStateChange((e) => { if (e === 'SIGNED_OUT') { user = null; loadWatch(); } });
  const { data: s } = await cloud.auth.getSession().catch(() => ({ data: null }));
  if (s) onSignedIn(s.user); else loadWatch();
}
boot();