const { chromium } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = 'C:/Users/lenovo/WorkBuddy/2026-10-10-09-44-41';
const MIME = { '.html':'text/html;charset=utf-8', '.js':'application/javascript;charset=utf-8', '.css':'text/css;charset=utf-8', '.png':'image/png' };

const srv = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => srv.listen(8899, r));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('PAGEERR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://127.0.0.1:8899/analyze.html', { waitUntil: 'domcontentloaded' });
  // 清掉上次测试的清单缓存，确保走真实分页拉取
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.bb').length > 0, { timeout: 45000 });

  const boards = await page.$$eval('.bb', els => els.map(e => e.textContent.trim()));
  console.log('板块筛选条:', boards.join(' | '));

  // 逐个测试：创业板 / 科创板 / 北交所 / 深沪主板
  const cases = [
    ['sz300750', '创业板-宁德时代'],
    ['sz301308', '创业板-江波龙'],
    ['sh688981', '科创板-中芯国际'],
    ['sh688256', '科创板-寒武纪'],
    ['sh688041', '科创板-海光信息'],
    ['bj920047', '北交所-诺思兰德'],
    ['sh600519', '沪主板-贵州茅台'],
    ['sz000001', '深主板-平安银行'],
  ];

  for (const [code, label] of cases) {
    await page.fill('#q', code);
    await page.evaluate(() => { document.querySelector('#result').innerHTML = ''; });
    await page.click('#goBtn');
    let ok = false, name = '', sup = '', res2 = '', trend = '';
    try {
      await page.waitForFunction(() => {
        const r = document.querySelector('#result');
        return r && r.children.length > 0 && (
          r.querySelector('.head-card') || r.querySelector('.placeholder'));
      }, { timeout: 30000 });
      name = await page.$eval('#result .name-row h2', e => e.textContent).catch(() => '');
      if (!name) {
        const ph = await page.$eval('#result .placeholder h2', e => e.textContent).catch(() => '');
        name = '【' + ph + '】';
      }
      trend = await page.$eval('#result .name-row .tag', e => e.textContent).catch(() => '');
      const rows = await page.$$eval('#result .lv-table tbody tr', els =>
        els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
      sup = rows.filter(r => r.includes('S1') || r.includes('S2')).slice(0, 2)
        .map(r => r.replace(/^.*?(-?\d+\.?\d*)\s+(-?\d+\.\d+)%.*$/, (_, p, d) => `${p}(${d}%)`)).join(' ');
      res2 = rows.filter(r => r.includes('R1') || r.includes('R2')).slice(0, 2)
        .map(r => r.replace(/^.*?(-?\d+\.?\d*)\s+\+?(-?\d+\.\d+)%.*$/, (_, p, d) => `${p}(${d}%)`)).join(' ');
      ok = !!name && !name.includes('【');
    } catch (e) { name = '(超时)'; }
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(18)} ${code} -> ${name} [${trend}] 支撑:${sup} 压力:${res2}`);
    await page.waitForTimeout(900); // 避免连打触发行情源限流
  }

  // 名称搜索 + 简称
  for (const kw of ['宁德', '中芯', '寒武纪']) {
    const r = await page.evaluate(k => {
      const el = document.querySelector('#q');
      el.value = k;
      el.dispatchEvent(new Event('input'));
      return [...document.querySelectorAll('.sug-row .sg-name')].slice(0, 3).map(e => e.textContent);
    }, kw);
    console.log(`名称搜索「${kw}」->`, r.join(' / ') || '(无)');
  }

  // 板块筛选点击
  await page.click('.bb[data-b="科创板"]');
  await page.waitForSelector('.bl-row', { timeout: 8000 });
  const blCnt = await page.$$eval('.bl-row', e => e.length);
  const blHead = await page.$eval('.bl-head', e => e.textContent.trim());
  console.log('科创板列表:', blHead, `渲染${blCnt}行`);

  console.log(errors.length ? '\n错误:\n' + errors.join('\n') : '\n零 JS 错误');
  await browser.close();
  srv.close();
})().catch(e => { console.error('FATAL', e.message); srv.close(); process.exit(1); });
