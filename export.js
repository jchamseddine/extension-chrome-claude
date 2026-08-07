// Isolated world, document_idle. Adds an export button next to "Partager" in the conversation
// header, with two outputs: Markdown and PDF. claude.ai exposes no native export —
// checked in the sidebar's "…" menu, the title's one, and the share modal — so nothing
// is duplicated here.
//
// A feature independent of the rest of the extension: writes NO storage key, has
// nothing to do with folders.js, theme.js, usage-source.js or status-source.js.
//
// THE CONTENT COMES FROM THE API, NOT FROM THE DOM. The GET /api/organizations/<org>/chat_conversations/
// <uuid> is the only response that carries the whole history (confirmed by the capture that serves
// the context estimation, see the header of inject.js). Reading the DOM would have required scrolling
// through the whole conversation before exporting, with the risk of a truncated export without it
// showing. Here, either the export is complete, or it fails and says so.
//
// No IIFE, "ex"/"EX_" prefix on top-level names: the extension's content scripts
// share a single isolated world per frame (same constraint as theme.js,
// autocontinue.js and folders.js).
'use strict';

// Selectors confirmed by real inspection. ANCHORING ORDER: the "Partager" button first,
// the slot as a fallback — and not the other way round. The slot had been taken for "the" stable
// insertion point, but it is absent from at least one context (Project conversation), where the export
// disabled itself while "Partager" was there. The "Partager" button, on the other hand, is what we really
// aim at: placement neighbour AND style model. Anchoring on it makes the detection
// independent of the header shell, hence of the context, without having to guess a
// container selector per context.
var EX_SLOT = 'div#dframe-header-actions-slot';
var EX_SHARE = 'button[data-testid="wiggle-controls-actions-share"]';
var EX_HEADER = 'div[data-testid="chat-header"]';

var EX_BTN_ID = '__claude_export_button';
var EX_MENU_ID = '__claude_export_menu';
var EX_STYLE_ID = '__claude_export_style';
var EX_DEBOUNCE_MS = 150;

var exObserver = null;
var exTarget = null;
var exTimer = null;
var exMenu = null;
var exBusy = false;
var exWarned = {};

function exAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
}

function exWarn(key, message) {
  if (exWarned[key]) return;
  exWarned[key] = true;
  console.warn('[export] ' + message);
}

function exNode(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ---- style -------------------------------------------------------------------

// The BUTTON has no style of its own: it copies the class of the "Partager" button (see
// exButton()). These rules therefore only serve the menu and the toast, which have no native
// equivalent to imitate.
function exStyle() {
  if (document.getElementById(EX_STYLE_ID)) return;

  var css = [
    '#' + EX_MENU_ID + '{position:fixed;z-index:2147483647;min-width:170px;padding:4px;',
    'border-radius:8px;background:#1c1c1e;color:#f5f5f4;box-shadow:0 6px 24px rgba(0,0,0,.35);',
    'font:12px/1.5 system-ui,sans-serif}',
    '#' + EX_MENU_ID + ' button{all:unset;display:block;box-sizing:border-box;width:100%;',
    'padding:6px 9px;border-radius:5px;cursor:pointer}',
    '#' + EX_MENU_ID + ' button:hover{background:rgba(255,255,255,.12)}',
    '#' + EX_MENU_ID + ' button[disabled]{opacity:.5;cursor:default}',
    '.ex-toast{position:fixed;bottom:76px;right:12px;z-index:2147483647;padding:5px 10px;',
    'border-radius:999px;background:rgba(20,20,22,.88);color:#f5f5f4;',
    'font:11px/1.4 system-ui,sans-serif;pointer-events:none;white-space:nowrap}'
  ].join('');

  var el = exNode('style');
  el.id = EX_STYLE_ID;
  el.textContent = css;
  (document.head || document.documentElement).appendChild(el);
}

// Positioned above the auto-continue toast (bottom 44 px) and the context badge
// (bottom 12 px), so the three can coexist without covering each other.
function exToast(text, ms) {
  var root = document.documentElement;
  if (!root) return null;

  var el = exNode('div', 'ex-toast', text);
  root.appendChild(el);
  if (ms) setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, ms);
  return el;
}

// ---- fetching the conversation -----------------------------------------------

// The URLs the PAGE has already called. That is where the organization uuid comes from: collecting it
// here means reading it from a request actually emitted, instead of guessing it from an assumed
// path (ORGS_PATH, the only unverified assumption of the repo, is not used).
function exSeenUrls() {
  try {
    return performance.getEntriesByType('resource').map(function (e) { return e.name; });
  } catch (e) {
    return [];
  }
}

