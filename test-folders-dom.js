// Test de folders.js — la moitie qui manipule la vraie sidebar. Lance avec :
//   npm install jsdom      (une seule fois, hors depot : voir plus bas)
//   node test-folders-dom.js
//
// ⚠️ SEUL test du depot a avoir besoin d'une dependance. Le depot n'a volontairement ni
// package.json ni node_modules — l'extension doit rester chargeable telle quelle en mode
// developpeur. Donc : si jsdom est absent, ce fichier SE SAUTE au lieu d'echouer, et les cinq
// autres suites continuent de tourner sans rien installer.
//
// Ce qu'il apporte quand meme, pour la fonctionnalite la plus fragile du depot : il monte la
// structure DOM reelle de la sidebar (celle du tableau des selecteurs du README) et verifie les
// deux scenarios qui, sans lui, ne se voient qu'a l'oeil dans le navigateur — le re-rendu de la
// SPA et l'arrivee de conversations plus anciennes au scroll. Il ne remplace pas une
// verification a la main sur claude.ai : il ne prouve que la logique de placement, pas que les
// selecteurs correspondent encore au vrai site.
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

var UUIDS = [
  '0f2a1b3c-4d5e-6f70-8192-a3b4c5d6e7f8',
  '11112222-3333-4444-5555-666677778888',
  '99998888-7777-6666-5555-444433332222'
];

// Structure CONFIRMEE par inspection reelle, reproduite a l'identique : c'est tout l'interet du
// test. Si claude.ai la change, c'est ici ET dans folders.js qu'il faut repercuter.
function sidebarHtml(uuids, withScroll) {
  var items = uuids.map(function (u, i) {
    return '<div class="relative df-drag-shiftable">' +
             '<div class="group relative rounded-[var(--df-radius-pill)]">' +
               '<a href="/chat/' + u + '">Conversation ' + i + '</a>' +
             '</div>' +
           '</div>';
  }).join('');

  var sections = '<div class="dframe-recents-by-mode contents">' +
                   '<div class="group/section flex flex-col gap-px">' + items + '</div>' +
                 '</div>';

  return '<aside class="dframe-sidebar">' +
           '<div id="frame-peek-popover" class="dframe-sidebar-body">' +
             '<div class="flex flex-col flex-1 min-h-0">' +
               (withScroll === false ? sections : '<div class="dframe-nav-scroll">' + sections + '</div>') +
             '</div>' +
           '</div>' +
         '</aside>';
}

// chrome bouchonne avec un vrai storage : set() previent les listeners, donc le test emprunte
// exactement le chemin de production (ecrire -> onChanged -> relire -> redessiner).
function boot(withScroll) {
  var dom = new JSDOM('<!doctype html><html><body>' + sidebarHtml(UUIDS, withScroll) + '</body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  var win = dom.window;

  var store = {};
  var listeners = [];
  var warns = [];

  win.chrome = {
    runtime: { id: 'test' },
    storage: {
      local: {
        get: function () { return Promise.resolve(JSON.parse(JSON.stringify(store))); },
        set: function (patch) {
          var changes = {};
          Object.keys(patch).forEach(function (k) {
            changes[k] = { oldValue: store[k], newValue: patch[k] };
            store[k] = patch[k];
          });
          listeners.forEach(function (f) { f(changes, 'local'); });
          return Promise.resolve();
        }
      },
      onChanged: { addListener: function (f) { listeners.push(f); } }
    }
  };
  win.console = { warn: function (m) { warns.push(m); }, log: function () {} };

  var ctx = dom.getInternalVMContext();
  ['folders-source.js', 'folders.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx);
  });

  return {
    win: win,
    doc: win.document,
    warns: warns,
    set: function (patch) { return win.chrome.storage.local.set(patch); },
    // Le rangement passe par un MutationObserver debounce : il faut laisser tourner la boucle.
    settle: function (ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }
  };
}

