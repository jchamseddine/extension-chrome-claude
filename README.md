# Claude Usage

Extension Chrome personnelle (Manifest V3, JS vanilla, aucun build step). Elle affiche :

1. l'usage **session (5 h)** et **hebdomadaire (7 j)** de claude.ai — icône à deux anneaux,
   badge, popup ;
2. une **estimation** de la taille du contexte de la conversation ouverte, en pastille sur
   la page ;
3. le **statut de Claude** lu sur `status.claude.com` (claude.ai, Claude Code, API…), en
   section du popup.

Elle permet aussi, via deux fonctionnalités totalement indépendantes des précédentes et l'une
de l'autre :

- de **personnaliser le thème** de claude.ai (couleur d'accent, poids de police, coins et
  ombres, police de lecture) ;
- de **relancer automatiquement** une réponse arrêtée par la limite de tool-use
  (*auto-continue*) — désactivé par défaut, avec compteur de continuations et pause ;
- de ranger les conversations dans des **dossiers personnalisés** dans la sidebar, sans rapport
  avec les *Projects* natifs — ⚠️ la fonctionnalité la plus fragile du dépôt, voir sa section ;
- d'**exporter une conversation** en Markdown ou en PDF, depuis un bouton à côté de
  « Partager » — le contenu vient de l'API, jamais du DOM, donc jamais tronqué.

Rien ne sort de la machine, sauf vers claude.ai et status.claude.com : tout est dans
`chrome.storage.local`, aucun serveur tiers.

## Installation

1. `chrome://extensions` → activer le **mode développeur**
2. **Charger l'extension non empaquetée** → sélectionner ce dossier
3. Être connecté à `https://claude.ai` — le sondage utilise les cookies de session

Chrome 111+ requis (`"world": "MAIN"` en content script statique).

Après avoir rechargé l'extension, **toujours recharger l'onglet claude.ai** — sinon le patch
injecté survit mais l'onglet ne peut plus servir de relais.

## ⚠️ Résolution de l'organisation : à compléter

`GET /api/organizations/<org>/usage` est **confirmé** par capture réseau (voir ci-dessous).
Ce qui reste une supposition, c'est `ORGS_PATH` dans [`usage-source.js`](usage-source.js) —
le chemin utilisé pour retrouver `<org>` n'a jamais été capturé.

Si le sondage échoue *avant même* d'atteindre l'endpoint d'usage (chercher `HTTP 404` ou
`format de réponse inconnu` en console, mais sur la requête qui précède `.../usage`), c'est
`ORGS_PATH` et `pickOrgId()` qu'il faut corriger, avec la même méthode que pour l'usage :
onglet **Network**, filtre *Fetch/XHR*, repérer la requête qui liste les organisations.

## D'où viennent les données

L'usage est **sondé** toutes les 60 s par le service worker (`chrome.alarms`), avec
`credentials: "include"`, sur `GET /api/organizations/<org>/usage`. Le service worker n'ayant
pas d'origine `claude.ai`, l'API peut refuser sa requête : sur **401/403**, l'appel est rejoué
depuis un onglet `claude.ai` ouvert, où il est same-origin (`content.js` sert de relais). Sans
onglet ouvert et avec un refus, le sondage échoue et le popup montre l'âge de la dernière
valeur connue.

L'estimation de contexte, elle, n'émet toujours **aucun** appel : elle observe les réponses
que claude.ai reçoit déjà.

Le statut vient d'une source à part, sur un autre domaine et sans authentification — voir
[Statut de Claude](#statut-de-claude) plus bas.

| URL (pathname) | Ce qu'on en tire |
| --- | --- |
| `…/organizations/<org>/usage` | `utilization` (0-100) et `resets_at` des fenêtres 5 h et 7 j, `severity` par fenêtre |
| `…/chat_conversations/<uuid>/completion` (SSE) | la longueur du texte streamé |
| `…/chat_conversations/<uuid>` (GET JSON) | la longueur de l'historique complet |
| `status.claude.com/api/v2/summary.json` | l'indicateur global, l'état des composants Claude, l'incident en cours |

Réponse réelle de l'API d'usage (capturée le 2026-07-29), simplifiée :

```json
{
  "five_hour": { "utilization": 76, "resets_at": "2026-07-29T10:49:59.074167+00:00" },
  "seven_day": { "utilization": 43, "resets_at": "2026-08-01T10:59:59.074190+00:00" },
  "limits": [
    { "kind": "session",    "percent": 76, "severity": "warning", "resets_at": "..." },
    { "kind": "weekly_all", "percent": 43, "severity": "normal",  "resets_at": "..." },
    { "kind": "weekly_scoped", "scope": { "model": { "display_name": "Fable" } }, "...": "..." }
  ],
  "extra_usage": { "is_enabled": false, "utilization": 0 },
  "spend": { "percent": 0, "enabled": false }
}
```

**`utilization` et `percent` sont des entiers 0-100**, pas des fractions 0-1 comme l'était
l'ancien `windows.utilization` du flux SSE — piège à ne pas réintroduire si ce fichier est
retouché : `parseUsage()` divise par 100 une seule fois, jamais ailleurs.

`parseUsage()` (dans `usage-source.js`) normalise cette réponse vers la forme historique de
l'événement SSE `message_limit`, qui reste le contrat interne de la clé `usage` :
`{ windows: { '5h': {utilization, status?, resets_at?}, '7d': {...} } }`, `utilization` en
fraction 0-1. Priorité à `limits[]` (`kind:"session"` → 5h, `kind:"weekly_all"` → 7d ;
`weekly_scoped`, l'usage par modèle, est ignoré) ; repli sur `five_hour`/`seven_day` à la
racine si `limits` manque, est vide, ou ne porte pas l'entrée cherchée. `severity` se mappe
sur `status` (`"warning"` → `approaching_limit`) ; `"over_limit"` n'a **jamais été observé**
côté `severity`, ce mapping est extrapolé par analogie avec l'ancien flux SSE.

Un champ absent, mal typé, ou une `severity` inconnue est **omis**, jamais mis à une valeur
inventée : `utilOf()`/`colorFor()` rendent alors du gris ou dérivent la couleur du seul
pourcentage, plutôt qu'un chiffre faux ou une exception. Couvert par
[`test-usage-source.js`](test-usage-source.js) (`node test-usage-source.js`), avec la réponse
réelle ci-dessus en cas de test principal.

`extra_usage` / `spend` (crédits payants) ne sont pas encore branchés — équivalent de l'ancien
`overageInUse`, jamais observé non plus. À câbler dans `evaluate()` de `background.js` si ce
point redevient utile.

### Statut de Claude

Troisième source, **totalement indépendante** des deux autres : autre domaine, endpoint public
(aucun cookie utile), rien de partagé en storage, et elle ne touche ni l'icône, ni l'historique,
ni les notifications. Sondée toutes les **5 min** par l'alarme `status-poll` — le statut bouge
rarement, inutile de solliciter la page au rythme de l'usage.

`status.claude.com` est un **Statuspage** (Atlassian) : son API v2 est publique et non
authentifiée. On prend `summary.json` et pas `status.json`, parce qu'une seule requête donne
l'indicateur global, les composants **et** les incidents. Réponse réelle (capturée le
2026-07-30, un incident était actif), simplifiée :

```json
{
  "status": { "indicator": "minor", "description": "Minor Service Outage" },
  "components": [
    { "name": "claude.ai",                     "status": "partial_outage", "group": false },
    { "name": "Claude Console (platform.claude.com)", "status": "operational", "group": false },
    { "name": "Claude API (api.anthropic.com)", "status": "partial_outage", "group": false },
    { "name": "Claude Code",                   "status": "partial_outage", "group": false },
    { "name": "Claude Cowork",                 "status": "partial_outage", "group": false },
    { "name": "Claude for Government",         "status": "operational",    "group": false }
  ],
  "incidents": [
    { "name": "Elevated errors across many models", "impact": "major", "resolved_at": null }
  ]
}
```

`parseStatus()` (dans [`status-source.js`](status-source.js)) normalise ça en
`{ level, components: [{ name, level, status }], incident? }`, `level` valant
`operational` / `degraded` / `outage`. Deux points que cette capture impose :

- **`status.indicator` peut sous-estimer la réalité** : il annonce `minor` alors que quatre
  composants sont en `partial_outage` et que l'incident est d'impact `major`. Le niveau global
  est donc le **pire de (indicateur, composants retenus)**, jamais l'indicateur seul.
- **Le filtre « nom contenant *claude* » ne retire rien aujourd'hui** : les six noms le
  contiennent. Il n'est là que pour écarter un composant étranger si Atlassian en ajoute un.

Un statut de composant inconnu — ou absent — donne `degraded`, pas `operational` : pour un
afficheur de panne, une fausse alerte qui envoie voir status.claude.com coûte moins cher qu'un
« tout va bien » affiché pendant une panne. La valeur brute est conservée à côté de `level`
pour rester diagnosticable. `status.description` n'est pas repris (anglais, et redondant avec
`level`) : le popup a ses propres libellés. Couvert par
[`test-status-source.js`](test-status-source.js) (`node test-status-source.js`), avec la capture
ci-dessus en cas de test principal.

