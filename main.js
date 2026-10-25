/* MAIN world: cache-only Cocos display adapter; no extension APIs or network. */
(() => {
  'use strict';
  if (location.origin !== 'https://gg-client-r.crave-saga.net' || !/^\/client\/[^/]+\/index_dmm\.html$/.test(location.pathname)) return;
  const APP = Symbol.for('cravesage-translator-mini.v1');
  const FULL = Symbol.for('crave-ai-translator.v1');
  const CHANNEL = 'cravesage-translator-mini/v1';
  if (window[APP]) return;
  const namesPolicy = globalThis[Symbol.for('cravesage-translator-mini.names.v1')];
  const MAX_ENTRIES = 5000, MAX_BYTES = 8 * 1024 * 1024;
  const records = new Map(), bySource = new Map(), memory = new Map(), pending = new Map(), requests = new Map();
  const hooks = [], engineEvents = [];
  let config = {enabled: false, target: '한국어', fontFamily: 'Malgun Gothic', playerName: '', displayName: '', cacheEpoch: '', ready: false};
  let playerNames = [], nameSource = 'none';
  let engine = null, busy = false, stopped = false, disposed = false, error = '', generation = 0, sequence = 0;
  let memoryBytes = 0, recordBytes = 0, pendingBytes = 0, heartbeat = null, lightTimer = null, burstTimer = null;
  let lastScan = 0, lastLight = 0, burstUntil = 0, attachAttempts = 0;
  const styleKeys = ['font', 'fontFamily', 'useSystemFont', 'fontSize', 'lineHeight', 'cacheMode', 'enableWrapText', 'overflow'];
  const emit = (type, payload = {}) => window.postMessage({channel: CHANNEL, from: 'engine', type, ...payload}, location.origin);
  const valid = value => !!value && (!engine?.isValid || engine.isValid(value));
  const active = label => valid(label) && label.node?.activeInHierarchy !== false;
  const candidate = value => typeof value === 'string' && value.length <= 8192 && !!value.trim();
  const entryBytes = (source, text) => (source.length + (typeof text === 'string' ? text.length : 0)) * 2;
  function room(bytes, entries = 1) {
    while (memory.size && (recordBytes + memoryBytes + pendingBytes + bytes > MAX_BYTES || records.size + memory.size + pending.size + entries > MAX_ENTRIES)) {
      const source = memory.keys().next().value;
      memoryBytes -= entryBytes(source, memory.get(source));
      memory.delete(source);
    }
    return recordBytes + memoryBytes + pendingBytes + bytes <= MAX_BYTES && records.size + memory.size + pending.size + entries <= MAX_ENTRIES;
  }
  function remember(source, text) {
    if (memory.has(source)) { memoryBytes -= entryBytes(source, memory.get(source)); memory.delete(source); }
    const bytes = entryBytes(source, text);
    if (!room(bytes)) return;
    memory.set(source, text); memoryBytes += bytes;
  }
  function recalled(source) {
    if (!memory.has(source)) return undefined;
    const text = memory.get(source); memory.delete(source); memory.set(source, text); return text;
  }
  function clearMemory() { memory.clear(); memoryBytes = 0; pendingBytes = 0; pending.clear(); requests.clear(); }
  function resetTranslations() {
    generation++; restoreAll(); clearMemory();
    for (const record of records.values()) { record.checked = false; record.missing = false; }
  }
  function readNames() {
    const names = [];
    let source = 'none';
    if (config.playerName.trim()) { names.push(config.playerName); source = 'override'; }
    else {
      try {
        const utils = typeof window.__require === 'function' && window.__require('UserUtils');
        const profile = typeof utils?.getUserBasicData === 'function' && utils.getUserBasicData();
        for (const [method, kind] of [['getMainCharacterName', 'mainCharacterName'], ['getUserName', 'userName']]) {
          try {
            const name = typeof profile?.[method] === 'function' && profile[method]();
            if (typeof name === 'string' && name.trim() && name.length <= 64 && !names.includes(name)) {
              names.push(name); if (source === 'none') source = kind;
            }
          } catch {}
        }
      } catch {}
    }
    const changed = names.length !== playerNames.length || names.some((name, index) => name !== playerNames[index]);
    playerNames = names; nameSource = source;
    if (changed) resetTranslations();
  }
  function choices(record) {
    const alternatives = namesPolicy.candidates(record.raw, playerNames);
    const name = record.raw.includes(namesPolicy.TOKEN) ? playerNames[0] : alternatives[0]?.name;
    return [{source: record.raw, name}, ...alternatives];
  }
  function safeType(label) { return label instanceof engine.Label || label instanceof engine.RichText; }
  function richChild(label) {
    if (!(label instanceof engine.Label)) return false;
    let node = label.node, depth = 0;
    while (node && depth++ < 40) {
      if ((node._components || []).some(component => component !== label && component instanceof engine.RichText)) return true;
      node = node.parent;
    }
    return false;
  }
  function hook(label) { return hooks.find(item => item.proto.isPrototypeOf(label)); }
  function actual(label) { const item = hook(label); return item ? item.before.get.call(label) : label.string; }
  function nativeSet(label, value) { const item = hook(label); if (!item) throw Error('Unsupported Cocos text accessor'); return item.before.set.call(label, value); }
  function restoreStyle(label, record) {
    if (!record.style) return;
    for (const [key, value] of Object.entries(record.style)) if (label[key] !== value) label[key] = value;
    record.style = null;
  }
  function display(label, record, text) {
    const extra = (text.length - record.display.length) * 2;
    if (extra > 0 && !room(extra, 0)) text = record.raw;
    const previousBusy = busy; busy = true;
    try {
      if (text !== record.raw && config.fontFamily.trim() && !record.style) {
        record.style = {};
        for (const key of styleKeys) if (key in label) record.style[key] = label[key];
      }
      if (text !== record.raw && config.fontFamily.trim()) {
        for (const [key, value] of Object.entries({font: null, useSystemFont: true, fontFamily: config.fontFamily, cacheMode: 0})) {
          if (key in label && label[key] !== value) label[key] = value;
        }
      } else restoreStyle(label, record);
      if (actual(label) !== text) nativeSet(label, text);
      recordBytes += (text.length - record.display.length) * 2;
      record.display = text;
    } finally { busy = previousBusy; }
  }
  function unindex(label, record) {
    const labels = bySource.get(record.raw); labels?.delete(label);
    if (!labels?.size) bySource.delete(record.raw);
  }
  function index(label, record) {
    let labels = bySource.get(record.raw);
    if (!labels) bySource.set(record.raw, labels = new Set());
    labels.add(label);
  }
  function forget(label, record, restore = false) {
    if (restore && valid(label)) restoreRecord(label, record);
    if (!records.has(label)) return;
    unindex(label, record); records.delete(label); recordBytes -= entryBytes(record.raw, record.display);
  }
  function restoreRecord(label, record) {
    // A native game write that bypassed our setter is newer than our last display.
    const current = actual(label);
    if (typeof current === 'string' && current !== record.display) {
      const previousBusy = busy; busy = true;
      try { restoreStyle(label, record); } finally { busy = previousBusy; }
      forget(label, record);
      return;
    }
    display(label, record, record.raw);
  }
  function restoreAll() { for (const [label, record] of records) if (valid(label)) restoreRecord(label, record); }
  function context(label) {
    const names = []; let node = label.node, depth = 0;
    while (node && depth++ < 5) {
      for (const component of node._components || []) {
        const name = engine.js?.getClassName?.(component);
        if (name && name !== 'cc.Label' && name !== 'cc.RichText') names.push(String(name).slice(0, 55));
      }
      node = node.parent;
    }
    return [...new Set(names)].slice(0, 5).join(' / ').slice(0, 280);
  }
  function ask(label, record, response = null) {
    if (!config.enabled || !config.ready || stopped || !active(label) || richChild(label) || !candidate(record.raw) || record.checked) return;
    for (const choice of choices(record)) {
      const text = response?.source === choice.source ? response.text : recalled(choice.source);
      if (text !== undefined) {
        if (text === null) continue;
        const rendered = namesPolicy.render(text, config.displayName.trim() ? config.displayName : choice.name);
        if (rendered === null) continue;
        record.checked = true; record.missing = false; display(label, record, rendered); return;
      }
      const existing = pending.get(choice.source);
      if (existing) { existing.bindings.set(record.raw, choice.name); return; }
      if (!room(entryBytes(choice.source, null))) { record.checked = true; record.missing = true; return; }
      const id = 'g' + generation + 'r' + (++sequence);
      const request = {id, source: choice.source, generation, bindings: new Map([[record.raw, choice.name]])};
      pending.set(choice.source, request); requests.set(id, request);
      pendingBytes += entryBytes(choice.source, null);
      emit('LOOKUP', {cacheEpoch: config.cacheEpoch, item: {id, source: choice.source, context: context(label)}});
      return;
    }
    record.checked = true; record.missing = true;
  }
  function update(label, value, preserve = false) {
    if (!safeType(label) || richChild(label)) return nativeSet(label, value);
    let raw = typeof value === 'string' ? value : String(value);
    let record = records.get(label);
    if (record && raw === record.display && raw !== record.raw) { raw = record.raw; preserve = true; }
    if (!record) {
      if (raw.length > 8192 || !room(raw.length * 4)) return nativeSet(label, value);
      record = {raw, display: raw, style: null, checked: false, missing: false, wasActive: active(label)};
      records.set(label, record); recordBytes += raw.length * 4; index(label, record);
    } else if (raw !== record.raw) {
      // Restore the original font before a new dialogue takes ownership of this component.
      const previousBusy = busy; busy = true;
      try { restoreStyle(label, record); } finally { busy = previousBusy; }
      if (raw.length > 8192 || !room(Math.max(0, raw.length * 4 - entryBytes(record.raw, record.display)), 0)) {
        forget(label, record); return nativeSet(label, value);
      }
      unindex(label, record); recordBytes += (raw.length - record.raw.length) * 2;
      record.raw = raw; record.checked = false; record.missing = false; index(label, record); preserve = false;
    }
    if (config.enabled && config.ready && record.checked && !record.missing && record.display !== raw) display(label, record, record.display);
    else if (!preserve) display(label, record, raw);
    ask(label, record);
  }
  function status() {
    let visible = 0, translated = 0, missing = 0;
    for (const [label, record] of records) if (active(label) && !richChild(label)) {
      visible++; if (record.raw !== record.display) translated++; if (record.missing) missing++;
    }
    return {ready: !!engine, enabled: config.enabled, warming: !config.ready, stopped, disposed, error, visible, translated, missing,
      waiting: pending.size, tracked: records.size, entries: records.size + memory.size + pending.size,
      memoryBytes: recordBytes + memoryBytes + pendingBytes, cacheEntries: memory.size, cacheEpoch: config.cacheEpoch,
      nameReady: playerNames.length > 0, nameSource};
  }
  function report() { emit('STATUS', {status: status()}); }
  function fail(message) {
    if (stopped || disposed) return;
    stopped = true; error = message;
    try { restoreAll(); } catch {}
    clearMemory(); emit('ERROR', {error: message}); report();
  }
  function conflict() {
    if (window[FULL] || document.getElementById('crave-korean-toggle')) { fail('다른 전체 번역/한글패치 확장과 함께 실행할 수 없습니다. 확장을 하나만 켠 뒤 게임을 새로고침하세요.'); return true; }
    if (hooks.some(item => Object.getOwnPropertyDescriptor(item.proto, 'string')?.set !== item.set)) {
      fail('다른 확장이 Cocos 텍스트 접근자를 변경했습니다. 확장을 하나만 켠 뒤 게임을 새로고침하세요.'); return true;
    }
    return false;
  }
  function attach() {
    const cc = window.cc;
    if (!cc?.Label || !cc.RichText || !cc.director?.getScene) return false;
    const candidates = [];
    for (const Type of [cc.RichText, cc.Label]) {
      let proto = Type.prototype;
      while (proto && !Object.getOwnPropertyDescriptor(proto, 'string')) proto = Object.getPrototypeOf(proto);
      const before = proto && Object.getOwnPropertyDescriptor(proto, 'string');
      if (!before?.get || !before?.set || !before.configurable) throw Error('Unsupported Cocos text accessor');
      if (!candidates.some(item => item.proto === proto)) candidates.push({proto, before});
    }
    engine = cc;
    for (const item of candidates) {
      item.set = function (value) {
        if (busy || stopped || disposed) return item.before.set.call(this, value);
        try { return update(this, value); }
        catch { fail('게임 텍스트 처리와 호환되지 않아 원문을 유지합니다.'); return item.before.set.call(this, value); }
      };
      Object.defineProperty(item.proto, 'string', {...item.before, set: item.set}); hooks.push(item);
    }
    if (typeof cc.director.on === 'function' && typeof cc.director.off === 'function') {
      const D = cc.Director || {};
      for (const event of new Set([D.EVENT_AFTER_UPDATE, D.EVENT_BEFORE_DRAW].filter(Boolean))) {
        cc.director.on(event, scheduleLight); engineEvents.push([event, scheduleLight]);
      }
      if (D.EVENT_AFTER_SCENE_LAUNCH) { cc.director.on(D.EVENT_AFTER_SCENE_LAUNCH, inputBurst); engineEvents.push([D.EVENT_AFTER_SCENE_LAUNCH, inputBurst]); }
    }
    return true;
  }
  function lightCheck() {
    if (disposed || stopped || document.hidden || !engine || !config.enabled || !config.ready) return;
    lastLight = Date.now();
    try {
      if (conflict()) return;
      for (const [label, record] of records) {
        if (!valid(label)) { forget(label, record); continue; }
        if (richChild(label)) { forget(label, record, true); continue; }
        const on = active(label);
        if (on) { const current = actual(label); if (!record.wasActive || current !== record.display) update(label, current === record.display ? record.raw : current, current === record.display); }
        record.wasActive = on;
      }
    } catch { fail('게임 엔진 구조와 호환되지 않아 원문을 유지합니다.'); }
  }
  function scheduleLight() {
    if (lightTimer || disposed || stopped || document.hidden || !config.enabled) return;
    lightTimer = setTimeout(() => { lightTimer = null; lightCheck(); }, Math.max(0, 64 - (Date.now() - lastLight)));
  }
  function refresh() {
    if (disposed || stopped || document.hidden) return;
    try {
      if (conflict()) return;
      if (!engine && !attach()) { report(); return; }
      readNames();
      if (!config.enabled || !config.ready) { report(); return; }
      lastScan = Date.now();
      const scene = engine.director.getScene();
      if (!scene) { report(); return; }
      const seen = new Set(), stack = [scene]; let count = 0;
      while (stack.length) {
        const node = stack.pop(); if (!valid(node)) continue;
        if (++count > 30000 || stack.length > 30000) { fail('게임 화면 구조가 너무 커서 캐시 적용을 중단했습니다.'); return; }
        for (const label of node._components || []) if (safeType(label) && !richChild(label)) {
          const record = records.get(label), current = actual(label);
          update(label, record && current === record.display ? record.raw : current, !!record && current === record.display);
          const next = records.get(label); if (next) { seen.add(label); next.wasActive = active(label); }
        }
        for (const child of node.children || []) {
          if (stack.length >= 30000) { fail('게임 화면 구조가 너무 커서 캐시 적용을 중단했습니다.'); return; }
          stack.push(child);
        }
      }
      for (const [label, record] of records) if (!seen.has(label)) forget(label, record, true);
      report();
    } catch { fail('게임 엔진 구조와 호환되지 않아 원문을 유지합니다.'); }
  }
  function inputBurst() {
    if (disposed || stopped || document.hidden || !config.enabled) return;
    burstUntil = Date.now() + 480;
    if (burstTimer) return;
    const run = () => { burstTimer = null; if (disposed || stopped || document.hidden || !config.enabled) return; refresh(); if (Date.now() < burstUntil) burstTimer = setTimeout(run, 160); };
    burstTimer = setTimeout(run, Math.max(16, 120 - (Date.now() - lastScan)));
  }
  function tick() {
    heartbeat = null; if (disposed) return;
    if (!stopped) {
      if (!engine) { attachAttempts++; refresh(); }
      else if (!document.hidden) { if (conflict()) return; if (config.enabled) { lightCheck(); if (Date.now() - lastScan >= 650) refresh(); } }
    }
    heartbeat = setTimeout(tick, engine ? (config.enabled && !document.hidden && !stopped ? 64 : 750) : (attachAttempts < 30 ? 100 : 1000));
  }
  function onMessage(event) {
    if (disposed || event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.from !== 'bridge') return;
    if (message.type === 'DISPOSE') { dispose(); return; }
    if (message.type === 'CONFIG') {
      const next = message.config;
      if (!next || typeof next.enabled !== 'boolean' || typeof next.target !== 'string' || !next.target.trim() || next.target.length > 64 || typeof next.fontFamily !== 'string' || next.fontFamily.length > 100 || typeof next.cacheEpoch !== 'string' || next.cacheEpoch.length > 128 || typeof next.ready !== 'boolean') return;
      const playerName = next.playerName === undefined ? '' : next.playerName;
      const displayName = next.displayName === undefined ? '' : next.displayName;
      if ([playerName, displayName].some(name => typeof name !== 'string' || name.length > 64 || /[<>{}\r\n]/.test(name))) return;
      const changed = config.cacheEpoch !== next.cacheEpoch || config.target !== next.target || config.enabled !== next.enabled || config.fontFamily !== next.fontFamily || config.playerName !== playerName || config.displayName !== displayName;
      if (changed) resetTranslations();
      config = {enabled: next.enabled, target: next.target, fontFamily: next.fontFamily, playerName, displayName, cacheEpoch: next.cacheEpoch, ready: next.ready};
      refresh(); return;
    }
    if (stopped || message.cacheEpoch !== config.cacheEpoch) return;
    if (message.type === 'WARM') {
      if (!Array.isArray(message.entries) || message.entries.length > 32) return;
      let size = 0;
      for (const item of message.entries) {
        if (!item || !candidate(item.source) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 50000) return;
        size += item.source.length + item.text.length; if (size > 131072) return;
      }
      for (const item of message.entries) remember(item.source, item.text);
      return;
    }
    if (message.type !== 'RESULT' || !config.enabled || !config.ready || !Array.isArray(message.results) || message.results.length > 32) return;
    let size = 0;
    for (const result of message.results) {
      if (!result || typeof result.id !== 'string' || result.id.length > 80 || (result.missing !== true && (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 50000))) return;
      size += result.id.length + (typeof result.text === 'string' ? result.text.length : 0); if (size > 131072) return;
    }
    for (const result of message.results) {
      const request = requests.get(result.id); if (!request || request.generation !== generation) continue;
      requests.delete(result.id);
      if (pending.get(request.source) === request) {
        pending.delete(request.source); pendingBytes -= entryBytes(request.source, null);
      }
      request.text = result.missing === true ? null : result.text;
      remember(request.source, request.text);
      for (const [raw, name] of request.bindings) {
        for (const label of bySource.get(raw) || []) {
          const record = records.get(label); if (!record || !valid(label)) continue;
          if (!choices(record).some(choice => choice.source === request.source && choice.name === name)) continue;
          const current = actual(label);
          if (current !== record.display && current !== record.raw) { update(label, current); continue; }
          ask(label, record, request);
        }
      }
    }
    report();
  }
  function visibility() { if (!disposed && !document.hidden) { refresh(); clearTimeout(heartbeat); heartbeat = setTimeout(tick, 64); } }
  function pagehide(event) { if (!event.persisted) dispose(); }
  function dispose() {
    if (disposed) return;
    disposed = true; clearTimeout(heartbeat); clearTimeout(lightTimer); clearTimeout(burstTimer);
    try { restoreAll(); } catch {}
    for (const [event, fn] of engineEvents) try { engine.director.off(event, fn); } catch {}
    for (const item of hooks) if (Object.getOwnPropertyDescriptor(item.proto, 'string')?.set === item.set) Object.defineProperty(item.proto, 'string', item.before);
    document.removeEventListener('visibilitychange', visibility); window.removeEventListener('message', onMessage); window.removeEventListener('pagehide', pagehide);
    for (const event of ['pointerup', 'touchend', 'keyup']) window.removeEventListener(event, inputBurst);
    records.clear(); bySource.clear(); recordBytes = 0; clearMemory(); emit('DISPOSED'); delete window[APP];
  }
  window[APP] = Object.freeze({refresh, status, dispose});
  document.addEventListener('visibilitychange', visibility); window.addEventListener('message', onMessage); window.addEventListener('pagehide', pagehide);
  for (const event of ['pointerup', 'touchend', 'keyup']) window.addEventListener(event, inputBurst, {passive: true});
  emit('HELLO'); refresh(); heartbeat = setTimeout(tick, engine ? 64 : 100);
})();
