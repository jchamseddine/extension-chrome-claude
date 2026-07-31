// Test unitaire de autocontinue.js — la moitie qui touche au DOM. Aucune dependance, aucun
// framework, comme test-autocontinue.js. Lance avec : node test-autocontinue-dom.js
//
// Ce que ce fichier verrouille, et que la logique pure ne peut pas couvrir :
//   - la distinction de role par action-bar-retry/action-bar-read-aloud (assistant) vs
//     action-bar-edit (utilisateur) : sans elle, un message utilisateur recyclerait dans
//     otherTexts/lastText et la detection se declarerait elle-meme en faux positif ;
//   - l'ancrage du "dernier message" au bouton Continue plutot qu'au dernier element renvoye
//     par querySelectorAll : le bug reel corrige ici etait un element assistant-like plus bas
//     dans le DOM (carte de citation, apercu...) qui usurpait la position "dernier" ;
//   - la duplication sr-only/aria-hidden a l'interieur d'un meme message, qui doublait le texte
//     capture si on se contentait d'un .innerText brut ;
//   - l'absence de double-clic quand le service worker et le MutationObserver reveillent
//     acTick() au meme instant — la garantie annoncee dans le README.
//
// Le DOM est bouchonne au minimum : querySelectorAll(AC_MESSAGE_ROW_SELECTOR) route sur un
// dictionnaire de selecteurs, chaque ligne simulee porte son propre querySelector() pour le
// signal de role et un arbre childNodes/nodeType/matches() minimal pour la lecture de texte, le
// bouton porte un closest() bouchonne, et le bouton compte ses clics. C'est le meme procede
// vm.runInContext que les autres tests, avec en plus le bouchon de chrome et de document que le
// monde isole fournirait.
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var LIMIT_TEXT = 'This response reached its tool use limit.';

var clicks = 0;
var store = {};
var dom = {};

// closestRow, optionnel : la ligne que closest(AC_MESSAGE_ROW_SELECTOR) doit retrouver, comme
// si le bouton etait reellement imbrique dedans dans le DOM. Absent par defaut, pour couvrir le
// repli (bouton non imbrique dans une ligne connue).
function button(closestRow) {
  return {
    innerText: 'Continue', offsetParent: {}, click: function () { clicks++; },
    closest: function () { return closestRow || null; }
  };
}

// Une ligne de conversation bouchonnee : "signals" liste les data-testid presents dans sa barre
// d'actions (ex. ['action-bar-retry'], ['action-bar-edit']). querySelector() ne sert qu'a
// repondre a l'unique requete qu'acIsAssistantRow() emet (AC_ASSISTANT_SIGNAL_SELECTOR).
// nodeType/matches()/childNodes simulent ce qu'acVisibleText() parcourt : un seul noeud texte,
// jamais masque (matches() repond toujours faux), comme un message ordinaire sans duplication
// d'accessibilite.
function row(text, signals) {
  return {
    nodeType: 1,
    matches: function () { return false; },
    childNodes: [{ nodeType: 3, nodeValue: text }],
    querySelector: function (sel) {
      for (var i = 0; i < signals.length; i++) {
        if (sel.indexOf(signals[i]) !== -1) return {};
      }
      return null;
    }
  };
}

// Meme chose que row(), mais avec une SECONDE copie du texte marquee masquee — le motif
// d'accessibilite reellement observe (sr-only/aria-hidden) qui doublait le texte capture. La
// copie masquee repond vrai a matches() exactement pour AC_HIDDEN_TEXT_SELECTOR, comme le
// ferait Element.prototype.matches() sur le vrai selecteur.
function rowWithHiddenDuplicate(text, signals) {
  return {
    nodeType: 1,
    matches: function () { return false; },
    childNodes: [
      { nodeType: 3, nodeValue: text },
      {
        nodeType: 1,
        matches: function (sel) { return sel === sandbox.AC_HIDDEN_TEXT_SELECTOR; },
        childNodes: [{ nodeType: 3, nodeValue: text }]
      }
    ],
    querySelector: function (sel) {
      for (var i = 0; i < signals.length; i++) {
        if (sel.indexOf(signals[i]) !== -1) return {};
      }
      return null;
    }
  };
}

