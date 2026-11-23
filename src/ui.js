// Archipelago for Obsidian: the document UI (map and prose), one instance per open document.
//
// The view of a document: Map, Prose, LaTeX and PDF. An instance owns its state
// (several documents can be open), it lives in a shadow root (Obsidian's and other plugins' CSS
// cannot reach it), files are read and written through `host`, and the file is merged with changes
// made elsewhere instead of being overwritten (see "the file" below).
//
//   host.css                 the stylesheet text for the shadow root
//   host.settings()          { autosaveSeconds }
//   host.read()              the file's text
//   host.process(fn)         atomic read-modify-write; fn(current) returns the new text
//   host.imageURL(rel)       a URL the page can show for a figure path relative to the document, or null
//   host.pickImage()         choose a figure in the vault: { rel, name } or null
//   host.importImages(files) copy dropped image Files into the vault: [{ rel, name }]
//   host.isDark()            whether Obsidian is in dark mode
//   host.notice(text)        a message to the user
//   host.name()              the document's file name, for messages
//   host.figureTarget(rel)   the vault path a figure path points at (file or not); host.exists(path)
//   host.tidyFigures(a, b)   after a save: trash the images that text a used and text b does not; returns what it removed
//   host.restoreFigure(path, bytes)   put a trashed image back

function createApp(host, container) {
'use strict';
const C = Core;
const D = container.ownerDocument;
const win = () => D.defaultView;

// ---- small helpers ----

function h(tag, attrs, ...kids) {
  const el = D.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    else if (k === 'data') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
function sv(tag, attrs) {
  const el = D.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  return el;
}
const icon = (d, size = 16) => {
  const s = sv('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  s.append(sv('path', { d }));
  return s;
};
const ICONS = {
  section: 'M1.5 3.5h13v9h-13zM5.8 3.5v9M10.2 3.5v9',
  claim: 'M2 4.5h12M2 8h12M2 11.5h7',
  figure: 'M1.5 3h13v10h-13zM1.5 11l3.5-3.5 3 3 2-2 4.5 4M10.5 6.2a.8.8 0 1 0 .01 0',
  table: 'M1.5 3h13v10h-13zM1.5 6.3h13M1.5 9.7h13M6 3v10M10.5 3v10',
  subsection: 'M1.5 2.5h13v11h-13zM4 6h8v6H4zM6 8.5h4',
  fit: 'M2 6V2h4M14 10v4h-4M2 2l4.5 4.5M14 14l-4.5-4.5',
};
const findLast = (a, f) => { for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return a[i]; return undefined; };
const isTextTarget = el => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
const basename = p => p.slice(p.lastIndexOf('/') + 1);
const ext = p => { const b = basename(p), k = b.lastIndexOf('.'); return k > 0 ? b.slice(k + 1).toLowerCase() : ''; };

/** Muted hues: blue, green, orange, purple, teal, pink, yellow, sage (as "r, g, b"). */
const HUES = ['107, 153, 209', '117, 173, 133', '230, 158, 97', '158, 138, 199', '97, 168, 184', '214, 133, 163', '214, 184, 102', '143, 163, 128'];
const hue = i => HUES[i % HUES.length];
const BLOCK_HUE = '128, 138, 153', IDEA_HUE = '255, 149, 0', NOTE_HUE = '142, 142, 147';

/** Map geometry in world points. */
const L = { islandW: 300, pad: 14, header: 50, gap: 8, addH: 30, cardW: 272, blockW: 200, ideaW: 220,
  groupHeader: 26, groupInset: 6, groupBottom: 6, groupEmpty: 22 };


// ---- the view's DOM: a shadow root with a toolbar, the map or prose, and an overlay ----

const hostEl = D.createElement('div');
hostEl.className = 'apg-host';
const shadow = hostEl.attachShadow({ mode: 'open' });
const styleEl = D.createElement('style');
styleEl.textContent = host.css;
const rootEl = h('div', { class: 'root', tabindex: '-1' }, h('div', { id: 'toolbar' }), h('div', { id: 'body' }, h('div', { id: 'main' })), h('div', { id: 'overlay', hidden: true }));
shadow.append(styleEl, rootEl);
container.append(hostEl);


// ---- state ----

const S = {
  doc: C.newDoc(), level: 'map', status: '', pan: { x: 40, y: 40 }, zoom: 1, viewport: { w: 0, h: 0 },
  islandDrag: null, cardDrag: null, linkDrag: null, hovered: null, editing: null, editingTitle: null, editingGroup: null,
  linkingFrom: null, linkTarget: null, linkPointer: null, selectedLink: null, resizeDrag: null, editingCell: null,
  editingEquation: null, focusParagraph: null, focusClaim: null, focusSection: null, selection: new Set(), groupDrag: null, marquee: null, templateDrag: null,
  startZoom: null, heights: {}, lastSection: null, needsFit: true, snapshotting: false,
  sourceOpen: new Set(), highlight: null, conflict: null, fade: false,
  // LaTeX and PDF: what the vault has for them (templates, .bib files), the last compile and the PDF shown
  tex: { info: null, templates: null, compiling: false, result: null, pdf: null, pdfFor: null, showLog: false, scrollTo: null,
    outside: false, report: null, syncing: false, preview: null, installing: false, pending: null },
};
let undoStack = [], redoStack = [], breakUndo = true, lastChange = 0, depth = 0;
let destroyed = false, fitTimer = null;

// ---- undo ----

/** Run `f` on the document and record one undo snapshot if it changed anything. Changes less
 *  than 1 s apart coalesce (typing), unless an action or an editing boundary starts a new entry. */
function change(f) {
  if (depth > 0) return f();
  const old = JSON.stringify(S.doc);
  depth++;
  try { f(); } finally { depth--; }
  if (old === JSON.stringify(S.doc)) return;
  const now = Date.now();
  if (breakUndo || now - lastChange > 1000 || !undoStack.length) {
    undoStack.push(old);
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    breakUndo = false;
  }
  lastChange = now;
  docChanged();
}

/** One undo entry for everything `f` changes, then a full redraw. */
function act(f) {
  if (depth === 0) breakUndo = true;
  change(f);
  if (depth === 0) breakUndo = true;
  requestRender();
}

function swapDoc(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(S.doc));
  S.doc = JSON.parse(from.pop());
  breakUndo = true;
  S.selectedLink = null;
  S.editing = null;
  docChanged();
  requestRender();
  restoreFigures();
}
const undo = () => swapDoc(undoStack, redoStack);
const redo = () => swapDoc(redoStack, undoStack);

function setEditing(id) { S.editing = id; breakUndo = true; requestRender(); }
function setEditingCell(ref) { S.editingCell = ref; breakUndo = true; requestRender(); }
function setEditingEquation(id) { S.editingEquation = id; breakUndo = true; requestRender(); }
const sameCell = (a, b) => !!a && !!b && a.id === b.id && a.r === b.r && a.c === b.c;

// ---- the file: load, save, and merge with changes made elsewhere ----
//
// The document is saved to its file by `host.process` and read back by `host.read`. The same file
// may be changed by someone else at any time (LiveSync, Syncthing, git, an editor). Three texts
// keep that from losing work:
//   knownDisk  what the file held when we last read or wrote it,
//   base       the last text that came from outside (at open, or the last external change),
//   seen       the versions we read or wrote lately (oldest first), base among them,
//   ours       what is open now.
// When the file differs from knownDisk, ours and theirs are merged line by line (core.js) over the version of `seen` that
// theirs grew from: a sync tool may bring back one of our own earlier writes (LiveSync does, while one types), or another
// device's edit of an older version.

let seen = [];   // see above; a few dozen texts at most
const remember = t => { if (seen[seen.length - 1] !== t) seen.push(t); if (seen.length > 40) seen.shift(); };
let knownDisk = '', base = '', inflight = null, saveTimer = null, saving = false, failing = false, queue = Promise.resolve();
const graveyard = new Map();   // images moved to the trash after a save: path -> bytes, so that undo can bring one back

function setStatus(s) { S.status = s; renderStatus(); }

/** Parse `text` into the open document, keeping the in-memory ids of sections and claims that are
 *  still there, so selection, focus and measured heights survive. */
function adopt(text) {
  const old = S.doc, secIds = new Map(), paraIds = new Map(), ideaIds = new Map();
  for (const s of old.sections) {
    if (s.sid) secIds.set(s.sid, s.id);
    for (const p of s.paragraphs) if (p.cid) paraIds.set(p.cid, p.id);
  }
  for (const u of old.unplaced) if (u.cid) ideaIds.set(u.cid, u.id);
  const d = C.parse(text);
  C.repair(d);
  C.dropDangling(d);
  for (const s of d.sections) {
    if (s.sid && secIds.has(s.sid)) s.id = secIds.get(s.sid);
    for (const p of s.paragraphs) if (p.cid && paraIds.has(p.cid)) p.id = paraIds.get(p.cid);
  }
  for (const u of d.unplaced) if (u.cid && ideaIds.has(u.cid)) u.id = ideaIds.get(u.cid);
  S.doc = d;
  C.assignIDs(S.doc);
  autoLayout();
  const live = new Set([...d.sections.flatMap(s => [s.id, ...s.paragraphs.map(p => p.id)]), ...d.unplaced.map(u => u.id)]);
  S.selection = new Set([...S.selection].filter(id => live.has(id)));
  for (const k of ['editing', 'editingTitle', 'editingGroup', 'hovered', 'linkingFrom', 'linkTarget']) if (S[k] && !live.has(S[k])) S[k] = null;
  if (S.editingCell && !live.has(S.editingCell.id)) S.editingCell = null;
  if (S.editingEquation && !live.has(S.editingEquation)) S.editingEquation = null;
  S.sourceOpen = new Set([...S.sourceOpen].filter(id => live.has(id)));
  S.selectedLink = null; S.linkDrag = null; S.cardDrag = null; S.islandDrag = null; S.groupDrag = null; S.resizeDrag = null;
  if (S.lastSection && !live.has(S.lastSection)) S.lastSection = null;
}

async function load() {
  const text = await host.read();
  if (destroyed) return;
  knownDisk = base = text;
  seen = [text];
  undoStack = []; redoStack = [];
  adopt(text);
  S.needsFit = true;
  render();
  settleFit();
  docChanged();   // ids and positions added on open are saved by the next autosave
}

const autosaveMs = () => Math.max(300, (host.settings().autosaveSeconds ?? 1.5) * 1000);

/** Called after every change of the document. */
function docChanged() {
  if (destroyed || S.conflict) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, autosaveMs());
}

function currentText() { C.assignIDs(S.doc); return C.serialize(S.doc); }

/** Write the document unless the file already holds it. A file that changed behind our back is merged first.
 *  The text is made inside the write, from the document as it is at that moment: a merge that lands while the
 *  write is waiting must not be overwritten by a text made before it. */
async function save() {
  if (saving || destroyed) return true;
  saving = true;
  let ok = true;
  try {
    for (let round = 0; round < 5 && !S.conflict; round++) {
      if (currentText() === knownDisk) break;
      let written = null, result;
      try {
        result = await host.process(disk => {
          if (disk !== knownDisk) return disk;
          written = currentText();
          inflight = written;
          return written;
        });
      } catch (e) {
        ok = false;
        if (host.gone && host.gone()) { setStatus('This document was deleted'); break; }   // not a failed save: there is nothing to save to
        if (!failing) host.notice('Archipelago: could not save ' + host.name() + '. Your changes are kept and it will try again.');
        failing = true;
        setStatus('Save failed');
        break;
      } finally {
        inflight = null;
      }
      failing = false;
      if (written !== null && result === written) {
        const before = knownDisk;
        knownDisk = written;
        remember(written);
        // an image this document no longer uses goes to the trash, with a copy kept here for undo
        if (host.tidyFigures) host.tidyFigures(before, written).then(gone => { for (const g of gone) if (g.data) graveyard.set(g.path, g.data); }).catch(() => {});
        setStatus('Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        break;
      }
      mergeFromDisk(result);   // the file changed since we last saw it: merge, then write again
    }
  } finally {
    saving = false;
  }
  // Changes made while the write was under way, or a failed write: try again after the delay.
  if (!destroyed && !S.conflict && !(host.gone && host.gone()) && currentText() !== knownDisk) docChanged();
  return ok;
}

/** Write a pending autosave now (the view is closing, another tab came to the front, Obsidian quits). Gives up
 *  after a few seconds so that a write that never ends cannot keep a tab from closing. */
async function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  const t0 = Date.now();
  for (let round = 0; round < 4 && !destroyed && !S.conflict && Date.now() - t0 < 6000; round++) {
    while (saving && Date.now() - t0 < 6000) await new Promise(r => setTimeout(r, 20));
    if (currentText() === knownDisk) return true;
    if (!(await save())) return false;
    clearTimeout(saveTimer); saveTimer = null;
  }
  return currentText() === knownDisk;
}

/** After undo or redo: a figure whose image was trashed after a save comes back with its block. */
async function restoreFigures() {
  if (!graveyard.size) return;
  let any = false;
  for (const s of S.doc.sections) for (const p of s.paragraphs) {
    const f = C.figure(p), target = f && host.figureTarget(f.path);
    if (target && graveyard.has(target) && !host.exists(target)) {
      try { await host.restoreFigure(target, graveyard.get(target)); any = true; } catch { /* leave the block with a missing image */ }
    }
  }
  if (any) requestRender();
}

/** What is open here, when a conflict is waiting and the view has to go: the text that would otherwise be lost. */
function unsavedText() { return S.conflict ? currentText() : null; }

/** The file holds `disk`, which we did not write. */
function mergeFromDisk(disk) {
  const saved = knownDisk;   // what we last wrote (or last read)
  knownDisk = disk;
  const ours = currentText();
  if (disk === ours) { base = disk; return; }
  if (ours === base) {
    // Nothing of ours is unsaved: take the file as it is.
    adopt(disk);
    base = disk;
    remember(disk);
    undoStack = []; redoStack = [];
    setStatus('Updated from the file');
    requestRender();
    return;
  }
  const from = C.closestBase([...seen, base], disk);
  remember(disk);
  const r = C.mergeDocs(from, ours, disk, saved);
  if (!r.conflicts && r.text === ours) {
    // Nothing in the file that we do not have (an earlier version of ours came back): write ours again, keep the undo.
    base = disk;
    docChanged();
    return;
  }
  if (r.conflicts) {
    // Autosave stays off until the conflicts are decided.
    clearTimeout(saveTimer); saveTimer = null;
    S.conflict = { segments: r.segments, disk, eol: r.eol };
    requestRender();
    return;
  }
  applyMerged(r.text, disk);
}

function applyMerged(text, disk) {
  adopt(text);
  const renamed = C.fixDuplicateIds(S.doc);   // two sides that made up the same id, one of them already saved
  base = disk;
  undoStack = []; redoStack = [];   // an older snapshot would bring the other side's changes back out
  setStatus(renamed.length ? `Merged changes made elsewhere; cleaned up ${renamed.length} claim${renamed.length > 1 ? 's' : ''} that came twice` : 'Merged changes made elsewhere');
  requestRender();
  docChanged();
}

/** The file changed on disk (the shell calls this for every modify event, including our own writes). */
function diskChanged() {
  queue = queue.then(async () => {
    if (destroyed || S.conflict) return;
    let t;
    try { t = await host.read(); } catch { return; }
    if (destroyed || S.conflict || t === knownDisk || t === inflight) return;
    mergeFromDisk(t);
  }).catch(() => {});
  return queue;
}

function resolveConflicts() {
  const c = S.conflict;
  if (!c || c.segments.some(s => s.type === 'conflict' && !s.choice)) return;
  S.conflict = null;
  applyMerged(C.joinSegments(c.segments, c.eol), c.disk);
  diskChanged();   // anything that arrived while the dialog was open
}

/** Keep everything open here, or take everything from the file. */
function chooseAll(v) {
  if (!S.conflict) return;
  for (const s of S.conflict.segments) if (s.type === 'conflict') s.choice = v;
  renderOverlay();
}

/** Refit once card heights and images are measured, then leave the view alone. */
function settleFit() {
  if (fitTimer) return;
  fitTimer = setTimeout(() => {
    fitTimer = null;
    if (destroyed) return;
    if (S.level === 'map' && S.viewport.w > 0) {
      if (S.needsFit) { fitAll(); S.needsFit = false; }
      if (S.startZoom) { zoomBy(S.startZoom / S.zoom); S.startZoom = null; }
      layoutMap();
    }
  }, 300);
}

// ---- ids and layout ----

/** Islands without a position go in a row; blocks without one go below their island. */
function autoLayout() {
  const secs = S.doc.sections;
  let x = 40;
  for (const s of secs) x = Math.max(x, (s.island ? s.island.x : 0) + L.islandW + 80);
  if (secs.every(s => !s.island)) x = 40;
  for (const s of secs) {
    if (!s.island) { s.island = { x, y: 80 }; x += L.islandW + 80; }
    let y = s.island.y + L.header + s.paragraphs.filter(C.isCard).length * 76 + L.addH + 40;
    for (const p of s.paragraphs) {
      if (C.isBlock(p) && !p.pos) { p.pos = { x: s.island.x + 50, y }; y += 170; }
    }
  }
}

// ---- map geometry ----

const rect = (x, y, w, h) => ({ x, y, w, h });
const contains = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const inset = (r, d) => rect(r.x + d, r.y + d, r.w - 2 * d, r.h - 2 * d);
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const midY = r => r.y + r.h / 2;
const ZERO = { w: 0, h: 0 };

const height = id => S.heights[id] ?? 60;
const offset = (id, d) => (d && d.id === id ? d.offset : ZERO);
const groupOffset = id => (S.groupDrag && S.selection.has(id) ? S.groupDrag : ZERO);

function islandOrigin(s) {
  const o = s.island || { x: 0, y: 0 }, d = offset(s.id, S.islandDrag), g = groupOffset(s.id);
  return { x: o.x + d.w + g.w, y: o.y + d.h + g.h };
}

/** Cards stack below the island header. A subsection (`##` to `#####`) is a region with a label row on top and its
 *  cards inset inside it; a deeper subsection is a region inside its parent's, inset once more. Everything in file order. */
function layout(s) {
  const r = { cards: new Map(), groups: [], height: 0 };
  const o = islandOrigin(s);
  let y = o.y + L.header;
  const stack = [];   // the open subsections: { id, level, top, empty }
  const closeOne = () => {
    const g = stack.pop(), d = stack.length + 1;   // depth of the region: 1 for `##`
    const bottom = g.empty ? g.top + L.groupHeader + L.groupEmpty : y - L.gap + L.groupBottom;
    const x = o.x + L.pad - L.groupInset + (d - 1) * L.groupInset, w = L.cardW + 2 * L.groupInset - 2 * (d - 1) * L.groupInset;
    r.groups.push({ id: g.id, level: g.level, depth: d, parent: stack.length ? stack[stack.length - 1].id : null,
      rect: rect(x, g.top, w, bottom - g.top), head: rect(x, g.top, w, L.groupHeader) });
    y = bottom + L.gap;
    if (stack.length) stack[stack.length - 1].empty = false;
  };
  const closeTo = lvl => { while (stack.length && stack[stack.length - 1].level >= lvl) closeOne(); };
  for (const p of s.paragraphs) {
    const k = C.kind(p);
    if (k === 'group') { closeTo(C.level(p)); stack.push({ id: p.id, level: C.level(p), top: y, empty: true }); y += L.groupHeader; }
    else if (k === 'groupEnd') closeTo(C.level(p));
    else if (k === 'prose') {
      const ins = stack.length * L.groupInset;
      r.cards.set(p.id, rect(o.x + L.pad + ins, y, L.cardW - 2 * ins, height(p.id)));
      y += height(p.id) + L.gap;
      for (const e of stack) e.empty = false;
    }
  }
  closeTo(0);
  r.height = y - o.y + L.addH + L.pad;
  return r;
}

function islandRect(s) {
  const o = islandOrigin(s);
  return rect(o.x, o.y, L.islandW, layout(s).height);
}

function blockWidth(p) {
  return Math.min(800, Math.max(120, (p.w ?? (C.kind(p) === 'table' ? 280 : L.blockW)) + offset(p.id, S.resizeDrag).w));
}

/** Live world frame of every card, block and idea, including in-flight drags. */
function frames() {
  const r = new Map();
  const moved = (id, f, free = true) => {
    const d = offset(id, S.cardDrag), g = free ? groupOffset(id) : ZERO;
    return rect(f.x + d.w + g.w, f.y + d.h + g.h, f.w, height(id));
  };
  for (const s of S.doc.sections) {
    const o = islandOrigin(s);
    const lay = layout(s);
    for (const [id, f] of lay.cards) r.set(id, moved(id, f, false));
    for (const g of lay.groups) { const hp = s.paragraphs.find(p => p.id === g.id); if (hp && hp.cid) r.set(g.id, g.head); }
    for (const p of s.paragraphs) {
      if (C.isBlock(p)) { const q = p.pos || o; r.set(p.id, moved(p.id, rect(q.x, q.y, blockWidth(p), 0))); }
    }
  }
  for (const i of S.doc.unplaced) r.set(i.id, moved(i.id, rect(i.pos.x, i.pos.y, L.ideaW, 0)));
  return r;
}

const toWorld = p => ({ x: (p.x - S.pan.x) / S.zoom, y: (p.y - S.pan.y) / S.zoom });

function zoomBy(f, at) {
  const p = at || { x: S.viewport.w / 2, y: S.viewport.h / 2 };
  const w = toWorld(p);
  S.zoom = Math.min(3, Math.max(0.15, S.zoom * f));
  S.pan = { x: p.x - w.x * S.zoom, y: p.y - w.y * S.zoom };
}

function fitAll() {
  if (!(S.viewport.w > 0)) return;
  const rs = [...S.doc.sections.map(islandRect), ...frames().values()];
  if (!rs.length) return;
  const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y));
  const x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h));
  S.zoom = Math.min(1.4, Math.max(0.15, Math.min((S.viewport.w - 60) / (x1 - x0), (S.viewport.h - 110) / (y1 - y0))));
  S.pan = { x: S.viewport.w / 2 - (x0 + x1) / 2 * S.zoom, y: S.viewport.h / 2 - 18 - (y0 + y1) / 2 * S.zoom };
}

