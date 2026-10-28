/* Shared pure dialogue/backlog formatting policy; exact cache identities stay unchanged. */
(()=>{'use strict';
const slot=Symbol.for('cravesage-translator-mini.dialogue.v1');
function split(text){
  const match=/^<size=([0-9]+(?:\.[0-9]+)?)>/.exec(text);
  if(!match||!text.endsWith('</size>'))return {body:text,open:'',close:''};
  let depth=1;const tags=/<(?:[^>"']|"[^"]*"|'[^']*')*>/g;tags.lastIndex=match[0].length;let tag;
  while((tag=tags.exec(text))){if(tag[0]==='</size>')depth--;else if(/^<size=[^>]*>$/.test(tag[0]))depth++;if(depth===0)return tags.lastIndex===text.length?{body:text.slice(match[0].length,tag.index),open:match[0],close:tag[0]}:{body:text,open:'',close:''};}
  return {body:text,open:'',close:''};
}
const joined=text=>text.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>|\{[^{}]*\}|\r\n|\r|\n/g,token=>token[0]==='<'||token[0]==='{'?token:'');
const key=text=>joined(split(text).body);
const equivalent=(a,b)=>typeof a==='string'&&typeof b==='string'&&key(a)===key(b);
const isStory=context=>typeof context==='string'&&/(?:^|\s\/\s)(?:AdvText|AdvTextExtension|ggMessageView|ggAdultMessageView|AdvRichBackLogText|AdvExtensionLogMessageThumbnail|AdvCommonScrollView)(?:$|\s\/\s)/.test(context);
const canonical=(source,context)=>isStory(context)?split(source).body:source;
function display(raw,text){const wrapper=split(raw),body=split(text).body;return wrapper.open+ (wrapper.open?joined(body):body)+wrapper.close;}
globalThis[slot]=Object.freeze({split,key,equivalent,isStory,canonical,display});
})();
