/*
 * 前端配置。部署时按需修改。
 * apiBase：后端服务地址。留空字符串表示与页面同源（用 server/ 部署时）。
 *          若后端不可用（例如只把页面部署在 GitHub Pages），页面自动进入「演示模式」：
 *          本地计算方案、模拟支付，仅用于产品演示，不能真实收费。
 */
window.RAISE_CONFIG = {
  apiBase: '',
  productName: '涨薪军师',
  // 以下价格仅用于演示模式展示；真实价格以服务端 PRICE_FEN 为准
  demoPrice: 29.9,
  demoOriginalPrice: 99,
  // 演示模式下“已帮助”人数无真实数据，展示公开调研数据
  supportWechat: ''
};