function centerIsland(id) {
  const s = S.doc.sections.find(q => q.id === id);
  if (!s || !(S.viewport.w > 0)) return;
  const r = islandRect(s);
  S.zoom = Math.max(S.zoom, 0.8);
  S.pan = { x: S.viewport.w / 2 - (r.x + r.w / 2) * S.zoom, y: S.viewport.h / 2 - midY(r) * S.zoom };
}

function setLevelInternal(l) {
  if (l === S.level) return;
  S.level = l;
  S.fade = true;
  if (l === 'map') { if (S.needsFit) settleFit(); else centerIsland(S.lastSection); }
  if (l === 'latex' || l === 'pdf') enterLatex();
  requestRender();
}

// ---- editing ----

function locate(id) {
  for (let si = 0; si < S.doc.sections.length; si++) {
    const pi = S.doc.sections[si].paragraphs.findIndex(p => p.id === id);
    if (pi >= 0) return [si, pi];
  }
  return null;
}
const paragraph = id => { const l = locate(id); return l ? S.doc.sections[l[0]].paragraphs[l[1]] : null; };
const section = id => S.doc.sections.find(s => s.id === id) || null;
const idea = id => S.doc.unplaced.find(i => i.id === id) || null;
const claimText = cid => { for (const s of S.doc.sections) for (const p of s.paragraphs) if (p.cid === cid) return p.claim; return ''; };

function setClaim(id, v) {
  change(() => {
    const p = paragraph(id), i = idea(id);
    if (p) p.claim = v;
    if (i) i.text = v;
  });
}

function endIslandDrag() {
  act(() => {
    const d = S.islandDrag, s = d && section(d.id);
    if (s) s.island = islandOrigin(s);
    S.islandDrag = null;
  });
}

/** Where a card dropped at height `y` goes: before an entry of the innermost subsection region it is dropped in (a card or a
 *  nested subsection), at the end of that region, or between the island's top-level entries. */
function slot(sid, y, excluding) {
  const s = section(sid);
  if (!s) return { kind: 'end' };
  const lay = layout(s), of = C.groupOf(s);
  const inside = lay.groups.filter(q => q.rect.y <= y && y <= q.rect.y + q.rect.h).sort((a, b) => b.depth - a.depth)[0];
  const container = inside ? inside.id : null;
  const entries = [];
  s.paragraphs.forEach((p, k) => {
    if (p.id === excluding) return;
    const gr = C.kind(p) === 'group' && lay.groups.find(q => q.id === p.id);
    if (gr && gr.parent === container) entries.push([p.id, midY(gr.rect)]);
    if (C.isCard(p) && of[k] === container && lay.cards.has(p.id)) entries.push([p.id, midY(lay.cards.get(p.id))]);
  });
  const e = entries.find(q => q[1] > y);
  if (e) return { kind: 'before', id: e[0], group: container };
  return container ? { kind: 'endOfGroup', group: container } : { kind: 'end' };
}

/** Insert `p` at a slot. Subsections that are open at that point and are not the target are closed first with an end
 *  marker of the right level (the one level below the target, or the bare `<!-- endgroup -->` for the section). */
function insert(p, sid, sl) {
  const s = section(sid);
  if (!s) return;
  let idx = s.paragraphs.length, want = null;
  if (sl.kind === 'before') { const k = s.paragraphs.findIndex(q => q.id === sl.id); if (k >= 0) idx = k; want = sl.group; }
  else if (sl.kind === 'endOfGroup') { idx = C.endOfGroup(s, sl.group) ?? s.paragraphs.length; want = sl.group; }
  const items = [p], open = C.openAt(s, idx);
  if (want === null) { if (open.length) items.unshift(C.newParagraph({ text: C.endGroup })); }
  else {
    const ti = open.findIndex(e => e.id === want);
    if (ti >= 0 && ti < open.length - 1) items.unshift(C.newParagraph({ text: C.endMarker(open[ti].level + 1) }));
  }
  s.paragraphs.splice(idx, 0, ...items);
  C.normalizeGroups(s);
  S.lastSection = sid;
}

/** A dragged card lands: into an island (at the drop height), onto water, or back where it was. */
function endCardDrag() {
  act(() => {
    const d = S.cardDrag, f = d && frames().get(d.id);
    S.cardDrag = null;
    if (!f) return;
    const c = { x: f.x + f.w / 2, y: midY(f) }, origin = { x: f.x, y: f.y };
    const loc = locate(d.id);
    if (loc && C.isBlock(S.doc.sections[loc[0]].paragraphs[loc[1]])) { S.doc.sections[loc[0]].paragraphs[loc[1]].pos = origin; return; }
    const target = findLast(S.doc.sections, s => contains(inset(islandRect(s), -10), c));
    // Decide the slot before removing the card, so the layout it is judged against does not shift.
    const sl = target ? slot(target.id, c.y, d.id) : null;
    const ii = S.doc.unplaced.findIndex(i => i.id === d.id);
    if (ii >= 0) {
      if (!target) { S.doc.unplaced[ii].pos = origin; return; }
      const it = S.doc.unplaced.splice(ii, 1)[0];
      insert(C.newParagraph({ id: it.id, claim: it.text, cid: it.cid }), target.id, sl);
      return;
    }
    if (!loc) return;
    const src = S.doc.sections[loc[0]];
    if (target) {
      const p = src.paragraphs.splice(loc[1], 1)[0];
      insert(p, target.id, sl);
      C.normalizeGroups(src);
    } else if (C.trimmed(src.paragraphs[loc[1]].text) === '') {
      const p = src.paragraphs.splice(loc[1], 1)[0];
      S.doc.unplaced.push(C.newIdea({ id: p.id, cid: p.cid, text: p.claim, pos: origin }));
      C.normalizeGroups(src);
      dropRefs([p.cid]);
    } else {
      setStatus('Claims with prose stay on an island');
    }
  });
}

function move(id, sid) {
  act(() => {
    const loc = locate(id);
    if (!loc || !section(sid)) return;
    const src = S.doc.sections[loc[0]];
    const p = src.paragraphs.splice(loc[1], 1)[0];
    p.autoPlace = false;
    C.normalizeGroups(src);
    insert(p, sid, { kind: 'end' });
  });
}

function addClaim(sid, y) {
  if (!section(sid)) return;
  act(() => {
    const p = C.newParagraph({ claim: 'New claim' });
    insert(p, sid, y == null ? { kind: 'end' } : slot(sid, y, p.id));
    C.assignIDs(S.doc);
    S.editing = p.id;
    S.lastSection = sid;
  });
}

function addIdea(w) {
  act(() => {
    const i = C.newIdea({ pos: { x: w.x - L.ideaW / 2, y: w.y - 20 } });
    S.doc.unplaced.push(i);
    C.assignIDs(S.doc);
    S.editing = i.id;
  });
}

const addEquation = w => addBlock('New equation', '$$ y = f(x) $$', w);

/** A new block goes into the last section until the first link with a claim moves it. */
function addBlock(claim, text, w) {
  const secs = S.doc.sections;
  if (!secs.length) { setStatus('Add a section first'); return; }
  act(() => {
    insert(C.newParagraph({ claim, pos: { x: w.x, y: w.y }, text, autoPlace: true }), secs[secs.length - 1].id, { kind: 'end' });
    C.assignIDs(S.doc);
  });
}

const imageURL = rel => host.imageURL(rel);

/** A figure that the shell has put into the vault: `rel` is its path relative to the document. */
function addFigureRef(r, w) { addBlock(`What ${r.name} shows`, `![${r.name}](${r.rel})`, w); }

function setTable(id, rows) {
  const p = paragraph(id);
  if (!p || !rows.length) return;
  const line = r => '| ' + r.map(c => (c === '' ? ' ' : C.oneLine(c).replaceAll('|', '/'))).join(' | ') + ' |';
  const ls = rows.map(line);
  ls.splice(1, 0, '|' + '---|'.repeat(rows[0].length));
  p.text = ls.join('\n');
}

/** Apply a structural table edit (add/delete row or column) as one undo step. */
function editTable(id, f) {
  const p = paragraph(id);
  if (!p) return;
  const rows = f(C.tableRows(p));
  act(() => setTable(id, rows));
}

function setCell(ref, v) {
  change(() => {
    const p = paragraph(ref.id);
    if (!p) return;
    let rows = C.tableRows(p);
    if (ref.r >= rows.length) return;
    const cols = Math.max(0, ...rows.map(r => r.length));
    rows = rows.map(r => r.concat(Array(Math.max(0, cols - r.length)).fill('')));
    rows[ref.r][ref.c] = v;
    setTable(ref.id, rows);
  });
}

function setEquation(id, v) {
  change(() => { const p = paragraph(id); if (p) p.text = '$$ ' + C.oneLine(v) + ' $$'; });
}

/** Create a palette object at a map-local point. */
async function create(t, local) {
  const w = toWorld(local);
  if (t === 'section') addSection(w);
  else if (t === 'subsection') {
    const s = findLast(S.doc.sections, q => contains(islandRect(q), w));
    if (s) addSubsection(s.id, w.y); else setStatus('Drop a subsection onto an island');
  } else if (t === 'claim') {
    const s = findLast(S.doc.sections, q => contains(islandRect(q), w));
    if (s) addClaim(s.id, w.y); else addIdea(w);
  } else if (t === 'table') addBlock('', '|   |   |\n|---|---|\n|   |   |\n|   |   |', w);
  else if (t === 'figure') {
    try {
      const r = await host.pickImage();
      if (r) addFigureRef(r, w);
    } catch { setStatus('Could not add the image'); }
  }
}

function deleteOne(id) { S.selection = new Set([id]); deleteSelection(); }

// ---- selection ----

function select(id, shift) {
  if (shift) { if (S.selection.has(id)) S.selection.delete(id); else S.selection.add(id); }
  else S.selection = new Set([id]);
}

function selectAll() {
  S.selection = new Set([
    ...S.doc.sections.flatMap(s => [s.id, ...s.paragraphs.filter(p => !C.isMarker(p)).map(p => p.id)]),
    ...S.doc.unplaced.map(i => i.id),
  ]);
}

// ---- groups ----

/** The island index and paragraph indices of the selection, if it is 2+ claim cards of one island. */
function groupableSelection() {
  if (S.selection.size < 2) return null;
  const locs = [...S.selection].map(locate);
  if (locs.some(l => !l)) return null;
  const si = locs[0][0];
  if (!locs.every(l => l[0] === si && C.isCard(S.doc.sections[si].paragraphs[l[1]]))) return null;
  return [si, locs.map(l => l[1]).sort((a, b) => a - b)];
}
const canGroup = () => groupableSelection() !== null;

/** Ctrl+G: a new subsection at the first selected card, holding the selected cards in order. Inside a subsection it nests
 *  one level deeper (down to LaTeX's \subparagraph, level 5). */
function groupSelection() {
  const g = groupableSelection();
  if (!g) {
    if (S.selection.size) setStatus('Select two or more claims of one island to group them');
    return;
  }
  const [si, idxs] = g;
  const s0 = S.doc.sections[si], open = C.openAt(s0, idxs[0]), lvl = (open.length ? open[open.length - 1].level : 1) + 1;
  if (lvl > C.MAX_LEVEL) { setStatus('LaTeX has no deeper level than \\subparagraph'); return; }
  act(() => {
    const s = S.doc.sections[si], first = idxs[0];
    const moved = idxs.map(k => s.paragraphs[k]);
    for (const k of idxs.slice().reverse()) s.paragraphs.splice(k, 1);
    const heading = C.newParagraph({ text: '#'.repeat(lvl) + ' Untitled group' });
    // An end marker keeps what followed the first selected card out of the new subsection.
    s.paragraphs.splice(first, 0, heading, ...moved, C.newParagraph({ text: C.endMarker(lvl) }));
    C.normalizeGroups(s);
    S.editingGroup = heading.id;
    S.lastSection = s.id;
  });
}

/** Expand a claim into a subsection: the claim becomes the heading (its text the title; its id and links stay with it),
 *  and its prose, if any, the first paragraph inside. At section level this makes a `##` subsection. */
function expandClaim(id) {
  const loc = locate(id);
  if (!loc) return;
  const s0 = S.doc.sections[loc[0]], p0 = s0.paragraphs[loc[1]];
  if (!C.isCard(p0)) return;
  const open = C.openAt(s0, loc[1]), lvl = (open.length ? open[open.length - 1].level : 1) + 1;
  if (lvl > C.MAX_LEVEL) { setStatus('LaTeX has no deeper level than \\subparagraph'); return; }
  act(() => {
    C.assignIDs(S.doc);
    const s = S.doc.sections[loc[0]], k = s.paragraphs.findIndex(q => q.id === id), p = s.paragraphs[k];
    const head = C.newParagraph({ text: '#'.repeat(lvl) + ' ' + C.oneLine(C.trimmed(p.claim) || 'Untitled'), cid: p.cid, needs: p.needs, claim: '' });
    const inner = C.trimmed(p.text) !== '' ? C.newParagraph({ text: p.text }) : C.newParagraph({ claim: 'New claim' });
    s.paragraphs.splice(k, 1, head, inner, C.newParagraph({ text: C.endMarker(lvl) }));
    C.normalizeGroups(s);
    S.selection = new Set();
    if (C.trimmed(p.text) === '') S.editing = inner.id;
    S.lastSection = s.id;
  });
}

/** Remove a subsection heading: what is in it stays, one level up (its own subsections move up too). The claim the
 *  heading came from is gone with it, and so are the links to that claim. */
function removeGroup(gid) {
  const loc = locate(gid);
  if (!loc) return;
  const s = S.doc.sections[loc[0]], pi = loc[1], head = s.paragraphs[pi];
  if (C.kind(head) !== 'group') return;
  const lvl = C.level(head), end = C.endOfGroup(s, gid);
  // what is nested in it moves up a level
  for (const q of s.paragraphs.slice(pi + 1, end)) if (C.isMarker(q)) C.withLevel(q, C.level(q) - 1);
  // the end marker that closed exactly this subsection has nothing to close any more
  const closing = s.paragraphs[end];
  if (closing && C.kind(closing) === 'groupEnd' && C.level(closing) === lvl) s.paragraphs.splice(end, 1);
  // without a heading what follows would join a subsection that is still open at this point: an end marker stops that
  if (C.openAt(s, pi).some(e => e.level >= lvl)) s.paragraphs[pi] = C.newParagraph({ text: C.endMarker(lvl) }); else s.paragraphs.splice(pi, 1);
  C.normalizeGroups(s);
  if (head.cid) dropRefs([head.cid]);
  if (S.editingGroup === gid) S.editingGroup = null;
}
/** Remove a subsection heading; its cards stay where they are, one level up. */
const ungroup = gid => act(() => removeGroup(gid));

/** Delete a subsection with everything in it (after asking, when it holds prose). */
function deleteSubsection(gid) {
  const loc = locate(gid);
  if (!loc) return;
  const s = S.doc.sections[loc[0]], i = loc[1], e = C.subtreeEnd(s, gid);
  const gone = s.paragraphs.slice(i, e);
  const prose = gone.filter(q => C.isCard(q) && C.trimmed(q.text) !== '').length;
  if (prose && !win().confirm(`Delete this subsection with ${gone.filter(C.isCard).length} claims, ${prose} of them with prose?`)) return;
  act(() => {
    s.paragraphs.splice(i, e - i);
    C.normalizeGroups(s);
    dropRefs(gone.map(q => q.cid));
  });
}

/** Ctrl+Shift+G: remove the innermost subsection that holds each selected card. */
function ungroupSelection() {
  const gids = [];
  for (const s of S.doc.sections) {
    const of = C.groupOf(s);
    s.paragraphs.forEach((p, k) => {
      // a selected subsection itself, or the innermost one that holds a selected card
      const g = S.selection.has(p.id) && C.kind(p) === 'group' ? p.id : S.selection.has(p.id) ? of[k] : null;
      if (g && !gids.includes(g)) gids.push(g);
    });
  }
  act(() => gids.forEach(removeGroup));
}

function renameGroup(gid, name) {
  const p = paragraph(gid);
  if (!p || C.groupName(p) === name) return;
  act(() => C.setGroupName(p, name));
}

/** Everything whose map rect intersects a world rect. */
function objectsIn(r) {
  const out = S.doc.sections.filter(s => intersects(islandRect(s), r)).map(s => s.id);
  for (const [id, f] of frames()) { const hp = paragraph(id); if (intersects(f, r) && !(hp && C.kind(hp) === 'group')) out.push(id); }
  return out;
}

/** Delete the selection; a section takes its claims with it, links touching removed claims go too. */
function deleteSelection() {
  if (!S.selection.size) return;
  // a selected subsection goes with everything in it (as a selected island does)
  const sel = new Set(S.selection);
  let prose = 0, claims = 0;
  for (const s of S.doc.sections) {
    if (sel.has(s.id)) continue;
    for (const p of [...s.paragraphs]) {
      if (!S.selection.has(p.id) || C.kind(p) !== 'group') continue;
      for (const q of s.paragraphs.slice(s.paragraphs.indexOf(p), C.subtreeEnd(s, p.id) ?? s.paragraphs.length)) {
        if (!sel.has(q.id) && C.isCard(q)) { claims++; if (C.trimmed(q.text) !== '') prose++; }
        sel.add(q.id);
      }
    }
  }
  if (prose && !win().confirm(`Delete this subsection with ${claims} claims, ${prose} of them with prose?`)) return;
  act(() => {
    const gone = new Set();
    for (const s of S.doc.sections) if (sel.has(s.id)) { s.paragraphs.forEach(p => gone.add(p.cid)); gone.add(s.sid); }
    S.doc.sections = S.doc.sections.filter(s => !sel.has(s.id));
    for (const s of S.doc.sections) {
      for (const p of s.paragraphs) if (sel.has(p.id)) gone.add(p.cid);
      s.paragraphs = s.paragraphs.filter(p => !sel.has(p.id));
      C.normalizeGroups(s);
    }
    S.doc.unplaced = S.doc.unplaced.filter(i => !sel.has(i.id));
    dropRefs([...gone]);
  });
  S.selection = new Set();
}

