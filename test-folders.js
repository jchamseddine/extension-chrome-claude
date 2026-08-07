// Unit test for folders-source.js: uuid parsing, folder creation/renaming/deletion,
// assignment and unassignment. No dependency, no framework, like
// test-theme.js. Run with: node test-folders.js
//
// What touches the REAL DOM (moving the items in the sidebar, drag and drop,
// SPA re-renders) is not testable here and is not testable anywhere: it is verified by hand
// in the browser. That is precisely why all the filing logic lives in
// folders-source.js, where it is verifiable, and not in folders.js.
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// folders-source.js is loaded by a content script <script> in the extension, not by
// require(): no module.exports to add to it. We evaluate it in its own context and
// read back its top-level "var" and "function" on it.
var src = fs.readFileSync(path.join(__dirname, 'folders-source.js'), 'utf8');
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

var UUID_A = '0f2a1b3c-4d5e-6f70-8192-a3b4c5d6e7f8';
var UUID_B = '11112222-3333-4444-5555-666677778888';

// Arrays born in the vm context do not have this realm's Array.prototype:
// deepStrictEqual would fail on them. So we compare strings, like test-status-source.js.
function ids(folders) { return folders.map(function (f) { return f.id; }).join(','); }
function pairs(map) {
  return Object.keys(map).sort().map(function (k) { return k + '=' + map[k]; }).join(',');
}

// ---- uuid from the href -----------------------------------------------------------------------

test('relative href: uuid extracted', function () {
  assert.strictEqual(sandbox.folderUuidFromHref('/chat/' + UUID_A), UUID_A);
});

test('absolute href: uuid extracted too', function () {
  assert.strictEqual(sandbox.folderUuidFromHref('https://claude.ai/chat/' + UUID_A), UUID_A);
});

test('href with a suffix (query, anchor): uuid extracted anyway', function () {
  assert.strictEqual(sandbox.folderUuidFromHref('/chat/' + UUID_A + '?from=recents'), UUID_A);
  assert.strictEqual(sandbox.folderUuidFromHref('/chat/' + UUID_A + '#bas'), UUID_A);
});

test('uuid normalized to lowercase', function () {
  assert.strictEqual(sandbox.folderUuidFromHref('/chat/' + UUID_A.toUpperCase()), UUID_A);
});

// The pitfall the strict uuid shape avoids: /chat/new is not a conversation.
test('"/chat/new" and friends: no uuid', function () {
  assert.strictEqual(sandbox.folderUuidFromHref('/chat/new'), null);
  assert.strictEqual(sandbox.folderUuidFromHref('/projects/' + UUID_A), null);
  assert.strictEqual(sandbox.folderUuidFromHref('/chat/12345'), null);
  assert.strictEqual(sandbox.folderUuidFromHref(''), null);
  assert.strictEqual(sandbox.folderUuidFromHref(null), null);
  assert.strictEqual(sandbox.folderUuidFromHref(undefined), null);
});

// ---- normalization at read time -----------------------------------------------------------------

test('empty storage: no folder, no assignment', function () {
  assert.strictEqual(sandbox.folderList({}).length, 0);
  assert.strictEqual(sandbox.folderList(null).length, 0);
  assert.strictEqual(pairs(sandbox.folderAssignmentMap({}, [])), '');
});

test('unusable entries discarded, not repaired', function () {
  var out = sandbox.folderList({ folders: [
    { id: 'f1', name: 'Bon' },
    { id: 'f2', name: '   ' },        // nom vide apres nettoyage
    { id: '', name: 'Sans id' },
    { name: 'Sans id du tout' },
    { id: 'f1', name: 'Doublon' },    // id already seen
    null
  ] });
  assert.strictEqual(ids(out), 'f1');
});

test('id of dubious shape rejected (selector injection)', function () {
  var out = sandbox.folderList({ folders: [
    { id: 'f1"] , [data-cf-folder="f2', name: 'Mechant' },
    { id: 'ok-1_2', name: 'Sage' }
  ] });
  assert.strictEqual(ids(out), 'ok-1_2');
});

test('color outside the palette brought back to the first, collapsed forced to a boolean', function () {
  var out = sandbox.folderList({ folders: [{ id: 'f1', name: 'A', color: '#123456', collapsed: 'oui' }] });
  assert.strictEqual(out[0].color, sandbox.FOLDER_COLORS[0]);
  assert.strictEqual(out[0].collapsed, false);
});

test('name cleaned: spaces reduced, cut at 40 characters', function () {
  var out = sandbox.folderList({ folders: [
    { id: 'f1', name: '  Trop   d\'espaces  ' },
    { id: 'f2', name: 'x'.repeat(60) }
  ] });
  assert.strictEqual(out[0].name, "Trop d'espaces");
  assert.strictEqual(out[1].name.length, 40);
});

