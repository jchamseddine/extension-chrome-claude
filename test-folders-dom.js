// Test for folders.js — the half that manipulates the real sidebar. Run with:
//   npm install jsdom      (once only, outside the repo: see below)
//   node test-folders-dom.js
//
// Warning: the ONLY test in the repo that needs a dependency. The repo deliberately has neither
// package.json nor node_modules — the extension must stay loadable as-is in
// developer mode. So: if jsdom is missing, this file SKIPS ITSELF instead of failing, and the five
// other suites keep running without installing anything.
//
// What it brings anyway, for the most fragile feature of the repo: it builds the
// sidebar's real DOM structure (the one from the README's selector table) and checks the
// two scenarios that, without it, can only be seen by eye in the browser — the SPA
// re-render and the arrival of older conversations on scroll. It does not replace a
// manual check on claude.ai: it only proves the placement logic, not that the
// selectors still match the real site.
'use strict';

var JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (e) {
  console.log('  -- jsdom missing: DOM test skipped (npm install jsdom to enable it)');
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

// Structure CONFIRMED by real inspection, reproduced identically: that is the whole point of the
// test. If claude.ai changes it, it must be reflected here AND in folders.js.
//
// The control container is reproduced with its real classes: hidden at rest
// (opacity-0 pointer-events-none), revealed by the group-hover:/group-focus-within: variants
// carried by the .group parent. That is where the "−" button must be placed — settling there is
// all that gives it the same hover appearance as the native "…".
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

// chrome stubbed with a real storage: set() notifies the listeners, so the test takes
// exactly the production path (write -> onChanged -> reread -> redraw).
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
    // Filing goes through a debounced MutationObserver: the loop must be allowed to run.
    settle: function (ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }
  };
}

// jsdom implements neither DragEvent nor DataTransfer: we build both. The fake dataTransfer
// carries a REAL clearData(), because that is precisely the site behavior we must be able
// to simulate — it is one of the two causes of the pinning bug.
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

// The SITE's drop handler, as it would be installed: on an ancestor of our blocks, and
// in BOTH phases. Capture is the case that trapped the previous version — it
// runs before any handler installed further down, so a stopPropagation() in bubbling
// came too late and the site pinned anyway.
function spyNativeDrop(w) {
  var calls = [];
  var scroll = w.doc.querySelector('.dframe-nav-scroll');

  ['dragover', 'drop'].forEach(function (type) {
    scroll.addEventListener(type, function (e) { calls.push('capture:' + e.type); }, true);
    scroll.addEventListener(type, function (e) { calls.push('bubble:' + e.type); }, false);
  });
  return calls;
}

// Sidebar state in readable form: "[Name]" for a folder, the conversation index
// otherwise, indented by two spaces when it is filed inside. An assertion diff then reads
// at a glance.
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