Côté popup, la section « Statut » se réduit à **une ligne** quand tout est nominal (« Tous les
systèmes opérationnels ») et ne détaille que les composants hors état nominal, précédés du titre
de l'incident quand il y en a un. Un lien ouvre `status.claude.com` dans un nouvel onglet pour
le détail complet. Elle réutilise la palette de `common.js` mais **pas** `colorFor()`, qui
attend un objet fenêtre d'usage.

## Architecture

| Fichier | Monde | Rôle |
| --- | --- | --- |
| `inject.js` | MAIN | patch de `fetch` et de l'History API, tap SSE, comptage de caractères |
| `content.js` | isolé | relais de secours : refait le fetch d'usage same-origin quand le SW est refusé |
| `context-estimator.js` | isolé | tient l'estimation de contexte par conversation et affiche la pastille sur `/chat/*` |
| `theme.js` | isolé | surcharge les tokens de thème du site — **indépendant du reste** |
| `autocontinue.js` | isolé | lit le DOM et clique le bouton *Continue* — **indépendant du reste** |
| `background.js` | service worker | sonde les deux API (usage 60 s, statut 5 min), écrit `usage` et `status`, dessine l'icône, notifie |
| `usage-source.js` | SW | **seul** point d'adaptation à l'API d'usage : URL + `parseUsage()` |
| `status-source.js` | SW | **seul** point d'adaptation à status.claude.com : URL + `parseStatus()` — **indépendant du reste** |
| `autocontinue-source.js` | SW + page + popup | **seul** point d'adaptation de l'auto-continue : phrases + `acDecide()`, logique pure |
| `autocontinue-bg.js` | SW | réveille `acTick()` dans chaque onglet claude.ai toutes les 5 s — **indépendant du reste** |
| `folders-source.js` | page | **seul** point d'adaptation « données » des dossiers : uuid + CRUD, logique pure |
| `folders.js` | isolé | insère les dossiers et **déplace** les items de la sidebar — ⚠️ **le plus fragile du dépôt** |
| `export-source.js` | page | **seul** point d'adaptation de l'export : URL, `parseConversation()`, Markdown/HTML — logique pure |
| `export.js` | isolé | bouton d'export dans l'en-tête, menu, téléchargement et impression — **indépendant du reste** |
| `common.js` | SW + popup | seuils de couleur partagés (`utilOf`, `colorFor`) |
| `popup.html` / `popup.js` | popup | les deux fenêtres d'usage, la projection, la section « Statut », les réglages |

Clés `chrome.storage.local` :

- `usage` = `{ data, updatedAt }` — clé unique, réécrite **à chaque sondage** même si rien n'a bougé
- `status` = `{ data, updatedAt }` — statut de status.claude.com, réécrite à chaque sondage
- `orgId` = uuid d'organisation mis en cache, invalidé sur 401/403/404
- `ctx:<uuid>` = `{ chars, tokens, updatedAt }` — une clé par conversation, LRU 20
- `usageHistory` = `[{ t, u5, u7 }, …]` — historique roulant, 50 points max
- `notifyState` = `{ windows: { '5h': { threshold, overLimit, notifiedReset }, … }, overage }` — anti-spam
- `settings` = `{ notifications: false }` — réglages du popup
- `accentColor`, `fontWeightPreset`, `radiusPreset`, `fontFamily` — personnalisation du thème,
  quatre clés de premier niveau ; **toutes absentes** = thème d'origine intact (voir plus bas)
- `autoContinueEnabled`, `autoContinueMaxCount`, `autoContinueCount`, `autoContinuePaused` —
  auto-continue, quatre clés de premier niveau ; **toutes absentes** = désactivé (voir plus bas)
- `folders` = `[{ id, name, color, collapsed }, …]` et `folderAssignments` =
  `{ "<uuid>": "<id dossier>" }` — dossiers personnalisés de la sidebar ; **absentes** = aucun
  dossier, tout reste dans « Récents » (voir plus bas)

### Sondage

Deux alarmes indépendantes : `usage-poll` à `periodInMinutes: 1` (le plancher de
`chrome.alarms`) et `status-poll` à 5 min, plus un sondage immédiat de chacune sur `onStartup`
et `onInstalled` pour ne pas attendre la première alarme.

Le sondage du statut appelle `fetchJson()` directement, **pas** `getJson()` : le repli sur un
onglet claude.ai n'aurait aucun sens pour un endpoint public d'un autre domaine, et ses
avertissements `[usage]` seraient trompeurs.

Le service worker étant détruit et relancé en permanence, le code de premier niveau rejoue à
chaque réveil : l'alarme n'est (re)créée que si `chrome.alarms.get` la trouve absente —
`create` remettrait le compte à zéro et repousserait le sondage indéfiniment.

L'icône, l'historique et les notifications restent branchés sur `chrome.storage.onChanged` :
l'événement se déclenche **aussi** dans le contexte qui a écrit, le sondage n'a donc rien à
appeler directement.

### Icône

Deux anneaux concentriques dessinés dans un `OffscreenCanvas` : **extérieur = 7 j**,
**intérieur = 5 h**, chacun coloré par sa propre fenêtre (vert < 50 %, jaune < 75 %,
orange < 90 %, rouge au-delà ; gris si la donnée manque). Le badge texte porte le % de la
fenêtre 5 h. Aucun PNG n'est livré : le service worker dessine l'icône dès `onInstalled` et
`onStartup`.

### Notifications

**Désactivées par défaut** — la case à cocher est dans le popup, la préférence va dans
`settings.notifications`. Cette **unique** préférence gouverne toutes les notifications, seuils
comme fin de reset.

#### Seuils

Trois seuils : **75 %**, **90 %**, **95 %**, évalués séparément sur chaque fenêtre. Le corps
de la notification donne la fenêtre, le % courant et l'heure de reset en heure locale.

L'anti-spam mémorise le dernier seuil notifié par fenêtre dans `notifyState`. On ne notifie
que si le seuil franchi est **supérieur** au dernier notifié ; redescendre le baisse
silencieusement, ce qui réarme la notification en cas de nouveau franchissement (typiquement
après un reset de fenêtre). Deux notifications distinctes s'ajoutent, chacune une seule fois
par transition : passage d'une fenêtre à `over_limit`, et passage de `overageInUse` à `true`.

> `overageInUse` est un vestige de l'ancien flux SSE : la réponse réelle de l'API d'usage ne le
> porte pas, elle a `extra_usage`/`spend` à la place (voir plus haut). Le check reste en place,
> sans effet, en attendant que ces champs soient câblés dans `evaluate()` de `background.js`.

#### Fin de reset

L'inverse des seuils : signaler qu'une fenêtre **repart à zéro**, sans avoir à ouvrir le popup.
Aucune donnée supplémentaire n'est collectée — `resets_at` et `utilization` sont déjà là.

`isReset()` exige **deux signaux ensemble**, jamais un seul :

1. `resets_at` a changé depuis le sondage précédent, **et**
2. l'utilisation est retombée franchement : ancien % > **20**, nouveau % < **la moitié** de
   l'ancien.

Chacun pris isolément produit des faux positifs. Une borne `resets_at` qui bouge de quelques
secondes sans reset réel n'est pas exclue par l'API — la retenir seule ferait sonner
l'extension pour rien. Et une chute de pourcentage sans nouvelle borne est une correction de
mesure, pas une nouvelle fenêtre. Le seuil de moitié plutôt qu'un « ≈ 0 % » absolu laisse
passer le cas courant où un message est envoyé dans la minute qui suit le reset.

S'y ajoute une **garde de fraîcheur** : la comparaison est ignorée si le sondage précédent a
plus de **10 min** (`RESET_MAX_AGE_MS`). Sans elle, le premier sondage au réveil de Chrome
annoncerait un reset survenu la veille.