test('orphan assignment ignored at read time', function () {
  var folders = sandbox.folderList({ folders: [{ id: 'f1', name: 'A' }] });
  var map = {};
  map[UUID_A] = 'f1';
  map[UUID_B] = 'f9';   // dossier inexistant
  assert.strictEqual(pairs(sandbox.folderAssignmentMap({ folderAssignments: map }, folders)),
    UUID_A + '=f1');
});

// ---- creation ---------------------------------------------------------------------------------

test('creation: id incremented, next unused color, expanded', function () {
  var a = sandbox.folderCreate([], 'Travail');
  assert.strictEqual(ids(a), 'f1');
  assert.strictEqual(a[0].name, 'Travail');
  assert.strictEqual(a[0].color, sandbox.FOLDER_COLORS[0]);
  assert.strictEqual(a[0].collapsed, false);

  var b = sandbox.folderCreate(a, 'Perso');
  assert.strictEqual(ids(b), 'f1,f2');
  assert.strictEqual(b[1].color, sandbox.FOLDER_COLORS[1]);   // not the same as f1
});

test('creation: the input array is never modified', function () {
  var a = sandbox.folderCreate([], 'A');
  sandbox.folderCreate(a, 'B');
  assert.strictEqual(a.length, 1);
});

test('creation with an empty name or cancelled: nothing changes', function () {
  var a = sandbox.folderCreate([], 'A');
  assert.strictEqual(sandbox.folderCreate(a, '   ').length, 1);
  assert.strictEqual(sandbox.folderCreate(a, null).length, 1);
});

// The id must not reuse that of a deleted folder as long as a larger one exists: a
// forgotten orphan assignment would attach itself to the wrong folder.
test('id: the gap of a deleted folder is not reused', function () {
  var a = [{ id: 'f1', name: 'A' }, { id: 'f2', name: 'B' }, { id: 'f3', name: 'C' }];
  var sansF2 = a.filter(function (f) { return f.id !== 'f2'; });
  assert.strictEqual(sandbox.folderNewId(sansF2), 'f4');
});

// ---- renaming, color, collapsing ----------------------------------------------------------------

test('renaming', function () {
  var a = sandbox.folderCreate([], 'Avant');
  assert.strictEqual(sandbox.folderRename(a, 'f1', 'Après')[0].name, 'Après');
});

test('renaming with an empty name: unchanged (prompt cancelled)', function () {
  var a = sandbox.folderCreate([], 'Avant');
  assert.strictEqual(sandbox.folderRename(a, 'f1', '  ')[0].name, 'Avant');
});

test('renaming an unknown folder: unchanged, no exception', function () {
  var a = sandbox.folderCreate([], 'A');
  assert.strictEqual(sandbox.folderRename(a, 'f99', 'X')[0].name, 'A');
});

test('color change, outside the palette refused', function () {
  var a = sandbox.folderCreate([], 'A');
  assert.strictEqual(sandbox.folderRecolor(a, 'f1', sandbox.FOLDER_COLORS[3])[0].color,
    sandbox.FOLDER_COLORS[3]);
  assert.strictEqual(sandbox.folderRecolor(a, 'f1', 'red')[0].color, sandbox.FOLDER_COLORS[0]);
});

test('collapsing: toggles, and does not touch the other folders', function () {
  var a = sandbox.folderCreate(sandbox.folderCreate([], 'A'), 'B');
  var b = sandbox.folderToggle(a, 'f1');
  assert.strictEqual(b[0].collapsed, true);
  assert.strictEqual(b[1].collapsed, false);
  assert.strictEqual(sandbox.folderToggle(b, 'f1')[0].collapsed, false);
});

// ---- assignment ------------------------------------------------------------------------------------

test('assignment then unassignment', function () {
  var m = sandbox.folderAssign({}, UUID_A, 'f1');
  assert.strictEqual(pairs(m), UUID_A + '=f1');
  assert.strictEqual(pairs(sandbox.folderUnassign(m, UUID_A)), '');
});

test('reassignment: a conversation is only in a single folder', function () {
  var m = sandbox.folderAssign(sandbox.folderAssign({}, UUID_A, 'f1'), UUID_A, 'f2');
  assert.strictEqual(pairs(m), UUID_A + '=f2');
});

test('assignment: the input map is never modified', function () {
  var m = sandbox.folderAssign({}, UUID_A, 'f1');
  sandbox.folderAssign(m, UUID_B, 'f2');
  assert.strictEqual(pairs(m), UUID_A + '=f1');
  sandbox.folderUnassign(m, UUID_A);
  assert.strictEqual(pairs(m), UUID_A + '=f1');
});

