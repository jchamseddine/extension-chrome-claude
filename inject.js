// Monde MAIN, document_start. Patche fetch pour estimer la taille du contexte : longueur du
// GET de conversation (base), du payload envoye, et du texte streame en reponse (increments).
// Tout est transmis au monde isole par postMessage ; ce fichier n'ecrit jamais en storage.
//
// L'usage (5h / 7j) ne passe plus par ici : il est sonde directement par le service worker.
// L'evenement SSE "message_limit" n'arrivait qu'apres l'envoi d'un message, ce qui rendait la
// donnee vieille des qu'on ne discutait pas.
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

  var DEBUG = false;

  var MAGIC = '__claude_usage_v1__';
  var SSE_BYTE_BUDGET = 4e6;
  var SSE_MS_BUDGET = 120000;
  var SSE_LINE_MAX = 64 * 1024;

  // Detection sur la ligne brute. Surtout PAS de contrainte sur un prefixe "data:" : une
  // donnee SSE peut etre repartie sur plusieurs lignes, arriver avec du padding, ou sans
  // prefixe du tout.
  var DELTA_RE = /"type"\s*:\s*"content_block_delta"/;

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
  // claude.ai). On accumule, et on n'emet qu'une fois, a la sortie du flux.
  function tapEventStream(hit, res) {
    var clone, reader;
    try { clone = res.clone(); } catch (e) {
      if (DEBUG) console.warn('[usage] tap : clone impossible', e);
      return;
    }
    try { reader = clone.body.getReader(); } catch (e) {
      if (DEBUG) console.warn('[usage] tap : reader impossible', e);
      return;
    }

    if (DEBUG) console.log('[usage] tap start', hit.uuid);

    var dec = new TextDecoder();
    var deadline = Date.now() + SSE_MS_BUDGET;
    var finished = false;
    var carry = '';
    var bytes = 0;
    var replyChars = 0;
    var lines = 0;      // jalon de diagnostic : "aucun log" doit pouvoir se distinguer de
                        // "le tap tourne mais ne matche rien"

    // Le JSON commence au premier '{' : tolere "data:", "data: ", du padding, ou l'absence
    // de prefixe. L'offset 5 code en dur de la version precedente n'admettait que "data:".
    function payloadOf(line) {
      var i = line.indexOf('{');
      return i === -1 ? null : JSON.parse(line.slice(i));
    }

    function onLine(line) {
      lines++;
      if (line.indexOf('{') === -1) return;   // lignes "event:", commentaires ":", vides

      if (DELTA_RE.test(line)) {
        try {
          var d = payloadOf(line).delta;
          var t = d && (d.text || d.thinking);
          if (typeof t === 'string') replyChars += t.length;
        } catch (e) { /* pas grave : un delta perdu ne fausse l'estimation qu'a la marge */ }
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
      if (DEBUG) {
        console.log('[usage] tap end', end, '| lignes:', lines, '| reponse:', replyChars,
                    'caracteres');
      }
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

  // ---- navigation SPA ------------------------------------------------------

  // Chaque monde a son propre History.prototype : patcher pushState depuis le monde isole
  // n'intercepterait rien, les appels de la page passent par SON prototype. Le patch doit
  // donc vivre ici, et le changement d'URL est relaye par postMessage.
  function emitNav() {
    emit({ kind: 'navigation', path: location.pathname });
  }

  ['pushState', 'replaceState'].forEach(function (name) {
    var native = history[name];
    if (typeof native !== 'function') return;
    history[name] = function () {
      var r = native.apply(this, arguments);   // location est deja a jour au retour
      try { emitNav(); } catch (e) { /* pas grave */ }
      return r;
    };
  });

  // pushState ne couvre pas le retour arriere.
  window.addEventListener('popstate', emitNav);
})();
