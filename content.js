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

    // Panne silencieuse la plus courante : l'extension a ete rechargee sans que l'onglet le
    // soit. Le patch MAIN continue d'emettre, mais plus rien ne peut etre ecrit.
    if (!alive()) {
      console.error('[usage] contexte d\'extension invalide : message_limit recu mais non ' +
                    'enregistre. Rechargez l\'onglet claude.ai.');
      return;
    }

    try {
      chrome.storage.local.set({
        usage: { data: d.data, updatedAt: Date.now() }
      }).catch(function (e) {
        console.error('[usage] ecriture de la cle "usage" echouee :', e);
      });
    } catch (e) {
      console.error('[usage] ecriture de la cle "usage" impossible :', e);
    }
  });
})();
