// Service worker. The only source of truth for usage: it queries claude.ai's API
// every minute (chrome.alarms) and writes the "usage" key. It also keeps the rolling
// history, the threshold notifications, and the appearance of the toolbar icon — two
// concentric rings drawn on an OffscreenCanvas, outer = 7d window, inner = 5h,
// plus the text badge of the 5h %.
//
// The icon, the history and the notifications stay wired to chrome.storage.onChanged:
// the event also fires in the context that wrote, so the polling has nothing to
// call directly.
'use strict';

// importScripts() exists ONLY in a WorkerGlobalScope. Chrome does load this file in
// a real service worker, but Firefox does not support "background.service_worker": it reads
// "background.scripts" and instantiates an EVENT PAGE, that is a hidden HTML page, where
// importScripts is undefined. Without this guard, the next line throws a ReferenceError and nothing
// in this file runs — no alarm, no polling, no icon.
//
// Warning: the list below is DUPLICATED in the manifest's "background.scripts", which loads the
// same files in the same order for Firefox. The two must stay in sync:
// modifying only one breaks ONE SINGLE of the two browsers, never both — an asymmetric
// failure, hence easy to miss.
if (typeof importScripts === 'function') {
  importScripts('common.js');        // utilOf(), colorFor(), resetText(), USAGE_LABELS
  importScripts('usage-source.js');  // usageUrl(), orgsUrl(), pickOrgId(), parseUsage()
  importScripts('status-source.js'); // STATUS_URL, parseStatus()

  // Auto-continue: a separate feature, which shares nothing with what precedes. These two
  // lines are its entire anchoring on the worker side — removing them deletes it entirely.
  importScripts('autocontinue-source.js'); // AC_KEYS, acSettings(), acMaxReached()
  importScripts('autocontinue-bg.js');     // alarm + tab polling
}

var TRACK = 'rgba(128,128,128,0.30)';

// Descending order: we look for the highest threshold crossed.
var THRESHOLDS = [95, 90, 75];
var HISTORY_MAX = 50;
var NOTIFY_ICON_SIZE = 128;

// Window reset detection: two signals required together (see isReset).
var RESET_FROM_PCT = 20;                 // below that, a drop is not significant
var RESET_MAX_AGE_MS = 10 * 60 * 1000;   // polling at 1 min: beyond that, Chrome was asleep

// Texts specific to the notifications, hence not in USAGE_LABELS of common.js, which also serves
// the popup display.
var RESET_MESSAGES = {
  '5h': 'Ta limite de session vient de se reset, tu peux repartir à 0 %.',
  '7d': 'Ta limite hebdomadaire vient de se reset, tu peux repartir à 0 %.'
};

var ALARM = 'usage-poll';
var POLL_MINUTES = 1;   // floor imposed by chrome.alarms

// The status rarely moves: no point hitting status.claude.com at the pace of usage.
var STATUS_ALARM = 'status-poll';
var STATUS_POLL_MINUTES = 5;

// The read-modify-writes of "usageHistory" and "notifyState" are serialized:
// two claude.ai tabs can write "usage" a few milliseconds apart and would
// read a stale value from each other.
var chain = Promise.resolve();

// ---- icon --------------------------------------------------------------------

function ring(ctx, center, radius, width, util, color) {
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';

  ctx.strokeStyle = TRACK;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, 2 * Math.PI);
  ctx.stroke();

  if (!util) return;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(center, center, radius, -Math.PI / 2, -Math.PI / 2 + util * 2 * Math.PI);
  ctx.stroke();
}

function canvasFor(size, w7, w5) {
  var canvas = new OffscreenCanvas(size, size);
  var ctx = canvas.getContext('2d');
  var center = size / 2;
  var width = Math.max(2, Math.round(size * 0.13));
  var gap = Math.max(1, Math.round(size * 0.06));
  var outer = center - width / 2;
  var inner = outer - width - gap;

  ring(ctx, center, outer, width, utilOf(w7), colorFor(w7));
  ring(ctx, center, inner, width, utilOf(w5), colorFor(w5));
  return canvas;
}

function paint(size, w7, w5) {
  return canvasFor(size, w7, w5).getContext('2d').getImageData(0, 0, size, size);
}

