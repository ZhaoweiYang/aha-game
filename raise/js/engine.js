/*
 * 涨薪军师 · 方案引擎
 * - analyze(input)      → 付费前展示的诊断数据（成功率 / 幅度 / 策略）
 * - buildReport(input)  → 付费后的完整方案（结构化 blocks，前端负责渲染）
 *
 * 方法论：哈佛谈判项目原则式谈判（BATNA / 客观标准 / 利益而非立场）、
 * Chris Voss《掌控谈话》FBI 战术同理心、精确锚点研究（Mason et al., 2013）。
 * 基准数据：PayScale Raise Anatomy（2018，约 16 万人）、前程无忧 2025 年调薪数据。
 * 生产环境此文件只在服务端运行，不下发到浏览器。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./schema.js'));
  else root.RaiseEngine = factory(root.RaiseSchema);
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  const L = S.label;

  /* ---------------- 工具函数 ---------------- */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  const round05 = (v) => Math.round(v * 2) / 2;
  const round10 = (v) => Math.round(v / 10) * 10;
  const money = (n) => '¥' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const pct = (v) => (Math.round(v * 10) / 10).toString().replace(/\.0$/, '') + '%';

  // 精确数字比整数更像“做过功课”的报价（Mason et al., 2013），避开整千 / 整五百
  function preciseAmount(x) {
    let v = Math.round(x / 10) * 10;
    if (v % 100 === 0) v += 30;
    return v;
  }

  const hasNumber = (s) => /\d/.test(s || '');
  const isQuantified = (input) => hasNumber(input.achievementText) && input.achievementText.length >= 8;
  // offer 只有比现在薪资高时才是筹码
  const offerLeverage = (input) => input.offer === 'has_offer' && input.offerSalary > input.salary;
  // 入职不满 1 年且没调过薪，不算“该涨了”，按 6-12 个月处理
  const lastRaiseOf = (input) => (input.tenure === 'lt1' && input.lastRaise === 'never' ? '6to12' : input.lastRaise);
  // 用户填写的成果去掉换行和结尾标点，方便嵌入到句子里
  const achievementClause = (input) => (input.achievementText || '').replace(/\s*\n+\s*/g, '；').replace(/[。！!？?.；;，,、\s]+$/, '');

  /* ---------------- 涨幅模型 ---------------- */

  function raiseRange(input) {
    let mid = S.INDUSTRY_BASE[input.industry] || 4.1;
    mid += { top: 5, good: 2.5, average: 0.5, below: -2, none: 0.5 }[input.performance];
    mid += { below20: 6, below10: 3, equal: 0.5, above: -1.5, unknown: 0.5 }[input.market];
    mid += Math.min(input.achievements.length, 5) * 0.6;
    mid += (input.irreplaceable - 3) * 1.2;
    mid += { lt6: -2, '6to12': 0, '12to24': 1.5, gt24: 3, never: 3 }[lastRaiseOf(input)];
    if (input.offer === 'interviewing') mid += 1.5;
    if (input.goal === 'promotion') mid += 3;
    mid *= { fast: 1.25, stable: 1, slow: 0.7, layoff: 0.45 }[input.companyStatus];
    mid *= { soe: 0.75, foreign: 0.95, startup: 1.1, listed: 1, private: 1 }[input.companyType];
    if (input.bossPower === 'rigid') mid *= 0.8;

    let offerPremium = 0;
    if (input.offer === 'has_offer' && input.offerSalary > input.salary) {
      offerPremium = (input.offerSalary / input.salary - 1) * 100;
      const counter = Math.min(offerPremium * 0.75, 40);
      mid = Math.max(mid, input.willingToLeave === 'no' ? counter * 0.6 : counter);
    }

    mid = clamp(mid, 2, 40);
    const low = round05(Math.max(1.5, mid * 0.55));
    const high = round05(Math.min(50, mid * 1.4));
    return { low, mid: round05(mid), high, offerPremium: Math.round(offerPremium * 10) / 10 };
  }

  /* ---------------- 成功率模型 ----------------
   * 逻辑回归形式：z = 基准 + Σ因素。基准对应“业绩合格、条件中性的人主动开口”，
   * 校准参照 PayScale：主动要求加薪的人中约 70% 获得了不同程度的涨薪。
   * 每个因素标注是否“可控”：可控因素在按方案准备后会被优化，形成“执行方案后”的成功率。
   */
  function factorList(input, range) {
    const f = [];
    const add = (key, z, text, opt) => f.push(Object.assign({ key, z, text, optZ: z, controllable: false }, opt || {}));

    add('perf', { top: 0.8, good: 0.4, average: 0, below: -0.9, none: -0.15 }[input.performance],
      '近期绩效：' + L('performance', input.performance));
    const n = input.achievements.length;
    add('achv', Math.min(n, 4) * 0.12, n ? `已有 ${n} 项关键成果` : '缺少可展示的关键成果');
    if (isQuantified(input)) add('quant', 0.2, '成果有数据支撑');
    else add('quant', -0.1, '成果还没有量化成数字', { controllable: true, optZ: 0.2, fix: '方案帮你把成果改写成可量化的价值清单' });
    add('irr', (input.irreplaceable - 3) * 0.22, `岗位不可替代程度 ${input.irreplaceable}/5`);
    add('market', { below20: 0.45, below10: 0.3, equal: 0, above: -0.45, unknown: -0.1 }[input.market],
      '薪资与市场相比：' + L('market', input.market),
      input.market === 'unknown' ? { controllable: true, optZ: 0, fix: '方案给出市场薪资调研路径，用客观数据说话' } : null);
    if (input.offer === 'interviewing') add('offer', 0.2, '正在接触外部机会');
    if (offerLeverage(input)) add('offer', input.willingToLeave === 'no' ? 0.3 : 0.55, '手上有更高薪的外部 offer');
    add('status', { fast: 0.45, stable: 0.1, slow: -0.5, layoff: -1.1 }[input.companyStatus],
      '公司经营：' + L('companyStatus', input.companyStatus));
    add('ctype', { soe: -0.3, foreign: 0.05, listed: 0.05, startup: 0, private: 0 }[input.companyType],
      '企业类型：' + L('companyType', input.companyType));
    add('power', { direct: 0.15, escalate: 0, rigid: -0.25 }[input.bossPower], L('bossPower', input.bossPower));
    add('relation', (input.relation - 3) * 0.2, `与老板关系 ${input.relation}/5`);
    add('lastRaise', { lt6: -0.6, '6to12': 0, '12to24': 0.3, gt24: 0.45, never: 0.45 }[lastRaiseOf(input)],
      '上次调薪：' + L('lastRaise', input.lastRaise));
    if (input.tenure === 'lt1') add('tenure', -0.4, '入职不足 1 年');
    if (input.tenure === 'gt4') add('tenure', 0.1, '在公司 4 年以上，熟悉业务');
    const cyc = {
      soon: [0.3, 0.3], far: [-0.05, 0.05], passed: [-0.3, -0.15], unknown: [0, 0.15]
    }[input.cycle];
    add('cycle', cyc[0], '调薪窗口：' + L('cycle', input.cycle),
      cyc[1] !== cyc[0] ? { controllable: true, optZ: cyc[1], fix: '方案帮你选择开口时机与“非周期调整”理由' } : null);
    if (input.expect > range.high * 1.5) {
      add('expect', -0.3, `期望涨幅 ${input.expect}% 明显超出可支撑区间`, { controllable: true, optZ: 0, fix: '方案按筹码重新校准锚点与目标' });
    } else if (input.expect > range.high * 1.2) {
      add('expect', -0.12, `期望涨幅 ${input.expect}% 略高于可支撑区间`, { controllable: true, optZ: 0, fix: '方案按筹码重新校准锚点与目标' });
    }
    if (input.goal === 'promotion') {
      add('goal', input.performance === 'top' || input.performance === 'good' ? 0.1 : -0.3, '同时争取升职');
    }
    add('prep', 0, '临场沟通准备不足', { controllable: true, optZ: 0.15, fix: '定制面谈脚本 + 反驳应对 + FBI 技巧演练', hidden: true });
    return f;
  }

  const Z0 = -0.35;
  const PROB_MIN = 0.12, BASE_MAX = 0.88, PROB_MAX = 0.93;

  function scoreDims(input) {
    const n = input.achievements.length;
    return [
      {
        key: 'value', label: '业绩价值',
        value: clamp({ top: 88, good: 72, average: 52, below: 25, none: 50 }[input.performance] + Math.min(n, 4) * 3 +
          (input.irreplaceable - 3) * 5 + (isQuantified(input) ? 5 : 0), 5, 100)
      },
      {
        key: 'market', label: '市场筹码',
        value: clamp({ below20: 82, below10: 68, equal: 48, above: 28, unknown: 40 }[input.market] +
          (offerLeverage(input) ? 20 : input.offer === 'none' ? 0 : 10), 5, 100)
      },
      {
        key: 'timing', label: '时机窗口',
        value: clamp({ soon: 82, far: 45, passed: 30, unknown: 55 }[input.cycle] +
          ({ lt6: -25, '6to12': 0, '12to24': 10, gt24: 15, never: 15 }[lastRaiseOf(input)]) +
          ({ fast: 8, stable: 0, slow: -12, layoff: -25 }[input.companyStatus]), 5, 100)
      },
      {
        key: 'relation', label: '信任关系',
        value: clamp(input.relation * 17 + ({ direct: 10, escalate: 0, rigid: -8 }[input.bossPower]), 5, 100)
      },
      {
        key: 'company', label: '公司支付力',
        value: clamp({ fast: 85, stable: 64, slow: 40, layoff: 18 }[input.companyStatus] +
          ({ listed: 5, foreign: 5, soe: -8, startup: 0, private: 0 }[input.companyType]), 5, 100)
      }
    ];
  }

  function strategyOf(input, prob, dims) {
    const timing = dims.find((d) => d.key === 'timing').value;
    if (input.companyStatus === 'layoff' || prob < 0.4) {
      return { key: 'defense', label: '防守反击型', desc: '公司或时机不利，先锁定书面承诺和非现金回报，为下一窗口铺路，不硬碰硬。' };
    }
    if (input.lastRaise === 'lt6' || (timing < 40 && input.offer === 'none')) {
      return { key: 'build', label: '蓄力出击型', desc: '现在开口性价比不高。先用 4-8 周补齐筹码、制造“高光时刻”，在窗口期前 4-6 周开口。' };
    }
    if (prob >= 0.68) {
      return { key: 'offense', label: '主动出击型', desc: '筹码充足，可以主动约谈并报出有野心的锚点，争取目标区间上沿。' };
    }
    return { key: 'steady', label: '稳扎稳打型', desc: '以“价值清单 + 市场依据”为主线，报精确锚点，争取目标区间中位。' };
  }

  /* ---------------- 诊断（付费前可见） ---------------- */

  function analyze(rawInput) {
    const input = S.normalizeInput(rawInput);
    const range = raiseRange(input);
    const factors = factorList(input, range);
    const z = factors.reduce((s, x) => s + x.z, Z0);
    const zOpt = factors.reduce((s, x) => s + x.optZ, Z0);
    const baseProb = clamp(sigmoid(z), PROB_MIN, BASE_MAX);
    // 准备带来的提升最多计 15 个百分点，避免夸大方案效果
    const prob = clamp(sigmoid(zOpt), baseProb, Math.min(PROB_MAX, baseProb + 0.15));
    const dims = scoreDims(input);
    const strategy = strategyOf(input, baseProb, dims);

    // 目标数字
    let target = input.expect;
    let expectNote = '';
    if (input.expect < range.mid) {
      target = range.mid;
      expectNote = `你的期望（${input.expect}%）偏保守，按你的筹码可以争取到 ${pct(range.mid)} 左右。`;
    } else if (input.expect > range.high) {
      target = range.high;
      expectNote = `你的期望（${input.expect}%）高于筹码能支撑的区间，建议目标定在 ${pct(range.high)}，超出部分用非现金方式争取。`;
    }
    target = round05(target);
    let anchor = round05(Math.max(target + 2, target * 1.25));
    if (range.offerPremium > 0 && input.willingToLeave !== 'no') anchor = round05(Math.max(anchor, Math.min(range.offerPremium, 50)));

    // 金额保证 当前薪资 < 底线 < 目标 < 锚点；低薪时按百分比取整可能撞在一起，这里逐级拉开
    const S0 = input.salary;
    const floorAmt = Math.max(round10(S0 * (1 + range.low / 100)), S0 + 10);
    const targetAmt = Math.max(preciseAmount(S0 * (1 + target / 100)), floorAmt + 10);
    const anchorAmt = Math.max(preciseAmount(S0 * (1 + anchor / 100)), targetAmt + 30);
    // 让步阶梯：三次让步约占差额的 50% / 30% / 20%，幅度递减（每次至少 ¥10），最后落在目标上
    const gap = anchorAmt - targetAmt;
    const d3 = Math.max(10, round10(gap * 0.2));
    let d2 = Math.max(d3, round10(gap * 0.3));
    if (gap - d2 - d3 < d2) d2 = Math.max(d3, Math.floor((gap - d3) / 20) * 10);
    const step2 = anchorAmt - (gap - d2 - d3);
    const step3 = targetAmt + d3;
    const pctOf = (amt) => Math.round((amt / S0 - 1) * 1000) / 10;
    const lowAmt = Math.max(10, round10(S0 * range.low / 100));
    const highAmt = Math.max(lowAmt + 10, round10(S0 * range.high / 100));

    const sorted = factors.filter((x) => !x.hidden).slice().sort((a, b) => b.z - a.z);
    const strengths = sorted.filter((x) => x.z > 0.05);
    const risks = sorted.filter((x) => x.z < -0.05).reverse();

    const seg = S.segmentOf(input);
    return {
      input,
      segment: seg,
      baseProb: Math.round(baseProb * 100),
      prob: Math.round(prob * 100),
      range,
      rangeAmount: { low: lowAmt, high: highAmt, annualLow: lowAmt * input.months, annualHigh: highAmt * input.months },
      numbers: {
        anchorPct: pctOf(anchorAmt), targetPct: pctOf(targetAmt), floorPct: pctOf(floorAmt),
        anchor: anchorAmt, target: targetAmt, floor: floorAmt,
        ladder: [anchorAmt, step2, step3, targetAmt],
        expectNote
      },
      dims,
      strategy,
      strengths: strengths.map((x) => x.text),
      risks: risks.map((x) => x.text),
      fixes: factors.filter((x) => x.controllable && x.optZ > x.z).map((x) => x.fix)
    };
  }

  // 付费墙只需要的字段（不暴露方案细节）
  function preview(a) {
    return {
      segment: a.segment,
      baseProb: a.baseProb,
      prob: a.prob,
      range: { low: a.range.low, high: a.range.high },
      rangeAmount: a.rangeAmount,
      strategy: { key: a.strategy.key, label: a.strategy.label },
      topStrength: a.strengths[0] || '',
      riskCount: a.risks.length,
      topRisk: a.risks[0] || '',
      fixes: a.fixes,
      salary: a.input.salary
    };
  }

  /* ---------------- 内容素材 ---------------- */

  const ROLE_VALUE = {
    tech: '系统稳定性、交付速度、攻克的技术难题、为公司节省的研发 / 运维成本',
    product: '你负责的功能上线后带来的数据变化（转化率、留存、DAU、收入）',
    data: '模型 / 分析带来的业务指标提升、节省的人力或决策失误成本',
    design: '设计改版带来的转化提升、设计规范节省的协作时间、品牌一致性',
    sales: '业绩达成率、新签客户数、回款金额、客单价与续约率',
    marketing: '线索量、获客成本下降、活动 ROI、品牌声量',
    operation: '用户增长、活跃 / 留存、GMV、活动投入产出比',
    finance_hr: '节省的成本、规避的合规风险、招聘达成率、流程提效',
    production: '良率、准时交付率、库存周转、降本金额',
    admin: '服务满意度、处理时效、节省的行政费用',
    pro: '专业资质、服务量、质量 / 口碑指标',
    other: '可衡量的产出、节省的时间与成本、对团队目标的贡献'
  };

  const ACHV_LINE = {
    exceed: '超额完成了业绩指标（补充：完成率 __%，团队排名 __）',
    lead: '主导了 __ 项目，从 0 到 1 推动落地（补充：周期、规模、结果数据）',
    revenue: '直接带来了 __ 万元收入 / __ 个客户',
    cost: '通过 __ 为公司节省了约 __ 万元成本 / __ 小时人力',
    extra: '在本职之外承担了 __ 的职责（原本属于 __ 级别 / __ 人的工作量）',
    mentor: '带了 __ 位新人，他们 __ 个月内独立上岗',
    fix: '在 __ 关键时刻解决了 __ 问题，避免了 __ 的损失',
    skill: '新掌握了 __ 技能 / 取得 __ 证书，已经应用在 __ 上',
    praise: '获得了 __（客户 / 高层）的公开认可'
  };

  // 老板风格 → 沟通策略
  const BOSS = {
    driver: {
      name: '拍板型老板',
      how: ['先说结论再说理由，整场控制在 15 分钟内', '每条成果都翻译成“对公司的结果 / 钱”', '准备一句话版本：“我希望调整到 X，因为我带来了 Y”', '别铺垫太多情绪和故事——他会不耐烦'],
      invite: 'X总，想约您 15 分钟，聊聊我过去一段时间的成果和下一阶段想多承担的事，您看这周四或周五哪个时间方便？',
      opening: '谢谢您抽时间。我直接说重点，大概占用您 10 分钟：我想聊聊我的薪资调整。先说三个事实，再说我的想法。'
    },
    expressive: {
      name: '激情型老板',
      how: ['先聊团队目标和未来规划，让他感到你和他“是一伙的”', '多用“我们”，把加薪包装成你愿意更投入的承诺', '他容易当场口头答应——一定要落到书面', '可以讲一个具体的高光故事，但最后要回到数字'],
      invite: 'X总，最近有些关于接下来工作的想法想跟您聊聊，也想听听您对团队下一步的规划，您这周哪天方便，大概半小时？',
      opening: '在开始之前我先说句心里话：您可能会担心我今天是来给您出难题的，其实正好相反——我很看好咱们接下来要做的事，所以想认真跟您聊聊我自己在里面的位置和回报。'
    },
    analytical: {
      name: '数据型老板',
      how: ['提前 1 天把“一页纸价值清单”发给他，别搞突然袭击', '每个观点都配数据和出处：市场报告、招聘 JD 截图、业绩数字', '给他考虑时间，不要逼当场表态', '说话少用形容词，多用数字和对比'],
      invite: 'X总，我整理了一份过去一段时间的工作复盘，也包括我对薪酬的一些想法，想约您 30 分钟沟通一下。材料我先发您，您方便时可以先看看。',
      opening: '谢谢您抽时间。昨天发您的材料不知道您有没有看过？我按材料的顺序讲：先是成果数据，然后是市场参考，最后是我的具体想法，您随时打断我。'
    },
    amiable: {
      name: '和善型老板',
      how: ['降低压力：多用“以“不”为导向的问题”，让他有安全感', '强调你会帮他把向上汇报的材料准备好', '不要逼他当场拍板，给出具体的下一步和时间点', '他不爱拒绝，但可能一直拖——用书面确认把事情往前推'],
      invite: 'X总，想跟您约个时间聊聊我的职业发展，也有一些关于薪酬的想法想听听您的建议，不着急，您看下周哪天方便？',
      opening: '先跟您说一下，今天想聊的事情可能会让您觉得有点为难——我完全理解，所以我会把需要的材料都准备好，尽量不给您添麻烦。'
    },
    unknown: {
      name: '通用策略',
      how: ['先用 2-3 分钟观察：他是急着要结论，还是愿意先聊聊？据此切换节奏', '先讲价值和事实，再讲数字', '准备好纸面材料，随时可以拿出来', '无论结果如何，都在当天用邮件确认'],
      invite: 'X总，想约您 20-30 分钟，聊聊我这段时间的工作复盘和接下来的发展，您看这周哪天方便？',
      opening: '谢谢您抽时间。在开始前我想先说一句：您可能会觉得我今天是来给您出难题的，或者觉得现在这个时机提有点突然——我理解您的压力，所以我准备得比较充分，也特别想听听您的真实想法。'
    }
  };

  const SOURCES = [
    { kind: '书', title: '《谈判力》Getting to Yes', author: 'Roger Fisher、William Ury、Bruce Patton（哈佛谈判项目）', use: '原则式谈判四原则、BATNA（最佳替代方案）、用客观标准而非立场谈判' },
    { kind: '书', title: '《掌控谈话》Never Split the Difference', author: 'Chris Voss（前 FBI 首席国际人质谈判专家）', use: '战术同理心、镜像、标注、校准问题、指控审计、Ackerman 递减让步' },
    { kind: '书', title: '《沃顿商学院最受欢迎的谈判课》Getting More', author: 'Stuart Diamond（沃顿商学院）', use: '关注对方的“脑中图像”、渐进式推进、利用对方的标准' },
    { kind: '书', title: 'Negotiation Genius', author: 'Deepak Malhotra、Max Bazerman（哈佛商学院）', use: '锚定效应、谈判区间（ZOPA）、保留价格' },
    { kind: '书', title: 'Getting Past No', author: 'William Ury（哈佛谈判项目联合创始人）', use: '应对拖延、强硬与“我再考虑一下”' },
    { kind: '书', title: '《关键对话》Crucial Conversations', author: 'Kerry Patterson 等', use: '高压对话中的情绪管理与安全感营造' },
    { kind: '书', title: 'Ask for It / Women Don’t Ask', author: 'Linda Babcock（卡内基梅隆大学）', use: '“不开口”的代价研究；为自己争取的具体方法' },
    { kind: '课程', title: 'Harvard Program on Negotiation（PON）', author: '哈佛法学院谈判项目', use: 'BATNA、锚定、首次报价等专题报告与高管谈判课程' },
    { kind: '课程', title: 'Successful Negotiation: Essential Strategies and Skills', author: '密歇根大学 George Siedel（Coursera）', use: '谈判准备的结构化分析：目标、底线、替代方案' },
    { kind: '课程', title: 'Introduction to Negotiation', author: '耶鲁大学 Barry Nalebuff（Coursera）', use: '原则式、有说服力的谈判策略' },
    { kind: '课程', title: 'Chris Voss Teaches the Art of Negotiation', author: 'MasterClass', use: 'FBI 谈判技巧的场景化演练' },
    { kind: '研究', title: 'PayScale《Raise Anatomy》（2018，约 16 万人）', author: 'PayScale', use: '主动要求加薪者中约 70% 获得涨薪，39% 拿到了所要求的幅度 —— 本产品成功率模型的基准' },
    { kind: '研究', title: 'Precise offers are potent anchors（JESP, 2013）', author: 'Malia Mason 等（哥伦比亚商学院）', use: '精确数字报价对还价的“拉力”更强 —— 锚点用精确数字的依据' },
    { kind: '研究', title: 'First offers as anchors（JPSP, 2001）', author: 'Adam Galinsky、Thomas Mussweiler', use: '先报价的一方更容易获得有利结果' },
    { kind: '数据', title: '前程无忧《2026 离职与调薪调研报告》', author: '51job', use: '2025 年企业整体调薪 4.1%、各行业调薪基准 —— 涨幅模型的行业基线' }
  ];

  /* ---------------- 完整方案（付费后） ---------------- */

  function buildReport(rawInput) {
    const a = analyze(rawInput);
    const input = a.input;
    const N = a.numbers;
    const boss = BOSS[input.bossStyle];
    const sections = [];
    const roleLabel = L('role', input.role);
    const isLead = input.level === 'manager' || input.level === 'director';

    /* 1. 局势诊断 */
    sections.push({
      id: 'diagnosis', title: '局势诊断', icon: '🧭',
      blocks: [
        { t: 'hero', items: [
          { label: '执行方案后成功率', value: a.prob + '%', note: `直接开口约 ${a.baseProb}%` },
          { label: '预计涨幅', value: `${pct(a.range.low)}–${pct(a.range.high)}`, note: `${money(a.rangeAmount.low)}–${money(a.rangeAmount.high)} / 月` }
        ] },
        { t: 'tag', text: a.strategy.label, desc: a.strategy.desc },
        { t: 'bars', title: '你的筹码五维（0-100）', items: a.dims.map((d) => ({ label: d.label, value: d.value })) },
        { t: 'list', title: '加分项', style: 'check', items: a.strengths.length ? a.strengths : ['暂未发现明显加分项——这正是需要先“蓄力”的信号'] },
        a.risks.length ? { t: 'list', title: '风险项', style: 'cross', items: a.risks } : { t: 'list', title: '风险项', style: 'check', items: ['没有明显短板，放心准备'] },
        a.fixes.length ? { t: 'list', title: '这份方案帮你补齐的部分', style: 'dot', items: a.fixes } : null,
        { t: 'tip', tone: 'info', text: '成功率指“谈完后 3 个月内获得任何幅度的涨薪”的预估概率，基于公开调研数据与因素模型计算，不构成承诺。' }
      ]
    });

    /* 2. 三个数字 */
    const numberBlocks = [
      { t: 'kv', rows: [
        ['开价锚点', `${money(N.anchor)} / 月`, `+${pct(N.anchorPct)}，面谈时第一个说出口的数字`],
        ['理想目标', `${money(N.target)} / 月`, `+${pct(N.targetPct)}，你真正想拿到的结果`],
        ['心理底线', `${money(N.floor)} / 月`, `+${pct(N.floorPct)}，低于它就转向非现金方案或书面复议`]
      ] },
      { t: 'p', text: `为什么锚点是 **${money(N.anchor)}** 这种“不整”的数字？哥伦比亚商学院 Mason 等人的研究发现，精确数字会让对方觉得你做过功课，还价幅度更小；而“2 万”“涨 20%”这类整数更像拍脑袋，容易被大幅砍价。` },
      { t: 'p', text: '为什么要先报价？首轮报价会成为后续讨论的“锚”（Galinsky & Mussweiler, 2001）。在你掌握市场数据的前提下，主动报出有依据的锚点通常更有利。' }
    ];
    if (N.expectNote) numberBlocks.push({ t: 'tip', tone: 'warn', text: N.expectNote });
    numberBlocks.push({
      t: 'ladder', title: '让步阶梯（借鉴 FBI Ackerman 模型：幅度递减）',
      items: [
        { step: '第 1 次报价', amount: money(N.ladder[0]), note: '说完立刻停下，沉默至少 5 秒' },
        { step: '第 1 次让步', amount: money(N.ladder[1]), note: '先用校准问题追问，对方坚持后才让' },
        { step: '第 2 次让步', amount: money(N.ladder[2]), note: '让步变小，同时提出一个交换条件' },
        { step: '最终落点', amount: money(N.ladder[3]), note: '用精确数字 + 一个非现金诉求收尾，传递“已到极限”' }
      ]
    });
    const batna = [];
    if (input.offer === 'has_offer' && !offerLeverage(input)) {
      batna.push(`你手上的 offer（${money(input.offerSalary)} / 月）不比现在的薪资高，它不是筹码：谈判中不要提起它。你真正的底牌是价值清单和市场数据。`);
    } else if (input.offer === 'has_offer') {
      batna.push(`你的 BATNA（谈判破裂时的最佳替代方案）是手上的 offer（${money(input.offerSalary)} / 月）。它让你有底气，但只在你“真的愿意走”时才是筹码。`);
      if (input.willingToLeave === 'no') batna.push('你表示不想走——那就不要把 offer 当威胁使用，只把它当作“市场对我的定价”这一客观依据。');
    } else if (input.offer === 'interviewing') {
      batna.push('你正在看机会：如果能在面谈前拿到一个书面 offer，你的 BATNA 会显著变强。没有之前，不要暗示自己有 offer。');
    } else {
      batna.push('你目前没有外部 offer，BATNA 偏弱。哈佛谈判项目的建议是：谈判前先“改善 BATNA”——花 2 周更新简历、和 2-3 位猎头聊聊，你会更清楚自己的市场价，说话也更有底气。');
    }
    batna.push('谈判前写下你的底线并坚守它：低于底线时，不要当场接受，转向下方的 Plan B（非现金回报 + 书面复议承诺）。');
    numberBlocks.push({ t: 'list', title: '你的 BATNA（底牌）', style: 'dot', items: batna });
    sections.push({ id: 'numbers', title: '你的三个数字', icon: '🎯', blocks: numberBlocks });

    /* 3. 时机 */
    const timing = [];
    const cycleText = {
      soon: '调薪窗口就在 1-2 个月内——最佳开口时间是窗口前 4-6 周：预算还没最终敲定，老板还有操作空间。本周就开始准备。',
      far: '离调薪窗口还远。如果你刚交付了重大成果或手上有 offer，可以申请“非周期调整”；否则建议现在开始蓄力，在窗口前 4-6 周开口。',
      passed: '调薪季刚过，预算大概率已经锁定。这次谈话的目标调整为：① 争取“特殊调整”（如果你的职责明显扩大）；② 锁定下一周期的书面承诺；③ 争取非现金回报。',
      unknown: '先搞清楚公司的预算节奏：向 HR 或老同事打听调薪 / 绩效周期。很多公司在 Q4 制定下一年人力预算——那之前开口最有效。'
    };
    timing.push(cycleText[input.cycle]);
    if (input.lastRaise === 'lt6') timing.push('你半年内刚调过薪。除非职责明显扩大，否则建议等满 9-12 个月再谈，现在先积累新的成果。');
    if (input.companyStatus === 'layoff') timing.push('公司正在裁员 / 降本：避开裁员消息刚出、财报刚发布的时间点。这时谈“加薪”不如谈“职责与回报的对等”和“书面复议承诺”。');
    if (input.companyStatus === 'fast') timing.push('公司正在快速增长——这是开口的好时机：业务扩张时，留住核心骨干的成本远低于重新招聘。');
    sections.push({
      id: 'timing', title: '最佳开口时机', icon: '⏰',
      blocks: [
        { t: 'list', style: 'dot', items: timing },
        { t: 'list', title: '黄金时刻', style: 'check', items: ['刚交付一个漂亮的项目 / 刚被表扬后的 1-2 周内', '周二至周四，上午 10 点后或下午 2-4 点', '老板心情不错、手头不着急的时候'] },
        { t: 'list', title: '避开', style: 'cross', items: ['周一早上、周五下午、节假日前一天', '老板刚挨批、项目刚出事故、公司刚发坏消息', '公开场合、电梯里、饭局上顺嘴一提'] }
      ]
    });

    /* 4. 准备清单 */
    const prep = a.strategy.key === 'build' ? [
      { day: '第 1-2 周', title: '找到一个“高光项目”', text: '主动认领一个老板关心、结果可见的任务，最好能在 4 周内出数据。' },
      { day: '第 2-4 周', title: '每周记录成果', text: '用“动作 + 数字 + 影响”格式记录，每周五花 10 分钟。' },
      { day: '第 3-5 周', title: '调研市场 + 改善 BATNA', text: '整理 5-10 个同城同级别岗位的薪资区间；和猎头聊聊。' },
      { day: '第 5-6 周', title: '小范围预告', text: '在 1 对 1 中自然地提到“想承担更多、也希望回报对等”，给老板心理准备。' },
      { day: '窗口前 4-6 周', title: '正式约谈', text: '按下面的面谈脚本执行。' }
    ] : [
      { day: 'D-7', title: '收集成果数据', text: `把成果量化：数字、百分比、金额、时间。重点是${ROLE_VALUE[input.role]}。` },
      { day: 'D-6', title: '调研市场薪资', text: '至少 3 个来源：招聘平台同城同级别 JD 的薪资带、行业薪酬报告（前程无忧 / 智联 / 猎聘 / 美世等）、猎头或同行反馈。截图保存。' },
      { day: 'D-5', title: '定下三个数字', text: `锚点 ${money(N.anchor)}、目标 ${money(N.target)}、底线 ${money(N.floor)}，并写下你的 BATNA。` },
      { day: 'D-4', title: '写一页纸价值清单', text: '用下面的模板，控制在一页以内。' },
      { day: 'D-3', title: '预演 2 遍', text: '找朋友扮演老板，专门挑最难的反驳问你；录音听自己的语速和语气。' },
      { day: 'D-2', title: '发出约谈邀请', text: '用下面的约谈话术，选对时间。' },
      { day: 'D-1', title: '复习话术卡', text: '背熟开场、报价那一句和 3 个校准问题，准备好 Plan B 清单。' },
      { day: 'D0', title: '面谈 + 当天邮件确认', text: '面谈结束 2 小时内发出确认邮件。' },
      { day: 'D+7', title: '跟进', text: '对方承诺的时间点一到，主动跟进，别等。' }
    ];
    sections.push({ id: 'prep', title: a.strategy.key === 'build' ? '蓄力计划' : '7 天准备清单', icon: '🗓️', blocks: [{ t: 'steps', items: prep }] });

    /* 5. 一页纸价值清单 */
    const achvLines = input.achievements.map((k) => '· ' + ACHV_LINE[k]);
    const valueDoc = [
      `【${input.name || '姓名'}｜${roleLabel}｜${L('level', input.level)}】过去 12 个月价值清单`,
      '',
      '一、核心成果（动作 + 数字 + 对公司的影响）',
      input.achievementText ? '· ' + achievementClause(input) : '· （用一句话写最重要的成果，必须带数字）',
      ...achvLines,
      '',
      `二、职责变化：入职 / 上次调薪时我负责 __；现在我负责 __${isLead ? '，团队从 __ 人扩到 __ 人' : ''}`,
      '',
      `三、市场参考：同城同级别${roleLabel}岗位月薪区间约 __–__（来源：__）`,
      '',
      `四、下一阶段计划：未来 6-12 个月我计划 __，预期带来 __`,
      '',
      `五、我的期望：月薪调整至 ${money(N.anchor)}`
    ].join('\n');
    sections.push({
      id: 'valuedoc', title: '一页纸价值清单', icon: '📄',
      blocks: [
        { t: 'p', text: `老板付钱买的是“价值”，不是“辛苦”。把下面的“__”填满，${input.bossStyle === 'analytical' ? '面谈前一天发给老板。' : '面谈时带一份纸质版，必要时递给老板。'}` },
        { t: 'copy', title: '价值清单模板', text: valueDoc },
        { t: 'tip', tone: 'info', text: `${roleLabel}岗位最有说服力的价值指标：${ROLE_VALUE[input.role]}。` }
      ]
    });

    /* 6. 约谈 + 面谈脚本 */
    const marketLine = {
      below20: `我也做了一些市场调研：同城同级别的${roleLabel}岗位，月薪区间大约在 __ 到 __（指着截图 / 报告），我目前明显低于这个区间。`,
      below10: `我参考了一些市场数据：同城同级别的${roleLabel}岗位大概在 __ 到 __，我目前处在偏下的位置。`,
      equal: '从市场数据看，我目前的薪资和同级别岗位基本持平。但过去这段时间我的职责和产出已经明显超出了这个级别。',
      above: '我知道我目前的薪资在市场上不算低，所以今天想谈的不是“对标市场”，而是我新承担的职责和产出能否得到对等的回报。',
      unknown: `我参考了招聘平台上同城同级别${roleLabel}岗位的薪资区间（面谈前务必完成调研并填入数字）：大约在 __ 到 __。`
    }[input.market];
    const valueLine = input.achievementText
      ? `我简单回顾一下过去这段时间的工作：${achievementClause(input)}。`
      : '我简单回顾一下过去这段时间的三个关键成果：第一，__；第二，__；第三，__（每条都带数字）。';
    const askLine = input.goal === 'promotion'
      ? `所以，我希望能讨论两件事：一是职级晋升到 __，二是月薪相应调整到 ${money(N.anchor)}。`
      : `综合这些，我希望把月薪调整到 ${money(N.anchor)}。`;
    const scriptLines = [
      { who: '你', text: boss.opening },
      { who: '技巧', text: {
        driver: '拍板型老板：开场一句话说明来意，不绕弯。',
        analytical: '数据型老板讨厌意外：提前发材料、按材料顺序讲，让他感到一切有据可查。'
      }[input.bossStyle] || '这是 FBI 的“指控审计”：先把对方可能的负面想法说出来，对方的防御会明显降低。' },
      { who: '你', text: valueLine },
      { who: '你', text: marketLine },
      { who: '你', text: askLine },
      { who: '技巧', text: '说完数字立刻停下。保持沉默至少 5-7 秒，第一个开口的人往往先让步。' },
      { who: '老板', text: '（通常会犹豫、反驳或沉默——反驳应对见下一节）' },
      { who: '你', text: '听起来这个数字让您有些顾虑。（停顿）您觉得要实现这个调整，我们需要怎么做？' },
      { who: '技巧', text: '“标注”+“校准问题”：用“怎么 / 什么”开头，把问题交给对方解决，而不是用“为什么不行”逼他防御。' },
      { who: '你', text: '那我总结一下今天我们聊到的：……您看我理解得对吗？' },
      { who: '技巧', text: '目标是让老板说出“没错（That\'s right）”——这代表他真正认同了你的总结，而不是敷衍的“好的”。' },
      { who: '你', text: '好的，那我今天下班前发一封邮件把今天的共识记下来，方便您往上沟通，您看可以吗？' }
    ];
    sections.push({
      id: 'script', title: '面谈全流程脚本', icon: '🎙️',
      blocks: [
        { t: 'list', title: `针对「${boss.name}」的沟通要点`, style: 'dot', items: boss.how },
        { t: 'copy', title: '约谈邀请（微信 / 当面）', text: boss.invite },
        { t: 'tip', tone: 'info', text: '约谈不要用微信直接谈薪资数字。约时间用微信，谈数字当面（或视频），结果用邮件确认。' },
        { t: 'dialog', title: '面谈脚本（按顺序）', lines: scriptLines }
      ]
    });

    /* 7. 反驳应对 */
    const hasOffer = offerLeverage(input);
    const objections = [
      {
        q: '“今年预算很紧，真的没有额度。”',
        tag: input.companyStatus === 'slow' || input.companyStatus === 'layoff' ? '高概率' : '',
        meaning: '可能是真的，也可能在测试你的决心。关键是把“不行”变成“怎样才行”。',
        a: '听起来预算这块确实让您很为难。（停顿）那您看，在现有预算之外，有没有其他方式能认可这部分贡献？比如下个预算周期优先考虑、先调整职级，或者用绩效奖金的方式？如果下个周期能调，我们能不能现在就把目标和金额定下来？',
        tech: '标注 + 校准问题 + 锁定未来'
      },
      {
        q: '“现在不是时候，等年底统一调薪再说。”',
        tag: input.cycle === 'far' || input.cycle === 'passed' ? '高概率' : '',
        meaning: '统一调薪对他来说更省事。你的目标：把“以后”变成有时间、有标准、有金额的承诺。',
        a: `我理解统一调整更好操作。为了到时候不让您为难，我们能不能现在约定：如果我在年底前完成 A、B 两个目标，就调整到 ${money(N.target)}？我把这个整理成邮件发您确认。`,
        tech: '原则式谈判：用客观标准锁定条件'
      },
      {
        q: '“你要的太多了，超出了范围。”',
        tag: '高概率',
        meaning: '锚点生效了——对方开始和你讨论“多少”，而不是“要不要”。',
        a: '看起来这个数字让您有些意外。（沉默几秒）您觉得在什么范围内是可以争取的？',
        tech: '标注 + 沉默 + 让对方先给区间；之后按让步阶梯走，每次让步都换回一点东西'
      },
      {
        q: '“你的表现还没到那个程度。”',
        tag: input.performance === 'average' || input.performance === 'below' ? '高概率' : '',
        meaning: '这是拿到“晋级标准”的好机会，不要辩解。',
        a: `谢谢您直接告诉我，这对我很重要。您觉得具体还差在哪里？如果我在接下来 3 个月做到 ___，我们是否可以按 ${money(N.target)} 来调整？`,
        tech: '把模糊的评价变成可验证的标准'
      },
      {
        q: '“大家都没涨，我给你涨了别人怎么办？”',
        tag: '',
        meaning: '他在担心团队公平和向上交代。不要拿具体同事比较。',
        a: '我理解您要考虑团队的整体平衡。我今天谈的不是和谁比，而是基于我现在承担的职责和产出——这部分已经超出了我入职时的岗位范围。您觉得以我现在的贡献，什么样的回报是合理的？',
        tech: '人事分开 + 利益而非立场（哈佛原则式谈判）'
      },
      {
        q: '“这事我做不了主，得往上报。”',
        tag: input.bossPower !== 'direct' ? '高概率' : '',
        meaning: '他可能是真的没权限，也可能在推。无论哪种，帮他“好交差”。',
        a: '明白。那我怎么做，能让您往上汇报的时候更好说？我可以准备一页纸的成果和市场数据给您。另外您大概什么时候能有反馈？',
        tech: '校准问题 + 给对方弹药 + 确定时间点'
      },
      {
        q: '“你是不是有别的 offer 了？”',
        tag: input.offer !== 'none' ? '高概率' : '',
        meaning: '他在评估你的离职风险。实话实说，但不威胁。',
        a: hasOffer
          ? (input.willingToLeave === 'no'
            ? '确实有机会找过我，但我更希望在这里长期发展，所以第一时间来找您聊，而不是拿它来谈条件。'
            : '确实有公司给了我机会，薪资在 __ 左右。但我更希望留在这里，所以先来和您聊。如果我们能找到一个合适的方案，我会全力投入。')
          : input.offer !== 'none'
            ? '有接触过一些机会，但我更希望在这里长期发展，所以才认真地来和您谈这件事。'
            : '没有。正因为我想在这里长期发展，所以才认真地来和您谈这件事。',
        tech: '绝不虚张声势：一旦被回“那你去吧”，你会非常被动'
      },
      {
        q: '“我再考虑考虑。”',
        tag: input.bossStyle === 'amiable' || input.bossStyle === 'analytical' ? '高概率' : '',
        meaning: '考虑没问题，但要防止“无限期考虑”。',
        a: '当然，您需要多久？如果我下周三再来找您聊结果，会不会太赶？',
        tech: '以“不”为导向的问题：对方说“不会”时，其实已经同意了时间点'
      },
      {
        q: '“好好干，以后不会亏待你的。”',
        tag: input.bossStyle === 'expressive' ? '高概率' : '',
        meaning: '口头承诺 ≠ 承诺。把“以后”具体化。',
        a: '谢谢您的认可，这对我很重要。为了让我更有方向，我们能不能把“以后”具体一点：什么时间点、达到什么标准、调整到什么水平？',
        tech: '校准问题：把模糊承诺落到时间 + 标准 + 金额'
      },
      {
        q: '“现在这形势，能保住工作就不错了。”',
        tag: input.companyStatus === 'layoff' ? '高概率' : '',
        meaning: '对方在压低你的预期。保持冷静，转向“对等”与“未来”。',
        a: '我很清楚公司现在的压力，所以今天不是来给您添难题的。我想确认的是：在这种情况下我承担了更多（举例），有没有可能先在职级 / 绩效 / 书面承诺上体现，等情况好转时优先调整？',
        tech: '战术同理心 + Plan B 非现金方案'
      }
    ];
    objections.sort((x, y) => (y.tag ? 1 : 0) - (x.tag ? 1 : 0));
    sections.push({ id: 'objections', title: '老板 10 大反驳 · 应对话术', icon: '🛡️', blocks: objections.map((o) => Object.assign({ t: 'qa' }, o)) });

    /* 8. FBI 技巧卡 */
    sections.push({
      id: 'fbi', title: 'FBI 谈判技巧卡', icon: '🕵️',
      blocks: [
        { t: 'p', text: '来自前 FBI 首席国际人质谈判专家 Chris Voss《掌控谈话》。核心理念：谈判不是辩论，先让对方感到“被理解”，再推动结果。' },
        { t: 'cards', items: [
          { title: '镜像', text: '重复对方最后 1-3 个关键词，用疑问语气。', example: '老板：“预算很紧。” 你：“预算很紧？”——然后等他自己解释更多。' },
          { title: '标注', text: '用“听起来… / 看起来… / 似乎…”说出对方的情绪或顾虑。', example: '“听起来您担心给我调了，其他人也会来要。”' },
          { title: '指控审计', text: '主动说出对方可能对你的负面想法，提前卸掉防御。', example: '“您可能会觉得我在这个时候提加薪有点不懂事……”' },
          { title: '校准问题', text: '用“怎么 / 什么”提问，不用“为什么”。把问题交给对方解决。', example: '“要实现这个调整，我们需要怎么做？”' },
          { title: '以“不”为导向', text: '设计让对方说“不”的问题，对方会更有安全感。', example: '“如果我们现在聊聊我的薪资，您会觉得很为难吗？”' },
          { title: '“没错”时刻', text: '复述对方的立场，直到他说“没错”——那是真正的认同。', example: '“所以您的意思是，您认可我的成果，但担心预算周期对不上？”' },
          { title: '深夜电台语调', text: '语速放慢、声音放低、语气平稳——传递“我很冷静，一切在掌控中”。', example: '报数字时尤其要用这种语调。' },
          { title: '沉默', text: '报完数字、问完问题后闭嘴。沉默的压力会让对方补充信息或让步。', example: '心里默数到 7。' }
        ] }
      ]
    });

    /* 9. Plan B */
    const planB = [
      '职级 / Title 调整（往往比加薪更容易批，并会抬高下一次调薪的基数）',
      '绩效奖金 / 年终奖系数上调',
      '书面的 3-6 个月复议承诺：时间 + 达成标准 + 调整金额（最重要的一条）',
      '培训、证书或学历的费用支持',
      '弹性工作 / 部分远程',
      '额外年假',
      '加入更重要的项目或客户（提升曝光度，为下次加薪铺路）',
      '交通 / 餐补 / 住房等补贴'
    ];
    if (input.companyType === 'listed' || input.companyType === 'startup') planB.splice(2, 0, '股票 / 期权 / RSU 授予');
    if (input.companyType === 'soe') planB.unshift('职称评定、岗位等级晋升（体制内薪资主要跟着岗级走）');
    sections.push({
      id: 'planb', title: 'Plan B：钱谈不拢时争取什么', icon: '🧩',
      blocks: [
        { t: 'p', text: '哈佛原则式谈判的第三条：“为双方利益创造选项”。老板拒绝的可能只是“现在给现金”，不是“认可你”。提前准备好这张清单，钱谈不拢时换个维度继续谈。' },
        { t: 'list', style: 'check', items: planB },
        { t: 'tip', tone: 'warn', text: '每次让步都要换回点什么。“如果月薪只能到 X，那能否在 ___ 上补足？”' }
      ]
    });

    /* 10. 跟进邮件 */
    const email = [
      '主题：关于今天沟通的确认',
      '',
      'X总您好：',
      '',
      '感谢您今天抽时间和我沟通。简单确认一下我们聊到的内容：',
      '1. 我过去一段时间的主要成果：__（一句话 + 数字）',
      `2. 关于薪资调整：您会在 __月__日 前与 __（HR / 上级）沟通，方案为${input.goal === 'promotion' ? '晋升至 __ 级、' : ''}月薪调整至 __；`,
      '3. 如本周期无法落实，我们约定在 __月__日 复议，复议标准为：__。',
      '',
      '如有理解不准确的地方请您指正。再次感谢您的支持，我会继续全力投入！',
      '',
      input.name || '（你的名字）'
    ].join('\n');
    sections.push({ id: 'email', title: '跟进确认邮件', icon: '✉️', blocks: [{ t: 'p', text: '面谈结束 2 小时内发出。它的作用是把口头共识变成书面记录，防止“我不记得说过”。' }, { t: 'copy', title: '邮件模板', text: email }] });

    /* 11. 避雷 */
    sections.push({
      id: 'donts', title: '避雷清单', icon: '⚠️',
      blocks: [{ t: 'list', style: 'cross', items: [
        '不要用个人原因（房贷、结婚、孩子）当理由——老板付钱买的是价值，不是你的开销',
        '不要拿具体同事的工资比较——会把老板推到对立面，还可能违反公司保密规定',
        '不要虚张声势说有 offer——被回一句“那你去吧”会非常被动',
        '不要在微信 / 邮件里直接谈数字——当面谈，再用邮件确认结果',
        '不要说“差不多”“大概”“您看着给”——用精确数字',
        '不要连续让步两次——每次让步都要换回点什么',
        '不要接受模糊承诺——“以后”“看看”都要落到时间 + 标准 + 金额',
        '谈不成也不要当场翻脸——保持关系，你还有下一轮'
      ] }]
    });

    /* 12. 针对补充情况 */
    const extraTips = extraAdvice(input);
    if (input.goal === 'promotion') {
      extraTips.unshift('你同时想争取升职：用“我已经在按下一级别的标准工作 __ 个月”来论证，列出下一级别的职责要求并逐条对应你的实际工作。升职 + 加薪一起谈时，先谈职级，再谈薪资——职级确定后，薪资就有了“客观标准”。');
    }
    if (isLead) extraTips.push('你是管理者：价值清单里要突出团队结果（团队目标达成、人员留存、梯队培养），而不仅是个人产出。');
    if (extraTips.length) {
      sections.push({ id: 'extra', title: '针对你的情况', icon: '💡', blocks: [{ t: 'list', style: 'dot', items: extraTips }] });
    }

    /* 13. 方法论来源 */
    sections.push({ id: 'sources', title: '方法论与数据来源', icon: '📚', blocks: [{ t: 'sources', items: SOURCES }] });

    return {
      generatedAt: new Date().toISOString(),
      summary: preview(a),
      numbers: N,
      sections: sections.map((s) => Object.assign({}, s, { blocks: s.blocks.filter(Boolean) }))
    };
  }

  // 自由补充信息的关键词规则（服务端配置了 AI 时，会再叠加一份 AI 深度定制分析）。
  // 只看“补充情况”，不看成果描述——“优化算法”“推动事业部增长”这类成果用词不应触发处境建议
  function extraAdvice(input) {
    const t = input.extra || '';
    const tips = [];
    const rules = [
      [/裁员|被优化|优化名单|减员|缩编|降薪|(公司|部门|团队).{0,6}(降本|收缩|砍预算)/, '你提到了裁员 / 降本：此时最有效的诉求是“职责与回报对等”和“书面复议承诺”。同时悄悄改善 BATNA（更新简历、联系猎头），这既是保险，也会让你谈判时更从容。'],
      [/新老板|新领导|换了领导|空降|新上司/, '你提到了新领导：新领导还不了解你的历史贡献。先用 2-4 周通过周报 / 1 对 1 建立认知，再谈薪资；第一次谈话可以先问“您对这个岗位的期待是什么”，把他的期待变成你的加薪标准。'],
      [/加班|996|工作量|一个人干|几个人的活|超负荷/, '你提到工作量大：不要说“我很辛苦”，而要说“我的职责范围从 A 扩大到了 A+B+C，相当于 __ 个岗位的工作量”。辛苦不值钱，职责范围才值钱。'],
      [/带团队|带人|下属|管理团队|组长/, '你提到在带人：如果还没有对应的 Title，把“补齐职级”作为第一诉求——职级会抬高你的薪资带宽上限。'],
      [/offer|跳槽|猎头|面试(?!官)|离职/i, '你提到了外部机会：offer 只在你真的愿意走时才是筹码。不想走的话，就把它当“市场定价依据”，而不是最后通牒。'],
      [/股权|期权|股票|RSU/i, '你提到了股权：问清楚三件事——授予数量、行权价 / 归属期、公司估值或股价依据。现金谈不动时，股权是很好的交换条件。'],
      [/怀孕|产假|孕期|哺乳/, '依据《女职工劳动保护特别规定》，用人单位不得因怀孕、生育、哺乳降低女职工工资。谈判中只谈价值和贡献；如遭遇不公平对待，保留证据并可咨询劳动监察部门。'],
      [/试用期|转正/, '你提到试用期 / 转正：转正是天然的谈薪节点。提前 2 周准备转正答辩材料，把试用期成果量化，并在答辩中自然地提出薪资期望。'],
      [/外包|派遣|驻场/, '你是外包 / 派遣身份：薪资通常由外包公司决定，但甲方的评价是关键筹码。先争取甲方负责人的书面认可，再找外包公司谈。'],
      [/国企|央企|事业单位|编制|体制内/, '体制内薪资主要跟岗位等级、职称和绩效系数走。谈判重点放在“岗级晋升”“职称评定”“绩效系数”，而不是直接谈月薪数字。'],
      [/倒挂|(同事|新人|新来的|新招的).{0,12}(比我高|比我多|工资高|薪资高|工资比我|薪资比我|开得比我)/, '你提到薪资倒挂：不要说出具体同事的名字和薪资。用“我了解到新入职的同级别岗位市场价在 __ 左右”来表达，把问题从“不公平”转化为“市场定价”。'],
      [/画饼|口头承诺|答应过|说好的/, '你提到老板以前有口头承诺：这次务必书面化。可以说：“上次您提到 __，这次我们能不能把具体时间和标准定下来？”'],
      [/房贷|车贷|结婚|生娃|生孩子|养娃|买房|家里.{0,4}(压力|开销|困难|缺钱)/, '你提到了个人生活压力：可以理解，但不要把它作为加薪理由——老板只为价值付钱。把它留在心里，作为你认真准备的动力。'],
      [/远程|异地|搬家|通勤/, '你提到了工作地点 / 通勤：如果现金空间有限，“远程 / 弹性工作”是一个高价值的交换条件。']
    ];
    rules.forEach(([re, tip]) => { if (re.test(t)) tips.push(tip); });
    return tips;
  }

  return { analyze, preview, buildReport, SOURCES, money, pct };
});
