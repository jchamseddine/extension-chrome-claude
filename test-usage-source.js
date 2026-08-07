// Unit test for usage-source.js. No dependency, no framework: consistent with
// "vanilla JS, no build step". Run with: node test-usage-source.js
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// usage-source.js is loaded by importScripts() in the extension, not by require(): no
// module.exports to add to it. So we evaluate it in its own context, as the service
// worker would, and read back its top-level "var" on that context.
var src = fs.readFileSync(path.join(__dirname, 'usage-source.js'), 'utf8');
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---- real response, captured on 2026-07-29 from GET /api/organizations/<org>/usage --------
var REAL_RESPONSE = {
  five_hour: { utilization: 76, resets_at: '2026-07-29T10:49:59.074167+00:00' },
  seven_day: { utilization: 43, resets_at: '2026-08-01T10:59:59.074190+00:00' },
  limits: [
    { kind: 'session', group: 'session', percent: 76, severity: 'warning',
      resets_at: '2026-07-29T10:49:59.074167+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 43, severity: 'normal',
      resets_at: '2026-08-01T10:59:59.074190+00:00', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 46, severity: 'normal',
      resets_at: '2026-08-01T11:00:00.074437+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false }
  ],
  extra_usage: { is_enabled: false, utilization: 0, disabled_reason: 'out_of_credits' },
  spend: { percent: 0, enabled: false, disabled_reason: 'out_of_credits' }
};

test('real response: percentages converted to a fraction, not to 76*100', function () {
  var out = sandbox.parseUsage(REAL_RESPONSE);
  assert.strictEqual(out.windows['5h'].utilization, 0.76);
  assert.strictEqual(out.windows['7d'].utilization, 0.43);
});

test('real response: severity mapped, weekly_scoped ignored', function () {
  var out = sandbox.parseUsage(REAL_RESPONSE);
  assert.strictEqual(out.windows['5h'].status, 'approaching_limit');   // severity "warning"
  assert.strictEqual(out.windows['7d'].status, undefined);             // severity "normal"
  assert.strictEqual(Object.keys(out.windows).length, 2);              // no 3rd window
});

test('real response: resets_at in Unix seconds, not the ISO string', function () {
  var out = sandbox.parseUsage(REAL_RESPONSE);
  assert.strictEqual(typeof out.windows['5h'].resets_at, 'number');
  assert.strictEqual(out.windows['5h'].resets_at, Math.round(Date.parse(REAL_RESPONSE.limits[0].resets_at) / 1000));
});

test('fallback to five_hour/seven_day when "limits" is missing', function () {
  var out = sandbox.parseUsage({
    five_hour: { utilization: 10, resets_at: '2026-07-29T10:00:00Z' },
    seven_day: { utilization: 20, resets_at: '2026-08-01T10:00:00Z' }
  });
  assert.strictEqual(out.windows['5h'].utilization, 0.1);
  assert.strictEqual(out.windows['7d'].utilization, 0.2);
  assert.strictEqual(out.windows['5h'].status, undefined);   // no severity at the root
});

test('fallback to five_hour/seven_day when "limits" is empty', function () {
  var out = sandbox.parseUsage({
    five_hour: { utilization: 5, resets_at: '2026-07-29T10:00:00Z' },
    seven_day: { utilization: 6, resets_at: '2026-08-01T10:00:00Z' },
    limits: []
  });
  assert.strictEqual(out.windows['5h'].utilization, 0.05);
  assert.strictEqual(out.windows['7d'].utilization, 0.06);
});

test('per-window fallback when "limits" only carries "session"', function () {
  var out = sandbox.parseUsage({
    five_hour: { utilization: 1, resets_at: '2026-07-29T10:00:00Z' },
    seven_day: { utilization: 2, resets_at: '2026-08-01T10:00:00Z' },
    limits: [{ kind: 'session', percent: 99, severity: 'warning', resets_at: '2026-07-29T10:00:00Z' }]
  });
  assert.strictEqual(out.windows['5h'].utilization, 0.99);   // comes from "limits"
  assert.strictEqual(out.windows['7d'].utilization, 0.02);   // fallback to seven_day
});

test('completely unknown format: null, not an exception', function () {
  assert.strictEqual(sandbox.parseUsage({ five_hour: { pct: 32 } }), null);
  assert.strictEqual(sandbox.parseUsage(null), null);
  assert.strictEqual(sandbox.parseUsage('oops'), null);
  assert.strictEqual(sandbox.parseUsage({ limits: [{ kind: 'session', percent: 'NaN' }] }), null);
});

test('unknown severity: window kept without a status (no exception)', function () {
  var out = sandbox.parseUsage({
    limits: [{ kind: 'session', percent: 50, severity: 'something_new', resets_at: null }]
  });
  assert.strictEqual(out.windows['5h'].utilization, 0.5);
  assert.strictEqual(out.windows['5h'].status, undefined);
  assert.strictEqual(out.windows['5h'].resets_at, undefined);
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
