import {send, fixtures} from './browser-host.mjs';
import {makeCacheEntry, portableEntry, indexedCacheEntry, byteSize, CACHE_FORMAT} from '../cache.mjs';
import {createCacheStore} from '../cache-store.mjs';
import {createCacheEditor} from '../cache-editor.mjs';
import {createCacheTransfer} from '../cache-transfer.mjs';
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
function nativeTransaction(db, names, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode); let result;
    tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result);
    tx.onabort = tx.onerror = () => reject(tx.error || Error('Native test transaction failed'));
    work(tx, value => { result = value; });
  });
}
async function isolatedCache(fn) {
  const cache = createCacheStore(indexedDB, {databaseName: 'mini-dialogue-test-' + crypto.randomUUID()});
  try { await fn(cache, createCacheEditor(cache), createCacheTransfer(cache)); }
  finally { await cache.destroy(); }
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
      const bad = await send({type: 'IMPORT_CACHE', data: envelope([{...a, id: 'v3:' + '0'.repeat(64)}]), mode: 'replace', confirmed: true});
      check(!bad.ok, 'Corrupted identity replacement accepted');
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
      for (const type of ['GET_STATE', 'SAVE_SETTINGS', 'CACHE_SEARCH', 'CACHE_GET', 'CACHE_EDIT_SAVE', 'CACHE_DELETE', 'CACHE_CLEAR', 'IMPORT_CACHE', 'IMPORT_START', 'IMPORT_BATCH', 'IMPORT_COMMIT', 'IMPORT_ABORT', 'EXPORT_START', 'EXPORT_PAGE', 'EXPORT_END']) {
        const denied = await send({type}, fixtures.game);
        check(denied.ok === false, 'Game accessed ' + type);
      }
      const denied = await send({type: 'PUBLIC_CONFIG'}, {...fixtures.game, url: 'https://attacker.invalid/'});
      check(!denied.ok, 'Foreign page accessed extension');
    });
    await scenario('stream parser rejects truncated, trailing, invalid UTF-8 and corrupted identities without losing native data', async () => {
      const extra = await row('追加台詞', '추가 대사');
      const startLine = JSON.stringify(header) + '\n', entryLine = JSON.stringify(extra) + '\n';
      const endLine = JSON.stringify({end: true, count: 1}) + '\n';
      const invalid = [
        new File([startLine, entryLine], 'truncated.ndjson'),
        new File([startLine, entryLine, endLine, entryLine], 'trailing.ndjson'),
        new File([startLine, entryLine, new Uint8Array([0xff])], 'invalid-utf8.ndjson'),
        new File([startLine, JSON.stringify({...a, id: 'v3:' + '0'.repeat(64)}) + '\n', endLine], 'corrupted-id.ndjson')
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
    await scenario('translation-content differences load byte-exact with warnings and remain readable and exportable', async () => {
      const warning = await row('攻撃20%\n{value}', '공격99%{other}');
      const valid = await row('防御30%', '방어30%');
      const imported = await request('IMPORT_CACHE', {data: envelope([warning, valid]), mode: 'merge'});
      check(imported.imported === 2 && imported.validationWarnings === 1, 'Content warning prevented a complete JSON import');
      const hit = await request('CACHE_LOOKUP', {items: [{id: 'warning', source: warning.source}]}, fixtures.game);
      check(hit.results[0].text === warning.text, 'Warning translation was filtered or modified on lookup');
      const keep = await request('IMPORT_START', {mode: 'merge', conflictPolicy: 'keep-local'});
      await request('IMPORT_BATCH', {token: keep.token, entries: [warning, valid]});
      const kept = await request('IMPORT_COMMIT', {token: keep.token, header, expectedCount: 2});
      check(kept.imported === 0 && kept.validationWarnings === 0, 'Skipped keep-local rows counted as loaded warnings');
      const changed = {...warning, text: '공격88%{other}'};
      const replace = await request('IMPORT_START', {mode: 'merge', conflictPolicy: 'use-incoming'});
      await request('IMPORT_BATCH', {token: replace.token, entries: [changed]});
      const replaced = await request('IMPORT_COMMIT', {token: replace.token, header, expectedCount: 1});
      check(replaced.imported === 1 && replaced.validationWarnings === 1, 'Streamed warning row did not commit');
      const exp = await request('EXPORT_START'); let cursor = null, exportedWarning = null;
      for (;;) {
        const page = await request('EXPORT_PAGE', {token: exp.token, cursor});
        exportedWarning ||= page.entries.find(entry => entry.id === warning.id);
        if (page.done) break; cursor = page.cursor;
      }
      await request('EXPORT_END', {token: exp.token});
      check(exportedWarning?.text === changed.text, 'Warning row was lost or changed by export');
      const stored = (await request('CACHE_GET', {id: warning.id})).entry;
      const edit = await send({type: 'CACHE_EDIT_SAVE', ...identity(stored), text: '공격77%{other}'});
      check(!edit.ok, 'Manual edit protection was unintentionally relaxed');
    });
    await scenario('confirmed reset clears all languages and stale transfers but preserves settings and permits reload', async () => {
      const settings = {enabled: true, target: '한국어', fontFamily: 'Arial', playerName: 'SourceName', displayName: 'VisibleName'};
      await request('SAVE_SETTINGS', {settings});
      const english = await row('別言語50%', 'Other language50%', {target: 'English'});
      await request('IMPORT_CACHE', {data: envelope([english]), mode: 'merge'});
      const before = await request('GET_STATE');
      for (const confirmed of [undefined, false, 'true', 1, null]) {
        const denied = await send({type: 'CACHE_CLEAR', ...(confirmed === undefined ? {} : {confirmed})});
        check(!denied.ok, 'Reset accepted invalid confirmation');
      }
      check(!(await send({type: 'CACHE_CLEAR', confirmed: true}, fixtures.game)).ok, 'Game cleared private cache');
      check((await request('GET_STATE')).cacheCount === before.cacheCount, 'Rejected resets changed live rows');
      const pending = await request('IMPORT_START', {mode: 'merge'});
      await request('IMPORT_BATCH', {token: pending.token, entries: [await row('後着40%', '늦은40%')]});
      const exporting = await request('EXPORT_START');
      const oldEpoch = (await request('PUBLIC_CONFIG', {}, fixtures.game)).config.cacheEpoch;
      const cleared = await request('CACHE_CLEAR', {confirmed: true});
      const after = await request('GET_STATE');
      check(cleared.cacheCount === 0 && after.cacheCount === 0, 'Reset did not empty cache');
      check(JSON.stringify(after.settings) === JSON.stringify(before.settings), 'Reset changed saved settings');
      const allLanguages = await request('CACHE_SEARCH', {query: '', mode: 'contains', cursor: null, limit: 20});
      check(allLanguages.results.length === 0 && allLanguages.done, 'Reset left another language behind');
      const epoch = (await request('PUBLIC_CONFIG', {}, fixtures.game)).config.cacheEpoch;
      check(epoch !== oldEpoch && fixtures.broadcasts.some(item => item.message.config?.cacheEpoch === epoch), 'Reset did not invalidate current game memories');
      check(!(await send({type: 'IMPORT_COMMIT', token: pending.token, header, expectedCount: 1})).ok, 'Old import repopulated cleared cache');
      check(!(await send({type: 'EXPORT_PAGE', token: exporting.token, cursor: null})).ok, 'Old export survived reset');
      const restored = await row('再読込60%', '재가져오기60%');
      await importCacheFile(new File([JSON.stringify(header) + '\n', JSON.stringify(restored) + '\n', '{"end":true,"count":1}\n'], 'reload.ndjson'), request);
      const lookup = await request('CACHE_LOOKUP', {items: [{id: 'reloaded', source: restored.source}]}, fixtures.game);
      check(lookup.results[0].text === restored.text && (await request('GET_STATE')).cacheCount === 1, 'Reload after reset failed');
    });
    await scenario('story fallback works in both directions without generic UI broadening or portable alias rows', async () => {
      const plain = await row('台詞の\n続き{USER}', '대사의\n계속{USER}', {context: 'generic UI'});
      const wrappedSource = '<size=24>台詞の続き{USER}</size>';
      await request('IMPORT_CACHE', {data: envelope([plain]), mode: 'replace', confirmed: true});
      const hits = await request('CACHE_LOOKUP', {items: [
        {id: 'story', source: wrappedSource, context: 'Canvas / AdvText'},
        {id: 'generic', source: wrappedSource, context: 'Canvas / SkillText'},
        {id: 'lookalike', source: wrappedSource, context: 'Canvas / NotAdvText'}
      ]}, fixtures.game);
      check(hits.results.find(r => r.id === 'story').text === '<size=24>대사의계속{USER}</size>', 'Plain-to-dialogue reuse failed');
      check(hits.results.find(r => r.id === 'generic').missing && hits.results.find(r => r.id === 'lookalike').missing, 'Generic lookup broadened');
      check((await request('GET_STATE')).cacheCount === 1, 'Fallback created an alias row');
      check((await request('CACHE_GET', {id: plain.id})).entry.text === plain.text, 'Fallback rewrote canonical editor row');
      const wrapped = await row(wrappedSource, '<size=24>역방향{USER}</size>');
      await request('IMPORT_CACHE', {data: envelope([wrapped]), mode: 'replace', confirmed: true});
      const reverse = await request('CACHE_LOOKUP', {items: [{id: 'backlog', source: plain.source, context: 'AdvRichBackLogText'}]}, fixtures.game);
      check(reverse.results[0].text === '역방향{USER}', 'Dialogue-to-backlog reuse failed');
      const exp = await request('EXPORT_START');
      const page = await request('EXPORT_PAGE', {token: exp.token, cursor: null});
      await request('EXPORT_END', {token: exp.token});
      check(page.entries.length === 1 && JSON.stringify(page.entries[0]) === JSON.stringify(wrapped), 'Export projected or changed stored bytes');
    });
    await scenario('exact warning and manual precedence beat indexed fallback; candidates rank manual, recent, then id', async () => {
      await isolatedCache(async cache => {
        const query = {source: '<size=30>優先台詞</size>', context: 'AdvText'};
        const manual = await row('優先\n台詞', '수동\n대사', {manual: true});
        const recent = await row('優先台詞', '최신대사', {updatedAt: 900});
        await cache.import(envelope([recent, manual]));
        check((await cache.lookup(query, {target: '한국어'})).text === '<size=30>수동대사</size>', 'New automatic row beat manual fallback');
        const exact = await row(query.source, '<size=30>정확대사</size>', {updatedAt: 100});
        await cache.import(envelope([exact]));
        check((await cache.lookup(query, {target: '한국어'})).text === exact.text, 'Manual fallback beat exact automatic row');
        const warning = {...exact, text: '경고99%'};
        const result = await cache.import(envelope([warning]), 'merge', {conflictPolicy: 'use-incoming'});
        check(result.validationWarnings === 1 && (await cache.lookup(query, {target: '한국어'})).text === warning.text, 'Exact warning was not preserved');
        await cache.import(envelope([warning]), 'replace', {confirmed: true});
        check(await cache.lookup({source: '優先台詞', context: 'AdvText'}, {target: '한국어'}) === null, 'Warning row entered fallback index');
        const older = await row('順序\n台詞', '오래된\n대사', {updatedAt: 200});
        const newer = await row('<size=20>順序台詞</size>', '<size=20>새대사</size>', {updatedAt: 300});
        await cache.import(envelope([older, newer]), 'replace', {confirmed: true});
        const orderQuery = {source: '<size=31>順序台詞</size>', context: 'AdvText'};
        check((await cache.lookup(orderQuery, {target: '한국어'})).id === newer.id, 'Recent candidate did not win');
        const tied = {...older, updatedAt: 300};
        await cache.import(envelope([tied]), 'merge', {conflictPolicy: 'use-incoming'});
        check((await cache.lookup(orderQuery, {target: '한국어'})).id === [older.id, newer.id].sort()[0], 'Tied fallback id order was not deterministic');
        check(await cache.lookup(orderQuery, {target: 'English'}) === null, 'Dialogue index crossed target language');
      });
    });
    await scenario('exact-only name-choice phase suppresses literal fallback without hiding canonical USER rows', async () => {
      await isolatedCache(async cache => {
        const literal = await row('太郎は\n来た', '타로는\n왔다', {manual: true});
        const canonical = await row('<size=30>{USER}は来た</size>', '<size=30>{USER}는 왔다</size>');
        const rawChoice = {source: '<size=30>太郎は来た</size>', context: 'AdvText'};
        const sharedChoice = {source: canonical.source, context: 'AdvText'};
        await cache.import(envelope([literal, canonical]));
        check(await cache.lookup(rawChoice, {target: '한국어', exactOnly: true}) === null, 'Exact-only literal lookup used indexed fallback');
        check((await cache.lookup(sharedChoice, {target: '한국어', exactOnly: true})).text === canonical.text, 'Exact-only phase hid canonical USER row');
        check((await cache.lookup(rawChoice, {target: '한국어'})).text === '<size=30>타로는왔다</size>', 'Default lookup lost literal dialogue fallback');
        check((await cache.lookup(rawChoice, {target: '한국어', exactOnly: false})).id === literal.id, 'Explicit fallback phase lost candidate');
        check(await cache.count() === 2, 'Name-choice lookup wrote an alias row');
      });
    });
    await scenario('protected tag and variable contents never broaden through the dialogue index', async () => {
      await isolatedCache(async cache => {
        for (const [source, text, requested] of [
          ['台詞<tag value="a\nb">', '대사<tag value="a\nb">', '台詞<tag value="ab">'],
          ['台詞{a\nb}', '대사{a\nb}', '台詞{ab}'],
          ['台詞<b>続き</b>', '대사<b>계속</b>', '台詞続き'],
          ['台詞10%', '대사10%', '台詞11%']
        ]) {
          await cache.import(envelope([await row(source, text)]), 'replace', {confirmed: true});
          check(await cache.lookup({source: '<size=24>' + requested + '</size>', context: 'AdvText'}, {target: '한국어'}) === null, 'Protected content was normalized');
        }
      });
    });
    await scenario('editing, deletion, direct/staged imports and clear maintain derived index and exact tombstones', async () => {
      await isolatedCache(async (cache, editor, transfer) => {
        const original = await row('削除する\n台詞', '삭제할\n대사');
        const equivalent = await row('<size=20>削除する台詞</size>', '<size=20>남겨진대사</size>');
        const query = {source: original.source, context: 'AdvRichBackLogText'};
        await cache.import(envelope([original, equivalent]));
        const edited = await editor.save({...identity(original), text: '수정한\n대사'});
        const fallback = await cache.lookup({source: '<size=40>削除する台詞</size>', context: 'AdvText'}, {target: '한국어'});
        check(fallback.id === original.id && fallback.text === '<size=40>수정한대사</size>', 'Edited row did not update manual index rank');
        const db = await cache._database();
        await nativeTransaction(db, 'cache-metadata', 'readwrite', tx => tx.objectStore('cache-metadata').put({id: 'deleted-source:' + original.id}));
        const savedAgain = await editor.save({...identity(edited.entry), text: '다시\n수정'});
        const markerAfterEdit = await nativeTransaction(db, 'cache-metadata', 'readonly', (tx, set) => {
          const r = tx.objectStore('cache-metadata').get('deleted-source:' + original.id); r.onsuccess = () => set(r.result);
        });
        check(!markerAfterEdit, 'Explicit edit did not clear exact tombstone');
        await editor.remove(identity(savedAgain.entry));
        check(await cache.count() === 1 && await cache.lookup(query, {target: '한국어'}) === null, 'Deleted source resurrected from equivalent row');
        await cache.import(envelope([equivalent]), 'replace', {confirmed: true});
        check(await cache.lookup(query, {target: '한국어'}) === null, 'Equivalent replacement cleared another exact tombstone');
        await cache.import(envelope([original]));
        check((await cache.lookup(query, {target: '한국어'})).text === original.text && await cache.count() === 2, 'Direct reimport did not restore exact source/count');
        await editor.remove(identity(original));
        const job = await transfer.importStart('merge');
        await transfer.importStage(job.token, [original]);
        await transfer.importCommit(job.token, header, {expectedCount: 1});
        check((await cache.lookup(query, {target: '한국어'})).text === original.text && await cache.count() === 2, 'Staged reimport did not restore exact source/count');
        await editor.remove(identity(original));
        const warning = {...equivalent, text: '잘못된99%'};
        await cache.import(envelope([warning]), 'merge', {conflictPolicy: 'use-incoming'});
        check(await cache.lookup({source: '<size=40>削除する台詞</size>', context: 'AdvText'}, {target: '한국어'}) === null, 'Incoming warning retained stale index fields');
        const restoredIndex = await transfer.importStart('merge', {conflictPolicy: 'use-incoming'});
        await transfer.importStage(restoredIndex.token, [equivalent]);
        await transfer.importCommit(restoredIndex.token, header, {expectedCount: 1});
        check((await cache.lookup({source: '<size=40>削除する台詞</size>', context: 'AdvText'}, {target: '한국어'})).text === '<size=40>남겨진대사</size>', 'Staged incoming row did not rebuild index');
        const removedIndex = await transfer.importStart('merge', {conflictPolicy: 'use-incoming'});
        await transfer.importStage(removedIndex.token, [warning]);
        await transfer.importCommit(removedIndex.token, header, {expectedCount: 1});
        check(await cache.lookup({source: '<size=40>削除する台詞</size>', context: 'AdvText'}, {target: '한국어'}) === null, 'Staged warning retained stale index fields');
        const pending = await transfer.importStart('merge');
        await transfer.importStage(pending.token, [original]);
        await cache.clear();
        let rejected = false;
        try { await transfer.importCommit(pending.token, header, {expectedCount: 1}); } catch { rejected = true; }
        check(rejected && await cache.count() === 0, 'Clear failed to invalidate staging');
        await cache.import(envelope([equivalent]));
        check((await cache.lookup(query, {target: '한국어'})).text === '남겨진대사', 'Clear left a deletion tombstone behind');
        const warm = await cache.warm('한국어');
        check(warm.entries.length === 1 && warm.entries[0].source === equivalent.source && warm.entries[0].text === equivalent.text, 'Warm cache returned a projected alias');
      });
    });
    await scenario('indexed fallback bounds row and byte work without scanning the translations store', async () => {
      await isolatedCache(async cache => {
        const base = await makeCacheEntry({source: '上限台詞', text: '상한대사', target: '한국어', createdAt: 100, updatedAt: 100});
        const db = await cache._database(), key = base.dialogueKey;
        const query = {source: '<size=40>上限台詞</size>', context: 'AdvText'};
        const seed = async entries => nativeTransaction(db, 'translations', 'readwrite', tx => {
          const store = tx.objectStore('translations'); store.clear(); for (const entry of entries) store.put(entry);
        });
        const invalid = Array.from({length: 40}, (_, i) => ({
          ...base, id: 'v3:' + i.toString(16).padStart(64, '0'), text: '警告99%', dialogueKey: key, reverseTime: 0
        }));
        await seed([...invalid, {...base, reverseTime: 1}]);
        let indexReads = 0, storeScans = 0;
        const indexCursor = IDBIndex.prototype.openCursor, storeCursor = IDBObjectStore.prototype.openCursor;
        IDBIndex.prototype.openCursor = function (...args) {
          const r = indexCursor.apply(this, args);
          if (this.name === 'dialogue') r.addEventListener('success', () => { if (r.result) indexReads++; });
          return r;
        };
        IDBObjectStore.prototype.openCursor = function (...args) { if (this.name === 'translations') storeScans++; return storeCursor.apply(this, args); };
        try {
          check(await cache.lookup(query, {target: '한국어'}) === null, 'Lookup passed the candidate row cap');
          check(indexReads === 32 && storeScans === 0, 'Lookup did not stay on its bounded index');
          indexReads = 0;
          await seed(invalid.slice(0, 2).map(entry => ({...entry, text: '가'.repeat(200000)})).concat({...base, reverseTime: 1}));
          check(await cache.lookup(query, {target: '한국어'}) === null && indexReads === 2, 'Lookup passed its 1MiB candidate byte cap');
        } finally {
          IDBIndex.prototype.openCursor = indexCursor;
          IDBObjectStore.prototype.openCursor = storeCursor;
        }
      });
    });
    await scenario('v1 upgrade and interrupted migration resume in bounded batches without row, id, byte or count loss', async () => {
      const entries = await Promise.all(Array.from({length: 90}, (_, i) => row(
        i < 16 ? '長'.repeat(7990) + i : '移行する台詞' + i,
        i < 16 ? '긴'.repeat(47000) + i : '이전된대사' + i,
        {context: i % 2 ? 'AdvText' : 'generic', ...(i % 3 === 0 ? {manual: true} : {})}
      )));
      entries.sort((a, b) => a.id.localeCompare(b.id));
      for (const resume of [false, true]) {
        const databaseName = 'mini-migration-test-' + crypto.randomUUID();
        const legacy = await new Promise((resolve, reject) => {
          const r = indexedDB.open(databaseName, 1);
          r.onupgradeneeded = () => {
            const db = r.result, live = db.createObjectStore('translations', {keyPath: 'id'});
            live.createIndex('targetRecent', ['target', 'reverseTime', 'id']);
            const meta = db.createObjectStore('cache-metadata', {keyPath: 'id'});
            meta.put({id: 'translation-count', count: entries.length});
            db.createObjectStore('imports', {keyPath: ['token', 'id']}).createIndex('token', 'token');
            for (let i = 0; i < entries.length; i++) {
              const entry = entries[i];
              live.put(resume && i < 10 ? indexedCacheEntry(entry) : {...entry, time: entry.updatedAt, reverseTime: Number.MAX_SAFE_INTEGER - entry.updatedAt});
            }
            if (resume) meta.put({id: 'dialogue-index-v1', cursor: entries[9].id, done: false});
          };
          r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
        });
        legacy.close();
        const updates = new WeakMap(), sizes = new WeakMap(), batches = [];
        const update = IDBCursor.prototype.update, put = IDBObjectStore.prototype.put;
        IDBCursor.prototype.update = function (value) {
          const tx = this.source.transaction;
          updates.set(tx, (updates.get(tx) || 0) + 1); sizes.set(tx, (sizes.get(tx) || 0) + byteSize(value));
          return update.call(this, value);
        };
        IDBObjectStore.prototype.put = function (value, ...args) {
          if (this.name === 'cache-metadata' && value.id === 'dialogue-index-v1') batches.push({rows: updates.get(this.transaction) || 0, bytes: sizes.get(this.transaction) || 0});
          return put.call(this, value, ...args);
        };
        const cache = createCacheStore(indexedDB, {databaseName});
        try {
          const db = await cache._database();
          const rows = await nativeTransaction(db, 'translations', 'readonly', (tx, set) => {
            const r = tx.objectStore('translations').getAll(); r.onsuccess = () => set(r.result);
          });
          check(db.version === 2 && rows.length === entries.length && await cache.count() === entries.length, 'Migration changed version, row count or metadata count');
          check(JSON.stringify(rows.map(portableEntry)) === JSON.stringify(entries), 'Migration changed portable bytes, identities or metadata');
          check(rows.every(entry => typeof entry.dialogueKey === 'string' && entry.manualRank === (entry.manual ? 0 : 1)), 'Migration missed derived fields');
          check(batches.length > 1 && batches.every(batch => batch.rows <= 64 && batch.bytes < 1048576 + 200000), 'Migration was not bounded');
          check(batches.reduce((n, batch) => n + batch.rows, 0) === entries.length - (resume ? 10 : 0), 'Migration failed to resume at committed cursor');
          const hit = await cache.lookup({source: '<size=24>移行する台詞89</size>', context: 'AdvText'}, {target: '한국어'});
          check(hit?.text === '<size=24>이전된대사89</size>', 'Migrated dialogue index was not usable');
        } finally {
          IDBCursor.prototype.update = update; IDBObjectStore.prototype.put = put;
          await cache.destroy();
        }
      }
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
