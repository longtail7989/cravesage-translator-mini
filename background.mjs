import {VERSION,DEFAULTS,isPlainObject,sanitizeSettings,publicConfig} from './core.mjs';
import {createCacheStore} from './cache-store.mjs';
import {createCacheEditor} from './cache-editor.mjs';
import {createCacheTransfer} from './cache-transfer.mjs';
const gameOrigin='https://gg-client-r.crave-saga.net';
const gamePath=/^\/client\/[^/]+\/index_dmm\.html$/;
const failure=(code,message)=>Object.assign(Error(message),{code});
const invalid=message=>failure('INVALID',message||'요청 형식이 올바르지 않습니다.');
export function isGameURL(value){try{const url=new URL(value);return url.origin===gameOrigin&&!url.username&&!url.password&&gamePath.test(url.pathname);}catch{return false;}}
export function createBackend(chromeApi=globalThis.chrome,{cache=createCacheStore()}={}){
  const editor=createCacheEditor(cache),transfers=createCacheTransfer(cache);
  let currentSettings={...DEFAULTS},cacheEpoch=crypto.randomUUID(),serial=Promise.resolve();
  const config=()=>publicConfig(currentSettings,cacheEpoch);
  const ready=(async()=>{
    if(typeof chromeApi.storage.local.setAccessLevel==='function')await chromeApi.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
    const stored=await chromeApi.storage.local.get('settings');
    currentSettings=sanitizeSettings(stored.settings??DEFAULTS);
    if(!stored.settings)await chromeApi.storage.local.set({settings:currentSettings});
    // Transfers are deliberately not resumable after service-worker restart.
    await transfers.cleanup({all:true});
  })();
  // Keep startup failures observable through every request without an unhandled rejection.
  ready.catch(()=>{});
  const locked=work=>{const task=serial.then(work,work);serial=task.catch(()=>{});return task;};
  const admin=sender=>sender?.id===chromeApi.runtime.id&&typeof sender.url==='string'&&sender.url.split(/[?#]/)[0]===chromeApi.runtime.getURL('popup.html');
  const game=sender=>sender?.id===chromeApi.runtime.id&&isGameURL(sender.url);
  async function broadcast(){
    const message={type:'PUBLIC_CONFIG_CHANGED',config:config()};
    // The game may be a child of DMM, and MV3 restarts forget previous senders.
    // Only this extension's content scripts receive these nonsecret notifications.
    let tabs=[];try{tabs=await chromeApi.tabs.query({});}catch{}
    await Promise.all(tabs.filter(tab=>Number.isInteger(tab.id)).map(async tab=>{try{await chromeApi.tabs.sendMessage(tab.id,message);}catch{/* No supported game frame in this tab. */}}));
  }
  async function changed(work){
    const result=await work();
    cacheEpoch=crypto.randomUUID();
    await broadcast();
    return result;
  }
  function importOptions(message){
    const mode=message.mode===undefined?'merge':message.mode,conflictPolicy=message.conflictPolicy===undefined?'keep-local':message.conflictPolicy;
    if(!['merge','replace'].includes(mode)||!['keep-local','use-incoming'].includes(conflictPolicy)||(Object.hasOwn(message,'confirmed')&&typeof message.confirmed!=='boolean'))throw invalid();
    if(mode==='replace'&&message.confirmed!==true)throw invalid('전체 교체에는 명시적인 확인이 필요합니다.');
    return {mode,conflictPolicy,confirmed:message.confirmed===true};
  }
  function lookupItems(items){
    if(!Array.isArray(items)||items.length>32)throw invalid('캐시 조회는 한 번에 최대 32개입니다.');
    let chars=0;const ids=new Set();
    for(const item of items){
      if(!isPlainObject(item)||Object.keys(item).some(key=>!['id','source','context','exactOnly'].includes(key))||typeof item.id!=='string'||!item.id||item.id.length>80||ids.has(item.id)||typeof item.source!=='string'||!item.source.trim()||item.source.length>8192||(item.context!==undefined&&(typeof item.context!=='string'||item.context.length>300))||(Object.hasOwn(item,'exactOnly')&&typeof item.exactOnly!=='boolean'))throw invalid('캐시 조회 항목이 올바르지 않습니다.');
      ids.add(item.id);chars+=item.source.length;
    }
    if(chars>131072)throw invalid('캐시 조회 원문은 합계 131,072자 이하여야 합니다.');
    return items;
  }
  const fields={
    PUBLIC_CONFIG:[],CACHE_WARM:[],CACHE_LOOKUP:['items'],GET_STATE:[],SAVE_SETTINGS:['settings'],
    CACHE_SEARCH:['query','target','mode','cursor','limit'],CACHE_GET:['id'],
    CACHE_EDIT_SAVE:['id','source','target','text','expectedUpdatedAt','expectedText'],
    CACHE_DELETE:['id','source','target','expectedUpdatedAt','expectedText'],
    CACHE_CLEAR:['confirmed'],
    IMPORT_CACHE:['data','mode','conflictPolicy','confirmed'],IMPORT_START:['mode','conflictPolicy','confirmed'],
    IMPORT_BATCH:['token','entries'],IMPORT_COMMIT:['token','header','expectedCount','confirmed'],IMPORT_ABORT:['token'],
    EXPORT_START:[],EXPORT_PAGE:['token','cursor'],EXPORT_END:['token']
  };
  async function dispatch(message,sender){
    if(!isPlainObject(message)||typeof message.type!=='string')throw invalid();
    const isAdmin=admin(sender),isGame=game(sender);
    if(!isAdmin&&!isGame)throw failure('FORBIDDEN','이 페이지에서는 확장을 사용할 수 없습니다.');
    if(!Object.hasOwn(fields,message.type)||Object.keys(message).some(key=>key!=='type'&&!fields[message.type].includes(key)))throw invalid('지원하지 않는 요청입니다.');
    if(!isAdmin&&!['PUBLIC_CONFIG','CACHE_WARM','CACHE_LOOKUP'].includes(message.type))throw failure('FORBIDDEN','확장 팝업 전용 요청입니다.');
    if(['CACHE_WARM','CACHE_LOOKUP'].includes(message.type)&&!isGame)throw failure('FORBIDDEN','게임 프레임 전용 요청입니다.');
    await ready;
    if(message.type==='PUBLIC_CONFIG')return {config:config()};
    if(message.type==='CACHE_WARM'){
      const settings={...currentSettings},epoch=cacheEpoch;
      return {...(settings.enabled?await cache.warm(settings.target):{entries:[],remaining:0,hasMore:false,bytes:0}),cacheEpoch:epoch};
    }
    if(message.type==='CACHE_LOOKUP'){
      const items=lookupItems(message.items),settings={...currentSettings},epoch=cacheEpoch;
      const results=await Promise.all(items.map(async item=>{const hit=settings.enabled?await cache.lookup(item,{...settings,exactOnly:item.exactOnly===true}):null;return hit?{id:item.id,text:hit.text,cached:true}:{id:item.id,missing:true};}));
      return {results,cacheEpoch:epoch};
    }
    return locked(async()=>{
      switch(message.type){
        case 'GET_STATE':return {settings:{...currentSettings},cacheCount:await cache.count(),version:VERSION,capabilities:{cacheClear:true,warningImports:true}};
        case 'SAVE_SETTINGS':return changed(async()=>{if(!isPlainObject(message.settings))throw invalid();const settings=sanitizeSettings(message.settings);await chromeApi.storage.local.set({settings});currentSettings=settings;return {};}).then(()=>({config:config()}));
        case 'CACHE_SEARCH':return editor.search({query:message.query===undefined?'':message.query,target:message.target,mode:message.mode===undefined?'contains':message.mode,cursor:message.cursor===undefined?null:message.cursor,limit:message.limit===undefined?20:message.limit});
        case 'CACHE_GET':return editor.get({id:message.id});
        case 'CACHE_EDIT_SAVE':return changed(()=>editor.save(message));
        case 'CACHE_DELETE':return changed(()=>editor.remove(message));
        case 'CACHE_CLEAR':if(message.confirmed!==true)throw invalid('캐시 전체 초기화에는 명시적인 확인이 필요합니다.');return changed(()=>cache.clear());
        case 'IMPORT_CACHE':{const options=importOptions(message);return changed(()=>cache.import(message.data,options.mode,options));}
        case 'IMPORT_START':{const options=importOptions(message);return transfers.importStart(options.mode,options);}
        case 'IMPORT_BATCH':return transfers.importStage(message.token,message.entries);
        case 'IMPORT_COMMIT':if(Object.hasOwn(message,'confirmed')&&typeof message.confirmed!=='boolean')throw invalid();return changed(()=>transfers.importCommit(message.token,message.header,{expectedCount:message.expectedCount}));
        case 'IMPORT_ABORT':return transfers.importAbort(message.token);
        case 'EXPORT_START':return transfers.exportStart();
        case 'EXPORT_PAGE':return transfers.exportNext({token:message.token,cursor:message.cursor===undefined?null:message.cursor});
        case 'EXPORT_END':return transfers.exportEnd(message.token);
        default:throw invalid();
      }
    });
  }
  async function handle(message,sender){try{return {ok:true,...await dispatch(message,sender)};}catch(error){return {ok:false,error:String(error?.message||'캐시 작업을 완료하지 못했습니다.').slice(0,350),code:typeof error?.code==='string'?error.code:error?.name==='QuotaExceededError'?'STORAGE':'INVALID'};}}
  return {handle,ready,cache};
}
if(globalThis.chrome?.runtime?.onMessage){
  const backend=createBackend();
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{backend.handle(message,sender).then(reply);return true;});
}