function render() {
  chrome.storage.local.get('usage').then(function (o) {
    var windows = (o.usage && o.usage.data && o.usage.data.windows) || null;
    var w5 = windows ? windows['5h'] : null;
    var w7 = windows ? windows['7d'] : null;

    chrome.action.setIcon({ imageData: { 16: paint(16, w7, w5), 32: paint(32, w7, w5) } })
      .catch(function () { /* harmless */ });

    var u5 = utilOf(w5);
    if (u5 === null) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }
    chrome.action.setBadgeText({ text: Math.round(u5 * 100) + '%' });
    chrome.action.setBadgeBackgroundColor({ color: colorFor(w5) });
    chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }, function () { /* harmless */ });
}

// ---- rolling history ---------------------------------------------------------

// One point per poll, hence a regular series at 1 point/minute — that is what gives
// meaning to the popup's linear regression. Used to project the moment the 5h window
// would reach 100 %. Capped at HISTORY_MAX: 50 points = 50 min, the popup's fitting
// window covers 30 of them.
function recordHistory(data) {
  var windows = data.windows || {};
  var point = {
    t: Date.now(),
    u5: utilOf(windows['5h']),
    u7: utilOf(windows['7d'])
  };
  if (point.u5 === null && point.u7 === null) return Promise.resolve();

  return chrome.storage.local.get('usageHistory').then(function (o) {
    var h = Array.isArray(o.usageHistory) ? o.usageHistory : [];
    h.push(point);
    if (h.length > HISTORY_MAX) h = h.slice(h.length - HISTORY_MAX);
    return chrome.storage.local.set({ usageHistory: h });
  });
}

// ---- threshold notifications -------------------------------------------------

// chrome.notifications requires an iconUrl: we encode the ring icon as a PNG data-URL
// rather than shipping a binary in the repo.
function iconDataUrl(w7, w5) {
  return canvasFor(NOTIFY_ICON_SIZE, w7, w5)
    .convertToBlob({ type: 'image/png' })
    .then(function (blob) { return blob.arrayBuffer(); })
    .then(function (buf) {
      var bytes = new Uint8Array(buf);
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return 'data:image/png;base64,' + btoa(s);
    });
}

function show(msg, url) {
  chrome.notifications.create('', {
    type: 'basic',
    iconUrl: url,
    title: msg.title,
    message: msg.message,
    priority: 2
  }, function () {
    if (chrome.runtime.lastError) console.warn('[usage] notification', chrome.runtime.lastError.message);
  });
}

// The highest threshold crossed by pct, 0 if none.
function crossedThreshold(pct) {
  for (var i = 0; i < THRESHOLDS.length; i++) {
    if (pct >= THRESHOLDS[i]) return THRESHOLDS[i];
  }
  return 0;
}

// A window reset cannot be read from resets_at alone: the API can return a slightly
// different boundary from one poll to the next without a real reset. Nor from the percentage
// drop alone: that would then be a measurement correction, not a new window. We therefore require
// both together, plus the freshness of the previous poll — otherwise we would announce, on
// Chrome's wake-up, a reset that happened hours ago.
function isReset(prevW, w, ageMs) {
  if (typeof ageMs !== 'number' || ageMs < 0 || ageMs > RESET_MAX_AGE_MS) return false;

  var prevSec = prevW && prevW.resets_at;
  var sec = w && w.resets_at;
  if (typeof prevSec !== 'number' || typeof sec !== 'number' || sec === prevSec) return false;

  var pu = utilOf(prevW);
  var u = utilOf(w);
  if (pu === null || u === null) return false;

  var prevPct = Math.round(pu * 100);
  return prevPct > RESET_FROM_PCT && Math.round(u * 100) < prevPct / 2;
}