Le point de comparaison est `changes.usage.oldValue` de `storage.onChanged` — la valeur du
sondage d'avant, lue depuis le storage, donc fiable même après un recyclage du service worker.
`notifyState.windows.<clé>.notifiedReset` mémorise en plus la dernière borne annoncée : une
seule notification par reset, même si le même sondage était rejoué.

Couvert par [`test-background.js`](test-background.js) (`node test-background.js`), qui exerce
les trois combinaisons (deux signaux → notifie ; borne seule → non ; chute seule → non), la
garde de fraîcheur, l'anti-spam et la non-régression des seuils.

L'icône de la notification est encodée en PNG data-URL depuis le même `OffscreenCanvas` que
l'icône de toolbar — `chrome.notifications` exige un `iconUrl`, et c'est ce qui permet de ne
livrer aucun binaire dans le dépôt.

### Estimation du temps avant la limite

Chaque sondage ajoute un point `{ t, u5, u7 }` à `usageHistory` (50 max, les plus anciens
sont jetés) — soit une série régulière à 1 point/minute, ce qui donne bien plus de sens à
l'ajustement qu'un point par message envoyé. 50 points couvrent 50 min, la fenêtre
d'ajustement en utilise 30. Le popup ajuste une **régression linéaire des moindres carrés**
sur les points des 30 dernières minutes :

```
a = Σ(t − t̄)(u − ū) / Σ(t − t̄)²      puis      t(u=1) = t̄ + (1 − ū) / a
```

Passer par les moyennes évite d'avoir à calculer l'ordonnée à l'origine. Aucune bibliothèque,
c'est volontairement basique — ça suppose un rythme constant, ce qui est faux dès qu'on fait
une pause.

La projection ne s'affiche **que** si la pente est positive et que l'échéance tombe **avant
le reset de la fenêtre** (`windows.5h.resets_at`) : au-delà, le compteur repart de zéro et la
limite ne sera jamais atteinte. Quand `resets_at` manque ou est déjà passé, un horizon fixe
de 5 h sert de repli. En dessous de 3 points — donc pendant les 3 premières minutes de
sondage — le popup affiche « pas assez de données » plutôt qu'un ajustement bancal. À
l'inverse, une période sans activité donne une pente nulle : la projection disparaît au lieu
d'annoncer une échéance imaginaire.

### Estimation de contexte

**C'est une estimation, pas une mesure.** Le POST vers `/completion` ne contient que le
nouveau message — l'historique reste côté serveur. La base vient donc du GET de la
conversation, à laquelle on ajoute à chaud les caractères envoyés puis ceux de la réponse
streamée ; le total est divisé par 4 pour approcher un nombre de tokens. Un rechargement de
page resynchronise sur la valeur réelle.

L'estimation est tenue **par conversation**, sous la clé `ctx:<uuid>` où `<uuid>` vient de
l'URL `/chat_conversations/<uuid>/completion`. Les 20 conversations les plus récemment mises
à jour sont conservées, les autres sont supprimées (LRU).

La pastille lit l'UUID de l'**URL de la page**, pas celui des requêtes : passer d'une
conversation à l'autre sans rechargement met à jour l'affichage, via le patch de
`pushState` / `replaceState` posé côté MAIN (chaque monde a son propre `History.prototype`,
patcher depuis le monde isolé n'intercepterait rien). Sans estimation connue pour la
conversation ouverte, la pastille affiche *contexte non estimé* plutôt qu'un « ~0 tokens »
trompeur.

Ne sont pas comptés : les instructions système, les outils, les documents de projet, les
résultats de recherche web. Le vrai contexte est donc toujours plus grand que ce chiffre.

### Personnalisation du thème

Fonctionnalité à part : `theme.js` ne partage rien avec le reste de l'extension (ni
`usage-source.js`, ni `background.js`, ni `common.js`), et a sa propre entrée
`content_scripts` dans le manifest pour pouvoir être retirée d'un bloc.

Quatre réglages, quatre clés de premier niveau (pas dans l'objet `settings`, réservé aux
notifications) :

| Clé | Valeurs | Absente = |
| --- | --- | --- |
| `accentColor` | `"#rrggbb"` | couleur d'origine |
| `fontWeightPreset` | `"thin"` / `"normal"` / `"bold"` | `"normal"` |
| `radiusPreset` | `"square"` / `"normal"` / `"round"` | `"normal"` |
| `fontFamily` | `"sans"` / `"serif"` / `"mono"` | police d'origine |

**Un seul point d'injection** : un `<style id="__claude_theme_v1__">` unique porte toutes les
règles, dans une seule déclaration `:root,html.cds-root,.cds-root{…}`. `"normal"` n'injecte
rien pour sa partie, et toute valeur hors liste est traitée comme absente — comme `accentValid`
pour la couleur, puisque le contenu finit concaténé dans du texte CSS.

**`--font-open-dyslexic` est hors périmètre** : claude.ai pilote déjà cette police nativement
(Réglages → Apparence → « Chat font » : Default / Match System / Dyslexic Friendly, cf. le
[centre d'aide](https://support.claude.com/en/articles/8887527-customizing-your-appearance-settings)).
Le menu de l'extension n'offre donc que sans-serif / serif / monospace.

#### Couleur d'accent

Chaîne de résolution **confirmée par inspection du bouton d'envoi** :

| Classe Tailwind | Variable | Alias | Valeur d'origine |
| --- | --- | --- | --- |
| `bg-fill-brand` | `--cds-fill-brand` | `--cds-clay-emphasized` | `#c6613f` |
| `bg-fill-brand-hover` | `--cds-fill-brand-hover` | `--cds-clay` | `#d97757` |

Ce sont des tokens de base du design system, pas propres à ce bouton : les surcharger repeint
les autres éléments de marque. `theme.js` ne pose que ces **deux seules** variables pour la
couleur, en `!important`, sur le sélecteur `:root,html.cds-root,.cds-root` :

| Sélecteur | Pourquoi |
| --- | --- |
| `:root` | cas où les tokens sont portés par `<html>` |
| `html.cds-root` | même élément, mais spécificité (0,1,1) > le `.cds-root` (0,1,0) du site |
| `.cds-root` | si la classe n'est **pas** sur `<html>`, le site pose les tokens sur un élément plus proche du bouton ; entre deux éléments différents la spécificité ne joue pas et notre valeur héritée depuis `:root` perdrait même en `!important` |

Pour savoir dans quel cas on est : `document.querySelector('.cds-root').tagName` dans la console
de l'onglet claude.ai.

La couleur de survol est calculée en JS : hex → HSL, **+9 points absolus de luminosité**
(teinte et saturation inchangées), HSL → hex. Le chiffre est calé sur le vrai couple
`#c6613f` (L 51,2 %) → `#d97757` (L 59,6 %), soit +8,4 points. En absolu et non en relatif :
un facteur multiplicatif écrase l'écart sur les teintes sombres. Exemples :
`#c6613f → #d17e62`, `#3f6ac6 → #6285d1`, `#20304f → #2d4470`. Testé par
`node test-theme.js`.

#### Poids, coins/ombres, police : dérivés des valeurs d'origine

Ces trois réglages ne posent **aucune valeur en dur** : ils lisent les tokens du site à
l'exécution (`getComputedStyle`) et les transforment. Une variable illisible ou de format
inattendu n'est simplement pas surchargée, avec un `console.warn` qui la nomme.

| Constante | Valeur | Pourquoi |
| --- | --- | --- |
| `THEME_WEIGHT_DELTA` | ±100 | un cran de la graduation CSS sur les 4 `--cds-font-weight-*` : visible sans casser la hiérarchie regular/bold |
| `THEME_RADIUS_FACTOR` | ×1,5 | au-delà, les petits contrôles deviennent des gélules |
| `THEME_SHADOW_LENGTH_FACTOR` | ×1,2 | des coins plus ronds paraissent plus plats sans ombres un peu plus marquées |
| `THEME_SHADOW_ALPHA_FACTOR` | ×1,15 | idem, borné à 1 |

`themeScaleShadow()` traite `--cds-shadow-{sm,md,lg}` par remplacement regex, sans découper les
couches ni les positions : **les décalages grandissent donc des mêmes 20 % que le flou.**
Simplification assumée — visuellement subtile, et ça évite un parseur `box-shadow` complet pour
un format qu'on ne maîtrise pas. Une couleur dont l'alpha n'est pas extractible (`oklch(… / .05)`,
alpha en `%`) laisse l'ombre **intacte** plutôt que d'inventer une valeur. « Carré » ne calcule
rien : `--cds-radius: 0` et les trois ombres à `none`.

Pour la police, on **alias** la variable cible sur une pile que le site définit déjà —
`<var cible>: var(--font-anthropic-serif)` — plutôt que de coder des piles en dur. La variable
cible est trouvée à l'exécution par `themeDetectFontVar()` : celle des trois `--font-anthropic-*`
dont la valeur correspond au `font-family` calculé de `document.body`. Aucune correspondance →
warn et réglage sans effet, pas de cible devinée.

⚠️ **La capture des valeurs d'origine est mémoïsée une seule fois** (`themeCaptureOriginals`),
et tous les réglages qui écrivent ces variables attendent qu'elle ait réussi. Sans ça, notre
propre feuille en `!important` polluerait la lecture suivante : le rayon serait multiplié par
1,5 **en cascade** à chaque changement de préréglage, et la pile de police aliasée ne serait
plus détectable. C'est aussi pourquoi « Carré » et la police attendent la capture alors que leur
calcul n'en a pas besoin.

À `document_start` les feuilles du site ne sont pas encore parsées et tout revient vide : la
capture renvoie `null` **sans mémoïser**, et `theme.js` retente sur `DOMContentLoaded` puis à
100/300/800/1500/3000 ms. Passé ce délai, un warn nomme ce qui reste introuvable.

#### Propagation

**Le popup n'envoie rien aux onglets** : il écrit ou supprime les quatre clés, et chaque onglet
réagit via `chrome.storage.onChanged` en **relisant les quatre** (un `remove` groupé produit
alors un seul rendu cohérent). Tous les onglets claude.ai ouverts changent donc ensemble, sans
rechargement, sans passer par `chrome.scripting` ni `chrome.tabs`. « Réinitialiser » supprime les quatre clés,
ce qui **retire** l'élément `<style>` au lieu de le vider — le thème d'origine redevient
exactement ce qu'il était.

⚠️ **Si un élément de marque ne change pas de couleur**, ne pas ajouter de variable au
hasard : inspecter cet élément précis pour confirmer sa vraie chaîne de résolution, comme
cela a été fait pour le bouton d'envoi. Les variables de fond (`--_gray-*`,
`--cds-hsl-gray-*`, `--cds-oncolor-*`), celles de texte, ainsi que `--_brand-clay` et
`--cds-hsl-clay` sont **hors périmètre** — ces deux dernières n'apparaissent pas dans la
chaîne confirmée ci-dessus.

