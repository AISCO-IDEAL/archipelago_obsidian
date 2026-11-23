#!/usr/bin/env node
// Unit tests of the merge that protects an open document when its file changes on disk.
'use strict';
const fs = require('fs');
const path = require('path');
const Core = require('../src/core.js');

let passed = 0, failed = 0;
const ok = (c, what, extra) => { if (c) { passed++; console.log('  ok   ' + what); } else { failed++; console.log('  FAIL ' + what + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };

const base = fs.readFileSync(path.join(__dirname, 'fixtures', 'example.apg'), 'utf8');
const edit = (text, from, to) => { if (!text.includes(from)) throw new Error('fixture has no: ' + from); return text.replace(from, to); };

console.log('lcsPairs');
{
  // against a plain dynamic-programming LCS on random inputs
  const dp = (a, b) => { const t = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1)); for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]); return t[0][0]; };
  let bad = 0;
  for (let n = 0; n < 300; n++) {
    const len = () => Math.floor(Math.random() * 25), sym = () => 'abcde'[Math.floor(Math.random() * 5)];
    const a = Array.from({ length: len() }, sym), b = Array.from({ length: len() }, sym);
    const p = Core.lcsPairs(a, b);
    const valid = p.every(([i, j], k) => a[i] === b[j] && (k === 0 || (i > p[k - 1][0] && j > p[k - 1][1])));
    if (!valid || p.length !== dp(a, b)) bad++;
  }
  ok(bad === 0, 'finds a longest common subsequence (300 random cases)', bad);
  ok(Core.lcsPairs(['a'], ['b']).length === 0, 'nothing in common');
  const big = Array.from({ length: 3000 }, (_, i) => 'l' + i), big2 = Array.from({ length: 3000 }, (_, i) => 'm' + i);
  ok(Core.lcsPairs(big, big2) === null, 'gives up on texts with nothing in common instead of hanging');
}

console.log('merging');
const m = (o, a, b) => Core.mergeDocs(o, a, b);
{
  const c1 = 'Gradient-based shape optimization is bottlenecked by the mesh, not the optimizer.';
  const c6 = 'Neural implicit shapes are expressive but lack editable parameters.';
  const r0 = m(base, base, base);
  ok(r0.conflicts === 0 && r0.text === base, 'nothing changed');
  const theirs = edit(base, c1, 'Their c1');
  const ours = edit(base, c6, 'Our c6');
  const r1 = m(base, ours, theirs);
  ok(r1.conflicts === 0 && r1.text.includes('Their c1') && r1.text.includes('Our c6'), 'edits to different claims both survive');
  ok(m(base, base, theirs).text === theirs, 'only theirs changed: theirs wins');
  ok(m(base, ours, base).text === ours, 'only ours changed: ours stays');
  ok(m(base, theirs, theirs).text === theirs, 'the same change on both sides is no conflict');
  const r2 = m(base, edit(base, c1, 'Mine'), edit(base, c1, 'Yours'));
  ok(r2.conflicts === 1 && r2.text === null, 'the same claim edited differently is one conflict');
  const sg = r2.segments.find(x => x.type === 'conflict');
  ok(sg.heading === 'Introduction' && /Gradient/.test(sg.claim + sg.ours.join('') + sg.theirs.join('')) || sg.heading === 'Introduction', 'the conflict names its section', [sg.heading, sg.claim]);
  sg.choice = 'theirs';
  ok(Core.joinSegments(r2.segments).includes('Yours') && !Core.joinSegments(r2.segments).includes('Mine'), 'choosing theirs keeps theirs');
  sg.choice = 'both';
  ok(Core.joinSegments(r2.segments).includes('Yours') && Core.joinSegments(r2.segments).includes('Mine'), 'choosing both keeps both');
  // islands
  const isl = '<!-- island: id=s1 x=40 y=60 -->';
  ok(m(base, edit(base, isl, '<!-- island: id=s1 x=100 y=60 -->'), edit(base, c6, 'X')).conflicts === 0, 'moving an island while someone edits a claim: no conflict');
  ok(m(base, edit(base, isl, '<!-- island: id=s1 x=100 y=60 -->'), edit(base, isl, '<!-- island: id=s1 x=40 y=500 -->')).conflicts === 1, 'both moving the same island is a conflict');
  // delete vs edit
  const del = edit(base, `<!-- claim: ${c6} | id=c6 -->\nLearned implicit representations reconstruct complex shapes from sparse data with remarkable fidelity. Their parameters, however, are network weights with no engineering meaning.\n\n`, '');
  ok(m(base, del, edit(base, 'Learned implicit', 'Learned IMPLICIT')).conflicts === 1, 'deleting a claim someone else edited is a conflict');
  ok(m(base, del, base).text === del, 'a deletion alone goes through');
}

