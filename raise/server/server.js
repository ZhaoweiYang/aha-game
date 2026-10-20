// 涨薪军师 · 后端服务（零框架，Node >= 22）
// 启动：cp .env.example .env && npm install && npm start
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Schema = require('../js/schema.js');
const Engine = require('../js/engine.js');
const { Store } = require('./store.js');

const env = process.env;
const PORT = Number(env.PORT || 8787);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_BASE_URL = (env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PRICE_FEN = Number(env.PRICE_FEN || 2990);
const ORIGINAL_PRICE_FEN = Number(env.ORIGINAL_PRICE_FEN || 9900);
const PAY_PROVIDER = env.PAY_PROVIDER || 'mock';
const SOCIAL_MIN_DISPLAY = Number(env.SOCIAL_MIN_DISPLAY || 30);
const TRUST_PROXY = env.TRUST_PROXY === '1';
const CORS_ORIGIN = env.CORS_ORIGIN || '';

const store = new Store(path.resolve(__dirname, env.DATA_DIR || 'data'));

// 运营方填写的历史真实数据（例如上线前内测用户的反馈），与线上真实统计相加后展示
const BASELINE_FILE = path.join(__dirname, 'stats-baseline.json');
const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : { segments: {} };

let wechat = null;
if (PAY_PROVIDER === 'wechat') {
  const { WechatPay } = require('./wechatpay.js');
  wechat = new WechatPay(env);
} else if (PAY_PROVIDER !== 'mock') {
  throw new Error('PAY_PROVIDER 只支持 mock 或 wechat');
}
if (PAY_PROVIDER === 'mock' && env.NODE_ENV === 'production') {
  console.warn('[警告] 生产环境使用了测试支付（PAY_PROVIDER=mock），任何人都能免费解锁方案');
}

let ai = null;
if (env.ANTHROPIC_API_KEY) {
  const { AiCoach } = require('./ai.js');
  ai = new AiCoach(env);
}
const aiJobs = new Set();

/* ---------------- 工具 ---------------- */

const newId = (bytes) => crypto.randomBytes(bytes || 12).toString('hex');

function send(res, status, data, headers) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, Object.assign({
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 32 * 1024)) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { throw Object.assign(new Error('JSON 格式错误'), { status: 400 }); }
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// 简单的按 IP 限流（单进程内存）
const buckets = new Map();
function rateLimit(req, name, max, windowMs) {
  const key = name + ':' + clientIp(req);
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (b.count > max) throw Object.assign(new Error('操作太频繁，请稍后再试'), { status: 429 });
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 600000).unref();

const yuan = (fen) => Math.round(fen) / 100;

/* ---------------- 业务 ---------------- */

// “帮助了多少类似的人”：只展示真实数据（线上统计 + 运营方填写的历史数据），不足门槛时退回到公开调研数据
function socialProof(seg) {
  const s = store.data.stats[seg.key] || {};
  const b = (baseline.segments || {})[seg.key] || {};
  const helped = (s.helped || 0) + (b.helped || 0);
  if (helped >= SOCIAL_MIN_DISPLAY) {
    return { type: 'helped', label: '已帮助类似的人', count: helped + ' 位', text: `${seg.label}用户反馈涨薪成功` };
  }
  let allHelped = (baseline.totalHelped || 0);
  for (const v of Object.values(store.data.stats)) allHelped += v.helped || 0;
  if (allHelped >= SOCIAL_MIN_DISPLAY) {
    return { type: 'helped', label: '已帮助', count: allHelped + ' 人', text: '用户反馈涨薪成功' };
  }
  const generated = (s.generated || 0) + (b.generated || 0);
  if (generated >= SOCIAL_MIN_DISPLAY) {
    return { type: 'generated', label: '和你类似的人', count: generated + ' 位', text: `${seg.label}已在这里定制方案` };
  }
  return { type: 'research', label: '主动开口的人里', count: '70%', text: '获得了涨薪（PayScale 16 万人调研）' };
}

function priceInfo() {
  return { fen: PRICE_FEN, yuan: yuan(PRICE_FEN), originalYuan: ORIGINAL_PRICE_FEN > PRICE_FEN ? yuan(ORIGINAL_PRICE_FEN) : null };
}

function markPaid(order, transactionId) {
  if (order.status === 'paid') return;
  order.status = 'paid';
  order.paidAt = Date.now();
  order.transactionId = transactionId || '';
  const preview = store.data.previews[order.previewId];
  store.bump(preview.segment.key, 'paid');
  store.save();
  startAi(order);
}

function startAi(order) {
  if (!ai || aiJobs.has(order.id)) return;
  const preview = store.data.previews[order.previewId];
  order.ai = { status: 'pending', attempts: ((order.ai && order.ai.attempts) || 0) + 1 };
  aiJobs.add(order.id);
  store.save();
  const report = Engine.buildReport(preview.input);
  ai.generate(preview.input, report)
    .then((sections) => { order.ai = { status: 'done', sections, attempts: order.ai.attempts }; })
    .catch((err) => {
      console.error('[AI] 订单', order.id, '生成失败：', err.message);
      order.ai = { status: 'error', attempts: order.ai.attempts, retryable: require('./ai.js').AiCoach.retryable(err) || err instanceof SyntaxError };
    })
    .finally(() => { aiJobs.delete(order.id); store.save(); });
}

function aiState(order) {
  if (!ai) return { status: 'off' };
  if (!order.ai || (order.ai.status === 'pending' && !aiJobs.has(order.id))) {
    startAi(order); // 服务重启后恢复未完成的任务
  } else if (order.ai.status === 'error' && order.ai.retryable && order.ai.attempts < 3) {
    startAi(order);
  }
  return order.ai.status === 'done' ? { status: 'done', sections: order.ai.sections } : { status: order.ai.status };
}

async function syncWechatOrder(order) {
  if (!wechat || order.status === 'paid') return;
  try {
    const t = await wechat.query(order.id);
    if (t.trade_state === 'SUCCESS' && t.amount && t.amount.total === order.amountFen) markPaid(order, t.transaction_id);
  } catch (e) {
    if (e.status !== 404) console.error('[微信支付] 查单失败', order.id, e.message);
  }
}

/* ---------------- 路由 ---------------- */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/health$/, (req) => ({
  ok: true,
  price: priceInfo(),
  pay: { provider: PAY_PROVIDER, h5: PAY_PROVIDER === 'wechat' && wechat.h5Enabled, jsapi: PAY_PROVIDER === 'wechat' && wechat.jsapiEnabled },
  openid: !!cookies(req).raise_openid,
  ai: !!ai
}));

