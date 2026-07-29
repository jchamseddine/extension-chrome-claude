// Seul point d'adaptation a l'API d'usage de claude.ai. Le reste de l'extension ne depend
// que de la SORTIE de ce fichier (un objet a la forme historique de "message_limit" du flux
// SSE : { windows: { '5h', '7d' }, ... }, utilization en FRACTION 0-1), jamais de la forme
// reelle de la reponse : si claude.ai change de format, il n'y a que ce fichier a corriger.
//
// Charge par importScripts() depuis le service worker.
'use strict';

// GET /api/organizations/<org>/usage, CONFIRME par capture reseau le 2026-07-29. Exemple de
// reponse reelle :
//   {
//     "five_hour": { "utilization": 76, "resets_at": "2026-07-29T10:49:59.074167+00:00" },
//     "seven_day": { "utilization": 43, "resets_at": "2026-08-01T10:59:59.074190+00:00" },
//     "limits": [
//       { "kind": "session",     "group": "session", "percent": 76, "severity": "warning",
//         "resets_at": "...", "scope": null, "is_active": true },
//       { "kind": "weekly_all",  "group": "weekly",  "percent": 43, "severity": "normal",
//         "resets_at": "...", "scope": null, "is_active": false },
//       { "kind": "weekly_scoped", ... "scope": { "model": {...} }, ... }
//     ],
//     "extra_usage": { "is_enabled": false, "utilization": 0, ... },
//     "spend": { "percent": 0, "enabled": false, ... }
//   }
// "utilization" et "percent" sont des ENTIERS 0-100, pas des fractions 0-1 comme l'etait
// l'ancien "windows.utilization" du flux SSE — parseUsage() divise par 100 une seule fois.
var USAGE_PATH = '/api/organizations/{org}/usage';

// A COMPLETER — n'a jamais ete capture (seul USAGE_PATH l'a ete). Suppose, par analogie avec
// USAGE_PATH, une liste d'organisations sous ce chemin. Si le sondage echoue des la
// resolution de l'org (avant meme d'atteindre USAGE_PATH), c'est ce chemin qu'il faut
// verifier en premier dans l'onglet Network.
var ORGS_PATH = '/api/organizations';

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

// common.js attend des SECONDES Unix. resets_at arrive en ISO 8601 (avec microsecondes,
// Date.parse les tronque sans erreur) ; les millisecondes sont gerees par prudence, au cas
// ou une reponse future les renverrait telles quelles.
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

// "warning"/"normal" sont les deux seules valeurs observees dans nos captures (percent 76 et
// 43, aucune limite atteinte). "over_limit" n'a donc JAMAIS ete vu cote severity : ce mapping
// est extrapole par analogie avec l'ancien "status" du flux SSE, a corriger si claude.ai
// utilise un autre mot pour une limite depassee. Une severite inconnue ou "normal" ne fixe
// pas de status : colorFor() derive alors la couleur du pourcentage seul, ce qui reste correct
// pour le cas nominal.
function statusFromSeverity(sev) {
  if (sev === 'warning') return 'approaching_limit';
  if (sev === 'critical' || sev === 'error' || sev === 'exceeded') return 'over_limit';
  return undefined;
}

function windowFromLimit(entry) {
  if (!entry || typeof entry.percent !== 'number' || !isFinite(entry.percent)) return null;

  var w = { utilization: entry.percent / 100 };
  var status = statusFromSeverity(entry.severity);
  if (status) w.status = status;

  var sec = toEpochSeconds(entry.resets_at);
  if (sec !== null) w.resets_at = sec;
  return w;
}

// Repli quand "limits" manque, est vide, ou ne porte pas l'entree cherchee : five_hour /
// seven_day n'ont pas de "severity", seulement utilization + resets_at.
function windowFromRoot(root) {
  if (!root || typeof root.utilization !== 'number' || !isFinite(root.utilization)) return null;

  var w = { utilization: root.utilization / 100 };
  var sec = toEpochSeconds(root.resets_at);
  if (sec !== null) w.resets_at = sec;
  return w;
}

function pickLimit(limits, kind) {
  if (!Array.isArray(limits)) return null;
  for (var i = 0; i < limits.length; i++) {
    if (limits[i] && limits[i].kind === kind) return limits[i];
  }
  return null;
}

// Transforme la reponse brute en objet a la forme historique de "message_limit" :
//   { windows: { '5h': {utilization, status?, resets_at?}, '7d': {...} } }
//
// "limits[]" est prioritaire car il porte deja severity/is_active en plus du pourcentage ;
// kind:"session" -> '5h', kind:"weekly_all" -> '7d'. "weekly_scoped" (usage par modele) est
// ignore : ce n'est pas la limite globale qu'on affiche. En repli — limits absent, vide, ou
// sans l'entree cherchee — on retombe sur five_hour / seven_day a la racine.
function parseUsage(json) {
  if (!json || typeof json !== 'object') return null;

  var limits = json.limits;
  var w5 = windowFromLimit(pickLimit(limits, 'session')) || windowFromRoot(json.five_hour);
  var w7 = windowFromLimit(pickLimit(limits, 'weekly_all')) || windowFromRoot(json.seven_day);

  if (!w5 && !w7) {
    console.warn('[usage] format de reponse inconnu : adapter parseUsage() dans ' +
                 'usage-source.js. JSON recu :', json);
    return null;
  }

  var out = { windows: {} };
  if (w5) out.windows['5h'] = w5;
  if (w7) out.windows['7d'] = w7;

  // extra_usage / spend portent les credits payants (equivalent de l'ancien overageInUse du
  // flux SSE, jamais observe non plus). Pas dans le perimetre de ce correctif : a cabler dans
  // evaluate() de background.js si ce point redevient utile.

  return out;
}
