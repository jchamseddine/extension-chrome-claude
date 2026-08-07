// Isolated world, document_idle. Feature independent of the rest of the extension: clicks the
// "Continue" button that claude.ai shows when a reply hits the tool-use limit.
// Reads and writes only the four autoContinue* keys, emits no network request.
//
// The decision is not taken here: this file only READS the DOM and hands a
// { hasButton, lastText, otherTexts } to acDecide() (autocontinue-source.js), which carries the two
// cumulative conditions and the counter. If claude.ai changes its markup, only the
// selectors below need fixing.
//
// TWO triggers, ONE SINGLE execution path:
//   - this file's MutationObserver: near-instant, but its setTimeout is throttled as soon
//     as the tab goes to the background (1 s minimum, then 1/min after five minutes hidden);
//   - the service worker's polling (autocontinue-bg.js), which calls acTick() through
//     chrome.scripting.executeScript. An extension injection, on the other hand, is not throttled: that is
//     what makes auto-continue work on a minimized tab.
// Both go through acTick(), which carries the acBusy lock and the guard delay. The
// double click is therefore impossible BY CONSTRUCTION, without a reservation protocol between the
// two sides: there is only one detector, woken in two ways.
//
// No IIFE: the service worker injects a function that calls acTick() in this isolated world,
// so the name must be visible from the global scope (same constraint as theme.js for its
// computation functions). Content scripts share a single isolated world per frame, hence the
// "ac"/"AC_" prefix on all top-level names.
'use strict';

// Individual message container. Spotted by real inspection: the Tailwind class carries a
// slash ("group/message-row"), which must be escaped in a CSS selector.
//
// The conversation list is VIRTUALIZED: React unmounts the .group/message-row outside the
// viewport as you scroll, so a one-off querySelectorAll() only sees what is
// currently mounted, never the full history. Assumption made here, NOT verified: the
// last assistant message we care about is necessarily the one the user is looking at at the
// moment the "Continue" button appears, hence mounted at the time of the periodic scan (already in
// place, every 5 s). If this assumption is false and even that message is unmounted,
// acScan() finds no assistant message at all; acLog() reports it explicitly (see
// further down) rather than failing silently.
var AC_MESSAGE_ROW_SELECTOR = '.group\\/message-row';

// Role signals, confirmed by real inspection, each EXCLUSIVE to a single role:
// action-bar-retry and action-bar-read-aloud appear ONLY on an assistant message;
// action-bar-edit appears ONLY on a user message. action-bar-copy exists on BOTH
// roles — a lead already ruled out, never to be used as a distinguishing criterion.
var AC_ASSISTANT_SIGNAL_SELECTOR =
  '[data-testid="action-bar-retry"], [data-testid="action-bar-read-aloud"]';

function acIsAssistantRow(row) {
  return !!row.querySelector(AC_ASSISTANT_SIGNAL_SELECTOR);
}

// Standard accessibility pattern (not an assumption about claude.ai's EXACT markup): a
// copy of the text reserved for the screen reader, marked by aria-hidden or a
// sr-only/visually-hidden utility class. innerText/textContent include it anyway, since it is neither
// display:none nor visibility:hidden — only removed visually by a clip — hence the
// consecutive duplicate observed in real use (the same passage read twice in a row). We discard it
// here without ever touching the real DOM: a manual walk of the nodes that skips any element
// matching this selector, exactly the opposite of what a plain .innerText would do.
var AC_HIDDEN_TEXT_SELECTOR =
  '[aria-hidden="true"], .sr-only, [class*="sr-only" i], [class*="visually-hidden" i], ' +
  '[class*="visuallyhidden" i]';

function acVisibleText(el) {
  if (!el) return '';
  var text = '';
  (function walk(node) {
    if (node.nodeType === 3) { text += node.nodeValue; return; }  // Node.TEXT_NODE
    if (node.nodeType !== 1) return;                              // neither text nor element: ignored
    if (node.matches && node.matches(AC_HIDDEN_TEXT_SELECTOR)) return;
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  })(el);
  return text.trim();
}

// acMessages() returns the rows in DOM order, not in the visual order of the conversation:
// an assistant-like element present elsewhere on the page (citation card, history
// preview...) that happens to come AFTER the real last message in the document would usurp the
// "last" position if we trusted the array order — that is exactly the symptom
// reported (text from a completely different conversation). The "Continue" button, however, is confirmed visible
// (non-null offsetParent, see acContinueButton): the row that wraps it IS by construction the
// real last assistant message, without our having to guess a page scope. Fallback
// to the last one found in DOM order only if the button is nested in no known
// row — an unverified assumption in that case, reported as such in the journal.
function acLastAssistantRow(rows, button) {
  var fromButton = (button && button.closest) ? button.closest(AC_MESSAGE_ROW_SELECTOR) : null;
  if (fromButton && rows.indexOf(fromButton) !== -1) {
    return { row: fromButton, anchored: true };
  }
  return { row: rows.length ? rows[rows.length - 1] : null, anchored: false };
}

