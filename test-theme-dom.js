// Test for theme.js in a stubbed DOM. Run with:
//   npm install jsdom      (once only, outside the repo)
//   node test-theme-dom.js
//
// Same rule as test-folders-dom.js and test-export-dom.js: if jsdom is missing, this file
// SKIPS ITSELF instead of failing. The repo deliberately has neither package.json nor node_modules.
//
// test-theme.js covers the pure computations (color conversion, weights, shadows); here we cover
// what they cannot see: what theme.js actually WRITES into a given document.
//
// Main reason for existing: claude.ai's large "fullscreen" spinner is rendered in an
// iframe on https://a.claude.ai/, where theme.js is now injected (all_frames). That document
// is REDUCED — it does not necessarily have .cds-root on <html>, nor the --cds-* tokens, nor even a
// <body> at the moment the script starts. These tests lock down both halves of the contract:
// the accent is overridden even when nothing is readable (that is what repaints the spinner), and
// the three derived settings disable themselves cleanly instead of crashing.
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

var STYLE_ID = '__claude_theme_v1__';

// The tokens as claude.ai sets them. A document that carries them must see the derived
// settings apply; a document that does not carry them must see them disable themselves.
var TOKENS = ':root{--cds-radius:8px;--cds-shadow-sm:0 1px 2px rgba(0,0,0,.4);' +
  '--cds-shadow-md:0 2px 6px rgba(0,0,0,.4);--cds-shadow-lg:0 4px 12px rgba(0,0,0,.4);' +
  '--cds-font-weight-regular:400;--cds-font-weight-medium:500;' +
  '--cds-font-weight-semibold:600;--cds-font-weight-bold:700}';

// runScripts:'outside-only' + getInternalVMContext: same technique as test-export-dom.js.
// theme.js is not in an IIFE, so its functions stay readable on the context.
function boot(headCss, stored, opts) {
  var o = opts || {};
  var dom = new JSDOM(
    '<!doctype html><html><head><style>' + (headCss || '') + '</style></head>' +
    '<body>contenu</body></html>',
    { url: o.url || 'https://a.claude.ai/isolated-segment.html', runScripts: 'outside-only' });

  var win = dom.window;
  var warns = [];
  var logs = [];
  win.console = {
    warn: function (m) { warns.push(String(m)); },
    log: function (m, d) { logs.push(String(m) + ' ' + JSON.stringify(d === undefined ? '' : d)); }
  };
  win.chrome = {
    storage: {
      local: { get: function () { return Promise.resolve(stored || {}); } },
      onChanged: { addListener: function () {} }
    }
  };

  // Simulates document_start in a document still without a body: themeCaptureOriginals() must
  // return null without memoizing, and above all must not throw.
  if (o.stripBody) win.document.documentElement.removeChild(win.document.body);

  vm.runInContext(fs.readFileSync(path.join(__dirname, 'theme.js'), 'utf8'),
    dom.getInternalVMContext());

  return {
    win: win,
    warns: warns,
    logs: logs,
    el: function () { return win.document.getElementById(STYLE_ID); },
    css: function () {
      var el = win.document.getElementById(STYLE_ID);
      return el ? el.textContent : null;
    },
    settle: function (ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }
  };
}

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---- the case that motivates injection into the iframe -------------------------------------

// THIS is the spinner bug's test: in a document that carries no design system
// token, the accent must still be written. It depends on no original value — that is
// what lets it repaint an element rendered in a reduced document.
test('document sans aucun token : l\'accent est surchargé quand même', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    var css = w.css();
    assert.ok(css, 'no sheet injected');
    assert.ok(css.indexOf('--cds-clay-emphasized:#3f6ac6 !important') !== -1, css);
    assert.ok(css.indexOf('--cds-clay:') !== -1, 'the lightened variant is missing: ' + css);
    assert.strictEqual(w.warns.length, 0, w.warns.join(' | '));
  });
});

// In the iframe, .cds-root may not exist: it is :root that carries the override. If that
// selector disappeared from the rule, the spinner would stop being repainted.
test('the rule targets :root, not only .cds-root', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    assert.ok(w.css().indexOf(':root,html.cds-root,.cds-root{') === 0, w.css());
  });
});

test('document without <body> (document_start): no exception, the accent gets through', function () {
  var w = boot('', { accentColor: '#3f6ac6' }, { stripBody: true });
  return w.settle().then(function () {
    assert.ok(w.css().indexOf('--cds-clay-emphasized:#3f6ac6') !== -1, w.css());
  });
});

// ---- clean disabling of the derived settings -----------------------------------------------

// The three other settings derive from original values: without them, they must write
// NOTHING — least of all a guessed value — and must not prevent the accent from getting through.
test('document without tokens: the derived settings write nothing, without crashing', function () {
  var w = boot('', {
    accentColor: '#3f6ac6', radiusPreset: 'round', fontWeightPreset: 'bold', fontFamily: 'serif'
  });
  return w.settle().then(function () {
    var css = w.css();
    assert.ok(css.indexOf('--cds-clay-emphasized') !== -1, 'the accent must get through: ' + css);
    assert.strictEqual(css.indexOf('--cds-radius'), -1, 'radius written without an original value');
    assert.strictEqual(css.indexOf('--cds-font-weight'), -1, 'weight written without an original value');
    assert.strictEqual(css.indexOf('--cds-shadow'), -1, 'shadow written without an original value');
  });
});

