// Monde MAIN, document_start. Patche fetch pour observer deux choses sur claude.ai :
//   - l'evenement SSE "message_limit" du flux /chat_conversations/<uuid>/completion
//     (usage session 5h et hebdo 7j) ;
//   - de quoi estimer la taille du contexte : longueur du GET de conversation (base),
//     du payload envoye, et du texte streame en reponse (increments).
// Tout est transmis au monde isole par postMessage ; ce fichier n'ecrit jamais en storage.
//
// REGLE D'OR : ce fichier ne doit jamais casser claude.ai. Tout chemin de capture est dans
// un try/catch, et la valeur de retour des fonctions patchees ne depend jamais du succes
// de la capture.
(function () {
  'use strict';

  if (window.__claudeUsageV1) return;
  try {
    Object.defineProperty(window, '__claudeUsageV1', { value: true });
  } catch (e) { /* pas grave */ }

  // Passer a true pour tracer les captures dans la console de la page.
  var DEBUG = false;

  var MAGIC = '__claude_usage_v1__';
  var SSE_BYTE_BUDGET = 4e6;
  var SSE_MS_BUDGET = 120000;
  var SSE_LINE_MAX = 64 * 1024;

  // Teste sur le pathname : l'URL reelle est
  // /api/organizations/<org>/chat_conversations/<uuid>[/completion].
  var COMPLETION_RE = /\/chat_conversations\/([0-9a-f-]{36})\/completion$/i;
  var CONVERSATION_RE = /\/chat_conversations\/([0-9a-f-]{36})$/i;

  // Retourne {what, uuid} pour les deux seules URL qui nous interessent, sinon null.
  function match(u) {
    try {
      var url = new URL(u, location.href);
      var h = url.hostname;
      if (h !== 'claude.ai' && !h.endsWith('.claude.ai')) return null;

      var m = COMPLETION_RE.exec(url.pathname);
      if (m) return { what: 'completion', uuid: m[1] };
      m = CONVERSATION_RE.exec(url.pathname);
      if (m) return { what: 'conversation', uuid: m[1] };
      return null;
    } catch (e) { return null; }
  }

  function emit(msg) {
    try {
      msg.__cu = MAGIC;
      window.postMessage(msg, location.origin);
    } catch (e) { /* pas grave */ }
  }

  // ---- corps de la requete -------------------------------------------------

  // Doit etre appele AVANT le fetch natif : fetch consomme le corps d'une Request, donc
  // le clone est obligatoire et doit etre pris avant.
  function captureRequestBody(input, init, uuid) {
    try {
      var body = init && init.body;
      if (typeof body === 'string') {
        emit({ kind: 'request', uuid: uuid, chars: body.length });
        return;
      }
      if (typeof Request !== 'undefined' && input instanceof Request && input.body) {
        input.clone().text().then(function (text) {
          emit({ kind: 'request', uuid: uuid, chars: text.length });
        }, function () { /* pas grave */ });
      }
    } catch (e) { /* pas grave */ }
  }

  // ---- reponses ------------------------------------------------------------

  function onResponse(hit, res) {
    if (!res || !res.status || !res.body) return;

    var ct = '';
    try { ct = (res.headers.get('content-type') || '').toLowerCase(); } catch (e) { /* pas grave */ }

    if (hit.what === 'completion') {
      if (ct.indexOf('text/event-stream') === 0) tapEventStream(hit, res);
      return;
    }

    // GET de conversation : c'est la seule reponse qui porte tout l'historique. On ne la
    // parse pas, sa longueur brute suffit pour une estimation annoncee comme telle.
    if (ct.indexOf('application/json') !== 0) return;
    var clone;
    try { clone = res.clone(); } catch (e) { return; }
    clone.text().then(function (text) {
      emit({ kind: 'snapshot', uuid: hit.uuid, chars: text.length });
      if (DEBUG) console.log('[usage] snapshot', hit.uuid, text.length);
    }, function () { /* pas grave */ });
  }

  // Tap SSE borne. Aucune E/S dans la boucle de lecture (le tee() cale sa contre-pression
  // sur la branche la plus lente : un postMessage par delta ferait saccader le rendu de
  // claude.ai). On n'emet que sur "message_limit" et une seule fois a la sortie du flux.
  function tapEventStream(hit, res) {
    var clone, reader;
    try { clone = res.clone(); } catch (e) { return; }
    try { reader = clone.body.getReader(); } catch (e) { return; }

    var dec = new TextDecoder();
    var deadline = Date.now() + SSE_MS_BUDGET;
    var finished = false;
    var carry = '';
    var bytes = 0;
    var replyChars = 0;

    function onLine(line) {
      if (line.indexOf('data:') !== 0) return;

      if (line.indexOf('"content_block_delta"') !== -1) {
        try {
          var d = JSON.parse(line.slice(5)).delta;
          var t = d && (d.text || d.thinking);
          if (typeof t === 'string') replyChars += t.length;
        } catch (e) { /* pas grave */ }
        return;
      }

      if (line.indexOf('"message_limit"') !== -1) {
        try {
          var o = JSON.parse(line.slice(5));
          if (o && o.type === 'message_limit' && o.message_limit) {
            emit({ kind: 'limit', data: o.message_limit });
            if (DEBUG) console.log('[usage] message_limit', o.message_limit);
          }
        } catch (e) { /* pas grave */ }
      }
    }

    // Decoupage en lignes avec report : un evenement a cheval sur deux lectures serait
    // manque sans ca.
    function feed(text) {
      if (!text) return;
      var parts = (carry + text).split('\n');
      carry = parts.pop();
      if (carry.length > SSE_LINE_MAX) { onLine(carry); carry = ''; }
      for (var i = 0; i < parts.length; i++) {
        var l = parts[i];
        if (l.charCodeAt(l.length - 1) === 13) l = l.slice(0, -1);
        onLine(l);
      }
    }

    function finish(end) {
      if (finished) return;
      finished = true;
      try {
        feed(dec.decode());          // vider le decodeur : sequence multi-octets en attente
        if (carry) { onLine(carry); carry = ''; }
      } catch (e) { /* pas grave */ }

      emit({ kind: 'reply', uuid: hit.uuid, chars: replyChars });
      if (DEBUG) console.log('[usage] tap end', end, 'reponse', replyChars, 'caracteres');
    }

    function step() {
      reader.read().then(function (r) {
        if (r.done) { finish('done'); return; }
        try {
          bytes += r.value ? r.value.byteLength : 0;
          feed(dec.decode(r.value, { stream: true }));
        } catch (e) { /* pas grave */ }

        if (bytes > SSE_BYTE_BUDGET || Date.now() > deadline) {
          try { reader.cancel().catch(function () {}); } catch (e) { /* pas grave */ }
          finish('budget');
          return;
        }
        step();
      }, function (e) {
        // Rejette quand la page annule la requete (bouton Stop) : on emet quand meme ce
        // qui a deja ete accumule.
        finish(e && e.name === 'AbortError' ? 'abort' : 'error');
      });
    }

    step();
  }

  // ---- patch fetch ---------------------------------------------------------

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    var patchedFetch = function fetch(input, init) {
      var hit = null;
      try {
        var isRequest = typeof Request !== 'undefined' && input instanceof Request;
        var url = isRequest ? input.url : String(input && input.url ? input.url : input);
        var method = (isRequest ? input.method : (init && init.method)) || 'GET';
        hit = match(url);

        // Un PUT de renommage repond sur la meme URL que le GET, mais sans les messages :
        // le prendre pour un snapshot ecraserait l'estimation par une valeur minuscule.
        if (hit && hit.what === 'conversation' && method.toUpperCase() !== 'GET') hit = null;

        // Avant l'appel natif, sinon le corps de la Request est deja consomme.
        if (hit && hit.what === 'completion') captureRequestBody(input, init, hit.uuid);
      } catch (e) { hit = null; }

      var p = nativeFetch.apply(this, arguments);
      try {
        if (hit && p && typeof p.then === 'function') {
          // Le handler de rejet n'est pas optionnel : claude.ai annule des requetes en
          // permanence (bouton Stop, navigation).
          p.then(function (res) {
            try { onResponse(hit, res); } catch (e) { /* pas grave */ }
          }, function () {});
        }
      } catch (e) { /* pas grave */ }
      return p; // la promesse originale, jamais un wrapper
    };
    try {
      patchedFetch.toString = function () { return 'function fetch() { [native code] }'; };
    } catch (e) { /* pas grave */ }
    window.fetch = patchedFetch;
  }
})();
