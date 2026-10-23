/* ==========================================================================
 * feeds.js —— 多源行情层 + 交叉验证
 *
 * 为什么需要这一层：
 *   2026-10-22 实测，东方财富 push2 系全域不可达（TLS 被服务端直接断开），
 *   单源架构会导致整个选股链路中断。更严重的是，即便接口活着，它也会
 *   间歇性只返回 100 条（分页截断），把「100 只」伪装成「全市场 5900 只」。
 *   所以数据源必须多路并进，并且互相核对。
 *
 * 四个源的实测能力（2026-10-22，HTTPS 全部支持 CORS）：
 *
 *   源        全市场列表   批量报价   单票快照   K线        备注
 *   ────────────────────────────────────────────────────────────────────
 *   东方财富    ✅ clist      —        —       ✅ hfq      当前不可达，自动降级
 *   新浪财经    ✅ 节点列表    —        —        —         稳定，缺资金流字段
 *   腾讯财经     —          ✅ 60/批   ✅      ✅ hfq/m30  主力 K 线源
 *   同花顺       —            —        ✅      ✅ 不复权   带精确时间戳，第三校验源
 *   通达信       —            —        —        —          TCP 私有协议，浏览器不可直连，
 *                                                          仅作离线校验基准
 *
 * 交叉验证的分层（不额外浪费请求，而是把本来就要拉的请求用起来）：
 *   L0  全市场：东财 ‖ 新浪 并行 → 5000+ 只逐只比价，算出全局一致率
 *   L1  候选：  腾讯批量报价（60 只 1~2 请求）→ 与 L0 工作集比价
 *   L2  入榜：  同花顺 realhead 逐只 → 第四源，带时间戳，可算时间差容差
 *   K线：       腾讯 hfq 主，东财 hfq 备；两者都在时比较末根收盘
 *
 * 容差为什么不能是 0：
 *   不同源的快照时刻本就不同。实测同一分钟内茅台分别为 1301.98（腾讯/新浪）
 *   与 1300.13（同花顺）、1299.43（通达信），这是行情推送延迟，不是错误。
 *   因此按「时间差」放大容差，超出才判为数据异常。
 * ========================================================================== */
