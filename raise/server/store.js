// 轻量 JSON 文件存储。单机小流量足够；流量上来后换成 MySQL / Redis，接口保持不变即可。
'use strict';

const fs = require('fs');
const path = require('path');

const TTL_MS = 7 * 24 * 3600 * 1000;

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = { previews: {}, orders: {}, stats: {} };
    if (fs.existsSync(this.file)) {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    }
    this.pruneExpired();
    // 长时间运行时定期清理过期数据，避免内存和每次写盘的体积无限增长
    this.pruneTimer = setInterval(() => this.pruneExpired(), 3600 * 1000);
    this.pruneTimer.unref();
    this.timer = null;
  }

  // 只按自有属性查找，避免 "__proto__" 之类的 id 取到原型链上的对象
  get(table, id) {
    const map = this.data[table];
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
  }

  // 防抖写盘：先写临时文件再 rename，避免进程中断导致文件损坏
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 200);
  }

  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  // 已支付订单永久保留；未支付的订单 7 天后清理；仍被订单引用的诊断不清理
  pruneExpired() {
    const now = Date.now();
    const keep = new Set();
    for (const [id, o] of Object.entries(this.data.orders)) {
      if (o.status !== 'paid' && now - o.createdAt > TTL_MS) delete this.data.orders[id];
      else keep.add(o.previewId);
    }
    for (const [id, p] of Object.entries(this.data.previews)) {
      if (now - p.createdAt > TTL_MS && !keep.has(id)) delete this.data.previews[id];
    }
    this.save();
  }

  bump(segKey, field, n) {
    const s = this.get('stats', segKey) || (this.data.stats[segKey] = { generated: 0, paid: 0, helped: 0 });
    s[field] = (s[field] || 0) + (n || 1);
    this.save();
  }
}

module.exports = { Store };
