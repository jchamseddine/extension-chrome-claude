// The only adaptation point of the export, and the only brick shared between the page and the tests.
// PURE logic: no DOM, no chrome.*, no fetch — that is what makes it testable
// as-is by test-export.js, with the same vm.runInContext technique as usage-source.js.
//
// A feature independent of the rest of the extension: nothing in common with usage-source.js,
// status-source.js, theme.js, autocontinue-source.js or folders-source.js.
'use strict';

// ---- locating the conversation -----------------------------------------------

// The real URL is /api/organizations/<org>/chat_conversations/<uuid>, CONFIRMED by the capture
// that served the context estimation (see the header of inject.js). It is the ONLY response
// that carries the whole history: it avoids DOM scraping, which would only see the loaded
// portion and would force scrolling through the whole conversation before exporting.
//
// The organization uuid, on the other hand, is not guessable: ORGS_PATH is precisely the only
// unverified assumption of the repo, and depending on it would couple the export to usage polling. So
// we collect it from the URLs the PAGE has already called (Resource Timing): the value comes
// from a request actually emitted, not from an assumed path.
var EXPORT_ORG_RE = /\/organizations\/([0-9a-f-]{36})\//i;
var EXPORT_CONV_RE = /\/chat_conversations\/([0-9a-f-]{36})(?:$|[?#])/i;
var EXPORT_CHAT_RE = /^\/chat\/([0-9a-f-]{36})/i;

function exportUuidFromPath(path) {
  if (typeof path !== 'string') return null;

  var m = EXPORT_CHAT_RE.exec(path);
  return m ? m[1].toLowerCase() : null;
}

// Two levels, from the most reliable to the least:
//   1. the EXACT URL the page used for this conversation — query string included,
//      so we inherit the site's parameters without having to know them;
//   2. failing that, rebuilt from any URL carrying the organization. The site
//      calls some constantly, so the org is found even if the conversation GET has left
//      the Resource Timing buffer (250 entries by default).
// Neither of the two guesses anything: both read a URL actually emitted.
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

// ---- reading the response ----------------------------------------------------

// The SHAPE of this response has never been captured: inject.js only reads its raw length.
// We therefore accept both plausible conventions (sender/role, text/content[]) rather than
// betting on a single one, and we say so in the console if nothing matches — same treatment as
// parseUsage() and parseStatus(). It is here, and nowhere else, that a fix will be needed.
function exportRole(m) {
  var raw = m.sender || m.role;
  if (raw === 'assistant') return 'assistant';
  if (raw === 'human' || raw === 'user') return 'user';
  return null;
}

// Blocks that are not text (tool_use, tool_result, thinking) are DISCARDED: an export
// must read like the conversation, not like its execution trace.
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
    console.warn('[export] unknown response format: adapt parseConversation() in ' +
                 'export-source.js. JSON received:', json);
    return null;
  }

  var messages = [];
  raw.forEach(function (m) {
    if (!m || typeof m !== 'object') return;
    var role = exportRole(m);
    var text = exportMessageText(m);
    if (!role || !text) return;   // empty message or unknown role: we do not invent it
    messages.push({ role: role, text: text });
  });

  var title = (typeof json.name === 'string' && json.name.trim())
    || (typeof json.title === 'string' && json.title.trim())
    || '';

  return { title: title, messages: messages };
}

// ---- file name ---------------------------------------------------------------

var EXPORT_FALLBACK_NAME = 'conversation';
var EXPORT_NAME_MAX = 80;

// DOS device names, always refused by Windows even with an extension: a
// conversation titled "CON" would produce a download impossible to save.
var EXPORT_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function exportPad(n) { return (n < 10 ? '0' : '') + n; }

function exportStamp(date) {
  return date.getFullYear() + '-' + exportPad(date.getMonth() + 1) + '-' + exportPad(date.getDate());
}

// Deliberately severe cleanup: we aim for a name valid on Windows, macOS and Linux at
// once, so we strip the union of their forbidden characters — <>:"/\|?* , control characters, and
// the dots or spaces at the end of a name, which Windows Explorer truncates silently.
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

// The message text is taken VERBATIM. This is deliberate: Claude's replies ARE
// markdown, code blocks and languages included — rewriting them could only damage them. Only
// the title is sanitized, because it becomes a "# …" line and a line break inside it
// would break the document structure.
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

// ---- HTML (for the PDF) ------------------------------------------------------

function exportEscapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Only http(s) are accepted: a "javascript:" link coming from a conversation's content must
// not become clickable in the printed document.
function exportSafeUrl(u) {
  return /^https?:\/\//i.test(u) ? u : null;
}

// Inline formatting applies OUTSIDE the backtick portions, otherwise a `**` quoted in
// code would become bold. HTML escaping ALWAYS comes first: a conversation's content
// can contain "<script>", which must never become a tag again.
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

// Deliberately partial markdown rendering: code blocks (with their language), headings, lists,
// quotes, paragraphs. No tables or footnotes — it covers what one reads in a
// conversation, and it avoids embedding a full markdown parser for a print
// button. What is not recognized comes out as a paragraph, never lost.
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
      i++;   // the closing line
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

// Self-contained document: all the style is in the page, nothing is loaded from outside. @page
// carries the PDF margins, and code blocks are allowed to break across two pages —
// without that a long code excerpt would skip a whole page.
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