### Auto-continue

Quatrième fonctionnalité indépendante : quand une réponse bute sur la **limite de tool-use**,
claude.ai affiche un bouton *Continue* qu'il faut cliquer à la main. `autocontinue.js` le fait
à votre place. **Désactivée par défaut**, réglages dans le popup.

Rien de commun avec `usage-source.js`, `status-source.js` ni `theme.js` : quatre clés dédiées,
sa propre entrée `content_scripts`, et deux `importScripts` isolés en tête de `background.js`
— c'est tout son ancrage, les retirer supprime la fonctionnalité.

| Clé | Valeurs | Absente = |
| --- | --- | --- |
| `autoContinueEnabled` | `true` / `false` | désactivé |
| `autoContinueMaxCount` | `1`-`999`, ou `0` | `0` = illimité |
| `autoContinueCount` | entier ≥ 0 | `0` |
| `autoContinuePaused` | `true` / `false` | pas en pause |

Adaptation dans [`autocontinue-source.js`](autocontinue-source.js) — logique **pure**, aucun
DOM, aucun `chrome.*` : c'est ce qui la rend testable telle quelle
(`node test-autocontinue.js`). Les sélecteurs DOM, eux, sont en tête de
[`autocontinue.js`](autocontinue.js), couvert par `node test-autocontinue-dom.js` sur un DOM
bouchonné.

#### Deux conditions cumulées

La détection n'agit **jamais** sur un seul signal :

1. un bouton *Continue* **visible** dans le DOM — un message qui parle de la limite sans
   bouton veut dire que la réponse est finie, il n'y a rien à continuer ;
2. une des six phrases caractéristiques dans le **dernier** message de l'assistant, et
   **nulle part ailleurs** dans la conversation.

