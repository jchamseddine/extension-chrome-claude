// Test unitaire de la detection de reset de fenetre (background.js). Aucune dependance,
// aucun framework, comme test-usage-source.js. Lance avec : node test-background.js
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

function read(file) { return fs.readFileSync(path.join(__dirname, file), 'utf8'); }
function noop() {}

// background.js est charge par le service worker, pas par require() : pas de module.exports a
// y ajouter. On l'evalue dans son propre contexte, en bouchonnant ce que le worker fournit —
// importScripts(), qui charge les dependances dans le MEME contexte (evaluate() a besoin de
// utilOf(), resetText() et USAGE_LABELS de common.js), et chrome, dont seul le cablage de fin
// de fichier se sert. OffscreenCanvas n'est touche que dans le corps de canvasFor(), jamais au
// chargement : inutile de le bouchonner.
var sandbox = {
  console: console,
  importScripts: function () {
    for (var i = 0; i < arguments.length; i++) {
      vm.runInContext(read(arguments[i]), sandbox);
    }
  },
  chrome: {
    storage: { onChanged: { addListener: noop } },
    alarms: { onAlarm: { addListener: noop }, get: function () { return { then: noop }; } },
    runtime: { onStartup: { addListener: noop }, onInstalled: { addListener: noop } }
  }
};
vm.createContext(sandbox);
vm.runInContext(read('background.js'), sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// Bornes de reset arbitraires, en secondes Unix comme ce que parseUsage() ecrit en storage.
var BORNE_A = 1785000000;
var BORNE_B = 1785018000;
var FRAIS = 60 * 1000;   // age du sondage precedent dans le cas nominal : une minute

function win(pct, resetsAt) { return { utilization: pct / 100, resets_at: resetsAt }; }

// ---- isReset() : la conjonction des deux signaux -------------------------------------------

test('nouvelle borne + chute franche : c est un reset', function () {
  assert.strictEqual(sandbox.isReset(win(76, BORNE_A), win(2, BORNE_B), FRAIS), true);
});

test('nouvelle borne sans chute : pas un reset', function () {
  assert.strictEqual(sandbox.isReset(win(76, BORNE_A), win(74, BORNE_B), FRAIS), false);
});

test('chute sans nouvelle borne : pas un reset', function () {
  assert.strictEqual(sandbox.isReset(win(76, BORNE_A), win(2, BORNE_A), FRAIS), false);
});

test('chute pas assez franche (40 -> 25) : pas un reset', function () {
  assert.strictEqual(sandbox.isReset(win(40, BORNE_A), win(25, BORNE_B), FRAIS), false);
});

test('utilisation precedente sous le seuil notable (18 -> 0) : pas un reset', function () {
  assert.strictEqual(sandbox.isReset(win(18, BORNE_A), win(0, BORNE_B), FRAIS), false);
});

test('sondage precedent trop vieux : pas un reset', function () {
  var sixHeures = 6 * 60 * 60 * 1000;
  assert.strictEqual(sandbox.isReset(win(76, BORNE_A), win(2, BORNE_B), sixHeures), false);
});

test('aucun sondage precedent : pas un reset', function () {
  assert.strictEqual(sandbox.isReset(undefined, win(2, BORNE_B), -1), false);
});

test('utilisation non numerique : pas un reset', function () {
  var casse = { utilization: null, resets_at: BORNE_A };
  assert.strictEqual(sandbox.isReset(casse, win(2, BORNE_B), FRAIS), false);
  assert.strictEqual(sandbox.isReset(win(76, BORNE_A), { resets_at: BORNE_B }, FRAIS), false);
});

test('borne absente d un cote : pas un reset', function () {
  assert.strictEqual(sandbox.isReset({ utilization: 0.76 }, win(2, BORNE_B), FRAIS), false);
});

// ---- evaluate() : messages produits et anti-spam --------------------------------------------

function envelope(w5, w7, ageMs) {
  return { data: { windows: { '5h': w5, '7d': w7 } }, updatedAt: Date.now() - ageMs };
}

function fresh() { return { windows: {} }; }

test('reset des deux fenetres : un message par fenetre', function () {
  var prev = envelope(win(76, BORNE_A), win(88, BORNE_A), FRAIS);
  var data = { windows: { '5h': win(1, BORNE_B), '7d': win(0, BORNE_B) } };

  var msgs = sandbox.evaluate(data, fresh(), prev);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].title, 'Session — 5 h : reset effectué');
  assert.ok(msgs[0].message.indexOf('limite de session') !== -1, msgs[0].message);
  assert.strictEqual(msgs[1].title, 'Semaine — 7 j : reset effectué');
  assert.ok(msgs[1].message.indexOf('limite hebdomadaire') !== -1, msgs[1].message);
});

test('meme reset rejoue : notifie une seule fois', function () {
  var prev = envelope(win(76, BORNE_A), win(43, BORNE_A), FRAIS);
  var data = { windows: { '5h': win(1, BORNE_B), '7d': win(43, BORNE_A) } };
  var state = fresh();

  assert.strictEqual(sandbox.evaluate(data, state, prev).length, 1);
  assert.strictEqual(state.windows['5h'].notifiedReset, BORNE_B);
  assert.strictEqual(sandbox.evaluate(data, state, prev).length, 0);
});

test('nouvelle borne sans chute : evaluate ne produit aucun message', function () {
  var prev = envelope(win(30, BORNE_A), win(43, BORNE_A), FRAIS);
  var data = { windows: { '5h': win(31, BORNE_B), '7d': win(43, BORNE_A) } };

  assert.strictEqual(sandbox.evaluate(data, fresh(), prev).length, 0);
});

test('chute sans nouvelle borne : evaluate ne produit aucun message', function () {
  var prev = envelope(win(76, BORNE_A), win(43, BORNE_A), FRAIS);
  var data = { windows: { '5h': win(2, BORNE_A), '7d': win(43, BORNE_A) } };
  var state = fresh();

  assert.strictEqual(sandbox.evaluate(data, state, prev).length, 0);
  // La descente reabaisse le seuil memorise, comme avant ce changement.
  assert.strictEqual(state.windows['5h'].threshold, 0);
  assert.strictEqual(state.windows['5h'].notifiedReset, undefined);
});

// ---- non-regression des seuils --------------------------------------------------------------

test('sans sondage precedent, les seuils fonctionnent toujours', function () {
  var data = { windows: { '5h': win(92, BORNE_A), '7d': win(43, BORNE_A) } };
  var state = fresh();

  var msgs = sandbox.evaluate(data, state, undefined);
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].title, 'Session — 5 h : 90 % atteint');
  assert.strictEqual(state.windows['5h'].threshold, 90);
});

test('un reset ne masque pas le franchissement de seuil de l autre fenetre', function () {
  var prev = envelope(win(76, BORNE_A), win(70, BORNE_A), FRAIS);
  var data = { windows: { '5h': win(1, BORNE_B), '7d': win(76, BORNE_A) } };

  var msgs = sandbox.evaluate(data, fresh(), prev);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].title, 'Session — 5 h : reset effectué');
  assert.strictEqual(msgs[1].title, 'Semaine — 7 j : 75 % atteint');
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
