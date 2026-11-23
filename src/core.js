// Archipelago document model: parse, serialize, repair and check the .apg Markdown format.
// A line-by-line port of Sources/Archipelago/Model.swift. Runs in the browser and in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let counter = 0;
  const uid = () => 'n' + (++counter);

  const trimmed = s => s.trim();
  const oneLine = s => s.replaceAll('\n', ' ').replaceAll('-->', '->');
  // Swift's rounded() rounds half away from zero.
  const rnd = x => (Math.sign(x) * Math.round(Math.abs(x))) || 0;
  const num = s => (s != null && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : null);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function newParagraph(o) {
    return Object.assign({
      id: uid(), claim: '', cid: '', needs: [], pos: null, w: null, text: '',
      orig: { claim: '', cid: '', needs: [], pos: null, w: null }, origClaimLine: null,
      trailing: [''], autoPlace: false,
    }, o || {});
  }
  function newSection(title, island) {
    return {
      id: uid(), title, synopsis: '', island, origTitle: '', origSynopsis: '', origIsland: null,
      headerLines: ['# ' + title], paragraphs: [], sid: '', origSid: '',
    };
  }
  const newIdea = o => Object.assign({ id: uid(), cid: '', text: '', pos: { x: 0, y: 0 }, to: '' }, o || {});
  function newDoc() {
    return {
      title: '', thesis: '', origTitle: '', origThesis: '', unplaced: [], origUnplaced: [],
      frontLines: null, unplacedRange: null, notesLines: null, preamble: [], sections: [],
      eol: '\n', bom: false, formatLine: null,   // as read: line ending, byte order mark, and the format line (kept as it is)
    };
  }

  const metaOf = p => ({ claim: p.claim, cid: p.cid, needs: p.needs, pos: p.pos, w: p.w });

  const isHeading = l => l.startsWith('# ') || trimmed(l) === '#';
  // `##` to `#####` are subsections (LaTeX has \subsection down to \subparagraph); `# ` is a section.
  const MAX_LEVEL = 5;
  const isGroupHeading = l => !l.includes('\n') && /^#{2,5}(?:[ \t].*)?$/.test(l);
  const endGroup = '<!-- endgroup -->';
  /** `<!-- endgroup -->` closes a level-2 subsection (and what is nested in it), `<!-- endgroup ### -->` a level-3 one, … */
  const END_RE = /^<!--\s*endgroup(?:\s+(#{2,5}))?\s*-->$/;
  const isEndMarker = l => !l.includes('\n') && END_RE.test(trimmed(l));
  const endMarker = lvl => (lvl <= 2 ? endGroup : `<!-- endgroup ${'#'.repeat(lvl)} -->`);
  const isMarkerLine = l => isGroupHeading(l) || isEndMarker(l);

  // BlockKind: prose, figure, table, equation, group, groupEnd
  function kind(p) {
    const t = trimmed(p.text);
    if (isGroupHeading(t)) return 'group';
    if (isEndMarker(t)) return 'groupEnd';
    if (t.startsWith('![')) return 'figure';
    if (t.startsWith('$$')) return 'equation';
    if (t.startsWith('|')) return 'table';
    return 'prose';
  }
  const isBlock = p => ['figure', 'table', 'equation'].includes(kind(p));
  const isMarker = p => { const k = kind(p); return k === 'group' || k === 'groupEnd'; };
  const isCard = p => kind(p) === 'prose';
  /** 2 to 5 for a subsection heading or the end marker that closes that level, null for anything else. */
  function level(p) {
    const t = trimmed(p.text);
    if (isGroupHeading(t)) return t.match(/^#+/)[0].length;
    const m = t.match(END_RE);
    return m && !t.includes('\n') ? (m[1] ? m[1].length : 2) : null;
  }
  const groupName = p => trimmed(trimmed(p.text).replace(/^#+/, ''));
  const setGroupName = (p, v) => { p.text = '#'.repeat(level(p) || 2) + ' ' + oneLine(v); };
  /** The heading or end marker of paragraph `p` moved to another level (a heading's title is kept). */
  function withLevel(p, lvl) {
    if (kind(p) === 'group') p.text = '#'.repeat(lvl) + ' ' + groupName(p);
    else if (kind(p) === 'groupEnd') p.text = endMarker(lvl);
  }

  function figure(p) {
    const t = trimmed(p.text), mid = t.indexOf('](');
    if (!t.startsWith('![') || mid < 0 || !t.endsWith(')')) return null;
    return { caption: t.slice(2, mid), path: t.slice(mid + 2, -1) };
  }
  function tableRows(p) {
    return p.text.split('\n').map(trimmed)
      .filter(l => l.startsWith('|') && !(l.includes('-') && [...l].every(ch => '|-: '.includes(ch))))
      .map(l => l.split('|').slice(1, -1).map(trimmed));
  }
  const equation = p => trimmed(p.text.replaceAll('$$', ''));

  // ---- groups ----

  /** The headings that are open after paragraphs[0 .. i-1], outermost first: [{ id, level }]. A heading closes every open
   *  heading of its own level or deeper, an end marker of level L closes those of level L or deeper. */
  function openAt(s, i) {
    const st = [];
    for (let k = 0; k < i && k < s.paragraphs.length; k++) {
      const p = s.paragraphs[k], kd = kind(p);
      if (kd === 'group') { const l = level(p); while (st.length && st[st.length - 1].level >= l) st.pop(); st.push({ id: p.id, level: l }); }
      else if (kd === 'groupEnd') { const l = level(p); while (st.length && st[st.length - 1].level >= l) st.pop(); }
    }
    return st;
  }

  /** For each paragraph, the id of the innermost subsection heading it belongs to (null outside any). A heading is in itself. */
  function groupOf(s) {
    const r = [], st = [];
    for (const p of s.paragraphs) {
      const kd = kind(p);
      if (kd === 'group') { const l = level(p); while (st.length && st[st.length - 1].level >= l) st.pop(); st.push({ id: p.id, level: l }); }
      else if (kd === 'groupEnd') { const l = level(p); while (st.length && st[st.length - 1].level >= l) st.pop(); }
      r.push(st.length ? st[st.length - 1].id : null);
    }
    return r;
  }
  /** For each paragraph, the ids of the headings it is in, outermost first (a heading is in its own path). */
  function pathOf(s) {
    const r = [], st = [];
    for (const p of s.paragraphs) {
      const kd = kind(p);
      if (kd === 'group') { const l = level(p); while (st.length && st[st.length - 1].level >= l) st.pop(); st.push({ id: p.id, level: l }); }
      else if (kd === 'groupEnd') { const l = level(p); while (st.length && st[st.length - 1].level >= l) st.pop(); }
      r.push(st.map(e => e.id));
    }
    return r;
  }
  /** The innermost subsection an item inserted at index i falls into (null: the section itself). */
  function groupAt(s, i) {
    const st = openAt(s, i);
    return st.length ? st[st.length - 1].id : null;
  }
  /** Index just past the last member of subsection g, with the subsections nested in it: up to the next heading or end
   *  marker of its own level or a higher one (that end marker is not part of it). */
  function endOfGroup(s, g) {
    let i = s.paragraphs.findIndex(p => p.id === g);
    if (i < 0) return null;
    const l = level(s.paragraphs[i]);
    i += 1;
    while (i < s.paragraphs.length && !(isMarker(s.paragraphs[i]) && level(s.paragraphs[i]) <= l)) i += 1;
    return i;
  }
  /** The last index of the subtree of heading g, counting its closing end marker when that closes exactly g. */
  function subtreeEnd(s, g) {
    const e = endOfGroup(s, g);
    if (e === null) return null;
    const p = s.paragraphs[e];
    return p && kind(p) === 'groupEnd' && level(p) === level(s.paragraphs.find(q => q.id === g)) ? e + 1 : e;
  }
  /** Move the heading at index i and everything nested in it down (or up) by `delta` levels. False, and nothing changed,
   *  when that would leave 2..5. */
  function shiftLevels(s, i, delta) {
    const e = subtreeEnd(s, s.paragraphs[i].id);   // with the end marker that closes exactly this subsection
    const items = s.paragraphs.slice(i, e).filter(isMarker);
    if (items.some(p => { const l = level(p) + delta; return l < 2 || l > MAX_LEVEL; })) return false;
    for (const p of items) withLevel(p, level(p) + delta);
    return true;
  }
  /** The deepest level that a heading inside subsection g (or the subtree of heading g) reaches, relative to g. */
  function depthBelow(s, g) {
    const i = s.paragraphs.findIndex(p => p.id === g), e = endOfGroup(s, g);
    if (i < 0) return 0;
    return Math.max(0, ...s.paragraphs.slice(i + 1, e).filter(p => kind(p) === 'group').map(p => level(p) - level(s.paragraphs[i])));
  }
  /** The numbers LaTeX gives the headings: { sections: Map(section id -> '2'), headings: Map(heading paragraph id -> '2.1.3') }. A skipped
   *  level counts as 0, as in LaTeX. */
  function numbering(d) {
    const sections = new Map(), headings = new Map(), pl = plan(d);
    let n = 0;
    d.sections.forEach(s => {
      if (pl.secOff.has(s.id)) return;   // a block that is switched off has no number: it is not in the paper
      n++;
      sections.set(s.id, String(n));
      const c = [0, 0, 0, 0, 0, 0];
      for (const p of s.paragraphs) {
        if (kind(p) !== 'group') continue;
        const l = level(p);
        c[l]++;
        for (let k = l + 1; k <= MAX_LEVEL; k++) c[k] = 0;
        headings.set(p.id, [n, ...c.slice(2, l + 1)].join('.'));
      }
    });
    return { sections, headings };
  }

  // ---- blocks that are switched off ----
  // Every block of the Map (an island, or a free-floating figure, table or equation) has a switch. One that is off is not in
  // the paper: not in Prose, not in the LaTeX. The ids of the ones that are off are in the front matter, `inactive: s4, c10`
  // (so that a plugin that does not know the switch leaves them alone). Of an island that is off, only the claims that a claim
  // of a block that is on is linked to (either depends on the other, `needs`) are shown, each below the claim it is linked to.

  /** The ids (of islands and blocks) that are switched off. */
  function inactiveIds(d) {
    const fl = d.frontLines || [];
    for (let k = 1; k < fl.length - 1; k++) {
      const m = fl[k].match(/^inactive:\s*(.*)$/);
      if (m) return new Set(m[1].replace(/^(["'])(.*)\1$/, '$2').split(/[\s,]+/).filter(Boolean));
    }
    return new Set();
  }

  /** What the paper shows. Returns { off (ids), secOff (ids of the islands that are off), hidden (ids of the paragraphs that are
   *  not shown where they are), pulled (id of a paragraph -> the paragraphs of islands that are off that are shown below it) }. */
  function plan(d) {
    const off = inactiveIds(d), hidden = new Set(), secOff = new Set(), pulled = new Map(), where = new Map();
    for (const s of d.sections) for (const p of s.paragraphs) if (p.cid) where.set(p.cid, { p, s });
    for (const s of d.sections) {
      const sOff = !!s.sid && off.has(s.sid);
      if (sOff) secOff.add(s.id);
      for (const p of s.paragraphs) {
        if (isBlock(p)) { if (p.cid && off.has(p.cid)) hidden.add(p.id); }   // a block has a switch of its own
        else if (sOff) hidden.add(p.id);
      }
    }
    if (secOff.size) {
      // the claims of the islands that are off that depend on a claim (cid -> them), in the order of the document
      const dependents = new Map();
      for (const s of d.sections) if (secOff.has(s.id)) for (const q of s.paragraphs) {
        if (!isCard(q)) continue;
        for (const n of q.needs) { if (!dependents.has(n)) dependents.set(n, []); dependents.get(n).push(q); }
      }
      const shown = new Set();   // each claim of an island that is off is shown once, below the first claim it is linked to
      for (const s of d.sections) for (const p of s.paragraphs) {
        if (hidden.has(p.id) || isBlock(p) || !p.cid && !p.needs.length) continue;
        // what this claim needs, then what needs this claim
        const linked = [...p.needs.map(n => (where.get(n) || {}).p), ...(dependents.get(p.cid) || [])];
        for (const q of linked) {
          if (!q || q === p || !hidden.has(q.id) || !isCard(q) || shown.has(q.id)) continue;
          shown.add(q.id);
          if (!pulled.has(p.id)) pulled.set(p.id, []);
          pulled.get(p.id).push(q);
        }
      }
    }
    return { off, hidden, secOff, pulled };
  }
  /** Drop end markers that close nothing or sit right before another marker or the section end. */
  function normalizeGroups(s) {
    const out = [], st = [];
    s.paragraphs.forEach((p, k) => {
      const kd = kind(p), l = kd === 'group' || kd === 'groupEnd' ? level(p) : null;
      if (kd === 'group') { while (st.length && st[st.length - 1] >= l) st.pop(); st.push(l); }
      if (kd === 'groupEnd') {
        const next = s.paragraphs[k + 1];
        // closes nothing / is the last paragraph / the next heading or end marker closes the same (or more)
        if (!st.some(x => x >= l) || !next || (isMarker(next) && level(next) <= l)) return;
        while (st.length && st[st.length - 1] >= l) st.pop();
      }
      out.push(p);
    });
    if (out.length !== s.paragraphs.length) s.paragraphs = out;
  }

  // ---- line syntax ----

  /** Value of `<!-- key: value -->`, or null. */
  function comment(line, key) {
    const t = trimmed(line);
    if (!t.startsWith('<!--') || !t.endsWith('-->') || [...t].length < 7) return null;
    const inner = trimmed(t.slice(4, -3));
    if (!inner.startsWith(key + ':')) return null;
    return trimmed(inner.slice(key.length + 1));
  }

  /** `k=v k2=v2` tokens, or null if any token is not of that form. */
  function tokens(s) {
    const r = {}; let n = 0;
    for (const t of s.split(' ').filter(Boolean)) {
      const e = t.indexOf('=');
      if (e <= 0) return null;
      r[t.slice(0, e)] = t.slice(e + 1); n++;
    }
    return n ? r : null;
  }

  function point(s) {
    if (s == null) return null;
    const p = s.split(',').filter(Boolean);
    if (p.length !== 2) return null;
    const x = num(p[0]), y = num(p[1]);
    return x === null || y === null ? null : { x, y };
  }

  const metaKeys = ['id', 'needs', 'pos', 'w'];

  function meta(claim, kv) {
    return {
      claim, cid: kv.id ?? '', needs: (kv.needs ?? '').split(',').filter(Boolean),
      pos: point(kv.pos), w: num(kv.w),
    };
  }

  /** Split `text | id=c3 needs=c1,c2 pos=10,20` into text and metadata. */
  function claimMeta(s0) {
    const s = ' ' + s0;   // the leading space lets an empty claim (`| id=c3`) find its bar too
    const bar = s.lastIndexOf(' | ');
    const kv = bar >= 0 ? tokens(s.slice(bar + 3)) : null;
    if (!kv || !Object.keys(kv).every(k => metaKeys.includes(k))) {
      return { claim: trimmed(s), cid: '', needs: [], pos: null, w: null };
    }
    return meta(trimmed(s.slice(0, bar)), kv);
  }

  function claimLine(m, key = 'claim') {
    const md = [];
    if (m.cid) md.push('id=' + m.cid);
    if (m.needs.length) md.push('needs=' + m.needs.join(','));
    if (m.pos) md.push(`pos=${rnd(m.pos.x)},${rnd(m.pos.y)}`);
    if (m.w != null) md.push('w=' + rnd(m.w));
    const parts = (m.claim ? [oneLine(m.claim)] : []).concat(md.length ? ['|', ...md] : []);
    return `<!-- ${key}:` + parts.map(x => ' ' + x).join('') + ' -->';
  }

  /** The text of a claim comment or a subsection comment (`<!-- subsection: text | id=c5 needs=c1 -->`, the claim an expanded
   *  subsection came from), or null. */
  const claimComment = l => { const c = comment(l, 'claim'); return c !== null ? c : comment(l, 'subsection'); };

  /** The `k=v` pairs of one metadata segment of a claim comment (metaKeys only, in order), or null. */
  function metaPairs(seg) {
    const r = [];
    for (const t of trimmed(seg).split(' ').filter(Boolean)) {
      const e = t.indexOf('=');
      if (e <= 0 || !metaKeys.includes(t.slice(0, e))) return null;
      r.push([t.slice(0, e), t.slice(e + 1)]);
    }
    return r.length ? r : null;
  }

  /** A claim comment's text and its trailing metadata segments (normally one). */
  function claimParts(c) {
    const segs = c.split('|'), groups = [];
    while (segs.length > 1) {
      const m = metaPairs(segs[segs.length - 1]);
      if (!m) break;
      groups.unshift(m);
      segs.pop();
    }
    return { text: trimmed(segs.join('|')), groups };
  }

  /** Written right after the front matter so a reader (or an LLM) learns the comment syntax. Never parsed. */
  const formatLine = '<!-- archipelago v1: `# ` heading = section, island = its map position (id=s*). '
    + 'claim = one-line summary card of the paragraph below it (id=c*), needs = ids it depends on, '
    + 'pos/w = floating figure/table/equation card on the map, `## ` to `##### ` = subsection (nested, closed by <!-- endgroup --> or <!-- endgroup ### -->), '
    + '`<!-- subsection: -->` under a heading = the claim it was expanded from (id, needs). '
    + 'Notes at the end = loose notes on the map, not in the paper (id=u*), to = section or claim a note points at. -->';
  const isFormatLine = l => trimmed(l).startsWith('<!-- archipelago v');

  /** Whether `text` is an Archipelago document, as opposed to an ordinary Markdown note. Every document
   *  has the format line as its first line after the front matter (and blank lines); a note that merely
   *  quotes the line further down, in a code block say, is not one. */
  function isDocument(text) {
    const lines = text.replace(/^\uFEFF/, '').slice(0, 20000).split('\n');
    let i = 0;
    if (lines.length > 1 && trimmed(lines[0]) === '---') {
      const end = lines.findIndex((l, k) => k >= 1 && trimmed(l) === '---');
      if (end < 0) return false;
      i = end + 1;
    }
    while (i < lines.length && trimmed(lines[i]) === '') i++;
    return i < lines.length && isFormatLine(lines[i]);
  }

  const notesMarker = '<!-- notes: loose notes on the map, not part of the paper -->';

  /** `- text <!-- id=u1 to=c3 pos=10,20 -->`: one note of the notes block. A bare `- text` is a note too. */
  function noteItem(line) {
    const t = trimmed(line);
    if (!t.startsWith('- ')) return null;
    let text = t.slice(2), kv = {};
    const open = text.lastIndexOf('<!--');
    const m = t.endsWith('-->') && open >= 0 ? tokens(trimmed(text.slice(open + 4, -3))) : null;
    if (m) {
      kv = m;
      text = text.slice(0, open);
      if (text.endsWith(' ')) text = text.slice(0, -1);   // only the separator, so the text keeps its own spaces
    } else {
      text = trimmed(text);
    }
    return newIdea({ cid: kv.id ?? '', text, pos: point(kv.pos) ?? { x: 0, y: 0 }, to: kv.to ?? '' });
  }

  function noteLine(n) {
    const md = [];
    if (n.cid) md.push('id=' + n.cid);
    if (n.to) md.push('to=' + n.to);
    md.push(`pos=${rnd(n.pos.x)},${rnd(n.pos.y)}`);
    return ['-', ...(n.text ? [oneLine(n.text)] : []), '<!--', ...md, '-->'].join(' ');
  }

  function islandLine(sid, p) {
    const kv = [];
    if (sid) kv.push('id=' + sid);
    if (p) kv.push('x=' + rnd(p.x), 'y=' + rnd(p.y));
    return kv.length ? '<!-- island: ' + kv.join(' ') + ' -->' : null;
  }

  function keyValue(line) {
    const r = line.indexOf(':');
    if (r < 0) return null;
    const k = trimmed(line.slice(0, r));
    let v = trimmed(line.slice(r + 1));
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1).replaceAll('\\"', '"');
    }
    return [k, v];
  }

  function yamlValue(v) {
    const q = v.includes(': ') || v.includes('#') || v.startsWith('"') || v.startsWith("'")
      || v.startsWith('[') || v.startsWith('{') || v.startsWith('-');
    return q ? '"' + v.replaceAll('"', '\\"') + '"' : v;
  }
  const yamlLine = (k, v) => `${k}: ${yamlValue(v)}`;

  // ---- parse ----

  /** The fence a Markdown line leaves us in: '' outside a fence, else the opening run (``` or ~~~ or longer). */
  function fenceAfter(state, line) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!state) return m && !(m[1][0] === '`' && m[2].includes('`')) ? m[1] : '';
    return m && m[1][0] === state[0] && m[1].length >= state.length && trimmed(m[2]) === '' ? '' : state;
  }

  function parse(text) {
    const d = newDoc();
    if (text.charCodeAt(0) === 0xFEFF) { d.bom = true; text = text.slice(1); }
    if (text.includes('\r\n')) d.eol = '\r\n';
    const lines = text.split(d.eol === '\r\n' ? /\r?\n/ : '\n');
    let i = 0;
    const end = lines.length > 1 && trimmed(lines[0]) === '---'
      ? lines.findIndex((l, k) => k >= 1 && trimmed(l) === '---') : -1;
    if (end >= 1) {
      const fl = lines.slice(0, end + 1);
      d.frontLines = fl;
      let k = 1;
      while (k < fl.length - 1) {
        const l = fl[k], kv = l.startsWith(' ') ? null : keyValue(l);
        if (kv) {
          const [key, v] = kv;
          if (key === 'title') d.title = v;
          if (key === 'thesis') d.thesis = v;
          if (key === 'unplaced') {
            let j = k + 1;
            const items = [];
            while (j < fl.length - 1 && (fl[j].startsWith(' ') || fl[j].startsWith('-') || trimmed(fl[j]) === '')) {
              let t = trimmed(fl[j]);
              if (t.startsWith('- ')) { items.push({}); t = t.slice(2); }
              const ikv = keyValue(t);
              if (ikv && items.length) items[items.length - 1][ikv[0]] = ikv[1];
              j += 1;
            }
            d.unplaced = items.map(it => newIdea({
              cid: it.id ?? '', text: it.text ?? '', pos: { x: num(it.x ?? '') ?? 0, y: num(it.y ?? '') ?? 0 }, to: it.to ?? '',
            }));
            d.unplacedRange = [k, j];
            k = j;
            continue;
          }
        }
        k += 1;
      }
      d.origTitle = d.title;
      d.origThesis = d.thesis;
      i = end + 1;
    }
    // The notes block runs from its marker to the end of the file.
    let body = lines.slice(i);
    let fence = '';
    for (let k = 0; k < body.length; k++) {
      fence = fenceAfter(fence, body[k]);
      if (!fence && comment(body[k], 'notes') !== null) {
        d.notesLines = body.slice(k);
        d.unplaced = d.unplaced.concat(body.slice(k + 1).map(noteItem).filter(Boolean));
        body = body.slice(0, k);
        break;
      }
    }
    d.origUnplaced = JSON.parse(JSON.stringify(d.unplaced));
    const chunks = [];
    let current = [], seenHeading = false, inFence = '';
    for (const l of body) {
      inFence = fenceAfter(inFence, l);
      if (!inFence && isHeading(l)) {
        if (seenHeading) chunks.push(current); else d.preamble = current;
        current = [l];
        seenHeading = true;
      } else {
        current.push(l);
      }
    }
    if (seenHeading) chunks.push(current); else d.preamble = current;
    const f = d.preamble.findIndex(isFormatLine);
    if (f >= 0) { d.formatLine = d.preamble[f]; d.preamble.splice(f, 1); }
    d.sections = chunks.map(parseSection);
    return d;
  }

  function parseSection(ls) {
    const title = trimmed(ls[0].slice(1));
    let j = 1, syn = '', island = null, sid = '';
    while (j < ls.length) {
      if (trimmed(ls[j]) === '') { j += 1; continue; }
      const s = comment(ls[j], 'synopsis');
      if (s !== null) { syn = s; j += 1; continue; }
      const isl = comment(ls[j], 'island'), kv = isl !== null ? tokens(isl) : null;
      if (kv) { island = point(`${kv.x ?? ''},${kv.y ?? ''}`); sid = kv.id ?? ''; j += 1; continue; }
      break;
    }
    const header = ls.slice(0, j);
    const paras = [];
    while (j < ls.length) {
      const p = newParagraph({ trailing: [] });
      let textLines = [];
      if (isMarkerLine(ls[j])) {
        // `## Subsection` and `<!-- endgroup -->` are paragraphs of their own. A heading may be followed by
        // `<!-- subsection: text | id= needs= -->`, the claim it was expanded from.
        textLines = [ls[j]]; j += 1;
        const sub = isGroupHeading(textLines[0]) && j < ls.length ? comment(ls[j], 'subsection') : null;
        if (sub !== null) {
          p.orig = claimMeta(sub);
          Object.assign(p, JSON.parse(JSON.stringify(p.orig)));
          p.origClaimLine = ls[j]; j += 1;
        }
      } else {
        const c = comment(ls[j], 'claim');
        if (c !== null) {
          p.orig = claimMeta(c);
          Object.assign(p, JSON.parse(JSON.stringify(p.orig)));
          p.origClaimLine = ls[j]; j += 1;
        }
        let inFence = '';
        while (j < ls.length && trimmed(ls[j]) !== '' && comment(ls[j], 'claim') === null && (inFence || !isMarkerLine(ls[j]))) {
          inFence = fenceAfter(inFence, ls[j]);
          textLines.push(ls[j]); j += 1;
        }
      }
      while (j < ls.length && trimmed(ls[j]) === '') { p.trailing.push(ls[j]); j += 1; }
      p.text = textLines.join('\n');
      paras.push(p);
    }
    return {
      id: uid(), title, synopsis: syn, island, origTitle: title, origSynopsis: syn, origIsland: island,
      headerLines: header, paragraphs: paras, sid, origSid: sid,
    };
  }

  // ---- serialize ----

  function setKey(fl, key, value) {
    for (let k = 1; k < fl.length - 1; k++) {
      if (!fl[k].startsWith(' ') && (keyValue(fl[k]) || [])[0] === key) { fl[k] = yamlLine(key, value); return; }
    }
    fl.splice(fl.length - 1, 0, yamlLine(key, value));
  }

  function linesOf(p) {
    let r = [];
    if (kind(p) === 'group') {
      // the heading, then the subsection comment when it came from a claim
      r.push(p.text);
      if (p.origClaimLine !== null && eq(metaOf(p), p.orig)) r.push(p.origClaimLine);
      else if (p.origClaimLine !== null || p.claim || p.cid) r.push(claimLine(metaOf(p), 'subsection'));
      return r.concat(p.trailing);
    }
    if (p.origClaimLine !== null && eq(metaOf(p), p.orig)) r.push(p.origClaimLine);
    else if (p.origClaimLine !== null || p.claim || p.cid) r.push(claimLine(metaOf(p)));
    // Blank lines would split the paragraph on reload, so they are dropped.
    if (p.text) r = r.concat(p.text.split('\n').filter(l => trimmed(l) !== ''));
    return r.concat(p.trailing);
  }

  /** Replace (or insert after the heading, or drop) the `<!-- key: ... -->` header line. */
  function setComment(h, key, line) {
    const k = h.findIndex((l, i) => i >= 1 && comment(l, key) !== null);
    if (k >= 0) { if (line !== null) h[k] = line; else h.splice(k, 1); }
    else if (line !== null) h.splice(1, 0, line);
  }

  function serialize(d) {
    let out = [];
    if (d.frontLines) {
      const fl = d.frontLines.slice();
      // Old files kept the notes in the front matter. They now go at the end.
      if (d.unplacedRange) fl.splice(d.unplacedRange[0], d.unplacedRange[1] - d.unplacedRange[0]);
      if (d.title !== d.origTitle) setKey(fl, 'title', oneLine(d.title));
      if (d.thesis !== d.origThesis) setKey(fl, 'thesis', oneLine(d.thesis));
      out = out.concat(fl);
    } else if (d.title || d.thesis) {
      out.push('---', yamlLine('title', oneLine(d.title)), yamlLine('thesis', oneLine(d.thesis)), '---');
    }
    out.push(d.formatLine || formatLine);   // a line that is there is kept: another plugin version must not make every open a change
    out = out.concat(d.preamble);
    for (const s of d.sections) {
      const h = s.headerLines.slice();
      if (s.title !== s.origTitle) h[0] = '# ' + oneLine(s.title);
      if (s.synopsis !== s.origSynopsis) setComment(h, 'synopsis', s.synopsis ? `<!-- synopsis: ${oneLine(s.synopsis)} -->` : null);
      if (!eq(s.island, s.origIsland) || s.sid !== s.origSid) setComment(h, 'island', islandLine(s.sid, s.island));
      out = out.concat(h);
      let prevEndsBlank = true, prevMarker = false;
      for (const p of s.paragraphs) {
        const ls = linesOf(p);
        if (!ls.length) continue;
        // A claim-less paragraph glued to the previous block would merge on reparse.
        // Group markers always parse as their own paragraph, so they never merge.
        if (!prevEndsBlank && !prevMarker && !isMarker(p) && (p.origClaimLine === null && !p.claim && !p.cid)) out.push('');
        out = out.concat(ls);
        prevEndsBlank = trimmed(ls[ls.length - 1]) === '';
        prevMarker = isMarker(p);
      }
    }
    if (d.notesLines && !d.unplacedRange && eq(d.unplaced, d.origUnplaced)) {
      out = out.concat(d.notesLines);
    } else if (d.unplaced.length) {
      if (out.length && trimmed(out[out.length - 1]) !== '') out.push('');
      // Lines in the notes block that are not notes are kept after them (--check reports them).
      const other = (d.notesLines || []).slice(1).filter(l => trimmed(l) !== '' && noteItem(l) === null);
      out = out.concat([notesMarker], d.unplaced.map(noteLine), other, ['']);
    }
    return (d.bom ? '\uFEFF' : '') + out.join(d.eol || '\n');
  }

  // ---- repair and check ----

  const dupKeys = pairs => new Set(pairs.map(p => p[0])).size < pairs.length;

  /** Rewrite a claim comment whose metadata repeats, when the repeats agree. Returns one line per fix. */
  function repair(d) {
    const fixed = [];
    for (const s of d.sections) {
      for (const p of s.paragraphs) {
        const c = p.origClaimLine !== null ? claimComment(p.origClaimLine) : null;
        if (c === null) continue;
        const { text, groups } = claimParts(c);
        const pairs = groups.flat();
        if (!(groups.length > 1 || dupKeys(pairs))) continue;
        const kv = {}; let agree = true;
        for (const [k, v] of pairs) {
          if (k in kv && kv[k] !== v) agree = false;
          kv[k] = v;
        }
        if (!agree) continue;
        const m = meta(text, kv);
        Object.assign(p, JSON.parse(JSON.stringify(m)));
        p.orig = m;
        p.origClaimLine = claimLine(m, kind(p) === 'group' ? 'subsection' : 'claim');
        fixed.push(`claim ${m.cid}: merged repeated metadata into ${p.origClaimLine}`);
      }
    }
    return fixed;
  }

  /** Problems worth fixing by hand. */
  function check(text) {
    const r = [];
    text.split('\n').forEach((l, k) => {
      const c = claimComment(l);
      if (c === null) return;
      const g = claimParts(c).groups;
      if (g.length > 1 || dupKeys(g.flat())) r.push(`line ${k + 1}: malformed claim comment (metadata repeated): ${trimmed(l)}`);
    });
    const d = parse(text);
    repair(d);
    const quote = s => { const a = [...s]; return '"' + (a.length > 50 ? a.slice(0, 50).join('') + '…' : s) + '"'; };
    const seen = {};
    const id = (i, what, prefix) => {
      if (!i) return;
      if (i in seen) r.push(`duplicate id ${i}: ${seen[i]} and ${what}`); else seen[i] = what;
      if ('scu'.includes(i[0]) && i[0] !== prefix) r.push(`${what}: id ${i} has the prefix of another kind (${prefix}* expected)`);
    };
    const cids = new Set(d.sections.flatMap(s => s.paragraphs.map(p => p.cid)).filter(Boolean));
    const targets = new Set([...cids, ...d.sections.map(s => s.sid).filter(Boolean)]);
    for (const s of d.sections) {
      id(s.sid, `section ${quote(s.title)}`, 's');
      for (const p of s.paragraphs) {
        if (p.origClaimLine === null) continue;
        const what = `claim ${p.cid ? p.cid + ' ' : ''}${quote(p.claim)} in ${quote(s.title)}`;
        id(p.cid, what, 'c');
        if (trimmed(p.claim) === '' && kind(p) !== 'group') r.push(`${what}: empty claim text`);
        if (trimmed(p.claim) === 'New claim') r.push(`${what}: placeholder text`);
        for (const n of p.needs) if (!cids.has(n)) r.push(`${what}: needs unknown id ${n}`);
      }
    }
    // a subsection should sit one level below the one it is in
    for (const sec of d.sections) {
      const st = [];
      for (const p of sec.paragraphs) {
        const kd = kind(p), l = kd === 'group' || kd === 'groupEnd' ? level(p) : null;
        if (kd === 'group') {
          while (st.length && st[st.length - 1] >= l) st.pop();
          const parent = st.length ? st[st.length - 1] : 1;
          if (l > parent + 1) r.push(`${quote(sec.title)}: ${quote(groupName(p))} is level ${l} but follows level ${parent} (skips a level)`);
          st.push(l);
        } else if (kd === 'groupEnd') {
          if (!st.some(x => x >= l)) r.push(`${quote(sec.title)}: an end marker of level ${l} closes nothing`);
          while (st.length && st[st.length - 1] >= l) st.pop();
        }
      }
    }
    for (const n of d.unplaced) {
      const what = `note ${n.cid ? n.cid + ' ' : ''}${quote(n.text)}`;
      id(n.cid, what, 'u');
      if (n.to && !targets.has(n.to)) r.push(`${what}: to= unknown section or claim id ${n.to}`);
    }
    for (const l of (d.notesLines || []).slice(1)) {
      if (trimmed(l) !== '' && noteItem(l) === null) r.push('notes block: not a `- note` line: ' + trimmed(l));
    }
    return r;
  }

  /** Give every section, claim, block and note an id: s/c/u plus the smallest unused integer. */
  function assignIDs(d) {
    const used = new Set([...d.sections.map(s => s.sid), ...d.sections.flatMap(s => s.paragraphs.map(p => p.cid)), ...d.unplaced.map(u => u.cid)]);
    const next = prefix => {
      let n = 1;
      while (used.has(prefix + n)) n += 1;
      used.add(prefix + n);
      return prefix + n;
    };
    for (const s of d.sections) if (!s.sid) s.sid = next('s');
    for (const s of d.sections) for (const p of s.paragraphs) {
      if (!p.cid && (p.origClaimLine !== null || p.claim || isBlock(p))) p.cid = next('c');
    }
    for (const u of d.unplaced) if (!u.cid) u.cid = next('u');
  }

  // ---- merging two versions of one document ----
  // Used when the file changes on disk while it is open (a sync tool, another person's edit):
  // base = the last text shared with the other side, ours = what is open, theirs = the file now.

  /** Matching line pairs [i, j] of a longest common subsequence (Myers), or null when the
   *  texts differ too much to be worth comparing. */
  function lcsPairs(a, b, maxD = 1500) {
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let ea = a.length, eb = b.length;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    const pairs = [];
    for (let i = 0; i < s; i++) pairs.push([i, i]);
    const A = a.slice(s, ea), B = b.slice(s, eb), n = A.length, m = B.length;
    if (n && m) {
      const max = Math.min(n + m, maxD), off = max + 1, trace = [];
      let v = new Int32Array(2 * max + 3), done = false;
      for (let d = 0; d <= max && !done; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
          let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
          let y = x - k;
          while (x < n && y < m && A[x] === B[y]) { x++; y++; }
          v[off + k] = x;
          if (x >= n && y >= m) { done = true; break; }
        }
      }
      if (!done) return null;
      const mid = [];
      let x = n, y = m;
      for (let d = trace.length - 1; d >= 0; d--) {
        const pv = trace[d], k = x - y;
        const pk = (k === -d || (k !== d && pv[off + k - 1] < pv[off + k + 1])) ? k + 1 : k - 1;
        const px = pv[off + pk], py = px - pk;
        while (x > px && y > py) { mid.push([s + x - 1, s + y - 1]); x--; y--; }
        if (d > 0) { x = px; y = py; }
      }
      mid.reverse();
      for (const p of mid) pairs.push(p);
    }
    for (let i = 0; i < a.length - ea; i++) pairs.push([ea + i, eb + i]);
    return pairs;
  }

  const sameLines = (x, y) => x.length === y.length && x.every((l, i) => l === y[i]);

  /** Three-way merge by lines. Segments: { type: 'same', lines } and { type: 'conflict', ours, theirs }.
   *  A change on one side only, the same change on both sides, and two insertions at one place
   *  (kept both, ours first) merge on their own. */
  function merge3Lines(o, a, b) {
    const pa = lcsPairs(o, a), pb = lcsPairs(o, b);
    if (!pa || !pb) return [{ type: 'conflict', ours: a, theirs: b }];
    const ma = new Int32Array(o.length).fill(-1), mb = new Int32Array(o.length).fill(-1);
    for (const [i, j] of pa) ma[i] = j;
    for (const [i, j] of pb) mb[i] = j;
    const segs = [];
    const same = ls => {
      if (!ls.length) return;
      if (!segs.length || segs[segs.length - 1].type !== 'same') segs.push({ type: 'same', lines: [] });
      segs[segs.length - 1].lines.push(...ls);
    };
    let io = 0, ia = 0, ib = 0;
    for (let i = 0; i <= o.length; i++) {
      if (i < o.length && !(ma[i] >= 0 && mb[i] >= 0)) continue;
      const ja = i === o.length ? a.length : ma[i], jb = i === o.length ? b.length : mb[i];
      const oR = o.slice(io, i), aR = a.slice(ia, ja), bR = b.slice(ib, jb);
      if (sameLines(aR, oR)) same(bR);
      else if (sameLines(bR, oR) || sameLines(aR, bR)) same(aR);
      else if (!oR.length) { same(aR); same(bR); }
      else segs.push({ type: 'conflict', ours: aR, theirs: bR });
      if (i < o.length) same([o[i]]);
      io = i + 1; ia = ja + 1; ib = jb + 1;
    }
    return segs;
  }

  /** Ids (`c3`, `s2`, `u1`) in the metadata of a text: `id=`, `needs=` and `to=` values. */
  const ID_RE = /\b(id|needs|to)=([A-Za-z0-9,]+)/g;
  function idsIn(text) {
    const r = new Set();
    for (const l of text.split(/\r?\n/)) if (!isFormatLine(l) && (/^\s*<!--/.test(l) || /<!--[^]*-->\s*$/.test(l))) {
      for (const m of l.matchAll(ID_RE)) if (m[1] === 'id') r.add(m[2]);
    }
    return r;
  }
  function renameIds(text, map) {
    if (!map.size) return text;
    return text.split('\n').map(l => {
      const i = l.lastIndexOf('<!--');
      if (i < 0 || !/-->\s*$/.test(l)) return l;
      // In a claim comment only the part after the last " | " is metadata, never the claim text.
      const claim = /^\s*<!-- (?:claim|subsection):/.test(l), bar = claim ? l.lastIndexOf(' | ') : -1;
      const from = claim ? (bar >= 0 ? bar : l.length) : i;
      return l.slice(0, from) + l.slice(from).replace(ID_RE, (all, k, v) => `${k}=${v.split(',').map(x => map.get(x) ?? x).join(',')}`);
    }).join('\n');
  }

  /** Merge two versions of a document that grew from `base`. Ids that both sides made up for
   *  different things (each picks the smallest unused number) are renamed on theirs first.
   *  `saved` is the text we last wrote: an id in it has been out there, so a `theirs` that has it
   *  most likely grew from it, and only ids we made up since can clash with theirs.
   *  Returns { text, conflicts, segments, eol }: `text` when nothing is left to decide, else `segments`
   *  for the resolver (conflicts carry the section and claim they sit in). */
  /** Of the versions this side has seen or written (oldest first), the one `theirs` most likely grew from: the fewest lines
   *  that are in one and not the other (a count of lines, regardless of order). A sync tool may bring back a version we wrote
   *  ourselves a moment ago (then it is that one, and nothing is in conflict), or another device's edit of an older version
   *  (then it is that older one, so what we changed since is ours and stays). On a tie the older one. */
  function closestBase(candidates, theirs) {
    const count = t => { const m = new Map(); for (const l of t.split(/\r?\n/)) m.set(l, (m.get(l) || 0) + 1); return m; };
    const th = count(theirs);
    let best = null, bestD = Infinity;
    for (const c of candidates) {
      if (c == null) continue;
      if (c === theirs) return c;
      const cm = count(c);
      let d = 0;
      for (const [l, n] of cm) d += Math.abs(n - (th.get(l) || 0));
      for (const [l, n] of th) if (!cm.has(l)) d += n;
      if (d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  function mergeDocs(base, ours, theirs, saved = base) {
    const eol = ours.includes('\r\n') ? '\r\n' : '\n';
    const baseIds = idsIn(base), oursIds = idsIn(ours), theirsIds = idsIn(theirs), savedIds = idsIn(saved);
    const clash = [...theirsIds].filter(id => !baseIds.has(id) && !savedIds.has(id) && oursIds.has(id));
    if (clash.length) {
      const used = new Set([...baseIds, ...oursIds, ...theirsIds]), map = new Map();
      for (const id of clash) {
        let n = 1;
        while (used.has(id[0] + n)) n++;
        used.add(id[0] + n);
        map.set(id, id[0] + n);
      }
      theirs = renameIds(theirs, map);
    }
    const lines = t => t.split(/\r?\n/);
    const segs = merge3Lines(lines(base), lines(ours), lines(theirs));
    let heading = '', claim = '';
    for (const sg of segs) {
      if (sg.type === 'same') {
        for (const l of sg.lines) {
          if (/^# /.test(l)) { heading = l.slice(2).trim(); claim = ''; }
          const c = trimmed(l).match(/^<!-- claim:(.*?)(?: \| [^|]*)?-->$/);
          if (c) claim = c[1].trim();
        }
      } else { sg.heading = heading; sg.claim = claim; }
    }
    const conflicts = segs.filter(x => x.type === 'conflict').length;
    return { conflicts, segments: segs, eol, text: conflicts ? null : joinSegments(segs, eol) };
  }

  /** The merged text once every conflict has a choice ('ours', 'theirs' or 'both'). */
  function joinSegments(segs, eol = '\n') {
    const out = [];
    for (const sg of segs) {
      if (sg.type === 'same') out.push(...sg.lines);
      else out.push(...(sg.choice === 'ours' ? sg.ours : sg.choice === 'theirs' ? sg.theirs : [...sg.ours, ...sg.theirs]));
    }
    return out.join(eol);
  }

  /** Clean up an id that two things have, which is what a line merge leaves when both sides added the same claim
   *  and the diffs lined the two copies up differently, or when two sides made up one id after one of them was
   *  saved. A later copy that is the same claim (same text, links, position) is removed; one that is a different
   *  claim gets a new id (links keep pointing at the first). Returns what was done, one line each. */
  function fixDuplicateIds(d) {
    const used = new Set([...d.sections.map(s => s.sid), ...d.sections.flatMap(s => s.paragraphs.map(p => p.cid)), ...d.unplaced.map(u => u.cid)]);
    const seen = new Map(), done = [];
    const fresh = prefix => { let n = 1; while (used.has(prefix + n)) n++; used.add(prefix + n); return prefix + n; };
    const same = (p, q) => p.claim === q.claim && p.text === q.text && eq(p.needs, q.needs) && eq(p.pos, q.pos) && p.w === q.w;
    for (const s of d.sections) {
      if (s.sid) { if (seen.has(s.sid)) { done.push(`${s.sid} -> ${s.sid = fresh('s')}`); } seen.set(s.sid, s); }
      for (let k = 0; k < s.paragraphs.length; k++) {
        const p = s.paragraphs[k];
        if (!p.cid) continue;
        const first = seen.get(p.cid);
        if (!first) { seen.set(p.cid, p); continue; }
        if (first.id !== undefined && first.text !== undefined && same(first, p)) { s.paragraphs.splice(k--, 1); done.push(`${p.cid} (a second copy removed)`); }
        else { done.push(`${p.cid} -> ${p.cid = fresh('c')}`); seen.set(p.cid, p); }
      }
    }
    for (const u of d.unplaced) {
      if (!u.cid) continue;
      const first = seen.get(u.cid);
      if (!first) { seen.set(u.cid, u); continue; }
      done.push(`${u.cid} -> ${u.cid = fresh('u')}`); seen.set(u.cid, u);
    }
    return done;
  }

  /** Drop `needs` and note links that point at ids that no longer exist (one side deleted what the other linked). */
  function dropDangling(d) {
    const ids = new Set([...d.sections.map(s => s.sid), ...d.sections.flatMap(s => s.paragraphs.map(p => p.cid))]);
    let n = 0;
    for (const s of d.sections) for (const p of s.paragraphs) {
      const keep = p.needs.filter(x => ids.has(x));
      if (keep.length !== p.needs.length) { n += p.needs.length - keep.length; p.needs = keep; }
    }
    for (const u of d.unplaced) if (u.to && !ids.has(u.to)) { u.to = ''; n++; }
    return n;
  }

  return {
    uid, trimmed, oneLine, eq, newParagraph, newSection, newIdea, newDoc,
    kind, isBlock, isMarker, isCard, groupName, setGroupName, figure, tableRows, equation,
    groupOf, groupAt, endOfGroup, normalizeGroups, numbering, plan, inactiveIds, endGroup, endMarker, level, withLevel, openAt, pathOf, subtreeEnd, shiftLevels, depthBelow, MAX_LEVEL,
    parse, serialize, repair, check, assignIDs, isDocument, isFormatLine,
    lcsPairs, merge3Lines, mergeDocs, closestBase, joinSegments, renameIds, idsIn, dropDangling, fixDuplicateIds, fenceAfter,
  };
});
