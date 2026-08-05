// Test unitaire de folders-source.js : parsing d'uuid, creation/renommage/suppression de
// dossier, assignation et desassignation. Aucune dependance, aucun framework, comme
// test-theme.js. Lance avec : node test-folders.js
//
// Ce qui touche au VRAI DOM (deplacement des items dans la sidebar, glisser-deposer,
// re-rendus de la SPA) n'est pas testable ici et ne l'est nulle part : ca se verifie a la main
// dans le navigateur. C'est precisement pour ca que toute la logique de rangement vit dans
// folders-source.js, ou elle est verifiable, et pas dans folders.js.
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// folders-source.js est charge par <script> de content script dans l'extension, pas par
// require() : pas de module.exports a y ajouter. On l'evalue dans son propre contexte et on
// relit ses "var" et "function" de premier niveau dessus.
var src = fs.readFileSync(path.join(__dirname, 'folders-source.js'), 'utf8');
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

var UUID_A = '0f2a1b3c-4d5e-6f70-8192-a3b4c5d6e7f8';
var UUID_B = '11112222-3333-4444-5555-666677778888';

// Les tableaux nes dans le contexte vm n'ont pas le Array.prototype de ce realm :
// deepStrictEqual echouerait dessus. On compare donc des chaines, comme test-status-source.js.
function ids(folders) { return folders.map(function (f) { return f.id; }).join(','); }
function pairs(map) {
  return Object.keys(map).sort().map(function (k) { return k + '=' + map[k]; }).join(',');
}

// ---- uuid depuis le href ----------------------------------------------------------------------

test('href relatif : uuid extrait', function () {
  assert.strictEqual(sandbox.folderUuidFromHref('/chat/' + UUID_A), UUID_A);
});

test('href absolu : uuid extrait aussi', function () {
  assert.strictEqual(sandbox.folderUuidFromHref('https://claude.ai/chat/' + UUID_A), UUID_A);
});

test('href avec suffixe (query, ancre) : uuid extrait quand meme', function () {
  assert.strictEqual(sandbox.folderUuidFromHref('/chat/' + UUID_A + '?from=recents'), UUID_A);
  assert.strictEqual(sandbox.folderUuidFromHref('/chat/' + UUID_A + '#bas'), UUID_A);
});

test('uuid normalise en minuscules', function () {
  assert.strictEqual(sandbox.folderUuidFromHref('/chat/' + UUID_A.toUpperCase()), UUID_A);
});

// Le piege que la forme uuid stricte evite : /chat/new n'est pas une conversation.
test('« /chat/new » et compagnie : pas d uuid', function () {
  assert.strictEqual(sandbox.folderUuidFromHref('/chat/new'), null);
  assert.strictEqual(sandbox.folderUuidFromHref('/projects/' + UUID_A), null);
  assert.strictEqual(sandbox.folderUuidFromHref('/chat/12345'), null);
  assert.strictEqual(sandbox.folderUuidFromHref(''), null);
  assert.strictEqual(sandbox.folderUuidFromHref(null), null);
  assert.strictEqual(sandbox.folderUuidFromHref(undefined), null);
});

// ---- normalisation a la lecture ----------------------------------------------------------------

test('storage vide : aucun dossier, aucune assignation', function () {
  assert.strictEqual(sandbox.folderList({}).length, 0);
  assert.strictEqual(sandbox.folderList(null).length, 0);
  assert.strictEqual(pairs(sandbox.folderAssignmentMap({}, [])), '');
});

test('entrees inexploitables jetees, pas reparees', function () {
  var out = sandbox.folderList({ folders: [
    { id: 'f1', name: 'Bon' },
    { id: 'f2', name: '   ' },        // nom vide apres nettoyage
    { id: '', name: 'Sans id' },
    { name: 'Sans id du tout' },
    { id: 'f1', name: 'Doublon' },    // id deja vu
    null
  ] });
  assert.strictEqual(ids(out), 'f1');
});

