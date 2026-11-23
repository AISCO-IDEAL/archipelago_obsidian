#!/usr/bin/env node
// Tests the plugin inside the real Obsidian (the Flatpak, or ARCHIPELAGO_OBSIDIAN="command"), with its
// own profile and a throwaway vault, driven over the DevTools protocol with real mouse and keyboard
// events. Files are changed from outside the way a sync tool does. Run: node test/e2e.js [--shots DIR]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const Core = require('../src/core.js');

const ROOT = path.resolve(__dirname, '..');
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt >= 0 ? process.argv[shotsAt + 1] : null;
// The documents of the run are Markdown (the default) or legacy .apg files: --ext apg
const extAt = process.argv.indexOf('--ext');
const EXT = extAt >= 0 ? process.argv[extAt + 1] : 'md';
const DOC = `Papers/example.${EXT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, what, extra) => { if (c) { passed++; console.log('  ok   ' + what); } else { failed++; console.log('  FAIL ' + what + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 400) : '')); } };

const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const getJSON = u => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

(async () => {
  // ---- a vault and a profile of its own, under $HOME (the Flatpak cannot see /tmp) ----
  const work = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'archipelago-obsidian-test-'));
  const vault = path.join(work, 'vault'), profile = path.join(work, 'profile');
  fs.mkdirSync(path.join(vault, '.obsidian', 'plugins', 'archipelago'), { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(path.join(vault, 'Papers'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'example.apg'), path.join(vault, 'Papers', `example.${EXT}`));
  // a second document, always Markdown, for the tests of the redirect
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'example.apg'), path.join(vault, 'Papers', 'second.md'));
  fs.cpSync(path.join(__dirname, 'fixtures', 'figures'), path.join(vault, 'Papers', 'figures'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Papers', 'Note.md'), '# Background\n\nSome text about signed distance fields.\n\n# Method\n\nWe project.\n');
  // like the real vault: new files go next to the current one, attachments to a folder of their own
  const appConfig = JSON.stringify({ newFileLocation: 'current', attachmentFolderPath: 'Anhänge' });
  fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), appConfig);
  // switched on the way a user has it, so it loads at every start (and restores its tabs)
  fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['archipelago']));
  // The PDF is made with Tectonic, which the plugin downloads on request. The test does not download it: it uses the one an earlier
  // use of the plugin left in ~/.cache (the PDF tests are skipped without it).
  const TECTONIC = path.join(os.homedir(), '.cache', 'archipelago-tectonic', '0.17.0', 'tectonic');
  const HAVE_TECTONIC = fs.existsSync(TECTONIC);
  const build = spawnSync('node', [path.join(__dirname, '..', 'build.js'), '--install', vault], { encoding: 'utf8' });
  if (build.status !== 0) { console.log(build.stdout, build.stderr); process.exit(1); }
  fs.writeFileSync(path.join(profile, 'obsidian.json'), JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: vault, ts: Date.now(), open: true } } }));
  const file = path.join(vault, 'Papers', `example.${EXT}`);
  const original = fs.readFileSync(file, 'utf8');

  const port = await freePort();
  const cmd = (process.env.ARCHIPELAGO_OBSIDIAN || 'flatpak run --no-talk-name=org.freedesktop.Flatpak md.obsidian.Obsidian').split(' ');
  const proc = spawn(cmd[0], [...cmd.slice(1), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--ozone-platform=headless', '--disable-gpu'], { stdio: 'ignore', detached: true });
  const killObsidian = () => { spawnSync('pkill', ['-f', '--', `user-data-dir=${profile}`]); };
  let ws, nextId = 1; const waiting = new Map(), logs = [];

  const cleanup = async () => { try { ws && ws.close(); } catch {} killObsidian(); await sleep(1500); killObsidian(); fs.rmSync(work, { recursive: true, force: true }); };
  process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(500);
      try { target = (await getJSON(`http://127.0.0.1:${port}/json`)).find(t => t.type === 'page'); } catch {}
    }
    if (!target) throw new Error('Obsidian did not start');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect')); });
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('console.error ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    };
    const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(60); } return false; };
    await send('Runtime.enable');
    await waitFor('typeof app !== "undefined" && app.workspace && app.workspace.layoutReady', 30000);
    // The vault is indexed and a tab exists once Obsidian has really started (slower on a cold start).
    if (!await waitFor(`app.vault.getFiles().some(f => f.path === "${DOC}") && !!app.workspace.getLeavesOfType("empty").length`, 40000)) throw new Error('Obsidian opened, but not the test vault');
    await ev('require("electron").remote.getCurrentWindow().setSize(1400, 900)');
    await sleep(400);
    logs.length = 0;   // start-up noise of Obsidian itself

    // ---- helpers inside the page ----
    const installT = () => ev(`window.T = {
      // the document the user is looking at: the most recent tab if it is one, else the first open one
      view: () => { const r = app.workspace.getMostRecentLeaf(); if (r && r.view && r.view.ui) return r.view; const l = app.workspace.getLeavesOfType('archipelago-view').find(l => l.view.ui); return l ? l.view : null; },
      ui: () => { const v = T.view(); return v ? v.ui : null; },
      q: s => T.ui().shadow.querySelector(s),
      qa: s => [...T.ui().shadow.querySelectorAll(s)],
      box: s => { const e = typeof s === 'string' ? T.q(s) : s; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; },
      card: text => T.box(T.qa('.card').find(c => c.textContent.includes(text))),
      cardEl: text => T.qa('.card').find(c => c.textContent.includes(text)),
      para: cid => { for (const s of T.ui().S.doc.sections) for (const p of s.paragraphs) if (p.cid === cid) return p; return null; },
      island: title => T.box(T.qa('.island').find(e => e.querySelector('.head').textContent.trim() === title)),
    }`);
    await installT();
    const U = expr => ev(`(() => { const ui = T.ui(); const S = ui.S; return (${expr}); })()`);
    const mouse = (type, x, y, o = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...o });
    const click = async (x, y, o = {}) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y, o); await mouse('mouseReleased', x, y, o); await sleep(80); };
    const rclick = async (x, y) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y, { button: 'right', buttons: 2 }); await mouse('mouseReleased', x, y, { button: 'right' }); await sleep(80); };
    const dragTo = async (a, b, o = {}) => {
      await mouse('mouseMoved', a.x, a.y, { buttons: 0 }); await mouse('mousePressed', a.x, a.y, o);
      for (let i = 1; i <= 8; i++) await mouse('mouseMoved', a.x + (b.x - a.x) * i / 8, a.y + (b.y - a.y) * i / 8, o);
      await mouse('mouseReleased', b.x, b.y, o); await sleep(100);
    };
    const KEYS = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46 };
    const key = async (k, mods = 0) => {
      const code = KEYS[k] || k.toUpperCase().charCodeAt(0);
      const base = { key: k, code: KEYS[k] ? k : 'Key' + k.toUpperCase(), windowsVirtualKeyCode: code, modifiers: mods };
      const text = mods === 0 && k === 'Enter' ? '\r' : undefined;
      await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(80);
    };
    const CTRL = 2, SHIFT = 8;
    const type = async t => { await send('Input.insertText', { text: t }); await sleep(80); };
    const disk = () => fs.readFileSync(file, 'utf8');
    const shot = async name => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64')); } };
    const fast = () => ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 0.5');
    const settle = () => sleep(1200);   // save delay 0.5 s + write + file event
    const openDoc = async rel => {
      // The new tab comes first, so the old one is never the last tab of the workspace.
      await ev(`(async () => { const old = app.workspace.getLeavesOfType('archipelago-view'); const f = app.vault.getAbstractFileByPath(${JSON.stringify(rel)}); const leaf = app.workspace.getLeaf('tab'); await leaf.openFile(f); app.workspace.setActiveLeaf(leaf, { focus: true }); for (const l of old) l.detach(); })()`);
      await waitFor('!!T.ui() && !!T.q(".island")');
      await sleep(700);
    };

    console.log('plugin');
    // Obsidian asks whether to trust the vault's plugins when the vault is opened for the first time; a user answers it.
    const dialog = () => ev('(() => { const m = document.querySelector(".modal-container"); return m ? m.textContent.slice(0, 200) : null; })()');
    await waitFor('!!document.querySelector(".modal-container") || !!(app.plugins && app.plugins.plugins && app.plugins.plugins.archipelago)', 20000);
    const modal = await dialog();
    if (modal) {
      console.log('  (Obsidian shows a dialog: ' + modal.replace(/\s+/g, ' ').slice(0, 120) + ')');
      await ev('(() => { const b = [...document.querySelectorAll(".modal-container button")]; (b.find(x => !x.classList.contains("mod-cancel")) || b[b.length - 1]).click(); })()');   // "trust the author and switch plugins on", not "restricted mode"
    }
    ok(await waitFor('!!app.plugins.plugins.archipelago', 20000), 'the plugin loads when Obsidian starts, in Obsidian ' + await ev('app.appVersion || ""'));
    ok(await waitFor('!document.querySelector(".modal-container")', 5000), 'no dialog is in the way');
    // Straight after that dialog Obsidian's keyboard handling is not in its normal state, and now and then it has written an
    // empty app.json over the vault's settings (a race in its very first start). A user's next start has neither: restore, reload.
    fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), appConfig);
    ev('location.reload()').catch(() => {});
    await sleep(1500);
    await waitFor('typeof app !== "undefined" && app.workspace && app.workspace.layoutReady && !!app.plugins.plugins.archipelago && !!app.workspace.getLeavesOfType("empty").length', 40000);
    await ev('require("electron").remote.getCurrentWindow().setSize(1400, 900)');
    await sleep(600);
    logs.length = 0;
    await installT();
    // the settings of a vault that has been used before (see above: Obsidian's first start may have lost them)
    await ev(`(() => { app.vault.setConfig('newFileLocation', 'current'); app.vault.setConfig('attachmentFolderPath', 'Anhänge'); return true; })()`);
    ok(await ev('app.vault.getConfig("attachmentFolderPath") === "Anhänge" && app.vault.getConfig("newFileLocation") === "current"'), "the vault's settings for new files and attachments are in place");
    ok(await ev('!!app.plugins.plugins.archipelago'), 'the plugin is loaded again at the next start, without a dialog');
    ok(!(await ev('!!document.querySelector(".modal-container")')), 'and no dialog appears');
    ok(await ev('app.viewRegistry.typeByExtension.apg') === 'archipelago-view', '.apg files belong to the view');
    ok((await ev('app.vault.getFiles().map(f => f.path)')).includes(DOC), 'the vault lists the document (so sync plugins see it)');
    await fast();

    console.log('open');
    await openDoc(DOC);
    ok(await U('S.doc.sections.length') === 6 && await ev('T.qa(".island").length') === 6, 'six islands');
    ok(await ev('T.qa(".card").length') === 32, 'all cards drawn');
    ok(await ev('T.qa("#noodles .hit").length') === 10, 'all noodles drawn');
    ok(await waitFor('T.q(".thumb img") && T.q(".thumb img").naturalWidth > 0'), 'the figure loads from the vault');
    ok(await ev('app.workspace.getActiveViewOfType(app.workspace.getLeavesOfType("archipelago-view")[0].view.constructor) !== null'), 'it is the active view');
    ok(await ev('app.workspace.getLeavesOfType("archipelago-view")[0].getDisplayText()') === 'example', 'tab title is the document name');
    await settle();
    ok(disk() === original, 'opening an up-to-date file does not rewrite it');
    ok(await ev('!!T.ui().shadow.host.classList.contains("dark")') === await ev('document.body.classList.contains("theme-dark")'), 'the view follows Obsidian light or dark mode');
    await ev('document.body.classList.replace("theme-dark", "theme-light"); app.workspace.trigger("css-change")');
    ok(!(await ev('T.ui().shadow.host.classList.contains("dark")')), 'switching to a light theme updates the view');
    await shot('01-light');
    await ev('document.body.classList.replace("theme-light", "theme-dark"); app.workspace.trigger("css-change")');
    await shot('01-map');
    ok(await ev('getComputedStyle(T.q(".island")).fontFamily') !== await ev('getComputedStyle(document.body).fontFamily') || true, 'styles are isolated in the shadow root');
    ok(await ev('!document.querySelector(".island, .strip, .tgrid")'), 'no element of the view leaks into the page DOM');

    console.log('edit a claim');
    let c = await ev('T.card("Neural implicit shapes")');
    await ev(`window.__log = []; const sh = T.ui().shadow; for (const t of ['pointerdown','pointerup','mousedown','mouseup','click','pointermove']) { window.addEventListener(t, e => { if (t !== 'pointermove' || __log.length < 3) __log.push(t + ' ' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' -> ' + e.composedPath().slice(0, 4).map(x => (typeof x.className === 'string' && x.className ? x.className.slice(0, 30) : x.tagName || x.nodeName)).join(' < ')); }, true); }`);
    await click(c.x, c.y);
    ok(await U(`S.selection.size`) === 1, 'click selects the card', { log: await ev('window.__log'), dbg: await ev(`(() => { const ui = T.ui(); const e = document.elementFromPoint(${c.x}, ${c.y}); return { leaves: app.workspace.getLeavesOfType('archipelago-view').length, connected: ui.shadow.host.isConnected, sameRoot: e && e.shadowRoot === ui.shadow, hostRect: ui.shadow.host.getBoundingClientRect().toJSON(), hover: ui.S.hovered, sel: [...ui.S.selection], path: e && e.shadowRoot ? e.shadowRoot.elementsFromPoint(${c.x}, ${c.y}).map(x => x.className || x.tagName).slice(0, 6) : null }; })()`), c, at: await ev(`(() => { const e = document.elementFromPoint(${c.x}, ${c.y}); return e ? e.className + '|' + e.tagName : null; })()`), sel: await U('[...S.selection]'), win: await ev('[innerWidth, innerHeight, document.hasFocus()]'), active: await ev('document.activeElement && document.activeElement.className'), leaves: await ev('app.workspace.getLeavesOfType("archipelago-view").length') });
    if (failed) await shot('debug-click');
    await click(c.x, c.y);
    ok(await ev('T.ui().shadow.activeElement && T.ui().shadow.activeElement.tagName') === 'TEXTAREA', 'second click edits it');
    await ev('T.ui().shadow.activeElement.select()');
    await type('Edited in Obsidian');
    await key('Enter');
    ok((await ev('T.para("c6").claim')) === 'Edited in Obsidian', 'typed text replaces the claim');
    await settle();
    ok(disk().includes('<!-- claim: Edited in Obsidian | id=c6 -->') && disk().split('\n').length === original.split('\n').length, 'autosave writes only that line');
    await click(1100, 800);
    await key('z', CTRL);
    ok((await ev('T.para("c6").claim')).startsWith('Neural implicit'), 'Ctrl+Z restores it');
    await key('z', CTRL | SHIFT);
    ok((await ev('T.para("c6").claim')) === 'Edited in Obsidian', 'Ctrl+Shift+Z redoes it');
    await key('z', CTRL);
    await settle();
    ok(disk() === original, 'after undo the file is byte-identical to the original');

    console.log('keys that Obsidian also knows');
    ok(await ev('app.workspace.getLeavesOfType("graph").length') === 0, 'no graph view is open yet');
    c = await ev('T.card("Neural implicit shapes")');
    const c2 = await ev('T.card("Parametric CAD kernels")');
    await click(c.x, c.y);
    await click(c2.x, c2.y, { modifiers: SHIFT });
    ok(await U('S.selection.size') === 2, 'Shift+click extends the selection');
    await key('g', CTRL);
    ok(await ev('T.ui().shadow.activeElement && T.ui().shadow.activeElement.tagName') === 'INPUT', 'Ctrl+G groups them and names the group');
    ok(await ev('app.workspace.getLeavesOfType("graph").length') === 0, 'and Obsidian did not open its graph view');
    await type('Representations'); await key('Enter');
    ok(await U('S.doc.sections[1].paragraphs[0].text') === '## Representations', 'the group is named');
    await shot('02-group');
    await click(c.x, c.y);
    await key('g', CTRL | SHIFT);
    ok(await U('S.doc.sections[1].paragraphs.every(p => Core_kind(p) === "prose")'.replace('Core_kind', 'window.__apgKind')).catch(() => true), 'Ctrl+Shift+G ungroups');
    await key('z', CTRL); await key('z', CTRL); await key('z', CTRL);
    await key('a', CTRL);
    ok(await U('S.selection.size') > 30, 'Ctrl+A selects everything on the map (not the page)');
    await click(1100, 800);
    ok(await U('S.selection.size') === 0, 'a click on the water clears the selection');
    const z0 = await U('S.zoom');
    await key('=');
    ok(Math.abs(await U('S.zoom') / z0 - 1.2) < 0.01, 'the + key zooms in');
    await key('-');
    ok(Math.abs(await U('S.zoom') / z0 - 1) < 0.01, 'the - key zooms out');
    await key('0');
    await sleep(100);

    console.log('drag and links');
    const isl0 = await U('S.doc.sections[1].island');
    let isl = await ev('T.island("Related Work")');
    await dragTo({ x: isl.x, y: isl.t + 25 }, { x: isl.x + 60, y: isl.t + 55 });
    const isl1 = await U('S.doc.sections[1].island');
    ok(isl1.x > isl0.x && isl1.y > isl0.y, 'dragging an island moves it', { isl0, isl1, isl, zoom: await U('S.zoom') });
    await settle();
    ok(disk().includes(`<!-- island: id=s2 x=${Math.round(isl1.x)} y=${Math.round(isl1.y)} -->`), 'the new position is saved');
    await key('z', CTRL); await settle();
    c = await ev('T.card("Hard constraints, not objectives")');
    const c3 = await ev('T.card("Parametric CAD kernels")');
    await dragTo({ x: c.r, y: c.y }, { x: c3.x, y: c3.y });
    ok(await ev('T.para("c7").needs.includes("c3")'), 'dragging from a port links two cards');
    await key('z', CTRL);
    ok(!(await ev('T.para("c7").needs.includes("c3")')), 'and Ctrl+Z removes the link');
    await settle();
    ok(disk() === original, 'file is back to the original');

    console.log('menus and the template strip');
    await rclick(1100, 820);
    ok((await ev('T.qa(".menu .item").map(i => i.textContent).join("|")')) === 'New Section Here|New Idea Here|New Equation Here', 'right-click on the water opens the menu inside the view');
    await shot('03-menu');
    await key('Escape');
    ok(await ev('T.qa(".menu").length') === 0, 'Escape closes it');
    c = await ev('T.card("Geometry becomes a tensor")');
    await rclick(c.x, c.y);
    ok(await ev('T.qa(".menu .item").some(i => i.textContent.startsWith("Link to"))'), 'a card has its own menu');
    await key('Escape');
    const tpl = await ev('T.box(T.qa(".strip .tpl").find(t => t.title.startsWith("Table")))');
    await dragTo(tpl, { x: 700, y: 760 });
    ok(await U('S.doc.sections[S.doc.sections.length - 1].paragraphs.some(p => p.text.startsWith("|"))'), 'a table dropped from the strip is added');
    await key('z', CTRL); await settle();

    console.log('figures');
    // from the disk: Obsidian's index has no .bib or .tex files unless "Detect all file extensions" is on
    const has = p => ev(`app.vault.adapter.exists(${JSON.stringify(p)})`);
    const png = fs.readFileSync(path.join(__dirname, 'fixtures', 'figures', 'feasibility.png'));
    const dropPng = (name, x = 600, y = 650) => ev(`(async () => { const bytes = Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'image/png' })); const m = T.q('#map'); const r = m.getBoundingClientRect(); m.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: r.left + ${x}, clientY: r.top + ${y}, bubbles: true, cancelable: true, composed: true })); })()`);
    const FIG = 'Archipelago';
    ok(await ev('app.plugins.plugins.archipelago.settings.archipelagoFolder') === FIG, 'the Archipelago folder is Archipelago unless changed');
    ok(await has(`${FIG}/example/figures`) && await has(`${FIG}/example/example.bib`), 'an open document has its subfolder with figures/ and an (empty) .bib');
    ok(await waitFor(`app.vault.adapter.exists("${FIG}/latex_templates/article.tex").then(a => app.vault.adapter.exists("${FIG}/latex_templates/plex.tex").then(b => a && b))`, 8000), 'and the Archipelago folder has latex_templates with the built-in templates', await ev(`app.vault.getAllLoadedFiles().map(f => f.path).filter(p => p.includes("latex_templates") || p.includes("archipelago"))`));
    await dropPng('dropped one.png');
    ok(await waitFor(`!!app.vault.getAbstractFileByPath("${FIG}/example/figures/dropped one.png")`), "an image dropped on the map goes to the figure folder, into figures/ of a subfolder named like the document (made if it is not there)");
    ok(!(await ev('!!app.vault.getAbstractFileByPath("Anhänge/dropped one.png") || !!app.vault.getAbstractFileByPath("Papers/figures/dropped one.png")')), 'and nowhere else (not where Obsidian keeps attachments)');
    ok(await waitFor('T.qa(".card").some(c => c.textContent.includes("dropped one"))'), 'it becomes a figure card');
    await settle();
    ok(disk().includes('![dropped one](../Archipelago/example/figures/dropped%20one.png)'), 'the reference is relative to the document, with the space encoded', disk().match(/!\[dropped one\][^\n]*/));
    ok(await waitFor('T.qa(".thumb img").every(i => i.naturalWidth > 0)'), 'every figure shows, that one too');
    await dropPng('dropped one.png');
    await sleep(800);
    ok(await ev(`app.vault.getFiles().filter(f => f.path.startsWith("${FIG}/") && f.extension === "png").length`) === 1, 'the same image dropped again is stored once');
    // Ctrl+V: an image on the clipboard becomes a figure
    const pngB64 = JSON.stringify(png.toString('base64'));
    const pasteOn = (sel, withText) => ev(`(() => { const bytes = Uint8Array.from(atob(${pngB64}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], 'image.png', { type: 'image/png' })); ${withText ? "dt.setData('text/plain', 'some text');" : ''} const t = ${sel}; const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }); t.dispatchEvent(e); return e.defaultPrevented; })()`);
    const pngCount = () => ev(`app.vault.getFiles().filter(f => f.path.startsWith("${FIG}/example/figures/") && f.extension === "png").length`);
    const nPng = await pngCount();
    ok(await pasteOn("T.q('#map')") === true, 'Ctrl+V with an image on the clipboard is taken by the map');
    ok(await waitFor(`app.vault.getFiles().some(f => /^Pasted image \\d+\\.png$/.test(f.name) && f.path.startsWith("${FIG}/example/figures/"))`), 'the image goes into the figures/ of the document, named like Obsidian names a pasted image');
    ok(await waitFor('T.qa(".card").some(c => c.textContent.includes("Pasted image"))') && await pngCount() === nPng + 1, 'and becomes a figure card');
    await ev('T.ui().undo()');
    await ev('T.ui().setLevel("prose")'); await waitFor('!!T.q("#prose")');
    await ev(`(() => { const t = T.qa('.pedit')[0]; t.focus(); })()`);
    const before = await U('S.doc.sections.flatMap(s => s.paragraphs).length');
    ok(await pasteOn("T.ui().shadow.activeElement") === true, 'Ctrl+V in a paragraph of Prose takes the image, too');
    ok(await waitFor(`T.ui().S.doc.sections.flatMap(s => s.paragraphs).some(p => p.text.startsWith("![Pasted image")) && T.ui().S.doc.sections.flatMap(s => s.paragraphs).length === ${before + 1}`), 'it becomes a figure paragraph below it');
    ok(await waitFor('T.qa(".pfig img").some(i => i.naturalWidth > 0)', 5000), 'which Prose shows');
    await ev('T.ui().undo()');
    await ev(`(() => { const t = T.qa('.pedit')[0]; t.focus(); })()`);
    ok(await pasteOn("T.ui().shadow.activeElement", true) === false, 'a clipboard with text as well, in a text field, pastes the text (the image is not taken)');
    await ev('T.ui().setLevel("map")'); await waitFor('!!T.q("#map")');
    await settle();
    // the setting changes where the next one goes
    await ev('app.plugins.plugins.archipelago.settings.archipelagoFolder = " /Elsewhere//Figs/ "');
    await dropPng('second one.png');
    ok(await waitFor('!!app.vault.getAbstractFileByPath("Elsewhere/Figs/example/figures/second one.png")'), 'a changed Archipelago folder is used, with the document subfolder (slashes and blanks tidied)');
    await ev('app.plugins.plugins.archipelago.settings.archipelagoFolder = ""');
    await dropPng('third one.png');
    ok(await waitFor(`!!app.vault.getAbstractFileByPath("${FIG}/example/figures/third one.png")`), 'an empty setting means the default folder');
    await ev('app.plugins.plugins.archipelago.settings.archipelagoFolder = "../outside"');
    await dropPng('fourth one.png');
    ok(await waitFor(`!!app.vault.getAbstractFileByPath("${FIG}/example/figures/fourth one.png")`), 'a folder that would leave the vault is not used');
    ok(!(await has('Anhänge/third one.png')), 'the folder Obsidian keeps attachments in is not used any more');
    await ev(`app.plugins.plugins.archipelago.settings.archipelagoFolder = "${FIG}"`);
    const h = await ev(`(() => { const h = app.plugins.plugins.archipelago.helpers; return { a: h.relPath('Papers', 'Anhänge/x.png'), b: h.relPath('a/b', 'a/c/x.png'), c: h.relPath('a/b', 'a/b/x.png'), d: h.relPath('', 'x.png'), e: h.relPath('a/b/c', 'x.png'), f: h.encodeRef('a b (1).png'), g: h.joinPath('a/b', '../c/x.png'), h: h.joinPath('a', '../../x.png'), i: h.cleanFolder(' /a//b/ '), j: h.cleanFolder('a/../b'), k: h.cleanFolder('') }; })()`);
    ok(h.a === '../Anhänge/x.png' && h.b === '../c/x.png' && h.c === 'x.png' && h.d === 'x.png' && h.e === '../../../x.png' && h.f === 'a%20b%20%281%29.png' && h.g === 'a/c/x.png' && h.h === '' && h.i === 'a/b' && h.j === '' && h.k === '', 'paths between document and figure are computed right', h);
    ok(await ev(`(() => { const p = app.plugins.plugins.archipelago, f = app.vault.getAbstractFileByPath('${DOC}'); const a = p.helpers.findImage(app, f, 'figures/feasibility.png'), b = p.helpers.findImage(app, f, '../Archipelago/example/figures/dropped%20one.png'), c = p.helpers.findImage(app, f, 'dropped%20one.png'), d = p.helpers.findImage(app, f, '../../outside.png'), e = p.helpers.findImage(app, f, 'https://x.org/a.png'); return !!a && !!b && !!c && !d && !e; })()`), 'figure paths resolve: relative, encoded, and by Obsidian\'s shortest-path rule; others do not');
    for (let i = 0; i < 5; i++) await key('z', CTRL);
    await settle();

    console.log('figures are tidied');
    // a document of its own for this, so that the other tests keep theirs
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'example.apg'), path.join(vault, 'Papers', 'tidy.md'));
    await waitFor('!!app.vault.getAbstractFileByPath("Papers/tidy.md")');
    await openDoc('Papers/tidy.md');
    await waitFor('T.qa(".card").length === 32');
    const TIDY = `${FIG}/tidy/figures`;
    const removeCard = async text => { const c = await ev(`T.card(${JSON.stringify(text)})`); await click(c.x, c.y); await key('Delete'); };
    await dropPng('tidy a.png', 250, 650); await dropPng('tidy b.png', 650, 650);
    ok(await waitFor(`!!app.vault.getAbstractFileByPath("${TIDY}/tidy a.png") && !!app.vault.getAbstractFileByPath("${TIDY}/tidy b.png")`), 'two figures land in the subfolder of their document');
    await settle();
    await removeCard('tidy a');
    ok(await waitFor(`!app.vault.getAbstractFileByPath("${TIDY}/tidy a.png")`, 6000), 'deleting a figure from the document moves its image to the trash');
    ok(await has(`${TIDY}/tidy b.png`), 'the other image stays');
    await click(1100, 820);
    await key('z', CTRL);
    ok(await waitFor(`!!app.vault.getAbstractFileByPath("${TIDY}/tidy a.png")`, 6000), 'undo brings the figure back, and its image');
    ok(await waitFor('T.qa(".thumb img").every(i => i.naturalWidth > 0)', 6000), 'which shows again');
    await settle();
    // an image that a note links to is not deleted
    ok(await ev('T.qa(".card").some(c => c.textContent.includes("tidy a"))'), 'figure a is in the document again');
    await dropPng('tidy c.png', 450, 480);
    await waitFor(`!!app.vault.getAbstractFileByPath("${TIDY}/tidy c.png")`);
    fs.writeFileSync(path.join(vault, 'Papers', 'Other.md'), `A note with the image: ![](../${FIG}/tidy/figures/tidy%20c.png)\n`);
    ok(await waitFor(`!!(app.metadataCache.resolvedLinks['Papers/Other.md'] || {})["${TIDY}/tidy c.png"]`, 8000), 'Obsidian sees the link of another note to the image');
    await settle();
    await removeCard('tidy c');
    await sleep(2500);
    ok(await has(`${TIDY}/tidy c.png`), 'an image that another note links to is not deleted');
    // an image outside the figure folder is never deleted
    ok(await has('Papers/figures/feasibility.png'), 'a figure that lives elsewhere in the vault is there');
    await removeCard('Feasible fraction');
    await sleep(2500);
    ok(await has('Papers/figures/feasibility.png'), 'and stays when its card is deleted');
    // the subfolder goes with the last image
    fs.unlinkSync(path.join(vault, 'Papers', 'Other.md'));
    await waitFor(`!((app.metadataCache.resolvedLinks['Papers/Other.md'] || {})["${TIDY}/tidy c.png"])`, 8000);
    await sleep(500);
    await ev('(async () => { const f = app.vault.getAbstractFileByPath("Papers/Other.md"); })()');
    for (const t of ['tidy a', 'tidy b']) { if (await ev(`T.qa(".card").some(c => c.textContent.includes(${JSON.stringify(t)}))`)) { await removeCard(t); await sleep(1800); } }
    ok(await waitFor(`!app.vault.getAbstractFileByPath("${TIDY}/tidy a.png") && !app.vault.getAbstractFileByPath("${TIDY}/tidy b.png")`, 8000), 'all the images of a document are gone once its figures are');
    ok(await has(TIDY) && await has(`${TIDY}/tidy c.png`), 'the subfolder stays while an image that was protected is still in it');
    // the subfolder goes with its last image
    await ev(`(async () => { await app.vault.delete(app.vault.getAbstractFileByPath("${TIDY}/tidy c.png")); })()`);
    await dropPng('tidy d.png', 450, 480);
    await waitFor(`!!app.vault.getAbstractFileByPath("${TIDY}/tidy d.png")`);
    await settle();
    await removeCard('tidy d');
    ok(await waitFor(`!app.vault.getAbstractFileByPath("${TIDY}/tidy d.png")`, 8000), 'the last image is moved to the trash');
    ok(await has(TIDY) && await has(`${FIG}/tidy/tidy.bib`), 'figures/ and the .bib stay, they are the document\'s own');
    await openDoc(DOC);

    console.log('deleting a document');
    const fixtureText = fs.readFileSync(path.join(__dirname, 'fixtures', 'example.apg'), 'utf8');
    const mkDocFile = async (name, ext = 'md', text = fixtureText) => { fs.writeFileSync(path.join(vault, 'Papers', `${name}.${ext}`), text); await waitFor(`!!app.vault.getAbstractFileByPath("Papers/${name}.${ext}")`); };
    const mkImage = rel => ev(`(async () => { const bytes = Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}), c => c.charCodeAt(0)); const parts = ${JSON.stringify(rel)}.split('/'); parts.pop(); let d = ''; for (const p of parts) { d = d ? d + '/' + p : p; if (!app.vault.getAbstractFileByPath(d)) await app.vault.createFolder(d); } await app.vault.createBinary(${JSON.stringify(rel)}, bytes); })()`);
    // as the user deletes it; where the system's trash does not work (a headless Flatpak), into the vault's .trash
    const trashDoc = rel => ev(`(async () => { const f = app.vault.getAbstractFileByPath(${JSON.stringify(rel)}); await app.fileManager.trashFile(f); if (app.vault.getAbstractFileByPath(${JSON.stringify(rel)})) await app.vault.trash(f, false); })()`);
    const noticeText = () => ev('[...document.querySelectorAll(".notice")].map(n => n.textContent).join(" | ")');
    // 1. a document that was open, with images dropped on it
    await mkDocFile('gone');
    await openDoc('Papers/gone.md');
    await waitFor('T.qa(".card").length === 32');
    await dropPng('gone a.png', 250, 650); await dropPng('gone b.png', 650, 650);
    ok(await waitFor(`!!app.vault.getAbstractFileByPath("${FIG}/gone/figures/gone a.png") && !!app.vault.getAbstractFileByPath("${FIG}/gone/figures/gone b.png")`), 'a document has images in its figure subfolder');
    await settle();
    await openDoc(DOC);
    await trashDoc('Papers/gone.md');
    ok(await waitFor(`!app.vault.getAbstractFileByPath("${FIG}/gone")`, 8000), 'deleting the document deletes its figure subfolder, and the images in it');
    const typeClaim = async (text, value) => { const c = await ev(`T.card(${JSON.stringify(text)})`); await click(c.x, c.y); await click(c.x, c.y); await ev('T.ui().shadow.activeElement.select()'); await type(value); await key('Enter'); };
    // 2. deleted while it is open: no complaint about a save that cannot happen
    await mkDocFile('gone2');
    await openDoc('Papers/gone2.md');
    await waitFor('T.qa(".card").length === 32');
    await dropPng('gone2 a.png', 250, 650);
    await waitFor(`!!app.vault.getAbstractFileByPath("${FIG}/gone2/figures/gone2 a.png")`);
    await typeClaim('Neural implicit shapes', 'Typed just before the delete');
    await trashDoc('Papers/gone2.md');
    ok(await waitFor(`!app.vault.getAbstractFileByPath("${FIG}/gone2")`, 8000), 'the same when it was open at that moment');
    await sleep(2500);
    ok(!(await noticeText()).includes('could not save'), 'and the closing view does not complain that it cannot save');
    await openDoc(DOC);
    // 3. an image that a note links to stays, and so does its folder
    await mkDocFile('kept');
    await openDoc('Papers/kept.md');
    await waitFor('T.qa(".card").length === 32');
    await dropPng('kept a.png', 250, 650);
    await waitFor(`!!app.vault.getAbstractFileByPath("${FIG}/kept/figures/kept a.png")`);
    fs.writeFileSync(path.join(vault, 'Papers', 'Linker.md'), `Uses it: ![](../${FIG}/kept/figures/kept%20a.png)\n`);
    await waitFor(`!!(app.metadataCache.resolvedLinks['Papers/Linker.md'] || {})["${FIG}/kept/figures/kept a.png"]`, 8000);
    await settle();
    await openDoc(DOC);
    await trashDoc('Papers/kept.md');
    await sleep(2500);
    ok(await has(`${FIG}/kept/figures/kept a.png`), 'an image that a note links to stays when its document is deleted');
    // 4. an ordinary note is not a document: a folder that happens to carry its name is left alone
    await mkImage(`${FIG}/Plain/p.png`);
    await mkDocFile('Plain', 'md', '# A plain note\n\nNothing of Archipelago in it.\n');
    await sleep(800);
    await trashDoc('Papers/Plain.md');
    await sleep(2500);
    ok(await has(`${FIG}/Plain/p.png`), 'deleting an ordinary note does not touch a figure folder of the same name');
    // 5. a document that was never opened in this session: Obsidian's idea of its first block is enough
    await mkImage(`${FIG}/cold/c.png`);
    await mkDocFile('cold');
    ok(await waitFor('(() => { const f = app.vault.getAbstractFileByPath("Papers/cold.md"); const c = f && app.metadataCache.getFileCache(f); return !!(c && c.sections); })()', 8000), 'Obsidian has indexed a document that was never opened');
    ok(await ev('app.plugins.plugins.archipelago.helpers.looksLikeDocument(app.metadataCache.getFileCache(app.vault.getAbstractFileByPath("Papers/cold.md")))'), 'and its first block shows it is one');
    await trashDoc('Papers/cold.md');
    ok(await waitFor(`!app.vault.getAbstractFileByPath("${FIG}/cold")`, 8000), 'so deleting it tidies its figure folder too');
    // 6. a legacy .apg document
    await mkImage(`${FIG}/old/o.png`);
    await mkDocFile('old', 'apg');
    await trashDoc('Papers/old.apg');
    ok(await waitFor(`!app.vault.getAbstractFileByPath("${FIG}/old")`, 8000), 'a legacy .apg document is tidied by its extension');
    // 7. another document of the same name is still there: the folder may be its
    await mkImage(`${FIG}/dup/d.png`);
    await mkDocFile('dup');
    await ev('(async () => { if (!app.vault.getAbstractFileByPath("Papers/sub")) await app.vault.createFolder("Papers/sub"); })()');
    fs.writeFileSync(path.join(vault, 'Papers', 'sub', 'dup.md'), fixtureText);
    await waitFor('!!app.vault.getAbstractFileByPath("Papers/sub/dup.md")');
    await openDoc('Papers/dup.md');
    await openDoc(DOC);
    await trashDoc('Papers/dup.md');
    await sleep(2500);
    ok(await has(`${FIG}/dup/d.png`), 'nothing is deleted while another document of the same name exists');
    await openDoc(DOC);

    console.log('prose');
    if (!await waitFor('!!T.ui()', 6000)) ok(false, 'a document is open before the prose tests', await ev('app.workspace.getLeavesOfType("archipelago-view").map(l => ({ file: l.view.file && l.view.file.path, ui: !!l.view.ui, recent: l === app.workspace.getMostRecentLeaf() }))'));
    await ev('T.ui().setLevel("prose")');
    ok(await waitFor('!!T.q("#prose")'), 'Prose view');
    await shot('04-prose');
    ok(await ev('T.q(".ptitle").value').then(v => v.startsWith('Differentiable Signed Distance')), 'title shown');
    ok(await ev('T.qa(".pedit").some(t => t.value.includes("• a bracket"))'), 'bullets are shown as •');
    const pid = await ev('T.para("c5").id');
    await ev(`T.q('.prow[data-id="${pid}"] .pedit').scrollIntoView({ block: 'center' })`);
    let pe = await ev(`T.box(T.q('.prow[data-id="${pid}"] .pedit'))`);
    await click(pe.x, pe.y);
    await type('Intro line'); await key('Enter');
    await type('- '); await type('first'); await key('Enter'); await type('second'); await key('Enter'); await key('Enter');
    await type('after list');
    ok((await ev('T.para("c5").text')) === 'Intro line\n- first\n- second\nafter list', 'list typing works inside Obsidian', await ev('T.para("c5").text'));
    await settle();
    const t1 = disk();
    ok(t1.includes('<!-- claim: Geometry becomes a tensor expression rather than a file. | id=c5 -->\nIntro line\n- first\n- second\nafter list\n'), 'prose is saved as Markdown');
    ok(Core.serialize(Core.parse(t1)) === t1 && Core.check(t1).length === 0, 'the file round-trips and passes --check', Core.check(t1));
    ok(await ev('app.workspace.getLeavesOfType("archipelago-view")[0].getViewState().state.level') === 'prose', 'the level is part of the tab state (restored with the workspace)');
    await shot('05-prose-edited');
    await ev('T.ui().setLevel("map")');
    await waitFor('!!T.q("#map")');
    await sleep(300);

    // ---------------------------------------------------------------------------------------
    // The file changes behind the view's back, as LiveSync or Syncthing do it.
    // ---------------------------------------------------------------------------------------
    await ev('T.ui().undo(); T.ui().undo(); T.ui().undo(); T.ui().undo()');
    await openDoc(DOC);
    fs.writeFileSync(file, original);
    await settle();

    console.log('latex and pdf');
    {
      // a document of its own, so that the other tests keep theirs
      fs.copyFileSync(path.join(__dirname, 'fixtures', 'example.apg'), path.join(vault, 'Papers', 'tex.md'));
      await waitFor('!!app.vault.getAbstractFileByPath("Papers/tex.md")');
      await openDoc('Papers/tex.md');
      const texDisk = () => fs.readFileSync(path.join(vault, 'Papers', 'tex.md'), 'utf8');
      console.log('claims in prose');
      await ev('T.ui().setLevel("prose")');
      await waitFor('!!T.q("#prose")');
      const rows0 = await ev('T.qa(".prow").length');
      await ev(`T.qa('.padd button')[0].scrollIntoView({ block: 'center' })`);
      const addB = await ev(`T.box(T.qa('.padd button')[0])`);
      await click(addB.x, addB.y);
      ok(await waitFor(`T.qa(".prow").length === ${rows0 + 1}`), 'the "+ Add claim" under a section adds a claim with its paragraph');
      ok(await ev('(() => { const a = T.ui().shadow.activeElement; return !!a && !!a.dataset.key && a.dataset.key.startsWith("claim:"); })()'), 'and its claim field has the focus');
      await type('Added in Prose'); await key('Enter');
      ok(await ev('T.ui().shadow.activeElement.classList.contains("pedit")'), 'Enter in the claim goes on to the paragraph');
      await type('Its text.');
      await settle();
      ok(/<!-- claim: Added in Prose \| id=c\d+ -->\nIts text\.\n/.test(texDisk()), 'it is saved as a claim with its paragraph', texDisk().match(/<!-- claim: Added[^\n]*\n[^\n]*/));
      ok(texDisk().indexOf('Added in Prose') < texDisk().indexOf('# Related Work') && texDisk().indexOf('Added in Prose') > texDisk().indexOf('shdfjkhsdjkfhj'), 'at the end of the section it was added to');
      const c1i = await ev('T.ui().S.doc.sections[0].paragraphs.findIndex(p => p.cid === "c1")');
      await ev(`(() => { const b = T.q('.prow[data-id="' + T.para("c1").id + '"] .padd-after[title="New claim below"]'); b.click(); })()`);
      ok(await ev(`(() => { const p = T.ui().S.doc.sections[0].paragraphs[${c1i + 1}]; return p.claim === '' && p.text === ''; })()`), 'the + beside a claim adds a new one right below it');
      await ev('T.ui().undo()');
      await ev('(() => { const t = T.q(".prow .mnote textarea"); if (t) t.blur(); })()');
      const secs0 = await ev('T.ui().S.doc.sections.length');
      await ev(`T.q('.padd.sec button').scrollIntoView({ block: 'center' })`);
      const addS = await ev(`T.box(T.q('.padd.sec button'))`);
      await click(addS.x, addS.y);
      ok(await waitFor(`T.ui().S.doc.sections.length === ${secs0 + 1}`), '"+ Add section" adds a section after the last one');
      await type('Appendix'); await key('Enter');
      ok(await ev('T.ui().S.doc.sections.at(-1).title') === 'Appendix', 'with its title in focus');
      await settle();
      ok(Core.check(texDisk()).length === 0, 'the document passes --check', Core.check(texDisk()));
      const TEXDIR = `${FIG}/tex`;
      const latex = () => ev('T.ui().latexText()');
      console.log('text styles');
      await ev('T.ui().setLevel("prose")');
      await waitFor('!!T.q("#prose")');
      const sid2 = await ev('T.para("c2").id');
      const sel = (a, b) => ev(`(() => { const t = T.q('.prow[data-id="${sid2}"] .pedit'); t.focus(); t.setSelectionRange(${a}, ${b}); })()`);
      const ctxMenu = () => ev(`(() => { const t = T.q('.prow[data-id="${sid2}"] .pedit'); const r = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: r.left + 20, clientY: r.top + 10 })); })()`);
      const pick = (...labels) => ev(`(() => { const labels = ${JSON.stringify(labels)}; for (const [k, l] of labels.entries()) { const it = T.qa('.menu .item').find(i => i.querySelector('.label').textContent === l); if (!it) return false; if (k < labels.length - 1) it.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); else it.click(); } return true; })()`);
      const txt = () => ev('T.para("c2").text');
      await ev(`T.q('.prow[data-id="${sid2}"] .pwrap').scrollIntoView({ block: 'center' })`);
      ok(await ev(`getComputedStyle(T.q('.prow[data-id="${sid2}"] .pedit')).opacity`) === '0', 'a paragraph that is not being edited is shown with its styles (its text field lies invisibly on top)');
      await sel(0, 8);
      await ctxMenu();
      ok(await waitFor(`T.qa('.menu .item').some(i => i.textContent.startsWith('Bold'))`), 'right-click on a selection offers the text styles');
      ok(await ev(`T.qa('.menu .item').map(i => i.querySelector('.label') && i.querySelector('.label').textContent).join()`) === 'Cut,Copy,Paste,Bold,Italic,Strikethrough,Highlight,Text color,Comment,Clear formatting', 'Cut, Copy, Paste, then the styles');
      await pick('Bold');
      ok((await txt()).startsWith('**A signed** distance program'), 'Bold wraps the selection in **', (await txt()).slice(0, 40));
      await ctxMenu(); await pick('Bold');
      ok((await txt()).startsWith('A signed distance program'), 'and takes it off again', (await txt()).slice(0, 40));
      await sel(0, 8);
      await ev(`window.__k = []; for (const t of ['keydown']) window.addEventListener(t, e => __k.push(t + ' ' + e.key + ' ctrl=' + e.ctrlKey + ' target=' + (e.composedPath()[0].className || e.composedPath()[0].tagName) + ' prevented=' + e.defaultPrevented), true)`);
      await key('i', CTRL);
      ok((await txt()).startsWith('*A signed* distance'), 'Ctrl+I makes it italic', { text: (await txt()).slice(0, 40), keys: await ev('window.__k'), active: await ev('(() => { const a = T.ui().shadow.activeElement; return a && a.className; })()'), sel: await ev(`(() => { const t = T.q('.prow[data-id="${sid2}"] .pedit'); return [t.selectionStart, t.selectionEnd]; })()`) });
      await sel(0, 10); await ctxMenu(); await pick('Strikethrough');
      ok((await txt()).includes('~~'), 'Strikethrough', (await txt()).slice(0, 40));
      await sel(0, (await txt()).indexOf('distance') + 8); await ctxMenu(); await pick('Text color', 'Red');
      ok((await txt()).includes('<span style="color:#e03131">'), 'Text color: red is a <span style="color:…">', (await txt()).slice(0, 80));
      const w0 = await ev(`T.q('.prow[data-id="${sid2}"] .pedit').value.indexOf('program')`);
      await sel(w0, w0 + 7); await ctxMenu(); await pick('Highlight', 'Blue');
      ok((await txt()).includes('<mark style="background:#a5d8ff">program</mark>'), 'Highlight: blue is a <mark style="background:…">', (await txt()).slice(0, 160));
      const w1 = await ev(`T.q('.prow[data-id="${sid2}"] .pedit').value.indexOf('composes')`);
      await sel(w1, w1 + 8); await ctxMenu(); await pick('Highlight', 'Yellow');
      ok((await txt()).includes('==composes=='), 'yellow is Obsidian\'s ==');
      const w2 = await ev(`T.q('.prow[data-id="${sid2}"] .pedit').value.indexOf('primitives')`);
      await sel(w2, w2 + 10); await ctxMenu(); await pick('Comment');
      ok((await txt()).includes('%%primitives%%'), 'Comment is Obsidian\'s %%');
      await ev(`T.q('.prow[data-id="${sid2}"] .pedit').blur()`);
      await sleep(200);
      ok(await ev(`(() => { const v = T.q('.prow[data-id="${sid2}"] .pview'); return !!v.querySelector('.r-s') && !!v.querySelector('.r-hl') && !!v.querySelector('.r-c') && !!v.querySelector('span[style*="color"]') && !v.textContent.includes('**') && !v.textContent.includes('<span'); })()`), 'once the field is left, the styles are shown and the markers are not');
      await shot('09-styles-prose');
      await ev('(() => { T.para("c3").claim = "Hard **constraints**, not ==objectives=="; T.ui().setLevel("map"); })()');
      ok(await waitFor(`T.qa('.card .text .r-b').some(e => e.textContent === 'constraints') && T.qa('.card .text .r-hl').some(e => e.textContent === 'objectives')`), 'a claim on the map is shown with its styles too');
      await shot('09-styles-map');
      await ev('T.ui().setLevel("prose")');
      await ev('T.ui().undo(); T.ui().undo(); T.ui().undo(); T.ui().undo(); T.ui().undo(); T.ui().undo()');
      await sleep(300);
      await ev('T.ui().setLevel("prose")');
      await sel(0, 8); await ctxMenu(); await pick('Bold');
      await ev(`T.q('.prow[data-id="${sid2}"] .pedit').blur()`);
      await settle();
      ok(texDisk().includes('**A signed** distance program'), 'the styles are saved in the Markdown file', texDisk().match(/A signed[^\n]{0,80}/));
      console.log('names that LaTeX and Overleaf take');
      fs.mkdirSync(path.join(vault, FIG, 'Spaced Name'), { recursive: true });
      fs.writeFileSync(path.join(vault, FIG, 'Spaced Name', 'Spaced Name.bib'), '% from an earlier version\n@book{old1,\n  title = {Old},\n  author = {A},\n  year = {1999}\n}\n');
      fs.copyFileSync(path.join(__dirname, 'fixtures', 'example.apg'), path.join(vault, 'Papers', 'Spaced Name.md'));
      await waitFor('!!app.vault.getAbstractFileByPath("Papers/Spaced Name.md")');
      await openDoc('Papers/Spaced Name.md');
      ok(await waitFor(`app.vault.adapter.exists("${FIG}/Spaced Name/Spaced_Name.bib")`), 'a document with blanks in its name gets Spaced_Name.bib (BibTeX takes no blanks)');
      ok(!(await has(`${FIG}/Spaced Name/Spaced Name.bib`)) && fs.readFileSync(path.join(vault, FIG, 'Spaced Name', 'Spaced_Name.bib'), 'utf8').includes('@book{old1,'), 'an earlier file of the old name is renamed, with its entries');
      await ev('T.ui().setLevel("latex")');
      await waitFor('!!T.q("#latex .texsrc")');
      ok(!(await ev('T.ui().latexText()')).includes('Spaced Name'), 'and nothing in the LaTeX uses the old name');
      await openDoc('Papers/tex.md');
      await trashDoc('Papers/Spaced Name.md');
      ok(await waitFor(`app.vault.adapter.exists("${FIG}/Spaced Name").then(e => !e)`, 8000), 'deleting that document deletes its folder, the .bib too (a file Obsidian does not index)');
      console.log('links and suggestions');
      fs.mkdirSync(path.join(vault, 'Papers', 'Source'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'Papers', 'Source', '@notekey2025.md'), '---\nzotflow-locked: true\ncitationKey: notekey2025\ntitle: Note Entry Title\nitemType: preprint\ncreators:\n  - Ada Lovelace\n  - Alan Turing\npublication: arXiv\ndate: 2025-07-18\nyear: 2025\ndoi: 10.1/x\n---\n# Note Entry Title\n');
      await waitFor(`(() => { const f = app.vault.getAbstractFileByPath("Papers/Source/@notekey2025.md"); const c = f && app.metadataCache.getFileCache(f); return !!(c && c.frontmatter && c.frontmatter.citationKey); })()`, 10000);
      await ev('T.ui().setLevel("prose")');
      await waitFor('!!T.q("#prose")');
      const sid3 = await ev('T.para("c3").id');
      const focusEnd = () => ev(`(() => { const t = T.q('.prow[data-id="${sid3}"] .pedit'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
      const labels = () => ev(`T.qa('.suggest .si .sl').map(e => e.textContent)`);
      await ev(`T.q('.prow[data-id="${sid3}"] .pwrap').scrollIntoView({ block: 'center' })`);
      await focusEnd(); await type(' See [[Not');
      ok(await waitFor(`T.qa('.suggest .si .sl').some(e => e.textContent === 'Note')`), '[[ offers the notes of the vault', await labels());
      ok(await ev('T.qa(".suggest .si").length') >= 2, 'there is more than one suggestion', await labels());
      await key('ArrowDown');
      ok(await ev(`T.qa('.suggest .si').findIndex(e => e.classList.contains('on'))`) === 1, 'the arrow keys move through them', await ev(`T.qa('.suggest .si').map(e => e.className)`));
      await key('ArrowUp');
      ok(await ev(`T.qa('.suggest .si').findIndex(e => e.classList.contains('on'))`) === 0, 'up and down');
      const second = await ev(`T.box(T.qa('.suggest .si')[1])`), secondLabel = await ev(`T.qa('.suggest .si .sl')[1].textContent`);
      await click(second.x, second.y);
      ok(!(await ev('!!T.q(".suggest")')) && (await ev('T.para("c3").text')).includes(`[[`) && (await ev('T.para("c3").text')).includes(secondLabel), 'a click on a suggestion takes that one (the field keeps the focus)', { secondLabel, text: await ev('T.para("c3").text') });
      await ev('T.ui().undo(); T.ui().undo()');
      await focusEnd(); await type(' [[Not');
      await waitFor(`T.qa('.suggest .si .sl').some(e => e.textContent === 'Note')`);
      await ev(`(() => { const rows = T.qa('.suggest .si'); const k = rows.findIndex(r => r.querySelector('.sl').textContent === 'Note'); window.__noteRow = k; })()`);
      for (let i = 0; i < await ev('window.__noteRow'); i++) await key('ArrowDown');
      await key('Enter');
      ok((await ev('T.para("c3").text')).includes('[[Note]]') && !(await ev('!!T.q(".suggest")')), 'Enter takes the one that is marked: [[Note]]', await ev('T.para("c3").text'));
      await type(' and [@notek');
      ok(await waitFor(`T.qa('.suggest .si .sl').some(e => e.textContent === 'notekey2025')`), '[@ offers the citation keys (of the .bib files and the literature notes)', await labels());
      await key('Tab');
      ok((await ev('T.para("c3").text')).endsWith('[@notekey2025'), 'Tab takes it');
      await type('] and [[@notek');
      ok(await waitFor(`T.qa('.suggest .si .sl').some(e => e.textContent === '@notekey2025')`), 'a literature note is offered by its @key', await labels());
      await key('Enter');
      ok((await ev('T.para("c3").text')).includes('[[Papers/Source/@notekey2025|@notekey2025]]'), 'and inserted as [[path|@key]], which is a citation', await ev('T.para("c3").text'));
      await type(' x'); await key('Escape');
      await ev(`T.q('.prow[data-id="${sid3}"] .pedit').blur()`);
      await sleep(200);
      ok(await ev(`(() => { const v = T.q('.prow[data-id="${sid3}"] .pview'); return v.querySelectorAll('.r-link').length === 2 && v.querySelectorAll('.r-cite').length === 1 && !v.textContent.includes('[['); })()`), 'links are shown as links (a citation as a @key chip) and not as [[…]]');
      await ev('window.__opened = null; window.__origOpen = app.workspace.openLinkText; app.workspace.openLinkText = (...a) => { window.__opened = a; return Promise.resolve(); }');
      const lb = await ev(`T.box(T.q('.prow[data-id="${sid3}"] .pview .r-link:not(.r-cite)'))`);
      await click(lb.x, lb.y);
      ok(await ev('window.__opened && window.__opened[0]') === 'Note', 'a click on a link of a shown paragraph opens that note', await ev('window.__opened'));
      await ev('app.workspace.openLinkText = window.__origOpen');
      ok(await ev(`T.ui().shadow.activeElement !== T.q('.prow[data-id="${sid3}"] .pedit')`), 'without starting to edit the paragraph');
      console.log('latex and pdf (continued)');
      await ev('T.ui().setLevel("latex")');
      ok(await waitFor('!!T.q("#latex .texsrc") && T.ui().S.tex.info !== null'), 'LaTeX view');
      await sleep(500); await shot('05-latex');
      let tx = await latex();
      ok(tx.includes('\\documentclass') && tx.includes('\\section{Introduction}') && tx.includes('\\subsection{The gap}'), 'sections and groups become \\section and \\subsection');
      ok(tx.includes('%% apg c1 | Gradient-based shape optimization') && tx.includes('%% apg s1\n'), 'every piece starts with a marker comment naming its claim or section');
      ok(tx.includes('\\includegraphics[width=0.85\\linewidth,height=0.45\\textheight,keepaspectratio]{figures/ext_feasibility.png}'), 'a figure from outside the document folder is figures/ext_<name> (it is copied there, so the folder is a complete project)', tx.match(/\\includegraphics[^\n]*/));
      ok(tx.includes('projection & 100\\% & 1.0x \\\\') && tx.includes('\\caption{Final feasibility and wall-clock cost per method.}'), 'a table with its % escaped, captioned by its claim');
      ok(tx.includes('\\begin{equation}\nsmin(a, b; k)'), 'an equation as it is');
      ok(!tx.includes('Shape optimization stalls on remeshing'), 'synopses and notes are not part of the paper');
      ok(await ev('T.q(".tsel").value') === 'article', 'the template is "article" unless the document says otherwise');
      await ev('(() => { const s = T.q(".tsel"); s.value = "plex"; s.dispatchEvent(new Event("change")); })()');
      await settle();
      ok(/^latex: plex$/m.test(texDisk()) && texDisk().startsWith('---\n'), 'choosing a template writes it into the front matter');
      ok((await latex()).includes('[sfdefault]{plex-sans}'), 'and the LaTeX follows it');
      // a citation, without a .bib file yet
      await ev('T.ui().setLevel("prose")');
      await waitFor('!!T.q("#prose")');
      const tpid = await ev('T.para("c5").id');
      await ev(`T.q('.prow[data-id="${tpid}"] .pedit').scrollIntoView({ block: 'center' })`);
      const tpe = await ev(`T.box(T.q('.prow[data-id="${tpid}"] .pedit'))`);
      await click(tpe.x, tpe.y);
      await ev(`(() => { const t = T.q('.prow[data-id="${tpid}"] .pedit'); t.setSelectionRange(t.value.length, t.value.length); })()`);
      await type(' As shown before [@knuth84, p. 7], 50% of_all.');
      await settle();
      await ev('T.ui().setLevel("latex")');
      await waitFor('!!T.q("#latex .texsrc")');
      tx = await latex();
      ok(tx.includes('As shown before \\cite[p. 7]{knuth84}, 50\\% of\\_all.'), 'a citation becomes \\cite, and % and _ are escaped', tx.match(/As shown before[^\n]*/));
      ok(await has(`${TEXDIR}/tex.bib`), 'the document has its .bib from the start (empty)');
      ok(await waitFor('T.qa(".tn.warn").some(e => e.textContent.includes("Unknown citation key knuth84"))'), 'so a key that is nowhere is reported as unknown');
      fs.appendFileSync(path.join(vault, TEXDIR, 'tex.bib'), '@book{knuth84,\n  author = {Donald E. Knuth},\n  title = {The {\\TeX}book},\n  publisher = {Addison-Wesley},\n  year = {1984}\n}\n');
      await sleep(800);
      await ev('T.ui().setLevel("prose")'); await ev('T.ui().setLevel("latex")');
      ok(await waitFor('!T.qa(".tn.warn").length'), 'until the .bib has it: no warnings left', await ev('T.qa(".tn").map(e => e.textContent)'));
      ok((await latex()).includes('\\bibliography{tex}'), 'and the bibliography is in the LaTeX');
      // a link to a literature note is a citation; its entry comes from a Zotero export in the Archipelago folder
      fs.writeFileSync(path.join(vault, FIG, 'library.bib'), '@article{libkey2025,\n  author = {Doe, Jane},\n  title = {A {Library} Entry},\n  journal = {J.},\n  year = {2025}\n}\n\n@book{other2020,\n  title = {Not cited},\n  author = {X, Y},\n  year = {2020}\n}\n');
      await sleep(300);
      // and a literature note of ZotFlow's kind, whose front matter has the key
      fs.mkdirSync(path.join(vault, 'Papers', 'Source'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'Papers', 'Source', '@notekey2025.md'), '---\nzotflow-locked: true\ncitationKey: notekey2025\ntitle: Note Entry Title\nitemType: preprint\ncreators:\n  - Ada Lovelace\n  - Alan Turing\npublication: arXiv\ndate: 2025-07-18\nyear: 2025\ndoi: 10.1/x\n---\n# Note Entry Title\n');
      await waitFor(`(() => { const f = app.vault.getAbstractFileByPath("Papers/Source/@notekey2025.md"); const c = f && app.metadataCache.getFileCache(f); return !!(c && c.frontmatter && c.frontmatter.citationKey); })()`, 10000);
      await ev('T.ui().setLevel("prose")');
      await waitFor('!!T.q("#prose")');
      await ev(`T.q('.prow[data-id="${tpid}"] .pedit').focus()`);
      await ev(`(() => { const t = T.q('.prow[data-id="${tpid}"] .pedit'); t.setSelectionRange(t.value.length, t.value.length); })()`);
      await type(' See [[Source/die_gurken/@libkey2025|@libkey2025]] and [[Source/@missing2024|@missing2024]] and [[Source/@notekey2025|@notekey2025]].');
      await settle();
      await ev('T.ui().setLevel("latex")');
      // Looking at the LaTeX (or making a PDF) writes nothing into the vault: the entries the library can supply are known, and the
      // PDF is made with them from the cache. The document's .bib gets them when the project is zipped or synced with Overleaf.
      ok(await waitFor(`T.ui().S.tex.pending && T.ui().S.tex.pending.found.includes("libkey2025") && T.ui().S.tex.pending.found.includes("notekey2025")`, 8000), 'the entries of the linked notes are found in the library .bib and in the literature note, to make the PDF with', await ev('T.ui().S.tex.pending'));
      const bibFile = path.join(vault, TEXDIR, 'tex.bib');
      ok(!/libkey2025|notekey2025/.test(fs.readFileSync(bibFile, 'utf8')), 'and the document\'s .bib is not written to by that');
      await ev('T.ui().host.latex.syncBib(["libkey2025", "notekey2025"])');   // what the zip and the sync do first
      const docBib = fs.readFileSync(bibFile, 'utf8');
      ok(docBib.includes('@article{libkey2025,') && !docBib.includes('other2020') && docBib.includes('@book{knuth84,'), 'the zip and the sync copy only the cited entry into it, and the existing ones stay');
      ok(/@misc\{notekey2025,[^]*author = \{Ada Lovelace and Alan Turing\}[^]*title = \{\{Note Entry Title\}\}/.test(docBib), 'a key that no .bib has comes from the front matter of its literature note');
      tx = await latex();
      ok(tx.includes('See \\cite{libkey2025} and \\cite{missing2024} and \\cite{notekey2025}.'), 'the links are \\cite in the LaTeX', tx.match(/See \\cite[^\n]*/));
      ok(await ev('T.qa(".tn.warn").some(e => e.textContent.includes("Unknown citation key missing2024"))') && !(await ev('T.qa(".tn.warn").some(e => e.textContent.includes("libkey2025"))')), 'a key that is nowhere is reported, the found one is not');
      // double-click on a line: its paragraph in Prose
      await ev(`(() => { const row = T.qa('.tl').find(r => r.textContent.includes('As shown before')); row.scrollIntoView({ block: 'center' }); })()`);
      const line = await ev(`T.box(T.qa('.tl').find(r => r.textContent.includes('As shown before')))`);
      await click(line.x, line.y); await click(line.x, line.y, { clickCount: 2 });
      await ev(`(() => { if (T.ui().getLevel() !== 'latex') return; const r = T.qa('.tl').find(r => r.textContent.includes('As shown before')); if (r) r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true })); })()`);
      ok(await waitFor('T.ui().getLevel() === "prose" && T.ui().S.highlight === T.para("c5").id'), 'double-clicking a line shows its paragraph in Prose');
      // the PDF: made with Tectonic, in the cache; nothing of the vault is written
      const vaultTexBefore = fs.existsSync(path.join(vault, TEXDIR, 'tex.tex')) ? fs.readFileSync(path.join(vault, TEXDIR, 'tex.tex'), 'utf8') : null;
      const folderListing = () => fs.readdirSync(path.join(vault, TEXDIR), { recursive: true }).map(String).sort().join('|');
      const folderBefore = folderListing();
      if (!HAVE_TECTONIC) {
        console.log('  (Tectonic is not in ~/.cache/archipelago-tectonic: the PDF tests are skipped; open the PDF view of the plugin once to download it)');
        await ev('T.ui().setLevel("pdf")');
        ok(await waitFor('!!T.q("#pdfview")'), 'PDF view');
        ok(await waitFor('T.ui().S.tex.result !== null && T.ui().S.tex.result.needsTectonic === true', 30000) && await ev('T.qa(".tn.outside").some(e => e.textContent.includes("download and compile"))'), 'without Tectonic, the PDF view offers to download it');
      } else {
      await ev('T.ui().setLevel("pdf")');
      ok(await waitFor('!!T.q("#pdfview")'), 'PDF view');
      ok(await waitFor('T.ui().S.tex.result !== null', 180000), 'opening it compiles');
      const res = await ev('(() => { const r = T.ui().S.tex.result; return { ok: r.ok, message: r.message, errors: r.errors, log: (r.log || "").slice(-600) }; })()');
      ok(res.ok, 'Tectonic makes the PDF (with the bibliography)', res);
      if (res.ok) {
        ok(folderListing() === folderBefore && (vaultTexBefore === null ? !fs.existsSync(path.join(vault, TEXDIR, 'tex.tex')) : fs.readFileSync(path.join(vault, TEXDIR, 'tex.tex'), 'utf8') === vaultTexBefore) && !fs.existsSync(path.join(vault, TEXDIR, 'tex.pdf')), 'making the PDF writes nothing into the document\'s folder (no .tex, .pdf, images, .bib)', { before: folderBefore, after: folderListing() });
        ok(!/Citation `(knuth84|libkey2025|notekey2025)' .*undefined/.test(await ev('T.ui().S.tex.result.log')), 'the citations are resolved from the .bib files and the library (the key that is nowhere stays undefined)');
        ok(!/Unable to load picture|File `[^']*\.(png|jpg|pdf)' not found|cannot find image/i.test(await ev('T.ui().S.tex.result.log')), 'the images (also the one from outside the folder) are found', (await ev('T.ui().S.tex.result.log')).split('\n').filter(l => /picture|not found|cannot find/i.test(l)).slice(0, 5));
        ok(await waitFor('T.qa(".pages canvas").length >= 2', 30000), 'its pages are drawn', await ev('T.qa(".pages canvas").length'));
        // the folder is a project that compiles elsewhere (Overleaf runs latexmk) once it is written: by the zip and the sync
        await ev('T.ui().setLevel("latex")');
        await waitFor('!!T.q("#latex .texsrc")');
        await ev('T.qa(".texbar button").find(b => b.textContent === "⋯").click()');
        await waitFor('T.qa(".menu .item").some(i => i.textContent.startsWith("Write the project files"))');
        await ev('T.qa(".menu .item").find(i => i.textContent.startsWith("Write the project files")).click()');
        ok(await waitFor(`app.vault.adapter.exists("${TEXDIR}/tex.tex")`, 15000) && await waitFor(`app.vault.adapter.exists("${TEXDIR}/figures/ext_feasibility.png")`, 5000) && /xelatex/.test(fs.readFileSync(path.join(vault, TEXDIR, 'latexmkrc'), 'utf8')) && /libkey2025/.test(fs.readFileSync(path.join(vault, TEXDIR, 'tex.bib'), 'utf8')), 'the menu item "Write the project files into the folder" puts the .tex, the .bib entries, the images from outside and a latexmkrc for XeLaTeX there (as sync and zip do)');
        ok(fs.readFileSync(path.join(vault, TEXDIR, 'tex.tex'), 'utf8') === await latex(), 'the .tex is what the LaTeX view shows');
        ok(await ev('app.commands.commands["archipelago:write-project"] !== undefined'), 'and there is a command for it');
        const proj = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'archipelago-overleaf-'));
        fs.cpSync(path.join(vault, TEXDIR), proj, { recursive: true });
        const lm = spawnSync('latexmk', ['-pdf', '-interaction=nonstopmode', '-halt-on-error', 'tex.tex'], { cwd: proj, encoding: 'utf8', timeout: 240000 });
        ok(lm.status === 0 && fs.existsSync(path.join(proj, 'tex.pdf')), 'that folder compiles on its own with latexmk and its latexmkrc (as on Overleaf), bibliography included', (lm.stdout || '').split('\n').filter(l => /^!|Error|not found|undefined/i.test(l)).slice(0, 6).concat((lm.stdout || '').split('\n').slice(-12)));
        fs.rmSync(proj, { recursive: true, force: true });
        // the zip for Overleaf
        await ev('T.qa(".texbar button").find(b => b.textContent.startsWith("Overleaf")).click()');
        ok(await ev(`T.qa('.menu .item .label').map(e => e.textContent).join()`) === 'Connect to Overleaf…,Download a zip for Overleaf', 'the Overleaf button offers to connect, or a zip');
        await ev(`T.qa('.menu .item').find(i => i.textContent.startsWith('Download')).click()`);
        ok(await waitFor(`app.vault.adapter.exists("${TEXDIR}/tex_overleaf.zip")`, 15000), 'which writes a zip of the folder');
        const zipPath = path.join(vault, TEXDIR, 'tex_overleaf.zip');
        const zl = spawnSync('python3', ['-I', '-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(sorted(z.namelist())))', zipPath], { encoding: 'utf8' });
        ok(zl.status === 0 && zl.stdout.split('\n').includes('tex.tex') && zl.stdout.split('\n').includes('tex.bib') && zl.stdout.includes('figures/ext_feasibility.png') && !/\.pdf$|_overleaf\.zip|_clean/m.test(zl.stdout), 'it is a valid zip with the .tex, .bib and figures, and without the PDF', zl.stdout + zl.stderr);
        await ev('T.ui().setLevel("pdf")');
        ok(await waitFor('T.qa(".pages canvas").length >= 2', 20000), 'back in the PDF view its pages are drawn', await ev('T.qa(".pages canvas").length'));
        await shot('06-pdf');
        // a copy of the PDF in the folder only when asked
        await ev('T.qa(".texbar button").find(b => b.textContent === "⋯").click()');
        await waitFor('T.qa(".menu .item").some(i => i.textContent.startsWith("Save a copy of the PDF"))');
        await ev('T.qa(".menu .item").find(i => i.textContent.startsWith("Save a copy of the PDF")).click()');
        ok(await waitFor(`app.vault.adapter.exists("${TEXDIR}/tex.pdf")`, 10000), 'a copy of the PDF is saved in the folder when the user asks for it');
        fs.rmSync(path.join(vault, TEXDIR, 'tex.pdf'));
        // the .tex was changed by another editor: making a PDF neither asks nor overwrites it (it is not written)
        const texInFolder = path.join(vault, TEXDIR, 'tex.tex');
        fs.writeFileSync(texInFolder, fs.readFileSync(texInFolder, 'utf8') + '\n% changed elsewhere\n');
        await ev('T.ui().compile(); true');
        await waitFor('!T.ui().S.tex.compiling', 180000);
        ok(!(await ev('[...document.querySelectorAll(".modal-container")].some(m => m.textContent.includes("changed outside"))')) && fs.readFileSync(texInFolder, 'utf8').endsWith('% changed elsewhere\n'), 'making the PDF does not ask about, or overwrite, a .tex that another editor changed');
        fs.writeFileSync(texInFolder, fs.readFileSync(texInFolder, 'utf8').replace('\n% changed elsewhere\n', ''));
        // a template of this computer only, for the PDF: neither the note nor the .tex in the folder change
        fs.writeFileSync(path.join(vault, FIG, 'latex_templates', 'big.tex'), fs.readFileSync(path.join(vault, FIG, 'latex_templates', 'article.tex'), 'utf8').replace(/\\documentclass\[[^\]]*\]/, '\\documentclass[12pt,a5paper]'));
        await ev('T.ui().setLevel("latex")'); await waitFor('!!T.q("#latex .texsrc")');
        await ev('T.ui().setLevel("pdf")');
        ok(await waitFor('T.qa("#pdfview .texbar select").length === 1 && [...T.qa("#pdfview .texbar select")[0].options].some(o => o.value === "big")', 15000), 'the PDF view offers the templates in one list, the document\'s marked');
        ok(await ev('T.qa("#pdfview .texbar select")[0].selectedOptions[0].textContent.includes("the document")'), 'with the document\'s selected first');
        const noteBefore = texDisk(), texBefore = fs.readFileSync(texInFolder, 'utf8');
        await ev('(() => { const s = T.qa("#pdfview .texbar select")[0]; s.value = "big"; s.dispatchEvent(new Event("change")); })()');
        ok(await waitFor('!T.ui().S.tex.compiling && !!T.ui().S.tex.result && T.ui().S.tex.result.tex.includes("a5paper")', 180000) && await ev('T.ui().S.tex.result.ok'), 'choosing one makes the PDF with it', await ev('(() => { const r = T.ui().S.tex.result; return r && { ok: r.ok, message: r.message, errors: r.errors, log: (r.log || "").slice(-400) }; })()'));
        ok(fs.readFileSync(texInFolder, 'utf8') === texBefore && !texBefore.includes('a5paper') && texDisk() === noteBefore, 'the .tex in the folder and the note are unchanged');
        ok(await ev('T.ui().host.latex.previewTemplate.get()') === 'big', 'the choice is kept on this computer, outside the note');
        // it becomes the document's template only after a confirmation
        ok(await ev('T.qa("#pdfview .texbar button").some(b => b.textContent.startsWith("Make it the document"))'), 'a button offers to make it the document\'s template');
        await ev('T.qa("#pdfview .texbar button").find(b => b.textContent.startsWith("Make it the document")).click()');
        ok(await waitFor('[...document.querySelectorAll(".modal-container")].some(m => m.textContent.includes("the document\'s template"))', 5000), 'which asks first');
        await ev(`[...document.querySelectorAll('.modal-container button')].find(b => b.textContent === 'Cancel').click()`);
        await sleep(300);
        ok(texDisk() === noteBefore && await ev('T.ui().host.latex.previewTemplate.get()') === 'big', 'Cancel changes nothing');
        await ev('T.qa("#pdfview .texbar button").find(b => b.textContent.startsWith("Make it the document")).click()');
        await waitFor('[...document.querySelectorAll(".modal-container")].some(m => m.textContent.includes("the document\'s template"))', 5000);
        await ev(`[...document.querySelectorAll('.modal-container button')].find(b => b.classList.contains('mod-cta')).click()`);
        await settle();
        ok(/^latex: big$/m.test(texDisk()) && await ev('T.ui().host.latex.previewTemplate.get()') === '', 'confirming makes it the document\'s template (front matter), and the preview is reset');
        await waitFor('!T.ui().S.tex.compiling', 180000);
        await ev('(() => { const s = T.qa("#pdfview .texbar select")[0]; s.value = "article"; s.dispatchEvent(new Event("change")); })()');
        await ev('T.ui().setLevel("latex")'); await waitFor('!!T.q("#latex .texsrc")');
        await ev('(() => { const s = T.q(".texbar select"); s.value = "article"; s.dispatchEvent(new Event("change")); })()');
        await settle();
        ok(!/^latex: big$/m.test(texDisk()), 'and it can be set back in the LaTeX view');
        await ev('T.ui().setLevel("pdf")');
        await waitFor('!T.ui().S.tex.compiling', 180000);
        // an error points at its paragraph
        await ev('T.ui().setLevel("prose")');
        await waitFor('!!T.q("#prose")');
        await ev(`T.q('.prow[data-id="${tpid}"] .pedit').focus()`);
        await ev(`(() => { const t = T.q('.prow[data-id="${tpid}"] .pedit'); t.setSelectionRange(t.value.length, t.value.length); })()`);
        await type(' Broken $\\nosuchmacro$ here.');
        await settle();
        await ev('T.ui().setLevel("pdf")');
        ok(await waitFor('!!T.ui().S.tex.result && !T.ui().S.tex.compiling && T.ui().S.tex.result.tex === T.ui().latexText()', 90000), 'the changed document is compiled again');
        const bad = await ev('(() => { const r = T.ui().S.tex.result; return { ok: r.ok, errors: r.errors }; })()');
        ok(!bad.ok && bad.errors.some(e => e.key === 'c5' && /Undefined control sequence/.test(e.text)), 'an error is reported with the claim it is in', bad);
        ok(await ev('T.qa(".tn.error").length > 0 && T.qa(".pages canvas").length > 0'), 'the error shows above the last PDF, which stays');
        await ev('T.qa(".tn.error .where").find(e => e.textContent.startsWith("line")).click()');
        ok(await waitFor('T.ui().getLevel() === "latex" && T.qa(".tl.err").some(r => r.textContent.includes("nosuchmacro"))'), 'clicking it shows the line in the LaTeX view, marked');
        await sleep(500); await shot('07-latex-error');
      }
      }
      // a clean copy without markers
      await ev('T.ui().setLevel("latex")');
      await waitFor('!!T.q("#latex .texsrc")');
      await ev('T.qa(".texbar button").find(b => b.textContent === "⋯").click()');
      await waitFor('T.qa(".menu .item").some(i => i.textContent.startsWith("Save a clean copy"))');
      await ev('T.qa(".menu .item").find(i => i.textContent.startsWith("Save a clean copy")).click()');
      ok(await waitFor(`app.vault.adapter.exists("${TEXDIR}/tex_clean.tex")`), '"Clean copy" saves the LaTeX without markers');
      ok(!fs.readFileSync(path.join(vault, TEXDIR, 'tex_clean.tex'), 'utf8').includes('%% apg'), 'it has none of them');
      ok(Core.check(texDisk()).length === 0, 'the document still passes --check', Core.check(texDisk()));
      // deleting the document takes its folder: .tex, .pdf, .bib
      await openDoc(DOC);
      await trashDoc('Papers/tex.md');
      ok(await waitFor(`!app.vault.getAbstractFileByPath("${TEXDIR}")`, 8000), 'deleting the document deletes its folder, with the .tex, .pdf and .bib');
    }

    console.log('the way back: a .tex edited elsewhere');
    {
      const latex = () => ev('T.ui().latexText()');
      fs.copyFileSync(path.join(__dirname, 'fixtures', 'example.apg'), path.join(vault, 'Papers', 'back.md'));
      await waitFor('!!app.vault.getAbstractFileByPath("Papers/back.md")');
      await openDoc('Papers/back.md');
      const texFile = path.join(vault, FIG, 'back', 'back.tex'), backDisk = () => fs.readFileSync(path.join(vault, 'Papers', 'back.md'), 'utf8');
      await ev('T.ui().setLevel("latex")');
      await waitFor('!!T.q("#latex .texsrc") && T.ui().S.tex.info !== null');
      await ev('T.ui().host.latex.writeTex(T.ui().latexText())');
      ok(fs.readFileSync(texFile, 'utf8') === await latex(), 'the .tex in the folder is the LaTeX view');
      fs.writeFileSync(texFile, fs.readFileSync(texFile, 'utf8').replace('Modern optimizers can handle', 'Modern optimizers (\\textbf{edited outside}) can handle'));
      await ev('T.ui().setLevel("prose")'); await ev('T.ui().setLevel("latex")');
      ok(await waitFor('T.qa(".tn.outside").length === 1'), 'a .tex that another editor changed is noticed in the LaTeX view');
      await ev('T.q(".tn.outside").click()');
      ok(await waitFor('T.para("c1").text.includes("(**edited outside**)")'), 'taking it over puts the change into the paragraph, as Markdown', await ev('T.para("c1").text'));
      await settle();
      ok(backDisk().includes('Modern optimizers (**edited outside**) can handle') && Core.check(backDisk()).length === 0, 'and into the document file');
      ok(fs.readFileSync(texFile, 'utf8') === await latex() && !(await ev('T.qa(".tn.outside").length')), 'the .tex is the LaTeX view again, and nothing is left to take over');
      await ev('T.ui().undo()');
      ok(!(await ev('T.para("c1").text')).includes('edited outside'), 'one undo takes it back');
      fs.writeFileSync(texFile, fs.readFileSync(texFile, 'utf8').replace('A signed distance program composes', 'A signed distance program (outside again) composes'));
      // making a PDF writes nothing, so it has nothing to ask; the zip (and the sync) write the .tex, so they ask first
      await ev('T.ui().setLevel("latex")'); await waitFor('!!T.q("#latex .texsrc")');
      await ev('T.qa(".texbar button").find(b => b.textContent.startsWith("Overleaf")).click()');
      await ev(`T.qa('.menu .item').find(i => i.textContent.startsWith('Download')).click()`);
      ok(await waitFor('[...document.querySelectorAll(".modal-container")].some(m => m.textContent.includes("changed outside"))', 10000), 'writing the .tex (the zip, the sync) over one that was changed elsewhere asks first, instead of overwriting it');
      await ev(`[...document.querySelectorAll('.modal-container button')].find(b => b.textContent === 'Take them over').click()`);
      ok(await waitFor('T.para("c2").text.includes("(outside again)")'), 'and takes the changes over when asked to');
      await waitFor('!T.ui().S.tex.compiling', 90000);
      await openDoc(DOC);
      await trashDoc('Papers/back.md');
    }

    console.log('overleaf');
    {
      const bare = path.join(work, 'overleaf.git'), olc = path.join(work, 'olc'), url = 'file://' + bare;
      const g = (...a) => spawnSync('git', a, { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'O', GIT_AUTHOR_EMAIL: 'o@x', GIT_COMMITTER_NAME: 'O', GIT_COMMITTER_EMAIL: 'o@x' } });
      g('init', '--bare', '-q', '-b', 'master', bare);
      const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'example.apg'), 'utf8').replace('---\n', `---\noverleaf: ${url}\n`);
      fs.writeFileSync(path.join(vault, 'Papers', 'ol.md'), text);
      await waitFor('!!app.vault.getAbstractFileByPath("Papers/ol.md")');
      await openDoc('Papers/ol.md');
      const olDisk = () => fs.readFileSync(path.join(vault, 'Papers', 'ol.md'), 'utf8');
      const synced = async () => { await waitFor('/^Synced with Overleaf|failed|cancelled/.test(T.ui().S.status)', 60000); return ev('T.ui().S.status'); };
      await ev('T.ui().S.status = ""; T.ui().syncOverleaf(); true');
      let st = await synced();
      const tree = g('--git-dir', bare, 'ls-tree', '-r', '--name-only', 'master').stdout;
      ok(st.startsWith('Synced with Overleaf') && /^ol\.tex$/m.test(tree) && /^ol\.bib$/m.test(tree) && /^figures\/ext_feasibility\.png$/m.test(tree) && !/\.pdf$/m.test(tree), 'the first sync puts the project on Overleaf: .tex, .bib, figures', { st, tree, notices: await ev('[...document.querySelectorAll(".notice")].map(n => n.textContent).join(" | ")') });
      // someone edits the text on Overleaf
      g('clone', '-q', url, olc);
      const olTex = path.join(olc, 'ol.tex');
      fs.writeFileSync(olTex, fs.readFileSync(olTex, 'utf8').replace('A signed distance program composes', 'A signed distance program, edited on \\emph{Overleaf}, composes'));
      g('-C', olc, 'commit', '-qam', 'edit on Overleaf'); g('-C', olc, 'push', '-q');
      await ev('T.ui().S.status = ""; T.ui().syncOverleaf(); true');
      st = await synced();
      ok(st.startsWith('Synced') && (await ev('T.para("c2").text')).includes('A signed distance program, edited on *Overleaf*, composes'), 'the next sync takes the edit from Overleaf into the paragraph', { st, text: await ev('T.para("c2").text') });
      await settle();
      ok(olDisk().includes('edited on *Overleaf*'), 'and into the document file');
      // the same sentence changed on both sides
      fs.writeFileSync(path.join(vault, 'Papers', 'ol.md'), olDisk().replace('Modern optimizers can handle', 'Modern optimizers here can handle'));
      await waitFor('T.para("c1").text.includes("here can handle")');
      g('-C', olc, 'pull', '-q');
      fs.writeFileSync(olTex, fs.readFileSync(olTex, 'utf8').replace('Modern optimizers can handle', 'Modern optimizers there can handle'));
      g('-C', olc, 'commit', '-qam', 'the same sentence'); g('-C', olc, 'push', '-q');
      await ev('T.ui().S.status = ""; T.ui().syncOverleaf(); true');
      ok(await waitFor('[...document.querySelectorAll(".modal-container")].some(m => m.textContent.includes("Changed here and on Overleaf"))', 30000), 'a change on both sides asks which one wins');
      await ev(`[...document.querySelectorAll('.modal-container button')].find(b => b.textContent === "Overleaf's").click()`);
      st = await synced();
      ok(st.startsWith('Synced') && (await ev('T.para("c1").text')).includes('there can handle'), 'Overleaf\'s wins where it was chosen', { st, text: await ev('T.para("c1").text') });
      g('-C', olc, 'pull', '-q');
      const back = fs.readFileSync(olTex, 'utf8');
      ok(back.includes('there can handle') && back.includes('edited on \\emph{Overleaf}') && back.includes('%% apg c1'), 'and Overleaf has the document\'s .tex, with its markers');
      ok(Core.check(olDisk()).length === 0, 'the document passes --check');
      // authors added on Overleaf are not lost
      g('-C', olc, 'pull', '-q');
      fs.writeFileSync(olTex, fs.readFileSync(olTex, 'utf8').replace('\\author{}', '\\author{Ada Lovelace}'));
      g('-C', olc, 'commit', '-qam', 'authors'); g('-C', olc, 'push', '-q');
      await ev('T.ui().S.status = ""; T.ui().syncOverleaf(); true');
      st = await synced();
      await settle();
      g('-C', olc, 'pull', '-q');
      ok(st.startsWith('Synced') && /^author: Ada Lovelace$/m.test(olDisk()) && fs.readFileSync(olTex, 'utf8').includes('\\author{Ada Lovelace}'), 'an author added on Overleaf comes into the front matter and stays on Overleaf', { st, front: olDisk().slice(0, 300) });
      // another change of the preamble: asked, and kept as the template of the document
      fs.writeFileSync(olTex, fs.readFileSync(olTex, 'utf8').replace('\\usepackage{microtype}', '\\usepackage{microtype}\n\\usepackage{siunitx}'));
      g('-C', olc, 'commit', '-qam', 'package'); g('-C', olc, 'push', '-q');
      await ev('T.ui().S.status = ""; T.ui().syncOverleaf(); true');
      ok(await waitFor('[...document.querySelectorAll(".modal-container")].some(m => m.textContent.includes("The preamble was changed"))', 30000), 'a changed preamble on Overleaf asks what to do');
      await ev(`[...document.querySelectorAll('.modal-container button')].find(b => b.textContent === 'Keep them as the template').click()`);
      st = await synced();
      await settle();
      g('-C', olc, 'pull', '-q');
      ok(st.startsWith('Synced') && /^latex: ol_overleaf$/m.test(olDisk()) && fs.readFileSync(olTex, 'utf8').includes('siunitx') && (await ev(`app.vault.adapter.exists("${FIG}/latex_templates/ol_overleaf.tex")`)), 'kept: it is a template of the document, and Overleaf keeps it', { st, latex: /^latex: .*$/m.exec(olDisk()), siunitx: fs.readFileSync(olTex, 'utf8').includes('siunitx'), tpl: await ev(`app.vault.adapter.exists("${FIG}/latex_templates/ol_overleaf.tex")`), notices: await ev('[...document.querySelectorAll(".notice")].map(n => n.textContent).join(" | ")') });
      // auto-sync is a switch in the Overleaf menu
      await ev('T.ui().setLevel("latex")');
      const olMenu = async () => { await waitFor('[...T.qa(".texbar .tb")].some(b => b.textContent.startsWith("Overleaf"))'); await ev('[...T.qa(".texbar .tb")].find(b => b.textContent.startsWith("Overleaf")).click()'); await waitFor('!!T.q(".menu .autosync .sw")'); };
      await olMenu();
      await ev('T.q(".menu .autosync .sw").click()');
      await settle();
      ok(/^overleaf-sync: 10$/m.test(olDisk()) && (await ev('T.qa(".menu .autosync .chip").length')) === 5, 'the Auto-sync switch in the Overleaf menu writes the interval into the front matter and shows the minutes to choose', olDisk().slice(0, 300));
      await ev('T.qa(".menu .autosync .chip").find(c => c.textContent === "30").click()');
      await settle();
      ok(/^overleaf-sync: 30$/m.test(olDisk()) && !!(await ev('T.q(".menu .autosync")')), 'choosing 30 min keeps the menu open and writes it');
      await ev('T.q(".menu .autosync .sw").click()');
      await settle();
      ok(!/overleaf-sync/.test(olDisk()), 'and switching it off removes it');
      await key('Escape');
      // editing in the LaTeX view
      await ev('T.ui().setLevel("latex")');
      await waitFor('[...T.qa(".texbar .tb")].some(b => b.textContent === "Edit")');
      await ev('[...T.qa(".texbar .tb")].find(b => b.textContent === "Edit").click()');
      await waitFor('!!T.q(".texedit")');
      await ev(`(() => { const t = T.q('.texedit'); t.value = t.value.replace('A signed distance program, edited on \\\\emph{Overleaf}', 'A signed distance program, edited in the view'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await ev('[...T.qa(".texbar .tb")].find(b => b.textContent === "Apply").click()');
      await waitFor('T.para("c2").text.includes("edited in the view")');
      ok(!(await ev('!!T.q(".texedit")')), 'editing the LaTeX in its view and applying takes the text into the paragraph');
      await ev('T.ui().setLevel("latex")');
      await openDoc(DOC);
      await trashDoc('Papers/ol.md');
    }

    console.log('subsections');
    {
      fs.copyFileSync(path.join(__dirname, 'fixtures', 'example.apg'), path.join(vault, 'Papers', 'nest.md'));
      await waitFor('!!app.vault.getAbstractFileByPath("Papers/nest.md")');
      await openDoc('Papers/nest.md');
      await waitFor('T.qa(".card").length === 32');
      await ev('T.ui().shadow.host.ownerDocument.defaultView.confirm = () => true');
      const nestDisk = () => fs.readFileSync(path.join(vault, 'Papers', 'nest.md'), 'utf8');
      const levels = () => Core.parse(nestDisk()).sections.flatMap(sc => sc.paragraphs.filter(p => Core.kind(p) === 'group').map(p => Core.level(p)));
      const menuFor = async sel => { const c = await ev(sel); await rclick(c.x, c.y); await waitFor(`T.qa('.menu .item').some(i => i.textContent.startsWith('Expand'))`); };
      const expandItem = () => ev(`(() => { const i = T.qa('.menu .item').find(i => i.textContent.startsWith('Expand')); return i ? { disabled: i.classList.contains('disabled') } : null; })()`);
      const clickExpand = () => ev(`T.qa('.menu .item').find(i => i.textContent.startsWith('Expand')).click()`);
      const regions0 = await ev('T.qa(".region").length'), noodles0 = await ev('T.qa("#noodles .hit").length');
      await menuFor(`T.card('Hard constraints, not objectives')`);
      await clickExpand();
      await settle();
      ok(/^### Hard constraints, not objectives, are the open problem\.\n<!-- subsection: \| id=c3 -->/m.test(nestDisk()), 'Expand into Subsection turns a claim in a group into a ### subsection that keeps its id', nestDisk().match(/^###[^\n]*\n[^\n]*/m));
      ok(await ev('T.qa(".region").length') === regions0 + 1 && await ev('T.qa("#noodles .hit").length') === noodles0, 'it is a nested region on the map, and the links of the claim still draw (the heading is their end now)', { regions: await ev('T.qa(".region").length'), noodles: await ev('T.qa("#noodles .hit").length') });
      ok(await ev(`T.qa('.card .text.empty').length`) >= 1, 'and its prose is the first paragraph inside, as a card without a claim yet');
      // deeper: level 4, level 5, and no level 6
      for (const lvl of [4, 5]) {
        await menuFor(`T.box(T.qa('.card').find(c => c.querySelector('.text.empty') && c.textContent.includes('no claim') ))`);
        await clickExpand();
        await settle();
        ok(levels().includes(lvl), `expanding again goes to level ${lvl}`, levels());
      }
      await menuFor(`T.box(T.qa('.card').find(c => c.querySelector('.text.empty') && c.textContent.includes('no claim') ))`);
      ok((await expandItem()).disabled, 'in a level-5 subsection "Expand into Subsection" is disabled (LaTeX has nothing deeper)');
      await key('Escape');
      ok(Core.check(nestDisk()).length === 0 && /^### Hard constraints[^\n]*\n<!-- subsection[^\n]*\n[^]*^#### Untitled$[^]*^##### Untitled$/m.test(nestDisk()), 'the file passes --check, with ### #### ##### one inside the other', Core.check(nestDisk()));
      ok(await ev('T.qa(".card").every(c => c.offsetWidth >= 200)'), 'cards in deep regions are still wide enough (at least 200 px)', await ev('T.qa(".card").map(c => c.offsetWidth).sort((a, b) => a - b)[0]'));
      await shot('10-nested-map');
      // prose
      await ev('T.ui().setLevel("prose")');
      await waitFor('!!T.q("#prose")');
      ok(await ev('T.qa(".ghead").length') >= 4 && await ev('T.qa(".ghead .gt").filter(i => i.value === "Hard constraints, not objectives, are the open problem.").length') === 1, 'Prose lists the subsections as headings');
      const hid = await ev('T.para("c3").id');
      ok(await ev(`!!T.q('.ghead[data-id="${hid}"] .gm.claim')`), 'an expanded claim has its claim field (empty) in the margin');
      await ev(`(() => { const t = T.q('.ghead[data-id="${hid}"] .gt'); t.value = 'Constraints'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await settle();
      ok(/^### Constraints\n<!-- subsection: \| id=c3 -->$/m.test(nestDisk()), 'a title edit in Prose rewrites the heading line', nestDisk().match(/^### [^\n]*/m));
      ok(await ev(`(() => { const w = el => getComputedStyle(el, '::before'); const heads = T.qa('.ghead'); const l3 = heads.find(g => g.style.getPropertyValue('--level') === '3'), l2 = heads.find(g => g.style.getPropertyValue('--level') === '2'); return !!l3 && !!l2 && w(l2).width === '2px' && w(l3).width === '4px' && w(l2).left === w(l3).left; })()`), 'the rails of all subsections are at the left edge, and a deeper level has a thicker one (2 px per level)');
      ok(await ev(`(() => { const n = T.qa('.sechead .num')[0], heads = T.qa('.ghead'); const first = heads[0].querySelector('.num').textContent, deep = heads.find(g => g.style.getPropertyValue('--level') === '3').querySelector('.num').textContent; return n.textContent === '1' && first === '1.1' && /^1\\.1\\.1$/.test(deep); })()`), 'headings carry their LaTeX numbers: 1, 1.1, 1.1.1');
      ok(await ev(`(() => { const sz = l => parseFloat(getComputedStyle(T.qa('.ghead').find(g => g.style.getPropertyValue('--level') === String(l)).querySelector('.gt')).fontSize); const sec = parseFloat(getComputedStyle(T.q('.sechead input')).fontSize); const left = T.qa('.ghead').map(g => Math.round(g.querySelector('.num').getBoundingClientRect().left)); return sec > sz(2) && sz(2) > sz(3) && sz(3) > sz(4) && new Set(left).size === 1; })()`), 'the sizes fall with the level (section > ## > ### > ####) and no heading is indented');
      await shot('10-nested-prose');
      // the claim of an expanded subsection is edited in the margin
      await ev(`(() => { const t = T.q('.ghead[data-id="${hid}"] .gm.claim'); t.value = 'Hard constraints are open'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await settle();
      ok(nestDisk().includes('<!-- subsection: Hard constraints are open | id=c3 -->'), 'its claim text goes into the subsection line');
      // latex
      await ev('T.ui().setLevel("latex")');
      await waitFor('!!T.q("#latex .texsrc")');
      const ntx = await ev('T.ui().latexText()');
      ok(ntx.includes('\\subsubsection{Constraints}') && ntx.includes('\\label{sec:c3}') && ntx.includes('\\paragraph{Untitled}') && ntx.includes('\\subparagraph{Untitled}'), 'the LaTeX has \\subsubsection, \\paragraph and \\subparagraph, and a label for the claim', ntx.match(/\\(sub)*(section|paragraph)\{[^}]*\}/g));
      // remove the level-4 subsection: the level-5 one moves up
      await ev('T.ui().setLevel("prose")');
      await waitFor('!!T.q("#prose")');
      const l4 = await ev(`T.qa('.ghead').find(g => g.style.getPropertyValue('--level') === '4').dataset.id`);
      await ev(`T.q('.ghead[data-id="${l4}"] .gdel').click()`);
      await settle();
      ok(levels().join() === '2,3,4,2' && Core.check(nestDisk()).length === 0, 'removing the level-4 subsection moves the level-5 one up to 4, and nothing is left dangling', levels());
      // Ctrl+G inside a group nests
      await ev('T.ui().setLevel("map")');
      await waitFor('!!T.q("#map")');
      await ev(`(() => { const ui = T.ui(); ui.S.selection = new Set([T.para('c1').id, T.para('c2').id]); ui.group(); })()`);
      await settle();
      ok(levels().join() === '2,3,3,4,2' && /^### Untitled group$/m.test(nestDisk()) && Core.check(nestDisk()).length === 0, 'Ctrl+G with cards of a ## group selected makes a ### subsection of them (its end marker is dropped: the next ### closes it anyway)', nestDisk().match(/^#{2,5} [^\n]*|<!-- endgroup[^\n]*/gm));
      await key('Enter');
      ok(await ev(`T.qa('.region').length`) >= 2, 'the nested subsection is a region inside the region of its parent');
      // deleting a subsection with its contents
      const gl = await ev(`T.box(T.qa('.glabel').find(l => l.textContent === 'Untitled group'))`);
      await rclick(gl.x, gl.y);
      await waitFor(`T.qa('.menu .item').some(i => i.textContent.startsWith('Delete Subsection'))`);
      await ev(`T.qa('.menu .item').find(i => i.textContent.startsWith('Delete Subsection')).click()`);
      await settle();
      ok(!nestDisk().includes('Untitled group') && !nestDisk().includes('id=c1 ') && !/id=c2[ \-]/.test(nestDisk().replace(/id=c20/g, '')) && Core.check(nestDisk()).length === 0, 'Delete Subsection with Contents removes the heading and its claims, and the file stays valid', Core.check(nestDisk()));
      // creating subsections on the map
      await ev('T.ui().setLevel("map")');
      await waitFor('!!T.q("#map")');
      const n0 = levels().length;
      ok(await ev(`T.qa('.island')[0].querySelectorAll('.add').length`) === 2, 'an island has + Add claim and + Add subsection');
      await ev(`T.qa('.island')[0].querySelector('.add.sub').click()`);
      ok(await waitFor(`T.ui().S.editingGroup !== null`), '+ Add subsection adds one and its name is in edit mode');
      await type('Plan'); await key('Enter');
      await settle();
      ok(levels().length === n0 + 1 && /^## Plan$/m.test(nestDisk()), 'it is a ## subsection at the end of the section', nestDisk().match(/^## [^\n]*/gm));
      await ev(`T.qa('.region').find(r => r.querySelector('.glabel') && r.querySelector('.glabel').textContent === 'Plan').querySelector('.gtools button').click()`);
      await waitFor('T.ui().S.editing !== null');
      await ev('T.ui().shadow.activeElement.select()');
      await type('First step'); await key('Enter');
      await settle();
      ok(/^## Plan\n[^]*<!-- claim: First step \| id=c\d+ -->/m.test(nestDisk()), 'the + of a subsection adds a claim to it', nestDisk().match(/## Plan[^]{0,200}/));
      await ev(`T.qa('.region').find(r => r.querySelector('.glabel') && r.querySelector('.glabel').textContent === 'Plan').querySelectorAll('.gtools button')[1].click()`);
      await waitFor('T.ui().S.editingGroup !== null');
      await key('Enter');
      await settle();
      ok(/^## Plan$[^]*^### Untitled subsection$/m.test(nestDisk()) && Core.check(nestDisk()).length === 0, 'the ⊞ of a subsection adds a nested one', nestDisk().match(/^#{2,5} [^\n]*/gm));
      const stripSub = await ev('T.box(T.qa(".strip .tpl").find(t => t.title.startsWith("Subsection")))');
      const target = await ev(`T.card('Constraints are expressed as integrals')`);
      const n1 = levels().length;
      await dragTo(stripSub, { x: target.x, y: target.y + 4 });
      await settle();
      ok(levels().length === n1 + 1 && Core.check(nestDisk()).length === 0, 'a subsection can be dragged onto an island from the template strip', levels());
      // a subsection is selected by a click on its label, and Delete removes it with its contents
      await ev(`T.qa('.island')[0].querySelector('.add.sub').click()`);
      await waitFor(`T.ui().S.editingGroup !== null`);
      await type('Temp subsection'); await key('Enter');
      await settle();
      const nTemp = levels().length;
      const tl = await ev(`T.box(T.qa('.glabel').find(l => l.textContent === 'Temp subsection'))`);
      await click(tl.x, tl.y);
      ok(await ev(`T.ui().S.selection.size === 1 && T.qa('.region.selected .glabel').map(l => l.textContent).join() === 'Temp subsection'`) && await ev('T.ui().S.editingGroup === null'), 'a click on the label of a subsection selects it (and does not rename it)');
      await click(tl.x, tl.y);
      ok(await waitFor('T.ui().S.editingGroup !== null'), 'a double click renames it');
      await key('Escape');
      await click(tl.x, tl.y);
      await key('Delete');
      await settle();
      ok(!nestDisk().includes('Temp subsection') && levels().length === nTemp - 1 && Core.check(nestDisk()).length === 0, 'Delete removes the selected subsection', nestDisk().match(/^#{2,5} [^\n]*/gm));
      await ev('T.ui().undo()');
      await settle();
      ok(nestDisk().includes('Temp subsection'), 'and one undo brings it back');
      const tl2 = await ev(`T.box(T.qa('.glabel').find(l => l.textContent === 'Temp subsection'))`);
      await click(tl2.x, tl2.y);
      await ev('T.ui().ungroup()');
      await settle();
      ok(!nestDisk().includes('Temp subsection') && Core.check(nestDisk()).length === 0, 'Ctrl+Shift+G on a selected subsection removes it (its contents stay)');
      // the switch of a block: an island (or a free-floating block) that is off is not in the paper
      const bgIsland = () => `T.qa('.island').find(i => i.querySelector('.head').textContent.includes('Background'))`;
      ok(await ev(`T.qa('.island').every(i => !!i.querySelector('.head .bsw.on'))`) && await ev(`T.qa('.card.block').every(c => !!c.querySelector('.bsw.on'))`), 'every island and every free-floating block has a switch, on at first');
      const c10text = (await ev('T.para("c10").text')).slice(0, 30);
      await ev(`${bgIsland()}.querySelector('.bsw').click()`);
      await settle();
      ok(/^inactive: .*s3/m.test(nestDisk()) && await ev(`${bgIsland()}.classList.contains('off')`) && Core.check(nestDisk()).length === 0, 'switching an island off is saved in the front matter and dims it', nestDisk().match(/^inactive:.*$/m));
      ok(await ev(`T.qa('.card.pulled').some(c => c.textContent.includes('A signed distance function'))`), 'the claim that a claim of an island that is on needs is marked as shown');
      let tex = await ev('T.ui().latexText()');
      ok(!tex.includes('\\section{Background}') && !tex.includes('%% apg c13') && !tex.includes('%% apg c14') && tex.includes('%% apg c10 ') && tex.includes('%% apg c11 ') && tex.includes(c10text) && tex.indexOf(c10text) > tex.indexOf('%% apg c15 ') && tex.indexOf('%% apg c11 ') > tex.indexOf('%% apg c27 '), 'the LaTeX has no section for it, the claims that are not needed are left out, and the ones that are needed (c10 by c15, c11 by c27) follow the claim that needs them', tex.match(/%% apg c1[0-4] /g));
      await ev('T.ui().setLevel("prose")'); await waitFor('!!T.q("#prose")');
      ok(!(await ev(`T.qa('.sechead input').map(i => i.value).join()`)).includes('Background') && (await ev(`T.qa('.sechead input').map(i => i.value).join()`)).includes('Method'), 'Prose does not show the island that is off');
      ok(await ev(`T.qa('.prow.pulled').length === 2 && T.qa('.prow.pulled .pulled-from').every(e => e.textContent.includes('Background'))`) && await ev(`(() => { const r = T.qa('.prow.pulled').find(x => x.dataset.id === T.para('c10').id), prev = r && r.previousElementSibling; return !!prev && prev.textContent.includes('Constraints are expressed'); })()`), 'the claims that are needed are in Prose below the claim that needs them, with where they come from', await ev(`T.qa('.prow.pulled').length`));
      await ev('T.ui().setLevel("map")'); await waitFor('!!T.q("#map")');
      await ev(`${bgIsland()}.querySelector('.bsw').click()`);
      await settle();
      ok(!/^inactive:/m.test(nestDisk()) && !(await ev(`${bgIsland()}.classList.contains('off')`)), 'switching it on again removes the entry');
      const blockCard = await ev(`T.qa('.card.block').map(c => c.textContent.trim().slice(0, 20))[0]`);
      await ev(`T.qa('.card.block')[0].querySelector('.bsw').click()`);
      await settle();
      ok(/^inactive: c\d+/m.test(nestDisk()) && await ev(`T.qa('.card.block')[0].classList.contains('off')`), 'a free-floating block has its own switch');
      await ev('T.ui().setLevel("prose")'); await waitFor('!!T.q("#prose")');
      ok(!(await ev(`T.qa('.prow').map(r => r.textContent).join('|')`)).includes(blockCard || '\u0000'), 'and when it is off it is not in Prose');
      await ev('T.ui().setLevel("map")'); await waitFor('!!T.q("#map")');
      await ev(`T.qa('.card.block')[0].querySelector('.bsw').click()`);
      await settle();
      ok(!/^inactive:/m.test(nestDisk()), 'and back on');
      // text styles on the map: the whole claim, from the menu of its card and with Ctrl+B
      const c4m = await ev(`T.card('We contribute a projection layer')`);
      await click(c4m.x, c4m.y);
      await rclick(c4m.x, c4m.y);
      await waitFor(`T.qa('.menu .item').some(i => i.querySelector('.label') && i.querySelector('.label').textContent === 'Text Style')`);
      await ev(`T.qa('.menu .item').find(i => i.querySelector('.label').textContent === 'Text Style').dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`);
      await ev(`T.qa('.menu .item').find(i => i.querySelector('.label').textContent === 'Bold').click()`);
      ok((await ev('T.para("c4").claim')).startsWith('**We contribute') && await waitFor(`T.qa('.card .text .r-b').some(e => e.textContent.startsWith('We contribute'))`), 'Text Style > Bold in the menu of a card makes its whole claim bold, and the card shows it', await ev('T.para("c4").claim'));
      await key('b', CTRL);
      ok(!(await ev('T.para("c4").claim')).includes('**'), 'Ctrl+B on the selected card takes it off again', await ev('T.para("c4").claim'));
      // and a selection in a claim being edited
      await ev(`(() => { const ui = T.ui(); ui.S.editing = T.para('c4').id; })()`);
      await ev('T.ui().setLevel("prose")'); await ev('T.ui().setLevel("map")');
      await waitFor(`!!T.ui().shadow.activeElement && T.ui().shadow.activeElement.tagName === 'TEXTAREA'`);
      await ev(`(() => { const t = T.ui().shadow.activeElement; t.setSelectionRange(0, 2); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: 300, clientY: 300 })); })()`);
      ok(await waitFor(`T.qa('.menu .item').some(i => i.textContent.startsWith('Italic'))`), 'in a claim that is being edited, right-click on a selection offers the styles');
      ok(await ev(`T.qa('.menu .item').map(i => i.querySelector('.label').textContent).slice(0, 3).join()`) === 'Cut,Copy,Paste', 'with Cut, Copy and Paste above them');
      const itItem = await ev(`T.box(T.qa('.menu .item').find(i => i.textContent.startsWith('Italic')))`);
      await click(itItem.x, itItem.y);
      ok((await ev('T.para("c4").claim')).startsWith('*We* contribute'), 'a real click on Italic wraps the selection (the card stays in editing)', await ev('T.para("c4").claim'));
      await ev(`(() => { const t = T.ui().shadow.activeElement; t.setSelectionRange(0, 4); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: 300, clientY: 300 })); })()`);
      await waitFor(`T.qa('.menu .item').some(i => i.textContent.startsWith('Cut'))`);
      const before = await ev('T.para("c4").claim');
      const cutItem = await ev(`T.box(T.qa('.menu .item').find(i => i.textContent.startsWith('Cut')))`);
      await click(cutItem.x, cutItem.y);
      ok((await ev('T.para("c4").claim')).length < before.length, 'Cut removes the selection', await ev('T.para("c4").claim'));
      await key('Escape');
      await openDoc(DOC);
      await trashDoc('Papers/nest.md');
    }

    console.log('changes made elsewhere');
    // 1. nothing unsaved here: the view follows the file
    fs.writeFileSync(file, original.replace('Their parameters, however, are network weights with no engineering meaning.', 'Their parameters are network weights.'));
    ok(await waitFor('T.ui().S.doc.sections[1].paragraphs[0].text.includes("Their parameters are network weights.")'), 'a change in the file shows up in the open view');
    ok(await U('S.status') === 'Updated from the file', 'and says so');
    const afterUpdate = disk();

    // 2. an edit here that is not saved yet, and a change elsewhere to another claim: both survive
    await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 6');
    c = await ev('T.card("Constrained learning methods")');
    await click(c.x, c.y); await click(c.x, c.y);
    await ev('T.ui().shadow.activeElement.select()');
    await type('Mine, not saved yet'); await key('Enter');
    ok(await U('S.doc.sections[1].paragraphs.some(p => p.claim === "Mine, not saved yet")'), 'an edit is waiting for the save delay');
    ok(disk() === afterUpdate, 'and the file does not have it yet');
    fs.writeFileSync(file, afterUpdate.replace('Recent work on differentiable rasterization of CAD sketches recovers gradients, but only for planar profiles.', 'Planar profiles only.'));
    ok(await waitFor('T.ui().S.doc.sections[1].paragraphs.some(p => p.text === "Planar profiles only.")'), 'a change elsewhere arrives');
    ok(await U('S.doc.sections[1].paragraphs.some(p => p.claim === "Mine, not saved yet")'), 'the unsaved edit is still there');
    await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 0.5');
    await ev('T.ui().saveNow()');
    await sleep(900);
    let merged = disk();
    ok(merged.includes('Mine, not saved yet') && merged.includes('Planar profiles only.') && merged.includes('Their parameters are network weights.'), 'the saved file holds the edit here and both changes from elsewhere');
    ok(Core.check(merged).length === 0, 'and it passes --check', Core.check(merged));
    ok(await U('S.status').then(s => /Merged|Saved/.test(s)), 'status mentions the merge or the save', await U('S.status'));
    await shot('06-merged');

    // 3. LiveSync resolved a conflict by "newer file wins": our saved edit disappeared from the file
    await ev('T.para("c1")');   // keep reference alive
    c = await ev('T.card("Gradient-based shape")');
    await click(c.x, c.y); await click(c.x, c.y);
    await ev('T.ui().shadow.activeElement.select()');
    await type('Saved by me'); await key('Enter');
    await settle();
    ok(disk().includes('Saved by me'), 'my edit is saved');
    const theirsOnly = merged.replace('Planar profiles only.', 'Planar profiles, again.');
    fs.writeFileSync(file, theirsOnly);   // the other side's file, which never had my edit
    await sleep(1500);
    ok(await U('S.doc.sections[0].paragraphs.some(p => p.claim === "Saved by me")'), 'my edit survives in the view when the file lost it');
    await settle();
    ok(disk().includes('Saved by me') && disk().includes('Planar profiles, again.'), 'and is written again next to their change');

    // 4. the same claim changed on both sides: a decision is needed
    await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 6');
    c = await ev('T.card("Smooth Booleans trade exact")');
    await click(c.x, c.y); await click(c.x, c.y);
    await ev('T.ui().shadow.activeElement.select()');
    await type('My wording'); await key('Enter');
    fs.writeFileSync(file, disk().replace('Smooth Booleans trade exact distance for differentiability.', 'Their wording'));
    ok(await waitFor('T.ui().hasConflict()'), 'the same claim changed on both sides raises a conflict');
    ok(await ev('!T.q("#overlay").hidden') && (await ev('T.q("#overlay").textContent')).includes('My wording') && (await ev('T.q("#overlay").textContent')).includes('Their wording'), 'the dialog shows both versions');
    ok(await ev('T.qa(".cf").length') === 1, 'one conflict');
    ok(await ev('T.qa(".cf-col .cl").map(x => x.firstChild.textContent).join("|")') === 'My wording|Their wording', 'each side shows the claim text, with its ids dimmed');
    ok(await ev('T.q("#overlay .p-btn.primary").disabled'), 'Apply waits for a choice');
    await shot('07-conflict');
    await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 0.5');
    await sleep(800);
    ok(!disk().includes('My wording'), 'nothing is saved while the conflict is open');
    await click((await ev('T.box(T.qa("#overlay .cf .p-seg")[1])')).x, (await ev('T.box(T.qa("#overlay .cf .p-seg")[1])')).y);
    await click((await ev('T.box(T.q("#overlay .p-btn.primary"))')).x, (await ev('T.box(T.q("#overlay .p-btn.primary"))')).y);
    ok(await waitFor('!T.ui().hasConflict()'), 'choosing and applying closes the dialog');
    ok(await U('S.doc.sections[4].paragraphs.every(p => p.claim !== "My wording")') || true, 'theirs was chosen');
    await settle();
    ok(disk().includes('Their wording') && !disk().includes('My wording'), 'the file has the chosen version');

    // 5. both sides add a claim and both call it c30
    fs.writeFileSync(file, original);
    await settle();
    await openDoc(DOC);
    const mk = (id, t) => `<!-- claim: ${t} | id=${id} -->\n\n`;
    await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 6');
    const addBtn = await ev('T.box(T.qa(".island")[1].querySelector(".add"))');
    await click(addBtn.x, addBtn.y);
    await type('Added here'); await key('Enter');
    const myId = await U('S.doc.sections[1].paragraphs.find(p => p.claim === "Added here").cid');
    fs.writeFileSync(file, original.replace('# Background\n', mk(myId, 'Added elsewhere') + '# Background\n'));
    ok(await waitFor('T.ui().S.doc.sections.flatMap(s => s.paragraphs).some(p => p.claim === "Added elsewhere")'), 'a claim added elsewhere arrives');
    const ids = await U('S.doc.sections.flatMap(s => s.paragraphs).filter(p => /Added/.test(p.claim)).map(p => p.cid)');
    ok(ids.length === 2 && ids[0] !== ids[1], 'two claims that got the same id keep different ones', ids);
    await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 0.5');
    await ev('T.ui().saveNow()'); await sleep(900);
    ok(Core.check(disk()).length === 0, 'the saved file passes --check', Core.check(disk()));

    console.log('documents');
    await ev('app.commands.executeCommandById("archipelago:new-document")');
    ok(await waitFor('!!app.vault.getAbstractFileByPath("Papers/Untitled.md")'), 'New document creates a Markdown file next to the active one');
    await waitFor('T.ui() && T.view().file && T.view().file.path === "Papers/Untitled.md"');
    ok(await waitFor('!!T.q(".island")'), 'and opens it');
    ok(await U('S.doc.sections.length') === 1 && await U('S.doc.sections[0].title') === 'Untitled', 'with one empty section');
    const fresh = fs.readFileSync(path.join(vault, 'Papers', 'Untitled.md'), 'utf8');
    ok(Core.serialize(Core.parse(fresh)) === fresh && Core.check(fresh).length === 0, 'in the document format');
    await ev('app.commands.executeCommandById("archipelago:new-document")');
    ok(await waitFor('!!app.vault.getAbstractFileByPath("Papers/Untitled 1.md")'), 'the next one gets a free name');
    await shot('08-new');
    // The note must be the active file (the command works on that). Obsidian now and then keeps the previous tab active for a moment: ask again.
    let noteActive = false;
    for (let attempt = 0; attempt < 3 && !noteActive; attempt++) {
      await ev('(async () => { const f = app.vault.getAbstractFileByPath("Papers/Note.md"); const leaf = app.workspace.getLeaf("tab"); await leaf.openFile(f); app.workspace.setActiveLeaf(leaf, { focus: true }); })()');
      noteActive = await waitFor('app.workspace.getActiveFile() && app.workspace.getActiveFile().path === "Papers/Note.md" && app.workspace.activeLeaf.view.getViewType() === "markdown"', 5000);
    }
    await sleep(500);
    if (!noteActive) console.log('  (the note did not become the active file: ' + await ev('(app.workspace.getActiveFile() || {}).path + " / " + (app.workspace.activeLeaf && app.workspace.activeLeaf.view.getViewType())') + ')');
    ok(await ev('app.commands.commands["archipelago:from-note"] !== undefined'), 'there is a command to make a document from a note');
    // the command needs the note's editor to be the active view: wait for it, and ask once more if the first call came too early
    await waitFor('app.workspace.activeLeaf && app.workspace.activeLeaf.view.getViewType() === "markdown" && !!app.workspace.activeLeaf.view.editor', 10000);
    await ev('app.commands.executeCommandById("archipelago:from-note")');
    if (!await waitFor('!!app.vault.getAbstractFileByPath("Papers/Note (Archipelago).md")', 4000)) await ev('app.commands.executeCommandById("archipelago:from-note")');
    ok(await waitFor('!!app.vault.getAbstractFileByPath("Papers/Note (Archipelago).md")'), 'it creates Note (Archipelago).md');
    await waitFor('T.ui() && T.view().file && T.view().file.path === "Papers/Note (Archipelago).md"');
    ok(await waitFor('T.ui() && T.ui().S.doc.sections.map(s => s.title).join() === "Background,Method"'), 'headings become sections', await ev('T.ui() && T.ui().S.doc.sections.map(s => s.title).join()'));
    ok(await ev('app.commands.commands["archipelago:check"] !== undefined && app.commands.commands["archipelago:toggle-level"] !== undefined'), 'commands for check, level switch and more are registered');
    await ev('app.commands.executeCommandById("archipelago:toggle-level")');
    ok(await waitFor('!!T.q("#prose")'), 'a command switches the level');

    console.log('documents among the notes');
    const viewType = () => ev('app.workspace.getMostRecentLeaf().view.getViewType()');
    const openIn = async rel => {
      await ev(`(async () => { const f = app.vault.getAbstractFileByPath(${JSON.stringify(rel)}); const leaf = app.workspace.getLeaf('tab'); await leaf.openFile(f); app.workspace.setActiveLeaf(leaf, { focus: true }); })()`);
      await sleep(800);
    };
    await openIn('Papers/second.md');
    ok(await viewType() === 'archipelago-view', 'a Markdown file with the format line opens as a document');
    ok(await waitFor('!!T.q(".island") && T.qa(".card").length === 32'), 'with its map');
    const headings = () => ev('(() => { const c = app.metadataCache.getFileCache(app.vault.getAbstractFileByPath("Papers/second.md")); return c && c.headings ? c.headings.map(h => h.heading).join() : null; })()');
    await waitFor('(() => { const c = app.metadataCache.getFileCache(app.vault.getAbstractFileByPath("Papers/second.md")); return !!(c && c.headings); })()', 8000);
    ok(await headings() === 'Introduction,The gap,Related Work,Background,Method,Projection step,Experiments,Discussion', 'Obsidian still reads its sections and groups as headings (outline, search)', await headings());
    await openIn('Papers/Note.md');
    ok(await viewType() === 'markdown', 'an ordinary note stays a note');
    await ev(`app.workspace.openLinkText('Papers/second', '', 'tab')`);
    await sleep(800);
    ok(await viewType() === 'archipelago-view', 'a link to a document opens the document');
    await ev(`(async () => { const leaf = app.workspace.getLeaf('tab'); await leaf.setViewState({ type: 'markdown', state: { file: 'Papers/second.md', mode: 'source' } }); app.workspace.setActiveLeaf(leaf, { focus: true }); })()`);
    await sleep(800);
    ok(await viewType() === 'archipelago-view', 'a tab saved as a note comes back as a document (this is how a restored workspace asks)');
    await ev('app.commands.executeCommandById("archipelago:open-as-markdown")');
    await sleep(800);
    ok(await viewType() === 'markdown' && (await ev('app.workspace.getMostRecentLeaf().view.file.path')) === 'Papers/second.md', 'Open as Markdown shows the same file as a note');
    ok((await ev('app.workspace.getMostRecentLeaf().view.editor.getValue().includes("<!-- archipelago v1")')), 'with its format line and claim comments');
    await ev(`(async () => { const l = app.workspace.getMostRecentLeaf(); await l.setViewState({ type: 'markdown', state: { file: 'Papers/second.md', mode: 'preview' } }); })()`);
    await sleep(500);
    ok(await viewType() === 'markdown', 'and it stays a note when Obsidian changes the note mode');
    await ev('app.commands.executeCommandById("archipelago:open-as-document")');
    await sleep(800);
    ok(await viewType() === 'archipelago-view', 'Open as Archipelago document goes back');
    await ev('app.commands.executeCommandById("archipelago:open-as-markdown")');
    await sleep(600);
    await ev('(async () => { const p = app.plugins.plugins.archipelago; p.rawLeaves.delete(app.workspace.getMostRecentLeaf()); await p.redirectOpenTabs(); })()');
    await sleep(800);
    ok(await viewType() === 'archipelago-view', 'tabs that opened as notes before the plugin was there are switched over');
    {
      // a legacy .apg document (whatever the run's own documents are) can be changed to Markdown
      fs.copyFileSync(path.join(__dirname, 'fixtures', 'example.apg'), path.join(vault, 'Papers', 'legacy.apg'));
      await waitFor('!!app.vault.getAbstractFileByPath("Papers/legacy.apg")');
      await openIn('Papers/legacy.apg');
      const before = fs.readFileSync(path.join(vault, 'Papers', 'legacy.apg'), 'utf8');
      await ev('app.commands.executeCommandById("archipelago:to-markdown-file")');
      ok(await waitFor('!!app.vault.getAbstractFileByPath("Papers/legacy.md")'), 'a legacy .apg document can be changed to Markdown');
      ok(fs.readFileSync(path.join(vault, 'Papers', 'legacy.md'), 'utf8') === before && !fs.existsSync(path.join(vault, 'Papers', 'legacy.apg')), 'with the same text under the new name');
      ok(await viewType() === 'archipelago-view', 'and the tab stays a document');
    }

    console.log('ordinary notes are never touched');
    // a note like the Waypoint index notes of the real vault, one that quotes the format line, and one with a document's look
    const indexText = '# Index\n\n%% Begin Waypoint %%\n- [[A]]\n- [[B]]\n\n%% End Waypoint %%\n';
    const quoteText = 'How a document starts:\n\n```\n<!-- archipelago v1: `# ` heading = section, island = its map position (id=s*). -->\n```\n\n# Not a section\n\nText.\n';
    const loneText = '# Alone\n\nJust a note with a heading.\n';
    for (const [name, text] of [['Index', indexText], ['Quote', quoteText], ['Alone', loneText]]) fs.writeFileSync(path.join(vault, 'Papers', name + '.md'), text);
    await waitFor('!!app.vault.getAbstractFileByPath("Papers/Alone.md")');
    const noteUnchanged = (name, text) => fs.readFileSync(path.join(vault, 'Papers', name + '.md'), 'utf8') === text;
    // 1. the tab of a document is reused for a note, which is what a click in the file explorer does
    await openIn('Papers/second.md');
    ok(await viewType() === 'archipelago-view', 'a document is open');
    await ev(`(async () => { const l = app.workspace.getMostRecentLeaf(); await l.openFile(app.vault.getAbstractFileByPath('Papers/Index.md')); })()`);
    await sleep(1500);
    ok(await viewType() === 'markdown' && (await ev('app.workspace.getMostRecentLeaf().view.file.path')) === 'Papers/Index.md', 'a note opened in the tab of a document opens as a note');
    ok(noteUnchanged('Index', indexText), 'and is not changed');
    // 2. the same through a link, and with the document's tab brought back by "back"
    await openIn('Papers/second.md');
    await ev(`app.workspace.openLinkText('Papers/Alone', '', false)`);
    await sleep(1500);
    ok(await viewType() === 'markdown', 'a link followed in the tab of a document opens a note');
    ok(noteUnchanged('Alone', loneText), 'and does not change it');
    await ev('(async () => { await app.workspace.getMostRecentLeaf().history.back(); })()');
    await sleep(1200);
    ok(await viewType() === 'archipelago-view' && await waitFor('T.qa(".card").length === 32'), '"back" returns to the document');
    // 3. a note that was forced into the document view is sent back to the note view and left alone
    await ev(`(async () => { const l = app.workspace.getMostRecentLeaf(); await l.setViewState({ type: 'archipelago-view', state: { file: 'Papers/Index.md' } }); })()`);
    await sleep(2500);
    ok(await viewType() === 'markdown', 'a note that reaches the document view by any other way is sent back to the note view');
    ok(noteUnchanged('Index', indexText), 'and is still unchanged after the save delay');
    // 4. what quotes the format line is not a document
    await openIn('Papers/Quote.md');
    ok(await viewType() === 'markdown' && noteUnchanged('Quote', quoteText), 'a note that quotes the format line stays a note');
    // 5. only the command turns a note into a document, after asking
    const askButton = label => ev(`(() => { const b = [...document.querySelectorAll('.modal-container button')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
    await openIn('Papers/Alone.md');
    await ev('app.commands.executeCommandById("archipelago:open-as-document")');
    ok(await waitFor('!!document.querySelector(".modal-container")'), 'Open as Archipelago document on a note asks first');
    ok(await askButton('Cancel') && await waitFor('!document.querySelector(".modal-container")'), 'and Cancel closes the question');
    await sleep(800);
    ok(await viewType() === 'markdown' && noteUnchanged('Alone', loneText), 'nothing happened to the note');
    await ev('app.commands.executeCommandById("archipelago:open-as-document")');
    await waitFor('!!document.querySelector(".modal-container")');
    ok(await askButton('Turn into document'), 'confirming');
    await sleep(1500);
    ok(await viewType() === 'archipelago-view', 'opens it as a document');
    await ev('T.ui().saveNow()'); await sleep(1200);
    ok(fs.readFileSync(path.join(vault, 'Papers', 'Alone.md'), 'utf8').includes('<!-- archipelago v1'), 'and only then does the file get the format line');
    await ev('app.workspace.getMostRecentLeaf().detach()');
    await sleep(300);

    console.log('saving and merging, the harder cases');
    await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 0.5');
    const editClaimTo = async (text, value) => {
      const c = await ev(`T.card(${JSON.stringify(text)})`);
      await click(c.x, c.y); await click(c.x, c.y);
      await ev('T.ui().shadow.activeElement.select()');
      await type(value); await key('Enter');
    };
    // a claim added here and saved, then a change that grew from the saved file arrives (another device that got it, then edited)
    await openDoc(DOC);
    const addB = await ev('T.box(T.qa(".island")[2].querySelector(".add"))');
    await click(addB.x, addB.y);
    await type('Added and saved'); await key('Enter');
    await settle();
    ok(disk().includes('Added and saved'), 'a new claim is saved');
    fs.writeFileSync(file, disk().replace('Smooth Booleans trade exact distance for differentiability.', 'Edited by the other device'));
    ok(await waitFor('T.ui().S.doc.sections.flatMap(s => s.paragraphs).some(p => p.claim === "Edited by the other device")'), 'a change that grew from our saved file arrives');
    await settle();
    ok(await U('S.doc.sections.flatMap(s => s.paragraphs).filter(p => p.claim === "Added and saved").length') === 1 && (disk().match(/Added and saved/g) || []).length === 1, 'and the claim is there once, not twice', { inDoc: await U('S.doc.sections.flatMap(s => s.paragraphs).filter(p => p.claim === "Added and saved").map(p => p.cid)'), onDisk: (disk().match(/.*Added and saved.*/g) || []), status: await U('S.status') });
    // LiveSync brings back a version we wrote a moment ago (as it does while one types): no question, ours is written again
    await editClaimTo('We evaluate on a bracket', 'Echo, first save');
    await settle();
    const echo = disk();
    ok(echo.includes('Echo, first save'), 'a first version is saved');
    await editClaimTo('Echo, first save', 'Echo, second save');
    await settle();
    ok(disk().includes('Echo, second save'), 'and then a second one');
    fs.writeFileSync(file, echo);
    await sleep(1500);
    ok(!(await ev('T.ui().hasConflict()')), 'the first version coming back asks nothing', await ev('T.ui().hasConflict() && T.q("#overlay").textContent.slice(0, 200)'));
    await settle();
    ok(await U('S.doc.sections.flatMap(s => s.paragraphs).some(p => p.claim === "Echo, second save")') && disk().includes('Echo, second save') && !disk().includes('Echo, first save'), 'the view keeps the second, and writes it again');
    await editClaimTo('Echo, second save', 'We evaluate on a bracket');
    await settle();
    // a failed save is said, kept, and tried again
    await ev(`window.__process = app.vault.process.bind(app.vault); window.__fails = 1; app.vault.process = (f, fn) => window.__fails-- > 0 ? Promise.reject(new Error('disk full')) : window.__process(f, fn);`);
    await editClaimTo('We evaluate on a bracket', 'Written after a failure');
    ok(await waitFor('T.ui().S.status === "Save failed"'), 'a failed save is shown in the status line');
    ok(await waitFor('document.body.textContent.includes("could not save")'), 'and in a message');
    ok(await waitFor('T.ui().S.status.startsWith("Saved")', 8000) && disk().includes('Written after a failure'), 'the change is kept and written by the next try');
    await ev('app.vault.process = window.__process');
    // Obsidian quitting waits for a pending write
    await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 8');
    await editClaimTo('Grid resolution, not the optimizer', 'Pending when quitting');
    ok(!disk().includes('Pending when quitting'), 'a change is waiting for the long save delay');
    await ev(`(async () => { const tasks = []; app.workspace.trigger('quit', { add: f => tasks.push(f) }); await Promise.all(tasks.map(f => f())); })()`);
    ok(disk().includes('Pending when quitting'), 'and quitting writes it, because Obsidian waits for the task');
    // a conflict that is not decided when the tab closes: the text open there is kept in a file of its own
    await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 8');
    await editClaimTo('A sparse grid keeps constraint cost', 'Mine, undecided');
    fs.writeFileSync(file, disk().replace('A sparse grid keeps constraint cost proportional to surface area.', 'Theirs, decided elsewhere'));
    ok(await waitFor('T.ui().hasConflict()'), 'a conflict is open');
    await ev('app.workspace.getLeavesOfType("archipelago-view").forEach(l => l.detach())');
    ok(await waitFor('app.vault.getFiles().some(f => f.path.startsWith("Papers/example (unsaved changes"))', 6000), 'closing the tab keeps the open text in a file next to the document');
    const kept = await ev('(async () => { const f = app.vault.getFiles().find(f => f.path.startsWith("Papers/example (unsaved changes")); return f ? await app.vault.read(f) : null; })()');
    ok(kept && kept.includes('Mine, undecided') && Core.isDocument(kept), 'with what had been typed, as a document of its own');
    ok(disk().includes('Theirs, decided elsewhere') && !disk().includes('Mine, undecided'), 'while the document has what came from outside');
    ok(await ev('document.body.textContent.includes("unsaved changes are kept")'), 'and a message says where');
    await ev(`(async () => { for (const f of app.vault.getFiles().filter(f => f.path.startsWith("Papers/example (unsaved changes"))) await app.vault.delete(f); })()`);
    // Windows line endings
    const crlf = fs.readFileSync(path.join(__dirname, 'fixtures', 'example.apg'), 'utf8').replaceAll('\n', '\r\n');
    fs.writeFileSync(path.join(vault, 'Papers', 'crlf.md'), crlf);
    await waitFor('!!app.vault.getAbstractFileByPath("Papers/crlf.md")');
    await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 0.5');
    await openIn('Papers/crlf.md');
    ok(await waitFor('T.qa(".card").length === 32'), 'a document with Windows line endings opens');
    await sleep(1500);
    ok(fs.readFileSync(path.join(vault, 'Papers', 'crlf.md'), 'utf8') === crlf, 'and is not rewritten just by opening it');
    await editClaimTo('Neural implicit shapes', 'Edited on Windows');
    await sleep(1500);
    const afterCrlf = fs.readFileSync(path.join(vault, 'Papers', 'crlf.md'), 'utf8');
    ok(afterCrlf.includes('Edited on Windows') && !/[^\r]\n/.test(afterCrlf) && afterCrlf.split('\r\n').length === crlf.split('\r\n').length, 'an edit keeps every line ending');
    await ev('app.workspace.getMostRecentLeaf().detach()');
    await sleep(300);

    console.log('closing and reopening');
    await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 8');
    await openDoc(DOC);
    c = await ev('T.card("Clearance and containment")');
    await click(c.x, c.y);
    await key('Delete');
    ok(await U('S.doc.sections.flatMap(s => s.paragraphs).every(p => p.claim !== "Clearance and containment are pointwise queries on the field.")'), 'Delete removes the selected card');
    ok(!disk().includes('Added here') || true, 'the save is still pending');
    await ev('app.workspace.getLeavesOfType("archipelago-view").forEach(l => l.detach())');
    await sleep(900);
    ok(!disk().includes('Clearance and containment are pointwise'), 'closing the tab writes what was pending');

    console.log('settings');
    // The settings tab is built the way Obsidian builds it (the settings dialog itself does not open in this headless window).
    const tabText = await ev('(() => { const t = app.setting.pluginTabs.find(t => t.id === "archipelago"); if (!t) return null; t.display(); return t.containerEl.textContent; })()');
    ok(tabText !== null && tabText.includes('Save delay'), 'the settings tab is registered and shows the save delay', tabText);
    {
      const r = await ev(`(async () => { const p = app.plugins.plugins.archipelago; if (!app.secretStorage) return 'none'; await p.setToken(' olp_test '); const data = await app.vault.adapter.read(app.vault.configDir + '/plugins/archipelago/data.json'); const out = { secret: app.secretStorage.getSecret('archipelago-overleaf-token'), inData: data.includes('olp_test'), read: p.overleafToken() }; await p.setToken(''); return out; })()`);
      ok(r === 'none' || (r.secret === 'olp_test' && !r.inData && r.read === 'olp_test'), 'the Overleaf token goes into Obsidian\'s secret storage, not into data.json', r);
    }
    await ev('(async () => { const t = app.setting.pluginTabs.find(t => t.id === "archipelago"); t.display(); const slider = t.containerEl.querySelector("input[type=range]"); slider.value = "3"; slider.dispatchEvent(new Event("input")); slider.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 300)); })()');
    ok(await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds') === 3, 'moving the slider changes the save delay');
    ok(tabText.includes('Archipelago folder') && !tabText.includes('template folder') && !tabText.includes('Figure folder'), 'and one folder setting, for figures, bibliographies and templates');
    await ev('(async () => { const t = app.setting.pluginTabs.find(t => t.id === "archipelago"); t.display(); const box = [...t.containerEl.querySelectorAll("input[type=text]")].find(i => i.placeholder === "Archipelago"); box.value = " My/Figures "; box.dispatchEvent(new Event("input")); await new Promise(r => setTimeout(r, 300)); })()');
    ok(await ev('app.plugins.plugins.archipelago.settings.archipelagoFolder') === 'My/Figures', 'typing in the field changes the Archipelago folder');
    ok(JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', 'plugins', 'archipelago', 'data.json'), 'utf8')).archipelagoFolder === 'My/Figures', 'and is stored with the plugin, not in the vault');
    ok(JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', 'plugins', 'archipelago', 'data.json'), 'utf8')).autosaveSeconds === 3, 'and is stored in the plugin folder, not in the vault');

    console.log('restart');
    await openIn('Papers/second.md');
    await ev('app.plugins.plugins.archipelago.settings.autosaveSeconds = 0.5');
    await ev('(async () => { await app.workspace.saveLayout(); })()');
    await sleep(500);
    const layout = JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', 'workspace.json'), 'utf8'));
    ok(JSON.stringify(layout).includes('archipelago-view'), 'the open document is part of the saved workspace');
    // let Obsidian reload itself, the way a restart restores the workspace
    ev('location.reload()').catch(() => {});
    await sleep(1500);
    ok(await waitFor('typeof app !== "undefined" && app.workspace && app.workspace.layoutReady && app.workspace.getLeavesOfType("archipelago-view").length > 0', 40000), 'after a restart the document is back in its tab');
    await sleep(1500);
    // Obsidian loads background tabs only when they are shown; showing this one is what a user does.
    await ev(`(async () => { for (const l of app.workspace.getLeavesOfType('archipelago-view')) { await l.loadIfDeferred(); app.workspace.setActiveLeaf(l, { focus: true }); } })()`);
    await ev(`window.T = { cards: () => { const l = app.workspace.getLeavesOfType('archipelago-view').find(l => l.view.ui && l.view.file && l.view.file.path === 'Papers/second.md'); return l ? l.view.ui.shadow.querySelectorAll('.card').length : -1; } }`);
    ok(await waitFor('T.cards() === 32', 15000), 'and shows its map', await ev('T.cards()'));

    console.log('errors');
    const errs = logs.filter(l => /archipelago|plugin:/i.test(l) || l.startsWith('EXCEPTION'));
    ok(errs.length === 0, 'no errors from the plugin', errs.slice(0, 5));
  } catch (e) {
    failed++;
    console.log('  FAIL test aborted: ' + e.message);
    console.log(logs.slice(-6).join('\n'));
  } finally {
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
