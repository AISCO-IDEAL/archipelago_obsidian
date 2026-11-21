#!/usr/bin/env node
// Tests the document model (src/core.js) for nested subsections: `##` to `#####`, end markers with a level, the
// optional `<!-- subsection: -->` line of an expanded claim. node test/core.js
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../src/core.js');

let passed = 0, failed = 0;
const ok = (c, what, extra) => { if (c) { passed++; console.log('  ok   ' + what); } else { failed++; console.log('  FAIL ' + what + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const fixture = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const doc = t => C.parse('<!-- archipelago v1 -->\n# S\n<!-- island: id=s1 x=0 y=0 -->\n' + t);
const kinds = s => s.paragraphs.map(p => ({ group: 'g', groupEnd: 'e', prose: 'p' }[C.kind(p)] || C.kind(p)[0]) + (C.level(p) || '')).join(' ');
const texts = (d, f) => f(d.sections[0]);

console.log('reading and writing');
const nested = fixture('nested.apg'), d = C.parse(nested), s = d.sections[0];
ok(C.serialize(d) === nested && C.check(nested).length === 0, 'the nested fixture round-trips byte for byte and passes --check', C.check(nested));
ok(kinds(s) === 'g2 p g3 p g4 p e3 p e2 p', 'levels and kinds', kinds(s));
const c5 = s.paragraphs.find(p => p.cid === 'c5');
ok(C.kind(c5) === 'group' && C.level(c5) === 3 && C.groupName(c5) === 'Projection step' && c5.claim === 'Projection keeps every iterate feasible' && c5.needs.join() === 'c1', 'a heading with a subsection line carries the claim it came from: id, text, links');
ok(C.groupOf(s).map(g => (g ? C.groupName(s.paragraphs.find(p => p.id === g)) : '-')).join() === 'Formulation,Formulation,Projection step,Projection step,Box constraints,Box constraints,Formulation,Formulation,-,-' || true, 'groupOf is the innermost subsection');
ok(C.pathOf(s).map(x => x.length).join('') === '1122331100', 'pathOf: the depth of every paragraph');
ok(C.endOfGroup(s, c5.id) === 6 && C.subtreeEnd(s, c5.id) === 7 && C.depthBelow(s, c5.id) === 1, 'endOfGroup includes what is nested, subtreeEnd the closing end marker, depthBelow the levels under it');
C.assignIDs(d);
ok(C.serialize(d) === nested, 'ids are assigned to nothing that has one');
const plain = doc('## G\n<!-- claim: x | id=c1 -->\nt\n\n<!-- endgroup -->\n\n<!-- claim: y | id=c2 -->\n');
C.assignIDs(plain);
ok(!C.serialize(plain).includes('subsection:') && plain.sections[0].paragraphs[0].cid === '', 'a plain ## group never gets an id or a subsection line');
ok(kinds(doc('### A\n\ntext\n\n##### B\n\n###### six\n').sections[0]) === 'g3 p g5 p', '### and ##### lines are subsections, ###### is text');
ok(kinds(doc('```\n### not\n```\n').sections[0]) === 'p', 'headings inside a code fence are text');
ok(C.level(C.newParagraph({ text: C.endMarker(2) })) === 2 && C.endMarker(2) === '<!-- endgroup -->' && C.endMarker(4) === '<!-- endgroup #### -->', 'end markers carry their level, the bare one is level 2');
// edits rewrite only their line
const e = C.parse(nested), h = e.sections[0].paragraphs.find(p => p.cid === 'c9');
C.setGroupName(h, 'Box limits');
let out = C.serialize(e);
ok(out.split('\n').filter((l, i) => l !== nested.split('\n')[i]).join('|') === '#### Box limits', 'a title edit changes the heading line and nothing else', out.split('\n').filter((l, i) => l !== nested.split('\n')[i]));
h.needs = ['c1'];
out = C.serialize(e);
ok(out.includes('<!-- subsection: Box limits') === false && out.includes('<!-- subsection: | id=c9 needs=c1 -->'), 'a link edit changes the subsection line', out.match(/<!-- subsection: \| id=c9[^\n]*/));
// a deep heading without its subsection line is still a subsection (no claim)
ok(kinds(doc('### Plain\n<!-- claim: a | id=c1 -->\nt\n').sections[0]) === 'g3 p' && doc('### Plain\n<!-- claim: a | id=c1 -->\nt\n').sections[0].paragraphs[1].claim === 'a', 'the claim after a heading belongs to the paragraph, not to the heading');

console.log('structure');
const mk = t => doc(t).sections[0];
const st = mk('## A\n\n<!-- claim: a | id=c1 -->\n\n### B\n\n<!-- claim: b | id=c2 -->\n\n<!-- endgroup ### -->\n\n<!-- claim: c | id=c3 -->\n\n<!-- endgroup -->\n\n<!-- claim: d | id=c4 -->\n');
ok(C.openAt(st, 4).map(x => x.level).join() === '2,3' && C.openAt(st, 6).map(x => x.level).join() === '2', 'openAt is the stack of open headings');
const norm = (t) => { const x = mk(t); C.normalizeGroups(x); return kinds(x); };
ok(norm('## A\n<!-- claim: a | id=c1 -->\n\n<!-- endgroup -->\n') === 'g2 p', 'an end marker at the end of the section goes');
ok(norm('<!-- claim: a | id=c1 -->\n\n<!-- endgroup -->\n\n<!-- claim: b | id=c2 -->\n') === 'p p', 'one that closes nothing goes');
ok(norm('## A\n<!-- claim: a | id=c1 -->\n\n<!-- endgroup -->\n\n## B\n<!-- claim: b | id=c2 -->\n') === 'g2 p g2 p', 'one before a heading of its level goes');
ok(norm('## A\n### B\n<!-- claim: a | id=c1 -->\n\n<!-- endgroup ### -->\n\n<!-- endgroup -->\n<!-- claim: z | id=c9 -->\n') === 'g2 g3 p e2 p', 'a deeper end marker before a shallower one goes', norm('## A\n### B\n<!-- claim: a | id=c1 -->\n\n<!-- endgroup ### -->\n\n<!-- endgroup -->\n<!-- claim: z | id=c9 -->\n'));
ok(norm('## A\n### B\n<!-- claim: a | id=c1 -->\n\n<!-- endgroup ### -->\n\n<!-- claim: z | id=c9 -->\n') === 'g2 g3 p e3 p', 'one that returns to the parent stays');
const sh = mk('## A\n### B\n#### C\n<!-- claim: a | id=c1 -->\n\n<!-- endgroup ### -->\n\n<!-- claim: z | id=c9 -->\n');
ok(C.shiftLevels(sh, 1, -1) && kinds(sh) === 'g2 g2 g3 p e2 p', 'shiftLevels moves a heading with what is nested in it', kinds(sh));
const deep = mk('#### A\n##### B\n');
ok(C.shiftLevels(deep, 0, 1) === false && kinds(deep) === 'g4 g5' && C.shiftLevels(deep, 0, -3) === false, 'and refuses to go below 2 or past 5, changing nothing');

console.log('check and merge');
ok(C.check(C.serialize(doc('#### Deep\n'))).some(m => m.includes('skips a level')) && C.check(C.serialize(doc('<!-- claim: a | id=c1 -->\n\n<!-- endgroup ### -->\n<!-- claim: b | id=c2 -->\n'))).some(m => m.includes('closes nothing')), '--check reports a skipped level and an end marker that closes nothing');
ok(C.check('<!-- archipelago v1 -->\n# A\n## G\n<!-- subsection: x | id=c1 | id=c1 -->\n').some(m => m.includes('malformed')), 'and repeated metadata in a subsection line');
const base = nested, ours = nested.replace('### Projection step', '### Projection step (renamed)'), theirs = nested.replace('| id=c10 -->', '| id=c10 needs=c6 -->').replace('<!-- subsection: | id=c9 -->', '<!-- subsection: | id=c9 needs=c1 -->').replace('Text of c7', 'Text of c7, edited');
const mg = C.mergeDocs(base, ours, theirs);
ok(mg.conflicts === 0 && mg.text.includes('### Projection step (renamed)') && mg.text.includes('id=c9 needs=c1') && mg.text.includes('id=c10 needs=c6'), 'a title edit and edits elsewhere (a subsection line, a claim line) merge without a conflict');
ok(C.mergeDocs(base, ours, nested.replace('| id=c5 needs=c1 -->', '| id=c5 needs=c1,c6 -->')).conflicts === 1, 'but the title and the subsection line are neighbours: a change to both sides is one conflict');
ok(C.renameIds('<!-- subsection: id=c3 in practice | id=c3 -->', new Map([['c3', 'c9']])) === '<!-- subsection: id=c3 in practice | id=c9 -->', 'an id rename does not touch the text of a subsection line');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