test('id de forme douteuse rejete (injection de selecteur)', function () {
  var out = sandbox.folderList({ folders: [
    { id: 'f1"] , [data-cf-folder="f2', name: 'Mechant' },
    { id: 'ok-1_2', name: 'Sage' }
  ] });
  assert.strictEqual(ids(out), 'ok-1_2');
});

test('couleur hors palette ramenee a la premiere, collapsed force en booleen', function () {
  var out = sandbox.folderList({ folders: [{ id: 'f1', name: 'A', color: '#123456', collapsed: 'oui' }] });
  assert.strictEqual(out[0].color, sandbox.FOLDER_COLORS[0]);
  assert.strictEqual(out[0].collapsed, false);
});

test('nom nettoye : espaces reduits, coupe a 40 caracteres', function () {
  var out = sandbox.folderList({ folders: [
    { id: 'f1', name: '  Trop   d\'espaces  ' },
    { id: 'f2', name: 'x'.repeat(60) }
  ] });
  assert.strictEqual(out[0].name, "Trop d'espaces");
  assert.strictEqual(out[1].name.length, 40);
});

test('assignation orpheline ignoree a la lecture', function () {
  var folders = sandbox.folderList({ folders: [{ id: 'f1', name: 'A' }] });
  var map = {};
  map[UUID_A] = 'f1';
  map[UUID_B] = 'f9';   // dossier inexistant
  assert.strictEqual(pairs(sandbox.folderAssignmentMap({ folderAssignments: map }, folders)),
    UUID_A + '=f1');
});

// ---- creation ---------------------------------------------------------------------------------

test('creation : id incremente, couleur suivante non utilisee, deplie', function () {
  var a = sandbox.folderCreate([], 'Travail');
  assert.strictEqual(ids(a), 'f1');
  assert.strictEqual(a[0].name, 'Travail');
  assert.strictEqual(a[0].color, sandbox.FOLDER_COLORS[0]);
  assert.strictEqual(a[0].collapsed, false);

  var b = sandbox.folderCreate(a, 'Perso');
  assert.strictEqual(ids(b), 'f1,f2');
  assert.strictEqual(b[1].color, sandbox.FOLDER_COLORS[1]);   // pas la meme que f1
});

test('creation : le tableau d entree n est jamais modifie', function () {
  var a = sandbox.folderCreate([], 'A');
  sandbox.folderCreate(a, 'B');
  assert.strictEqual(a.length, 1);
});

test('creation avec un nom vide ou annulee : rien ne change', function () {
  var a = sandbox.folderCreate([], 'A');
  assert.strictEqual(sandbox.folderCreate(a, '   ').length, 1);
  assert.strictEqual(sandbox.folderCreate(a, null).length, 1);
});

// L'id ne doit pas reprendre celui d'un dossier supprime tant qu'un plus grand existe : une
// assignation orpheline oubliee se rattacherait au mauvais dossier.
test('id : le trou d un dossier supprime n est pas reutilise', function () {
  var a = [{ id: 'f1', name: 'A' }, { id: 'f2', name: 'B' }, { id: 'f3', name: 'C' }];
  var sansF2 = a.filter(function (f) { return f.id !== 'f2'; });
  assert.strictEqual(sandbox.folderNewId(sansF2), 'f4');
});

// ---- renommage, couleur, repli -----------------------------------------------------------------

test('renommage', function () {
  var a = sandbox.folderCreate([], 'Avant');
  assert.strictEqual(sandbox.folderRename(a, 'f1', 'Après')[0].name, 'Après');
});

test('renommage avec un nom vide : inchange (prompt annule)', function () {
  var a = sandbox.folderCreate([], 'Avant');
  assert.strictEqual(sandbox.folderRename(a, 'f1', '  ')[0].name, 'Avant');
});

