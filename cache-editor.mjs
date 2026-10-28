// Trusted extension backend only. No provider calls or settings changes.
import {cacheId,makeCacheEntry,portableEntry,indexedCacheEntry,validateTextPair,byteSize} from './cache.mjs';
const META='cache-metadata',COUNTER='translation-count',DELETED='deleted-source:',MAX_SCAN=512,MAX_BYTES=2*1024*1024;
const validId=id=>typeof id==='string'&&/^v3:[a-f0-9]{64}$/.test(id);
const targetOK=t=>typeof t==='string'&&!!t.trim()&&t===t.trim()&&t.length<=64;
const safeTime=t=>Number.isSafeInteger(t)&&t>=0;
const error=(code,message)=>Object.assign(Error(message),{code});
const invalid=()=>error('INVALID','캐시 편집 요청이 올바르지 않습니다.');
const conflict=()=>error('CONFLICT','캐시가 변경되었습니다. 다시 불러온 뒤 편집하세요.');
const storageError=()=>error('STORAGE','캐시 편집 작업을 완료하지 못했습니다.');
function transaction(db,names,mode,fn){return new Promise((resolve,reject)=>{
  const tx=db.transaction(names,mode);let result,failure;
  tx.oncomplete=()=>resolve(typeof result==='function'?result():result);
  tx.onerror=tx.onabort=()=>reject(failure||storageError());
  const fail=e=>{failure=e;try{tx.abort();}catch{reject(e);}};
  try{fn(tx,x=>{result=x;},fail);}catch(e){fail(e?.code?e:storageError());}
});}
const preview=(text,n)=>typeof text==='string'?(text.length>n?text.slice(0,n-1)+'…':text):'';
const summary=e=>({id:e.id,sourcePreview:preview(e.source,180),textPreview:preview(e.text,300),target:e.target,updatedAt:e.updatedAt,manual:e.manual===true});
export function createCacheEditor(cache){
  if(!cache||typeof cache._database!=='function'||typeof cache.count!=='function')throw invalid();
  const read=(db,id)=>transaction(db,'translations','readonly',(tx,set)=>{const r=tx.objectStore('translations').get(id);r.onsuccess=()=>set(r.result);});
  async function search({query='',target,mode='contains',cursor=null,limit=20}={}){
    if(typeof query!=='string'||!['contains','exact'].includes(mode)||query.length>(mode==='exact'?8192:256)||!Number.isSafeInteger(limit)||limit<1||limit>20||(cursor!==null&&!validId(cursor))||(target!==undefined&&!targetOK(target)))throw invalid();
    if(mode==='exact'&&(!targetOK(target)||!query.trim()||cursor!==null))throw invalid();
    const db=await cache._database(),cacheCount=await cache.count();
    if(mode==='exact'){
      const id=await cacheId(target,query),e=await read(db,id);
      // Deliberately no translation usability filter: unchanged/bad rows are editable.
      return {results:e&&e.source===query&&e.target===target?[summary(e)]:[],cursor:null,done:true,scanned:e?1:0,cacheCount};
    }
    const needle=query.toLowerCase();
    return transaction(db,'translations','readonly',(tx,set,fail)=>{
      const store=tx.objectStore('translations'),results=[];let scanned=0,bytes=0,last=cursor,done=false;
      const next=()=>{
        if(scanned>=MAX_SCAN||bytes>=MAX_BYTES||results.length>=limit)return;
        const bounds=globalThis.IDBKeyRange.bound(last||'v3:','v3:\uffff',last!==null,false);
        const wanted=Math.min(32,MAX_SCAN-scanned),r=store.getAll(bounds,wanted);
        r.onsuccess=()=>{try{
          const rows=r.result;if(!rows.length){done=true;return;}
          for(const e of rows){
            const size=byteSize(e);
            if(bytes+size>MAX_BYTES){if(!scanned)throw storageError();return;}
            scanned++;bytes+=size;last=e.id;
            if(validId(e.id)&&(target===undefined||e.target===target)&&typeof e.source==='string'&&typeof e.text==='string'&&(!needle||e.source.toLowerCase().includes(needle)||e.text.toLowerCase().includes(needle)))results.push(summary(e));
            // Last processed key, never the last prefetched key, is the continuation.
            if(results.length>=limit||scanned>=MAX_SCAN||bytes>=MAX_BYTES)return;
          }
          if(rows.length<wanted){done=true;return;}next();
        }catch(e){fail(e?.code?e:storageError());}};
      };next();set(()=>({results,cursor:done?null:last,done,scanned,cacheCount}));
    });
  }
  async function get({id}={}){
    if(!validId(id))throw invalid();const db=await cache._database(),e=await read(db,id);
    return e?{entry:portableEntry(e),version:{updatedAt:e.updatedAt,text:e.text}}:{entry:null,version:null};
  }
  async function save({id,source,target,text,expectedUpdatedAt,expectedText}={}){
    if(!validId(id)||!targetOK(target)||!safeTime(expectedUpdatedAt)||typeof expectedText!=='string'||expectedText.length>49152)throw invalid();
    try{validateTextPair(source,text);}catch{throw invalid();}
    const db=await cache._database(),old=await read(db,id);
    if(!old||source!==old.source||target!==old.target||expectedUpdatedAt!==old.updatedAt||expectedText!==old.text)throw conflict();
    if(await cacheId(target,source)!==id)throw invalid();
    const now=Date.now(),oldTime=safeTime(old?.updatedAt)?old.updatedAt:0;
    if(oldTime===Number.MAX_SAFE_INTEGER)throw invalid();
    const updatedAt=Math.max(now,oldTime+1),createdAt=safeTime(old?.createdAt)&&old.createdAt<=updatedAt?old.createdAt:updatedAt;
    let entry;
    try{entry=await makeCacheEntry({source:old.source,target:old.target,text,context:old.context,createdAt,updatedAt,manual:true});}catch{throw invalid();}
    // All hashing/validation completed before this transaction. Re-read and CAS atomically.
    return transaction(db,['translations',META],'readwrite',(tx,set,fail)=>{
      const store=tx.objectStore('translations'),r=store.get(id);let cacheCount;
      r.onsuccess=()=>{
        const current=r.result;
        if(!current||current.source!==source||current.target!==target||current.updatedAt!==expectedUpdatedAt||current.text!==expectedText){fail(conflict());return;}
        // Current persisted context is authoritative, not any caller-provided metadata.
        if(current)entry={...entry,context:current.context,createdAt:safeTime(current.createdAt)&&current.createdAt<=updatedAt?current.createdAt:createdAt};
        const counter=tx.objectStore(META),n=counter.get(COUNTER);
        n.onsuccess=()=>{
          if(!safeTime(n.result?.count)||n.result.count<1){fail(storageError());return;}
          cacheCount=n.result.count;
          store.put(indexedCacheEntry(entry));
          counter.delete(DELETED+id);
        };
      };set(()=>({entry:portableEntry(entry),version:{updatedAt:entry.updatedAt,text:entry.text},cacheCount}));
    });
  }
  async function remove({id,source,target,expectedUpdatedAt,expectedText}={}){
    // Deletion also accepts unusable translations, but never alternate/legacy identities.
    if(!validId(id)||!targetOK(target)||typeof source!=='string'||!source.trim()||source.length>8192||!safeTime(expectedUpdatedAt)||typeof expectedText!=='string'||expectedText.length>49152)throw invalid();
    const db=await cache._database(),old=await read(db,id);
    const missing=()=>conflict();
    if(!old)throw missing();
    if(old.source!==source||old.target!==target||old.updatedAt!==expectedUpdatedAt||old.text!==expectedText)throw conflict();
    if(await cacheId(target,source)!==id)throw invalid();
    // Hash before opening the transaction, then re-read the canonical key and CAS.
    return transaction(db,['translations',META],'readwrite',(tx,set,fail)=>{
      const store=tx.objectStore('translations'),r=store.get(id);let cacheCount;
      r.onsuccess=()=>{
        const current=r.result;
        if(!current){fail(missing());return;}
        if(current.source!==source||current.target!==target||current.updatedAt!==expectedUpdatedAt||current.text!==expectedText){fail(conflict());return;}
        const counter=tx.objectStore(META),n=counter.get(COUNTER);
        n.onsuccess=()=>{
          if(!safeTime(n.result?.count)||n.result.count<1){fail(storageError());return;}
          cacheCount=n.result.count-1;
          store.delete(id);counter.put({id:COUNTER,count:cacheCount});counter.put({id:DELETED+id});
        };
      };set(()=>({deleted:1,source,target,cacheCount}));
    });
  }
  return {search,get,save,remove};
}
