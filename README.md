# Claude Usage

Extension Chrome personnelle (Manifest V3, JS vanilla, aucun build step). Elle affiche :

1. l'usage **session (5 h)** et **hebdomadaire (7 j)** de claude.ai — icône à deux anneaux,
   badge, popup ;
2. une **estimation** de la taille du contexte de la conversation ouverte, en pastille sur
   la page.

Rien ne sort de la machine : tout est dans `chrome.storage.local`, aucun serveur.

## Installation

1. `chrome://extensions` → activer le **mode développeur**
2. **Charger l'extension non empaquetée** → sélectionner ce dossier
3. Ouvrir `https://claude.ai` et envoyer un message

Chrome 111+ requis (`"world": "MAIN"` en content script statique).

Après avoir rechargé l'extension, **toujours recharger l'onglet claude.ai** — sinon le patch
injecté survit mais ne peut plus écrire.

## D'où viennent les données

Aucun appel réseau n'est émis par l'extension. Elle observe uniquement les réponses que
claude.ai reçoit déjà, sur deux URL :

| URL (pathname) | Ce qu'on en tire |
| --- | --- |
| `…/chat_conversations/<uuid>/completion` (SSE) | l'événement `message_limit`, et la longueur du texte streamé |
| `…/chat_conversations/<uuid>` (GET JSON) | la longueur de l'historique complet |

L'événement `message_limit` du flux SSE a cette forme :

```json
{
  "type": "message_limit",
  "message_limit": {
    "representativeClaim": "five_hour",
    "windows": {
      "5h": { "status": "within_limit", "resets_at": 1785260400, "utilization": 0.32 },
      "7d": { "status": "within_limit", "resets_at": 1785582000, "utilization": 0.29 }
    },
    "resolved": { "...": "..." }
  }
}
```

`utilization` est une fraction 0-1 ; `windows.*.resets_at` est un timestamp Unix en
**secondes** (alors que `resolved.limit.resets_at` est une chaîne ISO 8601). `status` peut
valoir autre chose que `within_limit` (`approaching_limit`, `over_limit`, …) : le popup
affiche alors une puce, et l'icône passe au rouge / orange quel que soit le pourcentage.

L'objet est stocké **entier**, donc `representativeClaim` et `resolved` restent disponibles
même si le popup ne rend que `windows`.

## Architecture

| Fichier | Monde | Rôle |
| --- | --- | --- |
| `inject.js` | MAIN | patch de `fetch` et de l'History API, tap SSE, extraction de `message_limit` + comptage de caractères |
| `content.js` | isolé | écrit la clé `usage` à chaque `message_limit` reçu |
| `context-estimator.js` | isolé | tient l'estimation de contexte par conversation et affiche la pastille sur `/chat/*` |
| `background.js` | service worker | dessine l'icône et le badge sur `chrome.storage.onChanged` |
| `common.js` | SW + popup | seuils de couleur partagés (`utilOf`, `colorFor`) |
| `popup.html` / `popup.js` | popup | les deux fenêtres, leur reset et leur statut |

Clés `chrome.storage.local` :

- `usage` = `{ data: <message_limit>, updatedAt }` — clé unique, écrasée à chaque écriture
- `ctx:<uuid>` = `{ chars, tokens, updatedAt }` — une clé par conversation, LRU 20
- `usageHistory` = `[{ t, u5, u7 }, …]` — historique roulant, 50 points max
- `notifyState` = `{ windows: { '5h': { threshold, overLimit }, … }, overage }` — anti-spam
- `settings` = `{ notifications: false }` — réglages du popup

Pas de `chrome.alarms` : tout est piloté par l'événement SSE, il n'y a rien à interroger.

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

> `overageInUse` n'a **jamais été observé** dans nos captures. Il est lu à deux emplacements
> plausibles (`data.overageInUse` et `data.resolved.overageInUse`) et simplement ignoré s'il
> n'existe pas. À corriger dans `evaluate()` de `background.js` si le champ se révèle ailleurs.

L'icône de la notification est encodée en PNG data-URL depuis le même `OffscreenCanvas` que
l'icône de toolbar — `chrome.notifications` exige un `iconUrl`, et c'est ce qui permet de ne
livrer aucun binaire dans le dépôt.

### Estimation du temps avant la limite

Chaque événement `message_limit` ajoute un point `{ t, u5, u7 }` à `usageHistory` (50 max,
les plus anciens sont jetés). Le popup ajuste une **régression linéaire des moindres carrés**
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
de 5 h sert de repli. En dessous de 3 points, le popup affiche « pas assez de données »
plutôt qu'un ajustement bancal.

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

`inject.js` commence par `var DEBUG = false;`. Le passer à `true` trace dans la console de
la page chaque `message_limit`, chaque snapshot et la fin de chaque flux.

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
- **Les endpoints internes de claude.ai ne sont pas stables.** Si le format change, les deux
  points à corriger sont les regex d'URL en tête de `inject.js` et la lecture de
  `data.windows` dans `background.js` / `popup.js`.
- L'usage n'est mis à jour qu'**à la fin d'un message envoyé** : c'est la seule occasion où
  claude.ai transmet `message_limit`. Le popup affiche l'âge de la valeur.
