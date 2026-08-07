// Test du controle de couleur d'accent du popup. Aucune dependance, aucun framework, comme
// test-theme.js. Lance avec : node test-popup-accent.js
//
// Pourquoi ce fichier existe alors que le reste de popup.js n'est pas teste : la pastille
// native <input type="color"> a du etre remplacee (elle tue le popup sur Firefox, voir la
// section « Portage Firefox » du README), et le controle qui la remplace porte de la logique —
// normalisation de la saisie, selection de la pastille, non-ecriture au rendu.
//
// popup.js est un script de page, pas un module. On l'evalue dans un contexte vm avec un DOM
// bouchonne minimal : pas besoin de jsdom, renderTheme() ne se sert que de getElementById,
// createElement, appendChild, dataset, style, children, setAttribute et addEventListener.
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// common.js d'abord : popup.js lit ses constantes des le premier niveau.
var SRC = ['common.js', 'popup.js'].map(function (f) {
  return fs.readFileSync(path.join(__dirname, f), 'utf8');
}).join('\n');

function El(tag) {
  this.tagName = tag;
  this.children = [];
  this.style = {};
  this.dataset = {};
  this.attrs = {};
  this.handlers = {};
  this.value = '';
  this.className = '';
  this.textContent = '';
}
El.prototype.appendChild = function (c) { this.children.push(c); return c; };
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
El.prototype.getAttribute = function (k) { return k in this.attrs ? this.attrs[k] : null; };
El.prototype.addEventListener = function (t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); };
El.prototype.fire = function (t) { (this.handlers[t] || []).forEach(function (fn) { fn({ type: t }); }); };

