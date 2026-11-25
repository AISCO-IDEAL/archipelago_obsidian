// Archipelago for Obsidian: the plugin. Opens documents in a Map / Prose view (see ui.js) and
// connects it to the vault. The document model is in core.js.
//
// A document is a Markdown file (.md) that carries Archipelago's format line, or a legacy .apg file.
// Sync tools merge Markdown as text, which they do not for unknown file types, so .md is the format
// for new documents. Obsidian would open such a file as a note: setViewState of every leaf is
// wrapped so that a document goes to this view instead (see `redirect`).

const {
  Plugin, FileView, FuzzySuggestModal, MarkdownView, Modal, Notice, Scope, TFile, TFolder, WorkspaceLeaf, PluginSettingTab, Setting, addIcon, normalizePath, loadPdfJs, requestUrl,
} = require('obsidian');

const VIEW_TYPE = 'archipelago-view';
const EXT = 'apg';           // legacy documents, which sync tools treat as binary
const DOC_EXT = 'md';        // what new documents are
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'];
const DEFAULTS = { autosaveSeconds: 1.5, archipelagoFolder: 'Archipelago' };
const OLD_DEFAULT_FOLDER = '99_attachments_c_docs/archipelago';   // the default before 0.3
/** The id of the Overleaf token in Obsidian's secret storage (the system's keychain), where Obsidian has one (1.11.4). */
const TOKEN_ID = 'archipelago-overleaf-token';
const TEMPLATE_DIR = 'latex_templates';   // in the Archipelago folder
const LEVELS = ['map', 'prose', 'latex', 'pdf'];

/** Three islands joined by a noodle, on Obsidian's 100x100 icon grid. */
const ICON_SVG = '<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">'
  + '<rect x="8" y="14" width="34" height="28" rx="8"/><rect x="58" y="14" width="34" height="28" rx="8"/>'
  + '<rect x="33" y="60" width="34" height="28" rx="8"/><path d="M42 28h16M25 42v6c0 6 8 12 8 12M75 42v6c0 6-8 12-8 12" stroke-dasharray="1 0"/></g>';

// ---- paths in the vault ----

const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const extOf = name => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');
const stemOf = name => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name);

/** `rel` resolved against folder `dir`; '' when it leaves the vault. */
function joinPath(dir, rel) {
  const parts = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '..') { if (!parts.length) return ''; parts.pop(); }
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

/** The path of `to` as seen from folder `fromDir` (`../x/y.png`). */
function relPath(fromDir, to) {
  const a = fromDir ? fromDir.split('/') : [], b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
}

/** A path as written in the document: spaces and parentheses would end a Markdown image link early. */
const encodeRef = p => p.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };

/** The vault file a figure path of the document `file` points at: relative to the document first, then the way
 *  Obsidian resolves a link (shortest path, from the vault root). */
function findImage(app, file, rel) {
  if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('/')) return null;
  for (const candidate of [rel, safeDecode(rel)]) {
    const f = app.vault.getAbstractFileByPath(normalizePath(joinPath(dirOf(file.path), candidate)));
    if (f instanceof TFile) return f;
  }
  return app.metadataCache.getFirstLinkpathDest(safeDecode(rel), file.path) || null;
}

async function ensureFolder(app, path) {
  if (!path || app.vault.getAbstractFileByPath(path)) return;
  await ensureFolder(app, dirOf(path));
  try { await app.vault.createFolder(path); } catch { /* created in the meantime */ }
}

const sameBytes = (a, b) => { const x = new Uint8Array(a), y = new Uint8Array(b); return x.length === y.length && x.every((v, i) => v === y[i]); };

/** A folder setting as a vault path: no leading or trailing slash, no way out of the vault. '' when it is empty. */
function cleanFolder(f) {
  const parts = String(f || '').replace(/\\/g, '/').split('/').map(x => x.trim()).filter(x => x && x !== '.');
  return parts.includes('..') ? '' : parts.join('/');
}

/** The name of a document's subfolder in the figure folder. */
const figureSubfolder = doc => doc.basename.replace(/[\\/:*?"<>|#^[\]]/g, '_').trim() || 'document';

/** The Archipelago folder of the settings (a folder of the vault; the default when the setting is empty or leaves the vault).
 *  It holds a subfolder per document and `latex_templates`. */
const archRoot = settings => cleanFolder(settings.archipelagoFolder) || cleanFolder(DEFAULTS.archipelagoFolder);

/** The folder of a document's own files: `figures/` with its images, `<document>.bib`, and the .tex and .pdf made from it. */
const docFolder = (doc, settings) => `${archRoot(settings)}/${figureSubfolder(doc)}`;
/** The name (without extension) of a document's .tex, .bib and .pdf: the document's name made safe for LaTeX and Overleaf. */
const docSlug = doc => fileSlug(doc.basename);

/** Whether what Obsidian had found in a deleted note is a document's: its first block, after the front matter, is an
 *  HTML comment, which is where the format line stands. */
function looksLikeDocument(cache) {
  const first = cache && (cache.sections || []).find(x => x.type !== 'yaml');
  return !!first && first.type === 'html';
}

/** The vault path a figure path of document `doc` points at, whether or not there is a file there. */
function figureTarget(app, doc, rel) {
  if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('/')) return '';
  const found = findImage(app, doc, rel);
  return found ? found.path : normalizePath(joinPath(dirOf(doc.path), safeDecode(rel)));
}

/** The vault paths of the images a document text refers to (those that exist). */
function figureFiles(app, doc, text) {
  const out = new Set();
  for (const s of Core.parse(text).sections) for (const p of s.paragraphs) {
    const f = Core.figure(p), file = f && findImage(app, doc, f.path);
    if (file) out.add(file.path);
  }
  return out;
}

/** Whether a note or another document links to this file (the cache of links knows what Obsidian found). */
function linkedElsewhere(app, file, doc) {
  for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) if (source !== doc.path && targets[file.path]) return true;
  return false;
}

/** Put image bytes in the `figures/` folder of the document's subfolder in the Archipelago folder (`root`) and give the
 *  path as seen from the document. The same image stored twice is one file; another image with the same name gets a number. */
