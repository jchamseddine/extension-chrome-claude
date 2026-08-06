# Contexte du projet

Extension Chrome (Manifest V3) personnelle, jamais destinée au Web Store, qui affiche :
1. L'usage de session (5h) et hebdomadaire (7j) sur claude.ai
2. Le % de contexte utilisé dans la conversation en cours (feature absente des outils existants)
3. Le statut de Claude lu sur status.claude.com

## État du repo

Le repo contient l'extension finale. Le sniffer de découverte (Phase 1) n'existe plus en tant
que tel : il ne reste que le nettoyage de ses clés `sniff:` dans `onInstalled`.

Note : le repo public de ClaudeKarma (jrlprost/ClaudeKarma et jrlprost/claudekarma_browser)
est introuvable (404 sur les deux adresses) — pas de code de référence externe disponible.
Tout vient de notre propre découverte réseau.

Trois sources de données, volontairement séparées :

- **Usage (5 h / 7 j)** — sondé toutes les 60 s par le service worker (`chrome.alarms`), écrit
  dans la clé `usage`. L'extraction depuis l'événement SSE `message_limit` a été **abandonnée** :
  trop fragile, et la donnée ne bougeait qu'après l'envoi d'un message.
- **Estimation de contexte** — toujours passive, via le patch `fetch` de `inject.js` (taille du
  GET de conversation + payloads envoyés + texte streamé). Aucun appel réseau émis.
- **Statut** — `GET https://status.claude.com/api/v2/summary.json` (Statuspage public, non
  authentifié) sondé toutes les 5 min par une alarme séparée, écrit dans la clé `status`.
  `parseStatus()` dans `status-source.js` ne partage rien avec les deux autres sources.
  Endpoint et forme de réponse **confirmés par capture** le 2026-07-30 — contrairement à
  `ORGS_PATH`. Deux pièges consignés dans le README : le niveau global est **calculé** (pire de
  l'indicateur de page et des composants, parce que `status.indicator` s'est révélé sous-estimer
  une panne réelle), et le filtre sur « claude » dans les noms de composants ne retire rien
  aujourd'hui (les six le contiennent).

`USAGE_PATH` (`GET /api/organizations/<org>/usage`) et `parseUsage()` dans `usage-source.js`
sont **confirmés** par capture réseau — voir le README pour la forme réelle de la réponse et
le piège d'unité (`utilization`/`percent` en 0-100, pas en fraction 0-1). Testé par
`node test-usage-source.js`.

⚠️ **`ORGS_PATH` reste une supposition** : la requête qui liste les organisations n'a jamais
été capturée — voir la section dédiée du README si le sondage échoue avant même d'atteindre
`.../usage`.