// jsdom n'implemente ni DragEvent ni DataTransfer : on fabrique les deux. Le faux dataTransfer
// porte un clearData() REEL, parce que c'est justement le comportement du site qu'il faut
// pouvoir simuler — c'est l'une des deux causes du bug d'epinglage.
function fakeDataTransfer() {
  var store = {};
  return {
    types: [],
    dropEffect: '',
    setData: function (k, v) {
      store[k] = String(v);
      if (this.types.indexOf(k) === -1) this.types.push(k);
    },
    getData: function (k) { return store[k] || ''; },
    clearData: function () { store = {}; this.types = []; }
  };
}

function fireDrag(w, el, type, data) {
  var ev = new w.win.Event(type, { bubbles: true, cancelable: true });
  ev.dataTransfer = data;
  el.dispatchEvent(ev);
  return ev;
}

// Le gestionnaire de depot du SITE, tel qu'il serait pose : sur un ancetre de nos blocs, et
// dans les DEUX phases. La capture est le cas qui piegeait la version precedente — elle
// s'execute avant tout gestionnaire pose plus bas, donc un stopPropagation() en bouillonnement
// arrivait trop tard et le site epinglait quand meme.
function spyNativeDrop(w) {
  var calls = [];
  var scroll = w.doc.querySelector('.dframe-nav-scroll');

  ['dragover', 'drop'].forEach(function (type) {
    scroll.addEventListener(type, function (e) { calls.push('capture:' + e.type); }, true);
    scroll.addEventListener(type, function (e) { calls.push('bubble:' + e.type); }, false);
  });
  return calls;
}

// Etat de la sidebar sous forme lisible : "[Nom]" pour un dossier, l'index de la conversation
// sinon, indente de deux espaces quand elle est rangee dedans. Un diff d'assertion se lit alors
// d'un coup d'oeil.
function layout(doc) {
  var out = [];
  doc.querySelectorAll('.df-drag-shiftable, [data-cf-folder]').forEach(function (el) {
    if (el.hasAttribute('data-cf-folder')) {
      out.push('[' + el.querySelector('.cf-name').textContent + ']');
      return;
    }
    var i = UUIDS.indexOf(el.querySelector('a').getAttribute('href').slice('/chat/'.length));
    out.push((el.closest('[data-cf-folder]') ? '  ' : '') + i);
  });
  return out.join(' ');
}

function assign(pairs) {
  var m = {};
  Object.keys(pairs).forEach(function (i) { m[UUIDS[i]] = pairs[i]; });
  return m;
}

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---- insertion ---------------------------------------------------------------------------------

test('sidebar nominale : racine en tete des sections, aucun item deplace', function () {
  var w = boot();
  return w.settle().then(function () {
    var root = w.doc.getElementById('__claude_folders_root');
    assert.ok(root, 'racine absente');
    assert.strictEqual(root.parentElement.className, 'dframe-recents-by-mode contents');
    assert.strictEqual(root.parentElement.firstChild, root, 'la racine doit passer AVANT « Récents »');
    assert.strictEqual(layout(w.doc), '0 1 2');
    assert.strictEqual(w.warns.length, 0, w.warns.join(' | '));
  });
});

test('conteneur scrollable absent : rien insere, sidebar native intacte', function () {
  var w = boot(false);
  return w.settle().then(function () {
    assert.strictEqual(w.doc.getElementById('__claude_folders_root'), null);
    assert.strictEqual(w.doc.querySelectorAll('.df-drag-shiftable').length, 3);
  });
});

// ---- rangement ---------------------------------------------------------------------------------