async function storeFigure(app, doc, name, data, root) {
  const clean = name.replace(/[\\/:*?"<>|#^[\]]/g, '_') || 'figure.png';
  const dir = `${root}/${figureSubfolder(doc)}/figures`, stem = stemOf(clean), ext = extOf(clean);
  let target;
  for (let n = 0; ; n++) {
    const candidate = normalizePath(`${dir}/${stem}${n ? ' ' + n : ''}${ext ? '.' + ext : ''}`), there = app.vault.getAbstractFileByPath(candidate);
    if (!there || (there instanceof TFile && sameBytes(await app.vault.readBinary(there), data))) { target = candidate; break; }
  }
  const existing = app.vault.getAbstractFileByPath(target);
  if (!(existing instanceof TFile)) {
    await ensureFolder(app, dirOf(target));
    try {
      await app.vault.createBinary(target, data);
    } catch (e) {
      // the same name was created in the meantime (two drops at once): fine if it is the same image
      const now = app.vault.getAbstractFileByPath(target);
      if (!(now instanceof TFile) || !sameBytes(await app.vault.readBinary(now), data)) throw e;
    }
  }
  return { rel: encodeRef(relPath(dirOf(doc.path), target)), name: stemOf(clean) };
}

// ---- LaTeX and PDF ----
// The PDF is made with Tectonic in a build folder outside the vault (see compileNow): making it writes nothing into the vault.
// The .tex, the .bib entries, images from elsewhere and a latexmkrc are written into the document's folder only when the project
// is synced with Overleaf or zipped (writeProject); a PDF only when the user asks for a copy.

// Files of types Obsidian does not know (.bib, .tex, .cls, …) are not in the vault's index unless the setting "Detect all file
// extensions" is on (and not at all after a restart without it), so everything of that kind goes through the adapter, which
// reads the disk itself.
const adapterOf = app => app.vault.adapter;
async function fileExists(app, path) { try { return await adapterOf(app).exists(path); } catch { return false; } }
async function makeDirs(app, path) {
  if (!path || await fileExists(app, path)) return;
  await makeDirs(app, dirOf(path));
  try { await adapterOf(app).mkdir(path); } catch { /* made in the meantime */ }
}
async function readText(app, path) { try { return await adapterOf(app).read(path); } catch { return ''; } }
/** Write a text file unless it holds that text already. */
async function writeText(app, path, text) {
  await makeDirs(app, dirOf(path));
  if (await fileExists(app, path) && await readText(app, path) === text) return;
  await adapterOf(app).write(path, text);
}
async function writeBinary(app, path, data) {
  await makeDirs(app, dirOf(path));
  await adapterOf(app).writeBinary(path, data);
}
/** A file or folder of the vault to the trash the user chose in Obsidian. When the system's trash does not take it (a
 *  sandbox without a trash portal: Obsidian then leaves it in place), it goes to the vault's .trash instead. */
async function toTrash(app, f) {
  const path = f.path;
  try { await app.fileManager.trashFile(f); } catch { /* tried below */ }
  if (await adapterOf(app).exists(path)) await adapterOf(app).trashLocal(path);
}

/** { files, folders } (full paths) of a folder, from the disk. */
async function listDir(app, dir) { try { return await adapterOf(app).list(dir); } catch { return { files: [], folders: [] }; } }
const baseOf = p => p.slice(p.lastIndexOf('/') + 1);

/** A name for files that LaTeX, BibTeX and Overleaf take: no blanks or special characters (accents are dropped). */
const fileSlug = name => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'document';

// ---- Tectonic: the LaTeX engine Archipelago downloads itself ----
// One program (XeTeX and BibTeX inside), downloaded once from its GitHub release and checked against the SHA-256 below. It
// fetches the LaTeX packages a document needs from its bundle, a fixed TeX Live snapshot per Tectonic version, and keeps them
// in a cache: everyone with the same plugin version typesets with the same packages, and nobody installs TeX.
const TECTONIC_VERSION = '0.17.0';
const TECTONIC_ASSETS = {   // platform-arch -> [target, archive, sha256]
  'linux-x64': ['x86_64-unknown-linux-musl', 'tar.gz', '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7'],
  'linux-arm64': ['aarch64-unknown-linux-musl', 'tar.gz', 'b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8'],
  'darwin-x64': ['x86_64-apple-darwin', 'tar.gz', '7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80'],
  'darwin-arm64': ['aarch64-apple-darwin', 'tar.gz', 'a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667'],
  'win32-x64': ['x86_64-pc-windows-msvc', 'zip', 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f'],
};
/** Under $HOME, which a Flatpak Obsidian sees too: the program, and the packages it fetched (shared by all vaults). */
const tectonicHome = () => require('path').join(require('os').homedir(), '.cache', 'archipelago-tectonic');
const tectonicExe = () => require('path').join(tectonicHome(), TECTONIC_VERSION, process.platform === 'win32' ? 'tectonic.exe' : 'tectonic');
const tectonicInstalled = () => { try { return require('fs').statSync(tectonicExe()).isFile(); } catch { return false; } };
const tectonicAsset = () => TECTONIC_ASSETS[process.platform + '-' + process.arch] || null;

/** The file `name` of a .tar.gz, or null. */
function fromTarGz(buf, name) {
  const tar = require('zlib').gunzipSync(buf);
  for (let off = 0; off + 512 <= tar.length;) {
    const head = tar.subarray(off, off + 512);
    if (head.every(b => b === 0)) break;
    const str = (a, b) => head.subarray(a, b).toString('latin1').replace(/\0[^]*$/, '');
    const full = (str(345, 500) ? str(345, 500) + '/' : '') + str(0, 100), size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(head[156] || 48);
    if ((type === '0' || type === '\0') && full.replace(/^.*\//, '') === name) return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}
/** The file `name` of a .zip, or null. */
function fromZip(buf, name) {
  const zlib = require('zlib');
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  for (let k = 0, off = buf.readUInt32LE(eocd + 16); k < count; k++) {
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), nlen = buf.readUInt16LE(off + 28);
    const xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), local = buf.readUInt32LE(off + 42);
    const file = buf.subarray(off + 46, off + 46 + nlen).toString('utf8');
    if (file.replace(/^.*[\\/]/, '') === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), data = buf.subarray(start, start + csize);
      return method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    }
    off += 46 + nlen + xlen + clen;
  }
  return null;
}

/** Download Tectonic into tectonicHome() unless it is there, check it, unpack it. Throws with a message for the user.
 *  One download at a time (the settings and every open document may ask), and a program that is there is never replaced:
 *  a compile may be running it. */
let tectonicDownload = null;
function installTectonic() {
  if (tectonicInstalled()) return Promise.resolve();
  if (!tectonicDownload) tectonicDownload = downloadTectonic().finally(() => { tectonicDownload = null; });
  return tectonicDownload;
}
async function downloadTectonic() {
  const fs = require('fs'), path = require('path'), a = tectonicAsset();
  if (!a) throw new Error(`there is no Tectonic for this computer (${process.platform}, ${process.arch})`);
  const [target, kind, sha] = a, file = `tectonic-${TECTONIC_VERSION}-${target}.${kind}`;
  const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/${file}`;
  const r = await requestUrl({ url, throw: false });
  if (r.status !== 200) throw new Error(`GitHub answered ${r.status} for ${file}`);
  const buf = Buffer.from(r.arrayBuffer);
  const got = require('crypto').createHash('sha256').update(buf).digest('hex');
  if (got !== sha) throw new Error(`${file} is not the expected file (SHA-256 ${got.slice(0, 12)}…, expected ${sha.slice(0, 12)}…): not used`);
  const exe = path.basename(tectonicExe()), data = kind === 'zip' ? fromZip(buf, exe) : fromTarGz(buf, exe);
  if (!data || !data.length) throw new Error(`${file} has no ${exe}`);
  fs.mkdirSync(path.dirname(tectonicExe()), { recursive: true });
  const tmp = tectonicExe() + '.part';
  fs.writeFileSync(tmp, data, { mode: 0o755 });
  fs.renameSync(tmp, tectonicExe());
}

/** For Overleaf (Overleaf reads it from the project): compile with XeLaTeX, the engine of Tectonic, so Overleaf's PDF is set
 *  like the one in Obsidian. Written (with the .tex) when the project is synced or zipped, and only when the folder has none,
 *  so one made by hand stays. */
const LATEXMKRC = `# Written by Archipelago: compile with XeLaTeX, like Archipelago's engine (Tectonic, which is XeTeX).
# Delete this file to use the compiler chosen in Overleaf's menu again (Archipelago writes it again only while it is missing).
$pdflatex = 'xelatex %O %S';
$lualatex = 'xelatex %O %S';
`;

/** Where programs (git) are, for an Obsidian started from the desktop without the shell's PATH (macOS). */
const EXTRA_PATH = { darwin: ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin'], linux: ['/usr/local/bin'], win32: [] };

/** Run a program to its end: { code, out } (stdout and stderr together). `env`: added to Obsidian's; a null value removes one. */
function runTool(cmd, args, cwd, env, timeout = 180000) {
  const cp = require('child_process'), path = require('path');
  const PATH = [process.env.PATH || '', ...(EXTRA_PATH[process.platform] || [])].filter(Boolean).join(path.delimiter);
  return new Promise(resolve => {
    let out = '', child;
    try {
      const all = { ...process.env, PATH, ...env };
      for (const k of Object.keys(all)) if (all[k] == null) delete all[k];   // null: not passed on
      child = cp.spawn(cmd, args, { cwd, env: all, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { resolve({ code: -1, out: String(e.message || e) }); return; }
    const timer = setTimeout(() => { out += `\n(stopped after ${timeout / 1000} s)`; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => { out += String(e.message || e); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
  });
}

// BibTeX takes no % comments: an at sign anywhere starts an entry, so this line must not have one.
const BIB_HEADER = name => `% Bibliography of ${name}. Entries are copied here from the bib files in the Archipelago folder (a Zotero export), or built from the literature notes, when the text cites them.\n`;
const OLD_BIB_HEADER = /^% Bibliography of [^\n]*\[@key\][^\n]*\n% Entries are copied here[^\n]*\n/;

// ---- a zip file (stored, not compressed) for Overleaf's "Upload Project" ----

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

/** A zip file of `entries` ([{ name, data: Uint8Array }]), as a Buffer. */
function makeZip(entries) {
  const now = new Date(), time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), data = Buffer.from(e.data), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data); centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const hashOf = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };

class ImageModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.chosen = false;
    this.setPlaceholder('Choose an image from the vault');
  }
  getItems() {
    return this.app.vault.getFiles().filter(f => IMAGE_EXT.includes(f.extension.toLowerCase())).sort((a, b) => b.stat.mtime - a.stat.mtime);
  }
  getItemText(f) { return f.path; }
  onChooseItem(f) { this.chosen = true; this.onChoose(f); }
  onClose() { super.onClose(); setTimeout(() => { if (!this.chosen) this.onChoose(null); }, 0); }
}

/** A question in Obsidian's own dialog with a button per choice ([{ label, value, warning }]); resolves to the value of the
 *  button pressed, or null when the dialog is closed. */
function chooseDialog(app, title, text, choices) {
  return new Promise(resolve => {
    const m = new Modal(app);
    let answered = false;
    const answer = v => { answered = true; resolve(v); m.close(); };
    m.titleEl.setText(title);
    for (const para of String(text).split('\n\n')) m.contentEl.createEl('p', { text: para });
    const row = m.contentEl.createDiv({ cls: 'modal-button-container' });
    for (const c of choices) row.createEl('button', { text: c.label, cls: c.warning ? 'mod-warning' : c.cta ? 'mod-cta' : '' }).addEventListener('click', () => answer(c.value));
    row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => answer(null));
    m.onClose = () => { if (!answered) resolve(null); };
    m.open();
  });
}
const confirmDialog = (app, title, text, yes) => chooseDialog(app, title, text, [{ label: yes, value: true, warning: true }]).then(v => v === true);

/** A line of text asked in Obsidian's own dialog; resolves to it, or null. */
function promptDialog(app, title, text, placeholder, value = '') {
  return new Promise(resolve => {
    const m = new Modal(app);
    let answered = false;
    const answer = v => { answered = true; resolve(v); m.close(); };
    m.titleEl.setText(title);
    m.contentEl.createEl('p', { text });
    const input = m.contentEl.createEl('input', { type: 'text', placeholder, value });
    input.style.width = '100%';
    input.addEventListener('keydown', e => { if (e.key === 'Enter') answer(input.value.trim()); });
    const row = m.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: 'OK', cls: 'mod-cta' }).addEventListener('click', () => answer(input.value.trim()));
    row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => answer(null));
    m.onClose = () => { if (!answered) resolve(null); };
    m.open();
    setTimeout(() => input.focus(), 0);
  });
}

// ---- the view ----

class ArchipelagoView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.level = 'map';
    this.ui = null;
    this.navigation = true;
    // Obsidian's own Ctrl+G opens the graph and Ctrl+S saves a note. A view's scope is asked first, so Ctrl+S is ours while
    // the view is active, and Ctrl+G when the map has the keyboard. In a text field, or in Prose, Ctrl+G stays Obsidian's.
    if (!this.scope) this.scope = new Scope(this.app.scope);
    this.scope.register(['Mod'], 'g', () => { if (this.ui && this.ui.mapKeysApply()) { this.ui.group(); return false; } return true; });
    this.scope.register(['Mod'], 's', () => { if (this.ui) { this.ui.saveKey(); return false; } return true; });
    // Obsidian's own Ctrl+B and Ctrl+I (bold, italic of the editor) are ours too, for the text styles of a field with a selection
    for (const [mods, k, kind] of [[['Mod'], 'b', 'b'], [['Mod'], 'i', 'i'], [['Mod', 'Shift'], 'x', 's'], [['Mod', 'Shift'], 'h', 'hl']]) {
      this.scope.register(mods, k, () => !(this.ui && this.ui.styleKey(kind)));
    }
    this.scope.register(['Mod', 'Shift'], 'g', () => { if (this.ui && this.ui.mapKeysApply()) { this.ui.ungroup(); return false; } return true; });
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file ? this.file.basename : 'Archipelago'; }
  getIcon() { return 'archipelago'; }
  // Only the legacy extension. A .md file is a document only when its content says so, and `redirect` decides
  // that. If this said yes for md, Obsidian would load any note opened in the tab of a document into this view,
  // and the view would write to it.
  canAcceptExtension(extension) { return extension === EXT; }

  getState() { return { ...super.getState(), level: this.ui ? this.ui.getLevel() : this.level }; }
  async setState(state, result) {
    if (state && LEVELS.includes(state.level)) {
      this.level = state.level;
      if (this.ui) this.ui.setLevel(this.level);
    }
    this.force = !!(state && state.force);   // "Open as Archipelago document" on a note: the one way to a note
    await super.setState(state, result);
  }

  onPaneMenu(menu, source) {
    super.onPaneMenu(menu, source);
    if (this.file && this.file.extension === DOC_EXT) {
      menu.addItem(i => i.setTitle('Open as Markdown').setIcon('file-text').setSection('pane').onClick(() => this.plugin.openAsMarkdown(this.leaf)));
    }
  }

  async onLoadFile(file) {
    await this.dropUi();
    // Whatever the way a file got here, a note is never loaded: this view would add the format line to it.
    const force = this.force;
    this.force = false;
    if (!(await this.plugin.mayShow(file, force))) {
      this.plugin.rawLeaves.add(this.leaf);
      setTimeout(() => this.leaf.setViewState({ type: 'markdown', state: { file: file.path } }), 0);
      return;
    }
    this.contentEl.addClass('apg-content');
    this.ui = createApp(this.host(), this.contentEl);
    this.ui.setLevel(this.level, true);
    await this.ui.load();
    this.plugin.ensureDocFolder(file).catch(() => {});   // its subfolder, figures/ and .bib
  }
  async onUnloadFile() { await this.dropUi(); }
  async onClose() { await this.dropUi(); }

  async dropUi() {
    const ui = this.ui;
    if (!ui) return;
    this.ui = null;
    const gone = this.file && this.app.vault.getAbstractFileByPath(this.file.path) !== this.file;   // deleted: nothing to write to
    if (gone) { /* the document was deleted while it was open */ }
    else if (ui.hasConflict()) await this.plugin.keepUnsaved(this.file, ui.unsavedText());
    else await ui.flush();
    ui.destroy();
  }

  onload() {
    this.registerEvent(this.app.vault.on('modify', f => { if (this.ui && this.file && f.path === this.file.path) this.ui.diskChanged(); }));
    this.registerEvent(this.app.workspace.on('css-change', () => { if (this.ui) this.ui.applyTheme(); }));
    // Another tab came to the front: write what is pending now rather than after the delay.
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => { if (this.ui && leaf !== this.leaf) this.ui.flush(); }));
  }

  host() {
    // The file is taken once: a view that is being closed or navigated must never write into whatever file it shows next.
    const view = this, app = this.app, plugin = this.plugin, file = this.file;
    return {
      css: APG_CSS,
      settings: () => plugin.settings,
      read: () => app.vault.read(file),
      process: fn => app.vault.process(file, fn),
      history: plugin.historyOf(file),
      notice: text => new Notice(text, 10000),
      name: () => file.name,
      figureTarget: rel => figureTarget(app, file, rel),
      exists: path => !!app.vault.getAbstractFileByPath(path),
      gone: () => app.vault.getAbstractFileByPath(file.path) !== file,
      restoreFigure: async (path, data) => { await ensureFolder(app, dirOf(path)); await app.vault.createBinary(path, data); },
      tidyFigures: (prev, next) => plugin.tidyFigures(file, prev, next),
      imageURL: rel => { const f = findImage(app, file, rel); return f ? app.vault.getResourcePath(f) : null; },
      isDark: () => document.body.classList.contains('theme-dark'),
      importImages: async files => {
        const out = [];
        for (const f of files) out.push(await storeFigure(app, file, f.name, await f.arrayBuffer(), archRoot(plugin.settings)));
        return out;
      },
      // An image that is in the vault already is referred to where it is: it syncs with the vault, no copy.
      pickImage: () => new Promise(resolve => {
        new ImageModal(app, f => resolve(f ? { rel: encodeRef(relPath(dirOf(file.path), f.path)), name: f.basename } : null)).open();
      }),
      latex: plugin.latexHost(file),
      choose: (title, text, choices) => chooseDialog(app, title, text, choices),
      prompt: (title, text, placeholder, value) => promptDialog(app, title, text, placeholder, value),
      suggest: plugin.suggestHost(file),
      openLink: (target, url) => {
        if (url) { if (/^https?:|^mailto:/i.test(target)) window.open(target); return; }
        app.workspace.openLinkText(target.replace(/\.md$/i, ''), file.path, false);
      },
    };
  }
}

// ---- creating documents ----

/** A free file name in `folder`: `Untitled.md`, `Untitled 1.md`, … */
function freePath(app, folder, stem, ext = DOC_EXT) {
  const dir = folder && folder.path !== '/' ? folder.path : '';
  for (let n = 0; ; n++) {
    const path = normalizePath(`${dir}/${stem}${n ? ' ' + n : ''}.${ext}`);
    if (!app.vault.getAbstractFileByPath(path)) return path;
  }
}

function newDocumentText() {
  const d = Core.newDoc();
  d.sections.push(Core.newSection('Untitled', { x: 40, y: 80 }));
  Core.assignIDs(d);
  return Core.serialize(d);
}

async function openFile(app, file, newTab) {
  const leaf = app.workspace.getLeaf(newTab ? 'tab' : false);
  await leaf.openFile(file);
  app.workspace.setActiveLeaf(leaf, { focus: true });
  return leaf;
}

// ---- settings ----

class ArchipelagoSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl;
    el.empty();
    new Setting(el)
      .setName('Save delay')
      .setDesc('Seconds between your last change and the file being written. Sync tools upload on every write, so a longer delay means fewer versions.')
      .addSlider(s => s.setLimits(0.5, 10, 0.5).setValue(this.plugin.settings.autosaveSeconds).setDynamicTooltip()
        .onChange(async v => { this.plugin.settings.autosaveSeconds = v; await this.plugin.saveSettings(); }));
    new Setting(el)
      .setName('Archipelago folder')
      .setDesc('A folder of the vault where Archipelago keeps what belongs to its documents. Every document gets a subfolder named like it, with figures/ (images dropped on a map), <document>.bib (its bibliography) and, when synced with Overleaf or zipped, <document>.tex. A PDF is made in a cache on this computer; a copy goes into the folder only when you ask for it. LaTeX templates are in latex_templates/ in this folder: .tex files with placeholders such as {{title}} and {{body}}, which a document picks in its LaTeX view; class and style files there are found when compiling. An image that is deleted from its document is moved to the trash (unless a note or another document links to it); images that are in the vault already are used where they are.')
      .addText(t => t.setPlaceholder(DEFAULTS.archipelagoFolder).setValue(this.plugin.settings.archipelagoFolder)
        .onChange(async v => { this.plugin.settings.archipelagoFolder = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(el).setName('LaTeX and PDF').setHeading();
    new Setting(el)
      .setName('LaTeX engine')
      .setDesc(`Archipelago makes the PDF with Tectonic ${TECTONIC_VERSION}: one program, downloaded once from GitHub (about 10 to 20 MB, checked against its SHA-256), that fetches the LaTeX packages a document needs the first time it is compiled. Nothing to install, and the same result on every computer. It is XeTeX, so Archipelago also puts a latexmkrc into each document's folder, which makes Overleaf compile with XeLaTeX too.`)
      .addButton(b => {
        b.setButtonText(tectonicInstalled() ? 'Downloaded' : 'Download now').setDisabled(tectonicInstalled());
        b.onClick(async () => {
          b.setButtonText('Downloading…').setDisabled(true);
          try { await installTectonic(); new Notice('Archipelago: Tectonic is ready.'); } catch (e) { new Notice('Archipelago: ' + (e.message || e), 15000); }
          this.display();
        });
      });
    new Setting(el)
      .setName('Overleaf Git token')
      .setDesc('For syncing a document with its Overleaf project (needs an Overleaf plan with Git integration). Make one at Overleaf > Account settings > Git integration. '
        + (this.app.secretStorage ? 'It is kept in Obsidian\'s secret storage (the system\'s keychain, not in the vault) and sent only to Overleaf.' : 'This Obsidian has no secret storage (update to 1.11.4 or later): the token is kept in the plugin settings, in plain text.'))
      .addText(t => {
        t.inputEl.type = 'password';
        t.setPlaceholder('olp_…').setValue(this.plugin.overleafToken()).onChange(v => this.plugin.setToken(v));
      });
    el.createEl('p', {
      cls: 'setting-item-description',
      text: 'Documents are Markdown files in your vault (.md, recognised by their format line) and sync like any other file. When a file changes while it is open, '
        + 'the changes are merged into the open document; only edits to the same lines ask you to choose.',
    });
  }
}

// ---- the plugin ----

module.exports = class ArchipelagoPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    // earlier versions had a figure folder and a template folder of their own: the figure folder is the Archipelago folder now,
    // so the images of the documents stay where they are
    if (saved.figureFolder && !saved.archipelagoFolder) saved.archipelagoFolder = saved.figureFolder;
    delete saved.figureFolder; delete saved.latexTemplateFolder;
    // a vault that used the old default folder without saving it keeps it
    if (!saved.archipelagoFolder && await this.app.vault.adapter.exists(OLD_DEFAULT_FOLDER)) saved.archipelagoFolder = OLD_DEFAULT_FOLDER;
    this.settings = Object.assign({}, DEFAULTS, saved);
    // a token kept in plain text by earlier versions moves into the secret storage
    if (this.settings.overleafToken && this.app.secretStorage) await this.setToken(this.settings.overleafToken);
    addIcon('archipelago', ICON_SVG);
    this.registerView(VIEW_TYPE, leaf => new ArchipelagoView(leaf, this));
    this.registerExtensions([EXT], VIEW_TYPE);
    this.addSettingTab(new ArchipelagoSettings(this.app, this));
    this.kinds = new Map();           // path -> whether that version of the file is a document
    this.rawLeaves = new WeakSet();   // tabs that show a document as Markdown on purpose
    this.helpers = { relPath, joinPath, encodeRef, findImage, cleanFolder, looksLikeDocument };   // for the tests
    this.installRedirect();
    this.app.workspace.onLayoutReady(() => { this.redirectOpenTabs(); this.ensureTemplateFolder().catch(e => console.error('Archipelago: latex_templates', e)); });

    const create = async folder => {
      this.app.vault.getConfig('newFileLocation');   // see storeFigure
      const file = await this.app.vault.create(freePath(this.app, folder, 'Untitled'), newDocumentText());
      await openFile(this.app, file, true);
    };
    const newHere = () => { this.app.vault.getConfig('newFileLocation'); return create(this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? '')); };
    this.addRibbonIcon('archipelago', 'New Archipelago document', () => newHere());
    this.addCommand({ id: 'new-document', name: 'New document', callback: () => newHere() });

    const view = () => this.app.workspace.getActiveViewOfType(ArchipelagoView);
    const onView = (id, name, run) => this.addCommand({
      id, name, checkCallback: checking => { const v = view(); if (!v || !v.ui) return false; if (!checking) run(v.ui); return true; },
    });
    onView('show-map', 'Show map', ui => ui.setLevel('map'));
    onView('show-prose', 'Show prose', ui => ui.setLevel('prose'));
    onView('toggle-level', 'Switch between map and prose', ui => ui.setLevel(ui.getLevel() === 'map' ? 'prose' : 'map'));
    onView('show-latex', 'Show LaTeX', ui => ui.setLevel('latex'));
    onView('show-pdf', 'Show PDF', ui => ui.setLevel('pdf'));
    onView('compile', 'Compile the PDF', ui => ui.compile());
    onView('write-project', 'Write the project files into the document folder (.tex, .bib, images)', ui => ui.writeProject());
    onView('overleaf-sync', 'Sync with Overleaf', ui => ui.syncOverleaf());
    onView('fit', 'Fit the whole map in view', ui => ui.fit());
    onView('group', 'Group the selected claims', ui => ui.group());
    onView('ungroup', 'Ungroup the groups of the selected claims', ui => ui.ungroup());
    onView('undo', 'Undo', ui => ui.undo());
    onView('redo', 'Redo', ui => ui.redo());
    onView('check', 'Check the document for problems', ui => {
      const problems = ui.check();
      new Notice(problems.length ? `${problems.length} problem(s):\n` + problems.slice(0, 8).join('\n') + (problems.length > 8 ? '\n…' : '') : 'No problems found.', problems.length ? 12000 : 4000);
    });

    // A document is a note to Obsidian too: these switch between the two ways of looking at it.
    this.addCommand({
      id: 'open-as-markdown', name: 'Open as Markdown',
      checkCallback: checking => { const v = view(); if (!v || !v.file || v.file.extension !== DOC_EXT) return false; if (!checking) this.openAsMarkdown(v.leaf); return true; },
    });
    this.addCommand({
      id: 'open-as-document', name: 'Open as Archipelago document',
      checkCallback: checking => {
        const v = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!v || !v.file || v.file.extension !== DOC_EXT) return false;
        if (!checking) this.openAsDocument(v.leaf, v.file);
        return true;
      },
    });
    this.addCommand({
      id: 'to-markdown-file', name: 'Change the file type of a legacy .apg document to Markdown (.md)',
      checkCallback: checking => {
        const v = view();
        if (!v || !v.file || v.file.extension !== EXT) return false;
        if (!checking) this.toMarkdownFile(v.file);
        return true;
      },
    });

    this.addCommand({
      id: 'from-note', name: 'Create an Archipelago document from the current note',
      checkCallback: checking => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md') return false;
        if (!checking) this.fromNote(f);
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFolder) {
        menu.addItem(i => i.setTitle('New Archipelago document').setIcon('archipelago').onClick(() => create(file)));
      } else if (file instanceof TFile && file.extension === DOC_EXT) {
        menu.addItem(i => i.setTitle('Create Archipelago document from note').setIcon('archipelago').onClick(() => this.fromNote(file)));
      } else if (file instanceof TFile && file.extension === EXT) {
        menu.addItem(i => i.setTitle('Change file type to Markdown (.md)').setIcon('archipelago').onClick(() => this.toMarkdownFile(file)));
      }
    }));

    // A document that is deleted takes the images of its figure subfolder with it. A .md file is only known to have been a
    // document by what Obsidian had found in it (its first block is the format line, an HTML comment) or by what this
    // plugin classified earlier; a legacy .apg is a document by its extension.
    this.registerEvent(this.app.vault.on('delete', f => { if (f instanceof TFile && f.extension === EXT) this.tidyDeletedDocument(f); }));
    this.registerEvent(this.app.metadataCache.on('deleted', (f, prev) => {
      if (f instanceof TFile && f.extension === DOC_EXT && ((this.kinds.get(f.path) || {}).doc === true || looksLikeDocument(prev))) this.tidyDeletedDocument(f);
    }));

    // A document that is renamed takes its folder (and the names of its .tex, .bib and .pdf) with it. Renaming the folder through
    // Obsidian updates the links of the document to its figures.
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
      if (f instanceof TFile && (f.extension === DOC_EXT || f.extension === EXT)) this.renameDocFolder(f, oldPath).catch(() => {});
    }));

    // Write what is pending when Obsidian quits.
    this.registerEvent(this.app.workspace.on('quit', tasks => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        const v = leaf.view, ui = v && v.ui;
        if (!ui) continue;
        // `tasks` makes Obsidian wait for what is added before it quits
        const job = ui.hasConflict() ? () => this.keepUnsaved(v.file, ui.unsavedText()) : () => ui.flush();
        if (tasks && typeof tasks.add === 'function') tasks.add(job); else job();
      }
    }));
  }

  async renameDocFolder(doc, oldPath) {
    const oldBase = baseOf(oldPath).replace(/\.[^.]*$/, '');
    if (oldBase === doc.basename) return;   // moved to another folder of the vault, same name
    if (doc.extension === DOC_EXT && !(await this.isDocument(doc))) return;
    const root = archRoot(this.settings), safe = n => n.replace(/[\\/:*?"<>|#^[\]]/g, '_').trim() || 'document';
    const from = `${root}/${safe(oldBase)}`, to = docFolder(doc, this.settings);
    const folder = this.app.vault.getAbstractFileByPath(from);
    if (!(folder instanceof TFolder) || await fileExists(this.app, to)) return;
    await this.app.fileManager.renameFile(folder, to);
    for (const ext of ['tex', 'bib', 'pdf']) {
      const a = `${to}/${fileSlug(oldBase)}.${ext}`, b = `${to}/${docSlug(doc)}.${ext}`;
      if (a !== b && await fileExists(this.app, a) && !(await fileExists(this.app, b))) await adapterOf(this.app).rename(a, b);
    }
  }

  /** A document next to a Markdown note, with the note's text read as a document (headings become sections). */
  async fromNote(note) {
    const d = Core.parse(await this.app.vault.read(note));
    Core.assignIDs(d);
    const file = await this.app.vault.create(freePath(this.app, note.parent, note.basename + ' (Archipelago)'), Core.serialize(d));
    await openFile(this.app, file, true);
  }

  /** A document was deleted: the files of its subfolder (its figures, .bib, .tex and .pdf) are moved to the trash, except
   *  those that a note or another document links to, and the folders go when they are empty. Nothing happens when another
   *  document of the same name is still there (the folder may be theirs). */
  async tidyDeletedDocument(doc) {
    const root = archRoot(this.settings), app = this.app, adapter = adapterOf(app);
    const dir = `${root}/${figureSubfolder(doc)}`;
    if (!(await fileExists(app, dir))) return;
    if (app.vault.getFiles().some(f => f.path !== doc.path && figureSubfolder(f) === figureSubfolder(doc) && (f.extension === EXT || f.extension === DOC_EXT))) return;
    const tidy = async folder => {
      const { files, folders } = await listDir(app, folder);
      for (const sub of folders) await tidy(sub);
      for (const path of files) {
        const known = app.vault.getAbstractFileByPath(path);
        if (known instanceof TFile) { if (!linkedElsewhere(app, known, doc)) await toTrash(app, known); }
        else { try { await adapter.trashLocal(path); } catch { await adapter.remove(path); } }   // .bib, .tex: not in the index
      }
      const left = await listDir(app, folder);
      if (!left.files.length && !left.folders.length) {
        try { await adapter.rmdir(folder, false); } catch { /* try the other way */ }
        const tf = app.vault.getAbstractFileByPath(folder);
        if (tf instanceof TFolder) { try { await toTrash(app, tf); } catch { /* still in use */ } }
      }
    };
    try {
      await tidy(dir);
    } catch (e) {
      new Notice(`Archipelago: could not tidy the files of ${doc.name}: ${e.message || e}`, 10000);
    }
  }

  /** After a save: the images this document used before and no longer does are moved to the trash, so that
   *  deleting a figure from a document deletes its image. Only images in the figure folder, only ones this
   *  document had, and never one that a note or another document still links to. What was removed is returned
   *  (with its bytes) so that undo can bring it back. */
  async tidyFigures(doc, prev, next) {
    const root = archRoot(this.settings), removed = [];
    if (prev === next) return removed;
    const app = this.app, after = figureFiles(app, doc, next);
    for (const path of figureFiles(app, doc, prev)) {
      if (after.has(path) || !path.startsWith(root + '/')) continue;
      const f = app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile) || linkedElsewhere(app, f, doc)) continue;
      const data = f.stat.size <= 16e6 ? await app.vault.readBinary(f) : null;
      await toTrash(app, f);
      removed.push({ path, data });
    }
    return removed;
  }

  // ---- suggestions in the text fields ----

  /** What the suggestions of a document's text fields come from: the notes of the vault, the keys of its bibliographies (and the
   *  literature notes), and, when the Completr plugin is in the vault, its word list and LaTeX commands (read, never changed). */
  suggestHost(doc) {
    const app = this.app, plugin = this;
    const cache = {};
    const fresh = (key, ms, make) => {
      const c = cache[key];
      if (c && Date.now() - c.at < ms) return c.value;
      const value = make();
      cache[key] = { at: Date.now(), value };
      return value;
    };
    const completr = async name => {
      try { return await app.vault.adapter.read(`${app.vault.configDir}/plugins/obsidian-completr/${name}`); } catch { return ''; }
    };
    return {
      notes: async () => fresh('notes', 5000, () => app.vault.getMarkdownFiles().filter(f => f.path !== doc.path).map(f => {
        const noExt = f.path.replace(/\.md$/i, ''), lit = f.basename.startsWith('@');
        // a literature note is inserted as a citation: [[path|@key]]; any other note the way Obsidian links it
        const link = lit ? `[[${noExt}|${f.basename}]]` : `[[${app.metadataCache.fileToLinktext(f, doc.path)}]]`;
        return { path: f.path, name: f.basename, dir: dirOf(f.path), mtime: f.stat.mtime, insert: link };
      })),
      keys: async () => {
        const out = new Map(), add = (key, hint) => { if (key && !out.has(key)) out.set(key, { key, hint }); };
        for (const dir of [docFolder(doc, plugin.settings), archRoot(plugin.settings)]) {
          for (const path of (await listDir(app, dir)).files.filter(f => /\.bib$/i.test(f))) for (const k of Latex.bibKeys(await readText(app, path))) add(k, baseOf(path));
        }
        for (const f of app.vault.getMarkdownFiles()) {
          const fm = (app.metadataCache.getFileCache(f) || {}).frontmatter;
          if (fm && fm.citationKey) add(String(fm.citationKey), String(fm.title || '').slice(0, 40));
        }
        return [...out.values()];
      },
      words: async () => { const c = cache.words; if (c) return c; return (cache.words = (await completr('scanned_words.txt')).split(/\r?\n/).filter(w => w.length >= 3)); },
      latex: async () => { const c = cache.latex; if (c) return c; try { return (cache.latex = JSON.parse(await completr('latex_commands.json'))); } catch { return (cache.latex = []); } },
    };
  }

  // ---- LaTeX ----

  /** The LaTeX templates: the `.tex` files of `latex_templates/` in the Archipelago folder, then the built-in ones of other names. */
  async latexTemplates() {
    const dir = `${archRoot(this.settings)}/${TEMPLATE_DIR}`, out = [];
    const files = (await listDir(this.app, dir)).files.filter(f => /\.tex$/i.test(f)).sort((a, b) => baseOf(a).localeCompare(baseOf(b)));
    for (const path of files) out.push({ name: baseOf(path).replace(/\.tex$/i, ''), text: await readText(this.app, path), path });
    for (const t of Latex.BUILTIN) if (!out.some(o => o.name === t.name)) out.push(t);
    return out;
  }

  /** `latex_templates/` in the Archipelago folder, with the built-in templates in it to start from. */
  async ensureTemplateFolder() {
    const dir = `${archRoot(this.settings)}/${TEMPLATE_DIR}`;
    // A built-in template that is missing is written again, one that exists is never touched (so an edited one stays).
    // Put a different template of your own beside them to use it; a deleted built-in one comes back.
    await makeDirs(this.app, dir);
    for (const t of Latex.BUILTIN) {
      const path = normalizePath(`${dir}/${t.name}.tex`);
      if (!(await fileExists(this.app, path))) await writeText(this.app, path, t.text);
    }
  }

  /** The files a document has in the Archipelago folder: its subfolder with `figures/` and `<name>.bib` (empty, or with a
   *  comment), made when they are missing. The .tex and .pdf appear when the PDF is made. Files named after the document
   *  with blanks in the name (earlier versions) get the safe name. */
  async ensureDocFolder(doc) {
    const app = this.app, dir = docFolder(doc, this.settings), name = docSlug(doc), old = figureSubfolder(doc);
    await this.ensureTemplateFolder();
    await ensureFolder(app, `${dir}/figures`);
    if (old !== name) {
      for (const ext of ['bib', 'tex', 'pdf']) {
        const from = normalizePath(`${dir}/${old}.${ext}`), to = normalizePath(`${dir}/${name}.${ext}`);
        if (await fileExists(app, from) && !(await fileExists(app, to))) { try { await adapterOf(app).rename(from, to); } catch { /* leave it */ } }
      }
    }
    const bib = normalizePath(`${dir}/${name}.bib`);
    if (!(await fileExists(app, bib))) await writeText(app, bib, BIB_HEADER(doc.basename));
    else {
      // the header of earlier versions had an at sign in it, which BibTeX reads as an entry (and stops)
      const text = await readText(app, bib);
      if (OLD_BIB_HEADER.test(text)) await writeText(app, bib, BIB_HEADER(doc.basename) + text.replace(OLD_BIB_HEADER, ''));
    }
  }

  /** Copy into the document's folder what the .tex needs from elsewhere (images outside its `figures/`, the template's class and
   *  style files), so that the folder alone is a complete project: zipped, it compiles on Overleaf. `assets`: Map dest (relative to
   *  the folder) -> vault path of the image. */
  async prepareProject(doc, assets) {
    const app = this.app, dir = docFolder(doc, this.settings), tdir = `${archRoot(this.settings)}/${TEMPLATE_DIR}`, adapter = adapterOf(app);
    const copy = async (src, dest) => {
      const data = await adapter.readBinary(src);
      if (await fileExists(app, dest)) { const have = await adapter.readBinary(dest); if (sameBytes(have, data)) return; }
      await writeBinary(app, dest, data);
    };
    for (const [rel, src] of assets) { try { await copy(src, normalizePath(`${dir}/${rel}`)); } catch { /* missing image: the LaTeX has a box and a warning */ } }
    const rc = normalizePath(`${dir}/latexmkrc`);
    if (!(await fileExists(app, rc)) && !(await fileExists(app, normalizePath(`${dir}/.latexmkrc`)))) await writeText(app, rc, LATEXMKRC);
    for (const path of (await listDir(app, tdir)).files) {
      if (/\.tex$/i.test(path)) continue;   // the templates themselves
      try { await copy(path, normalizePath(`${dir}/${baseOf(path)}`)); } catch { /* skip */ }
    }
  }

  /** What the LaTeX and PDF views of document `doc` need from the vault. */
  latexHost(doc) {
    const app = this.app, plugin = this;
    const folder = () => docFolder(doc, plugin.settings), name = () => docSlug(doc);   // the document may be renamed
    const assets = new Map();   // images the last LaTeX refers to that lie outside figures/: dest -> vault path
    const bibPaths = async () => (await listDir(app, folder())).files.filter(f => /\.bib$/i.test(f)).sort((a, b) => baseOf(a).localeCompare(baseOf(b)));
    const pendingBib = async keys => {
      const bibPath = normalizePath(`${folder()}/${name()}.bib`);
      const have = new Set();
      for (const path of await bibPaths()) for (const k of Latex.bibKeys(await readText(app, path))) have.add(k);
      const want = [...keys].filter(k => !have.has(k));
      if (!want.length) return { found: [], entries: [], missing: [] };
      const root = archRoot(plugin.settings), library = new Map();
      for (const path of (await listDir(app, root)).files.filter(f => /\.bib$/i.test(f))) {
        for (const [k, v] of Latex.bibEntries(await readText(app, path))) if (!library.has(k)) library.set(k, v);
      }
      // a key that no .bib has: the literature note that carries it in its front matter (ZotFlow's notes have `citationKey`)
      const left = new Set(want.filter(k => !library.has(k)));
      if (left.size) {
        for (const f of app.vault.getMarkdownFiles()) {
          const fm = (app.metadataCache.getFileCache(f) || {}).frontmatter;
          if (!fm || !left.has(String(fm.citationKey))) continue;
          const entry = Latex.bibFromNote(fm);
          if (entry) { library.set(String(fm.citationKey), entry); left.delete(String(fm.citationKey)); }
        }
      }
      const found = want.filter(k => library.has(k));
      return { found, entries: found.map(k => library.get(k)), missing: want.filter(k => !library.has(k)) };
    };
    return {
      templates: () => plugin.latexTemplates(),
      /** Save Overleaf's preamble as a template of `latex_templates/`, named after the document; returns its name. */
      saveTemplate: async text => {
        await plugin.ensureTemplateFolder();
        const tpl = name() + '_overleaf';
        await writeText(app, normalizePath(`${archRoot(plugin.settings)}/${TEMPLATE_DIR}/${tpl}.tex`), text);
        return tpl;
      },
      /** { folder, texPath, pdfPath, bibFiles: [names without .bib], bibKeys: Set } */
      info: async () => {
        const bibs = await bibPaths(), keys = new Set();
        for (const path of bibs) for (const k of Latex.bibKeys(await readText(app, path))) keys.add(k);
        const f = folder();
        return { folder: f, texPath: normalizePath(`${f}/${name()}.tex`), bibFiles: bibs.map(b => baseOf(b).replace(/\.bib$/i, '')), bibKeys: keys };
      },
      /** Copy the entries for `keys` that the document's .bib lacks from the .bib files in the Archipelago folder (a Zotero
       *  export, Better BibTeX's auto-export for instance), or build them from the literature notes. Entries are only ever added.
       *  Returns { added, missing } (keys). */
      syncBib: async keys => {
        await plugin.ensureDocFolder(doc);
        const bibPath = normalizePath(`${folder()}/${name()}.bib`), p = await pendingBib(keys);
        if (p.found.length) await writeText(app, bibPath, (await readText(app, bibPath)).replace(/\s*$/, '\n\n') + p.entries.join('\n\n') + '\n');
        return { added: p.found, missing: p.missing };
      },
      /** What `syncBib` would add, without writing anything: { found: keys, entries: [text], missing: keys }. The PDF is made
       *  with them (in the cache), so that making a PDF never changes a file of the vault. */
      pendingBib,
      /** The path \includegraphics takes for a figure path of the document (relative to the .tex), or null when there is no such
       *  image. An image outside the document's figures/ is referred to as figures/ext_<name>, and copied there before compiling. */
      figurePath: rel => {
        const f = findImage(app, doc, rel);
        if (!f) return null;
        const own = `${folder()}/figures/`;
        if (f.path.startsWith(own)) return f.path.slice(folder().length + 1);
        const dest = `figures/ext_${fileSlug(f.basename)}.${f.extension}`;
        assets.set(dest, f.path);
        return dest;
      },
      /** The physical width in inches of a figure of the document (``Latex.imageWidthIn``: a PNG with a resolution, a PDF),
       *  or null when unknown; a figure that knows its width is placed at it, a wide one across both columns. */
      figureWidthIn: rel => {
        const f = findImage(app, doc, rel);
        if (!f || !app.vault.adapter.getFullPath) return null;
        try { return Latex.imageWidthIn(require('fs').readFileSync(app.vault.adapter.getFullPath(f.path)), f.extension); } catch { return null; }
      },
      prepareProject: () => plugin.prepareProject(doc, assets),
      /** Make the PDF from `tex` in the cache of this computer. Nothing is written into the vault. `bib`: entries the folder's .bib
       *  does not have yet (see pendingBib). */
      compile: (tex, bib) => plugin.compileLatex(doc, tex, assets, bib),
      /** Put a copy of the PDF into the document's folder (only when the user asks: it is a file that sync tools would carry). */
      savePdf: async data => {
        await plugin.ensureDocFolder(doc);
        const path = normalizePath(`${folder()}/${name()}.pdf`);
        await writeBinary(app, path, data);
        return path;
      },
      installTectonic: () => installTectonic(),
      /** The template this computer previews the document with ('' = the document's own): per computer, not in the vault. */
      previewTemplate: {
        get: () => plugin.localGet('preview:' + doc.path) || '',
        set: name => plugin.localSet('preview:' + doc.path, name || null),
      },
      exportZip: tex => plugin.exportOverleaf(doc, tex, assets),
      /** Write the .tex (and remember it as the base) without compiling. */
      writeTex: tex => plugin.writeProject(doc, tex, assets),
      /** Keep an outside version of the .tex beside it (when not all of it could be taken over); returns its path. */
      keepCopy: async text => { const path = normalizePath(`${folder()}/${name()}_before_takeover.tex`); await writeText(app, path, text); return path; },
      /** { text, base } of the .tex in the folder (null when there is none) and as Archipelago last wrote it. */
      readTex: async () => {
        const path = normalizePath(`${folder()}/${name()}.tex`);
        return { text: (await fileExists(app, path)) ? await readText(app, path) : null, base: plugin.readBase(doc) };
      },
      overleaf: url => {
        const o = new Overleaf(plugin, doc, url);
        return { pull: (tex, choice) => o.pull(tex, assets, choice), push: tex => o.push(tex, assets), lock: () => o.lock(), unlock: () => o.unlock(), rollback: () => o.rollback() };
      },
      overleafUrl: input => overleafGitUrl(input),
      /** The PDF this computer made last time (from the cache), or null. */
      readPdf: async () => {
        try {
          const b = require('fs').readFileSync(require('path').join(plugin.buildDir(doc), 'main.pdf'));
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        } catch { return null; }
      },
      pdfjs: () => loadPdfJs(),
      showFolder: async () => {
        await plugin.ensureDocFolder(doc);
        const pick = (await bibPaths())[0] || normalizePath(`${folder()}/${name()}.bib`);
        if (typeof app.showInFolder === 'function') app.showInFolder(pick);
        else if (typeof app.openWithDefaultApp === 'function') app.openWithDefaultApp(folder());
      },
      openPath: path => { if (typeof app.openWithDefaultApp === 'function') app.openWithDefaultApp(path); },
      /** Write a copy without the marker comments (to hand in): returns its path. */
      saveClean: async tex => {
        const path = normalizePath(`${folder()}/${name()}_clean.tex`);
        await writeText(app, path, tex);
        return path;
      },
    };
  }

  /** The versions of a document this computer wrote or read lately, kept outside the vault (gzip, per computer, pruned after
   *  30 days), so that a sync tool bringing back one of our own old versions is recognised also after a restart. */
  historyOf(file) {
    const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib');
    const dir = path.join(os.homedir(), '.cache', 'archipelago-history');
    const f = path.join(dir, hashOf(adapterOf(this.app).getBasePath() + '/' + file.path) + '.json.gz');
    return {
      load: () => {
        if (!this.historyPruned) {   // once per session: files nobody has touched for a month
          this.historyPruned = true;
          try { for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 864e5) fs.unlinkSync(p); } } catch { /* no folder yet */ }
        }
        try { const list = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')); return Array.isArray(list) ? list : []; } catch { return []; }
      },
      save: list => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(list))); },
    };
  }

  /** The .tex as Archipelago last wrote it, kept outside the vault (per computer): what an outside edit of the .tex is compared
   *  with, to tell its changes from the document's. */
  baseFile(doc) {
    const path = require('path'), os = require('os');
    return path.join(os.homedir(), '.cache', 'archipelago-latex', hashOf(adapterOf(this.app).getBasePath() + '/' + doc.path), 'base.tex');
  }
  readBase(doc) { try { return require('fs').readFileSync(this.baseFile(doc), 'utf8'); } catch { return null; } }
  writeBase(doc, tex) { const fs = require('fs'), f = this.baseFile(doc); fs.mkdirSync(require('path').dirname(f), { recursive: true }); fs.writeFileSync(f, tex); }

  /** The document's folder ready as a project: its files, the template's, images from elsewhere, and the .tex. */
  async writeProject(doc, tex, assets) {
    await this.ensureDocFolder(doc);
    await this.prepareProject(doc, assets || new Map());
    await writeText(this.app, normalizePath(`${docFolder(doc, this.settings)}/${docSlug(doc)}.tex`), tex);
    this.writeBase(doc, tex);
  }

  /** The document's folder as a zip file for Overleaf (New Project > Upload Project): the .tex written from `tex`, the .bib, the
   *  figures, the template's class and style files. Not in it: the PDF, earlier zips, the clean copy. Returns the zip's path. */
  async exportOverleaf(doc, tex, assets) {
    const app = this.app, adapter = adapterOf(app), folder = docFolder(doc, this.settings), name = docSlug(doc);
    await this.writeProject(doc, tex, assets);
    const zipPath = normalizePath(`${folder}/${name}_overleaf.zip`), entries = [];
    const walk = async dir => {
      const { files, folders } = await listDir(app, dir);
      for (const f of files) {
        const rel = f.slice(folder.length + 1);
        if (!synced(rel)) continue;   // the PDF and zips of the folder, the clean copy, hidden files (figures may be PDFs)
        entries.push({ name: rel, data: new Uint8Array(await adapter.readBinary(f)) });
      }
      for (const sub of folders) await walk(sub);
    };
    await walk(folder);
    await writeBinary(app, zipPath, makeZip(entries));
    return zipPath;
  }

  /** Where this computer builds the document's PDF: outside the vault (under $HOME, which a Flatpak Obsidian sees too). */
  buildDir(doc) {
    const adapter = this.app.vault.adapter;
    return require('path').join(require('os').homedir(), '.cache', 'archipelago-latex', hashOf(adapter.getBasePath() + '/' + doc.path));
  }

  /** Make the PDF of `tex` with Tectonic, in the cache. Nothing is written into the vault: the .tex, the .bib, the images and the
   *  PDF there are Overleaf's and the sync tool's, and a PDF made here must not change them (two people making a PDF would
   *  otherwise write the same files and conflict). The text is `main.tex` of the build folder; the document's folder and the
   *  templates are searched for figures and class files, and the .bib files of the folder (with the entries `bib` adds) are
   *  collected into one file there.
   *  Returns { ok, pdf (ArrayBuffer or null), log, errors: [{ line, text }], message, needsTectonic }. */
  compileLatex(doc, tex, assets, bib) {
    // One compile of a document at a time: two would write the same build folder (two tabs of it, a compile that is asked
    // for while one runs).
    const key = doc.path;
    this.compiles = this.compiles || new Map();
    const run = (this.compiles.get(key) || Promise.resolve()).catch(() => {}).then(() => this.compileNow(doc, tex, assets, bib));
    this.compiles.set(key, run);
    run.finally(() => { if (this.compiles.get(key) === run) this.compiles.delete(key); }).catch(() => {});
    return run;
  }

  async compileNow(doc, tex, assets, bib) {
    const app = this.app, adapter = app.vault.adapter;
    if (typeof adapter.getBasePath !== 'function') return { ok: false, pdf: null, log: '', errors: [], message: 'Compiling needs Obsidian on a computer.' };
    if (!tectonicInstalled()) {
      return { ok: false, pdf: null, log: '', errors: [], needsTectonic: true,
        message: `To make the PDF, Archipelago downloads its LaTeX engine once: Tectonic ${TECTONIC_VERSION} from GitHub (about 10 to 20 MB).` };
    }
    const fs = require('fs'), path = require('path');
    const folder = docFolder(doc, this.settings), base = adapter.getBasePath(), build = this.buildDir(doc);
    fs.mkdirSync(build, { recursive: true });
    for (const f of ['main.pdf', 'main.log', 'main.xdv']) { try { fs.rmSync(path.join(build, f)); } catch { /* not there */ } }
    const cwd = path.join(base, folder), tdirAbs = path.join(base, archRoot(this.settings), TEMPLATE_DIR), stage = path.join(build, 'stage');
    // the .bib files of the folder and what they lack, as one file (named apg_refs, so that no other .bib of that name is found first)
    let refs = '';
    try {
      for (const f of (await listDir(app, folder)).files.filter(x => /\.bib$/i.test(x)).sort()) refs += (await readText(app, f)).replace(/\s*$/, '\n\n');
    } catch { /* no .bib */ }
    if (bib) refs += bib;
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'apg_refs.bib'), refs);
    // images from outside the document's figures/ (the LaTeX calls them figures/ext_<name>): copies in the stage
    for (const [rel, src] of assets || []) {
      try {
        const dest = path.join(stage, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(await adapter.readBinary(src)));
      } catch { /* missing image: the LaTeX has a box and a warning */ }
    }
    fs.writeFileSync(path.join(build, 'main.tex'), tex.replace(/\\bibliography\{[^}]*\}/, '\\bibliography{apg_refs}'));
    const args = [path.join(build, 'main.tex'), '--outdir', build, '--keep-logs', '--chatter', 'minimal',
      '-Z', `search-path=${stage}`, '-Z', `search-path=${cwd}`, '-Z', `search-path=${tdirAbs}`];
    const r = await runTool(tectonicExe(), args, cwd, { TECTONIC_CACHE_DIR: path.join(tectonicHome(), 'cache') }, 900000);
    let log = '';
    try { log = fs.readFileSync(path.join(build, 'main.log'), 'latin1'); } catch { /* none */ }
    if (!log && r.code !== 0) {
      const offline = /network|resolve|connect|timed out|dns|tls|certificate/i.test(r.out);
      return { ok: false, pdf: null, log: r.out, errors: Latex.logErrors(r.out.replace(/^error: /gm, ''), 'main.tex'),
        message: offline ? 'Tectonic could not fetch the LaTeX packages it needs (it needs the internet the first time a package is used):\n' + r.out.trim().slice(0, 400) : `Tectonic did not run: ${r.out.trim().slice(0, 400)}` };
    }
    if (r.code !== 0) log += '\n\n---- Tectonic ----\n' + r.out;
    const errors = Latex.logErrors(log, 'main.tex');
    let pdf = null;
    try { pdf = fs.readFileSync(path.join(build, 'main.pdf')); } catch { /* no output */ }
    if (r.code !== 0 || !pdf) return { ok: false, pdf: null, log, errors, message: errors.length ? '' : 'LaTeX stopped without a PDF; see the log.' };
    return { ok: true, pdf: pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength), log, errors, message: '' };
  }

  /** A view closes (or Obsidian quits) while a conflict waits for a decision: the text open there would be lost,
   *  so it is kept in a file next to the document, which opens like any document. */
  async keepUnsaved(file, text) {
    if (!file || !text) return;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    const copy = freePath(this.app, file.parent, `${file.basename} (unsaved changes ${stamp})`);
    try {
      await this.app.vault.create(copy, text);
      new Notice(`Archipelago: ${file.name} was changed elsewhere and you had not decided yet. Your unsaved changes are kept in ${copy}.`, 20000);
    } catch (e) {
      new Notice(`Archipelago: could not keep your unsaved changes of ${file.name}: ${e.message || e}`, 20000);
    }
  }

  // ---- documents among the notes ----

  /** Whether a file is an Archipelago document: a legacy .apg file, or a .md file with the format line. */
  async isDocument(file) {
    if (!(file instanceof TFile)) return false;
    if (file.extension === EXT) return true;
    if (file.extension !== DOC_EXT || file.stat.size > 20e6) return false;
    const key = `${file.stat.mtime}:${file.stat.size}`, known = this.kinds.get(file.path);
    if (known && known.key === key) return known.doc;
    const doc = Core.isDocument(await this.app.vault.cachedRead(file));
    this.kinds.set(file.path, { key, doc });
    return doc;
  }

  /** Whether the document view may show `file`: a legacy .apg file, a .md file that is a document, or any .md file
   *  when the user asked for it. */
  async mayShow(file, force) {
    if (!(file instanceof TFile)) return false;
    return file.extension === EXT || (file.extension === DOC_EXT && (force || await this.isDocument(file)));
  }

  /** The view state a leaf is about to get, with a document that would open as a note sent to the document view instead. */
  async redirect(state, leaf) {
    if (!state || state.type !== 'markdown' || !state.state || typeof state.state.file !== 'string' || (leaf && this.rawLeaves.has(leaf))) return state;
    const f = this.app.vault.getAbstractFileByPath(state.state.file);
    if (f instanceof TFile && f.extension === DOC_EXT && await this.isDocument(f)) return { ...state, type: VIEW_TYPE, state: { file: f.path } };
    return state;
  }

  /** Every way of opening a file (a link, the file explorer, the quick switcher, a restored tab) ends in
   *  `setViewState`, so a wrapper there catches all of them. It removes itself when the plugin unloads. */
  installRedirect() {
    const proto = WorkspaceLeaf.prototype, orig = proto.setViewState, plugin = this;
    let active = true;
    const wrapped = async function (state, eState) {
      if (active) { try { state = await plugin.redirect(state, this); } catch { /* open it as a note */ } }
      return orig.call(this, state, eState);
    };
    proto.setViewState = wrapped;
    this.register(() => { active = false; if (proto.setViewState === wrapped) proto.setViewState = orig; });
  }

  /** Tabs restored at start-up may have opened as notes before this plugin was there. */
  async redirectOpenTabs() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      try {
        const state = leaf.getViewState(), next = await this.redirect(state, leaf);
        if (next !== state) await leaf.setViewState(next);
      } catch { /* leave the tab as it is */ }
    }
  }

  async openAsMarkdown(leaf) {
    const file = leaf.view && leaf.view.file;
    if (!file) return;
    this.rawLeaves.add(leaf);
    await leaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'source' } });
  }

  async openAsDocument(leaf, file) {
    // A note that is not a document yet would get the format line (and ids, positions) on its first save.
    if (!(await this.isDocument(file)) && !(await confirmDialog(this.app, 'Turn this note into an Archipelago document?',
      `"${file.basename}" is an ordinary note. Opened as a document, it gets Archipelago's format line, and ids and map positions for its headings, `
      + 'when it is saved. Everything else in it stays as it is.', 'Turn into document'))) return;
    this.rawLeaves.delete(leaf);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path, force: true } });
  }

  /** Rename a legacy .apg document to .md (same text), so sync tools merge it as text. */
  async toMarkdownFile(file) {
    const target = freePath(this.app, file.parent, file.basename);
    await this.app.fileManager.renameFile(file, target);
    new Notice('Now ' + target);
  }

  async saveSettings() { await this.saveData(this.settings); }
  /** Kept on this computer only (Obsidian's local storage of the vault, which sync tools do not carry). */
  localGet(key) {
    try { return typeof this.app.loadLocalStorage === 'function' ? this.app.loadLocalStorage('archipelago-' + key) : window.localStorage.getItem('archipelago-' + this.app.vault.getName() + '-' + key); } catch { return null; }
  }
  localSet(key, value) {
    try {
      if (typeof this.app.saveLocalStorage === 'function') this.app.saveLocalStorage('archipelago-' + key, value);
      else if (value == null) window.localStorage.removeItem('archipelago-' + this.app.vault.getName() + '-' + key);
      else window.localStorage.setItem('archipelago-' + this.app.vault.getName() + '-' + key, value);
    } catch { /* not kept */ }
  }

  /** The Overleaf Git token: from Obsidian's secret storage, or (Obsidian before 1.11.4) from the plugin settings. */
  overleafToken() {
    const store = this.app.secretStorage;
    return ((store && store.getSecret(TOKEN_ID)) || this.settings.overleafToken || '').trim();
  }
  async setToken(value) {
    const store = this.app.secretStorage;
    if (store) { store.setSecret(TOKEN_ID, value.trim()); delete this.settings.overleafToken; } else this.settings.overleafToken = value.trim();
    await this.saveSettings();
  }

  onunload() { /* views flush and tear down on their own */ }
};
