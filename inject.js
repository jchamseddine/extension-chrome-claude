// MAIN world, document_start. Patches fetch to estimate the context size: length of the
// conversation GET (baseline), of the sent payload, and of the text streamed in reply (increments).
// Everything is passed to the isolated world by postMessage; this file never writes to storage.
//
// Usage (5h / 7d) no longer goes through here: it is polled directly by the service worker.
// The "message_limit" SSE event only arrived after a message was sent, which made the
// data stale as soon as you were not chatting.
//
// GOLDEN RULE: this file must never break claude.ai. Every capture path is in
// a try/catch, and the return value of the patched functions never depends on the success
// of the capture.
(function () {
  'use strict';

  if (window.__claudeUsageV1) return;
  try {
    Object.defineProperty(window, '__claudeUsageV1', { value: true });
  } catch (e) { /* harmless */ }

  var DEBUG = false;

  var MAGIC = '__claude_usage_v1__';
  var SSE_BYTE_BUDGET = 4e6;
  var SSE_MS_BUDGET = 120000;
  var SSE_LINE_MAX = 64 * 1024;

  // Detection on the raw line. Definitely NO constraint on a "data:" prefix: an
  // SSE datum can be spread over several lines, arrive with padding, or with no
  // prefix at all.
  var DELTA_RE = /"type"\s*:\s*"content_block_delta"/;

  // Tested on the pathname: the real URL is
  // /api/organizations/<org>/chat_conversations/<uuid>[/completion].
  var COMPLETION_RE = /\/chat_conversations\/([0-9a-f-]{36})\/completion$/i;
  var CONVERSATION_RE = /\/chat_conversations\/([0-9a-f-]{36})$/i;

  // Returns {what, uuid} for the only two URLs we care about, null otherwise.
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
    } catch (e) { /* harmless */ }
  }

  // ---- request body --------------------------------------------------------

  // Must be called BEFORE the native fetch: fetch consumes the body of a Request, so
  // the clone is mandatory and must be taken beforehand.
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
        }, function () { /* harmless */ });
      }
    } catch (e) { /* harmless */ }
  }

  // ---- responses -----------------------------------------------------------

  function onResponse(hit, res) {
    if (!res || !res.status || !res.body) return;

    var ct = '';
    try { ct = (res.headers.get('content-type') || '').toLowerCase(); } catch (e) { /* harmless */ }

    if (hit.what === 'completion') {
      if (ct.indexOf('text/event-stream') === 0) tapEventStream(hit, res);
      return;
    }

    // Conversation GET: this is the only response that carries the whole history. We do not
    // parse it, its raw length is enough for an estimate advertised as such.
    if (ct.indexOf('application/json') !== 0) return;
    var clone;
    try { clone = res.clone(); } catch (e) { return; }
    clone.text().then(function (text) {
      emit({ kind: 'snapshot', uuid: hit.uuid, chars: text.length });
      if (DEBUG) console.log('[usage] snapshot', hit.uuid, text.length);
    }, function () { /* harmless */ });
  }

  // Bounded SSE tap. No I/O in the read loop (tee() paces its backpressure
  // on the slowest branch: one postMessage per delta would make claude.ai's rendering
  // stutter). We accumulate, and emit only once, on stream exit.
  function tapEventStream(hit, res) {
    var clone, reader;
    try { clone = res.clone(); } catch (e) {
      if (DEBUG) console.warn('[usage] tap: clone impossible', e);
      return;
    }
    try { reader = clone.body.getReader(); } catch (e) {
      if (DEBUG) console.warn('[usage] tap: reader impossible', e);
      return;
    }

    if (DEBUG) console.log('[usage] tap start', hit.uuid);

    var dec = new TextDecoder();
    var deadline = Date.now() + SSE_MS_BUDGET;
    var finished = false;
    var carry = '';
    var bytes = 0;
    var replyChars = 0;
    var lines = 0;      // diagnostic marker: "no log" must be distinguishable from
                        // "the tap is running but matches nothing"

    // The JSON starts at the first '{': tolerates "data:", "data: ", padding, or the absence
    // of a prefix. The hard-coded offset 5 of the previous version only accepted "data:".
    function payloadOf(line) {
      var i = line.indexOf('{');
      return i === -1 ? null : JSON.parse(line.slice(i));
    }

    function onLine(line) {
      lines++;
      if (line.indexOf('{') === -1) return;   // "event:" lines, ":" comments, empty ones

      if (DELTA_RE.test(line)) {
        try {
          var d = payloadOf(line).delta;
          var t = d && (d.text || d.thinking);
          if (typeof t === 'string') replyChars += t.length;
        } catch (e) { /* harmless: a lost delta only skews the estimate marginally */ }
      }
    }

    // Splitting into lines with carry-over: an event straddling two reads would be
    // missed without this.
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
        feed(dec.decode());          // flush the decoder: multi-byte sequence pending
        if (carry) { onLine(carry); carry = ''; }
      } catch (e) { /* harmless */ }

      emit({ kind: 'reply', uuid: hit.uuid, chars: replyChars });
      if (DEBUG) {
        console.log('[usage] tap end', end, '| lines:', lines, '| reply:', replyChars,
                    'characters');
      }
    }

    function step() {
      reader.read().then(function (r) {
        if (r.done) { finish('done'); return; }
        try {
          bytes += r.value ? r.value.byteLength : 0;
          feed(dec.decode(r.value, { stream: true }));
        } catch (e) { /* harmless */ }

        if (bytes > SSE_BYTE_BUDGET || Date.now() > deadline) {
          try { reader.cancel().catch(function () {}); } catch (e) { /* harmless */ }
          finish('budget');
          return;
        }
        step();
      }, function (e) {
        // Rejects when the page cancels the request (Stop button): we still emit what
        // has already been accumulated.
        finish(e && e.name === 'AbortError' ? 'abort' : 'error');
      });
    }

    step();
  }

  // ---- fetch patch ---------------------------------------------------------

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    var patchedFetch = function fetch(input, init) {
      var hit = null;
      try {
        var isRequest = typeof Request !== 'undefined' && input instanceof Request;
        var url = isRequest ? input.url : String(input && input.url ? input.url : input);
        var method = (isRequest ? input.method : (init && init.method)) || 'GET';
        hit = match(url);

        // A rename PUT answers on the same URL as the GET, but without the messages:
        // taking it for a snapshot would overwrite the estimate with a tiny value.
        if (hit && hit.what === 'conversation' && method.toUpperCase() !== 'GET') hit = null;

        // Before the native call, otherwise the Request body is already consumed.
        if (hit && hit.what === 'completion') captureRequestBody(input, init, hit.uuid);
      } catch (e) { hit = null; }

      var p = nativeFetch.apply(this, arguments);
      try {
        if (hit && p && typeof p.then === 'function') {
          // The rejection handler is not optional: claude.ai cancels requests
          // constantly (Stop button, navigation).
          p.then(function (res) {
            try { onResponse(hit, res); } catch (e) { /* harmless */ }
          }, function () {});
        }
      } catch (e) { /* harmless */ }
      return p; // the original promise, never a wrapper
    };
    try {
      patchedFetch.toString = function () { return 'function fetch() { [native code] }'; };
    } catch (e) { /* harmless */ }
    window.fetch = patchedFetch;
  }

  // ---- SPA navigation ------------------------------------------------------

  // Each world has its own History.prototype: patching pushState from the isolated world
  // would intercept nothing, the page's calls go through ITS prototype. The patch must
  // therefore live here, and the URL change is relayed by postMessage.
  function emitNav() {
    emit({ kind: 'navigation', path: location.pathname });
  }

  ['pushState', 'replaceState'].forEach(function (name) {
    var native = history[name];
    if (typeof native !== 'function') return;
    history[name] = function () {
      var r = native.apply(this, arguments);   // location is already up to date on return
      try { emitNav(); } catch (e) { /* harmless */ }
      return r;
    };
  });

  // pushState does not cover going back.
  window.addEventListener('popstate', emitNav);
})();
