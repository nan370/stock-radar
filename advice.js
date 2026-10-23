/* 建议生成：基于算法结果 + 可选大模型润色
 *
 * 分工原则（重要）：
 *   - 所有数值结论（趋势、支撑、压力、止损）均由 ta.js 算法确定性计算
 *   - 本模块只做两件事：把结构化结果翻译成人话；可选调用大模型做叙事润色
 *   - 模型不得修改任何数值，只允许在给定数值范围内组织语言
 */

const Advice = (() => {

  /* ---- 纯规则版建议：完全离线，不依赖大模型 ---- */
  function rule(a) {
    const out = { action: '', tone: 'neutral', headline: '', points: [], risk: '' };
    const up = a.price >= a.prevClose;
    const t = a.trend;
    const nearSup = a.supports[0];
    const nearRes = a.resistances[0];
    const atrPct = a.atr ? (a.atr / a.price) * 100 : 0;

    // 1. 趋势定性
    if (t.cls === 'strong-bull') {
      out.tone = 'bull';
      out.headline = '趋势强势向上，回调即为机会';
      out.points.push(`八项技术指标中${t.score > 0 ? '多项' : '部分'}转强，综合评分 ${t.score}，属多头格局`);
      out.points.push(`股价位于20日、60日均线上方，中期趋势结构完整`);
    } else if (t.cls === 'mild-bull') {
      out.tone = 'bull';
      out.headline = '趋势温和向上，可持有观察';
      out.points.push(`综合评分 ${t.score}，多头略占优势但强度有限`);
    } else if (t.cls === 'neutral') {
      out.tone = 'neutral';
      out.headline = '多空均衡，区间震荡为主';
      out.points.push(`综合评分 ${t.score}，多空力量均衡，缺乏明确方向`);
    } else if (t.cls === 'mild-bear') {
      out.tone = 'bear';
      out.headline = '趋势温和下行，反弹需谨慎';
      out.points.push(`综合评分 ${t.score}，空头略占优，上行阻力较大`);
    } else {
      out.tone = 'bear';
      out.headline = '趋势弱势下行，注意风险控制';
      out.points.push(`综合评分 ${t.score}，多项指标转弱，中期趋势不利`);
    }

    // 2. 位置判断
    if (nearSup && nearRes) {
      const dSup = nearSup.distance, dRes = nearRes.distance;
      if (dSup < 1.5 && dRes < 1.5) {
        out.points.push(`股价夹在支撑 ${nearSup.price.toFixed(2)} 与压力 ${nearRes.price.toFixed(2)} 之间，仅 ${(dRes + dSup).toFixed(1)}% 空间，方向选择前不宜重仓`);
      } else if (dSup <= dRes) {
        out.points.push(`距最近支撑 ${nearSup.price.toFixed(2)} 仅 ${dSup.toFixed(2)}%，处于相对低位，关键位可尝试介入`);
      } else {
        out.points.push(`距最近压力 ${nearRes.price.toFixed(2)} 仅 ${dRes.toFixed(2)}%，处于相对高位，遇阻回落风险上升`);
      }
    }

    // 3. RSI 判断
    if (a.rsi != null) {
      if (a.rsi > 70) out.points.push(`RSI ${a.rsi.toFixed(1)} 进入超买区（>70），短期回调概率增大，不宜追高`);
      else if (a.rsi < 30) out.points.push(`RSI ${a.rsi.toFixed(1)} 进入超卖区（<30），存在技术性反弹需求`);
      else out.points.push(`RSI ${a.rsi.toFixed(1)} 处于中性区间（30-70），无超买超卖压力`);
    }

    // 4. 波动率
    if (a.atr) {
      out.points.push(`日均真实波幅 ATR=${a.atr.toFixed(2)}（约${atrPct.toFixed(2)}%），${atrPct > 3.5 ? '波动剧烈，需缩小仓位并放宽止损' : atrPct > 2 ? '波动适中' : '波动温和'}`);
    }

    // 5. 操作建议
    const overbought = a.rsi != null && a.rsi > 70;
    const nearResDist = nearRes ? nearRes.distance : null;
    const nearSupDist = nearSup ? nearSup.distance : null;
    // 趋势强但已接近压力位/超买时，不给"加仓"建议，避免自相矛盾
    const chasingRisk = overbought || (nearResDist != null && nearResDist < 1.5 && a.rsi > 60);

    if (chasingRisk && (t.cls === 'strong-bull' || t.cls === 'mild-bull')) {
      out.action = '持有 / 不宜追高';
      out.headline = '趋势向上但已接近压力区，等待回踩更优';
      out.points.push(`操作：${overbought ? `RSI已达 ${a.rsi.toFixed(1)} 超买区` : `距压力位 ${nearRes.price.toFixed(2)} 仅 ${nearResDist.toFixed(2)}%`}，此时追高性价比差`
        + (nearSup ? `；建议持有现有仓位，回踩 ${nearSup.price.toFixed(2)} 附近再考虑加仓` : '；建议持有现有仓位等待回调'));
    } else if (t.cls === 'strong-bull') {
      out.action = '持股 / 回踩加仓';
      out.points.push(`操作：回踩 ${nearSup ? nearSup.price.toFixed(2) : '短期均线'} 附近不破可分批建仓，`
        + (nearSup && a.atr ? `止损设在最近支撑下方1倍ATR（约 ${(nearSup.price - a.atr).toFixed(2)}）` : '并设置明确止损'));
    } else if (t.cls === 'mild-bull') {
      out.action = up ? '持股 / 逢低吸纳' : '观望 / 等待确认';
      out.points.push(up && nearSup
        ? `操作：${nearSup.price.toFixed(2)} 为关键支撑，跌破前可轻仓持有，跌破则离场观望`
        : '操作：当日收跌且动能未确认，建议等待趋势明朗再加仓');
    } else if (t.cls === 'neutral') {
      out.action = '观望 / 区间操作';
      if (nearSup && nearRes) {
        const width = nearRes.distance + nearSup.distance;
        out.points.push(width < 3
          ? `操作：支撑 ${nearSup.price.toFixed(2)} 与压力 ${nearRes.price.toFixed(2)} 间距仅 ${width.toFixed(1)}%，空间狭窄，方向未明前不宜重仓`
          : `操作：区间 ${nearSup.price.toFixed(2)} ~ ${nearRes.price.toFixed(2)} 内高抛低吸，突破区间再顺势跟进`);
      }
    } else if (t.cls === 'mild-bear') {
      out.action = '减仓 / 反弹减磅';
      out.points.push(`操作：反弹至 ${nearRes ? nearRes.price.toFixed(2) : '上方压力区'} 附近遇阻可减仓，`
        + `跌破 ${nearSup ? nearSup.price.toFixed(2) : '前低'} 需止损离场`);
    } else {
      out.action = '离场观望';
      out.points.push('操作：趋势明显走弱，建议降低仓位或空仓等待，不宜逆势抄底');
      if (nearSup) out.points.push(`若已持仓，${nearSup.price.toFixed(2)} 是最后防线，跌破应果断离场`);
    }

    out.risk = atrPct > 3.5
      ? '该标的日波动率较高，单日波动可能超过3%，仓位与止损需从严设置'
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
【趋势判定】${a.trend.label}（综合评分 ${a.trend.score}）
【支撑位】${supportTxt || '当前价位下方暂无有效支撑聚集'}
【压力位】${resistTxt || '当前价位上方暂无有效压力聚集'}
【RSI14】${a.rsi != null ? a.rsi.toFixed(1) : '样本不足'}
【ATR14】${a.atr != null ? a.atr.toFixed(2) : '样本不足'}
【20日动量】${a.trend.mom20 != null ? (a.trend.mom20 >= 0 ? '+' : '') + a.trend.mom20.toFixed(2) + '%' : '样本不足'}

算法给出的操作建议是：${base.action}
算法给出的风险提示是：${base.risk}

请写一段 150-250 字的分析师点评，要求：
1. 严格使用上述数值，一个数字都不要改动、不要重新计算
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