var Feeds = (function () {
  'use strict';

  var TOL_BASE = 0.35;      // 基础容差（%）：同刻快照的正常抖动
  var TOL_PER_MIN = 0.25;   // 每差 1 分钟额外放宽（%）
  var TOL_MAX = 2.5;        // 容差上限，超过这个值无论如何都判异常
  var BIG_MOVE = 1.2;       // 超出该值单独列出，供页面提示

  /* 各源元信息。offline=true 表示浏览器不可直连，仅作离线基准。 */
  var SOURCES = {
    em: { key: 'em', name: '东方财富', full: true, bulk: false, single: false, kline: true },
    sina: { key: 'sina', name: '新浪财经', full: true, bulk: false, single: false, kline: false },
    tx: { key: 'tx', name: '腾讯财经', full: false, bulk: true, single: true, kline: true },
    ths: { key: 'ths', name: '同花顺', full: false, bulk: false, single: true, kline: true },
    tdx: { key: 'tdx', name: '通达信', full: false, bulk: false, single: false, kline: false, offline: true },
  };

  /* 运行期健康状态：页面要能显示「哪个源现在能用」，而不是静默降级。 */
  var health = {};
  Object.keys(SOURCES).forEach(function (k) {
    health[k] = { ok: 0, fail: 0, lastMs: 0, lastErr: '', lastOkAt: 0 };
  });

  function mark(k, ok, ms, err) {
    var h = health[k];
    if (ok) { h.ok++; h.lastOkAt = Date.now(); h.lastErr = ''; }
    else { h.fail++; h.lastErr = String(err || 'unknown').slice(0, 90); }
    h.lastMs = ms || 0;
  }

  function status() {
    return Object.keys(SOURCES).map(function (k) {
      var s = SOURCES[k], h = health[k];
      var total = h.ok + h.fail;
      return {
        key: k, name: s.name, offline: !!s.offline,
        role: s.full ? '全市场' : (s.bulk ? '批量报价' : (s.single ? '单票校验' : '离线基准')),
        ok: h.ok, fail: h.fail, lastMs: h.lastMs, lastErr: h.lastErr,
        lastOkAt: h.lastOkAt,
        state: total === 0 ? 'idle' : (h.ok > 0 ? 'ok' : 'down'),
      };
    });
  }

  function timed(k, p) {
    var t0 = Date.now();
    return p.then(function (v) {
      mark(k, true, Date.now() - t0);
      return v;
    }, function (e) {
      mark(k, false, Date.now() - t0, e && e.message);
      throw e;
    });
  }

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  function tfetch(url, opt) {
    opt = opt || {};
    var ctl = null, timer = null;
    if (typeof AbortController !== 'undefined') {
      ctl = new AbortController();
      timer = setTimeout(function () { ctl.abort(); }, opt.timeout || 15000);
    }
    return fetch(url, {
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return opt.buffer ? r.arrayBuffer() : r.text();
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  /* 浏览器端可能被 CORS 预检拦下，统一转成可读错误 */
  function kindErr(e) {
    var m = String(e && e.message || e || '');
    if (/abort/i.test(m)) return '超时';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return '不可达或被跨域拦截';
    return m;
  }

  /* ------------------------------------------------------------------ *
   * 1. 全市场列表：东方财富
   * ------------------------------------------------------------------ */
  function emUniverse(prefix) {
    var fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
    var fields = 'f2,f3,f5,f6,f7,f8,f9,f10,f11,f12,f13,f14,f15,f16,f17,f18,f20,f21,f22,f23,f62,f100';
    var url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fid=f3'
      + '&fs=' + encodeURI(fs) + '&fields=' + fields;
    return timed('em', tfetch(url).then(function (t) {
      var j = JSON.parse(t);
      var rows = (j && j.data && j.data.diff) || [];
      if (!rows.length) throw new Error('空数据');
      /* 分页截断：该接口会间歇性只给 100 条。这时数据本身是对的（只是样本小），
       * 不当作失败丢弃，而是打标记降级成「抽样交叉源」，比直接扔掉更有用。
       * 但绝不能当成全市场——那会让后续过滤只剩个位数的票。 */
      var truncated = rows.length < 3000;
      var out = rows.map(function (x) {
        return {
          code: prefix(x.f12, x.f13),
          raw: String(x.f12),
          name: String(x.f14 || '').trim(),
          price: num(x.f2, null),
          pct: num(x.f3, 0),
          volume: num(x.f5, 0),
          amount: num(x.f6, 0) / 10000,        // 元 → 万元
          amp: num(x.f7, 0),
          turnover: num(x.f8, 0),
          pe: num(x.f9, null),
          volRatio: num(x.f10, null),
          high: num(x.f15, null),
          low: num(x.f16, null),
          open: num(x.f17, null),
          prevClose: num(x.f18, null),
          totalCap: num(x.f20, 0) / 1e8,       // → 亿
          floatCap: num(x.f21, 0) / 1e8,
          pb: num(x.f23, null),
          mainNet: num(x.f62, 0) / 10000,      // → 万元
          industry: String(x.f100 || ''),
          _src: 'em',
        };
      });
      out._truncated = truncated;
      return out;
    }).catch(function (e) { throw new Error(kindErr(e)); }));
  }

  /* 东财批量报价：ulist.np 按代码点名取，不受 clist 分页限制。
   * 2026-10-22 实测：clist 会被截断到 100 条且频繁超时，但 ulist 稳定可用，
   * 且带 f62 主力净流入与 f10 量比——这两项新浪没有，正好补回来。
   * secid 规则：沪市 1.xxxxxx，深市/北交所 0.xxxxxx。 */
  function emQuotes(codes, prefix) {
    function secid(c) {
      var m = /^(sh|sz|bj)(\d{4,6})$/.exec(c);
      if (!m) return null;
      return (m[1] === 'sh' ? '1.' : '0.') + m[2];
    }
    var ids = codes.map(secid).filter(Boolean);
    if (!ids.length) return Promise.resolve({});
    var fields = 'f2,f3,f5,f6,f8,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f62';
    var url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids='
      + ids.join(',') + '&fields=' + fields;
    return timed('em', tfetch(url).then(function (t) {
      var j = JSON.parse(t);
      var diff = (j && j.data && j.data.diff) || [];
      if (!diff.length) throw new Error('空数据');
      var out = {};
      diff.forEach(function (x) {
        var code = prefix(x.f12, x.f13);
        out[code] = {
          code: code, name: String(x.f14 || '').trim(),
          price: num(x.f2, null), pct: num(x.f3, 0),
          volume: num(x.f5, 0),
          amount: num(x.f6, 0) / 1e4,           // 元 → 万元
          turnover: num(x.f8, null), volRatio: num(x.f10, null),
          high: num(x.f15, null), low: num(x.f16, null),
          open: num(x.f17, null), prevClose: num(x.f18, null),
          totalCap: num(x.f20, 0) / 1e8,
          floatCap: num(x.f21, 0) / 1e8,
          pb: num(x.f23, null),
          mainNet: num(x.f62, 0) / 1e4,         // 元 → 万元
          _src: 'em',
        };
      });
      return out;
    }).catch(function (e) { throw new Error(kindErr(e)); }));
  }

  /* ------------------------------------------------------------------ *
   * 2. 全市场列表：新浪财经
   *    100 条/页，节点 hs_a 覆盖沪深 A 股。8 路并发取 60 页约 2 秒。
   *    字段比东财少了主力资金流与量比，所以只作补充与交叉校验。
   * ------------------------------------------------------------------ */
  function sinaPage(page, num_, sort) {
    var url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/'
      + 'Market_Center.getHQNodeData?page=' + page + '&num=' + (num_ || 100)
      + '&sort=' + (sort || 'amount') + '&asc=0&node=hs_a';
    return tfetch(url).then(function (t) {
      /* 该接口返回的是非严格 JSON（键无引号），先做一次补引号 */
      var s = String(t).trim();
      if (!s || s === 'null') return [];
      try { return JSON.parse(s); } catch (e) {
        var fixed = s.replace(/([{,])([a-zA-Z_][a-zA-Z0-9_]*):/g, '$1"$2":');
        try { return JSON.parse(fixed); } catch (e2) { return []; }
      }
    });
  }

  function sinaUniverse(prefix, onProgress) {
    /* 5500 只 / 100 条 ≈ 56 页，留 4 页余量。
     * 重试用「两轮统一补」而不是「每页自己等」：
     * 逐页退避会让 worker 堵在等待上，实测 60 页要跑 7.5 秒；
     * 先跑完一轮、把失败页收集起来再并发送一轮，同样覆盖率只要 3 秒左右。 */
    var PAGES = 60;
    var pages = new Array(PAGES + 1);

    function runBatch(list, conc) {
      var q = list.slice();
      function worker() {
        if (!q.length) return Promise.resolve();
        var p = q.shift();
        return sinaPage(p).then(function (arr) {
          pages[p] = arr || [];
          return worker();
        }, function () { return worker(); });
      }
      var ws = [];
      for (var w = 0; w < Math.min(conc, list.length || 1); w++) ws.push(worker());
      return Promise.all(ws);
    }

    function pending() {
      var r = [];
      for (var i = 1; i <= PAGES; i++) {
        if (!Array.isArray(pages[i]) || !pages[i].length) r.push(i);
      }
      return r;
    }

    var all = [];
    for (var i = 1; i <= PAGES; i++) all.push(i);
    var seen = 0;

    return timed('sina', runBatch(all, 10).then(function () {
      if (onProgress) onProgress(PAGES - pending().length, PAGES);
      var left = pending();
      if (!left.length) return;
      return new Promise(function (r) { setTimeout(r, 350); })
        .then(function () { return runBatch(left, 3); })
        .then(function () {
          var left2 = pending();
          if (!left2.length) return;
          return new Promise(function (r) { setTimeout(r, 650); })
            .then(function () { return runBatch(left2, 2); });
        });
    }).then(function () {
      var out = [], seenCode = {};
      var dup = 0;
      pages.forEach(function (arr) {
        if (!Array.isArray(arr)) return;
        arr.forEach(function (x) {
          var code = String(x.code || '').trim();
          if (!/^\d{6}$/.test(code)) return;
          /* 分页按成交额排序，而成交额盘中一直在变，翻页过程中会出现
           * 同一只被返回两次、另一只被跳过。必须去重，否则「全市场」
           * 会掺进重复计数，覆盖率被人为抬高。 */
          if (seenCode[code]) { dup++; return; }
          seenCode[code] = 1;
          var price = num(x.trade, null);
          var prev = num(x.settlement, null);
          out.push({
            code: prefix(code, null),
            raw: code,
            name: String(x.name || '').trim(),
            price: price,
            prevClose: prev,
            open: num(x.open, null),
            high: num(x.high, null),
            low: num(x.low, null),
            pct: num(x.changepercent, 0),
            volume: num(x.volume, 0) / 100,    // 股 → 手
            amount: num(x.amount, 0) / 1e4,    // 元 → 万元
            turnover: num(x.turnoverratio, null),
            /* 该接口的 nmc / mktcap 单位是「万元」，不是元。
             * 实测中际旭创 nmc=66551822，对应流通市值 6655 亿，除 1e4 才是亿。
             * 这里错一个数量级，MIN_FLOAT_CAP 的过滤就整条失效。 */
            floatCap: num(x.nmc, 0) / 1e4,     // 万元 → 亿
            totalCap: num(x.mktcap, 0) / 1e4,
            pe: num(x.per, null),
            pb: num(x.pb, null),
            volRatio: null,                    // 该接口不提供
            /* 该接口不提供主力净流入。这里必须写 null 而不是 0：
             * 0 是「净流入恰好为零」的合法值，下游无法区分「没有数据」，
             * 会导致后置的资金回填被跳过。 */
            mainNet: null,
            industry: '',
            _src: 'sina',
          });
        });
      });
      out._dup = dup;
      out._pages = PAGES - pending().length;
      if (onProgress) onProgress(PAGES, PAGES);
      /* 沪深 A 股实际约 5400~5600 只。低于 2500 说明大量分页没有取到，
       * 此时宁可让上层退到内置清单 + 腾讯批量，也不能拿残样本当全市场。
       * 2500~4800 之间允许通过，由上层用东财批量补全缺口。 */
      if (out.length < 2500) {
        throw new Error('仅取到 ' + out.length + ' 只（去重 ' + dup + ' 条），覆盖不足');
      }
      return out;
    }).catch(function (e) { throw new Error(kindErr(e)); }));
  }

  /* ------------------------------------------------------------------ *
   * 3. 批量报价：腾讯（60 只/批）
   *    浏览器无法自定义 Referer/UA，但腾讯 qt.gtimg.cn 允许 CORS *，
   *    返回 GBK，需按 gbk 解码。
   * ------------------------------------------------------------------ */
  function txQuotes(codes, conc) {
    var chunks = [];
    for (var i = 0; i < codes.length; i += 60) chunks.push(codes.slice(i, i + 60));
    var out = {}, idx = 0;

    function parseLine(line) {
      var m = /^v_([A-Za-z0-9]+)="([\s\S]*)"$/.exec(String(line).trim());
      if (!m) return;
      var f = m[2].split('~');
      if (f.length < 40) return;
      /* 时间字段位置在不同接口版本间会浮动，先定位 14 位时间串 */
      var ti = 30;
      for (var k = 26; k < 40; k++) {
        if (/^\d{14}$/.test(String(f[k] || '').trim())) { ti = k; break; }
      }
      var tm = String(f[ti] || '').trim();
      out[m[1]] = {
        code: m[1], name: String(f[1] || '').trim(),
        price: num(f[3], null), prevClose: num(f[4], null), open: num(f[5], null),
        volume: num(f[6], 0),                       // 手
        time: tm,                                    // YYYYMMDDHHMMSS
        pct: num(f[ti + 2], 0),
        high: num(f[ti + 3], null), low: num(f[ti + 4], null),
        amount: num(f[ti + 7], 0),                   // 万元
        turnover: num(f[ti + 8], null),
        amp: num(f[ti + 13], null),
        floatCap: num(f[ti + 15], null),
        totalCap: num(f[ti + 16], null),
        volRatio: num(f[ti + 19], null),
        _t: parseTxTime(tm),                // 毫秒时间戳，用于算源间快照时间差
        _src: 'tx',
      };
    }

    function worker() {
      if (idx >= chunks.length) return Promise.resolve();
      var chunk = chunks[idx++];
      var url = 'https://qt.gtimg.cn/q=' + chunk.join(',');
      return timed('tx', tfetch(url, { buffer: true }).then(function (buf) {
        new TextDecoder('gbk').decode(buf).split(';').forEach(parseLine);
      }).catch(function () { /* 单批失败不影响整体 */ })).then(worker, worker);
    }

    var ws = [];
    var n = Math.max(1, Math.min(conc || 4, chunks.length));
    for (var w = 0; w < n; w++) ws.push(worker());
    return Promise.all(ws).then(function () { return out; });
  }

  /* ------------------------------------------------------------------ *
   * 4. 单票快照：同花顺
   *    字段是数字编号的扁平字典，实测映射如下（2026-10-22 核对）：
   *      5 代码  6 昨收  7 今开  8 最高  9 最低  10 现价
   *      13 成交量(股)  14 外盘  15 内盘  19 成交额(元)
   *      69 涨停  70 跌停  402 流通股本(股)  407 总股本(股)
   *      199112 涨跌幅%  264648 涨跌额  1968584 换手率%  1771976 量比
   *      1378761 均价  3475914 总市值(元)
   *    顶层 time 是精确时间戳（到秒），交叉校验时用它算时间差容差。
   * ------------------------------------------------------------------ */
  function thsQuote(code) {
    var m = /^(sh|sz|bj)(\d{4,6})$/.exec(code);
    if (!m) return Promise.reject(new Error('代码格式不支持'));
    var hs = 'hs_' + m[2];
    var url = 'https://d.10jqka.com.cn/v6/realhead/' + hs + '/defer/last.js';
    return timed('ths', tfetch(url).then(function (t) {
      var mm = /^\s*[A-Za-z0-9_]+\(([\s\S]*)\)\s*;?\s*$/.exec(String(t).trim());
      if (!mm) throw new Error('返回格式异常');
      var j = JSON.parse(mm[1]);
      /* 同花顺的返回结构不稳定：有时 name/time/stockStatus 在顶层，
       * 有时被塞进 items 里（2026-10-22 实测两种都出现过）。
       * 只认其中一种会让时间戳与名称静默变空，进而让交叉校验的时间差失效。 */
      var it = j.items || {};
      function meta(k) {
        var v = it[k];
        if (v == null || v === '') v = j[k];
        return (v == null) ? '' : v;
      }
      function g(k) { return num(it[k], null); }
      var price = g(10), prev = g(6), fs = g(402);
      if (!(price > 0)) throw new Error('无有效价格');
      /* time 精确到秒，updateTime 只到分；两者都只在一个版本里出现，取到哪个算哪个 */
      var tmStr = String(meta('time') || meta('updateTime') || '');
      return {
        code: code, name: String(meta('name') || ''),
        price: price, prevClose: prev, open: g(7), high: g(8), low: g(9),
        volume: g(13) || 0,                        // 股
        amount: (g(19) || 0) / 1e4,                // 元 → 万元
        pct: g(199112), chg: g(264648),
        turnover: g(1968584),
        volRatio: g(1771976),
        avgPrice: g(1378761),
        floatCap: fs && price ? fs * price / 1e8 : null,
        totalCap: g(407) && price ? g(407) * price / 1e8 : null,
        limitUp: g(69), limitDown: g(70),
        time: tmStr,                               // 2026-10-22 09:48:31 北京时间
        _t: parseThsTime(tmStr),                   // 用于算源间时间差
        status: String(meta('stockStatus') || ''),
        _src: 'ths',
      };
    }).catch(function (e) { throw new Error(kindErr(e)); }));
  }

  /* ------------------------------------------------------------------ *
   * 5. K 线：腾讯后复权为主
   *    hfq 用于结构计算（前复权在除权日会造出假笔假中枢）。
   *    日/周/月都支持 hfq；30 分钟线接口不带复权参数，本身就是真实价。
   * ------------------------------------------------------------------ */
  function txBars(code, period, lmt) {
    var url = period === 'm30'
      ? 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline?param=' + code + ',m30,,' + lmt
      : 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=' + code + ',' + period + ',,,' + lmt + ',hfq';
    return timed('tx', tfetch(url).then(function (t) {
      var j = JSON.parse(t);
      var d = j && j.data && j.data[code];
      if (!d) throw new Error('无数据');
      var arr = period === 'm30' ? d.m30
        : (d['hfq' + period] || d['qfq' + period] || d[period]);
      if (!Array.isArray(arr) || !arr.length) throw new Error('无数据');
      /* 腾讯顺序：[日期, 开, 收, 高, 低, 量(手), {}, 换手率, 成交额(万元)] */
      return arr.map(function (r) {
        return {
          d: String(r[0]), o: +r[1], h: +r[3], l: +r[4], c: +r[2], v: +r[5],
          a: num(r[8], 0), t: num(r[7], null),
        };
      });
    }).catch(function (e) { throw new Error(kindErr(e)); }));
  }

  /* 不复权日线：仅用于把「上一交易日的真实价与真实成交额」回填进快照。
   * 结构计算必须用 hfq，但快照展示与交易计划必须是真实价，
   * 两者一旦混用，止损会算到后复权价上去。 */
  function txBarsRaw(code, period, lmt) {
    var url = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param='
      + code + ',' + period + ',,,' + lmt + ',';
    return timed('tx', tfetch(url).then(function (t) {
      var j = JSON.parse(t);
      var d = j && j.data && j.data[code];
      if (!d) throw new Error('无数据');
      var arr = d[period];
      if (!Array.isArray(arr) || !arr.length) throw new Error('无数据');
      return arr.map(function (r) {
        return {
          d: String(r[0]), o: +r[1], h: +r[3], l: +r[4], c: +r[2], v: +r[5],
          a: num(r[8], 0), t: num(r[7], null),
        };
      });
    }).catch(function (e) { throw new Error(kindErr(e)); }));
  }

  /* 东财 K 线：后复权 fqt=2，作为腾讯失败时的备份，也是 K 线交叉源 */
  function emBars(code, period, lmt) {
    var m = /^([a-z]{2})(\d{4,6})$/.exec(code);
    if (!m) return Promise.reject(new Error('代码格式不支持'));
    var mkt = m[1] === 'sh' ? '1' : '0';
    var klt = period === 'day' ? 101 : period === 'week' ? 102 : period === 'month' ? 103 : 30;
    var url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + mkt + '.' + m[2]
      + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57'
      + '&klt=' + klt + '&fqt=2&end=20500101&lmt=' + lmt;
    return timed('em', tfetch(url).then(function (t) {
      var j = JSON.parse(t);
      var kl = j && j.data && j.data.klines;
      if (!Array.isArray(kl) || !kl.length) throw new Error('无数据');
      /* 东财顺序：日期,开,收,高,低,量,额(元) */
      return kl.map(function (s) {
        var p = String(s).split(',');
        return { d: String(p[0]), o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5], a: num(p[6], 0) / 1e4 };
      });
    }).catch(function (e) { throw new Error(kindErr(e)); }));
  }

  /* 同花顺 K 线：01 日 / 11 周 / 21 月 / 41 30分钟
   * 顺序是 [日期, 开, 高, 低, 收, 量(股), 额(元), 换手率]，与腾讯不同，别搞混。
   * 该接口是前复权（早期数据会出现负价），只用于「最近价格一致性」核对，
   * 不能用于结构计算。 */
  function thsBars(code, period) {
    var m = /^(sh|sz|bj)(\d{4,6})$/.exec(code);
    if (!m) return Promise.reject(new Error('代码格式不支持'));
    var map = { day: '01', week: '11', month: '21', m30: '41' };
    var pc = map[period];
    if (!pc) return Promise.reject(new Error('周期不支持'));
    var url = 'https://d.10jqka.com.cn/v6/line/hs_' + m[2] + '/' + pc + '/last.js';
    return timed('ths', tfetch(url).then(function (t) {
      var mm = /^\s*[A-Za-z0-9_]+\(([\s\S]*)\)\s*;?\s*$/.exec(String(t).trim());
      if (!mm) throw new Error('返回格式异常');
      var j = JSON.parse(mm[1]);
      if (!j.data) throw new Error('无数据');
      return String(j.data).split(';').filter(Boolean).map(function (s) {
        var p = s.split(',');
        return { d: String(p[0]), o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[5], a: num(p[6], 0) / 1e4 };
      });
    }).catch(function (e) { throw new Error(kindErr(e)); }));
  }

  /* ------------------------------------------------------------------ *
   * 6. 交叉验证
   * ------------------------------------------------------------------ */

  /* 两个全市场快照逐只比价。返回一致率与偏离最大的标的，
   * 一致率过低说明有一方数据源在返回过期/错误数据，必须提示用户。 */
  function crossUniverse(primary, secondary, opt) {
    opt = opt || {};
    var tol = opt.tol || TOL_BASE;
    var common = 0, agree = 0, devs = [], worst = [], missing = 0;
    var a = {}, b = {};
    primary.forEach(function (r) { if (r.price > 0) a[r.raw || r.code] = r; });
    secondary.forEach(function (r) { if (r.price > 0) b[r.raw || r.code] = r; });

    Object.keys(a).forEach(function (k) {
      var ra = a[k], rb = b[k];
      if (!rb || !(rb.price > 0)) { missing++; return; }
      common++;
      var dev = Math.abs(ra.price - rb.price) / rb.price * 100;
      devs.push(dev);
      /* 停牌/涨跌停时两源可能一个有价一个零成交，价差不是错误 */
      if (dev <= tol) agree++;
      else worst.push({
        code: ra.code, name: ra.name, a: ra.price, b: rb.price, dev: dev,
        aSrc: ra._src || '', bSrc: rb._src || '',
      });
    });

    devs.sort(function (x, y) { return x - y; });
    worst.sort(function (x, y) { return y.dev - x.dev; });

    return {
      common: common,
      agree: agree,
      agreeRate: common ? agree / common : 0,
      median: devs.length ? devs[devs.length >> 1] : 0,
      p95: devs.length ? devs[Math.floor(devs.length * 0.95)] : 0,
      max: devs.length ? devs[devs.length - 1] : 0,
      missing: missing,
      tol: tol,
      worst: worst.slice(0, 8),
      bigMoves: worst.filter(function (w) { return w.dev > BIG_MOVE; }).length,
    };
  }

  /* 解析同花顺时间戳到毫秒。兼容两种格式：
   *   '2026-10-22 09:48:31 北京时间'（到秒）  '2026-10-22 09:48'（只到分）
   * 到分的情况精度损失 30 秒，折算成容差影响 < 0.15%，可接受。 */
  function parseThsTime(s) {
    var m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
  }

  /* 解析腾讯时间戳 YYYYMMDDHHMMSS */
  function parseTxTime(s) {
    var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }

  /* 单票多源比对。ref 是工作集里的那一行，cand 是校验源返回的快照。
   * 容差按「两源快照时间差」放大：差得越久，允许的价格漂移越大。
   * 这是必须的——把不同时刻的价格当成同一时刻来比，会误判大量正常数据。 */
  function crossQuote(ref, cand) {
    if (!ref || !cand || !(ref.price > 0) || !(cand.price > 0)) {
      return { state: 'missing', dev: null, tol: null, note: '校验源无数据' };
    }
    var dev = Math.abs(ref.price - cand.price) / cand.price * 100;
    var tRef = ref._t || null, tCand = cand._t || null;
    var gapSec = (tRef && tCand) ? Math.abs(tRef - tCand) / 1000 : null;
    var tol = TOL_BASE;
    if (gapSec != null) tol += (gapSec / 60) * TOL_PER_MIN;
    tol = Math.min(tol, TOL_MAX);

    var state = dev <= tol ? 'ok' : (dev <= Math.max(tol * 3, 1.5) ? 'warn' : 'bad');
    return {
      state: state, dev: dev, tol: tol, gapSec: gapSec,
      ref: ref.price, cand: cand.price, candSrc: cand._src || '',
      candTime: cand.time || '',
      note: state === 'ok' ? '一致'
        : state === 'warn' ? '轻微偏离，可能是快照时刻差'
          : '偏离过大，需人工核对',
    };
  }

  /* 同花顺单票带一次重试：它按 IP 限流，批量校验时偶发 403。
   * 一次重试能把「缺失」压到接近 0，成本只有失败时的那一次 */
  function thsQuoteRetry(code, tries) {
    tries = tries || 0;
    return thsQuote(code).catch(function (e) {
      if (tries >= 1) throw e;
      return new Promise(function (r) { setTimeout(r, 260); })
        .then(function () { return thsQuoteRetry(code, tries + 1); });
    });
  }

  /* 对一批标的做同花顺校验。并发受限，失败不抛错只记 missing。 */
  function verifyBatch(items, opt) {
    opt = opt || {};
    var conc = opt.conc || 3;
    var out = {};
    var idx = 0;

    function worker() {
      if (idx >= items.length) return Promise.resolve();
      var it = items[idx++];
      return thsQuoteRetry(it.code).then(function (q) {
        out[it.code] = crossQuote(it, q);
      }, function (e) {
        out[it.code] = { state: 'missing', dev: null, tol: null, note: kindErr(e) };
      }).then(worker);
    }

    var ws = [];
    for (var w = 0; w < Math.min(conc, items.length || 1); w++) ws.push(worker());
    return Promise.all(ws).then(function () { return out; });
  }

  /* K 线交叉：比较两源末根收盘价。仅当两源日期一致时才有意义。 */
  function crossBars(a, b) {
    if (!a || !b || !a.length || !b.length) return null;
    var la = a[a.length - 1], lb = b[b.length - 1];
    var da = String(la.d).slice(0, 10), db = String(lb.d).slice(0, 10);
    if (da !== db) {
      return { sameDate: false, dateA: da, dateB: db, dev: null, note: '两源末根日期不同' };
    }
    var dev = Math.abs(la.c - lb.c) / lb.c * 100;
    return {
      sameDate: true, date: da, dev: dev,
      a: la.c, b: lb.c, state: dev <= TOL_BASE ? 'ok' : 'warn',
    };
  }

  /* ------------------------------------------------------------------ *
   * 7. 交易时段判定（盘前 / 盘中 / 盘后）
   *    价格口径必须按这个走，否则盘后会把收盘价标成"实时"，
   *    盘前又会把昨收当成现价。
   * ------------------------------------------------------------------ */
  function session(nowMs) {
    var d = nowMs ? new Date(nowMs) : new Date();
    var wd = d.getDay();
    var m = d.getHours() * 60 + d.getMinutes();
    var ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');

    if (wd === 0 || wd === 6) {
      return { state: 'closed', today: ymd, label: '周末休市', progress: 1, tradable: false };
    }
    if (m < 9 * 60 + 15) {
      return { state: 'pre', today: ymd, label: '盘前', progress: 0.02, tradable: true };
    }
    if (m < 9 * 60 + 25) {
      return { state: 'pre', today: ymd, label: '集合竞价', progress: 0.03, tradable: true };
    }
    if (m < 9 * 60 + 30) {
      return { state: 'live', today: ymd, label: '开盘竞价', progress: 0.04, tradable: true };
    }
    if (m <= 11 * 60 + 30) {
      return { state: 'live', today: ymd, label: '上午交易', progress: 0.02 + (m - 570) / 120 * 0.48, tradable: true };
    }
    if (m < 13 * 60) {
      return { state: 'live', today: ymd, label: '午间休市', progress: 0.5, tradable: true };
    }
    if (m < 15 * 60) {
      return { state: 'live', today: ymd, label: '下午交易', progress: 0.5 + (m - 780) / 120 * 0.5, tradable: true };
    }
    return { state: 'post', today: ymd, label: '已收盘', progress: 1, tradable: true };
  }

  /* ------------------------------------------------------------------ *
   * 8. 统一取数入口：带缓存与降级
   * ------------------------------------------------------------------ */
  var CACHE = {};
  var TTL = 180000;

  function cached(k, p) {
    var hit = CACHE[k];
    if (hit && Date.now() - hit.t < TTL) return Promise.resolve(hit.v);
    return p().then(function (v) {
      CACHE[k] = { t: Date.now(), v: v };
      return v;
    });
  }

  /* 全市场：东财与新浪并行（都在 2~4 秒内），成功几家用几家。
   * 并行而不是串行降级，是为了拿到两家的交集做交叉验证；
   * 只有一家成功时，也照样能跑，只是标注「单源」。 */
  function universe(prefix, onProgress) {
    return cached('universe', function () {
      var t0 = Date.now();
      var pEm = emUniverse(prefix).then(function (r) { return { src: 'em', rows: r }; }, function (e) { return { src: 'em', err: e.message }; });
      var pSn = sinaUniverse(prefix, onProgress).then(function (r) { return { src: 'sina', rows: r }; }, function (e) { return { src: 'sina', err: e.message }; });

      return Promise.all([pEm, pSn]).then(function (res) {
        var ok = res.filter(function (r) { return r.rows && r.rows.length; });
        if (!ok.length) {
          var errs = res.map(function (r) { return r.src + ': ' + r.err; }).join('；');
          throw new Error('全市场数据源全部不可用（' + errs + '）');
        }
        /* 两源都只拿到抽样时，不能拿抽样当全市场 */
        var full = ok.filter(function (r) { return !r.rows._truncated; });
        if (!full.length) {
          throw new Error('全市场数据源均只返回抽样（'
            + ok.map(function (r) { return r.src + ' ' + r.rows.length + ' 条'; }).join('、')
            + '），无法覆盖全市场');
        }

        /* 工作集必须是完整的那一家：截断的源样本太小，拿它当工作集会让
         * 后续过滤只剩个位数的票。同为完整时西财字段更全（有资金流）优先。 */
        var rank = { em: 2, sina: 1 };
        full.sort(function (a, b) { return rank[b.src] - rank[a.src]; });
        var work = full[0];

        var cross = null;
        var other = ok.filter(function (r) { return r.src !== work.src; })[0];
        if (other) {
          cross = crossUniverse(work.rows, other.rows);
          cross.refSrc = work.src;
          cross.candSrc = other.src;
          /* 对面那家只有抽样时，一致率代表的是抽样一致率，不能当全域结论 */
          cross.sampled = !!(other.rows._truncated);
          cross.usable = cross.agreeRate >= 0.85;
        }

        work.rows._src = work.src;
        work.rows._srcList = ok.map(function (r) { return r.src + (r.rows._truncated ? '(抽样)' : ''); });
        work.rows._cross = cross;
        work.rows._failed = res.filter(function (r) { return r.err; }).map(function (r) {
          return { src: r.src, err: r.err };
        });
        work.rows._ms = Date.now() - t0;
        return work.rows;
      });
    });
  }

  function clearCache() { CACHE = {}; }

  /* 全市场抽样交叉：东财 clist 常被截断甚至不可达，此时无法做「全域比对」。
   * 改用东财 ulist 按代码点名核对一批样本，既稳定又能给出量化的一致率。
   * 抽样按等距取，避免排序带来的偏差（工作集是按成交额排序的）。 */
  function sampleCross(rows, prefix, n) {
    n = n || 120;
    var act = rows.filter(function (r) { return r.price > 0; });
    if (act.length < 20) return Promise.resolve(null);
    var step = Math.max(1, Math.floor(act.length / n));
    var pick = [];
    for (var i = 0; i < act.length && pick.length < n; i += step) pick.push(act[i]);

    var t0 = Date.now();
    return emQuotes(pick.map(function (r) { return r.code; }), prefix).then(function (em) {
      var common = 0, ok = 0, devs = [], bad = [];
      pick.forEach(function (r) {
        var q = em[r.code];
        if (!q || !(q.price > 0) || !(r.price > 0)) return;
        common++;
        var dev = Math.abs(r.price - q.price) / q.price * 100;
        devs.push(dev);
        if (dev <= TOL_BASE) ok++;
        else bad.push({ code: r.code, name: r.name, a: r.price, b: q.price, dev: dev });
      });
      devs.sort(function (a, b) { return a - b; });
      bad.sort(function (a, b) { return b.dev - a.dev; });
      return {
        asked: pick.length, n: common, agree: ok,
        agreeRate: common ? ok / common : 0,
        median: devs.length ? devs[devs.length >> 1] : 0,
        max: devs.length ? devs[devs.length - 1] : 0,
        worst: bad.slice(0, 5), ms: Date.now() - t0,
        refSrc: rows._src || '', candSrc: 'em',
      };
    }).catch(function (e) { return { error: kindErr(e) }; });
  }

  return {
    SOURCES: SOURCES,
    TOL: TOL_BASE,
    status: status,
    universe: universe,
    emUniverse: emUniverse,
    emQuotes: emQuotes,
    sinaUniverse: sinaUniverse,
    txQuotes: txQuotes,
    thsQuote: thsQuote,
    txBars: txBars,
    txBarsRaw: txBarsRaw,
    emBars: emBars,
    thsBars: thsBars,
    crossUniverse: crossUniverse,
    crossQuote: crossQuote,
    crossBars: crossBars,
    sampleCross: sampleCross,
    verifyBatch: verifyBatch,
    session: session,
    parseThsTime: parseThsTime,
    parseTxTime: parseTxTime,
    clearCache: clearCache,
    _kindErr: kindErr,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Feeds;
