// Test for export.js — the half that touches claude.ai's header. Run with:
//   npm install jsdom      (once only, outside the repo)
//   node test-export-dom.js
//
// Same rule as test-folders-dom.js: if jsdom is missing, this file SKIPS ITSELF instead
// of failing. The repo deliberately has neither package.json nor node_modules.
//
// It builds the header confirmed by inspection (slot, action container, "Partager" button)
// and checks what regresses most easily: the button placed in the right spot, with the
// style COPIED from the site, absent outside a conversation, and put back — in a single copy — after an
// SPA re-render. It does not prove that the selectors still match the real site.
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

var UUID = '0f2a1b3c-4d5e-6f70-8192-a3b4c5d6e7f8';
var BTN = '#__claude_export_button';
var MENU = '#__claude_export_menu';

// Plausible utility class of the "Partager" button: the test checks that it is taken
// as-is, not its value — that is the whole point of copying rather than inventing a style.
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

// "Project" context as we assume it from the warning received: the action slot is
// absent, but the "Partager" button is indeed there. The container name is deliberately
// different from the repo's ones: the test must pass WITHOUT the anchoring knowing this container.
function projectHeaderHtml() {
  return '<div data-testid="chat-header">' +
           '<div class="un-conteneur-que-le-code-ne-connait-pas">' +
             '<button data-testid="wiggle-controls-actions-share" class="' + SHARE_CLASS + '">' +
               '<svg width="16" height="16"></svg></button>' +
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

test('button placed just after "Partager", with ITS class and ITS icon size', function () {
  var w = boot('/chat/' + UUID, headerHtml());
  return w.settle().then(function () {
    var btn = w.doc.querySelector(BTN);
    assert.ok(btn, 'button absent');
    assert.strictEqual(
      w.doc.querySelector('[data-testid="wiggle-controls-actions-share"]').nextSibling, btn,
      'le bouton doit suivre immédiatement « Partager »');
    assert.strictEqual(btn.className, SHARE_CLASS, 'style not copied from the native button');
    assert.strictEqual(btn.querySelector('svg').getAttribute('width'), '16');
    assert.strictEqual(w.warns.length, 0, w.warns.join(' | '));
  });
});

test('outside a conversation: no button (nothing to export)', function () {
  var w = boot('/chat/new', headerHtml());
  return w.settle().then(function () {
    assert.strictEqual(w.doc.querySelector(BTN), null);
  });
});

test('without a "Partager" button: still placed in the slot, neutral style + warn', function () {
  var w = boot('/chat/' + UUID, headerHtml(false));
  return w.settle().then(function () {
    var btn = w.doc.querySelector(BTN);
    assert.ok(btn, 'button absent');
    assert.strictEqual(btn.parentElement.id, 'dframe-header-actions-slot');
    assert.ok(btn.style.cssText.indexOf('inline-flex') !== -1, 'fallback style absent');
    assert.ok(w.warns.length > 0, 'the fallback must be reported in the console');
  });
});

// The easiest regression: placing the button again on every render without removing the old one.
test('header re-render: the button comes back, in ONE single copy', function () {
  var w = boot('/chat/' + UUID, headerHtml());
  return w.settle().then(function () {
    assert.ok(w.doc.querySelector(BTN));
    w.doc.querySelector('[data-testid="chat-header"]').innerHTML =
      '<div id="dframe-header-actions-slot"><div data-testid="wiggle-controls-actions">' +
      '<button data-testid="wiggle-controls-actions-share" class="' + SHARE_CLASS + '">' +
      '<svg width="16" height="16"></svg></button></div></div>';
    return w.settle(250);
  }).then(function () {
    assert.ok(w.doc.querySelector(BTN), 'button not put back after re-render');
    assert.strictEqual(w.doc.querySelectorAll(BTN).length, 1, 'duplicate button');
  });
});

test('click: two-entry menu, closed by Escape', function () {
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
    assert.strictEqual(w.doc.querySelector(MENU), null, 'menu not closed');
  });
});

// ---- context detection --------------------------------------------------------------------
// The bug fixed here: the anchoring assumed ONE header structure (the action slot) and
// disabled itself everywhere else, while "Partager" — the real placement neighbour — was
// present. These three tests lock down that detection no longer depends on the shell.

test('header without an action slot (Project context): button still placed after "Partager"',
  function () {
    var w = boot('/chat/' + UUID, projectHeaderHtml());
    return w.settle().then(function () {
      var btn = w.doc.querySelector(BTN);
      assert.ok(btn, 'button absent although "Partager" is present');
      assert.strictEqual(
        w.doc.querySelector('[data-testid="wiggle-controls-actions-share"]').nextSibling, btn,
        'le bouton doit suivre immédiatement « Partager »');
      assert.strictEqual(btn.className, SHARE_CLASS, 'style not copied from the native button');
      assert.strictEqual(w.warns.length, 0, w.warns.join(' | '));
    });
  });

// The widest case: neither slot nor recognized header. As long as "Partager" is there, there is a
// placement neighbour — it is the only selector the anchoring really needs.
test('neither slot nor recognized header, but "Partager" present: button placed', function () {
  var w = boot('/chat/' + UUID,
    '<div class="coque-inconnue"><button data-testid="wiggle-controls-actions-share" ' +
    'class="' + SHARE_CLASS + '"><svg width="16" height="16"></svg></button></div>');
  return w.settle().then(function () {
    var btn = w.doc.querySelector(BTN);
    assert.ok(btn, 'button absent');
    assert.strictEqual(btn.parentElement.className, 'coque-inconnue');
  });
});

// The safety net stays in place: a context with NEITHER of the two anchors breaks nothing.
// It is the only case where the export must still disable itself. (The warn announcing it fires at 8 s,
// too late for this harness: we check the decision itself, through exAnchor().)
test('no anchor: nothing inserted, native header intact', function () {
  var w = boot('/chat/' + UUID, '<div data-testid="chat-header"><span>natif</span></div>');
  return w.settle(50).then(function () {
    assert.strictEqual(w.doc.querySelector(BTN), null);
    assert.strictEqual(w.doc.querySelector('[data-testid="chat-header"]').textContent, 'natif');
    assert.strictEqual(w.win.exAnchor(), null, 'no anchor must be found');
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