console.log('new ids');
{
  // Both sides add a claim at the end of the same island: each calls it c30.
  const mk = (id, text) => `<!-- claim: ${text} | id=${id} -->\n\n`;
  const anchor = '# Related Work\n';
  const A = edit(base, anchor, mk('c30', 'Added by A') + anchor);
  const B = edit(base, anchor, mk('c30', 'Added by B') + anchor);
  const r = m(base, A, B);
  ok(r.conflicts === 0, 'two insertions at one place merge without a conflict');
  const d = Core.parse(r.text);
  const ids = d.sections.flatMap(s => s.paragraphs.map(p => p.cid)).filter(Boolean);
  ok(new Set(ids).size === ids.length, 'ids stay unique', ids.filter((x, i) => ids.indexOf(x) !== i));
  ok(r.text.includes('Added by A') && r.text.includes('Added by B'), 'both claims are there');
  const cs = d.sections.flatMap(s => s.paragraphs).filter(p => /Added by/.test(p.claim));
  ok(cs.length === 2 && cs[0].cid !== cs[1].cid, 'the clashing id of theirs got a new number', cs.map(p => p.cid));
  // B's new claim is linked by another new claim of B: the link must follow the rename.
  const B2 = edit(base, anchor, mk('c30', 'B first') + `<!-- claim: B second | id=c31 needs=c30 -->\n\n` + anchor);
  const A2 = edit(base, anchor, mk('c30', 'A only') + anchor);
  const r2 = Core.parse(m(base, A2, B2).text);
  const all = r2.sections.flatMap(s => s.paragraphs);
  const first = all.find(p => p.claim === 'B first'), second = all.find(p => p.claim === 'B second'), mine = all.find(p => p.claim === 'A only');
  ok(second.needs.length === 1 && second.needs[0] === first.cid && first.cid !== mine.cid, 'a link inside the renamed part follows the new id', [first.cid, second.needs, mine.cid]);
  ok(Core.renameIds('<!-- claim: id=c1 and needs=c1 in the text | id=c1 needs=c1,c2 -->', new Map([['c1', 'c9']])) === '<!-- claim: id=c1 and needs=c1 in the text | id=c9 needs=c9,c2 -->', 'renaming never touches the claim text');
}

console.log('dangling links');
{
  const d = Core.parse(base);
  const target = d.sections.flatMap(s => s.paragraphs).find(p => p.cid === 'c3');
  target.cid = 'gone';
  const n = Core.dropDangling(d);
  ok(n >= 1 && d.sections.flatMap(s => s.paragraphs).every(p => !p.needs.includes('c3')), 'links to a claim that is gone are dropped', n);
}

console.log('the result is a valid document');
{
  const r = m(base, edit(base, '# Introduction', '# Intro'), edit(base, '# Related Work', '# Prior Work'));
  const d = Core.parse(r.text);
  ok(Core.serialize(d) === r.text && Core.check(r.text).length === 0, 'it parses, round-trips and passes --check', Core.check(r.text));
}

console.log('files that come back exactly as they were');
{
  const head = '<!-- archipelago v1: an older plugin wrote this line -->\n';
  const doc = head + '# A\n<!-- island: id=s1 x=1 y=2 -->\n<!-- claim: x | id=c1 -->\n~~~js\n# not a heading\n~~~\n\n<!-- claim: y | id=c2 -->\n````\n```\n# nor this\n```\n````\n\n   ```\n# nor this\n   ```\n';
  const same = (text, what) => { const d = Core.parse(text); ok(Core.serialize(d) === text, what, JSON.stringify(Core.serialize(d)).slice(0, 160)); return d; };
  const d = same(doc, 'fences made of ~~~, ````, and indented ones keep their lines, and an old format line stays');
  ok(d.sections.length === 1, 'a "# " inside any kind of fence is not a section', d.sections.map(x => x.title));
  same(doc.replaceAll('\n', '\r\n'), 'a file with Windows line endings is written back with them, every line');
  same('﻿' + doc, 'a byte order mark stays');
  same('---\ntitle: T\n---\n' + doc, 'front matter and a document together');
  // without a format line one is added, once, at the top; with the current one nothing changes
  const bare = '# A\n<!-- claim: x | id=c1 -->\ntext\n';
  ok(Core.serialize(Core.parse(bare)).startsWith(Core.serialize(Core.parse('')).split('\n')[0]) || Core.isDocument(Core.serialize(Core.parse(bare))), 'a file without the line gets it');
  // merging text with Windows line endings
  const crlf = doc.replaceAll('\n', '\r\n');
  const r = Core.mergeDocs(crlf, crlf.replace('x |', 'x2 |'), crlf.replace('y |', 'y2 |'), crlf);
  ok(r.conflicts === 0 && r.text.includes('\r\n') && !/[^\r]\n/.test(r.text) && r.text.includes('x2') && r.text.includes('y2'), 'merging keeps the line endings and both changes', JSON.stringify(r.text).slice(0, 120));
}

