/* ISOLATED world: only public configuration and read-only saved-cache requests. */
(() => {
  'use strict';
  if (location.origin !== 'https://gg-client-r.crave-saga.net' || !/^\/client\/[^/]+\/index_dmm\.html$/.test(location.pathname)) return;
  const APP = Symbol.for('cravesage-translator-mini.bridge.v1');
  const CHANNEL = 'cravesage-translator-mini/v1';
  if (window[APP]) return;
  const MAX_ENTRIES = 5000, MAX_BYTES = 8 * 1024 * 1024;
  const localCache = new Map(), queue = new Map(), flying = new Map();
  let config = {enabled: false, target: '한국어', fontFamily: 'Malgun Gothic', playerName: '', displayName: '', cacheEpoch: ''};
  let ready = false, warming = false, disposed = false, stopped = false, generation = 0, configRequest = 0, sequence = 0;
  let localBytes = 0, queueBytes = 0, lookupTimer = null, activeRequest = null, cacheHits = 0, notice = '', engineStatus = {};
  const send = (type, payload = {}) => window.postMessage({channel: CHANNEL, from: 'bridge', type, ...payload}, location.origin);
  const sourceValid = value => typeof value === 'string' && !!value.trim() && value.length <= 8192;
  const idValid = value => typeof value === 'string' && value.length <= 80 && /^g\d+r\d+$/.test(value);
  const cacheBytes = (source, text) => (source.length + (typeof text === 'string' ? text.length : 0)) * 2;
  function room(bytes, entries = 1) {
    while (localCache.size && (localBytes + queueBytes + bytes > MAX_BYTES || localCache.size + queue.size + flying.size + entries > MAX_ENTRIES)) {
      const source = localCache.keys().next().value;
      localBytes -= cacheBytes(source, localCache.get(source)); localCache.delete(source);
    }
    return localBytes + queueBytes + bytes <= MAX_BYTES && localCache.size + queue.size + flying.size + entries <= MAX_ENTRIES;
  }
  function remember(source, text) {
    if (localCache.has(source)) { localBytes -= cacheBytes(source, localCache.get(source)); localCache.delete(source); }
    const bytes = cacheBytes(source, text); if (!room(bytes)) return;
    localCache.set(source, text); localBytes += bytes;
  }
  function recalled(source) {
    if (!localCache.has(source)) return undefined;
    const text = localCache.get(source); localCache.delete(source); localCache.set(source, text); return text;
  }
  function clear() {
    clearTimeout(lookupTimer); lookupTimer = null; activeRequest = null;
    localCache.clear(); queue.clear(); flying.clear(); localBytes = 0; queueBytes = 0;
  }
  async function runtime(message) {
    const answer = await chrome.runtime.sendMessage(message);
    if (!answer?.ok) throw Error(answer?.error || '확장 프로그램 응답이 없습니다.');
    return answer;
  }
  function cleanConfig(value) {
    if (!value || typeof value.enabled !== 'boolean' || typeof value.target !== 'string' || !value.target.trim() || value.target.length > 64 || typeof value.fontFamily !== 'string' || value.fontFamily.length > 100 || typeof value.cacheEpoch !== 'string' || value.cacheEpoch.length > 128) throw Error('잘못된 공개 설정입니다.');
    const playerName = value.playerName === undefined ? '' : value.playerName, displayName = value.displayName === undefined ? '' : value.displayName;
    if ([playerName, displayName].some(name => typeof name !== 'string' || name.length > 64 || /[<>{}\r\n]/.test(name))) throw Error('잘못된 공개 이름 설정입니다.');
    return {enabled: value.enabled, target: value.target, fontFamily: value.fontFamily, playerName, displayName, cacheEpoch: value.cacheEpoch};
  }
  function publishConfig() { send('CONFIG', {config: {...config, ready: ready && !warming && !stopped}}); }
  function sendChunks(type, name, items) {
    let page = [], chars = 0;
    for (const item of items) {
      const size = (item.source?.length || 0) + (item.text?.length || 0) + (item.id?.length || 0);
      if (page.length && (page.length >= 32 || chars + size > 131072)) {
        send(type, {cacheEpoch: config.cacheEpoch, [name]: page}); page = []; chars = 0;
      }
      page.push(item); chars += size;
    }
    if (page.length) send(type, {cacheEpoch: config.cacheEpoch, [name]: page});
  }
  async function applyConfig(value) {
    const next = cleanConfig(value);
    if (ready && JSON.stringify(next) === JSON.stringify(config)) return;
    const gen = ++generation; config = next; ready = true; warming = config.enabled && !stopped;
    clear(); cacheHits = 0; if (!stopped) notice = '';
    // Invalidate/restore MAIN before any asynchronous IndexedDB warm can finish.
    publishConfig();
    if (config.enabled && !stopped) {
      try {
        const answer = await runtime({type: 'CACHE_WARM'});
        if (disposed || gen !== generation) return;
        if (answer.cacheEpoch !== config.cacheEpoch) return refreshConfig();
        if (!Array.isArray(answer.entries) || answer.entries.length > MAX_ENTRIES) throw Error('잘못된 캐시 예열 응답입니다.');
        for (const entry of answer.entries) {
          if (entry?.target !== config.target || !sourceValid(entry.source) || typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 50000) continue;
          remember(entry.source, entry.text);
        }
        // Send only the bounded retained L1, never cache metadata or privileged routes.
        sendChunks('WARM', 'entries', [...localCache].map(([source, text]) => ({source, text})));
      } catch (error) {
        if (disposed || gen !== generation) return;
        notice = String(error.message || error).slice(0, 300);
      }
    }
    if (disposed || gen !== generation) return;
    warming = false; publishConfig(); schedule();
  }
  async function refreshConfig() {
    const ticket = ++configRequest;
    try {
      const answer = await runtime({type: 'PUBLIC_CONFIG'});
      if (disposed || ticket !== configRequest) return;
      await applyConfig(answer.config);
    } catch (error) {
      if (disposed || ticket !== configRequest) return;
      notice = String(error.message || error).slice(0, 300);
    }
  }
  function schedule() {
    if (lookupTimer || activeRequest || disposed || stopped || warming || !ready || !config.enabled || !queue.size) return;
    lookupTimer = setTimeout(() => { lookupTimer = null; flush(); }, 8);
  }
  function lookup(item) {
    const text = recalled(item.source);
    if (text !== undefined) {
      if (text !== null) cacheHits++;
      sendChunks('RESULT', 'results', [text === null ? {id: item.id, missing: true} : {id: item.id, text, cached: true}]); return;
    }
    const existing = queue.get(item.source) || flying.get(item.source);
    if (existing) {
      if (!existing.ids.has(item.id)) {
        if (existing.ids.size >= 32 || !room(item.id.length * 2, 0)) { sendChunks('RESULT', 'results', [{id: item.id, missing: true}]); return; }
        existing.ids.add(item.id); existing.bytes += item.id.length * 2; queueBytes += item.id.length * 2;
      }
      return;
    }
    const bytes = (item.source.length + item.context.length + item.id.length) * 2;
    if (!room(bytes)) { sendChunks('RESULT', 'results', [{id: item.id, missing: true}]); return; }
    queue.set(item.source, {source: item.source, context: item.context, ids: new Set([item.id]), bytes}); queueBytes += bytes; schedule();
  }
  async function flush() {
    if (activeRequest || disposed || stopped || warming || !config.enabled || !queue.size) return;
    const token = {generation}, groups = []; let chars = 0;
    for (const [source, group] of queue) {
      if (groups.length >= 32 || chars + source.length > 131072) break;
      queue.delete(source); group.id = 'c' + (++sequence); groups.push(group); chars += source.length; flying.set(source, group);
    }
    if (!groups.length) return;
    activeRequest = token;
    try {
      const answer = await runtime({type: 'CACHE_LOOKUP', items: groups.map(group => ({id: group.id, source: group.source, context: group.context}))});
      if (disposed || stopped || token.generation !== generation) return;
      if (answer.cacheEpoch !== config.cacheEpoch) { await refreshConfig(); return; }
      if (!Array.isArray(answer.results) || answer.results.length > 32) throw Error('잘못된 캐시 조회 응답입니다.');
      const results = new Map();
      for (const result of answer.results) {
        if (!result || typeof result.id !== 'string' || result.id.length > 80 || (result.missing !== true && (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 50000))) throw Error('잘못된 캐시 조회 항목입니다.');
        results.set(result.id, result);
      }
      const outgoing = [];
      for (const group of groups) {
        if (flying.get(group.source) !== group) continue;
        flying.delete(group.source); queueBytes -= group.bytes;
        const result = results.get(group.id), text = typeof result?.text === 'string' && result.missing !== true ? result.text : null;
        remember(group.source, text);
        if (text !== null) cacheHits += group.ids.size;
        for (const id of group.ids) outgoing.push(text === null ? {id, missing: true} : {id, text, cached: true});
      }
      sendChunks('RESULT', 'results', outgoing);
    } catch (error) {
      if (!disposed && !stopped && token.generation === generation) {
        notice = String(error.message || error).slice(0, 300);
        const outgoing = [];
        for (const group of groups) {
          if (flying.get(group.source) !== group) continue;
          flying.delete(group.source); queueBytes -= group.bytes;
          remember(group.source, null);
          for (const id of group.ids) outgoing.push({id, missing: true});
        }
        sendChunks('RESULT', 'results', outgoing);
      }
    } finally {
      if (activeRequest === token) { activeRequest = null; schedule(); }
    }
  }
  function onPageMessage(event) {
    if (disposed || event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.from !== 'engine') return;
    if (message.type === 'HELLO') { publishConfig(); return; }
    if (message.type === 'DISPOSED') { dispose(false); return; }
    if (message.type === 'ERROR') {
      if (typeof message.error !== 'string' || message.error.length > 1000) return;
      stopped = true; notice = message.error; clear(); return;
    }
    if (message.type === 'STATUS') {
      const value = message.status;
      if (!value || typeof value !== 'object') return;
      const next = {};
      for (const key of ['ready', 'enabled', 'warming', 'stopped', 'disposed']) if (typeof value[key] === 'boolean') next[key] = value[key];
      for (const key of ['visible', 'translated', 'missing', 'waiting', 'tracked', 'entries', 'memoryBytes', 'cacheEntries']) if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 100000000) next[key] = value[key];
      if (typeof value.cacheEpoch === 'string' && value.cacheEpoch.length <= 128) next.cacheEpoch = value.cacheEpoch;
      if (typeof value.error === 'string' && value.error.length <= 1000) next.error = value.error;
      engineStatus = next; return;
    }
    if (message.type !== 'LOOKUP' || !ready || warming || stopped || !config.enabled || message.cacheEpoch !== config.cacheEpoch) return;
    const item = message.item;
    if (!item || !idValid(item.id) || !sourceValid(item.source) || typeof item.context !== 'string' || item.context.length > 300) return;
    lookup({id: item.id, source: item.source, context: item.context});
  }
  function status() {
    return {status: {...engineStatus}, notice, cacheHits, queued: queue.size + flying.size, warming,
      cacheEntries: localCache.size, entries: localCache.size + queue.size + flying.size, memoryBytes: localBytes + queueBytes,
      cacheEpoch: config.cacheEpoch, stopped, disposed};
  }
  function onRuntimeMessage(message, sender, reply) {
    if (disposed || sender?.id !== chrome.runtime.id) return;
    if (message?.type === 'PUBLIC_CONFIG_CHANGED') {
      configRequest++;
      applyConfig(message.config).catch(error => { notice = String(error.message || error).slice(0, 300); });
    }
    if (message?.type === 'GET_ENGINE_STATUS') reply({ok: true, ...status()});
  }
  function pagehide(event) { if (!event.persisted) dispose(); }
  function dispose(notify = true) {
    if (disposed) return;
    disposed = true; generation++; configRequest++; clear();
    if (notify) send('DISPOSE');
    window.removeEventListener('message', onPageMessage); window.removeEventListener('pagehide', pagehide);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage); delete window[APP];
  }
  window[APP] = Object.freeze({status, dispose});
  window.addEventListener('message', onPageMessage); window.addEventListener('pagehide', pagehide);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  refreshConfig();
})();
