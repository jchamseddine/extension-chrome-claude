// Monde isole, document_start. Relais de secours pour le sondage d'usage : quand le fetch
// emis depuis le service worker est refuse (401/403 — il ne porte pas d'origine claude.ai),
// le worker demande a cet onglet de refaire l'appel. Ici on est sur la page claude.ai, donc
// le fetch est same-origin : cookies, Origin et Referer sont ceux que l'API attend.
//
// Ce fichier ne touche plus a chrome.storage : la cle "usage" n'a qu'un seul auteur, le
// service worker. L'estimation de contexte est geree separement par context-estimator.js.
(function () {
  'use strict';

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.kind !== 'fetchUsage' || typeof msg.url !== 'string') return;

    fetch(msg.url, {
      credentials: 'include',
      headers: { accept: 'application/json' }
    }).then(function (res) {
      if (!res.ok) {
        // Le statut remonte au worker : c'est lui qui decide d'invalider l'uuid
        // d'organisation en cache plutot que de resonder dans le vide.
        sendResponse({ ok: false, error: 'HTTP ' + res.status, status: res.status });
        return;
      }
      return res.json().then(function (json) {
        sendResponse({ ok: true, json: json });
      });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });

    return true;   // reponse asynchrone : garde le canal ouvert
  });
})();
