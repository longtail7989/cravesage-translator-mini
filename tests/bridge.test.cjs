const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const origin = 'https://gg-client-r.crave-saga.net';
const dialogue = fs.readFileSync(path.join(__dirname, '../dialogue-text.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
async function bridge({warm = [], lookup} = {}) {
  const outgoing = [], calls = [], listeners = new Map(), timers = new Map();
  let sequence = 0;
  const config = {enabled: true, target: '한국어', fontFamily: '', playerName: '', displayName: '', cacheEpoch: 'one'};
  const window = {
    postMessage: message => outgoing.push(message),
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: type => listeners.delete(type)
  };
  const chrome = {runtime: {
    id: 'mini-test',
    onMessage: {addListener() {}, removeListener() {}},
    async sendMessage(message) {
      calls.push(message);
      if (message.type === 'PUBLIC_CONFIG') return {ok: true, config};
      if (message.type === 'CACHE_WARM') return {ok: true, entries: warm, cacheEpoch: 'one'};
      if (message.type === 'CACHE_LOOKUP') return {ok: true, cacheEpoch: 'one', results: await lookup(message.items)};
      throw Error('Unexpected request ' + message.type);
    }
  }};
  const context = vm.createContext({window, chrome, location: {origin, pathname: '/client/test/index_dmm.html'},
    setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }, console});
  vm.runInContext(dialogue, context);
  await vm.runInContext(source, context);
  const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  await settle();
  const request = (id, context = '', exactOnly = false) => listeners.get('message')({source: window, origin,
    data: {channel: 'cravesage-translator-mini/v1', from: 'engine', type: 'LOOKUP', cacheEpoch: 'one', item: {id, source: '同じ文章', context, exactOnly}}});
  const flush = async () => {
    const scheduled = [...timers.values()]; timers.clear();
    for (const callback of scheduled) callback();
    await settle();
  };
  const result = id => outgoing.flatMap(message => message.results || []).find(item => item.id === id);
  return {outgoing, calls, request, flush, result};
}

test('story fallback and generic exact lookup do not share pending requests or cached results', async () => {
  const b = await bridge({lookup: items => items.map(item => item.context === 'AdvText'
    ? {id: item.id, text: '대사 전용 재사용 번역'} : {id: item.id, missing: true})});
  b.request('g1r1', 'AdvText'); b.request('g1r2'); await b.flush();
  assert.equal(b.result('g1r1').text, '대사 전용 재사용 번역');
  assert.equal(b.result('g1r2').missing, true);
  b.request('g1r3', 'AdvText'); b.request('g1r4');
  assert.equal(b.result('g1r3').text, '대사 전용 재사용 번역');
  assert.equal(b.result('g1r4').missing, true);
  assert.equal(b.calls.filter(message => message.type === 'CACHE_LOOKUP').flatMap(message => message.items).length, 2);
});

test('a generic miss cannot suppress a later story fallback lookup', async () => {
  const b = await bridge({lookup: items => items.map(item => item.context === 'AdvText'
    ? {id: item.id, text: '백로그와 공유하는 대사'} : {id: item.id, missing: true})});
  b.request('g1r1'); await b.flush(); assert.equal(b.result('g1r1').missing, true);
  b.request('g1r2', 'AdvText'); await b.flush();
  assert.equal(b.result('g1r2').text, '백로그와 공유하는 대사');
});

test('exact warm entries remain available to both story and generic labels', async () => {
  const b = await bridge({warm: [{source: '同じ文章', text: '정확한 저장 번역', target: '한국어'}],
    lookup: () => { throw Error('An exact warm hit must not query storage'); }});
  b.request('g1r1', 'AdvText'); b.request('g1r2');
  assert.equal(b.result('g1r1').text, '정확한 저장 번역');
  assert.equal(b.result('g1r2').text, '정확한 저장 번역');
  assert.equal(b.calls.some(message => message.type === 'CACHE_LOOKUP'), false);
  const warm = b.outgoing.filter(message => message.type === 'WARM').flatMap(message => message.entries);
  assert.equal(warm[0].source, '同じ文章');
});

test('a story fallback cannot masquerade as an exact hit or suppress a later fallback after an exact miss', async () => {
  const b = await bridge({lookup: items => items.map(item => item.exactOnly
    ? {id: item.id, missing: true} : {id: item.id, text: '형식만 다른 대사 번역'})});
  b.request('g1r1', 'AdvText', true); b.request('g1r2', 'AdvText', false); await b.flush();
  assert.equal(b.result('g1r1').missing, true);
  assert.equal(b.result('g1r2').text, '형식만 다른 대사 번역');
  b.request('g1r3', 'AdvText', true); b.request('g1r4', 'AdvText', false);
  assert.equal(b.result('g1r3').missing, true);
  assert.equal(b.result('g1r4').text, '형식만 다른 대사 번역');
});
