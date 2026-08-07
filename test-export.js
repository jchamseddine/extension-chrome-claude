// Unit test for export-source.js: Markdown generation, HTML escaping, code block
// rendering, file name cleanup, reading the API response. No dependency,
// no framework, like test-theme.js. Run with: node test-export.js
//
// What touches the DOM (inserting the button into the header, menu, printing) is in
// export.js and is verified by hand in the browser.
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// export-source.js is loaded by a content script <script> in the extension, not by
// require(): no module.exports to add to it. We evaluate it in its own context and
// read back its top-level "var" and "function" on it. console is stubbed: parseConversation()
// warns in the console on an unknown format, and we want to observe that without suffering it.
var warnings = [];
var sandbox = { console: { warn: function (m) { warnings.push(String(m)); } } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'export-source.js'), 'utf8'), sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

var DATE = new Date(2026, 6, 31, 14, 5);   // 31/07/2026 14:05, local time
var UUID = '0f2a1b3c-4d5e-6f70-8192-a3b4c5d6e7f8';
var ORG = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';

function conv(messages, title) {
  return { title: title === undefined ? 'Ma conversation' : title, messages: messages };
}

// ---- locating the conversation -------------------------------------------------------------------

test('uuid read from the page path', function () {
  assert.strictEqual(sandbox.exportUuidFromPath('/chat/' + UUID), UUID);
  assert.strictEqual(sandbox.exportUuidFromPath('/chat/' + UUID.toUpperCase()), UUID);
  assert.strictEqual(sandbox.exportUuidFromPath('/chat/new'), null);
  assert.strictEqual(sandbox.exportUuidFromPath('/projects'), null);
  assert.strictEqual(sandbox.exportUuidFromPath(null), null);
});

// The best case: the page has already called the exact URL, query string included. We take it
// as-is, so we inherit the site's parameters without having to know them.
test('exact URL already called by the page: taken verbatim', function () {
  var exacte = 'https://claude.ai/api/organizations/' + ORG + '/chat_conversations/' + UUID +
    '?tree=True&rendering_mode=messages';
  var urls = ['https://claude.ai/api/bootstrap', exacte, 'https://claude.ai/api/autre'];
  assert.strictEqual(sandbox.exportFindConversationUrl(urls, UUID), exacte);
});

test('failing that, URL rebuilt from the organization seen elsewhere', function () {
  var urls = ['https://claude.ai/api/organizations/' + ORG + '/usage'];
  assert.strictEqual(sandbox.exportFindConversationUrl(urls, UUID),
    'https://claude.ai/api/organizations/' + ORG + '/chat_conversations/' + UUID);
});

test('URL of ANOTHER conversation: only serves for the organization', function () {
  var autre = '11112222-3333-4444-5555-666677778888';
  var urls = ['https://claude.ai/api/organizations/' + ORG + '/chat_conversations/' + autre];
  assert.strictEqual(sandbox.exportFindConversationUrl(urls, UUID),
    'https://claude.ai/api/organizations/' + ORG + '/chat_conversations/' + UUID);
});

test('no organization identifiable: null, not an invented URL', function () {
  assert.strictEqual(sandbox.exportFindConversationUrl(['https://claude.ai/api/bootstrap'], UUID), null);
  assert.strictEqual(sandbox.exportFindConversationUrl([], UUID), null);
  assert.strictEqual(sandbox.exportFindConversationUrl(null, UUID), null);
  assert.strictEqual(sandbox.exportFindConversationUrl(['x'], null), null);
});

// ---- reading the response ----------------------------------------------------------------------

test('"chat_messages" + sender + text shape', function () {
  var out = sandbox.parseConversation({
    name: 'Titre',
    chat_messages: [
      { sender: 'human', text: 'Bonjour' },
      { sender: 'assistant', text: 'Salut' }
    ]
  });
  assert.strictEqual(out.title, 'Titre');
  assert.strictEqual(out.messages.length, 2);
  assert.strictEqual(out.messages[0].role, 'user');
  assert.strictEqual(out.messages[1].role, 'assistant');
});

test('"messages" + role + content[] shape: text concatenated', function () {
  var out = sandbox.parseConversation({
    title: 'Autre',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }]
  });
  assert.strictEqual(out.title, 'Autre');
  assert.strictEqual(out.messages[0].text, 'A\n\nB');
});

// An export must read like the conversation, not like its execution trace.
test('non-textual blocks (tool_use, thinking) discarded', function () {
  var out = sandbox.parseConversation({
    chat_messages: [{ sender: 'assistant', content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'La réponse' },
      { type: 'tool_use', name: 'search', input: {} }
    ] }]
  });
  assert.strictEqual(out.messages.length, 1);
  assert.strictEqual(out.messages[0].text, 'La réponse');
});

