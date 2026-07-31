// Monde isole, document_idle. Ajoute un bouton d'export a cote de « Partager » dans l'en-tete
// de conversation, avec deux sorties : Markdown et PDF. claude.ai n'expose aucun export natif —
// verifie dans le menu « … » de la sidebar, celui du titre, et la modale de partage — donc rien
// n'est double ici.
//
// Fonctionnalite independante du reste de l'extension : n'ecrit AUCUNE cle de storage, n'a
// aucun rapport avec folders.js, theme.js, usage-source.js ni status-source.js.
//
// LE CONTENU VIENT DE L'API, PAS DU DOM. Le GET /api/organizations/<org>/chat_conversations/
// <uuid> est la seule reponse qui porte tout l'historique (confirme par la capture qui sert a
// l'estimation de contexte, voir l'en-tete de inject.js). Lire le DOM aurait exige de derouler
// toute la conversation avant d'exporter, avec le risque d'un export tronque sans que ca se
// voie. Ici, ou l'export est complet, ou il echoue en le disant.
//
// Pas d'IIFE, prefixe "ex"/"EX_" sur les noms de premier niveau : les content scripts de
// l'extension partagent un seul monde isole par frame (meme contrainte que theme.js,
// autocontinue.js et folders.js).
'use strict';

// Selecteurs confirmes par inspection reelle. Le slot est le point d'insertion STABLE ; le
// bouton « Partager » ne sert qu'a se placer juste apres lui et a copier son style.
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

// Le BOUTON n'a pas de style a lui : il copie la classe du bouton « Partager » (voir
// exButton()). Ces regles ne servent donc qu'au menu et au toast, qui n'ont pas d'equivalent
// natif a imiter.
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

// Cale au-dessus du toast de l'auto-continue (bas 44 px) et de la pastille de contexte
// (bas 12 px), pour que les trois puissent coexister sans se recouvrir.
function exToast(text, ms) {
  var root = document.documentElement;
  if (!root) return null;

  var el = exNode('div', 'ex-toast', text);
  root.appendChild(el);
  if (ms) setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, ms);
  return el;
}

// ---- recuperation de la conversation -----------------------------------------

// Les URL que la PAGE a deja appelees. C'est de la que sort l'uuid d'organisation : le relever
// ici, c'est le lire d'une requete reellement emise, au lieu de le deviner par un chemin
// suppose (ORGS_PATH, la seule supposition non verifiee du depot, n'est pas utilisee).
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

  // Same-origin depuis la page : cookies, Origin et Referer sont ceux que l'API attend. C'est
  // le meme mecanisme que le relais de secours du sondage d'usage (content.js).
  return fetch(url, { credentials: 'include', headers: { accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' sur le GET de conversation');
      return res.json();
    })
    .then(function (json) {
      var conv = parseConversation(json);   // dit deja en console ce qui manque
      if (!conv) throw new Error('format de réponse inconnu (voir la console)');
      if (!conv.messages.length) throw new Error('aucun message exploitable dans la réponse');

      // Le titre de la reponse fait foi ; document.title est un repli, il porte le suffixe du
      // site et vaut « Claude » sur une conversation encore sans nom.
      if (!conv.title) conv.title = String(document.title || '').replace(/\s*[-–|]\s*Claude\s*$/i, '');
      return conv;
    });
}

// ---- sorties -----------------------------------------------------------------

function exDownload(text, mime, filename) {
  var url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  var a = exNode('a');
  a.href = url;
  a.download = filename;
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  // Laisse au telechargement le temps de demarrer avant de liberer l'objet.
  setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
}

function exExportMarkdown(conv, now) {
  exDownload(exportMarkdown(conv, now), 'text/markdown',
    exportFileName(conv.title, now, 'md'));
  exToast('Markdown exporté', 3000);
}

