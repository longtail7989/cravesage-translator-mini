const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const namePolicy = fs.readFileSync(path.join(__dirname, '../name-policy.js'), 'utf8');
const origin = 'https://gg-client-r.crave-saga.net';
function engine({full = false, profile = null} = {}) {
  const messages = [], listeners = new Map(), timers = new Map(); let timer = 0;
  class Base { get string() { return this._value || ''; } set string(value) { this._value = String(value); } }
  class Label extends Base {} class RichText extends Base {}
  const scene = {_components: [], children: [], parent: null};
  const add = (raw, Type = Label, parent = scene) => {
    const label = new Type(), node = {_components: [label], children: [], parent, activeInHierarchy: true};
    label.node = node; Object.assign(label, {font: {name: 'Japanese'}, fontFamily: 'JP', useSystemFont: false, cacheMode: 1});
    parent.children.push(node); label.string = raw; return label;
  };
  const label = add('こんにちは');
  const cc = {Label, RichText, isValid: () => true, director: {getScene: () => scene}};
  const window = {cc, postMessage: message => messages.push(message),
    __require(name) {
      if (name !== 'UserUtils') throw Error('Unexpected game module');
      return {getUserBasicData: () => profile && ({
        getMainCharacterName: () => { if (profile.error) throw Error('Profile not ready'); return profile.mainName; },
        getUserName: () => profile.accountName
      })};
    },
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); }};
  if (full) window[Symbol.for('crave-ai-translator.v1')] = {};
  const document = {hidden: false, getElementById: () => null, addEventListener() {}, removeEventListener() {}};
  const context = vm.createContext({window, document, location: {origin, pathname: '/client/test/index_dmm.html'},
    setTimeout(fn) { const id = ++timer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, console});
  vm.runInContext(namePolicy, context);
  vm.runInContext(source, context);
  const send = (type, payload = {}) => listeners.get('message')?.({source: window, origin, data: {channel: 'cravesage-translator-mini/v1', from: 'bridge', type, ...payload}});
  const configure = (cacheEpoch = 'one', enabled = true, target = '한국어', extra = {}) => send('CONFIG', {config: {enabled, target, fontFamily: 'KR', cacheEpoch, ready: true, ...extra}});
  const request = raw => messages.filter(m => m.type === 'LOOKUP' && m.item.source === raw).at(-1)?.item;
  const result = (item, text, cacheEpoch = 'one') => send('RESULT', {cacheEpoch, results: [{id: item.id, ...(text === null ? {missing: true} : {text})}]});
  return {label, add, scene, window, messages, configure, request, result, send, setProfile(value) { profile = value; },
    names: vm.runInContext("globalThis[Symbol.for('cravesage-translator-mini.names.v1')]", context),
    api: window[Symbol.for('cravesage-translator-mini.v1')]};
}

test('saved cache applies to Cocos labels and disabling restores exact source and style', () => {
  const e = engine(); e.configure();
  assert.equal(e.label.string, 'こんにちは');
  e.result(e.request('こんにちは'), '안녕하세요');
  assert.equal(e.label.string, '안녕하세요'); assert.equal(e.label.fontFamily, 'KR');
  e.label.string = e.label.string;
  e.configure('two', false);
  assert.equal(e.label.string, 'こんにちは'); assert.equal(e.label.fontFamily, 'JP'); assert.equal(e.label.useSystemFont, false);
});

test('late cache response never replaces newer dialogue; same source on new label reuses synchronously', () => {
  const e = engine(); e.configure(); const old = e.request('こんにちは');
  e.label.string = '別の文章'; e.result(old, '안녕하세요');
  assert.equal(e.label.string, '別の文章');
  const other = e.add('こんにちは'); assert.equal(other.string, '안녕하세요');
  assert.equal(e.label.string, '別の文章');
});

test('missing cache stays original without scan floods and a new revision retries it', () => {
  const e = engine(); e.configure(); e.result(e.request('こんにちは'), null);
  const before = e.messages.filter(m => m.type === 'LOOKUP').length;
  for (let i = 0; i < 10; i++) { e.label.string = 'こんにちは'; e.api.refresh(); }
  assert.equal(e.label.string, 'こんにちは'); assert.equal(e.messages.filter(m => m.type === 'LOOKUP').length, before);
  e.configure('two'); const fresh = e.request('こんにちは');
  assert.equal(e.messages.filter(m => m.type === 'LOOKUP').length, before + 1);
  e.result(fresh, '새 캐시 번역', 'two'); assert.equal(e.label.string, '새 캐시 번역');
});