function exFetchConversation() {
  var uuid = exportUuidFromPath(location.pathname);
  if (!uuid) return Promise.reject(new Error('aucune conversation ouverte'));

  var url = exportFindConversationUrl(exSeenUrls(), uuid);
  if (!url) {
    return Promise.reject(new Error(
      "impossible de retrouver l'organisation dans les requêtes de la page — recharger l'onglet"));
  }

  // Same-origin from the page: cookies, Origin and Referer are the ones the API expects. It is
  // the same mechanism as the usage polling fallback relay (content.js).
  return fetch(url, { credentials: 'include', headers: { accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' sur le GET de conversation');
      return res.json();
    })
    .then(function (json) {
      var conv = parseConversation(json);   // already says in the console what is missing
      if (!conv) throw new Error('format de réponse inconnu (voir la console)');
      if (!conv.messages.length) throw new Error('aucun message exploitable dans la réponse');

      // The response title is authoritative; document.title is a fallback, it carries the site's
      // suffix and reads "Claude" on a conversation still without a name.
      if (!conv.title) conv.title = String(document.title || '').replace(/\s*[-–|]\s*Claude\s*$/i, '');
      return conv;
    });
}

// ---- outputs -----------------------------------------------------------------

function exDownload(text, mime, filename) {
  var url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  var a = exNode('a');
  a.href = url;
  a.download = filename;
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  // Gives the download time to start before releasing the object.
  setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
}

function exExportMarkdown(conv, now) {
  exDownload(exportMarkdown(conv, now), 'text/markdown',
    exportFileName(conv.title, now, 'md'));
  exToast('Markdown exporté', 3000);
}

// No jsPDF nor any library: we print a self-contained document and Chrome offers
// "Save as PDF". Printing goes through an offscreen iframe rather than a
// window: no pop-up blocker to fight, and above all window.print() then prints
// ONLY that document, not the claude.ai page around it.
//
// srcdoc inherits claude.ai's CSP: we therefore put no script in it, only HTML and
// a stylesheet. That is also why print() is called from here, from outside.
function exExportPdf(conv, now) {
  var frame = exNode('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.srcdoc = exportHtml(conv, now);

  frame.addEventListener('load', function () {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (e) {
      console.warn('[export] printing impossible:', (e && e.message) || e);
      exToast("Impression impossible — l'export Markdown reste disponible", 5000);
    }
    // print() blocks as long as the dialog is open; we only remove the iframe
    // afterwards, and with a delay, because Chrome still reads the document during the preview.
    setTimeout(function () { frame.remove(); }, 60000);
  });

  document.documentElement.appendChild(frame);
  exToast('Préparation du PDF…', 3000);
}

// ---- menu --------------------------------------------------------------------

function exCloseMenu() {
  if (exMenu && exMenu.parentNode) exMenu.parentNode.removeChild(exMenu);
  exMenu = null;
}

function exRun(kind) {
  if (exBusy) return;
  exBusy = true;

  var waiting = exToast('Récupération de la conversation…');
  exFetchConversation().then(function (conv) {
    var now = new Date();
    if (kind === 'md') exExportMarkdown(conv, now);
    else exExportPdf(conv, now);
  }).catch(function (e) {
    var msg = (e && e.message) || String(e);
    console.warn('[export] failure:', msg);
    exToast('Export impossible : ' + msg, 6000);
  }).then(function () {
    if (waiting && waiting.parentNode) waiting.parentNode.removeChild(waiting);
    exBusy = false;
  });
}

function exOpenMenu(anchor) {
  exCloseMenu();

  var menu = exNode('div');
  menu.id = EX_MENU_ID;

  [['Exporter en Markdown', 'md'], ['Exporter en PDF', 'pdf']].forEach(function (spec) {
    var b = exNode('button', null, spec[0]);
    b.addEventListener('click', function () {
      exCloseMenu();
      exRun(spec[1]);
    });
    menu.appendChild(b);
  });

  document.documentElement.appendChild(menu);

  // Aligned under the button, then pulled back into the window if it overflows.
  var box = anchor.getBoundingClientRect();
  menu.style.top = (box.bottom + 6) + 'px';
  menu.style.left = box.left + 'px';

  var m = menu.getBoundingClientRect();
  if (m.right > window.innerWidth) {
    menu.style.left = Math.max(4, window.innerWidth - m.width - 8) + 'px';
  }

  exMenu = menu;
}

document.addEventListener('click', function (e) {
  if (exMenu && !exMenu.contains(e.target) && e.target.id !== EX_BTN_ID) exCloseMenu();
}, true);

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') exCloseMenu();
}, true);

// ---- button ------------------------------------------------------------------

// Download icon, drawn as a stroke like the site's ones (currentColor, stroke of 2,
// rounded caps) rather than a character: an emoji would follow neither the color nor the size of the
// neighbouring buttons.
function exIcon(size) {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2');
  svg.appendChild(path);
  return svg;
}

