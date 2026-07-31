// Test de export.js — la moitie qui touche a l'en-tete de claude.ai. Lance avec :
//   npm install jsdom      (une seule fois, hors depot)
//   node test-export-dom.js
//
// Meme regle que test-folders-dom.js : si jsdom est absent, ce fichier SE SAUTE au lieu
// d'echouer. Le depot n'a volontairement ni package.json ni node_modules.
//
// Il monte l'en-tete confirme par inspection (slot, conteneur d'actions, bouton « Partager »)
// et verifie ce qui se regresse le plus facilement : le bouton pose au bon endroit, avec le
// style COPIE du site, absent hors conversation, et repose — en un seul exemplaire — apres un
// re-rendu de la SPA. Il ne prouve pas que les selecteurs correspondent encore au vrai site.
'use strict';

var JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (e) {
  console.log('  -- jsdom absent : test du DOM saute (npm install jsdom pour l\'activer)');
  process.exit(0);
}

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var UUID = '0f2a1b3c-4d5e-6f70-8192-a3b4c5d6e7f8';
var BTN = '#__claude_export_button';
var MENU = '#__claude_export_menu';

// Classe utilitaire plausible du bouton « Partager » : le test verifie qu'elle est reprise
// telle quelle, pas sa valeur — c'est tout l'interet de copier plutot que d'inventer un style.
var SHARE_CLASS = 'inline-flex items-center justify-center rounded-lg h-8 w-8 hover:bg-bg-200';

function headerHtml(withShare) {
  return '<div data-testid="chat-header">' +
           '<div id="dframe-header-actions-slot">' +
             '<div data-testid="wiggle-controls-actions">' +
               '<button data-testid="wiggle-controls-actions-files">Fichiers</button>' +
               (withShare === false ? '' :
                 '<button data-testid="wiggle-controls-actions-share" class="' + SHARE_CLASS + '">' +
                   '<svg width="16" height="16"></svg></button>') +
             '</div>' +
           '</div>' +
         '</div>';
}

function boot(pathname, body) {
  var dom = new JSDOM('<!doctype html><html><body>' + body + '</body></html>', {
    url: 'https://claude.ai' + pathname,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });

  var warns = [];
  dom.window.chrome = { runtime: { id: 'test' } };
  dom.window.console = { warn: function (m) { warns.push(String(m)); }, log: function () {} };

  var ctx = dom.getInternalVMContext();
  ['export-source.js', 'export.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx);
  });

  return {
    win: dom.window,
    doc: dom.window.document,
    warns: warns,
    settle: function (ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }
  };
}

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('bouton posé juste après « Partager », avec SA classe et SA taille d\'icône', function () {
  var w = boot('/chat/' + UUID, headerHtml());
  return w.settle().then(function () {
    var btn = w.doc.querySelector(BTN);
    assert.ok(btn, 'bouton absent');
    assert.strictEqual(
      w.doc.querySelector('[data-testid="wiggle-controls-actions-share"]').nextSibling, btn,
      'le bouton doit suivre immédiatement « Partager »');
    assert.strictEqual(btn.className, SHARE_CLASS, 'style non copié du bouton natif');
    assert.strictEqual(btn.querySelector('svg').getAttribute('width'), '16');
    assert.strictEqual(w.warns.length, 0, w.warns.join(' | '));
  });
});

test('hors conversation : aucun bouton (rien à exporter)', function () {
  var w = boot('/chat/new', headerHtml());
  return w.settle().then(function () {
    assert.strictEqual(w.doc.querySelector(BTN), null);
  });
});

test('sans bouton « Partager » : posé quand même dans le slot, style neutre + warn', function () {
  var w = boot('/chat/' + UUID, headerHtml(false));
  return w.settle().then(function () {
    var btn = w.doc.querySelector(BTN);
    assert.ok(btn, 'bouton absent');
    assert.strictEqual(btn.parentElement.id, 'dframe-header-actions-slot');
    assert.ok(btn.style.cssText.indexOf('inline-flex') !== -1, 'style de repli absent');
    assert.ok(w.warns.length > 0, 'le repli doit être signalé en console');
  });
});

// La regression la plus facile : re-poser le bouton a chaque rendu sans retirer l'ancien.
test('re-rendu de l\'en-tête : le bouton revient, en UN seul exemplaire', function () {
  var w = boot('/chat/' + UUID, headerHtml());
  return w.settle().then(function () {
    assert.ok(w.doc.querySelector(BTN));
    w.doc.querySelector('[data-testid="chat-header"]').innerHTML =
      '<div id="dframe-header-actions-slot"><div data-testid="wiggle-controls-actions">' +
      '<button data-testid="wiggle-controls-actions-share" class="' + SHARE_CLASS + '">' +
      '<svg width="16" height="16"></svg></button></div></div>';
    return w.settle(250);
  }).then(function () {
    assert.ok(w.doc.querySelector(BTN), 'bouton non reposé après re-rendu');
    assert.strictEqual(w.doc.querySelectorAll(BTN).length, 1, 'bouton en double');
  });
});

test('clic : menu à deux entrées, fermé par Échap', function () {
  var w = boot('/chat/' + UUID, headerHtml());
  return w.settle().then(function () {
    w.doc.querySelector(BTN).dispatchEvent(new w.win.MouseEvent('click', { bubbles: true }));

    var menu = w.doc.querySelector(MENU);
    assert.ok(menu, 'menu absent');
    var labels = Array.prototype.map.call(menu.querySelectorAll('button'), function (b) {
      return b.textContent;
    });
    assert.strictEqual(labels.join(' | '), 'Exporter en Markdown | Exporter en PDF');

    w.doc.dispatchEvent(new w.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.strictEqual(w.doc.querySelector(MENU), null, 'menu non fermé');
  });
});

test('point d\'insertion introuvable : rien inséré, en-tête natif intact', function () {
  var w = boot('/chat/' + UUID, '<div data-testid="chat-header"><span>natif</span></div>');
  return w.settle(50).then(function () {
    assert.strictEqual(w.doc.querySelector(BTN), null);
    assert.strictEqual(w.doc.querySelector('[data-testid="chat-header"]').textContent, 'natif');
  });
});

// ---- execution ----------------------------------------------------------------------------
var failed = 0;
tests.reduce(function (chain, t) {
  return chain.then(function () {
    return Promise.resolve().then(t.fn).then(function () {
      console.log('  ok  ' + t.name);
    }, function (e) {
      failed++;
      console.error('FAIL  ' + t.name);
      console.error('      ' + e.message);
    });
  });
}, Promise.resolve()).then(function () {
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passes');
  process.exit(failed ? 1 : 0);
});
