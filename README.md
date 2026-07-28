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
| `inject.js` | MAIN | patch de `fetch`, tap SSE, extraction de `message_limit` + comptage de caractères |
| `content.js` | isolé | écrit la clé `usage` à chaque `message_limit` reçu |
| `context-estimator.js` | isolé | tient l'estimation de contexte et affiche la pastille sur `/chat/*` |
| `background.js` | service worker | dessine l'icône et le badge sur `chrome.storage.onChanged` |
| `common.js` | SW + popup | seuils de couleur partagés (`utilOf`, `colorFor`) |
| `popup.html` / `popup.js` | popup | les deux fenêtres, leur reset et leur statut |

Deux clés `chrome.storage.local`, chacune écrasée à chaque écriture :

- `usage` = `{ data: <message_limit>, updatedAt }`
- `context` = `{ uuid, chars, updatedAt }` (dernière conversation seulement)

Pas de `chrome.alarms` : tout est piloté par l'événement SSE, il n'y a rien à interroger.

### Icône

Deux anneaux concentriques dessinés dans un `OffscreenCanvas` : **extérieur = 7 j**,
**intérieur = 5 h**, chacun coloré par sa propre fenêtre (vert < 50 %, jaune < 75 %,
orange < 90 %, rouge au-delà ; gris si la donnée manque). Le badge texte porte le % de la
fenêtre 5 h. Aucun PNG n'est livré : le service worker dessine l'icône dès `onInstalled` et
`onStartup`.

### Estimation de contexte

**C'est une estimation, pas une mesure.** Le POST vers `/completion` ne contient que le
nouveau message — l'historique reste côté serveur. La base vient donc du GET de la
conversation, à laquelle on ajoute à chaud les caractères envoyés puis ceux de la réponse
streamée ; le total est divisé par 4 pour approcher un nombre de tokens. Un rechargement de
page resynchronise sur la valeur réelle.

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