route('POST', /^\/api\/preview$/, async (req) => {
  rateLimit(req, 'preview', 40, 3600 * 1000);
  const body = await readJson(req);
  const input = Schema.normalizeInput(body.input);
  const a = Engine.analyze(input);
  const preview = Engine.preview(a);
  const id = newId(12);
  store.data.previews[id] = { id, input, segment: a.segment, preview, createdAt: Date.now() };
  store.bump(a.segment.key, 'generated');
  return { previewId: id, preview, social: socialProof(a.segment), price: priceInfo() };
});

route('GET', /^\/api\/preview\/([a-f0-9]{24})$/, (req, m) => {
  const p = store.data.previews[m[1]];
  if (!p) throw Object.assign(new Error('诊断不存在或已过期'), { status: 404 });
  return { preview: p.preview, input: p.input, social: socialProof(p.segment), price: priceInfo() };
});

route('POST', /^\/api\/order$/, async (req) => {
  rateLimit(req, 'order', 20, 3600 * 1000);
  const body = await readJson(req);
  const preview = store.data.previews[body.previewId];
  if (!preview) throw Object.assign(new Error('诊断不存在或已过期，请重新测评'), { status: 404 });
  const channel = body.channel;
  const order = {
    id: 'R' + newId(14),
    previewId: preview.id,
    amountFen: PRICE_FEN,
    description: '涨薪军师-专属涨薪谈判方案',
    notifyUrl: PUBLIC_BASE_URL + '/api/pay/wechat/notify',
    channel,
    status: 'created',
    createdAt: Date.now()
  };
  store.data.orders[order.id] = order;
  store.save();

  if (PAY_PROVIDER === 'mock') {
    return { orderId: order.id, mock: true, amountYuan: yuan(order.amountFen) };
  }
  if (channel === 'h5') {
    if (!wechat.h5Enabled) throw Object.assign(new Error('暂不支持浏览器支付，请在微信中打开'), { status: 400 });
    const h5Url = await wechat.createH5(order, clientIp(req), `${PUBLIC_BASE_URL}/?order=${order.id}`);
    return { orderId: order.id, h5Url };
  }
  if (channel === 'jsapi') {
    const openid = cookies(req).raise_openid;
    if (!wechat.jsapiEnabled) throw Object.assign(new Error('暂不支持微信内支付，请在浏览器中打开'), { status: 400 });
    if (!openid) throw Object.assign(new Error('请先完成微信授权'), { status: 401 });
    return { orderId: order.id, jsapi: await wechat.createJsapi(order, openid) };
  }
  throw Object.assign(new Error('不支持的支付方式'), { status: 400 });
});

