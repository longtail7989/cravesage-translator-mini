// Cache-only shared helpers. No translation service or network code.
export const VERSION='0.1.2';
export const DEFAULTS=Object.freeze({enabled:true,target:'한국어',fontFamily:'Malgun Gothic',playerName:'',displayName:''});
export const isPlainObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function sanitizeSettings(input={}){
  if(!isPlainObject(input)||Object.keys(input).some(key=>!Object.hasOwn(DEFAULTS,key)))throw Object.assign(Error('지원하지 않는 설정입니다.'),{code:'INVALID'});
  const settings={...DEFAULTS,...input};
  if(typeof settings.enabled!=='boolean'||typeof settings.target!=='string'||!settings.target.trim()||settings.target!==settings.target.trim()||settings.target.length>64||typeof settings.fontFamily!=='string'||settings.fontFamily!==settings.fontFamily.trim()||settings.fontFamily.length>100)throw Object.assign(Error('설정 값이나 길이가 올바르지 않습니다.'),{code:'INVALID'});
  if([settings.playerName,settings.displayName].some(value=>typeof value!=='string'||value.length>64||/[<>{}\r\n]/.test(value)))throw Object.assign(Error('이름은 64자 이하이며 < > { }와 줄바꿈을 포함할 수 없습니다.'),{code:'INVALID'});
  return settings;
}
export const publicConfig=(settings,cacheEpoch)=>({...settings,cacheEpoch});
// Preserve the original cache usability rule, while allowing deliberate manual entries.
export function unchangedJapanese(source,text,target){return /^(?:한국어|ko|korean)$/i.test(String(target).trim())&&typeof source==='string'&&typeof text==='string'&&/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(source.replace(/<[^<>]*>/g,''))&&source===text;}
export function protect(text,prefix='Q'){
  if(/⟦[A-Za-z0-9]+_\d+⟧/.test(text))throw Error('보호 토큰과 충돌하는 문구입니다.');
  const values=[];
  const masked=text.replace(/<[^>]*>|\{[^{}]*\}|\r\n|\r|\n|[+＋\-－]?[0-9０-９]+(?:[,，][0-9０-９]{3})*(?:[.．][0-9０-９]+)?(?:[%％])?/g,value=>{const token=`⟦${prefix}_${values.length}⟧`;values.push({token,value});return token;});
  return {masked,values,original:text};
}
export async function hashKey(value){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');}
