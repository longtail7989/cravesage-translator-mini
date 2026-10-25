import test from 'node:test';
import assert from 'node:assert/strict';
import {cacheId, cacheIdV2, makeCacheEntry, portableEntry, normalizeCacheHeader, validateImport, validateTextPair, CACHE_FORMAT} from '../cache.mjs';

const row = async (source = '攻撃力が10%上昇する。', text = '공격력이 10% 상승합니다.', extra = {}) =>
  portableEntry(await makeCacheEntry({source, text, target: '한국어', context: 'skill', createdAt: 100, updatedAt: 100, ...extra}));
const file = entries => ({format: CACHE_FORMAT, version: 3, exportedAt: '2026-10-25T00:00:00.000Z', appVersion: '0.3.5', entries});

test('exact source code units and target partition portable identity', async () => {
  const id = await cacheId('한국어', 'ガ');
  assert.notEqual(id, await cacheId('한국어', 'ガ'));
  assert.notEqual(id, await cacheId('한국어', 'ガ '));
  assert.notEqual(id, await cacheId('English', 'ガ'));
  assert.equal((await row(undefined, undefined, {context: 'story'})).id, (await row()).id);
});

test('legacy context identities validate before canonical conversion and deterministic deduplication', async () => {
  const a = await row(undefined, '공격력이 10% 증가합니다.', {context: 'old', updatedAt: 200});
  a.id = await cacheIdV2(a.target, a.source, a.context);
  const b = await row();
  const first = await validateImport(file([a, b]));
  const second = await validateImport(file([b, a]));
  assert.deepEqual(first, second);
  assert.equal(first[0].text, a.text);
  assert.equal(first[0].id, await cacheId(a.target, a.source));
  await assert.rejects(validateImport(file([{...a, context: 'tampered'}])));
});

test('portable versions one through three round-trip manual edits', async () => {
  const edited = await row('固有名詞', '固有名詞', {manual: true});
  for (const version of [1, 2, 3]) {
    const [loaded] = await validateImport({...file([edited]), version});
    assert.equal(loaded.manual, true);
    assert.equal(loaded.text, '固有名詞');
    assert.equal(loaded.updatedAt, 100);
  }
});

test('numbers, markup, variables and exact newline sequence cannot change on edit or import', async () => {
  const source = '<b>攻撃10%</b>\r\n{value}３ターン';
  const translation = '<b>공격10%</b>\r\n{value}３턴';
  assert.equal(validateTextPair(source, translation), true);
  for (const text of [translation.replace('10%', '11%'), translation.replace('\r\n', '\n'), translation.replace('<b>', '<i>'), translation.replace('{value}', '{other}')]) {
    assert.throws(() => validateTextPair(source, text));
    await assert.rejects(validateImport(file([await row(source, translation).then(r => ({...r, text}))])));
  }
});

test('malformed identities, timestamps and unsupported metadata fail closed', async () => {
  const valid = await row();
  for (const invalid of [{...valid, id: 'v3:' + '0'.repeat(64)}, {...valid, updatedAt: 99}, {...valid, manual: 'true'}, {...valid, apiKey: 'not-permitted'}]) {
    await assert.rejects(validateImport(file([invalid])));
  }
});

test('manual correction wins over newer automatic translation within one imported file', async () => {
  const manual = await row(undefined, '공격력이 10% 수동 증가합니다.', {manual: true});
  const automatic = await row(undefined, '공격력이 10% 자동 증가합니다.', {updatedAt: 200});
  for (const entries of [[manual, automatic], [automatic, manual]]) {
    const [result] = await validateImport(file(entries));
    assert.equal(result.text, manual.text);
    assert.equal(result.manual, true);
  }
});

test('original popup JSON fallback accepts exportedAtISO and source identity without changing row metadata', async () => {
  const original = await row(undefined, undefined, {manual: true});
  const {exportedAt, ...data} = file([original]);
  const [loaded] = await validateImport({...data, identity: 'source-v3', exportedAtISO: exportedAt});
  assert.deepEqual(portableEntry(loaded), original);
});

test('original NDJSON headers accept the exportedAtISO spelling while rejecting ambiguous or unsupported metadata', () => {
  const legacy = {format: CACHE_FORMAT, version: 3, identity: 'source-v3', exportedAtISO: '2026-10-25T02:45:13.557Z', appVersion: '0.3.5'};
  assert.equal(normalizeCacheHeader(legacy, {stream: true}).exportedAt, legacy.exportedAtISO);
  const invalid = [
    {...legacy, exportedAt: '2026-10-26T00:00:00.000Z'},
    {...legacy, exportedAtISO: 'invalid'},
    {...legacy, version: 1},
    {...legacy, identity: 'unverified'},
    {...legacy, unknown: true}
  ];
  for (const header of invalid) assert.throws(() => normalizeCacheHeader(header, {stream: true}));
});

test('shared player names can move with localization but keep multiplicity and all other protected content', async () => {
  const source = '<b>{USER}</b>\n値{value}10%\n{USER}';
  const translated = '<b></b>\n{USER} 값{value}10%\n{USER}';
  const entry = await row(source, translated);
  const [loaded] = await validateImport(file([entry]));
  assert.equal(loaded.text, translated);
  for (const invalid of [
    translated.replace('{USER}', ''),
    translated + '{USER}',
    translated.replace('10%', '11%'),
    translated.replace('{value}', '{other}'),
    translated.replace('\n', '\r\n'),
    translated.replace('</b>', '</i>')
  ]) assert.throws(() => validateTextPair(source, invalid));
});