console.log('ids that were saved before a change arrived');
{
  const anchor = '# Related Work\n';
  const ours = edit(base, anchor, '<!-- claim: third | id=c30 needs=c1 -->\n\n' + anchor);
  const theirs = edit(ours, 'Their parameters', 'Edited elsewhere');
  const r = Core.mergeDocs(base, ours, theirs, ours);
  ok(r.conflicts === 0 && (r.text.match(/third/g) || []).length === 1, 'a claim we saved earlier is not duplicated when a change that grew from it arrives', (r.text.match(/third/g) || []).length);
  ok(!/id=c3[1-9]/.test(r.text), 'and keeps its id');
  const A = edit(base, anchor, '<!-- claim: A new | id=c30 -->\n\n' + anchor), B = edit(base, anchor, '<!-- claim: B new | id=c30 -->\n\n' + anchor);
  const r2 = Core.mergeDocs(base, A, B, A);   // we saved c30, then their independent c30 won at the sync tool and arrives
  const d2 = Core.parse(r2.text), renamed = Core.fixDuplicateIds(d2);
  ok(renamed.length === 1, 'two claims that ended up with one id are told apart afterwards', renamed);
  // the same claim twice (both sides added it, the diffs lined the copies up differently): one copy goes
  const dup = Core.parse(Core.serialize(Core.parse(edit(base, anchor, '<!-- claim: same | id=c30 -->\ntext\n\n<!-- claim: same | id=c30 -->\ntext\n\n' + anchor))));
  const removed = Core.fixDuplicateIds(dup);
  ok(removed.length === 1 && /second copy removed/.test(removed[0]) && dup.sections.flatMap(x => x.paragraphs).filter(p => p.claim === 'same').length === 1, 'a second copy of the very same claim is removed, not renamed', removed);
  const ids = d2.sections.flatMap(x => x.paragraphs.map(p => p.cid)).filter(Boolean);
  ok(new Set(ids).size === ids.length, 'every id is unique then');
  ok(Core.mergeDocs(base, base, edit(base, 'Their parameters', 'X')).text.includes('X'), 'with nothing of ours changed, theirs just wins');
  // the format line differing between plugin versions is no id and no conflict
  ok(!Core.idsIn('<!-- archipelago v1: `# ` heading = section, island = its map position (id=s*). claim = (id=c*) -->').size, 'ids in the format line are not ids');
}

console.log('a version of ours that comes back (sync tools)');
{
  const v0 = '<!-- archipelago v1 -->\n# A\n<!-- island: id=s1 x=0 y=0 -->\n<!-- claim: x | id=c1 -->\nText.\n\n<!-- claim: y | id=c2 -->\nMore.\n\n<!-- claim: NeuralFoil | id=c25 -->\nSee\n';
  const v1 = v0.replace('\nSee\n', '\nSee [[@ten\n');   // saved while typing a link
  const v2 = v0.replace('\nSee\n', '\nSee [[S/@Ten Simple Rules|@Ten Simple Rules]]\n');   // saved after the suggestion
  const from = Core.closestBase([v0, v1, v2], v1);
  ok(from === v1, 'an earlier write of ours that comes back is its own base');
  const r = Core.mergeDocs(from, v2, v1, v2);
  ok(!r.conflicts && r.text === v2, 'so merging it changes nothing and asks nothing', r.segments && r.segments.filter(x => x.type === 'conflict'));
  ok(Core.mergeDocs(v0, v2, v1, v2).conflicts === 1, '(over the base from the open, it is a conflict: the case this avoids)');
  // another device edited the version before our last write ("newer file wins" lost our edit): our edit stays
  const mine = v2.replace('Text.', 'Text, mine.');
  const theirs = v2.replace('More.', 'More, theirs.');
  const b2 = Core.closestBase([v0, v1, v2, mine], theirs);
  ok(b2 === v2, 'an edit of an older version of ours: that version is the base', [v0, v1, v2, mine].indexOf(b2));
  const r2 = Core.mergeDocs(b2, mine, theirs, mine);
  ok(!r2.conflicts && r2.text.includes('Text, mine.') && r2.text.includes('More, theirs.'), 'and both edits are kept', r2.text);
  ok(Core.closestBase([v0, v0.replace('x |', 'z |')], v0.replace('Text.', 'Other.')) === v0, 'on a tie the older version');
}

console.log('what is a document');
{
  const doc = Core.serialize(Core.parse(base));
  ok(Core.isDocument(doc), 'a document');
  const line = doc.split('\n').find(l => Core.isFormatLine(l));
  ok(Core.isDocument(line + '\n# A\n'), 'one that starts with the format line');
  ok(Core.isDocument('---\ntitle: T\nthesis: S\n---\n' + line + '\n# A\n'), 'with front matter');
  ok(Core.isDocument('\uFEFF' + line + '\n# A\n'), 'with a byte order mark');
  ok(Core.isDocument('\n\n' + line + '\n'), 'after blank lines');
  ok(!Core.isDocument('# Index\n\n%% Begin Waypoint %%\n- [[A]]\n%% End Waypoint %%\n'), 'an index note is not');
  ok(!Core.isDocument(''), 'an empty file is not');
  ok(!Core.isDocument('Some text\n' + line + '\n'), 'a note with the line further down is not');
  ok(!Core.isDocument('```\n' + line + '\n```\n'), 'a note that quotes the line in a code block is not');
  ok(!Core.isDocument('---\ntitle: x\n' + line + '\n'), 'front matter that never ends is not');
  ok(!Core.isDocument('# A\n' + line + '\n# B\n'), 'a heading before the line is not');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
