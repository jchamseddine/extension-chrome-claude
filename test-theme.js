// Test unitaire des calculs de theme.js. Aucune dependance, aucun framework, comme
// test-usage-source.js. Lance avec : node test-theme.js
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// theme.js est un content script, pas un module : pas de module.exports a y ajouter. On
// l'evalue dans son propre contexte et on relit ses declarations de premier niveau. Le
// sandbox n'a ni "chrome" ni "document" : le cablage de fin de fichier est court-circuite par
// sa garde, seules les fonctions pures sont exercees ici.
var src = fs.readFileSync(path.join(__dirname, 'theme.js'), 'utf8');
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// Luminosite HSL recalculee depuis un hex, pour verifier le sens de l'eclaircissement sans
// reimplementer la conversion complete.
function lum(hex) {
  var r = parseInt(hex.slice(1, 3), 16) / 255;
  var g = parseInt(hex.slice(3, 5), 16) / 255;
  var b = parseInt(hex.slice(5, 7), 16) / 255;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

// ---- accentValid -------------------------------------------------------------------------

test('accentValid : accepte #rrggbb, minuscules comme majuscules', function () {
  assert.strictEqual(sandbox.accentValid('#c6613f'), '#c6613f');
  assert.strictEqual(sandbox.accentValid('#ABC123'), '#ABC123');
});

test('accentValid : rejette tout ce qui n\'est pas exactement #rrggbb', function () {
  assert.strictEqual(sandbox.accentValid(undefined), null);   // cle absente / remove()
  assert.strictEqual(sandbox.accentValid(''), null);
  assert.strictEqual(sandbox.accentValid('red'), null);
  assert.strictEqual(sandbox.accentValid('#fff'), null);      // forme courte non geree
  assert.strictEqual(sandbox.accentValid('#c6613'), null);
  assert.strictEqual(sandbox.accentValid('#c6613fg'), null);
  assert.strictEqual(sandbox.accentValid(12345), null);       // pas une chaine
});

test('accentValid : bloque une injection CSS venue du storage', function () {
  assert.strictEqual(sandbox.accentValid('#000000;} body{display:none'), null);
  assert.strictEqual(sandbox.accentValid('#000;}html{--x:1'), null);
});

// ---- accentLighten -----------------------------------------------------------------------

test('accentLighten : sortie au format #rrggbb', function () {
  assert.ok(/^#[0-9a-f]{6}$/.test(sandbox.accentLighten('#c6613f')));
  assert.ok(/^#[0-9a-f]{6}$/.test(sandbox.accentLighten('#20304f')));
  assert.ok(/^#[0-9a-f]{6}$/.test(sandbox.accentLighten('#000000')));
});

test('accentLighten : +9 points de luminosite sur l\'accent par defaut', function () {
  var out = sandbox.accentLighten('#c6613f');
  // Tolerance d'un cran de quantification 8 bits (1/255) sur l'aller-retour hex -> HSL -> hex.
  assert.ok(Math.abs(lum(out) - (lum('#c6613f') + 0.09)) < 1 / 255,
    '#c6613f -> ' + out + ' : ecart de luminosite ' + (lum(out) - lum('#c6613f')));
});

test('accentLighten : teinte conservee (le rouge reste dominant)', function () {
  var out = sandbox.accentLighten('#c6613f');
  var r = parseInt(out.slice(1, 3), 16);
  var g = parseInt(out.slice(3, 5), 16);
  var b = parseInt(out.slice(5, 7), 16);
  assert.ok(r > g && g > b, 'ordre des canaux non conserve : ' + out);
});

test('accentLighten : eclaircit aussi une teinte sombre de facon visible', function () {
  var out = sandbox.accentLighten('#20304f');
  assert.ok(lum(out) - lum('#20304f') > 0.08, '#20304f -> ' + out);
});

test('accentLighten : gris achromatique, pas de NaN, reste gris', function () {
  var out = sandbox.accentLighten('#808080');
  assert.ok(/^#[0-9a-f]{6}$/.test(out), 'sortie invalide : ' + out);
  assert.strictEqual(out.slice(1, 3), out.slice(3, 5));
  assert.strictEqual(out.slice(3, 5), out.slice(5, 7));
  assert.ok(lum(out) > lum('#808080'));
});

test('accentLighten : noir pur -> gris, pas de division par zero', function () {
  var out = sandbox.accentLighten('#000000');
  assert.strictEqual(out, '#171717');   // L = 0.09 sur les trois canaux
});

test('accentLighten : borne a 1, aucun debordement de canal', function () {
  assert.strictEqual(sandbox.accentLighten('#ffffff'), '#ffffff');
  // Deja tres clair : la borne s'applique sans produire de canal hors 00-ff.
  assert.ok(/^#[0-9a-f]{6}$/.test(sandbox.accentLighten('#fff5f0')));
  assert.ok(/^#[0-9a-f]{6}$/.test(sandbox.accentLighten('#00ff00')));
});

// ---- themePreset -------------------------------------------------------------------------

test('themePreset : accepte une valeur de la liste', function () {
  assert.strictEqual(sandbox.themePreset('thin', sandbox.THEME_WEIGHT_PRESETS, 'normal'), 'thin');
  assert.strictEqual(sandbox.themePreset('bold', sandbox.THEME_WEIGHT_PRESETS, 'normal'), 'bold');
  assert.strictEqual(sandbox.themePreset('round', sandbox.THEME_RADIUS_PRESETS, 'normal'), 'round');
  assert.strictEqual(sandbox.themePreset('serif', sandbox.THEME_FONT_PRESETS, null), 'serif');
});

test('themePreset : le prereglage neutre est ramene a null (rien a injecter)', function () {
  assert.strictEqual(sandbox.themePreset('normal', sandbox.THEME_WEIGHT_PRESETS, 'normal'), null);
  assert.strictEqual(sandbox.themePreset('normal', sandbox.THEME_RADIUS_PRESETS, 'normal'), null);
});

test('themePreset : toute valeur hors liste est traitee comme absente', function () {
  assert.strictEqual(sandbox.themePreset(undefined, sandbox.THEME_WEIGHT_PRESETS, 'normal'), null);
  assert.strictEqual(sandbox.themePreset('', sandbox.THEME_RADIUS_PRESETS, 'normal'), null);
  assert.strictEqual(sandbox.themePreset('THIN', sandbox.THEME_WEIGHT_PRESETS, 'normal'), null);
  assert.strictEqual(sandbox.themePreset(2, sandbox.THEME_RADIUS_PRESETS, 'normal'), null);
  // La valeur finit dans du texte CSS : aucune chaine arbitraire ne doit passer.
  assert.strictEqual(sandbox.themePreset('round;} body{display:none', sandbox.THEME_RADIUS_PRESETS, 'normal'), null);
});

// ---- themeShiftWeight --------------------------------------------------------------------

test('themeShiftWeight : deplace d\'un cran dans les deux sens', function () {
  assert.strictEqual(sandbox.themeShiftWeight('400', 100), '500');
  assert.strictEqual(sandbox.themeShiftWeight('400', -100), '300');
  assert.strictEqual(sandbox.themeShiftWeight(' 600 ', 100), '700');
});

test('themeShiftWeight : borne a [100, 900]', function () {
  assert.strictEqual(sandbox.themeShiftWeight('100', -100), '100');
  assert.strictEqual(sandbox.themeShiftWeight('900', 100), '900');
});

test('themeShiftWeight : un poids non numerique n\'est pas converti', function () {
  assert.strictEqual(sandbox.themeShiftWeight('normal', 100), null);
  assert.strictEqual(sandbox.themeShiftWeight('bold', -100), null);
  assert.strictEqual(sandbox.themeShiftWeight('', 100), null);
  assert.strictEqual(sandbox.themeShiftWeight(undefined, 100), null);   // variable illisible
  assert.strictEqual(sandbox.themeShiftWeight(null, 100), null);
  assert.strictEqual(sandbox.themeShiftWeight(400, 100), null);         // pas une chaine
  assert.strictEqual(sandbox.themeShiftWeight('400 !important', 100), null);
});

// ---- themeScaleLength --------------------------------------------------------------------

test('themeScaleLength : met a l\'echelle en conservant l\'unite', function () {
  assert.strictEqual(sandbox.themeScaleLength('8px', 1.5), '12px');
  assert.strictEqual(sandbox.themeScaleLength('0.5rem', 1.5), '0.75rem');
  assert.strictEqual(sandbox.themeScaleLength(' 1em ', 1.5), '1.5em');
  assert.strictEqual(sandbox.themeScaleLength('10%', 1.5), '15%');
  assert.strictEqual(sandbox.themeScaleLength('.25rem', 1.5), '0.38rem');   // arrondi 2 decimales
});

test('themeScaleLength : zero sans unite reste zero', function () {
  assert.strictEqual(sandbox.themeScaleLength('0', 1.5), '0');
  assert.strictEqual(sandbox.themeScaleLength('0px', 1.5), '0');
});

test('themeScaleLength : format inattendu -> null, aucune valeur devinee', function () {
  assert.strictEqual(sandbox.themeScaleLength('calc(1px + 2px)', 1.5), null);
  assert.strictEqual(sandbox.themeScaleLength('8px 4px', 1.5), null);
  assert.strictEqual(sandbox.themeScaleLength('8pt', 1.5), null);
  assert.strictEqual(sandbox.themeScaleLength('', 1.5), null);
  assert.strictEqual(sandbox.themeScaleLength(undefined, 1.5), null);
  assert.strictEqual(sandbox.themeScaleLength(8, 1.5), null);
  // Une longueur non nulle sans unite est invalide en CSS : seul "0" est tolere.
  assert.strictEqual(sandbox.themeScaleLength('4', 1.5), null);
});

test('themeScaleLength : bloque une injection CSS venue d\'une variable', function () {
  assert.strictEqual(sandbox.themeScaleLength('8px;} body{display:none', 1.5), null);
});

// ---- themeScaleShadow --------------------------------------------------------------------

test('themeScaleShadow : agrandit les longueurs px', function () {
  assert.strictEqual(sandbox.themeScaleShadow('0 1px 2px rgba(0, 0, 0, 0.1)'),
    '0 1.2px 2.4px rgba(0, 0, 0, 0.115)');
});

test('themeScaleShadow : monte l\'alpha sans depasser 1', function () {
  assert.strictEqual(sandbox.themeScaleShadow('0 0 4px rgba(0,0,0,0.9)'), '0 0 4.8px rgba(0,0,0, 1)');
  assert.strictEqual(sandbox.themeScaleShadow('0 0 4px rgb(0 0 0 / 0.2)'), '0 0 4.8px rgb(0 0 0 / 0.23)');
});

test('themeScaleShadow : ne touche pas au canal bleu d\'un rgb() sans alpha', function () {
  assert.strictEqual(sandbox.themeScaleShadow('0 2px 3px rgb(10, 20, 30)'),
    '0 2.4px 3.6px rgb(10, 20, 30)');
});

test('themeScaleShadow : plusieurs couches traitees ensemble', function () {
  assert.strictEqual(sandbox.themeScaleShadow('0 1px 2px rgba(0,0,0,0.2), 0 4px 8px rgba(0,0,0,0.1)'),
    '0 1.2px 2.4px rgba(0,0,0, 0.23), 0 4.8px 9.6px rgba(0,0,0, 0.115)');
});

test('themeScaleShadow : rien d\'exploitable -> null, ombre laissee intacte', function () {
  assert.strictEqual(sandbox.themeScaleShadow('none'), null);
  assert.strictEqual(sandbox.themeScaleShadow(''), null);
  assert.strictEqual(sandbox.themeScaleShadow(undefined), null);
  assert.strictEqual(sandbox.themeScaleShadow('0 0 0 oklch(0.2 0 0 / .05)'), null);   // alpha non extractible
  assert.strictEqual(sandbox.themeScaleShadow('0 0 2px rgb(0 0 0 / 5%)'), '0 0 2.4px rgb(0 0 0 / 5%)');
});

test('themeScaleShadow : bloque une injection CSS venue d\'une variable', function () {
  assert.strictEqual(sandbox.themeScaleShadow('0 1px 2px #000;} body{display:none'), null);
});

// ---- themeDetectFontVar ------------------------------------------------------------------

test('themeDetectFontVar : retrouve la pile appliquee au corps de page', function () {
  var vars = {
    '--font-anthropic-sans': '"Styrene B", ui-sans-serif, sans-serif',
    '--font-anthropic-serif': '"Tiempos Text", ui-serif, serif',
    '--font-anthropic-mono': '"Berkeley Mono", ui-monospace, monospace'
  };
  // getComputedStyle renormalise les guillemets et les espaces : la comparaison doit y survivre.
  assert.strictEqual(sandbox.themeDetectFontVar(vars, 'Styrene B, ui-sans-serif, sans-serif'),
    '--font-anthropic-sans');
  assert.strictEqual(sandbox.themeDetectFontVar(vars, '"Tiempos Text", ui-serif, serif'),
    '--font-anthropic-serif');
});

test('themeDetectFontVar : aucune correspondance -> null, pas de cible devinee', function () {
  var vars = { '--font-anthropic-sans': 'A, sans-serif' };
  assert.strictEqual(sandbox.themeDetectFontVar(vars, 'Helvetica, sans-serif'), null);
  assert.strictEqual(sandbox.themeDetectFontVar(vars, ''), null);
  assert.strictEqual(sandbox.themeDetectFontVar({}, 'A, sans-serif'), null);
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