// Etat de depart : conversation alternee utilisateur/assistant, le dernier message assistant
// portant la phrase de limite, et un bouton visible dont closest() ne retrouve rien (repli sur
// le dernier trouve dans l'ordre du DOM, qui coincide ici avec le bon message). Chaque message
// assistant porte AUSSI action-bar-copy, pour verrouiller que ce signal-la (present sur les deux
// roles) n'est jamais ce qui fait passer une ligne pour assistant.
function reset() {
  clicks = 0;
  store = { autoContinueEnabled: true, autoContinueCount: 0, autoContinueMaxCount: 0 };
  dom = {
    '.group\\/message-row': [
      row('Salut, peux-tu m\'aider ?', ['action-bar-edit']),
      row('Bonjour', ['action-bar-retry', 'action-bar-copy']),
      row('Une autre question', ['action-bar-edit']),
      row(LIMIT_TEXT, ['action-bar-read-aloud', 'action-bar-copy'])
    ],
    'button, [role="button"]': [button()]
  };
}

// Le journal de diagnostic est un livrable a part entiere : c'est lui qui doit dire pourquoi
// rien ne se declenche. On le capture pour pouvoir l'asserter.
var logs = [];

var sandbox = {
  console: { log: function (m) { logs.push(String(m)); }, warn: function () {} },
  Promise: Promise, Date: Date, Math: Math, Number: Number, isFinite: isFinite,
  String: String, Object: Object, Array: Array,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  // Le MutationObserver n'est jamais declenche ici : les tests appellent acTick() en direct,
  // ce qui est justement le chemin que les deux declencheurs partagent.
  MutationObserver: function () { return { observe: function () {} }; },
  document: {
    documentElement: { appendChild: function () {} },
    querySelectorAll: function (sel) { return dom[sel] || []; },
    getElementById: function () { return null; },
    createElement: function () { return { style: {}, id: '', textContent: '' }; }
  },
  chrome: {
    runtime: { id: 'test' },
    storage: {
      local: {
        get: function () { return Promise.resolve(store); },
        set: function (o) { Object.assign(store, o); return Promise.resolve(); }
      },
      onChanged: { addListener: function () {} }
    }
  }
};

reset();
vm.createContext(sandbox);
['autocontinue-source.js', 'autocontinue.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), sandbox);
});

// Les tests sont asynchrones (acTick rend une promesse) : on les enchaine, contrairement aux
// autres fichiers de test du depot ou tout est synchrone.
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// Remet le monde ET les compteurs internes du content script a zero entre deux tests.
function fresh() {
  reset();
  logs.length = 0;
  sandbox.acLastClickAt = 0;
  sandbox.acBusy = false;
  sandbox.acLastLog = '';   // anti-repetition du journal
}

function journal() {
  return logs.filter(function (l) { return l.indexOf('diagnostic') !== -1; }).join('\n');
}

// ---- lecture du DOM -------------------------------------------------------------------------

test('acScan : les messages utilisateur sont ecartes, seuls les assistants restent', function () {
  fresh();
  var scan = sandbox.acScan();
  assert.strictEqual(scan.hasButton, true);
  assert.strictEqual(scan.lastText, LIMIT_TEXT);
  assert.strictEqual(scan.otherTexts.length, 1);
  assert.strictEqual(scan.otherTexts[0], 'Bonjour');
  assert.strictEqual(scan.messageCount, 2);
});

// ---- distinction de role ----------------------------------------------------------------------

test('acIsAssistantRow : action-bar-retry seul suffit', function () {
  assert.strictEqual(sandbox.acIsAssistantRow(row('x', ['action-bar-retry'])), true);
});

test('acIsAssistantRow : action-bar-read-aloud seul suffit', function () {
  assert.strictEqual(sandbox.acIsAssistantRow(row('x', ['action-bar-read-aloud'])), true);
});

