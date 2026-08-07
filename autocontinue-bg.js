// Service worker half of auto-continue. Loaded by importScripts() from background.js,
// with which it shares NEITHER data NOR functions: two lines to remove to delete the
// feature. Nothing to do with usage-source.js, status-source.js or theme.js.
//
// Why the worker gets involved when autocontinue.js already sees the DOM: the setTimeout of a
// background tab are throttled (1 s minimum, then 1/min after five minutes hidden), so
// the page's MutationObserver is not enough for a minimized tab. Here the clock is on the
// extension side, out of reach of the tab's throttler.
//
// This file DECIDES nothing and reads no DOM: it only wakes acTick() in each
// claude.ai tab, through chrome.scripting.executeScript. It is the same function as the one
// triggered by the page's MutationObserver, so the acTick() lock is enough to guarantee
// a single continuation — no need for a reservation protocol between the two sides.
'use strict';

// chrome.alarms has a one-minute floor: far too slow for a continuation. The alarm therefore
// only serves to RESURRECT the worker after a sleep; the real cadence comes from the
// setInterval below, which only lives as long as the worker lives. Each executeScript pushes
// the sleep back, so the loop is self-sustaining as long as there is a claude.ai tab.
//
// It is started ONLY if auto-continue is active, not paused and under its maximum:
// disabled, the extension keeps nothing alive.
var AC_ALARM = 'autocontinue-poll';
var AC_ALARM_MINUTES = 1;
var AC_POLL_MS = 5000;

var AC_TAB_URLS = ['https://claude.ai/*', 'https://*.claude.ai/*'];

var acTimer = null;

function acStartLoop() {
  if (acTimer) return;
  acTimer = setInterval(acPollTabs, AC_POLL_MS);
}

function acStopLoop() {
  if (!acTimer) return;
  clearInterval(acTimer);
  acTimer = null;
}

// Injected as-is into the tab's isolated world: it is SERIALIZED, so it cannot
// capture anything from this file. acTick comes from the autocontinue.js content script, which lives
// in that same isolated world — a tab opened before the extension was installed or
// reloaded does not have it, hence the guard (same limit as the usage polling fallback relay).
function acRemoteTick() {
  return (typeof acTick === 'function') ? acTick('sw') : 'no content script (reload the tab)';
}

// Diagnostic journal. Two states deserve to be stated, and only one of these two messages is
// visible at a time:
//   - the loop does not start: this is THE case where nothing else can speak, since neither the
//     polling nor the page's MutationObserver is running. Without this message, an
//     autoContinueEnabled never written is indistinguishable from a detection that fails;
//   - the loop is running: each tab returns its reason, and that is what we display.
// Anti-repetition in both cases: the polling comes back every 5 s.
var acLastState = '';
var acLastTab = {};

// Only logs if the state has CHANGED. The key is compared, not the message: without this, a stable
// state would be redisplayed on every loop turn.
function acSay(key, message) {
  if (key === acLastState) return;
  acLastState = key;
  console.log('[autocontinue] ' + message);
}

function acIdleReason(settings) {
  if (!settings.enabled) {
    return 'auto-continue DISABLED (autoContinueEnabled missing or false) — ' +
      'tick the box in the popup; nothing runs as long as that key is not true';
  }
  if (settings.paused) return 'paused (autoContinuePaused = true)';
  return 'maximum counter reached: ' + settings.count + ' / ' + settings.maxCount +
    ' — « Réinitialiser » in the popup, or set the maximum to 0 (unlimited)';
}

function acPollTabs() {
  return chrome.storage.local.get(AC_KEYS).then(function (o) {
    var settings = acSettings(o);

    if (!settings.enabled || settings.paused || acMaxReached(settings)) {
      var raison = acIdleReason(settings);
      acSay('idle:' + raison, 'loop stopped: ' + raison);
      return acStopLoop();
    }

    acStartLoop();
    return chrome.tabs.query({ url: AC_TAB_URLS }).then(function (tabs) {
      if (!tabs.length) {
        acSay('notabs', 'active, but no claude.ai tab open');
        return;
      }
      acSay('running', 'active — polling ' + tabs.length + ' tab(s) every ' +
        (AC_POLL_MS / 1000) + ' s');

      tabs.forEach(function (tab) {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: acRemoteTick })
          .then(function (res) {
            // acTick() always returns its reason in plain words: it is what says why
            // the tab did not click. The detail (button, phrase, counter) is logged
            // on the page side, in the tab's console.
            var raison = res && res[0] && res[0].result;
            if (!raison || acLastTab[tab.id] === raison) return;
            acLastTab[tab.id] = raison;
            console.log('[autocontinue] tab ' + tab.id + ': ' + raison +
                        ' — detail in the tab console');
          })
          .catch(function () { /* tab currently navigating, or injection refused */ });
      });
    });
  }).catch(function (e) {
    console.warn('[autocontinue] polling failed:', (e && e.message) || e);
  });
}

// Enabling, resuming or resetting the counter from the popup must take effect right
// away, without waiting for the alarm.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;

  var touched = AC_KEYS.some(function (k) { return !!changes[k]; });
  if (touched) acPollTabs();
});

chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === AC_ALARM) acPollTabs();
});

// Same precaution as the two other alarms: top-level code replays on every
// worker wake-up, and chrome.alarms.create would reset the count to zero. The immediate polling
// is in the continuation so as to restart the setInterval as soon as it wakes.
chrome.alarms.get(AC_ALARM).then(function (a) {
  if (!a) chrome.alarms.create(AC_ALARM, { periodInMinutes: AC_ALARM_MINUTES });
  acPollTabs();
}, function () { /* harmless */ });
