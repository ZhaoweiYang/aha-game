# 涨薪军师 · H5 涨薪谈判方案生成器

用户填写个人、公司和老板的情况，生成专属的涨薪谈判方案。免费部分给出诊断（预计成功率、预计涨幅、类似用户数据），付费后解锁完整方案。

方法论来自哈佛谈判项目的原则式谈判、前 FBI 谈判专家 Chris Voss 的战术同理心、哥伦比亚商学院的精确锚点研究；基准数据来自 PayScale 和前程无忧。详见 [docs/methodology.md](docs/methodology.md)。

## 产品流程

```
首页 → 5 步问卷（约 3 分钟）→ 生成诊断 → 付费页 → 支付 → 完整方案 → 谈完后反馈结果
```

**付费页展示**
- 预计涨薪成功率：区分“直接开口”和“按方案执行后”两个数值
- 预计涨幅：百分比区间，以及折算成每月、每年多拿多少钱
- 帮助了多少类似的人：只用真实数据，规则见下文“社会证明数据”
- 推荐策略、最大优势、风险项数量，以及模糊处理的脚本预览

**完整方案（13 个模块）**

1. 局势诊断：筹码五维评分、加分项和风险项
2. 三个数字：开价锚点、理想目标、心理底线，附让步阶梯和 BATNA 分析
3. 最佳开口时机
4. 7 天准备清单（时机不利时换成“蓄力计划”）
5. 一页纸价值清单模板
6. 按老板性格（拍板型、激情型、数据型、和善型）定制的约谈话术和逐句面谈脚本
7. 老板常见的 10 种反驳及应对话术，按用户情况标注“高概率”
8. FBI 谈判技巧卡
9. Plan B：钱谈不拢时可以争取的非现金回报
10. 跟进确认邮件模板
11. 避雷清单
12. 针对用户补充情况的建议（关键词规则）
13. 方法论与数据来源

配置 `ANTHROPIC_API_KEY` 后，还会多出一份 AI 深度定制内容：处境解读、量身写的开场白、最可能遇到的 3 个反驳，以及未来 7 天的行动清单。

## 目录结构

```
raise/
├── index.html          # H5 单页
├── css/app.css
├── js/
│   ├── config.js       # 前端配置（接口地址等）
│   ├── schema.js       # 问卷字段与输入校验（前后端共用）
│   ├── engine.js       # 方案引擎：成功率 / 涨幅模型 + 方案内容（生产环境只在服务端运行）
│   └── app.js          # 前端交互
├── server/
│   ├── server.js       # 接口 + 静态文件服务（零框架）
│   ├── wechatpay.js    # 微信支付 API v3（H5 / JSAPI / 回调验签解密 / 网页授权）
│   ├── ai.js           # AI 深度定制（Claude API）
│   ├── store.js        # JSON 文件存储
│   ├── test/           # node:test 测试
│   └── .env.example
└── docs/methodology.md
```

## 两种运行模式

| 模式 | 部署方式 | 说明 |
|---|---|---|
| 演示模式 | 只部署静态文件，例如 GitHub Pages 的 `/raise/` | 前端检测不到后端时自动启用：在浏览器里计算方案，点“模拟支付成功”即可解锁。**不能收费**，只用于演示和收集反馈 |
| 正式模式 | 运行 `server/` | 方案只在服务端生成，支付成功后才下发，`engine.js` 不对外提供 |

## 本地运行

```bash
cd raise/server
cp .env.example .env     # 默认 PAY_PROVIDER=mock，即测试支付
npm install
npm start                # 打开 http://localhost:8787（需 Node >= 22.9）
npm test                 # 引擎、购买全流程、微信支付验签测试
```

## 上线清单

### 1. 资质与支付

- 微信支付商户号，并开通 **JSAPI 支付**（在微信里打开的页面必须用它）。如果要支持外部浏览器，还需开通 **H5 支付**
- 一个已认证的**服务号**：JSAPI 支付需要 AppID，以及用网页授权获取 openid
- 一个已备案、使用 https 的域名，并完成以下配置：
  - 商户平台：JSAPI 支付授权目录、H5 支付域名
  - 公众号后台：网页授权域名