⚠️ `theme.js` a **deux** entrées `content_scripts`. La seconde vise `https://a.claude.ai/*` avec
`all_frames: true` : le spinner « plein écran » (gros astérisque isolé) est rendu dans une iframe
sur ce sous-domaine, où le script n'était jamais injecté — `all_frames` vaut `false` par défaut,
et c'était ça le blocage, pas le domaine (`https://*.claude.ai/*` le couvrait déjà, y compris
dans `host_permissions`). Ne pas remplacer ça par un `all_frames: true` sur l'entrée principale :
ça injecterait aussi le thème dans les autres iframes du site (rendus d'artefacts). L'entrée
principale porte un `exclude_matches` symétrique pour que les deux jeux restent disjoints —
modifier l'un sans l'autre provoque une double exécution. C'est la seule entrée du dépôt couplée
à un nom de domaine précis : si Anthropic le renomme, le spinner cessera **silencieusement** de
suivre la couleur.

Quatre fonctionnalités s'ajoutent, indépendantes des trois sources ci-dessus et les unes des
autres : la **personnalisation du thème** (`theme.js`), l'**auto-continue**
(`autocontinue-source.js` + `autocontinue.js` + `autocontinue-bg.js`), qui clique le bouton
« Continue » d'une réponse arrêtée par la limite de tool-use. L'auto-continue exige **deux
conditions cumulées** (bouton visible ET phrase de limite dans le seul dernier message) et
n'a qu'un détecteur, `acTick()`, réveillé soit par un `MutationObserver`, soit par le service
worker — d'où l'impossibilité structurelle du double-clic. Testé par
`node test-autocontinue.js` (logique pure) et `node test-autocontinue-dom.js` (DOM bouchonné).

⚠️ Convention à ne pas casser : `autoContinueMaxCount === 0` signifie **illimité**, partout
(`AC_UNLIMITED`). C'est aussi ce que rend `acSettings()` pour une clé absente ou aberrante, donc
un réglage non configuré ne bloque jamais. Une comparaison `count >= maxCount` nue bloquerait
immédiatement à 0 : le court-circuit doit passer **avant**, et `acMaxReached()` est le seul
endroit du dépôt où cette comparaison a le droit d'exister. Quand l'auto-continue ne clique pas,
le diagnostic est dans la console du service worker (état de la boucle) puis dans celle de
l'onglet (bouton, phrase, compteur, décision, et le message réel recopié).

⚠️ Les **dossiers personnalisés** de la sidebar (`folders-source.js` + `folders.js`) sont la
fonctionnalité **la plus fragile du dépôt** : la seule à manipuler la structure DOM native de
claude.ai plutôt que des variables CSS ou des données d'API. Elle **déplace** les vrais nœuds
des conversations (jamais de clone, sinon les clics et menus natifs seraient perdus), s'ancre
sur `a[href^="/chat/"]` puis `closest('.df-drag-shiftable')`, et se réapplique via un
`MutationObserver` sur `aside.dframe-sidebar`. **Ne pas re-deviner les sélecteurs** : ils sont
confirmés par inspection et consignés dans un tableau du README, avec leur fragilité respective.
Le bouton « − » (retrait en un clic) se pose dans le conteneur de contrôles natif de la ligne,
atteint par le parent du premier `button` de l'item qui n'est pas le nôtre — surtout pas par
`aria-label^="Plus d'options pour"`, qui dépend de la langue de l'interface. C'est ce qui lui
fait hériter du survol sans gérer d'opacité, et il appelle le **même** `cfApplyDrop('', uuid)`
que le dépôt sur la bande « Retirer » : une seule désassignation, deux entrées. Son clic est
intercepté sur `window` en **capture**, par délégation sur `.cf-unfile`, et le bouton lui-même ne
porte **aucun** gestionnaire : en bouillonnement, le premier clic se faisait manger par un
« avaleur de clic » à usage unique du site — même défaut et même correction que pour le dépôt. Ne
pas y reposer d'`addEventListener`.
Ses composants flottants — menu du clic droit, modale de saisie (création et renommage),
confirmation de suppression — **copient un composant natif précis** de claude.ai : il ne reste
**aucun** `window.prompt` ni `window.confirm` dans cette fonctionnalité. Saisie et confirmation
partagent la coque `cfShell()` et rien d'autre (corps, garde-fou et touche Entrée diffèrent) —
ne pas les refondre en une seule fonction à paramètres optionnels. La confirmation donne le focus
à **« Annuler »**, pas au bouton rouge : Entrée y referme au lieu de détruire, à l'inverse d'un
`window.confirm`. Chaque couleur, rayon et
ombre y passe par `var(--cds-x, <valeur observée>)` : les noms de tokens sont **déduits** de
leurs classes Tailwind, ce qui n'est acceptable que parce qu'on les **lit** avec un repli — un
nom erroné retombe sur la valeur observée. Ne pas remplacer ces replis par un token nu, et ne pas
rebrancher ces composants sur `--cds-radius` / `--cds-shadow-{sm,md,lg}` : ce sont les tokens de
base, que `theme.js` multiplie déjà, et rien ne confirme qu'ils valent le `rounded-card` /
`shadow-panel` observés ici. Le mode sombre est couvert par le token du site quand il existe, et
par un repli `@media (prefers-color-scheme: dark)` sinon.

Toute la logique vérifiable vit dans `folders-source.js` (`node test-folders.js`) ; le placement
DOM a un harnais jsdom optionnel, `node test-folders-dom.js`, qui se saute si jsdom est absent —
le dépôt reste sans `package.json` ni `node_modules`.

L'**export de conversation** (`export-source.js` + `export.js`) ajoute un bouton à côté de
« Partager ». Décision de conception à ne pas défaire : **le contenu vient de l'API**
(`…/chat_conversations/<uuid>`, le même GET que celui intercepté par `inject.js`), jamais du
DOM — scraper aurait imposé de dérouler toute la conversation, et un export tronqué ne se voit
pas. Il n'y a **pas de repli DOM**, délibérément. L'uuid d'organisation n'est pas deviné non
plus : il est relevé dans les URL que la page a réellement appelées
(`performance.getEntriesByType('resource')`), justement pour ne pas dépendre de `ORGS_PATH`. Le
PDF passe par `window.print()` dans une iframe hors écran, sans aucune bibliothèque. Testé par
`node test-export.js` (logique pure) et `node test-export-dom.js` (jsdom optionnel).

⚠️ L'ancrage du bouton part de **« Partager »**, pas du slot `div#dframe-header-actions-slot` :
ce dernier est absent d'au moins un contexte (conversation de Projet), où l'export se
désactivait à tort. `exAnchor()` cherche « Partager » du plus proche au plus large et place le
bouton dans *son* parent, quel qu'il soit — donc **ne pas remettre de condition « slot
obligatoire »**, et ne pas ajouter un sélecteur de conteneur par contexte : c'est justement ce
que cet ordre évite. Le slot ne sert que de repli, et l'arrêt propre ne subsiste que si les deux
manquent.

Le dépôt est **porté sur Firefox** (MV3), avec un **manifest unique** partagé avec Chrome.
Vérifié en conditions réelles sur Firefox 153 et Chrome 150 ; le détail des mesures, des
verdicts et des réserves est dans la section « Portage Firefox » du README. Trois pièges
seulement méritent d'être connus avant de toucher au code :

⚠️ `background` porte **deux** clés : `service_worker` (Chrome) et `scripts` (Firefox, qui ne
supporte pas `service_worker` et instancie une **event page**). Les mêmes six fichiers sont donc
listés **à deux endroits**, dans le même ordre — le tableau `scripts` du manifest, et les
`importScripts()` en tête de `background.js`. Rien ne les synchronise : n'en modifier qu'un casse
**un seul** des deux navigateurs, ce qui en fait une panne asymétrique, facile à ne pas voir.
`importScripts` n'existant que dans un `WorkerGlobalScope`, il est protégé par
`if (typeof importScripts === 'function')` — **ne pas retirer ce garde**, c'était le premier
obstacle réel du portage.

⚠️ `compat.js` doit être chargé **en premier** dans chaque contexte : tableau `scripts`, chaque
entrée `content_scripts` **sauf** celle en `world: "MAIN"` (aucune API d'extension n'y existe),
et `popup.html`. Il aliase `chrome` sur `browser`, et c'est un **filet de sécurité, pas un
correctif** : sur Firefox 153 `chrome.*` rend déjà des promesses, mais ce comportement n'est
documenté nulle part. Deux conséquences : après l'alias `chrome.*` **est** `browser.*`, qui est
promise-only, donc tout appel en **style callback** devient suspect — le dépôt n'en compte qu'un,
`show()` dans `background.js` ; et le fichier étant évalué **six fois par frame** (une par entrée
`content_scripts`), il doit rester **strictement idempotent** : aucun compteur, aucun log.

⚠️ `strict_min_version: "128.0"` vient de `world: "MAIN"` (Firefox 128+), **pas** du comportement
de `chrome.*`. Ne pas l'abaisser en croyant qu'il protège les promesses : sous 128, `world` est
une clé inconnue donc ignorée, `inject.js` atterrit dans le monde isolé, et l'estimation de
contexte cesse **silencieusement** de fonctionner.

## Contraintes techniques

- Manifest V3 uniquement, JS vanilla, pas de build step — chargeable directement en mode
  développeur via chrome://extensions, ou via `about:debugging` côté Firefox. **Un seul
  manifest pour les deux navigateurs** : voir les pièges ci-dessus avant d'y toucher.
- Toutes les données restent en local (chrome.storage.local) — jamais de serveur tiers. Le
  réseau émis par l'extension va vers claude.ai (sondage d'usage) et status.claude.com
  (sondage de statut), rien d'autre.
- Les endpoints internes de claude.ai ne sont pas garantis stables : le code doit rester
  simple à corriger si un format de réponse change. D'où `usage-source.js` et
  `status-source.js`, un point d'adaptation unique par source.

---

# Behavioral guidelines

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
