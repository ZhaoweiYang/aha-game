/* 涨薪军师 · H5 前端 */
(function () {
  'use strict';

  const CFG = window.RAISE_CONFIG || {};
  const S = window.RaiseSchema;
  const API = (CFG.apiBase || '').replace(/\/$/, '');
  const ORDERS_KEY = 'raise_orders';
  const DRAFT_KEY = 'raise_draft';
  const PAID_KEY = 'raise_paid_previews';   // 诊断 id → 已支付订单 id，避免同一份诊断重复购买
  const PENDING_KEY = 'raise_pending_order'; // 跳转 H5 支付前记下订单对应的诊断，支付回来后可以回到付费页

  const state = {
    mode: null,          // 'live' | 'demo'
    server: null,        // /api/health 返回
    step: 0,
    input: Object.assign({}, S.DEFAULTS, { achievements: [] }),
    preview: null,
    previewId: null,
    social: null,
    orderId: null,
    ready: null          // 后端探测完成的 Promise；提交和支付前先等它
  };

  /* ---------------- 工具 ---------------- */

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const money = (n) => '¥' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const pct = (v) => (Math.round(v * 10) / 10).toString().replace(/\.0$/, '') + '%';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isWeChat = () => /MicroMessenger/i.test(navigator.userAgent);

  const store = {
    get(key, dflt) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; }
    },
    set(key, v) {
      try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 隐私模式等场景忽略 */ }
    }
  };

  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }

  function modal(opts) {
    const card = $('#modalCard');
    card.innerHTML = `<h3>${esc(opts.title)}</h3><p>${opts.html || esc(opts.body || '')}</p>
      <div class="btns">${opts.cancel !== false ? `<button class="btn btn-ghost" data-m="cancel">${esc(opts.cancelText || '取消')}</button>` : ''}
      <button class="btn btn-primary" data-m="ok">${esc(opts.ok || '确定')}</button></div>`;
    $('#modal').classList.remove('hidden');
    card.onclick = (e) => {
      const m = e.target.getAttribute('data-m');
      if (!m) return;
      $('#modal').classList.add('hidden');
      if (m === 'ok' && opts.onOk) opts.onOk();
      if (m === 'cancel' && opts.onCancel) opts.onCancel();
    };
  }

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    window.scrollTo(0, 0);
  }

  async function api(path, body, method) {
    const res = await fetch(API + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || ('请求失败 ' + res.status)), { status: res.status });
    return data;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // 返回 { ok } 后端可用；{ absent } 确定没有后端（404 或非 JSON，例如纯静态托管）；{ error } 网络问题
  async function probeHealth(ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(API + '/api/health', { signal: ctrl.signal, credentials: 'include' });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.ok) return { ok: data };
      return res.status === 404 || !data ? { absent: true } : { error: true };
    } catch (e) {
      return { error: true };
    } finally {
      clearTimeout(t);
    }
  }

  // 网络慢或后端临时故障时不能退回演示模式（后端不提供 engine.js），而是提示用户重试
  async function detectMode() {
    let r = await probeHealth(3000);
    if (r.error) r = await probeHealth(8000);
    if (r.ok) { state.mode = 'live'; state.server = r.ok; return; }
    if (r.absent) {
      try { await loadScript('js/engine.js'); state.mode = 'demo'; return; } catch (e) { /* 落到 offline */ }
    }
    state.mode = 'offline';
  }

  function offlineToast() {
    toast('网络不太稳定，请检查网络后刷新页面重试', 3500);
  }

  /* ---------------- 问卷 ---------------- */

  const STEPS = [
    {
      title: '先说说你的基本盘', sub: '用于匹配同城、同行业、同职级的调薪数据',
      fields: [
        { key: 'city', type: 'chips', label: '所在城市' },
        { key: 'industry', type: 'chips', label: '所在行业' },
        { key: 'role', type: 'chips', label: '岗位类型' },
        { key: 'level', type: 'chips', cols: 2, label: '目前职级' },
        { key: 'salary', type: 'number', label: '目前月薪', hint: '税前', unit: '元/月', min: 1000, max: 1000000, required: true },
        { key: 'months', type: 'chips', label: '一年发几个月' },
        { key: 'years', type: 'number', label: '总工作年限', unit: '年', min: 0, max: 45 },
        { key: 'tenure', type: 'chips', label: '在现公司多久' }
      ]
    },
    {
      title: '你创造了哪些价值？', sub: '老板为价值付钱，不为辛苦付钱',
      fields: [
        { key: 'performance', type: 'chips', cols: 2, label: '最近一次绩效' },
        { key: 'achievements', type: 'multi', label: '过去一年的关键成果', hint: '可多选' },
        { key: 'achievementText', type: 'textarea', label: '最拿得出手的一件事', hint: '建议填写', placeholder: '例：主导新会员体系上线，3 个月复购率提升 12%，带来约 80 万增量收入', help: '带上数字——方案会直接把它写进你的面谈脚本' },
        { key: 'irreplaceable', type: 'scale', label: '如果你明天离职，团队多难找人替代？', ends: ['很容易', '几乎找不到'] },
        { key: 'lastRaise', type: 'chips', label: '上次调薪是什么时候' }
      ]
    },
    {
      title: '你手上有哪些筹码？', sub: '筹码决定你能开多高的价',
      fields: [
        { key: 'market', type: 'chips', cols: 2, label: '你的薪资和市场相比' },
        { key: 'offer', type: 'chips', label: '有没有外部机会' },
        { key: 'offerSalary', type: 'number', label: 'offer 的月薪', hint: '税前', unit: '元/月', min: 1000, max: 2000000, required: true, showIf: (i) => i.offer === 'has_offer' },
        { key: 'willingToLeave', type: 'chips', label: '如果谈不拢，你会走吗', showIf: (i) => i.offer !== 'none' }
      ]
    },
    {
      title: '公司和老板', sub: '知己知彼：同样的话，对不同的老板要换种说法',
      fields: [
        { key: 'companyType', type: 'chips', label: '公司类型' },
        { key: 'companyStatus', type: 'chips', cols: 2, label: '公司最近的经营状况' },
        { key: 'cycle', type: 'chips', cols: 2, label: '离公司调薪 / 绩效窗口' },
        { key: 'bossStyle', type: 'chips', cols: 2, label: '你的老板更像哪种' },
        { key: 'bossPower', type: 'chips', label: '你的加薪谁说了算' },
        { key: 'relation', type: 'scale', label: '你和老板的关系', ends: ['很一般', '非常信任'] }
      ]
    },
    {
      title: '最后，你的目标', sub: '越具体，方案越贴合你',
      fields: [
        { key: 'goal', type: 'chips', label: '这次想谈什么' },
        { key: 'expect', type: 'number', label: '你期望的涨幅', unit: '%', min: 1, max: 100, required: true },
        { key: 'extra', type: 'textarea', label: '补充情况', hint: '选填', placeholder: '公司情况、老板细节、你的顾虑……\n例：部门刚换了新领导；我一个人干两个人的活；新来的同事工资比我高', help: '写得越多，方案越有针对性' },
        { key: 'name', type: 'text', label: '怎么称呼你', hint: '选填', placeholder: '用于生成你的价值清单和邮件模板' }
      ]
    }
  ];

  function fieldHtml(f) {
    const v = state.input[f.key];
    const label = `<label class="field-label">${esc(f.label)}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`;
    let body = '';
    if (f.type === 'chips' || f.type === 'multi') {
      const opts = S.OPTIONS[f.key];
      body = `<div class="chips ${f.cols === 2 ? 'cols-2' : ''}">` + opts.map((o) => {
        const on = f.type === 'multi' ? v.indexOf(o[0]) >= 0 : String(v) === String(o[0]);
        return `<button type="button" class="chip ${on ? 'on' : ''}" data-key="${f.key}" data-val="${esc(o[0])}" data-multi="${f.type === 'multi' ? 1 : 0}">${esc(o[1])}${o[2] ? `<small>${esc(o[2])}</small>` : ''}</button>`;
      }).join('') + '</div>';
    } else if (f.type === 'number') {
      body = `<div class="input-wrap"><input class="input" type="number" inputmode="decimal" data-key="${f.key}" value="${v === '' || v == null || (v === 0 && f.min > 0) ? '' : v}" min="${f.min}" max="${f.max}" placeholder="请输入"><span class="unit">${esc(f.unit)}</span></div>`;
    } else if (f.type === 'text') {
      body = `<input class="input" type="text" maxlength="20" data-key="${f.key}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}">`;
    } else if (f.type === 'textarea') {
      body = `<textarea class="textarea" data-key="${f.key}" maxlength="${f.key === 'extra' ? 1000 : 600}" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
    } else if (f.type === 'scale') {
      body = '<div class="scale">' + [1, 2, 3, 4, 5].map((n) =>
        `<button type="button" class="chip ${v === n ? 'on' : ''}" data-key="${f.key}" data-val="${n}" data-num="1">${n}</button>`).join('') +
        `</div><div class="scale-labels"><span>${esc(f.ends[0])}</span><span>${esc(f.ends[1])}</span></div>`;
    }
    return `<div class="field" data-field="${f.key}">${label}${body}${f.help ? `<div class="field-help">${esc(f.help)}</div>` : ''}</div>`;
  }

  function renderStep() {
    const step = STEPS[state.step];
    const fields = step.fields.filter((f) => !f.showIf || f.showIf(state.input));
    $('#formBody').innerHTML = `<h2 class="step-title">${esc(step.title)}</h2><p class="step-sub">${esc(step.sub)}</p>` + fields.map(fieldHtml).join('');
    $('#progressBar').style.width = ((state.step + 1) / STEPS.length * 100) + '%';
    $('#stepCount').textContent = (state.step + 1) + '/' + STEPS.length;
    $('#nextBtn').textContent = state.step === STEPS.length - 1 ? '生成我的涨薪诊断' : '下一步';
  }

  function onFormClick(e) {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const key = chip.dataset.key;
    let val = chip.dataset.val;
    if (chip.dataset.num === '1' || typeof S.DEFAULTS[key] === 'number') val = Number(val);
    if (chip.dataset.multi === '1') {
      const list = state.input[key];
      const i = list.indexOf(val);
      if (i >= 0) list.splice(i, 1); else list.push(val);
      chip.classList.toggle('on');
    } else {
      state.input[key] = val;
      chip.parentNode.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
      // 有依赖字段时重绘（保留滚动位置）
      if (key === 'offer') { const y = window.scrollY; renderStep(); window.scrollTo(0, y); }
    }
    chip.closest('.field').classList.remove('invalid');
    store.set(DRAFT_KEY, state.input);
  }

  function onFormInput(e) {
    const key = e.target.dataset.key;
    if (!key) return;
    state.input[key] = e.target.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value;
    e.target.closest('.field').classList.remove('invalid');
    store.set(DRAFT_KEY, state.input);
  }

  function validateStep() {
    const step = STEPS[state.step];
    let firstBad = null;
    step.fields.forEach((f) => {
      if (f.showIf && !f.showIf(state.input)) return;
      if (f.type !== 'number') return;
      const v = state.input[f.key];
      const bad = (f.required && (v === '' || v == null)) || (v !== '' && v != null && (v < f.min || v > f.max));
      if (bad) {
        const el = document.querySelector(`[data-field="${f.key}"]`);
        el.classList.add('invalid');
        if (!firstBad) firstBad = { el, f };
      }
    });
    if (firstBad) {
      firstBad.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(`请填写有效的「${firstBad.f.label}」（${firstBad.f.min}-${firstBad.f.max}）`);
      return false;
    }
    return true;
  }

  function next() {
    if (!validateStep()) return;
    if (state.step < STEPS.length - 1) { state.step++; renderStep(); window.scrollTo(0, 0); return; }
    submit();
  }

  function prev() {
    if (state.step === 0) { show('s-home'); return; }
    state.step--; renderStep(); window.scrollTo(0, 0);
  }

  /* ---------------- 诊断 ---------------- */

  async function animateLoading(minMs) {
    const items = document.querySelectorAll('#loadingSteps li');
    items.forEach((li) => li.classList.remove('done'));
    const per = minMs / items.length;
    for (const li of items) { await sleep(per); li.classList.add('done'); }
  }

  const RESEARCH_SOCIAL = { type: 'research', label: '主动开口的人里', count: '70%', text: '获得了涨薪（PayScale 16 万人调研）' };

  async function submit() {
    await state.ready;
    if (state.mode === 'offline') { offlineToast(); return; }
    $('#s-loading h2').textContent = '正在生成你的涨薪诊断';
    show('s-loading');
    const anim = animateLoading(2600);
    try {
      if (state.mode === 'live') {
        const data = await api('/api/preview', { input: state.input });
        state.previewId = data.previewId;
        state.preview = data.preview;
        state.social = data.social || RESEARCH_SOCIAL;
        state.server.price = data.price || state.server.price;
      } else {
        const a = window.RaiseEngine.analyze(state.input);
        state.preview = window.RaiseEngine.preview(a);
        state.social = RESEARCH_SOCIAL;
      }
      await anim;
      renderPay();
    } catch (err) {
      await anim;
      show('s-form');
      toast(err.message || '生成失败，请重试');
    }
  }

  function gauge(p) {
    const r = 46, c = 2 * Math.PI * r;
    return `<svg class="gauge" viewBox="0 0 112 112" role="img" aria-label="预计成功率 ${p}%">
      <circle class="gauge-track" cx="56" cy="56" r="${r}" fill="none" stroke-width="10"/>
      <circle class="gauge-val" cx="56" cy="56" r="${r}" fill="none" stroke-width="10"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${c.toFixed(1)}" data-offset="${(c * (1 - p / 100)).toFixed(1)}"
        transform="rotate(-90 56 56)"/>
      <text class="gauge-text" x="56" y="60" text-anchor="middle">${p}%</text>
      <text class="gauge-sub" x="56" y="78" text-anchor="middle">成功率</text>
    </svg>`;
  }

  function priceInfo() {
    if (state.mode === 'live' && state.server && state.server.price) return state.server.price;
    return { yuan: CFG.demoPrice || 29.9, originalYuan: CFG.demoOriginalPrice || 99 };
  }

  function renderPay() {
    const p = state.preview;
    const price = priceInfo();
    const social = state.social;
    const ra = p.rangeAmount;
    const roi = ra.low > 0 ? Math.max(1, Math.round(price.yuan / ra.low * 100)) : null;
    const locks = [
      ['🧭', '筹码五维诊断 + 风险项逐一拆解'],
      ['🎯', '你的开价锚点 / 目标 / 底线（精确到元）'],
      ['⏰', '最佳开口时机与避雷时段'],
      ['🎙️', '按老板性格定制的逐句面谈脚本'],
      ['🛡️', '老板 10 大反驳 · 应对话术'],
      ['🕵️', 'FBI 谈判技巧卡（镜像 / 标注 / 校准问题）'],
      ['🧩', 'Plan B：钱谈不拢时还能争取什么'],
      ['📄', '约谈话术 + 一页纸价值清单 + 确认邮件模板']
    ];
    if (state.mode === 'live' && state.server && state.server.ai) locks.push(['🤖', 'AI 根据你的补充情况深度定制']);
    $('#payBody').innerHTML = `
      ${state.mode === 'demo' ? '<span class="demo-badge">演示模式：未连接支付服务，可模拟支付体验完整流程</span>' : ''}
      <h2 class="pay-title">你的涨薪诊断已生成</h2>
      <p class="pay-sub">${esc(p.segment.label)} · 当前月薪 ${money(p.salary)}</p>
      <div class="metric-card">
        <div class="metric-main">
          ${gauge(p.prob)}
          <div>
            <div class="metric-title">预计涨薪成功率</div>
            <div class="metric-note">不做准备直接开口约 <b>${p.baseProb}%</b></div>
            ${p.prob > p.baseProb ? `<span class="uplift">按方案执行 +${p.prob - p.baseProb}%</span>` : ''}
          </div>
        </div>
      </div>
      <div class="metric-row">
        <div class="metric-card">
          <div class="metric-label">预计涨幅</div>
          <div class="metric-value gold range">${pct(p.range.low)}–<wbr>${pct(p.range.high)}</div>
          <div class="metric-note">每月多 <b>${money(ra.low)}–${money(ra.high)}</b><br>每年多 ${money(ra.annualLow)}–${money(ra.annualHigh)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">${esc(social.label)}</div>
          <div class="helped-num">${esc(social.count)}</div>
          <div class="metric-note">${esc(social.text)}</div>
        </div>
      </div>
      <div class="strategy-card">
        <b>推荐策略：${esc(p.strategy.label)}</b>
        <p>${p.topStrength ? `你最大的优势：${esc(p.topStrength)}<br>` : ''}${p.riskCount ? `发现 <b>${p.riskCount}</b> 个风险项${p.topRisk ? `（如：${esc(p.topRisk)}）` : ''}，完整方案逐一给出应对` : '暂未发现明显短板'}</p>
      </div>
      <div class="lock-list">${locks.map((l) => `<div class="lock-item"><span>${l[0]}</span>${esc(l[1])}<span class="lk">🔒</span></div>`).join('')}</div>
      <div class="blur-preview">
        <div class="blurred">你：谢谢您抽时间。在开始前我想先说一句：您可能会觉得我今天是来给您出难题的……综合这些，我希望把月薪调整到 ¥××,×××。（停顿，沉默 5 秒）老板：……你：听起来这个数字让您有些顾虑，您觉得要实现这个调整，我们需要怎么做？</div>
        <div class="unlock-tip">🔒 解锁查看你的逐句面谈脚本</div>
      </div>
      ${roi ? `<p class="roi">方案费用仅相当于预计<b>首月涨幅的 ${roi}%</b></p>` : ''}
      <p class="disclaimer">* 成功率与涨幅为基于公开调研数据（PayScale、前程无忧等）与你填写信息的模型预估，仅供参考，不构成对结果的承诺。虚拟内容商品，解锁后即可查看。</p>`;
    $('#priceNow').textContent = '¥' + price.yuan;
    $('#priceOld').textContent = price.originalYuan ? '¥' + price.originalYuan : '';
    show('s-pay');
    requestAnimationFrame(() => setTimeout(() => {
      const g = document.querySelector('.gauge-val');
      if (g) g.style.strokeDashoffset = g.dataset.offset;
    }, 60));
  }

  /* ---------------- 支付 ---------------- */

  // 只记录已确认支付的订单，供首页“查看我已购买的方案”使用
  function rememberPaid(orderId, previewId) {
    const list = store.get(ORDERS_KEY, []).filter((x) => x !== orderId);
    list.unshift(orderId);
    store.set(ORDERS_KEY, list.slice(0, 10));
    $('#myReportBtn').classList.remove('hidden');
    const pending = store.get(PENDING_KEY, null);
    if (pending && pending.orderId === orderId) store.set(PENDING_KEY, null);
    if (previewId) {
      const map = store.get(PAID_KEY, {});
      map[previewId] = orderId;
      store.set(PAID_KEY, map);
    }
  }

  function paidOrderFor(previewId) {
    return previewId ? store.get(PAID_KEY, {})[previewId] : null;
  }

  // 离开“确认支付中”的等待页：回到付费页，没有诊断数据时回首页
  // 链接参数（?order= / ?resume=）处理完再去掉：刷新不会重复进入付费页，转发出去的链接也不带别人的诊断或订单
  function stripParams() {
    if (location.search) history.replaceState(null, '', location.pathname);
  }

  async function leaveLoading() {
    stripParams();
    $('#s-loading h2').textContent = '正在生成你的涨薪诊断';
    if (!state.preview && state.previewId) {
      try { applyPreview(await api('/api/preview/' + encodeURIComponent(state.previewId))); } catch (e) { /* 诊断已过期 */ }
    }
    if (state.preview) renderPay(); else show('s-home');
  }

  function applyPreview(data) {
    state.preview = data.preview;
    state.social = data.social || RESEARCH_SOCIAL;
    if (data.price && state.server) state.server.price = data.price;
    if (data.input) state.input = Object.assign({}, state.input, data.input);
  }

  async function pay() {
    await state.ready;
    if (state.mode === 'demo') {
      modal({
        title: '演示模式',
        body: '当前页面未连接支付服务（部署 server/ 后即可真实收费）。点击“模拟支付成功”体验完整方案。',
        ok: '模拟支付成功',
        onOk: () => showReport(window.RaiseEngine.buildReport(state.input), { status: 'off' })
      });
      return;
    }
    if (state.mode === 'offline') { offlineToast(); return; }
    const bought = paidOrderFor(state.previewId);
    if (bought) { waitPaid(bought, state.previewId); return; }
    const srv = state.server;
    const btn = $('#payBtn');
    let channel = srv.pay.provider === 'mock' ? 'mock' : (isWeChat() ? 'jsapi' : 'h5');
    if (channel === 'jsapi' && !srv.pay.jsapi) { toast('请点击右上角，选择在浏览器中打开后支付', 3500); return; }
    if (channel === 'h5' && !srv.pay.h5 && srv.pay.jsapi) { toast('请在微信中打开本页面完成支付', 3500); return; }
    if (channel === 'jsapi' && !srv.openid) {
      location.href = API + '/api/wechat/oauth?pid=' + encodeURIComponent(state.previewId);
      return;
    }
    btn.disabled = true;
    try {
      const res = await api('/api/order', { previewId: state.previewId, channel });
      state.orderId = res.orderId;
      if (res.mock) {
        modal({
          title: '测试支付',
          body: `服务端处于测试支付模式（PAY_PROVIDER=mock）。订单金额 ¥${res.amountYuan}，点击确认模拟支付成功。`,
          ok: '确认支付',
          onOk: async () => {
            try { await api('/api/pay/mock/confirm', { orderId: res.orderId }); waitPaid(res.orderId, state.previewId); } catch (e) { toast(e.message); }
          }
        });
      } else if (res.h5Url) {
        store.set(PENDING_KEY, { orderId: res.orderId, previewId: state.previewId });
        location.href = res.h5Url;
      } else if (res.jsapi) {
        const invoke = () => window.WeixinJSBridge.invoke('getBrandWCPayRequest', res.jsapi, (r) => {
          if (r.err_msg === 'get_brand_wcpay_request:ok') waitPaid(res.orderId, state.previewId);
          else if (r.err_msg === 'get_brand_wcpay_request:cancel') toast('支付已取消');
          else toast('支付未完成，请重试');
        });
        if (window.WeixinJSBridge) invoke();
        else document.addEventListener('WeixinJSBridgeReady', invoke, { once: true });
      }
    } catch (err) {
      toast(err.message || '下单失败，请重试');
    } finally {
      btn.disabled = false;
    }
  }

  async function waitPaid(orderId, previewId) {
    show('s-loading');
    document.querySelectorAll('#loadingSteps li').forEach((li) => li.classList.add('done'));
    document.querySelector('#s-loading h2').textContent = '正在确认支付结果…';
    for (let i = 0; i < 40; i++) {
      try {
        const o = await api('/api/order/' + encodeURIComponent(orderId));
        if (o.status === 'paid') { await loadReport(orderId, previewId); return; }
      } catch (e) { /* 继续轮询 */ }
      await sleep(1500);
    }
    modal({
      title: '暂未确认到支付',
      body: '如果你已完成支付，请稍后点击“重新查询”。如有疑问请联系客服并提供订单号：' + orderId,
      ok: '重新查询', cancelText: '返回',
      onOk: () => waitPaid(orderId, previewId),
      onCancel: leaveLoading
    });
  }

  async function loadReport(orderId, previewId) {
    const data = await api('/api/report/' + encodeURIComponent(orderId));
    state.orderId = orderId;
    rememberPaid(orderId, previewId);
    stripParams();
    $('#s-loading h2').textContent = '正在生成你的涨薪诊断';
    showReport(data.report, data.ai);
    if (data.ai && data.ai.status === 'pending') pollAi(orderId);
  }

  async function pollAi(orderId) {
    for (let i = 0; i < 45; i++) {
      await sleep(4000);
      try {
        const ai = await api('/api/report/' + encodeURIComponent(orderId) + '/ai');
        if (ai.status !== 'pending') { renderAi(ai); return; }
      } catch (e) { /* 继续 */ }
    }
    renderAi({ status: 'timeout' });
  }

  /* ---------------- 方案渲染 ---------------- */

  const B = {
    p: (b) => `<p>${rich(b.text)}</p>`,
    tip: (b) => `<div class="tip ${b.tone || 'info'}">${rich(b.text)}</div>`,
    tag: (b) => `<div class="tag-box"><b>${esc(b.text)}</b><p>${esc(b.desc)}</p></div>`,
    hero: (b) => `<div class="hero-row">${b.items.map((i) => `<div class="hero-tile"><div class="l">${esc(i.label)}</div><div class="v">${esc(i.value)}</div><div class="n">${esc(i.note)}</div></div>`).join('')}</div>`,
    list: (b) => `${b.title ? `<h3>${esc(b.title)}</h3>` : ''}<ul class="ul ${b.style || 'dot'}">${b.items.map((i) => `<li>${rich(i)}</li>`).join('')}</ul>`,
    bars: (b) => `${b.title ? `<h3>${esc(b.title)}</h3>` : ''}<div class="bars" role="list">${b.items.map((i) =>
      `<div class="bar-row" role="listitem" title="${esc(i.label)}：${i.value}"><span class="lbl">${esc(i.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, i.value)}%"></div></div><span class="val">${i.value}</span></div>`).join('')}</div>`,
    kv: (b) => `<table class="kv">${b.rows.map((r) => `<tr><td>${esc(r[0])}</td><td><span class="amt">${esc(r[1])}</span><span class="note">${esc(r[2])}</span></td></tr>`).join('')}</table>`,
    ladder: (b) => `<h3>${esc(b.title)}</h3><div class="ladder">${b.items.map((i) => `<div class="ladder-step"><span class="s">${esc(i.step)}</span><span class="a">${esc(i.amount)}</span><span class="n">${esc(i.note)}</span></div>`).join('')}</div>`,
    steps: (b) => `<div class="steps">${b.items.map((i) => `<div class="step-item"><span class="step-day">${esc(i.day)}</span><div><b>${esc(i.title)}</b><span>${rich(i.text)}</span></div></div>`).join('')}</div>`,
    copy: (b) => `<div class="copy-box"><div class="copy-head"><span>${esc(b.title)}</span><button class="copy-btn" data-copy>复制</button></div><pre>${esc(b.text)}</pre></div>`,
    dialog: (b) => `<h3>${esc(b.title)}</h3><div class="dialog">${b.lines.map((l) => {
      const cls = l.who === '你' ? 'you' : l.who === '老板' ? 'boss' : 'tech';
      return `<div class="dl ${cls}"><span class="who">${esc(l.who)}</span><span class="txt">${rich(l.text)}</span></div>`;
    }).join('')}</div>`,
    qa: (b) => `<div class="qa"><div class="qa-q">${b.tag ? `<span class="qa-tag">${esc(b.tag)}</span>` : ''}<span>${esc(b.q)}</span></div><div class="qa-m">潜台词：${esc(b.meaning)}</div><div class="qa-a">${rich(b.a)}</div><div class="qa-t">💡 ${esc(b.tech)}</div></div>`,
    cards: (b) => `<div class="cards">${b.items.map((c) => `<div class="card"><b>${esc(c.title)}</b><p>${esc(c.text)}</p><div class="ex">${esc(c.example)}</div></div>`).join('')}</div>`,
    sources: (b) => b.items.map((s) => `<div class="src"><span class="src-kind">${esc(s.kind)}</span><b>${esc(s.title)}</b><div class="au">${esc(s.author)}</div><div class="use">${esc(s.use)}</div></div>`).join('')
  };

  function sectionHtml(s) {
    return `<section class="sec" id="sec-${esc(s.id)}"><h2><span>${s.icon || ''}</span>${esc(s.title)}</h2>${s.blocks.map((b) => (B[b.t] ? B[b.t](b) : '')).join('')}</section>`;
  }

  function aiHtml(ai) {
    if (!ai || ai.status === 'off') return '';
    if (ai.status === 'pending') {
      return `<section class="sec" id="sec-ai"><h2><span>🤖</span>AI 深度定制</h2><div class="ai-pending"><div class="spinner"></div>AI 正在结合你的补充情况撰写专属建议，约 1 分钟…</div></section>`;
    }
    if (ai.status === 'timeout') {
      return `<section class="sec" id="sec-ai"><h2><span>🤖</span>AI 深度定制</h2><p>AI 定制还在生成中。稍后在首页点“查看我已购买的方案”重新打开即可看到，其余方案内容不受影响。</p></section>`;
    }
    if (ai.status === 'error' || !ai.sections) {
      return `<section class="sec" id="sec-ai"><h2><span>🤖</span>AI 深度定制</h2><p>AI 定制这次没有生成成功，其余方案内容不受影响。如需帮助，请联系客服并提供下方的订单号。</p></section>`;
    }
    return ai.sections.map((s) => sectionHtml(Object.assign({ icon: '🤖' }, s, { id: 'ai-' + s.id }))).join('');
  }

  function renderAi(ai) {
    const old = document.getElementById('sec-ai');
    const html = aiHtml(ai);
    if (old) old.outerHTML = html;
  }

  function showReport(report, ai) {
    const sections = report.sections;
    $('#reportNav').innerHTML = sections.map((s) => `<a href="#sec-${esc(s.id)}">${esc(s.title)}</a>`).join('');
    const outcome = state.mode === 'live' && state.orderId ? `
      <section class="sec outcome" id="sec-outcome">
        <h2 style="justify-content:center">谈完了？告诉我们结果</h2>
        <p>你的反馈会帮助更多和你情况类似的人</p>
        <div class="btns">
          <button class="btn btn-gold" data-outcome="success">🎉 涨薪成功</button>
          <button class="btn btn-ghost" data-outcome="partial">部分成功</button>
          <button class="btn btn-ghost" data-outcome="fail">暂未成功</button>
        </div>
      </section>` : '';
    const firstIdx = 1; // 在“局势诊断”后插入 AI 定制
    const html = sections.map((s, i) => sectionHtml(s) + (i === firstIdx - 1 ? aiHtml(ai) : '')).join('');
    $('#reportBody').innerHTML = html + `
      <div class="report-actions">
        ${isWeChat() && state.orderId
          ? '<button class="btn btn-ghost" data-action="copy-link">复制方案链接</button>'
          : (isWeChat() ? '' : '<button class="btn btn-ghost" data-action="print">保存为 PDF</button>')}
        <button class="btn btn-ghost" data-action="restart">重新测评</button>
      </div>` + outcome +
      (state.orderId ? `<p class="disclaimer" style="text-align:center">订单号：${esc(state.orderId)}（可在首页“查看我已购买的方案”再次打开）</p>` : '');
    show('s-report');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
      document.body.removeChild(ta);
    }
    toast('已复制');
  }

  async function sendOutcome(result) {
    try {
      await api('/api/outcome', { orderId: state.orderId, result });
      $('#sec-outcome').innerHTML = `<h2 style="justify-content:center">${result === 'fail' ? '谢谢反馈，下一轮继续加油 💪' : '恭喜！谢谢你的反馈 🎉'}</h2><p>${result === 'fail' ? '别灰心：回看 Plan B 和“锁定下一窗口”的话术，把这次谈话变成下一次的铺垫。' : '你的经验会帮助更多和你一样的人。'}</p>`;
    } catch (e) {
      toast(e.message || '提交失败');
    }
  }

  /* ---------------- 入口 ---------------- */

  function bind() {
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-action]');
      if (a) {
        const act = a.dataset.action;
        if (act === 'start') { state.step = 0; renderStep(); show('s-form'); }
        else if (act === 'next') next();
        else if (act === 'prev') prev();
        else if (act === 'pay') pay();
        else if (act === 'print') window.print();
        else if (act === 'copy-link') {
          // 微信内置浏览器不支持打印：复制链接到系统浏览器打开后再保存
          copyText(location.origin + location.pathname + '?order=' + encodeURIComponent(state.orderId))
            .then(() => toast('已复制。可在浏览器中打开后保存为 PDF（请勿分享给他人）', 3500));
        }
        else if (act === 'restart') { state.step = 0; renderStep(); show('s-form'); }
        else if (act === 'my-report') openMyReport();
        return;
      }
      const cp = e.target.closest('[data-copy]');
      if (cp) { copyText(cp.closest('.copy-box').querySelector('pre').textContent); return; }
      const oc = e.target.closest('[data-outcome]');
      if (oc) sendOutcome(oc.dataset.outcome);
    });
    $('#formBody').addEventListener('click', onFormClick);
    $('#formBody').addEventListener('input', onFormInput);
  }

  // 依次尝试本机记录的已购订单，打开第一个可用的；失效的记录顺手清掉
  async function openMyReport() {
    for (const id of store.get(ORDERS_KEY, [])) {
      try { await loadReport(id); return; } catch (e) {
        if (e.status !== 402 && e.status !== 404) { toast(e.message); return; }
        store.set(ORDERS_KEY, store.get(ORDERS_KEY, []).filter((x) => x !== id));
      }
    }
    $('#myReportBtn').classList.add('hidden');
    toast('没有找到已购买的方案');
  }

  // 恢复草稿：数字字段保留用户原样输入（包括空值和超出范围的值），交给下一步的校验提示，不能被悄悄补成合法值
  function restoreDraft(draft) {
    const input = S.normalizeInput(Object.assign({}, S.DEFAULTS, draft));
    ['salary', 'years', 'expect', 'offerSalary'].forEach((k) => {
      const v = draft[k];
      if (v === '' || (typeof v === 'number' && isFinite(v))) input[k] = v;
    });
    return input;
  }

  // H5 支付跳回时如果页面没能处理 ?order=（网络问题、被刷新），下次打开时再查一次这笔订单
  async function checkPending() {
    const pending = store.get(PENDING_KEY, null);
    if (!pending || !pending.orderId) return;
    try {
      const o = await api('/api/order/' + encodeURIComponent(pending.orderId));
      if (o.status === 'paid') {
        state.previewId = pending.previewId;
        await loadReport(pending.orderId, pending.previewId);
      }
    } catch (e) {
      if (e.status === 404) store.set(PENDING_KEY, null);
    }
  }

  async function init() {
    bind();
    state.ready = detectMode();
    const draft = store.get(DRAFT_KEY, null);
    if (draft && typeof draft === 'object') state.input = restoreDraft(draft);
    const params = new URLSearchParams(location.search);
    const order = params.get('order');
    const resume = params.get('resume');
    await state.ready;
    // 离线时保留链接参数，网络恢复后刷新即可继续
    if (state.mode === 'offline') { offlineToast(); return; }
    if (state.mode !== 'live') { stripParams(); return; }
    if (store.get(ORDERS_KEY, []).length) $('#myReportBtn').classList.remove('hidden');
    if (order) {
      const pending = store.get(PENDING_KEY, null);
      state.previewId = pending && pending.orderId === order ? pending.previewId : null;
      waitPaid(order, state.previewId); // 支付确认、打开方案或用户返回后才去掉 ?order=
      return;
    }
    if (resume) {
      state.previewId = resume;
      const bought = paidOrderFor(resume);
      if (bought) { waitPaid(bought, resume); return; }
      try {
        applyPreview(await api('/api/preview/' + encodeURIComponent(resume)));
        renderPay();
      } catch (e) { toast('诊断已过期，请重新测评'); }
      stripParams();
      return;
    }
    checkPending();
  }

  init();
})();
