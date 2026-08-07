// Unit test for window reset detection (background.js). No dependency,
// no framework, like test-usage-source.js. Run with: node test-background.js
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

function read(file) { return fs.readFileSync(path.join(__dirname, file), 'utf8'); }
function noop() {}

// background.js is loaded by the service worker, not by require(): no module.exports to
// add to it. We evaluate it in its own context, stubbing what the worker provides —
// importScripts(), which loads the dependencies into the SAME context (evaluate() needs
// utilOf(), resetText() and USAGE_LABELS from common.js), and chrome, which only the wiring at the
// end of the file uses. OffscreenCanvas is only touched inside canvasFor()'s body, never at
// load time: no need to stub it.
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

// Arbitrary reset boundaries, in Unix seconds like what parseUsage() writes to storage.
var BORNE_A = 1785000000;
var BORNE_B = 1785018000;
var FRAIS = 60 * 1000;   // age of the previous poll in the nominal case: one minute

function win(pct, resetsAt) { return { utilization: pct / 100, resets_at: resetsAt }; }

// ---- isReset(): the conjunction of the two signals ------------------------------------------

test('new boundary + sharp drop: this is a reset', function () {
  assert.strictEqual(sandbox.isReset(win(76, BORNE_A), win(2, BORNE_B), FRAIS), true);
});

test('new boundary without a drop: not a reset', function () {
  assert.strictEqual(sandbox.isReset(win(76, BORNE_A), win(74, BORNE_B), FRAIS), false);
});

test('drop without a new boundary: not a reset', function () {
  assert.strictEqual(sandbox.isReset(win(76, BORNE_A), win(2, BORNE_A), FRAIS), false);
});

test('drop not sharp enough (40 -> 25): not a reset', function () {
  assert.strictEqual(sandbox.isReset(win(40, BORNE_A), win(25, BORNE_B), FRAIS), false);
});

test('previous utilization below the notable threshold (18 -> 0): not a reset', function () {
  assert.strictEqual(sandbox.isReset(win(18, BORNE_A), win(0, BORNE_B), FRAIS), false);
});

test('previous poll too old: not a reset', function () {
  var sixHeures = 6 * 60 * 60 * 1000;
  assert.strictEqual(sandbox.isReset(win(76, BORNE_A), win(2, BORNE_B), sixHeures), false);
});

test('no previous poll: not a reset', function () {
  assert.strictEqual(sandbox.isReset(undefined, win(2, BORNE_B), -1), false);
});

test('non-numeric utilization: not a reset', function () {
  var casse = { utilization: null, resets_at: BORNE_A };
  assert.strictEqual(sandbox.isReset(casse, win(2, BORNE_B), FRAIS), false);
  assert.strictEqual(sandbox.isReset(win(76, BORNE_A), { resets_at: BORNE_B }, FRAIS), false);
});

test('boundary missing on one side: not a reset', function () {
  assert.strictEqual(sandbox.isReset({ utilization: 0.76 }, win(2, BORNE_B), FRAIS), false);
});

// ---- evaluate(): messages produced and anti-spam ---------------------------------------------

function envelope(w5, w7, ageMs) {
  return { data: { windows: { '5h': w5, '7d': w7 } }, updatedAt: Date.now() - ageMs };
}

function fresh() { return { windows: {} }; }

test('reset of both windows: one message per window', function () {
  var prev = envelope(win(76, BORNE_A), win(88, BORNE_A), FRAIS);
  var data = { windows: { '5h': win(1, BORNE_B), '7d': win(0, BORNE_B) } };

  var msgs = sandbox.evaluate(data, fresh(), prev);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].title, 'Session — 5 h : reset effectué');
  assert.ok(msgs[0].message.indexOf('limite de session') !== -1, msgs[0].message);
  assert.strictEqual(msgs[1].title, 'Semaine — 7 j : reset effectué');
  assert.ok(msgs[1].message.indexOf('limite hebdomadaire') !== -1, msgs[1].message);
});

test('same reset replayed: notifies only once', function () {
  var prev = envelope(win(76, BORNE_A), win(43, BORNE_A), FRAIS);
  var data = { windows: { '5h': win(1, BORNE_B), '7d': win(43, BORNE_A) } };
  var state = fresh();

  assert.strictEqual(sandbox.evaluate(data, state, prev).length, 1);
  assert.strictEqual(state.windows['5h'].notifiedReset, BORNE_B);
  assert.strictEqual(sandbox.evaluate(data, state, prev).length, 0);
});

test('new boundary without a drop: evaluate produces no message', function () {
  var prev = envelope(win(30, BORNE_A), win(43, BORNE_A), FRAIS);
  var data = { windows: { '5h': win(31, BORNE_B), '7d': win(43, BORNE_A) } };

  assert.strictEqual(sandbox.evaluate(data, fresh(), prev).length, 0);
});

test('drop without a new boundary: evaluate produces no message', function () {
  var prev = envelope(win(76, BORNE_A), win(43, BORNE_A), FRAIS);
  var data = { windows: { '5h': win(2, BORNE_A), '7d': win(43, BORNE_A) } };
  var state = fresh();

  assert.strictEqual(sandbox.evaluate(data, state, prev).length, 0);
  // The descent lowers the memorized threshold again, as before this change.
  assert.strictEqual(state.windows['5h'].threshold, 0);
  assert.strictEqual(state.windows['5h'].notifiedReset, undefined);
});

// ---- threshold non-regression ----------------------------------------------------------------

test('without a previous poll, the thresholds still work', function () {
  var data = { windows: { '5h': win(92, BORNE_A), '7d': win(43, BORNE_A) } };
  var state = fresh();

  var msgs = sandbox.evaluate(data, state, undefined);
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].title, 'Session — 5 h : 90 % atteint');
  assert.strictEqual(state.windows['5h'].threshold, 90);
});

test('a reset does not mask the other window\'s threshold crossing', function () {
  var prev = envelope(win(76, BORNE_A), win(70, BORNE_A), FRAIS);
  var data = { windows: { '5h': win(1, BORNE_B), '7d': win(76, BORNE_A) } };

  var msgs = sandbox.evaluate(data, fresh(), prev);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].title, 'Session — 5 h : reset effectué');
  assert.strictEqual(msgs[1].title, 'Semaine — 7 j : 75 % atteint');
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
