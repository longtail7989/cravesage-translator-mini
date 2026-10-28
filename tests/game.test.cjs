const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const namePolicy = fs.readFileSync(path.join(__dirname, '../name-policy.js'), 'utf8');
const dialoguePolicy = fs.readFileSync(path.join(__dirname, '../dialogue-text.js'), 'utf8');
const storyPolicy = fs.readFileSync(path.join(__dirname, '../story-text.js'), 'utf8');
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
  class AdvText extends Label {
    getPlaneText() { return this._planeText; }
    getMaxLength() { return this._planeText.length; }
  }
  class AdvTextExtension extends AdvText {}
  class AdvRichBackLogText extends RichText {}
  const cc = {Label, RichText, AdvText, AdvTextExtension, AdvRichBackLogText, isValid: value => !value.destroyed,
    js: {getClassName: value => value instanceof AdvTextExtension ? 'AdvTextExtension' : value instanceof AdvText ? 'AdvText' : value instanceof AdvRichBackLogText ? 'AdvRichBackLogText' : value instanceof RichText ? 'cc.RichText' : 'cc.Label'},
    director: {getScene: () => scene}};
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
  vm.runInContext(dialoguePolicy, context);
  vm.runInContext(storyPolicy, context);
  vm.runInContext(source, context);
  const send = (type, payload = {}) => listeners.get('message')?.({source: window, origin, data: {channel: 'cravesage-translator-mini/v1', from: 'bridge', type, ...payload}});
  const configure = (cacheEpoch = 'one', enabled = true, target = '한국어', extra = {}) => send('CONFIG', {config: {enabled, target, fontFamily: 'KR', cacheEpoch, ready: true, ...extra}});
  const request = (raw, story, exactOnly) => messages.filter(m => m.type === 'LOOKUP' && m.item.source === raw && (story === undefined || /AdvText|AdvRichBackLogText/.test(m.item.context) === story) && (exactOnly === undefined || m.item.exactOnly === exactOnly)).at(-1)?.item;
  const result = (item, text, cacheEpoch = 'one') => send('RESULT', {cacheEpoch, results: [{id: item.id, ...(text === null ? {missing: true} : {text})}]});
  return {label, add, scene, window, messages, configure, request, result, send, setProfile(value) { profile = value; },
    names: vm.runInContext("globalThis[Symbol.for('cravesage-translator-mini.names.v1')]", context),
    api: window[Symbol.for('cravesage-translator-mini.v1')]};
}

