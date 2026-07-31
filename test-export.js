// Test unitaire de export-source.js : generation du Markdown, echappement HTML, rendu des
// blocs de code, nettoyage du nom de fichier, lecture de la reponse d'API. Aucune dependance,
// aucun framework, comme test-theme.js. Lance avec : node test-export.js
//
// Ce qui touche au DOM (insertion du bouton dans l'en-tete, menu, impression) est dans
// export.js et se verifie a la main dans le navigateur.
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// export-source.js est charge par <script> de content script dans l'extension, pas par
// require() : pas de module.exports a y ajouter. On l'evalue dans son propre contexte et on
// relit ses "var" et "function" de premier niveau dessus. console est bouchonne : parseConversation()
// avertit en console sur un format inconnu, et on veut pouvoir le constater sans le subir.
var warnings = [];
var sandbox = { console: { warn: function (m) { warnings.push(String(m)); } } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'export-source.js'), 'utf8'), sandbox);

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

var DATE = new Date(2026, 6, 31, 14, 5);   // 31/07/2026 14:05, heure locale
var UUID = '0f2a1b3c-4d5e-6f70-8192-a3b4c5d6e7f8';
var ORG = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';

function conv(messages, title) {
  return { title: title === undefined ? 'Ma conversation' : title, messages: messages };
}

// ---- localisation de la conversation -----------------------------------------------------------

test('uuid lu dans le chemin de la page', function () {
  assert.strictEqual(sandbox.exportUuidFromPath('/chat/' + UUID), UUID);
  assert.strictEqual(sandbox.exportUuidFromPath('/chat/' + UUID.toUpperCase()), UUID);
  assert.strictEqual(sandbox.exportUuidFromPath('/chat/new'), null);
  assert.strictEqual(sandbox.exportUuidFromPath('/projects'), null);
  assert.strictEqual(sandbox.exportUuidFromPath(null), null);
});

// Le meilleur cas : la page a deja appele l'URL exacte, query string comprise. On la reprend
// telle quelle, donc on herite des parametres du site sans avoir a les connaitre.
test('URL exacte deja appelee par la page : reprise verbatim', function () {
  var exacte = 'https://claude.ai/api/organizations/' + ORG + '/chat_conversations/' + UUID +
    '?tree=True&rendering_mode=messages';
  var urls = ['https://claude.ai/api/bootstrap', exacte, 'https://claude.ai/api/autre'];
  assert.strictEqual(sandbox.exportFindConversationUrl(urls, UUID), exacte);
});

test('a defaut, URL reconstruite depuis l organisation vue ailleurs', function () {
  var urls = ['https://claude.ai/api/organizations/' + ORG + '/usage'];
  assert.strictEqual(sandbox.exportFindConversationUrl(urls, UUID),
    'https://claude.ai/api/organizations/' + ORG + '/chat_conversations/' + UUID);
});

test('URL d une AUTRE conversation : ne sert que pour l organisation', function () {
  var autre = '11112222-3333-4444-5555-666677778888';
  var urls = ['https://claude.ai/api/organizations/' + ORG + '/chat_conversations/' + autre];
  assert.strictEqual(sandbox.exportFindConversationUrl(urls, UUID),
    'https://claude.ai/api/organizations/' + ORG + '/chat_conversations/' + UUID);
});

test('aucune organisation reperable : null, pas une URL inventee', function () {
  assert.strictEqual(sandbox.exportFindConversationUrl(['https://claude.ai/api/bootstrap'], UUID), null);
  assert.strictEqual(sandbox.exportFindConversationUrl([], UUID), null);
  assert.strictEqual(sandbox.exportFindConversationUrl(null, UUID), null);
  assert.strictEqual(sandbox.exportFindConversationUrl(['x'], null), null);
});

// ---- lecture de la reponse ---------------------------------------------------------------------

test('forme « chat_messages » + sender + text', function () {
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

test('forme « messages » + role + content[] : texte concatene', function () {
  var out = sandbox.parseConversation({
    title: 'Autre',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }]
  });
  assert.strictEqual(out.title, 'Autre');
  assert.strictEqual(out.messages[0].text, 'A\n\nB');
});

