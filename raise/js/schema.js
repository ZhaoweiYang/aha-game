/*
 * 涨薪军师 · 问卷字段定义与输入校验
 * 浏览器端（window.RaiseSchema）与 Node 服务端（require）共用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RaiseSchema = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 每个选项：[值, 标签, 可选说明]
  var OPTIONS = {
    city: [
      ['tier1', '一线城市', '北上广深'],
      ['newtier1', '新一线', '杭州 / 成都 / 武汉 / 南京等'],
      ['tier2', '二线城市'],
      ['other', '三线及以下']
    ],
    industry: [
      ['internet', '互联网 / IT / AI'],
      ['finance', '金融 / 银行 / 保险'],
      ['manufacturing', '制造业'],
      ['auto', '汽车 / 新能源'],
      ['pharma', '医药 / 医疗健康'],
      ['consumer', '快消 / 零售 / 电商'],
      ['media', '文娱 / 传媒 / 游戏'],
      ['service', '专业服务（咨询 / 律所 / 会计）'],
      ['energy', '能源 / 化工 / 材料'],
      ['education', '教育培训'],
      ['realestate', '地产 / 建筑'],
      ['public', '公共服务 / 事业单位'],
      ['other', '其他行业']
    ],
    role: [
      ['tech', '技术 / 研发'],
      ['product', '产品'],
      ['data', '数据 / 算法'],
      ['design', '设计'],
      ['sales', '销售 / 商务'],
      ['marketing', '市场 / 品牌'],
      ['operation', '运营'],
      ['finance_hr', '财务 / 人事 / 法务'],
      ['production', '生产 / 供应链'],
      ['admin', '行政 / 客服'],
      ['pro', '专业岗（医 / 教 / 工程师等）'],
      ['other', '其他']
    ],
    level: [
      ['junior', '初级', '执行层，1-3 年'],
      ['mid', '中级', '业务骨干'],
      ['senior', '资深 / 专家', '能独当一面'],
      ['manager', '主管 / 经理', '带团队'],
      ['director', '总监及以上', '管理者的管理者']
    ],
    tenure: [
      ['lt1', '不到 1 年'],
      ['1to2', '1-2 年'],
      ['2to4', '2-4 年'],
      ['gt4', '4 年以上']
    ],
    lastRaise: [
      ['lt6', '半年内涨过'],
      ['6to12', '6-12 个月前'],
      ['12to24', '1-2 年前'],
      ['gt24', '2 年以上'],
      ['never', '入职后从没涨过']
    ],
    performance: [
      ['top', '优秀', '团队前 10-20%'],
      ['good', '良好', '超出预期'],
      ['average', '合格', '达到预期'],
      ['below', '待改进', '没达到预期'],
      ['none', '公司没有正式绩效']
    ],
    achievements: [
      ['exceed', '超额完成 KPI / 业绩'],
      ['lead', '主导了重要项目'],
      ['revenue', '直接带来收入 / 客户'],
      ['cost', '降本增效 / 省了钱'],
      ['extra', '承担了额外职责'],
      ['mentor', '带新人 / 带团队'],
      ['fix', '解决关键难题 / 救火'],
      ['skill', '新技能 / 证书 / 学历'],
      ['praise', '获客户或高层公开表扬']
    ],
    market: [
      ['below20', '明显偏低', '比市场低 20% 以上'],
      ['below10', '略偏低', '比市场低 10% 左右'],
      ['equal', '基本持平'],
      ['above', '高于市场'],
      ['unknown', '不清楚']
    ],
    offer: [
      ['none', '没有'],
      ['interviewing', '正在面试 / 看机会'],
      ['has_offer', '手上有 offer']
    ],
    willingToLeave: [
      ['yes', '谈不拢就走'],
      ['maybe', '看情况'],
      ['no', '不想走']
    ],
    companyType: [
      ['private', '民营企业'],
      ['listed', '上市公司 / 大厂'],
      ['foreign', '外资企业'],
      ['soe', '国企 / 央企 / 事业单位'],
      ['startup', '初创公司']
    ],
    companyStatus: [
      ['fast', '快速增长'],
      ['stable', '平稳'],
      ['slow', '增长放缓 / 业绩承压'],
      ['layoff', '正在裁员 / 降本']
    ],
    cycle: [
      ['soon', '1-2 个月内', '有调薪 / 绩效窗口'],
      ['far', '还早', '离调薪窗口 3 个月以上'],
      ['passed', '刚过', '调薪季刚结束'],
      ['unknown', '不清楚', '或没有固定调薪期']
    ],
    bossStyle: [
      ['driver', '拍板型', '说话直接、看结果，没耐心听铺垫'],
      ['expressive', '激情型', '爱聊愿景、重视认可，情绪外露'],
      ['analytical', '数据型', '讲逻辑要依据，决定慢、抠细节'],
      ['amiable', '和善型', '随和怕冲突，不爱拒绝也不爱拍板'],
      ['unknown', '说不准']
    ],
    bossPower: [
      ['direct', '直属老板能直接拍板'],
      ['escalate', '要往上报批 / 走 HR'],
      ['rigid', '有严格的职级薪资带宽']
    ],
    goal: [
      ['raise', '涨薪'],
      ['promotion', '升职 + 涨薪']
    ],
    months: [
      [12, '12 薪'], [13, '13 薪'], [14, '14 薪'], [15, '15 薪'], [16, '16 薪及以上']
    ]
  };

  // 行业调薪基准（%）。主要参考前程无忧《2026 离职与调薪调研报告》中 2025 年各行业调薪幅度
  // （整体 4.1%，高科技 4.9%，医药 4.4%，制造 4.3%，汽车 4.1%，金融 3.0%），
  // 报告未单列的行业为基于整体水平的估算值，运营方可按最新数据调整。
  var INDUSTRY_BASE = {
    internet: 4.9, finance: 3.0, manufacturing: 4.3, auto: 4.1, pharma: 4.4,
    consumer: 3.8, media: 3.8, service: 4.0, energy: 4.0, education: 3.2,
    realestate: 2.5, public: 3.0, other: 4.1
  };

  var DEFAULTS = {
    city: 'tier1', industry: 'internet', role: 'tech', level: 'mid',
    years: 3, tenure: '1to2', salary: 15000, months: 13,
    lastRaise: '12to24', performance: 'good', achievements: [], achievementText: '',
    irreplaceable: 3, market: 'unknown', offer: 'none', offerSalary: 0, willingToLeave: 'maybe',
    companyType: 'private', companyStatus: 'stable', cycle: 'unknown',
    bossStyle: 'unknown', bossPower: 'escalate', relation: 3,
    goal: 'raise', expect: 15, extra: '', name: ''
  };

  function values(key) {
    return OPTIONS[key].map(function (o) { return o[0]; });
  }

  function label(key, value) {
    var list = OPTIONS[key] || [];
    for (var i = 0; i < list.length; i++) if (list[i][0] === value) return list[i][1];
    return '';
  }

  function pick(key, v) {
    return values(key).indexOf(v) >= 0 ? v : DEFAULTS[key];
  }

  function num(v, min, max, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  function text(v, maxLen) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maxLen);
  }

  // 清洗用户输入：服务端以此为准，前端仅做体验层面的校验
  function normalizeInput(raw) {
    raw = raw || {};
    var achv = Array.isArray(raw.achievements) ? raw.achievements : [];
    var validAchv = values('achievements');
    var input = {
      city: pick('city', raw.city),
      industry: pick('industry', raw.industry),
      role: pick('role', raw.role),
      level: pick('level', raw.level),
      years: Math.round(num(raw.years, 0, 45, DEFAULTS.years)),
      tenure: pick('tenure', raw.tenure),
      salary: Math.round(num(raw.salary, 1000, 1000000, DEFAULTS.salary)),
      months: Math.round(num(raw.months, 12, 16, DEFAULTS.months)),
      lastRaise: pick('lastRaise', raw.lastRaise),
      performance: pick('performance', raw.performance),
      achievements: achv.filter(function (a, i) {
        return validAchv.indexOf(a) >= 0 && achv.indexOf(a) === i;
      }),
      achievementText: text(raw.achievementText, 600),
      irreplaceable: Math.round(num(raw.irreplaceable, 1, 5, DEFAULTS.irreplaceable)),
      market: pick('market', raw.market),
      offer: pick('offer', raw.offer),
      offerSalary: Math.round(num(raw.offerSalary, 0, 2000000, 0)),
      willingToLeave: pick('willingToLeave', raw.willingToLeave),
      companyType: pick('companyType', raw.companyType),
      companyStatus: pick('companyStatus', raw.companyStatus),
      cycle: pick('cycle', raw.cycle),
      bossStyle: pick('bossStyle', raw.bossStyle),
      bossPower: pick('bossPower', raw.bossPower),
      relation: Math.round(num(raw.relation, 1, 5, DEFAULTS.relation)),
      goal: pick('goal', raw.goal),
      expect: Math.round(num(raw.expect, 1, 100, DEFAULTS.expect)),
      extra: text(raw.extra, 1000),
      name: text(raw.name, 20)
    };
    if (input.offer !== 'has_offer') input.offerSalary = 0;
    return input;
  }

  // “类似的人”分组：行业 × 职级
  function segmentOf(input) {
    return {
      key: input.industry + '|' + input.level,
      label: label('industry', input.industry).split(' / ')[0] + ' · ' + label('level', input.level)
    };
  }

  return {
    OPTIONS: OPTIONS,
    INDUSTRY_BASE: INDUSTRY_BASE,
    DEFAULTS: DEFAULTS,
    label: label,
    normalizeInput: normalizeInput,
    segmentOf: segmentOf
  };
});
