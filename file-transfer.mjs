import {normalizeCacheHeader} from './cache.mjs';

export const MAX_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_BATCH_ENTRIES = 1000;
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const format = 'crave-ai-translation-cache';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = value => encoder.encode(value).byteLength;
const abortError = () => new DOMException('작업을 취소했습니다.', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };


function portableEntry(entry) {
  const required = ['id', 'source', 'context', 'target', 'text', 'createdAt', 'updatedAt'];
  if (!plain(entry) || !required.every(key => Object.hasOwn(entry, key))) throw new Error('캐시 항목의 필수 필드가 없습니다.');
  return Object.fromEntries([...required, ...(Object.hasOwn(entry, 'manual') ? ['manual'] : [])].map(key => [key, entry[key]]));
}

async function importJson(file, send, options) {
  if (file.size > MAX_JSON_BYTES) throw new Error('전체 JSON 파일은 32 MiB 이하만 가능합니다. 큰 캐시는 NDJSON을 사용하세요.');
  checkAbort(options.signal);
  const buffer = await file.arrayBuffer();
  checkAbort(options.signal);
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer)); }
  catch { throw new Error('올바른 UTF-8 JSON 파일이 아닙니다. 기존 캐시는 변경하지 않았습니다.'); }
  if (!plain(data) || data.format !== format || ![1, 2, 3].includes(data.version) || !Array.isArray(data.entries)) throw new Error('지원하는 캐시 JSON v1/v2/v3 파일이 아닙니다.');
  options.onProgress?.('JSON 검증 후 한 번에 반영 중 · 팝업을 열어 두세요');
  checkAbort(options.signal);
  return send('IMPORT_CACHE', {data, mode: options.mode, conflictPolicy: options.conflictPolicy, confirmed: options.confirmed === true});
}

/** Whole JSON is bounded; NDJSON is validated and staged without retaining the cache. */
export async function importCacheFile(file, send, {mode = 'merge', conflictPolicy = 'keep-local', confirmed = false, signal, onProgress = () => {}} = {}) {
  if (!file || typeof file.stream !== 'function' || !['merge', 'replace'].includes(mode) || !['keep-local', 'use-incoming'].includes(conflictPolicy)) throw new Error('가져올 파일과 처리 방식을 확인하세요.');
  if (mode === 'replace' && !confirmed) throw new Error('전체 교체 확인이 필요합니다.');
  checkAbort(signal);
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const isNdjson = /\.(ndjson|jsonl)$/i.test(file.name || '');
  let buffer = '', token = null, header = null, footer = null, count = 0, readBytes = 0, batch = [], batchBytes = 0, legacy = false;
  const envelopeBytes = () => bytes(JSON.stringify({type: 'IMPORT_BATCH', token, entries: []}));
  const cancelReader = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancelReader, {once: true});
  async function flush() {
    if (!batch.length) return;
    checkAbort(signal);
    await send('IMPORT_BATCH', {token, entries: batch});
    checkAbort(signal);
    batch = [];
    batchBytes = envelopeBytes();
    onProgress(`검증·임시 저장 ${count.toLocaleString('ko-KR')}개 · ${Math.min(100, Math.floor(readBytes / Math.max(file.size, 1) * 100))}% · 기존 캐시는 아직 유지`);
  }
  async function line(text) {
    if (!text.trim()) return;
    if (!header && !isNdjson && text.length > 65536) { legacy = true; return; }
    if (bytes(text) > MAX_LINE_BYTES) throw new Error('NDJSON 한 줄은 UTF-8 1 MiB 이하여야 합니다.');
    let value;
    try { value = JSON.parse(text); }
    catch {
      if (!header && !isNdjson) { legacy = true; return; }
      throw new Error('NDJSON 줄의 JSON 문법이 올바르지 않습니다.');
    }
    if (!header) {
      if (!isNdjson && plain(value) && Array.isArray(value.entries)) { legacy = true; return; }
      header = normalizeCacheHeader(value, {stream: true});
      const started = await send('IMPORT_START', {mode, conflictPolicy, confirmed});
      token = started.token;
      if (typeof token !== 'string' || !token) throw new Error('임시 가져오기 작업을 시작하지 못했습니다.');
      batchBytes = envelopeBytes();
      checkAbort(signal);
      return;
    }
    if (footer) throw new Error('NDJSON 종료 표시 뒤에 추가 데이터가 있습니다.');
    if (plain(value) && Object.hasOwn(value, 'end')) {
      if (Object.keys(value).length !== 2 || value.end !== true || !Number.isSafeInteger(value.count) || value.count < 0 || value.count !== count) throw new Error('NDJSON 종료 표시 또는 항목 개수가 일치하지 않습니다.');
      footer = value;
      return;
    }
    // Do not strip unsupported fields: the backend must reject malformed imports.
    if (!plain(value)) throw new Error('NDJSON 항목은 객체여야 합니다.');
    const size = bytes(JSON.stringify(value)) + 1;
    if (size + envelopeBytes() > MAX_BATCH_BYTES) throw new Error('캐시 항목 하나가 8 MiB 전송 한도를 초과합니다.');
    if (batch.length && (batch.length >= MAX_BATCH_ENTRIES || batchBytes + size > MAX_BATCH_BYTES)) await flush();
    batch.push(value);
    batchBytes += size;
    count++;
    if (!Number.isSafeInteger(count)) throw new Error('캐시 항목 개수가 너무 큽니다.');
    if (batch.length === MAX_BATCH_ENTRIES) await flush();
  }
  try {
    while (!legacy) {
      checkAbort(signal);
      const part = await reader.read();
      checkAbort(signal);
      if (part.done) { buffer += decoder.decode(); break; }
      readBytes += part.value.byteLength;
      buffer += decoder.decode(part.value, {stream: true});
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const text = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        await line(text);
        if (legacy) break;
      }
      // Pretty-printed or single-line whole JSON is read separately, only under 32 MiB.
      if (!header && !isNdjson && buffer.length > 65536) { legacy = true; break; }
      if (buffer.length > MAX_LINE_BYTES) throw new Error('NDJSON 한 줄이 너무 큽니다.');
    }
    if (!legacy && buffer.trim()) await line(buffer.replace(/\r$/, ''));
    if (legacy) {
      await reader.cancel();
      return await importJson(file, send, {mode, conflictPolicy, confirmed, signal, onProgress});
    }
    if (!header || !footer) throw new Error('NDJSON 헤더 또는 종료 표시가 없습니다. 잘리거나 미완료된 파일입니다. 기존 캐시는 유지됩니다.');
    await flush();
    checkAbort(signal);
    onProgress(`검증 완료 · ${count.toLocaleString('ko-KR')}개를 한 번에 반영 중`);
    const result = await send('IMPORT_COMMIT', {token, header, expectedCount: footer.count});
    token = null;
    return result;
  } finally {
    if (token) { try { await send('IMPORT_ABORT', {token}); } catch { /* Worker startup/expiry also cleans abandoned staging. */ } }
    signal?.removeEventListener('abort', cancelReader);
    try { await reader.cancel(); } catch { /* Reader may already be closed. */ }
    reader.releaseLock();
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
}

