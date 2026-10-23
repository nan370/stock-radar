/* 站内跳转补 sharecode。
 *
 * 发布出来的站点是"带分享码才能打开"的：访问 /analyze.html?... 而没带
 * sharecode 会直接 403「链接不完整」。用户是从分享链接进来的，第一页没问题，
 * 但页面里的站内链接（量化选股 / 个股分析 / 表单提交）都不带这个参数，
 * 一点就 403 —— 看起来就是"点了没反应/页面空了"。
 *
 * 这里统一处理，不改各处链接写法：
 *   1) 捕获阶段拦截站内 <a> 点击，缺 sharecode 就补上再跳；
 *   2) 给所有 GET 表单塞一个 hidden sharecode；
 *   3) 首次加载时把已有 <a href> 直接改写（中键/右键新开也正确）。
 */
(function () {
  'use strict';
  var RAW = new URLSearchParams(location.search).get('sharecode');
  if (!RAW) return;
  var SC = 'sharecode=' + encodeURIComponent(RAW);

  function isInternal(h) {
    return h && !/^(https?:|mailto:|tel:|javascript:|#)/i.test(h);
  }
  function withSC(h) {
    if (!isInternal(h) || h.indexOf('sharecode=') >= 0) return h;
    return h + (h.indexOf('?') >= 0 ? '&' : '?') + SC;
  }

  function rewriteLinks(root) {
    var list = (root || document).querySelectorAll('a[href]');
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var h = a.getAttribute('href');
      var fixed = withSC(h);
      if (fixed !== h) a.setAttribute('href', fixed);
    }
  }

  function fixForms() {
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) {
      var f = forms[i];
      if ((f.method || 'get').toLowerCase() !== 'get') continue;
      if (f.querySelector('input[name="sharecode"]')) continue;
      var el = document.createElement('input');
      el.type = 'hidden';
      el.name = 'sharecode';
      el.value = RAW;
      f.appendChild(el);
    }
  }

  /* 捕获阶段补码，动态插入的链接（表格行、候选卡片）也能覆盖。
   * 注意别把「新标签打开」吃掉：带修饰键 / 中键时只改 href，交给浏览器默认行为。 */
  document.addEventListener('click', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[href]') : null;
    if (!a) return;
    var h = a.getAttribute('href');
    var fixed = withSC(h);
    if (fixed === h) return;
    a.setAttribute('href', fixed);
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    location.href = fixed;
  }, true);

  document.addEventListener('DOMContentLoaded', function () {
    rewriteLinks(document);
    fixForms();
  });

  window.__withShareCode = withSC;
  window.__fixShareLinks = function (root) { rewriteLinks(root); fixForms(); };
})();
