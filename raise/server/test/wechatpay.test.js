'use strict';

// 用本地生成的密钥模拟微信支付平台，验证签名、回调验签与解密逻辑
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WechatPay } = require('../wechatpay.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxpay-'));
const merchant = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(path.join(dir, 'key.pem'), merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }));
fs.writeFileSync(path.join(dir, 'pub.pem'), platform.publicKey.export({ type: 'spki', format: 'pem' }));
const API_V3_KEY = 'a'.repeat(32);

const wx = new WechatPay({
  WECHAT_MCHID: '1900000001', WECHAT_APPID: 'wx123', WECHAT_SERIAL_NO: 'SERIAL', WECHAT_API_V3_KEY: API_V3_KEY,
  WECHAT_PRIVATE_KEY_PATH: path.join(dir, 'key.pem'), WECHAT_PLATFORM_PUBLIC_KEY_PATH: path.join(dir, 'pub.pem'),
  WECHAT_PLATFORM_PUBLIC_KEY_ID: 'PUB_KEY_ID_1', WECHAT_JSAPI_ENABLED: '1'
});

function fakeNotify(transaction, tamper) {
  const nonce = 'abcdefghijkl';
  const iv = Buffer.from(nonce);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(API_V3_KEY), iv);
  cipher.setAAD(Buffer.from('transaction'));
  const enc = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]);
  const body = JSON.stringify({
    event_type: 'TRANSACTION.SUCCESS',
    resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext: enc.toString('base64'), nonce, associated_data: 'transaction' }
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const hnonce = crypto.randomBytes(8).toString('hex');
  const sig = crypto.createSign('RSA-SHA256').update(`${ts}\n${hnonce}\n${body}\n`).sign(platform.privateKey, 'base64');
  const headers = { 'wechatpay-timestamp': ts, 'wechatpay-nonce': hnonce, 'wechatpay-signature': sig, 'wechatpay-serial': 'PUB_KEY_ID_1' };
  return { headers, body: tamper ? body.replace('SUCCESS', 'SUCCEsS') : body };
}

test('回调：验签通过并解密出交易', () => {
  const t = { out_trade_no: 'R1', trade_state: 'SUCCESS', mchid: '1900000001', amount: { total: 2990 } };
  const n = fakeNotify(t);
  const parsed = wx.parseNotify(n.headers, n.body);
  assert.equal(parsed.transaction.out_trade_no, 'R1');
  assert.equal(parsed.transaction.amount.total, 2990);
});

test('回调：报文被篡改时拒绝', () => {
  const n = fakeNotify({ out_trade_no: 'R1' }, true);
  assert.throws(() => wx.parseNotify(n.headers, n.body), /验签失败/);
});

test('JSAPI：请求签名与 paySign 可被商户公钥验证', async () => {
  const realFetch = global.fetch;
  let captured;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return new Response(JSON.stringify({ prepay_id: 'wx_prepay_1' }), { status: 200 });
  };
  try {
    const params = await wx.createJsapi({ id: 'R1', description: 'd', notifyUrl: 'https://x/notify', amountFen: 2990 }, 'openid1');
    assert.equal(params.package, 'prepay_id=wx_prepay_1');
    const ok = crypto.createVerify('RSA-SHA256')
      .update(`${params.appId}\n${params.timeStamp}\n${params.nonceStr}\n${params.package}\n`)
      .verify(merchant.publicKey, params.paySign, 'base64');
    assert.ok(ok);
    assert.equal(captured.url, 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi');
    const auth = captured.opts.headers.Authorization;
    const m = /nonce_str="([^"]+)",signature="([^"]+)",timestamp="(\d+)"/.exec(auth);
    const msg = `POST\n/v3/pay/transactions/jsapi\n${m[3]}\n${m[1]}\n${captured.opts.body}\n`;
    assert.ok(crypto.createVerify('RSA-SHA256').update(msg).verify(merchant.publicKey, m[2], 'base64'));
  } finally {
    global.fetch = realFetch;
  }
});
