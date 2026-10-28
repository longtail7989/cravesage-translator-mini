/* Shared, cache-only protagonist-name templates; also usable by side-effect import. */
(() => {
  'use strict';
  const TOKEN = '{USER}';
  const usable = name => typeof name === 'string' && !!name.trim() && name.length <= 64 && !/[<>{}\r\n]/.test(name);
  const unique = names => [...new Set(Array.isArray(names) ? names.filter(usable) : [])];
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function replaceNames(text, aliases) {
    if (typeof text !== 'string') return text;
    const names = unique(aliases).sort((a, b) => b.length - a.length);
    if (!names.length) return text;
    const pattern = new RegExp(names.map(escape).join('|'), 'g');
    // Protected spans are never searched, including tokens produced by an earlier pass.
    return text.split(/(<(?:[^>"']|"[^"]*"|'[^']*')*>|\{[^}]*\})/g).map((part, index) => index % 2 ? part : part.replace(pattern, () => TOKEN)).join('');
  }
  function candidates(source, names) {
    if (typeof source !== 'string') return [];
    const seen = new Set(), result = [];
    for (const name of unique(names)) {
      const canonical = replaceNames(source, [name]);
      if (canonical === source || seen.has(canonical)) continue;
      seen.add(canonical); result.push({source: canonical, name});
    }
    return result;
  }
  function render(template, name, aliases = []) {
    if (typeof template !== 'string') return null;
    // Personalization is display-only and limited to aliases bound by the source.
    if (usable(name)) template = replaceNames(template, aliases);
    if (!template.includes(TOKEN)) return template;
    return usable(name) ? template.replace(/\{USER\}/g, () => name) : null;
  }
  globalThis[Symbol.for('cravesage-translator-mini.names.v1')] = Object.freeze({TOKEN, usable, replaceNames, candidates, render});
})();