// Guard delay after a click: the time for claude.ai to remove the button and resume
// streaming. Without it, the next tick would see the same state and click again.
var AC_COOLDOWN_MS = 5000;

// We only look at the DOM once the mutations have settled: during streaming hundreds arrive
// per second, and the button only appears at the end.
var AC_QUIET_MS = 600;

var AC_TOAST_ID = '__claude_autocontinue_toast';
var AC_TOAST_MS = 4000;

var acBusy = false;
var acLastClickAt = 0;
var acQuietTimer = null;
var acToastTimer = null;

// Local reflection of "active and not paused". Only serves to NOT pay for a storage
// read on every DOM lull when the feature is off — acTick() rereads
// the real values before acting anyway.
var acOn = false;

function acAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
}

// ---- DOM reading -------------------------------------------------------------

function acMessages() {
  var rows = document.querySelectorAll(AC_MESSAGE_ROW_SELECTOR);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (acIsAssistantRow(rows[i])) out.push(rows[i]);
  }
  return out;
}

// offsetParent === null is enough to discard hidden buttons here: the "Continue" button is
// in the conversation flow, not in position:fixed (where offsetParent would be null even when
// visible). startsWith and not equality: the label sometimes carries a suffix — and it covers along
// the way "Continuer" of a French interface.
//
// The LABEL test comes before the VISIBILITY one, purely so we can count the
// correctly-labelled buttons we discard: it is that figure which, in the journal, distinguishes "no
// button" from "button present but wrongly judged invisible".
function acContinueButton(stats) {
  var nodes = document.querySelectorAll('button, [role="button"]');

  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var t = (el.innerText || el.textContent || '').trim();
    if (t !== 'Continue' && t.indexOf('Continue') !== 0) continue;

    if (el.offsetParent === null) {
      if (stats) stats.hidden++;
      continue;
    }
    return el;
  }
  return null;
}

function acScan() {
  var stats = { hidden: 0 };
  var button = acContinueButton(stats);
  var rows = acMessages();
  var last = acLastAssistantRow(rows, button);
  var otherRows = rows.filter(function (r) { return r !== last.row; });

  return {
    hasButton: !!button,
    lastText: last.row ? acVisibleText(last.row) : '',
    otherTexts: otherRows.map(acVisibleText),
    // Purely diagnostic: acDecide() reads none of the four below.
    hiddenButtons: stats.hidden,
    messageCount: rows.length,
    lastRowIndex: last.row ? rows.indexOf(last.row) : -1,
    lastRowAnchored: last.anchored
  };
}

// ---- diagnostic journal ------------------------------------------------------

// We speak ONLY when there is something to say: a visible "Continue" button, or a
// correctly-labelled button we have just discarded. The rest of the time, silence — otherwise the 5 s
// polling would flood the console.
//
// The last message is copied out when the limit phrase is NOT found in it: it is the only
// way to read the real wording and add it to AC_LIMIT_PHRASES. That is in particular what
// is missing for a French claude.ai interface, of which no variant is known.
var acLastLog = '';

function acLog(scan, settings, decision, origin) {
  if (!scan.hasButton && !scan.hiddenButtons) return;

  var ailleurs = scan.otherTexts.some(acHasLimitPhrase);
  var dansDernier = acHasLimitPhrase(scan.lastText);

  var lignes = [
    '"Continue" button    : ' + (scan.hasButton ? 'found'
      : 'DISCARDED — ' + scan.hiddenButtons + ' with the right label but judged invisible (null offsetParent)'),
    'assistant messages   : ' + scan.messageCount + ' read',
    'last message read    : ' + (scan.messageCount > 0
      ? 'selector ' + AC_MESSAGE_ROW_SELECTOR + ', index ' + scan.lastRowIndex + '/' +
        (scan.messageCount - 1) + ' — ' + (scan.lastRowAnchored
          ? 'anchored to the Continue button (reliable)'
          : 'last one found in DOM order (button not nested — assumption to verify)')
      : 'none (see WARNING below)'),
    'limit phrase         : ' + (dansDernier ? 'found in the last message'
      : 'ABSENT from the last message'),
    'phrase earlier       : ' + (ailleurs ? 'YES — blocking (anti-false-positive)' : 'no'),
    'counter              : ' + settings.count + ' / ' +
      (settings.maxCount === AC_UNLIMITED ? 'unlimited' : settings.maxCount),
    'active / paused      : ' + settings.enabled + ' / ' + settings.paused,
    'DECISION             : ' + (decision.go ? 'CLICKS' : 'ignores') + ' — ' + decision.reason
  ];

  if (!dansDernier) {
    lignes.push('last message (first 500 characters), to collect the real phrase:',
      '  ' + JSON.stringify(scan.lastText.slice(0, 500)));
  }

  // Suspicious case: a "Continue" button is visible but no .group/message-row has been
  // recognized as assistant — either virtualization has unmounted down to the message visible
  // on screen, or the role selectors no longer match anything.
  if (scan.messageCount === 0) {
    lignes.push('WARNING                : no assistant message found in the DOM at this ' +
      'moment (virtualization or stale role selectors?)');
  }

  // Anti-repetition: the polling comes back every 5 s on an identical state.
  var texte = lignes.join('\n  ');
  if (texte === acLastLog) return;
  acLastLog = texte;
  console.log('[autocontinue] diagnostic (' + origin + ')\n  ' + texte);
}

