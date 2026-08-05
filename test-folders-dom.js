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
//
// Le conteneur de controles est reproduit avec ses classes reelles : cache au repos
// (opacity-0 pointer-events-none), revele par les variants group-hover:/group-focus-within:
// portes par le parent .group. C'est la que le bouton « − » doit se poser — s'y installer est
// tout ce qui lui donne la meme apparition au survol que le « … » natif.
function itemHtml(u, label) {
  return '<div class="relative df-drag-shiftable">' +
           '<div class="group relative rounded-[var(--df-radius-pill)]">' +
             '<a href="/chat/' + u + '" class="w-full">' + label + '</a>' +
             '<div class="absolute right-[6px] top-1/2 -translate-y-1/2 flex items-center gap-0.5 ' +
                  'opacity-0 pointer-events-none group-hover:opacity-100 ' +
                  'group-hover:pointer-events-auto group-focus-within:opacity-100 ' +
                  'group-focus-within:pointer-events-auto">' +
               '<button aria-label="Plus d\'options pour ' + label + '"></button>' +
               '<div class="cds-root text-primary contents"></div>' +
             '</div>' +
           '</div>' +
         '</div>';
}

function sidebarHtml(uuids, withScroll) {
  var items = uuids.map(function (u, i) {
    return itemHtml(u, 'Conversation ' + i);
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
        UUIDS.map(function (u, i) { return itemHtml(u, 'C' + i); }).join('') + '</div></div>';
      return w.settle(200);   // debounce du MutationObserver
    })
    .then(function () {
      assert.strictEqual(layout(w.doc), '[T]   0 1 2', 'rangement non reapplique apres re-rendu');
      // Le re-rendu a detruit le bouton avec l'ancien item : il doit revenir avec le rangement.
      assert.strictEqual(w.doc.querySelectorAll('.cf-unfile').length, 1, 'bouton « − » non remis');
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
      section.insertAdjacentHTML('beforeend', itemHtml(vieux, 'Vieille conversation'));
      w.doc.__nouveau = section.lastElementChild;
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

// ---- bouton « − » --------------------------------------------------------------------------------

// L'exigence n'est pas seulement « un bouton existe » : c'est qu'il vive dans le conteneur de
// controles NATIF, seul endroit ou il herite du survol sans qu'on gere une opacite.
test('bouton « − » : uniquement sur les items rangés, dans le conteneur de contrôles natif', function () {
  var w = boot();
  return withFolder(w)
    .then(function () { return w.set({ folderAssignments: assign({ 1: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      var btns = w.doc.querySelectorAll('.cf-unfile');
      assert.strictEqual(btns.length, 1, 'un bouton, et seulement sur la conversation rangée');
      assert.ok(btns[0].closest('.cf-body'), 'le bouton n\'est pas sur l\'item rangé');

      var bar = btns[0].parentElement;
      assert.ok(bar.querySelector('button[aria-label^="Plus d\'options"]'),
        'le bouton doit partager le conteneur du « … » natif, sinon il ne suit pas le survol');
      assert.ok(bar.className.indexOf('group-hover:opacity-100') !== -1,
        'conteneur sans variant group-hover: : le bouton serait visible en permanence');
      assert.strictEqual(btns[0].getAttribute('aria-label'),
        'Retirer « Conversation 1 » du dossier');
    });
});

// Le point de la demande : une seule logique de retrait, deux entrees. On rejoue les deux
// scenarios de bout en bout et on compare l'etat complet — DOM et storage.
test('bouton « − » : retrait identique au dépôt sur la bande « Retirer »', function () {
  function etat(w) {
    return w.win.chrome.storage.local.get().then(function (store) {
      return layout(w.doc) + ' | ' + JSON.stringify(store.folderAssignments || {});
    });
  }

  function range(w) {
    return withFolder(w)
      .then(function () { return w.set({ folderAssignments: assign({ 1: 'f1' }) }); })
      .then(w.settle)
      .then(function () {
        assert.strictEqual(layout(w.doc), '[Travail]   1 0 2');
        return w;
      });
  }

  var parBande = boot();
  var parBouton = boot();
  var natif = [];

  return range(parBande)
    .then(function (w) {
      var data = fakeDataTransfer();
      var out = w.doc.querySelector('.cf-out');
      fireDrag(w, w.doc.querySelector('.cf-body a'), 'dragstart', data);
      fireDrag(w, out, 'dragover', data);
      fireDrag(w, out, 'drop', data);
      return w.settle();
    })
    .then(function () { return range(parBouton); })
    .then(function (w) {
      // Un gestionnaire du site sur un ancetre, en bouillonnement : c'est ce que le
      // stopPropagation() du bouton doit arreter. (En capture, rien ne peut l'arreter : la
      // capture descend depuis window, et le site n'a de toute facon pas de clic de ligne en
      // capture — sinon le « … » natif d'a cote naviguerait lui aussi.)
      w.doc.querySelector('.dframe-nav-scroll')
        .addEventListener('click', function () { natif.push('bubble:click'); }, false);

      var ev = new w.win.Event('click', { bubbles: true, cancelable: true });
      w.doc.querySelector('.cf-body .cf-unfile').dispatchEvent(ev);
      assert.ok(ev.defaultPrevented, 'le clic doit être neutralisé : sinon il remonte à la ligne');
      return w.settle();
    })
    .then(function () {
      assert.strictEqual(natif.join(','), '', 'le clic est remonté jusqu\'à un ancêtre du site');
      return Promise.all([etat(parBande), etat(parBouton)]);
    })
    .then(function (deux) {
      assert.strictEqual(deux[1], deux[0], 'le bouton ne produit pas le même résultat que la bande');
      assert.strictEqual(deux[1], '[Travail] 0 1 2 | {}', 'conversation non sortie du dossier');
      assert.strictEqual(parBouton.doc.querySelectorAll('.cf-unfile').length, 0,
        'le bouton est reparti dans « Récents » avec l\'item');
    });
});

// LE BUG remonte en usage reel : le PREMIER clic sur « − » ne faisait rien, le suivant — et tous
// les suivants — marchait, sans rechargement de la page. Cause : le gestionnaire etait pose sur le
// bouton, donc en phase de BOUILLONNEMENT. Une bibliotheque de glissement arme couramment un
// « avaleur de clic » a usage unique en fin de geste, pour que le clic qui suit un glissement ne
// declenche rien ; pose en CAPTURE sur un ancetre, il stoppe la propagation AVANT que l'evenement
// n'atteigne le bouton. Une fois l'avaleur consomme, tout redevient normal — d'ou « le premier clic
// seulement ». Exactement le defaut n° 2 du tableau du depot, au meme endroit du fichier.
test('bouton « − » : un avaleur de clic du site ne peut plus manger le retrait', function () {
  var w = boot();
  var avale = 0;

  function clic(sel) {
    w.doc.querySelector(sel).dispatchEvent(
      new w.win.Event('click', { bubbles: true, cancelable: true }));
    return w.settle();
  }

  return withFolder(w)
    .then(function () { return w.set({ folderAssignments: assign({ 1: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      assert.strictEqual(layout(w.doc), '[Travail]   1 0 2');
      w.doc.addEventListener('click', function (e) { avale++; e.stopPropagation(); }, true);

      // Témoin : le repli d'un dossier, lui, est bien géré sur l'élément (bouillonnement). Il
      // prouve que l'avaleur est réellement en position de manger un clic — sans ce témoin, le
      // test passerait aussi avec un avaleur inoffensif, et ne garantirait rien.
      return clic('.cf-head');
    })
    .then(function () {
      assert.strictEqual(avale, 1, 'l\'avaleur n\'a pas joué : le test ne prouverait rien');
      assert.strictEqual(w.doc.querySelector('[data-cf-folder]').className, '',
        'l\'avaleur laisse passer les clics : il ne prouve rien');

      return clic('.cf-body .cf-unfile');
    })
    .then(function () {
      assert.strictEqual(avale, 1, 'le clic est descendu jusqu\'à l\'avaleur au lieu d\'être pris');
      assert.strictEqual(layout(w.doc), '[Travail] 0 1 2',
        'le clic a été mangé avant d\'atteindre le retrait');
    });
});

// ---- menu contextuel et modale de renommage ------------------------------------------------------
//
// Les deux composants qui copient un composant natif de claude.ai (menu « … » d'une conversation,
// modale de renommage d'une conversation). Ce qu'ils DECIDENT est teste dans test-folders.js ; ce
// qui suit verifie ce qu'ils AFFICHENT et ce qu'ils ecrivent.

function ouvreMenu(w) {
  var ev = new w.win.Event('contextmenu', { bubbles: true, cancelable: true });
  ev.clientX = 40;
  ev.clientY = 60;
  w.doc.querySelector('.cf-head').dispatchEvent(ev);
  return w.doc.querySelector('.cf-menu');
}

function clique(w, el) {
  el.dispatchEvent(new w.win.Event('click', { bubbles: true, cancelable: true }));
}

function touche(w, el, key) {
  var ev = new w.win.KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

// Aucune des trois commandes ne doit plus passer par un composant du navigateur : les compteurs
// restent a zero pour toute la duree du test.
function espionneNatif(w) {
  var natif = { prompt: 0, confirm: 0 };
  w.win.prompt = function () { natif.prompt++; return 'par le prompt natif'; };
  w.win.confirm = function () { natif.confirm++; return true; };
  return natif;
}

function modaleOuverte(w, natif) {
  var modal = w.doc.querySelector('.cf-modal');
  assert.ok(modal, 'aucune modale ouverte');
  assert.strictEqual(natif.prompt + natif.confirm, 0,
    'un composant du navigateur a été appelé : c\'est ce qu\'on remplace');

  return {
    modal: modal,
    input: modal.querySelector('.cf-modal-input'),
    message: modal.querySelector('.cf-modal-message'),
    annuler: modal.querySelectorAll('.cf-modal-btn')[0],
    action: modal.querySelectorAll('.cf-modal-btn')[1]
  };
}

// Ouvre le menu puis la modale de renommage.
function ouvreRenommage(w) {
  var natif = espionneNatif(w);
  clique(w, ouvreMenu(w).querySelectorAll('.cf-item')[0]);

  var d = modaleOuverte(w, natif);
  assert.strictEqual(w.doc.querySelector('.cf-menu'), null, 'le menu doit se fermer derrière');
  d.enregistrer = d.action;
  return d;
}

function ouvreCreation(w) {
  var natif = espionneNatif(w);
  clique(w, w.doc.querySelector('.cf-btn'));
  return modaleOuverte(w, natif);
}

function ouvreSuppression(w) {
  var natif = espionneNatif(w);
  clique(w, ouvreMenu(w).querySelectorAll('.cf-item')[1]);
  return modaleOuverte(w, natif);
}

test('menu contextuel : conteneur et items à la structure du menu natif', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var menu = ouvreMenu(w);
    assert.ok(menu, 'menu non ouvert');
    assert.strictEqual(menu.getAttribute('role'), 'menu');

    var items = menu.querySelectorAll('.cf-item');
    assert.strictEqual(items.length, 2, 'renommer + supprimer');
    items.forEach(function (it) {
      assert.strictEqual(it.getAttribute('role'), 'menuitem');
      // Icone au trait de l'extension, pas la police de ligatures du site.
      assert.ok(it.querySelector('svg path'), 'item sans icône SVG');
      assert.ok(it.querySelector('.cf-item-label').textContent, 'item sans libellé');
    });
    assert.strictEqual(menu.querySelectorAll('.cf-swatch').length, 8, 'palette absente du menu');
  });
});

// L'invariant qui rend acceptable de DEDUIRE les noms de tokens du site depuis leurs classes
// Tailwind : un nom mal deduit ne doit jamais laisser une couleur indefinie. Si ce test casse,
// c'est qu'un var(--cds-…) a ete ajoute sans repli — et ce composant-la deviendra invisible le
// jour ou le token n'existe pas.
test('aucun token du site n\'est utilisé sans valeur de repli', function () {
  var w = boot();
  return w.settle().then(function () {
    var css = w.doc.getElementById('__claude_folders_style').textContent;
    var refs = css.match(/var\(--cds-[a-z0-9-]+[,)]/g) || [];

    assert.ok(refs.length >= 8, 'les tokens du site ne sont plus lus du tout (' + refs.length + ')');
    refs.forEach(function (r) {
      assert.ok(r.slice(-1) === ',', 'sans repli : ' + r);
    });
    assert.strictEqual(css.indexOf('#1c1c1e'), -1, 'ancien menu sombre en dur toujours présent');
  });
});

test('renommage : modale pré-remplie, focalisée, texte sélectionné', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var d = ouvreRenommage(w);

    assert.strictEqual(d.input.value, 'Travail', 'le nom actuel doit être pré-rempli');
    assert.strictEqual(w.doc.activeElement, d.input, 'le champ n\'a pas le focus');
    assert.strictEqual(d.input.selectionStart, 0);
    assert.strictEqual(d.input.selectionEnd, 'Travail'.length, 'texte non présélectionné');
    assert.strictEqual(d.input.maxLength, w.win.FOLDER_NAME_MAX, 'longueur non bornée');
    assert.strictEqual(d.modal.querySelector('[role="dialog"]').className, 'cf-modal-box');
    assert.strictEqual(d.annuler.textContent, 'Annuler');
    assert.strictEqual(d.enregistrer.textContent, 'Enregistrer');
  });
});

test('Entrée enregistre et referme, comme le bouton « Enregistrer »', function () {
  function renomme(w, parLaTouche) {
    return withFolder(w).then(function () {
      var d = ouvreRenommage(w);
      d.input.value = '  Perso  ';
      d.input.dispatchEvent(new w.win.Event('input', { bubbles: true }));

      if (parLaTouche) {
        assert.ok(touche(w, d.input, 'Enter').defaultPrevented, 'Entrée non consommée');
      } else {
        clique(w, d.enregistrer);
      }
      assert.strictEqual(w.doc.querySelector('.cf-modal'), null, 'modale restée ouverte');
      return w.settle();
    }).then(function () {
      // Le nom est nettoye a l'ecriture, comme par le prompt qu'on remplace.
      return w.doc.querySelector('.cf-name').textContent;
    });
  }

  return Promise.all([renomme(boot(), true), renomme(boot(), false)]).then(function (deux) {
    assert.strictEqual(deux[0], 'Perso', 'Entrée n\'a pas enregistré');
    assert.strictEqual(deux[1], deux[0], 'les deux entrées ne donnent pas le même résultat');
  });
});

test('Échap et « Annuler » ferment sans rien écrire', function () {
  function abandonne(w, parLaTouche) {
    return withFolder(w).then(function () {
      var d = ouvreRenommage(w);
      d.input.value = 'Jamais enregistré';

      if (parLaTouche) touche(w, d.input, 'Escape');
      else clique(w, d.annuler);

      assert.strictEqual(w.doc.querySelector('.cf-modal'), null, 'modale restée ouverte');
      return w.settle();
    }).then(function () {
      return w.doc.querySelector('.cf-name').textContent;
    });
  }

  return Promise.all([abandonne(boot(), true), abandonne(boot(), false)]).then(function (deux) {
    assert.strictEqual(deux[0], 'Travail', 'Échap a enregistré');
    assert.strictEqual(deux[1], 'Travail', '« Annuler » a enregistré');
  });
});

// Fermer sur un nom vide se lirait comme une sauvegarde reussie, alors que folderRename()
// ignorerait la saisie : la modale reste donc ouverte, et le bouton le dit.
test('nom vidé : Entrée ne ferme rien et « Enregistrer » est désactivé', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var d = ouvreRenommage(w);
    assert.strictEqual(d.enregistrer.disabled, false, 'le nom actuel est pourtant valide');

    d.input.value = '   ';
    d.input.dispatchEvent(new w.win.Event('input', { bubbles: true }));
    assert.strictEqual(d.enregistrer.disabled, true, 'bouton actif sur un nom vide');

    touche(w, d.input, 'Enter');
    assert.ok(w.doc.querySelector('.cf-modal'), 'la modale s\'est fermée sur un nom vide');

    d.input.value = 'Perso';
    d.input.dispatchEvent(new w.win.Event('input', { bubbles: true }));
    assert.strictEqual(d.enregistrer.disabled, false, 'bouton resté désactivé');
  });
});

// claude.ai ecoute le clavier sur le document pour ses propres raccourcis. Une frappe faite dans
// notre champ n'a rien a y faire — sans quoi taper « / » ou « e » dans un nom de dossier
// declencherait un raccourci du site.
test('les frappes de la modale ne parviennent pas au site', function () {
  var w = boot();
  var recu = [];

  return withFolder(w).then(function () {
    w.doc.addEventListener('keydown', function (e) { recu.push(e.key); }, false);

    var d = ouvreRenommage(w);
    touche(w, d.input, 'e');
    touche(w, d.input, '/');
    touche(w, d.input, 'Escape');

    assert.strictEqual(recu.join(','), '', 'le site a reçu les frappes : ' + recu.join(','));
  });
});

// ---- création : la même modale de saisie ---------------------------------------------------------

test('« + » : modale de création, champ vide, bouton « Créer »', function () {
  var w = boot();
  return w.settle().then(function () {
    var d = ouvreCreation(w);

    assert.strictEqual(d.input.value, '', 'aucun nom ne doit être pré-rempli');
    assert.strictEqual(w.doc.activeElement, d.input, 'le champ n\'a pas le focus');
    assert.strictEqual(d.modal.querySelector('.cf-modal-title').textContent, 'Nouveau dossier');
    assert.strictEqual(d.annuler.textContent, 'Annuler');
    assert.strictEqual(d.action.textContent, 'Créer');
    // Le meme garde-fou qu'au renommage : rien a creer tant que le champ est vide.
    assert.strictEqual(d.action.disabled, true, 'bouton actif sur un champ vide');

    d.input.value = '  Travail  ';
    d.input.dispatchEvent(new w.win.Event('input', { bubbles: true }));
    assert.strictEqual(d.action.disabled, false);

    assert.ok(touche(w, d.input, 'Enter').defaultPrevented, 'Entrée non consommée');
    assert.strictEqual(w.doc.querySelector('.cf-modal'), null, 'modale restée ouverte');
    return w.settle();
  }).then(function () {
    assert.strictEqual(w.doc.querySelector('.cf-name').textContent, 'Travail',
      'dossier non créé, ou nom non nettoyé');
  });
});

test('création abandonnée (Échap, « Annuler », fond) : aucun dossier', function () {
  var w = boot();

  function abandonne(ferme) {
    var d = ouvreCreation(w);
    d.input.value = 'Jamais créé';
    d.input.dispatchEvent(new w.win.Event('input', { bubbles: true }));
    ferme(w, d);
    assert.strictEqual(w.doc.querySelector('.cf-modal'), null, 'modale restée ouverte');
  }

  return w.settle().then(function () {
    abandonne(function (w, d) { touche(w, d.input, 'Escape'); });
    abandonne(function (w, d) { clique(w, d.annuler); });
    abandonne(function (w, d) {
      d.modal.dispatchEvent(new w.win.Event('mousedown', { bubbles: true }));
    });
    return w.settle();
  }).then(function () {
    assert.strictEqual(w.doc.querySelectorAll('[data-cf-folder]').length, 0, 'un dossier a été créé');
  });
});

// Le clic dans la BOITE ne doit pas fermer : c'est le piege classique du « clic sur le fond »
// posé sans distinguer la cible de l'élément écouté.
test('clic dans la boîte : la modale reste ouverte', function () {
  var w = boot();
  return w.settle().then(function () {
    var d = ouvreCreation(w);
    d.input.dispatchEvent(new w.win.Event('mousedown', { bubbles: true }));
    assert.ok(w.doc.querySelector('.cf-modal'), 'un clic dans le champ a fermé la modale');
  });
});

// ---- suppression : confirmation stylée -----------------------------------------------------------

test('suppression : confirmation sans champ, bouton d\'alerte, focus sur « Annuler »', function () {
  var w = boot();
  return withFolder(w)
    .then(function () { return w.set({ folderAssignments: assign({ 0: 'f1', 1: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      var d = ouvreSuppression(w);

      assert.strictEqual(d.input, null, 'une confirmation n\'a pas de champ de saisie');
      assert.ok(d.message, 'message absent');
      assert.strictEqual(d.modal.querySelector('.cf-modal-title').textContent,
        'Supprimer le dossier « Travail » ?');
      assert.strictEqual(d.message.textContent, w.win.folderDeleteMessage(2),
        'le message ne vient pas de folders-source.js');

      assert.strictEqual(d.annuler.textContent, 'Annuler');
      assert.strictEqual(d.action.textContent, 'Supprimer');
      assert.ok(d.action.className.indexOf('cf-modal-btn-danger') !== -1,
        'le bouton destructeur doit porter la couleur d\'alerte, pas le primaire foncé');
      assert.strictEqual(d.action.className.indexOf('cf-modal-btn-primary'), -1);

      // Rien a valider : aucun des deux boutons n'est grise, jamais.
      assert.strictEqual(d.annuler.disabled, false);
      assert.strictEqual(d.action.disabled, false);

      // Le focus est sur « Annuler » : Entree referme au lieu de detruire, contrairement a
      // window.confirm dont la touche Entree valide.
      assert.strictEqual(w.doc.activeElement, d.annuler,
        'le focus doit être sur « Annuler », pas sur le bouton destructeur');
    });
});

test('suppression confirmée : dossier supprimé, conversations libérées', function () {
  var w = boot();
  return withFolder(w)
    .then(function () { return w.set({ folderAssignments: assign({ 0: 'f1', 2: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      assert.strictEqual(layout(w.doc), '[Travail]   0   2 1');
      clique(w, ouvreSuppression(w).action);
      assert.strictEqual(w.doc.querySelector('.cf-modal'), null, 'modale restée ouverte');
      return w.settle();
    })
    .then(function () {
      assert.strictEqual(w.doc.querySelectorAll('[data-cf-folder]').length, 0, 'dossier non supprimé');
      assert.strictEqual(layout(w.doc), '0 1 2', 'une conversation a été perdue avec le dossier');
    });
});

test('suppression abandonnée (Échap, « Annuler », fond) : rien n\'est touché', function () {
  var w = boot();

  function abandonne(ferme) {
    var d = ouvreSuppression(w);
    ferme(w, d);
    assert.strictEqual(w.doc.querySelector('.cf-modal'), null, 'modale restée ouverte');
  }

  return withFolder(w)
    .then(function () { return w.set({ folderAssignments: assign({ 1: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      abandonne(function (w, d) { touche(w, d.annuler, 'Escape'); });
      abandonne(function (w, d) { clique(w, d.annuler); });
      abandonne(function (w, d) {
        d.modal.dispatchEvent(new w.win.Event('mousedown', { bubbles: true }));
      });
      return w.settle();
    })
    .then(function () {
      assert.strictEqual(layout(w.doc), '[Travail]   1 0 2', 'le dossier ou son contenu a bougé');
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
