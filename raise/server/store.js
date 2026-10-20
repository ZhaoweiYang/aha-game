// 轻量 JSON 文件存储。单机小流量足够；流量上来后换成 MySQL / Redis，接口保持不变即可。
'use strict';

const fs = require('fs');
const path = require('path');

const PREVIEW_TTL_MS = 7 * 24 * 3600 * 1000;

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = { previews: {}, orders: {}, stats: {}, outcomes: [] };
    if (fs.existsSync(this.file)) {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    }
    this.pruneExpired();
    this.timer = null;
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

  pruneExpired() {
    const now = Date.now();
    const paidPreviews = new Set(Object.values(this.data.orders).map((o) => o.previewId));
    for (const [id, p] of Object.entries(this.data.previews)) {
      if (now - p.createdAt > PREVIEW_TTL_MS && !paidPreviews.has(id)) delete this.data.previews[id];
    }
  }

  bump(segKey, field, n) {
    const s = this.data.stats[segKey] || (this.data.stats[segKey] = { generated: 0, paid: 0, helped: 0 });
    s[field] = (s[field] || 0) + (n || 1);
    this.save();
  }
}

module.exports = { Store };