// ---- toast -------------------------------------------------------------------

// Deliberately a toast in the page and not chrome.notifications: a continuation is an
// event of the conversation you are currently reading, not a system alert. Positioned
// above the context badge (bottom-right, ~22 px tall) so as not to cover it.
function acToast(text) {
  var root = document.documentElement;
  if (!root) return;

  var el = document.getElementById(AC_TOAST_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = AC_TOAST_ID;
    el.style.cssText = [
      'position:fixed !important',
      'bottom:44px !important',
      'right:12px !important',
      'z-index:2147483647 !important',
      'padding:5px 10px !important',
      'border-radius:999px !important',
      'background:rgba(20,20,22,.88) !important',
      'color:#f5f5f4 !important',
      'font:11px/1.4 system-ui,sans-serif !important',
      'letter-spacing:.01em !important',
      'pointer-events:none !important',
      'white-space:nowrap !important'
    ].join(';');
  }

  el.textContent = text;
  if (el.parentNode !== root) root.appendChild(el);

  clearTimeout(acToastTimer);
  acToastTimer = setTimeout(function () {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, AC_TOAST_MS);
}

// ---- triggering --------------------------------------------------------------

// Returns a promise of a reason, in plain words: it is the value the service worker gets back from
// its executeScript, hence what we read in the console when nothing happens.
//
// The lock is NOT released by the guard delay: acBusy only covers the read-decide
// -write, acLastClickAt covers the after-click. Two distinct roles, two variables.
function acTick(origin) {
  if (acBusy) return Promise.resolve('already running');
  if (Date.now() - acLastClickAt < AC_COOLDOWN_MS) return Promise.resolve('guard delay');
  if (!acAlive()) return Promise.resolve('invalidated extension context');

  acBusy = true;
  return chrome.storage.local.get(AC_KEYS).then(function (o) {
    var settings = acSettings(o);
    var scan = acScan();
    var decision = acDecide(scan, settings);

    acLog(scan, settings, decision, origin);
    if (!decision.go) return decision.reason;

    // The scan and the click are not the same instant: the button may have gone between the two.
    var button = acContinueButton();
    if (!button) return 'button vanished between detection and click';

    acLastClickAt = Date.now();
    button.click();

    var count = settings.count + 1;
    acToast('Auto-continue — continuation ' + count +
            (settings.maxCount ? ' / ' + settings.maxCount : ''));

    return chrome.storage.local.set({ autoContinueCount: count }).then(function () {
      console.log('[autocontinue] continuation ' + count + ' (' + origin + ')');
      return 'continuation ' + count;
    });
  }).catch(function (e) {
    return 'failure: ' + ((e && e.message) || e);
  }).then(function (reason) {
    acBusy = false;
    return reason;
  });
}

// ---- wiring ------------------------------------------------------------------

function acReadState() {
  if (!acAlive()) return;
  chrome.storage.local.get(['autoContinueEnabled', 'autoContinuePaused']).then(function (o) {
    acOn = o.autoContinueEnabled === true && o.autoContinuePaused !== true;
  }, function () { /* invalidated context */ });
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (!changes.autoContinueEnabled && !changes.autoContinuePaused) return;
  acReadState();
});

// Debounce on the lull: during streaming the timer is pushed back in a loop, and acTick()
// only fires once the reply has settled — that is, at the moment the button exists.
if (document.documentElement) {
  new MutationObserver(function () {
    if (!acOn) return;
    clearTimeout(acQuietTimer);
    acQuietTimer = setTimeout(function () { acTick('page'); }, AC_QUIET_MS);
  }).observe(document.documentElement, { childList: true, subtree: true });
}

acReadState();