// The style is not invented: we COPY the class of the "Partager" button, so the size, the
// radius, the hover states and the theme follow the site without our having to know them. Same
// technique as folders.js for the sections. Without a "Partager" button, we fall back on a neutral
// style rather than displaying nothing.
function exButton(share) {
  var btn = exNode('button');
  btn.id = EX_BTN_ID;
  btn.type = 'button';
  btn.title = 'Exporter la conversation';
  btn.setAttribute('aria-label', 'Exporter la conversation');

  var size = '16';
  if (share) {
    btn.className = share.className;
    var icon = share.querySelector('svg');
    if (icon) {
      var w = icon.getAttribute('width');
      if (w) size = w;
    }
  } else {
    btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;' +
      'width:32px;height:32px;border:0;border-radius:8px;background:none;color:inherit;' +
      'cursor:pointer';
  }

  btn.appendChild(exIcon(size));
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (exMenu) exCloseMenu();
    else exOpenMenu(btn);
  });

  return btn;
}

// Where to place the button, whatever the context (standard conversation, Project conversation).
// Returns { share, container } or null if the header offers neither of the two known anchors.
//
// The search for the "Partager" button goes from nearest to widest — slot, then header, then
// document — so that the standard case behaves exactly as before, and contexts
// without a slot or a recognized header still find their anchor. NO new selector is
// introduced here: it is the same confirmed pair, tried in an order that no longer assumes a
// single header structure.
function exAnchor() {
  var slot = document.querySelector(EX_SLOT);
  var header = document.querySelector(EX_HEADER);

  var share = (slot && slot.querySelector(EX_SHARE))
    || (header && header.querySelector(EX_SHARE))
    || document.querySelector(EX_SHARE);

  if (share && share.parentNode) return { share: share, container: share.parentNode };
  if (slot) return { share: null, container: slot };
  return null;
}

// The button only makes sense on an open conversation: on the home page there is nothing to
// export. It is therefore placed and removed as navigation goes.
function exPlace() {
  if (!exAlive()) return;

  var existing = document.getElementById(EX_BTN_ID);
  var anchor = exportUuidFromPath(location.pathname) ? exAnchor() : null;

  if (!anchor) {
    if (existing) existing.remove();
    return;
  }

  if (!anchor.share) {
    exWarn('share', 'button "' + EX_SHARE + '" not found: the export button takes a ' +
      'neutral style instead of copying the site\'s one.');
  }

  // Already in place at the right spot: no header re-render happened, we touch nothing.
  if (existing && existing.parentNode === anchor.container &&
      (!anchor.share || existing.previousSibling === anchor.share)) return;
  if (existing) existing.remove();

  exStyle();
  var btn = exButton(anchor.share);

  // Just after "Partager", in its own container; failing that, at the end of the slot.
  if (anchor.share) anchor.container.insertBefore(btn, anchor.share.nextSibling);
  else anchor.container.appendChild(btn);
}

// ---- observation -------------------------------------------------------------

// claude.ai is an SPA: the header re-renders on every navigation, and our button goes with it.
// We therefore observe the header — or the document as long as it does not exist — and place the button
// back after each render. takeRecords() discards the mutations we have just caused ourselves.
function exSchedule() {
  clearTimeout(exTimer);
  exTimer = setTimeout(function () {
    exWatch();
    exPlace();
    if (exObserver) exObserver.takeRecords();
  }, EX_DEBOUNCE_MS);
}

function exWatch() {
  var target = document.querySelector(EX_HEADER) || document.documentElement;
  if (!target || target === exTarget) return;

  if (exObserver) exObserver.disconnect();
  exObserver = new MutationObserver(exSchedule);
  exObserver.observe(target, { childList: true, subtree: true });
  exTarget = target;
}

exWatch();
exPlace();

// A single, explicit message if NEITHER of the two anchors has ever appeared. Reserved for the case
// where a conversation is indeed open: on the home page, their absence is normal.
//
// The message names both selectors and says whether the header itself was recognized: that is what
// distinguishes "the header changed structure" from "this context has no conversation
// header at all", and it avoids a second inspection round trip.
setTimeout(function () {
  if (document.getElementById(EX_BTN_ID) || !exportUuidFromPath(location.pathname)) return;
  exWarn('slot', 'no anchor point in the header: neither "' + EX_SHARE + '" nor "' +
    EX_SLOT + '" (header "' + EX_HEADER + '" ' +
    (document.querySelector(EX_HEADER) ? 'present' : 'absent') + '). The export button is ' +
    'disabled and nothing was inserted. See the Export section of the README.');
}, 8000);
