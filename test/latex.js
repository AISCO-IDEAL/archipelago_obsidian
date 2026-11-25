#!/usr/bin/env node
// Tests the LaTeX export (src/latex.js) on its own, and compiles the sample with pdflatex when it is installed.
//   node test/latex.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../src/core.js');
const L = require('../src/latex.js');
const R = require('../src/richtext.js');

let passed = 0, failed = 0;
const ok = (c, what, extra) => { if (c) { passed++; console.log('  ok   ' + what); } else { failed++; console.log('  FAIL ' + what + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const inl = s => L.inline(s, { cites: new Set(), warnings: [], features: new Set() });

console.log('inline');
ok(inl('100% & #1 a_b {x} ~ ^ \\') === '100\\% \\& \\#1 a\\_b \\{x\\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{}', 'special characters are escaped');
ok(inl('**bold** *it* _it_ snake_case_name') === '\\textbf{bold} \\emph{it} \\emph{it} snake\\_case\\_name', 'strong and emphasis; an underscore inside a word is a character');
ok(inl('$x_1^2$ costs $5 and $10') === '$x_1^2$ costs \\$5 and \\$10', 'inline math stays as it is, money is money');
ok(inl('`a_b`') === '\\texttt{a\\_b}', 'code');
ok(inl('[text](https://x.org/a%20b#c)') === '\\href{https://x.org/a\\%20b\\#c}{text}', 'links');
ok(inl('<https://x.org>') === '\\url{https://x.org}', 'autolinks');
ok(inl('a^[note *here*]') === 'a\\footnote{note \\emph{here}}', 'footnotes');
ok(inl('[[Note|shown]] [[Other#h]]') === 'shown Other', 'wiki links keep their text');
ok(inl('x <!-- hidden --> y') === 'x  y', 'HTML comments are dropped');
ok(inl('"quoted"') === "``quoted''", 'typographic quotes');
ok(inl('\\*not emphasis\\*') === '*not emphasis*', 'a backslash makes punctuation plain');
const ctx = { cites: new Set(), warnings: [], features: new Set() };
ok(L.inline('[@a] [@a; @b] [@c, p. 3] [see @d, ch. 2] [-@e]', ctx) === '\\cite{a} \\cite{a,b} \\cite[p. 3]{c} \\cite[see][ch. 2]{d} \\cite{e}', 'citations', L.inline('[@a] [@a; @b] [@c, p. 3] [see @d, ch. 2] [-@e]', ctx));
ok([...ctx.cites].join(',') === 'a,b,c,d,e', 'and what is cited is collected');
ok(inl('mail me at a@b.ch [not a cite]') === 'mail me at a@b.ch [not a cite]', 'an @ that is no citation is text');

ok(inl('[[99_attachments_c_docs/Source/die_gurken/@berzins2025|@berzins2025]] [[Source/@k2|x]] [[@z]] [[Note|shown]] [[Source/Plain]]') === '\\cite{berzins2025} \\cite{k2} \\cite{z} shown Source/Plain'.replace('Source/Plain', 'Source/Plain'), 'a link to a literature note (@key in its alias or name) is a citation, other links are their text', inl('[[Source/Plain]]'));
const be = L.bibEntries('@comment{x}\n@article{a1,\n title={A {B}},\n year=2020\n}\n@book(b2, title="x")\n@Article{a1, title={dup}}');
ok([...be.keys()].join() === 'a1,b2' && be.get('a1').endsWith('year=2020\n}') && be.get('a1').includes('{A {B}}'), 'entries of a .bib file: nested braces, both bracket kinds, comments skipped, the first of a repeated key');

const note = L.bibFromNote({ citationKey: 'berzins2025', title: 'Geometry-Informed Neural Networks', itemType: 'preprint', creators: ['Arturs Berzins', 'Andreas Radler'], publication: 'arXiv', date: '2025-07-18', year: 2025, url: 'http://arxiv.org/abs/2402.14009', doi: '10.48550/arXiv.2402.14009' });
ok(note.startsWith('@misc{berzins2025,') && note.includes('author = {Arturs Berzins and Andreas Radler}') && note.includes('title = {{Geometry-Informed Neural Networks}}') && note.includes('year = {2025}') && note.includes('howpublished = {arXiv}') && note.includes('doi = {10.48550/arXiv.2402.14009}'), 'a BibTeX entry from the front matter of a ZotFlow note', note);
ok(L.bibEntries(note).has('berzins2025') && L.bibFromNote({ title: 'x' }) === null && L.bibFromNote({ citationKey: 'k', title: 'A & B_c', itemType: 'journalArticle', publication: 'J', date: '1999', creators: [{ firstName: 'A', lastName: 'B' }] }).includes('journal = {J}'), 'it parses back, needs a key, handles other item types and escapes');

const fx = { cites: new Set(), warnings: [], features: new Set() };
ok(L.inline('~~old~~ ==hl== <span style="color:red">r</span> <mark style="background:#a5d8ff">m</mark>', fx) === '\\sout{old} \\hl{hl} \\textcolor[HTML]{E03131}{r} {\\definecolor{apghl}{HTML}{A5D8FF}\\sethlcolor{apghl}\\hl{m}}' && [...fx.features].sort().join() === 'soul,sout,xcolor', 'strike-through, highlight, colour: the LaTeX, and the packages they need');
ok(inl('a %%one\ntwo%% b') === 'a \n% one\n% two\n b', 'a %%comment%% is a LaTeX comment on lines of its own');
ok(inl('**a *b* c**') === '\\textbf{a \\emph{b} c}' && inl('<span style="color:#abc">x</span>') === '\\textcolor[HTML]{AABBCC}{x}', 'styles nest, #rgb is expanded');

console.log('richtext');
const sp = 'a **bold *and* x** ~~s~~ ==h== %%c **no** %% <span style="color:red">r</span> `**c**` $a*b*c$ * x* done';
ok(R.spans(sp).map(p => p.t).join('') === sp, 'a text read into pieces is the same text, markers included');
ok(R.spans(sp).filter(p => !p.mk && p.b && p.i).map(p => p.t).join() === 'and' && R.spans(sp).some(p => p.code && p.t === '`**c**`') && R.spans(sp).some(p => p.c && !p.b), 'nesting, code, and no styles inside a comment');
ok(R.plain('**a** %%c%% ==b==') === 'a c b', 'without markers');
{
  const t = 'see https://a.org/x?y=1. Then (http://b.org) and [t](https://c.org)', u = R.spans(t).filter(p => p.link);
  ok(u.map(p => p.link).join() === 'https://a.org/x?y=1,http://b.org,https://c.org' && u.every(p => p.url) && R.spans(t).map(p => p.t).join('') === t, 'a bare web address is a link, without the punctuation that ends the sentence');
}
const lk = R.spans('see [[Source/x/@key2025|@key2025]] and [[Note|shown]] and [t](https://x.org) and [[a]]b');
ok(lk.map(p => p.t).join('') === 'see [[Source/x/@key2025|@key2025]] and [[Note|shown]] and [t](https://x.org) and [[a]]b' && lk.filter(p => p.link).map(p => p.label + (p.cite ? '!' + p.cite : '')).join() === '@key2025!key2025,shown,t,a', 'links are read as pieces: a literature note is a citation, an alias or the note name is the label');
let t1 = R.toggle('hello big world', 6, 9, 'b');
ok(t1.text === 'hello **big** world' && t1.s === 8 && t1.e === 11, 'bold wraps the selection');
ok(R.toggle(t1.text, t1.s, t1.e, 'b').text === 'hello big world' && R.toggle(t1.text, 6, 13, 'b').text === 'hello big world', 'and takes it off again (selection with or without the markers)');
ok(R.toggle('hello big world', 6, 9, 'hl', 'blue').text === 'hello <mark style="background:#a5d8ff">big</mark> world' && R.toggle('hello big world', 6, 9, 'hl').text === 'hello ==big== world', 'highlight: yellow is ==, others are <mark>');
const col = R.toggle('hello big world', 6, 9, 'color', 'red');
ok(R.toggle(col.text, col.s, col.e, 'color', 'blue').text.includes('#1971c2">big') && R.toggle(col.text, col.s, col.e, 'clear').text === 'hello big world', 'another colour replaces the colour, clear removes it');
ok(R.toggle('  big ', 0, 6, 'i').text === '  *big* ', 'blanks at the ends of a selection stay outside');

console.log('blocks');
const doc = t => C.parse('<!-- archipelago v1 -->\n# S\n<!-- island: id=s1 x=0 y=0 -->\n' + t);
const body = (t, o = {}) => L.toLatex(doc(t), { template: '{{body}}', ...o });
let r = body('<!-- claim: A | id=c1 -->\nOne\nline.\n\n- a\n  - b\n- c\n');
ok(r.tex.includes('%% apg c1 | A\nOne line.\n') || r.tex.includes('%% apg c1 | A\nOne line.'), 'lines of a paragraph are running text', r.tex);
ok(r.tex.includes('\\begin{itemize}\n  \\item a\n  \\begin{itemize}\n    \\item b\n  \\end{itemize}\n  \\item c\n\\end{itemize}'), 'nested lists', r.tex);
r = body('<!-- claim: Costs | id=c2 -->\n| a | b |\n|:--|--:|\n| 1% | x |\n');
ok(r.tex.includes('\\begin{tabular}{lr}') && r.tex.includes('1\\% & x \\\\') && r.tex.includes('\\caption{Costs}'), 'tables: alignment, escaping, the claim as caption', r.tex);
r = body('<!-- claim: C | id=c3 -->\n$$ a \\\\ b $$\n');
ok(r.tex.includes('\\begin{equation}\n\\begin{aligned}\na \\\\ b\n\\end{aligned}\n\\label{eq:c3}'), 'an equation of several lines is aligned', r.tex);
r = body('<!-- claim: F | id=c4 -->\n![A *fig*](figs/x.svg)\n', { figurePath: p => p });
ok(r.tex.includes('\\fbox') && r.warnings.some(w => w.key === 'c4' && w.text.includes('.svg')), 'an SVG cannot go into pdflatex: a box, and a warning');
r = body('<!-- claim: F | id=c5 -->\n![cap](gone.png)\n', { figurePath: () => null });
ok(r.warnings.some(w => w.key === 'c5' && w.text.includes('Missing image')), 'a missing image is reported');

const png = (w, ppm) => {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(10, 4);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (ppm) { const phys = Buffer.alloc(9); phys.writeUInt32BE(ppm, 0); phys.writeUInt32BE(ppm, 4); phys[8] = 1; parts.push(chunk('pHYs', phys)); }
  return Buffer.concat([...parts, chunk('IEND', Buffer.alloc(0))]);
};
ok(Math.abs(L.imageWidthIn(png(2025, 11811), 'png') - 6.75) < 0.01, 'a PNG with a resolution has a physical width', L.imageWidthIn(png(2025, 11811), 'png'));
ok(L.imageWidthIn(png(2025, 0), 'png') === null, 'a PNG without a resolution has no physical width');
ok(Math.abs(L.imageWidthIn(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page /MediaBox [ 0 0 234 187.2 ] >>', 'latin1'), 'pdf') - 3.25) < 1e-9, 'a PDF is as wide as its page');
ok(L.imageWidthIn(Buffer.from('xx'), 'jpg') === null, 'other formats have no known width');
const fig = w => body('<!-- claim: F | id=c8 -->\n![cap](f.pdf)\n', { figurePath: p => p, figureWidthIn: () => w }).tex;
ok(fig(6.75).includes('\\begin{figure*}[htbp]') && fig(6.75).includes('\\includegraphics{f.pdf}') && fig(6.75).includes('\\end{figure*}'), 'a page-wide image spans both columns at its own size', fig(6.75));
ok(fig(3.25).includes('\\begin{figure}[htbp]') && fig(3.25).includes('\\includegraphics{f.pdf}'), 'a column-wide image keeps its own size', fig(3.25));
ok(fig(null).includes('\\begin{figure}[htbp]') && fig(null).includes('width=0.85\\linewidth'), 'an image of unknown size is fitted into the column', fig(null));
ok(fig(20).includes('\\begin{figure}[htbp]') && fig(20).includes('width=0.85\\linewidth'), 'an image wider than the page (a screenshot) is fitted into the column', fig(20));
r = body('<!-- claim: Only a claim | id=c6 -->\n\n<!-- claim: B | id=c7 -->\nText [@k].\n', { bibFiles: ['refs'], bibKeys: new Set() });
ok(!r.tex.includes('c6'), 'a claim without prose is not in the paper');
ok(r.warnings.some(w => w.text.startsWith('Unknown citation key k ') && w.key === 'c7'), 'an unknown key is reported');
r = body('<!-- claim: B | id=c7 -->\nText [@k].\n');
ok(r.warnings.some(w => w.text.includes('no .bib file')), 'citing without a .bib is reported');

console.log('subsections');
const nested = C.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nested.apg'), 'utf8'));
const nr = L.toLatex(nested, { template: '{{body}}' });
ok(['\\section{Method}', '\\subsection{Formulation}', '\\subsubsection{Projection step}', '\\label{sec:c5}', '\\paragraph{Box constraints}', '\\label{sec:c9}'].every(x => nr.tex.includes(x)), 'levels 2 to 5 are \\subsection to \\subparagraph, an expanded claim has a \\label', nr.tex.match(/\\(sub)*(section|paragraph)\{[^}]*\}/g));
ok(nr.tex.indexOf('Projection step') < nr.tex.indexOf('Text of c6') && nr.tex.indexOf('Text of c10') < nr.tex.indexOf('Text of c7') && nr.warnings.length === 0, 'in the order of the file, without warnings');
const skip = L.toLatex(C.parse('<!-- archipelago v1 -->\n# A\n#### Deep\n<!-- subsection: | id=c1 -->\n'), { template: '{{body}}' });
ok(skip.tex.includes('\\paragraph{Deep}') && skip.warnings.some(w => w.text.includes('a level is skipped')), 'a skipped level is exported as written, with a warning');
ok(L.toLatex(C.parse('<!-- archipelago v1 -->\n# A\n```\n###### six\n```\n'), { template: '{{body}}' }).tex.includes('verbatim'), 'headings inside a code fence stay text');

console.log('papers linked in claims');
const cdoc = C.parse('<!-- archipelago v1 -->\n# A\n<!-- island: id=s1 x=0 y=0 -->\n<!-- claim: Nice [[x/@a2020|@a2020]] and [@b2021; @c2022] words | id=c1 -->\nText one.\n\n<!-- claim: [[x/@d2023|@d2023]] | id=c2 -->\n\n## Sub\n<!-- claim: [[x/@e2024|@e2024]] | id=c3 -->\nSub text [@e2024].\n\n# B\n<!-- island: id=s2 x=0 y=0 -->\n<!-- claim: [[x/@f2025|@f2025]] | id=c4 -->\nOnly this.\n');
const cr = L.toLatex(cdoc, { template: '{{body}}', bibFiles: ['d'], bibKeys: new Set(['a2020', 'b2021', 'c2022', 'd2023', 'f2025']) });
ok(cr.tex.includes('\\cite{a2020,b2021,c2022,d2023}') && cr.tex.indexOf('\\cite{a2020,b2021,c2022,d2023}') > cr.tex.indexOf('Sub text'), 'papers in claims, with other words or several in one, are cited together at the end of the section (after its subsections)');
ok(cr.tex.split('\\cite{e2024}').length === 2 && cr.tex.includes('Sub text \\cite{e2024}'), 'a key that the text of the subsection cites already is not added again');
ok(/Only this\.\n%% apg cite:c4 [^\n]*\n\\cite\{f2025\}/.test(cr.tex), 'when a paragraph ends the section the \\cite follows it in the same paragraph');
ok([...cr.cites].sort().join() === 'a2020,b2021,c2022,d2023,e2024,f2025' && cr.warnings.some(w => w.text.startsWith('Unknown citation key e2024')) && !L.toLatex(cdoc, { template: '{{body}}' }).tex.includes('\\cite{} '), 'they count as cited: they are collected for the .bib and unknown keys are reported');
ok(!L.toLatex(C.parse('<!-- archipelago v1 -->\n# A\n<!-- claim: [[x/@a2020|@a2020]] | id=c1 -->\n![cap](x.png)\n'), { template: '{{body}}', figurePath: p => p }).tex.includes('\\cite{a2020}'), 'the claim of a figure is its caption, not a place for a citation');

const rdoc = C.parse(`<!-- archipelago v1 -->
# Method
<!-- island: id=s1 x=0 y=0 -->
## Sub A
<!-- claim: The first claim | id=c1 needs=c10 -->
Text of c1.

### Deep
<!-- subsection: | id=c2 needs=c11 -->
<!-- claim: inside | id=c3 needs=c12 -->
Text of c3.

<!-- endgroup ### -->
<!-- endgroup -->

# Literature
<!-- island: id=s2 x=0 y=0 -->
<!-- claim: [[x/@paperA|@paperA]] | id=c10 -->

<!-- claim: a look at [@paperB] and [@paperC] | id=c11 -->

<!-- claim: [[x/@paperD|@paperD]] | id=c12 -->

<!-- claim: [[x/@paperE|@paperE]] | id=c13 -->

<!-- notes: loose notes on the map, not part of the paper -->
- [[x/@paperF|@paperF]] <!-- id=u1 to=c3 pos=0,0 -->
- [[x/@paperG|@paperG]] <!-- id=u2 to=s1 pos=0,0 -->
- [[x/@paperH|@paperH]] <!-- id=u3 pos=0,0 -->
`);
const rt = L.toLatex(rdoc, { template: '{{body}}' }).tex;
const at = k => rt.indexOf(k);
ok(/\\cite\{paperA\}/.test(rt) && at('\\cite{paperA}') > at('Text of c3.') && at('\\cite{paperA}') < at('\\section{Literature}'), 'a paper claim that a claim depends on is cited at the end of that claim\'s subsection (after the subsections nested in it)', rt.match(/\\cite\{[^}]*\}/g));
ok(/Text of c3\.[^]*\\cite\{paperB,paperC,paperD,paperF\}[^]*\\section\{Literature\}/.test(rt), 'what a subsection depends on (with other words and several papers in the claim), what a claim inside depends on, and a note that points at that claim are cited together at the end of that subsection', rt.match(/\\cite\{[^}]*\}/g));
ok(/Method\}[^]*\\cite\{paperG\}/.test(rt) && !/\\cite\{paperH\}/.test(rt), 'a note that points at a section is cited at its end, a note without a link is not cited');
const lit = rt.slice(rt.indexOf('\\section{Literature}'));
ok(/\\cite\{paperE\}/.test(lit) && !/paperA|paperB|paperD/.test(lit), 'a paper claim that is linked elsewhere is not cited again where it lies, one that is not linked is, in its own section');

console.log('templates');
ok(L.fill('a{{#x}}[{{x}}]{{/x}}{{^y}}none{{/y}}{{z}}', { x: '1', y: '' }) === 'a[1]none{{z}}', 'sections, inverted sections, unknown names left alone');
const d = C.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'example.apg'), 'utf8'));
L.setFront(d, 'latex', 'plex');
const text = C.serialize(d);
ok(/^latex: plex$/m.test(text) && L.front(C.parse(text), 'latex') === 'plex' && C.check(text).length === 0, 'the template is kept in the front matter');
const nofront = C.parse('<!-- archipelago v1 -->\n# A\n');
nofront.title = 'T';
L.setFront(nofront, 'latex', 'x');
ok(C.serialize(nofront).startsWith('---\nlatex: x\ntitle: T\n---\n') || C.serialize(nofront).startsWith('---\ntitle: T\nlatex: x\n---\n'), 'a document without front matter gets one', C.serialize(nofront));
r = L.toLatex(d, { markers: false });
ok(!r.tex.includes('%% apg'), 'without markers there are none');
r = L.toLatex(d);
ok(L.keyAtLine(r.tex, r.tex.split('\n').findIndex(l => l.startsWith('Modern optimizers')) + 1) === 'c1', 'a line is traced to its claim');
ok(L.logErrors('./paper.tex:12: Undefined control sequence.\nl.12 Broken $\\nosuch\nx.cls:3: oops\n', 'paper.tex').map(e => e.line).join() === '12,0', 'errors of the log, by line in our file');

