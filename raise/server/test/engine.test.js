'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../../js/engine.js');
const Schema = require('../../js/schema.js');

const STRONG = {
  performance: 'top', achievements: ['exceed', 'lead', 'revenue'], achievementText: '订单转化率提升 18%',
  market: 'below10', companyStatus: 'fast', cycle: 'soon', relation: 4, irreplaceable: 4, expect: 20
};
const WEAK = { companyStatus: 'layoff', performance: 'below', lastRaise: 'lt6', cycle: 'passed', expect: 40 };

test('输入清洗：非法值回落默认值，数字被限制范围', () => {
  const i = Schema.normalizeInput({ city: 'mars', salary: -5, expect: 999, achievements: ['lead', 'lead', 'hack'], extra: 'x'.repeat(5000) });
  assert.equal(i.city, Schema.DEFAULTS.city);
  assert.equal(i.salary, 1000);
  assert.equal(i.expect, 100);
  assert.deepEqual(i.achievements, ['lead']);
  assert.equal(i.extra.length, 1000);
});

test('成功率：强筹码 > 弱筹码，且都在合理区间', () => {
  const s = Engine.analyze(STRONG);
  const w = Engine.analyze(WEAK);
  assert.ok(s.prob > w.prob);
  for (const a of [s, w]) {
    assert.ok(a.baseProb >= 12 && a.baseProb <= 88);
    assert.ok(a.prob >= a.baseProb && a.prob - a.baseProb <= 15);
  }
  assert.equal(w.strategy.key, 'defense');
  assert.equal(s.strategy.key, 'offense');
});

test('三个数字：锚点 > 目标 > 底线 > 当前薪资，锚点为精确数', () => {
  for (const p of [{}, STRONG, WEAK, { salary: 8000, offer: 'has_offer', offerSalary: 11000, willingToLeave: 'yes' }]) {
    const a = Engine.analyze(p);
    const n = a.numbers;
    assert.ok(n.anchor > n.target, JSON.stringify(n));
    assert.ok(n.target >= n.floor);
    assert.ok(n.floor > a.input.salary);
    assert.notEqual(n.anchor % 500, 0);
  }
});

test('preview 不包含方案细节', () => {
  const p = Engine.preview(Engine.analyze(STRONG));
  const s = JSON.stringify(p);
  assert.ok(!('numbers' in p));
  assert.ok(!s.includes('anchor'));
});

test('完整方案：各模块齐全，补充信息触发针对性建议', () => {
  const r = Engine.buildReport(Object.assign({}, WEAK, { extra: '公司在裁员，部门刚换了新领导', goal: 'promotion' }));
  const ids = r.sections.map((x) => x.id);
  for (const id of ['diagnosis', 'numbers', 'timing', 'prep', 'valuedoc', 'script', 'objections', 'fbi', 'planb', 'email', 'donts', 'extra', 'sources']) {
    assert.ok(ids.includes(id), id);
  }
  const extra = JSON.stringify(r.sections.find((x) => x.id === 'extra'));
  assert.ok(extra.includes('裁员') && extra.includes('新领导') && extra.includes('升职'));
  const objections = r.sections.find((x) => x.id === 'objections').blocks;
  assert.equal(objections.length, 10);
  assert.equal(objections[0].tag, '高概率');
});

test('金额与让步阶梯：全参数扫描下严格有序、让步递减', () => {
  let n = 0;
  for (const salary of [1000, 1500, 3000, 6000, 10000, 15000, 100000, 1000000]) {
    for (const companyStatus of ['fast', 'stable', 'slow', 'layoff']) {
      for (const performance of ['top', 'average', 'below']) {
        for (const expect of [1, 15, 100]) {
          const a = Engine.analyze({ salary, companyStatus, performance, expect });
          const N = a.numbers, L = N.ladder, R = a.rangeAmount;
          const ctx = JSON.stringify({ salary, companyStatus, performance, expect, N, R });
          assert.ok(N.anchor > N.target && N.target > N.floor && N.floor > salary, ctx);
          assert.ok(L[0] === N.anchor && L[3] === N.target, ctx);
          assert.ok(L[0] - L[1] >= L[1] - L[2] && L[1] - L[2] >= L[2] - L[3] && L[2] - L[3] >= 10, ctx);
          assert.ok(R.low >= 10 && R.high > R.low, ctx);
          n++;
        }
      }
    }
  }
  assert.equal(n, 288);
});