// Anti-spam: we memorize the last threshold notified per window. We only notify when the
// crossed threshold is HIGHER than the last notified one; coming back down lowers it silently,
// which re-authorizes the notification if the threshold is crossed again (window reset, for instance).
//
// "prev" is the { data, updatedAt } envelope of the previous poll, as storage.onChanged
// provides it in oldValue: it comes from storage, so it survives the worker being recycled.
function evaluate(data, state, prev) {
  var msgs = [];
  var windows = data.windows || {};
  var prevWindows = (prev && prev.data && prev.data.windows) || {};
  var ageMs = (prev && typeof prev.updatedAt === 'number' && isFinite(prev.updatedAt))
    ? Date.now() - prev.updatedAt
    : -1;   // no usable previous poll: no detectable reset

  Object.keys(USAGE_LABELS).forEach(function (key) {
    var w = windows[key];
    var st = state.windows[key] || { threshold: 0, overLimit: false };
    var label = USAGE_LABELS[key];
    var u = utilOf(w);

    if (u !== null) {
      var pct = Math.round(u * 100);
      var crossed = crossedThreshold(pct);
      if (crossed > st.threshold) {
        msgs.push({
          title: label + ' : ' + crossed + ' % atteint',
          message: pct + ' % utilisé. ' + (resetText(w.resets_at, key === '7d') || 'Reset inconnu.')
        });
      }
      st.threshold = crossed;
    }

    var over = !!(w && w.status === 'over_limit');
    if (over && !st.overLimit) {
      msgs.push({
        title: label + ' : limite atteinte',
        message: 'Cette fenêtre est épuisée. ' + (resetText(w.resets_at, key === '7d') || 'Reset inconnu.')
      });
    }
    st.overLimit = over;

    // Anti-spam specific to the reset: we memorize the last announced boundary. Redundant with the
    // comparison against prev in the nominal case, but guarantees the "only once per reset"
    // even if the same poll were replayed.
    if (isReset(prevWindows[key], w, ageMs) && st.notifiedReset !== w.resets_at) {
      msgs.push({
        title: label + ' : reset effectué',
        message: RESET_MESSAGES[key] + ' ' + resetText(w.resets_at, key === '7d')
      });
      st.notifiedReset = w.resets_at;
    }

    state.windows[key] = st;
  });

  // Leftover from the old SSE stream: this field does not exist in the real response of
  // /organizations/<org>/usage (it carries extra_usage/spend instead, not wired up
  // here yet — see usage-source.js). Left as-is, without effect as long as nothing populates it.
  var overage = !!(data.overageInUse || (data.resolved && data.resolved.overageInUse));
  if (overage && !state.overage) {
    msgs.push({
      title: 'Crédits payants en cours de consommation',
      message: "Le forfait inclus est épuisé : l'usage actuel est facturé en supplément."
    });
  }
  state.overage = overage;

  return msgs;
}

function maybeNotify(data, prev) {
  return chrome.storage.local.get(['settings', 'notifyState']).then(function (o) {
    // Disabled by default: without a saved setting, we do not notify.
    if (!(o.settings && o.settings.notifications)) return;

    var state = o.notifyState || {};
    if (!state.windows) state.windows = {};

    var msgs = evaluate(data, state, prev);
    return chrome.storage.local.set({ notifyState: state }).then(function () {
      if (!msgs.length) return;
      var windows = data.windows || {};
      return iconDataUrl(windows['7d'], windows['5h']).then(function (url) {
        msgs.forEach(function (m) { show(m, url); });
      });
    });
  });
}

// ---- API polling -------------------------------------------------------------

// The service worker has no claude.ai origin: credentials:'include' does send the
// session cookies, but nothing guarantees the API accepts a request without the
// Origin/Referer it expects. So we try from here first — it works with the tab closed —
// and we fall back to an open claude.ai tab, where the fetch is same-origin.
function fetchJson(url) {
  return fetch(url, {
    credentials: 'include',
    headers: { accept: 'application/json' }
  }).then(function (res) {
    if (!res.ok) {
      var e = new Error('HTTP ' + res.status);
      e.status = res.status;
      throw e;
    }
    return res.json();
  });
}

// Tabs loaded before the extension was installed or reloaded have no live
// content script: their sendMessage rejects. So we try the tabs one after another.
function askTabs(tabs, url, i, lastErr) {
  if (i >= tabs.length) {
    throw new Error(lastErr || 'no claude.ai tab responds (reload the tab)');
  }
  return chrome.tabs.sendMessage(tabs[i].id, { kind: 'fetchUsage', url: url })
    .then(function (r) {
      if (r && r.ok) return r.json;
      var e = new Error((r && r.error) || 'empty response');
      if (r && r.status) e.status = r.status;
      throw e;
    })
    .catch(function (e) {
      // An HTTP refusal will repeat identically on the other tabs: no point insisting.
      if (e && e.status) throw e;
      return askTabs(tabs, url, i + 1, String((e && e.message) || e));
    });
}

function fetchViaTab(url) {
  return chrome.tabs.query({ url: ['https://claude.ai/*', 'https://*.claude.ai/*'] })
    .then(function (tabs) {
      if (!tabs.length) throw new Error('no claude.ai tab open');
      return askTabs(tabs, url, 0, null);
    });
}