/** Remove `needs` and note links that point at ids that are gone. */
function dropRefs(list) {
  const gone = new Set(list.filter(Boolean));
  for (const s of S.doc.sections) for (const p of s.paragraphs) {
    if (p.needs.some(n => gone.has(n))) p.needs = p.needs.filter(n => !gone.has(n));
  }
  for (const i of S.doc.unplaced) if (gone.has(i.to)) i.to = '';
}

/** Islands, blocks and ideas in the selection move; claims move only with their island. */
function endGroupDrag() {
  const g = S.groupDrag;
  if (!g) return;
  act(() => {
    const add = p => (p ? { x: p.x + g.w, y: p.y + g.h } : p);
    for (const s of S.doc.sections) {
      if (S.selection.has(s.id)) s.island = add(s.island);
      for (const p of s.paragraphs) if (C.isBlock(p) && S.selection.has(p.id)) p.pos = add(p.pos);
    }
    for (const i of S.doc.unplaced) if (S.selection.has(i.id)) i.pos = add(i.pos);
    S.groupDrag = null;
  });
}

function endResize() {
  const d = S.resizeDrag;
  if (!d) return;
  act(() => {
    const p = paragraph(d.id);
    if (p) p.w = Math.round(blockWidth(p));
    S.resizeDrag = null;
  });
}

// ---- links ----

/** `to` now needs `from`. A new block follows the first placed claim or block linked to it into
 *  its section. From a note, `to` is the claim, block or section (island) the note points at. */
function addLink(from, to) {
  const note = idea(from);
  if (note) {
    act(() => {
      C.assignIDs(S.doc);
      const target = paragraph(to)?.cid || section(to)?.sid || '';
      if (target) note.to = target;
    });
    return;
  }
  act(() => {
    C.assignIDs(S.doc);
    const src = paragraph(from), dst = paragraph(to);
    if (from === to || !src || !dst) return;
    if (!dst.needs.includes(src.cid)) dst.needs.push(src.cid);
    const fs = S.doc.sections[locate(from)[0]].id, ts = S.doc.sections[locate(to)[0]].id;
    // A block still waiting for its first link has no section of its own to share.
    if (src.autoPlace && !dst.autoPlace) move(from, ts);
    if (dst.autoPlace && !src.autoPlace) move(to, fs);
  });
}

function removeNoteLink(id) { const n = idea(id); if (n) act(() => { n.to = ''; }); }
function removeNeed(cid, id) { const p = paragraph(id); if (p) act(() => { p.needs = p.needs.filter(n => n !== cid); }); }
function removeLink(k) {
  const src = paragraph(k.src);
  if (src) removeNeed(src.cid, k.dst); else removeNoteLink(k.src);
  S.selectedLink = null;
}

/** Every drawable dependency link, colored by the source island. */
function links() {
  const byCid = new Map();
  let order = 0;
  S.doc.sections.forEach((s, i) => {
    for (const p of s.paragraphs) if (p.cid) byCid.set(p.cid, { id: p.id, order: order++, hue: C.isBlock(p) ? BLOCK_HUE : hue(i) });
  });
  const r = [];
  for (const s of S.doc.sections) for (const p of s.paragraphs) for (const n of p.needs) {
    const src = byCid.get(n), dst = byCid.get(p.cid);
    if (!src || !dst || src.id === p.id) continue;
    r.push({ src: src.id, dst: p.id, hue: src.hue, backwards: src.order > dst.order, note: false });
  }
  // Note links run from the note to its claim, block or island, in a thin neutral line.
  const sids = new Map();
  for (const s of S.doc.sections) if (!sids.has(s.sid)) sids.set(s.sid, s.id);
  for (const n of S.doc.unplaced) {
    if (!n.to) continue;
    const dst = byCid.get(n.to)?.id ?? sids.get(n.to);
    if (dst) r.push({ src: n.id, dst, hue: NOTE_HUE, backwards: false, note: true });
  }
  return r;
}

/** World frame of a link end: a card, block or note, or a whole island (a note linked to a section). */
function endFrame(id, fr) {
  if (fr.has(id)) return fr.get(id);
  const s = section(id);
  return s ? islandRect(s) : null;
}

/** The card under a world point. */
function cardAt(w) {
  for (const [id, f] of frames()) if (contains(f, w)) return id;
  return null;
}

/** Bezier control points of the noodle from card `a` to card `b`: leave toward the
 *  target's side; cards in one column loop out to the right. */
function noodleControls(a, b, g) {
  const aMax = a.x + a.w, bMax = b.x + b.w;
  if (b.x > aMax + 20) {
    const p0 = { x: aMax + g, y: midY(a) }, p3 = { x: b.x - g, y: midY(b) };
    const dx = Math.max(50, (p3.x - p0.x) * 0.5);
    return [p0, { x: p0.x + dx, y: p0.y }, { x: p3.x - dx, y: p3.y }, p3];
  } else if (bMax < a.x - 20) {
    const p0 = { x: a.x - g, y: midY(a) }, p3 = { x: bMax + g, y: midY(b) };
    const dx = Math.max(50, (p0.x - p3.x) * 0.5);
    return [p0, { x: p0.x - dx, y: p0.y }, { x: p3.x + dx, y: p3.y }, p3];
  }
  const p0 = { x: aMax + g, y: midY(a) }, p3 = { x: bMax + g, y: midY(b) };
  const x = Math.max(p0.x, p3.x) + 45 + Math.abs(p3.y - p0.y) * 0.3;
  return [p0, { x, y: p0.y }, { x, y: p3.y }, p3];
}

/** Enter on the empty last line of a paragraph: start a new paragraph after it. */
function splitParagraph(id) {
  const loc = locate(id);
  if (!loc) return;
  act(() => {
    const p = C.newParagraph();
    S.doc.sections[loc[0]].paragraphs.splice(loc[1] + 1, 0, p);
    S.focusParagraph = p.id;
  });
}

// ---- sections ----

/** A new, empty subsection at a slot of an island (`y`: the drop height, else the end of the island). One level below the
 *  subsection it lands in; its name is in edit mode. */
function addSubsection(sid, y, group) {
  const s = section(sid);
  if (!s) return;
  const sl = group ? { kind: 'endOfGroup', group } : y == null ? { kind: 'end' } : slot(sid, y, null);
  const into = sl.kind === 'end' ? null : sl.group, parent = into ? paragraph(into) : null;
  const lvl = (parent ? C.level(parent) : 1) + 1;
  if (lvl > C.MAX_LEVEL) { setStatus('LaTeX has no deeper level than \\subparagraph'); return; }
  act(() => {
    const heading = C.newParagraph({ text: '#'.repeat(lvl) + ' Untitled subsection' });
    insert(heading, sid, sl);
    const k = s.paragraphs.findIndex(q => q.id === heading.id);
    s.paragraphs.splice(k + 1, 0, C.newParagraph({ text: C.endMarker(lvl) }));   // what follows stays outside of it
    C.normalizeGroups(s);
    S.editingGroup = heading.id;
    S.lastSection = sid;
  });
}

/** A new claim at the end of subsection `gid`. */
function addClaimIn(sid, gid) {
  if (!section(sid)) return;
  act(() => {
    const p = C.newParagraph({ claim: 'New claim' });
    insert(p, sid, { kind: 'endOfGroup', group: gid });
    C.assignIDs(S.doc);
    S.editing = p.id;
    S.lastSection = sid;
  });
}

/** Prose: a new claim with its paragraph, after paragraph `afterId` or at the end of the section. The claim field has the focus. */
function addProseClaim(sid, afterId) {
  const s = section(sid);
  if (!s) return;
  act(() => {
    const p = C.newParagraph(), k = afterId ? s.paragraphs.findIndex(q => q.id === afterId) : -1;
    if (k < 0 || k + 1 >= s.paragraphs.length) insert(p, sid, { kind: 'end' });
    else insert(p, sid, { kind: 'before', id: s.paragraphs[k + 1].id, group: C.groupOf(s)[k] });
    S.focusClaim = p.id;
    S.lastSection = sid;
  });
}

/** Prose: a new section after the last one. Its title has the focus. */
function addProseSection() {
  act(() => {
    const s = C.newSection('Untitled', null);
    S.doc.sections.push(s);
    autoLayout();
    S.focusSection = s.id;
    S.lastSection = s.id;
  });
}

function addSection(w) {
  act(() => {
    const s = C.newSection('Untitled', { x: w.x - L.islandW / 2, y: w.y - 20 });
    S.doc.sections.push(s);
    S.editingTitle = s.id;
    S.lastSection = s.id;
  });
}

function rename(sid, title) {
  const s = section(sid);
  if (!s || s.title === title) return;
  act(() => { s.title = title; });
}


// ======================================================================================
// UI
// ======================================================================================

/** Pointer drag with a movement threshold. The innermost element that starts a drag wins. */
function drag(el, o) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || (o.filter && !o.filter(e))) return;
    e.stopPropagation();
    if (o.down) o.down(e);
    const x0 = e.clientX, y0 = e.clientY, thr = o.threshold ?? 3, tgt = e.target, W = win();
    let moved = false;
    const mv = ev => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved) { if (Math.hypot(dx, dy) <= thr) return; moved = true; }
      if (o.move) o.move(ev, dx, dy);
    };
    const up = ev => {
      W.removeEventListener('pointermove', mv);
      W.removeEventListener('pointerup', up);
      W.removeEventListener('pointercancel', up);
      if (moved) { if (o.end) o.end(ev); } else if (ev.type === 'pointerup' && o.click) o.click(ev, tgt);
    };
    W.addEventListener('pointermove', mv);
    W.addEventListener('pointerup', up);
    W.addEventListener('pointercancel', up);
  });
}

let lastTap = { key: '', t: 0 };
function isDoubleTap(key) {
  const now = Date.now(), dbl = lastTap.key === key && now - lastTap.t < 450;
  lastTap = dbl ? { key: '', t: 0 } : { key, t: now };
  return dbl;
}

const FIELD_SIZING = win().CSS.supports('field-sizing', 'content');
function autosize(ta) {
  if (FIELD_SIZING || ta.tagName !== 'TEXTAREA') return;
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}
const autosizeAll = () => shadow.querySelectorAll('textarea').forEach(autosize);


// ---- rendering ----

let renderQueued = false, rendering = false;
function requestRender() {
  if (renderQueued || destroyed) return;
  renderQueued = true;
  queueMicrotask(() => { renderQueued = false; if (!destroyed) render(); });
}

function render() {
  const a = shadow.activeElement;
  const saved = a && a.dataset && a.dataset.key ? { key: a.dataset.key, s: a.selectionStart, e: a.selectionEnd } : null;
  rendering = true;
  try {
    renderToolbar();
    renderOverlay();
    const main = shadow.getElementById('main');
    if (S.level === 'map') renderMap(main);
    else if (S.level === 'latex') renderLatex(main);
    else if (S.level === 'pdf') renderPdf(main);
    else renderProse(main);
  } finally {
    rendering = false;
  }
  autosizeAll();
  if (S.level === 'map') layoutMap();
  // Keyboard focus follows the editing state. A field that survives a redraw keeps its caret.
  const f = shadow.querySelector('[data-autofocus]');
  if (f) {
    f.focus({ preventScroll: S.level === 'map' });
    try {
      if (saved && saved.key === f.dataset.key) f.setSelectionRange(saved.s, saved.e);
      else if (f.dataset.autofocus === 'end') f.setSelectionRange(f.value.length, f.value.length);
      else f.select();
    } catch {}
  } else if (saved && shadow.activeElement !== a) {
    const n = shadow.querySelector(`[data-key="${CSS.escape(saved.key)}"]`);
    if (n) { n.focus({ preventScroll: true }); try { n.setSelectionRange(saved.s, saved.e); } catch {} }
  }
  S.focusParagraph = null; S.focusClaim = null; S.focusSection = null;
  S.fade = false;
}

function renderStatus() {
  shadow.querySelectorAll('.status-text').forEach(el => { el.textContent = S.status; });
}

function zoomKey(f) { if (S.level === 'map') { zoomBy(f); layoutMap(); } }
function fitKey() { if (S.level === 'map') { fitAll(); layoutMap(); } }

// ---- menus ----

let openMenus = [];
function closeMenu(level = 0) {
  while (openMenus.length > level) openMenus.pop().remove();
}

/** A menu at a screen point. Items: {label, action, key, disabled, danger, submenu}, {sep}, {header}. */
function showMenu(x, y, items, level = 0, anchor = null) {
  closeMenu(level);
  const rr = rootEl.getBoundingClientRect();
  const m = h('div', { class: 'menu' });
  for (const it of items) {
    if (it.sep) { m.append(h('div', { class: 'sep' })); continue; }
    if (it.header != null) { m.append(h('div', { class: 'header' }, it.header)); continue; }
    if (it.node) { m.append(it.node); continue; }   // a row of its own controls; clicks in it keep the menu open
    const el = h('div', { class: 'item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '') },
      h('span', { class: 'label' }, it.label), (it.submenu || it.key) && h('span', { class: 'key' }, it.submenu ? '▸' : it.key));
    el.addEventListener('mouseenter', () => {
      m.querySelectorAll('.item.open').forEach(o => o.classList.remove('open'));
      if (it.submenu && !it.disabled) {
        const r = el.getBoundingClientRect();
        el.classList.add('open');
        showMenu(r.right - 2, r.top - 6, it.submenu, level + 1, r);
      } else closeMenu(level + 1);
    });
    el.addEventListener('click', () => {
      if (it.disabled || it.submenu || !it.action) return;
      closeMenu();
      it.action();
    });
    m.append(el);
  }
  m.addEventListener('mousedown', e => e.preventDefault());   // keeps the focus where it is
  m.addEventListener('contextmenu', e => e.preventDefault());
  rootEl.append(m);
  const w = m.offsetWidth, ht = m.offsetHeight;
  if (x - rr.left + w > rr.width - 4) x = anchor ? Math.max(rr.left + 4, anchor.left - w + 2) : Math.max(rr.left + 4, rr.right - w - 4);
  if (y - rr.top + ht > rr.height - 4) y = Math.max(rr.top + 4, rr.bottom - ht - 4);
  m.style.left = (x - rr.left) + 'px';
  m.style.top = (y - rr.top) + 'px';
  openMenus.push(m);
}

// ---- toolbar ----

function renderToolbar() {
  const center = h('div', { class: 'seg' });
  for (const [l, name] of [['map', 'Map'], ['prose', 'Prose'], ['latex', 'LaTeX'], ['pdf', 'PDF']]) {
    center.append(h('button', { class: S.level === l ? 'on' : '', onclick: () => setLevelInternal(l) }, name));
  }
  const right = h('div', { class: 'right' }, h('span', { class: 'status status-text' }, S.status));
  if (S.level === 'map') right.append(h('button', { class: 'tb', title: 'Fit all', onclick: fitKey }, icon(ICONS.fit)));
  shadow.getElementById('toolbar').replaceChildren(h('div', { class: 'left' }), center, right);
}

// ---- conflicts between this document and changes made elsewhere ----

/** A line of the document for the conflict dialog: comment brackets gone, the id and link fields dimmed. */
function conflictLine(l) {
  const m = l.match(/^\s*<!--\s*claim:\s*(.*?)(?:\s\|\s((?:id|needs|pos|w)=[^|]*?))?\s*-->\s*$/);
  if (m) return h('div', { class: 'cl' }, m[1] || '(no claim text)', m[2] && h('span', { class: 'meta' }, '  ' + m[2]));
  const c = l.match(/^\s*<!--\s*(.*?)\s*-->\s*$/);
  return h('div', { class: 'cl' }, c ? c[1] : l || '\u00a0');
}

function renderOverlay() {
  const el = shadow.getElementById('overlay');
  if (!S.conflict) { el.hidden = true; el.replaceChildren(); return; }
  el.replaceChildren(conflictCard(S.conflict));
  el.hidden = false;
}

function conflictCard(c) {
  const conflicts = c.segments.filter(s => s.type === 'conflict'), chosen = conflicts.filter(s => s.choice).length;
  const card = h('div', { class: 'ov-card wide' }, h('h2', {}, 'Changed in two places'),
    h('div', { class: 'p-text faint' }, 'The file was changed elsewhere, on lines you changed here too. Choose what to keep.'));
  const choose = (s, v) => { s.choice = v; renderOverlay(); };
  const pick = (s, v, label) => h('button', { class: 'p-seg' + (s.choice === v ? ' on' : ''), onclick: () => choose(s, v) }, label);
  for (const s of conflicts) {
    const where = [s.heading, s.claim].filter(Boolean).join(' › ');
    const col = (v, label, ls) => {
      const d = h('div', { class: 'cf-col' + (s.choice === v || s.choice === 'both' ? ' on' : '') },
        h('div', { class: 'cf-label' }, label), h('div', { class: 'cf-lines' }, ls.length ? ls.map(conflictLine) : h('div', { class: 'cl meta' }, '(nothing)')));
      d.addEventListener('click', () => choose(s, v));
      return d;
    };
    card.append(h('div', { class: 'cf' }, where && h('div', { class: 'cf-ctx' }, where),
      h('div', { class: 'cf-cols' }, col('ours', 'Mine', s.ours), col('theirs', 'Theirs', s.theirs)),
      h('div', { class: 'p-segs' }, pick(s, 'ours', 'Mine'), pick(s, 'theirs', 'Theirs'), pick(s, 'both', 'Both'))));
  }
  card.append(h('div', { class: 'ov-foot' },
    h('div', { class: 'p-row' }, h('button', { class: 'p-btn', onclick: () => chooseAll('ours') }, 'All mine'),
      h('button', { class: 'p-btn', onclick: () => chooseAll('theirs') }, 'All theirs')),
    h('span', { class: 'faint' }, `${chosen} of ${conflicts.length} chosen`),
    h('button', { class: 'p-btn primary', disabled: chosen < conflicts.length, onclick: resolveConflicts }, 'Apply')));
  return card;
}

// ---- map ----

let mapEl = null, worldA, worldB, noodleSvg, ghostEl, marqueeEl, stripEl, resizeObs = null;
const cardEls = new Map(), islandEls = new Map(), regionEls = new Map();

const local = e => { const r = mapEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

function mini(kind) {
  if (kind === 'section') return h('div', { class: 'mini section' }, h('i'), h('i'), h('i'));
  if (kind === 'claim') return h('div', { class: 'mini claim' }, h('i'));
  if (kind === 'subsection') return h('div', { class: 'mini subsection' }, h('i'));
  return h('div', { class: 'mini ' + kind }, icon(ICONS[kind], 14));
}

function buildStrip() {
  stripEl = h('div', { class: 'strip' });
  for (const t of ['section', 'subsection', 'claim', 'figure', 'table']) {
    const name = t[0].toUpperCase() + t.slice(1);
    const b = h('div', { class: 'tpl', title: t === 'figure' || t === 'table' ? `${name}: drag onto the map, or click to add at the center` : `${name}: drag onto the map` }, icon(ICONS[t]));
    drag(b, {
      threshold: 4,
      move: ev => { S.templateDrag = { kind: t, x: ev.clientX, y: ev.clientY }; layoutMap(); },
      end: ev => {
        S.templateDrag = null;
        const p = local(ev), sr = stripEl.getBoundingClientRect();
        const overStrip = ev.clientX >= sr.left && ev.clientX <= sr.right && ev.clientY >= sr.top && ev.clientY <= sr.bottom;
        if (!overStrip && p.x >= 0 && p.y >= 0 && p.x <= S.viewport.w && p.y <= S.viewport.h) create(t, p);
        layoutMap();
      },
      click: () => { if (t === 'figure' || t === 'table') create(t, { x: S.viewport.w / 2, y: S.viewport.h / 2 }); },
    });
    stripEl.append(b);
  }
  stripEl.addEventListener('pointerdown', e => e.stopPropagation());
  stripEl.addEventListener('dblclick', e => e.stopPropagation());
  return stripEl;
}

function buildMap(main) {
  worldA = h('div', { class: 'world' });
  worldB = h('div', { class: 'world' });
  noodleSvg = sv('svg', { id: 'noodles' });
  ghostEl = h('div', { class: 'ghost', style: { display: 'none' } });
  marqueeEl = h('div', { class: 'marquee', style: { display: 'none' } });
  mapEl = h('div', { id: 'map', class: S.fade ? 'fade' : '' }, worldA, noodleSvg, worldB, buildStrip(), ghostEl, marqueeEl);

  // Scroll pans, pinch or Ctrl+scroll zooms around the pointer.
  mapEl.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.target.closest('.strip')) return;
    const k = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) {
      const dy = Math.max(-25, Math.min(25, e.deltaY * k));   // a mouse wheel notch is far larger than a pinch step
      zoomBy(Math.exp(-dy * 0.01), local(e));
    } else {
      S.pan = { x: S.pan.x - e.deltaX * k, y: S.pan.y - e.deltaY * k };
    }
    layoutMap();
  }, { passive: false });

  // Runs before any card or island handler: a click that is not on a card ends link mode
  // (a note in link mode can point at a whole island) and deselects the selected noodle.
  mapEl.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.strip')) return;
    const onHit = e.target.classList && e.target.classList.contains('hit');
    if (S.selectedLink && !onHit) { S.selectedLink = null; layoutMap(); }
    if (S.linkingFrom && !e.target.closest('.card')) {
      const from = S.linkingFrom;
      S.linkingFrom = null; S.linkPointer = null;
      if (!onHit) {
        const w = toWorld(local(e));
        const s = findLast(S.doc.sections, q => contains(islandRect(q), w));
        if (s) addLink(from, s.id);
        e.stopPropagation();
      }
      layoutMap();
    }
  }, true);

  // Water: a drag pans, Shift+drag draws a marquee, a click clears the selection.
  let panStart = null, marqueeStart = null;
  drag(mapEl, {
    threshold: 2,
    filter: e => e.target === mapEl,
    down: e => { if (!e.shiftKey && S.selection.size) { S.selection = new Set(); layoutMap(); } panStart = null; marqueeStart = e.shiftKey ? local(e) : null; },
    move: (ev, dx, dy) => {
      if (marqueeStart) {
        const p = local(ev), m = marqueeStart;
        S.marquee = rect(Math.min(m.x, p.x), Math.min(m.y, p.y), Math.abs(p.x - m.x), Math.abs(p.y - m.y));
      } else {
        if (!panStart) panStart = { x: S.pan.x, y: S.pan.y };
        S.pan = { x: panStart.x + dx, y: panStart.y + dy };
      }
      layoutMap();
    },
    end: () => {
      if (S.marquee) {
        const r = S.marquee, a = toWorld({ x: r.x, y: r.y }), b = toWorld({ x: r.x + r.w, y: r.y + r.h });
        for (const id of objectsIn(rect(a.x, a.y, b.x - a.x, b.y - a.y))) S.selection.add(id);
      }
      S.marquee = null; marqueeStart = null; panStart = null;
      layoutMap();
    },
  });

  mapEl.addEventListener('dblclick', e => {
    if (e.target !== mapEl) return;
    const w = toWorld(local(e));
    if (e.altKey) addSection(w); else addIdea(w);
  });

  mapEl.addEventListener('contextmenu', e => {
    if (isTextTarget(e.target)) return;
    e.preventDefault();
    if (e.target !== mapEl) return;
    const w = toWorld(local(e));
    showMenu(e.clientX, e.clientY, [
      { label: 'New Section Here', action: () => addSection(w) },
      { label: 'New Idea Here', action: () => addIdea(w) },
      { label: 'New Equation Here', action: () => addEquation(w) },
    ]);
  });

  mapEl.addEventListener('pointermove', e => {
    S.pointerWorld = toWorld(local(e));
    if (S.linkingFrom) { S.linkPointer = toWorld(local(e)); layoutMap(); }
  });

  // Image files dropped from the file manager become figures.
  mapEl.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  mapEl.addEventListener('drop', e => {
    e.preventDefault();
    const w = toWorld(local(e));
    const files = [...e.dataTransfer.files].filter(f => ['png', 'jpg', 'jpeg', 'gif', 'tiff', 'tif', 'svg', 'webp', 'bmp'].includes(ext(f.name)));
    if (files.length) host.importImages(files).then(rs => rs.forEach((r, k) => addFigureRef(r, { x: w.x + k * 30, y: w.y + k * 30 })))
      .catch(() => setStatus('Could not add the image'));
  });

  main.replaceChildren(mapEl);
  if (resizeObs) resizeObs.disconnect();
  resizeObs = new (win().ResizeObserver)(() => { if (mapEl && mapEl.isConnected && !rendering && !destroyed) layoutMap(); });
  resizeObs.observe(mapEl);
}

