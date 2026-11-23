// Archipelago: basic text styles in Markdown, for Map and Prose. Shared by the UI, which shows them and applies them
// (right-click on a selection, Ctrl+B / Ctrl+I), and tested without a browser.
//
//   **bold**   *italic*   ~~strike-through~~   ==highlight==   %%comment%%
//   <span style="color:#e03131">coloured text</span>   <mark style="background:#a5d8ff">coloured highlight</mark>
//
// These are Obsidian's own syntaxes (`==` and `%%` are Obsidian's highlight and comment), and latex.js turns
// each of them into LaTeX. `spans` reads a text into styled pieces that, put together, are the text again, markers included.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rich = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TEXT_COLORS = { red: '#e03131', orange: '#e8590c', green: '#2f9e44', blue: '#1971c2', purple: '#9c36b5', gray: '#868e96' };
  const HIGHLIGHTS = { yellow: '#ffe066', green: '#b2f2bb', blue: '#a5d8ff', pink: '#fcc2d7', orange: '#ffd8a8' };
  const YELLOW = HIGHLIGHTS.yellow;

  /** A colour as '#rrggbb' (a name of the lists above, #rgb, #rrggbb), or null. */
  function hex(c) {
    c = String(c || '').trim().toLowerCase();
    if (TEXT_COLORS[c]) return TEXT_COLORS[c];
    if (HIGHLIGHTS[c]) return HIGHLIGHTS[c];
    if (/^#[0-9a-f]{6}$/.test(c)) return c;
    if (/^#[0-9a-f]{3}$/.test(c)) return '#' + [...c.slice(1)].map(x => x + x).join('');
    return null;
  }

  const SPAN_OPEN = /^<span style="color:\s*([^";]+?);?\s*">/;
  const MARK_OPEN = /^<mark style="background(?:-color)?:\s*([^";]+?);?\s*">/;

  /** The opening marker at the start of `s`: { len, close, style } or null. */
  function opener(s) {
    if (s.startsWith('**')) return { len: 2, close: '**', style: { b: true }, strong: true };
    if (s.startsWith('~~')) return { len: 2, close: '~~', style: { s: true } };
    if (s.startsWith('==')) return { len: 2, close: '==', style: { bg: YELLOW } };
    if (s.startsWith('%%')) return { len: 2, close: '%%', style: { c: true } };
    if (s[0] === '*') return { len: 1, close: '*', style: { i: true }, strong: true };
    let m = s.match(SPAN_OPEN);
    if (m && hex(m[1])) return { len: m[0].length, close: '</span>', style: { color: hex(m[1]) } };
    m = s.match(MARK_OPEN);
    if (m && hex(m[1])) return { len: m[0].length, close: '</mark>', style: { bg: hex(m[1]) } };
    return null;
  }

  /** Where the marker `o` that opened at `i` closes, or -1. */
  function closer(s, i, o) {
    let from = i + o.len;
    if (o.strong && (from >= s.length || /\s/.test(s[from]))) return -1;   // `* x*` and `** x**` are not emphasis
    for (;;) {
      const e = s.indexOf(o.close, from);
      if (e < 0 || e === from) return -1;
      // a single * is not the start of **, and a closing marker is not preceded by a blank
      if (o.close === '*' && (s[e + 1] === '*' || s[e - 1] === '*')) { from = e + 1; continue; }
      if (o.strong && /\s/.test(s[e - 1])) { from = e + o.close.length; continue; }
      let at = e;
      if (o.close === '**') while (s[at + 2] === '*') at++;   // `***x***`: the closing ** are the last two stars
      return at;
    }
  }

  /** A link at the start of `s`: `[[target|alias]]` (Obsidian's; a note whose name or alias starts with @ is a literature note,
   *  cited as `@key`) or `[label](url)`. { len, link, label, cite } or null. */
  function linkAt(s) {
    if (s.startsWith('[[')) {
      const e = s.indexOf(']]');
      if (e < 3) return null;
      const inner = s.slice(2, e);
      if (inner.includes('\n') || inner.includes('[')) return null;
      const bar = inner.indexOf('|'), target = (bar >= 0 ? inner.slice(0, bar) : inner).trim(), alias = bar >= 0 ? inner.slice(bar + 1).trim() : '';
      const file = target.replace(/#.*$/, ''), name = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/i, '');
      const key = [name, alias].find(c => /^@[^\s,{}@]+$/.test(c));   // the note's name first, as latex.js
      return { len: e + 2, link: target, label: key || alias || name || target, cite: key ? key.slice(1) : null };
    }
    if (s[0] === '[') {
      const m = s.match(/^\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
      if (m && !m[2].startsWith('#') ) return { len: m[0].length, link: m[2], label: m[1] || m[2], cite: null, url: true };
    }
    return null;
  }

  /** The text as styled pieces: [{ t, mk, b, i, s, bg, color, c, code, link, label }] (mk: a marker character run; link: a link
   *  piece, `t` its text as written and `label` what to show). `t` of all pieces joined is `text`. Code spans and $math$ are
   *  left alone. */
  function spans(text) {
    const out = [];
    const push = (t, style, mk, extra) => { if (t) out.push({ t, mk: !!mk, ...style, ...extra }); };
    (function walk(s, style) {
      let i = 0, plain = '';
      const flush = () => { push(plain, style, false); plain = ''; };
      while (i < s.length) {
        const ch = s[i];
        if (ch === '\\' && i + 1 < s.length) { plain += s.slice(i, i + 2); i += 2; continue; }
        if (ch === '`') {
          const run = s.slice(i).match(/^`+/)[0], e = s.indexOf(run, i + run.length);
          if (e > 0) { flush(); push(s.slice(i, e + run.length), style, false, { code: true }); i = e + run.length; continue; }
        }
        if (ch === '$' && s[i + 1] && s[i + 1] !== '$' && !/\s/.test(s[i + 1])) {
          let e = i + 1;
          while (e < s.length && !(s[e] === '$' && s[e - 1] !== '\\')) e++;
          if (e < s.length && !/\s/.test(s[e - 1])) { plain += s.slice(i, e + 1); i = e + 1; continue; }
        }
        if (ch === '[') {
          const l = linkAt(s.slice(i));
          if (l) { flush(); push(s.slice(i, i + l.len), style, false, { link: l.link, label: l.label, cite: l.cite, url: !!l.url }); i += l.len; continue; }
        }
        const o = '*~=%<'.includes(ch) ? opener(s.slice(i)) : null;
        const e = o ? closer(s, i, o) : -1;
        if (o && e > 0) {
          flush();
          push(s.slice(i, i + o.len), style, true);
          const inner = s.slice(i + o.len, e);
          if (o.style.c) push(inner, { ...style, ...o.style }, false);   // a comment is not read for styles inside it
          else walk(inner, { ...style, ...o.style });
          push(s.slice(e, e + o.close.length), style, true);
          i = e + o.close.length;
          continue;
        }
        plain += ch; i++;
      }
      flush();
    })(String(text), {});
    return out;
  }

  /** The text without any markers: what the styles are applied to. */
  const plain = text => spans(text).filter(p => !p.mk).map(p => p.t).join('');

  // ---- applying a style to a selection ----

  const WRAP = {
    b: () => ['**', '**'], i: () => ['*', '*'], s: () => ['~~', '~~'], c: () => ['%%', '%%'],
    hl: c => { const h = HIGHLIGHTS[String(c || '').toLowerCase()] || hex(c) || YELLOW; return h === YELLOW ? ['==', '=='] : [`<mark style="background:${h}">`, '</mark>']; },
    color: c => [`<span style="color:${hex(c) || TEXT_COLORS.red}">`, '</span>'],
  };

  /** Apply (or, when it is applied already, remove) a style on the selection [s, e) of `text`.
   *  kind: 'b' bold, 'i' italic, 's' strike-through, 'hl' highlight (arg: colour, yellow by default), 'color' (arg),
   *  'c' comment, 'clear' (every style of the selection). Returns { text, s, e } with the selection on the same words. */
  function toggle(text, s, e, kind, arg) {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (s >= e) return { text, s, e };
    if (kind === 'clear') {
      let sel = text.slice(s, e);
      // markers right outside the selection go too
      for (let k = 0; k < 6; k++) {
        const before = text.slice(0, s), after = text.slice(e);
        const hit = ['**', '~~', '==', '%%', '*'].find(m => before.endsWith(m) && after.startsWith(m))
          || [/<span style="color:[^">]*">$/, /<mark style="background[^">]*">$/].map(re => (before.match(re) || [null])[0]).find(Boolean);
        if (!hit) break;
        const close = typeof hit === 'string' && !hit.startsWith('<') ? hit : (hit.startsWith('<span') ? '</span>' : '</mark>');
        if (!after.startsWith(close)) break;
        text = before.slice(0, before.length - hit.length) + sel + after.slice(close.length);
        s -= hit.length; e -= hit.length;
      }
      sel = text.slice(s, e);
      const bare = spans(sel).filter(p => !p.mk).map(p => p.t).join('');
      return { text: text.slice(0, s) + bare + text.slice(e), s, e: s + bare.length };
    }
    const [open, close] = WRAP[kind](arg), sel = text.slice(s, e);
    const re = kind === 'color' ? /^<span style="color:[^">]*">/ : kind === 'hl' ? /^(==|<mark style="background[^">]*">)/ : null;
    const closeAny = kind === 'color' ? '</span>' : kind === 'hl' ? null : close;
    // 1. the selection is wrapped itself
    const inner = re ? (sel.match(re) || [null])[0] : sel.startsWith(open) ? open : null;
    const innerClose = kind === 'hl' && inner ? (inner === '==' ? '==' : '</mark>') : closeAny;
    if (inner && sel.length >= inner.length + innerClose.length && sel.endsWith(innerClose)) {
      const body = sel.slice(inner.length, sel.length - innerClose.length);
      const same = inner === open;
      const next = same ? body : open + body + close;
      return { text: text.slice(0, s) + next + text.slice(e), s: s + (same ? 0 : open.length), e: s + (same ? body.length : open.length + body.length) };
    }
    // 2. the markers are right outside the selection
    const before = text.slice(0, s), after = text.slice(e);
    const outerOpen = re ? (before.match(new RegExp(re.source.replace('^', '') + '$')) || [null])[0] : before.endsWith(open) ? open : null;
    const outerClose = kind === 'hl' && outerOpen ? (outerOpen === '==' ? '==' : '</mark>') : closeAny;
    if (outerOpen && after.startsWith(outerClose) && !(open === '*' && (before.endsWith('**') || after.startsWith('**')) && !before.endsWith('***'))) {
      const same = outerOpen === open;
      const head = before.slice(0, before.length - outerOpen.length), tail = after.slice(outerClose.length);
      if (same) return { text: head + sel + tail, s: head.length, e: head.length + sel.length };
      return { text: head + open + sel + close + tail, s: head.length + open.length, e: head.length + open.length + sel.length };
    }
    // 3. wrap
    return { text: before + open + sel + close + after, s: s + open.length, e: e + open.length };
  }

  return { TEXT_COLORS, HIGHLIGHTS, hex, spans, plain, toggle, linkAt };
});
