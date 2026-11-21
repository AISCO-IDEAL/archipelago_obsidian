// Archipelago for Obsidian: a document's LaTeX project synced with Overleaf, through Overleaf's Git integration.
//
// The project folder in the vault (<Archipelago folder>/<document>/) is mirrored in a Git working copy outside the vault
// (~/.cache/archipelago-overleaf/<hash of the URL>), so the vault gets no .git folder that sync tools or the vault's own Git would
// carry or trip over. A sync: write the .tex from the document into the folder, copy the folder into the working copy, commit,
// merge what is on Overleaf (Git does the three-way merge of the text, with the last sync as the base), copy the result back
// into the folder, take the .tex's changes over into the document (fromlatex.js, done by the view), write the .tex again and push.
// Git runs inside Obsidian's sandbox when it is a Flatpak (it has one); the token is passed in the environment, never written to disk by Git.

/** The Git URL of an Overleaf project from what a user pastes: the Git URL, or the address of the project in the browser. */
function overleafGitUrl(input) {
  const t = String(input || '').trim(), m = t.match(/overleaf\.com\/(?:project\/)?([0-9a-f]{24})\b/i);
  if (m) return `https://git.overleaf.com/${m[1]}`;
  return /^(https?|file):\/\/\S+$/.test(t) ? t : null;
}

/** Whether the token may go to this URL: only to Overleaf's Git server (a document could name any address). */
const isOverleaf = url => /^https:\/\/git\.overleaf\.com\/[0-9a-f]{24}$/i.test(url);

const mirrorOf = url => require('path').join(require('os').homedir(), '.cache', 'archipelago-overleaf', hashOf(url));

/** Git in `cwd`: { code, out }. Overleaf takes the user "git" and the token as the password. */
function git(args, cwd, token) {
  const env = {
    // Git of the environment Obsidian was started from must not lead it elsewhere, or print request headers
    GIT_DIR: null, GIT_WORK_TREE: null, GIT_INDEX_FILE: null, GIT_TRACE: null, GIT_TRACE_CURL: null, GIT_CURL_VERBOSE: null, GIT_CONFIG_PARAMETERS: null,
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Archipelago', GIT_AUTHOR_EMAIL: 'archipelago@localhost',
    GIT_COMMITTER_NAME: 'Archipelago', GIT_COMMITTER_EMAIL: 'archipelago@localhost',
  };
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('git:' + token).toString('base64') });
  return runTool('git', args, cwd, env, 120000);
}

/** What of a project folder is synced: not the PDF and zips at its top, not the clean copy, no hidden files. */
const synced = rel => !/^[^/]+\.(pdf|zip)$/i.test(rel) && !/_(clean|before_takeover)\.tex$/i.test(rel) && !rel.split('/').some(x => x.startsWith('.'));

/** The files of a folder of the disk, relative to it (without .git). */
function diskFiles(dir) {
  const fs = require('fs'), path = require('path'), out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.filter(synced);
}

/** The files of a folder of the vault, relative to it. */
async function vaultFiles(app, folder) {
  const out = [];
  const walk = async dir => {
    const { files, folders } = await listDir(app, dir);
    for (const f of files) out.push(f.slice(folder.length + 1));
    for (const sub of folders) await walk(sub);
  };
  await walk(folder);
  return out.filter(synced);
}

/** Working copies a sync runs in now: one sync at a time per working copy (two panes, two documents with one project). */
const BUSY = new Set();

class Overleaf {
  constructor(plugin, doc, url) {
    this.plugin = plugin; this.app = plugin.app; this.doc = doc; this.url = url;
    this.dir = mirrorOf(url);
    this.token = isOverleaf(url) ? plugin.overleafToken() : '';
  }
  lock() { if (BUSY.has(this.dir)) return false; BUSY.add(this.dir); return true; }
  unlock() { BUSY.delete(this.dir); }
  get folder() { return docFolder(this.doc, this.plugin.settings); }
  git(...args) { return git(args, this.dir, this.token); }
  manifestPath() { return require('path').join(this.dir, '.git', 'archipelago-files.json'); }
  /** The files of the last sync, and the vault folder they were in. (Earlier versions kept the list alone.) */
  manifest() {
    try {
      const m = JSON.parse(require('fs').readFileSync(this.manifestPath(), 'utf8'));
      return Array.isArray(m) ? Object.assign(new Set(m), { folder: null }) : Object.assign(new Set(m.files), { folder: m.folder });
    } catch { return Object.assign(new Set(), { folder: null }); }
  }
  saveManifest() { require('fs').writeFileSync(this.manifestPath(), JSON.stringify({ folder: this.folder, files: diskFiles(this.dir) })); }