test('nominal sidebar: root ahead of the sections, no item moved', function () {
  var w = boot();
  return w.settle().then(function () {
    var root = w.doc.getElementById('__claude_folders_root');
    assert.ok(root, 'racine absente');
    assert.strictEqual(root.parentElement.className, 'dframe-recents-by-mode contents');
    assert.strictEqual(root.parentElement.firstChild, root, 'the root must come BEFORE « Récents »');
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

test('assignment: the item enters the folder, the others do not move', function () {
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

// The bookmark exists for that: without it, the item would come back to the end of "Recents" and
// would lose its chronological place until the site's next re-render.
test('unassignment: the item comes back to ITS place, not to the end', function () {
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

test('collapsing: the body is hidden, the items stay inside', function () {
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

// ---- deletion: the scenario where a conversation could DISAPPEAR --------------------------------

test('folder deletion: conversations freed, NONE lost', function () {
  var w = boot();
  return w.settle()
    .then(function () { return w.set({ folders: [{ id: 'f1', name: 'T' }] }); })
    .then(function () { return w.set({ folderAssignments: assign({ 0: 'f1', 2: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      assert.strictEqual(layout(w.doc), '[T]   0   2 1');
      // What the context menu writes: folderDelete() returns both keys at once.
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

// ---- the two scenarios that can only be seen for real -------------------------------------------

test('SPA re-render: the filing reapplies itself', function () {
  var w = boot();
  return w.settle()
    .then(function () { return w.set({ folders: [{ id: 'f1', name: 'T' }] }); })
    .then(function () { return w.set({ folderAssignments: assign({ 0: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      assert.strictEqual(layout(w.doc), '[T]   0 1 2');
      // The site rebuilds its list: our blocks and the moved items go with it.
      var scroll = w.doc.querySelector('.dframe-nav-scroll');
      scroll.innerHTML = '<div class="dframe-recents-by-mode contents">' +
        '<div class="group/section flex flex-col gap-px">' +
        UUIDS.map(function (u, i) { return itemHtml(u, 'C' + i); }).join('') + '</div></div>';
      return w.settle(200);   // MutationObserver debounce
    })
    .then(function () {
      assert.strictEqual(layout(w.doc), '[T]   0 1 2', 'rangement non reapplique apres re-rendu');
      // The re-render destroyed the button along with the old item: it must come back with the filing.
      assert.strictEqual(w.doc.querySelectorAll('.cf-unfile').length, 1, '"−" button not put back');
    });
});

test('conversation arriving on scroll (pagination): filed without a reload', function () {
  var w = boot();
  var vieux = '44445555-6666-7777-8888-999900001111';

  return w.settle()
    .then(function () { return w.set({ folders: [{ id: 'f1', name: 'T' }] }); })
    .then(function () {
      var m = assign({ 2: 'f1' });
      m[vieux] = 'f1';   // already assigned, but not yet loaded into the DOM
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

// ---- drag and drop: the pinning bug ------------------------------------------------------------

// The exact scenario reported in real use: dragging a conversation from « Récents » to a
// custom folder pinned it in the native section instead of assigning it.
function dragTo(w, uuidIndex, zone, options) {
  var opts = options || {};
  var link = w.doc.querySelectorAll('a[href^="/chat/"]')[uuidIndex];
  var data = fakeDataTransfer();

  fireDrag(w, link, 'dragstart', data);
  // The site installs its own dragstart handler and clears the drag clipboard
  // before writing ITS type into it: our data disappears.
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

test('drop on a folder: assigned, and the SITE handler is never called', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var natif = spyNativeDrop(w);
    var head = w.doc.querySelector('.cf-head');
    var r = dragTo(w, 0, head);

    assert.strictEqual(natif.join(','), '', 'the site received the event: it would have pinned');
    assert.ok(r.over.defaultPrevented, 'without preventDefault on dragover, the drop is refused');
    assert.ok(r.drop.defaultPrevented, 'drop not neutralized');
    return w.settle();
  }).then(function () {
    assert.strictEqual(layout(w.doc), '[Travail]   0 1 2', 'conversation not filed');
  });
});

// Cause no. 1 of the bug: the membership test was done on dataTransfer.types, which the site
// clears. cfDragging is now authoritative.
test('the site clears dataTransfer: the drop works anyway', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var natif = spyNativeDrop(w);
    var r = dragTo(w, 1, w.doc.querySelector('.cf-head'), { siteClearsData: true });

    assert.strictEqual(r.data.types.length, 0, 'the clipboard must indeed be empty');
    assert.strictEqual(natif.join(','), '', 'the site took over');
    assert.ok(r.drop.defaultPrevented);
    return w.settle();
  }).then(function () {
    assert.strictEqual(layout(w.doc), '[Travail]   1 0 2');
  });
});

// Cause no. 2: the site listening in capture on an ancestor went BEFORE us. We now intercept
// on window, the very first point of the trajectory.
test('drop into the BODY of an empty folder: same guarantee', function () {
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

// The other half of the requirement: outside our zones, we must disturb nothing, so that native
// reorganisation et l'epinglage natifs continuent de marcher.
test('drop OUTSIDE our zones: the site receives everything, intact', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var natif = spyNativeDrop(w);
    var cible = w.doc.querySelectorAll('.df-drag-shiftable')[1];
    var r = dragTo(w, 0, cible);

    assert.strictEqual(natif.join(','),
      'capture:dragover,bubble:dragover,capture:drop,bubble:drop',
      'le drag natif a été bridé alors qu\'il ne devait pas l\'être');
    assert.strictEqual(r.drop.defaultPrevented, false, 'we neutralized a drop that is not ours');
    return w.settle();
  }).then(function () {
    assert.strictEqual(layout(w.doc), '[Travail] 0 1 2', 'an assignment happened wrongly');
  });
});

// ---- leaving a folder ---------------------------------------------------------------------------

test('the « Retirer » strip only appears for a filed conversation', function () {
  var w = boot();
  return withFolder(w)
    .then(function () { return w.set({ folderAssignments: assign({ 0: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      var out = w.doc.querySelector('.cf-out');
      assert.ok(out, 'bande absente');
      assert.strictEqual(out.hidden, true, 'it must not be visible at rest');

      // Conversation NOT filed: nothing to remove.
      fireDrag(w, w.doc.querySelectorAll('a[href^="/chat/"]')[1], 'dragstart', fakeDataTransfer());
      assert.strictEqual(out.hidden, true);

      // Conversation filed: the strip opens.
      fireDrag(w, w.doc.querySelector('.cf-body a'), 'dragstart', fakeDataTransfer());
      assert.strictEqual(out.hidden, false, 'strip not shown for a filed conversation');
    });
});

test('leaving through the strip: unassigned, without the site being solicited', function () {
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

      assert.strictEqual(natif.join(','), '', 'the site was solicited: risk of pinning');
      assert.ok(drop.defaultPrevented);
      return w.settle();
    })
    .then(function () {
      assert.strictEqual(layout(w.doc), '[Travail] 0 1 2', 'conversation not taken out of the folder');
    });
});

// ---- "−" button ---------------------------------------------------------------------------------

// The requirement is not merely "a button exists": it is that it lives in the NATIVE control
// container, the only place where it inherits the hover without our managing an opacity.
test('"−" button: only on filed items, in the native control container', function () {
  var w = boot();
  return withFolder(w)
    .then(function () { return w.set({ folderAssignments: assign({ 1: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      var btns = w.doc.querySelectorAll('.cf-unfile');
      assert.strictEqual(btns.length, 1, 'one button, and only on the filed conversation');
      assert.ok(btns[0].closest('.cf-body'), 'the button is not on the filed item');

      var bar = btns[0].parentElement;
      assert.ok(bar.querySelector('button[aria-label^="Plus d\'options"]'),
        'le bouton doit partager le conteneur du « … » natif, sinon il ne suit pas le survol');
      assert.ok(bar.className.indexOf('group-hover:opacity-100') !== -1,
        'conteneur sans variant group-hover: : le bouton serait visible en permanence');
      assert.strictEqual(btns[0].getAttribute('aria-label'),
        'Retirer « Conversation 1 » du dossier');
    });
});

// The point of the request: a single removal logic, two entry points. We replay both
// scenarios end to end and compare the complete state — DOM and storage.
test('"−" button: removal identical to the drop on the « Retirer » strip', function () {
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
      // A site handler on an ancestor, in bubbling: that is what the button's
      // stopPropagation() must stop. (In capture, nothing can stop it: capture
      // descends from window, and the site has no row click in capture anyway —
      // otherwise the native "…" next to it would navigate too.)
      w.doc.querySelector('.dframe-nav-scroll')
        .addEventListener('click', function () { natif.push('bubble:click'); }, false);

      var ev = new w.win.Event('click', { bubbles: true, cancelable: true });
      w.doc.querySelector('.cf-body .cf-unfile').dispatchEvent(ev);
      assert.ok(ev.defaultPrevented, 'the click must be neutralized: otherwise it goes up to the row');
      return w.settle();
    })
    .then(function () {
      assert.strictEqual(natif.join(','), '', 'the click went up to a site ancestor');
      return Promise.all([etat(parBande), etat(parBouton)]);
    })
    .then(function (deux) {
      assert.strictEqual(deux[1], deux[0], 'the button does not produce the same result as the strip');
      assert.strictEqual(deux[1], '[Travail] 0 1 2 | {}', 'conversation not taken out of the folder');
      assert.strictEqual(parBouton.doc.querySelectorAll('.cf-unfile').length, 0,
        'le bouton est reparti dans « Récents » avec l\'item');
    });
});

// THE BUG reported in real use: the FIRST click on "−" did nothing, the next one — and all
// the ones after — worked, without reloading the page. Cause: the handler was installed on the
// button, hence in the BUBBLING phase. A drag library commonly arms a single-use
// "click swallower" at the end of a gesture, so that the click following a drag triggers
// nothing; installed in CAPTURE on an ancestor, it stops propagation BEFORE the event
// reaches the button. Once the swallower is consumed, everything is normal again — hence "the first
// click only". Exactly flaw no. 2 of the repo's table, at the same place in the file.
test('"−" button: a site click swallower can no longer eat the removal', function () {
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

      // Control: folder collapsing, for its part, is indeed handled on the element (bubbling). It
      // proves the swallower really is in a position to eat a click — without this control, the
      // test would also pass with a harmless swallower, and would guarantee nothing.
      return clic('.cf-head');
    })
    .then(function () {
      assert.strictEqual(avale, 1, 'the swallower did not fire: the test would prove nothing');
      assert.strictEqual(w.doc.querySelector('[data-cf-folder]').className, '',
        'l\'avaleur laisse passer les clics : il ne prouve rien');

      return clic('.cf-body .cf-unfile');
    })
    .then(function () {
      assert.strictEqual(avale, 1, 'the click went down to the swallower instead of being taken');
      assert.strictEqual(layout(w.doc), '[Travail] 0 1 2',
        'le clic a été mangé avant d\'atteindre le retrait');
    });
});

// ---- menu contextuel et modale de renommage ------------------------------------------------------
//
// The two components that copy a native claude.ai component (a conversation's "…" menu,
// a conversation's rename modal). What they DECIDE is tested in test-folders.js; what
// follows checks what they DISPLAY and what they write.

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

// None of the three commands must go through a browser component anymore: the counters
// stay at zero for the whole duration of the test.
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

// Opens the menu then the rename modal.
function ouvreRenommage(w) {
  var natif = espionneNatif(w);
  clique(w, ouvreMenu(w).querySelectorAll('.cf-item')[0]);

  var d = modaleOuverte(w, natif);
  assert.strictEqual(w.doc.querySelector('.cf-menu'), null, 'the menu must close behind');
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

test('context menu: container and items with the native menu structure', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var menu = ouvreMenu(w);
    assert.ok(menu, 'menu non ouvert');
    assert.strictEqual(menu.getAttribute('role'), 'menu');

    var items = menu.querySelectorAll('.cf-item');
    assert.strictEqual(items.length, 2, 'renommer + supprimer');
    items.forEach(function (it) {
      assert.strictEqual(it.getAttribute('role'), 'menuitem');
      // The extension's stroke icon, not the site's ligature font.
      assert.ok(it.querySelector('svg path'), 'item without an SVG icon');
      assert.ok(it.querySelector('.cf-item-label').textContent, 'item without a label');
    });
    assert.strictEqual(menu.querySelectorAll('.cf-swatch').length, 8, 'palette missing from the menu');
  });
});

// The invariant that makes it acceptable to DEDUCE the site's token names from their Tailwind
// classes: a badly deduced name must never leave a color undefined. If this test breaks,
// it means a var(--cds-…) was added without a fallback — and that component will become invisible the
// day the token does not exist.
test('no site token is used without a fallback value', function () {
  var w = boot();
  return w.settle().then(function () {
    var css = w.doc.getElementById('__claude_folders_style').textContent;
    var refs = css.match(/var\(--cds-[a-z0-9-]+[,)]/g) || [];

    assert.ok(refs.length >= 8, 'the site tokens are no longer read at all (' + refs.length + ')');
    refs.forEach(function (r) {
      assert.ok(r.slice(-1) === ',', 'without a fallback: ' + r);
    });
    assert.strictEqual(css.indexOf('#1c1c1e'), -1, 'old hard-coded dark menu still present');
  });
});

test('renaming: modal pre-filled, focused, text selected', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var d = ouvreRenommage(w);

    assert.strictEqual(d.input.value, 'Travail', 'the current name must be pre-filled');
    assert.strictEqual(w.doc.activeElement, d.input, 'the field does not have the focus');
    assert.strictEqual(d.input.selectionStart, 0);
    assert.strictEqual(d.input.selectionEnd, 'Travail'.length, 'text not preselected');
    assert.strictEqual(d.input.maxLength, w.win.FOLDER_NAME_MAX, 'length not bounded');
    assert.strictEqual(d.modal.querySelector('[role="dialog"]').className, 'cf-modal-box');
    assert.strictEqual(d.annuler.textContent, 'Annuler');
    assert.strictEqual(d.enregistrer.textContent, 'Enregistrer');
  });
});

test('Enter saves and closes, like the « Enregistrer » button', function () {
  function renomme(w, parLaTouche) {
    return withFolder(w).then(function () {
      var d = ouvreRenommage(w);
      d.input.value = '  Perso  ';
      d.input.dispatchEvent(new w.win.Event('input', { bubbles: true }));

      if (parLaTouche) {
        assert.ok(touche(w, d.input, 'Enter').defaultPrevented, 'Enter not consumed');
      } else {
        clique(w, d.enregistrer);
      }
      assert.strictEqual(w.doc.querySelector('.cf-modal'), null, 'modal stayed open');
      return w.settle();
    }).then(function () {
      // The name is cleaned on write, as by the prompt we are replacing.
      return w.doc.querySelector('.cf-name').textContent;
    });
  }

  return Promise.all([renomme(boot(), true), renomme(boot(), false)]).then(function (deux) {
    assert.strictEqual(deux[0], 'Perso', 'Enter did not save');
    assert.strictEqual(deux[1], deux[0], 'the two entry points do not give the same result');
  });
});

test('Escape and « Annuler » close without writing anything', function () {
  function abandonne(w, parLaTouche) {
    return withFolder(w).then(function () {
      var d = ouvreRenommage(w);
      d.input.value = 'Jamais enregistré';

      if (parLaTouche) touche(w, d.input, 'Escape');
      else clique(w, d.annuler);

      assert.strictEqual(w.doc.querySelector('.cf-modal'), null, 'modal stayed open');
      return w.settle();
    }).then(function () {
      return w.doc.querySelector('.cf-name').textContent;
    });
  }

  return Promise.all([abandonne(boot(), true), abandonne(boot(), false)]).then(function (deux) {
    assert.strictEqual(deux[0], 'Travail', 'Escape saved');
    assert.strictEqual(deux[1], 'Travail', '« Annuler » saved');
  });
});

// Closing on an empty name would read as a successful save, whereas folderRename()
// would ignore the input: so the modal stays open, and the button says so.
test('name emptied: Enter closes nothing and « Enregistrer » is disabled', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var d = ouvreRenommage(w);
    assert.strictEqual(d.enregistrer.disabled, false, 'the current name is valid though');

    d.input.value = '   ';
    d.input.dispatchEvent(new w.win.Event('input', { bubbles: true }));
    assert.strictEqual(d.enregistrer.disabled, true, 'button active on an empty name');

    touche(w, d.input, 'Enter');
    assert.ok(w.doc.querySelector('.cf-modal'), 'the modal closed on an empty name');

    d.input.value = 'Perso';
    d.input.dispatchEvent(new w.win.Event('input', { bubbles: true }));
    assert.strictEqual(d.enregistrer.disabled, false, 'button stayed disabled');
  });
});

// claude.ai listens to the keyboard on the document for its own shortcuts. A keystroke made in
// our field has no business there — otherwise typing "/" or "e" in a folder name
// would trigger a site shortcut.
test('the modal keystrokes do not reach the site', function () {
  var w = boot();
  var recu = [];

  return withFolder(w).then(function () {
    w.doc.addEventListener('keydown', function (e) { recu.push(e.key); }, false);

    var d = ouvreRenommage(w);
    touche(w, d.input, 'e');
    touche(w, d.input, '/');
    touche(w, d.input, 'Escape');

    assert.strictEqual(recu.join(','), '', 'the site received the keystrokes: ' + recu.join(','));
  });
});

// ---- creation: the same input modal --------------------------------------------------------------

test('"+": creation modal, empty field, « Créer » button', function () {
  var w = boot();
  return w.settle().then(function () {
    var d = ouvreCreation(w);

    assert.strictEqual(d.input.value, '', 'no name must be pre-filled');
    assert.strictEqual(w.doc.activeElement, d.input, 'the field does not have the focus');
    assert.strictEqual(d.modal.querySelector('.cf-modal-title').textContent, 'Nouveau dossier');
    assert.strictEqual(d.annuler.textContent, 'Annuler');
    assert.strictEqual(d.action.textContent, 'Créer');
    // The same guard as when renaming: nothing to create as long as the field is empty.
    assert.strictEqual(d.action.disabled, true, 'button active on an empty field');

    d.input.value = '  Travail  ';
    d.input.dispatchEvent(new w.win.Event('input', { bubbles: true }));
    assert.strictEqual(d.action.disabled, false);

    assert.ok(touche(w, d.input, 'Enter').defaultPrevented, 'Enter not consumed');
    assert.strictEqual(w.doc.querySelector('.cf-modal'), null, 'modal stayed open');
    return w.settle();
  }).then(function () {
    assert.strictEqual(w.doc.querySelector('.cf-name').textContent, 'Travail',
      'dossier non créé, ou nom non nettoyé');
  });
});

test('creation abandoned (Escape, « Annuler », backdrop): no folder', function () {
  var w = boot();

  function abandonne(ferme) {
    var d = ouvreCreation(w);
    d.input.value = 'Jamais créé';
    d.input.dispatchEvent(new w.win.Event('input', { bubbles: true }));
    ferme(w, d);
    assert.strictEqual(w.doc.querySelector('.cf-modal'), null, 'modal stayed open');
  }

  return w.settle().then(function () {
    abandonne(function (w, d) { touche(w, d.input, 'Escape'); });
    abandonne(function (w, d) { clique(w, d.annuler); });
    abandonne(function (w, d) {
      d.modal.dispatchEvent(new w.win.Event('mousedown', { bubbles: true }));
    });
    return w.settle();
  }).then(function () {
    assert.strictEqual(w.doc.querySelectorAll('[data-cf-folder]').length, 0, 'a folder was created');
  });
});

// A click in the BOX must not close: it is the classic trap of the "click on the backdrop"
// installed without distinguishing the target from the listened element.
test('click in the box: the modal stays open', function () {
  var w = boot();
  return w.settle().then(function () {
    var d = ouvreCreation(w);
    d.input.dispatchEvent(new w.win.Event('mousedown', { bubbles: true }));
    assert.ok(w.doc.querySelector('.cf-modal'), 'a click in the field closed the modal');
  });
});

// ---- deletion: styled confirmation ---------------------------------------------------------------

test('deletion: confirmation without a field, danger button, focus on « Annuler »', function () {
  var w = boot();
  return withFolder(w)
    .then(function () { return w.set({ folderAssignments: assign({ 0: 'f1', 1: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      var d = ouvreSuppression(w);

      assert.strictEqual(d.input, null, 'a confirmation has no input field');
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

      // Nothing to validate: neither of the two buttons is ever greyed out.
      assert.strictEqual(d.annuler.disabled, false);
      assert.strictEqual(d.action.disabled, false);

      // The focus is on « Annuler »: Enter closes instead of destroying, unlike
      // window.confirm, whose Enter key confirms.
      assert.strictEqual(w.doc.activeElement, d.annuler,
        'le focus doit être sur « Annuler », pas sur le bouton destructeur');
    });
});

test('deletion confirmed: folder deleted, conversations freed', function () {
  var w = boot();
  return withFolder(w)
    .then(function () { return w.set({ folderAssignments: assign({ 0: 'f1', 2: 'f1' }) }); })
    .then(w.settle)
    .then(function () {
      assert.strictEqual(layout(w.doc), '[Travail]   0   2 1');
      clique(w, ouvreSuppression(w).action);
      assert.strictEqual(w.doc.querySelector('.cf-modal'), null, 'modal stayed open');
      return w.settle();
    })
    .then(function () {
      assert.strictEqual(w.doc.querySelectorAll('[data-cf-folder]').length, 0, 'folder not deleted');
      assert.strictEqual(layout(w.doc), '0 1 2', 'a conversation was lost with the folder');
    });
});

test('deletion abandoned (Escape, « Annuler », backdrop): nothing is touched', function () {
  var w = boot();

  function abandonne(ferme) {
    var d = ouvreSuppression(w);
    ferme(w, d);
    assert.strictEqual(w.doc.querySelector('.cf-modal'), null, 'modal stayed open');
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
      assert.strictEqual(layout(w.doc), '[Travail]   1 0 2', 'the folder or its content moved');
    });
});

// ---- repli pointeur ------------------------------------------------------------------------------

// If the site drags with the POINTER (as "df-drag-shiftable" suggests) and not in HTML5, no
// dragstart is emitted and the whole path above stays silent. This fallback then takes over.
test('pointer drag, without any HTML5 event: filed anyway', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var head = w.doc.querySelector('.cf-head');
    w.doc.elementFromPoint = function () { return head; };   // jsdom does not provide it

    var link = w.doc.querySelectorAll('a[href^="/chat/"]')[0];
    link.dispatchEvent(new w.win.Event('pointerdown', { bubbles: true }));
    // jsdom has no PointerEvent: we set the coordinates and the button by hand.
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
    assert.strictEqual(layout(w.doc), '[Travail]   0 1 2', 'the pointer fallback filed nothing');
  });
});

test('plain click on a conversation: no filing', function () {
  var w = boot();
  return withFolder(w).then(function () {
    var head = w.doc.querySelector('.cf-head');
    w.doc.elementFromPoint = function () { return head; };

    var link = w.doc.querySelectorAll('a[href^="/chat/"]')[0];
    var down = new w.win.Event('pointerdown', { bubbles: true });
    down.button = 0; down.clientX = 10; down.clientY = 10;
    link.dispatchEvent(down);

    var up = new w.win.Event('pointerup', { bubbles: true, cancelable: true });
    up.clientX = 11; up.clientY = 10;   // below the drag threshold
    link.dispatchEvent(up);

    return w.settle();
  }).then(function () {
    assert.strictEqual(layout(w.doc), '[Travail] 0 1 2', 'a click was taken for a drag');
  });
});

// ---- run -----------------------------------------------------------------------------------
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
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passed');
  process.exit(failed ? 1 : 0);
});
