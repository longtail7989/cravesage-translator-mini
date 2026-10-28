import {importCacheFile, exportCacheFile} from './file-transfer.mjs';
import {VERSION, sanitizeSettings} from './core.mjs';

const $ = id => document.getElementById(id);
const number = value => new Intl.NumberFormat('ko-KR').format(value);
let loaded = false, busy = false, savedSettings = null, selected = null, selectionVersion = null;
let searchRequest = null, nextCursor = null, scannedTotal = 0, transferController = null;
let reloadRequired = false;

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({type, ...payload});
  if (!response || response.ok !== true) throw Object.assign(new Error(response?.error || '백그라운드에 연결하지 못했습니다. 확장을 다시 열어 주세요.'), {code: response?.code});
  return response;
}
function status(message, kind = 'info') {
  $('status').textContent = message;
  $('status').dataset.kind = kind;
}
function fail(error) {
  if (error?.name === 'AbortError') status('작업을 취소했습니다. 완료된 백업이 아닌 파일은 사용하지 마세요.');
  else status(error?.message || String(error), 'error');
}
function updateCount(response) {
  if (Number.isSafeInteger(response?.cacheCount)) $('cacheCount').textContent = number(response.cacheCount);
}
function syncControls() {
  document.querySelectorAll('button,input,select,textarea').forEach(element => {
    if (element.id === 'cancelTransfer') element.disabled = !transferController || transferController.signal.aborted;
    else if (element.id === 'retryLoad' || element.id === 'reloadExtension') element.disabled = busy;
    else element.disabled = busy || !loaded;
  });
  $('searchNext').disabled = busy || !loaded || nextCursor === null;
  $('conflictPolicy').disabled = busy || !loaded || $('importMode').value !== 'merge';
  $('conflictField').hidden = $('importMode').value !== 'merge';
  $('main').setAttribute('aria-busy', String(busy));
  $('cancelTransfer').hidden = !transferController;
}
async function run(action) {
  if (busy || !loaded) return;
  busy = true;
  syncControls();
  try { await action(); }
  catch (error) { fail(error); }
  finally { busy = false; syncControls(); }
}
function isDirty() { return selected && $('entryText').value !== selected.text; }
function discardDraft() { return !isDirty() || window.confirm('저장하지 않은 번역 초안을 버릴까요? 필요한 내용은 먼저 복사해 두세요.'); }
function clearSelection() {
  selected = null;
  selectionVersion = null;
  $('editForm').hidden = true;
  $('entrySource').value = '';
  $('entryTarget').value = '';
  $('entryText').value = '';
  $('conflictNotice').hidden = true;
  for (const button of $('searchResults').querySelectorAll('button')) button.setAttribute('aria-pressed', 'false');
}
function showEntry(response) {
  const entry = response.entry;
  if (!entry || typeof entry.text !== 'string' || typeof entry.source !== 'string' || typeof entry.target !== 'string') throw new Error('항목을 불러오지 못했습니다. 삭제되었을 수 있습니다.');
  selected = entry;
  selectionVersion = response.version || {updatedAt: entry.updatedAt, text: entry.text};
  $('entrySource').value = entry.source;
  $('entryTarget').value = entry.target;
  $('entryText').value = entry.text;
  $('entryText').maxLength = Math.max(512, entry.source.length * 6);
  const time = new Date(entry.updatedAt);
  $('entryMeta').textContent = (entry.manual ? '수동 수정 · ' : '') + (Number.isFinite(time.getTime()) ? time.toLocaleString('ko-KR') : '');
  $('editForm').hidden = false;
  $('conflictNotice').hidden = true;
  for (const button of $('searchResults').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === entry.id));
}
async function fetchSelection(id) {
  const response = await send('CACHE_GET', {id});
  if (!response.entry) { clearSelection(); throw new Error('이 번역이 삭제되었습니다. 다시 검색해 주세요.'); }
  showEntry(response);
}
function casPayload() {
  return {id: selected.id, source: selected.source, target: selected.target, expectedUpdatedAt: selectionVersion.updatedAt, expectedText: selectionVersion.text};
}
function mutationFailure(error) {
  if (error?.code === 'CONFLICT') {
    $('conflictNotice').hidden = false;
    status('저장된 항목이 달라 작업을 반영하지 않았습니다. 초안은 유지했습니다. 최신 항목을 다시 불러오려면 아래 버튼을 누르세요.', 'error');
  } else if (error?.code === 'INVALID') {
    status('번역문을 저장하지 못했습니다. 글자 수와 수치·태그·변수·줄바꿈의 내용 및 순서를 확인하세요. 초안은 유지했습니다.', 'error');
  } else fail(error);
}
function invalidateSearch() {
  searchRequest = null;
  nextCursor = null;
  scannedTotal = 0;
  $('searchResults').replaceChildren();
  $('searchNext').hidden = true;
  $('searchSummary').textContent = '캐시가 변경되었습니다. 다시 검색하면 최신 내용을 확인할 수 있습니다.';
}
function renderResults(results) {
  const fragment = document.createDocumentFragment();
  for (const entry of results) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'result-button';
    button.dataset.id = entry.id;
    button.setAttribute('aria-pressed', String(selected?.id === entry.id));
    const source = document.createElement('span');
    source.className = 'result-source';
    source.textContent = entry.sourcePreview;
    const text = document.createElement('span');
    text.className = 'result-text';
    text.textContent = entry.textPreview;
    const meta = document.createElement('span');
    meta.className = 'result-meta';
    meta.textContent = entry.target + (entry.manual ? ' · 수동 수정' : '');
    button.append(source, text, meta);
    button.addEventListener('click', () => {
      if (busy || !discardDraft()) return;
      void run(async () => { await fetchSelection(entry.id); status('번역문을 수정한 뒤 저장하세요. 원문과 대상 언어는 변경할 수 없습니다.'); });
    });
    item.append(button);
    fragment.append(item);
  }
  $('searchResults').replaceChildren(fragment);
}
async function searchPage(cursor) {
  const response = await send('CACHE_SEARCH', {...searchRequest, cursor, limit: 20});
  if (!Array.isArray(response.results) || response.results.length > 20 || typeof response.done !== 'boolean' || (!response.done && (typeof response.cursor !== 'string' || response.cursor === cursor))) throw new Error('검색 페이지 응답이 올바르지 않습니다. 다시 검색해 주세요.');
  updateCount(response);
  scannedTotal += response.scanned || 0;
  nextCursor = response.done ? null : response.cursor;
  renderResults(response.results);
  $('searchNext').hidden = response.done;
  $('searchSummary').textContent = `이 범위 ${number(response.results.length)}개 일치 · 누적 ${number(scannedTotal)}개 확인` + (response.done ? ' · 마지막 범위입니다.' : ' · 다음 범위에 결과가 더 있을 수 있습니다.');
}
async function load() {
  if (busy) return;
  busy = true;
  syncControls();
  try {
    const response = await send('GET_STATE');
    reloadRequired = response.version !== VERSION || response.capabilities?.cacheClear !== true || response.capabilities?.warningImports !== true;
    $('reloadNotice').hidden = !reloadRequired;
    if (reloadRequired) {
      loaded = false;
      $('version').textContent = `팝업 v${VERSION} / 백그라운드 v${response.version ?? '알 수 없음'}`;
      updateCount(response);
      $('retryLoad').hidden = true;
      status('실행 중인 백그라운드가 현재 팝업과 맞지 않습니다. 상단의 확장 다시 로드를 누른 뒤 팝업을 다시 여세요. 캐시와 설정은 유지됩니다.', 'error');
      return;
    }
    savedSettings = response.settings;
    $('enabled').checked = savedSettings.enabled;
    $('target').value = savedSettings.target;
    $('fontFamily').value = savedSettings.fontFamily;
    $('playerName').value = savedSettings.playerName ?? '';
    $('displayName').value = savedSettings.displayName ?? '';
    $('searchTarget').value = savedSettings.target;
    $('version').textContent = 'v' + response.version;
    updateCount(response);
    loaded = true;
    $('retryLoad').hidden = true;
    status('준비되었습니다. 캐시 파일을 가져오거나 저장된 번역을 검색하세요.');
  } catch (error) { fail(error); $('retryLoad').hidden = false; }
  finally { busy = false; syncControls(); }
}

