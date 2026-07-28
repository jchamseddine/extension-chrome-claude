// Monde isole, document_start. Pont entre inject.js (monde MAIN) et chrome.storage.
// Ne traite que l'usage : la cle "usage" est ecrasee a chaque nouvel evenement
// message_limit. Le service worker reagit ensuite via chrome.storage.onChanged.
// L'estimation de contexte est geree separement par context-estimator.js.
(function () {
  'use strict';

  var MAGIC = '__claude_usage_v1__';

  // Apres un rechargement de l'extension, le patch MAIN survit mais les handles chrome.*
  // sont morts et tout jette en silence.
  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;          // bloque les iframes
    if (event.origin !== location.origin) return;
    var d = event.data;
    if (!d || typeof d !== 'object') return;
    if (d.__cu !== MAGIC) return;
    if (d.kind !== 'limit' || !d.data) return;
    if (!alive()) return;

    try {
      chrome.storage.local.set({
        usage: { data: d.data, updatedAt: Date.now() }
      }).catch(function () { /* contexte invalide */ });
    } catch (e) { /* contexte invalide */ }
  });
})();
