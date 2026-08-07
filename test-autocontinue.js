// Unit test for autocontinue-source.js: the six phrase variants, the anti-false-positive
// guard, the maximum counter and the pause. No dependency, no framework,
// like test-status-source.js. Run with: node test-autocontinue.js
//
// Only the PURE logic is tested here. The DOM (message selectors, "Continue" button)
// is in autocontinue.js and is not covered: it can only be verified on the real page.
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// autocontinue-source.js is loaded by importScripts() and by <script> in the extension, not
// by require(): no module.exports to add to it. We evaluate it in its own context and
// read back its top-level "var" and "function" on it.
var src = fs.readFileSync(path.join(__dirname, 'autocontinue-source.js'), 'utf8');
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// Nominal settings: active, not paused, fresh counter, unlimited maximum.
function on(over) {
  var s = { enabled: true, paused: false, count: 0, maxCount: 0 };
  Object.keys(over || {}).forEach(function (k) { s[k] = over[k]; });
  return s;
}

// A scan that satisfies both conditions: button visible, phrase in the last message
// only.
function scan(over) {
  var d = {
    hasButton: true,
    lastText: 'I have reached its tool use limit for this response.',
    otherTexts: ['Bonjour', 'Voici le resultat de la recherche.']
  };
  Object.keys(over || {}).forEach(function (k) { d[k] = over[k]; });
  return d;
}

// ---- the six phrase variants -----------------------------------------------------------------

// A real sentence is buried in a paragraph: we test as a substring, not by equality.
var VARIANTES = [
  ['tool-use limit',    'Claude has hit the tool-use limit for this turn.'],
  ['tool use limit',    'I reached the tool use limit while working on this.'],
  ['reached its tool',  'The response reached its tool budget and stopped.'],
  ['exhausted the tool', 'This response exhausted the tool allowance available.'],
  ['tool call limit',   'Stopped: tool call limit exceeded.'],
  ['continuation needed', 'Response incomplete, continuation needed.']
];

VARIANTES.forEach(function (v) {
  test('variant "' + v[0] + '" detected in a paragraph', function () {
    assert.strictEqual(sandbox.acHasLimitPhrase(v[1]), true);
  });
});

test('the six variants are indeed the ones listed', function () {
  assert.strictEqual(sandbox.AC_LIMIT_PHRASES.length, 6);
  assert.strictEqual(sandbox.AC_LIMIT_PHRASES.join('|'),
    VARIANTES.map(function (v) { return v[0]; }).join('|'));
});

test('detection is case-insensitive', function () {
  assert.strictEqual(sandbox.acHasLimitPhrase('TOOL-USE LIMIT reached'), true);
  assert.strictEqual(sandbox.acHasLimitPhrase('Tool Call Limit'), true);
});

test('ordinary, empty or non-string text: no phrase', function () {
  assert.strictEqual(sandbox.acHasLimitPhrase('Voici la reponse complete.'), false);
  assert.strictEqual(sandbox.acHasLimitPhrase(''), false);
  assert.strictEqual(sandbox.acHasLimitPhrase(null), false);
  assert.strictEqual(sandbox.acHasLimitPhrase(42), false);
});

// ---- the two cumulative conditions ------------------------------------------------------------

test('button + phrase in the last message only: we continue', function () {
  var d = sandbox.acDecide(scan(), on());
  assert.strictEqual(d.go, true, d.reason);
});

test('phrase without a Continue button: we do not continue', function () {
  var d = sandbox.acDecide(scan({ hasButton: false }), on());
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('button') !== -1, d.reason);
});

test('button without a phrase in the last message: we do not continue', function () {
  var d = sandbox.acDecide(scan({ lastText: 'Voici la reponse, terminee.' }), on());
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('last message') !== -1, d.reason);
});

// The false positive this guard exists to avoid: a conversation whose SUBJECT is the
// tool-use limit mentions it in every message, and would auto-continue itself endlessly.
test('conversation that discusses the subject: phrase earlier, we do not continue', function () {
  var d = sandbox.acDecide(scan({
    otherTexts: ['Explique-moi comment marche la tool-use limit de Claude.',
                 'Voici comment elle fonctionne.']
  }), on());
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('earlier') !== -1, d.reason);
});

test('phrase in a single old message, absent from the last one: we do not continue', function () {
  var d = sandbox.acDecide(scan({
    lastText: 'Voici la suite.',
    otherTexts: ['Cette reponse a atteint la tool call limit.']
  }), on());
  assert.strictEqual(d.go, false);
});

test('conversation with a single message: nothing "elsewhere", we continue', function () {
  var d = sandbox.acDecide(scan({ otherTexts: [] }), on());
  assert.strictEqual(d.go, true, d.reason);
});

// ---- pause and activation ---------------------------------------------------------------------

test('disabled: we do not continue, even if everything else is in place', function () {
  var d = sandbox.acDecide(scan(), on({ enabled: false }));
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('disabled') !== -1, d.reason);
});

test('paused: we do not continue, without touching the other settings', function () {
  var d = sandbox.acDecide(scan(), on({ paused: true }));
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('paused') !== -1, d.reason);
});

