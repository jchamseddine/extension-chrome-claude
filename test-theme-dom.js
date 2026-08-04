// Test de theme.js dans un DOM bouchonne. Lance avec :
//   npm install jsdom      (une seule fois, hors depot)
//   node test-theme-dom.js
//
// Meme regle que test-folders-dom.js et test-export-dom.js : si jsdom est absent, ce fichier
// SE SAUTE au lieu d'echouer. Le depot n'a volontairement ni package.json ni node_modules.
//
// test-theme.js couvre les calculs purs (conversion de couleur, poids, ombres) ; ici on couvre
// ce qu'ils ne peuvent pas voir : ce que theme.js ECRIT reellement dans un document donne.
//
// Raison d'etre principale : le gros spinner « plein ecran » de claude.ai est rendu dans une
// iframe sur https://a.claude.ai/, ou theme.js est desormais injecte (all_frames). Ce document
// est REDUIT — il n'a pas forcement .cds-root sur <html>, ni les tokens --cds-*, ni meme un
// <body> au moment ou le script demarre. Ces tests verrouillent les deux moities du contrat :
// l'accent est surcharge meme quand rien n'est lisible (c'est ce qui repeint le spinner), et
// les trois reglages derives se desactivent proprement au lieu de planter.
'use strict';

var JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (e) {
  console.log('  -- jsdom absent : test du DOM saute (npm install jsdom pour l\'activer)');
  process.exit(0);
}

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var STYLE_ID = '__claude_theme_v1__';

// Les tokens tels que claude.ai les pose. Un document qui les porte doit voir les reglages
// derives s'appliquer ; un document qui ne les porte pas doit les voir se desactiver.
var TOKENS = ':root{--cds-radius:8px;--cds-shadow-sm:0 1px 2px rgba(0,0,0,.4);' +
  '--cds-shadow-md:0 2px 6px rgba(0,0,0,.4);--cds-shadow-lg:0 4px 12px rgba(0,0,0,.4);' +
  '--cds-font-weight-regular:400;--cds-font-weight-medium:500;' +
  '--cds-font-weight-semibold:600;--cds-font-weight-bold:700}';

// runScripts:'outside-only' + getInternalVMContext : meme procede que test-export-dom.js.
// theme.js n'est pas dans une IIFE, ses fonctions restent donc lisibles sur le contexte.
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

  // Simule document_start dans un document encore sans corps : themeCaptureOriginals() doit
  // rendre null sans memoiser, et surtout ne pas lever.
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

// ---- le cas qui motive l'injection dans l'iframe -------------------------------------------

// C'EST le test du bug du spinner : dans un document qui ne porte aucun token du design
// system, l'accent doit quand meme etre ecrit. Il ne depend d'aucune valeur d'origine — c'est
// ce qui lui permet de repeindre un element rendu dans un document reduit.
test('document sans aucun token : l\'accent est surchargé quand même', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    var css = w.css();
    assert.ok(css, 'aucune feuille injectée');
    assert.ok(css.indexOf('--cds-clay-emphasized:#3f6ac6 !important') !== -1, css);
    assert.ok(css.indexOf('--cds-clay:') !== -1, 'la variante éclaircie manque : ' + css);
    assert.strictEqual(w.warns.length, 0, w.warns.join(' | '));
  });
});

// Dans l'iframe, .cds-root peut ne pas exister : c'est :root qui porte la surcharge. Si ce
// selecteur disparaissait de la regle, le spinner cesserait d'etre repeint.
test('la règle vise :root, pas seulement .cds-root', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    assert.ok(w.css().indexOf(':root,html.cds-root,.cds-root{') === 0, w.css());
  });
});

test('document sans <body> (document_start) : aucune exception, l\'accent passe', function () {
  var w = boot('', { accentColor: '#3f6ac6' }, { stripBody: true });
  return w.settle().then(function () {
    assert.ok(w.css().indexOf('--cds-clay-emphasized:#3f6ac6') !== -1, w.css());
  });
});

// ---- desactivation propre des reglages derives ---------------------------------------------

// Les trois autres reglages derivent de valeurs d'origine : sans elles, ils ne doivent RIEN
// ecrire — surtout pas une valeur devinee — et ne pas empecher l'accent de passer.
test('document sans tokens : les réglages dérivés n\'écrivent rien, sans planter', function () {
  var w = boot('', {
    accentColor: '#3f6ac6', radiusPreset: 'round', fontWeightPreset: 'bold', fontFamily: 'serif'
  });
  return w.settle().then(function () {
    var css = w.css();
    assert.ok(css.indexOf('--cds-clay-emphasized') !== -1, 'l\'accent doit passer : ' + css);
    assert.strictEqual(css.indexOf('--cds-radius'), -1, 'rayon écrit sans valeur d\'origine');
    assert.strictEqual(css.indexOf('--cds-font-weight'), -1, 'poids écrit sans valeur d\'origine');
    assert.strictEqual(css.indexOf('--cds-shadow'), -1, 'ombre écrite sans valeur d\'origine');
  });
});