route('POST', /^\/api\/pay\/mock\/confirm$/, async (req) => {
  if (PAY_PROVIDER !== 'mock') throw Object.assign(new Error('Not found'), { status: 404 });
  const body = await readJson(req);
  const order = store.data.orders[body.orderId];
  if (!order) throw Object.assign(new Error('订单不存在'), { status: 404 });
  markPaid(order, 'MOCK-' + Date.now());
  return { ok: true };
});

route('POST', /^\/api\/pay\/wechat\/notify$/, async (req) => {
  if (!wechat) throw Object.assign(new Error('Not found'), { status: 404 });
  const raw = await readBody(req, 64 * 1024);
  let parsed;
  try {
    parsed = wechat.parseNotify(req.headers, raw);
  } catch (e) {
    console.error('[微信支付] 回调校验失败：', e.message);
    throw Object.assign(new Error('FAIL'), { status: 401, wechat: true });
  }
  const t = parsed.transaction;
  const order = store.data.orders[t.out_trade_no];
  if (order && t.trade_state === 'SUCCESS' && t.mchid === wechat.mchid && t.amount && t.amount.total === order.amountFen) {
    markPaid(order, t.transaction_id);
  }
  return { __status: 204 };
});

route('GET', /^\/api\/order\/(R[a-f0-9]{28})$/, async (req, m) => {
  const order = store.data.orders[m[1]];
  if (!order) throw Object.assign(new Error('订单不存在'), { status: 404 });
  await syncWechatOrder(order);
  return { status: order.status };
});

function paidOrder(id) {
  const order = store.data.orders[id];
  if (!order) throw Object.assign(new Error('订单不存在'), { status: 404 });
  if (order.status !== 'paid') throw Object.assign(new Error('订单未支付'), { status: 402 });
  return order;
}

route('GET', /^\/api\/report\/(R[a-f0-9]{28})$/, async (req, m) => {
  const order = store.data.orders[m[1]];
  if (order) await syncWechatOrder(order);
  const paid = paidOrder(m[1]);
  const preview = store.data.previews[paid.previewId];
  return { report: Engine.buildReport(preview.input), ai: aiState(paid) };
});

route('GET', /^\/api\/report\/(R[a-f0-9]{28})\/ai$/, (req, m) => aiState(paidOrder(m[1])));