test('低于现薪的 offer 不算筹码', () => {
  const base = Engine.analyze({ salary: 20000 });
  const low = Engine.analyze({ salary: 20000, offer: 'has_offer', offerSalary: 15000, willingToLeave: 'yes' });
  const high = Engine.analyze({ salary: 20000, offer: 'has_offer', offerSalary: 26000, willingToLeave: 'yes' });
  assert.equal(low.baseProb, base.baseProb);
  assert.ok(high.baseProb > base.baseProb);
  const batna = JSON.stringify(Engine.buildReport({ salary: 20000, offer: 'has_offer', offerSalary: 15000 }).sections.find((x) => x.id === 'numbers'));
  assert.ok(batna.includes('不是筹码'));
});

test('入职不满 1 年且未调薪，不按“久未调薪”加成', () => {
  const newHire = Engine.analyze({ tenure: 'lt1', lastRaise: 'never' });
  const recent = Engine.analyze({ tenure: 'lt1', lastRaise: '6to12' });
  assert.equal(newHire.range.mid, recent.range.mid);
  assert.equal(newHire.dims.find((d) => d.key === 'timing').value, recent.dims.find((d) => d.key === 'timing').value);
});

test('补充情况规则不被成果用词误触发；成果结尾标点不重复', () => {
  const r = Engine.buildReport({
    achievementText: '优化推荐算法，推动事业部点击率提升 15%。',
    extra: '同事们都很支持我，我还担任校招面试官', companyStatus: 'fast'
  });
  assert.equal(r.sections.find((x) => x.id === 'extra'), undefined);
  assert.ok(!JSON.stringify(r).includes('。。'));
  const hit = JSON.stringify(Engine.buildReport({ extra: '公司在裁员，新来的同事工资比我高' }).sections.find((x) => x.id === 'extra'));
  assert.ok(hit.includes('裁员') && hit.includes('倒挂'));
});

test('补充情况关键词：真实表述能命中，成果 / 工作描述不误触发', () => {
  const tipOf = (extra, o) => {
    const sec = Engine.buildReport(Object.assign({ extra }, o || {})).sections.find((x) => x.id === 'extra');
    return sec ? sec.blocks[0].items.join('|') : '';
  };
  const hits = {
    '裁员': ['最近公司优化了一批人', '人员优化', '听说年底要优化人员', '身边好几个同事被毕业了', '今年降本增效，预算很紧', '大环境不好，到处都在降本'],
    '倒挂': ['新人月薪比我还高', '同事比我拿得多', '新入职的员工工资比我高', '应届生起薪都比我高'],
    '体制内': ['我是事业编，在医院工作', '在国企上班'],
    '外部机会': ['我在面试别的公司', '最近面试了几家公司', '我想离职', '有猎头找我']
  };
  for (const [key, list] of Object.entries(hits)) for (const t of list) assert.ok(tipOf(t).includes(key), `${key} 应命中：${t}`);
  const misses = ['我去年帮公司降本 80 万', '带领团队降本 30%', '优化了一批接口', '同事的工作量比我多', '负责编制年度预算和财务报表',
    '我负责技术面试，面试了 40 个候选人', '团队离职率从 20% 降到 5%', '同事离职后我接手了他的工作'];
  for (const t of misses) {
    const tip = tipOf(t);
    for (const key of ['裁员', '倒挂', '体制内', '外部机会']) assert.ok(!tip.includes(key), `不应命中 ${key}：${t}`);
  }
  // 低于现薪的 offer：补充建议与 BATNA 一致，不再说它是筹码
  const low = tipOf('手上有个 offer，但不太想走', { salary: 20000, offer: 'has_offer', offerSalary: 15000 });
  assert.ok(low.includes('不比现在的薪资高'));
  const lowDims = Engine.analyze({ salary: 20000, offer: 'has_offer', offerSalary: 15000 }).dims;
  const noneDims = Engine.analyze({ salary: 20000 }).dims;
  assert.equal(lowDims.find((d) => d.key === 'market').value, noneDims.find((d) => d.key === 'market').value);
});

test('多行成果不出现重复标点；目标不高于期望与推荐区间', () => {
  const r = JSON.stringify(Engine.buildReport({ achievementText: 'A 提升 12%。\nB 提升 15%。\n成果如下：\n' }));
  assert.ok(!/[。；：][；。]/.test(r));
  const a = Engine.analyze({ salary: 3000, expect: 20, companyStatus: 'fast' });
  assert.ok(a.numbers.targetPct <= a.range.high, JSON.stringify(a.numbers));
  assert.ok(a.numbers.expectNote.includes(String(a.numbers.targetPct)));
  const b = Engine.analyze({ salary: 2000, expect: 10 });
  assert.ok(b.numbers.targetPct <= 10, JSON.stringify(b.numbers));
});