test('assignation : l item entre dans le dossier, les autres ne bougent pas', function () {
  var w = boot();
  return w.settle()
    .then(function () { return w.set({ folders: [{ id: 'f1', name: 'Travail' }] }); })
    .then(function () { return w.set({ folderAssignments: assign({ 1: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      assert.strictEqual(layout(w.doc), '[Travail]   1 0 2');
      assert.strictEqual(w.doc.querySelector('.cf-count').textContent, '1');
      assert.strictEqual(w.doc.querySelectorAll('[data-cf-slot]').length, 1, 'marque-page manquant');
    });
});

// Le marque-page existe pour ca : sans lui, l'item reviendrait a la fin de « Recents » et
// perdrait sa place chronologique jusqu'au prochain re-rendu du site.
test('desassignation : l item revient a SA place, pas a la fin', function () {
  var w = boot();
  return w.settle()
    .then(function () { return w.set({ folders: [{ id: 'f1', name: 'T' }] }); })
    .then(function () { return w.set({ folderAssignments: assign({ 1: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      assert.strictEqual(layout(w.doc), '[T]   1 0 2');
      return w.set({ folderAssignments: {} });
    })
    .then(w.settle)
    .then(function () {
      assert.strictEqual(layout(w.doc), '[T] 0 1 2', 'ordre chronologique perdu');
      assert.strictEqual(w.doc.querySelectorAll('[data-cf-slot]').length, 0, 'marque-page non consomme');
    });
});

test('repli : le corps est masque, les items restent dedans', function () {
  var w = boot();
  return w.settle()
    .then(function () { return w.set({ folders: [{ id: 'f1', name: 'T', collapsed: true }] }); })
    .then(function () { return w.set({ folderAssignments: assign({ 0: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      var body = w.doc.querySelector('.cf-body');
      assert.strictEqual(body.hidden, true);
      assert.strictEqual(body.querySelectorAll('.df-drag-shiftable').length, 1);
    });
});

// ---- suppression : le scenario ou une conversation pourrait DISPARAITRE -------------------------

test('suppression du dossier : conversations liberees, AUCUNE perdue', function () {
  var w = boot();
  return w.settle()
    .then(function () { return w.set({ folders: [{ id: 'f1', name: 'T' }] }); })
    .then(function () { return w.set({ folderAssignments: assign({ 0: 'f1', 2: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      assert.strictEqual(layout(w.doc), '[T]   0   2 1');
      // Ce que le menu contextuel ecrit : folderDelete() rend les deux cles d'un coup.
      return w.set({ folders: [], folderAssignments: {} });
    })
    .then(w.settle)
    .then(function () {
      assert.strictEqual(w.doc.querySelectorAll('.df-drag-shiftable').length, 3,
        'une conversation a ete arrachee du document avec le bloc du dossier');
      assert.strictEqual(layout(w.doc), '0 1 2');
      assert.strictEqual(w.doc.querySelectorAll('[data-cf-folder]').length, 0, 'bloc orphelin restant');
    });
});

// ---- les deux scenarios qui ne se voient qu'en vrai ---------------------------------------------

test('re-rendu de la SPA : le rangement se reapplique tout seul', function () {
  var w = boot();
  return w.settle()
    .then(function () { return w.set({ folders: [{ id: 'f1', name: 'T' }] }); })
    .then(function () { return w.set({ folderAssignments: assign({ 0: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      assert.strictEqual(layout(w.doc), '[T]   0 1 2');
      // Le site rebatit sa liste : nos blocs et les items deplaces partent avec.
      var scroll = w.doc.querySelector('.dframe-nav-scroll');
      scroll.innerHTML = '<div class="dframe-recents-by-mode contents">' +
        '<div class="group/section flex flex-col gap-px">' +
        UUIDS.map(function (u, i) {
          return '<div class="relative df-drag-shiftable"><div><a href="/chat/' + u + '">C' + i + '</a></div></div>';
        }).join('') + '</div></div>';
      return w.settle(200);   // debounce du MutationObserver
    })
    .then(function () {
      assert.strictEqual(layout(w.doc), '[T]   0 1 2', 'rangement non reapplique apres re-rendu');
    });
});

test('conversation arrivee au scroll (pagination) : rangee sans rechargement', function () {
  var w = boot();
  var vieux = '44445555-6666-7777-8888-999900001111';

  return w.settle()
    .then(function () { return w.set({ folders: [{ id: 'f1', name: 'T' }] }); })
    .then(function () {
      var m = assign({ 2: 'f1' });
      m[vieux] = 'f1';   // deja assignee, mais pas encore chargee dans le DOM
      return w.set({ folderAssignments: m });
    })
    .then(w.settle)
    .then(function () {
      var section = w.doc.querySelector('.group\\/section');
      var div = w.doc.createElement('div');
      div.className = 'relative df-drag-shiftable';
      div.innerHTML = '<div><a href="/chat/' + vieux + '">Vieille conversation</a></div>';
      section.appendChild(div);
      w.doc.__nouveau = div;
      return w.settle(200);
    })
    .then(function () {
      assert.ok(w.doc.__nouveau.closest('[data-cf-folder]'),
        'une conversation apparue apres le chargement n a pas ete rangee');
    });
});

// ---- glisser-deposer : le bug d'epinglage ------------------------------------------------------

// Le scenario exact remonte en usage reel : glisser une conversation de « Récents » vers un
// dossier custom l'epinglait dans la section native au lieu de l'assigner.
function dragTo(w, uuidIndex, zone, options) {
  var opts = options || {};
  var link = w.doc.querySelectorAll('a[href^="/chat/"]')[uuidIndex];
  var data = fakeDataTransfer();

  fireDrag(w, link, 'dragstart', data);
  // Le site pose son propre gestionnaire de dragstart et efface le presse-papier de glissement
  // avant d'y ecrire SON type : notre donnee disparait.
  if (opts.siteClearsData) data.clearData();

  var over = fireDrag(w, zone, 'dragover', data);
  var drop = fireDrag(w, zone, 'drop', data);
  return { over: over, drop: drop, data: data };
}

function withFolder(w) {
  return w.settle()
    .then(function () { return w.set({ folders: [{ id: 'f1', name: 'Travail' }] }); })
    .then(w.settle);
}

test('dépôt sur un dossier : assigné, et le gestionnaire du SITE n\'est jamais appelé', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var natif = spyNativeDrop(w);
    var head = w.doc.querySelector('.cf-head');
    var r = dragTo(w, 0, head);

    assert.strictEqual(natif.join(','), '', 'le site a reçu l\'événement : il aurait épinglé');
    assert.ok(r.over.defaultPrevented, 'sans preventDefault sur dragover, le dépôt est refusé');
    assert.ok(r.drop.defaultPrevented, 'drop non neutralisé');
    return w.settle();
  }).then(function () {
    assert.strictEqual(layout(w.doc), '[Travail]   0 1 2', 'conversation non rangée');
  });
});

// Cause n° 1 du bug : le test d'appartenance se faisait sur dataTransfer.types, que le site
// efface. cfDragging fait desormais foi.
test('le site efface dataTransfer : le dépôt fonctionne quand même', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var natif = spyNativeDrop(w);
    var r = dragTo(w, 1, w.doc.querySelector('.cf-head'), { siteClearsData: true });

    assert.strictEqual(r.data.types.length, 0, 'le presse-papier doit bien être vide');
    assert.strictEqual(natif.join(','), '', 'le site a repris la main');
    assert.ok(r.drop.defaultPrevented);
    return w.settle();
  }).then(function () {
    assert.strictEqual(layout(w.doc), '[Travail]   1 0 2');
  });
});

// Cause n° 2 : le site ecoutant en capture sur un ancetre passait AVANT nous. On intercepte
// maintenant sur window, le tout premier point de la trajectoire.
test('dépôt dans le CORPS d\'un dossier vide : même garantie', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var natif = spyNativeDrop(w);
    dragTo(w, 2, w.doc.querySelector('.cf-body'));
    assert.strictEqual(natif.join(','), '');
    return w.settle();
  }).then(function () {
    assert.strictEqual(layout(w.doc), '[Travail]   2 0 1');
  });
});

// L'autre moitie de l'exigence : hors de nos zones, on ne doit rien perturber, pour que la
// reorganisation et l'epinglage natifs continuent de marcher.
test('dépôt HORS de nos zones : le site reçoit tout, intact', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var natif = spyNativeDrop(w);
    var cible = w.doc.querySelectorAll('.df-drag-shiftable')[1];
    var r = dragTo(w, 0, cible);

    assert.strictEqual(natif.join(','),
      'capture:dragover,bubble:dragover,capture:drop,bubble:drop',
      'le drag natif a été bridé alors qu\'il ne devait pas l\'être');
    assert.strictEqual(r.drop.defaultPrevented, false, 'on a neutralisé un dépôt qui n\'est pas le nôtre');
    return w.settle();
  }).then(function () {
    assert.strictEqual(layout(w.doc), '[Travail] 0 1 2', 'une assignation a eu lieu à tort');
  });
});

// ---- sortie d'un dossier ------------------------------------------------------------------------

test('la bande « Retirer » n\'apparaît que pour une conversation rangée', function () {
  var w = boot();
  return withFolder(w)
    .then(function () { return w.set({ folderAssignments: assign({ 0: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      var out = w.doc.querySelector('.cf-out');
      assert.ok(out, 'bande absente');
      assert.strictEqual(out.hidden, true, 'elle ne doit pas être visible au repos');

      // Conversation NON rangée : rien à retirer.
      fireDrag(w, w.doc.querySelectorAll('a[href^="/chat/"]')[1], 'dragstart', fakeDataTransfer());
      assert.strictEqual(out.hidden, true);

      // Conversation rangée : la bande s'ouvre.
      fireDrag(w, w.doc.querySelector('.cf-body a'), 'dragstart', fakeDataTransfer());
      assert.strictEqual(out.hidden, false, 'bande non affichée pour une conversation rangée');
    });
});

test('sortie par la bande : désassignée, sans que le site soit sollicité', function () {
  var w = boot();
  return withFolder(w)
    .then(function () { return w.set({ folderAssignments: assign({ 1: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      assert.strictEqual(layout(w.doc), '[Travail]   1 0 2');

      var natif = spyNativeDrop(w);
      var data = fakeDataTransfer();
      var link = w.doc.querySelector('.cf-body a');
      var out = w.doc.querySelector('.cf-out');

      fireDrag(w, link, 'dragstart', data);
      fireDrag(w, out, 'dragover', data);
      var drop = fireDrag(w, out, 'drop', data);

      assert.strictEqual(natif.join(','), '', 'le site a été sollicité : risque d\'épinglage');
      assert.ok(drop.defaultPrevented);
      return w.settle();
    })
    .then(function () {
      assert.strictEqual(layout(w.doc), '[Travail] 0 1 2', 'conversation non sortie du dossier');
    });
});

// ---- repli pointeur ------------------------------------------------------------------------------

// Si le site glisse au POINTEUR (ce que suggere « df-drag-shiftable ») et non en HTML5, aucun
// dragstart n'est emis et toute la voie precedente reste muette. Ce repli prend alors le relais.
test('glissement au pointeur, sans aucun événement HTML5 : rangé quand même', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var head = w.doc.querySelector('.cf-head');
    w.doc.elementFromPoint = function () { return head; };   // jsdom ne le fournit pas

    var link = w.doc.querySelectorAll('a[href^="/chat/"]')[0];
    link.dispatchEvent(new w.win.Event('pointerdown', { bubbles: true }));
    // jsdom n'a pas PointerEvent : on pose les coordonnées et le bouton à la main.
    var down = new w.win.Event('pointerdown', { bubbles: true });
    down.button = 0; down.clientX = 10; down.clientY = 10;
    link.dispatchEvent(down);

    var move = new w.win.Event('pointermove', { bubbles: true });
    move.clientX = 60; move.clientY = 80;
    w.doc.dispatchEvent(move);

    var up = new w.win.Event('pointerup', { bubbles: true, cancelable: true });
    up.clientX = 60; up.clientY = 80;
    head.dispatchEvent(up);

    return w.settle();
  }).then(function () {
    assert.strictEqual(layout(w.doc), '[Travail]   0 1 2', 'le repli pointeur n\'a rien rangé');
  });
});

test('simple clic sur une conversation : aucun rangement', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var head = w.doc.querySelector('.cf-head');
    w.doc.elementFromPoint = function () { return head; };

    var link = w.doc.querySelectorAll('a[href^="/chat/"]')[0];
    var down = new w.win.Event('pointerdown', { bubbles: true });
    down.button = 0; down.clientX = 10; down.clientY = 10;
    link.dispatchEvent(down);

    var up = new w.win.Event('pointerup', { bubbles: true, cancelable: true });
    up.clientX = 11; up.clientY = 10;   // sous le seuil de glissement
    link.dispatchEvent(up);

    return w.settle();
  }).then(function () {
    assert.strictEqual(layout(w.doc), '[Travail] 0 1 2', 'un clic a été pris pour un glissement');
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