test('empty message or unknown role: ignored, not invented', function () {
  var out = sandbox.parseConversation({
    chat_messages: [
      { sender: 'human', text: '   ' },
      { sender: 'system', text: 'consigne' },
      { sender: 'human', text: 'vrai message' }
    ]
  });
  assert.strictEqual(out.messages.length, 1);
  assert.strictEqual(out.messages[0].text, 'vrai message');
});

test('unknown format: null and a warning naming the file to fix', function () {
  warnings.length = 0;
  assert.strictEqual(sandbox.parseConversation({ foo: 1 }), null);
  assert.strictEqual(sandbox.parseConversation(null), null);
  assert.strictEqual(sandbox.parseConversation('oops'), null);
  assert.ok(warnings.some(function (w) { return w.indexOf('export-source.js') !== -1; }),
    'the warning must name the file to fix');
});

test('title absent: empty string, the page context will take over', function () {
  assert.strictEqual(sandbox.parseConversation({ chat_messages: [] }).title, '');
});

// ---- Markdown -----------------------------------------------------------------------------------

test('structure: title, date, one block per message with its role', function () {
  var md = sandbox.exportMarkdown(conv([
    { role: 'user', text: 'Question ?' },
    { role: 'assistant', text: 'Réponse.' }
  ]), DATE);

  assert.ok(md.indexOf('# Ma conversation\n') === 0, md.slice(0, 40));
  assert.ok(md.indexOf('31/07/2026 à 14:05') !== -1, 'date missing');
  assert.ok(md.indexOf('### Vous\n\nQuestion ?') !== -1, md);
  assert.ok(md.indexOf('### Claude\n\nRéponse.') !== -1, md);
  assert.strictEqual((md.match(/^---$/gm) || []).length, 2, 'one separator per message');
});

// The message text IS markdown: rewriting it could only damage it.
test('code blocks preserved verbatim, with their language', function () {
  var code = 'Voici :\n\n```python\ndef f():\n    return "**pas du gras**"\n```\n\nVoilà.';
  var md = sandbox.exportMarkdown(conv([{ role: 'assistant', text: code }]), DATE);
  assert.ok(md.indexOf(code) !== -1, 'the code block was modified');
});

test('multiline or empty title sanitized: the "#" stays on a single line', function () {
  var md = sandbox.exportMarkdown(conv([], 'Deux\nlignes   ici'), DATE);
  assert.ok(md.indexOf('# Deux lignes ici\n') === 0, md.slice(0, 40));
  assert.ok(sandbox.exportMarkdown(conv([], ''), DATE).indexOf('# Conversation\n') === 0);
  assert.ok(sandbox.exportMarkdown(conv([], null), DATE).indexOf('# Conversation\n') === 0);
});

test('conversation without a message: valid document, no exception', function () {
  var md = sandbox.exportMarkdown(conv([]), DATE);
  assert.ok(md.indexOf('# Ma conversation') === 0);
  assert.strictEqual((md.match(/^---$/gm) || []).length, 0);
});

// ---- HTML escaping -------------------------------------------------------------------------------