test('no setting: no sheet injected (the document stays intact)', function () {
  var w = boot(TOKENS, {});
  return w.settle().then(function () {
    assert.strictEqual(w.css(), null, 'a sheet was placed although nothing is configured');
  });
});

// ---- document that does carry the tokens ---------------------------------------------------

// The other half of the contract: where the tokens exist, the derived settings apply
// for real. Without this test, a theme.js that never did anything again would pass the
// disabling tests above without our seeing it.
test('document with the tokens: the derived settings apply', function () {
  var w = boot(TOKENS, { radiusPreset: 'round', fontWeightPreset: 'bold' });
  return w.settle().then(function () {
    var css = w.css();
    assert.ok(css.indexOf('--cds-radius:12px !important') !== -1, css);   // 8px x1.5
    assert.ok(css.indexOf('--cds-font-weight-bold:800 !important') !== -1, css);   // 700 +100
    assert.ok(css.indexOf('--cds-shadow-sm:') !== -1, 'shadows not accentuated: ' + css);
  });
});

test('"Carré" preset: radius at 0 and shadows removed', function () {
  var w = boot(TOKENS, { radiusPreset: 'square' });
  return w.settle().then(function () {
    var css = w.css();
    assert.ok(css.indexOf('--cds-radius:0 !important') !== -1, css);
    assert.ok(css.indexOf('--cds-shadow-sm:none !important') !== -1, css);
  });
});

// ---- instrumentation of the intermittent propagation bug (TEMPORARY) -----------------------
// These tests cover the MEASUREMENT POINTS themselves. This is not overzealousness: an observer mute
// because it is broken would read exactly like "hypothesis disproved", and it is that very misreading
// that has already cost one diagnosis round with the "state read" log locked to the first
// load. An instrument you have not tested is no better than no instrument.

test('the observer detects the tag removal by the site', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    var el = w.el();
    assert.ok(el, 'tag absent before the removal');
    el.parentNode.removeChild(el);            // what a site re-render would do
    return w.settle(30);
  }).then(function () {
    assert.ok(w.warns.some(function (m) { return m.indexOf('tag REMOVED from the DOM') !== -1; }),
      'the removal was NOT detected — a mute observer wrongly reads as "hypothesis ' +
      'disproved": ' + w.warns.join(' | '));
  });
});

// The removal must be OBSERVED, not repaired, as long as THEME_REINJECT is false. This test freezes
// the gate: the day we promote it, it fails and reminds us to update it.
test('THEME_REINJECT at false: the removal is observed, not repaired', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    assert.strictEqual(w.win.THEME_REINJECT, false, 'the reinjection gate has been promoted');
    w.el().parentNode.removeChild(w.el());
    return w.settle(30);
  }).then(function () {
    assert.strictEqual(w.el(), null, 'the tag was reinjected although the gate is closed');
  });
});

// The counter-test of the promotion: with the gate open, the tag comes back. It proves that
// promoting THEME_REINJECT really is enough, without having to discover it in production.
test('THEME_REINJECT at true: the tag is put back after a removal', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    w.win.THEME_REINJECT = true;
    w.el().parentNode.removeChild(w.el());
    return w.settle(30);
  }).then(function () {
    var el = w.el();
    assert.ok(el, 'the tag was not put back');
    assert.ok(el.textContent.indexOf('--cds-clay-emphasized:#3f6ac6') !== -1, el.textContent);
  });
});

// The log whose scope was wrong: it must name its cause, otherwise seeing it in the console
// proves nothing about the origin of the read.
test('every storage read is traced, with its cause', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    assert.ok(w.logs.some(function (m) { return m.indexOf('state read (initial load)') !== -1; }),
      w.logs.join(' | '));
  });
});

// The audit must report the COMPUTED value, not the one we think we wrote: it is the one that
// separates "tag removed" from "more specific rule that wins".
test('the audit reports the match between the requested and computed color', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    var audit = w.logs.filter(function (m) { return m.indexOf('[theme] audit') === 0; });
    assert.strictEqual(audit.length, 1, 'one audit per render expected: ' + w.logs.join(' | '));
    assert.ok(audit[0].indexOf('requested=#3f6ac6') !== -1, audit[0]);
    assert.ok(audit[0].indexOf('computed=#3f6ac6') !== -1, audit[0]);
    assert.ok(audit[0].indexOf('matches=YES') !== -1, audit[0]);
    assert.ok(audit[0].indexOf('attached=yes') !== -1, audit[0]);

    // A single line of text, not an object: that is what makes it copyable from the console.
    assert.strictEqual(audit[0].indexOf('{'), -1, 'the audit must stay flat: ' + audit[0]);
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
