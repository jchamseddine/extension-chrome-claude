// Unit test for autocontinue.js — the half that touches the DOM. No dependency, no
// framework, like test-autocontinue.js. Run with: node test-autocontinue-dom.js
//
// What this file locks down, and that the pure logic cannot cover:
//   - role distinction through action-bar-retry/action-bar-read-aloud (assistant) vs
//     action-bar-edit (user): without it, a user message would recycle into
//     otherTexts/lastText and detection would declare itself a false positive;
//   - anchoring the "last message" to the Continue button rather than to the last element returned
//     by querySelectorAll: the real bug fixed here was an assistant-like element lower
//     in the DOM (citation card, preview...) that usurped the "last" position;
//   - the sr-only/aria-hidden duplication inside a single message, which doubled the captured
//     text if we settled for a raw .innerText;
//   - the absence of a double click when the service worker and the MutationObserver wake
//     acTick() at the same instant — the guarantee announced in the README.
//
// The DOM is stubbed to a minimum: querySelectorAll(AC_MESSAGE_ROW_SELECTOR) routes on a
// selector dictionary, each simulated row carries its own querySelector() for the
// role signal and a minimal childNodes/nodeType/matches() tree for text reading, the
// button carries a stubbed closest(), and the button counts its clicks. It is the same
// vm.runInContext technique as the other tests, plus the chrome and document stubs the
// isolated world would provide.
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var LIMIT_TEXT = 'This response reached its tool use limit.';

var clicks = 0;
var store = {};
var dom = {};

// closestRow, optional: the row that closest(AC_MESSAGE_ROW_SELECTOR) must find again, as
// if the button were really nested inside it in the DOM. Absent by default, to cover the
// fallback (button not nested in a known row).
function button(closestRow) {
  return {
    innerText: 'Continue', offsetParent: {}, click: function () { clicks++; },
    closest: function () { return closestRow || null; }
  };
}

// A stubbed conversation row: "signals" lists the data-testid present in its action
// bar (e.g. ['action-bar-retry'], ['action-bar-edit']). querySelector() only serves to
// answer the single query acIsAssistantRow() emits (AC_ASSISTANT_SIGNAL_SELECTOR).
// nodeType/matches()/childNodes simulate what acVisibleText() walks: a single text node,
// never hidden (matches() always answers false), like an ordinary message without accessibility
// duplication.
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

// Same as row(), but with a SECOND copy of the text marked hidden — the accessibility
// pattern actually observed (sr-only/aria-hidden) that doubled the captured text. The
// hidden copy answers true to matches() exactly for AC_HIDDEN_TEXT_SELECTOR, as
// Element.prototype.matches() would on the real selector.
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

// Starting state: alternating user/assistant conversation, the last assistant message
// carrying the limit phrase, and a visible button whose closest() finds nothing (fallback to
// the last one found in DOM order, which here coincides with the right message). Each assistant
// message ALSO carries action-bar-copy, to lock down that this signal (present on both
// roles) is never what makes a row pass for an assistant one.
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

// The diagnostic journal is a deliverable in its own right: it is what must say why
// nothing fires. We capture it so we can assert on it.
var logs = [];

