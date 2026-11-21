#!/usr/bin/env node
// Tests the way back from an edited .tex into the document (src/fromlatex.js). node test/fromlatex.js
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../src/core.js');
const L = require('../src/latex.js');
const F = require('../src/fromlatex.js');

let passed = 0, failed = 0;
const ok = (c, what, extra) => { if (c) { passed++; console.log('  ok   ' + what); } else { failed++; console.log('  FAIL ' + what + (extra !== undefined ? '  -> ' + JSON.stringify(extra, null, 1).slice(0, 1500) : '')); } };
const fixture = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const opts = { template: L.BUILTIN[0].text, figurePath: p => p };
const exp = d => L.toLatex(d, opts).tex;
const para = (d, cid) => { for (const s of d.sections) for (const p of s.paragraphs) if (p.cid === cid) return p; return null; };
const body = tex => F.split(tex).pieces.filter(p => !p.key.startsWith('cite:')).map(p => p.key + '\n' + F.norm(p.body)).join('\n\n');
const take = (d, theirs, base) => F.importTex(d, { ...opts, theirs, base });

console.log('nothing changed');
for (const f of ['example.apg', 'nested.apg']) {
  const d = C.parse(fixture(f)), before = C.serialize(d), r = take(d, exp(d));
  ok(r.changed === 0 && r.report.length === 0 && C.serialize(d) === before, `${f}: its own export changes nothing`, r.report);
}

console.log('text');
const doc = () => C.parse(fixture('example.apg'));
let d = doc(), t = exp(d);
let theirs = t.replace('Modern optimizers can handle', '\\textbf{Modern} optimizers, see \\ref{fig:c21}, can handle')
  .replace('Learned implicit representations', 'Learned \\emph{implicit} representations\\footnote{As in \\cite{park2019}.}, ``quoted\'\' and 50\\%')
  .replace('Recent work on differentiable', 'Recent work\n% a reviewer note\non differentiable');
let r = take(d, theirs);
ok(para(d, 'c1').text.startsWith('**Modern** optimizers, see `\\ref{fig:c21}`{=latex}, can handle'), 'bold, and a command without Markdown form kept as raw LaTeX', para(d, 'c1').text);
ok(para(d, 'c6').text.startsWith('Learned *implicit* representations^[As in [@park2019].], "quoted" and 50%'), 'emphasis, footnote, citation, quotes, escaped characters', para(d, 'c6').text);
ok(para(d, 'c8').text.includes('Recent work %%a reviewer note%% on differentiable'), 'a comment line becomes %%comment%%', para(d, 'c8').text);
ok(r.changed === 3 && body(exp(d)) === body(theirs), 'and the document exports to the edited .tex again', { report: r.report, diff: [body(exp(d)), body(theirs)].map(x => x.slice(0, 300)) });

console.log('styles, links, colours');
d = C.parse('<!-- archipelago v1 -->\n# A\n<!-- island: id=s1 x=0 y=0 -->\n<!-- claim: x | id=c1 -->\nSee [[Source/@k2025|@k2025]] and [[Note|a note]], ~~old~~ ==new== <span style="color:#e03131">red</span> <mark style="background:#a5d8ff">blue</mark> [site](https://x.org/a%20b) and <https://y.org>.\n');
t = exp(d);
theirs = t.replace('See ', 'So see ');
take(d, theirs);
ok(para(d, 'c1').text === 'So see [[Source/@k2025|@k2025]] and a note, ~~old~~ ==new== <span style="color:#e03131">red</span> <mark style="background:#a5d8ff">blue</mark> [site](https://x.org/a%20b) and <https://y.org>.', 'an edit elsewhere keeps the link to the literature note, styles, colours and links (a link to a plain note becomes its text, which is what the LaTeX has)', para(d, 'c1').text);