test('aucun réglage : aucune feuille injectée (le document reste intact)', function () {
  var w = boot(TOKENS, {});
  return w.settle().then(function () {
    assert.strictEqual(w.css(), null, 'une feuille a été posée alors que rien n\'est configuré');
  });
});

// ---- document qui porte bien les tokens ----------------------------------------------------

// L'autre moitie du contrat : la ou les tokens existent, les reglages derives s'appliquent
// pour de vrai. Sans ce test, un theme.js qui ne ferait plus jamais rien passerait les tests
// de desactivation ci-dessus sans qu'on le voie.
test('document avec les tokens : les réglages dérivés s\'appliquent', function () {
  var w = boot(TOKENS, { radiusPreset: 'round', fontWeightPreset: 'bold' });
  return w.settle().then(function () {
    var css = w.css();
    assert.ok(css.indexOf('--cds-radius:12px !important') !== -1, css);   // 8px x1,5
    assert.ok(css.indexOf('--cds-font-weight-bold:800 !important') !== -1, css);   // 700 +100
    assert.ok(css.indexOf('--cds-shadow-sm:') !== -1, 'ombres non accentuées : ' + css);
  });
});

test('préréglage « carré » : rayon à 0 et ombres supprimées', function () {
  var w = boot(TOKENS, { radiusPreset: 'square' });
  return w.settle().then(function () {
    var css = w.css();
    assert.ok(css.indexOf('--cds-radius:0 !important') !== -1, css);
    assert.ok(css.indexOf('--cds-shadow-sm:none !important') !== -1, css);
  });
});

// ---- instrumentation du bug de propagation intermittente (TEMPORAIRE) ----------------------
// Ces tests couvrent les POINTS DE MESURE eux-memes. Ce n'est pas du zele : un observateur muet
// parce que casse se lirait exactement comme « hypothese infirmee », et c'est ce contresens-la
// qui a deja coute un tour de diagnostic avec le log « etat lu » verrouille au premier
// chargement. Un instrument qu'on n'a pas teste ne vaut pas mieux que pas d'instrument.

test('l\'observateur détecte le retrait de la balise par le site', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    var el = w.el();
    assert.ok(el, 'balise absente avant le retrait');
    el.parentNode.removeChild(el);            // ce que ferait un re-rendu du site
    return w.settle(30);
  }).then(function () {
    assert.ok(w.warns.some(function (m) { return m.indexOf('balise RETIREE du DOM') !== -1; }),
      'le retrait n\'a PAS été détecté — un observateur muet se lit à tort comme « hypothèse ' +
      'infirmée » : ' + w.warns.join(' | '));
  });
});

// Le retrait doit etre CONSTATE, pas repare, tant que THEME_REINJECT vaut false. Ce test fige
// la porte : le jour ou on la promeut, il echoue et rappelle de le mettre a jour.
test('THEME_REINJECT à false : le retrait est constaté, pas réparé', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    assert.strictEqual(w.win.THEME_REINJECT, false, 'la porte de réinjection a été promue');
    w.el().parentNode.removeChild(w.el());
    return w.settle(30);
  }).then(function () {
    assert.strictEqual(w.el(), null, 'la balise a été réinjectée alors que la porte est fermée');
  });
});

// Le contre-test de la promotion : avec la porte ouverte, la balise revient. Il prouve que
// promouvoir THEME_REINJECT suffit vraiment, sans avoir a le decouvrir en production.
test('THEME_REINJECT à true : la balise est reposée après un retrait', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    w.win.THEME_REINJECT = true;
    w.el().parentNode.removeChild(w.el());
    return w.settle(30);
  }).then(function () {
    var el = w.el();
    assert.ok(el, 'la balise n\'a pas été reposée');
    assert.ok(el.textContent.indexOf('--cds-clay-emphasized:#3f6ac6') !== -1, el.textContent);
  });
});

// Le log dont la portee etait fausse : il doit nommer sa cause, sinon le voir en console ne
// prouve rien sur l'origine de la lecture.
test('chaque lecture de storage est tracée, avec sa cause', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    assert.ok(w.logs.some(function (m) { return m.indexOf('etat lu (chargement initial)') !== -1; }),
      w.logs.join(' | '));
  });
});

// L'audit doit rapporter la valeur CALCULEE, pas celle qu'on croit avoir ecrite : c'est elle qui
// separe « balise retiree » de « regle plus specifique qui gagne ».
test('l\'audit rapporte la concordance entre couleur demandée et calculée', function () {
  var w = boot('', { accentColor: '#3f6ac6' });
  return w.settle().then(function () {
    var audit = w.logs.filter(function (m) { return m.indexOf('[theme] audit') === 0; });
    assert.strictEqual(audit.length, 1, 'un audit par rendu attendu : ' + w.logs.join(' | '));
    assert.ok(audit[0].indexOf('"demande":"#3f6ac6"') !== -1, audit[0]);
    assert.ok(audit[0].indexOf('"calcule"') !== -1, audit[0]);
    assert.ok(audit[0].indexOf('"concordant"') !== -1, audit[0]);
    assert.ok(audit[0].indexOf('"attachee":true') !== -1, audit[0]);
  });
});

// ---- execution ----------------------------------------------------------------------------
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
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passes');
  process.exit(failed ? 1 : 0);
});