$('settingsForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!$('settingsForm').reportValidity()) return;
  void run(async () => {
    const settings = {enabled: $('enabled').checked, target: $('target').value.trim(), fontFamily: $('fontFamily').value.trim(), playerName: $('playerName').value, displayName: $('displayName').value};
    if (!settings.target) throw new Error('대상 언어를 입력하세요.');
    const response = await send('SAVE_SETTINGS', {settings: sanitizeSettings(settings)});
    savedSettings = response.config || settings;
    $('enabled').checked = savedSettings.enabled;
    $('target').value = savedSettings.target;
    $('fontFamily').value = savedSettings.fontFamily;
    $('playerName').value = savedSettings.playerName ?? '';
    $('displayName').value = savedSettings.displayName ?? '';
    $('settingsHint').textContent = '저장한 설정이 게임에 적용됩니다.';
    status('설정을 저장했습니다. ' + (savedSettings.enabled ? '일치하는 캐시 번역을 적용합니다.' : '게임에는 원문을 표시합니다.'), 'success');
  });
});
for (const id of ['enabled', 'target', 'fontFamily', 'playerName', 'displayName']) $(id).addEventListener('input', () => { $('settingsHint').textContent = '변경 사항이 아직 저장되지 않았습니다.'; });
$('importMode').addEventListener('change', syncControls);
$('importCache').addEventListener('click', () => {
  if (busy || !loaded) return;
  const file = $('cacheFile').files?.[0];
  if (!file) { status('먼저 가져올 캐시 파일을 선택하세요.', 'error'); $('cacheFile').focus(); return; }
  if (!discardDraft()) return;
  const mode = $('importMode').value;
  const conflictPolicy = mode === 'merge' ? $('conflictPolicy').value : 'keep-local';
  let confirmed = false;
  if (mode === 'replace') {
    confirmed = window.confirm('전체 교체: 파일 전체 검증이 끝나면 기존 캐시 전체를 파일 내용으로 바꿉니다. 파일에 없는 번역과 수동 수정은 삭제되며 되돌릴 수 없습니다. 먼저 NDJSON으로 백업했는지 확인하세요. 전체 교체할까요?');
    if (!confirmed) return;
  }
  if (conflictPolicy === 'use-incoming') {
    confirmed = window.confirm('파일 번역으로 덮어쓰기: 원문·언어가 같은 로컬 번역을 파일 번역으로 바꿉니다. 수동 수정도 덮어쓰며 되돌릴 수 없습니다. 파일에 없는 로컬 번역은 유지됩니다. 먼저 백업했는지 확인하세요. 계속할까요?');
    if (!confirmed) return;
  }
  void run(async () => {
    transferController = new AbortController();
    syncControls();
    status('파일을 검증하고 임시 저장합니다. 완료될 때까지 이 화면을 열어 두세요.');
    try {
      const response = await importCacheFile(file, send, {mode, conflictPolicy, confirmed, signal: transferController.signal, onProgress: message => { $('transferProgress').textContent = message; }});
      updateCount(response);
      clearSelection();
      invalidateSearch();
      $('cacheFile').value = '';
      const warnings = response.validationWarnings;
      $('transferProgress').textContent = '가져오기 완료 · ' + (mode === 'replace' ? '전체 교체' : conflictPolicy === 'keep-local' ? '병합 · 로컬 번역 유지' : '병합 · 파일 번역 우선') + ` · 내용 차이 경고 ${number(warnings)}개`;
      status(`${number(response.imported)}개 반영 · ${number(response.skipped)}개 건너뜀 · 현재 ${number(response.cacheCount)}개. 반영한 항목 중 원문·번역문의 수치·태그·변수·줄바꿈 차이 경고 ${number(warnings)}개. 파일 번역문은 변경하지 않았으며 경고 항목도 그대로 반영했습니다.`, warnings > 0 ? 'info' : 'success');
    } catch (error) {
      $('transferProgress').textContent = '가져오기 중단 · 반영 전 검증 실패 시 기존 캐시는 유지됩니다.';
      throw error;
    } finally { transferController = null; }
  });
});
$('exportCache').addEventListener('click', () => {
  if (busy || !loaded) return;
  // run invokes its callback immediately, retaining the click's picker activation.
  void run(async () => {
    transferController = new AbortController();
    syncControls();
    status('NDJSON 백업을 저장합니다. 원문·번역문이 포함되므로 파일은 비공개로 보관하세요.');
    try {
      const response = await exportCacheFile(send, {signal: transferController.signal, onProgress: message => { $('transferProgress').textContent = message; }});
      $('transferProgress').textContent = response.method === 'download' ? '다운로드 시작 · 브라우저에서 파일 저장 완료를 확인하세요.' : 'NDJSON 파일 저장 완료';
      status(`${number(response.count)}개 번역을 ${response.method === 'download' ? 'NDJSON으로 다운로드합니다.' : 'NDJSON으로 백업했습니다.'}`, 'success');
    } catch (error) {
      $('transferProgress').textContent = '내보내기 중단 · 미완료 파일을 백업으로 사용하지 마세요.';
      throw error;
    } finally { transferController = null; }
  });
});
$('cancelTransfer').addEventListener('click', () => {
  transferController?.abort();
  $('cancelTransfer').disabled = true;
  $('transferProgress').textContent = '취소 요청 중 · 이미 시작된 최종 반영은 완료될 수 있습니다.';
});
$('clearCache').addEventListener('click', () => {
  if (busy || !loaded) return;
  if (!window.confirm('캐시 전체 초기화: 모든 언어의 저장된 번역과 수동 수정, 저장하지 않은 번역 초안을 삭제합니다. 진행 중인 가져오기·내보내기도 중단되며 게임에 이미 불러온 번역 기억도 초기화됩니다. 되돌릴 수 없으므로 필요한 캐시는 먼저 백업하세요. 저장한 설정과 아직 저장하지 않은 설정 입력값, 디스크의 캐시·백업 파일은 그대로 유지됩니다. 캐시를 모두 삭제할까요?')) return;
  void run(async () => {
    const response = await send('CACHE_CLEAR', {confirmed: true});
    updateCount(response);
    clearSelection();
    $('entryMeta').textContent = '';
    invalidateSearch();
    $('searchSummary').textContent = '캐시가 비어 있습니다. 파일을 가져오면 다시 검색할 수 있습니다.';
    $('cacheFile').value = '';
    $('transferProgress').textContent = '캐시 전체 초기화 완료 · 진행 중이던 가져오기·내보내기는 중단되었습니다.';
    status('캐시를 모두 삭제했습니다. 현재 0개이며 게임의 번역 기억을 초기화했습니다. 저장한 설정과 저장하지 않은 설정 입력값, 디스크의 캐시·백업 파일은 유지됩니다.', 'success');
  });
});
$('searchMode').addEventListener('change', () => {
  $('searchQuery').maxLength = $('searchMode').value === 'exact' ? 8192 : 256;
  $('searchTarget').required = $('searchMode').value === 'exact';
  $('searchQuery').required = $('searchMode').value === 'exact';
});
$('searchForm').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || !$('searchForm').reportValidity() || !discardDraft()) return;
  const query = $('searchQuery').value;
  const target = $('searchTarget').value.trim();
  const mode = $('searchMode').value;
  if ((mode === 'contains' && query.length > 256) || (mode === 'exact' && (!query.trim() || !target))) { status('일부 일치 검색은 256자 이하, 정확히 일치 검색은 원문과 대상 언어가 필요합니다.', 'error'); return; }
  void run(async () => {
    clearSelection();
    searchRequest = {query, mode, ...(target ? {target} : {})};
    nextCursor = null;
    scannedTotal = 0;
    $('searchResults').replaceChildren();
    $('searchNext').hidden = true;
    await searchPage(null);
    status('검색 결과를 선택하면 전체 원문과 번역문을 불러옵니다.');
  });
});
$('searchNext').addEventListener('click', () => {
  if (busy || nextCursor === null || !searchRequest || !discardDraft()) return;
  void run(async () => { clearSelection(); await searchPage(nextCursor); });
});
$('editForm').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || !selected || !$('editForm').reportValidity()) return;
  void run(async () => {
    try {
      const response = await send('CACHE_EDIT_SAVE', {...casPayload(), text: $('entryText').value});
      showEntry(response);
      updateCount(response);
      invalidateSearch();
      status('번역을 저장했습니다. 수동 수정으로 기록하고 게임 캐시를 갱신했습니다.', 'success');
    } catch (error) { mutationFailure(error); }
  });
});
$('deleteEntry').addEventListener('click', () => {
  if (busy || !selected || !window.confirm('이 원문·언어의 저장된 번역을 삭제할까요? 저장하지 않은 초안도 닫힙니다. 되돌릴 수 없으며 게임에는 원문을 표시합니다.')) return;
  void run(async () => {
    try {
      const response = await send('CACHE_DELETE', casPayload());
      updateCount(response);
      clearSelection();
      invalidateSearch();
      status('선택한 번역을 삭제했습니다.', 'success');
    } catch (error) { mutationFailure(error); }
  });
});
$('reloadEntry').addEventListener('click', () => {
  if (busy || !selected || !window.confirm('현재 번역 초안을 버리고 저장된 최신 항목을 다시 불러올까요? 초안은 복구할 수 없습니다.')) return;
  const id = selected.id;
  void run(async () => { await fetchSelection(id); status('최신 항목을 불러왔습니다.'); });
});
$('closeEntry').addEventListener('click', () => { if (!busy && discardDraft()) clearSelection(); });
$('openTab').addEventListener('click', () => {
  if (busy) return;
  void chrome.tabs.create({url: chrome.runtime.getURL('popup.html')}).catch(fail);
});
$('retryLoad').addEventListener('click', () => { void load(); });
$('reloadExtension').addEventListener('click', () => {
  if (busy || !reloadRequired) return;
  try { chrome.runtime.reload(); }
  catch (error) { status(`확장 다시 로드 실패: ${error.message}. chrome://extensions에서 Mini의 새로고침을 눌러 주세요.`, 'error'); }
});
window.addEventListener('pagehide', () => { transferController?.abort(); });
window.addEventListener('beforeunload', event => {
  if (transferController || isDirty()) { event.preventDefault(); event.returnValue = ''; }
});
void load();