test('renommage d un dossier inconnu : inchange, pas d exception', function () {
  var a = sandbox.folderCreate([], 'A');
  assert.strictEqual(sandbox.folderRename(a, 'f99', 'X')[0].name, 'A');
});

test('changement de couleur, hors palette refuse', function () {
  var a = sandbox.folderCreate([], 'A');
  assert.strictEqual(sandbox.folderRecolor(a, 'f1', sandbox.FOLDER_COLORS[3])[0].color,
    sandbox.FOLDER_COLORS[3]);
  assert.strictEqual(sandbox.folderRecolor(a, 'f1', 'red')[0].color, sandbox.FOLDER_COLORS[0]);
});

test('repli : bascule, et ne touche pas les autres dossiers', function () {
  var a = sandbox.folderCreate(sandbox.folderCreate([], 'A'), 'B');
  var b = sandbox.folderToggle(a, 'f1');
  assert.strictEqual(b[0].collapsed, true);
  assert.strictEqual(b[1].collapsed, false);
  assert.strictEqual(sandbox.folderToggle(b, 'f1')[0].collapsed, false);
});

// ---- assignation ---------------------------------------------------------------------------------

test('assignation puis desassignation', function () {
  var m = sandbox.folderAssign({}, UUID_A, 'f1');
  assert.strictEqual(pairs(m), UUID_A + '=f1');
  assert.strictEqual(pairs(sandbox.folderUnassign(m, UUID_A)), '');
});

test('reassignation : une conversation n est que dans un seul dossier', function () {
  var m = sandbox.folderAssign(sandbox.folderAssign({}, UUID_A, 'f1'), UUID_A, 'f2');
  assert.strictEqual(pairs(m), UUID_A + '=f2');
});

test('assignation : la map d entree n est jamais modifiee', function () {
  var m = sandbox.folderAssign({}, UUID_A, 'f1');
  sandbox.folderAssign(m, UUID_B, 'f2');
  assert.strictEqual(pairs(m), UUID_A + '=f1');
  sandbox.folderUnassign(m, UUID_A);
  assert.strictEqual(pairs(m), UUID_A + '=f1');
});

test('desassignation d une conversation absente : rien ne change', function () {
  var m = sandbox.folderAssign({}, UUID_A, 'f1');
  assert.strictEqual(pairs(sandbox.folderUnassign(m, UUID_B)), UUID_A + '=f1');
});

test('assignation sans uuid ou sans dossier : ignoree', function () {
  assert.strictEqual(pairs(sandbox.folderAssign({}, null, 'f1')), '');
  assert.strictEqual(pairs(sandbox.folderAssign({}, UUID_A, null)), '');
});

// ---- retrait : bande « Retirer » et bouton « − » -----------------------------------------------
//
// Les deux entrees passent par le MEME cfApplyDrop('', uuid), donc par folderUnassign : ce qui
// suit verrouille les proprietes dont depend cette mise en commun. Le fait que le bouton appelle
// bien cette fonction-la, et pas une copie, se verifie dans test-folders-dom.js.

test('retrait : le resultat ne depend pas du dossier d origine', function () {
  var deF1 = sandbox.folderUnassign(sandbox.folderAssign({}, UUID_A, 'f1'), UUID_A);
  var deF2 = sandbox.folderUnassign(sandbox.folderAssign({}, UUID_A, 'f2'), UUID_A);
  assert.strictEqual(pairs(deF1), '');
  assert.strictEqual(pairs(deF2), '');
});

// Le bouton peut etre clique deux fois avant que le premier storage.onChanged ne soit revenu.
test('retrait : deux fois de suite = une fois (double clic)', function () {
  var m = sandbox.folderAssign(sandbox.folderAssign({}, UUID_A, 'f1'), UUID_B, 'f1');
  var une = sandbox.folderUnassign(m, UUID_A);
  assert.strictEqual(pairs(sandbox.folderUnassign(une, UUID_A)), pairs(une));
  assert.strictEqual(pairs(une), UUID_B + '=f1');   // la voisine n'a pas bouge
});

