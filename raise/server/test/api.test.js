'use strict';

// 端到端：mock 支付下的完整购买流程
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raise-test-'));
process.env.PAY_PROVIDER = 'mock';
process.env.SOCIAL_MIN_DISPLAY = '2';
process.env.STATS_BASELINE_FILE = path.join(process.env.DATA_DIR, 'no-baseline.json');
delete process.env.ANTHROPIC_API_KEY;

const { server } = require('../server.js');
let base;

test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('诊断 → 下单 → 支付 → 获取方案 → 反馈结果', async () => {
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.pay.provider, 'mock');

  const pv = await (await post('/api/preview', { input: { salary: 20000, industry: 'finance', level: 'senior' } })).json();
  assert.match(pv.previewId, /^[a-f0-9]{24}$/);
  assert.equal(pv.social.type, 'research');
  assert.ok(pv.preview.prob > 0);

  const order = await (await post('/api/order', { previewId: pv.previewId, channel: 'mock' })).json();
  assert.ok(order.mock);

  const unpaid = await fetch(base + '/api/report/' + order.orderId);
  assert.equal(unpaid.status, 402);

  await post('/api/pay/mock/confirm', { orderId: order.orderId });
  const status = await (await fetch(base + '/api/order/' + order.orderId)).json();
  assert.equal(status.status, 'paid');

  const report = await (await fetch(base + '/api/report/' + order.orderId)).json();
  assert.ok(report.report.sections.length >= 12);
  assert.equal(report.ai.status, 'off');

  assert.equal((await post('/api/outcome', { orderId: order.orderId, result: 'success' })).status, 200);

  // 同分组再来一位，达到展示门槛（测试中设为 2）后显示真实“已帮助”人数
  const pv2 = await (await post('/api/preview', { input: { salary: 18000, industry: 'finance', level: 'senior' } })).json();
  const o2 = await (await post('/api/order', { previewId: pv2.previewId, channel: 'mock' })).json();
  await post('/api/pay/mock/confirm', { orderId: o2.orderId });
  await post('/api/outcome', { orderId: o2.orderId, result: 'partial' });
  const pv3 = await (await post('/api/preview', { input: { industry: 'finance', level: 'senior' } })).json();
  assert.equal(pv3.social.type, 'helped');
  assert.equal(pv3.social.count, '2 位');
});

// 用原始 socket 发请求，避免 fetch 规范化路径
function rawGet(target, headers) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(server.address().port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n${headers || ''}Connection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => resolve(Number(buf.split(' ')[1])));
    sock.on('error', reject);
  });
}

test('方案引擎、服务端代码、密钥和数据不对外暴露（含编码绕过）', async () => {
  for (const p of ['/js/engine.js', '/js//engine.js', '/js/%2Fengine.js', '/js/./engine.js', '/server/server.js',
    '/%2Fserver/server.js', '//server/data/db.json', '/%2Fserver/data/db.json', '/server/.env', '/README.md',
    '/docs/methodology.md', '/js/%2e%2e/server/server.js', '/%00', '/index.html%00']) {
    assert.equal(await rawGet(p), 404, p);
  }
  for (const p of ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/config.js', '/js/schema.js']) {
    assert.equal(await rawGet(p), 200, p);
  }
});

test('畸形请求不会让服务崩溃', async () => {
  assert.equal(await rawGet('//'), 400);
  assert.equal(await rawGet('/%E0%A4%A'), 404);
  assert.equal((await fetch(base + '/api/health', { headers: { cookie: 'promo=50%; raise_openid=abc' } })).status, 200);
  for (const id of ['__proto__', 'constructor', 'hasOwnProperty']) {
    assert.equal((await post('/api/pay/mock/confirm', { orderId: id })).status, 404);
    assert.equal((await post('/api/order', { previewId: id, channel: 'mock' })).status, 404);
    assert.equal((await post('/api/outcome', { orderId: id, result: 'success' })).status, 404);
  }
  assert.equal(({}).status, undefined);
  assert.equal((await post('/api/preview', null)).status, 200);
  assert.equal((await fetch(base + '/api/health')).status, 200);
});

test('同一订单反复反馈只计一次', async () => {
  const pv = await (await post('/api/preview', { input: { industry: 'auto', level: 'junior' } })).json();
  const o = await (await post('/api/order', { previewId: pv.previewId, channel: 'mock' })).json();
  await post('/api/pay/mock/confirm', { orderId: o.orderId });
  for (let i = 0; i < 5; i++) await post('/api/outcome', { orderId: o.orderId, result: 'success' });
  const { store } = require('../server.js');
  assert.equal(store.data.stats['auto|junior'].helped, 1);
  await post('/api/outcome', { orderId: o.orderId, result: 'fail' });
  assert.equal(store.data.stats['auto|junior'].helped, 0);
});

test('参数校验', async () => {
  assert.equal((await post('/api/order', { previewId: 'nope' })).status, 404);
  assert.equal((await fetch(base + '/api/report/Rdeadbeef')).status, 404);
  assert.equal((await post('/api/preview', 'not json')).status, 200); // 非对象 body 会被清洗为默认输入
});