// ---- the switch of a block: in the paper or not ----

let mapPlan = null;   // what the paper shows (core.js `plan`), made at every render of the Map

/** The id the front matter keeps a block under: the island's `s…`, or the free-floating block's `c…`. */
function switchId(id, create) {
  if (create) C.assignIDs(S.doc);   // an island or block that has no id yet gets one, to be kept under
  const s = section(id);
  if (s) return s.sid;
  const p = paragraph(id);
  return p ? p.cid : '';
}
const isOn = id => { const k = switchId(id); return !k || !C.inactiveIds(S.doc).has(k); };

/** Put an island or a free-floating block into the paper, or leave it out (Prose and LaTeX do not show it). */
function setOn(id, on) {
  act(() => {
    const k = switchId(id, true);
    if (!k) return;
    const off = C.inactiveIds(S.doc);
    if (on) off.delete(k); else off.add(k);
    // only ids that are there still
    const live = new Set([...S.doc.sections.flatMap(s => [s.sid, ...s.paragraphs.map(p => p.cid)])]);
    Latex.setFront(S.doc, 'inactive', [...off].filter(x => live.has(x)).join(', '));
  });
}

/** The switch of an island or block. */
function switchEl(id) {
  const on = isOn(id);
  const b = h('button', { class: 'bsw' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on),
    title: on ? 'In the paper. Click to leave it out of Prose and LaTeX (claims that a claim in the paper needs stay, below it).' : 'Not in the paper. Click to put it back.' }, h('i'));
  b.addEventListener('click', e => { e.stopPropagation(); setOn(id, !isOn(id)); });
  b.addEventListener('dblclick', e => e.stopPropagation());
  return b;
}

function renderMap(main) {
  mapPlan = C.plan(S.doc);
  if (!mapEl || !mapEl.isConnected) buildMap(main);
  cardEls.clear(); islandEls.clear(); regionEls.clear();
  worldA.replaceChildren(...S.doc.sections.map((s, i) => islandEl(s, i)));
  const cards = [];
  S.doc.sections.forEach((s, i) => {
    for (const p of s.paragraphs) if (!C.isMarker(p)) cards.push(cardEl(p.id, p.claim, C.isBlock(p) ? BLOCK_HUE : hue(i), p));
  });
  for (const it of S.doc.unplaced) cards.push(cardEl(it.id, it.text, IDEA_HUE, null));
  worldB.replaceChildren(...cards);
}

function islandEl(s, i) {
  const id = s.id;
  const el = h('div', { class: 'island', data: { id }, style: { '--hue': hue(i) } });
  const head = h('div', { class: 'head' });
  if (S.editingTitle === id) {
    const inp = h('input', { value: s.title, placeholder: 'Section title', data: { key: 'title:' + id, autofocus: '' } });
    const commit = () => {
      if (S.editingTitle !== id) return;
      S.editingTitle = null;
      rename(id, C.trimmed(inp.value) || 'Untitled');
      requestRender();
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); S.editingTitle = null; requestRender(); }
    });
    inp.addEventListener('blur', () => { if (!rendering) commit(); });
    head.append(inp);
  } else {
    head.append(h('div', { class: 'title', title: 'Double-click to rename' }, s.title || 'Untitled'));
  }
  head.append(switchEl(id));
  if (mapPlan && mapPlan.secOff.has(id)) el.classList.add('off');
  el.append(head);
  for (const p of s.paragraphs) {
    if (C.kind(p) !== 'group') continue;
    const gid = p.id, region = h('div', { class: 'region', style: { '--level': C.level(p) } });
    if (S.editingGroup === gid) {
      const inp = h('input', { value: C.groupName(p), placeholder: 'Group name', data: { key: 'group:' + gid, autofocus: '' } });
      const commit = () => {
        if (S.editingGroup !== gid) return;
        S.editingGroup = null;
        renameGroup(gid, C.trimmed(inp.value) || 'Untitled group');
        requestRender();
      };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); S.editingGroup = null; requestRender(); }
      });
      inp.addEventListener('blur', () => { if (!rendering) commit(); });
      region.append(inp);
    } else {
      const label = h('div', { class: 'glabel', title: (p.claim ? p.claim + '\n' : '') + 'Click to select, double-click to rename, right-click for more', data: { gid } }, C.groupName(p) || 'Untitled group');
      label.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        showMenu(e.clientX, e.clientY, [
          { label: 'Rename Subsection', action: () => { S.editingGroup = gid; requestRender(); } },
          { label: 'Remove Subsection (keep contents)', action: () => ungroup(gid) },
          { label: 'Delete Subsection with Contents', danger: true, action: () => deleteSubsection(gid) },
        ]);
      });
      region.append(label);
    }
    if (S.editingGroup !== gid) {
      const lvl = C.level(p);
      region.append(h('div', { class: 'gtools' },
        h('button', { title: 'Add a claim to this subsection', onclick: () => addClaimIn(id, gid) }, '+'),
        lvl < C.MAX_LEVEL && h('button', { title: 'Add a subsection inside this one', onclick: () => addSubsection(id, null, gid) }, '⊞')));
    }
    regionEls.set(gid, region);
    el.append(region);
  }
  const add = h('button', { class: 'add' }, '+ Add claim');
  add.addEventListener('click', () => addClaim(id));
  const addSub = h('button', { class: 'add sub', title: 'Add a subsection at the end of the section' }, '+ Add subsection');
  addSub.addEventListener('click', () => addSubsection(id, null));
  el.append(add, addSub);

  drag(el, {
    threshold: 2,
    filter: e => !e.target.closest('input, button'),
    move: (ev, dx, dy) => {
      S.lastSection = id;
      const d = { w: dx / S.zoom, h: dy / S.zoom };
      if (S.selection.has(id) && S.selection.size > 1) S.groupDrag = d; else S.islandDrag = { id, offset: d };
      layoutMap();
    },
    end: () => { if (S.groupDrag) endGroupDrag(); else endIslandDrag(); },
    click: (ev, tgt) => {
      // a click on a subsection's label selects it (Delete removes it with its contents, Ctrl+Shift+G keeps the contents); a double click renames it
      const label = tgt.closest && tgt.closest('.glabel');
      if (label) {
        const gid = label.dataset.gid;
        if (isDoubleTap('group:' + gid)) { S.editingGroup = gid; requestRender(); return; }
        select(gid, ev.shiftKey);
        layoutMap();
        return;
      }
      const onTitle = tgt.closest && tgt.closest('.head');
      if (onTitle && isDoubleTap('title:' + id)) { S.editingTitle = id; requestRender(); return; }
      if (!onTitle) isDoubleTap('');
      select(id, ev.shiftKey);
      layoutMap();
    },
  });
  islandEls.set(id, el);
  return el;
}

/** A claim inside an island, a free-floating figure/table/equation block, or an unplaced idea (para == null).
 *  Hit layering, top to bottom: link port, resize handles (blocks), card body, island, water. */
function cardEl(id, text, hueStr, para) {
  const isPara = !!para, isBlock = isPara && C.isBlock(para);
  const el = h('div', { class: 'card ' + (isPara ? (isBlock ? 'block' : 'claim') : 'idea'), data: { id }, style: { '--hue': hueStr } });
  if (!isPara) el.append(h('div', { class: 'idea-label' }, 'UNPLACED IDEA'));
  if (isBlock) el.append(blockThumb(para));
  if (isBlock) el.append(switchEl(id));
  if (isPara && mapPlan) {
    if (mapPlan.hidden.has(id)) el.classList.add('off');
    for (const list of mapPlan.pulled.values()) if (list.includes(para)) { el.classList.add('pulled'); el.title = 'Its block is off. It is in the paper below the claim that needs it.'; }
  }
  const row = h('div', { class: 'row' });
  if (S.editing === id) {
    const ta = h('textarea', { rows: 1, placeholder: '(no claim)', value: text, data: { key: 'claim:' + id, autofocus: '' } });
    const done = () => { if (S.editing === id) setEditing(null); };
    ta.addEventListener('input', () => { setClaim(id, ta.value); autosize(ta); layoutMap(); });
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); done(); } });
    styleable(ta);
    ta.addEventListener('blur', () => { if (!rendering) done(); });
    row.append(ta);
  } else {
    row.append(h('div', { class: 'text' + (text ? '' : ' empty') }, ...(text ? richNodes(text) : ['(no claim)'])));
  }
  if (isPara && !isBlock && C.trimmed(para.text) === '') row.append(h('div', { class: 'noprose', title: 'No prose yet' }));
  el.append(row);

  if (isBlock) {
    // Grab zones on a block's right edge, bottom edge (figures) and bottom-right corner.
    const fig = C.kind(para) === 'figure';
    for (const zone of fig ? ['e', 's', 'se'] : ['e', 'se']) {
      const z = h('div', { class: 'rs ' + zone });
      drag(z, {
        threshold: 1,
        move: (ev, dx, dy) => {
          const wx = dx / S.zoom, wy = dy / S.zoom;
          const img = el.querySelector('.thumb img');
          const aspect = fig && img && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1;
          const d = zone === 'e' ? wx : zone === 's' ? wy * aspect : (fig && Math.abs(wy * aspect) > Math.abs(wx) ? wy * aspect : wx);
          S.resizeDrag = { id, offset: { w: d, h: 0 } };
          layoutMap();
        },
        end: endResize,
      });
      el.append(z);
    }
  }

  // Drag from this dot onto another card (that card then depends on this one),
  // or click it to enter linking mode and click the target card.
  const port = h('div', { class: 'port', title: isPara
    ? 'Drag onto another card, or click then click a card: that card depends on this one'
    : 'Drag onto a section, claim or figure, or click then click one: this note points at it' }, h('i'));
  drag(port, {
    threshold: 3,
    move: ev => {
      const w = toWorld(local(ev));
      S.linkDrag = { from: id, to: w };
      const hit = cardAt(w);
      S.linkTarget = hit === null || hit === id || !paragraph(hit) ? null : hit;
      // A note can also point at a whole island.
      if (!isPara && S.linkTarget === null) S.linkTarget = findLast(S.doc.sections, s => contains(islandRect(s), w))?.id ?? null;
      layoutMap();
    },
    end: () => {
      const t = S.linkTarget;
      S.linkDrag = null; S.linkTarget = null;
      if (t) addLink(id, t);
      layoutMap();
    },
    click: () => { S.linkingFrom = S.linkingFrom === id ? null : id; S.linkPointer = null; layoutMap(); },
  });
  el.append(port);

  el.addEventListener('mouseenter', () => { if (!S.snapshotting) { S.hovered = id; layoutMap(); } });
  el.addEventListener('mouseleave', () => { if (S.hovered === id) { S.hovered = null; layoutMap(); } });
  el.addEventListener('contextmenu', e => {
    if (isTextTarget(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    showMenu(e.clientX, e.clientY, cardMenu(id));
  });
  drag(el, {
    threshold: 3,
    filter: e => !e.target.closest('input, textarea, button, .port, .rs'),
    move: (ev, dx, dy) => {
      const d = { w: dx / S.zoom, h: dy / S.zoom };
      if (S.selection.has(id) && S.selection.size > 1) S.groupDrag = d; else S.cardDrag = { id, offset: d };
      const loc = locate(id);
      if (loc) S.lastSection = S.doc.sections[loc[0]].id;
      layoutMap();
    },
    end: () => { if (S.groupDrag) endGroupDrag(); else endCardDrag(); },
    click: (ev, tgt) => {
      const link = tgt.closest && tgt.closest('.r-link');
      if (link && (ev.ctrlKey || ev.metaKey)) { openLink({ link: link.dataset.link, url: !!link.dataset.url }); return; }
      const cell = tgt.closest && tgt.closest('.cell');
      if (cell && el.contains(cell)) { setEditingCell({ id, r: +cell.dataset.r, c: +cell.dataset.c }); return; }
      if (tgt.closest && tgt.closest('.eq') && el.contains(tgt)) { setEditingEquation(id); return; }
      if (S.linkingFrom) {
        const from = S.linkingFrom;
        S.linkingFrom = null; S.linkPointer = null;
        if (from !== id && isPara) addLink(from, id);
        layoutMap();
      } else if (S.selection.size === 1 && S.selection.has(id) && !ev.shiftKey) {
        setEditing(id);
      } else {
        select(id, ev.shiftKey);
        layoutMap();
      }
    },
  });
  cardEls.set(id, el);
  return el;
}

function cardMenu(id) {
  const para = paragraph(id), note = idea(id), items = [];
  const label = q => [...((C.kind(q) === 'group' ? C.groupName(q) : q.claim) || q.cid)].slice(0, 60).join('');
  if (S.selection.has(id) && canGroup()) items.push({ label: 'Group', action: groupSelection }, { sep: true });
  if (para) {
    const sub = [];
    for (const s of S.doc.sections) {
      sub.push({ header: s.title || 'Untitled' });
      for (const q of s.paragraphs) if (q.id !== id && q.cid) sub.push({ label: label(q), action: () => addLink(id, q.id) });
    }
    items.push({ label: 'Link to…', submenu: sub });
    if (para.needs.length) {
      items.push({ header: 'Depends on' });
      for (const cid of para.needs) {
        items.push({ label: `Remove link from ${cid}: ${[...claimText(cid)].slice(0, 40).join('')}`, action: () => removeNeed(cid, id) });
      }
    }
    items.push({ sep: true }, {
      label: C.isBlock(para) ? 'Place in Section…' : 'Move to Section',
      submenu: S.doc.sections.map(s => ({ label: s.title || 'Untitled', action: () => move(id, s.id) })),
    });
  }
  if (note) {
    const sub = [];
    for (const s of S.doc.sections) {
      sub.push({ header: s.title || 'Untitled' }, { label: 'Section: ' + (s.title || 'Untitled'), action: () => addLink(id, s.id) });
      for (const q of s.paragraphs) if (q.cid) sub.push({ label: label(q), action: () => addLink(id, q.id) });
    }
    items.push({ label: 'Link to…', submenu: sub });
    if (note.to) items.push({ label: 'Remove link to ' + note.to, action: () => removeNoteLink(id) });
    items.push({ sep: true });
  }
  if (para && C.isCard(para)) {
    const loc = locate(id), open = loc ? C.openAt(S.doc.sections[loc[0]], loc[1]) : [], deepest = open.length && open[open.length - 1].level >= C.MAX_LEVEL;
    items.push({ label: 'Expand into Subsection', disabled: !!deepest, action: () => expandClaim(id) });
  }
  if ((para && !C.isBlock(para) && !C.isMarker(para)) || note) items.push({ label: 'Text Style', submenu: styleItems((k, a) => styleClaim(id, k, a)) });
  items.push({ label: 'Edit Claim', action: () => setEditing(id) }, { label: 'Delete', danger: true, action: () => deleteOne(id) });
  return items;
}

const missing = path => h('div', { class: 'missing' }, path);

/** Thumbnail of a figure, table or equation block. */
function blockThumb(p) {
  const k = C.kind(p), el = h('div', { class: 'thumb' });
  if (k === 'figure') {
    const f = C.figure(p), url = f && imageURL(f.path);
    if (url) {
      const img = h('img', { src: url, draggable: 'false', alt: '' });
      img.addEventListener('load', () => layoutMap());
      img.addEventListener('error', () => { img.replaceWith(missing(f.path)); layoutMap(); });
      el.append(img);
    } else el.append(missing(f ? f.path : 'figure'));
  } else if (k === 'table') {
    el.append(tableGrid(p.id, C.tableRows(p), 10, false));
  } else if (k === 'equation') {
    el.append(equationField(p));
  }
  return el;
}

/** Equation source in monospace; click to edit it in place, click away to finish. */
function equationField(p) {
  const id = p.id;
  if (S.editingEquation !== id) return h('div', { class: 'eq', title: 'Click to edit the equation' }, C.equation(p) || '(empty equation)');
  const ta = h('textarea', { rows: 1, placeholder: 'equation', value: C.equation(p), data: { key: 'eq:' + id, autofocus: '' } });
  const done = () => { if (S.editingEquation === id) setEditingEquation(null); };
  ta.addEventListener('input', () => { setEquation(id, ta.value); autosize(ta); layoutMap(); });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); done(); } });
  ta.addEventListener('blur', () => { if (!rendering) done(); });
  return h('div', { class: 'eq' }, ta);
}