test('import/edit/delete epoch invalidation rejects old responses and removes old displayed translation', () => {
  const e = engine(); e.configure(); const old = e.request('こんにちは'); e.result(old, '이전 번역');
  e.configure('two'); assert.equal(e.label.string, 'こんにちは');
  e.result(old, '오래된 번역'); assert.equal(e.label.string, 'こんにちは');
  e.result(e.request('こんにちは'), '수정 번역', 'two'); assert.equal(e.label.string, '수정 번역');
  e.configure('three'); e.result(e.request('こんにちは'), null, 'three'); assert.equal(e.label.string, 'こんにちは');
});

test('warm cache is target/epoch scoped and RichText generated children are not separately translated', () => {
  const e = engine();
  e.send('CONFIG', {config: {enabled: true, target: '한국어', fontFamily: 'KR', cacheEpoch: 'one', ready: false}});
  e.send('WARM', {cacheEpoch: 'one', entries: [{source: 'こんにちは', text: '준비 번역'}]}); e.configure();
  assert.equal(e.label.string, '준비 번역');
  const rich = e.add('<b>物語</b>', e.window.cc.RichText); const child = e.add('物語', e.window.cc.Label, rich.node);
  e.api.refresh(); assert(e.request('<b>物語</b>')); assert.equal(e.request('物語'), undefined); assert.equal(child.string, '物語');
  e.configure('two', true, 'English'); assert.equal(e.label.string, 'こんにちは');
});

test('full extension conflict fails closed without changing original setter or text', () => {
  const e = engine({full: true}); e.configure();
  assert.equal(e.api.status().stopped, true); assert.equal(e.label.string, 'こんにちは');
  assert.equal(e.messages.filter(m => m.type === 'LOOKUP').length, 0);
});

test('dispose restores original source and allows native game text writes', () => {
  const e = engine(); e.configure(); e.result(e.request('こんにちは'), '안녕하세요'); e.api.dispose();
  assert.equal(e.label.string, 'こんにちは'); assert.equal(e.label.fontFamily, 'JP');
  e.label.string = 'ゲーム継続'; assert.equal(e.label.string, 'ゲーム継続');
  assert.equal(e.window[Symbol.for('cravesage-translator-mini.v1')], undefined);
});

function warm(e, entries, extra = {}) {
  e.configure('one', true, '한국어', {...extra, ready: false});
  e.send('WARM', {cacheEpoch: 'one', entries});
  e.configure('one', true, '한국어', extra);
}

test('literal cache wins over a normalized nickname template', () => {
  const e = engine({profile: {mainName: 'Akira', accountName: 'Account'}});
  e.label.string = 'Akira、出発！';
  warm(e, [{source: 'Akira、出発！', text: '저장된 고유 번역'}, {source: '{USER}、出発！', text: '{USER}, 출발!'}]);
  assert.equal(e.label.string, '저장된 고유 번역');
  assert.equal(e.request('{USER}、出発！'), undefined);
});

test('different known names share one warm template and retain their own binding', () => {
  const e = engine({profile: {mainName: 'Akira', accountName: 'Ren'}});
  e.label.string = 'Akira、出発！';
  warm(e, [{source: '{USER}、出発！', text: '{USER}, 출발!'}]);
  const other = e.add('Ren、出発！');
  e.result(e.request('Akira、出発！'), null);
  e.result(e.request('Ren、出発！'), null);
  assert.equal(e.label.string, 'Akira, 출발!');
  assert.equal(other.string, 'Ren, 출발!');
  assert.equal(e.request('{USER}、出発！'), undefined);
  const again = e.add('Ren、出発！');
  assert.equal(again.string, 'Ren, 출발!');
});

test('repeated names containing replacement metacharacters render literally', () => {
  const e = engine({profile: {mainName: 'A$&'}});
  e.label.string = 'A$&とA$&';
  e.configure(); e.result(e.request('A$&とA$&'), null);
  const request = e.request('{USER}と{USER}');
  assert(request);
  e.result(request, '{USER} 그리고 {USER}');
  assert.equal(e.label.string, 'A$& 그리고 A$&');
});

test('late profile loading retries an initial miss without game writes or requests', () => {
  const e = engine();
  e.label.string = 'Mika、おはよう';
  e.configure(); e.result(e.request('Mika、おはよう'), null);
  assert.equal(e.api.status().nameReady, false);
  e.setProfile({mainName: 'Mika', accountName: 'Account'});
  e.api.refresh();
  assert.equal(e.api.status().nameReady, true);
  assert.equal(e.api.status().nameSource, 'mainCharacterName');
  e.result(e.request('Mika、おはよう'), null);
  e.result(e.request('{USER}、おはよう'), '{USER}, 좋은 아침');
  assert.equal(e.label.string, 'Mika, 좋은 아침');
});

