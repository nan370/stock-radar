/* ==========================================================================
 * screen.js —— 量化选股页交互层
 * 依赖：chan.js / wyckoff.js / screener.js / backtest.js
 * ========================================================================== */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function n2(v, d) { return (v == null || !isFinite(v)) ? '—' : v.toFixed(d == null ? 2 : d); }
  function pctText(v) { return (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function cls(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : ''; }
  function yi(wan) {
    if (wan == null || !isFinite(wan)) return '—';
    var y = wan / 10000;
    return y >= 10000 ? (y / 10000).toFixed(2) + '万亿' : Math.round(y).toLocaleString() + '亿';
  }

  var state = { running: false, result: null, bt: null, btSet: 'all', env: null, autoTimer: null };
  var IDX = ['sh000001', 'sz399001', 'sz399006'];
  var GBK = (function () { try { return new TextDecoder('gbk'); } catch (e) { return null; } })();

  /* ------------------------------ 时间 ------------------------------ */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function tick() {
    var d = new Date();
    $('#clock').textContent = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' 周' + '日一二三四五六'[d.getDay()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function isTradingDay(d) { var w = d.getDay(); return w >= 1 && w <= 5; }
  function minOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }
  function isTradingNow() {
    var d = new Date();
    if (!isTradingDay(d)) return false;
    var m = minOfDay(d);
    return (m >= 565 && m <= 690) || (m >= 780 && m <= 900);   /* 9:25 出开盘价即有成交 */
  }
  /* 交易进度：用于把盘中未完成K线的成交量折算成全天预估量 */
  function tradingProgress() {
    var d = new Date();
    if (!isTradingDay(d)) return 1;
    var m = minOfDay(d);
    if (m < 565) return 0;
    if (m <= 690) return Math.max(0.05, (m - 570) / 120 * 0.5);
    if (m < 780) return 0.5;
    if (m <= 900) return 0.5 + (m - 780) / 120 * 0.5;
    return 1;
  }
  function ymd(d) {
    d = d || new Date();
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }
  function ymdDash(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /* ------------------------------ 行情 ------------------------------ */
  function withTimeout(ms) {
    var c = new AbortController();
    setTimeout(function () { c.abort(); }, ms);
    return c.signal;
  }

  function fetchQuotes(codes) {
    return fetch('https://qt.gtimg.cn/q=' + codes.join(','), { cache: 'no-store', signal: withTimeout(9000) })
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (buf) {
        var txt = GBK ? GBK.decode(buf) : new TextDecoder().decode(buf);
        var out = {};
        txt.split(';').forEach(function (line) {
          var m = /^v_([A-Za-z0-9]+)="([\s\S]*)"$/.exec(line.trim());
          if (!m) return;
          var f = m[2].split('~');
          if (f.length < 40) return;
          var ti = 30;
          for (var k = 26; k < 40; k++) {
            if (/^\d{14}$/.test((f[k] || '').trim())) { ti = k; break; }
          }
          out[m[1]] = {
            name: (f[1] || '').trim(), price: +f[3], prevClose: +f[4],
            pct: +f[ti + 2], change: +f[ti + 1],
            high: +f[ti + 3], low: +f[ti + 4], amount: +f[ti + 7],
            time: (f[ti] || '').trim(),
          };
        });
        return out;
      })
      .catch(function () { return {}; });
  }

  /* ------------------------------ 环境闸门 ------------------------------ */
  function buildEnv(liveEnv, basis, sampleN) {
    return Promise.all([
      fetchQuotes(IDX),
      Screener.fetchBars('sh000001', 'day', 160).catch(function () { return null; }),
    ]).then(function (res) {
      var q = res[0] || {}, bars = res[1];
      var sh = q['sh000001'] || {}, cyb = q['sz399006'] || {}, sz = q['sz399001'] || {};

      var ma20 = null, ma60 = null, above20 = null, above60 = null;
      if (bars && bars.length >= 60) {
        var s20 = 0, s60 = 0;
        for (var i = bars.length - 20; i < bars.length; i++) s20 += bars[i].c;
        for (var j = bars.length - 60; j < bars.length; j++) s60 += bars[j].c;
        ma20 = s20 / 20; ma60 = s60 / 60;
        var px = bars[bars.length - 1].c;
        above20 = px > ma20; above60 = px > ma60;
      }

      var score = 0;
      var reasons = [];
      if (sh.pct != null) {
        if (sh.pct > 0.3) { score += 2; reasons.push('上证 ' + pctText(sh.pct) + '，指数当日偏强'); }
        else if (sh.pct < -0.3) { score -= 2; reasons.push('上证 ' + pctText(sh.pct) + '，指数当日偏弱'); }
        else reasons.push('上证 ' + pctText(sh.pct) + '，指数日内窄幅');
      }
      if (above20 === true) { score += 2; reasons.push('指数运行在20日均线上方，中期结构未破'); }
      else if (above20 === false) { score -= 2; reasons.push('指数跌破20日均线，中期结构转弱'); }
      if (above60 === true && above20 === false) reasons.push('仍在60日均线上方，调整性质偏温和');
      if (liveEnv && liveEnv.total) {
        var ur = liveEnv.upRatio;
        if (ur > 0.55) { score += 1; reasons.push('全市场 ' + liveEnv.up + ' 涨 ' + liveEnv.down + ' 跌，普涨格局'); }
        else if (ur < 0.4) { score -= 1; reasons.push('全市场 ' + liveEnv.up + ' 涨 ' + liveEnv.down + ' 跌，普跌格局'); }
        else reasons.push('涨跌家数接近（' + liveEnv.up + ':' + liveEnv.down + '），结构性行情');
        if (liveEnv.limitDown > liveEnv.limitUp) { score -= 1; reasons.push('跌停 ' + liveEnv.limitDown + ' 家多于涨停 ' + liveEnv.limitUp + ' 家'); }
      }

      /* 盘前实时里没有涨跌数据，这里必须说明环境分的依据，
       * 否则「全市场 0 涨 0 跌」会被当成真实的市场宽度。 */
      if (basis === 'pre') {
        reasons.unshift('当日无成交数据（盘前或休市），涨跌家数取自上一交易日'
          + (sampleN ? '（样本 ' + sampleN + ' 只）' : '') + '，指数均线按最新收盘计算');
      } else if (basis === 'post') {
        reasons.unshift('按今日收盘数据统计，涨跌家数与量能为当日最终状态'
          + (sampleN ? '（样本 ' + sampleN + ' 只）' : ''));
      }

      var level = score >= 3 ? 'ok' : score >= -2 ? 'warn' : 'bad';
      var title = level === 'ok' ? '环境配合，可按计划建仓'
        : level === 'warn' ? '环境中性，控制仓位、只做强势确认'
          : '环境逆风，结构好的票也只能小仓试错';

      return {
        level: level, title: title, score: score, reasons: reasons,
        sh: sh, sz: sz, cyb: cyb,
        ma20: ma20, ma60: ma60, above20: above20, above60: above60,
        live: liveEnv,
        /* 环境只调仓位，不否决选股：结构好的票照常列出，但标注逆风并提示降仓 */
        positionAdvice: level === 'ok' ? '可按计划正常仓位'
          : level === 'warn' ? '建议半仓以内，单笔不超过总资金 10%'
            : '环境逆风：只做小仓试错或纯观察，单笔不超过 5%，跌破止损立即离场',
      };
    });
  }

  function renderGate(env) {
    var el = $('#gate');
    el.className = 'gate ' + (env.level === 'ok' ? 'ok' : env.level === 'bad' ? 'bad' : 'warn');
    var tag = $('#gateTag');
    tag.className = 'gate-tag ' + (env.level === 'ok' ? 'ok' : env.level === 'bad' ? 'bad' : 'warn');
    tag.textContent = env.level === 'ok' ? '偏强' : env.level === 'bad' ? '偏弱' : '中性';
    $('.gate-title').textContent = '市场环境闸门：' + env.title;

    $('#gateBody').innerHTML = env.reasons.map(function (r) { return '· ' + esc(r); }).join('<br>');

    var m = [];
    m.push('上证 <b class="' + cls(env.sh.pct) + '">' + n2(env.sh.price) + ' ' + pctText(env.sh.pct) + '</b>');
    m.push('创业板 <b class="' + cls(env.cyb.pct) + '">' + pctText(env.cyb.pct) + '</b>');
    if (env.ma20 != null) m.push('上证20日线 <b>' + n2(env.ma20) + '</b>（' + (env.above20 ? '上方' : '下方') + '）');
    if (env.live) m.push('两市上涨 <b>' + env.live.up + '</b> / 下跌 <b>' + env.live.down + '</b>');
    m.push('环境分 <b>' + env.score + '</b>');
    m.push('仓位建议 <b>' + esc(env.positionAdvice) + '</b>');
    $('#gateMetrics').innerHTML = m.join('');
  }

  /* ------------------------------ 进度 ------------------------------ */
  function setProgress(on, msg, pct) {
    var w = $('#progressWrap');
    if (on) w.classList.add('on'); else w.classList.remove('on');
    if (msg != null) $('#progressMsg').textContent = msg;
    if (pct != null) {
      $('#progressBar').style.width = Math.round(pct) + '%';
      $('#progressPct').textContent = Math.round(pct) + '%';
    }
  }

  /* ------------------------------ 渲染：候选 ------------------------------ */
  function levelLine(name, st, extra) {
    if (!st) return '<div class="lv-row"><span class="lv-name">' + name + '</span><span class="lv-struct">数据不足</span></div>';
    var dirCls = st.dir > 0 ? 'pos' : st.dir < 0 ? 'neg' : '';
    var posText = { above: '中枢上方', inside: '中枢内', below: '中枢下方', unknown: '—' }[st.position] || '—';
    var buy = st.buy && st.buy.grade ? '｜' + ({ first: '一买', second: '二买', third: '三买' }[st.buy.type] || '') : '';
    return '<div class="lv-row">' +
      '<span class="lv-name">' + name + '</span>' +
      '<span class="lv-dir ' + dirCls + '">' + (st.dir > 0 ? '向上' : st.dir < 0 ? '向下' : '不明') + '</span>' +
      '<span class="lv-struct">' + posText + buy + (extra ? '｜' + extra : '') + '</span>' +
      '</div>';
  }

  function planHtml(it) {
    var p = it.plan;
    var rows = [
      ['买入区间', n2(p.buyLo) + ' ~ ' + n2(p.buyHi), (p.widthPct ? '宽度 ' + p.widthPct.toFixed(1) + '%' : '') + (p.waitPullback ? '｜需等回踩' : '')],
      ['止损', n2(p.stop), p.stopReason],
      ['目标1', n2(p.target1), p.targetNote],
      ['目标2', n2(p.target2), '次级压力位'],
      ['盈亏比', p.rr ? p.rr.toFixed(2) : '—', p.rr2 ? '到目标2 为 ' + p.rr2.toFixed(2) : ''],
      ['单笔风险', p.riskPct != null ? p.riskPct.toFixed(1) + '%' : '—', '区间中值到止损的距离'],
    ];
    return rows.map(function (r) {
      return '<div class="plan-line"><span class="lb">' + r[0] + '</span><span class="vl">' + r[1] +
        '</span><span class="note">' + esc(r[2] || '') + '</span></div>';
    }).join('');
  }

  function levelHtml(it) {
    var sup = it.plan.supports.map(function (s) {
      return n2(s.price) + '<span style="color:#adb5bd;font-size:11px">（' + esc(s.labels.slice(0, 2).join('/')) + '）</span>';
    }).join('　');
    var res = it.plan.resistances.map(function (s) {
      return n2(s.price) + '<span style="color:#adb5bd;font-size:11px">（' + esc(s.labels.slice(0, 2).join('/')) + '）</span>';
    }).join('　');
    return '<div class="ev"><span class="k">支撑</span><span class="t">' + (sup || '—') + '</span></div>' +
      '<div class="ev"><span class="k">压力</span><span class="t">' + (res || '—') + '</span></div>';
  }

  function wyckoffHtml(it) {
    var w = it.wyckoff;
    if (!w) return '<div class="ev"><span class="k">量价</span><span class="t">数据不足</span></div>';
    var evs = w.events.length ? w.events.map(function (e) {
      return '<div class="ev"><span class="k">' + (e.daysAgo ? 'T-' + e.daysAgo : '当日') + '</span>' +
        '<span class="v ' + (e.dir > 0 ? 'p' : 'n') + '">' + (e.dir > 0 ? '多' : '空') + '</span>' +
        '<span class="t"><b>' + esc(e.name) + '</b><br>' + esc(e.detail) + '</span></div>';
    }).join('') : '<div class="ev"><span class="k">事件</span><span class="t">近 5 日无显著量价事件</span></div>';
    var cy = w.cycle;
    return '<div class="ev"><span class="k">阶段</span><span class="t"><b>' + esc(cy ? cy.name : w.phaseText) + '</b>｜量比 ' + w.volRatio.toFixed(2) +
      '｜区间分位 ' + (w.pos * 100).toFixed(0) + '%</span></div>' +
      (cy ? '<div class="ev"><span class="k">判据</span><span class="t">' + esc((cy.evidence || []).join('；')) + '</span></div>' : '') +
      evs;
  }

  function detailHtml(it) {
    var s = it.score;
    var detailRows = s.detail.map(function (d) {
      var vcls = /^\+/.test(d.v) ? 'p' : /^-/.test(d.v) ? 'n' : '';
      return '<div class="ev"><span class="k">' + esc(d.k) + '</span><span class="v ' + vcls + '">' + esc(d.v) +
        '</span><span class="t">' + esc(d.t) + '</span></div>';
    }).join('');

    return '<div class="detail-box">' +
      '<div class="detail-col">' +
        '<h4>四级结构<span class="sm">月 → 周 → 日 → 30F</span></h4>' +
        levelLine('月线', it.month, it.month && it.month.pivotCount ? it.month.pivotCount + '个中枢' : '') +
        levelLine('周线', it.week, it.week && it.week.pivotCount ? it.week.pivotCount + '个中枢' : '') +
        levelLine('日线', it.day, it.day && it.day.pivotCount ? it.day.pivotCount + '个中枢' : '') +
        levelLine('30分钟', it.m30, it.m30 ? '入场时机参考' : '数据不足') +
        '<h4 style="margin-top:14px">结构判定</h4>' +
        '<div class="ev"><span class="k">日线</span><span class="t">' + esc(it.day.buy ? it.day.buy.text : '—') + '</span></div>' +
        (it.day.diverg && it.day.diverg.type ? '<div class="ev"><span class="k">背驰</span><span class="t">' + esc(it.day.diverg.note) + '</span></div>' : '') +
        levelHtml(it) +
        '<h4 style="margin-top:14px">威科夫量价</h4>' + wyckoffHtml(it) +
        verifyHtml(it) +
      '</div>' +
      '<div class="detail-col">' +
        '<h4>评分明细<span class="sm">结构' + s.structure.toFixed(0) + ' / 量价' + s.volume.toFixed(0) +
          ' / 动量' + s.momentum.toFixed(0) + ' / 资金' + (s.money == null ? '缺' : s.money.toFixed(0)) +
          ' / 风险' + s.risk.toFixed(0) + (s.moneyMissing ? '（资金缺数据，总分按其余四项折算）' : '') + '</span></h4>' +
        detailRows +
        '<h4 style="margin-top:14px">交易计划</h4>' + planHtml(it) +
        '<div class="links">' +
          '<a class="link-a" href="analyze.html?code=' + encodeURIComponent(it.code) + '">打开完整技术分析 →</a>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* 源间价格核对标记。三个点分别对应腾讯 / 东财 / 同花顺：
   *   ✓ 一致   ~ 轻微偏离（多为快照时刻差）   ✗ 偏离过大   · 无数据
   * 放在标的下方，一眼能看出这只票的成交价有没有被多家行情源同时确认。 */
  function verifyTag(v) {
    if (!v) return '';
    var items = [{ k: 'tx', label: '腾讯' }, { k: 'em', label: '东财' }, { k: 'ths', label: '同花顺' }];
    var html = items.map(function (it) {
      var x = v[it.k];
      if (!x || x.dev == null) return '<i class="vk na" title="' + it.label + '：无数据">·</i>';
      var c = x.state === 'ok' ? 'ok' : x.state === 'warn' ? 'warn' : 'bad';
      var tip = it.label + ' 对比本页快照：偏离 ' + x.dev.toFixed(3) + '%' +
        (x.tol != null ? '（容差 ' + x.tol.toFixed(2) + '%' + (x.gapSec != null ? '，时差 ' + Math.round(x.gapSec) + 's' : '') + '）' : '');
      return '<i class="vk ' + c + '" title="' + esc(tip) + '">' +
        (c === 'ok' ? '✓' : c === 'warn' ? '~' : '✗') + '</i>';
    }).join('');
    return '<span class="verify-tag">' + html + '</span>';
  }

  function verifyHtml(it) {
    var v = it.verify;
    if (!v) return '<div class="ev"><span class="k">校验</span><span class="t">本次未参与源间校验</span></div>';
    var rows = [];
    var map = { tx: '腾讯行情', em: '东方财富', ths: '同花顺' };
    Object.keys(map).forEach(function (k) {
      var x = v[k];
      if (!x) { rows.push('<div class="ev"><span class="k">' + map[k] + '</span><span class="t" style="color:#adb5bd">无数据</span></div>'); return; }
      if (x.dev == null) { rows.push('<div class="ev"><span class="k">' + map[k] + '</span><span class="t" style="color:#adb5bd">' + esc(x.note || '无法比对') + '</span></div>'); return; }
      var c = x.state === 'ok' ? 'p' : x.state === 'warn' ? '' : 'n';
      rows.push('<div class="ev"><span class="k">' + map[k] + '</span>' +
        '<span class="v ' + c + '">' + x.dev.toFixed(3) + '%</span>' +
        '<span class="t">' + esc(x.note || '') +
        (x.tol != null ? '（容差 ' + x.tol.toFixed(2) + '%' + (x.gapSec != null ? '，快照时差 ' + Math.round(x.gapSec) + ' 秒' : '') + '）' : '') +
        '</span></div>');
    });
    return '<h4 style="margin-top:14px">源间核对<span class="sm">多家行情源相互印证</span></h4>' + rows.join('');
  }

  function pickTable(list) {
    var head = '<div class="cand-wrap"><div class="table-scroll"><table class="cand-table"><thead><tr>' +
      '<th>标的</th><th>评分</th><th class="num">现价</th><th>趋势</th>' +
      '<th class="num">买入区间</th><th class="num">止损</th><th class="num">目标</th>' +
      '<th class="num">盈亏比</th><th></th></tr></thead><tbody>';

    var body = list.map(function (it, i) {
      var s = it.score, p = it.plan;
      var trendTxt = (it.month ? (it.month.dir > 0 ? '月↑' : it.month.dir < 0 ? '月↓' : '月→') : '') +
        (it.week ? (it.week.dir > 0 ? ' 周↑' : it.week.dir < 0 ? ' 周↓' : ' 周→') : '') +
        (it.day && it.day.buy && it.day.buy.type !== 'none'
          ? ' ' + ({ first: '一买', second: '二买', third: '三买' }[it.day.buy.type] || '')
          : ' 日运行');
      var warn = '';
      if (p.waitPullback) warn = '<span class="warn-chip">等回踩</span>';
      if (it.pct != null && it.pct > 9) warn += '<span class="warn-chip">接近涨停</span>';
      if (it.partial) warn += '<span class="warn-chip">未完成K线</span>';
      if (it.envWarn) warn += '<span class="warn-chip">环境逆风</span>';

      return '<tr class="cand-row" data-idx="' + i + '">' +
        '<td><div class="cand-name">' + esc(it.name) + warn + '</div>' +
          '<div class="cand-code">' + it.code + (it.industry ? ' · ' + esc(it.industry) : '') +
          verifyTag(it.verify) + '</div></td>' +
        '<td><div class="score-cell"><span class="score-num">' + s.total + '</span>' +
          '<span class="grade ' + s.grade + '">' + s.grade + '</span></div>' +
          '<div class="cand-code">' + esc(s.gradeText) + '</div></td>' +
        '<td class="num"><div>' + n2(it.price) + '</div><div class="cand-pct ' + cls(it.pct) + '">' + pctText(it.pct) + '</div></td>' +
        '<td><div class="trend-cell"><div class="t1">' + trendTxt + '</div>' +
          '<div class="t2">' + esc(it.wyckoff ? it.wyckoff.phaseText : '') + '</div></div></td>' +
        '<td class="num"><span class="rng">' + n2(p.buyLo) + '<span class="sep">~</span>' + n2(p.buyHi) + '</span></td>' +
        '<td class="num"><span class="stop-v">' + n2(p.stop) + '</span></td>' +
        '<td class="num"><span class="tgt-v">' + n2(p.target1) + '</span></td>' +
        '<td class="num"><span class="rr-v ' + (p.rr >= 1.5 ? 'good' : p.rr < 1.2 ? 'bad' : '') + '">' +
          (p.rr ? p.rr.toFixed(2) : '—') + '</span></td>' +
        '<td style="color:#adb5bd;font-size:15px">›</td>' +
      '</tr>' +
      '<tr class="detail-row" data-detail="' + i + '" style="display:none"><td colspan="9">' + detailHtml(it) + '</td></tr>';
    }).join('');

    return head + body + '</tbody></table></div></div>';
  }

  /* 数据口径提示条。
   * 盘前（9:15 前）所有实时源都没有当日成交额，此时榜单只能基于上一交易日收盘。
   * 这个差别必须写在榜单正上方，否则用户会把昨天的信号当今天的买点。 */
  /* 数据口径提示条。三种状态必须分开写清楚：
   *   pre  盘前/休市：榜单基于上一交易日收盘，不能当今天的买点
   *   post 已收盘：用的是今日收盘价与完整K线，等于今天的最终结论
   *   live 盘中：最后一根K线未完成，信号可能随时变化
   * 之前只分「盘中/盘前」，收盘后会被标成「盘中实时」，这是错的。 */
  function renderBasis(result) {
    var bar = $('#basisBar');
    if (!bar) return;
    if (!result) { bar.style.display = 'none'; return; }

    bar.style.display = '';
    var srcTxt = srcText(result.src)
      + (result.srcList && result.srcList.length > 1
        ? '（' + result.srcList.map(srcText).join(' + ') + ' 交叉）' : '');

    if (result.basis === 'pre') {
      bar.className = 'basis-bar warn';
      bar.innerHTML = '<b>数据基准：' + esc(result.prevBar || '上一交易日') + ' 收盘</b>' +
        '当日尚无成交数据（' + esc(result.sessionLabel || '盘前') + '），量价与结构全部取自上一交易日。' +
        (result.seedN ? '已从流通市值靠前的 ' + result.seedN + ' 只重建量价，' : '') +
        '多周期精算 ' + result.all.length + ' 只。' +
        '<span class="basis-src">数据源 ' + esc(srcTxt) + '</span>';
    } else if (result.basis === 'post') {
      bar.className = 'basis-bar ok';
      bar.innerHTML = '<b>数据基准：今日收盘价</b>' +
        '当日已收盘，结构与交易计划用的是今日收盘价与完整日K线（不是未完成K线），' +
        '这批结果可直接用于次日开盘的委托规划。全市场 ' + result.universe + ' 只参与筛选，' +
        '精算 ' + result.all.length + ' 只。' +
        '<span class="basis-src">数据源 ' + esc(srcTxt) + '</span>';
    } else {
      bar.className = 'basis-bar live';
      bar.innerHTML = '<b>数据基准：盘中实时（' + esc(result.sessionLabel || '交易中') + '）</b>' +
        '当日K线未完成，最后一根按最新价刷新，依赖它的判定标记为「未确认」，' +
        '尾盘前信号仍可能翻转。全市场 ' + result.universe + ' 只参与筛选，' +
        '精算 ' + result.all.length + ' 只。' +
        '<span class="basis-src">数据源 ' + esc(srcTxt) + '</span>';
    }
  }

  function srcText(s) {
    return ({
      em: '东方财富', sina: '新浪财经', tx: '腾讯行情', ths: '同花顺', tencent: '腾讯行情',
      eastmoney: '东方财富',
      'em(抽样)': '东财(抽样)', 'sina(抽样)': '新浪(抽样)',
      'em+daily': '东方财富 + 腾讯日线', 'sina+daily': '新浪财经 + 腾讯日线',
      'tx+daily': '腾讯行情 + 日线', 'tencent+daily': '腾讯行情 + 日线',
    })[s] || (s || '未知');
  }

  /* 数据源面板：把「现在到底哪几家能用、数据对不对得上」摆到明面上。
   * 单源静默降级的问题在于：用户不知道眼前的结果是四源交叉来的，
   * 还是一家随时会挂的接口给的。 */
  function renderSources(result) {
    var grid = $('#srcGrid'), list = $('#crossList'), hint = $('#srcHint'), dot = $('#srcDot');
    if (!grid) return;
    if (!result) return;

    var feeds = result.feeds || [];
    var cross = result.cross || {};

    var okN = 0, liveN = 0;
    grid.innerHTML = feeds.map(function (s) {
      var st, txt;
      if (s.offline) { st = 'off'; txt = '离线基准'; }
      else if (s.state === 'ok') { st = 'ok'; txt = '可用'; okN++; liveN++; }
      else if (s.state === 'down') { st = 'bad'; txt = '不可用'; liveN++; }
      else { st = 'idle'; txt = '未参与'; }

      var meta = [];
      if (s.ok) meta.push('成功 ' + s.ok);
      if (s.fail) meta.push('失败 ' + s.fail);
      if (s.lastMs) meta.push(s.lastMs + 'ms');

      return '<div class="src-card ' + st + '">' +
        '<div class="sc-top"><span class="sc-name">' + esc(s.name) + '</span>' +
        '<span class="sc-state">' + txt + '</span></div>' +
        '<div class="sc-role">' + esc(s.role) + '</div>' +
        '<div class="sc-meta">' + esc(meta.join(' · ') || '—') + '</div>' +
        (s.lastErr ? '<div class="sc-err" title="' + esc(s.lastErr) + '">' + esc(s.lastErr) + '</div>' : '') +
        '</div>';
    }).join('');

    /* 交叉校验四层：全市场（两源全域）/ 抽样（点名核对）/ 候选（逐只比价）/ 入榜（第三方复核）。
     * 一致率替代「是否相同」——不同源的快照时刻本就不同，要求完全相等会把正常数据判成错误。 */
    var rows = [];

    function rateCls(r) { return r >= 0.95 ? 'ok' : r >= 0.8 ? 'warn' : 'bad'; }

    var u = cross.universe;
    if (u && u.common) {
      rows.push({
        name: '全市场交叉', src: srcText(u.refSrc) + ' ↔ ' + srcText(u.candSrc),
        n: u.common, rate: u.agreeRate, med: u.median,
        note: u.sampled ? '对方仅返回抽样 ' + u.common + ' 只' : '全域逐只比对',
      });
    }

    var sm = cross.sample;
    if (sm && !sm.error && sm.n) {
      rows.push({
        name: '抽样点名核对', src: srcText(sm.refSrc) + ' ↔ 东财批量',
        n: sm.n, rate: sm.agreeRate, med: sm.median,
        note: '按代码点名 ' + sm.asked + ' 只，最大偏离 ' + sm.max.toFixed(2) + '%',
      });
    }

    var pl = cross.pool;
    if (pl) {
      var n = pl.txN + pl.emN;
      var ok = pl.txOk + pl.emOk;
      rows.push({
        name: '候选池逐只', src: '腾讯 ' + pl.txN + ' 只 · 东财 ' + pl.emN + ' 只',
        n: n, rate: n ? ok / n : null, med: null,
        note: pl.reliable ? '两条独立线均通过' :
          (pl.worst && pl.worst.length ? '偏离最大：' + pl.worst[0].name + ' ' + pl.worst[0].dev.toFixed(2) + '%' : ''),
      });
    }

    var th = cross.ths;
    if (th && th.n) {
      rows.push({
        name: '入榜第三方复核', src: '同花顺（带精确时间戳）',
        n: th.n, rate: th.rate, med: null,
        note: '按快照时间差动态放宽容差',
      });
    }

    if (!rows.length) {
      list.innerHTML = '<div class="cross-empty">本次只有单一数据源可用，无法交叉校验。' +
        '此时结果仍可参考，但缺少源间互证。</div>';
    } else {
      list.innerHTML = rows.map(function (r) {
        var rate = r.rate == null ? null : r.rate;
        return '<div class="cross-row ' + (rate == null ? 'na' : rateCls(rate)) + '">' +
          '<span class="cr-name">' + esc(r.name) + '</span>' +
          '<span class="cr-src">' + esc(r.src) + '</span>' +
          '<span class="cr-n">' + (r.n || '—') + ' 只</span>' +
          '<span class="cr-rate">' + (rate == null ? '—' : (rate * 100).toFixed(1) + '%') + '</span>' +
          '<span class="cr-note">' + esc(r.note || '') + '</span>' +
          '</div>';
      }).join('');
    }

    var bad = feeds.filter(function (s) { return !s.offline && s.state === 'down'; });
    $('#srcHint').textContent = okN + '/' + liveN + ' 源可用 · ' +
      (rows.length ? rows.length + ' 层交叉' : '无交叉') +
      (bad.length ? ' · ' + bad.map(function (s) { return s.name; }).join('、') + ' 不可用' : '');
    if (dot) dot.className = 'dot ' + (bad.length ? 'warn' : (okN ? 'ok' : ''));
  }

  function renderPicks(result) {
    var list = result.picked;
    var ts = new Date(result.ts);
    var isPre = result.basis === 'pre';
    $('#lastRun').textContent = '更新 ' + pad(ts.getHours()) + ':' + pad(ts.getMinutes()) +
      ' · 耗时 ' + (result.elapsed / 1000).toFixed(1) + 's' +
      ' · ' + ({ pre: '上一交易日', live: '盘中', post: '收盘' }[result.basis] || '');
    renderBasis(result);
    renderSources(result);

    if (!list.length) {
      $('#pickArea').innerHTML = '<div class="empty-state"><b>本次没有满足全部条件的标的</b>' +
        '入榜要求综合分 ≥ 45、盈亏比 ≥ 1.2、日线结构未破坏且至少两级结构共振。' +
        '当前市场下强行凑数只会带来亏损，建议从下方观察名单里等回踩确认，或空仓等待环境转好。' +
        '<br><span class="es-note">注意：高分不等于可买。观察名单里常有 70~85 分的票卡在盈亏比上——' +
        '上方压力太近，空间不够赔率，买进去赢面大但赚得少，不划算。</span>' +
        (isPre ? '<br><span style="color:#b8860b">本次基于 ' + esc(result.prevBar || '上一交易日') +
          ' 收盘数据计算，精算样本 ' + result.all.length + ' 只。</span>' : '') + '</div>';
      $('#pickHint').textContent = '0 只合格 / 精算 ' + result.all.length + ' 只' +
        (isPre ? ' · 昨日基准' : '');
      return;
    }

    $('#pickHint').textContent = list.length + ' 只合格 · 精算 ' + result.all.length +
      ' 只 · 候选池 ' + result.pool + ' 只' +
      (isPre ? ' · 昨日基准' : '') +
      (state.env && state.env.level === 'bad' ? ' · 环境逆风，建议降仓' : '');
    $('#pickArea').innerHTML = pickTable(list);

    $$('.cand-row').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var idx = tr.getAttribute('data-idx');
        var d = document.querySelector('.detail-row[data-detail="' + idx + '"]');
        if (!d) return;
        var open = d.style.display !== 'none';
        d.style.display = open ? 'none' : 'table-row';
        tr.classList.toggle('open', !open);
      });
    });
  }

  function renderWatch(list) {
    var blk = $('#watchBlock');
    if (!list.length) { blk.style.display = 'none'; return; }
    blk.style.display = '';
    $('#watchHint').textContent = list.length + ' 只结构尚可但未达建仓门槛';

    $('#watchGrid').innerHTML = list.map(function (it) {
      var p = it.plan, s = it.score;
      var why = [];
      if (!(p.rr >= 1.2)) why.push('盈亏比 ' + (p.rr ? p.rr.toFixed(2) : '—') + ' 偏低');
      if (s.total < 45) why.push('综合分 ' + s.total + ' 未达标');
      if (s.levelHit < 2) why.push('结构共振仅 ' + s.levelHit + ' 级');
      if (it.day.buy && it.day.buy.type === 'none' && !it.day.buy.running) why.push('日线结构走弱');
      if (p.waitPullback) why.push('需等回踩至 ' + n2(p.buyLo) + ' 附近');

      return '<div class="watch-card" data-code="' + it.code + '">' +
        '<div class="wc-top"><span class="wc-name">' + esc(it.name) + '</span>' +
          '<span class="wc-score">' + s.total + '</span></div>' +
        '<div class="wc-line">' + it.code + ' · ' + n2(it.price) + ' <span class="' + cls(it.pct) + '">' + pctText(it.pct) + '</span></div>' +
        '<div class="wc-line">区间 ' + n2(p.buyLo) + '~' + n2(p.buyHi) + ' ｜ 盈亏比 ' + (p.rr ? p.rr.toFixed(2) : '—') + '</div>' +
        '<div class="wc-why">' + esc(why.join('；') || '等待结构进一步确认') + '</div>' +
      '</div>';
    }).join('');

    $$('.watch-card').forEach(function (c) {
      c.addEventListener('click', function () {
        location.href = 'analyze.html?code=' + encodeURIComponent(c.getAttribute('data-code'));
      });
    });
  }

  /* ------------------------------ 渲染：回测 ------------------------------ */
  function btStat(k, v, n) {
    return '<div class="bt-stat"><div class="k">' + k + '</div><div class="v">' + v + '</div>' +
      (n ? '<div class="n">' + n + '</div>' : '') + '</div>';
  }

  /* ------------------------------ 分数分层校验 ------------------------------
   * 打分权重以前是「看起来合理」就定下了，没有任何数据支持。这里用同一批
   * 历史回测，按综合分把候选池切成 5 桶，看每桶的实际期望收益：
   *   如果高分桶期望更高、且大体单调，说明权重方向是对的；
   *   如果不单调甚至反向，说明权重需要重估 —— 页面会直接把这个结论写出来，
   *   而不是继续展示一个「看起来 80 分很靠谱」的数字。
   * 局限同样写在页面上：样本内、样本是当天筛出来的票、每桶标的数很少。 */
  function renderBuckets(res) {
    var box = $('#btBucket');
    if (!box) return;
    var rows = (res.rows || []).filter(function (r) { return r._score != null && r.all && r.all.n; });
    if (rows.length < 5) { box.innerHTML = '<p class="bt-note">样本不足 5 只，无法做分数分层校验。</p>'; return; }

    var DEFS = [
      { k: '≥ 70 分', lo: 70, hi: 999 },
      { k: '60 ~ 69', lo: 60, hi: 70 },
      { k: '50 ~ 59', lo: 50, hi: 60 },
      { k: '42 ~ 49', lo: 42, hi: 50 },
      { k: '< 42', lo: -999, hi: 42 },
    ];

    function agg(list) {
      var trades = [];
      list.forEach(function (r) { trades = trades.concat(r.allTrades || []); });
      if (!trades.length) return null;
      var wins = trades.filter(function (t) { return t.netPct > 0; });
      var sum = trades.reduce(function (a, t) { return a + t.netPct; }, 0);
      return {
        n: list.length, trades: trades.length,
        winRate: wins.length / trades.length,
        exp: sum / trades.length,
      };
    }

    var all = agg(rows);
    var buckets = DEFS.map(function (d) {
      var list = rows.filter(function (r) { return r._score >= d.lo && r._score < d.hi; });
      return { k: d.k, s: agg(list) };
    }).filter(function (b) { return b.s; });

    if (!all || buckets.length < 2) {
      box.innerHTML = '<p class="bt-note">分层后没有可统计的成交，暂时无法校验。</p>';
      return;
    }

    var body = buckets.map(function (b) {
      var diff = b.s.exp - all.exp;
      return '<tr><td>' + b.k + '</td><td class="num">' + b.s.n + '</td><td class="num">' + b.s.trades + '</td>' +
        '<td class="num">' + (b.s.winRate * 100).toFixed(0) + '%</td>' +
        '<td class="num ' + (b.s.exp > 0 ? 'good' : 'bad') + '">' + (b.s.exp > 0 ? '+' : '') + b.s.exp.toFixed(2) + '%</td>' +
        '<td class="num">' + (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%</td></tr>';
    }).join('');

    /* 单调性：用「桶序号 × 期望」的秩相关粗略判断方向是否一致。
     * 桶序号 0 是最高分，所以同向时相关系数应为负。 */
    var xs = buckets.map(function (b, i) { return i; });
    var ys = buckets.map(function (b) { return b.s.exp; });
    var mx = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
    var my = ys.reduce(function (a, b) { return a + b; }, 0) / ys.length;
    var num = 0, dx = 0, dy = 0;
    xs.forEach(function (x, i) {
      num += (x - mx) * (ys[i] - my);
      dx += (x - mx) * (x - mx);
      dy += (ys[i] - my) * (ys[i] - my);
    });
    var rho = (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : 0;

    var verdict = rho <= -0.5
      ? '<b>分层基本单调</b>：分数越高的桶，历史每笔期望越高 —— 权重方向与数据一致。'
      : rho >= 0.3
        ? '<b>分层反向</b>：分数越高的桶期望反而越低。这通常意味着样本期这类结构失效，或权重把「已经涨完」当成了「结构好」，入榜名单要打折看。'
        : '<b>分层不单调</b>：高分区没有明显优势，说明权重里有一项在拖后腿，需要重估（下一步该做的是逐项去权重看边际贡献）。';

    box.innerHTML =
      '<div class="bt-year" style="margin-top:12px"><b>分数分层校验</b>　' +
      '全样本基准：' + all.trades + ' 笔、每笔期望 ' + (all.exp > 0 ? '+' : '') + all.exp.toFixed(2) + '%、胜率 ' + (all.winRate * 100).toFixed(0) + '%</div>' +
      '<table class="bucket-table"><thead><tr><th>综合分桶</th><th class="num">标的</th><th class="num">成交笔数</th>' +
      '<th class="num">胜率</th><th class="num">每笔期望</th><th class="num">相对基准</th></tr></thead><tbody>' +
      body + '</tbody></table>' +
      '<p class="bt-note" style="margin-top:10px">' + verdict +
      '　秩相关 ' + rho.toFixed(2) + '（-1 表示完全单调：分数越高越好）。' +
      '注意：这是<b>样本内</b>校验，样本只覆盖本次候选池里拉到 260 根以上日线的 ' + rows.length +
      ' 只票，且这些票本身就是今天量价筛出来的，存在选择偏差；每桶成交笔数少，差异可能来自运气。' +
      '它的用途是「发现自己是不是在自欺」，不是收益承诺。</p>';
  }

  function renderBacktest(res) {
    if (!res || !res.summary || !res.summary.all || !res.summary.all.n) {
      $('#btBlock').style.display = 'none';
      return;
    }
    $('#btBlock').style.display = '';
    var set = state.btSet === 'trend' ? res.summary.trend : res.summary.all;
    if (!set || !set.n) {
      $('#btGrid').innerHTML = '<div class="bt-stat" style="grid-column:1/-1"><div class="k">该口径下无成交</div>' +
        '<div class="v" style="font-size:14px">叠加过滤后样本为空</div></div>';
      $('#btYear').innerHTML = '';
      $('#btNote').innerHTML = '样本内该组信号为 0 笔，无法统计。';
      return;
    }

    $('#btHint').textContent = '共 ' + res.totalTrades + ' 笔 · 样本 ' + (res.sampleSize || res.rows.length) + ' 只 · ' +
      (res.range ? res.range.from + ' ~ ' + res.range.to : '') + ' · 样本内';

    $('#btGrid').innerHTML =
      btStat('每笔期望收益', (set.expectancy > 0 ? '+' : '') + set.expectancy.toFixed(2) + '%', '已扣 0.2% 往返成本') +
      btStat('胜率', (set.winRate * 100).toFixed(1) + '%', set.n + ' 笔交易') +
      btStat('盈亏比', set.payoff ? set.payoff.toFixed(2) : '—', '平均盈 ' + set.avgWin.toFixed(1) + '% / 平均亏 ' + set.avgLoss.toFixed(1) + '%') +
      btStat('平均持有', set.avgHold.toFixed(1) + '日', '止盈 ' + set.targetCount + ' / 止损 ' + set.stopCount + ' / 到期 ' + set.timeCount) +
      btStat('交易序列回撤', set.maxDD.toFixed(1) + '%', '按平仓顺序连乘');

    $('#btYear').innerHTML = set.yearStats.map(function (y) {
      var good = y.avg > 0;
      return '<div class="yc">' + y.year + '：<b class="' + (good ? 'pos' : 'neg') + '">' +
        (y.avg > 0 ? '+' : '') + y.avg.toFixed(2) + '%</b> · ' + y.n + '笔 · 胜率 ' + (y.winRate * 100).toFixed(0) + '%</div>';
    }).join('') + set.typeStats.map(function (t) {
      return '<div class="yc">' + t.type + '：<b>' + (t.avg > 0 ? '+' : '') + t.avg.toFixed(2) + '%</b> · ' +
        t.n + '笔 · 胜率 ' + (t.winRate * 100).toFixed(0) + '%</div>';
    }).join('');

    var better = res.summary.trend && res.summary.trend.n && res.summary.all &&
      res.summary.trend.expectancy > res.summary.all.expectancy;
    $('#btNote').innerHTML =
      '<b>样本说明：</b>回测对象是本次候选池前 ' + (res.sampleSize || res.rows.length) +
      ' 只，不是全市场随机样本——这些票是今天量价筛出来的，本身已带选择偏差，所以下面的数字应视为<b>上限</b>而非预期收益。' +
      '信号按次日开盘成交、扣除往返 0.2% 成本，参数未做样本外调优，全部为<b>样本内</b>结果。<br>' +
      '<b>要注意：</b>分年度差异极大（好年份与差年份每笔期望可以差 5 个百分点以上），说明策略高度依赖市场环境，' +
      '这也正是上方保留环境闸门的原因。单只标的往往只有十几笔信号，统计不具显著性，请以汇总结果为准。<br>' +
      '<b>级别过滤：</b>' + (better
        ? '叠加月周过滤后期望收益提升、回撤下降，说明上级别方向确实过滤掉了部分逆势交易。'
        : '叠加月周过滤后收益未提升，说明当前样本下级别过滤的增益有限，使用时以结构本身为主、级别方向作参考。');

    renderBuckets(res);

    $$('.bt-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-set') === state.btSet);
    });
  }

  /* ------------------------------ 昨日追踪 ------------------------------ */
  function saveHistory(result) {
    try {
      var key = 'screen_hist_' + ymdDash();
      var payload = {
        date: ymdDash(),
        ts: result.ts,
        items: result.picked.map(function (it) {
          return {
            code: it.code, name: it.name, score: it.score.total,
            price: it.price, buyLo: it.plan.buyLo, buyHi: it.plan.buyHi,
            stop: it.plan.stop, target: it.plan.target1,
          };
        }),
      };
      localStorage.setItem(key, JSON.stringify(payload));
      var keys = Object.keys(localStorage).filter(function (k) { return k.indexOf('screen_hist_') === 0; }).sort();
      keys.slice(0, Math.max(0, keys.length - 10)).forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* 隐私模式下不可用，忽略 */ }
  }

  function renderTrack() {
    var keys = Object.keys(localStorage).filter(function (k) { return k.indexOf('screen_hist_') === 0; }).sort();
    var today = 'screen_hist_' + ymdDash();
    var prevKey = null;
    for (var i = keys.length - 1; i >= 0; i--) {
      if (keys[i] !== today) { prevKey = keys[i]; break; }
    }
    if (!prevKey) return;

    var rec;
    try { rec = JSON.parse(localStorage.getItem(prevKey)); } catch (e) { return; }
    if (!rec || !rec.items || !rec.items.length) return;

    fetchQuotes(rec.items.map(function (x) { return x.code; })).then(function (q) {
      var rows = rec.items.map(function (x) {
        var cur = q[x.code];
        if (!cur || !cur.price) return null;
        var chg = (cur.price - x.price) / x.price * 100;
        var hitStop = cur.price <= x.stop;
        var hitTgt = cur.price >= x.target;
        var status = hitStop ? '<b class="neg">已破止损</b>' : hitTgt ? '<b class="pos">已达目标</b>' : '持有中';
        return '<div class="track-chip">' + esc(x.name) + ' <b class="' + cls(chg) + '">' + pctText(chg) + '</b>' +
          ' · ' + status + '</div>';
      }).filter(Boolean);
      if (!rows.length) return;
      $('#trackBar').style.display = '';
      $('#trackTitle').textContent = rec.date + ' 入选标的今日表现';
      $('#trackHint').textContent = '按入选时价格计算，非成交价';
      $('#trackItems').innerHTML = rows.join('');
    });
  }

  /* ------------------------------ 回测执行 ------------------------------ */
  /* 用候选池里的标的做回测，而不是只用入榜的几只。
   * 只用入榜票会在方法上出问题：那是"今天已经涨得最好的几只"，用它们的历史
   * 回测必然虚高（选择偏差）。这里取候选池前 30 只，样本更接近真实可选范围。
   * 即便如此仍不是全市场随机样本，页面会如实标注。 */
  function runBacktest(result) {
    var items = (result.all || []).slice(0, 30);
    if (!items.length) { $('#btBlock').style.display = 'none'; return Promise.resolve(); }
    $('#btBlock').style.display = '';
    $('#btHint').textContent = '拉取历史K线中…';

    return Screener.pool(items.map(function (it) {
      return function () {
        return Screener.fetchBars(it.code, 'day', 800).then(function (bars) {
          if (bars && bars.length >= 260) {
            it._bars = bars;
            var n = bars.length, last = bars[n - 1].c;
            it._chg20 = (last - bars[n - 21].c) / bars[n - 21].c * 100;
            it._chg60 = (last - bars[n - 61].c) / bars[n - 61].c * 100;
            return it;
          }
          return null;
        }).catch(function () { return null; });
      };
    }), 6).then(function () {
      var ready = items.filter(function (it) { return it._bars && it._bars.length >= 260; });
      if (!ready.length) { $('#btHint').textContent = '历史数据不足，无法回测'; return; }
      var res = Backtest.run(ready);
      res.sampleSize = ready.length;
      /* 把综合分带回回测行上：下面要按分数分桶，检验「分高的历史表现是不是真的更好」。
       * 这一步是给打分权重做验证 —— 之前五个权重是拍出来的，从没被数据检验过。 */
      var byCode = {};
      ready.forEach(function (it) { byCode[it.code] = it; });
      (res.rows || []).forEach(function (r) {
        var it = byCode[r.code];
        r._score = it && it.score ? it.score.total : null;
      });
      state.bt = res;
      renderBacktest(res);
    });
  }

  /* ------------------------------ 主流程 ------------------------------ */
  function setRunning(on) {
    state.running = on;
    var b1 = $('#runBtn'), b2 = $('#runBtn2');
    b1.disabled = on; b2.disabled = on;
    b1.textContent = on ? '计算中…' : '开始选股';
    b2.textContent = on ? '计算中…' : '重新计算';
  }

  function runAll() {
    if (state.running) return Promise.resolve();
    setRunning(true);
    setProgress(true, '正在获取全市场快照…', 2);

    var t0 = Date.now();
    var today = ymdDash();
    var isLive = isTradingNow();
    var progress = tradingProgress();

    /* 环境与选股并行：环境只用 3 个指数报价 + 上证日线，很快 */
    return Screener.run({
      today: isLive ? today : '',
      progress: progress,
      onProgress: function (p) {
        var pct = 4;
        if (p.stage === 'universe') pct = 6 + (p.done / Math.max(1, p.total)) * 8;
        else if (p.stage === 'prepare') pct = 8 + (p.done / Math.max(1, p.total)) * 6;
        else if (p.stage === 'prescreen') pct = 14;
        else if (p.stage === 'analyze') pct = 14 + (p.done / Math.max(1, p.total)) * 72;
        else if (p.stage === 'verify') pct = 86 + (p.done / Math.max(1, p.total)) * 8;
        else if (p.stage === 'done') pct = 94;
        setProgress(true, p.msg, pct);
      },
    }).then(function (result) {
      state.result = result;

      return buildEnv(result.env, result.basis, result.envSample).then(function (env) {
        state.env = env;
        renderGate(env);

        /* 环境偏弱不清空候选——选股与仓位是两件事。结构达标的票照常给出，
         * 但标注「环境逆风」，由页面顶部与仓位建议共同约束。 */
        if (env.level === 'bad') {
          result.picked.forEach(function (it) { it.envWarn = true; });
        }

        renderPicks(result);
        renderWatch(result.watch);
        if (result.picked.length) {
          saveHistory(result);
          setProgress(true, '回测计算中…', 95);
          return runBacktest(result).then(function () {
            setProgress(false);
            setRunning(false);
            renderTrack();
          });
        }
        setProgress(false);
        setRunning(false);
        renderTrack();
      });
    }).catch(function (err) {
      console.error('[Screen] 选股失败', err);
      setProgress(false);
      setRunning(false);

      var msg = (err && err.message) || '未知错误';
      var prev = state.result;

      /* 关键：刷新失败不能把上一次的榜单清掉。
       * 盘中每 5 分钟会自动重算，行情源一旦抖动就把整页变成「选股失败」，
       * 用户看到的就是「可买候选一直失败」，而其实上一份结果还有效。 */
      if (prev && prev.picked && prev.picked.length) {
        var pt = new Date(prev.ts);
        var bar = $('#basisBar');
        bar.style.display = '';
        bar.className = 'basis-bar bad';
        bar.innerHTML = '<b>本次刷新失败（' + esc(msg) + '）</b>' +
          '下面仍是 ' + pad(pt.getHours()) + ':' + pad(pt.getMinutes()) + ' 成功计算的那一份结果，' +
          '价格已不是最新，请谨慎使用。稍等十几秒再点「重新计算」。';
        return;
      }

      $('#pickArea').innerHTML = '<div class="empty-state"><b>数据源全部不可用</b>' +
        '原因：' + esc(msg) + '。<br>' +
        '已尝试：东方财富（全市场 + 批量报价）、新浪全市场列表、腾讯批量报价、同花顺单票，' +
        '以及内置清单兜底，本次都没取到有效数据。这通常是网络断开或行情源临时限流，' +
        '十几秒后点「重新计算」即可，不需要刷新页面。</div>';
      $('#pickHint').textContent = '计算失败 · 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
      var bb = $('#basisBar');
      if (bb) bb.style.display = 'none';
      var sg = $('#srcGrid');
      if (sg) {
        sg.innerHTML = '<div class="empty-state small"><b>无法评估数据源状态</b>' +
          '本次所有行情源都未返回有效数据，因此无法生成交叉校验。' +
          '已记录各源的最后报错，重试时可据此判断是网络问题还是接口问题。</div>';
      }
      var cl = $('#crossList');
      if (cl) cl.innerHTML = '';
      var sh = $('#srcHint');
      if (sh) sh.textContent = '全部不可用';
    });
  }

  /* 交易时段每 5 分钟自动重算；非交易时段不自动跑，避免无意义请求 */
  function startAuto() {
    if (state.autoTimer) clearInterval(state.autoTimer);
    state.autoTimer = setInterval(function () {
      if (document.hidden || state.running) return;
      if (!isTradingNow()) return;
      runAll();
    }, 5 * 60 * 1000);
  }

  function updateMode() {
    var pill = $('#modePill');
    if (!pill) return;
    /* 三态口径：盘中用实时价、收盘后用今日收盘价、盘前用上一交易日。
     * 这三者对交易的含义完全不同，标签必须如实写出来。 */
    var s = Feeds.session();
    if (s.state === 'live') {
      pill.className = 'mode-pill live';
      pill.textContent = s.label + ' · 实时价 · 末根K线未完成';
    } else if (s.state === 'post') {
      pill.className = 'mode-pill closed';
      pill.textContent = '已收盘 · 使用今日收盘价与完整K线';
    } else if (s.state === 'closed') {
      pill.className = 'mode-pill closed';
      pill.textContent = '周末休市 · 使用上一交易日收盘';
    } else {
      pill.className = 'mode-pill closed';
      pill.textContent = s.label + ' · 使用上一交易日收盘';
    }
  }

  /* ------------------------------ 启动 ------------------------------ */
  function boot() {
    tick();
    setInterval(tick, 30000);
    updateMode();
    setInterval(updateMode, 60000);

    $('#runBtn').addEventListener('click', runAll);
    $('#runBtn2').addEventListener('click', runAll);

    $$('.bt-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        state.btSet = b.getAttribute('data-set');
        if (state.bt) renderBacktest(state.bt);
      });
    });

    renderTrack();
    startAuto();

    /* 进入页面直接跑一次；交易时段之外也跑，用户打开就想看结果 */
    setTimeout(runAll, 260);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
