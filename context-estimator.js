// Monde isole, document_start. Estime la taille du contexte de chaque conversation et
// affiche celle de la conversation ouverte dans une pastille fixe en bas a droite.
//
// Le POST vers /completion ne contient QUE le nouveau message : l'historique reste cote
// serveur. La base vient donc du GET de la conversation (qui, lui, porte tout l'historique),
// et on y ajoute a chaud les caracteres envoyes puis ceux de la reponse streamee.
// caracteres / 4 est une approximation grossiere du nombre de tokens, jamais une mesure.
//
// FORMAT DE STOCKAGE — une cle chrome.storage.local par conversation :
//
//   "ctx:<uuid>" -> { chars: 49600, tokens: 12400, updatedAt: 1785260400000 }
//
//   <uuid>    uuid de la conversation, extrait par inject.js de l'URL interceptee
//             /chat_conversations/<uuid>/completion (et du GET de meme prefixe).
//   chars     total de caracteres transmis — c'est la valeur cumulable, les increments
//             arrivent en caracteres.
//   tokens    Math.round(chars / 4), ecrit en meme temps que chars pour que la cle soit
//             lisible telle quelle sans reappliquer la conversion.
//   updatedAt derniere mise a jour, en millisecondes ; sert de cle de tri au LRU.
//
// Seules les MAX_CONVERSATIONS conversations les plus recemment mises a jour sont
// conservees, pour que les conversations abandonnees ne s'accumulent pas indefiniment.
(function () {
  'use strict';

  var MAGIC = '__claude_usage_v1__';
  var CHARS_PER_TOKEN = 4;
  var MAX_CONVERSATIONS = 20;
  var PREFIX = 'ctx:';
  var EL_ID = '__claude_usage_context_badge';
  var CHAT_RE = /^\/chat\/([0-9a-f-]{36})/i;

  var displayed = null;   // uuid lu dans l'URL DE LA PAGE, pas dans celle des requetes
  var chars = null;       // null = aucune estimation connue, a distinguer d'un zero
  var el = null;
  var chain = Promise.resolve();

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function currentUuid() {
    var m = CHAT_RE.exec(location.pathname);
    return m ? m[1] : null;
  }

  // ---- stockage ------------------------------------------------------------

  // Lecture-modification-ecriture serialisee : deux increments de la meme conversation
  // peuvent arriver a quelques millisecondes d'intervalle (payload envoye, puis reponse
  // streamee), et se liraient mutuellement une valeur perimee sans cette file.
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
    }).catch(function () { /* contexte invalide */ });
    // Pas de render() ici : chrome.storage.onChanged s'en charge, y compris quand c'est
    // un autre onglet qui a ecrit.
  }

  // LRU : on ne garde que les MAX_CONVERSATIONS cles ctx: les plus recentes.
  function prune() {
    return chrome.storage.local.get(null).then(function (all) {
      var keys = Object.keys(all).filter(function (k) { return k.indexOf(PREFIX) === 0; });
      if (keys.length <= MAX_CONVERSATIONS) return;
      keys.sort(function (a, b) {
        return (all[b].updatedAt || 0) - (all[a].updatedAt || 0);
      });
      // Idempotent : deux onglets qui elaguent en meme temps ne se genent pas.
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

  // ---- conversation affichee ----------------------------------------------

  function setDisplayed(uuid) {
    if (uuid === displayed) return;
    displayed = uuid;
    chars = null;
    render();                       // etat neutre immediat pendant la lecture du storage
    if (!uuid || !alive()) return;

    var key = PREFIX + uuid;
    chrome.storage.local.get(key).then(function (o) {
      if (displayed !== uuid) return;                    // navigation entre-temps
      chars = (o[key] && typeof o[key].chars === 'number') ? o[key].chars : null;
      render();
    }, function () { /* contexte invalide */ });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    var d = event.data;
    if (!d || typeof d !== 'object' || d.__cu !== MAGIC) return;

    if (d.kind === 'navigation') { setDisplayed(currentUuid()); return; }

    // L'uuid vient de l'URL de la requete : une conversation neuve est alimentee avant
    // meme que son URL de page ne soit poussee, et sera lue au moment de la navigation.
    if (d.kind !== 'snapshot' && d.kind !== 'request' && d.kind !== 'reply') return;
    if (!d.uuid || typeof d.chars !== 'number') return;
    update(d.uuid, d.kind, d.chars);
  });

  // ---- affichage -----------------------------------------------------------

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
      // Un « ~0 tokens » ferait croire a une conversation vide alors qu'on ne sait rien.
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

  // Pastille accrochee a <html> et non a <body> : hors du conteneur que React remonte.
  // L'observateur ne couvre que le cas residuel ou elle serait quand meme arrachee.
  if (document.documentElement) {
    new MutationObserver(function () {
      if (el && displayed && el.parentNode !== document.documentElement) render();
    }).observe(document.documentElement, { childList: true });
  }

  setDisplayed(currentUuid());
})();