/** Call directly from the click handler so the picker retains user activation. */
export async function exportCacheFile(send, {signal, onProgress = () => {}, picker = globalThis.showSaveFilePicker?.bind(globalThis), download = downloadBlob} = {}) {
  const name = 'crave-cache-' + new Date().toISOString().replace(/[:.]/g, '-') + '.ndjson';
  // A present but denied picker must never trigger a memory fallback.
  const picked = picker ? picker({suggestedName: name, types: [{description: '번역 캐시 NDJSON', accept: {'application/x-ndjson': ['.ndjson']}}]}) : null;
  let writer = null, token = null, completed = false, totalBytes = 0, count = 0;
  const parts = picked ? null : [];
  async function writeLine(value) {
    checkAbort(signal);
    const line = JSON.stringify(value) + '\n';
    if (bytes(line) > MAX_LINE_BYTES) throw new Error('내보내는 캐시 줄이 1 MiB를 초과합니다.');
    if (writer) await writer.write(line);
    else {
      totalBytes += bytes(line);
      if (totalBytes > MAX_JSON_BYTES) throw new Error('다운로드 대체 저장은 32 MiB 이하만 가능합니다. 새 탭에서 순차 저장을 지원하는 Chrome으로 다시 시도하세요.');
      parts.push(line);
    }
  }
  try {
    if (picked) {
      const handle = await picked;
      checkAbort(signal);
      writer = await handle.createWritable();
    }
    checkAbort(signal);
    const start = await send('EXPORT_START');
    token = start.token;
    if (typeof token !== 'string' || !token) throw new Error('내보내기 작업을 시작하지 못했습니다.');
    await writeLine(normalizeCacheHeader(start.header, {stream: true}));
    let cursor = null;
    while (true) {
      checkAbort(signal);
      const page = await send('EXPORT_PAGE', {token, cursor});
      checkAbort(signal);
      if (!Array.isArray(page.entries) || page.entries.length > MAX_BATCH_ENTRIES || typeof page.done !== 'boolean') throw new Error('캐시 내보내기 페이지가 올바르지 않습니다.');
      for (const entry of page.entries) { await writeLine(portableEntry(entry)); count++; }
      onProgress(`내보내기 ${count.toLocaleString('ko-KR')}개 · 팝업을 열어 두세요${picked ? '' : ' · 32 MiB 제한 다운로드'}`);
      if (page.done) break;
      if (typeof page.cursor !== 'string' || !page.cursor || page.cursor === cursor) throw new Error('캐시 페이지 순서가 올바르지 않습니다.');
      cursor = page.cursor;
    }
    if (start.countIsExact === true && count !== start.count) throw new Error('내보내기 항목 개수가 일치하지 않습니다.');
    await writeLine({end: true, count});
    checkAbort(signal);
    if (writer) { await writer.close(); writer = null; }
    else download(new Blob(parts, {type: 'application/x-ndjson;charset=utf-8'}), name);
    completed = true;
    return {count, method: picked ? 'stream' : 'download'};
  } finally {
    if (!completed && writer) { try { await writer.abort(); } catch { /* Disk may already be unavailable. */ } }
    if (token) { try { await send('EXPORT_END', {token}); } catch { /* Worker startup/expiry also cleans abandoned sessions. */ } }
  }
}