- 商户平台 → API 安全：下载 API 证书私钥 `apiclient_key.pem`，设置 APIv3 密钥，下载**微信支付公钥**并记下公钥 ID，然后填进 `.env`
- 设置 `PAY_PROVIDER=wechat`，并按实际开通情况设置 `WECHAT_JSAPI_ENABLED` 和 `WECHAT_H5_ENABLED`

> `wechatpay.js` 按微信支付 API v3 文档实现，签名和回调验签解密已用本地生成的密钥测过（见 `test/wechatpay.test.js`），但还没有和真实商户号联调过。上线前请先用 0.01 元完成一次真实支付，并确认回调能正常收到。

### 2. 部署

```bash
# 服务器上（Node >= 22.9）
cd raise/server && npm ci --omit=dev
NODE_ENV=production npm start     # 建议用 pm2 / systemd 守护
```

- 用 Nginx 反向代理 https 并转发到 8787 端口，同时设置 `TRUST_PROXY=1`，否则 H5 支付拿不到用户的真实 IP。服务取 `X-Forwarded-For` 的最右一项作为用户 IP，所以代理必须追加（而不是透传）这个头。Nginx 中需要加上：

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8787;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  ```

- 服务只对外提供页面运行所需的 5 个文件（`index.html`、`css/app.css`、`js/app.js`、`js/config.js`、`js/schema.js`），其余文件（包括方案引擎、密钥、数据）一律返回 404
- 定期备份 `server/data/db.json`。流量上来后，把 `store.js` 换成数据库实现即可，接口不用改

### 3. 价格

在 `.env` 中设置，单位是“分”：`PRICE_FEN=2990`（¥29.9），`ORIGINAL_PRICE_FEN=9900`（划线价）。

## 社会证明数据（“帮助了多少类似的人”）

付费页的这个数字**只展示真实数据**：

1. 用户谈完后在方案页点“涨薪成功”或“部分成功”，计入 `helped`，按 行业 × 职级 分组统计
2. 同组人数达到 `SOCIAL_MIN_DISPLAY`（默认 30）时，展示“已帮助 N 位 互联网 · 资深用户反馈涨薪成功”
3. 同组人数不足、但全站达到门槛时，展示全站人数
4. 都不足时，退而展示同组“已解锁方案”的付费订单数（只算付费订单，同一个人反复测评不会把数字刷高）；仍然不足时，展示公开调研数据（PayScale：主动开口的人中 70% 获得了涨薪）
5. 如果上线前有可追溯的内测数据，可以填进 `server/stats-baseline.json`（参考 `stats-baseline.example.json`，也可用环境变量 `STATS_BASELINE_FILE` 指定路径）

> **合规提醒**：《广告法》和《反不正当竞争法》禁止虚构交易量、用户评价和效果数据。请不要在 baseline 里填写无法追溯的数字。“成功率”和“涨幅”页面上已标注为模型预估，不构成承诺，这一点请保留。

运营数据：`GET /api/admin/stats`（请求头 `Authorization: Bearer <ADMIN_TOKEN>`），可以看到诊断数、订单数、付费数、收入和分组统计。

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 服务状态、价格、可用支付方式 |
| POST | `/api/preview` | 提交问卷，返回诊断（不含方案细节） |
| GET | `/api/preview/:id` | 恢复诊断（微信授权回跳后使用） |
| POST | `/api/order` | 下单，返回 H5 跳转链接或 JSAPI 调起参数 |
| POST | `/api/pay/wechat/notify` | 微信支付回调（验签 + 解密 + 金额校验） |
| GET | `/api/order/:id` | 查询订单状态，未支付时会主动向微信查单 |
| GET | `/api/report/:id` | 获取完整方案（必须已支付） |
| GET | `/api/report/:id/ai` | 获取 AI 定制内容的状态和结果 |
| POST | `/api/outcome` | 用户反馈谈判结果 |
| GET | `/api/wechat/oauth` | 微信网页授权（JSAPI 支付取 openid） |

## 后续可以做

- 接入支付宝（`server.js` 的下单接口已按支付渠道分支，新增一个 provider 即可）
- 根据 `/api/outcome` 收集的真实结果回归校准模型权重
- 分享海报（“我的涨薪成功率 xx%”）做裂变传播
- AI 模拟老板对练（多轮对话）作为高阶付费项
