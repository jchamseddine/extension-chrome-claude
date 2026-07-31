// Test unitaire de autocontinue-source.js : les six variantes de phrase, le garde-fou
// anti-faux-positif, le compteur maximum et la pause. Aucune dependance, aucun framework,
// comme test-status-source.js. Lance avec : node test-autocontinue.js
//
// Seule la logique PURE est testee ici. Le DOM (selecteurs de messages, bouton « Continue »)
// est dans autocontinue.js et n'est pas couvert : il ne peut se verifier que sur la vraie page.
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// autocontinue-source.js est charge par importScripts() et par <script> dans l'extension, pas
// par require() : pas de module.exports a y ajouter. On l'evalue dans son propre contexte et on
// relit ses "var" et "function" de premier niveau dessus.
var src = fs.readFileSync(path.join(__dirname, 'autocontinue-source.js'), 'utf8');
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// Reglages nominaux : actif, pas en pause, compteur vierge, maximum illimite.
function on(over) {
  var s = { enabled: true, paused: false, count: 0, maxCount: 0 };
  Object.keys(over || {}).forEach(function (k) { s[k] = over[k]; });
  return s;
}

// Un scan qui remplit les deux conditions : bouton visible, phrase dans le dernier message
// seulement.
function scan(over) {
  var d = {
    hasButton: true,
    lastText: 'I have reached its tool use limit for this response.',
    otherTexts: ['Bonjour', 'Voici le resultat de la recherche.']
  };
  Object.keys(over || {}).forEach(function (k) { d[k] = over[k]; });
  return d;
}

// ---- les six variantes de phrase ------------------------------------------------------------

// Une phrase reelle est noyee dans un paragraphe : on teste en sous-chaine, pas en egalite.
var VARIANTES = [
  ['tool-use limit',    'Claude has hit the tool-use limit for this turn.'],
  ['tool use limit',    'I reached the tool use limit while working on this.'],
  ['reached its tool',  'The response reached its tool budget and stopped.'],
  ['exhausted the tool', 'This response exhausted the tool allowance available.'],
  ['tool call limit',   'Stopped: tool call limit exceeded.'],
  ['continuation needed', 'Response incomplete, continuation needed.']
];

VARIANTES.forEach(function (v) {
  test('variante « ' + v[0] + ' » detectee dans un paragraphe', function () {
    assert.strictEqual(sandbox.acHasLimitPhrase(v[1]), true);
  });
});

test('les six variantes sont bien celles listees', function () {
  assert.strictEqual(sandbox.AC_LIMIT_PHRASES.length, 6);
  assert.strictEqual(sandbox.AC_LIMIT_PHRASES.join('|'),
    VARIANTES.map(function (v) { return v[0]; }).join('|'));
});

test('detection insensible a la casse', function () {
  assert.strictEqual(sandbox.acHasLimitPhrase('TOOL-USE LIMIT reached'), true);
  assert.strictEqual(sandbox.acHasLimitPhrase('Tool Call Limit'), true);
});

test('texte ordinaire, vide ou non-chaine : aucune phrase', function () {
  assert.strictEqual(sandbox.acHasLimitPhrase('Voici la reponse complete.'), false);
  assert.strictEqual(sandbox.acHasLimitPhrase(''), false);
  assert.strictEqual(sandbox.acHasLimitPhrase(null), false);
  assert.strictEqual(sandbox.acHasLimitPhrase(42), false);
});

// ---- les deux conditions cumulees -------------------------------------------------------------

test('bouton + phrase dans le dernier message seulement : on continue', function () {
  var d = sandbox.acDecide(scan(), on());
  assert.strictEqual(d.go, true, d.reason);
});

test('phrase sans bouton Continue : on ne continue pas', function () {
  var d = sandbox.acDecide(scan({ hasButton: false }), on());
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('bouton') !== -1, d.reason);
});

test('bouton sans phrase dans le dernier message : on ne continue pas', function () {
  var d = sandbox.acDecide(scan({ lastText: 'Voici la reponse, terminee.' }), on());
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('dernier message') !== -1, d.reason);
});

// Le faux positif que ce garde-fou existe pour eviter : une conversation dont le SUJET est la
// limite de tool-use en parle a chaque message, et s'auto-continuerait sans fin.
test('conversation qui parle du sujet : phrase plus haut, on ne continue pas', function () {
  var d = sandbox.acDecide(scan({
    otherTexts: ['Explique-moi comment marche la tool-use limit de Claude.',
                 'Voici comment elle fonctionne.']
  }), on());
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('plus haut') !== -1, d.reason);
});

test('phrase dans un seul message ancien, absente du dernier : on ne continue pas', function () {
  var d = sandbox.acDecide(scan({
    lastText: 'Voici la suite.',
    otherTexts: ['Cette reponse a atteint la tool call limit.']
  }), on());
  assert.strictEqual(d.go, false);
});

test('conversation d un seul message : rien "ailleurs", on continue', function () {
  var d = sandbox.acDecide(scan({ otherTexts: [] }), on());
  assert.strictEqual(d.go, true, d.reason);
});

// ---- pause et activation ----------------------------------------------------------------------

test('desactive : on ne continue pas, meme si tout est reuni', function () {
  var d = sandbox.acDecide(scan(), on({ enabled: false }));
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('desactive') !== -1, d.reason);
});