// Pas de jsPDF ni d'aucune bibliotheque : on imprime un document autonome et Chrome propose
// « Enregistrer au format PDF ». L'impression passe par une iframe hors ecran plutot que par
// une fenetre : pas de bloqueur de pop-up a affronter, et surtout window.print() n'imprime
// alors QUE ce document, pas la page claude.ai autour.
//
// srcdoc herite de la CSP de claude.ai : on n'y met donc aucun script, uniquement du HTML et
// une feuille de style. C'est aussi pour ca que print() est appele d'ici, de l'exterieur.
function exExportPdf(conv, now) {
  var frame = exNode('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.srcdoc = exportHtml(conv, now);

  frame.addEventListener('load', function () {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (e) {
      console.warn('[export] impression impossible :', (e && e.message) || e);
      exToast("Impression impossible — l'export Markdown reste disponible", 5000);
    }
    // print() est bloquant tant que la boite de dialogue est ouverte ; on ne retire l'iframe
    // qu'apres, et avec du retard, parce que Chrome lit encore le document pendant l'apercu.
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
    console.warn('[export] échec :', msg);
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

  // Aligne sous le bouton, puis rentre dans la fenetre si ca deborde.
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

// ---- bouton ------------------------------------------------------------------

// Icone de telechargement, dessinee au trait comme celles du site (currentColor, trait de 2,
// bouts arrondis) plutot qu'un caractere : un emoji ne suivrait ni la couleur ni la taille des
// boutons voisins.
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

// Le style n'est pas invente : on COPIE la classe du bouton « Partager », donc la taille, le
// rayon, les etats de survol et le theme suivent le site sans qu'on ait a les connaitre. Meme
// procede que folders.js pour les sections. Sans bouton « Partager », on se rabat sur un style
// neutre plutot que de ne rien afficher.
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

// Le bouton n'a de sens que sur une conversation ouverte : sur l'accueil il n'y a rien a
// exporter. Il est donc pose et retire au fil de la navigation.
function exPlace() {
  if (!exAlive()) return;

  var slot = document.querySelector(EX_SLOT);
  var existing = document.getElementById(EX_BTN_ID);

  if (!slot || !exportUuidFromPath(location.pathname)) {
    if (existing) existing.remove();
    return;
  }

  var share = slot.querySelector(EX_SHARE) || document.querySelector(EX_SHARE);
  if (!share) {
    exWarn('share', 'bouton « ' + EX_SHARE + ' » introuvable : le bouton d\'export prend un ' +
      'style neutre au lieu de copier celui du site.');
  }

  // Deja en place au bon endroit : un re-rendu de l'en-tete n'a pas eu lieu, on ne touche a rien.
  if (existing && existing.parentNode && (!share || existing.previousSibling === share)) return;
  if (existing) existing.remove();

  exStyle();
  var btn = exButton(share);

  // Juste apres « Partager », dans son propre conteneur ; a defaut, en fin du slot stable.
  if (share && share.parentNode) share.parentNode.insertBefore(btn, share.nextSibling);
  else slot.appendChild(btn);
}

// ---- observation -------------------------------------------------------------

// claude.ai est une SPA : l'en-tete se re-rend a chaque navigation, et notre bouton part avec.
// On observe donc l'en-tete — ou le document tant qu'il n'existe pas — et on repose le bouton
// apres chaque rendu. takeRecords() jette les mutations qu'on vient soi-meme de provoquer.
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

// Un seul message, explicite, si le point d'insertion n'est jamais apparu. Reserve au cas ou
// une conversation est bien ouverte : sur l'accueil, l'absence de slot est normale.
setTimeout(function () {
  if (document.getElementById(EX_BTN_ID) || !exportUuidFromPath(location.pathname)) return;
  exWarn('slot', 'point d\'insertion « ' + EX_SLOT + ' » introuvable : le bouton d\'export est ' +
    'désactivé et rien n\'a été inséré dans l\'en-tête. Voir la section Export du README.');
}, 8000);