test('comptage par dossier', function () {
  var m = sandbox.folderAssign(sandbox.folderAssign({}, UUID_A, 'f1'), UUID_B, 'f1');
  assert.strictEqual(sandbox.folderCount(m, 'f1'), 2);
  assert.strictEqual(sandbox.folderCount(m, 'f2'), 0);
  assert.strictEqual(sandbox.folderCount({}, 'f1'), 0);
});

// ---- suppression : le point sensible --------------------------------------------------------------

test('suppression : le dossier part, ses conversations sont LIBEREES', function () {
  var folders = sandbox.folderCreate(sandbox.folderCreate([], 'A'), 'B');
  var m = sandbox.folderAssign(sandbox.folderAssign({}, UUID_A, 'f1'), UUID_B, 'f2');

  var out = sandbox.folderDelete(folders, m, 'f1');
  assert.strictEqual(ids(out.folders), 'f2');
  // UUID_A n'est plus assigne : il retourne dans « Recents ». UUID_B n'a pas bouge.
  assert.strictEqual(pairs(out.assignments), UUID_B + '=f2');
});

test('suppression : les entrees d origine ne sont pas modifiees', function () {
  var folders = sandbox.folderCreate([], 'A');
  var m = sandbox.folderAssign({}, UUID_A, 'f1');

  sandbox.folderDelete(folders, m, 'f1');
  assert.strictEqual(folders.length, 1);
  assert.strictEqual(pairs(m), UUID_A + '=f1');
});

test('suppression d un dossier inconnu : rien ne change', function () {
  var folders = sandbox.folderCreate([], 'A');
  var m = sandbox.folderAssign({}, UUID_A, 'f1');

  var out = sandbox.folderDelete(folders, m, 'f99');
  assert.strictEqual(ids(out.folders), 'f1');
  assert.strictEqual(pairs(out.assignments), UUID_A + '=f1');
});

test('suppression d un dossier vide : aucune assignation touchee', function () {
  var folders = sandbox.folderCreate(sandbox.folderCreate([], 'A'), 'B');
  var m = sandbox.folderAssign({}, UUID_A, 'f1');

  var out = sandbox.folderDelete(folders, m, 'f2');
  assert.strictEqual(pairs(out.assignments), UUID_A + '=f1');
});

// ---- modale de renommage -----------------------------------------------------------------------
//
// Les deux seules decisions de la modale qui ne dependent pas du DOM. Ce qu'elle AFFICHE se
// verifie dans test-folders-dom.js ; ce qu'elle DECIDE se verifie ici.

test('nom soumettable : ce qui survit au nettoyage, et rien d autre', function () {
  assert.strictEqual(sandbox.folderNameSubmittable('Travail'), true);
  assert.strictEqual(sandbox.folderNameSubmittable('  Travail  '), true);
  assert.strictEqual(sandbox.folderNameSubmittable('x'.repeat(60)), true);   // coupe, pas refuse
  assert.strictEqual(sandbox.folderNameSubmittable(''), false);
  assert.strictEqual(sandbox.folderNameSubmittable('   '), false);
  assert.strictEqual(sandbox.folderNameSubmittable('\n\t '), false);
  assert.strictEqual(sandbox.folderNameSubmittable(null), false);
  assert.strictEqual(sandbox.folderNameSubmittable(undefined), false);
});

// L'invariant qui justifie la fonction : refuser exactement ce que folderRename() ignorerait.
// Si les deux divergeaient, la modale se fermerait sur un nom que personne n'ecrirait — ce qui
// se lit comme une sauvegarde reussie.
test('nom soumettable ⇔ renommage effectif', function () {
  var a = sandbox.folderCreate([], 'Avant');
  ['Après', '  Après  ', '', '   ', null].forEach(function (saisi) {
    var change = sandbox.folderRename(a, 'f1', saisi)[0].name !== 'Avant';
    assert.strictEqual(sandbox.folderNameSubmittable(saisi), change, JSON.stringify(saisi));
  });
});

