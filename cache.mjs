import {hashKey,protect,VERSION,unchangedJapanese} from './core.mjs';
export const CACHE_FORMAT='crave-ai-translation-cache';
export const CACHE_FILE_VERSION=3;
export const CACHE_MAX_FILE_BYTES=32*1024*1024;
const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const fields=['id','source','context','target','text','createdAt','updatedAt'];
const optionalFields=['manual'];
const keysOnly=(x,keys)=>Object.keys(x).every(k=>keys.includes(k));
// The original popup exporter writes exportedAtISO; backend/Mini exports use exportedAt.
export function normalizeCacheHeader(data,{stream=false}={}){
  const allowed=['format','version','identity','exportedAt','exportedAtISO','appVersion',...(stream?[]:['entries'])];
  if(!plain(data)||!keysOnly(data,allowed)||data.format!==CACHE_FORMAT||!(stream?[2,3]:[1,2,3]).includes(data.version)||(stream?data.identity!=='source-v3':Object.hasOwn(data,'identity')&&data.identity!=='source-v3'))throw Error('지원하는 캐시 파일 헤더가 아닙니다.');
  const hasDate=Object.hasOwn(data,'exportedAt'),hasISO=Object.hasOwn(data,'exportedAtISO');
  const exportedAt=hasDate?data.exportedAt:data.exportedAtISO;
  if(!hasDate&&!hasISO||hasDate&&hasISO&&data.exportedAt!==data.exportedAtISO||typeof exportedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(exportedAt)||!Number.isFinite(Date.parse(exportedAt))||typeof data.appVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(data.appVersion))throw Error('캐시 파일의 내보낸 시각·앱 버전이 올바르지 않습니다.');
  return {format:CACHE_FORMAT,version:data.version,...(Object.hasOwn(data,'identity')?{identity:data.identity}:{}),exportedAt,appVersion:data.appVersion};
}
export const byteSize=x=>new TextEncoder().encode(typeof x==='string'?x:JSON.stringify(x)).byteLength;
export function cacheIdentityV2(target,source,context=''){return JSON.stringify(['crave-cache-v2',target,source,context]);}
export async function cacheIdV2(target,source,context=''){return 'v2:'+await hashKey(cacheIdentityV2(target,source,context));}
export function cacheIdentityV3(target,source){return JSON.stringify(['crave-cache-v3',target,source]);}
export async function cacheId(target,source){return 'v3:'+await hashKey(cacheIdentityV3(target,source));}
export function validateTextPair(source,text){
  if(typeof source!=='string'||!source.trim()||source.length>8192||typeof text!=='string'||!text.trim()||text.length>Math.max(512,source.length*6))throw Error('캐시 원문·번역문의 길이가 올바르지 않습니다.');
  const a=protect(source,'CHECK').values.map(x=>x.value),b=protect(text,'CHECK').values.map(x=>x.value);
  // A localized player name can move across lines; all other protected values stay ordered.
  const ordinaryA=a.filter(value=>value!=='{USER}'),ordinaryB=b.filter(value=>value!=='{USER}');
  if(a.length-ordinaryA.length!==b.length-ordinaryB.length||JSON.stringify(ordinaryA)!==JSON.stringify(ordinaryB))throw Error('캐시에 수치·태그·변수·줄바꿈 또는 이름 자리표시자 개수가 바뀐 번역이 있어 불러오기를 중단했습니다.');
  return true;
}
export async function makeCacheEntry({source,context='',target,text,createdAt=Date.now(),updatedAt=Date.now(),manual}){
  if(typeof target!=='string'||!target.trim()||target!==target.trim()||target.length>64||typeof context!=='string'||context.length>300)throw Error('캐시 언어·문맥이 올바르지 않습니다.');
  if(manual!==undefined&&typeof manual!=='boolean')throw Error('캐시 수동 편집 표시가 올바르지 않습니다.');
  validateTextPair(source,text);
  if(!Number.isSafeInteger(createdAt)||createdAt<0||!Number.isSafeInteger(updatedAt)||updatedAt<0||updatedAt<createdAt)throw Error('캐시 시간 정보가 올바르지 않습니다.');
  return {id:await cacheId(target,source),source,context,target,text,createdAt,updatedAt,time:updatedAt,reverseTime:Number.MAX_SAFE_INTEGER-updatedAt,...(manual===true?{manual:true}:{})};
}
export function isModernEntry(e){return plain(e)&&typeof e.id==='string'&&/^v[23]:[a-f0-9]{64}$/.test(e.id)&&typeof e.source==='string'&&typeof e.target==='string'&&typeof e.context==='string';}
export function portableEntry(e){return {id:e.id,source:e.source,context:e.context,target:e.target,text:e.text,createdAt:e.createdAt,updatedAt:e.updatedAt,...(e.manual===true?{manual:true}:{})};}
// Total order makes source-context collisions independent of cursor/import order.
export function preferredEntry(a,b){
  if(!a)return b;if(!b)return a;
  if(a.source!==b.source||a.target!==b.target)return b;
  const valid=e=>{try{validateTextPair(e.source,e.text);return e.manual===true||!unchangedJapanese(e.source,e.text,e.target);}catch{return false;}};
  const av=valid(a),bv=valid(b);if(av!==bv)return bv?b:a;
  const am=av&&a.manual===true,bm=bv&&b.manual===true;if(am!==bm)return bm?b:a;
  if(a.updatedAt!==b.updatedAt)return b.updatedAt>a.updatedAt?b:a;
  const ak=JSON.stringify(portableEntry(a)),bk=JSON.stringify(portableEntry(b));return bk>ak?b:a;
}
export function checkPortableShape(raw){
  if(!plain(raw)||!keysOnly(raw,[...fields,...optionalFields])||!fields.every(k=>Object.hasOwn(raw,k)))throw Error('캐시 항목에 필수 필드가 없거나 지원하지 않는 필드가 있습니다.');
  if(Object.hasOwn(raw,'manual')&&typeof raw.manual!=='boolean')throw Error('캐시 수동 편집 표시가 올바르지 않습니다.');
  // Reject oversized or hostile records before serializing them for byte accounting.
  validateTextPair(raw.source,raw.text);
  if(typeof raw.id!=='string'||raw.id.length!==67||typeof raw.context!=='string'||raw.context.length>300||typeof raw.target!=='string'||raw.target.length>64)throw Error('캐시 항목의 필드 길이가 올바르지 않습니다.');
}
export async function validatePortableEntries(raws){
  if(!Array.isArray(raws))throw Error('캐시 항목 배열이 필요합니다.');
  const entries=new Map();
  for(let start=0;start<raws.length;start+=32){
    const chunk=await Promise.all(raws.slice(start,start+32).map(async raw=>{
      checkPortableShape(raw);
      const entry=await makeCacheEntry(raw);
      const expected=typeof raw.id==='string'&&raw.id.startsWith('v2:')?await cacheIdV2(raw.target,raw.source,raw.context):entry.id;
      if(raw.id!==expected)throw Error('캐시 항목의 고유키가 원문·언어·문맥과 일치하지 않습니다.');
      return entry;
    }));
    for(const e of chunk)entries.set(e.id,preferredEntry(entries.get(e.id),e));
  }
  return [...entries.values()];
}
export function buildExport(entries){
  const modern=[];let bytes=512,legacySkipped=0;
  for(const e of entries){if(!isModernEntry(e)){legacySkipped++;continue;}const row=portableEntry(e);bytes+=byteSize(row)+1;if(bytes>CACHE_MAX_FILE_BYTES)throw Error('32MiB를 초과하는 캐시는 exportPage() 페이지 내보내기를 사용하세요.');modern.push(row);}
  return {data:{format:CACHE_FORMAT,version:CACHE_FILE_VERSION,exportedAt:new Date().toISOString(),appVersion:VERSION,entries:modern},exported:modern.length,legacySkipped};
}
export async function validateImport(data){
  normalizeCacheHeader(data);
  if(!Array.isArray(data.entries))throw Error('캐시 항목 배열이 필요합니다.');
  let bytes=512;for(const e of data.entries){checkPortableShape(e);bytes+=byteSize(e)+1;if(bytes>CACHE_MAX_FILE_BYTES)throw Error('32MiB를 초과하는 캐시는 importBatch() 페이지 불러오기를 사용하세요.');}
  return validatePortableEntries(data.entries);
}

export const indexedCacheEntry=entry=>({...entry,time:entry.updatedAt,reverseTime:Number.MAX_SAFE_INTEGER-entry.updatedAt});
