/* MAIN: read verified native story text/progress; never advance or mutate the game. */
(() => {
  'use strict';
  const KEY = Symbol.for('cravesage-translator-mini.story-text.v1');
  if (globalThis[KEY]) return;
  const BODY = new Set(['AdvText', 'AdvTextExtension']);
  function create({getEngine, getRecords}) {
    let segmenter = null;
    function progress(label, nativeFrame) {
      try {
        const engine = getEngine();
        if (!label || (engine?.isValid && !engine.isValid(label)) || !BODY.has(engine?.js?.getClassName?.(label)) || typeof nativeFrame !== 'string' || typeof label.getPlaneText !== 'function' || typeof label.getMaxLength !== 'function') return null;
        const full = label.getPlaneText(), length = label.getMaxLength(), shown = label._dispLength;
        if (typeof full === 'string' && length === full.length && Number.isFinite(shown) && shown >= 0 && shown <= length && nativeFrame.length === Math.trunc(shown) && full.startsWith(nativeFrame)) return {full, length, shown};
      } catch {}
      return null;
    }
    function source(label, nativeFrame) { return progress(label, nativeFrame)?.full ?? nativeFrame; }
    function typingPlan(text) {
      segmenter ??= new Intl.Segmenter(undefined, {granularity: 'grapheme'});
      const units = [], stack = [], spans = [];
      let visible = '', close = '', offset = 0;
      function append(start, end) {
        if (start === end) return;
        spans.push({offset: visible.length, start, length: end - start, close});
        visible += text.slice(start, end);
      }
      function flush() {
        let spanIndex = 0;
        for (const part of segmenter.segment(visible)) {
          const end = part.index + part.segment.length;
          while (end > spans[spanIndex].offset + spans[spanIndex].length) spanIndex++;
          const span = spans[spanIndex];
          units.push({end: span.start + end - span.offset, close: span.close});
        }
        visible = ''; spans.length = 0;
      }
      for (const match of text.matchAll(/<(?:[^>"']|"[^"]*"|'[^']*')*>|\{[^{}]*\}/g)) {
        append(offset, match.index);
        const token = match[0]; offset = match.index + token.length;
        if (token[0] === '{') { flush(); units.push({end: offset, close}); continue; }
        if (token.startsWith('<!--')) continue;
        const end = token.match(/^<\s*\/\s*([A-Za-z][\w:-]*)\s*>$/);
        if (end) {
          if (stack.at(-1)?.toLowerCase() !== end[1].toLowerCase()) return null;
          stack.pop();
        } else {
          const start = token.match(/^<\s*([A-Za-z][\w:-]*)(?=[\s=/>])/);
          if (!start) return null;
          if (!/\/\s*>$/.test(token) && !/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(start[1])) stack.push(start[1]);
        }
        close = stack.slice().reverse().map(name => '</' + name + '>').join('');
      }
      append(offset, text.length); flush();
      // Conservative retained-plan estimate, computed only when parsing a new target.
      const bytes = 128 + units.reduce((size, unit) => size + 64 + unit.close.length * 2, 0);
      return stack.length ? null : {text, units, bytes, count: -1, display: ''};
    }
    function reveal(label, nativeFrame, fullDisplayText) {
      const record = getRecords().get(label), frame = progress(label, nativeFrame);
      if (!record || !frame || frame.shown >= frame.length) {
        if (record) delete record.typingPlan;
        return fullDisplayText;
      }
      let plan = record.typingPlan;
      if (!plan || plan.text !== fullDisplayText) {
        plan = typingPlan(fullDisplayText);
        if (!plan) { delete record.typingPlan; return fullDisplayText; }
        record.typingPlan = plan;
      }
      if (frame.shown === 0) return '';
      const count = Math.min(plan.units.length, Math.max(1, Math.floor(plan.units.length * frame.shown / frame.length)));
      if (plan.count !== count) {
        const unit = plan.units[count - 1];
        plan.display = count === plan.units.length ? fullDisplayText : fullDisplayText.slice(0, unit.end) + unit.close;
        plan.count = count;
      }
      return plan.display;
    }
    return Object.freeze({source, reveal});
  }
  globalThis[KEY] = Object.freeze({create});
})();