// A 404 says the URL is wrong: the fallback would only produce the same 404 from
// the tab. We only fall back on what can genuinely be down to the caller's origin.
function getJson(url) {
  return fetchJson(url).catch(function (e) {
    if (e && e.status && e.status !== 401 && e.status !== 403) throw e;
    console.warn('[usage] direct fetch failed (' + ((e && e.message) || e) +
                 '): falling back to a claude.ai tab');
    return fetchViaTab(url);
  });
}

// The organization uuid never changes in practice: we cache it so as not to pay for
// one more request on every poll (the worker dies between two alarms, an in-memory cache
// would not survive).
function resolveOrg() {
  if (!usageNeedsOrg()) return Promise.resolve(null);

  return chrome.storage.local.get('orgId').then(function (o) {
    if (o.orgId) return o.orgId;
    return getJson(orgsUrl()).then(function (json) {
      var id = pickOrgId(json);
      if (!id) throw new Error('no organization uuid in the response from ' + orgsUrl());
      return chrome.storage.local.set({ orgId: id }).then(function () { return id; });
    });
  });
}

function pollUsage() {
  return resolveOrg()
    .then(function (org) { return getJson(usageUrl(org)); })
    .then(function (json) {
      var data = parseUsage(json);
      if (!data) return;   // parseUsage has already said in the console what is missing

      // Written on every poll even if nothing moved: "updatedAt" must reflect the
      // real freshness of the data, and usageHistory needs regular sampling.
      return chrome.storage.local.set({ usage: { data: data, updatedAt: Date.now() } });
    })
    .catch(function (e) {
      console.warn('[usage] polling failed:', (e && e.message) || e);
      // A stale organization uuid would make the polling mute forever: we discard it
      // so the next wake-up asks for it again.
      if (e && (e.status === 401 || e.status === 403 || e.status === 404)) {
        return chrome.storage.local.remove('orgId').catch(function () {});
      }
    });
}

// ---- status polling ----------------------------------------------------------

// A source totally independent of usage: another domain, a public endpoint, and nothing
// in common in storage. It touches neither the icon, nor the history, nor the notifications.
function pollStatus() {
  // fetchJson() and not getJson(): falling back to a claude.ai tab makes no sense for a
  // public endpoint on another domain, and its "[usage]" warnings would be misleading.
  return fetchJson(STATUS_URL)
    .then(function (json) {
      var data = parseStatus(json);
      if (!data) return;   // parseStatus has already said in the console what is missing

      return chrome.storage.local.set({ status: { data: data, updatedAt: Date.now() } });
    })
    .catch(function (e) {
      console.warn('[status] polling failed:', (e && e.message) || e);
    });
}

// ---- triggers ----------------------------------------------------------------

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes.usage) return;
  render();

  var data = changes.usage.newValue && changes.usage.newValue.data;
  if (!data) return;
  var prev = changes.usage.oldValue;   // previous poll, for reset detection
  chain = chain
    .then(function () { return recordHistory(data); })
    .then(function () { return maybeNotify(data, prev); })
    .catch(function (e) { console.warn('[usage]', e); });
});

chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === ALARM) pollUsage();
  if (a.name === STATUS_ALARM) pollStatus();
});

// The service worker is destroyed and restarted constantly; this top-level code
// therefore replays on every wake-up. chrome.alarms.create resets the count to zero, which
// would push the polling back indefinitely: we only create if the alarm is missing.
chrome.alarms.get(ALARM).then(function (a) {
  if (!a) chrome.alarms.create(ALARM, { periodInMinutes: POLL_MINUTES });
}, function () { /* harmless */ });

chrome.alarms.get(STATUS_ALARM).then(function (a) {
  if (!a) chrome.alarms.create(STATUS_ALARM, { periodInMinutes: STATUS_POLL_MINUTES });
}, function () { /* harmless */ });

// setIcon does not survive a Chrome restart: we must redraw at startup.
chrome.runtime.onStartup.addListener(function () {
  render();
  pollUsage();   // do not wait for the first alarm to have data to display
  pollStatus();
});

chrome.runtime.onInstalled.addListener(function () {
  // Orphan keys: Phase 1 captures (sniffer), and "context" from before the
  // per-conversation segmentation (replaced by the "ctx:<uuid>" keys).
  chrome.storage.local.get(null).then(function (all) {
    var stale = Object.keys(all).filter(function (k) {
      return k.indexOf('sniff:') === 0 || k === 'context';
    });
    if (stale.length) chrome.storage.local.remove(stale).catch(function () {});
  }, function () {});
  render();
  pollUsage();
  pollStatus();
});