console.log('compile');
const hasTeX = spawnSync('pdflatex', ['-version']).status === 0;
if (!hasTeX) console.log('  (pdflatex is not installed: skipped)');
else for (const t of L.BUILTIN) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apg-latex-'));
  fs.cpSync(path.join(__dirname, 'fixtures', 'figures'), path.join(dir, 'figures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'paper.tex'), L.toLatex(d, { template: t.text, figurePath: p => p }).tex);
  const run = spawnSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', 'paper.tex'], { cwd: dir, encoding: 'utf8' });
  ok(run.status === 0 && fs.existsSync(path.join(dir, 'paper.pdf')), `the sample compiles with the "${t.name}" template`, (run.stdout || '').split('\n').filter(l => l.startsWith('!')).slice(0, 3));
  fs.rmSync(dir, { recursive: true, force: true });
}

if (hasTeX) for (const t of L.BUILTIN) {
  const sd = C.parse('<!-- archipelago v1 -->\n# S\n<!-- island: id=s1 x=0 y=0 -->\n<!-- claim: c | id=c1 -->\nPlain **bold** *it* ~~gone~~ ==marked== <span style="color:#e03131">red</span> <mark style="background:#a5d8ff">blue</mark> %%a comment%% 100%.\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apg-latex-'));
  fs.writeFileSync(path.join(dir, 'paper.tex'), L.toLatex(sd, { template: t.text }).tex);
  const run = spawnSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', 'paper.tex'], { cwd: dir, encoding: 'utf8' });
  ok(run.status === 0, `a paragraph with every style compiles with the "${t.name}" template`, (run.stdout || '').split('\n').filter(l => l.startsWith('!')).slice(0, 3));
  fs.rmSync(dir, { recursive: true, force: true });
}

