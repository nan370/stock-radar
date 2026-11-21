# -*- coding: utf-8 -*-
"""
生成 breadth_seed.json —— 近似通达信 880005「涨跌家数」
口径：沪深两市全部 A 股（不含北交所），逐日按「收盘价 vs 上一交易日收盘价」统计
      上涨 / 下跌 / 平盘 家数（停牌当日无 K 线，不计入）。
做法：腾讯日 K（不复权）批量拉取最近 N 个交易日，聚合出每日家数。
用途：给 stock-radar 情绪看板的「涨跌家数」图做历史回补（前端无法直连通达信）。
"""
import json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                    '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Referer': 'https://gu.qq.com/'}
TPL = 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=%s,day,,,%d'
KEEP = 55          # 取多少根日线（多取几天，防节假日/停牌断档）


def fetch(sym, retry=2):
    url = TPL % (sym, KEEP)
    for i in range(retry + 1):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=12) as f:
                raw = f.read().decode('utf-8', 'ignore')
            d = json.loads(raw)
            node = (d.get('data') or {}).get(sym) or {}
            rows = node.get('day') or node.get('qfqday') or []
            return rows
        except Exception:
            if i == retry:
                return []
            time.sleep(0.4)
    return []


def main():
    app = BASE
    for cand in (os.path.join(BASE, 'stock-radar-app'), r'E:\WorkBuddyData\WorkBuddy\stock-radar-app'):
        if os.path.exists(os.path.join(cand, 'a_share_all.json')):
            app = cand
            break
    allf = os.path.join(app, 'a_share_all.json')
    stocks = json.load(open(allf, encoding='utf-8'))
    syms = []
    for s in stocks:
        norm = s.get('norm') or ''
        # 只保留沪深 A 股：沪市 60x/68x，深市 00x/30x（排除 B 股 sh9/sz2 与北交所 bj）
        if norm.startswith('sh6') or norm.startswith('sz00') or norm.startswith('sz30'):
            syms.append(norm)
    syms = sorted(set(syms))
    print('待拉取', len(syms), '只', flush=True)

    # date -> [up, down, flat]
    agg = {}
    done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=10) as pool:
        futs = {pool.submit(fetch, s): s for s in syms}
        for fu in as_completed(futs):
            rows = fu.result()
            done += 1
            if done % 500 == 0:
                print('  %d/%d  %.1fs' % (done, len(syms), time.time() - t0), flush=True)
            prev = None
            for r in rows:
                try:
                    date, close = r[0], float(r[2])
                except (IndexError, ValueError, TypeError):
                    continue
                if prev is not None:
                    cell = agg.setdefault(date, [0, 0, 0])
                    if close > prev:
                        cell[0] += 1
                    elif close < prev:
                        cell[1] += 1
                    else:
                        cell[2] += 1
                prev = close

    dates = sorted(agg.keys())
    # 只保留最后 40 个交易日
    dates = dates[-40:]
    out = {}
    for d in dates:
        u, dn, fl = agg[d]
        tot = u + dn + fl
        if tot < 1000:      # 数据明显不全的丢弃
            continue
        out[d] = [u, dn, fl]
    print('有效交易日', len(out), '区间', dates[0] if dates else '-', '->', dates[-1] if dates else '-')

    dst = os.path.join(app, 'breadth_seed.json')
    payload = {
        'src': 'tencent-kline · 沪深A股(不含北交所) · 口径近似通达信880005',
        'updated': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'rows': out,
    }
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    print('已写', dst, os.path.getsize(dst), 'bytes')
    for d in dates[-6:]:
        print(' ', d, agg.get(d))


if __name__ == '__main__':
    main()