// Un export doit se lire comme la conversation, pas comme sa trace d'execution.
test('blocs non textuels (tool_use, thinking) ecartes', function () {
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

test('message vide ou role inconnu : ignore, pas invente', function () {
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

test('format inconnu : null et un avertissement nommant le fichier a corriger', function () {
  warnings.length = 0;
  assert.strictEqual(sandbox.parseConversation({ foo: 1 }), null);
  assert.strictEqual(sandbox.parseConversation(null), null);
  assert.strictEqual(sandbox.parseConversation('oops'), null);
  assert.ok(warnings.some(function (w) { return w.indexOf('export-source.js') !== -1; }),
    'l\'avertissement doit nommer le fichier a corriger');
});

test('titre absent : chaine vide, le contexte page prendra le relais', function () {
  assert.strictEqual(sandbox.parseConversation({ chat_messages: [] }).title, '');
});

// ---- Markdown -----------------------------------------------------------------------------------

test('structure : titre, date, un bloc par message avec son role', function () {
  var md = sandbox.exportMarkdown(conv([
    { role: 'user', text: 'Question ?' },
    { role: 'assistant', text: 'Réponse.' }
  ]), DATE);

  assert.ok(md.indexOf('# Ma conversation\n') === 0, md.slice(0, 40));
  assert.ok(md.indexOf('31/07/2026 à 14:05') !== -1, 'date absente');
  assert.ok(md.indexOf('### Vous\n\nQuestion ?') !== -1, md);
  assert.ok(md.indexOf('### Claude\n\nRéponse.') !== -1, md);
  assert.strictEqual((md.match(/^---$/gm) || []).length, 2, 'un separateur par message');
});

// Le texte des messages EST du markdown : le reecrire ne pourrait que l'abimer.
test('blocs de code preserves verbatim, avec leur langage', function () {
  var code = 'Voici :\n\n```python\ndef f():\n    return "**pas du gras**"\n```\n\nVoilà.';
  var md = sandbox.exportMarkdown(conv([{ role: 'assistant', text: code }]), DATE);
  assert.ok(md.indexOf(code) !== -1, 'le bloc de code a ete modifie');
});

test('titre multiligne ou vide assaini : le « # » reste sur une seule ligne', function () {
  var md = sandbox.exportMarkdown(conv([], 'Deux\nlignes   ici'), DATE);
  assert.ok(md.indexOf('# Deux lignes ici\n') === 0, md.slice(0, 40));
  assert.ok(sandbox.exportMarkdown(conv([], ''), DATE).indexOf('# Conversation\n') === 0);
  assert.ok(sandbox.exportMarkdown(conv([], null), DATE).indexOf('# Conversation\n') === 0);
});

test('conversation sans message : document valide, pas d exception', function () {
  var md = sandbox.exportMarkdown(conv([]), DATE);
  assert.ok(md.indexOf('# Ma conversation') === 0);
  assert.strictEqual((md.match(/^---$/gm) || []).length, 0);
});

// ---- echappement HTML ----------------------------------------------------------------------------

// Le point le plus sensible du fichier : le contenu d'une conversation ne doit jamais redevenir
// des balises dans le document imprime.
test('HTML echappe : une balise du contenu ne redevient pas une balise', function () {
  var html = sandbox.exportHtml(conv([{ role: 'user', text: '<script>alert(1)</script>' }]), DATE);
  assert.strictEqual(html.indexOf('<script>alert'), -1, 'balise script reinjectee !');
  assert.ok(html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') !== -1, html);
});

test('esperluettes et guillemets echappes, y compris dans le titre', function () {
  assert.strictEqual(sandbox.exportEscapeHtml('a & b < c > d " e'),
    'a &amp; b &lt; c &gt; d &quot; e');
  var html = sandbox.exportHtml(conv([], 'Tom & "Jerry" <b>'), DATE);
  assert.strictEqual(html.indexOf('<b>'), -1);
  assert.ok(html.indexOf('Tom &amp; &quot;Jerry&quot; &lt;b&gt;') !== -1);
});

test('lien javascript: refuse, lien http conserve', function () {
  var mauvais = sandbox.exportRenderMarkdown('[clic](javascript:alert(1))');
  assert.strictEqual(mauvais.indexOf('href'), -1, 'un lien javascript: a ete rendu cliquable');

  var bon = sandbox.exportRenderMarkdown('[Anthropic](https://claude.ai/x)');
  assert.ok(bon.indexOf('<a href="https://claude.ai/x">Anthropic</a>') !== -1, bon);
});

// ---- rendu markdown -> HTML -----------------------------------------------------------------------

test('bloc de code : <pre><code> avec la classe de langage, contenu echappe', function () {
  var html = sandbox.exportRenderMarkdown('```js\nif (a < b) { f("x"); }\n```');
  assert.ok(html.indexOf('<pre><code class="language-js">') !== -1, html);
  assert.ok(html.indexOf('if (a &lt; b) { f(&quot;x&quot;); }') !== -1, html);
});

test('bloc de code sans langage : pas de classe', function () {
  var html = sandbox.exportRenderMarkdown('```\nbrut\n```');
  assert.ok(html.indexOf('<pre><code>brut</code></pre>') !== -1, html);
});

// Sans ca, un `**` cite dans du code deviendrait du gras.
test('le formatage en ligne ne s applique pas dans le code', function () {
  var html = sandbox.exportRenderMarkdown('Texte `a ** b` fin');
  assert.ok(html.indexOf('<code>a ** b</code>') !== -1, html);
  assert.strictEqual(html.indexOf('<strong>'), -1);
});

test('titres, gras, italique, listes et citations', function () {
  assert.ok(sandbox.exportRenderMarkdown('## Titre').indexOf('<h2>Titre</h2>') !== -1);
  assert.ok(sandbox.exportRenderMarkdown('un **gras** ici').indexOf('<strong>gras</strong>') !== -1);
  assert.ok(sandbox.exportRenderMarkdown('un *ital* ici').indexOf('<em>ital</em>') !== -1);

  var ul = sandbox.exportRenderMarkdown('- un\n- deux');
  assert.ok(ul.indexOf('<ul><li>un</li><li>deux</li></ul>') !== -1, ul);

  var ol = sandbox.exportRenderMarkdown('1. un\n2. deux');
  assert.ok(ol.indexOf('<ol><li>un</li><li>deux</li></ol>') !== -1, ol);

  assert.ok(sandbox.exportRenderMarkdown('> cité').indexOf('<blockquote>cité</blockquote>') !== -1);
});

test('paragraphes separes par une ligne vide', function () {
  var html = sandbox.exportRenderMarkdown('Un.\n\nDeux.');
  assert.strictEqual((html.match(/<p>/g) || []).length, 2, html);
});

test('texte non reconnu : ressort en paragraphe, jamais perdu', function () {
  var html = sandbox.exportRenderMarkdown('| a | b |\n| - | - |');
  assert.ok(html.indexOf('a') !== -1 && html.indexOf('b') !== -1, html);
});

// ---- nom de fichier -------------------------------------------------------------------------------

test('nom nominal : titre + date + extension', function () {
  assert.strictEqual(sandbox.exportFileName('Mon projet', DATE, 'md'),
    'Mon projet - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName('Mon projet', DATE, 'pdf'),
    'Mon projet - 2026-07-31.pdf');
});

test('caracteres interdits remplaces, tirets conserves', function () {
  assert.strictEqual(sandbox.exportFileName('a/b\\c:d*e?f"g<h>i|j', DATE, 'md'),
    'a b c d e f g h i j - 2026-07-31.md');
  // Le tiret est legitime dans un nom de fichier : il ne doit PAS sauter.
  assert.strictEqual(sandbox.exportFileName('Avant-après', DATE, 'md'),
    'Avant-après - 2026-07-31.md');
});

test('caracteres de controle et espaces multiples reduits', function () {
  assert.strictEqual(sandbox.exportFileName('a\nb\tc   d', DATE, 'md'), 'a b c d - 2026-07-31.md');
});

test('titre vide ou absent : repli sur « conversation »', function () {
  assert.strictEqual(sandbox.exportFileName('', DATE, 'md'), 'conversation - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName('   ', DATE, 'md'), 'conversation - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName(null, DATE, 'md'), 'conversation - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName('///', DATE, 'md'), 'conversation - 2026-07-31.md');
});

// Windows refuse ces noms meme suivis d'une extension : le telechargement serait impossible a
// enregistrer.
test('nom de peripherique DOS refuse', function () {
  assert.strictEqual(sandbox.exportFileName('CON', DATE, 'md'), 'conversation - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName('nul', DATE, 'md'), 'conversation - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName('COM3', DATE, 'md'), 'conversation - 2026-07-31.md');
  // « console » commence pareil mais n'est pas reserve.
  assert.strictEqual(sandbox.exportFileName('console', DATE, 'md'), 'console - 2026-07-31.md');
});

test('point ou espace final retire (l explorateur Windows les tronque)', function () {
  assert.strictEqual(sandbox.exportFileName('Fin.', DATE, 'md'), 'Fin - 2026-07-31.md');
  assert.strictEqual(sandbox.exportFileName('Fin...  ', DATE, 'md'), 'Fin - 2026-07-31.md');
});

test('titre tres long tronque', function () {
  var out = sandbox.exportFileName('x'.repeat(300), DATE, 'md');
  assert.strictEqual(out, 'x'.repeat(80) + ' - 2026-07-31.md');
});

test('date : un chiffre est bien complete a deux', function () {
  assert.strictEqual(sandbox.exportFileName('A', new Date(2026, 0, 5), 'md'), 'A - 2026-01-05.md');
});

// ---- execution ----------------------------------------------------------------------------
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

console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passes');
if (failed) process.exit(1);
