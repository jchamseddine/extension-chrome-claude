// Monde isole, document_start. Estime la taille du contexte de la conversation ouverte et
// l'affiche dans une pastille fixe en bas a droite des pages /chat/*.
//
// Le POST vers /completion ne contient QUE le nouveau message : l'historique reste cote
// serveur. La base vient donc du GET de la conversation (qui, lui, porte tout l'historique),
// et on y ajoute a chaud les caracteres envoyes puis ceux de la reponse streamee.
// caracteres / 4 est une approximation grossiere du nombre de tokens, jamais une mesure.
(function () {
  'use strict';

  var MAGIC = '__claude_usage_v1__';
  var CHARS_PER_TOKEN = 4;
  var EL_ID = '__claude_usage_context_badge';
  var CHAT_RE = /^\/chat\/([0-9a-f-]{36})/i;

  var uuid = null;
  var chars = 0;
  var el = null;

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function pathUuid() {
    var m = CHAT_RE.exec(location.pathname);
    return m ? m[1] : null;
  }

  // ---- etat ----------------------------------------------------------------

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    var d = event.data;
    if (!d || typeof d !== 'object' || d.__cu !== MAGIC) return;
    if (d.kind !== 'snapshot' && d.kind !== 'request' && d.kind !== 'reply') return;

    // Une conversation neuve recoit son uuid avant que l'URL ne soit poussee : on adopte
    // celui du message plutot que d'attendre le changement de pathname.
    if (d.uuid !== uuid) { uuid = d.uuid; chars = 0; }
    chars = d.kind === 'snapshot' ? d.chars : chars + d.chars;

    save();
    render();
  });

  function save() {
    if (!alive()) return;
    try {
      chrome.storage.local.set({
        context: { uuid: uuid, chars: chars, updatedAt: Date.now() }
      }).catch(function () { /* contexte invalide */ });
    } catch (e) { /* contexte invalide */ }
  }

  // Reprend la valeur stockee quand on revient sur une conversation que le SPA ne
  // recharge pas. Le prochain snapshot ecrasera de toute facon.
  function restore(target) {
    if (!alive()) return;
    try {
      chrome.storage.local.get('context').then(function (o) {
        // Navigation entre-temps, ou snapshot deja arrive pendant la lecture : dans les
        // deux cas la valeur stockee est perimee.
        if (uuid !== target || chars > 0) return;
        chars = (o.context && o.context.uuid === target) ? o.context.chars : 0;
        render();
      }, function () { /* contexte invalide */ });
    } catch (e) { /* contexte invalide */ }
  }

  // Un seul timer couvre les deux fragilites du SPA : changement d'URL sans rechargement,
  // et pastille arrachee du DOM par un re-rendu de React.
  function tick() {
    var p = pathUuid();
    if (p && p !== uuid) {
      uuid = p;
      chars = 0;
      restore(p);
    }
    render();
  }

  // ---- affichage -----------------------------------------------------------

  function render() {
    var visible = !!pathUuid() && chars > 0;

    if (!visible) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    if (!document.body) return;

    if (!el) {
      el = document.createElement('div');
      el.id = EL_ID;
      el.title = 'Estimation grossiere : caracteres transmis divises par 4. '
               + "Ce n'est pas un comptage de tokens exact.";
      el.style.cssText = [
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
    }

    var tokens = Math.round(chars / CHARS_PER_TOKEN);
    el.textContent = '~' + tokens.toLocaleString('fr-FR') + ' tokens (estimation)';
    if (el.parentNode !== document.body) document.body.appendChild(el);
  }

  tick();
  setInterval(tick, 1000);
})();