test('acIsAssistantRow : action-bar-edit (utilisateur) n est pas assistant', function () {
  assert.strictEqual(sandbox.acIsAssistantRow(row('x', ['action-bar-edit'])), false);
});

// La fausse piste deja ecartee : action-bar-copy existe sur les deux roles, donc seul ne doit
// jamais faire passer une ligne pour assistant.
test('acIsAssistantRow : action-bar-copy seul (present sur les deux roles) ne suffit pas',
  function () {
    assert.strictEqual(sandbox.acIsAssistantRow(row('x', ['action-bar-copy'])), false);
  });

test('acIsAssistantRow : action-bar-copy + action-bar-edit reste utilisateur', function () {
  assert.strictEqual(sandbox.acIsAssistantRow(row('x', ['action-bar-copy', 'action-bar-edit'])),
    false);
});

test('acMessages : une ligne sans aucun signal de role (indeterminee) est ignoree', function () {
  fresh();
  dom['.group\\/message-row'].push(row('Ligne sans barre d\'actions', []));
  var scan = sandbox.acScan();
  assert.strictEqual(scan.messageCount, 2, 'une ligne indeterminee ne doit pas etre comptee');
});

// ---- ancrage du "dernier message" au bouton Continue -------------------------------------------

// Le bug reel corrige ici : un element assistant-like plus BAS dans le document (carte de
// citation, apercu d'historique...) que le vrai dernier message se faisait passer pour "dernier"
// simplement parce qu'il arrivait en dernier dans querySelectorAll(). Le bouton, confirme
// visible, doit trancher a la place de l'ordre du DOM.
test('acScan : un leurre plus bas dans le DOM n usurpe pas "dernier" quand le bouton l ancre',
  function () {
    fresh();
    var vraiDernier = row(LIMIT_TEXT, ['action-bar-retry']);
    var leurre = row('Analyse financière X-FAB Silicon Foundries — sans rapport, dupliqué ' +
      'depuis une autre conversation.', ['action-bar-read-aloud']);
    dom['.group\\/message-row'] = [row('Bonjour', ['action-bar-retry']), vraiDernier, leurre];
    dom['button, [role="button"]'] = [button(vraiDernier)];

    var scan = sandbox.acScan();
    assert.strictEqual(scan.lastText, LIMIT_TEXT);
    assert.strictEqual(scan.lastRowAnchored, true);
    assert.ok(scan.otherTexts.indexOf(leurre.childNodes[0].nodeValue) !== -1,
      'le leurre doit rester lisible dans otherTexts, juste pas pris pour "dernier"');
  });

test('acScan : repli sur le dernier trouvé dans l ordre du DOM si le bouton n est imbriqué ' +
  'dans aucune ligne connue', function () {
  fresh();   // button() par defaut : closest() ne retrouve rien
  var scan = sandbox.acScan();
  assert.strictEqual(scan.lastText, LIMIT_TEXT);
  assert.strictEqual(scan.lastRowAnchored, false);
});

// ---- duplication sr-only / aria-hidden a l interieur d un message ------------------------------

test('acVisibleText : la copie sr-only n est pas concaténée au texte visible', function () {
  fresh();
  var dernier = rowWithHiddenDuplicate(LIMIT_TEXT, ['action-bar-retry']);
  dom['.group\\/message-row'] = [row('Bonjour', ['action-bar-retry']), dernier];
  dom['button, [role="button"]'] = [button(dernier)];

  var scan = sandbox.acScan();
  assert.strictEqual(scan.lastText, LIMIT_TEXT,
    'le texte masqué a été concaténé au texte visible : ' + JSON.stringify(scan.lastText));
});

test('acContinueButton : un bouton invisible est ignore', function () {
  fresh();
  dom['button, [role="button"]'] = [{ innerText: 'Continue', offsetParent: null }];
  assert.strictEqual(sandbox.acScan().hasButton, false);
});

test('acContinueButton : « Continuer » d une interface francaise est reconnu', function () {
  fresh();
  dom['button, [role="button"]'] = [{ innerText: 'Continuer', offsetParent: {} }];
  assert.strictEqual(sandbox.acScan().hasButton, true);
});

