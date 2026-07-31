// Seul point d'adaptation de l'export, et seule brique partagee entre la page et les tests.
// Logique PURE : aucun DOM, aucun chrome.*, aucun fetch — c'est ce qui la rend testable telle
// quelle par test-export.js, avec le meme procede vm.runInContext que usage-source.js.
//
// Fonctionnalite independante du reste de l'extension : rien de commun avec usage-source.js,
// status-source.js, theme.js, autocontinue-source.js ni folders-source.js.
'use strict';

// ---- localisation de la conversation -----------------------------------------

// L'URL reelle est /api/organizations/<org>/chat_conversations/<uuid>, CONFIRMEE par la capture
// qui a servi a l'estimation de contexte (voir l'en-tete de inject.js). C'est la SEULE reponse
// qui porte tout l'historique : elle evite le scraping du DOM, qui ne verrait que la portion
// chargee et obligerait a derouler toute la conversation avant d'exporter.
//
// L'uuid d'organisation, lui, n'est pas devinable : ORGS_PATH est justement la seule
// supposition non verifiee du depot, et en dependre couplerait l'export au sondage d'usage. On
// le releve donc dans les URL que la PAGE a deja appelees (Resource Timing) : la valeur vient
// d'une requete reellement emise, pas d'un chemin suppose.
var EXPORT_ORG_RE = /\/organizations\/([0-9a-f-]{36})\//i;
var EXPORT_CONV_RE = /\/chat_conversations\/([0-9a-f-]{36})(?:$|[?#])/i;
var EXPORT_CHAT_RE = /^\/chat\/([0-9a-f-]{36})/i;

function exportUuidFromPath(path) {
  if (typeof path !== 'string') return null;

  var m = EXPORT_CHAT_RE.exec(path);
  return m ? m[1].toLowerCase() : null;
}

// Deux niveaux, du plus sur au moins sur :
//   1. l'URL EXACTE que la page a utilisee pour cette conversation — query string comprise,
//      donc on herite des parametres du site sans avoir a les connaitre ;
//   2. a defaut, reconstruite a partir de n'importe quelle URL portant l'organisation. Le site
//      en appelle en permanence, donc l'org se trouve meme si le GET de conversation est sorti
//      du tampon de Resource Timing (250 entrees par defaut).
// Aucun des deux ne devine quoi que ce soit : les deux lisent une URL reellement emise.
function exportFindConversationUrl(urls, uuid) {
  if (!uuid || !Array.isArray(urls)) return null;

  var org = null;
  for (var i = 0; i < urls.length; i++) {
    var u = urls[i];
    if (typeof u !== 'string') continue;

    var conv = EXPORT_CONV_RE.exec(u);
    if (conv && conv[1].toLowerCase() === uuid) return u;

    if (!org) {
      var m = EXPORT_ORG_RE.exec(u);
      if (m) org = m[1];
    }
  }

  return org ? 'https://claude.ai/api/organizations/' + org + '/chat_conversations/' + uuid : null;
}

// ---- lecture de la reponse ---------------------------------------------------

// La FORME de cette reponse n'a jamais ete capturee : inject.js n'en lit que la longueur brute.
// On accepte donc les deux conventions plausibles (sender/role, text/content[]) plutot que d'en
// parier une seule, et on le dit en console si rien ne correspond — meme traitement que
// parseUsage() et parseStatus(). C'est ici, et nulle part ailleurs, qu'il faudra corriger.
function exportRole(m) {
  var raw = m.sender || m.role;
  if (raw === 'assistant') return 'assistant';
  if (raw === 'human' || raw === 'user') return 'user';
  return null;
}

// Les blocs qui ne sont pas du texte (tool_use, tool_result, thinking) sont ECARTES : un export
// doit se lire comme la conversation, pas comme sa trace d'execution.
function exportMessageText(m) {
  if (typeof m.text === 'string' && m.text.trim()) return m.text.trim();

  var parts = [];
  if (Array.isArray(m.content)) {
    m.content.forEach(function (b) {
      if (!b || typeof b !== 'object') return;
      if (b.type && b.type !== 'text') return;
      if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim());
    });
  }
  return parts.join('\n\n');
}

function parseConversation(json) {
  if (!json || typeof json !== 'object') return null;

  var raw = Array.isArray(json.chat_messages) ? json.chat_messages
          : Array.isArray(json.messages) ? json.messages
          : null;

  if (!raw) {
    console.warn('[export] format de réponse inconnu : adapter parseConversation() dans ' +
                 'export-source.js. JSON reçu :', json);
    return null;
  }

  var messages = [];
  raw.forEach(function (m) {
    if (!m || typeof m !== 'object') return;
    var role = exportRole(m);
    var text = exportMessageText(m);
    if (!role || !text) return;   // message vide ou role inconnu : on ne l'invente pas
    messages.push({ role: role, text: text });
  });

  var title = (typeof json.name === 'string' && json.name.trim())
    || (typeof json.title === 'string' && json.title.trim())
    || '';

  return { title: title, messages: messages };
}

// ---- nom de fichier ----------------------------------------------------------

var EXPORT_FALLBACK_NAME = 'conversation';
var EXPORT_NAME_MAX = 80;

// Noms de peripheriques DOS, toujours refuses par Windows meme avec une extension : une
// conversation intitulee « CON » produirait un telechargement impossible a enregistrer.
var EXPORT_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function exportPad(n) { return (n < 10 ? '0' : '') + n; }

function exportStamp(date) {
  return date.getFullYear() + '-' + exportPad(date.getMonth() + 1) + '-' + exportPad(date.getDate());
}

// Nettoyage volontairement severe : on vise un nom valide sur Windows, macOS et Linux a la
// fois, donc on retire l'union de leurs interdits — <>:"/\|?* , les caracteres de controle, et
// les points ou espaces en fin de nom, que l'explorateur Windows tronque silencieusement.
function exportFileName(title, date, ext) {
  var name = (typeof title === 'string' ? title : '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EXPORT_NAME_MAX)
    .replace(/[. ]+$/, '');

  if (!name || EXPORT_RESERVED_RE.test(name)) name = EXPORT_FALLBACK_NAME;

  return name + ' - ' + exportStamp(date) + '.' + ext;
}

// ---- Markdown ----------------------------------------------------------------

var EXPORT_ROLE_LABEL = { user: 'Vous', assistant: 'Claude' };

// Le texte des messages est repris VERBATIM. C'est deliberé : les reponses de Claude SONT du
// markdown, blocs de code et langages compris — les reecrire ne pourrait que les abimer. Seul
// le titre est assaini, parce qu'il devient une ligne « # … » et qu'un retour a la ligne dedans
// casserait la structure du document.
function exportCleanTitle(title) {
  var t = (typeof title === 'string' ? title : '').replace(/\s+/g, ' ').trim();
  return t || 'Conversation';
}

function exportDateText(date) {
  return exportPad(date.getDate()) + '/' + exportPad(date.getMonth() + 1) + '/' +
    date.getFullYear() + ' à ' + exportPad(date.getHours()) + ':' + exportPad(date.getMinutes());
}

function exportMarkdown(conv, date) {
  var out = ['# ' + exportCleanTitle(conv.title), '',
    '*Conversation exportée depuis claude.ai le ' + exportDateText(date) + '.*', ''];

  conv.messages.forEach(function (m) {
    out.push('---', '', '### ' + (EXPORT_ROLE_LABEL[m.role] || m.role), '', m.text, '');
  });

  return out.join('\n');
}

// ---- HTML (pour le PDF) ------------------------------------------------------

function exportEscapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Seuls http(s) sont acceptes : un lien « javascript: » venu du contenu d'une conversation ne
// doit pas devenir cliquable dans le document imprime.
function exportSafeUrl(u) {
  return /^https?:\/\//i.test(u) ? u : null;
}

// Le formatage en ligne s'applique HORS des portions entre backticks, sinon un `**` cite dans
// du code deviendrait du gras. L'echappement HTML passe TOUJOURS en premier : le contenu d'une
// conversation peut contenir « <script> », qui ne doit jamais redevenir une balise.
function exportInline(text) {
  return text.split(/(`[^`\n]+`)/).map(function (part, i) {
    if (i % 2 === 1) return '<code>' + exportEscapeHtml(part.slice(1, -1)) + '</code>';

    return exportEscapeHtml(part)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (all, label, url) {
        var safe = exportSafeUrl(url);
        return safe ? '<a href="' + exportEscapeHtml(safe) + '">' + label + '</a>' : all;
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }).join('');
}

// Rendu markdown volontairement partiel : blocs de code (avec leur langage), titres, listes,
// citations, paragraphes. Pas de tableaux ni de notes — ca couvre ce qu'on lit dans une
// conversation, et ca evite d'embarquer un analyseur markdown complet pour un bouton
// d'impression. Ce qui n'est pas reconnu ressort en paragraphe, jamais perdu.
function exportRenderMarkdown(text) {
  var lines = String(text).split('\n');
  var out = [];
  var i = 0;

  function flushParagraph(buf) {
    if (buf.length) out.push('<p>' + exportInline(buf.join(' ')) + '</p>');
  }

  while (i < lines.length) {
    var line = lines[i];

    var fence = /^\s*```(\w+)?/.exec(line);
    if (fence) {
      var code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;   // la ligne de fermeture
      var lang = fence[1] ? ' class="language-' + exportEscapeHtml(fence[1]) + '"' : '';
      out.push('<pre><code' + lang + '>' + exportEscapeHtml(code.join('\n')) + '</code></pre>');
      continue;
    }

    var head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      var n = head[1].length;
      out.push('<h' + n + '>' + exportInline(head[2]) + '</h' + n + '>');
      i++;
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      var quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      }
      out.push('<blockquote>' + exportInline(quote.join(' ')) + '</blockquote>');
      continue;
    }

    var bullet = /^\s*([-*+]|\d+\.)\s+/.exec(line);
    if (bullet) {
      var ordered = /\d/.test(bullet[1]);
      var items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push('<li>' + exportInline(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, '')) + '</li>');
      }
      out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
      continue;
    }

    if (!line.trim()) { i++; continue; }

    var para = [];
    while (i < lines.length && lines[i].trim() &&
           !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+\.\s|---+\s*$)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    flushParagraph(para);
  }

  return out.join('\n');
}