function story(e, full, shown = 0, Type = e.window.cc.AdvText) {
  const label = e.add('', Type);
  label._planeText = full;
  label._dispLength = shown;
  label.string = full.slice(0, shown);
  return label;
}
function frame(label, shown, full = label._planeText) {
  label._planeText = full; label._dispLength = shown; label.string = full.slice(0, shown);
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

test('verified native story requests only the complete source at zero and reveals cached full text progressively', () => {
  const e = engine(), full = 'あいうえおかきくけこ', target = '가나다라마바사아자차';
  const label = story(e, full);
  e.configure();
  const request = e.request(full, true);
  assert(request); assert.equal(e.request('あ'), undefined);
  e.result(request, target);
  assert.equal(label.string, '');
  const requests = e.messages.filter(message => message.type === 'LOOKUP').length;
  frame(label, 1); assert.equal(label.string, '가');
  frame(label, 3); assert.equal(label.string, '가나다');
  frame(label, 7); assert.equal(label.string, '가나다라마바사');
  frame(label, 0); assert.equal(label.string, '');
  frame(label, full.length); assert.equal(label.string, target);
  assert.equal(e.messages.filter(message => message.type === 'LOOKUP').length, requests);
  assert.equal(label._dispLength, full.length); assert.equal(label.getPlaneText(), full);
  const again = story(e, full, 1, e.window.cc.AdvTextExtension);
  assert.equal(again.string, '가');
  frame(again, full.length); assert.equal(again.string, target, 'memory retains the full translation, not its last visible fragment');
});

test('late story responses use current native progress without restarting completed dialogue', () => {
  const e = engine(), full = 'あいうえおかきくけこ';
  const label = story(e, full, 1); e.configure(); const pending = e.request(full);
  frame(label, 6); e.result(pending, '가나다라마바사아자차');
  assert.equal(label.string, '가나다라마바');
  const second = 'さしすせそたちつてと'; frame(label, 1, second);
  const late = e.request(second); frame(label, second.length);
  e.result(late, '늦은 번역 전체'); assert.equal(label.string, '늦은 번역 전체');
});

test('shared native prefix collisions reject stale full-source responses before scans and preserve the next dialogue', () => {
  const e = engine(), first = '同じ始まり、最初の文章。', second = '同じ始まり、次の文章。';
  const label = story(e, first, 1); e.configure(); const old = e.request(first);
  label._planeText = second; label._dispLength = 1;
  e.result(old, '이전 대사의 번역');
  assert.equal(label.string, '同'); assert(e.request(second));
  e.result(e.request(second), '새로운 대사 전체');
  assert.equal(label.string, '새');
  frame(label, second.length); assert.equal(label.string, '새로운 대사 전체');
  frame(label, 1, first); assert.equal(label.string, '이', 'a stale result may populate full-source memory, never the wrong current record');
});

test('off, delete, name change, target change and dispose restore native prefixes rather than the complete Japanese source', () => {
  for (const change of ['off', 'delete', 'name', 'target', 'dispose']) {
    const e = engine(), full = 'あいうえおかきくけこ', label = story(e, full, 3);
    e.configure(); e.result(e.request(full), '가나다라마바사아자차'); assert.equal(label.string, '가나다');
    if (change === 'off') e.configure('one', false);
    if (change === 'delete') { e.configure('two'); e.result(e.request(full), null, 'two'); }
    if (change === 'name') e.configure('one', true, '한국어', {displayName: '다른 이름'});
    if (change === 'target') e.configure('one', true, 'English');
    if (change === 'dispose') e.api.dispose();
    assert.equal(label.string, 'あいう', change);
    assert.equal(label.fontFamily, 'JP', change);
    assert.equal(label.getPlaneText(), full); assert.equal(label._dispLength, 3);
  }
});

test('native bypass writes and new dialogue retain their own prefix during reset and misses', () => {
  const e = engine(), full = 'あいうえおかきくけこ', label = story(e, full, 2);
  e.configure(); e.result(e.request(full), '가나다라마바사아자차');
  label._value = 'ゲームの新しい書込み'; e.configure('one', false);
  assert.equal(label.string, 'ゲームの新しい書込み');
  e.configure(); frame(label, 3, 'かきくけこさしすせそ');
  e.result(e.request('かきくけこさしすせそ'), null);
  assert.equal(label.string, 'かきく');
  frame(label, 5); assert.equal(label.string, 'かきくけこ');
});

test('story projection keeps newline, emoji, combining graphemes, tags and variables whole', () => {
  const e = engine(), full = 'あ'.repeat(20), label = story(e, full, 0);
  const target = '<color="#ff00aa"><b>가👨‍👩‍👧‍👦</b>{OTHER}\r\n나</color><i>끝</i>';
  e.configure(); e.result(e.request(full), target);
  assert.equal(label.string, '');
  for (const [shown, expected] of [
    [1, '<color="#ff00aa"><b>가</b></color>'],
    [7, '<color="#ff00aa"><b>가👨‍👩‍👧‍👦</b></color>'],
    [10, '<color="#ff00aa"><b>가👨‍👩‍👧‍👦</b>{OTHER}</color>'],
    [14, '<color="#ff00aa"><b>가👨‍👩‍👧‍👦</b>{OTHER}\r\n</color>'],
    [17, '<color="#ff00aa"><b>가👨‍👩‍👧‍👦</b>{OTHER}\r\n나</color>'],
    [20, target]
  ]) { frame(label, shown); assert.equal(label.string, expected); }
  const second = story(e, 'い'.repeat(10), 1);
  e.result(e.request('い'.repeat(10)), '<b>ᄒ</b>ᅡᆫ<i>👩🏽‍</i>🚀끝');
  assert.equal(second.string, '<b>ᄒ</b>ᅡᆫ');
  frame(second, 7); assert.equal(second.string, '<b>ᄒ</b>ᅡᆫ<i>👩🏽‍</i>🚀');
});

test('unknown native progress and static backlog display the complete stored value without animation', () => {
  const e = engine(), full = 'あいうえおかきくけこ', target = '<b>한국어 전체</b>';
  const label = story(e, full, 1); e.configure(); e.result(e.request(full), target);
  assert.equal(label.string, '<b>한</b>');
  label._dispLength = NaN; label.string = full;
  assert.equal(label.string, target);
  const backlog = e.add(full, e.window.cc.AdvRichBackLogText);
  assert.equal(backlog.string, target);
  e.api.refresh(); assert.equal(backlog.string, target);
});

test('story-only fallback memory, misses and pending lookups never leak into generic UI', () => {
  const e = engine(), source = '共有の文章', label = story(e, source, source.length);
  e.configure(); const storyRequest = e.request(source, true);
  const generic = e.add(source); const genericRequest = e.request(source, false);
  assert(storyRequest); assert(genericRequest); assert.notEqual(storyRequest.id, genericRequest.id);
  assert.equal(storyRequest.exactOnly, true);
  e.result(storyRequest, null);
  const fallbackRequest = e.request(source, true, false);
  assert(fallbackRequest); assert.notEqual(fallbackRequest.id, storyRequest.id);
  e.result(fallbackRequest, '스토리 재사용');
  assert.equal(label.string, '스토리 재사용'); assert.equal(generic.string, source);
  e.result(genericRequest, null); assert.equal(generic.string, source);
  assert.equal(e.add(source).string, source);
  assert.equal(story(e, source, source.length).string, '스토리 재사용');
});

test('warm exact values stay whole and beat context fallback results without becoming fallback keys', () => {
  const e = engine(), source = '共有の文章', label = story(e, source, 1);
  warm(e, [{source, text: '정확한 캐시 전체'}]);
  assert.equal(label.string, '정');
  assert.equal(e.add(source).string, '정확한 캐시 전체');
  assert.equal(e.add(source, e.window.cc.AdvRichBackLogText).string, '정확한 캐시 전체');
  frame(label, source.length); assert.equal(label.string, '정확한 캐시 전체');
});

test('literal manual backlog names use only their bound alias in display overrides and retain other names/tags', () => {
  const e = engine({profile: {mainName: 'Akira', accountName: 'Ren'}});
  const first = 'Akira、出発！', second = 'Ren、出発！';
  e.label.string = first;
  warm(e, [{source: first, text: '<b title="Akira">Akira</b>와 Ren {Akira}'}, {source: second, text: 'Ren와 Akira'}], {displayName: '표시$&'});
  const other = e.add(second, e.window.cc.AdvRichBackLogText);
  assert.equal(e.label.string, '<b title="Akira">표시$&</b>와 Ren {Akira}');
  assert.equal(other.string, '표시$&와 Akira');
  e.configure('one', true, '한국어', {displayName: ''});
  e.result(e.request(first), '<b title="Akira">Akira</b>와 Ren {Akira}');
  e.result(e.request(second), 'Ren와 Akira');
  assert.equal(e.label.string, '<b title="Akira">Akira</b>와 Ren {Akira}');
  assert.equal(other.string, 'Ren와 Akira');
  e.setProfile({mainName: 'Next', accountName: 'Other'}); e.api.refresh();
  e.configure('one', true, '한국어', {displayName: '새표시'});
  e.label.string = 'Next、出発！';
  e.result(e.request('Next、出発！'), 'Next와 Akira');
  assert.equal(e.label.string, '새표시와 Akira');
});

test('personalized story templates stay complete across native ticks and two independently bound users', () => {
  const e = engine({profile: {mainName: 'Akira', accountName: 'Ren'}});
  const first = 'Akira、冒険へ出発！', second = 'Ren、冒険へ出発！', target = '<b>{USER}</b>, 모험을 떠나자!';
  const label = story(e, first, 0);
  warm(e, [{source: '{USER}、冒険へ出発！', text: target}]);
  e.result(e.request(first), null); assert.equal(label.string, '');
  frame(label, 1); assert.equal(label.string, '<b>A</b>');
  frame(label, first.length); assert.equal(label.string, '<b>Akira</b>, 모험을 떠나자!');
  const other = story(e, second, 0);
  e.result(e.request(second), null); assert.equal(other.string, '');
  frame(other, second.length); assert.equal(other.string, '<b>Ren</b>, 모험을 떠나자!');
  const backlog = e.add(first, e.window.cc.AdvRichBackLogText);
  e.result(e.request(first, true), null);
  assert.equal(backlog.string, '<b>Akira</b>, 모험을 떠나자!');
  assert.equal(label.getPlaneText(), first); assert.equal(other.getPlaneText(), second);
});

test('unverified metadata cannot promote a native prefix into a full source request', () => {
  for (const alter of [
    label => { label._dispLength = NaN; },
    label => { label._dispLength = -1; },
    label => { label._dispLength = 100; },
    label => { label.getMaxLength = () => 100; },
    label => { label.getPlaneText = () => { throw Error('not ready'); }; },
    label => { label.getPlaneText = () => '別の文章'; }
  ]) {
    const e = engine(), full = 'あいうえお', label = story(e, full, 1);
    alter(label); e.configure();
    assert.equal(e.request(full), undefined); assert(e.request('あ'));
    e.result(e.request('あ'), '검증되지 않은 전체 번역');
    assert.equal(label.string, '검증되지 않은 전체 번역');
  }
});

test('a profile change arriving just before a result rejects the old name binding', () => {
  const e = engine({profile: {mainName: 'First'}});
  e.label.string = 'First、出発！'; e.configure(); e.result(e.request('First、出発！'), null);
  const old = e.request('{USER}、出発！');
  e.setProfile({mainName: 'Second'}); e.result(old, '{USER}, 오래된 이름');
  assert.equal(e.label.string, 'First、出発！');
  e.label.string = 'Second、出発！'; e.result(e.request('Second、出発！'), null);
  e.result(e.request('{USER}、出発！'), '{USER}, 출발!');
  assert.equal(e.label.string, 'Second, 출발!');
});

test('retained typing plans are budgeted and released when native typing completes', () => {
  const e = engine(), full = 'あ'.repeat(20), target = '가'.repeat(20);
  const label = story(e, full, 0); e.configure(); e.result(e.request(full), target);
  const typing = e.api.status().memoryBytes;
  assert(typing >= target.length * 64, 'status includes conservative per-unit plan allocations');
  frame(label, full.length);
  assert.equal(label.string, target);
  assert(e.api.status().memoryBytes < typing, 'completion releases the cached plan, not just its visible prefix');
  assert(e.api.status().memoryBytes <= 8 * 1024 * 1024);
  assert(e.api.status().entries <= 5000);
});

test('all exact literal and USER candidates precede raw manual-backlog fallback', () => {
  const e = engine({profile: {mainName: 'Akira'}});
  const raw = 'Akira、冒険へ\n出発！', canonical = '{USER}、冒険へ\n出発！';
  const cacheRows = new Map([
    [raw, {exact: null, fallback: 'Akira, 가져온 수동 백로그 문장!'}],
    [canonical, {exact: '{USER}, 팝업에서 편집한 정확한 문장!', fallback: null}]
  ]);
  const answer = item => e.result(item, cacheRows.get(item.source)[item.exactOnly ? 'exact' : 'fallback']);
  const label = story(e, raw, raw.length);
  e.configure();
  const literal = e.request(raw, true, true);
  assert(literal); assert.equal(e.request(raw, true, false), undefined);
  answer(literal);
  const template = e.request(canonical, true, true);
  assert(template);
  assert.equal(e.request(raw, true, false), undefined, 'manual backlog reuse must wait for exact USER lookup');
  answer(template);
  assert.equal(label.string, 'Akira, 팝업에서 편집한 정확한 문장!');
  assert.equal(e.request(raw, true, false), undefined, 'exact canonical entry wins without consulting fallback');
});

test('dialogue reuse starts only after every exact candidate misses and keeps phase-scoped memory', () => {
  const e = engine({profile: {mainName: 'Akira', accountName: 'Ren'}});
  const raw = 'Akira와Ren、出発！', first = '{USER}와Ren、出発！', second = 'Akira와{USER}、出発！';
  const label = story(e, raw, raw.length);
  e.configure();
  e.result(e.request(raw, true, true), null);
  assert.equal(e.request(raw, true, false), undefined);
  e.result(e.request(first, true, true), null);
  assert.equal(e.request(raw, true, false), undefined);
  e.result(e.request(second, true, true), null);
  const fallback = e.request(raw, true, false);
  assert(fallback); assert.notEqual(fallback.id, e.request(raw, true, true).id);
  e.result(fallback, 'Akira와Ren, 수동 백로그 재사용!');
  assert.equal(label.string, 'Akira와Ren, 수동 백로그 재사용!');
  const again = story(e, raw, raw.length);
  assert.equal(again.string, 'Akira와Ren, 수동 백로그 재사용!', 'fallback memory must survive exact-phase negative memory');
  assert.equal(e.add(raw).string, raw, 'generic UI cannot consume either story lookup phase');
});