test('acContinueButton : un bouton quelconque ne passe pas', function () {
  fresh();
  dom['button, [role="button"]'] = [{ innerText: 'Copier', offsetParent: {} }];
  assert.strictEqual(sandbox.acScan().hasButton, false);
});

// ---- verrou anti-double-clic ------------------------------------------------------------------

test('deux ticks simultanes (worker + page) : un seul clic', function () {
  fresh();
  return Promise.all([sandbox.acTick('sw'), sandbox.acTick('page')]).then(function (r) {
    assert.strictEqual(clicks, 1, 'double-clic : ' + clicks + ' clics');
    assert.strictEqual(store.autoContinueCount, 1);
    assert.ok(r.indexOf('deja en cours') !== -1, r.join(' / '));
  });
});

test('tick suivant dans le delai de garde : aucun clic', function () {
  fresh();
  return sandbox.acTick('sw').then(function () {
    assert.strictEqual(clicks, 1);
    return sandbox.acTick('sw');
  }).then(function (r) {
    assert.strictEqual(r, 'delai de garde');
    assert.strictEqual(clicks, 1);
  });
});

test('delai de garde ecoule, limite toujours la : on reclique', function () {
  fresh();
  return sandbox.acTick('sw').then(function () {
    sandbox.acLastClickAt = 0;   // simule les 5 s ecoulees
    return sandbox.acTick('sw');
  }).then(function () {
    assert.strictEqual(clicks, 2);
    assert.strictEqual(store.autoContinueCount, 2);
  });
});

// ---- les reglages arretent bien le clic reel ---------------------------------------------------

test('maximum atteint : aucun clic, compteur inchange', function () {
  fresh();
  store.autoContinueCount = 3;
  store.autoContinueMaxCount = 3;
  return sandbox.acTick('sw').then(function (r) {
    assert.ok(r.indexOf('maximum') !== -1, r);
    assert.strictEqual(clicks, 0);
    assert.strictEqual(store.autoContinueCount, 3);
  });
});

test('en pause : aucun clic', function () {
  fresh();
  store.autoContinuePaused = true;
  return sandbox.acTick('page').then(function (r) {
    assert.ok(r.indexOf('pause') !== -1, r);
    assert.strictEqual(clicks, 0);
  });
});

test('desactive : aucun clic', function () {
  fresh();
  store.autoContinueEnabled = false;
  return sandbox.acTick('page').then(function (r) {
    assert.ok(r.indexOf('desactive') !== -1, r);
    assert.strictEqual(clicks, 0);
  });
});

test('bouton disparu entre la detection et le clic : aucune exception', function () {
  fresh();
  dom['button, [role="button"]'] = [];
  return sandbox.acTick('sw').then(function (r) {
    assert.ok(r.indexOf('bouton') !== -1, r);
    assert.strictEqual(clicks, 0);
  });
});

test('phrase presente plus haut : aucun clic malgre le bouton', function () {
  fresh();
  dom['.group\\/message-row'] = [
    row('Parlons de la tool-use limit.', ['action-bar-retry']),
    row(LIMIT_TEXT, ['action-bar-read-aloud'])
  ];
  return sandbox.acTick('page').then(function (r) {
    assert.ok(r.indexOf('plus haut') !== -1, r);
    assert.strictEqual(clicks, 0);
  });
});

// ---- journal de diagnostic -----------------------------------------------------------------

// Le cas rapporte : bouton bien visible, mais aucun clic. Sans le journal, impossible de
// distinguer « phrase absente » de « desactive » ou de « compteur epuise ».
test('bouton visible mais phrase absente : le journal dit pourquoi ET recopie le message',
  function () {
    fresh();
    var vrai = 'Claude a atteint la limite d’utilisation d’outils pour cette réponse.';
    dom['.group\\/message-row'] = [row(vrai, ['action-bar-retry'])];

    return sandbox.acTick('sw').then(function () {
      var j = journal();
      assert.ok(j, 'aucun diagnostic alors qu\'un bouton est visible');
      assert.ok(j.indexOf('bouton « Continue »  : trouvé') !== -1, j);
      assert.ok(j.indexOf('ABSENTE du dernier message') !== -1, j);
      assert.ok(j.indexOf('DÉCISION             : ignore') !== -1, j);
      // Le plus utile : la formulation reelle, pour l'ajouter a AC_LIMIT_PHRASES.
      assert.ok(j.indexOf('limite d’utilisation d’outils') !== -1,
        'le message réel doit être recopié pour qu\'on puisse relever la phrase');
    });
  });