/** A table edited in place: click a cell to edit it, Tab / Shift+Tab / Enter move, Esc ends.
 *  Hovering shows "+" on the right (add column) and bottom (add row); right-click deletes. */
function tableGrid(id, rows, size, nativeClick) {
  const cols = Math.max(1, ...rows.map(r => r.length));
  const grid = h('div', { class: 'tgrid', style: { gridTemplateColumns: `repeat(${cols}, 1fr)`, fontSize: size + 'px' } });
  rows.forEach((row, r) => {
    for (let c = 0; c < cols; c++) {
      const ref = { id, r, c }, text = c < row.length ? row[c] : '';
      const cell = h('div', { class: 'cell' + (r === 0 ? ' r0' : ''), data: { r, c } });
      if (sameCell(S.editingCell, ref)) cell.append(cellInput(ref, text, rows.length, cols)); else cell.textContent = text || ' ';
      if (nativeClick) cell.addEventListener('click', () => { if (!sameCell(S.editingCell, ref)) setEditingCell(ref); });
      cell.addEventListener('contextmenu', e => {
        if (isTextTarget(e.target)) return;
        e.preventDefault(); e.stopPropagation();
        showMenu(e.clientX, e.clientY, [
          { label: 'Delete Row', disabled: rows.length <= 1, action: () => { S.editingCell = null; editTable(id, rs => { rs.splice(r, 1); return rs; }); } },
          { label: 'Delete Column', disabled: cols <= 1, action: () => { S.editingCell = null; editTable(id, rs => rs.map(x => { if (c < x.length) x.splice(c, 1); return x; })); } },
        ]);
      });
      grid.append(cell);
    }
  });
  const plus = (cls, title, f) => {
    const b = h('button', { class: 'plus ' + cls, title });
    b.addEventListener('click', e => { e.stopPropagation(); f(); });
    return b;
  };
  return h('div', { class: 'tgrid-wrap' }, grid,
    plus('col', 'Add column', () => editTable(id, rs => rs.map(x => x.concat(Array(Math.max(0, cols + 1 - x.length)).fill(''))))),
    plus('row', 'Add row', () => editTable(id, rs => { rs.push(Array(cols).fill('')); return rs; })));
}

function cellInput(ref, text, nrows, ncols) {
  const inp = h('input', { value: text, data: { key: `cell:${ref.id}:${ref.r}:${ref.c}`, autofocus: '' } });
  inp.addEventListener('input', () => { setCell(ref, inp.value); });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setEditingCell(ref.r + 1 < nrows ? { id: ref.id, r: ref.r + 1, c: ref.c } : null);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditingCell(null);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const i = ref.r * ncols + ref.c + (e.shiftKey ? -1 : 1);
      setEditingCell(i >= 0 && i < nrows * ncols ? { id: ref.id, r: Math.floor(i / ncols), c: i % ncols } : null);
    }
  });
  inp.addEventListener('blur', () => { if (!rendering && sameCell(S.editingCell, ref)) setEditingCell(null); });
  return inp;
}

/** Position everything from the current state: card sizes are measured, islands, group regions,
 *  cards and noodles follow, including in-flight drags. Never rebuilds elements. */
function layoutMap() {
  if (!mapEl || !mapEl.isConnected || S.level !== 'map') return;
  S.viewport = { w: mapEl.clientWidth, h: mapEl.clientHeight };
  if (S.hovered && !cardEls.has(S.hovered)) S.hovered = null;
  for (const s of S.doc.sections) {
    const depth = C.pathOf(s).map(x => x.length);
    s.paragraphs.forEach((p, k) => {
      const el = cardEls.get(p.id);
      if (el) el.style.width = (C.isBlock(p) ? blockWidth(p) : L.cardW - 2 * depth[k] * L.groupInset) + 'px';
    });
  }
  for (const it of S.doc.unplaced) { const el = cardEls.get(it.id); if (el) el.style.width = L.ideaW + 'px'; }
  for (const [id, el] of cardEls) S.heights[id] = el.offsetHeight;
  if (S.needsFit) { fitAll(); settleFit(); }

  const fr = frames();
  for (const s of S.doc.sections) {
    const el = islandEls.get(s.id);
    if (!el) continue;
    const lay = layout(s), o = islandOrigin(s);
    el.style.left = o.x + 'px'; el.style.top = o.y + 'px'; el.style.height = lay.height + 'px';
    el.classList.toggle('selected', S.selection.has(s.id) || S.linkTarget === s.id);
    el.classList.toggle('dragging', !!S.islandDrag && S.islandDrag.id === s.id);
    for (const g of lay.groups) {
      const rg = regionEls.get(g.id);
      if (!rg) continue;
      rg.classList.toggle('selected', S.selection.has(g.id));
      // The island's 1 px border shifts its children.
      rg.style.left = (g.rect.x - o.x - 1) + 'px'; rg.style.top = (g.rect.y - o.y - 1) + 'px';
      rg.style.width = g.rect.w + 'px'; rg.style.height = g.rect.h + 'px';
    }
  }
  for (const [id, el] of cardEls) {
    const f = fr.get(id);
    if (!f) continue;
    el.style.left = f.x + 'px'; el.style.top = f.y + 'px';
    const dragging = !!S.cardDrag && S.cardDrag.id === id;
    const target = S.linkTarget === id || (S.linkingFrom !== null && S.linkingFrom !== id && S.hovered === id);
    el.classList.toggle('selected', S.selection.has(id));
    el.classList.toggle('target', target);
    el.classList.toggle('lit', S.hovered === id || target);
    el.classList.toggle('dragging', dragging);
    el.lastElementChild.classList.toggle('active', S.linkingFrom === id);
  }
  const t = `translate(${S.pan.x}px, ${S.pan.y}px) scale(${S.zoom})`;
  worldA.style.transform = t; worldB.style.transform = t;
  mapEl.classList.toggle('linking', S.linkingFrom !== null);
  paintNoodles(fr);

  if (S.templateDrag) {
    const r = mapEl.getBoundingClientRect();
    if (ghostEl.dataset.kind !== S.templateDrag.kind) { ghostEl.replaceChildren(mini(S.templateDrag.kind)); ghostEl.dataset.kind = S.templateDrag.kind; }
    ghostEl.style.display = ''; ghostEl.style.left = (S.templateDrag.x - r.left) + 'px'; ghostEl.style.top = (S.templateDrag.y - r.top) + 'px';
  } else ghostEl.style.display = 'none';
  if (S.marquee) {
    const m = S.marquee;
    marqueeEl.style.display = ''; marqueeEl.style.left = m.x + 'px'; marqueeEl.style.top = m.y + 'px';
    marqueeEl.style.width = m.w + 'px'; marqueeEl.style.height = m.h + 'px';
  } else marqueeEl.style.display = 'none';
}

/** Every dependency link as a soft bezier, recomputed from live frames on every drag frame.
 *  Geometry is mapped to screen points before stroking, so widths are constant on screen. */
function paintNoodles(fr) {
  const T = p => ({ x: p.x * S.zoom + S.pan.x, y: p.y * S.zoom + S.pan.y });
  const out = [];
  for (const l of links()) {
    const a = endFrame(l.src, fr), b = endFrame(l.dst, fr);
    if (!a || !b) continue;
    const c = noodleControls(a, b, 6 / S.zoom).map(T);
    const d = `M${c[0].x} ${c[0].y}C${c[1].x} ${c[1].y} ${c[2].x} ${c[2].y} ${c[3].x} ${c[3].y}`;
    const selected = !!S.selectedLink && S.selectedLink.src === l.src && S.selectedLink.dst === l.dst;
    const hv = S.hovered, lit = selected || hv === null || hv === l.src || hv === l.dst;
    const w = (selected ? 5 : hv !== null && lit ? 4 : 3) * (l.note ? 0.5 : 1);
    const color = `rgba(${l.hue}, ${lit ? (hv === null && !selected ? 0.7 : 0.95) : 0.15})`;
    if (selected) out.push(sv('path', { d, fill: 'none', stroke: `rgba(${l.hue}, 0.25)`, 'stroke-width': w + 10, 'stroke-linecap': 'round' }));
    out.push(sv('path', { d, fill: 'none', stroke: color, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-dasharray': l.backwards ? '9 9' : null }));
    out.push(sv('circle', { cx: c[3].x, cy: c[3].y, r: 3.5, fill: color }));
    // A wide invisible stroke takes the clicks: select, then Delete, or right-click to remove.
    const hit = sv('path', { d, class: 'hit' });
    const key = { src: l.src, dst: l.dst };
    hit.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      S.selectedLink = key; S.linkingFrom = null;
      layoutMap();
    });
    hit.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      S.selectedLink = key;
      layoutMap();
      showMenu(e.clientX, e.clientY, [{ label: 'Remove Link', action: () => removeLink(key) }]);
    });
    out.push(hit);
  }
  let rubber = S.linkDrag ? [S.linkDrag.from, S.linkDrag.to] : null;
  if (!rubber && S.linkingFrom !== null && S.linkPointer) rubber = [S.linkingFrom, S.linkPointer];
  if (rubber && fr.has(rubber[0])) {
    const a = fr.get(rubber[0]), p0 = T({ x: a.x + a.w, y: midY(a) }), to = T(rubber[1]);
    const dx = Math.max(40, Math.abs(to.x - p0.x) * 0.45);
    out.push(sv('path', { d: `M${p0.x} ${p0.y}C${p0.x + dx} ${p0.y} ${to.x - dx} ${to.y} ${to.x} ${to.y}`, fill: 'none',
      stroke: 'var(--accent)', 'stroke-opacity': 0.8, 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-dasharray': '2 8' }));
  }
  noodleSvg.replaceChildren(...out);
}

// ---- prose ----

/** Markdown list line: indent, marker ("- ", "* " or "1. ") and content. */
function listLine(line) {
  const indent = line.match(/^ */)[0], rest = line.slice(indent.length);
  let marker;
  if (rest.length >= 2 && '-*•'.includes(rest[0]) && rest[1] === ' ') marker = rest.slice(0, 2);
  else {
    const dot = rest.indexOf('.');
    if (dot > 0 && /^\d+$/.test(rest.slice(0, dot)) && rest[dot + 1] === ' ') marker = rest.slice(0, dot + 2); else return null;
  }
  const number = /^\d+\. $/.test(marker) ? parseInt(marker, 10) : null;
  return { indent, marker, content: rest.slice(marker.length), number,
    nextMarker: number !== null ? `${number + 1}. ` : '• ', step: number === null ? '  ' : '   ' };
}
/** Bullets are stored as "- " (or "* ") and shown as "• ". Same length, so ranges map 1:1. */
const mapLines = (s, f) => s.split('\n').map(l => { const m = listLine(l), r = m ? f(m) : null; return r != null ? m.indent + r + m.content : l; }).join('\n');
const bulletsDisplay = md => mapLines(md, m => (m.number === null ? '• ' : null));
const bulletsMarkdown = shown => mapLines(shown, m => (m.marker === '• ' ? '- ' : null));

// ---- text styles (bold, italic, strike-through, highlight, colour, comment) ----

/** A text as DOM, styles shown and markers hidden (see richtext.js). */
function richNodes(text) {
  return Rich.spans(text).filter(p => !p.mk).map(p => {
    if (p.link) {
      // a link to a note, a literature note (a citation) or a web page; Ctrl+click opens it (in Prose a plain click does)
      return h('span', { class: 'r-link' + (p.cite ? ' r-cite' : ''), title: p.link + ' (Ctrl+click to open)', data: { link: p.link, url: p.url ? '1' : '' } }, p.cite ? '@' + p.cite : p.label);
    }
    const cls = [p.b && 'r-b', p.i && 'r-i', p.s && 'r-s', p.c && 'r-c', p.code && 'r-code', p.bg && 'r-hl'].filter(Boolean).join(' ');
    if (!cls && !p.color) return D.createTextNode(p.t);
    const el = h('span', { class: cls, title: p.c ? 'Comment' : null }, p.t);
    if (p.color) el.style.color = p.color;
    if (p.bg) el.style.background = p.bg;
    return el;
  });
}

/** Apply a style to the selection of a text field (or take it off), as one edit its own undo understands. */
function applyStyle(ta, kind, arg) {
  const v = ta.value, r = Rich.toggle(v, ta.selectionStart, ta.selectionEnd, kind, arg);
  if (r.text === v) return;
  let a = 0;
  while (a < v.length && a < r.text.length && v[a] === r.text[a]) a++;
  let b = 0;
  while (b < v.length - a && b < r.text.length - a && v[v.length - 1 - b] === r.text[r.text.length - 1 - b]) b++;
  replaceRange(ta, a, v.length - b, r.text.slice(a, r.text.length - b));
  ta.setSelectionRange(r.s, r.e);
}

const cap = w => w[0].toUpperCase() + w.slice(1);

/** The claim of a card (or an unplaced idea) in one style, as a whole. */
function styleClaim(id, kind, arg) {
  const p = paragraph(id), n = idea(id), text = p ? p.claim : n ? n.text : '';
  if (!text) return;
  const r = Rich.toggle(text, 0, text.length, kind, arg);
  if (r.text !== text) act(() => { if (p) p.claim = r.text; else n.text = r.text; });
}

/** The entries of the styles menu; `apply(kind, arg)` does the work (on a selection, or on a whole claim). */
function styleItems(apply) {
  const ap = (k, a) => () => apply(k, a);
  return [
    { label: 'Bold', key: 'Ctrl+B', action: ap('b') },
    { label: 'Italic', key: 'Ctrl+I', action: ap('i') },
    { label: 'Strikethrough', key: 'Ctrl+Shift+X', action: ap('s') },
    { sep: true },
    { label: 'Highlight', key: 'Ctrl+Shift+H', submenu: Object.keys(Rich.HIGHLIGHTS).map(n => ({ label: cap(n), action: ap('hl', n) })) },
    { label: 'Text color', submenu: Object.keys(Rich.TEXT_COLORS).map(n => ({ label: cap(n), action: ap('color', n) })) },
    { label: 'Comment', action: ap('c') },
    { sep: true },
    { label: 'Clear formatting', action: ap('clear') },
  ];
}

/** Right-click on a selection offers the styles; Ctrl+B, Ctrl+I, Ctrl+Shift+X and Ctrl+Shift+H apply them. */
function styleable(ta) {
  ta.dataset.styleable = '1';
  ta.addEventListener('contextmenu', e => {
    if (ta.selectionStart === ta.selectionEnd) return;   // nothing selected: the usual menu (copy, paste)
    e.preventDefault(); e.stopPropagation();
    const clip = [
      { label: 'Cut', key: 'Ctrl+X', action: () => { ta.focus(); D.execCommand('cut'); } },
      { label: 'Copy', key: 'Ctrl+C', action: () => { ta.focus(); D.execCommand('copy'); } },
      { label: 'Paste', key: 'Ctrl+V', action: async () => {
        ta.focus();
        let t = '';
        try { t = await win().navigator.clipboard.readText(); } catch { /* no permission: the browser's own paste */ }
        if (t) replaceRange(ta, ta.selectionStart, ta.selectionEnd, t); else D.execCommand('paste');
      } },
      { sep: true },
    ];
    showMenu(e.clientX, e.clientY, [...clip, ...styleItems((k, a) => applyStyle(ta, k, a))]);
  });
  suggestable(ta);
  ta.addEventListener('keydown', e => {
    if (e.isComposing || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase(), kind = !e.shiftKey ? { b: 'b', i: 'i' }[k] : { x: 's', h: 'hl' }[k];
    if (!kind || ta.selectionStart === ta.selectionEnd) return;
    e.preventDefault(); e.stopPropagation();
    applyStyle(ta, kind);
  });
  return ta;
}

// ---- suggestions: links to notes, citation keys, LaTeX commands, words ----
// `[[` offers the notes of the vault (a literature note whose name starts with @ is inserted as `[[path|@key]]`, which is a
// citation), `[@` the keys of the bibliographies and literature notes, `\` inside $…$ LaTeX commands, and three letters of a
// word the words of the Completr plugin's list (when that plugin is in the vault). Tab or Enter takes the suggestion.

let sug = null;   // the open popup: { ta, items, sel, el }
const closeSuggest = () => { if (sug) { sug.el.remove(); sug = null; } };

/** Where the caret of a text field is, in client coordinates (a hidden copy of the text measures it). */
function caretPoint(ta) {
  const cs = win().getComputedStyle(ta), m = h('div');
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'boxSizing', 'tabSize', 'textAlign']) m.style[k] = cs[k];
  Object.assign(m.style, { position: 'fixed', visibility: 'hidden', top: '0', left: '0', width: ta.offsetWidth + 'px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', border: '0' });
  m.textContent = ta.value.slice(0, ta.selectionStart);
  const mark = h('span', {}, '\u200b');
  m.append(mark);
  rootEl.append(m);
  const r = ta.getBoundingClientRect(), x = mark.offsetLeft, y = mark.offsetTop, lh = mark.offsetHeight || 16;
  m.remove();
  return { x: r.left + x, y: r.top + y - ta.scrollTop + lh };
}

const fuzzy = (hay, q) => { hay = hay.toLowerCase(); let i = 0; for (const ch of q) { i = hay.indexOf(ch, i); if (i < 0) return false; i++; } return true; };

/** The suggestions for the caret of `ta`: { items: [{ label, hint, text, start, end, caret }] } or null. */
async function suggestionsFor(ta) {
  const sg = host.suggest;
  if (!sg || ta.selectionStart !== ta.selectionEnd) return null;
  const v = ta.value, pos = ta.selectionStart, before = v.slice(0, pos), line = before.slice(before.lastIndexOf('\n') + 1);
  let m = before.match(/\[\[([^\[\]\n|]*)$/);
  if (m) {
    const q = m[1].toLowerCase().trim(), end = pos + (v.slice(pos, pos + 2) === ']]' ? 2 : 0), start = pos - m[0].length;
    const notes = (await sg.notes()).filter(n => !q || fuzzy(n.path, q));
    notes.sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || (b.name.toLowerCase().includes(q) - a.name.toLowerCase().includes(q)) || b.mtime - a.mtime);
    return { items: notes.slice(0, 8).map(n => ({ label: n.name, hint: n.dir, text: n.insert, start, end })) };
  }
  m = before.match(/(?:\[|;\s*)@([^\s,;\]\[@]*)$/);
  if (m) {
    const q = m[1].toLowerCase();
    const keys = (await sg.keys()).filter(k => !q || k.key.toLowerCase().includes(q));
    keys.sort((a, b) => (b.key.toLowerCase().startsWith(q) - a.key.toLowerCase().startsWith(q)));
    return { items: keys.slice(0, 8).map(k => ({ label: k.key, hint: k.hint, text: k.key, start: pos - m[1].length, end: pos })) };
  }
  const dollars = (line.replace(/\$\$/g, '').match(/\$/g) || []).length;
  m = dollars % 2 === 1 ? line.match(/\\[A-Za-z]*$/) : null;
  if (m) {
    const cmds = (await sg.latex()).filter(c => c.displayName.replace(/\.\.\.$/, '').startsWith(m[0]) && c.displayName.replace(/\.\.\.$/, '') !== m[0]);
    return { items: cmds.slice(0, 8).map(c => {
      const at = c.replacement.indexOf('~'), text = c.replacement.replace('~', '');
      return { label: c.displayName, hint: '', text, start: pos - m[0].length, end: pos, caret: at >= 0 ? at : null };
    }) };
  }
  m = before.match(/[\p{L}][\p{L}\p{N}_-]{2,}$/u);
  if (m && !/[\p{L}\p{N}]/u.test(v[pos] || '')) {
    const q = m[0].toLowerCase(), seen = new Set();
    const words = (await sg.words()).filter(w => w.length > m[0].length && w.toLowerCase().startsWith(q) && !seen.has(w) && seen.add(w));
    return { items: words.slice(0, 6).map(w => ({ label: w, hint: '', text: w, start: pos - m[0].length, end: pos })) };
  }
  return null;
}

function acceptSuggestion() {
  if (!sug) return;
  const { ta, items, sel } = sug, it = items[sel];
  closeSuggest();
  replaceRange(ta, it.start, it.end, it.text);
  const at = it.caret != null ? it.start + it.caret : it.start + it.text.length;
  ta.setSelectionRange(at, at);
}

let suggestToken = 0;
async function updateSuggest(ta) {
  const token = ++suggestToken;
  let r = null;
  try { r = await suggestionsFor(ta); } catch { r = null; }
  if (token !== suggestToken || destroyed || shadow.activeElement !== ta) return;
  if (!r || !r.items.length) { closeSuggest(); return; }
  closeSuggest();
  const el = h('div', { class: 'suggest' });
  r.items.forEach((it, k) => {
    const row = h('div', { class: 'si' + (k === 0 ? ' on' : '') }, h('span', { class: 'sl' }, it.label), it.hint && h('span', { class: 'sh' }, it.hint));
    row.addEventListener('mousedown', e => { e.preventDefault(); sug.sel = k; acceptSuggestion(); });
    el.append(row);
  });
  const pt = caretPoint(ta), rr = rootEl.getBoundingClientRect();
  rootEl.append(el);
  el.style.left = Math.max(4, Math.min(pt.x - rr.left, rr.width - el.offsetWidth - 4)) + 'px';
  el.style.top = Math.min(pt.y - rr.top + 2, rr.height - el.offsetHeight - 4) + 'px';
  sug = { ta, items: r.items, sel: 0, el };
}

function suggestable(ta) {
  ta.addEventListener('input', () => { updateSuggest(ta); });
  ta.addEventListener('blur', () => { suggestToken++; closeSuggest(); });
  ta.addEventListener('keydown', e => {
    if (!sug || sug.ta !== ta || e.isComposing) return;
    const move = d => {
      sug.sel = (sug.sel + d + sug.items.length) % sug.items.length;
      sug.items.forEach((_, k) => sug.el.children[k].classList.toggle('on', k === sug.sel));
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); move(-1); }
    else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); e.stopImmediatePropagation(); acceptSuggestion(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeSuggest(); }
  }, true);
  return ta;
}

/** The link that covers offset `off` of a text, as { link, url } or null. */
function linkAtOffset(text, off) {
  let at = 0;
  for (const p of Rich.spans(text)) {
    if (p.link && off >= at && off <= at + p.t.length) return { link: p.link, url: p.url };
    at += p.t.length;
  }
  return null;
}
const openLink = l => { if (host.openLink) host.openLink(l.link, !!l.url); };

/** Replace a range of a textarea in a way its own undo history understands. */
function replaceRange(ta, start, end, text) {
  ta.focus();
  ta.setSelectionRange(start, end);
  const ok = text === '' ? (start === end || D.execCommand('delete')) : D.execCommand('insertText', false, text);
  if (!ok) ta.setRangeText(text, start, end, 'end');
}

/** Paragraph editor with live list formatting. Grows with its content. */
function paragraphEditor(p) {
  const id = p.id;
  const ta = h('textarea', { class: 'pedit', rows: 1, placeholder: 'Write this paragraph…', value: bulletsDisplay(p.text), data: { key: 'para:' + id } });
  if (S.focusParagraph === id) ta.dataset.autofocus = 'end';
  // Until it is focused, the paragraph is shown with its styles (the text field, which has the markers, lies invisibly on top).
  const view = h('div', { class: 'pview' });
  // A click on a link of the shown paragraph opens it (the invisible text field lies on top, so it is asked by position).
  ta.addEventListener('mousedown', e => {
    if (e.button !== 0 || shadow.activeElement === ta) return;
    const hit = [...view.querySelectorAll('.r-link')].find(l => [...l.getClientRects()].some(r => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom));
    if (hit) { e.preventDefault(); openLink({ link: hit.dataset.link, url: !!hit.dataset.url }); }
  });
  ta.addEventListener('click', e => {
    if (!(e.ctrlKey || e.metaKey) || ta.selectionStart !== ta.selectionEnd) return;
    const l = linkAtOffset(ta.value, ta.selectionStart);
    if (l) openLink(l);
  });
  const paint = () => view.replaceChildren(...(ta.value ? richNodes(ta.value) : [h('span', { class: 'ph' }, 'Write this paragraph…')]));
  paint();
  styleable(ta);
  const sync = () => {
    // "- " or "* " typed at a line start becomes a bullet.
    const shown = bulletsDisplay(bulletsMarkdown(ta.value));
    if (shown !== ta.value && shown.length === ta.value.length) {
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = shown;
      ta.setSelectionRange(s, e);
    }
    change(() => { const q = paragraph(id); if (q) q.text = bulletsMarkdown(ta.value); });
    paint();
    autosize(ta);
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', e => {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'Enter' && e.key !== 'Tab') return;
    const v = ta.value, pos = ta.selectionStart;
    const ls = v.lastIndexOf('\n', pos - 1) + 1, nl = v.indexOf('\n', pos), le = nl < 0 ? v.length : nl;
    const line = v.slice(ls, le), m = listLine(line);
    if (e.key === 'Enter') {
      // Enter continues a list, ends it on an empty item, never makes a blank line inside the
      // paragraph, and splits off a new paragraph when pressed on an empty last line.
      if (m) {
        e.preventDefault();
        if (C.trimmed(m.content) === '') replaceRange(ta, ls, le, ''); else replaceRange(ta, pos, ta.selectionEnd, '\n' + m.indent + m.nextMarker);
        sync();
      } else if (C.trimmed(line) === '') {
        e.preventDefault();
        if (le === v.length) {
          if (ls > 0) { replaceRange(ta, ls - 1, le, ''); sync(); }
          splitParagraph(id);
        }
      }
    } else if (!e.shiftKey) {
      e.preventDefault();
      if (m) replaceRange(ta, ls, ls, m.step); else replaceRange(ta, pos, ta.selectionEnd, '\t');
      if (m) ta.setSelectionRange(pos + m.step.length, pos + m.step.length);
      sync();
    } else {
      e.preventDefault();
      if (m && m.indent.length) {
        const n = Math.min(m.indent.length, m.step.length);
        replaceRange(ta, ls, ls + n, '');
        ta.setSelectionRange(Math.max(ls, pos - n), Math.max(ls, pos - n));
        sync();
      }
    }
  });
  return h('div', { class: 'pwrap' }, view, ta);
}