// The most sensitive point of the file: a conversation's content must never become
// tags again in the printed document.
test('HTML escaped: a tag from the content does not become a tag again', function () {
  var html = sandbox.exportHtml(conv([{ role: 'user', text: '<script>alert(1)</script>' }]), DATE);
  assert.strictEqual(html.indexOf('<script>alert'), -1, 'script tag reinjected!');
  assert.ok(html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') !== -1, html);
});

test('ampersands and quotes escaped, including in the title', function () {
  assert.strictEqual(sandbox.exportEscapeHtml('a & b < c > d " e'),
    'a &amp; b &lt; c &gt; d &quot; e');
  var html = sandbox.exportHtml(conv([], 'Tom & "Jerry" <b>'), DATE);
  assert.strictEqual(html.indexOf('<b>'), -1);
  assert.ok(html.indexOf('Tom &amp; &quot;Jerry&quot; &lt;b&gt;') !== -1);
});

test('javascript: link refused, http link preserved', function () {
  var mauvais = sandbox.exportRenderMarkdown('[clic](javascript:alert(1))');
  assert.strictEqual(mauvais.indexOf('href'), -1, 'a javascript: link was made clickable');

  var bon = sandbox.exportRenderMarkdown('[Anthropic](https://claude.ai/x)');
  assert.ok(bon.indexOf('<a href="https://claude.ai/x">Anthropic</a>') !== -1, bon);
});

// ---- markdown -> HTML rendering ---------------------------------------------------------------------

test('code block: <pre><code> with the language class, content escaped', function () {
  var html = sandbox.exportRenderMarkdown('```js\nif (a < b) { f("x"); }\n```');
  assert.ok(html.indexOf('<pre><code class="language-js">') !== -1, html);
  assert.ok(html.indexOf('if (a &lt; b) { f(&quot;x&quot;); }') !== -1, html);
});

test('code block without a language: no class', function () {
  var html = sandbox.exportRenderMarkdown('```\nbrut\n```');
  assert.ok(html.indexOf('<pre><code>brut</code></pre>') !== -1, html);
});

// Without this, a `**` quoted in code would become bold.
test('inline formatting does not apply inside code', function () {
  var html = sandbox.exportRenderMarkdown('Texte `a ** b` fin');
  assert.ok(html.indexOf('<code>a ** b</code>') !== -1, html);
  assert.strictEqual(html.indexOf('<strong>'), -1);
});

test('headings, bold, italic, lists and quotes', function () {
  assert.ok(sandbox.exportRenderMarkdown('## Titre').indexOf('<h2>Titre</h2>') !== -1);
  assert.ok(sandbox.exportRenderMarkdown('un **gras** ici').indexOf('<strong>gras</strong>') !== -1);
  assert.ok(sandbox.exportRenderMarkdown('un *ital* ici').indexOf('<em>ital</em>') !== -1);

  var ul = sandbox.exportRenderMarkdown('- un\n- deux');
  assert.ok(ul.indexOf('<ul><li>un</li><li>deux</li></ul>') !== -1, ul);

  var ol = sandbox.exportRenderMarkdown('1. un\n2. deux');
  assert.ok(ol.indexOf('<ol><li>un</li><li>deux</li></ol>') !== -1, ol);

  assert.ok(sandbox.exportRenderMarkdown('> cité').indexOf('<blockquote>cité</blockquote>') !== -1);
});

test('paragraphs separated by an empty line', function () {
  var html = sandbox.exportRenderMarkdown('Un.\n\nDeux.');
  assert.strictEqual((html.match(/<p>/g) || []).length, 2, html);
});

test('unrecognized text: comes out as a paragraph, never lost', function () {
  var html = sandbox.exportRenderMarkdown('| a | b |\n| - | - |');
  assert.ok(html.indexOf('a') !== -1 && html.indexOf('b') !== -1, html);
});

// ---- file name ------------------------------------------------------------------------------------

test('nominal name: title + date + extension', function () {
  assert.strictEqual(sandbox.exportFileName('Mon projet', DATE, 'md'),
    'Mon projet - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName('Mon projet', DATE, 'pdf'),
    'Mon projet - 2026-07-31.pdf');
});

test('forbidden characters replaced, hyphens preserved', function () {
  assert.strictEqual(sandbox.exportFileName('a/b\\c:d*e?f"g<h>i|j', DATE, 'md'),
    'a b c d e f g h i j - 2026-07-31.md');
  // The hyphen is legitimate in a file name: it must NOT be dropped.
  assert.strictEqual(sandbox.exportFileName('Avant-après', DATE, 'md'),
    'Avant-après - 2026-07-31.md');
});

test('control characters and multiple spaces reduced', function () {
  assert.strictEqual(sandbox.exportFileName('a\nb\tc   d', DATE, 'md'), 'a b c d - 2026-07-31.md');
});

test('title empty or absent: fallback to "conversation"', function () {
  assert.strictEqual(sandbox.exportFileName('', DATE, 'md'), 'conversation - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName('   ', DATE, 'md'), 'conversation - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName(null, DATE, 'md'), 'conversation - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName('///', DATE, 'md'), 'conversation - 2026-07-31.md');
});

// Windows refuses these names even followed by an extension: the download would be impossible to
// save.
test('DOS device name refused', function () {
  assert.strictEqual(sandbox.exportFileName('CON', DATE, 'md'), 'conversation - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName('nul', DATE, 'md'), 'conversation - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName('COM3', DATE, 'md'), 'conversation - 2026-07-31.md');
  // "console" starts the same way but is not reserved.
  assert.strictEqual(sandbox.exportFileName('console', DATE, 'md'), 'console - 2026-07-31.md');
});

test('trailing dot or space removed (Windows Explorer truncates them)', function () {
  assert.strictEqual(sandbox.exportFileName('Fin.', DATE, 'md'), 'Fin - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName('Fin...  ', DATE, 'md'), 'Fin - 2026-07-31.md');
});

test('very long title truncated', function () {
  var out = sandbox.exportFileName('x'.repeat(300), DATE, 'md');
  assert.strictEqual(out, 'x'.repeat(80) + ' - 2026-07-31.md');
});

test('date: a single digit is indeed padded to two', function () {
  assert.strictEqual(sandbox.exportFileName('A', new Date(2026, 0, 5), 'md'), 'A - 2026-01-05.md');
});

// ---- run -----------------------------------------------------------------------------------
var failed = 0;
tests.forEach(function (t) {
  try {
    t.fn();
    console.log('  ok  ' + t.name);
  } catch (e) {
    failed++;
    console.error('FAIL  ' + t.name);
    console.error('      ' + e.message);
  }
});

console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passed');
if (failed) process.exit(1);