ok(L.toLatex(C.parse('<!-- archipelago v1 -->\n# A\n<!-- island: id=s1 x=0 y=0 -->\nSee [[Source/@smith2020|@smith2020x]].\n'), {}).tex.includes('\\cite{smith2020}'), 'a link to a literature note cites the note\'s key, not a mistyped alias');
{
  const d = C.parse('<!-- archipelago v1 -->\n# A\n<!-- island: id=s1 x=0 y=0 -->\n<!-- claim: Lifting Line [[@Fundamentals] | id=c1 -->\nSee [[Source/@known2020|@known2020]] and [@gone2021].\n');
  const r = L.toLatex(d, { bibFiles: ['a'], bibKeys: new Set(['known2020']) });
  const unk = r.warnings.filter(w => w.text.startsWith('Unknown citation key'));
  ok(unk.length === 2 && unk.some(w => w.text.includes('Fundamentals (in "Lifting Line [[@Fundamentals]")') && w.key === 'c1') && unk.some(w => w.text.includes('gone2021') && w.key === 'c1'), 'an unknown citation key says which claim cites it and points at it', unk);
  ok(r.warnings.some(w => w.text.startsWith('Unfinished link [[@Fundamentals]') && w.key === 'c1'), 'a link that ends with one ] is reported as unfinished', r.warnings);
  ok(!L.toLatex(C.parse('<!-- archipelago v1 -->\n# A\n<!-- island: id=s1 x=0 y=0 -->\n<!-- claim: x | id=c1 -->\nA [[Note|alias]] and [[@k]] and [a] [b].\n'), { bibFiles: ['a'], bibKeys: new Set(['k']) }).warnings.some(w => w.text.startsWith('Unfinished')), 'finished links and plain brackets are not');
}
console.log('blocks that are switched off');
{
  const src = '<!-- archipelago v1 -->\n# A\n<!-- island: id=s1 x=0 y=0 -->\n<!-- claim: first | id=c1 needs=c4,c5 -->\nText of first.\n\n<!-- claim: second | id=c2 -->\nText of second.\n\n# Pool\n<!-- island: id=s2 x=300 y=0 -->\n<!-- claim: linked claim | id=c4 -->\nPulled text.\n\n<!-- claim: unlinked | id=c3 -->\nHidden text.\n\n<!-- claim: also linked | id=c5 -->\n\n# C\n<!-- island: id=s3 x=600 y=0 -->\n<!-- claim: third | id=c6 -->\nText of third.\n\n<!-- claim: Fig | id=c7 pos=10,10 -->\n![F](f.png)\n';
  const mk = off => { const d = C.parse(src); if (off) L.setFront(d, 'inactive', off); return d; };
  const all = L.toLatex(mk(''), {}).tex;
  ok(all.includes('Hidden text.') && all.includes('\\section{Pool}') && all.includes('![') === false, 'everything is in the paper while nothing is off');
  const r = L.toLatex(mk('s2'), {}), t = r.tex;
  ok(!t.includes('\\section{Pool}') && !t.includes('Hidden text.') && t.includes('\\section{C}'), 'an island that is off is not in the LaTeX', t.match(/\\section\{[^}]*\}/g));
  ok(t.indexOf('Text of first.') < t.indexOf('Pulled text.') && t.indexOf('Pulled text.') < t.indexOf('Text of second.') && /%% apg c4 /.test(t), 'a claim of it that an active claim needs follows that claim', t);
  ok(C.numbering(mk('s2')).sections.get(C.parse(src).sections[2].id) === undefined && [...C.numbering(mk('s2')).sections.values()].join() === '1,2', 'and it has no section number');
  const f = L.toLatex(mk('c7'), {}).tex;
  ok(!f.includes('\\begin{figure}') && L.toLatex(mk(''), {}).tex.includes('\\begin{figure}'), 'a free-floating block that is off is not in the LaTeX either');
  const pl = C.plan(mk('s2'));
  ok(pl.pulled.size === 1 && [...pl.pulled.values()][0].map(q => q.cid).join() === 'c4,c5' && pl.hidden.size === 3, 'the plan says which paragraphs are shown where', [pl.pulled.size, pl.hidden.size]);
  {
    // a claim of an island that is off that depends on a claim of an island that is on is shown below that claim too
    const rev = C.parse('<!-- archipelago v1 -->\n# A\n<!-- island: id=s1 x=0 y=0 -->\n<!-- claim: active | id=c1 -->\nActive text.\n\n# Pool\n<!-- island: id=s2 x=300 y=0 -->\n<!-- claim: depends on active | id=c2 needs=c1 -->\nDependent text.\n\n<!-- claim: unlinked | id=c3 -->\nHidden text.\n');
    L.setFront(rev, 'inactive', 's2');
    const tt = L.toLatex(rev, {}).tex;
    ok(tt.includes('Dependent text.') && tt.indexOf('Dependent text.') > tt.indexOf('Active text.') && !tt.includes('Hidden text.'), 'a claim of an island that is off that depends on an active claim follows it, an unlinked one is left out', tt);
    const plr = C.plan(rev);
    ok([...plr.pulled.values()][0].map(q => q.cid).join() === 'c2', 'the plan shows it below the claim it depends on');
  }
  ok(C.serialize(mk('s2')).includes('inactive: s2') && C.serialize(C.parse(C.serialize(mk('s2')))) === C.serialize(mk('s2')), 'the switch is saved in the front matter and comes back');
  ok(L.toLatex(mk('s2'), {}).tex === L.toLatex(C.parse(C.serialize(mk('s2'))), {}).tex, 'the LaTeX is the same after saving and reading');
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