/** A claim field of Prose, shown with its styles and links until it is focused, as the paragraphs are: the text field lies
 *  invisibly on top, and a click on a link opens it. `cls` is given to the shown text too, so both look the same. */
function richClaim(ta, cls) {
  const view = h('div', { class: 'cview ' + (cls || '') });
  const paint = () => view.replaceChildren(...(ta.value ? richNodes(ta.value) : [h('span', { class: 'ph' }, ta.placeholder)]));
  paint();
  ta.addEventListener('input', paint);
  ta.addEventListener('mousedown', e => {
    if (e.button !== 0 || shadow.activeElement === ta) return;
    const hit = [...view.querySelectorAll('.r-link')].find(l => [...l.getClientRects()].some(r => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom));
    if (hit) { e.preventDefault(); openLink({ link: hit.dataset.link, url: !!hit.dataset.url }); }
  });
  return h('div', { class: 'cwrap' }, ta, view);   // the field first: a query for the field by its class finds it, not the view
}

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff' };

/** The image files on the clipboard (a screenshot, an image copied from a browser or an editor), named the way Obsidian names a
 *  pasted image when they have no name of their own. */
function clipboardImages(e) {
  const out = [], stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  for (const f of [...(e.clipboardData ? e.clipboardData.files : [])]) {
    const extn = IMAGE_TYPES[f.type];
    if (!extn) continue;
    const named = f.name && f.name !== 'image.png' && /\.[A-Za-z0-9]+$/.test(f.name);
    out.push(named ? f : new (win().File)([f], `Pasted image ${stamp}${out.length ? '-' + out.length : ''}.${extn}`, { type: f.type }));
  }
  return out;
}

/** Pasted images become figures: on the Map where the pointer last was (else the middle of the view), in Prose below the paragraph
 *  that has the focus (else at the end of the section that was touched last). */
async function pasteImages(files) {
  let rs;
  try { rs = await host.importImages(files); } catch { setStatus('Could not add the image'); return; }
  if (!rs.length || destroyed) return;
  if (S.level === 'map') {
    const c = S.pointerWorld || toWorld({ x: S.viewport.w / 2, y: S.viewport.h / 2 });
    rs.forEach((r, k) => addFigureRef(r, { x: c.x + k * 30, y: c.y + k * 30 }));
    return;
  }
  const row = shadow.activeElement && shadow.activeElement.closest ? shadow.activeElement.closest('.prow') : null;
  const s = (row && section(row.dataset.sec)) || section(S.lastSection) || S.doc.sections[S.doc.sections.length - 1];
  if (!s) { setStatus('Add a section first'); return; }
  act(() => {
    let after = row && row.dataset.sec === s.id ? row.dataset.id : null;
    const r0 = islandRect(s);
    for (const r of rs) {
      const p = C.newParagraph({ claim: `What ${r.name} shows`, text: `![${r.name}](${r.rel})`, pos: { x: r0.x + r0.w + 60, y: r0.y }, autoPlace: true });
      const k = after ? s.paragraphs.findIndex(q => q.id === after) : -1;
      if (k < 0 || k + 1 >= s.paragraphs.length) insert(p, s.id, { kind: 'end' });
      else insert(p, s.id, { kind: 'before', id: s.paragraphs[k + 1].id, group: C.groupOf(s)[k] });
      after = p.id;
    }
    C.assignIDs(S.doc);
    S.lastSection = s.id;
  });
}

/** A single-paragraph text field that grows: Enter does not insert a line break. */
function lineField(cls, value, placeholder, onInput) {
  const ta = h('textarea', { class: cls, rows: 1, placeholder, value });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
  ta.addEventListener('input', () => { onInput(ta.value.replaceAll('\n', ' ')); autosize(ta); });
  return ta;
}

function setHighlight(id) {
  S.highlight = id;
  shadow.querySelectorAll('.prow.highlight').forEach(r => r.classList.remove('highlight'));
  if (id) { const r = shadow.querySelector(`.prow[data-id="${id}"]`); if (r) r.classList.add('highlight'); }
}

