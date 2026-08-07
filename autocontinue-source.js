// The only adaptation point of auto-continue to what claude.ai DISPLAYS, and the only brick
// shared between its three contexts (page, service worker, popup). PURE logic: no DOM,
// no chrome.*, no fetch — that is what makes it testable as-is by
// test-autocontinue.js, with the same vm.runInContext technique as usage-source.js.
//
// A feature independent of the rest of the extension: nothing in common with usage-source.js,
// status-source.js or theme.js, neither in data nor in functions.
'use strict';

// The six variants come from claude-autocontinue (timothy22000, MIT), which collected them
// on real messages. They are compared in lowercase and as substrings, not by equality:
// the sentence is buried in a paragraph whose wording changes.
//
// NO FRENCH VARIANT here: none has been captured, and this repo does not hard-code a guessed
// value (same rule as ORGS_PATH). On a French claude.ai interface, detection
// will therefore fail on the sentence — see "Limites connues" in the README.
var AC_LIMIT_PHRASES = [
  'tool-use limit',
  'tool use limit',
  'reached its tool',
  'exhausted the tool',
  'tool call limit',
  'continuation needed'
];

function acHasLimitPhrase(text) {
  if (typeof text !== 'string' || !text) return false;

  var low = text.toLowerCase();
  for (var i = 0; i < AC_LIMIT_PHRASES.length; i++) {
    if (low.indexOf(AC_LIMIT_PHRASES[i]) !== -1) return true;
  }
  return false;
}

// ---- settings ----------------------------------------------------------------

var AC_KEYS = ['autoContinueEnabled', 'autoContinueMaxCount', 'autoContinueCount',
  'autoContinuePaused'];

// Upper bound of the popup field. Beyond that, "unlimited" (0) says the same thing more clearly.
var AC_MAX_LIMIT = 999;

// CONVENTION, unambiguous and valid EVERYWHERE (popup, page, service worker):
//
//     autoContinueMaxCount === 0  <=>  UNLIMITED
//
// This is not a randomly chosen sentinel. It is also the value acSettings() returns
// when the key is missing, is null, or is nonsensical — so a setting never configured
// NEVER forbids continuing, which is the intended behavior for an undefined maximum.
// The alternative (0 = "no continuation allowed") would have required another value for
// "unlimited" (-1, null) and a missing key would then have become a silent block.
//
// Non-negotiable corollary: a BARE "count >= maxCount" comparison would block from the
// first call when maxCount is 0. The short-circuit must therefore be explicit, and there is
// only one place where that comparison is allowed to exist: acMaxReached().
var AC_UNLIMITED = 0;

// Normalizes the four raw storage keys into a usable object. Any missing or
// nonsensical value falls back to the most cautious behavior: disabled, counter at zero, maximum
// unlimited (see AC_UNLIMITED above).
//
// autoContinueCount MISSING and autoContinueCount = 0 give exactly the same result:
// Number(undefined) is NaN, which the isFinite test discards. A missing key therefore cannot
// skew the maximum comparison — the popup writes it anyway on activation, but so
// that storage reads unambiguously by hand, not to fix a behavior.
function acSettings(o) {
  o = o || {};

  var count = Number(o.autoContinueCount);
  var max = Number(o.autoContinueMaxCount);

  return {
    enabled: o.autoContinueEnabled === true,
    paused: o.autoContinuePaused === true,
    count: (isFinite(count) && count > 0) ? Math.floor(count) : 0,
    maxCount: (isFinite(max) && max > 0) ? Math.min(Math.floor(max), AC_MAX_LIMIT) : AC_UNLIMITED
  };
}

// THE only place in the repo where count and maxCount are compared. The short-circuit on
// AC_UNLIMITED comes before the comparison, never after: that is what prevents a maximum
// left at 0 — hence "unlimited" — from reading as "quota already exhausted".
function acMaxReached(settings) {
  if (settings.maxCount === AC_UNLIMITED) return false;
  return settings.count >= settings.maxCount;
}

// ---- decision ----------------------------------------------------------------

// "scan" is what the page observed, without interpretation:
//   { hasButton, lastText, otherTexts }   otherTexts = all assistant messages EXCEPT the
//                                         last one, in conversation order
//
// TWO cumulative conditions, never just one:
//   (a) a visible "Continue" button — a message that mentions the limit without a button means
//       the reply is finished, there is nothing to continue;
//   (b) the limit phrase in the LAST message, and NOWHERE else in the
//       conversation. This is the anti-false-positive guard: a conversation whose subject
//       IS the tool-use limit repeats the phrase from message to message, and would
//       auto-continue itself endlessly.
//
// Always returns a reason, including when we do continue: it is what the console
// journal displays, and what the tests read.
function acDecide(scan, settings) {
  if (!settings.enabled) return { go: false, reason: 'auto-continue disabled' };
  if (settings.paused) return { go: false, reason: 'paused' };
  if (!scan) return { go: false, reason: 'nothing to examine' };

  if (!scan.hasButton) return { go: false, reason: 'no Continue button visible' };
  if (!acHasLimitPhrase(scan.lastText)) {
    return { go: false, reason: 'no limit phrase in the last message' };
  }

  var others = scan.otherTexts || [];
  for (var i = 0; i < others.length; i++) {
    if (acHasLimitPhrase(others[i])) {
      return { go: false, reason: 'limit phrase already present earlier in the conversation' };
    }
  }

  if (acMaxReached(settings)) {
    return { go: false, reason: 'maximum counter reached (' + settings.maxCount + ')' };
  }

  return { go: true, reason: 'tool-use limit detected' };
}
