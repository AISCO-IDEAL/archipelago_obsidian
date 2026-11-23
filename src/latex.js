// Archipelago: a document as LaTeX. Deterministic: the same document and template give the same text.
// The LaTeX is derived from the document and never the other way round (Map and Prose are where it is edited).
//
// Every piece of the body starts with a marker comment, `%% apg <key>`, which names the section, claim or block it
// came from (`s1`, `c12`, or `s1/3` for a paragraph without an id). LaTeX ignores comments, so the PDF is the same with
// or without them; they let a compile error be traced to its paragraph, and they are what a later way back from
// edited LaTeX into the document will go by.
//
// Templates are LaTeX files with placeholders: {{title}}, {{thesis}}, {{author}}, {{date}}, {{babel}}, {{body}},
// {{bibliography}}, {{bibfiles}}. `{{#key}} … {{/key}}` keeps what is between only when the value is not empty
// (`{{^key}} … {{/key}}`: only when it is). Placeholders the template does not use are simply not there.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.Latex = factory(root.Core);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  // ---- templates that come with the app ----

  const ARTICLE = String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage[{{babel}}]{babel}
\usepackage{lmodern}
\usepackage{microtype}
\usepackage[margin=25mm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[numbers,sort&compress]{natbib}
\usepackage[hidelinks]{hyperref}

\setcounter{secnumdepth}{5}
\title{{{title}}{{#thesis}}\\[0.8em]\large\itshape {{thesis}}{{/thesis}}}
\author{{{author}}}
\date{{{date}}}

\begin{document}
\maketitle

{{body}}

{{bibliography}}
\end{document}
`;

  const PLEX = String.raw`\documentclass[10pt,a4paper]{article}
\usepackage[left=24mm,right=24mm,top=22mm,bottom=24mm,footskip=10mm]{geometry}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage[sfdefault]{plex-sans}
\usepackage[{{babel}}]{babel}
\usepackage{xcolor}
\usepackage{microtype}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{enumitem}
\usepackage{needspace}
\usepackage{fancyhdr}
\usepackage[numbers,sort&compress]{natbib}
\usepackage[hidelinks]{hyperref}

\definecolor{muted}{gray}{0.42}
\setcounter{secnumdepth}{5}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0.55em}
\setlist{itemsep=0.15em,topsep=0.3em}
\pagestyle{fancy}
\fancyhf{}
\renewcommand{\headrulewidth}{0pt}
\fancyfoot[L]{\color{muted}\footnotesize {{title}}}
\fancyfoot[R]{\color{muted}\footnotesize\thepage}

\makeatletter
\renewcommand{\section}{\@startsection{section}{1}{0pt}{1.6em}{0.5em}{\needspace{4\baselineskip}\large\bfseries}}
\renewcommand{\subsection}{\@startsection{subsection}{2}{0pt}{1.1em}{0.3em}{\needspace{3\baselineskip}\normalsize\bfseries\color{muted}}}
\renewcommand{\subsubsection}{\@startsection{subsubsection}{3}{0pt}{0.9em}{0.25em}{\needspace{3\baselineskip}\normalsize\itshape\color{muted}}}
\makeatother

\begin{document}
{\LARGE\bfseries {{title}}\par}
{{#thesis}}\vspace{0.5em}{\large\color{muted} {{thesis}}\par}{{/thesis}}
{{#author}}\vspace{0.8em}{\normalsize {{author}}\par}{{/author}}
{{#date}}{\footnotesize\color{muted} {{date}}\par}{{/date}}
\vspace{1.5em}

{{body}}

{{bibliography}}
\end{document}
`;

  const BUILTIN = [
    { name: 'article', text: ARTICLE, builtin: true },
    { name: 'plex', text: PLEX, builtin: true },
  ];

  // ---- inline Markdown ----

  /** LaTeX's special characters, and a few Unicode signs pdflatex does not know on its own. */
  const ESC = {
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&', '#': '\\#', '%': '\\%', '_': '\\_',
    '^': '\\textasciicircum{}', '~': '\\textasciitilde{}', '<': '\\textless{}', '>': '\\textgreater{}', '|': '\\textbar{}',
    '→': '$\\rightarrow$', '←': '$\\leftarrow$', '↔': '$\\leftrightarrow$', '⇒': '$\\Rightarrow$', '≤': '$\\leq$', '≥': '$\\geq$',
    '≠': '$\\neq$', '≈': '$\\approx$', '×': '$\\times$', '±': '$\\pm$', '∞': '$\\infty$', '−': '$-$', '·': '$\\cdot$',
    '\u00A0': '~', '\u2009': '\\,', '\u202F': '\\,',
  };
  const escape = s => s.replace(/[\\{}$&#%_^~<>|→←↔⇒≤≥≠≈×±∞−·\u00A0\u2009\u202F]/g, ch => ESC[ch]);
  /** A URL inside \href or \url: only these three need a backslash there. */
  const escapeURL = s => s.replace(/[%#\\]/g, ch => '\\' + ch);

  /** Index of the `close` that ends what opened at i (brackets nest), or -1. */
  function closing(s, i, open, close) {
    let depth = 0;
    for (let k = i; k < s.length; k++) {
      if (s[k] === '\\') { k++; continue; }
      if (s[k] === open) depth++;
      else if (s[k] === close && --depth === 0) return k;
    }
    return -1;
  }

  const KEY = /^@([A-Za-z0-9_][\w:.#$%&+?<>~/-]*)/;

  /** `[@a; @b, p. 3]` (Pandoc's citation syntax) as { keys, pre, post }, or null when it is not one. */
  function citation(inner) {
    const parts = inner.split(';').map(C.trimmed);
    if (!parts.length || parts.some(p => !p.includes('@'))) return null;
    const keys = [];
    let pre = '', post = '';
    for (const [n, part] of parts.entries()) {
      const at = part.search(/(^|\s)-?@/);
      if (at < 0) return null;
      const before = C.trimmed(part.slice(0, at)), rest = part.slice(at).replace(/^\s/, '').replace(/^-/, '');
      const m = rest.match(KEY);
      if (!m) return null;
      const key = m[1].replace(/[.,:;]+$/, ''), after = C.trimmed(rest.slice(1 + key.length).replace(/^,/, ''));
      keys.push(key);
      if (n === 0) pre = before;
      if (n === parts.length - 1) post = after;
    }
    return { keys, pre, post };
  }

  const CSS_COLORS = { red: 'E03131', orange: 'E8590C', green: '2F9E44', blue: '1971C2', purple: '9C36B5', gray: '868E96', yellow: 'FFE066', pink: 'FCC2D7', black: '000000' };
  /** A CSS colour (#rgb, #rrggbb, or a name of a few) as HTML colour digits for xcolor, or null. */
  function cssColor(c) {
    c = String(c || '').trim().toLowerCase();
    if (CSS_COLORS[c]) return CSS_COLORS[c];
    if (/^#[0-9a-f]{6}$/.test(c)) return c.slice(1).toUpperCase();
    if (/^#[0-9a-f]{3}$/.test(c)) return [...c.slice(1)].map(x => x + x).join('').toUpperCase();
    return null;
  }

  /** The citation key of the inside of a wiki link `target|alias`: the alias when it starts with @, else the note's name when
   *  that does (`Source/@berzins2025`). null for an ordinary link. */
  function wikiCitation(t) {
    const bar = t.indexOf('|'), target = (bar >= 0 ? t.slice(0, bar) : t).replace(/#.*$/, ''), alias = bar >= 0 ? C.trimmed(t.slice(bar + 1)) : '';
    const name = target.slice(target.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    // the note's own name first (`Source/@key`): the alias is text typed by hand, and a typo in it must not change the key
    for (const c of [name, alias]) if (/^@[^\s,{}@]+$/.test(c)) return c.slice(1);
    return null;
  }

  /** Inline Markdown to LaTeX: emphasis, code, math, links, citations, footnotes; everything else is text.
   *  `ctx` collects what the document cites and what could not be shown. */
  function inline(s, ctx) {
    let out = '', i = 0;
    const text = t => { out += escape(t); };
    while (i < s.length) {
      const ch = s[i], rest = s.slice(i);
      // a backslash before Markdown punctuation makes it a plain character
      if (ch === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!$@|<>~^%&]/.test(s[i + 1])) { text(s[i + 1]); i += 2; continue; }
      // HTML comments are not part of the text
      if (rest.startsWith('<!--')) { const e = s.indexOf('-->', i + 4); i = e < 0 ? s.length : e + 3; continue; }
      // %%comment%% (Obsidian's): a LaTeX comment on lines of its own, so it is in the .tex and not in the PDF
      if (rest.startsWith('%%')) {
        const e = s.indexOf('%%', i + 2);
        if (e > i + 2) { out += '\n' + s.slice(i + 2, e).trim().split(/\n/).map(l => '% ' + l.trim()).join('\n') + '\n'; i = e + 2; continue; }
      }
      // ~~strike-through~~, ==highlight==, <span style="color:…">, <mark style="background:…">
      let handled = false;
      for (const [mark, wrap, feature] of [['~~', t => '\\sout{' + t + '}', 'sout'], ['==', t => '\\hl{' + t + '}', 'soul']]) {
        if (!rest.startsWith(mark)) continue;
        const e = s.indexOf(mark, i + 2);
        if (e > i + 2) { ctx.features.add(feature); out += wrap(inline(s.slice(i + 2, e), ctx)); i = e + 2; handled = true; break; }
      }
      if (handled) continue;
      {
        const sp = rest.match(/^<(span) style="color:\s*([^";]+?);?\s*">/) || rest.match(/^<(mark) style="background(?:-color)?:\s*([^";]+?);?\s*">/);
        const e = sp ? s.indexOf(sp[1] === 'span' ? '</span>' : '</mark>', i + sp[0].length) : -1, h = sp && cssColor(sp[2]);
        if (sp && h && e > 0) {
          const inner = inline(s.slice(i + sp[0].length, e), ctx);
          if (sp[1] === 'span') { ctx.features.add('xcolor'); out += '\\textcolor[HTML]{' + h + '}{' + inner + '}'; }
          else { ctx.features.add('soul'); out += '{\\definecolor{apghl}{HTML}{' + h + '}\\sethlcolor{apghl}\\hl{' + inner + '}}'; }
          i = e + (sp[1] === 'span' ? '</span>' : '</mark>').length; continue;
        }
      }
      // code, and raw LaTeX: `\ref{fig:c3}`{=latex} (Pandoc's syntax) goes into the LaTeX as it is
      if (ch === '`') {
        const run = rest.match(/^`+/)[0], e = s.indexOf(run, i + run.length);
        if (e > 0 && s.startsWith('{=latex}', e + run.length)) { out += s.slice(i + run.length, e); i = e + run.length + 8; continue; }
        if (e > 0) { out += '\\texttt{' + escape(s.slice(i + run.length, e).trim()) + '}'; i = e + run.length; continue; }
      }
      // inline math, as it is: $x$ (not $$, the opening $ followed and the closing $ preceded by a non-space, no digit after)
      if (ch === '$' && s[i + 1] !== '$' && s[i + 1] && !/\s/.test(s[i + 1])) {
        let e = i + 1;
        while (e < s.length && !(s[e] === '$' && s[e - 1] !== '\\')) e++;
        if (e < s.length && !/\s/.test(s[e - 1]) && !/\d/.test(s[e + 1] || '')) { out += s.slice(i, e + 1); i = e + 1; continue; }
      }
      // footnote ^[text]
      if (ch === '^' && s[i + 1] === '[') {
        const e = closing(s, i + 1, '[', ']');
        if (e > 0) { out += '\\footnote{' + inline(s.slice(i + 2, e), ctx) + '}'; i = e + 1; continue; }
      }
      // Obsidian wiki link [[target|text]]. A link to a literature note (`[[Source/@key|@key]]`, as Zotero's notes are
      // named) is a citation; any other is its text.
      if (rest.startsWith('[[')) {
        const e = s.indexOf(']]', i + 2);
        if (e > 0) {
          const t = s.slice(i + 2, e), key = wikiCitation(t);
          if (key) { ctx.cites.add(key); out += '\\cite{' + key + '}'; }
          else { const bar = t.indexOf('|'); text(bar >= 0 ? t.slice(bar + 1) : t.replace(/#.*$/, '')); }
          i = e + 2; continue;
        }
      }
      if (ch === '[') {
        const e = closing(s, i, '[', ']');
        if (e > 0) {
          const inner = s.slice(i + 1, e);
          // link [text](url)
          if (s[e + 1] === '(') {
            const f = closing(s, e + 1, '(', ')');
            if (f > 0) {
              const url = C.trimmed(s.slice(e + 2, f)).replace(/\s+"[^"]*"$/, '');
              out += '\\href{' + escapeURL(url) + '}{' + inline(inner, ctx) + '}';
              i = f + 1; continue;
            }
          }
          // citation [@key], [@a; @b], [see @a, p. 3]
          const c = citation(inner);
          if (c) {
            for (const k of c.keys) ctx.cites.add(k);
            if (c.pre && c.keys.length === 1) out += '\\cite[' + inline(c.pre, ctx) + '][' + inline(c.post, ctx) + ']{' + c.keys[0] + '}';
            else if (c.post) out += (c.pre ? inline(c.pre, ctx) + ' ' : '') + '\\cite[' + inline(c.post, ctx) + ']{' + c.keys.join(',') + '}';
            else out += (c.pre ? inline(c.pre, ctx) + ' ' : '') + '\\cite{' + c.keys.join(',') + '}';
            i = e + 1; continue;
          }
        }
      }
      // autolink <https://…>
      if (ch === '<') {
        const m = rest.match(/^<((?:https?|ftp|mailto):[^\s>]+)>/);
        if (m) { out += '\\url{' + escapeURL(m[1]) + '}'; i += m[0].length; continue; }
      }
      // strong and emphasis: ** __ * _ (an underscore inside a word is a character)
      if (ch === '*' || ch === '_') {
        const run = s[i + 1] === ch ? ch + ch : ch;
        const leftOK = ch === '*' || i === 0 || !/[\p{L}\p{N}]/u.test(s[i - 1]);
        if (leftOK && s[i + run.length] && !/\s/.test(s[i + run.length])) {
          let e = i + run.length;
          for (;;) {
            e = s.indexOf(run, e);
            if (e < 0) break;
            const rightOK = !/\s/.test(s[e - 1]) && (ch === '*' || !/[\p{L}\p{N}]/u.test(s[e + run.length] || ''))
              && !(run.length === 1 && s[e + 1] === ch && s[e - 1] !== ch);
            if (rightOK && e > i + run.length) break;
            e += run.length;
          }
          if (e > 0) {
            out += (run.length === 2 ? '\\textbf{' : '\\emph{') + inline(s.slice(i + run.length, e), ctx) + '}';
            i = e + run.length; continue;
          }
        }
      }
      // straight quotes become typographic ones; a dash run is a dash run in LaTeX already
      if (ch === '"') { const open = i === 0 || /[\s([{]/.test(s[i - 1]); out += open ? '``' : "''"; i++; continue; }
      text(ch); i++;
    }
    return out;
  }

  // ---- blocks ----

  /** Markdown list line: indent width, ordered or not, content. */
  function listItem(line) {
    const m = line.match(/^(\s*)([-*•+]|\d+[.)])\s+(.*)$/);
    return m ? { indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), content: m[3] } : null;
  }

  /** The text of a prose paragraph: lines joined into running text, with lists, quotes, code and headings as such. */
  function proseText(text, ctx) {
    const lines = text.split('\n'), out = [];
    let run = [];
    const flush = () => { if (run.length) { out.push(inline(run.map(C.trimmed).join(' '), ctx)); run = []; } };
    for (let k = 0; k < lines.length;) {
      const l = lines[k];
      const fence = l.match(/^\s{0,3}(`{3,}|~{3,})\s*(\{=latex\})?/);
      if (fence) {
        flush();
        const body = [];
        k++;
        while (k < lines.length && !lines[k].trimStart().startsWith(fence[1])) body.push(lines[k++]);
        k++;
        // a ```{=latex} block is raw LaTeX; any other fence is verbatim
        out.push(fence[2] ? body.join('\n') : '\\begin{verbatim}\n' + body.join('\n') + '\n\\end{verbatim}');
        continue;
      }
      if (listItem(l)) {
        flush();
        const items = [];
        // an indented line continues the item before it; a line that is not indented ends the list (Prose has no blank lines
        // inside a paragraph, so that is how text after a list is written)
        while (k < lines.length && C.trimmed(lines[k]) !== '') {
          const it = listItem(lines[k]);
          if (it) items.push(it);
          else if (items.length && /^\s+\S/.test(lines[k])) items[items.length - 1].content += ' ' + C.trimmed(lines[k]);
          else break;
          k++;
        }
        out.push(list(items, 0, items.length ? items[0].indent : 0, ctx).join('\n'));
        continue;
      }
      if (/^\s*>/.test(l)) {
        flush();
        const q = [];
        while (k < lines.length && /^\s*>/.test(lines[k])) q.push(lines[k++].replace(/^\s*>\s?/, ''));
        out.push('\\begin{quote}\n' + proseText(q.join('\n'), ctx) + '\n\\end{quote}');
        continue;
      }
      const hd = l.match(/^(#{3,6})\s+(.*)$/);
      if (hd) {
        flush();
        out.push(SECTIONING[Math.min(hd[1].length, 5) - 2] + '{' + inline(C.trimmed(hd[2]), ctx) + '}');
        k++; continue;
      }
      run.push(l); k++;
    }
    flush();
    return out.join('\n');
  }

  /** Nested itemize/enumerate from list items, starting at `items[0]` with the given indent. */
  function list(items, from, indent, ctx) {
    const env = items[from].ordered ? 'enumerate' : 'itemize', out = ['\\begin{' + env + '}'];
    let k = from;
    while (k < items.length && items[k].indent >= indent) {
      if (items[k].indent > indent) {
        const sub = list(items, k, items[k].indent, ctx);
        out.push(...sub.map(l => '  ' + l));
        k = sub.next;
        continue;
      }
      out.push('  \\item ' + inline(C.trimmed(items[k].content), ctx));
      k++;
    }
    out.push('\\end{' + env + '}');
    out.next = k;
    return out;
  }

  const IMAGE_OK = ['png', 'jpg', 'jpeg', 'pdf', 'eps'];
  const COLUMN_MAX_IN = 3.5;   // an image up to this wide (inches) is a column figure, wider ones span both columns
  const PAGE_MAX_IN = 7.0;     // wider than this (a screenshot without a resolution, say) is fitted into the column

  /** The physical width in inches of an image (bytes: Uint8Array or Buffer): a PNG by its pHYs resolution, a PDF by its
   *  first MediaBox; null for other formats and when the file does not say. */
  function imageWidthIn(bytes, ext) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const e = String(ext || '').toLowerCase();
    if (e === 'png') {
      if (b.length < 24) return null;
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const width = v.getUint32(16);
      for (let i = 8; i + 8 <= b.length;) {
        const len = v.getUint32(i), type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
        if (type === 'pHYs' && len === 9 && i + 17 <= b.length) {
          const ppm = v.getUint32(i + 8);
          return b[i + 16] === 1 && ppm > 0 ? width / ppm / 0.0254 : null;
        }
        if (type === 'IDAT' || type === 'IEND') return null;
        i += 12 + len;
      }
      return null;
    }
    if (e === 'pdf') {
      let head = '';
      for (let i = 0; i < Math.min(b.length, 1 << 20); i++) head += String.fromCharCode(b[i]);
      const m = head.match(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/);
      return m ? (parseFloat(m[3]) - parseFloat(m[1])) / 72 : null;
    }
    return null;
  }

  function figureBlock(p, key, ctx) {
    const f = C.figure(p);
    if (!f) return proseText(p.text, ctx);
    const found = ctx.figurePath ? ctx.figurePath(f.path) : f.path;
    const ext = (f.path.match(/\.([A-Za-z0-9]+)(?:[?#].*)?$/) || [])[1];
    let graphic, env = 'figure';
    if (!found) {
      ctx.warnings.push({ key, text: 'Missing image ' + f.path });
      graphic = '\\fbox{\\parbox{0.6\\linewidth}{\\centering Missing image\\\\\\texttt{' + escape(f.path) + '}}}';
    } else if (!ext || !IMAGE_OK.includes(ext.toLowerCase())) {
      ctx.warnings.push({ key, text: `pdflatex cannot show ${ext ? '.' + ext : 'this'} images: ${f.path} (use PNG, JPG or PDF)` });
      graphic = '\\fbox{\\parbox{0.6\\linewidth}{\\centering Image in a format pdflatex cannot show\\\\\\texttt{' + escape(f.path) + '}}}';
    } else {
      if (/[%#{}\\]/.test(found)) ctx.warnings.push({ key, text: 'The image path has a character LaTeX cannot take (% # { } \\): ' + found });
      // An image that says how wide it is (a figure made at its final size) is placed at that size, never rescaled:
      // up to COLUMN_MAX_IN in one column, up to PAGE_MAX_IN across both; any other image is fitted into the column.
      const w = ctx.figureWidthIn ? ctx.figureWidthIn(f.path) : null;
      const own = typeof w === 'number' && w > 0 && w <= PAGE_MAX_IN;
      if (own && w > COLUMN_MAX_IN) env = 'figure*';
      graphic = '\\includegraphics' + (own ? '' : '[width=0.85\\linewidth,height=0.45\\textheight,keepaspectratio]') + '{' + (/\s/.test(found) ? '"' + found + '"' : found) + '}';
    }
    return ['\\begin{' + env + '}[htbp]', '  \\centering', '  ' + graphic,
      ...(C.trimmed(f.caption) ? ['  \\caption{' + inline(C.trimmed(f.caption), ctx) + '}'] : []),
      '  \\label{fig:' + key + '}', '\\end{' + env + '}'].join('\n');
  }

  /** A Markdown table: the first row is the header, `:--`/`--:`/`:-:` set the alignment, a `Table: …` line
   *  (Pandoc's) is the caption; without one the claim is. */
  function tableBlock(p, key, ctx) {
    const rows = C.tableRows(p);
    if (!rows.length) return proseText(p.text, ctx);
    const lines = p.text.split('\n').map(C.trimmed);
    const rule = lines.find(l => l.startsWith('|') && l.includes('-') && [...l].every(ch => '|-: '.includes(ch)));
    const n = Math.max(...rows.map(r => r.length));
    const aligns = rule ? rule.split('|').slice(1, -1).map(c => { c = C.trimmed(c); return c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : 'l'; }) : [];
    const spec = Array.from({ length: n }, (_, k) => aligns[k] || 'l').join('');
    const capLine = lines.find(l => /^(Table)?:\s/.test(l));
    const caption = capLine ? C.trimmed(capLine.replace(/^(Table)?:/, '')) : C.trimmed(p.claim || '');
    const row = r => '    ' + Array.from({ length: n }, (_, k) => inline(r[k] || '', ctx)).join(' & ') + ' \\\\';
    const body = rule ? [row(rows[0]), '    \\midrule', ...rows.slice(1).map(row)] : rows.map(row);
    return ['\\begin{table}[htbp]', '  \\centering',
      ...(caption ? ['  \\caption{' + inline(caption, ctx) + '}'] : []),
      '  \\label{tab:' + key + '}',
      '  \\begin{tabular}{' + spec + '}', '    \\toprule', ...body, '    \\bottomrule', '  \\end{tabular}', '\\end{table}'].join('\n');
  }

  /** `$$ … $$`, as it is, in an equation (with `aligned` around it when it has several lines and no environment). */
  function equationBlock(p, key) {
    let m = C.trimmed(C.equation(p));
    if (m.includes('\\\\') && !m.includes('\\begin{')) m = '\\begin{aligned}\n' + m + '\n\\end{aligned}';
    return ['\\begin{equation}', m, '\\label{eq:' + key + '}', '\\end{equation}'].join('\n');
  }

  // ---- the document ----

  /** A front matter value of the document ('' when it is not there). */
  function front(d, key) {
    if (key === 'title') return d.title;
    if (key === 'thesis') return d.thesis;
    const fl = d.frontLines || [];
    for (let k = 1; k < fl.length - 1; k++) {
      const m = fl[k].match(/^([\w-]+):\s*(.*)$/);
      if (m && m[1] === key) return m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
    return '';
  }

  const LANGS = { de: 'ngerman', 'de-ch': 'nswissgerman', 'de-at': 'naustrian', en: 'english', 'en-us': 'american', 'en-gb': 'british', fr: 'french', it: 'italian', es: 'spanish', nl: 'dutch' };
  const babelName = l => LANGS[String(l || '').toLowerCase()] || l || 'english';

  /** The marker line in front of a piece of the body. */
  const marker = (key, label) => '%% apg ' + key + (label ? ' | ' + C.oneLine(label).replace(/\s+/g, ' ').trim() : '');

  /** LaTeX's sectioning commands for the subsection levels 2 to 5 (`##` to `#####`). */
  const SECTIONING = ['\\subsection', '\\subsubsection', '\\paragraph', '\\subparagraph'];

  /** The pieces of the body, in order: { key, kind, tex }. */
  /** The citation keys in a text, in order (nothing is added to the document's own tally). */
  function citesIn(text) {
    const sc = { cites: new Set(), warnings: [], features: new Set() };
    inline(String(text || ''), sc);
    return [...sc.cites];
  }

  function segments(d, ctx) {
    const out = [];
    // Where the papers linked in a claim (or in a note) are cited: with a link (the claim or subsection depends on the paper's
    // claim: `needs=`; a note points at it: `to=`) at the end of the subsection that is linked; without one, where the claim is.
    const sources = new Map();   // id of a claim or note -> { keys, cid, claim }
    for (const s of d.sections) for (const p of s.paragraphs) {
      const kd = C.kind(p);
      if (p.cid && (kd === 'prose' || kd === 'group')) { const keys = citesIn(p.claim); if (keys.length) sources.set(p.cid, { keys, cid: p.cid, claim: p.claim }); }
    }
    for (const n of d.unplaced) { const keys = n.cid ? citesIn(n.text) : []; if (keys.length) sources.set(n.cid, { keys, cid: n.cid, claim: n.text }); }
    const incoming = new Map(), routed = new Set();   // target id (claim, subsection or section id) -> sources
    const route = (target, from) => { if (!incoming.has(target)) incoming.set(target, []); incoming.get(target).push(sources.get(from)); routed.add(from); };
    for (const s of d.sections) for (const p of s.paragraphs) for (const n of p.needs) if (p.cid && n !== p.cid && sources.has(n)) route(p.cid, n);
    for (const n of d.unplaced) if (n.to && sources.has(n.cid)) route(n.to, n.cid);
    const plan = C.plan(d);   // blocks that are switched off are not in the paper (core.js)
    d.sections.forEach((s, si) => {
      const sk = s.sid || 's#' + (si + 1), secOff = plan.secOff.has(s.id);
      if (!secOff) out.push({ key: sk, kind: 'section', tex: marker(sk) + '\n\\section{' + inline(C.trimmed(s.title), ctx) + '}' + (s.sid ? '\n\\label{sec:' + s.sid + '}' : '') });
      // Papers linked in a claim (not in the paragraph) are cited at the end of the subsection (or section) the claim is in:
      // `\cite{a,b}` after its last paragraph, to be moved to the right place in the text later. Keys cited in the text of that
      // subsection already are left out.
      const boxes = [{ level: 1, claims: [], start: out.length, cid: '' }];
      const flush = box => {
        const used = new Set(out.slice(box.start).flatMap(sg => sg.cites || []));
        const keys = [...new Set(box.claims.flatMap(c => c.keys))].filter(k => !used.has(k));
        if (!keys.length) return;
        const first = box.claims.find(c => c.keys.some(k => keys.includes(k))), line = '\\cite{' + keys.join(',') + '}';
        const note = marker('cite:' + (first.cid || sk), first.claim);
        const last = out.length > box.start ? out[out.length - 1] : null;
        const join = last && last.kind === 'prose' && !box.nested;   // after the paragraph that ends it: "text. [1]"; else a paragraph of its own
        if (join) last.tex += '\n' + note + '\n' + line;
        else out.push({ key: 'cite:' + (first.cid || sk), kind: 'cite', tex: note + '\n' + line, cites: keys });
        if (join) last.cites = (last.cites || []).concat(keys);
      };
      const closeTo = lvl => { while (boxes.length > 1 && boxes[boxes.length - 1].level >= lvl) flush(boxes.pop()); };
      const claimOf = p => {
        const keys = routed.has(p.cid) ? [] : citesIn(p.claim);   // a claim that is linked to something is cited there
        keys.forEach(k => ctx.cites.add(k));
        if (keys.length) boxes[boxes.length - 1].claims.push({ keys, cid: p.cid, claim: p.claim });
      };
      // what is linked to this claim, subsection or section is cited at the end of the subsection it is in
      const linked = id => {
        for (const src of incoming.get(id) || []) { src.keys.forEach(k => ctx.cites.add(k)); boxes[boxes.length - 1].claims.push(src); }
      };
      if (!secOff) linked(s.sid);
      const open = [];   // the levels of the open subsections, to see a level that is skipped
      // the claims of islands that are off that a claim here needs: their paragraphs follow it
      const addPulled = p => {
        for (const q of plan.pulled.get(p.id) || []) {
          if (C.trimmed(q.text) === '') continue;
          out.push({ key: q.cid, kind: 'prose', tex: marker(q.cid, q.claim) + '\n' + proseText(q.text, ctx), cites: citesIn(q.text) });
        }
      };
      s.paragraphs.forEach((p, pi) => {
        if (plan.hidden.has(p.id)) return;
        const k = C.kind(p), key = p.cid || `${sk}/${pi + 1}`;
        if (k === 'groupEnd') { while (open.length && open[open.length - 1] >= C.level(p)) open.pop(); closeTo(C.level(p)); return; }
        let tex;
        if (k === 'group') {
          const lvl = C.level(p);
          while (open.length && open[open.length - 1] >= lvl) open.pop();
          closeTo(lvl);
          const above = open.length ? open[open.length - 1] : 1;
          if (lvl > above + 1) ctx.warnings.push({ key, text: `${SECTIONING[lvl - 2]} directly under ${above === 1 ? '\\section' : SECTIONING[above - 2]} (a level is skipped)` });
          open.push(lvl);
          tex = SECTIONING[lvl - 2] + '{' + inline(C.groupName(p), ctx) + '}' + (p.cid ? '\n\\label{sec:' + p.cid + '}' : '');
          out.push({ key, kind: k, tex: marker(key, p.claim) + '\n' + tex });
          addPulled(p);
          boxes[boxes.length - 1].nested = true;
          boxes.push({ level: lvl, claims: [], start: out.length, cid: p.cid });
          claimOf(p);   // the claim a subsection was expanded from belongs to the subsection
          linked(p.cid);
          return;
        }
        if (k === 'prose') claimOf(p);
        if (p.cid) linked(p.cid);
        if (k === 'figure') tex = figureBlock(p, key, ctx);
        else if (k === 'table') tex = tableBlock(p, key, ctx);
        else if (k === 'equation') tex = equationBlock(p, key);
        else if (C.trimmed(p.text) === '') { addPulled(p); return; }   // a claim without prose yet is not in the paper
        else tex = proseText(p.text, ctx);
        out.push({ key, kind: k, tex: marker(key, p.claim) + '\n' + tex, cites: k === 'prose' ? citesIn(p.text) : [] });
        addPulled(p);
      });
      closeTo(2);
      flush(boxes[0]);
    });
    return out;
  }

  /** Fill a template: `{{#k}}…{{/k}}` and `{{^k}}…{{/k}}` first, then `{{k}}`. Unknown names are left as they are. */
  function fill(template, values) {
    const known = k => Object.prototype.hasOwnProperty.call(values, k);
    let t = template.replace(/\{\{([#^])([\w-]+)\}\}([^]*?)\{\{\/\2\}\}/g, (all, sign, k, inner) => {
      if (!known(k)) return all;
      return (sign === '#') === !!C.trimmed(String(values[k])) ? inner : '';
    });
    return t.replace(/\{\{([\w-]+)\}\}/g, (all, k) => (known(k) ? String(values[k]) : all));
  }

  /** The keys a .bib file defines. */
  function bibKeys(text) {
    const keys = new Set();
    for (const m of String(text || '').matchAll(/@([A-Za-z]+)\s*[{(]\s*([^,\s}]+)\s*,/g)) {
      if (!['comment', 'string', 'preamble'].includes(m[1].toLowerCase())) keys.add(m[2]);
    }
    return keys;
  }

  /** The packages the styles of the text need (xcolor for colour, soul for highlighting, ulem for strike-through), added right
   *  before \begin{document} unless the template loads them. */
  function addPackages(tex, features) {
    const has = name => new RegExp('\\\\(?:usepackage|RequirePackage)(?:\\[[^\\]]*\\])?\\{[^}]*\\b' + name + '\\b[^}]*\\}').test(tex);
    const lines = [];
    if ((features.has('xcolor') || features.has('soul')) && !has('xcolor')) lines.push('\\usepackage{xcolor}');
    if (features.has('soul') && !has('soul')) lines.push('\\usepackage{soul}');
    if (features.has('sout') && !has('ulem')) lines.push('\\usepackage[normalem]{ulem}');
    const at = tex.indexOf('\\begin{document}');
    return lines.length && at >= 0 ? tex.slice(0, at) + lines.join('\n') + '\n' + tex.slice(at) : tex;
  }

  /** The entries of a .bib file: Map key -> the entry's text, as it is written. */
  function bibEntries(text) {
    const out = new Map(), t = String(text || ''), re = /@([A-Za-z]+)\s*([{(])\s*([^,\s}]+)\s*,/g;
    let m;
    while ((m = re.exec(t))) {
      if (['comment', 'string', 'preamble'].includes(m[1].toLowerCase())) continue;
      let depth = 0, k = m.index + m[0].indexOf(m[2]);
      for (; k < t.length; k++) {
        if (t[k] === '\\') { k++; continue; }
        if (t[k] === '{' || t[k] === '(') depth++;
        else if (t[k] === '}' || t[k] === ')') { if (--depth === 0) break; }
      }
      if (depth === 0 && k < t.length) { if (!out.has(m[3])) out.set(m[3], t.slice(m.index, k + 1)); re.lastIndex = k + 1; }
    }
    return out;
  }

  /** A BibTeX entry for a literature note's front matter (as Zotero's notes made by ZotFlow have it: `citationKey`, `title`,
   *  `itemType`, `creators`, `publication`, `date`/`year`, `doi`, `url`, and `volume`, `issue`, `pages`, `publisher`, `isbn`
   *  when there). null when there is no key or no title. */
  function bibFromNote(fm) {
    if (!fm || !fm.citationKey || !fm.title) return null;
    const val = v => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
    const esc = v => val(v).replace(/([&%#_$])/g, '\\$1');
    const names = (Array.isArray(fm.creators) ? fm.creators : fm.creators ? [fm.creators] : []).map(c => {
      if (c && typeof c === 'object') return val(c.name || [c.firstName, c.lastName].filter(Boolean).join(' '));
      return val(c);
    }).filter(Boolean);
    const type = val(fm.itemType), year = val(fm.year) || (val(fm.date).match(/\b(1[5-9]|20)\d\d\b/) || [''])[0];
    const kind = { journalArticle: 'article', conferencePaper: 'inproceedings', book: 'book', bookSection: 'incollection',
      report: 'techreport', thesis: /master|bachelor/i.test(val(fm.thesisType)) ? 'mastersthesis' : 'phdthesis' }[type] || 'misc';
    const where = val(fm.publication || fm.proceedingsTitle || fm.bookTitle);
    const f = [['author', names.map(esc).join(' and ')], ['title', '{' + esc(fm.title) + '}'], ['year', year]];
    if (kind === 'article') f.push(['journal', esc(where)]);
    else if (kind === 'inproceedings' || kind === 'incollection') f.push(['booktitle', esc(where)]);
    else if (kind === 'misc' && where) f.push(['howpublished', esc(where)]);
    else if (kind === 'phdthesis' || kind === 'mastersthesis') f.push(['school', esc(fm.university || fm.publisher || where)]);
    else if (kind === 'techreport') f.push(['institution', esc(fm.institution || fm.publisher || where)]);
    for (const k of ['volume', 'number', 'pages', 'publisher', 'isbn', 'doi']) f.push([k, k === 'doi' ? val(fm.doi) : esc(k === 'number' ? fm.issue || fm.number : fm[k])]);
    f.push(['url', val(fm.url)]);
    return '@' + kind + '{' + val(fm.citationKey) + ',\n' + f.filter(([, v]) => v && v !== '{}').map(([k, v]) => `  ${k} = {${v}}`).join(',\n') + '\n}';
  }

  /** The document as LaTeX.
   *  opts: template (text), figurePath(rel) -> path for \includegraphics or null when missing,
   *        bibFiles: [names without .bib], bibKeys: Set or null (null: not checked), markers (default true).
   *  Returns { tex, segments, cites, warnings, bodyStart } (bodyStart: line number, 1-based, where the body begins). */
  function toLatex(d, opts = {}) {
    const ctx = { cites: new Set(), warnings: [], figurePath: opts.figurePath || null, figureWidthIn: opts.figureWidthIn || null, features: new Set() };
    const segs = segments(d, ctx);
    const markers = opts.markers !== false;
    const strip = t => (markers ? t : t.split('\n').filter(l => !l.startsWith('%% apg ')).join('\n'));
    const body = segs.map(sg => strip(sg.tex)).join('\n\n');
    const bibFiles = opts.bibFiles || [];
    const author = front(d, 'author'), date = front(d, 'date');
    for (const b of bibFiles) if (/[\s,%#{}]/.test(b)) ctx.warnings.push({ key: '', text: `BibTeX cannot use the file name ${b}.bib (blanks or special characters): rename it` });
    if (ctx.cites.size && !bibFiles.length) ctx.warnings.push({ key: '', text: 'The text cites, but there is no .bib file' });
    if (opts.bibKeys) {
      // where each key is cited first (the claim or paragraph, to show it and to say which one in the message)
      const where = new Map();
      for (const sg of segs) for (const k of sg.cites || []) if (!where.has(k)) where.set(k, sg.key.replace(/^cite:/, ''));
      const label = id => { for (const s of d.sections) for (const p of s.paragraphs) if (p.cid === id) { const t = C.oneLine(p.claim || p.text || '').slice(0, 40); return t ? `"${t}"` : id; } return ''; };
      for (const k of ctx.cites) {
        if (opts.bibKeys.has(k)) continue;
        const at = where.get(k) || '', place = at ? label(at) : '';
        ctx.warnings.push({ key: at, text: `Unknown citation key ${k}${place ? ' (in ' + place + ')' : ''}: no .bib file has an entry for it and no literature note has it as its citationKey. Check the key, or add the paper in Zotero.` });
      }
    }
    // A link that ends with one ] ([[@key]) is not a link: Markdown takes the end of it as a citation [@key], which is unknown.
    for (const s of d.sections) for (const p of s.paragraphs) {
      for (const text of [p.claim, p.text]) {
        for (const m of String(text || '').matchAll(/\[\[[^\[\]\n|]*\](?!\])/g)) ctx.warnings.push({ key: p.cid || '', text: `Unfinished link ${m[0].slice(0, 60)}: it ends with one ] where ]] is needed` });
      }
    }
    const bibliography = ctx.cites.size && bibFiles.length ? '\\bibliographystyle{plainnat}\n\\bibliography{' + bibFiles.join(',') + '}' : '';
    const values = {
      title: inline(C.trimmed(d.title), ctx), thesis: inline(C.trimmed(d.thesis), ctx),
      author: inline(author, ctx), date: date ? inline(date, ctx) : '\\today',
      babel: babelName(front(d, 'lang')), bibliography, bibfiles: bibFiles.join(','),
      body: markers ? '%% apg body\n' + body + '\n%% apg end' : body,
    };
    const tex = addPackages(fill(opts.template || ARTICLE, values), ctx.features);
    const at = tex.indexOf('%% apg body'), bodyStart = at < 0 ? 0 : tex.slice(0, at).split('\n').length;
    return { tex, segments: segs, cites: ctx.cites, warnings: ctx.warnings, bodyStart };
  }

  /** The marker key of the piece of the body that line `n` (1-based) of `tex` is in, or ''. */
  function keyAtLine(tex, n) {
    const lines = tex.split('\n');
    for (let k = Math.min(n, lines.length) - 1; k >= 0; k--) {
      const m = lines[k].match(/^%% apg (\S+)/);
      if (m) return m[1] === 'body' || m[1] === 'end' ? '' : m[1].replace(/^cite:/, '');
    }
    return '';
  }

  /** The errors in a pdflatex log: { line, text } (line in the .tex named `texName`, or 0 when it is in another
   *  file, such as the template's class, or the log does not say). */
  function logErrors(log, texName) {
    const out = [], lines = String(log || '').split(/\r?\n/);
    for (let k = 0; k < lines.length; k++) {
      const fl = lines[k].match(/^(.*?\.(?:tex|cls|sty)):(\d+): (.*)$/);
      if (fl) {
        const file = fl[1].replace(/^.*\//, ''), ours = !texName || file === texName;
        out.push({ line: ours ? +fl[2] : 0, text: (ours ? '' : file + ': ') + fl[3] + nextLines(lines, k) });
        continue;
      }
      if (lines[k].startsWith('! ')) {
        let line = 0;
        for (let j = k + 1; j < Math.min(k + 20, lines.length); j++) { const m = lines[j].match(/^l\.(\d+)/); if (m) { line = +m[1]; break; } }
        out.push({ line, text: lines[k].slice(2) });
      }
    }
    return out;
  }
  // "Undefined control sequence." is followed by the line that has it; that line says which.
  function nextLines(lines, k) {
    const m = lines[k + 1] && lines[k + 1].match(/^l\.\d+ (.*)$/);
    return m ? ' ' + C.trimmed(m[1]).slice(-60) : '';
  }

  /** Frontmatter edit: set (or remove, with '') a key of the document's front matter. */
  function setFront(d, key, value) {
    if (!d.frontLines) {
      if (!value) return;
      // serialize writes title and thesis into it, as they differ from the (empty) originals
      d.frontLines = ['---', '---'];
      d.origTitle = ''; d.origThesis = '';
    }
    const fl = d.frontLines.slice();
    const k = fl.findIndex((l, i) => i >= 1 && i < fl.length - 1 && new RegExp('^' + key + ':').test(l));
    const line = key + ': ' + value;
    if (k >= 0) { if (value) fl[k] = line; else fl.splice(k, 1); } else if (value) fl.splice(fl.length - 1, 0, line);
    d.frontLines = fl;
  }

  return { BUILTIN, toLatex, imageWidthIn, inline, proseText, citation, figureBlock, tableBlock, equationBlock, citesIn, cssColor, SECTIONING, ESC, escape, fill, bibKeys, bibEntries, bibFromNote, wikiCitation, keyAtLine, logErrors, front, setFront, babelName, segments };
});
