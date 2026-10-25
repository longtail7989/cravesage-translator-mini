import {VERSION} from './core.mjs';
import {validateConflictPolicy} from './cache-store.mjs';
import {CACHE_FORMAT,CACHE_FILE_VERSION,normalizeCacheHeader,validatePortableEntries,preferredEntry,indexedCacheEntry,checkPortableShape,byteSize} from './cache.mjs';
const META='cache-metadata',STAGE='imports',LIVE='translations',TTL=5*60*1000;
function transact(db,names,mode,work){return new Promise((resolve,reject)=>{
  const tx=db.transaction(names,mode);let result,error;
  const fail=e=>{error=e;try{tx.abort();}catch{reject(e);}};
  tx.oncomplete=()=>resolve(typeof result==='function'?result():result);
  tx.onabort=tx.onerror=()=>reject(error||tx.error||Error('캐시 파일 작업을 완료하지 못했습니다. 기존 캐시는 유지됩니다.'));
  try{work(tx,x=>{result=x;},fail);}catch(e){fail(e);}
});}
function tokenId(token){if(typeof token!=='string'||!/^[a-f0-9-]{36}$/.test(token))throw Error('캐시 작업 토큰이 올바르지 않습니다.');return 'transfer:'+token;}
function jobValid(job,kind){if(!job||job.kind!==kind||job.expires<Date.now())throw Error('캐시 파일 작업이 만료되거나 중단되었습니다. 다시 시작하세요.');}
export function createCacheTransfer(cache){
  let serial=Promise.resolve();
  const run=fn=>{const p=serial.then(fn,fn);serial=p.catch(()=>{});return p;};
  async function purge(token){const db=await cache._database(),id=tokenId(token);
    // Mark cancellation durably before bounded cleanup, so a restart cannot
    // commit a partially purged staging session. Never delete live translations.
    await transact(db,META,'readwrite',tx=>{const meta=tx.objectStore(META),r=meta.get(id);r.onsuccess=()=>{if(r.result)meta.put({...r.result,kind:'aborted',expires:Date.now()-1});};});
    for(;;){const removed=await transact(db,STAGE,'readwrite',(tx,set)=>{const stage=tx.objectStore(STAGE),r=stage.index('token').getAllKeys(IDBKeyRange.only(token),1000);r.onsuccess=()=>{for(const key of r.result)stage.delete(key);set(r.result.length);};});if(removed<1000)break;}
    await transact(db,META,'readwrite',tx=>{tx.objectStore(META).delete(id);});return {};
  }
  async function cleanup(all=false){const db=await cache._database();const expired=await transact(db,META,'readonly',(tx,set)=>{
    const tokens=[],r=tx.objectStore(META).openCursor();r.onsuccess=()=>{const c=r.result;if(c){if(typeof c.value?.id==='string'&&c.value.id.startsWith('transfer:')&&(all||c.value.expires<Date.now()))tokens.push(c.value.token);c.continue();}};set(()=>tokens);
  });for(const token of expired)await purge(token);}
  async function getJob(token,kind){const db=await cache._database(),id=tokenId(token);return transact(db,META,'readonly',(tx,set,fail)=>{const r=tx.objectStore(META).get(id);r.onsuccess=()=>{try{jobValid(r.result,kind);set(r.result);}catch(e){fail(e);}};});}
  async function saveJob(job){const db=await cache._database();job.expires=Date.now()+TTL;return transact(db,META,'readwrite',tx=>{tx.objectStore(META).put(job);});}
  return {
    cleanup:({all=false}={})=>run(()=>cleanup(all)),
    exportStart:()=>run(async()=>{await cleanup();const token=crypto.randomUUID(),header={format:CACHE_FORMAT,version:CACHE_FILE_VERSION,identity:'source-v3',exportedAt:new Date().toISOString(),appVersion:VERSION};const count=await cache.count();await saveJob({id:tokenId(token),token,kind:'export',cursor:null,done:false,expires:Date.now()+TTL});return {token,header,count,countIsExact:false};}),
    exportNext:({token,cursor=null})=>run(async()=>{await cleanup();const job=await getJob(token,'export');if(job.done||cursor!==job.cursor)throw Error('캐시 파일 페이지 순서가 올바르지 않습니다. 다시 시작하세요.');const page=await cache.exportPage({cursor,limit:250,maxBytes:1024*1024});await saveJob({...job,cursor:page.cursor,done:page.done});return page;}),
    exportEnd:token=>run(async()=>{await purge(token);return {};}),
    importStart:(mode,{conflictPolicy='keep-local',confirmed=false}={})=>run(async()=>{validateConflictPolicy(conflictPolicy);if(!['merge','replace'].includes(mode)||mode==='replace'&&confirmed!==true)throw Object.assign(Error('전체 교체에는 명시적인 확인이 필요합니다.'),{code:'INVALID'});await cleanup();const token=crypto.randomUUID();await saveJob({id:tokenId(token),token,kind:'import',mode,conflictPolicy,confirmed:confirmed===true,inputCount:0,stagedCount:0,expires:Date.now()+TTL});return {token};}),
    importStage:(token,rows)=>run(async()=>{
      await cleanup();await getJob(token,'import');
      if(!Array.isArray(rows)||rows.length>1000)throw Error('캐시 불러오기 배치는 최대 1,000개입니다.');
      let bytes=0;for(const row of rows){checkPortableShape(row);bytes+=byteSize(row)+1;if(bytes>8*1024*1024)throw Error('캐시 불러오기 배치는 8MiB 이하여야 합니다.');}
      const entries=await validatePortableEntries(rows),db=await cache._database(),id=tokenId(token);
      return transact(db,[STAGE,META],'readwrite',(tx,set,fail)=>{
        const stage=tx.objectStore(STAGE),meta=tx.objectStore(META),j=meta.get(id);let job,i=0,newRows=0;
        const next=()=>{if(i===entries.length){job.inputCount+=rows.length;job.stagedCount+=newRows;if(!Number.isSafeInteger(job.inputCount)||!Number.isSafeInteger(job.stagedCount)){fail(Error('캐시 항목 수가 너무 큽니다.'));return;}job.expires=Date.now()+TTL;meta.put(job);set({staged:rows.length,cumulative:job.inputCount,uniqueStaged:job.stagedCount});return;}const e=entries[i++],r=stage.get([token,e.id]);r.onsuccess=()=>{const old=r.result;const entry=indexedCacheEntry(preferredEntry(old?.entry,e));if(!old)newRows++;const w=stage.put({token,id:e.id,entry});w.onsuccess=next;};};
        j.onsuccess=()=>{try{job=j.result;jobValid(job,'import');validateConflictPolicy(job.conflictPolicy);next();}catch(e){fail(e);}};
      });
    }),
    importCommit:(token,header,{expectedCount}={})=>run(async()=>{
      normalizeCacheHeader(header,{stream:true});if(!Number.isSafeInteger(expectedCount)||expectedCount<0)throw Error('캐시 파일 종료 개수를 확인할 수 없습니다.');
      await cleanup();const db=await cache._database(),id=tokenId(token);
      return transact(db,[STAGE,META,LIVE],'readwrite',(tx,set,fail)=>{
        const stage=tx.objectStore(STAGE),meta=tx.objectStore(META),live=tx.objectStore(LIVE);let job,after=null,imported=0,cacheCount=0,savedCount=0,added=0,processed=0;
        const finish=()=>{if(processed!==job.stagedCount){fail(Error('임시 캐시 항목 수가 일치하지 않습니다. 기존 캐시는 유지됩니다.'));return;}cacheCount=job.mode==='replace'?imported:savedCount+added;if(!Number.isSafeInteger(cacheCount)){fail(Error('캐시 개수가 너무 큽니다.'));return;}meta.put({id:'translation-count',count:cacheCount});meta.delete(id);set(()=>({imported,skipped:job.inputCount-imported,cacheCount}));};
        const nextPage=()=>{const bounds=IDBKeyRange.bound([token,after||''],[token,'\uffff'],after!==null,false),r=stage.getAll(bounds,256);
          r.onsuccess=()=>{const batch=r.result;if(!batch.length){finish();return;}after=batch[batch.length-1].id;let pending=batch.length;
            const done=()=>{if(--pending===0)nextPage();};
            for(const row of batch){if(row.token!==token||row.entry?.id!==row.id){fail(Error('임시 캐시 항목이 올바르지 않습니다.'));return;}
              processed++;
              const write=old=>{if(job.mode==='replace'||job.conflictPolicy==='use-incoming'||!old){live.put(row.entry);imported++;if(!old)added++;}stage.delete([token,row.id]);done();};
              if(job.mode==='replace')write(null);else{const q=live.get(row.id);q.onsuccess=()=>write(q.result);}
            }
          };
        };
        const j=meta.get(id);j.onsuccess=()=>{try{job=j.result;jobValid(job,'import');validateConflictPolicy(job.conflictPolicy);if(!['merge','replace'].includes(job.mode)||job.mode==='replace'&&job.confirmed!==true)throw Error('전체 교체 확인 정보가 없습니다.');if(job.inputCount!==expectedCount)throw Error('캐시 파일 종료 개수가 실제 항목 수와 다릅니다. 기존 캐시는 유지됩니다.');const n=meta.get('translation-count');n.onsuccess=()=>{const value=n.result?.count;if(!Number.isSafeInteger(value)||value<0){fail(Error('캐시 개수 정보를 확인할 수 없어 불러오기를 중단했습니다.'));return;}savedCount=value;if(job.mode==='replace')live.clear();nextPage();};}catch(e){fail(e);}};
      });
    }),
    importAbort:token=>run(async()=>{await purge(token);return {};})
  };
}
