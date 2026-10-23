/* ---------- 自选股 · 跨设备分享码 ----------
 *
 * 为什么需要它：云端自选库绑定在 *.app.workbuddy.host，这个域名在公网 DNS 里
 * 没有记录（手机 4G 解析不到），所以 GitHub Pages 版读不到云端，
 * 自选只能落在本机 localStorage —— 换设备、换浏览器就看不到。
 *
 * 这里用「把清单编码进网址」来搬：零账号、零后端、永不过期。
 * 代价是不自动同步，加完得再分享一次。
 */
(function () {
  'use strict';

  var KEY = 'stockradar.watchlist.v1';
  var MARK = '#w=';

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
  }

  function write(arr) {
    try { localStorage.setItem(KEY, JSON.stringify(arr)); } catch (e) {}
  }

  function marketOf(code) {
    if (code.indexOf('hk') === 0) return '港股';
    if (code.indexOf('us') === 0) return '美股';
    return 'A股';
  }

  /* 从地址栏 #w=... 读清单，合并进本机（只增不删，不覆盖已有）。
   * 返回新增条数；不确定的条目直接跳过，绝不把本地清单搞坏。 */
  function applyFromUrl() {
    var h = location.hash || '';
    if (h.indexOf(MARK) !== 0) return 0;

    var raw = '';
    try { raw = decodeURIComponent(h.slice(MARK.length)); } catch (e) { return 0; }

    var items = raw.split(';').map(function (s) {
      var i = s.indexOf(':');
      var code = (i < 0 ? s : s.slice(0, i)).trim();
      var name = i < 0 ? '' : s.slice(i + 1).trim();
      return code ? { code: code, name: name } : null;
    }).filter(Boolean);
    if (!items.length) return 0;

    var local = read();
    if (!Array.isArray(local)) local = [];

    var have = {};
    local.forEach(function (w) { if (w && w.code) have[w.code] = 1; });

    var added = 0;
    items.forEach(function (it) {
      if (have[it.code]) {
        /* 已有但名称为空（早期数据），顺手补上 */
        if (it.name) {
          for (var k = 0; k < local.length; k++) {
            if (local[k] && local[k].code === it.code && !local[k].name) local[k].name = it.name;
          }
        }
        return;
      }
      have[it.code] = 1;
      local.push({ code: it.code, name: it.name, market: marketOf(it.code) });
      added++;
    });

    if (added) write(local);

    /* 清掉 hash：刷新不再重复导入，地址栏也不拖一条长尾巴 */
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}

    return added;
  }

  /* 生成分享链接：一律指向个股分析页，那边右侧就是自选栏，导入后立刻看得见 */
  function buildLink() {
    var arr = read();
    if (!arr.length) return '';
    var payload = arr.map(function (w) { return w.code + ':' + (w.name || ''); }).join(';');
    var dir = location.pathname.replace(/[^/]*$/, '');
    return location.origin + dir + 'analyze.html' + MARK + encodeURIComponent(payload);
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 非安全上下文或权限被拒，走下面的兜底 */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function hint(msg) {
    if (typeof window.toast === 'function') {
      try { window.toast(msg); return; } catch (e) {}
    }
    alert(msg);
  }

  var sheet = null;

  function closeSheet() {
    if (sheet && sheet.parentNode) sheet.parentNode.removeChild(sheet);
    sheet = null;
  }

  function openSheet() {
    var url = buildLink();
    if (!url) {
      hint('自选股还是空的，先加几只再分享');
      return;
    }
    closeSheet();

    sheet = document.createElement('div');
    sheet.className = 'ws-sheet';
    sheet.innerHTML =
      '<div class="ws-card" role="dialog" aria-modal="true" aria-label="自选股分享链接">' +
      '  <h3>自选股分享链接</h3>' +
      '  <p>在另一台设备（手机或另一个浏览器）打开这个链接，自选股会自动导入并保留。</p>' +
      '  <textarea class="ws-url" readonly rows="4" spellcheck="false"></textarea>' +
      '  <div class="ws-acts">' +
      '    <button type="button" class="btn primary" data-act="copy">复制链接</button>' +
      '    <button type="button" class="btn" data-act="close">关闭</button>' +
      '  </div>' +
      '  <p class="ws-note">导入后两台设备各自独立。以后新增的自选，再分享一次即可。</p>' +
      '</div>';
    document.body.appendChild(sheet);

    var ta = sheet.querySelector('.ws-url');
    ta.value = url;
    ta.addEventListener('focus', function () { ta.select(); });

    sheet.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) {
        if (e.target === sheet) closeSheet();
        return;
      }
      if (btn.dataset.act === 'close') { closeSheet(); return; }
      if (copyText(url)) {
        btn.textContent = '已复制 ✓';
        setTimeout(function () { btn.textContent = '复制链接'; }, 2000);
      } else {
        ta.focus();
        ta.select();
        hint('请长按上面的链接手动复制');
      }
    });
  }

  window.WatchSync = {
    applyFromUrl: applyFromUrl,
    buildLink: buildLink,
    openSheet: openSheet,
    count: function () { return read().length; }
  };
})();
