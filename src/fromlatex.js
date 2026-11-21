// Archipelago: the way back, from an edited .tex (Overleaf, another editor) into the document.
//
// The .tex is what latex.js writes: every piece of the body starts with `%% apg <key>`, the key of the section, subsection,
// claim or block it came from. The .tex is read piece by piece and compared with the export of the document as it is now (and,
// when known, with the .tex as it was last written, the base): a piece that changed only in the .tex is translated back.
//
//   text of a paragraph   -> its Markdown (styles, citations, links, lists, quotes, footnotes, comments); new paragraphs
//                            (blank lines) become new paragraphs after it, without a claim; an empty piece empties the
//                            paragraph (its claim stays on the map)
//   section / subsection  -> its title (a changed level is not taken over)
//   figure, table         -> caption, cells; equation -> its content
//   claims, links, map    -> stay as they are (claims are not in the .tex; the `%% apg` lines name them only)
//
// Nothing is lost: LaTeX that has no Markdown form (\ref, \SI, an environment of its own) is kept as raw LaTeX, `\ref{x}`{=latex}
// inline or a ```{=latex} block, which the export writes out as it is. Every translation is checked by exporting it again.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'), require('./latex.js'));
  else root.FromLatex = factory(root.Core, root.Latex);
})(typeof self !== 'undefined' ? self : this, function (C, L) {
  'use strict';

  // ---- comparing LaTeX ----

  /** LaTeX as it reads: lines of one paragraph joined (comment lines keep their line), blank lines one, blanks one. */
  function norm(t) {
    let out = '', prev = null, prevComment = false;
    for (const raw of String(t || '').replace(/\r/g, '').split('\n')) {
      const l = raw.trim();
      if (l === '') { if (prev !== null && prev !== '') out += '\n\n'; prev = ''; continue; }
      const comment = l.startsWith('%');
      if (prev) out += comment || prevComment ? '\n' : ' ';
      out += l; prev = l; prevComment = comment;
    }
    return out.replace(/[ \t]+/g, ' ').trim();
  }

  /** The body of a .tex in pieces: { head, before, pieces: [{ key, label, body }], tail }, or null without `%% apg body`, or
   *  without an end (`%% apg end` or `\\end{document}`). */
  function split(tex) {
    const lines = String(tex || '').replace(/\r/g, '').split('\n');
    const b = lines.findIndex(l => /^%% apg body\s*$/.test(l));
    if (b < 0) return null;
    let e = lines.findIndex((l, k) => k > b && /^%% apg end\s*$/.test(l));
    if (e < 0) e = lines.findIndex((l, k) => k > b && /^\\end\{document\}/.test(l.trim()));
    if (e < 0) return null;   // cut off: what is missing is not "removed"
    const pieces = [], before = [];
    let cur = null;
    for (const l of lines.slice(b + 1, e)) {
      const m = l.match(/^%% apg (\S+)(?: \| (.*))?$/);
      if (m) { cur = { key: m[1], label: m[2] || '', lines: [] }; pieces.push(cur); continue; }
      (cur ? cur.lines : before).push(l);
    }
    return {
      head: lines.slice(0, b).join('\n'), tail: lines.slice(e + 1).join('\n'), before: before.join('\n').trim(),
      pieces: pieces.map(p => ({ key: p.key, label: p.label, body: p.lines.join('\n').trim() })),
    };
  }

  // ---- LaTeX to Markdown, inline ----

  /** The content of the group that opens at s[i] ('{' or '['), and the index after it. */
  function group(s, i) {
    const open = s[i], close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let k = i; k < s.length; k++) {
      if (s[k] === '\\') { k++; continue; }
      if (s[k] === open) depth++;
      else if (s[k] === close && --depth === 0) return [s.slice(i + 1, k), k + 1];
    }
    return null;
  }

  const UNESCAPE = { '%': '%', '&': '&', '#': '#', _: '_', $: '$', '{': '{', '}': '}', ',': ' ' };
  const WORDS = { textbackslash: '\\', textasciitilde: '~', textasciicircum: '^', textless: '<', textgreater: '>', textbar: '|' };
  const MATH = new Map(Object.entries(L.ESC).filter(([, t]) => t.startsWith('$')).map(([ch, t]) => [t, ch]));

  /** Raw LaTeX inside Markdown: `…`{=latex}, with a backtick run longer than any inside. */
  const raw = t => { const run = '`'.repeat(Math.max(0, ...(t.match(/`+/g) || []).map(r => r.length)) + 1); return run + (t.startsWith('`') ? ' ' : '') + t + (t.endsWith('`') ? ' ' : '') + run + '{=latex}'; };

  /** The citation tokens of a Markdown text, by the citation they make: `keys|pre|post` -> the token as written. */
  function citationTokens(md) {
    const out = new Map();
    for (const m of String(md || '').matchAll(/\[\[([^\]\n]*)\]\]|\[([^[\]\n]*@[^[\]\n]*)\]/g)) {
      if (m[1] != null) { const k = L.wikiCitation(m[1]); if (k) out.set(k + '||', m[0]); continue; }
      const c = L.citation(m[2]);
      if (c) out.set(c.keys.join(',') + '|' + c.pre + '|' + c.post, m[0]);
    }
    return out;
  }

  /** LaTeX of a piece of running text to Markdown. `old` is the Markdown it was made from, whose way of citing is kept. */
  function inlineMd(s, old) {
    const tokens = citationTokens(old);
    const conv = t => inlineMd(t, old);
    let out = '', i = 0;
    const plain = ch => { out += ch === '*' || (ch === '[' && /[[@]/.test(s[i + 1] || '')) ? '\\' + ch : ch; };
    while (i < s.length) {
      const ch = s[i], rest = s.slice(i);
      // comment lines (written for %%comments%%)
      if (ch === '\n' && s[i + 1] === '%' || (i === 0 && ch === '%')) {
        let k = ch === '\n' ? i + 1 : i;
        const lines = [];
        while (s[k] === '%') { const e = s.indexOf('\n', k); const l = s.slice(k, e < 0 ? s.length : e); lines.push(l.replace(/^%\s?/, '')); k = e < 0 ? s.length : e + 1; }
        // with a blank on both sides, as the export writes it (the line breaks around a comment are blanks to LaTeX)
        out += (out && !/\s$/.test(out) ? ' ' : '') + '%%' + lines.join('\n') + '%%' + (k < s.length && !/\s/.test(s[k]) ? ' ' : '');
        i = k; continue;
      }
      if (ch === '\n') { out += ' '; i++; continue; }
      if (ch === '\\') {
        const sym = s[i + 1];
        if (sym && UNESCAPE[sym] !== undefined) { out += UNESCAPE[sym]; i += 2; continue; }
        const m = rest.match(/^\\([A-Za-z]+)(\*?)/);
        if (!m) { out += raw(s.slice(i, i + 2)); i += 2; continue; }
        const name = m[1];
        let j = i + m[0].length;
        if (WORDS[name] !== undefined && s.startsWith('{}', j)) { out += WORDS[name]; i = j + 2; continue; }
        // a command with its arguments: [opt]* {arg}*
        const opts = [], args = [];
        while (s[j] === '[') { const g = group(s, j); if (!g) break; opts.push(g[0]); j = g[1]; }
        while (s[j] === '{') { const g = group(s, j); if (!g) break; args.push(g[0]); j = g[1]; }
        const whole = s.slice(i, j);
        let md = null;
        if (!m[2] && !opts.length && args.length === 1) {
          if (name === 'textbf') md = '**' + conv(args[0]) + '**';
          else if (name === 'emph') md = '*' + conv(args[0]) + '*';
          else if (name === 'sout') md = '~~' + conv(args[0]) + '~~';
          else if (name === 'hl') md = '==' + conv(args[0]) + '==';
          else if (name === 'footnote') md = '^[' + conv(args[0]) + ']';
          else if (name === 'url') md = '<' + args[0].replace(/\\([%#\\])/g, '$1') + '>';
          else if (name === 'texttt') md = '`' + args[0].replace(/\\([%&#_${}])/g, '$1').replace(/\\text(backslash|asciitilde|asciicircum|less|greater|bar)\{\}/g, (a, w) => WORDS['text' + w]) + '`';
        }
        if (name === 'href' && !opts.length && args.length === 2) md = '[' + conv(args[1]) + '](' + args[0].replace(/\\([%#\\])/g, '$1') + ')';
        if (name === 'textcolor' && opts[0] === 'HTML' && args.length === 2) md = '<span style="color:#' + args[0].toLowerCase() + '">' + conv(args[1]) + '</span>';
        if (name === 'cite' && args.length === 1 && opts.length <= 2) {
          const keys = args[0].split(',').map(x => x.trim()).filter(Boolean);
          const pre = opts.length === 2 ? conv(opts[0]) : '', post = opts.length ? conv(opts[opts.length - 1]) : '';
          md = tokens.get(keys.join(',') + '|' + pre + '|' + post)
            || (keys.length === 1 && !pre && !post && tokens.get(keys[0] + '||'))
            || '[' + (pre ? pre + ' ' : '') + keys.map(k => '@' + k).join('; ') + (post ? ', ' + post : '') + ']';
        }
        out += md !== null ? md : raw(whole);
        i = j; continue;
      }
      if (ch === '{') {
        const hl = rest.match(/^\{\\definecolor\{apghl\}\{HTML\}\{([0-9A-Fa-f]{6})\}\\sethlcolor\{apghl\}\\hl\{/);
        const g = group(s, i);
        if (hl && g && g[0].endsWith('}')) {
          const inner = group(s, i + hl[0].length - 1);
          if (inner && inner[1] === g[1] - 1) { out += '<mark style="background:#' + hl[1].toLowerCase() + '">' + conv(inner[0]) + '</mark>'; i = g[1]; continue; }
        }
        if (g) { out += raw(s.slice(i, g[1])); i = g[1]; continue; }
      }
      if (ch === '$') {
        let e = i + 1;
        while (e < s.length && !(s[e] === '$' && s[e - 1] !== '\\')) e++;
        const math = s.slice(i, e + 1);
        out += MATH.has(math) ? MATH.get(math) : math;
        i = e + 1; continue;
      }
      if (rest.startsWith('``') || rest.startsWith("''")) { out += '"'; i += 2; continue; }
      if (ch === '~') { out += ' '; i++; continue; }
      plain(ch); i++;
    }
    return out;
  }

  const scratch = () => ({ cites: new Set(), warnings: [], features: new Set() });
  const same = (a, b) => norm(a) === norm(b);

  /** Inline LaTeX to Markdown, checked: the export of the Markdown must give the same LaTeX, else it stays raw. */
  function inlineChecked(tex, old) {
    const md = inlineMd(tex, old);
    return same(L.inline(md, scratch()), tex) ? md : raw(tex);
  }

  // ---- LaTeX to Markdown, blocks of a paragraph ----

  const HEADING = /^\\(subsection|subsubsection|paragraph|subparagraph)\*?\{/;

  /** `\begin{env}` at line k: the index of its `\end{env}` line (nested ones counted), or -1. */
  function envEnd(lines, k, env) {
    let depth = 0;
    for (let j = k; j < lines.length; j++) {
      depth += (lines[j].match(new RegExp('\\\\begin\\{' + env + '\\}', 'g')) || []).length;
      depth -= (lines[j].match(new RegExp('\\\\end\\{' + env + '\\}', 'g')) || []).length;
      if (depth <= 0) return j;
    }
    return -1;
  }

  /** itemize/enumerate lines to Markdown list lines (nested lists indented). */
  function listMd(lines, old) {
    const out = [], stack = [];
    let item = null;
    const done = () => { if (item) { out.push(item.indent + item.marker + inlineMd(item.text.trim(), old)); item = null; } };
    for (const raw0 of lines) {
      const l = raw0.trim();
      const b = l.match(/^\\begin\{(itemize|enumerate)\}/);
      if (b) { done(); stack.push({ ordered: b[1] === 'enumerate', n: 0 }); continue; }
      if (/^\\end\{(itemize|enumerate)\}/.test(l)) { done(); stack.pop(); continue; }
      const it = l.match(/^\\item\s?(.*)$/);
      if (it && stack.length) {
        done();
        const top = stack[stack.length - 1];
        top.n++;
        const indent = stack.slice(0, -1).map(e => (e.ordered ? '   ' : '  ')).join('');
        item = { indent, marker: top.ordered ? top.n + '. ' : '- ', text: it[1] };
        continue;
      }
      if (item) item.text += '\n' + l;
    }
    done();
    return out;
  }

  /** The Markdown paragraphs of the LaTeX of one prose piece. Each one is checked by exporting it again; one that does not come
   *  back the same is kept as a raw LaTeX block. */
  function blocksMd(body, old) {
    const lines = body.split('\n'), paras = [];
    let md = [], tex = [], run = [];
    const flushRun = () => { if (run.length) { md.push(inlineMd(run.join('\n').trim(), old)); run = []; } };
    const endPara = () => {
      flushRun();
      if (!tex.length) return;
      const m = md.join('\n'), t = tex.join('\n');
      paras.push(same(L.proseText(m, scratch()), t) ? m : '```{=latex}\n' + t.trim() + '\n```');
      md = []; tex = [];
    };
    for (let k = 0; k < lines.length;) {
      const l = lines[k], t = l.trim();
      if (t === '') { endPara(); k++; continue; }
      const env = t.match(/^\\begin\{([A-Za-z*]+)\}/);
      if (env) {
        const e = envEnd(lines, k, env[1].replace('*', '\\*'));
        const chunk = lines.slice(k, e < 0 ? lines.length : e + 1);
        flushRun();
        tex.push(...chunk);
        if (env[1] === 'itemize' || env[1] === 'enumerate') md.push(...listMd(chunk, old));
        else if (env[1] === 'quote') md.push(...blocksMd(chunk.slice(1, -1).join('\n'), old).join('\n').split('\n').map(x => '> ' + x));
        else if (env[1] === 'verbatim') md.push('```', ...chunk.slice(1, -1), '```');
        else md.push('```{=latex}', ...chunk, '```');
        k = e < 0 ? lines.length : e + 1;
        continue;
      }
      const hd = t.match(HEADING);
      if (hd) {
        // a heading of its own: a new subsection in the document
        endPara();
        const g = group(t, t.indexOf('{'));
        const lvl = L.SECTIONING.indexOf('\\' + hd[1]) + 2;
        paras.push(g ? '#'.repeat(lvl) + ' ' + inlineChecked(g[0], old) : '```{=latex}\n' + t + '\n```');
        k++; continue;
      }
      tex.push(l); run.push(l); k++;
    }
    endPara();
    return paras;
  }

  // ---- pieces back into the document ----

  /** `\cmd{title}` (with an optional \label line) of a heading piece: { cmd, title } or null. */
  function headingOf(body) {
    const t = body.trim(), m = t.match(/^\\(section|subsection|subsubsection|paragraph|subparagraph)\*?(?=\{)/);
    if (!m) return null;
    const g = group(t, m[0].length);
    if (!g || !/^\s*(\\label\{[^}]*\})?\s*$/.test(t.slice(g[1]))) return null;
    return { cmd: m[1], title: g[0] };
  }

  /** The value of the first \cmd{…} in a text, or null. */
  function argOf(t, cmd) {
    const i = t.indexOf('\\' + cmd + '{');
    if (i < 0) return null;
    const g = group(t, i + cmd.length + 1);
    return g ? g[0] : null;
  }

  /** The document's pieces by key: sections and paragraphs, keyed as latex.js keys them. */
  function itemsOf(d) {
    const items = new Map();
    d.sections.forEach((s, si) => {
      const sk = s.sid || 's#' + (si + 1);
      items.set(sk, { type: 'section', s });
      s.paragraphs.forEach((p, pi) => items.set(p.cid || `${sk}/${pi + 1}`, { type: C.kind(p), s, p }));
    });
    return items;
  }

  /** Take the edits of an outside .tex over into document `d` (changed in place).
   *  opts: theirs (the .tex), base (the .tex as last written, or null), and the export options of latex.js (template,
   *  figurePath, bibFiles, …), with which the document's own .tex is made for the comparison.
   *  Returns { changed (count), report: [{ key, kind: 'applied' | 'skipped' | 'conflict' | 'note', text }] }. */
  function importTex(d, opts) {
    const report = [], note = (kind, key, text) => report.push({ kind, key, text });
    const T = split(opts.theirs);
    if (!T) { note('skipped', '', 'The .tex has no "%% apg body" line or no end ("%% apg end", \\end{document}): it was not written by Archipelago, or it is cut off'); return { changed: 0, report }; }
    const ours = L.toLatex(d, opts), O = split(ours.tex), B = opts.base ? split(opts.base) : null;
    const map = x => new Map(x.pieces.map(p => [p.key, p]));
    const om = map(O), tm = map(T), bm = B ? map(B) : null;
    const items = itemsOf(d), inserts = [];
    let changed = 0;
    // Title, author and date are the document's (front matter): changed in the .tex, they are taken over.
    for (const [cmd, what] of [['title', 'title'], ['author', 'author'], ['date', 'date']]) {
      const t = argOf(T.head, cmd), o = argOf(O.head, cmd), b = B ? argOf(B.head, cmd) : null;
      if (t === null || o === null || same(t, o) || (B && b !== null && same(t, b))) continue;
      if (B && b !== null && !same(o, b)) { note('conflict', '', `The ${what} was changed in the document and in the .tex: the document's is kept`); continue; }
      if (cmd === 'title' && C.trimmed(d.thesis)) { note('skipped', '', 'The title was changed in the .tex: with a subtitle it is changed in the document'); continue; }
      const md = cmd === 'date' && t.trim() === '\\today' ? '' : inlineChecked(t.replace(/\s*\n\s*/g, ' ').trim(), cmd === 'title' ? d.title : L.front(d, cmd));
      if (cmd === 'title') d.title = md; else L.setFront(d, cmd, md);
      changed++; note('applied', '', `The ${what} was taken over`);
    }
    // What else of the preamble differs (packages, macros, the class) is not the document's: `preamble` carries it for the caller
    // to ask what to do with it (making it the document's template, or having the template replace it).
    const head = split(L.toLatex(d, opts).tex).head;
    const preamble = !same(T.head, head) && !(B && same(T.head, B.head)) ? T.head : null;
    if (!same(T.tail, O.tail) && !(B && same(T.tail, B.tail))) note('note', '', 'The end of the .tex (after the text) was changed: that is not taken over');
    if (T.before) note('skipped', '', 'Text before the first "%% apg" line is not taken over: ' + T.before.slice(0, 60));

    const apply = (key, it, body) => {
      const p = it.p;
      if (it.type === 'section' || it.type === 'group') {
        const h = headingOf(body);
        const want = it.type === 'section' ? 'section' : L.SECTIONING[C.level(p) - 2].slice(1);
        if (!h) return note('skipped', key, 'A heading that is not a single \\' + want + '{…} is not taken over');
        if (h.cmd !== want) return note('skipped', key, `\\${want} became \\${h.cmd}: levels change in Map or Prose`);
        const title = inlineChecked(h.title, it.type === 'section' ? it.s.title : C.groupName(p));
        if (it.type === 'section') it.s.title = title; else C.setGroupName(p, title);
        return true;
      }
      if (it.type === 'prose') {
        const paras = blocksMd(body, p.text);
        p.text = paras.length ? paras[0] : '';
        for (const md of paras.slice(1).reverse()) inserts.push({ s: it.s, after: p, p: C.newParagraph({ text: md }) });
        if (!paras.length) note('applied', key, 'The paragraph was removed in the .tex: its text is emptied, its claim stays');
        return true;
      }
      if (it.type === 'equation') {
        const m = body.match(/\\begin\{equation\}\s*\n?([^]*?)\n?(?:\\label\{[^}]*\}\s*)?\\end\{equation\}/);
        if (!m) return note('skipped', key, 'The equation is no longer an equation environment');
        let eq = m[1].trim();
        const wrapped = eq.match(/^\\begin\{aligned\}\s*\n?([^]*?)\n?\\end\{aligned\}$/);
        if (wrapped && !C.equation(p).includes('\\begin{')) eq = wrapped[1].trim();
        p.text = eq.includes('\n') ? '$$\n' + eq + '\n$$' : '$$ ' + eq + ' $$';
        return true;
      }
      if (it.type === 'figure') {
        const f = C.figure(p), cap = argOf(body, 'caption');
        if (!f || cap === null) return note('skipped', key, 'The figure has no \\caption any more');
        p.text = '![' + inlineChecked(cap, f.caption) + '](' + f.path + ')';
        return true;
      }
      if (it.type === 'table') {
        const tab = body.match(/\\begin\{tabular\}\{[^}]*\}([^]*?)\\end\{tabular\}/);
        if (!tab) return note('skipped', key, 'The table has no tabular any more');
        const rows = tab[1].split(/\\\\/).map(r => r.replace(/\\(toprule|midrule|bottomrule)/g, '').trim()).filter(Boolean)
          .map(r => r.split(/(?<!\\)&/).map(c => inlineChecked(c.trim(), p.text)));
        const lines = p.text.split('\n'), rule = lines.find(l => /^\s*\|[\s|:-]+\|\s*$/.test(l) && l.includes('-'));
        const capLine = lines.find(l => /^(Table)?:\s/.test(l.trim()));
        const n = Math.max(...rows.map(r => r.length));
        const md = r => '| ' + Array.from({ length: n }, (_, k) => r[k] || '').join(' | ') + ' |';
        const out = [md(rows[0]), rule || '|' + ' --- |'.repeat(n), ...rows.slice(1).map(md)];
        const cap = argOf(body, 'caption');
        if (cap !== null && capLine) out.push('Table: ' + inlineChecked(cap, capLine));
        else if (cap !== null) p.claim = inlineChecked(cap, p.claim);   // without a Table: line, the claim is the caption
        p.text = out.join('\n');
        return true;
      }
      return note('skipped', key, 'Not taken over');
    };

    for (const [key, o] of om) {
      if (key.startsWith('cite:')) continue;   // made from the papers of claims: moved or removed in the .tex, it stays that way there
      const it = items.get(key), t = tm.get(key), b = bm ? bm.get(key) : undefined;
      if (!it) continue;
      const theirs = t ? t.body : null;
      if (theirs !== null && same(theirs, o.body)) continue;
      if (b !== undefined) {
        if (theirs !== null && same(theirs, b.body)) continue;   // changed in the document only: the next export has it
        if (!same(o.body, b.body)) { note('conflict', key, 'Changed in the document and in the .tex: the document\'s version is kept'); continue; }
      }
      if (theirs === null) {
        if (bm && b === undefined) continue;   // new in the document since the .tex was written: not removed there
        if (it.type === 'prose' && C.trimmed(it.p.text) !== '') { it.p.text = ''; changed++; note('applied', key, 'Removed in the .tex: the paragraph is emptied, its claim stays'); }
        else if (it.type !== 'prose') note('skipped', key, 'Removed in the .tex: not removed from the document (do that in Map or Prose)');
        continue;
      }
      const before = JSON.stringify(it.p || it.s.title);
      const ok = apply(key, it, theirs);
      if (ok === true && JSON.stringify(it.p || it.s.title) !== before) { changed++; if (!report.some(r => r.key === key)) note('applied', key, 'Taken over'); }
    }
    for (const t of T.pieces) {
      if (!om.has(t.key) && !t.key.startsWith('cite:') && !(bm && bm.has(t.key))) note('skipped', t.key, 'A piece the document does not have (its marker line was copied or made up): not taken over');
    }
    for (const ins of inserts) {
      const k = ins.s.paragraphs.indexOf(ins.after);
      ins.s.paragraphs.splice(k + 1, 0, ins.p);
      changed++;
    }
    for (const s of d.sections) C.normalizeGroups(s);
    return { changed, report, preamble };
  }

  /** The preamble and end of `theirs` as a template of the document (title, author, date, bibliography and body as placeholders),
   *  or null when the template would not give the .tex back. `opts` as for importTex (the document `d` after taking over). */
  function templateFrom(d, theirs, opts) {
    const T = split(theirs);
    if (!T) return null;
    let head = T.head;
    for (const [cmd, value] of [['title', C.trimmed(d.title)], ['author', L.front(d, 'author')], ['date', L.front(d, 'date')]]) {
      const m = new RegExp('^[^%\\n]*?(\\\\' + cmd + '\\{)', 'm').exec(head), i = m ? m.index + m[0].length - m[1].length : -1;
      const g = i < 0 ? null : group(head, i + cmd.length + 1);
      if (g && value && same(g[0], L.inline(value, scratch()))) head = head.slice(0, i) + '\\' + cmd + '{{{' + cmd + '}}}' + head.slice(g[1]);
    }
    const tail = T.tail.replace(/\\bibliographystyle\{[^}]*\}\s*\\bibliography\{[^}]*\}/, '{{bibliography}}');
    const text = head + '\n{{body}}\n' + tail;
    const back = split(L.toLatex(d, { ...opts, template: text }).tex);
    return back && same(back.head, T.head) && same(back.tail, T.tail) ? text : null;
  }

  return { norm, split, inlineMd, inlineChecked, blocksMd, importTex, templateFrom };
});
