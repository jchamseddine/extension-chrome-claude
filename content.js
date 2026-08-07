// Isolated world, document_start. Fallback relay for usage polling: when the fetch
// issued from the service worker is rejected (401/403 — it carries no claude.ai origin),
// the worker asks this tab to redo the call. Here we are on the claude.ai page, so
// the fetch is same-origin: cookies, Origin and Referer are the ones the API expects.
//
// This file no longer touches chrome.storage: the "usage" key has a single author, the
// service worker. Context estimation is handled separately by context-estimator.js.
(function () {
  'use strict';

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.kind !== 'fetchUsage' || typeof msg.url !== 'string') return;

    fetch(msg.url, {
      credentials: 'include',
      headers: { accept: 'application/json' }
    }).then(function (res) {
      if (!res.ok) {
        // The status goes back to the worker: it is the one that decides to invalidate the
        // cached organization uuid rather than keep polling into the void.
        sendResponse({ ok: false, error: 'HTTP ' + res.status, status: res.status });
        return;
      }
      return res.json().then(function (json) {
        sendResponse({ ok: true, json: json });
      });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });

    return true;   // asynchronous response: keeps the channel open
  });
})();