test('profile changes reject stale template responses and bind only current game names', () => {
  const e = engine({profile: {mainName: 'First'}});
  e.label.string = 'First、出発！'; e.configure();
  e.result(e.request('First、出発！'), null);
  const old = e.request('{USER}、出発！');
  e.setProfile({mainName: 'Second'}); e.api.refresh();
  assert.equal(e.label.string, 'First、出発！');
  e.result(old, '{USER}, 오래된 번역');
  assert.equal(e.label.string, 'First、出発！');
  e.label.string = 'Second、出発！';
  e.result(e.request('Second、出発！'), null);
  const fresh = e.request('{USER}、出発！');
  assert.notEqual(fresh.id, old.id);
  e.result(fresh, '{USER}, 출발!');
  assert.equal(e.label.string, 'Second, 출발!');
  assert.equal(e.add('First、出発！').string, 'First、出発！');
});

test('explicit source and display overrides reset bindings and blank display restores matched name', () => {
  const e = engine({profile: {mainName: 'GameName'}});
  e.label.string = 'TestName、出発！';
  e.configure('one', true, '한국어', {playerName: 'TestName', displayName: '표시$&'});
  assert.equal(e.api.status().nameSource, 'override');
  e.result(e.request('TestName、出発！'), null);
  const old = e.request('{USER}、出発！');
  e.configure('one', true, '한국어', {playerName: 'NextName', displayName: '표시$&'});
  e.result(old, '{USER}, 오래된 번역');
  assert.equal(e.label.string, 'TestName、出発！');
  e.label.string = 'NextName、出発！';
  e.result(e.request('NextName、出発！'), null);
  e.result(e.request('{USER}、出発！'), '{USER}, 출발!');
  assert.equal(e.label.string, '표시$&, 출발!');
  e.configure('one', true, '한국어', {playerName: 'NextName', displayName: ''});
  assert.equal(e.label.string, 'NextName、出発！');
  e.result(e.request('NextName、出発！'), null);
  e.result(e.request('{USER}、出発！'), '{USER}, 출발!');
  assert.equal(e.label.string, 'NextName, 출발!');
});

test('unknown names never expose an unresolved nickname token', () => {
  const e = engine();
  e.configure(); e.result(e.request('こんにちは'), '{USER}, 안녕하세요');
  assert.equal(e.label.string, 'こんにちは');
  const other = e.add('{USER}、出発！');
  e.result(e.request('{USER}、出発！'), '{USER}, 출발!');
  assert.equal(other.string, '{USER}、出発！');
  assert.equal(e.api.status().nameReady, false);
});

test('nickname matching preserves tag attributes and unrelated game variables', () => {
  const e = engine({profile: {mainName: 'Aki'}});
  const raw = '<color name="Aki">Aki {OTHER} {Aki}</color>';
  e.label.string = raw; e.configure(); e.result(e.request(raw), null);
  const request = e.request('<color name="Aki">{USER} {OTHER} {Aki}</color>');
  assert(request);
  e.result(request, '<b>{USER}</b> {OTHER} {Aki}');
  assert.equal(e.label.string, '<b>Aki</b> {OTHER} {Aki}');
});

test('shared converter policy uses longest literal alias without cascading existing variables', () => {
  const {names} = engine();
  assert.equal(names.replaceNames('<b title=">" data-name="Anna">Anna</b>', ['Anna']), '<b title=">" data-name="Anna">{USER}</b>');
  assert.equal(names.replaceNames('<b data-name="Anna">Anna Ann {Anna} {USER}</b>', ['Ann', 'Anna', 'USER']),
    '<b data-name="Anna">{USER} {USER} {Anna} {USER}</b>');
  assert.equal(names.render('{USER} {OTHER} {USER}', '$&'), '$& {OTHER} $&');
  assert.equal(names.render('{USER}', ''), null);
  assert.equal(names.candidates('No nickname here', ['Anna']).length, 0);
});

test('account name remains available when the protagonist getter is not ready', () => {
  const e = engine({profile: {error: true, accountName: 'AccountName'}});
  e.label.string = 'AccountName、出発！'; e.configure();
  assert.equal(e.api.status().nameSource, 'userName');
  e.result(e.request('AccountName、出発！'), null);
  e.result(e.request('{USER}、出発！'), '{USER}, 출발!');
  assert.equal(e.label.string, 'AccountName, 출발!');
});

test('template word order may move the name across preserved line breaks', () => {
  const e = engine({profile: {mainName: 'Mika'}});
  e.label.string = '一行目\n二行目\nMika、出発！\n';
  e.configure(); e.result(e.request('一行目\n二行目\nMika、出発！\n'), null);
  e.result(e.request('一行目\n二行目\n{USER}、出発！\n'), '{USER}, 출발!\n첫째 줄\n둘째 줄\n');
  assert.equal(e.label.string, 'Mika, 출발!\n첫째 줄\n둘째 줄\n');
});