test('en pause : on ne continue pas, sans toucher aux autres reglages', function () {
  var d = sandbox.acDecide(scan(), on({ paused: true }));
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('pause') !== -1, d.reason);
});

// ---- compteur maximum -------------------------------------------------------------------------

test('compteur sous le maximum : on continue', function () {
  assert.strictEqual(sandbox.acDecide(scan(), on({ count: 9, maxCount: 10 })).go, true);
});

test('compteur egal au maximum : on s arrete', function () {
  var d = sandbox.acDecide(scan(), on({ count: 10, maxCount: 10 }));
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('maximum') !== -1, d.reason);
});

test('compteur au-dela du maximum : on s arrete aussi', function () {
  assert.strictEqual(sandbox.acDecide(scan(), on({ count: 42, maxCount: 10 })).go, false);
});

test('maximum a 0 = illimite : un gros compteur ne bloque pas', function () {
  assert.strictEqual(sandbox.acDecide(scan(), on({ count: 5000, maxCount: 0 })).go, true);
});

test('acMaxReached : 0 est illimite, pas "deja atteint"', function () {
  assert.strictEqual(sandbox.acMaxReached({ count: 0, maxCount: 0 }), false);
  assert.strictEqual(sandbox.acMaxReached({ count: 3, maxCount: 3 }), true);
  assert.strictEqual(sandbox.acMaxReached({ count: 2, maxCount: 3 }), false);
});

// ---- l'etat exact releve en usage reel ----------------------------------------------------------

// Storage constate : maxCount a 0, paused a false, et autoContinueCount TOTALEMENT ABSENT.
// C'est la combinaison soupconnee de tout bloquer. Ces trois tests fixent le contrat : elle ne
// bloque rien, et la cle manquante se comporte a l'identique d'une cle a zero.
var RELEVE = { autoContinueMaxCount: 0, autoContinuePaused: false };

function releve(over) {
  var o = { autoContinueMaxCount: 0, autoContinuePaused: false };
  Object.keys(over || {}).forEach(function (k) { o[k] = over[k]; });
  return o;
}

test('état relevé + activé : maxCount 0 et compteur absent NE bloquent pas', function () {
  var s = sandbox.acSettings(releve({ autoContinueEnabled: true }));
  assert.strictEqual(s.count, 0, 'une clé absente doit être lue comme 0');
  assert.strictEqual(s.maxCount, sandbox.AC_UNLIMITED);
  assert.strictEqual(sandbox.acMaxReached(s), false, 'maxCount 0 lu comme quota épuisé');

  var d = sandbox.acDecide(scan(), s);
  assert.strictEqual(d.go, true, d.reason);
});

test('compteur ABSENT et compteur a 0 : strictement le meme comportement', function () {
  var absent = sandbox.acSettings(releve({ autoContinueEnabled: true }));
  var zero = sandbox.acSettings(releve({ autoContinueEnabled: true, autoContinueCount: 0 }));

  assert.strictEqual(absent.count, zero.count);
  assert.strictEqual(sandbox.acDecide(scan(), absent).go, sandbox.acDecide(scan(), zero).go);
});

// La seule valeur manquante qui bloque vraiment — et celle qui manquait au relevé.
test('état relevé SANS autoContinueEnabled : c est ca, et seulement ca, qui bloque', function () {
  var d = sandbox.acDecide(scan(), sandbox.acSettings(RELEVE));
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('desactive') !== -1, d.reason);
});

test('maxCount absent, null ou aberrant : illimite, jamais bloquant', function () {
  [undefined, null, '', 'douze', NaN, -1].forEach(function (v) {
    var s = sandbox.acSettings({ autoContinueEnabled: true, autoContinueMaxCount: v });
    assert.strictEqual(s.maxCount, sandbox.AC_UNLIMITED, 'valeur ' + JSON.stringify(v));
    assert.strictEqual(sandbox.acDecide(scan(), s).go, true, 'valeur ' + JSON.stringify(v));
  });
});

test('AC_UNLIMITED vaut bien 0 : la convention est celle du popup', function () {
  assert.strictEqual(sandbox.AC_UNLIMITED, 0);
});

// ---- normalisation des reglages ---------------------------------------------------------------

test('storage vide : desactive, compteur a zero, maximum illimite', function () {
  var s = sandbox.acSettings({});
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.paused, false);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.maxCount, 0);
});

test('valeurs aberrantes ramenees au comportement prudent', function () {
  var s = sandbox.acSettings({
    autoContinueEnabled: 'oui',      // pas un booleen : ne compte pas comme actif
    autoContinueCount: -3,
    autoContinueMaxCount: 'douze'
  });
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.maxCount, 0);
});

test('maximum borne a AC_MAX_LIMIT et tronque a l entier', function () {
  assert.strictEqual(sandbox.acSettings({ autoContinueMaxCount: 5000 }).maxCount,
    sandbox.AC_MAX_LIMIT);
  assert.strictEqual(sandbox.acSettings({ autoContinueMaxCount: 12.9 }).maxCount, 12);
  assert.strictEqual(sandbox.AC_MAX_LIMIT, 999);
});

test('les quatre cles de storage sont bien celles annoncees', function () {
  assert.strictEqual(sandbox.AC_KEYS.join(','),
    'autoContinueEnabled,autoContinueMaxCount,autoContinueCount,autoContinuePaused');
});

test('scan absent : aucune exception, on ne continue pas', function () {
  assert.strictEqual(sandbox.acDecide(null, on()).go, false);
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