test('unassignment of an absent conversation: nothing changes', function () {
  var m = sandbox.folderAssign({}, UUID_A, 'f1');
  assert.strictEqual(pairs(sandbox.folderUnassign(m, UUID_B)), UUID_A + '=f1');
});

test('assignment without a uuid or without a folder: ignored', function () {
  assert.strictEqual(pairs(sandbox.folderAssign({}, null, 'f1')), '');
  assert.strictEqual(pairs(sandbox.folderAssign({}, UUID_A, null)), '');
});

// ---- removal: "Retirer" strip and "−" button ---------------------------------------------------
//
// Both entry points go through the SAME cfApplyDrop('', uuid), hence through folderUnassign: what
// follows locks down the properties this sharing depends on. That the button really calls
// that function, and not a copy, is verified in test-folders-dom.js.

test('removal: the result does not depend on the folder of origin', function () {
  var deF1 = sandbox.folderUnassign(sandbox.folderAssign({}, UUID_A, 'f1'), UUID_A);
  var deF2 = sandbox.folderUnassign(sandbox.folderAssign({}, UUID_A, 'f2'), UUID_A);
  assert.strictEqual(pairs(deF1), '');
  assert.strictEqual(pairs(deF2), '');
});

// The button can be clicked twice before the first storage.onChanged has come back.
test('removal: twice in a row = once (double click)', function () {
  var m = sandbox.folderAssign(sandbox.folderAssign({}, UUID_A, 'f1'), UUID_B, 'f1');
  var une = sandbox.folderUnassign(m, UUID_A);
  assert.strictEqual(pairs(sandbox.folderUnassign(une, UUID_A)), pairs(une));
  assert.strictEqual(pairs(une), UUID_B + '=f1');   // the neighbour has not moved
});

test('per-folder count', function () {
  var m = sandbox.folderAssign(sandbox.folderAssign({}, UUID_A, 'f1'), UUID_B, 'f1');
  assert.strictEqual(sandbox.folderCount(m, 'f1'), 2);
  assert.strictEqual(sandbox.folderCount(m, 'f2'), 0);
  assert.strictEqual(sandbox.folderCount({}, 'f1'), 0);
});

// ---- deletion: the sensitive point ----------------------------------------------------------------

test('deletion: the folder goes, its conversations are FREED', function () {
  var folders = sandbox.folderCreate(sandbox.folderCreate([], 'A'), 'B');
  var m = sandbox.folderAssign(sandbox.folderAssign({}, UUID_A, 'f1'), UUID_B, 'f2');

  var out = sandbox.folderDelete(folders, m, 'f1');
  assert.strictEqual(ids(out.folders), 'f2');
  // UUID_A is no longer assigned: it goes back to "Recents". UUID_B has not moved.
  assert.strictEqual(pairs(out.assignments), UUID_B + '=f2');
});

test('deletion: the original inputs are not modified', function () {
  var folders = sandbox.folderCreate([], 'A');
  var m = sandbox.folderAssign({}, UUID_A, 'f1');

  sandbox.folderDelete(folders, m, 'f1');
  assert.strictEqual(folders.length, 1);
  assert.strictEqual(pairs(m), UUID_A + '=f1');
});

test('deletion of an unknown folder: nothing changes', function () {
  var folders = sandbox.folderCreate([], 'A');
  var m = sandbox.folderAssign({}, UUID_A, 'f1');

  var out = sandbox.folderDelete(folders, m, 'f99');
  assert.strictEqual(ids(out.folders), 'f1');
  assert.strictEqual(pairs(out.assignments), UUID_A + '=f1');
});

test('deletion of an empty folder: no assignment touched', function () {
  var folders = sandbox.folderCreate(sandbox.folderCreate([], 'A'), 'B');
  var m = sandbox.folderAssign({}, UUID_A, 'f1');

  var out = sandbox.folderDelete(folders, m, 'f2');
  assert.strictEqual(pairs(out.assignments), UUID_A + '=f1');
});

// ---- rename modal ------------------------------------------------------------------------------
//
// The only two modal decisions that do not depend on the DOM. What it DISPLAYS is
// verified in test-folders-dom.js; what it DECIDES is verified here.

