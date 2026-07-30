// Test unitaire de status-source.js. Aucune dependance, aucun framework, comme
// test-usage-source.js. Lance avec : node test-status-source.js
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// status-source.js est charge par importScripts() dans l'extension, pas par require() : pas de
// module.exports a y ajouter. On l'evalue donc dans son propre contexte, comme le ferait le
// service worker, et on relit ses "var" de premier niveau sur ce contexte.
var src = fs.readFileSync(path.join(__dirname, 'status-source.js'), 'utf8');
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---- reponse reelle, capturee le 2026-07-30 sur GET /api/v2/summary.json -------------------
// Un incident etait actif ce jour-la : c'est une vraie fixture de degradation, pas une
// fabrication. Elaguee des champs qu'on ne lit pas (page, created_at/updated_at, position,
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

test('reponse reelle : niveau global "outage", pas le "minor" de l\'indicateur', function () {
  assert.strictEqual(sandbox.parseStatus(REAL_RESPONSE).level, 'outage');
});

test('reponse reelle : 6 composants retenus, 4 en panne', function () {
  var out = sandbox.parseStatus(REAL_RESPONSE);
  assert.strictEqual(out.components.length, 6);

  var down = out.components.filter(function (c) { return c.level === 'outage'; });
  assert.strictEqual(down.length, 4);
  assert.strictEqual(down[0].name, 'claude.ai');
  assert.strictEqual(down[0].status, 'partial_outage');   // valeur brute conservee

  // join() plutot que deepStrictEqual : les tableaux naissent dans le contexte vm, leur
  // Array.prototype n'est pas celui de ce realm et la comparaison stricte echouerait dessus.
  var ok = out.components.filter(function (c) { return c.level === 'operational'; })
    .map(function (c) { return c.name; }).join(' | ');
  assert.strictEqual(ok, 'Claude Console (platform.claude.com) | Claude for Government');
});

test('reponse reelle : titre et impact de l\'incident en cours', function () {
  var out = sandbox.parseStatus(REAL_RESPONSE);
  assert.strictEqual(out.incident.name, 'Elevated errors across many models');
  assert.strictEqual(out.incident.impact, 'major');
});

test('tout nominal : level operational, incident absent (pas null)', function () {
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

test('composant etranger et entree de groupe ecartes, sans peser sur le niveau', function () {
  var out = sandbox.parseStatus({
    status: { indicator: 'none' },
    components: [
      { name: 'claude.ai', status: 'operational', group: false },
      { name: 'Some Other Vendor', status: 'major_outage', group: false },
      { name: 'Claude Services', status: 'major_outage', group: true }   // groupe, pas un etat
    ]
  });
  assert.strictEqual(out.components.length, 1);
  assert.strictEqual(out.level, 'operational');   // le major_outage etranger ne compte pas
});

test('degraded_performance donne "degraded", pas "outage"', function () {
  var out = sandbox.parseStatus({
    status: { indicator: 'none' },
    components: [{ name: 'Claude Code', status: 'degraded_performance', group: false }]
  });
  assert.strictEqual(out.level, 'degraded');
  assert.strictEqual(out.components[0].level, 'degraded');
});

test('un incident deja resolu n\'est pas remonte', function () {
  var out = sandbox.parseStatus({
    status: { indicator: 'none' },
    components: [{ name: 'claude.ai', status: 'operational', group: false }],
    incidents: [{ name: 'Vieil incident', impact: 'minor', resolved_at: '2026-07-29T10:00:00Z' }]
  });
  assert.strictEqual(out.incident, undefined);
});

test('statut de composant inconnu : garde en "degraded", brut conserve', function () {
  var out = sandbox.parseStatus({
    components: [{ name: 'Claude Code', status: 'exploded', group: false }]
  });
  assert.strictEqual(out.level, 'degraded');            // pas d'indicateur : les composants seuls
  assert.strictEqual(out.components[0].level, 'degraded');
  assert.strictEqual(out.components[0].status, 'exploded');
});

test('format totalement inconnu : null, pas d\'exception', function () {
  assert.strictEqual(sandbox.parseStatus(null), null);
  assert.strictEqual(sandbox.parseStatus('oops'), null);
  assert.strictEqual(sandbox.parseStatus({}), null);
  assert.strictEqual(sandbox.parseStatus({ components: 'nope' }), null);
  assert.strictEqual(sandbox.parseStatus({ status: { indicator: 42 } }), null);
});

test('indicateur seul, sans composants : niveau quand meme derive', function () {
  var out = sandbox.parseStatus({ status: { indicator: 'critical' }, components: [] });
  assert.strictEqual(out.level, 'outage');
  assert.strictEqual(out.components.length, 0);
});

// ---- execution ----------------------------------------------------------------------------
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

console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passes');
if (failed) process.exit(1);