// Ce que le journal doit prouver sans ambiguïté avant de conclure sur la phrase de limite :
// quel sélecteur et quelle ligne (par sa position) ont fourni le texte, et si cette ligne a été
// retrouvée en s'ancrant au bouton Continue ou par repli sur l'ordre du DOM.
test('journal : la ligne "dernier message lu" donne le sélecteur, l index et l ancrage',
  function () {
    fresh();
    var dernier = row(LIMIT_TEXT, ['action-bar-retry']);
    dom['.group\\/message-row'] = [row('Bonjour', ['action-bar-retry']), dernier];
    dom['button, [role="button"]'] = [button(dernier)];

    return sandbox.acTick('sw').then(function () {
      var j = journal();
      assert.ok(j.indexOf('.group\\/message-row') !== -1, j);
      assert.ok(j.indexOf('index 1/1') !== -1, j);
      assert.ok(j.indexOf('ancré au bouton Continue (fiable)') !== -1, j);
    });
  });

// Le soupcon du diagnostic : un bouton present mais ecarte par le test de visibilite serait
// indiscernable d'une absence de bouton sans ce comptage.
test('bouton au bon libellé mais jugé invisible : le journal le distingue d\'une absence',
  function () {
    fresh();
    dom['button, [role="button"]'] = [{ innerText: 'Continue', offsetParent: null }];

    return sandbox.acTick('sw').then(function () {
      var j = journal();
      assert.ok(j.indexOf('ÉCARTÉ — 1 au bon libellé mais jugé invisible') !== -1, j);
    });
  });

// L'hypothese de virtualisation posee dans autocontinue.js : si aucune ligne n'est reconnue
// assistant alors qu'un bouton "Continue" est visible, le journal doit le dire explicitement
// plutot que de se taire sur un scan.messageCount a 0.
test('bouton visible mais aucun message assistant reconnu : le journal alerte', function () {
  fresh();
  dom['.group\\/message-row'] = [row('Salut', ['action-bar-edit'])];

  return sandbox.acTick('sw').then(function () {
    var j = journal();
    assert.ok(j.indexOf('ATTENTION') !== -1 && j.indexOf('aucun message assistant') !== -1, j);
  });
});

test('compteur épuisé : le journal donne les deux nombres', function () {
  fresh();
  store.autoContinueCount = 5;
  store.autoContinueMaxCount = 5;

  return sandbox.acTick('sw').then(function () {
    assert.ok(journal().indexOf('compteur             : 5 / 5') !== -1, journal());
  });
});

test('maximum à 0 : le journal dit « illimité », pas « 0 »', function () {
  fresh();
  return sandbox.acTick('sw').then(function () {
    assert.ok(journal().indexOf('compteur             : 0 / illimité') !== -1, journal());
  });
});

// Sans ce silence, le sondage a 5 s noierait la console de l'onglet.
test('aucun bouton nulle part : le journal se tait', function () {
  fresh();
  dom['button, [role="button"]'] = [];

  return sandbox.acTick('sw').then(function () {
    assert.strictEqual(journal(), '', 'le diagnostic doit rester silencieux sans bouton');
  });
});

test('état identique répété : journalisé une seule fois', function () {
  fresh();
  dom['.group\\/message-row'] = [row('Rien à signaler.', ['action-bar-retry'])];

  return sandbox.acTick('sw').then(function () {
    var apresUn = logs.length;
    assert.ok(apresUn > 0);
    return sandbox.acTick('sw').then(function () {
      assert.strictEqual(logs.length, apresUn, 'le même état a été journalisé deux fois');
    });
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
  if (failed) process.exit(1);
});