var sandbox = {
  console: { log: function (m) { logs.push(String(m)); }, warn: function () {} },
  Promise: Promise, Date: Date, Math: Math, Number: Number, isFinite: isFinite,
  String: String, Object: Object, Array: Array,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  // The MutationObserver is never fired here: the tests call acTick() directly,
  // which is precisely the path the two triggers share.
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

// The tests are asynchronous (acTick returns a promise): we chain them, unlike the
// other test files in the repo where everything is synchronous.
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// Resets the world AND the content script's internal counters between two tests.
function fresh() {
  reset();
  logs.length = 0;
  sandbox.acLastClickAt = 0;
  sandbox.acBusy = false;
  sandbox.acLastLog = '';   // journal anti-repetition
}

function journal() {
  return logs.filter(function (l) { return l.indexOf('diagnostic') !== -1; }).join('\n');
}

// ---- DOM reading ------------------------------------------------------------------------------

test('acScan: user messages are discarded, only the assistant ones remain', function () {
  fresh();
  var scan = sandbox.acScan();
  assert.strictEqual(scan.hasButton, true);
  assert.strictEqual(scan.lastText, LIMIT_TEXT);
  assert.strictEqual(scan.otherTexts.length, 1);
  assert.strictEqual(scan.otherTexts[0], 'Bonjour');
  assert.strictEqual(scan.messageCount, 2);
});

// ---- role distinction -------------------------------------------------------------------------

test('acIsAssistantRow: action-bar-retry alone is enough', function () {
  assert.strictEqual(sandbox.acIsAssistantRow(row('x', ['action-bar-retry'])), true);
});

test('acIsAssistantRow: action-bar-read-aloud alone is enough', function () {
  assert.strictEqual(sandbox.acIsAssistantRow(row('x', ['action-bar-read-aloud'])), true);
});

test('acIsAssistantRow: action-bar-edit (user) is not assistant', function () {
  assert.strictEqual(sandbox.acIsAssistantRow(row('x', ['action-bar-edit'])), false);
});

// The false lead already ruled out: action-bar-copy exists on both roles, so on its own it must
// never make a row pass for an assistant one.
test('acIsAssistantRow: action-bar-copy alone (present on both roles) is not enough',
  function () {
    assert.strictEqual(sandbox.acIsAssistantRow(row('x', ['action-bar-copy'])), false);
  });

test('acIsAssistantRow: action-bar-copy + action-bar-edit stays user', function () {
  assert.strictEqual(sandbox.acIsAssistantRow(row('x', ['action-bar-copy', 'action-bar-edit'])),
    false);
});

test('acMessages: a row without any role signal (undetermined) is ignored', function () {
  fresh();
  dom['.group\\/message-row'].push(row('Ligne sans barre d\'actions', []));
  var scan = sandbox.acScan();
  assert.strictEqual(scan.messageCount, 2, 'an undetermined row must not be counted');
});

// ---- anchoring the "last message" to the Continue button ---------------------------------------

// The real bug fixed here: an assistant-like element LOWER in the document (citation
// card, history preview...) than the real last message passed itself off as "last"
// simply because it came last in querySelectorAll(). The button, confirmed
// visible, must decide instead of DOM order.
test('acScan: a decoy lower in the DOM does not usurp "last" when the button anchors it',
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

test('acScan: fallback to the last one found in DOM order if the button is not nested ' +
  'dans aucune ligne connue', function () {
  fresh();   // button() by default: closest() finds nothing
  var scan = sandbox.acScan();
  assert.strictEqual(scan.lastText, LIMIT_TEXT);
  assert.strictEqual(scan.lastRowAnchored, false);
});

// ---- sr-only / aria-hidden duplication inside a message ---------------------------------------

test('acVisibleText: the sr-only copy is not concatenated to the visible text', function () {
  fresh();
  var dernier = rowWithHiddenDuplicate(LIMIT_TEXT, ['action-bar-retry']);
  dom['.group\\/message-row'] = [row('Bonjour', ['action-bar-retry']), dernier];
  dom['button, [role="button"]'] = [button(dernier)];

  var scan = sandbox.acScan();
  assert.strictEqual(scan.lastText, LIMIT_TEXT,
    'le texte masqué a été concaténé au texte visible : ' + JSON.stringify(scan.lastText));
});

test('acContinueButton: an invisible button is ignored', function () {
  fresh();
  dom['button, [role="button"]'] = [{ innerText: 'Continue', offsetParent: null }];
  assert.strictEqual(sandbox.acScan().hasButton, false);
});

test('acContinueButton: "Continuer" from a French interface is recognized', function () {
  fresh();
  dom['button, [role="button"]'] = [{ innerText: 'Continuer', offsetParent: {} }];
  assert.strictEqual(sandbox.acScan().hasButton, true);
});

test('acContinueButton: an arbitrary button does not pass', function () {
  fresh();
  dom['button, [role="button"]'] = [{ innerText: 'Copier', offsetParent: {} }];
  assert.strictEqual(sandbox.acScan().hasButton, false);
});

// ---- anti-double-click lock -------------------------------------------------------------------

test('two simultaneous ticks (worker + page): a single click', function () {
  fresh();
  return Promise.all([sandbox.acTick('sw'), sandbox.acTick('page')]).then(function (r) {
    assert.strictEqual(clicks, 1, 'double click: ' + clicks + ' clicks');
    assert.strictEqual(store.autoContinueCount, 1);
    assert.ok(r.indexOf('already running') !== -1, r.join(' / '));
  });
});

test('next tick within the guard delay: no click', function () {
  fresh();
  return sandbox.acTick('sw').then(function () {
    assert.strictEqual(clicks, 1);
    return sandbox.acTick('sw');
  }).then(function (r) {
    assert.strictEqual(r, 'guard delay');
    assert.strictEqual(clicks, 1);
  });
});

test('guard delay elapsed, limit still there: we click again', function () {
  fresh();
  return sandbox.acTick('sw').then(function () {
    sandbox.acLastClickAt = 0;   // simulates the 5 s elapsed
    return sandbox.acTick('sw');
  }).then(function () {
    assert.strictEqual(clicks, 2);
    assert.strictEqual(store.autoContinueCount, 2);
  });
});

// ---- the settings do stop the real click -------------------------------------------------------

test('maximum reached: no click, counter unchanged', function () {
  fresh();
  store.autoContinueCount = 3;
  store.autoContinueMaxCount = 3;
  return sandbox.acTick('sw').then(function (r) {
    assert.ok(r.indexOf('maximum') !== -1, r);
    assert.strictEqual(clicks, 0);
    assert.strictEqual(store.autoContinueCount, 3);
  });
});

test('paused: no click', function () {
  fresh();
  store.autoContinuePaused = true;
  return sandbox.acTick('page').then(function (r) {
    assert.ok(r.indexOf('paused') !== -1, r);
    assert.strictEqual(clicks, 0);
  });
});

test('disabled: no click', function () {
  fresh();
  store.autoContinueEnabled = false;
  return sandbox.acTick('page').then(function (r) {
    assert.ok(r.indexOf('disabled') !== -1, r);
    assert.strictEqual(clicks, 0);
  });
});

test('button vanished between detection and click: no exception', function () {
  fresh();
  dom['button, [role="button"]'] = [];
  return sandbox.acTick('sw').then(function (r) {
    assert.ok(r.indexOf('button') !== -1, r);
    assert.strictEqual(clicks, 0);
  });
});

test('phrase present earlier: no click despite the button', function () {
  fresh();
  dom['.group\\/message-row'] = [
    row('Parlons de la tool-use limit.', ['action-bar-retry']),
    row(LIMIT_TEXT, ['action-bar-read-aloud'])
  ];
  return sandbox.acTick('page').then(function (r) {
    assert.ok(r.indexOf('earlier') !== -1, r);
    assert.strictEqual(clicks, 0);
  });
});

// ---- diagnostic journal ---------------------------------------------------------------------

// The reported case: button clearly visible, but no click. Without the journal, it is impossible to
// distinguish "phrase absent" from "disabled" or from "counter exhausted".
test('button visible but phrase absent: the journal says why AND copies the message out',
  function () {
    fresh();
    var vrai = 'Claude a atteint la limite d’utilisation d’outils pour cette réponse.';
    dom['.group\\/message-row'] = [row(vrai, ['action-bar-retry'])];

    return sandbox.acTick('sw').then(function () {
      var j = journal();
      assert.ok(j, 'no diagnostic although a button is visible');
      assert.ok(j.indexOf('"Continue" button    : found') !== -1, j);
      assert.ok(j.indexOf('ABSENT from the last message') !== -1, j);
      assert.ok(j.indexOf('DECISION             : ignores') !== -1, j);
      // The most useful part: the real wording, to add it to AC_LIMIT_PHRASES.
      assert.ok(j.indexOf('limite d’utilisation d’outils') !== -1,
        'le message réel doit être recopié pour qu\'on puisse relever la phrase');
    });
  });

// What the journal must prove unambiguously before concluding about the limit phrase:
// which selector and which row (by its position) supplied the text, and whether that row was
// found by anchoring to the Continue button or by falling back to DOM order.
test('journal: the "last message read" line gives the selector, the index and the anchoring',
  function () {
    fresh();
    var dernier = row(LIMIT_TEXT, ['action-bar-retry']);
    dom['.group\\/message-row'] = [row('Bonjour', ['action-bar-retry']), dernier];
    dom['button, [role="button"]'] = [button(dernier)];

    return sandbox.acTick('sw').then(function () {
      var j = journal();
      assert.ok(j.indexOf('.group\\/message-row') !== -1, j);
      assert.ok(j.indexOf('index 1/1') !== -1, j);
      assert.ok(j.indexOf('anchored to the Continue button (reliable)') !== -1, j);
    });
  });

// The diagnostic's suspicion: a button present but discarded by the visibility test would be
// indistinguishable from an absent button without this count.
test('button with the right label but judged invisible: the journal tells it from an absence',
  function () {
    fresh();
    dom['button, [role="button"]'] = [{ innerText: 'Continue', offsetParent: null }];

    return sandbox.acTick('sw').then(function () {
      var j = journal();
      assert.ok(j.indexOf('DISCARDED — 1 with the right label but judged invisible') !== -1, j);
    });
  });

// The virtualization hypothesis stated in autocontinue.js: if no row is recognized as
// assistant while a "Continue" button is visible, the journal must say so explicitly
// rather than stay silent on a scan.messageCount of 0.
test('button visible but no assistant message recognized: the journal warns', function () {
  fresh();
  dom['.group\\/message-row'] = [row('Salut', ['action-bar-edit'])];

  return sandbox.acTick('sw').then(function () {
    var j = journal();
    assert.ok(j.indexOf('WARNING') !== -1 && j.indexOf('no assistant message') !== -1, j);
  });
});

test('counter exhausted: the journal gives both numbers', function () {
  fresh();
  store.autoContinueCount = 5;
  store.autoContinueMaxCount = 5;

  return sandbox.acTick('sw').then(function () {
    assert.ok(journal().indexOf('counter              : 5 / 5') !== -1, journal());
  });
});

test('maximum at 0: the journal says "unlimited", not "0"', function () {
  fresh();
  return sandbox.acTick('sw').then(function () {
    assert.ok(journal().indexOf('counter              : 0 / unlimited') !== -1, journal());
  });
});

// Without this silence, the 5 s polling would flood the tab's console.
test('no button anywhere: the journal stays silent', function () {
  fresh();
  dom['button, [role="button"]'] = [];

  return sandbox.acTick('sw').then(function () {
    assert.strictEqual(journal(), '', 'the diagnostic must stay silent without a button');
  });
});

test('identical state repeated: logged only once', function () {
  fresh();
  dom['.group\\/message-row'] = [row('Rien à signaler.', ['action-bar-retry'])];

  return sandbox.acTick('sw').then(function () {
    var apresUn = logs.length;
    assert.ok(apresUn > 0);
    return sandbox.acTick('sw').then(function () {
      assert.strictEqual(logs.length, apresUn, 'the same state was logged twice');
    });
  });
});

// ---- run -----------------------------------------------------------------------------------
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
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passed');
  if (failed) process.exit(1);
});