console.log('paragraphs');
d = doc(); t = exp(d);
theirs = t.replace('the chain of derivatives.', 'the chain of derivatives.\n\nA new paragraph written in Overleaf.\n\n\\subsubsection{A new heading}\n\nAnd text under it.');
r = take(d, theirs);
const s0 = d.sections[0], k1 = s0.paragraphs.findIndex(p => p.cid === 'c1');
ok(s0.paragraphs[k1 + 1].text === 'A new paragraph written in Overleaf.' && s0.paragraphs[k1 + 1].claim === '' && s0.paragraphs[k1 + 2].text === '### A new heading' && C.kind(s0.paragraphs[k1 + 2]) === 'group' && s0.paragraphs[k1 + 3].text === 'And text under it.', 'blank lines make new paragraphs after it (without a claim), a heading a new subsection', s0.paragraphs.slice(k1, k1 + 4).map(p => p.text.slice(0, 30)));
d = doc(); t = exp(d);
theirs = t.replace(/%% apg c8 [^\n]*\nRecent work[^\n]*\n/, '%% apg c8 | x\n');
r = take(d, theirs);
ok(para(d, 'c8').text === '' && para(d, 'c8').claim.startsWith('Differentiable sketch') && r.report.some(x => x.key === 'c8'), 'a paragraph emptied in the .tex is emptied, its claim stays');
d = doc(); t = exp(d);
theirs = t.replace(/%% apg c9 [^\n]*\n[^\n]*\n/, '');
take(d, theirs);
ok(para(d, 'c9').text === '' && para(d, 'c9').claim !== '', 'one whose marker line is gone too');
d = doc(); t = exp(d);
theirs = t.replace('Projection and penalty methods', 'Projection and penalty methods\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\nwith more text');
take(d, theirs);
ok(para(d, 'c9').text.startsWith('Projection and penalty methods\n```{=latex}\n\\begin{align}') && body(exp(d)) === body(theirs), 'an environment of its own (an align) in a paragraph is kept as a raw LaTeX block, and exported as it is', para(d, 'c9').text);
d = doc(); t = exp(d);
theirs = t.replace('Doubling the sparse grid resolution', 'Results:\n\\begin{itemize}\n  \\item first\n  \\item second with \\textbf{bold}\n  \\begin{enumerate}\n    \\item nested\n  \\end{enumerate}\n\\end{itemize}\nDoubling the sparse grid resolution');
take(d, theirs);
ok(para(d, 'c23').text.startsWith('Results:\n- first\n- second with **bold**\n  1. nested\nDoubling') && body(exp(d)) === body(theirs), 'lists, nested, with text after them', para(d, 'c23').text);

console.log('headings and blocks');
d = C.parse(fixture('nested.apg')); t = exp(d);
theirs = t.replace('\\section{Method}', '\\section{Methods}').replace('\\subsubsection{Projection step}', '\\subsubsection{The \\emph{projection} step}').replace('\\paragraph{Box constraints}', '\\subsubsection{Box constraints}');
r = take(d, theirs);
ok(d.sections[0].title === 'Methods' && C.groupName(para(d, 'c5')) === 'The *projection* step', 'section and subsection titles', [d.sections[0].title, C.groupName(para(d, 'c5'))]);
ok(C.groupName(para(d, 'c9')) === 'Box constraints' && C.level(para(d, 'c9')) === 4 && r.report.some(x => x.key === 'c9' && x.kind === 'skipped'), 'a changed level is not taken over, and said so');
d = doc(); t = exp(d);
theirs = t.replace('smin(a, b; k) = -k log(exp(-a/k) + exp(-b/k))', 'smin(a, b; k) = -k \\log(e^{-a/k} + e^{-b/k})')
  .replace('\\caption{Fraction of feasible runs over iterations for the three methods.}', '\\caption{Feasible runs per iteration.}')
  .replace('projection & 100\\% & 1.0x', 'projection & 99\\% & 1.0x')
  .replace('\\caption{Final feasibility and wall-clock cost per method.}', '\\caption{Feasibility and cost.}');
r = take(d, theirs);
ok(para(d, 'c12').text === '$$ smin(a, b; k) = -k \\log(e^{-a/k} + e^{-b/k}) $$', 'an equation', para(d, 'c12').text);
ok(para(d, 'c21').text === '![Feasible runs per iteration.](figures/feasibility.png)', 'a figure caption (the image stays)', para(d, 'c21').text);
ok(para(d, 'c22').text.includes('| projection | 99% | 1.0x |') && para(d, 'c22').text.includes('|---|---|---|') && para(d, 'c22').claim === 'Feasibility and cost.', 'a table: cells, its alignment row, and its caption (the claim, which is the caption)', [para(d, 'c22').text, para(d, 'c22').claim]);
ok(body(exp(d)) === body(theirs), 'the document exports to the edited .tex again');

