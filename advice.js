/* 建议生成：基于算法结果 + 可选大模型润色
 *
 * 分工原则（重要）：
 *   - 所有数值结论（趋势、支撑、压力、止损）均由 ta.js 算法确定性计算
 *   - 本模块只做两件事：把结构化结果翻译成人话；可选调用大模型做叙事润色
 *   - 模型不得修改任何数值，只允许在给定数值范围内组织语言
 */

const Advice = (() => {

  /* ---- 纯规则版建议：完全离线，不依赖大模型 ----
   * 2026-10-24 重写：以前只看均线八项，于是「当日 +7.8%」的票能被写成
   * 「弱势空头 / 离场观望」—— 均线确实还没跟上，但结构层面早已转向，
   * 两句话放在一起用户只会觉得这系统在瞎说。
   * 现在结论按「结构 → 量价 → 均线」的次序取主导项，冲突时明说冲突，
   * 并且止损/买区/目标一律取 Model.plan 算好的数，不再自己另算一套。 */
  function rule(a) {
    const out = { action: '', tone: 'neutral', headline: '', points: [], risk: '' };
    const up = a.price >= a.prevClose;
    const t = a.trend;
    const pl = a.plan || null;
    const d = a.day || null;
    const wy = a.wyckoff || null;
    const sc = a.score || null;
    const cy = wy && wy.cycle ? wy.cycle : null;
    const grade = d && d.buy ? (d.buy.grade || 0) : 0;
    const nearSup = a.supports[0];
    const nearRes = a.resistances[0];
    const atrPct = a.atr ? (a.atr / a.price) * 100 : 0;
    const overbought = a.rsi != null && a.rsi > 70;
    const nearResDist = nearRes ? nearRes.distance : null;
    const rr = pl ? pl.rr : null;

    /* 1. 结构主线：缠论买点 > 均线分类 */
    const structTxt = d
      ? `缠论：月线${a.month ? a.month.dirText : '样本不足'}、周线${a.week ? a.week.dirText : '样本不足'}、日线${d.dirText}，
        日线位于${({ above: '中枢上方', inside: '中枢内部', below: '中枢下方' })[d.position] || '中枢位置不明'}
        ${grade ? '，' + ({ 1: '一买（背驰反弹）', 2: '二买（不破前低）', 3: '三买（回调不进中枢）' })[grade] : '，无有效买点'}`
      : null;

    if (grade >= 2 && (!d.conflict)) {
      out.tone = 'bull';
      out.headline = grade === 3 ? '三买成立：回调没进中枢，结构最健康' : '二买成立：回调不破前低，趋势延续概率较高';
    } else if (grade === 1 || (d && d.diverg && d.diverg.type === 'bottom')) {
      out.tone = 'bull';
      out.headline = '底背驰已现，属超跌反弹性质，需次级别回踩确认';
    } else if (t.cls === 'strong-bull' || t.cls === 'mild-bull') {
      out.tone = 'bull';
      out.headline = t.cls === 'strong-bull' ? '均线多头排列，回调即为机会' : '均线温和向上，可持有观察';
    } else if (t.cls === 'neutral') {
      out.tone = 'neutral';
      out.headline = '多空均衡，区间震荡为主';
    } else if (t.cls === 'mild-bear') {
      out.tone = 'bear';
      out.headline = '均线温和下行，反弹需谨慎';
    } else {
      out.tone = 'bear';
      out.headline = '均线弱势下行，注意风险控制';
    }

    /* 2. 当日涨跌与结构冲突时，必须显式解释，不能装作没看见 */
    const dayBig = Math.abs(a.changePct) >= 4;
    if (dayBig && out.tone === 'bear') {
      out.points.push(`今日${a.changePct > 0 ? '大涨' : '大跌'} ${Math.abs(a.changePct).toFixed(2)}%，但均线仍是空头排列 ——
        这是「反弹」与「反转」的分界问题：结构没走出来之前，把大涨当反弹处理，
        不追高，等回踩不破 ${pl ? pl.stop.toFixed(2) : '前低'} 再看`);
    } else if (dayBig && out.tone === 'bull' && a.changePct < 0) {
      out.points.push(`今日回调 ${Math.abs(a.changePct).toFixed(2)}%，仍在多头结构内，属正常回踩`);
    }

    /* 3. 结构 + 量价两条硬依据 */
    if (structTxt) out.points.push(structTxt.replace(/\s+/g, ' '));
    if (cy) out.points.push(`威科夫：${cy.name}。${cy.text}`);
    if (wy && wy.volRatio != null) {
      out.points.push(`量比 ${wy.volRatio.toFixed(2)}（近 20 日均量为基准），
        多头量价事件 ${wy.bullCount} 个 / 空头 ${wy.bearCount} 个，
        ${wy.bullCount > wy.bearCount ? '量价层面偏多' : wy.bearCount > wy.bullCount ? '量价层面偏空' : '量价层面中性'}`);
    }

    /* 4. 位置判断 */
    if (nearSup && nearRes) {
      const dSup = nearSup.distance, dRes = nearRes.distance;
      if (dSup < 1.5 && dRes < 1.5) {
        out.points.push(`股价夹在支撑 ${nearSup.price.toFixed(2)} 与压力 ${nearRes.price.toFixed(2)} 之间，
          仅 ${(dRes + dSup).toFixed(1)}% 空间，方向选择前不宜重仓`);
      } else if (dSup <= dRes) {
        out.points.push(`距最近支撑 ${nearSup.price.toFixed(2)} 仅 ${dSup.toFixed(2)}%，处于相对低位，关键位可尝试介入`);
      } else {
        out.points.push(`距最近压力 ${nearRes.price.toFixed(2)} 仅 ${dRes.toFixed(2)}%，处于相对高位，遇阻回落风险上升`);
      }
    }

    /* 5. RSI / 波动率 */
    if (a.rsi != null) {
      if (a.rsi > 70) out.points.push(`RSI ${a.rsi.toFixed(1)} 进入超买区（>70），短期回调概率增大，不宜追高`);
      else if (a.rsi < 30) out.points.push(`RSI ${a.rsi.toFixed(1)} 进入超卖区（<30），存在技术性反弹需求`);
      else out.points.push(`RSI ${a.rsi.toFixed(1)} 处于中性区间（30-70），无超买超卖压力`);
    }
    if (a.atr) {
      out.points.push(`日均真实波幅 ATR=${a.atr.toFixed(2)}（约 ${atrPct.toFixed(2)}%），
        ${atrPct > 3.5 ? '波动剧烈，需缩小仓位并放宽止损' : atrPct > 2 ? '波动适中' : '波动温和'}`);
    }

    /* 6. 操作建议：买区/止损/目标统一取 plan，不再另算 */
    const chasing = overbought || (nearResDist != null && nearResDist < 1.5 && a.rsi > 60);
    const bp = (v) => (v == null || !isFinite(v) ? '--' : v.toFixed(2));

    if (pl && pl.waitPullback && (out.tone === 'bull' || grade >= 2)) {
      out.action = '等回踩 / 不追高';
      out.headline += `；现价高于买区，等回到 ${bp(pl.buyLo)}~${bp(pl.buyHi)} 再动手`;
      out.points.push(`操作：现价 ${bp(a.price)} 高于计划买区上沿 ${bp(pl.buyHi)}，
        直接买等于在压力位下方接货；等回踩到 ${bp(pl.buyLo)}~${bp(pl.buyHi)} 分批，
        止损 ${bp(pl.stop)}（${pl.stopReason}），目标 ${bp(pl.target1)}，盈亏比 ${rr ? rr.toFixed(2) : '--'}`);
    } else if (chasing && (out.tone === 'bull' || grade >= 2)) {
      out.action = '持有 / 不宜追高';
      out.points.push(`操作：${overbought ? `RSI 已达 ${a.rsi.toFixed(1)} 超买` : `距压力位 ${nearRes.price.toFixed(2)} 仅 ${nearResDist.toFixed(2)}%`}，
        追高性价比差；回踩 ${pl ? bp(pl.buyLo) + '~' + bp(pl.buyHi) : nearSup ? nearSup.price.toFixed(2) + ' 附近' : '支撑位'} 再考虑加仓`);
    } else if (out.tone === 'bull' && pl) {
      out.action = grade >= 2 ? '分批建仓' : (up ? '持股 / 逢低吸纳' : '观望 / 等待确认');
      out.points.push(`操作：买区 ${bp(pl.buyLo)}~${bp(pl.buyHi)}，止损 ${bp(pl.stop)}（${pl.stopReason}，
        距中值 ${pl.riskPct.toFixed(1)}%），目标 ${bp(pl.target1)} / ${bp(pl.target2)}，
        盈亏比 ${rr ? rr.toFixed(2) : '--'}；仓位按单笔风险 1% 反推 ≤ ${pl.riskPct > 0 ? Math.min(100, 1 / pl.riskPct * 100).toFixed(0) : '--'}%`);
    } else if (t.cls === 'neutral') {
      out.action = '观望 / 区间操作';
      if (nearSup && nearRes) {
        const width = nearRes.distance + nearSup.distance;
        out.points.push(width < 3
          ? `操作：支撑 ${nearSup.price.toFixed(2)} 与压力 ${nearRes.price.toFixed(2)} 间距仅 ${width.toFixed(1)}%，空间狭窄，方向未明前不宜重仓`
          : `操作：区间 ${nearSup.price.toFixed(2)} ~ ${nearRes.price.toFixed(2)} 内高抛低吸，突破区间再顺势跟进`);
      }
    } else if (out.tone === 'bear' && grade === 0 && t.cls === 'mild-bear') {
      out.action = '减仓 / 反弹减磅';
      out.points.push(`操作：反弹至 ${nearRes ? nearRes.price.toFixed(2) : '上方压力区'} 附近遇阻可减仓，
        跌破 ${pl ? bp(pl.stop) : nearSup ? nearSup.price.toFixed(2) : '前低'} 需止损离场`);
    } else if (pl && a.price > pl.stop) {
      /* 现价还在计划失效位之上时，说「离场」等于让人在止损位上方 9% 割肉，
       * 与同一张卡上的交易计划直接打架。这里把两种情况分开说。 */
      out.action = '不加仓 / 持仓守止损';
      out.points.push(`操作：空仓者不参与这段逆势反弹 —— 现价 ${bp(a.price)} 距最近压力 ${nearRes ? bp(nearRes.price) : '上方压力'} 只有 ${nearRes ? nearRes.distance.toFixed(2) + '%' : '有限空间'}`);
      out.points.push(`持仓者按计划执行：${bp(pl.stop)} 才是失效位（${pl.stopReason}，还有 ${((a.price - pl.stop) / a.price * 100).toFixed(2)}% 空间），
        跌破再走；反弹到压力 ${nearRes ? bp(nearRes.price) : '上方'} 附近可先减半仓`);
    } else {
      out.action = '离场观望';
      out.points.push('操作：趋势明显走弱，建议降低仓位或空仓等待，不宜逆势抄底');
      if (pl) out.points.push(`若已持仓，${bp(pl.stop)} 是计划失效位（${pl.stopReason}），已跌破，反弹即减`);
      else if (nearSup) out.points.push(`若已持仓，${nearSup.price.toFixed(2)} 是最后防线，跌破应果断离场`);
    }

    /* 7. 评分与风险 */
    if (sc) {
      out.points.push(`多因子综合 ${sc.total}/100（${sc.grade} 级 · ${sc.gradeText}），
        分项：结构 ${sc.structure} / 量价 ${sc.volume} / 动量 ${sc.momentum} / 资金 ${sc.money} / 风险 ${sc.risk}`);
    }
    out.risk = atrPct > 3.5
      ? '该标的日波动率较高，单日波动可能超过 3%，仓位与止损需从严设置'
      : '技术分析基于历史价量数据，无法预判突发消息与政策变化，需结合基本面与市场情绪综合决策';

    return out;
  }

  /* ---- 大模型润色：只做叙事组织，不改数值 ----
   * 注意：云端 LLM 仅支持流式（stream:true），且 messages[0] 必须是 system。 */
  async function polish(a, base, cloud, modelId) {
    try {
      const supportTxt = a.supports.map((s, i) =>
        `支撑${i + 1} ${s.price.toFixed(2)}（低于现价${s.distance.toFixed(2)}%，依据：${s.labels.join('、')}）`).join('；');
      const resistTxt = a.resistances.map((r, i) =>
        `压力${i + 1} ${r.price.toFixed(2)}（高于现价${r.distance.toFixed(2)}%，依据：${r.labels.join('、')}）`).join('；');

      const userPrompt = `下面是某标的的技术分析结果，**所有数值均由算法确定性计算得出，禁止修改任何数字**。

【标的】${a.name}（${a.code}）
【最新收盘】${a.price}，当日${a.changePct >= 0 ? '涨' : '跌'} ${Math.abs(a.changePct).toFixed(2)}%
【均线趋势】${a.trend.label}（均线打分 ${a.trend.score}，量纲约 -9~+9，只表示均线排列的强弱，**不是综合评分**）
【综合评分】${a.score && a.score.total != null
        ? `${a.score.total}/100（${a.score.grade} 级）—— 这才是全文唯一可以称为"综合评分"的数字`
        : '样本不足'}
【支撑位】${supportTxt || '当前价位下方暂无有效支撑聚集'}
【压力位】${resistTxt || '当前价位上方暂无有效压力聚集'}
【RSI14】${a.rsi != null ? a.rsi.toFixed(1) : '样本不足'}
【ATR14】${a.atr != null ? a.atr.toFixed(2) : '样本不足'}
【20日动量】${a.trend.mom20 != null ? (a.trend.mom20 >= 0 ? '+' : '') + a.trend.mom20.toFixed(2) + '%' : '样本不足'}

算法给出的操作建议是：${base.action}
算法给出的风险提示是：${base.risk}

请写一段 150-250 字的分析师点评，要求：
1. 严格使用上述数值，一个数字都不要改动、不要重新计算
1b. 提到"综合评分"时只能引用【综合评分】里的 0~100 数值与等级，
   绝不能把【均线趋势】里的均线打分（-9~+9）说成综合评分，两者量纲完全不同
2. 说明当前处于什么技术形态，为什么得出这个判断
3. 说明支撑压力位的含义（这些价位为什么重要）
4. 给出具体可执行的操作，含仓位与止损参考
5. 结尾提示风险
6. 不要出现"根据数据显示"这类空洞开场白，直接讲结论
7. 不要使用 markdown 标题或列表，纯段落文字`;

      let content = '';
      let reasoning = '';
      const messages = [
        {
          role: 'system',
          content: '你是资深证券分析师，擅长把结构化的技术分析结果转述为专业、易懂的点评。'
            + '你只能使用用户提供的数值，严禁自行计算、修改或臆造任何数字。'
            + '输出为纯段落中文，不使用 markdown 格式，不使用标题或列表。',
        },
        { role: 'user', content: userPrompt },
      ];

      for await (const chunk of cloud.llm.chat.completions.create({
        model: modelId,
        messages,
        stream: true,
        temperature: 1,
      })) {
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      }
      content = content.trim();
      return content.length > 40 ? content : null;
    } catch (e) {
      console.warn('[Advice] 模型润色失败，回退到规则版本', e?.message);
      return null;
    }
  }

  return { rule, polish };
})();