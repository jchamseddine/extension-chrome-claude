// Isolated world, document_start. Estimates the context size of each conversation and
// displays the one for the open conversation in a fixed badge at the bottom right.
//
// The POST to /completion contains ONLY the new message: the history stays on the
// server side. The baseline therefore comes from the conversation GET (which does carry the whole history),
// and we add on the fly the characters sent then those of the streamed reply.
// characters / 4 is a rough approximation of the token count, never a measurement.
//
// STORAGE FORMAT — one chrome.storage.local key per conversation:
//
//   "ctx:<uuid>" -> { chars: 49600, tokens: 12400, updatedAt: 1785260400000 }
//
//   <uuid>    conversation uuid, extracted by inject.js from the intercepted URL
//             /chat_conversations/<uuid>/completion (and from the GET with the same prefix).
//   chars     total characters transmitted — this is the accumulable value, the increments
//             arrive in characters.
//   tokens    Math.round(chars / 4), written at the same time as chars so the key is
//             readable as-is without reapplying the conversion.
//   updatedAt last update, in milliseconds; serves as the LRU sort key.
//
// Only the MAX_CONVERSATIONS most recently updated conversations are
// kept, so that abandoned conversations do not accumulate indefinitely.
(function () {
  'use strict';

  var MAGIC = '__claude_usage_v1__';
  var CHARS_PER_TOKEN = 4;
  var MAX_CONVERSATIONS = 20;
  var PREFIX = 'ctx:';
  var EL_ID = '__claude_usage_context_badge';
  var CHAT_RE = /^\/chat\/([0-9a-f-]{36})/i;

  var displayed = null;   // uuid read from the PAGE URL, not from the request URLs
  var chars = null;       // null = no known estimate, to be distinguished from a zero
  var el = null;
  var chain = Promise.resolve();

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function currentUuid() {
    var m = CHAT_RE.exec(location.pathname);
    return m ? m[1] : null;
  }

  // ---- storage -------------------------------------------------------------

  // Serialized read-modify-write: two increments of the same conversation
  // can arrive a few milliseconds apart (payload sent, then streamed
  // reply), and would read a stale value from each other without this queue.
  function update(uuid, kind, delta) {
    var key = PREFIX + uuid;
    chain = chain.then(function () {
      if (!alive()) return;
      return chrome.storage.local.get(key).then(function (o) {
        var prev = (o[key] && typeof o[key].chars === 'number') ? o[key].chars : 0;
        var next = kind === 'snapshot' ? delta : prev + delta;
        var rec = {};
        rec[key] = {
          chars: next,
          tokens: Math.round(next / CHARS_PER_TOKEN),
          updatedAt: Date.now()
        };
        return chrome.storage.local.set(rec).then(prune);
      });
    }).catch(function () { /* invalidated context */ });
    // No render() here: chrome.storage.onChanged takes care of it, including when it is
    // another tab that wrote.
  }

  // LRU: we only keep the MAX_CONVERSATIONS most recent ctx: keys.
  function prune() {
    return chrome.storage.local.get(null).then(function (all) {
      var keys = Object.keys(all).filter(function (k) { return k.indexOf(PREFIX) === 0; });
      if (keys.length <= MAX_CONVERSATIONS) return;
      keys.sort(function (a, b) {
        return (all[b].updatedAt || 0) - (all[a].updatedAt || 0);
      });
      // Idempotent: two tabs pruning at the same time do not get in each other's way.
      return chrome.storage.local.remove(keys.slice(MAX_CONVERSATIONS));
    });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !displayed) return;
    var c = changes[PREFIX + displayed];
    if (!c) return;
    chars = c.newValue ? c.newValue.chars : null;
    render();
  });

  // ---- displayed conversation ----------------------------------------------

  function setDisplayed(uuid) {
    if (uuid === displayed) return;
    displayed = uuid;
    chars = null;
    render();                       // immediate neutral state while storage is being read
    if (!uuid || !alive()) return;

    var key = PREFIX + uuid;
    chrome.storage.local.get(key).then(function (o) {
      if (displayed !== uuid) return;                    // navigation in the meantime
      chars = (o[key] && typeof o[key].chars === 'number') ? o[key].chars : null;
      render();
    }, function () { /* invalidated context */ });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    var d = event.data;
    if (!d || typeof d !== 'object' || d.__cu !== MAGIC) return;

    if (d.kind === 'navigation') { setDisplayed(currentUuid()); return; }

    // The uuid comes from the request URL: a brand-new conversation is fed before
    // its page URL is even pushed, and will be read at navigation time.
    if (d.kind !== 'snapshot' && d.kind !== 'request' && d.kind !== 'reply') return;
    if (!d.uuid || typeof d.chars !== 'number') return;
    update(d.uuid, d.kind, d.chars);
  });

  // ---- display -------------------------------------------------------------

  function build() {
    var n = document.createElement('div');
    n.id = EL_ID;
    n.style.cssText = [
      'position:fixed !important',
      'bottom:12px !important',
      'right:12px !important',
      'z-index:2147483647 !important',
      'padding:4px 9px !important',
      'border-radius:999px !important',
      'background:rgba(20,20,22,.82) !important',
      'color:#f5f5f4 !important',
      'font:11px/1.4 system-ui,sans-serif !important',
      'letter-spacing:.01em !important',
      'pointer-events:none !important',
      'white-space:nowrap !important'
    ].join(';');
    return n;
  }

  function render() {
    var root = document.documentElement;
    if (!displayed || !root) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    if (!el) el = build();

    if (chars === null) {
      // A "~0 tokens" would suggest an empty conversation when we know nothing at all.
      el.textContent = 'contexte non estimé';
      el.style.opacity = '.75';
      el.title = "Aucune estimation pour cette conversation. Envoyez un message, ou "
               + "rechargez la page pour la mesurer sur l'historique complet.";
    } else {
      el.textContent = '~' + Math.round(chars / CHARS_PER_TOKEN).toLocaleString('fr-FR')
                     + ' tokens (estimation)';
      el.style.opacity = '1';
      el.title = 'Estimation grossière : caractères transmis divisés par 4. '
               + "Ce n'est pas un comptage de tokens exact.";
    }

    if (el.parentNode !== root) root.appendChild(el);
  }

  // Badge attached to <html> and not to <body>: outside the container React remounts.
  // The observer only covers the residual case where it would be torn off anyway.
  if (document.documentElement) {
    new MutationObserver(function () {
      if (el && displayed && el.parentNode !== document.documentElement) render();
    }).observe(document.documentElement, { childList: true });
  }

  setDisplayed(currentUuid());
})();