console.log('three ways');
d = doc();
const base = exp(d);
para(d, 'c1').text = 'Changed in the document.';
theirs = base.replace('A signed distance program composes', 'A signed distance program, edited in Overleaf, composes').replace('Modern optimizers can handle', 'Modern optimizers, edited in Overleaf too, can handle');
r = take(d, theirs, base);
ok(para(d, 'c2').text.startsWith('A signed distance program, edited in Overleaf'), 'a piece changed only in the .tex is taken over');
ok(para(d, 'c1').text === 'Changed in the document.' && r.report.some(x => x.key === 'c1' && x.kind === 'conflict'), 'one changed on both sides keeps the document\'s, and says so', r.report);
d = doc();
const base2 = exp(d);
para(d, 'c1').text = 'Only the document changed this.';
r = take(d, base2, base2);
ok(para(d, 'c1').text === 'Only the document changed this.' && r.changed === 0, 'one changed only in the document is left as it is');
d = doc(); t = exp(d);
r = take(d, t.replace('\\usepackage{microtype}', '\\usepackage{microtype}\n\\usepackage{siunitx}'));
ok(r.changed === 0 && r.preamble && r.preamble.includes('siunitx'), 'a changed preamble is handed back, not taken over');
const tpl = F.templateFrom(d, t.replace('\\usepackage{microtype}', '\\usepackage{microtype}\n\\usepackage{siunitx}'), opts);
ok(tpl && tpl.includes('siunitx') && tpl.includes('{{body}}') && L.toLatex(d, { ...opts, template: tpl }).tex.includes('\\usepackage{siunitx}'), 'and can be made the template of the document', tpl);
d = doc(); t = exp(d); const b3 = t;
r = take(d, t.replace('\\author{}', '\\author{Ada Lovelace \\and Alan Turing}').replace('\\date{\\today}', '\\date{May 2026}'), b3);
ok(r.preamble === null && L.front(d, 'author') === 'Ada Lovelace `\\and`{=latex} Alan Turing' && L.front(d, 'date') === 'May 2026', 'author and date come back into the front matter', [L.front(d, 'author'), L.front(d, 'date'), r.preamble]);
ok(exp(d).includes('\\author{Ada Lovelace \\and Alan Turing}') && exp(d).includes('\\date{May 2026}'), 'and the next export keeps them');
r = take(d, exp(d).replace('\\date{May 2026}', '\\date{\\today}'), exp(d));
ok(L.front(d, 'date') === '' && r.changed === 1, 'a date back to \\today clears the front matter');
ok(take(doc(), 'no markers').report[0].kind === 'skipped', 'a .tex without markers is refused');
ok(F.split('x\n%% apg body\n%% apg c1\nSome text') === null && take(doc(), exp(doc()).split('%% apg end')[0].replace(/\\end\{document\}/, '')).changed === 0, 'a cut-off .tex (no end) is refused, nothing is emptied');
d = doc(); const base4 = exp(d);
d.sections[0].paragraphs.push(C.newParagraph({ text: 'Written in the document after the export.' }));
r = take(d, base4.replace('Modern optimizers can handle', 'Modern optimizers surely can handle'), base4);
ok(d.sections[0].paragraphs.at(-1).text === 'Written in the document after the export.' && para(d, 'c1').text.includes('surely'), 'a paragraph new in the document is not emptied by an outside edit', r.report);

console.log('paragraphs without a claim');
d = C.parse('<!-- archipelago v1 -->\n# A\n<!-- island: id=s1 x=0 y=0 -->\nAlpha text.\n\nBeta text.\n\nGamma text.\n');
const base5 = exp(d);
d.sections[0].paragraphs.splice(0, 0, C.newParagraph({ text: 'Inserted first in the document.' }));
r = take(d, base5.replace('Gamma text.', 'Gamma text, edited in the .tex.'), base5);
ok(d.sections[0].paragraphs.map(p => p.text).join('|') === 'Inserted first in the document.|Alpha text.|Beta text.|Gamma text, edited in the .tex.', 'a paragraph inserted in the document does not shift an edit of the .tex onto another paragraph', d.sections[0].paragraphs.map(p => p.text));
d = C.parse('<!-- archipelago v1 -->\n# A\n<!-- island: id=s1 x=0 y=0 -->\nAlpha text.\n\nBeta text.\n\nGamma text.\n');
const base6 = exp(d);
d.sections[0].paragraphs.splice(0, 1);
r = take(d, base6.replace('Gamma text.', 'Gamma text, edited in the .tex.'), base6);
ok(d.sections[0].paragraphs.map(p => p.text).join('|') === 'Beta text.|Gamma text, edited in the .tex.', 'and neither does one removed in the document', d.sections[0].paragraphs.map(p => p.text));

console.log('papers of claims');
d = C.parse('<!-- archipelago v1 -->\n# A\n<!-- island: id=s1 x=0 y=0 -->\n<!-- claim: x | id=c1 -->\nFirst paragraph.\n\n<!-- claim: y | id=c2 -->\nSecond paragraph.\n\n<!-- claim: [[S/@p2020|@p2020]] | id=c3 -->\n');
t = exp(d);
ok(t.includes('%% apg cite:c3'), 'the \\cite of a paper claim has a marker of its own');
theirs = t.replace(/\n%% apg cite:c3[^\n]*\n\\cite\{p2020\}/, '').replace('First paragraph.', 'First paragraph \\cite{p2020}.');
r = take(d, theirs);
ok(para(d, 'c1').text === 'First paragraph [@p2020].' && !exp(d).includes('%% apg cite:c3'), 'moving it in the .tex into a paragraph puts the citation into that paragraph, and the automatic one goes', [para(d, 'c1').text, r.report]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