La seconde moitié du point 2 est le garde-fou anti-faux-positif : une conversation dont le
*sujet* est la limite de tool-use répète la phrase de message en message et s'auto-continuerait
sans fin. Les six variantes (`tool-use limit`, `tool use limit`, `reached its tool`,
`exhausted the tool`, `tool call limit`, `continuation needed`) viennent de
[claude-autocontinue](https://github.com/timothy22000/claude-autocontinue) (MIT), qui les a
relevées sur des messages réels ; elles sont comparées en minuscules et **en sous-chaîne**, la
formulation autour changeant. Aucune variante française n'est codée : aucune n'a été capturée,
et ce dépôt n'écrit pas de valeur devinée (même règle que `ORGS_PATH`).

#### Deux déclencheurs, un seul chemin

| Déclencheur | Où | Latence | Angle mort |
| --- | --- | --- | --- |
| `MutationObserver` (débounce 600 ms d'accalmie) | `autocontinue.js`, page | quasi instantanée | ses `setTimeout` sont **bridés** dès que l'onglet passe en arrière-plan (1 s min, puis 1/min après 5 min caché) |
| sondage `chrome.scripting.executeScript` | `autocontinue-bg.js`, service worker | ≤ 5 s | onglet sans content script (ouvert avant l'installation) |

Les deux appellent **la même** fonction `acTick()`, dans le monde isolé de l'onglet. Le
verrou `acBusy` et le délai de garde de 5 s qu'elle porte rendent donc le double-clic
impossible **par construction** : il n'y a qu'un détecteur, réveillé de deux façons — pas de
protocole de réservation entre le worker et la page. C'est ce que verrouille le test
*deux ticks simultanés (worker + page) : un seul clic*. C'est aussi pour ça que `autocontinue.js`
n'est **pas** dans une IIFE : le worker injecte une fonction qui appelle `acTick()`, le nom
doit être visible depuis le global du monde isolé (même contrainte que `theme.js`).

`chrome.alarms` a un plancher d'une minute, bien trop lent pour une continuation : l'alarme
`autocontinue-poll` ne sert qu'à **ressusciter** le worker, la cadence de 5 s vient d'un
`setInterval` qui ne vit que tant que le worker vit. Chaque `executeScript` repousse la mise en
veille, donc la boucle s'auto-entretient tant qu'il y a un onglet claude.ai. Elle n'est démarrée
que si l'auto-continue est **actif, non en pause et sous son maximum** : désactivé, l'extension
ne maintient rien en vie.

#### `autoContinueMaxCount` : 0 signifie *illimité*

Sans ambiguïté et **partout** — popup, page, service worker. Ce n'est pas une sentinelle
arbitraire : c'est aussi ce que rend `acSettings()` quand la clé manque, vaut `null` ou est
aberrante. Un maximum jamais configuré n'interdit donc **jamais** de continuer, ce qui est le
comportement voulu pour un réglage absent.

L'alternative — `0` = « aucune continuation autorisée » — aurait imposé une autre valeur pour
« illimité » (`-1`, `null`) et transformé une clé absente en blocage silencieux.

⚠️ Corollaire non négociable : une comparaison `count >= maxCount` **nue** bloquerait dès le
premier appel quand `maxCount` vaut 0. Le court-circuit sur `AC_UNLIMITED` doit donc passer
**avant** la comparaison, et il n'existe qu'un seul endroit dans le dépôt où cette comparaison a
le droit de vivre : `acMaxReached()`.

`autoContinueCount` absent et `autoContinueCount = 0` se comportent **strictement pareil**
(`Number(undefined)` vaut `NaN`, que le test `isFinite` écarte). Le popup écrit quand même les
quatre clés à l'activation, mais uniquement pour que le storage se lise sans ambiguïté à la
main — pas pour corriger un comportement. Cinq tests fixent ce contrat, dont l'état exact relevé
en usage réel.

#### Compteur et notification

Chaque continuation incrémente `autoContinueCount` et affiche un **toast dans la page**
(bas-droite, au-dessus de la pastille de contexte, 4 s) — pas une `chrome.notifications` : une
continuation est un événement de la conversation qu'on est en train de lire, pas une alerte
système. Le popup montre `3 / 10 continuations déclenchées`, avec « Réinitialiser » pour
remettre le compteur à zéro et « Pause » pour suspendre **sans toucher aux réglages**.

### Dossiers personnalisés

> ⚠️ **C'est la fonctionnalité la plus fragile du dépôt, et de loin.** Toutes les autres
> s'appuient sur une *donnée* (API d'usage, Statuspage) ou sur des *variables CSS* du design
> system. Celle-ci est la seule à manipuler la **structure DOM native** de claude.ai : elle
> déplace de vrais nœuds de la sidebar. Un remaniement de la sidebar la casse — d'où le tableau
> de sélecteurs ci-dessous, qui est le point de départ de toute réparation.

Range les conversations dans des dossiers de couleur, insérés **au-dessus** de « Récents », sans
aucun rapport avec les *Projects* natifs de claude.ai. Deux clés dédiées :

| Clé | Forme | Absente = |
| --- | --- | --- |
| `folders` | `[{ id, name, color, collapsed }, …]` | aucun dossier |
| `folderAssignments` | `{ "<uuid conversation>": "<id dossier>" }` | tout dans « Récents » |

Une conversation non assignée **n'est pas touchée** : elle reste dans « Récents », à sa place.

#### Tableau des sélecteurs

À vérifier dans cet ordre le jour où les dossiers cessent de fonctionner. Ils sont tous en tête
de [`folders.js`](folders.js), en constantes `CF_*`.

| Sélecteur | Rôle | Fragilité |
| --- | --- | --- |
| `a[href^="/chat/"]` | **ancrage principal** — l'uuid se lit dans le `href`, il n'existe aucun data-attribute dédié | **faible** : c'est une URL, pas une classe |
| `.df-drag-shiftable` | wrapper déplaçable, atteint par `link.closest(…)` | moyenne : classe applicative, mais pas utilitaire |
| `.dframe-nav-scroll` | conteneur scrollable ; **absent = arrêt complet** | moyenne |
| `.dframe-recents-by-mode` | wrapper des sections, point d'insertion | moyenne ; absent, on se rabat sur `.dframe-nav-scroll` avec un `console.warn` |
| `aside.dframe-sidebar` | coque observée par le `MutationObserver` | faible : c'est la coque, elle survit aux re-rendus |

Deux sélecteurs de la structure inspectée sont **délibérément inutilisés** :
`div.group.relative[class*="rounded-"]` (le conteneur d'item) parce que sa classe est un rayon
Tailwind arbitraire — `rounded-[var(--df-radius-pill)]` — et `div.group\/section` (la section)
parce qu'une classe Tailwind échappée est exactement le genre d'ancrage qui casse. La section
est **déduite du DOM** à la place : c'est le parent d'un item qui n'est dans aucun de nos blocs.

#### Déplacer, jamais dupliquer

Les items rangés dans un dossier sont les **vrais nœuds** de claude.ai, déplacés. Un clone
perdrait les gestionnaires de clic et le menu contextuel natifs attachés par le site — c'est le
compromis central de cette fonctionnalité, et la raison de sa fragilité.

Quand un item part dans un dossier, un **marque-page** (`<div hidden data-cf-slot="<uuid>">`)
reste à sa place exacte. L'en sortir le remet donc à sa position chronologique, et pas
bêtement à la fin de « Récents ». Un re-rendu du site détruit les marque-pages avec le reste,
ce qui est sans conséquence : après un re-rendu, les items non assignés sont déjà au bon endroit.

⚠️ **L'ordre des opérations dans `cfReflow()` n'est pas cosmétique.** Les blocs dont le dossier
a été supprimé sont retirés **après** la boucle de placement, jamais avant : à l'entrée de la
passe ils contiennent encore leurs items, et les supprimer d'abord arracherait ces
conversations du document jusqu'au prochain re-rendu du site. Le test *suppression du dossier :
conversations libérées, AUCUNE perdue* verrouille ce point précis.

#### Re-rendus et pagination

La sidebar est une SPA : elle se re-rend à chaque navigation. Le rangement est donc réappliqué
par un `MutationObserver` (débounce 120 ms) posé sur `aside.dframe-sidebar` — la coque, qui
survit aux re-rendus — et **pas** un scan unique au chargement. Tant que la coque n'existe pas,
on se rabat sur `documentElement`, puis on **resserre** dès qu'elle apparaît : sans ça on
observerait tout le document en permanence, flux d'une réponse en cours compris.

Le `takeRecords()` en fin de passe jette les mutations que le rangement vient lui-même de
provoquer — sans lui, chaque rendu en déclencherait un autre, indéfiniment.

Conséquence utile : une conversation plus ancienne qui **apparaît au scroll** (pagination) est
rangée sans rechargement. La liste n'est pas virtualisée pour le nombre d'items actuellement
observé (testé jusqu'à 21), mais le code ne le suppose nulle part.

#### Interactions

- **Glisser-déposer** natif du navigateur, aucune bibliothèque. Un `<a href>` est déjà
  *draggable*, donc on ne pose pas `draggable="true"` : on ajoute seulement notre type de
  donnée au `dragstart`, sans `preventDefault`, ce qui laisse le système de glissement du site
  (`df-drag-shiftable`) recevoir ce qu'il attend quand le dépôt ne nous concerne pas. Déposer
  sur un dossier assigne ; pour désassigner, une bande **« Retirer du dossier »** apparaît dans
  notre bloc pendant le glissement d'une conversation rangée. Voir
  [Dépôt : ne jamais toucher aux zones natives](#dépôt--ne-jamais-toucher-aux-zones-natives).
- **« + »** en haut de la liste : `prompt` pour le nom, couleur attribuée automatiquement — la
  première non utilisée de la palette de 8, pour que deux dossiers créés à la suite se
  distinguent sans seconde question.
- **Clic droit sur un dossier** : renommer, changer de couleur (8 pastilles), supprimer.
  Supprimer **libère** ses conversations vers « Récents » et ne supprime **jamais** une
  conversation — l'extension n'en a aucun moyen, et ne doit jamais en avoir. La confirmation le
  dit explicitement, parce que c'est la question qu'on se pose devant un « Supprimer ».
- **Clic sur l'en-tête** : replier / déplier. Le compteur affiche le nombre de conversations
  *assignées*, qui peut dépasser le nombre visible si les plus anciennes ne sont pas chargées.

#### Dépôt : ne jamais toucher aux zones natives

> Corrigé après un bug vu en usage réel : déposer une conversation sur un dossier custom
> l'**épinglait** dans la section native « Épinglé » au lieu de l'assigner.

Les gestionnaires appelaient pourtant déjà `preventDefault()` et `stopPropagation()` — ce
n'était donc pas la cause. Deux défauts réels, **chacun suffisant** à reproduire le symptôme :

| Défaut | Pourquoi ça épinglait | Correction |
| --- | --- | --- |
| Le glissement était identifié par `dataTransfer.types` | Le site pose son propre `dragstart` et une implémentation de drag appelle couramment `clearData()` avant d'écrire **son** type, ce qui efface le nôtre. Notre `dragover` ne reconnaissait alors plus rien, n'appelait pas `preventDefault()`, et le dépôt n'était même pas **autorisé** sur nos blocs : le navigateur le renvoyait à la logique du site | `cfDragging`, posé au `dragstart`, fait foi ; `dataTransfer` ne sert plus qu'à *récupérer* l'uuid, en secours |
| Écoute en phase de **bouillonnement** | Si le site écoute en phase de **capture** sur un ancêtre, son gestionnaire s'exécute *avant* le nôtre — et nos blocs sont à l'intérieur de `.dframe-nav-scroll`. `stopPropagation()` arrivait trop tard | Interception sur **`window` en capture** : le tout premier point de la trajectoire d'un événement, avant tout gestionnaire posé sur un descendant, quel que soit son ordre d'inscription |

Conséquence volontaire : **plus aucun gestionnaire n'est posé sur un élément natif.** On n'agit
que si la cible est dans notre sous-arbre *et* qu'un glissement de conversation est en cours.
Partout ailleurs l'événement passe intact, donc la réorganisation et l'épinglage natifs
fonctionnent exactement comme avant.

C'est aussi pourquoi **désassigner ne se fait plus en déposant sur « Récents »** : poser un
gestionnaire sur une section du site était précisément ce qui pouvait déclencher son épinglage.
La bande « Retirer du dossier » est à nous, dans notre bloc, et n'apparaît que pendant le
glissement d'une conversation déjà rangée.

**Repli pointeur.** `df-drag-shiftable` (« les items s'écartent ») suggère un glissement au
*pointeur* et non en HTML5 — auquel cas aucun `dragstart`/`dragover`/`drop` n'est émis et tout
ce qui précède reste muet. Un repli sur `pointerdown`/`pointermove`/`pointerup` prend alors le
relais, armé **uniquement** si aucun `dragstart` n'a été vu pour le geste en cours : les deux
voies ne peuvent pas se déclencher ensemble, et c'est le navigateur qui tranche, pas nous. Après
un dépôt capté au pointeur, un `keydown` Échap est envoyé au document — le site vient d'être
privé de son `pointerup`, et Échap est la sortie conventionnelle des bibliothèques de drag pour
annuler proprement un glissement en cours.

#### Tests

Toute la logique de rangement — parsing d'uuid, création, assignation, suppression — est dans
[`folders-source.js`](folders-source.js), **pure** et testée par `node test-folders.js`.
`folders.js` ne garde que le DOM. La séparation est délibérée : la partie qui cassera un jour ne
doit pas entraîner avec elle la partie vérifiable.

Le placement DOM lui-même a son propre harnais, [`test-folders-dom.js`](test-folders-dom.js),
qui monte la structure du tableau ci-dessus dans jsdom et couvre les deux scénarios invisibles
autrement : le re-rendu de la SPA et la conversation qui arrive au scroll. C'est le **seul**
test du dépôt à avoir besoin d'une dépendance : sans `npm install jsdom` il **se saute** au lieu
d'échouer, pour que le dépôt reste chargeable tel quel, sans `package.json` ni `node_modules`.

Le dépôt y est couvert par un **espion** qui rejoue le gestionnaire du site : posé sur un
ancêtre de nos blocs, dans les **deux** phases. Les tests vérifient qu'il n'est jamais appelé
quand on dépose sur un dossier, et qu'il l'est bel et bien — liste d'appels exacte à l'appui —
quand on dépose ailleurs. Son silence est donc une garantie, pas un faux négatif.

⚠️ Une limite de jsdom à connaître : il **n'applique pas** la règle du navigateur selon laquelle
un `drop` n'est émis que si le `dragover` correspondant a été neutralisé. Les tests vérifient
donc *qui reçoit quoi*, pas l'arbitrage du navigateur. En vrai, le premier défaut du tableau
ci-dessus a une conséquence de plus : le `drop` n'atteint jamais nos zones.

Il ne remplace pas une vérification à la main sur claude.ai : il prouve la logique de placement,
pas que les sélecteurs correspondent encore au vrai site — ça, seul le navigateur le dit.

### Export de conversation

Un bouton d'export à côté de « Partager », dans l'en-tête de conversation, avec deux sorties :
**Markdown** et **PDF**. claude.ai n'expose aucun export natif — vérifié dans le menu « … » de
la sidebar, celui du titre de conversation, et la modale de partage — donc rien n'est doublé.

Aucune clé de storage : cette fonctionnalité ne stocke rien.

#### Le contenu vient de l'API, pas du DOM

C'est **la** décision de conception de ce module. Le GET
`…/organizations/<org>/chat_conversations/<uuid>` est la seule réponse qui porte tout
l'historique — le même endpoint que celui déjà intercepté pour l'estimation de contexte
(voir l'en-tête de [`inject.js`](inject.js)), donc **confirmé par capture**.

Scraper le DOM aurait obligé à dérouler toute la conversation avant d'exporter, et un export
tronqué ne se voit pas : le fichier a l'air complet. Ici, **ou l'export est complet, ou il
échoue en le disant**. Il n'y a pas de repli DOM, délibérément — un repli silencieusement
tronqué serait pire que pas d'export du tout.

⚠️ **L'uuid d'organisation n'est pas deviné.** `ORGS_PATH` étant la seule supposition non
vérifiée du dépôt, en dépendre couplerait l'export au sondage d'usage et le ferait reposer sur
un pari. Il est donc relevé dans les URL que la page a **réellement** appelées
(`performance.getEntriesByType('resource')`), en deux niveaux :

1. l'URL **exacte** que le site a utilisée pour cette conversation, query string comprise — on
   hérite de ses paramètres sans avoir à les connaître ;
2. à défaut, reconstruite à partir de n'importe quelle URL portant l'organisation (le site en
   appelle en permanence, donc elle se trouve même si le GET de conversation est sorti du
   tampon de Resource Timing, limité à 250 entrées).

Si aucun des deux n'aboutit, l'export refuse de partir et demande de recharger l'onglet.

| Sélecteur | Rôle |
| --- | --- |
| `button[data-testid="wiggle-controls-actions-share"]` | **ancrage principal** : voisin de placement **et** modèle de style |
| `div#dframe-header-actions-slot` | conteneur de **repli**, si « Partager » est absent |
| `div[data-testid="chat-header"]` | observé par le `MutationObserver` ; sert aussi à cadrer la recherche |

⚠️ **L'ancrage part du bouton « Partager », pas du slot** — et pas l'inverse, contrairement à la
première version. Le slot avait été pris pour « le » point d'insertion stable, mais il est
**absent d'au moins un contexte** (conversation de Projet) : l'export s'y désactivait avec un
`[export] point d'insertion … introuvable` alors que « Partager » était bien là. `exAnchor()`
cherche donc « Partager » du plus proche au plus large — slot, puis en-tête, puis document — et
place le bouton dans *son* parent, quel qu'il soit. La détection ne dépend plus de la coque
d'en-tête, **sans qu'aucun sélecteur de conteneur n'ait été deviné par contexte** : c'est la même
paire confirmée, essayée dans un autre ordre. Le repli sur le slot n'est utilisé que si
« Partager » est introuvable ; si les deux manquent, l'export se désactive proprement — c'est le
seul cas restant, et il reste signalé.

Le bouton **ne s'invente pas de style** : il copie la `className` du bouton « Partager » et la
taille de son `<svg>`, donc rayon, états de survol et thème suivent le site sans qu'on ait à
les connaître (même procédé que `folders.js` pour les classes de section). Sans bouton
« Partager », il se rabat sur un style neutre et le signale en console. Il n'est posé que sur
une conversation ouverte, et reposé après chaque re-rendu de l'en-tête.

#### Markdown

Le texte des messages est repris **verbatim** : les réponses de Claude *sont* du markdown,
blocs de code et langages compris — les réécrire ne pourrait que les abîmer. Seul le titre est
assaini, parce qu'il devient une ligne `#` qu'un retour à la ligne casserait. Les blocs qui ne
sont pas du texte (`tool_use`, `tool_result`, `thinking`) sont écartés : un export doit se lire
comme la conversation, pas comme sa trace d'exécution.

#### PDF : `window.print()`, aucune bibliothèque

Pas de jsPDF ni d'équivalent. On imprime un document autonome et Chrome propose *Enregistrer au
format PDF*. L'impression passe par une **iframe hors écran** plutôt que par une fenêtre : pas
de bloqueur de pop-up à affronter, et surtout `print()` n'imprime alors *que* ce document, pas
la page claude.ai autour.

Le markdown est rendu en HTML par un convertisseur volontairement **partiel** (blocs de code
avec leur langage, titres, listes, citations, liens, gras/italique) — ce qui n'est pas reconnu
ressort en paragraphe, jamais perdu. C'est le compromis assumé pour ne pas embarquer un
analyseur markdown complet derrière un bouton d'impression.

L'échappement HTML passe **toujours** avant le formatage : une conversation contenant
`<script>` ne doit jamais redevenir une balise dans le document imprimé, et un lien
`javascript:` n'est jamais rendu cliquable. Deux tests couvrent précisément ces deux cas.

#### Nom de fichier

`<titre> - AAAA-MM-JJ.md` (ou `.pdf`), avec un nettoyage visant l'union des interdits Windows,
macOS et Linux : `<>:"/\|?*`, les caractères de contrôle, les points ou espaces finaux — que
l'explorateur Windows tronque en silence — et les noms de périphériques DOS (`CON`, `NUL`,
`COM1`…), que Windows refuse même suivis d'une extension. Titre vide ou entièrement filtré :
repli sur `conversation`.

#### Tests

`node test-export.js` couvre la logique pure (32 tests) : génération du Markdown, échappement,
rendu des blocs de code, nom de fichier, lecture de la réponse d'API.
[`test-export-dom.js`](test-export-dom.js) vérifie l'insertion du bouton dans l'en-tête (8 tests)
et **se saute** sans jsdom, comme `test-folders-dom.js`. Trois de ses tests portent sur la
détection du contexte : en-tête sans slot d'actions, en-tête non reconnu, et aucun ancrage du
tout — les deux premiers échouent bien si l'on remet la condition « slot obligatoire ».

## Debug

**L'usage se diagnostique depuis la console du service worker** (`chrome://extensions` →
*service worker*). Messages possibles, du plus fréquent au plus rare :

| Message | Ce que ça veut dire |
| --- | --- |
| `HTTP 404` sur la requête d'organisations | `ORGS_PATH` est faux — voir la section dédiée en haut |
| `format de réponse inconnu … JSON reçu :` | un cas non couvert par `parseUsage()` — l'ajouter, avec un test dans `test-usage-source.js` |
| `fetch direct échoue (HTTP 403) : repli sur un onglet claude.ai` | normal, le repli prend la main |
| `aucun onglet claude.ai ouvert` | l'API refuse le SW et il n'y a pas de relais disponible |
| `aucun onglet claude.ai ne répond` | l'onglet est antérieur au chargement de l'extension → le recharger |
| `[status] sondage échoue :` | status.claude.com est injoignable — le popup masque simplement la section |
| `[status] format de réponse inconnu … JSON reçu :` | Statuspage a changé de forme — corriger `parseStatus()`, avec un test dans `test-status-source.js` |
| `[autocontinue] sondage échoue :` | la boucle du worker n'a pas pu lire le storage ou lister les onglets |

Les dossiers, eux, parlent dans la console **de la page** claude.ai, une seule fois par cause
pour ne pas noyer la console à chaque re-rendu :

| Message | Ce que ça veut dire |
| --- | --- |
| `[folders] conteneur « .dframe-nav-scroll » introuvable après 8 s` | la sidebar a changé — rien n'a été inséré, voir le tableau des sélecteurs |
| `[folders] wrapper « .dframe-recents-by-mode » introuvable` | dégradé, pas bloquant : les dossiers sont insérés directement dans le conteneur scrollable |
| `[folders] aucun « .df-drag-shiftable » au-dessus du lien` | le lien est trouvé mais plus le wrapper déplaçable : plus rien n'est rangé |
| `[export] aucun point d'ancrage dans l'en-tête : ni « …-share » ni « …-actions-slot »` | ni le bouton « Partager » ni le slot de repli — aucun bouton inséré. Le message dit si l'en-tête `chat-header` était présent : **présent** = sa structure interne a changé, **absent** = ce contexte n'a pas d'en-tête de conversation reconnu |
| `[export] bouton « …-share » introuvable` | dégradé, pas bloquant : le bouton prend un style neutre au lieu de copier celui du site |
| `[export] format de réponse inconnu … JSON reçu :` | la réponse de conversation a changé de forme — corriger `parseConversation()`, avec un test dans `test-export.js` |
| `[export] échec : …` | l'export s'est arrêté avant d'écrire quoi que ce soit ; la même phrase s'affiche en toast dans la page |

#### Pourquoi l'auto-continue ne clique pas

Deux consoles, deux moitiés de la réponse. **Commencer par celle du service worker** : c'est la
seule qui parle quand la fonctionnalité est éteinte — dans ce cas rien d'autre ne tourne, ni le
sondage ni le `MutationObserver` de la page.

| Console du service worker | Ce que ça veut dire |
| --- | --- |
| `boucle arrêtée : auto-continue DÉSACTIVÉ (autoContinueEnabled absent ou false)` | la case du popup n'est pas cochée — **rien** ne tourne tant que cette clé n'est pas à `true` |
| `boucle arrêtée : en pause` | bouton « Pause » du popup |
| `boucle arrêtée : compteur maximum atteint : 5 / 5` | « Réinitialiser », ou passer le maximum à 0 (illimité) |
| `actif, mais aucun onglet claude.ai ouvert` | la boucle tourne, il n'y a personne à sonder |
| `actif — sondage de N onglet(s) toutes les 5 s` | tout va bien de ce côté : passer à la console de l'onglet |
| `onglet 42 : pas de content script (recharger l'onglet)` | onglet ouvert avant le chargement de l'extension |

Une fois la boucle active, le détail est dans la console **de l'onglet**. Elle ne parle que
lorsqu'un bouton « Continue » est visible — ou qu'un bouton au bon libellé vient d'être écarté —
et ne répète jamais un état identique :

```
[autocontinue] diagnostic (sw)
  bouton « Continue »  : trouvé
  messages assistant   : 12 lus
  dernier message lu   : sélecteur .group\/message-row, index 11/11 — ancré au bouton Continue (fiable)
  phrase de limite     : ABSENTE du dernier message
  phrase plus haut     : non
  compteur             : 0 / illimité
  actif / en pause     : true / false
  DÉCISION             : ignore — pas de phrase de limite dans le dernier message
  dernier message (500 premiers caractères), pour relever la phrase réelle :
    "Claude a atteint la limite d’utilisation d’outils pour cette réponse."
```

Les lignes qui tranchent :

- **`bouton « Continue » : ÉCARTÉ — n au bon libellé mais jugé invisible`** — le bouton existe
  mais `offsetParent` est nul. C'est le test de visibilité qu'il faut alors revoir, pas la
  détection de phrase.
- **`dernier message lu : … — ancré au bouton Continue (fiable)`** confirme que le texte capturé
  vient bien de la ligne qui contient le bouton visible, pas d'un élément assistant-like plus bas
  dans le document (carte de citation, aperçu d'historique…) qui aurait usurpé la position
  « dernier » simplement en arrivant en dernier dans `querySelectorAll()`. Si la ligne dit à la
  place **`dernier trouvé dans l'ordre du DOM (bouton non imbriqué — hypothèse à vérifier)`**,
  l'ancrage a échoué et le texte lu n'est pas garanti correspondre au bon message — à vérifier à
  l'œil avant de conclure quoi que ce soit sur la phrase de limite.
- **`phrase de limite : ABSENTE du dernier message`** suivi du message recopié — c'est le cas
  attendu sur une **interface en français**, dont aucune variante n'est connue (voir « Limites
  connues »). Le message recopié est là précisément pour relever la formulation réelle et
  l'ajouter à `AC_LIMIT_PHRASES`, avec un test dans `test-autocontinue.js`. C'est la seule
  façon correcte de la compléter : relevée, jamais devinée.

Chaque continuation écrit par ailleurs `[autocontinue] continuation 3 (page|sw)`, avec l'origine
du déclencheur.
Pour savoir pourquoi *rien* ne se passe, appeler `acTick('manuel')` dans cette même console,
**après avoir basculé le sélecteur de contexte** de *top* vers celui de l'extension (les
content scripts vivent dans un monde isolé) : la fonction renvoie toujours sa raison en clair (`aucun bouton Continue visible`,
`phrase de limite déjà présente plus haut dans la conversation`, `compteur maximum atteint (10)`,
`pas de content script (recharger l'onglet)`…).

`inject.js` a un `var DEBUG = false;` en tête — le passer à `true` fait sortir `[usage] tap
start` / `tap end` dans la console de **la page claude.ai**. Ça ne concerne plus que
l'estimation de contexte.

> **Après avoir rechargé l'extension, recharger aussi l'onglet claude.ai.** Sinon les content
> scripts de l'onglet sont orphelins et le relais de secours ne répond plus (le service
> worker le signale explicitement).

Pour tester les états dégradés sans attendre une vraie limite, depuis la console du service
worker (`chrome://extensions` → *service worker*) :

```js
chrome.storage.local.set({ usage: { updatedAt: Date.now(), data: { windows: {
  '5h': { status: 'over_limit',        utilization: 0.97, resets_at: Math.floor(Date.now()/1000) + 3600 },
  '7d': { status: 'approaching_limit', utilization: 0.80, resets_at: Math.floor(Date.now()/1000) + 200000 }
} } } });
```

Même méthode pour la section « Statut », qui est le plus souvent verte :

```js
chrome.storage.local.set({ status: { updatedAt: Date.now(), data: {
  level: 'outage',
  incident: { name: 'Elevated errors across many models', impact: 'major' },
  components: [
    { name: 'claude.ai',   level: 'outage',   status: 'partial_outage' },
    { name: 'Claude Code', level: 'degraded', status: 'degraded_performance' }
  ]
} } });
```

## Limites connues

- **Web/Service Workers = angle mort.** Un content script ne s'exécute pas dans les workers ;
  tout `fetch` émis depuis un worker par claude.ai serait invisible. Aucune parade.
- **Le canal `postMessage` n'est pas privé.** La page peut lire ces messages, et toute autre
  extension à content script MAIN sur claude.ai aussi.
- **Les endpoints internes de claude.ai ne sont pas stables.** Si le format d'usage change, il
  n'y a que `usage-source.js` à corriger (et `test-usage-source.js` à mettre à jour). Pour
  l'estimation de contexte, ce sont les regex d'URL en tête de `inject.js`. L'API Statuspage,
  elle, est une API publique documentée : c'est la plus stable des trois.
- **Le statut est vieux de 5 min au pire.** Le début d'un incident n'apparaît donc pas
  instantanément ; le lien vers status.claude.com est là pour ça.
- **`ORGS_PATH` n'est pas encore vérifié** — voir la section dédiée en haut.
- **`severity` → `over_limit` est une extrapolation.** Seules `"warning"` et `"normal"` ont
  été observées ; à corriger dans `statusFromSeverity()` si claude.ai utilise un autre mot
  pour signaler une limite atteinte.
- **Un compte multi-organisations prend la première** retournée par l'API, qui n'est pas
  forcément l'active. À affiner dans `pickOrgId()` si le cas se présente.
- Le sondage tourne à **1/minute**, plancher de `chrome.alarms` : une consommation faite en
  quelques secondes n'apparaît qu'au sondage suivant. Le popup affiche l'âge de la valeur.
- **Le thème ne s'applique qu'aux onglets ayant un content script** : un onglet claude.ai
  ouvert avant l'installation ou le rechargement de l'extension ne réagit qu'une fois
  rechargé. Même limite que le relais de secours du sondage.
- **À `document_start` les valeurs d'origine ne sont pas encore lisibles** : seule la couleur
  d'accent s'applique immédiatement. Poids, coins/ombres et police arrivent quelques centaines
  de millisecondes plus tard, quand les feuilles du site sont parsées.
- **L'auto-continue repose sur ce que claude.ai *affiche*, pas sur une API.** Trois points de
  rupture, tous dans `autocontinue.js` : le repérage des messages de l'assistant — le conteneur
  `.group/message-row` (liste **virtualisée** : un scan ponctuel ne voit que ce qui est monté),
  filtré au rôle assistant par la présence de `[data-testid="action-bar-retry"]` ou
  `[data-testid="action-bar-read-aloud"]` dans sa barre d'actions (`action-bar-edit` marque au
  contraire un message utilisateur ; `action-bar-copy` existe sur les deux rôles et n'est
  **jamais** utilisé comme critère) — la reconnaissance du bouton par son libellé (`Continue`,
  qui couvre au passage `Continuer`) — et la lecture du texte lui-même, qui doit ignorer toute
  copie masquée pour l'accessibilité (`[aria-hidden="true"]`, `.sr-only`, `visually-hidden`…),
  sans quoi le même passage se retrouve doublé. Un remaniement du balisage les casse en silence —
  la détection ne se déclenchera simplement plus.
- **Le « dernier message » s'ancre au bouton *Continue*, pas à l'ordre du DOM.**
  `querySelectorAll('.group/message-row')` rend ses résultats dans l'ordre du document, qui ne
  correspond pas forcément à l'ordre visuel de la conversation : un élément assistant-like
  ailleurs sur la page (carte de citation, aperçu…) placé *après* le vrai dernier message dans le
  DOM usurperait sinon la position « dernier ». `acLastAssistantRow()` retrouve donc la ligne qui
  contient réellement le bouton visible via `.closest()`, et ne se replie sur le dernier élément
  du tableau que si le bouton n'est imbriqué dans aucune ligne connue — repli non vérifié sur le
  vrai balisage, signalé comme tel dans le journal de diagnostic (`dernier message lu`).
- **Les six phrases de limite ne sont connues qu'en anglais.** Sur une interface claude.ai en
  français, la condition (2) échouera : aucune variante française n'a été capturée, et ce dépôt
  ne code pas de valeur devinée. À relever sur un vrai message, puis à ajouter dans
  `AC_LIMIT_PHRASES` avec un test dans `test-autocontinue.js`.
- **`document.execCommand('insertText')` est volontairement absent.** La référence
  [claude-autocontinue](https://github.com/timothy22000/claude-autocontinue) s'en sert pour
  *écrire* dans l'éditeur (son mode « minimize tokens ») : c'est la seule méthode fiable pour
  déclencher les événements synthétiques React/ProseMirror de l'input de claude.ai — un
  `value = …` suivi d'un `dispatchEvent` ne suffit pas, React ne voit rien. C'est aussi une API
  **dépréciée**, qui casserait si Anthropic changeait l'implémentation de l'éditeur, au même
  titre que les autres pièges consignés ici. Cette extension ne tape donc **rien** : elle se
  limite au clic sur le bouton, qui ne dépend pas de l'éditeur. Si un mode « prompt de
  continuation » est ajouté un jour, il faudra passer par `execCommand` et hériter de cette
  fragilité.
- **Un onglet ouvert avant l'installation n'a pas d'auto-continue** : ni `MutationObserver`, ni
  `acTick()` à réveiller par `executeScript`. Même limite que le relais de secours du sondage et
  que le thème — recharger l'onglet.
- **La boucle de 5 s maintient le service worker éveillé** tant qu'un onglet claude.ai est
  ouvert *et* que l'auto-continue est actif, non en pause et sous son maximum. C'est le prix
  d'une cadence sous le plancher d'une minute de `chrome.alarms` ; désactivé, rien n'est
  maintenu en vie.
- **Le compteur peut sous-compter avec plusieurs onglets.** `autoContinueCount` est incrémenté
  par un lire-modifier-écrire côté page : deux onglets qui continuent à la même milliseconde
  peuvent perdre une unité. Sans conséquence sur la limite elle-même, qui reste évaluée à
  chaque tick.
- **Les dossiers déplacent des nœuds que React gère.** C'est le risque assumé de la
  fonctionnalité : si le site supprime un item (conversation effacée) pendant qu'il se trouve
  dans un de nos blocs, son `removeChild` porte sur un nœud qui n'est plus chez lui et peut
  lever. Rien ne le prévient depuis une extension — c'est le prix du choix « déplacer plutôt que
  dupliquer », qui est ce qui préserve les clics et menus contextuels natifs. En cas de sidebar
  cassée, vider `folders` et `folderAssignments` remet tout d'aplomb.
- **Un léger scintillement au changement de conversation est normal** : le site re-rend sa
  liste, remet brièvement les items rangés dans « Récents », et le `MutationObserver` les
  redéplace 120 ms plus tard.
- **Le compteur d'un dossier peut dépasser le nombre visible** : il compte les conversations
  *assignées*, dont certaines ne sont pas encore chargées dans le DOM (pagination au scroll).
- **L'implémentation de glissement de claude.ai n'a pas été identifiée** (HTML5 ou pointeur).
  Les deux voies sont couvertes et s'excluent mutuellement, mais si un jour une conversation se
  retrouvait **à la fois** rangée dans un dossier *et* épinglée nativement, ce serait le signe
  que les deux systèmes se déclenchent ensemble. Le remède serait alors d'ajouter, après notre
  dépôt, un retrait explicite de la zone d'épinglage — et non d'élargir l'interception, qui
  casserait le drag natif ailleurs. Rien de tel n'a été observé.
- **La forme de la réponse de conversation n'a jamais été capturée.** L'*endpoint* l'est (c'est
  celui de l'estimation de contexte), mais pas la structure de son JSON :
  `parseConversation()` accepte les deux conventions plausibles (`chat_messages`/`messages`,
  `sender`/`role`, `text`/`content[]`) plutôt que d'en parier une seule, et le dit en console
  si aucune ne correspond. C'est le premier endroit à corriger si l'export échoue alors que le
  bouton s'affiche.
- **Le PDF dépend d'une iframe `srcdoc`, qui hérite de la CSP de claude.ai.** Aucun script n'y
  est injecté (`print()` est appelé de l'extérieur), mais si la politique du site interdisait
  un jour les styles en ligne, le PDF sortirait sans mise en forme — le texte, lui, resterait
  complet. L'export Markdown, qui ne dépend d'aucune CSP, reste la sortie la plus sûre.
- **Le rendu markdown → HTML du PDF est partiel** : ni tableaux, ni notes de bas de page, ni
  HTML brut inline. Ce qui n'est pas reconnu ressort en paragraphe — jamais perdu, mais pas
  mis en forme. Le fichier `.md`, lui, est le contenu exact.
- **Les noms de tokens du design system ne sont pas garantis stables.** Si un jour l'accent ne
  change plus, c'est `--cds-clay-emphasized` / `--cds-clay` qu'il faut re-confirmer en
  inspectant le bouton d'envoi ; il n'y a que `theme.js` à corriger. Pour les trois autres
  réglages, le `console.warn` nomme directement la variable en cause.
