// Test unitaire de usage-source.js. Aucune dependance, aucun framework : coherent avec
// "JS vanilla, pas de build step". Lance avec : node test-usage-source.js
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// usage-source.js est charge par importScripts() dans l'extension, pas par require() : pas
// de module.exports a y ajouter. On l'evalue donc dans son propre contexte, comme le ferait
// le service worker, et on relit ses "var" de premier niveau sur ce contexte.
var src = fs.readFileSync(path.join(__dirname, 'usage-source.js'), 'utf8');
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---- reponse reelle, capturee le 2026-07-29 sur GET /api/organizations/<org>/usage --------
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

test('reponse reelle : pourcentages convertis en fraction, pas en 76*100', function () {
  var out = sandbox.parseUsage(REAL_RESPONSE);
  assert.strictEqual(out.windows['5h'].utilization, 0.76);
  assert.strictEqual(out.windows['7d'].utilization, 0.43);
});

test('reponse reelle : severity mappee, weekly_scoped ignore', function () {
  var out = sandbox.parseUsage(REAL_RESPONSE);
  assert.strictEqual(out.windows['5h'].status, 'approaching_limit');   // severity "warning"
  assert.strictEqual(out.windows['7d'].status, undefined);             // severity "normal"
  assert.strictEqual(Object.keys(out.windows).length, 2);              // pas de 3e fenetre
});

test('reponse reelle : resets_at en secondes Unix, pas la chaine ISO', function () {
  var out = sandbox.parseUsage(REAL_RESPONSE);
  assert.strictEqual(typeof out.windows['5h'].resets_at, 'number');
  assert.strictEqual(out.windows['5h'].resets_at, Math.round(Date.parse(REAL_RESPONSE.limits[0].resets_at) / 1000));
});

test('repli sur five_hour/seven_day quand "limits" est absent', function () {
  var out = sandbox.parseUsage({
    five_hour: { utilization: 10, resets_at: '2026-07-29T10:00:00Z' },
    seven_day: { utilization: 20, resets_at: '2026-08-01T10:00:00Z' }
  });
  assert.strictEqual(out.windows['5h'].utilization, 0.1);
  assert.strictEqual(out.windows['7d'].utilization, 0.2);
  assert.strictEqual(out.windows['5h'].status, undefined);   // pas de severity a la racine
});

test('repli sur five_hour/seven_day quand "limits" est vide', function () {
  var out = sandbox.parseUsage({
    five_hour: { utilization: 5, resets_at: '2026-07-29T10:00:00Z' },
    seven_day: { utilization: 6, resets_at: '2026-08-01T10:00:00Z' },
    limits: []
  });
  assert.strictEqual(out.windows['5h'].utilization, 0.05);
  assert.strictEqual(out.windows['7d'].utilization, 0.06);
});

test('repli par fenetre quand "limits" ne porte que "session"', function () {
  var out = sandbox.parseUsage({
    five_hour: { utilization: 1, resets_at: '2026-07-29T10:00:00Z' },
    seven_day: { utilization: 2, resets_at: '2026-08-01T10:00:00Z' },
    limits: [{ kind: 'session', percent: 99, severity: 'warning', resets_at: '2026-07-29T10:00:00Z' }]
  });
  assert.strictEqual(out.windows['5h'].utilization, 0.99);   // vient de "limits"
  assert.strictEqual(out.windows['7d'].utilization, 0.02);   // repli sur seven_day
});

test('format totalement inconnu : null, pas d\'exception', function () {
  assert.strictEqual(sandbox.parseUsage({ five_hour: { pct: 32 } }), null);
  assert.strictEqual(sandbox.parseUsage(null), null);
  assert.strictEqual(sandbox.parseUsage('oops'), null);
  assert.strictEqual(sandbox.parseUsage({ limits: [{ kind: 'session', percent: 'NaN' }] }), null);
});

test('severity inconnue : fenetre gardee sans status (pas d\'exception)', function () {
  var out = sandbox.parseUsage({
    limits: [{ kind: 'session', percent: 50, severity: 'something_new', resets_at: null }]
  });
  assert.strictEqual(out.windows['5h'].utilization, 0.5);
  assert.strictEqual(out.windows['5h'].status, undefined);
  assert.strictEqual(out.windows['5h'].resets_at, undefined);
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
