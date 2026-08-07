// The only adaptation point to Claude's public status page. The rest of the extension only
// depends on the OUTPUT of this file:
//   { level: 'operational'|'degraded'|'outage',
//     components: [ { name, level, status } ],   // status = raw value, for the console
//     incident?: { name, impact? } }             // ongoing incident, if there is one
// Statuspage's "status.description" is not carried over: it is in English and redundant with
// "level" ("Minor Service Outage" adds nothing to 'degraded'). The popup displays its own
// French label.
// never on the actual shape of the response: if Atlassian changes format, only this
// file needs fixing. No fetch, no chrome.* here — background.js keeps all the I/O.
//
// Completely independent of usage-source.js and theme.js: no shared data, no shared
// function. Loaded by importScripts() from the service worker.
'use strict';

// GET https://status.claude.com/api/v2/summary.json, CONFIRMED by capture on 2026-07-30 (an
// incident was active). This is Statuspage (Atlassian). Sample of a real response:
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
// summary.json and not status.json: a single request gives the overall indicator, the components
// AND the incidents. status.json only carries the indicator.
var STATUS_URL = 'https://status.claude.com/api/v2/summary.json';

// ---- normalization -----------------------------------------------------------

// Severity order, to keep the worst state seen.
var STATUS_RANK = { operational: 0, degraded: 1, outage: 2 };

function worstLevel(a, b) {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

// An unknown word — or a missing "status" field — yields 'degraded' rather than 'operational':
// for an outage display, a false alarm that sends you to status.claude.com is less
// costly than an "all is well" shown during an outage.
function levelFromComponent(status) {
  if (status === 'operational') return 'operational';
  if (status === 'partial_outage' || status === 'major_outage') return 'outage';
  return 'degraded';   // degraded_performance, under_maintenance, or unexpected value
}

function levelFromIndicator(ind) {
  if (ind === 'none') return 'operational';
  if (ind === 'major' || ind === 'critical') return 'outage';
  return 'degraded';   // minor, maintenance, or unexpected value
}

// The 6 components of the page all carry "Claude" in their name: this filter removes nothing
// today, it only serves to discard a foreign component if Atlassian adds one. Group
// entries (group:true) have no state of their own — none on this page, a guard.
function isClaudeComponent(c) {
  if (!c || c.group === true || typeof c.name !== 'string') return false;
  return c.name.toLowerCase().indexOf('claude') !== -1;
}

// First unresolved incident. In principle summary.json only lists those, but the test on
// resolved_at costs just one condition. We only keep the title and the impact: the body of the
// incident_updates is too long for a 260 px popup, and the section link is enough.
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

// The overall level is the WORST of (page indicator, retained components), never the indicator
// alone: the 2026-07-30 capture announces "minor" while 4 components are in partial_outage
// and the incident has "major" impact. Following the indicator blindly would understate the
// outage.
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
    console.warn('[status] unknown response format: adapt parseStatus() in ' +
                 'status-source.js. JSON received:', json);
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
