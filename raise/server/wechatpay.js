// 微信支付 API v3：H5 下单（外部浏览器）、JSAPI 下单（微信内）、查单、回调验签与解密、网页授权取 openid。
// 文档：https://pay.weixin.qq.com/doc/v3/merchant/4012062524
// 需要用真实商户号联调后再上线。
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const API_HOST = 'https://api.mch.weixin.qq.com';

class WechatPay {
  constructor(env) {
    this.mchid = env.WECHAT_MCHID;
    this.appid = env.WECHAT_APPID;
    this.appSecret = env.WECHAT_APP_SECRET;
    this.serialNo = env.WECHAT_SERIAL_NO;
    this.apiV3Key = env.WECHAT_API_V3_KEY;
    this.privateKey = env.WECHAT_PRIVATE_KEY_PATH ? fs.readFileSync(env.WECHAT_PRIVATE_KEY_PATH, 'utf8') : null;
    // 微信支付公钥模式（新商户默认）：商户平台「API 安全」下载公钥与公钥 ID
    this.platformPublicKey = env.WECHAT_PLATFORM_PUBLIC_KEY_PATH ? fs.readFileSync(env.WECHAT_PLATFORM_PUBLIC_KEY_PATH, 'utf8') : null;
    this.platformPublicKeyId = env.WECHAT_PLATFORM_PUBLIC_KEY_ID || '';
    this.h5Enabled = env.WECHAT_H5_ENABLED === '1';
    this.jsapiEnabled = env.WECHAT_JSAPI_ENABLED === '1';
    const missing = ['WECHAT_MCHID', 'WECHAT_APPID', 'WECHAT_SERIAL_NO', 'WECHAT_API_V3_KEY', 'WECHAT_PRIVATE_KEY_PATH', 'WECHAT_PLATFORM_PUBLIC_KEY_PATH']
      .filter((k) => !env[k]);
    if (missing.length) throw new Error('微信支付配置缺失：' + missing.join(', '));
  }

  sign(message) {
    return crypto.createSign('RSA-SHA256').update(message).sign(this.privateKey, 'base64');
  }

  async request(method, urlPath, body) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = body ? JSON.stringify(body) : '';
    const signature = this.sign(`${method}\n${urlPath}\n${ts}\n${nonce}\n${payload}\n`);
    const auth = `WECHATPAY2-SHA256-RSA2048 mchid="${this.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${this.serialNo}"`;
    const headers = { Authorization: auth, Accept: 'application/json', 'User-Agent': 'raise-coach-server' };
    if (body) headers['Content-Type'] = 'application/json';
    if (this.platformPublicKeyId) headers['Wechatpay-Serial'] = this.platformPublicKeyId;
    const res = await fetch(API_HOST + urlPath, { method, headers, body: payload || undefined });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(`微信支付接口错误 ${res.status}: ${data.code || ''} ${data.message || ''}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // H5 支付：返回跳转链接。redirectUrl 为支付后返回的页面
  async createH5(order, clientIp, redirectUrl) {
    const data = await this.request('POST', '/v3/pay/transactions/h5', {
      appid: this.appid,
      mchid: this.mchid,
      description: order.description,
      out_trade_no: order.id,
      notify_url: order.notifyUrl,
      amount: { total: order.amountFen, currency: 'CNY' },
      scene_info: { payer_client_ip: clientIp, h5_info: { type: 'Wap' } }
    });
    return data.h5_url + '&redirect_url=' + encodeURIComponent(redirectUrl);
  }

  // JSAPI 支付（微信内打开）：返回前端调起支付所需参数
  async createJsapi(order, openid) {
    const data = await this.request('POST', '/v3/pay/transactions/jsapi', {
      appid: this.appid,
      mchid: this.mchid,
      description: order.description,
      out_trade_no: order.id,
      notify_url: order.notifyUrl,
      amount: { total: order.amountFen, currency: 'CNY' },
      payer: { openid }
    });
    const timeStamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const pkg = 'prepay_id=' + data.prepay_id;
    return {
      appId: this.appid, timeStamp, nonceStr, package: pkg, signType: 'RSA',
      paySign: this.sign(`${this.appid}\n${timeStamp}\n${nonceStr}\n${pkg}\n`)
    };
  }

  async query(outTradeNo) {
    return this.request('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${this.mchid}`);
  }

  // 回调：验签 + 解密，返回交易对象；验签失败抛错
  parseNotify(headers, rawBody) {
    const ts = headers['wechatpay-timestamp'];
    const nonce = headers['wechatpay-nonce'];
    const signature = headers['wechatpay-signature'];
    const serial = headers['wechatpay-serial'];
    if (!ts || !nonce || !signature) throw new Error('缺少验签头');
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new Error('回调时间戳过期');
    if (this.platformPublicKeyId && serial && serial !== this.platformPublicKeyId) throw new Error('未知的平台公钥 ID：' + serial);
    const ok = crypto.createVerify('RSA-SHA256').update(`${ts}\n${nonce}\n${rawBody}\n`).verify(this.platformPublicKey, signature, 'base64');
    if (!ok) throw new Error('回调验签失败');
    const body = JSON.parse(rawBody);
    const r = body.resource;
    const buf = Buffer.from(r.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(this.apiV3Key, 'utf8'), Buffer.from(r.nonce, 'utf8'));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    if (r.associated_data) decipher.setAAD(Buffer.from(r.associated_data, 'utf8'));
    const plain = Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]).toString('utf8');
    return { eventType: body.event_type, transaction: JSON.parse(plain) };
  }

  // 公众号网页授权（静默），用于 JSAPI 支付获取 openid
  oauthUrl(redirectUri, state) {
    return 'https://open.weixin.qq.com/connect/oauth2/authorize?appid=' + this.appid +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&response_type=code&scope=snsapi_base&state=' + encodeURIComponent(state) + '#wechat_redirect';
  }

  async openidFromCode(code) {
    const url = 'https://api.weixin.qq.com/sns/oauth2/access_token?appid=' + this.appid +
      '&secret=' + this.appSecret + '&code=' + encodeURIComponent(code) + '&grant_type=authorization_code';
    const data = await (await fetch(url)).json();
    if (!data.openid) throw new Error('获取 openid 失败：' + (data.errmsg || 'unknown'));
    return data.openid;
  }
}

module.exports = { WechatPay };
