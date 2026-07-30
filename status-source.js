// Seul point d'adaptation a la page de statut publique de Claude. Le reste de l'extension ne
// depend que de la SORTIE de ce fichier :
//   { level: 'operational'|'degraded'|'outage',
//     components: [ { name, level, status } ],   // status = valeur brute, pour la console
//     incident?: { name, impact? } }             // incident en cours, s'il y en a un
// "status.description" de Statuspage n'est pas repris : il est en anglais et redondant avec
// "level" ("Minor Service Outage" n'ajoute rien a 'degraded'). Le popup affiche son propre
// libelle francais.
// jamais de la forme reelle de la reponse : si Atlassian change de format, il n'y a que ce
// fichier a corriger. Aucun fetch, aucun chrome.* ici — background.js garde tout l'I/O.
//
// Totalement independant de usage-source.js et de theme.js : aucune donnee, aucune fonction
// partagee. Charge par importScripts() depuis le service worker.
'use strict';

// GET https://status.claude.com/api/v2/summary.json, CONFIRME par capture le 2026-07-30 (un
// incident etait actif). C'est du Statuspage (Atlassian). Exemple de reponse reelle :
//   {
//     "page": { "id": "tymt9n04zgry", "name": "Claude", ... },
//     "status": { "indicator": "minor", "description": "Minor Service Outage" },
//     "components": [
//       { "name": "claude.ai",                            "status": "partial_outage", "group": false, ... },
//       { "name": "Claude Console (platform.claude.com)",  "status": "operational",    ... },
//       { "name": "Claude API (api.anthropic.com)",        "status": "partial_outage", ... },
//       { "name": "Claude Code",                          "status": "partial_outage", ... },
//       { "name": "Claude Cowork",                        "status": "partial_outage", ... },
//       { "name": "Claude for Government",                "status": "operational",    ... }
//     ],
//     "incidents": [ { "name": "Elevated errors across many models", "status": "identified",
//                      "impact": "major", "resolved_at": null, "shortlink": "...", ... } ],
//     "scheduled_maintenances": []
//   }
//
// summary.json et pas status.json : une seule requete donne l'indicateur global, les composants
// ET les incidents. status.json ne porte que l'indicateur.
var STATUS_URL = 'https://status.claude.com/api/v2/summary.json';

// ---- normalisation -----------------------------------------------------------

// Ordre de gravite, pour retenir le pire etat vu.
var STATUS_RANK = { operational: 0, degraded: 1, outage: 2 };

function worstLevel(a, b) {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

// Un mot inconnu — ou un champ "status" absent — donne 'degraded' plutot que 'operational' :
// pour un afficheur de panne, une fausse alerte qui envoie voir status.claude.com est moins
// couteuse qu'un "tout va bien" affiche pendant une panne.
function levelFromComponent(status) {
  if (status === 'operational') return 'operational';
  if (status === 'partial_outage' || status === 'major_outage') return 'outage';
  return 'degraded';   // degraded_performance, under_maintenance, ou valeur inattendue
}

function levelFromIndicator(ind) {
  if (ind === 'none') return 'operational';
  if (ind === 'major' || ind === 'critical') return 'outage';
  return 'degraded';   // minor, maintenance, ou valeur inattendue
}

// Les 6 composants de la page portent tous "Claude" dans leur nom : ce filtre ne retire rien
// aujourd'hui, il ne sert qu'a ecarter un composant etranger si Atlassian en ajoute un. Les
// entrees de groupe (group:true) n'ont pas d'etat propre — aucune sur cette page, garde-fou.
function isClaudeComponent(c) {
  if (!c || c.group === true || typeof c.name !== 'string') return false;
  return c.name.toLowerCase().indexOf('claude') !== -1;
}

// Premier incident non resolu. summary.json ne liste en principe que ceux-la, mais le test sur
// resolved_at ne coute qu'une condition. On ne garde que le titre et l'impact : le corps des
// incident_updates est trop long pour un popup de 260 px, et le lien de la section suffit.
function pickIncident(list) {
  if (!Array.isArray(list)) return null;

  for (var i = 0; i < list.length; i++) {
    var inc = list[i];
    if (!inc || typeof inc.name !== 'string' || inc.resolved_at) continue;

    var out = { name: inc.name };
    if (typeof inc.impact === 'string') out.impact = inc.impact;
    return out;
  }
  return null;
}

// Le niveau global est le PIRE de (indicateur de page, composants retenus), jamais l'indicateur
// seul : la capture du 2026-07-30 annonce "minor" alors que 4 composants sont en partial_outage
// et que l'incident est d'impact "major". Suivre l'indicateur aveuglement sous-estimerait la
// panne.
function parseStatus(json) {
  if (!json || typeof json !== 'object') return null;

  var indicator = json.status && json.status.indicator;
  var components = [];

  if (Array.isArray(json.components)) {
    json.components.forEach(function (c) {
      if (!isClaudeComponent(c)) return;
      components.push({
        name: c.name,
        level: levelFromComponent(c.status),
        status: c.status
      });
    });
  }

  if (typeof indicator !== 'string' && !components.length) {
    console.warn('[status] format de reponse inconnu : adapter parseStatus() dans ' +
                 'status-source.js. JSON recu :', json);
    return null;
  }

  var level = 'operational';
  if (typeof indicator === 'string') level = worstLevel(level, levelFromIndicator(indicator));
  components.forEach(function (c) { level = worstLevel(level, c.level); });

  var out = { level: level, components: components };

  var incident = pickIncident(json.incidents);
  if (incident) out.incident = incident;

  return out;
}