// ---- maximum counter --------------------------------------------------------------------------

test('counter below the maximum: we continue', function () {
  assert.strictEqual(sandbox.acDecide(scan(), on({ count: 9, maxCount: 10 })).go, true);
});

test('counter equal to the maximum: we stop', function () {
  var d = sandbox.acDecide(scan(), on({ count: 10, maxCount: 10 }));
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('maximum') !== -1, d.reason);
});

test('counter beyond the maximum: we stop too', function () {
  assert.strictEqual(sandbox.acDecide(scan(), on({ count: 42, maxCount: 10 })).go, false);
});

test('maximum at 0 = unlimited: a large counter does not block', function () {
  assert.strictEqual(sandbox.acDecide(scan(), on({ count: 5000, maxCount: 0 })).go, true);
});

test('acMaxReached: 0 is unlimited, not "already reached"', function () {
  assert.strictEqual(sandbox.acMaxReached({ count: 0, maxCount: 0 }), false);
  assert.strictEqual(sandbox.acMaxReached({ count: 3, maxCount: 3 }), true);
  assert.strictEqual(sandbox.acMaxReached({ count: 2, maxCount: 3 }), false);
});

// ---- the exact state observed in real use --------------------------------------------------------

// Storage as observed: maxCount at 0, paused at false, and autoContinueCount COMPLETELY ABSENT.
// This is the combination suspected of blocking everything. These three tests fix the contract: it
// blocks nothing, and the missing key behaves identically to a key at zero.
var RELEVE = { autoContinueMaxCount: 0, autoContinuePaused: false };

function releve(over) {
  var o = { autoContinueMaxCount: 0, autoContinuePaused: false };
  Object.keys(over || {}).forEach(function (k) { o[k] = over[k]; });
  return o;
}

test('observed state + enabled: maxCount 0 and a missing counter do NOT block', function () {
  var s = sandbox.acSettings(releve({ autoContinueEnabled: true }));
  assert.strictEqual(s.count, 0, 'a missing key must be read as 0');
  assert.strictEqual(s.maxCount, sandbox.AC_UNLIMITED);
  assert.strictEqual(sandbox.acMaxReached(s), false, 'maxCount 0 read as an exhausted quota');

  var d = sandbox.acDecide(scan(), s);
  assert.strictEqual(d.go, true, d.reason);
});

test('counter ABSENT and counter at 0: strictly the same behavior', function () {
  var absent = sandbox.acSettings(releve({ autoContinueEnabled: true }));
  var zero = sandbox.acSettings(releve({ autoContinueEnabled: true, autoContinueCount: 0 }));

  assert.strictEqual(absent.count, zero.count);
  assert.strictEqual(sandbox.acDecide(scan(), absent).go, sandbox.acDecide(scan(), zero).go);
});

// The only missing value that really blocks — and the one missing from the observation.
test('observed state WITHOUT autoContinueEnabled: that, and only that, is what blocks', function () {
  var d = sandbox.acDecide(scan(), sandbox.acSettings(RELEVE));
  assert.strictEqual(d.go, false);
  assert.ok(d.reason.indexOf('disabled') !== -1, d.reason);
});

test('maxCount missing, null or nonsensical: unlimited, never blocking', function () {
  [undefined, null, '', 'douze', NaN, -1].forEach(function (v) {
    var s = sandbox.acSettings({ autoContinueEnabled: true, autoContinueMaxCount: v });
    assert.strictEqual(s.maxCount, sandbox.AC_UNLIMITED, 'value ' + JSON.stringify(v));
    assert.strictEqual(sandbox.acDecide(scan(), s).go, true, 'value ' + JSON.stringify(v));
  });
});

test('AC_UNLIMITED is indeed 0: the convention is the popup\'s', function () {
  assert.strictEqual(sandbox.AC_UNLIMITED, 0);
});

// ---- settings normalization -------------------------------------------------------------------

test('empty storage: disabled, counter at zero, unlimited maximum', function () {
  var s = sandbox.acSettings({});
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.paused, false);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.maxCount, 0);
});

test('nonsensical values brought back to the cautious behavior', function () {
  var s = sandbox.acSettings({
    autoContinueEnabled: 'oui',      // not a boolean: does not count as active
    autoContinueCount: -3,
    autoContinueMaxCount: 'douze'
  });
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.maxCount, 0);
});

test('maximum clamped to AC_MAX_LIMIT and truncated to an integer', function () {
  assert.strictEqual(sandbox.acSettings({ autoContinueMaxCount: 5000 }).maxCount,
    sandbox.AC_MAX_LIMIT);
  assert.strictEqual(sandbox.acSettings({ autoContinueMaxCount: 12.9 }).maxCount, 12);
  assert.strictEqual(sandbox.AC_MAX_LIMIT, 999);
});

test('the four storage keys are indeed the ones announced', function () {
  assert.strictEqual(sandbox.AC_KEYS.join(','),
    'autoContinueEnabled,autoContinueMaxCount,autoContinueCount,autoContinuePaused');
});

test('scan absent: no exception, we do not continue', function () {
  assert.strictEqual(sandbox.acDecide(null, on()).go, false);
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
