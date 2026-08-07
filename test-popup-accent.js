// Test for the popup's accent color control. No dependency, no framework, like
// test-theme.js. Run with: node test-popup-accent.js
//
// Why this file exists while the rest of popup.js is not tested: the native
// <input type="color"> swatch had to be replaced (it kills the popup on Firefox, see the
// "Portage Firefox" section of the README), and the control replacing it carries logic —
// input normalization, swatch selection, no write on render.
//
// popup.js is a page script, not a module. We evaluate it in a vm context with a minimal
// stubbed DOM: no need for jsdom, renderTheme() only uses getElementById,
// createElement, appendChild, dataset, style, children, setAttribute and addEventListener.
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// common.js first: popup.js reads its constants from the top level.
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

// A fresh context per test: the stubbed elements keep their listeners, two
// renderTheme() in the same DOM would wire them twice.
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
    // popup.js's top level launches a storage.get().then(...): a promise that never
    // resolves short-circuits the whole usage render, off topic here.
    chrome: { storage: { local: {
      get: function () { return new Promise(function () {}); },
      set: function (o) { writes.push(o); return Promise.resolve(); },
      remove: function (k) { writes.push({ remove: k }); return Promise.resolve(); }
    } } },
    AC_KEYS: [],   // comes from autocontinue-source.js, not loaded here
    Promise: Promise
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { s: sandbox, el: sandbox.document.getElementById, writes: writes };
}

// Selection state of the eight swatches, as a string readable in the failure message.
function pressed(el) {
  return el('accentSwatches').children.map(function (b) {
    return b.getAttribute('aria-pressed');
  }).join(',');
}

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---- accentNormalize ----------------------------------------------------------------------

test('accentNormalize: accepts #rrggbb, the optional hash and uppercase', function () {
  var n = load().s.accentNormalize;
  assert.strictEqual(n('#c6613f'), '#c6613f');
  assert.strictEqual(n('c6613f'), '#c6613f');
  assert.strictEqual(n('#C6613F'), '#c6613f');
  assert.strictEqual(n('  #c6613f  '), '#c6613f');
});

test('accentNormalize: rejects everything accentValid (theme.js) would reject', function () {
  var n = load().s.accentNormalize;
  assert.strictEqual(n('#abc'), null);        // short form not handled on the theme.js side
  assert.strictEqual(n('#zzzzzz'), null);
  assert.strictEqual(n('red'), null);
  assert.strictEqual(n('rgb(1,2,3)'), null);
  assert.strictEqual(n(''), null);
  assert.strictEqual(n(undefined), null);     // missing key
  assert.strictEqual(n('#000000;} body{display:none'), null);
});

test('the whole palette passes accentValid, and its first stop is the default', function () {
  var s = load().s;
  s.ACCENT_PRESETS.forEach(function (c) {
    assert.ok(/^#[0-9a-f]{6}$/.test(c), c + ' would not be applied by theme.js');
  });
  // « Réinitialiser » must fall back on a visibly selected swatch.
  assert.strictEqual(s.ACCENT_PRESETS[0], s.DEFAULT_ACCENT);
});

// ---- render -------------------------------------------------------------------------------

test('render with no stored key: default displayed, nothing written', function () {
  var t = load();
  t.s.renderTheme({});
  assert.strictEqual(t.el('accentHex').value, '#c6613f');
  assert.strictEqual(t.el('accentPreview').style.background, '#c6613f');
  assert.strictEqual(t.el('accentSwatches').children.length, 8);
  assert.strictEqual(pressed(t.el), 'true,false,false,false,false,false,false,false');
  // A render that wrote would recreate the key « Réinitialiser » has just removed.
  assert.strictEqual(t.writes.length, 0);
});

test('render of a color outside the palette: normalized, no swatch selected', function () {
  var t = load();
  t.s.renderTheme({ accentColor: '#ABCDEF' });
  assert.strictEqual(t.el('accentHex').value, '#abcdef');
  assert.strictEqual(pressed(t.el), 'false,false,false,false,false,false,false,false');
  assert.strictEqual(t.writes.length, 0);
});

// ---- interactions -------------------------------------------------------------------------

test('click on a swatch: writes, moves the selection, updates the field', function () {
  var t = load();
  t.s.renderTheme({});
  t.el('accentSwatches').children[3].fire('click');
  assert.deepStrictEqual(t.writes, [{ accentColor: '#0f766e' }]);
  assert.strictEqual(t.el('accentHex').value, '#0f766e');
  assert.strictEqual(pressed(t.el), 'false,false,false,true,false,false,false,false');
});

test('hexadecimal input: writes as soon as complete, without rewriting the field', function () {
  var t = load();
  t.s.renderTheme({});
  t.el('accentHex').value = 'aabbcc';
  t.el('accentHex').fire('input');
  assert.deepStrictEqual(t.writes, [{ accentColor: '#aabbcc' }]);
  assert.strictEqual(t.el('accentPreview').style.background, '#aabbcc');
  // Rewriting the field while typing would move the caret and correct the typed case.
  assert.strictEqual(t.el('accentHex').value, 'aabbcc');
});

test('incomplete input: flagged, not written, and recovered on field blur', function () {
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

test('reset: default displayed and the four keys removed in a single remove', function () {
  var t = load();
  t.s.renderTheme({ accentColor: '#aabbcc' });
  t.el('themeReset').fire('click');
  assert.strictEqual(t.el('accentHex').value, '#c6613f');
  assert.strictEqual(pressed(t.el), 'true,false,false,false,false,false,false,false');
  assert.deepStrictEqual(t.writes, [{ remove: ['accentColor', 'fontWeightPreset', 'radiusPreset', 'fontFamily'] }]);
});

// ---- run -----------------------------------------------------------------------------------
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

console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passed');
if (failed) process.exit(1);
