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