// Un contexte neuf par test : les elements bouchonnes gardent leurs ecouteurs, deux
// renderTheme() dans le meme DOM les cableraient deux fois.
function load() {
  var els = {};
  var writes = [];
  var sandbox = {
    document: {
      getElementById: function (id) {
        if (!els[id]) { els[id] = new El('div'); els[id].id = id; }
        return els[id];
      },
      createElement: function (t) { return new El(t); }
    },
    // Le premier niveau de popup.js lance un storage.get().then(...) : une promesse qui ne se
    // resout jamais court-circuite tout le rendu d'usage, hors sujet ici.
    chrome: { storage: { local: {
      get: function () { return new Promise(function () {}); },
      set: function (o) { writes.push(o); return Promise.resolve(); },
      remove: function (k) { writes.push({ remove: k }); return Promise.resolve(); }
    } } },
    AC_KEYS: [],   // vient d'autocontinue-source.js, non charge ici
    Promise: Promise
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { s: sandbox, el: sandbox.document.getElementById, writes: writes };
}

// Etat de selection des huit pastilles, en une chaine lisible dans le message d'echec.
function pressed(el) {
  return el('accentSwatches').children.map(function (b) {
    return b.getAttribute('aria-pressed');
  }).join(',');
}

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---- accentNormalize ----------------------------------------------------------------------

test('accentNormalize : accepte #rrggbb, le diese optionnel et les majuscules', function () {
  var n = load().s.accentNormalize;
  assert.strictEqual(n('#c6613f'), '#c6613f');
  assert.strictEqual(n('c6613f'), '#c6613f');
  assert.strictEqual(n('#C6613F'), '#c6613f');
  assert.strictEqual(n('  #c6613f  '), '#c6613f');
});

test('accentNormalize : rejette tout ce que accentValid (theme.js) rejetterait', function () {
  var n = load().s.accentNormalize;
  assert.strictEqual(n('#abc'), null);        // forme courte non geree cote theme.js
  assert.strictEqual(n('#zzzzzz'), null);
  assert.strictEqual(n('red'), null);
  assert.strictEqual(n('rgb(1,2,3)'), null);
  assert.strictEqual(n(''), null);
  assert.strictEqual(n(undefined), null);     // cle absente
  assert.strictEqual(n('#000000;} body{display:none'), null);
});

test('toute la palette passe accentValid, et son premier cran est le defaut', function () {
  var s = load().s;
  s.ACCENT_PRESETS.forEach(function (c) {
    assert.ok(/^#[0-9a-f]{6}$/.test(c), c + ' ne serait pas applique par theme.js');
  });
  // « Reinitialiser » doit retomber sur une pastille visiblement selectionnee.
  assert.strictEqual(s.ACCENT_PRESETS[0], s.DEFAULT_ACCENT);
});

// ---- rendu --------------------------------------------------------------------------------

test('rendu sans cle stockee : defaut affiche, rien d\'ecrit', function () {
  var t = load();
  t.s.renderTheme({});
  assert.strictEqual(t.el('accentHex').value, '#c6613f');
  assert.strictEqual(t.el('accentPreview').style.background, '#c6613f');
  assert.strictEqual(t.el('accentSwatches').children.length, 8);
  assert.strictEqual(pressed(t.el), 'true,false,false,false,false,false,false,false');
  // Un rendu qui ecrirait recreerait la cle que « Reinitialiser » vient de supprimer.
  assert.strictEqual(t.writes.length, 0);
});

test('rendu d\'une couleur hors palette : normalisee, aucune pastille selectionnee', function () {
  var t = load();
  t.s.renderTheme({ accentColor: '#ABCDEF' });
  assert.strictEqual(t.el('accentHex').value, '#abcdef');
  assert.strictEqual(pressed(t.el), 'false,false,false,false,false,false,false,false');
  assert.strictEqual(t.writes.length, 0);
});

// ---- interactions -------------------------------------------------------------------------

test('clic sur une pastille : ecrit, deplace la selection, met le champ a jour', function () {
  var t = load();
  t.s.renderTheme({});
  t.el('accentSwatches').children[3].fire('click');
  assert.deepStrictEqual(t.writes, [{ accentColor: '#0f766e' }]);
  assert.strictEqual(t.el('accentHex').value, '#0f766e');
  assert.strictEqual(pressed(t.el), 'false,false,false,true,false,false,false,false');
});

test('saisie hexadecimale : ecrit des que complete, sans reecrire le champ', function () {
  var t = load();
  t.s.renderTheme({});
  t.el('accentHex').value = 'aabbcc';
  t.el('accentHex').fire('input');
  assert.deepStrictEqual(t.writes, [{ accentColor: '#aabbcc' }]);
  assert.strictEqual(t.el('accentPreview').style.background, '#aabbcc');
  // Reecrire le champ pendant la frappe deplacerait le curseur et corrigerait la casse tapee.
  assert.strictEqual(t.el('accentHex').value, 'aabbcc');
});

test('saisie incomplete : signalee, pas ecrite, et rattrapee a la sortie du champ', function () {
  var t = load();
  t.s.renderTheme({});
  t.el('accentHex').value = 'aabbcc';
  t.el('accentHex').fire('input');
  t.el('accentHex').value = 'aabb';
  t.el('accentHex').fire('input');
  assert.strictEqual(t.writes.length, 1);
  assert.strictEqual(t.el('accentHex').getAttribute('aria-invalid'), 'true');

  t.el('accentHex').fire('blur');
  assert.strictEqual(t.el('accentHex').value, '#aabbcc');
  assert.strictEqual(t.el('accentHex').getAttribute('aria-invalid'), 'false');
  assert.strictEqual(t.writes.length, 1);
});

test('reinitialisation : defaut affiche et les quatre cles retirees en un seul remove', function () {
  var t = load();
  t.s.renderTheme({ accentColor: '#aabbcc' });
  t.el('themeReset').fire('click');
  assert.strictEqual(t.el('accentHex').value, '#c6613f');
  assert.strictEqual(pressed(t.el), 'true,false,false,false,false,false,false,false');
  assert.deepStrictEqual(t.writes, [{ remove: ['accentColor', 'fontWeightPreset', 'radiusPreset', 'fontFamily'] }]);
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
