# Claude Usage

Extension Chrome personnelle (Manifest V3, JS vanilla, aucun build step). Elle affiche :

1. l'usage **session (5 h)** et **hebdomadaire (7 j)** de claude.ai — icône à deux anneaux,
   badge, popup ;
2. une **estimation** de la taille du contexte de la conversation ouverte, en pastille sur
   la page.

Rien ne sort de la machine, sauf vers claude.ai lui-même : tout est dans
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

| URL (pathname) | Ce qu'on en tire |
| --- | --- |
| `…/organizations/<org>/usage` | `utilization` (0-100) et `resets_at` des fenêtres 5 h et 7 j, `severity` par fenêtre |
| `…/chat_conversations/<uuid>/completion` (SSE) | la longueur du texte streamé |
| `…/chat_conversations/<uuid>` (GET JSON) | la longueur de l'historique complet |

Réponse réelle (capturée le 2026-07-29), simplifiée :

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

## Architecture

| Fichier | Monde | Rôle |
| --- | --- | --- |
| `inject.js` | MAIN | patch de `fetch` et de l'History API, tap SSE, comptage de caractères |
| `content.js` | isolé | relais de secours : refait le fetch d'usage same-origin quand le SW est refusé |
| `context-estimator.js` | isolé | tient l'estimation de contexte par conversation et affiche la pastille sur `/chat/*` |
| `background.js` | service worker | sonde l'API toutes les 60 s, écrit `usage`, dessine l'icône, notifie |
| `usage-source.js` | SW | **seul** point d'adaptation à l'API : URL + `parseUsage()` |
| `common.js` | SW + popup | seuils de couleur partagés (`utilOf`, `colorFor`) |
| `popup.html` / `popup.js` | popup | les deux fenêtres, leur reset et leur statut |

Clés `chrome.storage.local` :

- `usage` = `{ data, updatedAt }` — clé unique, réécrite **à chaque sondage** même si rien n'a bougé
- `orgId` = uuid d'organisation mis en cache, invalidé sur 401/403/404
- `ctx:<uuid>` = `{ chars, tokens, updatedAt }` — une clé par conversation, LRU 20
- `usageHistory` = `[{ t, u5, u7 }, …]` — historique roulant, 50 points max
- `notifyState` = `{ windows: { '5h': { threshold, overLimit }, … }, overage }` — anti-spam
- `settings` = `{ notifications: false }` — réglages du popup

### Sondage

Une alarme `usage-poll` à `periodInMinutes: 1` (le plancher de `chrome.alarms`), plus un
sondage immédiat sur `onStartup` et `onInstalled` pour ne pas attendre la première alarme.

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

### Notifications de seuil

**Désactivées par défaut** — la case à cocher est dans le popup, la préférence va dans
`settings.notifications`.

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

## Limites connues

- **Web/Service Workers = angle mort.** Un content script ne s'exécute pas dans les workers ;
  tout `fetch` émis depuis un worker par claude.ai serait invisible. Aucune parade.
- **Le canal `postMessage` n'est pas privé.** La page peut lire ces messages, et toute autre
  extension à content script MAIN sur claude.ai aussi.
- **Les endpoints internes de claude.ai ne sont pas stables.** Si le format d'usage change, il
  n'y a que `usage-source.js` à corriger (et `test-usage-source.js` à mettre à jour). Pour
  l'estimation de contexte, ce sont les regex d'URL en tête de `inject.js`.
- **`ORGS_PATH` n'est pas encore vérifié** — voir la section dédiée en haut.
- **`severity` → `over_limit` est une extrapolation.** Seules `"warning"` et `"normal"` ont
  été observées ; à corriger dans `statusFromSeverity()` si claude.ai utilise un autre mot
  pour signaler une limite atteinte.
- **Un compte multi-organisations prend la première** retournée par l'API, qui n'est pas
  forcément l'active. À affiner dans `pickOrgId()` si le cas se présente.
- Le sondage tourne à **1/minute**, plancher de `chrome.alarms` : une consommation faite en
  quelques secondes n'apparaît qu'au sondage suivant. Le popup affiche l'âge de la valeur.
