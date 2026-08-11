// ==UserScript==
// @name         DeepSeek Daily Monitor
// @namespace    https://github.com/local/deepseek-usage-monitor
// @version      1.4.2
// @description  拦截 DeepSeek 开放平台用量 API（兼容新版 by_api_key 接口），在小窗口中展示完整数据（纯本地，无远程通信）
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

  function safeJSON(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function log(msg) {
    console.log('[DS Monitor] ' + msg);
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

  // ---- 新版平台: 桶的 time 是 Unix 秒, 按本地时区归入"今日" ----
  function localDateOf(unixSec) {
    const d = new Date(unixSec * 1000);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function localToday() {
    return localDateOf(Math.floor(Date.now() / 1000));
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
      // 真实字段名 (2026-07 新版接口实测):
      // usage = { REQUEST, RESPONSE_TOKEN, PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN } (全大写蛇形)
      // 同时兜底 camelCase / snake_case 变体
      const cachedInput = pick('PROMPT_CACHE_HIT_TOKEN', 'promptCacheHitToken', 'prompt_cache_hit_token', 'cached_input_tokens', 'cache_hit_tokens');
      const uncachedInput = pick('PROMPT_CACHE_MISS_TOKEN', 'promptCacheMissToken', 'prompt_cache_miss_token', 'uncached_input_tokens', 'cache_miss_tokens');
      const output = pick('RESPONSE_TOKEN', 'responseToken', 'response_token', 'output_tokens', 'completion_tokens');
      const requests = pick('REQUEST', 'request', 'apiRequests', 'api_requests', 'requests');
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

  // 记录是否属于"今日": 旧版日期(UTC)或新版 Unix 秒(本地时区)
  function isTodayRecord(rec) {
    if (rec.date !== undefined) {
      return rec.date === utcToday() || rec.date === localToday();
    }
    if (rec.time !== undefined) {
      return localDateOf(rec.time) === localToday();
    }
    return true;
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
      balance: {
        total,
        normal_wallet_balance: normalBal,
        bonus_wallet_balance: bonusBal,
        currency,
      },
      monthly_consumption: { amount: monthlyCost, currency },
    };
  }

  function transformUsageAmount(bizData) {
    const models = {};
    const seen = {};

    for (const rec of collectUsageRecords(bizData)) {
      if (!isTodayRecord(rec)) continue;
      const metrics = extractMetricsFromUsageFlexible(rec.usage);
      if (!seen[rec.model]) {
        seen[rec.model] = true;
        models[rec.model] = metrics;
      } else {
        const m = models[rec.model];
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
    }

    return { today_date: localToday(), models };
  }

  function transformUsageCost(bizData) {
    let todayCost = 0;
    const modelCosts = {};
    let currency = bizData.currency || 'CNY';
    if (Array.isArray(bizData.data) && bizData.data[0] && bizData.data[0].currency) {
      currency = bizData.data[0].currency;
    }

    for (const rec of collectCostRecords(bizData)) {
      if (!isTodayRecord(rec)) continue;
      todayCost += rec.cost;
      if (rec.model) modelCosts[rec.model] = (modelCosts[rec.model] || 0) + rec.cost;
    }

    return { today_cost: { amount: Math.floor(todayCost * 100) / 100, currency }, model_costs: modelCosts };
  }

  function buildOutputPayload() {
    const summary = rawUserSummary
      ? transformUserSummary(rawUserSummary)
      : { balance: { total: 0, normal_wallet_balance: 0, bonus_wallet_balance: 0, currency: 'CNY' }, monthly_consumption: { amount: 0, currency: 'CNY' } };

    let usageData = { today_date: utcToday(), models: {} };
    if (rawUsageAmount) {
      usageData = transformUsageAmount(rawUsageAmount);
    }

    let costData = { today_cost: { amount: 0, currency: 'CNY' } };
    if (rawUsageCost) {
      costData = transformUsageCost(rawUsageCost);
    }

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
      updatePanelData(payload);
      updateSummaryBar(payload);
    }
  }

  // ============================================================
  // 格式化数字
  // ============================================================
  function fmtNumShort(n) {
    if (n === undefined || n === null) return '—';
    if (typeof n === 'number') {
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return n.toLocaleString();
    }
    return String(n);
  }

  function fmtNumRaw(n) {
    if (n === undefined || n === null) return '—';
    if (typeof n === 'number') return n.toLocaleString();
    return String(n);
  }

  function makeToggleValue(n) {
    const span = document.createElement('span');
    span.className = 'ds-val-toggle';
    span.setAttribute('data-short', fmtNumShort(n));
    span.setAttribute('data-raw', fmtNumRaw(n));
    span.textContent = fmtNumShort(n);
    span.style.cursor = 'pointer';
    span.title = '点击查看原始数字';
    return span;
  }

  function fmtMoney(n) {
    if (n === undefined || n === null) return '—';
    const val = Math.floor(Number(n) * 100) / 100;
    return '¥' + val.toFixed(2);
  }

  function fmtPercent(n) {
    if (n === undefined || n === null || n === '') return '—';
    return Number(n).toFixed(1) + '%';
  }

  // ============================================================
  // 面板
  // ============================================================
  const PANEL_POS_KEY = 'ds_monitor_panel_pos';

  function loadPanelPos() {
    try {
      const saved = localStorage.getItem(PANEL_POS_KEY);
      if (saved) {
        const pos = JSON.parse(saved);
        // 钳制位置，确保面板在可视区域内
        const w = pos.width || 320;
        const h = 400; // 估算面板高度
        if (pos.left !== null && pos.left !== undefined) {
          pos.left = Math.max(0, Math.min(pos.left, window.innerWidth - 40));
        }
        pos.top = Math.max(0, Math.min(pos.top || 60, window.innerHeight - 60));
        return pos;
      }
    } catch { /* ignore */ }
    return { top: 60, left: null, right: 12, width: 320, collapsed: false };
  }

  function savePanelPos(pos) {
    try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify(pos)); } catch { /* ignore */ }
  }

  let panelPos = loadPanelPos();
  let lastPayload = null;

  function injectPanel() {
    const pos = panelPos;
    const panel = document.createElement('div');
    panel.id = 'ds-monitor-panel';

    let styleLeft = '', styleRight = '';
    if (pos.left !== null && pos.left !== undefined) {
      styleLeft = 'left: ' + pos.left + 'px;';
    } else {
      styleRight = 'right: ' + (pos.right || 12) + 'px;';
    }
    panel.style.cssText = 'top: ' + (pos.top || 60) + 'px;' + styleLeft + styleRight +
      'width: ' + (pos.width || 320) + 'px;';

    panel.innerHTML = `
      <style>
        #ds-monitor-panel {
          position: fixed; z-index: 99999;
          background: rgba(30, 30, 46, 0.92);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 12px;
          font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif;
          font-size: 12px; color: #cdd6f4;
          box-shadow:
            0 12px 40px rgba(0,0,0,0.5),
            0 0 0 0.5px rgba(255,255,255,0.05);
          display: flex; flex-direction: column; overflow: hidden;
          user-select: none; min-width: 280px;
        }
        #ds-monitor-panel.ds-collapsed .ds-body,
        #ds-monitor-panel.ds-collapsed .ds-summary-bar { display: none; }

        .ds-titlebar {
          display: flex; justify-content: space-between; align-items: center;
          padding: 8px 14px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          cursor: move; flex-shrink: 0;
        }
        .ds-titlebar-left { display: flex; align-items: baseline; gap: 4px; }
        .ds-title {
          font-size: 13px; font-weight: 600; color: #e5e5e5;
        }
        .ds-title-models {
          font-size: 11px; color: #6c7086;
          font-family: 'SF Mono', 'Menlo', monospace;
        }
        .ds-titlebar-actions { display: flex; align-items: center; gap: 2px; }
        .ds-btn {
          width: 26px; height: 26px; border: none; background: none;
          color: #6c7086; cursor: pointer; border-radius: 6px;
          display: flex; align-items: center; justify-content: center;
          font-size: 14px; transition: all 0.15s;
        }
        .ds-btn:hover { background: rgba(255,255,255,0.08); color: #cdd6f4; }

        .ds-body {
          padding: 0; flex: 1 1 auto; min-height: 0;
        }

        .ds-account-overview {
          padding: 10px 14px; display: flex; gap: 10px;
        }
        .ds-acct-item { flex: 1; text-align: center; }
        .ds-acct-label {
          font-size: 9px; color: #6c7086; text-transform: uppercase;
          letter-spacing: 0.5px; margin-bottom: 2px;
        }
        .ds-acct-value {
          font-size: 20px; font-weight: 700; color: #cdd6f4;
          font-variant-numeric: tabular-nums; line-height: 1;
        }
        .ds-acct-value.accent {
          background: linear-gradient(135deg, #89b4fa, #a6e3a1);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .ds-acct-unit {
          font-size: 10px; color: #585b70; margin-top: 2px;
        }

        .ds-section-gap {
          height: 1px; background: rgba(255,255,255,0.06);
          margin: 0 14px;
        }

        .ds-model-section { padding: 12px 14px; }
        .ds-model-block {
          background: rgba(0,0,0,0.2); border-radius: 8px;
          padding: 10px 12px; margin-bottom: 8px;
          border: 1px solid rgba(255,255,255,0.04);
        }
        .ds-model-block:last-child { margin-bottom: 0; }

        .ds-model-row {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 8px;
        }
        .ds-model-id {
          font-size: 12px; font-weight: 600;
          font-family: 'SF Mono', 'Menlo', monospace; color: #fab387;
        }
        .ds-model-sep {
          height: 1px; background: rgba(255,255,255,0.04);
          margin-bottom: 8px;
        }

        .ds-metrics {
          display: grid; grid-template-columns: 1fr 1fr 1fr;
          gap: 6px 0;
        }
        .ds-metric {
          display: flex; flex-direction: column; align-items: center;
        }
        .ds-metric-val {
          font-size: 14px; font-weight: 600; color: #cdd6f4;
          font-variant-numeric: tabular-nums; line-height: 1.2;
        }
        .ds-metric-val.green { color: #a6e3a1; }
        .ds-metric-val.yellow { color: #f9e2af; }
        .ds-metric-lbl {
          font-size: 9px; color: #6c7086; margin-top: 2px;
          text-transform: uppercase; letter-spacing: 0.3px;
        }

        .ds-cache-row {
          margin-top: 8px; padding-top: 8px;
          border-top: 1px solid rgba(255,255,255,0.04);
          display: flex; align-items: center; gap: 8px;
        }
        .ds-cache-label {
          font-size: 10px; color: #6c7086; white-space: nowrap;
        }
        .ds-cache-track {
          flex: 1; height: 3px; background: rgba(255,255,255,0.06);
          border-radius: 2px; overflow: hidden;
        }
        .ds-cache-fill {
          height: 100%; border-radius: 2px;
          background: linear-gradient(90deg, #89b4fa, #a6e3a1);
        }
        .ds-cache-pct {
          font-size: 11px; font-weight: 600; color: #a6e3a1;
          min-width: 36px; text-align: right;
          font-variant-numeric: tabular-nums;
        }

        .ds-summary-bar {
          display: flex; align-items: center; justify-content: center;
          gap: 14px; padding: 10px 14px;
          background: rgba(0,0,0,0.2);
          border-top: 1px solid rgba(255,255,255,0.06);
          font-size: 11px; color: #6c7086;
        }
        .ds-sum-val { color: #a6adc8; font-weight: 500; font-variant-numeric: tabular-nums; }
        .ds-summary-dot {
          width: 3px; height: 3px; border-radius: 50%; background: #45475a;
        }

        .ds-no-data { color: #585b70; text-align: center; padding: 20px 0; font-size: 12px; }
        .ds-val-toggle { font-variant-numeric: tabular-nums; }
      </style>
      <div class="ds-titlebar" id="ds-titlebar">
        <div class="ds-titlebar-left">
          <span class="ds-title">Usage Monitor</span>
          <span class="ds-title-models">· DeepSeek</span>
        </div>
        <div class="ds-titlebar-actions">
          <button class="ds-btn" id="ds-collapse-btn" title="收起/展开">${pos.collapsed ? '▶' : '▼'}</button>
        </div>
      </div>
      <div class="ds-body" id="ds-body">
        <div class="ds-account-overview">
          <div class="ds-acct-item">
            <div class="ds-acct-label">余额</div>
            <div class="ds-acct-value" id="ds-balance">—</div>
            <div class="ds-acct-unit">CNY</div>
          </div>
          <div class="ds-acct-item">
            <div class="ds-acct-label">本月消费</div>
            <div class="ds-acct-value" id="ds-monthly-cost">—</div>
            <div class="ds-acct-unit">CNY</div>
          </div>
          <div class="ds-acct-item">
            <div class="ds-acct-label">今日消费</div>
            <div class="ds-acct-value accent" id="ds-today-cost">—</div>
            <div class="ds-acct-unit">CNY</div>
          </div>
        </div>
        <div class="ds-section-gap"></div>
        <div class="ds-model-section" id="ds-model-section">
          <div class="ds-no-data" id="ds-no-data">等待数据…</div>
        </div>
      </div>
      <div class="ds-summary-bar" id="ds-summary-bar" style="display:none;">
        <span>总 Token <span class="ds-sum-val" id="ds-sum-tokens">—</span></span>
        <span class="ds-summary-dot"></span>
        <span>总请求 <span class="ds-sum-val" id="ds-sum-requests">—</span></span>
        <span class="ds-summary-dot"></span>
        <span>命中率 <span class="ds-sum-val" id="ds-sum-hitrate">—</span></span>
      </div>
    `;
    document.body.appendChild(panel);

    if (pos.collapsed) {
      panel.classList.add('ds-collapsed');
    }

    if (lastPayload) {
      updatePanelData(lastPayload);
      updateSummaryBar(lastPayload);
    }

    // --- 拖拽 ---
    const titleBar = document.getElementById('ds-titlebar');
    let dragInfo = null;

    titleBar.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      dragInfo = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
      panel.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragInfo) return;
      const dx = e.clientX - dragInfo.startX;
      const dy = e.clientY - dragInfo.startY;
      panel.style.left = (dragInfo.startLeft + dx) + 'px';
      panel.style.right = 'auto';
      panel.style.top = Math.max(0, dragInfo.startTop + dy) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragInfo) return;
      dragInfo = null;
      panel.style.transition = '';
      const rect = panel.getBoundingClientRect();
      const w = rect.width;
      panelPos.top = Math.max(0, Math.min(rect.top, window.innerHeight - 60));
      panelPos.left = Math.max(-w + 40, Math.min(rect.left, window.innerWidth - 40));
      panelPos.right = null;
      // 应用钳制后的位置
      panel.style.top = panelPos.top + 'px';
      panel.style.left = panelPos.left + 'px';
      savePanelPos(panelPos);
    });

    // --- 折叠/展开 ---
    const collapseBtn = document.getElementById('ds-collapse-btn');
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = panel.classList.toggle('ds-collapsed');
      collapseBtn.textContent = collapsed ? '▶' : '▼';
      panelPos.collapsed = collapsed;
      savePanelPos(panelPos);
    });

    // --- 点击切换原始数字 ---
    panel.addEventListener('click', (e) => {
      const span = e.target.closest('[data-short]');
      if (!span) return;
      const showing = span.textContent === span.getAttribute('data-raw');
      span.textContent = showing
        ? span.getAttribute('data-short')
        : span.getAttribute('data-raw');
    });
  }

  // ============================================================
  // 更新面板数据
  // ============================================================

  function updatePanelData(payload) {
    const modelSection = document.getElementById('ds-model-section');
    const noDataEl = document.getElementById('ds-no-data');
    const todayCostEl = document.getElementById('ds-today-cost');
    const monthlyCostEl = document.getElementById('ds-monthly-cost');
    const balanceEl = document.getElementById('ds-balance');

    if (!modelSection) {
      lastPayload = payload;
      return;
    }

    if (!payload || !payload.timestamp) {
      if (noDataEl) noDataEl.style.display = '';
      return;
    }

    // 账户概览
    const balance = payload.balance || {};
    const monthly = payload.monthly_consumption || {};
    const todayCost = payload.today_cost || {};
    const currency = balance.currency || 'CNY';

    if (todayCostEl) todayCostEl.textContent = fmtMoney(todayCost.amount);
    if (monthlyCostEl) monthlyCostEl.textContent = fmtMoney(monthly.amount);
    if (balanceEl) balanceEl.textContent = fmtMoney(balance.total);

    // 更新单位
    const units = document.querySelectorAll('.ds-acct-unit');
    units.forEach(u => { u.textContent = currency; });

    // 模型数据
    if (noDataEl) noDataEl.style.display = 'none';

    // 清除旧模型块（保留 no-data 元素）
    const existingBlocks = modelSection.querySelectorAll('.ds-model-block');
    existingBlocks.forEach(b => b.remove());

    const models = payload.models || {};
    const modelNames = Object.keys(models);

    if (modelNames.length === 0) {
      if (noDataEl) noDataEl.style.display = '';
      return;
    }

    for (const name of modelNames) {
      const m = models[name];
      const mLower = name.toLowerCase();
      let shortName = name;
      if (mLower.includes('flash')) shortName = 'deepseek-v4-flash';
      else if (mLower.includes('pro')) shortName = 'deepseek-v4-pro';

      const block = document.createElement('div');
      block.className = 'ds-model-block';

      // 模型名
      const modelRow = document.createElement('div');
      modelRow.className = 'ds-model-row';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'ds-model-id';
      nameSpan.textContent = shortName;
      modelRow.appendChild(nameSpan);
      block.appendChild(modelRow);

      // 模型名下方分隔线
      const modelSep = document.createElement('div');
      modelSep.className = 'ds-model-sep';
      block.appendChild(modelSep);

      // 指标网格 — 第1行: Total, Cost, Requests; 第2行: Cached, Uncached, Output
      const metricsGrid = document.createElement('div');
      metricsGrid.className = 'ds-metrics';

      const tokens = m.tokens || {};
      const costVal = m.cost !== undefined ? '¥' + m.cost.toFixed(2) : '—';

      // 行1: Total, Cost, Requests
      metricsGrid.appendChild(makeToggleMetric(tokens.total, 'Total'));
      metricsGrid.appendChild(makeToggleMetric(m.cost, 'Cost', '', true));
      metricsGrid.appendChild(makeToggleMetric(m.requests, 'Requests'));

      // 行2: Cached, Uncached, Output
      metricsGrid.appendChild(makeToggleMetric(tokens.cached_input, 'Cached', 'green'));
      metricsGrid.appendChild(makeToggleMetric(tokens.uncached_input, 'Uncached'));
      metricsGrid.appendChild(makeToggleMetric(tokens.output, 'Output'));

      block.appendChild(metricsGrid);

      // 缓存命中条
      if (m.cache_hit_rate !== null && m.cache_hit_rate !== undefined) {
        const cacheRow = document.createElement('div');
        cacheRow.className = 'ds-cache-row';

        const cacheLabel = document.createElement('span');
        cacheLabel.className = 'ds-cache-label';
        cacheLabel.textContent = 'Cache Hit';

        const cacheTrack = document.createElement('div');
        cacheTrack.className = 'ds-cache-track';
        const cacheFill = document.createElement('div');
        cacheFill.className = 'ds-cache-fill';
        cacheFill.style.width = Math.min(100, Math.max(0, m.cache_hit_rate)) + '%';
        cacheTrack.appendChild(cacheFill);

        const cachePct = document.createElement('span');
        cachePct.className = 'ds-cache-pct';
        cachePct.textContent = fmtPercent(m.cache_hit_rate);

        cacheRow.appendChild(cacheLabel);
        cacheRow.appendChild(cacheTrack);
        cacheRow.appendChild(cachePct);
        block.appendChild(cacheRow);
      }

      modelSection.appendChild(block);
    }
  }

  function makeToggleMetric(n, labelText, extraClass, isMoney) {
    const metric = document.createElement('div');
    metric.className = 'ds-metric';

    const val = document.createElement('span');
    val.className = 'ds-metric-val';
    if (extraClass) val.classList.add(extraClass);

    if (n !== undefined && n !== null && typeof n === 'number') {
      if (isMoney) {
        val.textContent = '¥' + n.toFixed(2);
      } else {
        val.setAttribute('data-short', fmtNumShort(n));
        val.setAttribute('data-raw', fmtNumRaw(n));
        val.textContent = fmtNumShort(n);
        val.style.cursor = 'pointer';
        val.title = '点击查看原始数字';
      }
    } else {
      val.textContent = '—';
    }

    const lbl = document.createElement('span');
    lbl.className = 'ds-metric-lbl';
    lbl.textContent = labelText;

    metric.appendChild(val);
    metric.appendChild(lbl);
    return metric;
  }

  function updateSummaryBar(payload) {
    const bar = document.getElementById('ds-summary-bar');
    const sumTokens = document.getElementById('ds-sum-tokens');
    const sumRequests = document.getElementById('ds-sum-requests');
    const sumHitrate = document.getElementById('ds-sum-hitrate');

    if (!bar || !payload) return;

    const models = payload.models || {};
    const modelNames = Object.keys(models);

    if (modelNames.length === 0) {
      bar.style.display = 'none';
      return;
    }

    bar.style.display = '';

    let totalTokens = 0;
    let totalRequests = 0;
    let totalCached = 0;
    let totalInput = 0;

    for (const name of modelNames) {
      const m = models[name];
      totalRequests += m.requests || 0;
      if (m.tokens) {
        totalTokens += m.tokens.total || 0;
        totalCached += m.tokens.cached_input || 0;
        totalInput += (m.tokens.cached_input || 0) + (m.tokens.uncached_input || 0);
      }
    }

    const overallHitRate = totalInput > 0
      ? Math.round((totalCached / totalInput) * 1000) / 10
      : null;

    if (sumTokens) sumTokens.textContent = fmtNumShort(totalTokens);
    if (sumRequests) sumRequests.textContent = totalRequests.toLocaleString();
    if (sumHitrate) sumHitrate.textContent = overallHitRate !== null ? fmtPercent(overallHitRate) : '—';
  }

  // ============================================================
  // 启动
  // ============================================================
  function init() {
    log('DeepSeek Usage Monitor 已加载（纯本地模式）');

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(injectPanel, 500);
      });
    } else {
      setTimeout(injectPanel, 500);
    }
  }

  init();
})();