function renderProse(main) {
  mapEl = null;
  let sc = shadow.getElementById('prose');
  const fresh = !sc, top = sc ? sc.scrollTop : 0;
  if (fresh) {
    sc = h('div', { id: 'prose', class: S.fade ? 'fade' : '' });
    // Whatever was touched last decides where the Map centers.
    sc.addEventListener('focusin', e => { const r = e.target.closest('[data-sec]'); if (r) S.lastSection = r.dataset.sec; });
    // Pinching and Ctrl+scroll do nothing in Prose.
    sc.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });
    main.replaceChildren(sc);
  }
  // cid -> (paragraph, section index), for dependency dots.
  const deps = new Map();
  S.doc.sections.forEach((s, i) => { for (const p of s.paragraphs) if (p.cid) deps.set(p.cid, [p.id, i]); });

  const numbers = C.numbering(S.doc);   // 1, 1.1, 1.1.1 … as LaTeX numbers them
  const pl = C.plan(S.doc);             // what is not shown (blocks that are switched off), and what is shown below another claim
  // The claim in the left margin, right-aligned toward the text, with one dot per dependency. `o.from`: the title of the block
  // that is off, when this claim is shown here because the claim above it needs it.
  const claimRow = (p, o) => {
    const id = p.id, kind = C.kind(p), sid = o.sid;
    const claimField = lineField('', p.claim, 'add claim', v => change(() => { const q = paragraph(id); if (q) q.claim = v; }));
    claimField.dataset.key = 'claim:' + id;
    styleable(claimField);
    if (S.focusClaim === id) claimField.dataset.autofocus = 'end';
    // Enter ends the claim and goes on to the paragraph
    claimField.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const t = shadow.querySelector(`.prow[data-id="${id}"] .pedit`);
      if (t) { e.preventDefault(); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
    });
    const note = h('div', { class: 'mnote' }, o.from != null && h('div', { class: 'pulled-from', title: 'Shown here because the claim above needs it. Its block is switched off, so it is not in the paper anywhere else.' }, '↳ from ' + (o.from || 'a block')), richClaim(claimField));
    const dots = p.needs.filter(cid => deps.has(cid)).map(cid => {
      const [did, si] = deps.get(cid);
      const d = h('b', { title: 'Depends on ' + cid, style: { '--hue': hue(si) } });
      d.addEventListener('mouseenter', () => setHighlight(did));
      d.addEventListener('mouseleave', () => { if (S.highlight === did) setHighlight(null); });
      d.addEventListener('click', () => {
        const r = shadow.querySelector(`.prow[data-id="${did}"]`);
        if (r) r.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return d;
    });
    if (dots.length) note.append(h('div', { class: 'dots' }, dots));
    const row = h('div', { class: 'prow' + (o.rail ? ' rail' : '') + (o.from != null ? ' pulled' : ''), data: { id, sec: sid }, style: { '--hue': o.hu, '--depth': o.depth } },
      h('div', { class: 'hl' }, ), note, proseBlock(p, kind, sid));
    if (o.from == null) {
      note.append(h('div', { class: 'padd-tools' },
        C.isCard(p) && h('button', { class: 'padd-after', title: 'Expand this claim into a subsection', onclick: () => expandClaim(id) }, '↳'),
        h('button', { class: 'padd-after', title: 'New claim below', onclick: () => addProseClaim(sid, id) }, '+')));
    }
    return row;
  };

  const inner = h('div', { class: 'inner' });
  inner.append(h('div', { class: 'top' },
    lineField('ptitle', S.doc.title, 'Untitled paper', v => change(() => { S.doc.title = v; })),
    lineField('pthesis', S.doc.thesis, 'One sentence for the whole paper', v => change(() => { S.doc.thesis = v; }))));

  S.doc.sections.forEach((s, i) => {
    const sid = s.id, hu = hue(i), secOff = pl.secOff.has(sid);
    if (!secOff) {
      const title = h('input', { value: s.title, placeholder: 'Section title' });
      if (S.focusSection === sid) title.dataset.autofocus = 'select';
      title.addEventListener('input', () => change(() => { const q = section(sid); if (q) q.title = title.value; }));
      inner.append(h('div', { class: 'sechead', data: { id: sid, sec: sid }, style: { '--hue': hu } }, h('i'), h('span', { class: 'num' }, numbers.sections.get(sid)), title));
    }
    const of = C.groupOf(s), path = C.pathOf(s);
    s.paragraphs.forEach((p, k) => {
      const kind = C.kind(p), id = p.id, depth = Math.max(0, path[k].length - 1);
      if (kind === 'groupEnd' || pl.hidden.has(id)) return;
      if (kind === 'group') {
        // The title in the paper, and at the top of the rail the same title in small caps (both editable), or, for a subsection
        // that was expanded from a claim, that claim (with its dependency dots). Deeper subsections are indented.
        const b = h('input', { class: 'gt', value: C.groupName(p), placeholder: 'Subsection title' });
        const lvl = C.level(p), size = { 2: 17, 3: 15, 4: 13.5, 5: 13 }[lvl];
        b.style.fontSize = size + 'px';
        if (lvl >= 4) b.style.fontStyle = 'italic';
        const num = h('span', { class: 'num', style: { fontSize: size + 'px', fontStyle: lvl >= 4 ? 'italic' : null } }, numbers.headings.get(id));
        b.addEventListener('input', () => change(() => { const q = paragraph(id); if (q) C.setGroupName(q, b.value); }));
        let a;
        if (p.cid || p.claim) {
          const f = lineField('gm claim', p.claim, 'add claim', v => change(() => { const q = paragraph(id); if (q) q.claim = v; }));
          f.dataset.key = 'claim:' + id;
          styleable(f);
          a = richClaim(f, 'gm claim');
        } else {
          a = h('input', { class: 'gm', value: C.groupName(p), placeholder: 'group' });
          a.addEventListener('input', () => { change(() => { const q = paragraph(id); if (q) C.setGroupName(q, a.value); }); b.value = a.value; });
          b.addEventListener('input', () => { a.value = b.value; });
        }
        const del = h('button', { class: 'gdel', title: 'Remove this subsection (what is in it stays)', onclick: () => ungroup(id) }, '×');
        inner.append(h('div', { class: 'ghead rail', data: { id, sec: sid }, style: { '--hue': hu, '--depth': depth, '--level': C.level(p) } }, a, h('i'), num, b, del));
        return;
      }
      inner.append(claimRow(p, { sid, hu, rail: !!of[k], depth }));
      // the claims of a block that is off that this claim needs, below it
      for (const q of pl.pulled.get(p.id) || []) {
        const qs = S.doc.sections.find(x => x.paragraphs.includes(q));
        inner.append(claimRow(q, { sid: qs.id, hu: hue(S.doc.sections.indexOf(qs)), rail: false, depth: 0, from: qs.title }));
      }
    });
    if (!secOff) inner.append(h('div', { class: 'padd', data: { sec: sid } }, h('button', { title: 'Add a claim with its paragraph to this section', onclick: () => addProseClaim(sid, null) }, '+ Add claim')));
  });
  inner.append(h('div', { class: 'padd sec' }, h('button', { title: 'Add a section', onclick: addProseSection }, '+ Add section')));
  sc.replaceChildren(h('div', { class: 'sheet' }, inner));
  autosizeAll();
  if (!fresh) sc.scrollTop = top;
  else if (S.lastSection) {
    const el = sc.querySelector(`.sechead[data-id="${S.lastSection}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
  }
  // from the LaTeX view: the paragraph a line came from, lit up for a moment
  if (typeof S.tex.scrollTo === 'string') {
    const id = S.tex.scrollTo, el = sc.querySelector(`.prow[data-id="${id}"]`);
    S.tex.scrollTo = null;
    if (el) {
      el.scrollIntoView({ block: 'center' });
      setHighlight(id);
      setTimeout(() => { if (S.highlight === id) setHighlight(null); }, 1600);
    }
  }
  if (S.highlight) setHighlight(S.highlight);
}

function proseBlock(p, kind, sid) {
  const id = p.id, el = h('div', { class: 'pblock' });
  if (kind === 'prose') { el.append(paragraphEditor(p)); return el; }
  if (kind === 'table') { el.append(tableGrid(id, C.tableRows(p), 13, true)); return el; }
  let shown;
  if (kind === 'figure') {
    const f = C.figure(p), url = f && imageURL(f.path);
    shown = h('div', { class: 'pfig' });
    if (url) {
      const img = h('img', { src: url, alt: '' });
      img.addEventListener('error', () => img.replaceWith(missing('Missing image ' + f.path)));
      shown.append(img);
    } else shown.append(missing('Missing image ' + (f ? f.path : '')));
    shown.append(h('div', { class: 'cap' }, f ? f.caption : ''));
  } else {
    shown = h('div', { class: 'peq' }, C.equation(p));
  }
  shown.title = 'Click to edit the Markdown source';
  shown.addEventListener('click', () => {
    if (S.sourceOpen.has(id)) S.sourceOpen.delete(id); else S.sourceOpen.add(id);
    S.lastSection = sid;
    requestRender();
  });
  el.append(shown);
  if (S.sourceOpen.has(id)) {
    const ta = h('textarea', { class: 'psrc', rows: 1, value: p.text, data: { key: 'src:' + id } });
    ta.addEventListener('input', () => { change(() => { const q = paragraph(id); if (q) q.text = ta.value; }); autosize(ta); });
    // The rendered block above follows once the field is left.
    ta.addEventListener('blur', () => { if (!rendering) requestRender(); });
    el.append(ta);
  }
  return el;
}


// ---- LaTeX and PDF ----
// Both are made from the document and are read-only here: the text is edited in Map and Prose. The LaTeX is
// remade on every render (it is cheap), the PDF when asked for (Compile) and when the PDF view opens on a LaTeX
// text it has not been made from.

const time = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The template the document asks for (front matter `latex:`), else "article", else the first there is. */
function templateOf() {
  const list = S.tex.templates || Latex.BUILTIN, want = Latex.front(S.doc, 'latex');
  return list.find(t => t.name === want) || list.find(t => t.name === 'article') || list[0];
}

/** The citation keys that are known: those of the folder's .bib files, and those the PDF is made with from the library (see
 *  `refreshPending`). Null when the folder has not been looked at yet. */
function knownKeys() {
  const info = S.tex.info;
  return info ? new Set([...info.bibKeys, ...(S.tex.pending ? S.tex.pending.found : [])]) : null;
}

let latexCache = { key: null, value: null };
/** The document as LaTeX now: { tex, warnings, cites, … } (see latex.js). */
function latexResult() {
  const info = S.tex.info, t = templateOf(), known = knownKeys();
  const key = [currentText(), t.name, t.text, info ? info.bibFiles.join(',') + '|' + [...known].join(',') : ''].join('\0');
  if (latexCache.key === key) return latexCache.value;
  const value = Latex.toLatex(S.doc, {
    template: t.text, figurePath: host.latex ? host.latex.figurePath : null, figureWidthIn: host.latex ? host.latex.figureWidthIn : null,
    bibFiles: info ? info.bibFiles : [], bibKeys: known,
  });
  latexCache = { key, value };
  return value;
}

/** The template this computer shows the PDF with, when it is not the document's: chosen in the PDF view, kept per computer and
 *  document (not in the note), so everyone may preview with a template of their own. The .tex in the folder, which goes to
 *  Overleaf and comes back from it, is always made with the document's template. */
function previewTemplateOf() {
  const want = S.tex.preview, list = S.tex.templates || Latex.BUILTIN;
  if (!want || want === templateOf().name) return null;
  return list.find(t => t.name === want) || null;
}
let previewCache = { key: null, tex: null };
/** The LaTeX the PDF is made from: the document's, or the same text in the preview template. */
function pdfTex() {
  const t = previewTemplateOf(), doc = latexResult().tex;
  if (!t) return doc;
  const key = doc + '\0' + t.name + '\0' + t.text;
  if (previewCache.key !== key) previewCache = { key, tex: Latex.toLatex(S.doc, { ...exportOpts(), template: t.text }).tex };
  return previewCache.tex;
}

/** Copy the entries the text cites from a Zotero export in the Archipelago folder into the document's .bib. */
async function syncBib() {
  if (!host.latex || !host.latex.syncBib) return;
  const cites = [...latexResult().cites];
  if (!cites.length) return;
  const r = await host.latex.syncBib(cites);
  if (r.added.length) { S.tex.info = await host.latex.info(); setStatus(`Added to the .bib: ${r.added.join(', ')}`); }
}

/** What the text cites that the folder's .bib lacks and the library can supply (a Zotero export, literature notes). The PDF is made
 *  with these entries from the cache; the .bib itself is only extended when the project is synced with Overleaf or zipped. */
async function refreshPending() {
  if (!host.latex || !host.latex.pendingBib) return;
  const cites = [...latexResult().cites];
  S.tex.pending = cites.length ? await host.latex.pendingBib(cites) : { found: [], entries: [], missing: [] };
}

/** Ask the vault for templates and .bib files again (they may have changed since), and compile for the PDF view. */
async function enterLatex() {
  if (!host.latex) return;
  try {
    const [templates, info] = await Promise.all([host.latex.templates(), host.latex.info()]);
    if (destroyed) return;
    S.tex.templates = templates;
    S.tex.info = info;
    await refreshPending();
    if (S.tex.preview === null && host.latex.previewTemplate) S.tex.preview = host.latex.previewTemplate.get() || '';
    // the .tex was changed outside (another editor) since Archipelago wrote it: offered to be taken over
    const file = await host.latex.readTex();
    S.tex.outside = !!(file.text && file.base && FromLatex.norm(file.text) !== FromLatex.norm(file.base) && FromLatex.norm(file.text) !== FromLatex.norm(latexResult().tex));
    if (S.level === 'pdf') {
      if (!S.tex.pdf) { const old = await host.latex.readPdf(); if (old && !S.tex.pdf) S.tex.pdf = old; }   // the last PDF while the new one is made
      if (S.tex.pdfFor !== pdfTex()) compile();
    }
  } catch (e) {
    setStatus('LaTeX: ' + (e.message || e));
  }
  requestRender();
}

/** Write the .tex and make the PDF. */
async function compile() {
  if (!host.latex || S.tex.compiling) return;
  if (!S.tex.info) { await enterLatex(); if (S.tex.compiling) return; }
  try { await refreshPending(); } catch { /* the warnings say what is missing */ }
  const src = pdfTex();   // the PDF is made in the cache: no file of the vault is written or asked about
  S.tex.compiling = true;
  setStatus(S.tex.installing ? 'Downloading Tectonic…' : 'Compiling…');
  requestRender();
  let res;
  try { res = await host.latex.compile(src, S.tex.pending && S.tex.pending.entries.length ? S.tex.pending.entries.join('\n\n') + '\n' : ''); } catch (e) { res = { ok: false, pdf: null, log: '', errors: [], message: String(e.message || e) }; }
  if (destroyed) return;
  S.tex.compiling = false;
  res.tex = src;
  res.errors = (res.errors || []).map(e => ({ ...e, key: e.line ? Latex.keyAtLine(src, e.line) : '' }));
  S.tex.result = res;
  if (res.ok && res.pdf) { S.tex.pdf = res.pdf; S.tex.pdfFor = src; }
  setStatus(res.ok ? 'PDF made ' + time() : res.needsTectonic ? 'Tectonic is not downloaded yet' : 'LaTeX failed');
  requestRender();
  // the document changed while it compiled: once more, so the PDF shows what is there
  if (S.level === 'pdf' && res.ok && pdfTex() !== src) compile();
}

/** Download the LaTeX engine (Tectonic) once, then compile. */
async function installEngine() {
  if (!host.latex || !host.latex.installTectonic || S.tex.installing) return;
  S.tex.installing = true;
  setStatus('Downloading Tectonic…');
  requestRender();
  try {
    await host.latex.installTectonic();
    S.tex.installing = false;
    setStatus('Tectonic is ready. The first PDF takes longer: it fetches the LaTeX packages it needs.');
    compile();
  } catch (e) {
    S.tex.installing = false;
    S.tex.result = { ok: false, pdf: null, log: '', errors: [], message: 'Tectonic could not be downloaded: ' + (e.message || e), tex: pdfTex() };
    setStatus('Download failed');
    requestRender();
  }
}

// ---- the way back: an edited .tex into the document ----

/** Take the edits of `theirs` (a .tex) over into the document, as one undo step; `base`: the .tex as last written, or null. */
const exportOpts = () => {
  const info = S.tex.info;
  return { template: templateOf().text, figurePath: host.latex.figurePath, figureWidthIn: host.latex.figureWidthIn, bibFiles: info ? info.bibFiles : [], bibKeys: knownKeys() };
};

function takeOver(theirs, base) {
  let res = { changed: 0, report: [] };
  act(() => { res = FromLatex.importTex(S.doc, { ...exportOpts(), theirs, base }); });
  S.tex.report = res.report.length ? res.report : null;
  return res;
}

const summary = res => {
  const n = k => res.report.filter(r => r.kind === k).length;
  return `${res.changed} change(s) taken over` + (n('skipped') ? `, ${n('skipped')} not` : '') + (n('conflict') ? `, ${n('conflict')} changed on both sides (the document's kept)` : '');
};

/** Take the edits of `theirs` over, asking first when its preamble (packages, macros, class) differs from the document's
 *  template: it becomes the template of this document (saved in latex_templates/), or the template replaces it. Nothing is
 *  changed when the user cancels, or when nobody can be asked (`auto`), or when the preamble cannot be a template: then null. */
async function takeOverAsking(theirs, base, auto) {
  const after = JSON.parse(JSON.stringify(S.doc));
  const dry = FromLatex.importTex(after, { ...exportOpts(), theirs, base });
  let template = null;
  if (dry.preamble != null) {
    if (auto) { setStatus('Auto-sync paused: the preamble differs from the template, sync by hand'); return null; }
    const c = await host.choose('The preamble was changed',
      "The packages and settings before the text (the preamble) differ from this document's template. Keep them as this document's template (saved in latex_templates/, other documents are not affected), or let the template replace them?",
      [{ label: 'Keep them as the template', value: 'keep', cta: true }, { label: 'Use the template', value: 'template', warning: true }]);
    if (!c) return null;
    if (c === 'keep') {
      template = FromLatex.templateFrom(after, theirs, exportOpts());
      if (!template) { host.notice('Archipelago: this preamble cannot be made a template (a {{…}} in it?). Put it into a file of latex_templates/ by hand.'); return null; }
    }
  }
  if (destroyed) return null;
  const name = template && await host.latex.saveTemplate(template);
  if (name) S.tex.templates = await host.latex.templates();
  const res = takeOver(theirs, base);
  if (name) act(() => Latex.setFront(S.doc, 'latex', name));
  return res;
}

/** The .tex in the document's folder was edited outside: its changes into the document, then the .tex written again from it
 *  (a version with changes that could not be taken over is kept beside it). */
async function takeOverFile() {
  const file = await host.latex.readTex();
  if (!file.text) { host.notice('Archipelago: there is no .tex yet'); return; }
  const res = await takeOverAsking(file.text, file.base, false);
  if (!res) return;
  if (res.report.some(r => r.kind !== 'applied')) await host.latex.keepCopy(file.text);
  await host.latex.writeTex(latexResult().tex);
  S.tex.outside = false;
  setStatus(summary(res));
  requestRender();
}

/** Before Archipelago writes the .tex (zip, sync; making a PDF writes nothing in the vault): if another editor changed it since, its changes are taken over first,
 *  or, when the user says so, it is overwritten (and kept beside it). False when the user cancels. */
async function guardOutside(auto) {
  const f = await host.latex.readTex(), norm = FromLatex.norm;
  if (!(f.text && f.base && norm(f.text) !== norm(f.base) && norm(f.text) !== norm(latexResult().tex))) return true;
  if (auto) return false;
  const c = await host.choose('The .tex was changed outside Archipelago',
    'Another editor changed the .tex since Archipelago wrote it. Take its changes over into the document first, or overwrite it with the document (a copy of it is kept as …_before_takeover.tex)?',
    [{ label: 'Take them over', value: 'take', cta: true }, { label: 'Overwrite it', value: 'overwrite', warning: true }]);
  if (c === 'take') { await takeOverFile(); return true; }
  if (c === 'overwrite') { await host.latex.keepCopy(f.text); S.tex.outside = false; return true; }
  return false;
}

const overleafProject = url => { const m = String(url).match(/git\.overleaf\.com\/([0-9a-f]{24})/i); return m ? 'https://www.overleaf.com/project/' + m[1] : null; };

async function connectOverleaf() {
  const input = await host.prompt('Connect to Overleaf',
    'The address of the Overleaf project (as the browser shows it) or its Git URL (Overleaf: Menu > Git). Start with "New Project > Upload Project" and the zip of this menu, or with an empty project.',
    'https://www.overleaf.com/project/…');
  if (input == null) return;
  const url = host.latex.overleafUrl(input);
  if (!url) { host.notice('Archipelago: that is not the address of an Overleaf project'); return; }
  change(() => Latex.setFront(S.doc, 'overleaf', url));
  await syncOverleaf();
}

/** Sync with the Overleaf project of the document (front matter `overleaf:`): the document's .tex goes up, Overleaf's edits
 *  come back into the document. */
async function syncOverleaf(auto = false) {
  const url = Latex.front(S.doc, 'overleaf');
  if (!url) return connectOverleaf();
  if (S.tex.syncing || !host.latex) return;
  const ol = host.latex.overleaf(url);
  if (!ol.lock()) { if (!auto) host.notice('Archipelago: this Overleaf project is being synced already (in another tab?)'); return; }
  S.tex.syncing = true;
  S.tex.lastSync = Date.now();
  // by itself (auto) nothing is asked: what needs a decision pauses until the user syncs by hand
  const ask = (...a) => (auto ? Promise.resolve(null) : host.choose(...a));
  const stop = () => setStatus(auto ? 'Auto-sync paused: it needs a decision, sync by hand' : 'Overleaf sync cancelled');
  const fail = (m, status) => { if (auto) setStatus('Auto-sync: ' + m); else { host.notice('Archipelago: ' + m); setStatus(status); } };
  setStatus('Syncing with Overleaf…');
  requestRender();
  try {
    await flush();
    if (!S.tex.info) await enterLatex();
    if (!(await guardOutside(auto))) { stop(); return; }
    await syncBib();
    // the view closed, or the file is in a conflict with a change from elsewhere: what is taken over would not be saved
    const gone = () => destroyed || S.conflict;
    if (gone()) { stop(); return; }
    let r = await ol.pull(latexResult().tex);
    if (r.ask === 'first') {
      const c = await ask('This Overleaf project has a text already',
        'It differs from this document. Take its text into the document (what can be taken over: text, titles, captions, tables, equations), or replace it on Overleaf with this document (Overleaf keeps the old one in its history)?',
        [{ label: "Take Overleaf's text", value: 'overleaf', cta: true }, { label: 'Replace it with this document', value: 'archipelago', warning: true }]);
      if (!c) { stop(); return; }
      r = await ol.pull(latexResult().tex, c);
    }
    if (r.ask === 'conflict') {
      const c = await ask('Changed here and on Overleaf',
        `The same lines of ${r.files.join(', ')} were changed in this document and on Overleaf since the last sync. Which should win where they collide? (Everything else of both is kept.)`,
        [{ label: "Overleaf's", value: 'theirs' }, { label: 'This document\'s', value: 'ours' }]);
      if (!c) { stop(); return; }
      r = await ol.pull(latexResult().tex, c);
    }
    if (r.error) { fail(r.error, 'Overleaf sync failed'); return; }
    if (r.ask) { stop(); return; }
    if (gone()) { await ol.rollback(); stop(); return; }
    let res = null;
    if (r.tex && FromLatex.norm(r.tex) !== FromLatex.norm(latexResult().tex)) {
      res = await takeOverAsking(r.tex, r.base, auto);
      if (!res) { await ol.rollback(); await host.latex.writeTex(latexResult().tex); if (!auto) stop(); return; }
    }
    await flush();
    await enterLatex();
    await syncBib();
    if (gone()) { await ol.rollback(); stop(); return; }
    const p = await ol.push(latexResult().tex);
    if (p.error) { fail(p.error, 'Overleaf sync failed'); return; }
    S.tex.outside = false;
    setStatus('Synced with Overleaf ' + time() + (res ? ': ' + summary(res) : ''));
    if (res && !auto && res.report.some(x => x.kind !== 'applied')) host.notice('Archipelago: ' + summary(res) + '. What was not taken over is listed in the LaTeX view; on Overleaf it is replaced by the document\'s version (Overleaf keeps the old one in its history).');
  } catch (e) {
    fail('the Overleaf sync failed: ' + (e.message || e), 'Overleaf sync failed');
  } finally {
    ol.unlock();
    S.tex.syncing = false;
    S.tex.lastSync = Date.now();
    requestRender();
  }
}

/** Write the project into the document's folder, as the zip and the Overleaf sync do first: the .tex, the .bib entries the library
 *  supplies, images from elsewhere and the latexmkrc. Making a PDF writes none of these; this is for working on the folder with
 *  other tools (latexmk, an editor). */
async function writeProjectFiles() {
  if (!host.latex) return;
  try {
    if (!(await enterLatexInfo()) || !(await guardOutside())) return;
    await syncBib();
    await host.latex.writeTex(latexResult().tex);
    S.tex.outside = false;
    host.notice('Archipelago: wrote the .tex, .bib and images into ' + S.tex.info.folder);
    setStatus('Project written ' + time());
  } catch (e) { host.notice('Archipelago: could not write the project files: ' + (e.message || e)); }
  requestRender();
}
/** The folder's .bib files and templates, looked at once. */
async function enterLatexInfo() {
  if (S.tex.info) return true;
  await enterLatex();
  return !!S.tex.info;
}

async function overleafZip() {
  try {
    if (!(await guardOutside())) return;
    await syncBib();
    const zip = await host.latex.exportZip(latexResult().tex);
    host.notice('Archipelago: ' + zip + '. At overleaf.com: New Project > Upload Project.');
    setStatus('Overleaf zip made ' + time());
  } catch (e) { host.notice('Archipelago: could not make the zip: ' + (e.message || e)); }
}

/** Every 20 s: the document with `overleaf-sync: <minutes>` in its front matter is synced when that long has passed (not while
 *  typing, not while another sync runs). */
function autoSyncTick() {
  const mins = S.doc && +Latex.front(S.doc, 'overleaf-sync');
  if (destroyed || !(mins > 0) || !host.latex || !host.latex.overleafUrl(Latex.front(S.doc, 'overleaf')) || S.tex.syncing) return;
  const now = Date.now();
  if (now - (S.tex.lastSync || 0) < mins * 60000 || now - lastChange < 8000 || S.conflict) return;
  syncOverleaf(true);
}
const autoSyncTimer = setInterval(autoSyncTick, 20000);

/** The menu row of auto-sync: a switch, and the interval when it is on (kept as `overleaf-sync: <minutes>` in the front matter). */
function autoSyncRow() {
  const row = h('div', { class: 'mrow autosync', title: 'Sync with Overleaf by itself while this note is open. It waits while you type and stops when it needs a decision (a conflict, a changed preamble); then sync by hand.' });
  const draw = () => {
    const mins = +Latex.front(S.doc, 'overleaf-sync') || 0;
    const set = v => { S.tex.lastSync = Date.now(); change(() => Latex.setFront(S.doc, 'overleaf-sync', v)); draw(); requestRender(); };
    const sw = h('input', { type: 'checkbox', class: 'sw' });
    sw.checked = mins > 0;
    sw.addEventListener('change', () => set(sw.checked ? '10' : ''));
    row.replaceChildren(h('label', { class: 'swl' }, sw, 'Auto-sync'));
    if (mins > 0) row.append(h('span', { class: 'mins' }, ...[5, 10, 15, 30, 60].map(m => h('button', { class: 'chip' + (m === mins ? ' on' : ''), onclick: () => set(String(m)) }, String(m))), ' min'));
  };
  draw();
  return row;
}

function overleafMenu(ev) {
  const url = Latex.front(S.doc, 'overleaf'), project = url && overleafProject(url);
  const items = url
    ? [{ label: S.tex.syncing ? 'Syncing…' : 'Sync with Overleaf', disabled: S.tex.syncing, action: () => syncOverleaf() },
      { node: autoSyncRow() },
      project && { label: 'Open the project on Overleaf', action: () => host.openLink(project, true) },
      { label: 'Disconnect from Overleaf', action: () => change(() => Latex.setFront(S.doc, 'overleaf', '')) }]
    : [{ label: 'Connect to Overleaf…', action: connectOverleaf }];
  const r = ev.currentTarget.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, [...items.filter(Boolean), { sep: true }, { label: 'Download a zip for Overleaf', action: overleafZip }]);
}

/** The paragraph or section a marker key names: `c12`, `s3`, or `s3/4` (a section's 4th paragraph). */
function byKey(key) {
  if (!key) return null;
  key = key.replace(/^cite:/, '');
  const m = key.match(/^(.+)\/(\d+)$/);
  for (const [si, s] of S.doc.sections.entries()) {
    const sk = s.sid || 's#' + (si + 1);
    if (sk === key) return { section: s };
    if (m && sk === m[1]) { const p = s.paragraphs[+m[2] - 1]; return p ? { section: s, p } : { section: s }; }
    const p = s.paragraphs.find(q => q.cid === key);
    if (p) return { section: s, p };
  }
  return null;
}

/** Show the paragraph (or section) of a marker key in Prose. */
function showInProse(key) {
  const f = byKey(key);
  if (!f) return;
  S.lastSection = f.section.id;
  S.tex.scrollTo = f.p ? f.p.id : null;
  if (f.p && C.isCard(f.p)) S.focusParagraph = f.p.id;
  setLevelInternal('prose');
}

/** A line of LaTeX with commands and comments marked. */
function colorLatex(l) {
  const out = [];
  let i = 0, buf = '';
  const push = (cls, t) => { if (buf) { out.push(buf); buf = ''; } out.push(h('span', { class: cls }, t)); };
  while (i < l.length) {
    if (l[i] === '%') { push('c', l.slice(i)); break; }
    if (l[i] === '\\') { const t = l.slice(i).match(/^\\([A-Za-z@]+\*?|.?)/)[0]; push('k', t); i += t.length; continue; }
    if (l[i] === '$') { push('m', '$'); i++; continue; }
    buf += l[i++];
  }
  if (buf) out.push(buf);
  return out;
}

/** Warnings of the export, the result of the last compile, and messages: clickable where they point somewhere. */
function latexNotes(r) {
  const res = S.tex.result, box = h('div', { class: 'texnotes' });
  const item = (cls, text, onClick, where) => {
    const el = h('div', { class: 'tn ' + cls + (onClick ? ' link' : '') }, h('span', { class: 'what' }, text), where && h('span', { class: 'where' }, where));
    if (onClick) el.addEventListener('click', onClick);
    box.append(el);
  };
  if (S.tex.outside) {
    item('outside', 'The .tex was changed outside Archipelago since it was written. Take its changes over into the document?', () => takeOverFile(), 'take over');
  }
  if (S.tex.report) {
    for (const x of S.tex.report) item(x.kind === 'applied' ? 'applied' : x.kind === 'conflict' ? 'error' : 'warn', x.text, x.key && byKey(x.key) ? () => showInProse(x.key) : null, x.key && byKey(x.key) ? 'show in Prose' : null);
    const done = h('div', { class: 'tn link where' }, 'Hide this list');
    done.addEventListener('click', () => { S.tex.report = null; requestRender(); });
    box.append(done);
  }
  for (const w of r.warnings) item('warn', w.text, w.key ? () => showInProse(w.key) : null, w.key ? 'show in Prose' : null);
  if (res && !res.ok) {
    if (res.needsTectonic) item('outside', S.tex.installing ? 'Downloading Tectonic…' : res.message, S.tex.installing ? null : () => installEngine(), S.tex.installing ? null : 'download and compile');
    else if (res.message) item('error pre', res.message);
    for (const e of res.errors) {
      const go = e.line && res.tex === r.tex ? () => { S.tex.scrollTo = { line: e.line }; if (S.level !== 'latex') setLevelInternal('latex'); else requestRender(); } : null;
      item('error', e.text, go, e.line ? 'line ' + e.line + (e.key ? ' · ' + e.key : '') : null);
      if (e.key && byKey(e.key)) box.lastChild.append(h('span', { class: 'where link', onclick: ev => { ev.stopPropagation(); showInProse(e.key); } }, 'show in Prose'));
    }
    if (res.log) {
      const t = h('div', { class: 'tn link where' }, S.tex.showLog ? 'Hide the log' : 'Show the log');
      t.addEventListener('click', () => { S.tex.showLog = !S.tex.showLog; requestRender(); });
      box.append(t);
      if (S.tex.showLog) box.append(h('pre', { class: 'texlog' }, res.log.split('\n').slice(-80).join('\n')));
    }
  }
  return box.childNodes.length ? box : null;
}

function latexBar(r, forPdf) {
  const L = host.latex, info = S.tex.info;
  const list = S.tex.templates || Latex.BUILTIN, cur = templateOf();
  // LaTeX view: the document's template (a change of the document, like any edit).
  // PDF view: the template this computer previews with. That choice changes nothing in the document, the vault or Overleaf; the
  // document's own template is the one marked. Only the button "Make it the document's template" (after a confirmation) does.
  const now = forPdf ? previewTemplateOf() : null;
  const sel = forPdf && L.previewTemplate
    ? h('select', { class: 'tsel', title: 'The template this computer shows the PDF with. The choice stays on this computer: the document, the .tex and Overleaf keep the document\'s template.' },
      list.map(t => h('option', { value: t.name, selected: t.name === (now ? now.name : cur.name) }, t.name === cur.name ? t.name + ' (the document\'s)' : 'Preview: ' + t.name)))
    : h('select', { class: 'tsel', title: 'LaTeX template (kept in the document as "latex:" in its front matter; your own are in latex_templates/)' },
      list.map(t => h('option', { value: t.name, selected: t.name === cur.name }, t.name)));
  if (forPdf && L.previewTemplate) sel.addEventListener('change', () => { S.tex.preview = sel.value === cur.name ? '' : sel.value; L.previewTemplate.set(S.tex.preview); compile(); });
  else sel.addEventListener('change', () => change(() => Latex.setFront(S.doc, 'latex', sel.value)));
  const adopt = now ? h('button', { class: 'tb', title: 'Make the preview template the document\'s template, for everyone who works on it', onclick: () => adoptPreview(now) }, 'Make it the document\'s template…') : null;
  const btn = (label, title, f, cls) => h('button', { class: 'tb' + (cls ? ' ' + cls : ''), title, onclick: f }, label);
  const right = h('div', { class: 'grp' });
  if (!forPdf) {
    right.append(...(S.tex.editing
      ? [btn('Apply', 'Take the edited LaTeX over into the document (one undo step; what cannot be taken over is listed)', applyEdit, 'primary'), btn('Cancel', 'Discard the edits', () => { S.tex.editing = false; S.tex.draft = null; requestRender(); })]
      : [btn('Edit', 'Edit the LaTeX here: Apply takes the text, titles, captions, tables and equations over into the document', () => { S.tex.editing = true; S.tex.draft = null; requestRender(); })]));
  }
  const auto = +Latex.front(S.doc, 'overleaf-sync') > 0;
  right.append(btn((S.tex.syncing ? 'Syncing…' : 'Overleaf') + (auto ? ' ⟳' : '') + ' ▾', Latex.front(S.doc, 'overleaf') ? 'Sync with Overleaf, auto-sync, or download a zip' : 'Connect to Overleaf, or download a zip to upload there', ev => overleafMenu(ev)));
  right.append(btn('⋯', 'More', ev => {
    const rr = ev.currentTarget.getBoundingClientRect();
    showMenu(rr.left, rr.bottom + 2, [
      { label: 'Copy the LaTeX', action: () => { win().navigator.clipboard.writeText(r.tex); setStatus('LaTeX copied'); } },
      { label: 'Write the project files into the folder (.tex, .bib, images)', action: () => writeProjectFiles() },
      { label: 'Save a clean copy (without %% apg comments)', action: async () => {
        const clean = Latex.toLatex(S.doc, { template: cur.text, figurePath: L.figurePath, figureWidthIn: L.figureWidthIn, bibFiles: info ? info.bibFiles : [], markers: false }).tex;
        await L.prepareProject();
        host.notice('Archipelago: saved ' + await L.saveClean(clean));
      } },
      ...(S.tex.pdf ? [{ label: 'Save a copy of the PDF in the document\'s folder', action: async () => host.notice('Archipelago: saved ' + await L.savePdf(S.tex.pdf)) }] : []),
      { sep: true },
      ...(info ? info.bibFiles.map(b => ({ label: `Open ${b}.bib (${info.bibKeys.size} entries)`, action: () => L.openPath(`${info.folder}/${b}.bib`) })) : []),
      { label: 'Show the folder', action: () => L.showFolder() },
    ]);
  }));
  right.append(btn(S.tex.compiling ? 'Compiling…' : forPdf ? 'Compile' : 'Compile ▸ PDF', 'Make the PDF (on this computer only: no file of the vault is written)', () => {
    if (!forPdf) setLevelInternal('pdf'); else compile();
  }, 'primary'));
  return h('div', { class: 'texbar' }, h('div', { class: 'grp' }, sel, adopt), right);
}

/** The preview template becomes the document's template, after the user has said yes: the note changes (`latex:`), so everyone who
 *  has the document gets it, and the next Overleaf sync brings its preamble there. */
async function adoptPreview(t) {
  const ok = await host.choose('Make "' + t.name + '" the document\'s template?',
    'The document and its .tex, which goes to Overleaf, would use this template from now on, for everyone who works on the document. '
    + 'The next Overleaf sync brings the new preamble to Overleaf. Everyone\'s own previews stay as they are.',
    [{ label: 'Make it the document\'s template', value: true, cta: true }]);
  if (ok !== true) return;
  S.tex.preview = '';
  host.latex.previewTemplate.set('');
  act(() => Latex.setFront(S.doc, 'latex', t.name));
  setStatus('The document\'s template is now ' + t.name);
  compile();
}

/** The edited LaTeX of the editor into the document. */
async function applyEdit() {
  const r = latexResult(), text = S.tex.draft == null ? r.tex : S.tex.draft;
  S.tex.editing = false; S.tex.draft = null;
  if (FromLatex.norm(text) === FromLatex.norm(r.tex)) { requestRender(); return; }
  const res = await takeOverAsking(text, r.tex, false);
  if (!res) { S.tex.editing = true; S.tex.draft = text; requestRender(); return; }   // back to the editor, nothing lost
  if (res.report.some(x => x.kind !== 'applied')) await host.latex.keepCopy(text);
  setStatus(summary(res));
  requestRender();
}

function renderLatex(main) {
  mapEl = null;
  if (!host.latex) { main.replaceChildren(h('div', { class: 'texempty' }, 'LaTeX is not available here.')); return; }
  const r = latexResult();
  let sc = shadow.getElementById('latex');
  const fresh = !sc, top = sc ? sc.scrollTop : 0;
  if (fresh) { sc = h('div', { id: 'latex', class: S.fade ? 'fade' : '' }); main.replaceChildren(sc); }
  if (S.tex.editing) {
    if (sc.querySelector('.texedit')) return;   // a redraw would take the text and the focus away
    const ta = h('textarea', { class: 'texedit', spellcheck: 'false', title: 'The marker lines (%% apg …) tell which paragraph a piece belongs to: keep them' });
    ta.value = S.tex.draft == null ? r.tex : S.tex.draft;
    ta.addEventListener('input', () => { S.tex.draft = ta.value; });
    sc.replaceChildren(latexBar(r, false), h('div', { class: 'texpage' }, latexNotes(r), ta));
    return;
  }
  const res = S.tex.result, errs = res && res.tex === r.tex ? res.errors : [];
  const errAt = new Map(errs.filter(e => e.line).map(e => [e.line, e.text]));
  const src = h('div', { class: 'texsrc', title: 'Double-click a line to edit its paragraph in Prose' });
  r.tex.split('\n').forEach((l, k) => {
    const n = k + 1;
    src.append(h('div', { class: 'tl' + (errAt.has(n) ? ' err' : '') + (l.startsWith('%% apg ') ? ' mk' : ''), data: { n: String(n) }, title: errAt.get(n) || null },
      h('span', { class: 'ln' }, String(n)), h('span', { class: 'tc' }, ...colorLatex(l))));
  });
  src.addEventListener('dblclick', e => {
    const row = e.target.closest('.tl');
    if (row) showInProse(Latex.keyAtLine(r.tex, +row.dataset.n));
  });
  sc.replaceChildren(latexBar(r, false), h('div', { class: 'texpage' }, latexNotes(r), src));
  if (S.tex.scrollTo && S.tex.scrollTo.line) {
    const row = src.querySelector(`.tl[data-n="${S.tex.scrollTo.line}"]`);
    S.tex.scrollTo = null;
    if (row) { row.scrollIntoView({ block: 'center' }); return; }
  }
  if (!fresh) sc.scrollTop = top;
}

let pdfShown = null, pdfJob = 0;

function renderPdf(main) {
  mapEl = null;
  if (!host.latex) { main.replaceChildren(h('div', { class: 'texempty' }, 'PDF is not available here.')); return; }
  const r = latexResult();
  let sc = shadow.getElementById('pdfview');
  if (!sc) {
    sc = h('div', { id: 'pdfview', class: S.fade ? 'fade' : '' }, h('div', { class: 'texbar' }), h('div', { class: 'pdfnotes' }), h('div', { class: 'pages' }));
    main.replaceChildren(sc);
    pdfShown = null;
  }
  sc.querySelector('.texbar').replaceWith(latexBar(r, true));
  const notes = latexNotes(r), stale = S.tex.pdf && S.tex.pdfFor !== pdfTex() && !S.tex.compiling;
  const pn = h('div', { class: 'pdfnotes' }, notes, stale && h('div', { class: 'tn stale' }, 'The document changed since this PDF was made. Compile to update it.'));
  sc.querySelector('.pdfnotes').replaceWith(pn);
  const pages = sc.querySelector('.pages');
  if (!S.tex.pdf) {
    pdfShown = null;
    pages.replaceChildren(h('div', { class: 'texempty' }, S.tex.compiling ? 'Making the PDF…' : 'No PDF yet.'));
  } else if (pdfShown !== S.tex.pdf) {
    drawPdf(sc, pages, S.tex.pdf);
  }
}

/** Draw every page of a PDF (with pdf.js, which Obsidian has) as wide as the view allows; the scroll position stays. */
async function drawPdf(sc, pages, data) {
  pdfShown = data;
  const job = ++pdfJob;
  try {
    const pdfjs = await host.latex.pdfjs();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
    const width = Math.max(300, Math.min(sc.clientWidth - 48, 1000)), dpr = win().devicePixelRatio || 1, out = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      if (job !== pdfJob || destroyed) return;
      const scale = width / page.getViewport({ scale: 1 }).width, vp = page.getViewport({ scale: scale * dpr });
      const c = D.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      c.style.width = width + 'px'; c.style.height = Math.floor(vp.height / dpr) + 'px';
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      out.push(h('div', { class: 'page' }, c));
    }
    if (job !== pdfJob || destroyed) return;
    const top = sc.scrollTop;
    pages.replaceChildren(...out);
    sc.scrollTop = top;
    if (typeof pdf.destroy === 'function') pdf.destroy();
  } catch (e) {
    if (job === pdfJob) pages.replaceChildren(h('div', { class: 'texempty' }, 'The PDF cannot be shown: ' + (e.message || e)));
  }
}


// ---- keyboard ----

// Only while the focus is inside this view. Obsidian's own shortcuts see everything else.
rootEl.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), text = isTextTarget(shadow.activeElement);
  if (e.key === 'Escape' && openMenus.length) { closeMenu(); e.stopPropagation(); return; }
  if (S.conflict) return;
  const run = f => { e.preventDefault(); e.stopPropagation(); f(); };
  if (mod && (k === 'z' || k === 'y')) {
    // Text fields keep their own undo while focused.
    if (text) return;
    return run(() => (k === 'y' || e.shiftKey ? redo() : undo()));
  }
  if (S.level !== 'map' || text) return;
  if (e.key === 'Escape' && (S.linkingFrom !== null || S.selectedLink)) {
    return run(() => { S.linkingFrom = null; S.selectedLink = null; S.linkPointer = null; layoutMap(); });
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (S.selectedLink) return run(() => { removeLink(S.selectedLink); layoutMap(); });
    if (S.selection.size) return run(deleteSelection);
  }
  if (mod && k === 'a') return run(() => { selectAll(); layoutMap(); });
  // Ctrl+S, Ctrl+G and Ctrl+Shift+G are registered with the view's scope instead: Obsidian's own
  // Ctrl+S (save) and Ctrl+G (the graph) would take them before they reach this listener.
  // Zoom with the plain keys: Ctrl+= and Ctrl+- are Obsidian's own.
  if (!mod && !e.altKey && (e.key === '+' || e.key === '=')) return run(() => zoomKey(1.2));
  if (!mod && !e.altKey && e.key === '-') return run(() => zoomKey(1 / 1.2));
  if (!mod && !e.altKey && e.key === '0') return run(fitKey);
});
// Text fields keep their native menu; elsewhere the view has its own menus.
rootEl.addEventListener('contextmenu', e => { if (!isTextTarget(shadow.activeElement) || !isTextTarget(e.target)) e.preventDefault(); });
// Pinching and Ctrl+scroll must not zoom Obsidian itself.
rootEl.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });
// Ctrl+V with an image on the clipboard adds a figure (Map and Prose). A clipboard with text, in a text field, pastes the text.
rootEl.addEventListener('paste', e => {
  if (S.conflict || (S.level !== 'map' && S.level !== 'prose')) return;
  const files = clipboardImages(e);
  if (!files.length) return;
  if (isTextTarget(e.target) && e.clipboardData.getData('text/plain')) return;
  e.preventDefault(); e.stopPropagation();
  pasteImages(files);
});
// A click on the map gives this view the keyboard focus (the map itself has no focusable element).
rootEl.addEventListener('pointerdown', e => {
  if (openMenus.length && !e.target.closest('.menu')) closeMenu();
  // a menu or a suggestion keeps the focus where it is (the text field being edited), or a map card would stop editing
  if (e.target.closest('.menu, .suggest')) return;
  if (!isTextTarget(e.target) && shadow.activeElement !== rootEl) rootEl.focus({ preventScroll: true });
}, true);

