// Unit test for status-source.js. No dependency, no framework, like
// test-usage-source.js. Run with: node test-status-source.js
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// status-source.js is loaded by importScripts() in the extension, not by require(): no
// module.exports to add to it. So we evaluate it in its own context, as the
// service worker would, and read back its top-level "var" on that context.
var src = fs.readFileSync(path.join(__dirname, 'status-source.js'), 'utf8');
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---- real response, captured on 2026-07-30 from GET /api/v2/summary.json -------------------
// An incident was active that day: this is a genuine degradation fixture, not a
// fabrication. Pruned of the fields we do not read (page, created_at/updated_at, position,
// incident_updates, reminder_intervals...).
var REAL_RESPONSE = {
  status: { indicator: 'minor', description: 'Minor Service Outage' },
  components: [
    { name: 'claude.ai', status: 'partial_outage', group: false, id: 'rwppv331jlwc' },
    { name: 'Claude Console (platform.claude.com)', status: 'operational', group: false, id: '0qbwn08sd68x' },
    { name: 'Claude API (api.anthropic.com)', status: 'partial_outage', group: false, id: 'k8w3r06qmzrp' },
    { name: 'Claude Code', status: 'partial_outage', group: false, id: 'yyzkbfz2thpt' },
    { name: 'Claude Cowork', status: 'partial_outage', group: false, id: 'bpp5gb3hpjcl' },
    { name: 'Claude for Government', status: 'operational', group: false, id: '0scnb50nvy53' }
  ],
  incidents: [
    { name: 'Elevated errors across many models', status: 'identified', impact: 'major',
      resolved_at: null, monitoring_at: null, shortlink: 'https://stspg.io/c0fmy7628y3w',
      started_at: '2026-07-30T05:57:43.516Z' }
  ],
  scheduled_maintenances: []
};

test('real response: overall level "outage", not the indicator\'s "minor"', function () {
  assert.strictEqual(sandbox.parseStatus(REAL_RESPONSE).level, 'outage');
});

test('real response: 6 components retained, 4 down', function () {
  var out = sandbox.parseStatus(REAL_RESPONSE);
  assert.strictEqual(out.components.length, 6);

  var down = out.components.filter(function (c) { return c.level === 'outage'; });
  assert.strictEqual(down.length, 4);
  assert.strictEqual(down[0].name, 'claude.ai');
  assert.strictEqual(down[0].status, 'partial_outage');   // raw value preserved

  // join() rather than deepStrictEqual: the arrays are born in the vm context, their
  // Array.prototype is not this realm's and the strict comparison would fail on it.
  var ok = out.components.filter(function (c) { return c.level === 'operational'; })
    .map(function (c) { return c.name; }).join(' | ');
  assert.strictEqual(ok, 'Claude Console (platform.claude.com) | Claude for Government');
});

test('real response: title and impact of the ongoing incident', function () {
  var out = sandbox.parseStatus(REAL_RESPONSE);
  assert.strictEqual(out.incident.name, 'Elevated errors across many models');
  assert.strictEqual(out.incident.impact, 'major');
});

test('all nominal: level operational, incident absent (not null)', function () {
  var out = sandbox.parseStatus({
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [
      { name: 'claude.ai', status: 'operational', group: false },
      { name: 'Claude Code', status: 'operational', group: false }
    ],
    incidents: []
  });
  assert.strictEqual(out.level, 'operational');
  assert.strictEqual(out.incident, undefined);
  assert.strictEqual(out.components.length, 2);
});

test('foreign component and group entry discarded, without weighing on the level', function () {
  var out = sandbox.parseStatus({
    status: { indicator: 'none' },
    components: [
      { name: 'claude.ai', status: 'operational', group: false },
      { name: 'Some Other Vendor', status: 'major_outage', group: false },
      { name: 'Claude Services', status: 'major_outage', group: true }   // a group, not a state
    ]
  });
  assert.strictEqual(out.components.length, 1);
  assert.strictEqual(out.level, 'operational');   // the foreign major_outage does not count
});

test('degraded_performance yields "degraded", not "outage"', function () {
  var out = sandbox.parseStatus({
    status: { indicator: 'none' },
    components: [{ name: 'Claude Code', status: 'degraded_performance', group: false }]
  });
  assert.strictEqual(out.level, 'degraded');
  assert.strictEqual(out.components[0].level, 'degraded');
});

test('an already resolved incident is not reported', function () {
  var out = sandbox.parseStatus({
    status: { indicator: 'none' },
    components: [{ name: 'claude.ai', status: 'operational', group: false }],
    incidents: [{ name: 'Old incident', impact: 'minor', resolved_at: '2026-07-29T10:00:00Z' }]
  });
  assert.strictEqual(out.incident, undefined);
});

test('unknown component status: kept as "degraded", raw preserved', function () {
  var out = sandbox.parseStatus({
    components: [{ name: 'Claude Code', status: 'exploded', group: false }]
  });
  assert.strictEqual(out.level, 'degraded');            // no indicator: the components alone
  assert.strictEqual(out.components[0].level, 'degraded');
  assert.strictEqual(out.components[0].status, 'exploded');
});

test('completely unknown format: null, not an exception', function () {
  assert.strictEqual(sandbox.parseStatus(null), null);
  assert.strictEqual(sandbox.parseStatus('oops'), null);
  assert.strictEqual(sandbox.parseStatus({}), null);
  assert.strictEqual(sandbox.parseStatus({ components: 'nope' }), null);
  assert.strictEqual(sandbox.parseStatus({ status: { indicator: 42 } }), null);
});

test('indicator alone, without components: level derived anyway', function () {
  var out = sandbox.parseStatus({ status: { indicator: 'critical' }, components: [] });
  assert.strictEqual(out.level, 'outage');
  assert.strictEqual(out.components.length, 0);
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
