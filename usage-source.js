// Seul point d'adaptation a l'API d'usage de claude.ai. Le reste de l'extension ne depend
// que de la SORTIE de ce fichier (un objet a la forme historique de "message_limit"), jamais
// de la forme reelle de la reponse : si claude.ai change d'URL ou de format, il n'y a que ce
// fichier a corriger.
//
// Charge par importScripts() depuis le service worker.
'use strict';

// =============================================================================
// A COMPLETER — les deux constantes ci-dessous n'ont PAS ete verifiees
// =============================================================================
// La capture reseau de https://claude.ai/new#settings/usage n'a jamais ete fournie. Ces
// valeurs sont des SUPPOSITIONS, extrapolees du seul chemin interne connu avec certitude :
// /api/organizations/<org>/chat_conversations/<uuid>/completion (cf. inject.js).
//
// Pour les corriger : ouvrir https://claude.ai/new#settings/usage, onglet Network, filtre
// Fetch/XHR, recharger la page. Reperer la requete qui porte les pourcentages, puis :
//   1. USAGE_PATH   <- son pathname. '{org}' marque l'emplacement de l'uuid d'organisation ;
//                      le retirer si l'URL n'en contient pas (ORGS_PATH devient alors inutile).
//   2. parseUsage() <- adapter la lecture au JSON reel (voir le commentaire de la fonction).
//
// Tant que ce n'est pas fait, le sondage echoue bruyamment dans la console du service worker
// (chrome://extensions -> "service worker") : soit un "HTTP 404" qui dit que USAGE_PATH est
// faux, soit un "format de reponse inconnu" qui affiche le JSON recu et dit que seul
// parseUsage() reste a ecrire.
var USAGE_PATH = '/api/organizations/{org}/usage';
var ORGS_PATH = '/api/organizations';
// =============================================================================

var CLAUDE_ORIGIN = 'https://claude.ai';

function usageNeedsOrg() {
  return USAGE_PATH.indexOf('{org}') !== -1;
}

function usageUrl(orgId) {
  return CLAUDE_ORIGIN + USAGE_PATH.replace('{org}', orgId || '');
}

function orgsUrl() {
  return CLAUDE_ORIGIN + ORGS_PATH;
}

// Premier uuid d'organisation trouve. Un compte multi-organisations prendrait la premiere,
// qui n'est pas forcement l'active — a affiner seulement si le cas se presente.
function pickOrgId(json) {
  var list = Array.isArray(json) ? json
           : (json && Array.isArray(json.organizations)) ? json.organizations
           : null;
  if (!list) return null;

  for (var i = 0; i < list.length; i++) {
    var id = list[i] && (list[i].uuid || list[i].id);
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

// ---- normalisation -----------------------------------------------------------

// common.js attend des SECONDES Unix. Les deux autres formes deja croisees chez claude.ai
// sont l'ISO 8601 (resolved.limit.resets_at) et les millisecondes.
function toEpochSeconds(v) {
  if (typeof v === 'number' && isFinite(v)) {
    return v > 1e11 ? Math.round(v / 1000) : v;   // > an 5138 en secondes => c'est des ms
  }
  if (typeof v === 'string') {
    var ms = Date.parse(v);
    if (!isNaN(ms)) return Math.round(ms / 1000);
  }
  return null;
}

// Un champ absent est omis plutot que mis a null : utilOf()/colorFor() rendent alors du gris,
// ce qui est exactement le comportement voulu quand le format bouge. Ne jette jamais.
function normalizeWindow(w) {
  if (!w || typeof w !== 'object') return null;

  var out = {};
  if (typeof w.utilization === 'number' && isFinite(w.utilization)) out.utilization = w.utilization;
  if (typeof w.status === 'string') out.status = w.status;

  var sec = toEpochSeconds(w.resets_at);
  if (sec !== null) out.resets_at = sec;

  // Une fenetre sans aucun champ exploitable ne vaut pas mieux qu'une fenetre absente.
  if (out.utilization === undefined && out.status === undefined) return null;
  return out;
}

// Transforme la reponse brute en objet a la forme de "message_limit" :
//   { windows: { '5h': {utilization, status, resets_at}, '7d': {...} }, ... }
//
// Deux formes sont reconnues, toutes deux basees sur la seule qu'on ait reellement observee
// (l'evenement SSE message_limit) : la reponse porte "windows" a sa racine, ou sous une cle
// "message_limit". Si l'endpoint de la page reglages renvoie autre chose, c'est ICI qu'il
// faut mapper ses champs vers '5h' / '7d' — le JSON recu est loggue pour ca.
function parseUsage(json) {
  if (!json || typeof json !== 'object') return null;

  var src = json.windows ? json
          : (json.message_limit && json.message_limit.windows) ? json.message_limit
          : null;

  if (!src) {
    console.warn('[usage] format de reponse inconnu : adapter parseUsage() dans ' +
                 'usage-source.js. JSON recu :', json);
    return null;
  }

  var windows = src.windows || {};
  var w5 = normalizeWindow(windows['5h']);
  var w7 = normalizeWindow(windows['7d']);
  if (!w5 && !w7) {
    console.warn('[usage] reponse sans fenetre "5h" ni "7d" exploitable :', windows);
    return null;
  }

  var out = { windows: {} };
  if (w5) out.windows['5h'] = w5;
  if (w7) out.windows['7d'] = w7;

  // Champs optionnels recopies tels quels : evaluate() de background.js lit overageInUse aux
  // deux emplacements plausibles, et l'objet entier reste disponible pour un usage futur.
  if (src.overageInUse != null) out.overageInUse = src.overageInUse;
  if (src.resolved) out.resolved = src.resolved;
  if (src.representativeClaim) out.representativeClaim = src.representativeClaim;

  return out;
}