test('submittable name: what survives the cleanup, and nothing else', function () {
  assert.strictEqual(sandbox.folderNameSubmittable('Travail'), true);
  assert.strictEqual(sandbox.folderNameSubmittable('  Travail  '), true);
  assert.strictEqual(sandbox.folderNameSubmittable('x'.repeat(60)), true);   // cut, not refused
  assert.strictEqual(sandbox.folderNameSubmittable(''), false);
  assert.strictEqual(sandbox.folderNameSubmittable('   '), false);
  assert.strictEqual(sandbox.folderNameSubmittable('\n\t '), false);
  assert.strictEqual(sandbox.folderNameSubmittable(null), false);
  assert.strictEqual(sandbox.folderNameSubmittable(undefined), false);
});

// The invariant that justifies the function: refusing exactly what folderRename() would ignore.
// If the two diverged, the modal would close on a name nobody would write — which
// reads as a successful save.
test('submittable name <=> effective renaming', function () {
  var a = sandbox.folderCreate([], 'Avant');
  ['Après', '  Après  ', '', '   ', null].forEach(function (saisi) {
    var change = sandbox.folderRename(a, 'f1', saisi)[0].name !== 'Avant';
    assert.strictEqual(sandbox.folderNameSubmittable(saisi), change, JSON.stringify(saisi));
  });
});

// The same invariant on the creation side: both input modals share this guard, so it
// must match BOTH writes. A « Créer » active on a name folderCreate() discards
// would close the modal without any folder appearing.
test('submittable name <=> effective creation', function () {
  ['Travail', '  Travail  ', 'x'.repeat(60), '', '   ', '\n\t ', null, undefined]
    .forEach(function (saisi) {
      var cree = sandbox.folderCreate([], saisi).length === 1;
      assert.strictEqual(sandbox.folderNameSubmittable(saisi), cree, JSON.stringify(saisi));
    });
});

// ---- delete confirmation ------------------------------------------------------------------------
//
// The confirmation has no field, hence nothing to validate: its action button is never greyed out
// and the only guard is the gesture asked for (verified in test-folders-dom.js, with the focus on
// « Annuler »). What is verifiable here is its text — the only part that can be wrong.

test('delete message: agreement according to the number of conversations', function () {
  assert.ok(/^Ce dossier est vide\./.test(sandbox.folderDeleteMessage(0)));
  assert.ok(/^La conversation qu'il contient retournera /.test(sandbox.folderDeleteMessage(1)));
  assert.ok(/^Les 3 conversations qu'il contient retourneront /.test(sandbox.folderDeleteMessage(3)));
});

// The sentence that answers "does this delete my conversations?". It must not disappear
// in any of the three cases — it is the whole reason this confirmation exists.
test('delete message: the reassurance is always present', function () {
  [0, 1, 2, 50].forEach(function (n) {
    assert.ok(sandbox.folderDeleteMessage(n).indexOf('Aucune conversation ne sera supprimée.') !== -1,
      'n=' + n);
  });
});

test('delete message: a nonsensical count is treated as zero', function () {
  var vide = sandbox.folderDeleteMessage(0);
  [undefined, null, NaN, 'trois', -1].forEach(function (n) {
    assert.strictEqual(sandbox.folderDeleteMessage(n), vide, JSON.stringify(n));
  });
});

test('keys: Escape cancels, Enter submits, the rest is left to the browser', function () {
  assert.strictEqual(sandbox.folderDialogKeyAction('Escape'), 'cancel');
  assert.strictEqual(sandbox.folderDialogKeyAction('Enter'), 'submit');
  ['a', 'Tab', 'ArrowDown', 'Backspace', 'Esc', 'enter', '', null, undefined]
    .forEach(function (k) {
      assert.strictEqual(sandbox.folderDialogKeyAction(k), null, JSON.stringify(k));
    });
});

// ---- palette ---------------------------------------------------------------------------------

test('palette: 8 colors, all distinct, in #rrggbb', function () {
  var p = sandbox.FOLDER_COLORS;
  assert.strictEqual(p.length, 8);
  assert.strictEqual(p.filter(function (c, i) { return p.indexOf(c) === i; }).length, 8);
  p.forEach(function (c) { assert.ok(/^#[0-9a-f]{6}$/i.test(c), c); });
});

test('beyond 8 folders, the colors are recycled without crashing', function () {
  var folders = [];
  for (var i = 0; i < 10; i++) folders = sandbox.folderCreate(folders, 'D' + i);
  assert.strictEqual(folders.length, 10);
  folders.forEach(function (f) {
    assert.ok(sandbox.FOLDER_COLORS.indexOf(f.color) !== -1, f.color);
  });
});

// ---- run -----------------------------------------------------------------------------------
var failed = 0;
tests.forEach(function (t) {
  try {
    t.fn();
    console.log('  ok  ' + t.name);
  } catch (e) {
    failed++;
    console.error('FAIL  ' + t.name);
    console.error('      ' + e.message);
  }
});

console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passed');
if (failed) process.exit(1);