// Document autonome : tout le style est dans la page, rien n'est charge de l'exterieur. @page
// porte les marges du PDF, et les blocs de code sont autorises a se couper entre deux pages —
// sans ca un long extrait de code sauterait une page entiere.
function exportHtml(conv, date) {
  var title = exportCleanTitle(conv.title);

  var body = conv.messages.map(function (m) {
    return '<section class="msg ' + m.role + '">' +
             '<h2>' + exportEscapeHtml(EXPORT_ROLE_LABEL[m.role] || m.role) + '</h2>' +
             exportRenderMarkdown(m.text) +
           '</section>';
  }).join('\n');

  return '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<title>' + exportEscapeHtml(title) + '</title><style>' +
    '@page{margin:16mm 14mm}' +
    'body{font:11pt/1.55 system-ui,sans-serif;color:#111;margin:0}' +
    'h1{font-size:19pt;margin:0 0 4pt}' +
    '.meta{color:#666;font-size:9pt;margin:0 0 16pt}' +
    '.msg{border-top:1px solid #ddd;padding-top:10pt;margin-top:12pt;break-inside:auto}' +
    '.msg h2{font-size:10pt;text-transform:uppercase;letter-spacing:.06em;color:#666;' +
      'margin:0 0 6pt;break-after:avoid}' +
    '.msg.user h2{color:#c6613f}' +
    'p{margin:0 0 8pt}' +
    'pre{background:#f5f5f4;border:1px solid #e5e5e3;border-radius:4pt;padding:7pt;' +
      'font:9.5pt/1.45 ui-monospace,monospace;white-space:pre-wrap;word-wrap:break-word;' +
      'break-inside:auto;margin:0 0 8pt}' +
    'code{font:9.5pt/1.4 ui-monospace,monospace;background:#f5f5f4;padding:1pt 3pt;' +
      'border-radius:3pt}' +
    'pre code{background:none;padding:0;font-size:inherit}' +
    'blockquote{margin:0 0 8pt;padding-left:9pt;border-left:2pt solid #ddd;color:#555}' +
    'ul,ol{margin:0 0 8pt;padding-left:18pt}li{margin:0 0 3pt}' +
    'h1,h2,h3,h4,h5,h6{break-after:avoid}' +
    'a{color:#0b57d0;text-decoration:none}' +
    'img{max-width:100%}' +
    '</style></head><body>' +
    '<h1>' + exportEscapeHtml(title) + '</h1>' +
    '<p class="meta">Conversation exportée depuis claude.ai le ' +
      exportEscapeHtml(exportDateText(date)) + '.</p>' +
    body +
    '</body></html>';
}
