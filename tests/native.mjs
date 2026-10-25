import {send, fixtures} from './browser-host.mjs';
import {makeCacheEntry, portableEntry, CACHE_FORMAT} from '../cache.mjs';
import {importCacheFile, exportCacheFile} from '../file-transfer.mjs';
const results = [], output = document.getElementById('results');
const check = (condition, message) => { if (!condition) throw Error(message); };
async function request(type, payload = {}, sender) {
  const answer = await send({type, ...payload}, sender);
  if (!answer.ok) throw Object.assign(Error(answer.error), {code: answer.code});
  return answer;
}
async function row(source, text, extra = {}) {
  return portableEntry(await makeCacheEntry({source, text, context: 'synthetic test', target: '한국어', createdAt: 100, updatedAt: 100, ...extra}));
}
const envelope = entries => ({format: CACHE_FORMAT, version: 3, exportedAt: '2026-10-25T00:00:00.000Z', appVersion: '0.3.5', entries});
const header = {format: CACHE_FORMAT, version: 3, identity: 'source-v3', exportedAt: '2026-10-25T00:00:00.000Z', appVersion: '0.3.5'};
const identity = entry => ({id: entry.id, source: entry.source, target: entry.target, expectedUpdatedAt: entry.updatedAt, expectedText: entry.text});
async function scenario(name, fn) {
  await fn(); results.push({name, passed: true}); output.textContent = JSON.stringify(results, null, 2);
}
async function run() {
  results.length = 0;
  const source = '攻撃力10%上昇', a = await row(source, '공격력10% 증가');
  try {
    await scenario('JSON load, exact source/target lookup, and missing original', async () => {
      await request('IMPORT_CACHE', {data: envelope([a]), mode: 'replace', confirmed: true});
      const found = await request('CACHE_LOOKUP', {items: [{id: 'a', source}, {id: 'space', source: source + ' '}, {id: 'missing', source: '未収録文章'}]}, fixtures.game);
      check(found.results.find(r => r.id === 'a').text === a.text, 'Imported text not applied');
      check(found.results.find(r => r.id === 'space').missing === true, 'Whitespace normalized');
      check(found.results.find(r => r.id === 'missing').missing === true, 'Missing text not preserved');
    });
    await scenario('original popup NDJSON and JSON exports load through the parser and native backend', async () => {
      const {exportedAt, ...metadata} = header;
      const originalHeader = {...metadata, exportedAtISO: exportedAt};
      for (const version of [2, 3]) {
        const text = `공격력10% 원본 파일 v${version === 2 ? '이' : '삼'}`;
        const entry = {...a, text};
        const stream = new File([JSON.stringify({...originalHeader, version}) + '\n', JSON.stringify(entry) + '\n', '{"end":true,"count":1}\n'], 'original-export.ndjson');
        await importCacheFile(stream, request, {conflictPolicy: 'use-incoming'});
        check((await request('CACHE_GET', {id: a.id})).entry.text === text, 'Original NDJSON did not reach native cache');
      }
      const legacyJson = new File([JSON.stringify({...originalHeader, entries: [a]})], 'original-export.json');
      await importCacheFile(legacyJson, request, {conflictPolicy: 'use-incoming'});
      check((await request('CACHE_GET', {id: a.id})).entry.text === a.text, 'Original JSON fallback did not reach native cache');
    });
    await scenario('default merge keeps manual local text; incoming choice replaces it and adds new source', async () => {
      const edited = await request('CACHE_EDIT_SAVE', {...identity(a), text: '공격력10% 수동 증가'});
      check(edited.entry.manual === true, 'Manual flag absent');
      const incoming = await row(source, '공격력10% 파일 증가', {updatedAt: 200});
      const b = await row('物語開始', '이야기 시작');
      await request('IMPORT_CACHE', {data: envelope([incoming, b]), mode: 'merge'});
      check((await request('CACHE_GET', {id: a.id})).entry.text === edited.entry.text, 'Default merge overwrote manual');
      check((await request('GET_STATE')).cacheCount === 2, 'Merge lost or duplicated rows');
      await request('IMPORT_CACHE', {data: envelope([incoming]), mode: 'merge', conflictPolicy: 'use-incoming'});
      check((await request('CACHE_GET', {id: a.id})).entry.text === incoming.text, 'Incoming priority not honored');
    });
    await scenario('concurrent editors use atomic CAS and protected validation', async () => {
      const current = (await request('CACHE_GET', {id: a.id})).entry;
      const messages = ['공격력10% 첫 수정', '공격력10% 둘째 수정'].map(text => send({type: 'CACHE_EDIT_SAVE', ...identity(current), text}));
      const edits = await Promise.all(messages);
      check(edits.filter(r => r.ok).length === 1, 'Both stale editors wrote successfully');
      check(edits.some(r => !r.ok && r.code === 'CONFLICT'), 'Conflict not surfaced');
      const winner = (await request('CACHE_GET', {id: a.id})).entry;
      const bad = await send({type: 'CACHE_EDIT_SAVE', ...identity(winner), text: '공격력99% 잘못된 수정'});
      check(!bad.ok, 'Changed protected number accepted');
      check((await request('CACHE_GET', {id: a.id})).entry.text === winner.text, 'Failed edit changed stored value');
    });
    await scenario('failed replace and truncated staged import preserve all live data', async () => {
      const before = (await request('CACHE_GET', {id: a.id})).entry;
      const noConfirm = await send({type: 'IMPORT_CACHE', data: envelope([]), mode: 'replace'});
      check(!noConfirm.ok, 'Destructive replacement lacked confirmation');
      const bad = await send({type: 'IMPORT_CACHE', data: envelope([{...a, text: '공격력99% 변조'}]), mode: 'replace', confirmed: true});
      check(!bad.ok, 'Invalid replacement accepted');
      const session = await request('IMPORT_START', {mode: 'replace', confirmed: true});
      await request('IMPORT_BATCH', {token: session.token, entries: [await row('新規文', '새 문장')]});
      const partial = await send({type: 'IMPORT_COMMIT', token: session.token, header, expectedCount: 2});
      check(!partial.ok, 'Truncated count accepted');
      await request('IMPORT_ABORT', {token: session.token});
      check((await request('CACHE_GET', {id: a.id})).entry.text === before.text, 'Failed replacement lost original');
      check((await request('GET_STATE')).cacheCount === 2, 'Failed replacement changed count');
    });
    await scenario('streamed import and export preserve metadata, manual flag and actual count', async () => {
      const manual = await row('固有名詞', '固有名詞', {manual: true});
      const start = await request('IMPORT_START', {mode: 'merge', conflictPolicy: 'keep-local'});
      await request('IMPORT_BATCH', {token: start.token, entries: [manual]});
      await request('IMPORT_COMMIT', {token: start.token, header: {...header, version: 2}, expectedCount: 1});
      const exp = await request('EXPORT_START'); let cursor = null; const rows = [];
      for (;;) {
        const page = await request('EXPORT_PAGE', {token: exp.token, cursor}); rows.push(...page.entries);
        if (page.done) break; cursor = page.cursor;
      }
      await request('EXPORT_END', {token: exp.token});
      check(rows.length === 3, 'Export count differs from live cache');
      const saved = rows.find(r => r.id === manual.id);
      check(saved.manual === true && saved.text === manual.text && saved.updatedAt === 100, 'Portable edit metadata changed');
      check(rows.every(r => !Object.hasOwn(r, 'reverseTime') && !Object.hasOwn(r, 'time')), 'Internal fields exported');
    });
    await scenario('search, single deletion and revision broadcast update live cache', async () => {
      const search = await request('CACHE_SEARCH', {query: '공격력', mode: 'contains', target: '한국어', cursor: null, limit: 20});
      check(search.results.some(r => r.id === a.id), 'Translation search missed edit');
      const current = (await request('CACHE_GET', {id: a.id})).entry;
      const oldRevision = (await request('PUBLIC_CONFIG', {}, fixtures.game)).config.cacheEpoch;
      await request('CACHE_DELETE', identity(current));
      const lookup = await request('CACHE_LOOKUP', {items: [{id: 'deleted', source}]}, fixtures.game);
      check(lookup.results[0].missing === true, 'Deleted source reused');
      check((await request('GET_STATE')).cacheCount === 2, 'Single delete count wrong');
      const revision = (await request('PUBLIC_CONFIG', {}, fixtures.game)).config.cacheEpoch;
      check(revision !== oldRevision, 'Delete did not invalidate memories');
      check(fixtures.broadcasts.some(b => b.message.config?.cacheEpoch === revision), 'Revision not broadcast');
    });
    await scenario('game and foreign pages cannot access editing or file-management operations', async () => {
      for (const type of ['GET_STATE', 'SAVE_SETTINGS', 'CACHE_SEARCH', 'CACHE_GET', 'CACHE_EDIT_SAVE', 'CACHE_DELETE', 'IMPORT_CACHE', 'IMPORT_START', 'IMPORT_BATCH', 'IMPORT_COMMIT', 'IMPORT_ABORT', 'EXPORT_START', 'EXPORT_PAGE', 'EXPORT_END']) {
        const denied = await send({type}, fixtures.game);
        check(denied.ok === false, 'Game accessed ' + type);
      }
      const denied = await send({type: 'PUBLIC_CONFIG'}, {...fixtures.game, url: 'https://attacker.invalid/'});
      check(!denied.ok, 'Foreign page accessed extension');
    });
    await scenario('stream parser rejects truncated, trailing, invalid UTF-8 and protected-content files without losing native data', async () => {
      const extra = await row('追加台詞', '추가 대사');
      const startLine = JSON.stringify(header) + '\n', entryLine = JSON.stringify(extra) + '\n';
      const endLine = JSON.stringify({end: true, count: 1}) + '\n';
      const invalid = [
        new File([startLine, entryLine], 'truncated.ndjson'),
        new File([startLine, entryLine, endLine, entryLine], 'trailing.ndjson'),
        new File([startLine, entryLine, new Uint8Array([0xff])], 'invalid-utf8.ndjson'),
        new File([startLine, JSON.stringify({...a, text: '공격력99% 변조'}) + '\n', endLine], 'protected.ndjson')
      ];
      const retainedId = (await row('物語開始', '이야기 시작')).id;
      for (const file of invalid) {
        let rejected = false;
        try { await importCacheFile(file, request, {mode: 'replace', confirmed: true}); } catch { rejected = true; }
        check(rejected, 'Unsafe file accepted: ' + file.name);
        check((await request('GET_STATE')).cacheCount === 2, 'Unsafe import lost native rows');
        check((await request('CACHE_GET', {id: retainedId})).entry.text === '이야기 시작', 'Existing translation lost');
      }
      await importCacheFile(new File([startLine, entryLine, endLine], 'valid.ndjson'), request);
      check((await request('CACHE_GET', {id: extra.id})).entry.text === extra.text, 'Valid stream not committed');
    });
    await scenario('real cache export writes a re-importable NDJSON backup and aborts incomplete disk writes', async () => {
      let backup = null;
      const result = await exportCacheFile(request, {picker: null, download: blob => { backup = blob; }});
      check(result.count === 3 && backup instanceof Blob, 'Backup count wrong');
      const text = await backup.text(), lines = text.trim().split('\n').map(line => JSON.parse(line));
      check(lines.at(-1).end === true && lines.at(-1).count === 3, 'Actual footer count wrong');
      await importCacheFile(new File([backup], 'roundtrip.ndjson'), request, {mode: 'replace', confirmed: true});
      check((await request('GET_STATE')).cacheCount === 3, 'Backup round-trip lost native rows');
      let aborted = false, closed = false, failed = false;
      try {
        await exportCacheFile(request, {picker: async () => ({createWritable: async () => ({
          write: async () => { throw Error('Synthetic disk-full failure'); },
          close: async () => { closed = true; }, abort: async () => { aborted = true; }
        })})});
      } catch { failed = true; }
      check(failed && aborted && !closed, 'Failed disk write treated as completed');
      check((await request('GET_STATE')).cacheCount === 3, 'Failed export changed native cache');
    });
    await scenario('disable restores misses; switching target never reuses another language', async () => {
      await request('SAVE_SETTINGS', {settings: {enabled: false, target: '한국어', fontFamily: 'Malgun Gothic'}});
      const off = await request('CACHE_LOOKUP', {items: [{id: 'off', source: '物語開始'}]}, fixtures.game);
      check(!off.results.some(r => typeof r.text === 'string'), 'Disabled cache still applied');
      await request('SAVE_SETTINGS', {settings: {enabled: true, target: 'English', fontFamily: 'Arial'}});
      const english = await request('CACHE_LOOKUP', {items: [{id: 'language', source: '物語開始'}]}, fixtures.game);
      check(english.results[0].missing === true, 'Target language isolation lost');
      await request('SAVE_SETTINGS', {settings: {enabled: true, target: '한국어', fontFamily: 'Malgun Gothic'}});
    });
    window.__miniNativeResult = {allPassed: true, passed: results.length, results};
  } catch (error) {
    results.push({passed: false, error: error.message, stack: error.stack});
    window.__miniNativeResult = {allPassed: false, results};
  }
  output.textContent = JSON.stringify(window.__miniNativeResult, null, 2);
  return window.__miniNativeResult;
}
document.getElementById('start').addEventListener('click', () => { window.__miniNativePromise = run(); });