  /** Before files are deleted on one side because they are gone on the other: an error when that looks like a mistake
   *  (the folder moved: other Archipelago folder, renamed document; or many files at once). */
  checkDeletions(gone, last, where) {
    if (!gone.length) return null;
    if (last.folder && last.folder !== this.folder) return { error: `The document's folder is now ${this.folder}, it was ${last.folder} at the last sync: move the files there (or set the Archipelago folder back) before syncing, or ${gone.length} file(s) would be deleted ${where}.` };
    if (gone.length > 3 && gone.length * 2 > last.size) return { error: `${gone.length} of ${last.size} files would be deleted ${where} (${gone.slice(0, 4).join(', ')}…). If that is meant, delete them there by hand; the sync stops.` };
    return null;
  }

  /** The folder into the working copy. A file that was synced before and is gone from the folder is removed there too. */
  async toMirror() {
    const fs = require('fs'), path = require('path'), adapter = adapterOf(this.app), last = this.manifest();
    const local = await vaultFiles(this.app, this.folder);
    const gone = diskFiles(this.dir).filter(rel => !local.includes(rel) && last.has(rel));
    const stop = this.checkDeletions(gone, last, 'on Overleaf');
    if (stop) return stop;
    for (const rel of local) {
      const data = Buffer.from(await adapter.readBinary(`${this.folder}/${rel}`)), dest = path.join(this.dir, rel);
      if (fs.existsSync(dest) && fs.readFileSync(dest).equals(data)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    for (const rel of gone) fs.rmSync(path.join(this.dir, rel));
    return null;
  }

  /** The working copy into the folder. A file that was synced before and is gone on Overleaf goes to the trash. */
  async fromMirror() {
    const fs = require('fs'), path = require('path'), adapter = adapterOf(this.app), last = this.manifest();
    const remote = diskFiles(this.dir);
    const gone = (await vaultFiles(this.app, this.folder)).filter(rel => !remote.includes(rel) && last.has(rel));
    const stop = this.checkDeletions(gone, last, 'in the vault');
    if (stop) return stop;
    for (const rel of remote) {
      const data = fs.readFileSync(path.join(this.dir, rel)), dest = normalizePath(`${this.folder}/${rel}`);
      if (await fileExists(this.app, dest) && Buffer.from(await adapter.readBinary(dest)).equals(data)) continue;
      await writeBinary(this.app, dest, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    for (const rel of gone) {
      const p = normalizePath(`${this.folder}/${rel}`), known = this.app.vault.getAbstractFileByPath(p);
      if (known instanceof TFile) await toTrash(this.app, known); else await adapter.trashLocal(p);
    }
    return null;
  }

  /** The branch of the working copy (Overleaf's is master). */
  async branch() {
    const r = await this.git('symbolic-ref', '--quiet', '--short', 'HEAD'), b = (r.out || '').trim();
    return r.code === 0 && /^[\w./-]+$/.test(b) ? b : 'master';
  }

  texOf(dir) { try { return require('fs').readFileSync(require('path').join(dir, docSlug(this.doc) + '.tex'), 'utf8'); } catch { return null; } }
  fail(r, what) {
    const out = (r.out || '').trim();
    if (/Authentication failed|403|401|could not read Username|terminal prompts disabled/i.test(out)) return { error: 'Overleaf refused the login: check the Git token in Settings > Archipelago (Overleaf > Account settings > Git integration).' };
    if (/not found|does not appear to be a git repository|repository .* not found/i.test(out)) return { error: 'There is no Overleaf project at ' + this.url };
    if (/ENOENT|spawn git/i.test(out)) return { error: 'Git was not found. Install Git (on a Flatpak Obsidian it comes with the app).' };
    return { error: `${what} failed: ${out.slice(-400)}` };
  }

  /** The first half of a sync, up to the merged .tex (see the top of the file). `ours`: the .tex of the document now.
   *  `choice`: 'overleaf' | 'archipelago' (first sync, when Overleaf has a different text already), 'theirs' | 'ours'
   *  (a conflict). Returns { error } | { ask: 'first' | 'conflict', files } | { tex, base } (tex: to take over; base: what it
   *  is compared with, null for "everything that differs"). */
  async pull(ours, assets, choice) {
    const fs = require('fs');
    if (/^https?:/.test(this.url) && !isOverleaf(this.url)) return { error: `Only Overleaf projects (https://git.overleaf.com/…) are synced, and this document names ${this.url}: connect it again from the Overleaf menu.` };
    if (!this.token && /^https?:/.test(this.url)) return { error: 'An Overleaf Git token is needed: Overleaf > Account settings > Git integration > Generate token, then paste it in Settings > Archipelago.' };
    await this.plugin.writeProject(this.doc, ours, assets);
    if (!fs.existsSync(require('path').join(this.dir, '.git'))) {
      fs.mkdirSync(require('path').dirname(this.dir), { recursive: true });
      const r = await git(['clone', '--quiet', '--', this.url, this.dir], require('os').homedir(), this.token);
      if (r.code !== 0) { fs.rmSync(this.dir, { recursive: true, force: true }); return this.fail(r, 'Cloning the Overleaf project'); }
    }
    // Before the first sync that went through, the project on Overleaf may have a text of its own: whose counts is asked.
    const remoteTex = this.texOf(this.dir), first = !fs.existsSync(this.manifestPath());
    if (first && remoteTex !== null && FromLatex.norm(remoteTex) !== FromLatex.norm(ours)) {
      if (!choice) return { ask: 'first' };
      if (choice === 'overleaf') { const e = await this.fromMirror(); return e || { tex: remoteTex, base: null }; }
    }
    const e = await this.toMirror();
    if (e) return e;
    await this.git('add', '-A');
    if ((await this.git('diff', '--cached', '--quiet')).code !== 0) {
      const c = await this.git('commit', '--quiet', '-m', 'Archipelago: ' + this.doc.basename);
      if (c.code !== 0) return this.fail(c, 'Committing');
    }
    const f = await this.git('fetch', '--quiet', 'origin');
    if (f.code !== 0) return this.fail(f, 'Fetching from Overleaf');
    const branch = await this.branch();
    if ((await this.git('rev-parse', '--verify', '--quiet', 'origin/' + branch)).code !== 0) return { tex: ours, base: ours };   // nothing on Overleaf yet
    this.before = ((await this.git('rev-parse', 'HEAD')).out || '').trim();
    const m = await this.git('merge', '--no-edit', ...(choice === 'theirs' || choice === 'ours' ? ['-X', choice] : []), 'origin/' + branch);
    if (m.code !== 0) {
      const files = ((await this.git('diff', '--name-only', '--diff-filter=U')).out || '').trim().split('\n').filter(Boolean);
      await this.git('merge', '--abort');
      if (files.length && choice) return { error: `Git cannot settle ${files.join(', ')} on its own (changed on one side, deleted or renamed on the other?): make both the same on Overleaf, then sync again.` };
      return files.length ? { ask: 'conflict', files } : this.fail(m, 'Merging');
    }
    const fe = await this.fromMirror();
    if (fe) return fe;
    return { tex: this.texOf(this.dir) ?? ours, base: ours };
  }

  /** The sync stops after the merge (cancelled, or the view closed): the working copy goes back to before it, so the next
   *  sync merges Overleaf's changes again instead of overwriting them with the document's older text. */
  async rollback() {
    if (/^[0-9a-f]{40}$/.test(this.before || '')) await this.git('reset', '--quiet', '--hard', this.before);
  }

  /** The second half: the .tex of the document (after taking the changes over) into the folder and to Overleaf. */
  async push(tex, assets) {
    await this.plugin.writeProject(this.doc, tex, assets);
    const e = await this.toMirror();
    if (e) return e;
    await this.git('add', '-A');
    if ((await this.git('diff', '--cached', '--quiet')).code !== 0) await this.git('commit', '--quiet', '-m', 'Archipelago: ' + this.doc.basename);
    const branch = await this.branch();
    const p = await this.git('push', '--quiet', 'origin', 'HEAD:' + branch);
    if (p.code !== 0) return /rejected|fetch first|non-fast-forward/i.test(p.out) ? { error: 'Overleaf changed during the sync: sync again.' } : this.fail(p, 'Pushing to Overleaf');
    this.saveManifest();
    return { ok: true };
  }
}