// ---- the view's handle on this app ----

function setLevel(l, quiet) {
  if (!['map', 'prose', 'latex', 'pdf'].includes(l)) return;
  if (quiet) { S.level = l; if (l === 'latex' || l === 'pdf') enterLatex(); return; }
  setLevelInternal(l);
}

function applyTheme() { hostEl.classList.toggle('dark', !!host.isDark()); }
applyTheme();

function destroy() {
  destroyed = true;
  clearTimeout(saveTimer); clearTimeout(fitTimer); clearInterval(autoSyncTimer);
  graveyard.clear();
  if (resizeObs) resizeObs.disconnect();
  closeMenu();
  hostEl.remove();
}

return {
  load, flush, destroy, diskChanged, applyTheme, setLevel, getLevel: () => S.level, fit: fitKey,
  compile: () => compile(), latexText: () => latexResult().tex, syncOverleaf: () => syncOverleaf(),
  /** A style shortcut (b, i, s, hl) pressed with the focus in a text field that has styles and a selection: true when applied. */
  styleKey: kind => {
    const a = shadow.activeElement;
    if (a && a.tagName === 'TEXTAREA' && a.dataset.styleable === '1' && a.selectionStart !== a.selectionEnd) { applyStyle(a, kind); return true; }
    // on the map, with one claim card selected and nothing being edited: the whole claim
    if (S.level === 'map' && !isTextTarget(a) && S.selection.size === 1) {
      const id = [...S.selection][0], p = paragraph(id), n = idea(id);
      if ((p && C.isCard(p) && p.claim) || (n && n.text)) { styleClaim(id, kind); return true; }
    }
    return false;
  },
  writeProject: writeProjectFiles,
  group: groupSelection, ungroup: ungroupSelection, undo, redo, check: () => C.check(currentText()),
  hasConflict: () => !!S.conflict, resolveConflicts, chooseAll, saveNow: save,
  /** The open text when a conflict is waiting (to keep it somewhere before the view closes), else null. */
  unsavedText,
  /** Ctrl+S: write now. */
  saveKey: () => flush().then(() => setStatus('Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))),
  /** Whether a keyboard shortcut for the map applies right now (a text field keeps its keys). */
  mapKeysApply: () => S.level === 'map' && !S.conflict && !isTextTarget(shadow.activeElement),
  // for tests
  S, shadow, host,
};
}
