// ==UserScript==
// @name         DeepSeek Usage Enhancer
// @namespace    https://github.com/local/deepseek-usage-enhancer
// @version      1.5.1
// @description  在 DeepSeek 用量页面注入今日数据（今日消费/请求数/Token/缓存命中率）；自动识别新版与旧版页面布局；图表悬停数字加千分位
// @author       Jmkwang
// @license      MIT
// @match        https://platform.deepseek.com/usage*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// ============================================================
// 适配新版平台 (2026-07 改版): 拦截 /usage/by_api_key/amount|cost
// 新接口 (series[].buckets[], 金额为字符串), 同时兼容旧版结构
// ============================================================

(function () {
  'use strict';

  // ============================================================
  // 状态
  // ============================================================
  let bearerToken = null;

  let rawUserSummary = null;
  let rawUsageAmount = null;
  let rawUsageCost = null;

  // ============================================================
  // 工具函数
  // ============================================================
  function utcToday() {
    const d = new Date();
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  function utcYesterday() {
    const d = new Date(Date.now() - 86400000);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  function utcMonthYear() {
    const d = new Date();
    return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
  }

  function safeJSON(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function log(msg) {
    console.log('[DS Inject] ' + msg);
  }

  // ============================================================
  // biz_data 提取
  // ============================================================
  function extractBizData(json) {
    if (!json) return null;
    let result = null;
    if (json.biz_data) result = json.biz_data;
    else if (json.data && json.data.biz_data) result = json.data.biz_data;
    else if (json.data && Array.isArray(json.data) && json.data.length > 0) result = json.data[0];
    else result = json;
    if (Array.isArray(result) && result.length > 0) return result[0];
    return result;
  }

  function findAuthHeader(req) {
    if (req.headers && typeof req.headers.get === 'function') {
      return req.headers.get('Authorization') || req.headers.get('authorization');
    }
    if (req.headers && typeof req.headers === 'object') {
      return req.headers['Authorization'] || req.headers['authorization'];
    }
    return null;
  }

  // ============================================================
  // 数据变换
  // ============================================================
  function usageArrayToMap(usageArr) {
    if (!Array.isArray(usageArr)) return {};
    const map = {};
    for (const u of usageArr) {
      map[u.type] = Number(u.amount) || 0;
    }
    return map;
  }

  function extractMetricsFromUsage(usageMap) {
    const types = Object.keys(usageMap);
    const lowerMap = {};
    for (const t of types) {
      lowerMap[t.toLowerCase()] = usageMap[t];
    }

    const find = (keywords) => {
      for (const kw of keywords) {
        if (usageMap[kw] !== undefined) return usageMap[kw];
        if (lowerMap[kw.toLowerCase()] !== undefined) return lowerMap[kw.toLowerCase()];
        for (const t of types) {
          if (t.toLowerCase().includes(kw.toLowerCase())) return usageMap[t];
        }
      }
      return 0;
    };

    const cachedInput = find(['PROMPT_CACHE_HIT_TOKEN', 'PROMPT_CACHE_HIT_TOKENS',
      'CACHE_HIT_TOKENS', 'cache_hit_tokens', 'prompt_cache_hit_tokens']);
    const uncachedInput = find(['PROMPT_CACHE_MISS_TOKEN', 'PROMPT_CACHE_MISS_TOKENS',
      'CACHE_MISS_TOKENS', 'cache_miss_tokens', 'prompt_cache_miss_tokens']);
    const output = find(['RESPONSE_TOKEN', 'RESPONSE_TOKENS',
      'COMPLETION_TOKEN', 'COMPLETION_TOKENS',
      'output_tokens', 'completion_tokens']);
    const requests = find(['REQUEST', 'REQUESTS',
      'API_REQUESTS', 'request_count', 'api_requests']);

    const total = cachedInput + uncachedInput + output;
    const divisor = cachedInput + uncachedInput;
    const cacheHitRate = divisor > 0
      ? Math.round((cachedInput / divisor) * 10000) / 100
      : null;

    return { requests, tokens: { total, cached_input: cachedInput, uncached_input: uncachedInput, output }, cache_hit_rate: cacheHitRate };
  }

  // ---- 新版平台: 桶的 time 是 Unix 秒, 按本地时区归入"今日/昨日" ----
  function localDateOf(unixSec) {
    const d = new Date(unixSec * 1000);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function localToday() {
    return localDateOf(Math.floor(Date.now() / 1000));
  }

  function localYesterday() {
    return localDateOf(Math.floor(Date.now() / 1000) - 86400);
  }

  // usage 字段可能是旧版数组 [{type, amount}] 或新版对象 {request, response_token, ...}
  function extractMetricsFromUsageFlexible(usage) {
    if (Array.isArray(usage)) {
      return extractMetricsFromUsage(usageArrayToMap(usage));
    }
    if (usage && typeof usage === 'object') {
      const n = (v) => Number(v) || 0;
      const pick = (...keys) => {
        for (const k of keys) {
          if (usage[k] !== undefined) return n(usage[k]);
        }
        return 0;
      };
      // 新版接口字段为 camelCase: usage.request / responseToken / promptCacheHitToken / promptCacheMissToken
      const cachedInput = pick('promptCacheHitToken', 'prompt_cache_hit_token', 'cached_input_tokens', 'cache_hit_tokens');
      const uncachedInput = pick('promptCacheMissToken', 'prompt_cache_miss_token', 'uncached_input_tokens', 'cache_miss_tokens');
      const output = pick('responseToken', 'response_token', 'output_tokens', 'completion_tokens');
      const requests = pick('request', 'apiRequests', 'api_requests', 'requests');
      const total = cachedInput + uncachedInput + output;
      const divisor = cachedInput + uncachedInput;
      const cacheHitRate = divisor > 0
        ? Math.round((cachedInput / divisor) * 10000) / 100
        : null;
      return { requests, tokens: { total, cached_input: cachedInput, uncached_input: uncachedInput, output }, cache_hit_rate: cacheHitRate };
    }
    return { requests: 0, tokens: { total: 0, cached_input: 0, uncached_input: 0, output: 0 }, cache_hit_rate: null };
  }

  // 收集 (model, date/time, usage) 记录, 兼容新旧两种结构
  function collectUsageRecords(bizData) {
    const records = [];
    // 新版: series[].buckets[].usage (按模型/API Key 拆分)
    if (Array.isArray(bizData.series)) {
      for (const s of bizData.series) {
        if (!s || !s.model || !Array.isArray(s.buckets)) continue;
        for (const b of s.buckets) {
          if (b && b.usage) records.push({ model: s.model, time: b.time, usage: b.usage });
        }
      }
      return records;
    }
    // 旧版: days[].data[] + total[]
    if (Array.isArray(bizData.days)) {
      for (const day of bizData.days) {
        if (!day || !Array.isArray(day.data)) continue;
        for (const entry of day.data) {
          if (entry && entry.model) records.push({ model: entry.model, date: day.date, usage: entry.usage });
        }
      }
    }
    for (const entry of (bizData.total || [])) {
      if (entry && entry.model) records.push({ model: entry.model, usage: entry.usage });
    }
    return records;
  }

  // 收集 (model, date/time, cost) 记录
  function collectCostRecords(bizData) {
    const records = [];
    // 新版: data[].series[].buckets[].cost (按币种分组, 金额是字符串)
    if (Array.isArray(bizData.data)) {
      for (const group of bizData.data) {
        if (!group || !Array.isArray(group.series)) continue;
        for (const s of group.series) {
          if (!s || !s.model || !Array.isArray(s.buckets)) continue;
          for (const b of s.buckets) {
            if (b) records.push({ model: s.model, time: b.time, cost: Number(b.cost) || 0 });
          }
        }
      }
      return records;
    }
    // 旧版: days[].data[] 的 usage 金额
    if (Array.isArray(bizData.days)) {
      for (const day of bizData.days) {
        if (!day || !Array.isArray(day.data)) continue;
        for (const entry of day.data) {
          if (!entry) continue;
          let c = 0;
          if (Array.isArray(entry.usage)) {
            for (const u of entry.usage) c += Number(u.amount) || 0;
          }
          records.push({ model: entry.model || '', date: day.date, cost: c });
        }
      }
    }
    return records;
  }

  function transformUserSummary(bizData) {
    const normalBal = (bizData.normal_wallets && bizData.normal_wallets[0])
      ? Number(bizData.normal_wallets[0].balance) || 0 : 0;
    const bonusBal = (bizData.bonus_wallets && bizData.bonus_wallets[0])
      ? Number(bizData.bonus_wallets[0].balance) || 0 : 0;

    // 新版可能直接给 total_balance / topped_up_balance / granted_balance
    let total = normalBal + bonusBal;
    if (total === 0) {
      const tb = Number(bizData.total_balance) || 0;
      const tu = Number(bizData.topped_up_balance) || 0;
      const gr = Number(bizData.granted_balance) || 0;
      if (tb > 0) total = tb;
      else if (tu + gr > 0) total = tu + gr;
    }

    const monthlyCost = (bizData.monthly_costs && bizData.monthly_costs[0])
      ? Number(bizData.monthly_costs[0].amount) || 0 : 0;
    const currency = (bizData.monthly_costs && bizData.monthly_costs[0])
      ? bizData.monthly_costs[0].currency : (bizData.currency || 'CNY');

    return {
      balance: { total, normal_wallet_balance: normalBal, bonus_wallet_balance: bonusBal, currency },
      monthly_consumption: { amount: monthlyCost, currency },
    };
  }

  function mergeModelMetrics(target, model, metrics) {
    if (!target[model]) {
      target[model] = metrics;
      return;
    }
    const m = target[model];
    m.requests += metrics.requests;
    m.tokens.total += metrics.tokens.total;
    m.tokens.cached_input += metrics.tokens.cached_input;
    m.tokens.uncached_input += metrics.tokens.uncached_input;
    m.tokens.output += metrics.tokens.output;
    const divisor = m.tokens.cached_input + m.tokens.uncached_input;
    m.cache_hit_rate = divisor > 0
      ? Math.round((m.tokens.cached_input / divisor) * 10000) / 100
      : null;
  }

  // 按日期集合筛选模型数据 (旧版 date 为 UTC 字符串, 新版 time 为 Unix 秒 → 本地日期)
  function extractModelsForDate(bizData, dateStrs) {
    const models = {};
    const dates = new Set(dateStrs);
    for (const rec of collectUsageRecords(bizData)) {
      const recDate = rec.date !== undefined ? rec.date
        : (rec.time !== undefined ? localDateOf(rec.time) : null);
      if (recDate === null || !dates.has(recDate)) continue;
      mergeModelMetrics(models, rec.model, extractMetricsFromUsageFlexible(rec.usage));
    }
    return models;
  }

  function transformUsageAmount(bizData) {
    return {
      today_date: localToday(),
      models: extractModelsForDate(bizData, [utcToday(), localToday()]),
      yesterday_models: extractModelsForDate(bizData, [utcYesterday(), localYesterday()]),
    };
  }

  function transformUsageCost(bizData) {
    let todayCost = 0;
    const modelCosts = {};
    let currency = bizData.currency || 'CNY';
    if (Array.isArray(bizData.data) && bizData.data[0] && bizData.data[0].currency) {
      currency = bizData.data[0].currency;
    }

    for (const rec of collectCostRecords(bizData)) {
      if (rec.date !== undefined) {
        if (rec.date !== utcToday() && rec.date !== localToday()) continue;
      } else if (rec.time !== undefined) {
        if (localDateOf(rec.time) !== localToday()) continue;
      }
      todayCost += rec.cost;
      if (rec.model) modelCosts[rec.model] = (modelCosts[rec.model] || 0) + rec.cost;
    }

    return { today_cost: { amount: Math.floor(todayCost * 100) / 100, currency }, model_costs: modelCosts };
  }

  function buildOutputPayload() {
    const summary = rawUserSummary
      ? transformUserSummary(rawUserSummary)
      : { balance: { total: 0, currency: 'CNY' }, monthly_consumption: { amount: 0, currency: 'CNY' } };

    let usageData = { today_date: utcToday(), models: {}, yesterday_models: {} };
    if (rawUsageAmount) usageData = transformUsageAmount(rawUsageAmount);

    let costData = { today_cost: { amount: 0, currency: 'CNY' } };
    if (rawUsageCost) costData = transformUsageCost(rawUsageCost);

    // 将模型费用合并到模型数据中
    if (costData.model_costs && usageData.models) {
      for (const [model, cost] of Object.entries(costData.model_costs)) {
        if (usageData.models[model]) {
          usageData.models[model].cost = Math.floor(cost * 100) / 100;
        }
      }
    }

    return {
      timestamp: new Date().toISOString(),
      ...summary,
      ...usageData,
      ...costData,
    };
  }

  // ============================================================
  // 数据接收
  // ============================================================
  function processApiResponse(endpoint, bizData) {
    switch (endpoint) {
    case 'get_user_summary': rawUserSummary = bizData; break;
    case 'usage_amount': rawUsageAmount = bizData; break;
    case 'usage_cost': rawUsageCost = bizData; break;
    }
    const payload = buildOutputPayload();
    if (payload) {
      onDataUpdate(payload);
    }
  }

  // ============================================================
  // 拦截层
  // ============================================================
  const TRACKED_ENDPOINTS = [
    { method: 'GET', path: '/users/get_user_summary', id: 'get_user_summary' },
    // 新版平台 (2026-07 改版): 按 API Key 拆分用量
    { method: 'GET', path: '/usage/by_api_key/amount', id: 'usage_amount' },
    { method: 'GET', path: '/usage/by_api_key/cost', id: 'usage_cost' },
    // 旧版平台兼容
    { method: 'GET', path: '/usage/amount', id: 'usage_amount' },
    { method: 'GET', path: '/usage/cost', id: 'usage_cost' },
  ];

  function matchEndpoint(method, url) {
    const m = method.toUpperCase();
    for (const ep of TRACKED_ENDPOINTS) {
      if (m === ep.method && url.includes(ep.path)) {
        return ep;
      }
    }
    // 新版平台也可能通过 /api/v0/users/{id} 返回账户汇总
    if (m === 'GET' && /\/users\/\d+(\/|$|\?)/.test(url)) {
      return { method: 'GET', path: '', id: 'get_user_summary' };
    }
    return null;
  }

  // --- fetch 拦截 ---
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');
    const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    const ep = matchEndpoint(method, url);

    if (ep) {
      const req = input instanceof Request ? input : { headers: init && init.headers };
      if (!bearerToken) {
        const auth = findAuthHeader(req);
        if (auth && auth.startsWith('Bearer ')) bearerToken = auth.slice(7);
      }
    }

    return origFetch.call(window, input, init).then(async (response) => {
      if (ep && response.ok) {
        try {
          const cloned = response.clone();
          const json = await cloned.json();
          const bizData = extractBizData(json);
          if (bizData) processApiResponse(ep.id, bizData);
        } catch (e) { /* ignore */ }
      }
      return response;
    });
  };

  // --- XHR 拦截 ---
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    let _method = 'GET';
    let _url = '';

    const origOpen = xhr.open;
    xhr.open = function (method, url, ...rest) {
      _method = method;
      _url = typeof url === 'string' ? url : url.toString();
      return origOpen.call(xhr, method, url, ...rest);
    };

    const origSetRequestHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function (header, value) {
      if (header.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
        if (!bearerToken) bearerToken = value.slice(7);
      }
      return origSetRequestHeader.call(xhr, header, value);
    };

    const origSend = xhr.send;
    xhr.send = function (body) {
      const ep = matchEndpoint(_method, _url);
      xhr.addEventListener('load', function () {
        if (ep && xhr.status >= 200 && xhr.status < 300) {
          const json = safeJSON(xhr.responseText);
          if (json) {
            const bizData = extractBizData(json);
            if (bizData) processApiResponse(ep.id, bizData);
          }
        }
      });
      return origSend.call(xhr, body);
    };
    return xhr;
  };
  window.XMLHttpRequest.prototype = OrigXHR.prototype;

  // ============================================================
  // DOM 注入
  // ============================================================
  let latestPayload = null;
  let tooltipObserverSetup = false;
  const INJECT_MARKER = 'data-ds-inject';

  // ============================================================
  // 新版页面 (2026-07 改版) 注入
  // 锚点: 统计行 c7197b0d (消费金额/请求次数/Tokens), 模型名 ce40a39d
  // ============================================================
  const NEW_OVERVIEW_CLS = 'c7197b0d';
  const NEW_MODELNAME_CLS = 'ce40a39d';
  const V2_MARKER = 'data-ds-inject-v2';

  let layout = 'unknown';
  let layoutLogged = false;

  function detectLayout() {
    if (document.querySelector('[class*="' + NEW_OVERVIEW_CLS + '"]') ||
        document.querySelector('[class*="' + NEW_MODELNAME_CLS + '"]')) return 'new';
    if (document.querySelector('[class*="a0cde8c1"]')) return 'old';
    return 'none';
  }

  function ensureLayout() {
    if (layout !== 'new' && layout !== 'old') {
      const d = detectLayout();
      if (d !== 'none') {
        layout = d;
        if (!layoutLogged) { layoutLogged = true; log('页面布局识别: ' + layout); }
      } else if (document.body && document.body.children && document.body.children.length > 0 && !layoutLogged) {
        layoutLogged = true;
        log('未识别页面布局, 跳过 DOM 注入 (数据仍在拦截)');
      }
    }
    return layout;
  }

  function v2FmtShort(n) {
    if (n === undefined || n === null) return '—';
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString();
  }

  function v2Money(n) {
    return '¥' + (Math.floor((Number(n) || 0) * 100) / 100).toFixed(2);
  }

  function v2Chip(label, value) {
    const span = document.createElement('span');
    span.className = 'dsv2-chip';
    const lbl = document.createElement('b');
    lbl.textContent = label;
    const val = document.createElement('i');
    val.textContent = value;
    span.appendChild(lbl);
    span.appendChild(val);
    return span;
  }

  function v2StyleOnce() {
    if (document.getElementById('dsv2-style')) return;
    const st = document.createElement('style');
    st.id = 'dsv2-style';
    st.textContent =
      '.dsv2-strip{display:flex;flex-wrap:wrap;gap:8px;padding:10px 14px;margin:12px 0 4px;' +
      'background:rgba(30,30,46,.92);border:1px solid rgba(255,255,255,.1);border-radius:12px;' +
      'font-family:-apple-system,\'SF Pro Text\',\'Helvetica Neue\',sans-serif;font-size:12px;color:#cdd6f4;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.35);z-index:50;}' +
      '.dsv2-chip{display:inline-flex;align-items:baseline;gap:6px;padding:4px 10px;' +
      'background:rgba(255,255,255,.06);border-radius:8px;white-space:nowrap;}' +
      '.dsv2-chip b{font-weight:600;color:#6c7086;font-size:11px;}' +
      '.dsv2-chip i{font-style:normal;font-weight:700;color:#cdd6f4;font-variant-numeric:tabular-nums;}';
    (document.head || document.body || document.documentElement).appendChild(st);
  }

  function v2Summary(payload) {
    const models = payload.models || {};
    let req = 0, tok = 0, cached = 0, input = 0;
    for (const name of Object.keys(models)) {
      const m = models[name];
      req += m.requests || 0;
      if (m.tokens) {
        tok += m.tokens.total || 0;
        cached += m.tokens.cached_input || 0;
        input += (m.tokens.cached_input || 0) + (m.tokens.uncached_input || 0);
      }
    }
    const hit = input > 0 ? Math.round((cached / input) * 1000) / 10 : null;
    return { cost: (payload.today_cost || {}).amount || 0, req, tok, hit };
  }

  function injectNewLayout() {
    const payload = latestPayload;
    if (!payload) return;
    v2StyleOnce();
    const s = v2Summary(payload);

    // 1) 统计行后插入今日数据条
    const statsRow = document.querySelector('[class*="' + NEW_OVERVIEW_CLS + '"]');
    if (statsRow) {
      let strip = document.querySelector('[' + V2_MARKER + '="strip"]');
      if (!strip) {
        strip = document.createElement('div');
        strip.className = 'dsv2-strip';
        strip.setAttribute(V2_MARKER, 'strip');
        statsRow.insertAdjacentElement('afterend', strip);
      }
      strip.innerHTML = '';
      strip.appendChild(v2Chip('今日消费', v2Money(s.cost)));
      strip.appendChild(v2Chip('今日请求', v2FmtShort(s.req)));
      strip.appendChild(v2Chip('今日Tokens', v2FmtShort(s.tok)));
      strip.appendChild(v2Chip('缓存命中率', s.hit !== null ? s.hit.toFixed(1) + '%' : '—'));
    }

    // 2) 每个模型名后插入今日明细行
    const modelEls = document.querySelectorAll('[class*="' + NEW_MODELNAME_CLS + '"]');
    for (const el of modelEls) {
      const text = (el.textContent || '').trim();
      if (!text) continue;
      let matchedName = null;
      for (const name of Object.keys(payload.models || {})) {
        if (text.toLowerCase().includes(name.toLowerCase()) ||
            name.toLowerCase().includes(text.toLowerCase())) {
          matchedName = name;
          break;
        }
      }
      if (!matchedName) continue;
      const m = payload.models[matchedName];
      const marker = 'model-' + matchedName.replace(/[^a-z0-9-]/gi, '_');
      let row = document.querySelector('[' + V2_MARKER + '="' + marker + '"]');
      if (!row) {
        row = document.createElement('div');
        row.className = 'dsv2-strip';
        row.setAttribute(V2_MARKER, marker);
        el.insertAdjacentElement('afterend', row);
      }
      row.innerHTML = '';
      const nameChip = document.createElement('span');
      nameChip.className = 'dsv2-chip';
      nameChip.textContent = text;
      row.appendChild(nameChip);
      row.appendChild(v2Chip('今日请求', v2FmtShort(m.requests)));
      row.appendChild(v2Chip('今日Tokens', v2FmtShort(m.tokens ? m.tokens.total : 0)));
      row.appendChild(v2Chip('命中率', (m.cache_hit_rate !== null && m.cache_hit_rate !== undefined)
        ? m.cache_hit_rate.toFixed(1) + '%' : '—'));
      row.appendChild(v2Chip('今日消费', v2Money(m.cost)));
    }
  }

  function onDataUpdate(payload) {
    latestPayload = payload;
    tryAllInjections();
  }

  // 检查页面上是否已有注入标记（被 React 重绘后标记消失）
  function isInjectionPresent(marker) {
    return !!document.querySelector('[' + INJECT_MARKER + '="' + marker + '"]');
  }

  function tryAllInjections() {
    if (!latestPayload) return;

    const l = ensureLayout();

    if (l === 'new') {
      injectNewLayout();
    } else if (l === 'old') {
      // 旧版页面注入：今日消费卡片 / 模型今日行
      if (!isInjectionPresent('cost')) {
        injectTodayCostCard();
      } else {
        updateTodayCostAmount();
      }

      const modelNames = Object.keys(latestPayload.models || {});
      for (const name of modelNames) {
        const marker = 'model-' + name.replace(/[^a-z0-9-]/gi, '_');
        if (!isInjectionPresent(marker)) {
          const yd = (latestPayload.yesterday_models || {})[name];
          injectModelData(name, latestPayload.models[name], yd, marker);
        }
      }
    }

    if (!tooltipObserverSetup) {
      setupTooltipFormatter();
      tooltipObserverSetup = true;
    }
  }

  // ---- 今日消费卡片 ----
  function injectTodayCostCard() {
    // 找到本月消费卡片（确认数据已加载：_7ed1d04 里必须有 ¥ + 数字两个 span）
    const allCards = document.querySelectorAll('[class*="a0cde8c1"]');
    let monthCard = null;
    for (const card of allCards) {
      const titleEl = card.querySelector('[class*="_477051d"]');
      if (titleEl && titleEl.textContent.includes('本月消费')) {
        const valueEl = card.querySelector('[class*="_7ed1d04"]');
        if (valueEl && valueEl.querySelectorAll('span').length >= 2) {
          monthCard = card;
        }
        break;
      }
    }
    if (!monthCard) return;

    // 从原始卡片读取精确的 class 名，从头构建（不用 cloneNode，避免 React 导致子元素丢失）
    const cardClass = monthCard.className;
    const titleClass = monthCard.querySelector('[class*="_477051d"]').className;

    const todayCard = document.createElement('div');
    todayCard.className = cardClass;
    todayCard.setAttribute(INJECT_MARKER, 'cost');

    const titleDiv = document.createElement('div');
    titleDiv.className = titleClass;
    titleDiv.textContent = '今日消费';

    const outerDiv = document.createElement('div');
    outerDiv.className = 'abf3dfef';
    const midDiv = document.createElement('div');
    const bbDiv = document.createElement('div');
    bbDiv.className = '_4bb7bee';

    const v7Div = document.createElement('div');
    v7Div.className = '_7ed1d04';
    const yen = document.createElement('span');
    yen.textContent = '¥';
    const amt = document.createElement('span');
    amt.textContent = (latestPayload.today_cost || {}).amount.toFixed(2);
    v7Div.appendChild(yen);
    v7Div.appendChild(amt);
    bbDiv.appendChild(v7Div);

    const cnyDiv = document.createElement('div');
    cnyDiv.className = '_1ef3557';
    cnyDiv.style.cssText = 'color: rgb(var(--ds-rgb-label-2));';
    cnyDiv.textContent = 'CNY';
    bbDiv.appendChild(cnyDiv);

    midDiv.appendChild(bbDiv);
    outerDiv.appendChild(midDiv);

    todayCard.appendChild(titleDiv);
    todayCard.appendChild(outerDiv);

    monthCard.parentElement.insertBefore(todayCard, monthCard.nextSibling);
  }

  function updateTodayCostAmount() {
    const costCard = document.querySelector('[' + INJECT_MARKER + '="cost"]');
    if (!costCard) return;
    const v7Div = costCard.querySelector('[class*="_7ed1d04"]');
    if (!v7Div) return;
    const spans = v7Div.querySelectorAll('span');
    if (spans.length >= 2) {
      spans[1].textContent = (latestPayload.today_cost || {}).amount.toFixed(2);
    }
  }

  // ---- 模型数据注入 ----
  function injectModelData(modelName, modelMetrics, yesterdayMetrics, marker) {
    // 找到页面上对应的模型名 span
    const modelSpans = document.querySelectorAll('.ds-text.ds-text--monospace');
    let targetSpan = null;
    for (const span of modelSpans) {
      const text = span.textContent.trim();
      const tLower = text.toLowerCase();
      const mLower = modelName.toLowerCase();
      if (tLower.includes(mLower) || mLower.includes(tLower)) {
        targetSpan = span;
        break;
      }
    }
    if (!targetSpan) return;

    // 找到 grid 容器
    const sectionHeader = targetSpan.closest('[class*="_6926780"]') || targetSpan.closest('div');
    let gridContainer = sectionHeader.nextElementSibling;
    while (gridContainer && !gridContainer.querySelector('[class*="columns-2"]')) {
      gridContainer = gridContainer.nextElementSibling;
    }
    if (!gridContainer) return;

    const grid = gridContainer.querySelector('[class*="columns-2"]');
    if (!grid) return;

    const gridItems = grid.querySelectorAll('.ds-grid-item');

    // ---- 列1: 请求次数 ----
    let requestColumn = null;
    for (const item of gridItems) {
      if (item.textContent.includes('API 请求次数') || item.textContent.includes('请求次数')) {
        requestColumn = item;
        break;
      }
    }
    if (requestColumn) {
      injectRequestExtras(requestColumn, modelMetrics.requests,
        yesterdayMetrics ? yesterdayMetrics.requests : 0, marker);
    }

    // ---- 列2: Tokens ----
    let tokenColumn = null;
    for (const item of gridItems) {
      const labels = item.querySelectorAll('.ds-text--lsp');
      for (const lbl of labels) {
        if (lbl.textContent.trim() === 'Tokens') {
          tokenColumn = item;
          break;
        }
      }
      if (tokenColumn) break;
    }
    if (tokenColumn) {
      injectTokenToday(tokenColumn, modelMetrics, marker);
    }
  }

  // 创建一行：label（与 API 请求次数/Tokens 同款）+ value（与数值同款）
  function makeInjectRow(labelText, valueText) {
    const row = document.createElement('div');
    row.className = 'ds-flex';
    row.style.cssText = 'align-items:baseline;gap:12px;';

    const label = document.createElement('span');
    label.className = 'ds-text ds-text--fsp ds-text--lsp';
    label.textContent = labelText;

    const value = document.createElement('span');
    value.className = 'ds-text ds-text--label2';
    value.textContent = valueText;

    row.appendChild(label);
    row.appendChild(value);
    return row;
  }

  function injectRequestExtras(column, todayRequests, yesterdayRequests, marker) {
    // 找到 "API 请求次数" label 的那一行
    const labels = column.querySelectorAll('.ds-text--lsp');
    let labelRow = null;
    for (const lbl of labels) {
      if (lbl.textContent.includes('请求次数')) {
        labelRow = lbl.closest('.ds-flex');
        break;
      }
    }
    if (!labelRow) return;

    const stack = labelRow.parentElement;

    // 昨日请求次数（在今日上方）
    const rowY = makeInjectRow('昨日请求次数', yesterdayRequests.toLocaleString());
    rowY.setAttribute(INJECT_MARKER, marker);
    stack.insertBefore(rowY, labelRow.nextSibling);

    // 今日请求次数
    const rowT = makeInjectRow('今日请求次数', todayRequests.toLocaleString());
    rowT.setAttribute(INJECT_MARKER, marker);
    stack.insertBefore(rowT, rowY.nextSibling);
  }

  function injectTokenToday(column, metrics, marker) {
    // 1. 把 "Tokens" label 改成 "本月总Tokens"
    const labels = column.querySelectorAll('.ds-text--lsp');
    let tokenLabelEl = null;
    for (const lbl of labels) {
      if (lbl.textContent.trim() === 'Tokens') {
        lbl.textContent = '本月总Tokens';
        tokenLabelEl = lbl;
        break;
      }
    }
    if (!tokenLabelEl) return;

    // 找到 token label 那一行 → 垂直 stack
    const tokenRow = tokenLabelEl.closest('.ds-flex');
    if (!tokenRow) return;
    const stack = tokenRow.parentElement;

    // 2. 今日总Tokens
    const totalVal = metrics.tokens ? metrics.tokens.total.toLocaleString() : '0';
    const row1 = makeInjectRow('今日总Tokens', totalVal);
    row1.setAttribute(INJECT_MARKER, marker);

    // 3. 缓存命中率
    const rate = metrics.cache_hit_rate !== null && metrics.cache_hit_rate !== undefined
      ? metrics.cache_hit_rate.toFixed(1) + '%' : '—';
    const row2 = makeInjectRow('今日缓存命中率', rate);
    row2.setAttribute(INJECT_MARKER, marker);

    // 插入到 tokenRow 后面（图表 div 前面）
    let insertAfter = tokenRow;
    stack.insertBefore(row1, insertAfter.nextSibling);
    stack.insertBefore(row2, row1.nextSibling);
  }

  // ---- 图表 tooltip 数字千分位 ----
  function setupTooltipFormatter() {
    const formatNumber = (text) => {
      return text.replace(/\b(\d{4,})\b/g, (_, n) => Number(n).toLocaleString());
    };

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          // 处理任何包含大数字的新增元素（ECharts tooltip 内层 div 也覆盖）
          if (/\d{4,}/.test(node.textContent)) {
            formatTooltipText(node, formatNumber);
            node.querySelectorAll('*').forEach(el => {
              if (!el._dsFormatted && /\d{4,}/.test(el.textContent)) {
                formatTooltipText(el, formatNumber);
              }
            });
          }
        }
        if (m.type === 'characterData' && m.target.parentElement) {
          const el = m.target.parentElement;
          if (!el._dsFormatted && /\d{4,}/.test(el.textContent)) {
            formatTooltipText(el, formatNumber);
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    log('已启用图表数字千分位格式化');
  }

  function formatTooltipText(root, formatter) {
    if (root._dsFormatted) return;
    root._dsFormatted = true;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      const orig = node.textContent;
      const formatted = formatter(orig);
      if (formatted !== orig) {
        node.textContent = formatted;
      }
    }
  }

  // ============================================================
  // 启动
  // ============================================================
  function init() {
    log('DeepSeek Usage Enhancer 已加载');

    let pollFast = true;
    let pollCount = 0;

    function poll() {
      pollCount++;
      tryAllInjections();

      // 初始阶段每 500ms 快速轮询；稳定后降到 3s
      if (pollFast && pollCount > 20) {
        pollFast = false;
      }
      setTimeout(poll, pollFast ? 500 : 3000);
    }

    // 切换标签页回来时，如果注入标记丢失（React 重绘），立即补注
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        pollCount = 0;
        pollFast = true;
        tryAllInjections();
      }
    });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(poll, 800);
      });
    } else {
      setTimeout(poll, 800);
    }
  }

  init();
})();
