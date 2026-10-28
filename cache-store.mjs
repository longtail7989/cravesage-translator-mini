import {cacheId,isModernEntry,portableEntry,validateImport,validateTextShape,hasTextPairWarning,indexedCacheEntry,byteSize} from './cache.mjs';
import {unchangedJapanese} from './core.mjs';
const dialogue=globalThis[Symbol.for('cravesage-translator-mini.dialogue.v1')];
const META='cache-metadata',COUNTER='translation-count',DELETED='deleted-source:',MIGRATION='dialogue-index-v1',BATCH=64,MAX_BYTES=1048576;
const useful=entry=>{try{return isModernEntry(entry)&&validateTextShape(entry.source,entry.text)&&(entry.manual===true||!unchangedJapanese(entry.source,entry.text,entry.target));}catch{return false;}};
export function validateConflictPolicy(policy='keep-local'){
  if(policy!=='keep-local'&&policy!=='use-incoming')throw Error('지원하지 않는 캐시 충돌 처리 방식입니다.');
  return policy;
}
function transaction(db,names,mode,work){return new Promise((resolve,reject)=>{
  const tx=db.transaction(names,mode);let result,failure;
  tx.oncomplete=()=>resolve(typeof result==='function'?result():result);
  tx.onerror=tx.onabort=()=>reject(failure||tx.error||Object.assign(Error('캐시 작업을 완료하지 못했습니다.'),{code:'STORAGE'}));
  const fail=error=>{failure=error;try{tx.abort();}catch{reject(error);}};
  try{work(tx,value=>{result=value;},fail);}catch(error){fail(error);}
});}
export function createCacheStore(idb=globalThis.indexedDB,{databaseName='cravesage-mini-cache'}={}){
  if(typeof databaseName!=='string'||!databaseName)throw Error('캐시 데이터베이스 이름이 필요합니다.');
  let closed=false;
  const opened=new Promise((resolve,reject)=>{
    const request=idb.open(databaseName,2);
    request.onupgradeneeded=()=>{
      const db=request.result,live=db.objectStoreNames.contains('translations')?request.transaction.objectStore('translations'):db.createObjectStore('translations',{keyPath:'id'});
      if(!live.indexNames.contains('targetRecent'))live.createIndex('targetRecent',['target','reverseTime','id']);
      if(!live.indexNames.contains('dialogue'))live.createIndex('dialogue',['target','dialogueKey','manualRank','reverseTime','id']);
      if(!db.objectStoreNames.contains(META))db.createObjectStore(META,{keyPath:'id'}).put({id:COUNTER,count:0});
      if(!db.objectStoreNames.contains('imports'))db.createObjectStore('imports',{keyPath:['token','id']}).createIndex('token','token');
    };
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db);};
    request.onerror=()=>reject(request.error||Error('캐시를 열 수 없습니다.'));
    request.onblocked=()=>reject(Error('다른 캐시 연결을 닫고 다시 시도하세요.'));
  });
  // Each bounded transaction updates only derived fields and checkpoints atomically.
  // A worker restart resumes after the last committed key, without rehashing rows.
  async function migrate(db){
    let state=await transaction(db,META,'readonly',(tx,set)=>{const r=tx.objectStore(META).get(MIGRATION);r.onsuccess=()=>set(r.result);});
    while(!state?.done){
      const after=state?.cursor??null;
      state=await transaction(db,['translations',META],'readwrite',(tx,set,fail)=>{
        const meta=tx.objectStore(META);let visited=0,bytes=0,last=after;
        const finish=done=>{const checkpoint={id:MIGRATION,cursor:last,done};meta.put(checkpoint);set(checkpoint);};
        const r=tx.objectStore('translations').openCursor(after===null?undefined:globalThis.IDBKeyRange.lowerBound(after,true));
        r.onsuccess=()=>{try{
          const row=r.result;if(!row){finish(true);return;}
          let indexed=null;
          if(isModernEntry(row.value)){
            // Preserve malformed historical rows too, but never make them reusable.
            try{validateTextShape(row.value.source,row.value.text);indexed=indexedCacheEntry(row.value);}catch{}
          }
          const size=byteSize(indexed||row.value);
          if(visited&&bytes+size>MAX_BYTES){finish(false);return;}
          last=row.primaryKey;visited++;bytes+=size;
          if(indexed)row.update(indexed);
          if(visited>=BATCH||bytes>=MAX_BYTES){finish(false);return;}row.continue();
        }catch(error){fail(error);}};
      });
    }
  }
  const ready=opened.then(async db=>{await migrate(db);return db;});
  const database=async()=>{if(closed)throw Error('캐시 연결이 닫혔습니다.');return ready;};
  async function count(){const db=await database();return transaction(db,META,'readonly',(tx,set,fail)=>{
    const request=tx.objectStore(META).get(COUNTER);request.onsuccess=()=>{const count=request.result?.count;if(!Number.isSafeInteger(count)||count<0){fail(Error('캐시 개수 정보가 올바르지 않습니다.'));return;}set(count);};
  });}
  async function lookup(item,settings){
    const id=await cacheId(settings.target,item.source),db=await database();
    return transaction(db,['translations',META],'readonly',(tx,set,fail)=>{
      const live=tx.objectStore('translations'),request=live.get(id);
      request.onsuccess=()=>{
        const entry=request.result;
        // Explicit exact rows retain their original bytes, including imported warnings.
        if(useful(entry)&&entry.source===item.source&&entry.target===settings.target){set(entry);return;}
        if(settings.exactOnly===true||!dialogue.isStory(item.context)){set(null);return;}
        const marker=tx.objectStore(META).get(DELETED+id);
        marker.onsuccess=()=>{
          if(marker.result){set(null);return;}
          const key=dialogue.key(item.source),bounds=globalThis.IDBKeyRange.bound([settings.target,key,0,0,''],[settings.target,key,1,Number.MAX_SAFE_INTEGER,'\uffff']);
          let visited=0,bytes=0;
          const r=live.index('dialogue').openCursor(bounds);
          r.onsuccess=()=>{try{
            const row=r.result;if(!row){set(null);return;}
            const candidate=row.value,size=byteSize(candidate);visited++;bytes+=size;
            if(bytes>MAX_BYTES){set(null);return;}
            if(useful(candidate)&&candidate.target===settings.target&&dialogue.equivalent(item.source,candidate.source)&&!hasTextPairWarning(candidate.source,candidate.text)){
              set({...candidate,text:dialogue.display(item.source,candidate.text)});return;
            }
            if(visited>=32){set(null);return;}row.continue();
          }catch(error){fail(error);}};
        };
      };
    });
  }
  async function importCache(data,mode='merge',{conflictPolicy='keep-local',confirmed=false}={}){
    validateConflictPolicy(conflictPolicy);
    if(!['merge','replace'].includes(mode)||mode==='replace'&&confirmed!==true)throw Object.assign(Error('전체 교체에는 명시적인 확인이 필요합니다.'),{code:'INVALID'});
    // Validate and hash every row before opening the atomic live-cache transaction.
    const entries=await validateImport(data),db=await database();
    return transaction(db,['translations',META],'readwrite',(tx,set,fail)=>{
      const live=tx.objectStore('translations'),meta=tx.objectStore(META);let imported=0,added=0,cacheCount=0,validationWarnings=0,index=0;
      const next=()=>{
        if(index===entries.length){cacheCount+=added;if(!Number.isSafeInteger(cacheCount)){fail(Error('캐시 개수가 너무 큽니다.'));return;}meta.put({id:COUNTER,count:cacheCount});set({imported,skipped:data.entries.length-imported,cacheCount,validationWarnings});return;}
        const entry=entries[index++],request=live.get(entry.id);
        request.onsuccess=()=>{if(request.result&&mode==='merge'&&conflictPolicy==='keep-local'){next();return;}const write=live.put(indexedCacheEntry(entry));meta.delete(DELETED+entry.id);write.onsuccess=()=>{imported++;if(hasTextPairWarning(entry.source,entry.text))validationWarnings++;if(!request.result)added++;next();};};
      };
      const request=meta.get(COUNTER);request.onsuccess=()=>{const old=request.result?.count;if(!Number.isSafeInteger(old)||old<0){fail(Error('캐시 개수 정보가 올바르지 않습니다.'));return;}cacheCount=mode==='replace'?0:old;if(mode==='replace')live.clear();next();};
    });
  }
  async function exportPage({cursor=null,limit=250,maxBytes=1048576}={}){
    if(cursor!==null&&(typeof cursor!=='string'||!/^v3:[a-f0-9]{64}$/.test(cursor)))throw Error('캐시 내보내기 커서가 올바르지 않습니다.');
    if(!Number.isSafeInteger(limit)||limit<1||limit>10000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024)throw Error('내보내기 페이지 크기가 올바르지 않습니다.');
    const db=await database();return transaction(db,'translations','readonly',(tx,set,fail)=>{
      const entries=[];let bytes=0,last=cursor,done=false;
      const request=tx.objectStore('translations').openCursor(globalThis.IDBKeyRange.bound(cursor||'v3:','v3:\uffff',cursor!==null,false));
      request.onsuccess=()=>{try{const row=request.result;if(!row){done=true;return;}const entry=portableEntry(row.value),size=byteSize(entry)+1;
        if(entries.length>=limit||bytes+size>maxBytes){if(!entries.length)throw Error('캐시 한 항목이 페이지 바이트 한도를 초과합니다.');return;}
        entries.push(entry);bytes+=size;last=row.primaryKey;row.continue();
      }catch(error){fail(error);}};
      set(()=>({entries,cursor:done?null:last,done}));
    });
  }
  async function warm(target){
    const db=await database();return transaction(db,'translations','readonly',(tx,set,fail)=>{
      const entries=[];let bytes=0,visited=0,scannedBytes=0,hasMore=false;
      const request=tx.objectStore('translations').index('targetRecent').openCursor(globalThis.IDBKeyRange.bound([target,0,''],[target,Number.MAX_SAFE_INTEGER,'\uffff']));
      request.onsuccess=()=>{try{const row=request.result;if(!row)return;const entry=row.value,size=byteSize(entry);if(visited>=2000||scannedBytes+size>2*1024*1024){hasMore=true;return;}visited++;scannedBytes+=size;
        if(useful(entry)){const item={source:entry.source,context:entry.context,target:entry.target,text:entry.text},itemBytes=byteSize(item);if(bytes+itemBytes>2*1024*1024){hasMore=true;return;}entries.push(item);bytes+=itemBytes;}row.continue();
      }catch(error){fail(error);}};
      set(()=>({entries,remaining:null,hasMore,bytes}));
    });
  }
  async function clear(){
    const db=await database();return transaction(db,['translations','imports',META],'readwrite',(tx,set)=>{
      tx.objectStore('translations').clear();
      tx.objectStore('imports').clear();
      const meta=tx.objectStore(META);meta.clear();meta.put({id:COUNTER,count:0});meta.put({id:MIGRATION,cursor:null,done:true});
      set({cacheCount:0});
    });
  }
  return {lookup,count,exportPage,warm,clear,import:importCache,_database:database,
    async close(){closed=true;(await ready).close();},
    async destroy(){closed=true;(await ready).close();return new Promise((resolve,reject)=>{const request=idb.deleteDatabase(databaseName);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error||Error('캐시 삭제 실패'));request.onblocked=()=>reject(Error('캐시 연결이 열려 있습니다.'));});}
  };
}