// Le meme invariant du cote creation : les deux modales de saisie partagent ce garde-fou, il
// doit donc coller aux DEUX ecritures. Un « Créer » actif sur un nom que folderCreate() jette
// fermerait la modale sans qu'aucun dossier n'apparaisse.
test('nom soumettable ⇔ création effective', function () {
  ['Travail', '  Travail  ', 'x'.repeat(60), '', '   ', '\n\t ', null, undefined]
    .forEach(function (saisi) {
      var cree = sandbox.folderCreate([], saisi).length === 1;
      assert.strictEqual(sandbox.folderNameSubmittable(saisi), cree, JSON.stringify(saisi));
    });
});

// ---- confirmation de suppression ---------------------------------------------------------------
//
// La confirmation n'a pas de champ, donc rien a valider : son bouton d'action n'est jamais grise
// et le seul garde-fou est le geste demande (verifie dans test-folders-dom.js, avec le focus sur
// « Annuler »). Ce qui est verifiable ici, c'est son texte — la seule partie qui peut etre fausse.

test('message de suppression : accord selon le nombre de conversations', function () {
  assert.ok(/^Ce dossier est vide\./.test(sandbox.folderDeleteMessage(0)));
  assert.ok(/^La conversation qu'il contient retournera /.test(sandbox.folderDeleteMessage(1)));
  assert.ok(/^Les 3 conversations qu'il contient retourneront /.test(sandbox.folderDeleteMessage(3)));
});

// La phrase qui repond a « est-ce que ca supprime mes conversations ? ». Elle ne doit disparaitre
// dans aucun des trois cas — c'est la seule raison d'etre de cette confirmation.
test('message de suppression : la réassurance est toujours présente', function () {
  [0, 1, 2, 50].forEach(function (n) {
    assert.ok(sandbox.folderDeleteMessage(n).indexOf('Aucune conversation ne sera supprimée.') !== -1,
      'n=' + n);
  });
});

test('message de suppression : un compte aberrant est traité comme zéro', function () {
  var vide = sandbox.folderDeleteMessage(0);
  [undefined, null, NaN, 'trois', -1].forEach(function (n) {
    assert.strictEqual(sandbox.folderDeleteMessage(n), vide, JSON.stringify(n));
  });
});

test('touches : Échap annule, Entrée valide, le reste est laissé au navigateur', function () {
  assert.strictEqual(sandbox.folderDialogKeyAction('Escape'), 'cancel');
  assert.strictEqual(sandbox.folderDialogKeyAction('Enter'), 'submit');
  ['a', 'Tab', 'ArrowDown', 'Backspace', 'Esc', 'enter', '', null, undefined]
    .forEach(function (k) {
      assert.strictEqual(sandbox.folderDialogKeyAction(k), null, JSON.stringify(k));
    });
});

// ---- palette ---------------------------------------------------------------------------------

test('palette : 8 couleurs, toutes distinctes, en #rrggbb', function () {
  var p = sandbox.FOLDER_COLORS;
  assert.strictEqual(p.length, 8);
  assert.strictEqual(p.filter(function (c, i) { return p.indexOf(c) === i; }).length, 8);
  p.forEach(function (c) { assert.ok(/^#[0-9a-f]{6}$/i.test(c), c); });
});

test('au-dela de 8 dossiers, les couleurs sont recyclees sans planter', function () {
  var folders = [];
  for (var i = 0; i < 10; i++) folders = sandbox.folderCreate(folders, 'D' + i);
  assert.strictEqual(folders.length, 10);
  folders.forEach(function (f) {
    assert.ok(sandbox.FOLDER_COLORS.indexOf(f.color) !== -1, f.color);
  });
});

// ---- execution ----------------------------------------------------------------------------
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

console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passes');
if (failed) process.exit(1);