route('POST', /^\/api\/outcome$/, async (req) => {
  const body = await readJson(req);
  const order = paidOrder(body.orderId);
  const result = ['success', 'partial', 'fail'].indexOf(body.result) >= 0 ? body.result : null;
  if (!result) throw Object.assign(new Error('参数错误'), { status: 400 });
  const seg = store.data.previews[order.previewId].segment;
  const wasHelped = order.outcome === 'success' || order.outcome === 'partial';
  const isHelped = result === 'success' || result === 'partial';
  if (!wasHelped && isHelped) store.bump(seg.key, 'helped', 1);
  if (wasHelped && !isHelped) store.bump(seg.key, 'helped', -1);
  order.outcome = result;
  store.data.outcomes.push({ orderId: order.id, segment: seg.key, result, at: Date.now() });
  store.save();
  return { ok: true };
});

route('GET', /^\/api\/wechat\/oauth$/, (req, m, url) => {
  if (!wechat) throw Object.assign(new Error('Not found'), { status: 404 });
  const pid = url.searchParams.get('pid') || '';
  if (!/^[a-f0-9]{24}$/.test(pid)) throw Object.assign(new Error('参数错误'), { status: 400 });
  return { __redirect: wechat.oauthUrl(PUBLIC_BASE_URL + '/api/wechat/oauth/callback', pid) };
});

route('GET', /^\/api\/wechat\/oauth\/callback$/, async (req, m, url) => {
  if (!wechat) throw Object.assign(new Error('Not found'), { status: 404 });
  const pid = url.searchParams.get('state') || '';
  const openid = await wechat.openidFromCode(url.searchParams.get('code') || '');
  return {
    __redirect: `${PUBLIC_BASE_URL}/?resume=${/^[a-f0-9]{24}$/.test(pid) ? pid : ''}`,
    __headers: { 'Set-Cookie': `raise_openid=${encodeURIComponent(openid)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${PUBLIC_BASE_URL.startsWith('https') ? '; Secure' : ''}` }
  };
});

// 运营数据看板（需 ADMIN_TOKEN）
route('GET', /^\/api\/admin\/stats$/, (req) => {
  const token = env.ADMIN_TOKEN;
  if (!token || req.headers.authorization !== 'Bearer ' + token) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const orders = Object.values(store.data.orders);
  const paid = orders.filter((o) => o.status === 'paid');
  return {
    previews: Object.keys(store.data.previews).length,
    orders: orders.length,
    paid: paid.length,
    revenueYuan: yuan(paid.reduce((s, o) => s + o.amountFen, 0)),
    outcomes: store.data.outcomes.length,
    segments: store.data.stats
  };
});

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
// 方案引擎只在服务端运行，不对外提供，避免付费内容被直接读取
const BLOCKED = [/^\/server(\/|$)/, /^\/js\/engine\.js$/, /^\/docs(\/|$)/, /\/\./, /\.md$/];

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (BLOCKED.some((re) => re.test(pathname))) return send(res, 404, 'Not found');
  const file = path.join(ROOT, path.normalize(pathname));
  if (!file.startsWith(ROOT + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': pathname === '/index.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(buf);
  });
}

/* ---------------- 入口 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
  }
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, 'Bad request'); }
    return serveStatic(req, res, pathname);
  }
  const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
  if (!r) return send(res, 404, { error: 'Not found' });
  try {
    const out = await r.handler(req, url.pathname.match(r.pattern), url);
    if (out && out.__redirect) {
      res.writeHead(302, Object.assign({ Location: out.__redirect }, out.__headers || {}));
      return res.end();
    }
    if (out && out.__status) { res.writeHead(out.__status); return res.end(); }
    send(res, 200, out);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[错误]', req.method, url.pathname, err);
    if (err.wechat) return send(res, status, { code: 'FAIL', message: err.message });
    send(res, status, { error: status >= 500 ? '服务开小差了，请稍后再试' : err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`涨薪军师已启动：${PUBLIC_BASE_URL}（支付：${PAY_PROVIDER}，AI 定制：${ai ? '开启' : '关闭'}）`);
  });
  const shutdown = () => { store.flush(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { server, store };
