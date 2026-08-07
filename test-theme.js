// Unit test for theme.js's computations. No dependency, no framework, like
// test-usage-source.js. Run with: node test-theme.js
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// theme.js is a content script, not a module: no module.exports to add to it. We
// evaluate it in its own context and read back its top-level declarations. The
// sandbox has neither "chrome" nor "document": the wiring at the end of the file is short-circuited by
// its guard, only the pure functions are exercised here.
var src = fs.readFileSync(path.join(__dirname, 'theme.js'), 'utf8');
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// HSL lightness recomputed from a hex, to check the direction of the lightening without
// reimplementing the full conversion.
function lum(hex) {
  var r = parseInt(hex.slice(1, 3), 16) / 255;
  var g = parseInt(hex.slice(3, 5), 16) / 255;
  var b = parseInt(hex.slice(5, 7), 16) / 255;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

// ---- accentValid -------------------------------------------------------------------------

test('accentValid: accepts #rrggbb, lowercase as well as uppercase', function () {
  assert.strictEqual(sandbox.accentValid('#c6613f'), '#c6613f');
  assert.strictEqual(sandbox.accentValid('#ABC123'), '#ABC123');
});

test('accentValid: rejects anything that is not exactly #rrggbb', function () {
  assert.strictEqual(sandbox.accentValid(undefined), null);   // missing key / remove()
  assert.strictEqual(sandbox.accentValid(''), null);
  assert.strictEqual(sandbox.accentValid('red'), null);
  assert.strictEqual(sandbox.accentValid('#fff'), null);      // short form not handled
  assert.strictEqual(sandbox.accentValid('#c6613'), null);
  assert.strictEqual(sandbox.accentValid('#c6613fg'), null);
  assert.strictEqual(sandbox.accentValid(12345), null);       // not a string
});

test('accentValid: blocks a CSS injection coming from storage', function () {
  assert.strictEqual(sandbox.accentValid('#000000;} body{display:none'), null);
  assert.strictEqual(sandbox.accentValid('#000;}html{--x:1'), null);
});

// ---- accentLighten -----------------------------------------------------------------------

test('accentLighten: output in #rrggbb format', function () {
  assert.ok(/^#[0-9a-f]{6}$/.test(sandbox.accentLighten('#c6613f')));
  assert.ok(/^#[0-9a-f]{6}$/.test(sandbox.accentLighten('#20304f')));
  assert.ok(/^#[0-9a-f]{6}$/.test(sandbox.accentLighten('#000000')));
});

test('accentLighten: +9 lightness points on the default accent', function () {
  var out = sandbox.accentLighten('#c6613f');
  // Tolerance of one 8-bit quantization step (1/255) on the hex -> HSL -> hex round trip.
  assert.ok(Math.abs(lum(out) - (lum('#c6613f') + 0.09)) < 1 / 255,
    '#c6613f -> ' + out + ': lightness gap ' + (lum(out) - lum('#c6613f')));
});

test('accentLighten: hue preserved (red stays dominant)', function () {
  var out = sandbox.accentLighten('#c6613f');
  var r = parseInt(out.slice(1, 3), 16);
  var g = parseInt(out.slice(3, 5), 16);
  var b = parseInt(out.slice(5, 7), 16);
  assert.ok(r > g && g > b, 'channel order not preserved: ' + out);
});

test('accentLighten: also lightens a dark hue visibly', function () {
  var out = sandbox.accentLighten('#20304f');
  assert.ok(lum(out) - lum('#20304f') > 0.08, '#20304f -> ' + out);
});

test('accentLighten: achromatic grey, no NaN, stays grey', function () {
  var out = sandbox.accentLighten('#808080');
  assert.ok(/^#[0-9a-f]{6}$/.test(out), 'invalid output: ' + out);
  assert.strictEqual(out.slice(1, 3), out.slice(3, 5));
  assert.strictEqual(out.slice(3, 5), out.slice(5, 7));
  assert.ok(lum(out) > lum('#808080'));
});

test('accentLighten: pure black -> grey, no division by zero', function () {
  var out = sandbox.accentLighten('#000000');
  assert.strictEqual(out, '#171717');   // L = 0.09 on all three channels
});

test('accentLighten: clamped to 1, no channel overflow', function () {
  assert.strictEqual(sandbox.accentLighten('#ffffff'), '#ffffff');
  // Already very light: the clamp applies without producing a channel outside 00-ff.
  assert.ok(/^#[0-9a-f]{6}$/.test(sandbox.accentLighten('#fff5f0')));
  assert.ok(/^#[0-9a-f]{6}$/.test(sandbox.accentLighten('#00ff00')));
});

// ---- themePreset -------------------------------------------------------------------------

test('themePreset: accepts a value from the list', function () {
  assert.strictEqual(sandbox.themePreset('thin', sandbox.THEME_WEIGHT_PRESETS, 'normal'), 'thin');
  assert.strictEqual(sandbox.themePreset('bold', sandbox.THEME_WEIGHT_PRESETS, 'normal'), 'bold');
  assert.strictEqual(sandbox.themePreset('round', sandbox.THEME_RADIUS_PRESETS, 'normal'), 'round');
  assert.strictEqual(sandbox.themePreset('serif', sandbox.THEME_FONT_PRESETS, null), 'serif');
});

test('themePreset: the neutral preset is brought back to null (nothing to inject)', function () {
  assert.strictEqual(sandbox.themePreset('normal', sandbox.THEME_WEIGHT_PRESETS, 'normal'), null);
  assert.strictEqual(sandbox.themePreset('normal', sandbox.THEME_RADIUS_PRESETS, 'normal'), null);
});

test('themePreset: any value outside the list is treated as absent', function () {
  assert.strictEqual(sandbox.themePreset(undefined, sandbox.THEME_WEIGHT_PRESETS, 'normal'), null);
  assert.strictEqual(sandbox.themePreset('', sandbox.THEME_RADIUS_PRESETS, 'normal'), null);
  assert.strictEqual(sandbox.themePreset('THIN', sandbox.THEME_WEIGHT_PRESETS, 'normal'), null);
  assert.strictEqual(sandbox.themePreset(2, sandbox.THEME_RADIUS_PRESETS, 'normal'), null);
  // The value ends up in CSS text: no arbitrary string must get through.
  assert.strictEqual(sandbox.themePreset('round;} body{display:none', sandbox.THEME_RADIUS_PRESETS, 'normal'), null);
});

// ---- themeShiftWeight --------------------------------------------------------------------

test('themeShiftWeight: moves one step in both directions', function () {
  assert.strictEqual(sandbox.themeShiftWeight('400', 100), '500');
  assert.strictEqual(sandbox.themeShiftWeight('400', -100), '300');
  assert.strictEqual(sandbox.themeShiftWeight(' 600 ', 100), '700');
});

test('themeShiftWeight: clamped to [100, 900]', function () {
  assert.strictEqual(sandbox.themeShiftWeight('100', -100), '100');
  assert.strictEqual(sandbox.themeShiftWeight('900', 100), '900');
});

test('themeShiftWeight: a non-numeric weight is not converted', function () {
  assert.strictEqual(sandbox.themeShiftWeight('normal', 100), null);
  assert.strictEqual(sandbox.themeShiftWeight('bold', -100), null);
  assert.strictEqual(sandbox.themeShiftWeight('', 100), null);
  assert.strictEqual(sandbox.themeShiftWeight(undefined, 100), null);   // unreadable variable
  assert.strictEqual(sandbox.themeShiftWeight(null, 100), null);
  assert.strictEqual(sandbox.themeShiftWeight(400, 100), null);         // not a string
  assert.strictEqual(sandbox.themeShiftWeight('400 !important', 100), null);
});

// ---- themeScaleLength --------------------------------------------------------------------

test('themeScaleLength: scales while preserving the unit', function () {
  assert.strictEqual(sandbox.themeScaleLength('8px', 1.5), '12px');
  assert.strictEqual(sandbox.themeScaleLength('0.5rem', 1.5), '0.75rem');
  assert.strictEqual(sandbox.themeScaleLength(' 1em ', 1.5), '1.5em');
  assert.strictEqual(sandbox.themeScaleLength('10%', 1.5), '15%');
  assert.strictEqual(sandbox.themeScaleLength('.25rem', 1.5), '0.38rem');   // rounded to 2 decimals
});

test('themeScaleLength: zero without a unit stays zero', function () {
  assert.strictEqual(sandbox.themeScaleLength('0', 1.5), '0');
  assert.strictEqual(sandbox.themeScaleLength('0px', 1.5), '0');
});

test('themeScaleLength: unexpected format -> null, no guessed value', function () {
  assert.strictEqual(sandbox.themeScaleLength('calc(1px + 2px)', 1.5), null);
  assert.strictEqual(sandbox.themeScaleLength('8px 4px', 1.5), null);
  assert.strictEqual(sandbox.themeScaleLength('8pt', 1.5), null);
  assert.strictEqual(sandbox.themeScaleLength('', 1.5), null);
  assert.strictEqual(sandbox.themeScaleLength(undefined, 1.5), null);
  assert.strictEqual(sandbox.themeScaleLength(8, 1.5), null);
  // A non-zero length without a unit is invalid in CSS: only "0" is tolerated.
  assert.strictEqual(sandbox.themeScaleLength('4', 1.5), null);
});

test('themeScaleLength: blocks a CSS injection coming from a variable', function () {
  assert.strictEqual(sandbox.themeScaleLength('8px;} body{display:none', 1.5), null);
});

// ---- themeScaleShadow --------------------------------------------------------------------

test('themeScaleShadow: enlarges the px lengths', function () {
  assert.strictEqual(sandbox.themeScaleShadow('0 1px 2px rgba(0, 0, 0, 0.1)'),
    '0 1.2px 2.4px rgba(0, 0, 0, 0.115)');
});

test('themeScaleShadow: raises the alpha without exceeding 1', function () {
  assert.strictEqual(sandbox.themeScaleShadow('0 0 4px rgba(0,0,0,0.9)'), '0 0 4.8px rgba(0,0,0, 1)');
  assert.strictEqual(sandbox.themeScaleShadow('0 0 4px rgb(0 0 0 / 0.2)'), '0 0 4.8px rgb(0 0 0 / 0.23)');
});

test('themeScaleShadow: does not touch the blue channel of an rgb() without alpha', function () {
  assert.strictEqual(sandbox.themeScaleShadow('0 2px 3px rgb(10, 20, 30)'),
    '0 2.4px 3.6px rgb(10, 20, 30)');
});

test('themeScaleShadow: several layers processed together', function () {
  assert.strictEqual(sandbox.themeScaleShadow('0 1px 2px rgba(0,0,0,0.2), 0 4px 8px rgba(0,0,0,0.1)'),
    '0 1.2px 2.4px rgba(0,0,0, 0.23), 0 4.8px 9.6px rgba(0,0,0, 0.115)');
});

test('themeScaleShadow: nothing usable -> null, shadow left intact', function () {
  assert.strictEqual(sandbox.themeScaleShadow('none'), null);
  assert.strictEqual(sandbox.themeScaleShadow(''), null);
  assert.strictEqual(sandbox.themeScaleShadow(undefined), null);
  assert.strictEqual(sandbox.themeScaleShadow('0 0 0 oklch(0.2 0 0 / .05)'), null);   // alpha not extractable
  assert.strictEqual(sandbox.themeScaleShadow('0 0 2px rgb(0 0 0 / 5%)'), '0 0 2.4px rgb(0 0 0 / 5%)');
});

test('themeScaleShadow: blocks a CSS injection coming from a variable', function () {
  assert.strictEqual(sandbox.themeScaleShadow('0 1px 2px #000;} body{display:none'), null);
});

// ---- themeDetectFontVar ------------------------------------------------------------------

test('themeDetectFontVar: finds the stack applied to the page body', function () {
  var vars = {
    '--font-anthropic-sans': '"Styrene B", ui-sans-serif, sans-serif',
    '--font-anthropic-serif': '"Tiempos Text", ui-serif, serif',
    '--font-anthropic-mono': '"Berkeley Mono", ui-monospace, monospace'
  };
  // getComputedStyle renormalizes the quotes and the spaces: the comparison must survive that.
  assert.strictEqual(sandbox.themeDetectFontVar(vars, 'Styrene B, ui-sans-serif, sans-serif'),
    '--font-anthropic-sans');
  assert.strictEqual(sandbox.themeDetectFontVar(vars, '"Tiempos Text", ui-serif, serif'),
    '--font-anthropic-serif');
});

test('themeDetectFontVar: no match -> null, no guessed target', function () {
  var vars = { '--font-anthropic-sans': 'A, sans-serif' };
  assert.strictEqual(sandbox.themeDetectFontVar(vars, 'Helvetica, sans-serif'), null);
  assert.strictEqual(sandbox.themeDetectFontVar(vars, ''), null);
  assert.strictEqual(sandbox.themeDetectFontVar({}, 'A, sans-serif'), null);
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
