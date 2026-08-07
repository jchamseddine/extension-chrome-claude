// The only adaptation point to claude.ai's usage API. The rest of the extension only depends
// on the OUTPUT of this file (an object in the historical shape of "message_limit" from the
// SSE stream: { windows: { '5h', '7d' }, ... }, utilization as a 0-1 FRACTION), never on the
// actual shape of the response: if claude.ai changes format, only this file needs fixing.
//
// Loaded by importScripts() from the service worker.
'use strict';

// GET /api/organizations/<org>/usage, CONFIRMED by network capture on 2026-07-29. Sample of a
// real response:
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
// "utilization" and "percent" are 0-100 INTEGERS, not 0-1 fractions as the old
// "windows.utilization" of the SSE stream was — parseUsage() divides by 100 exactly once.
var USAGE_PATH = '/api/organizations/{org}/usage';

// TO BE COMPLETED — has never been captured (only USAGE_PATH has been). Assumed, by analogy with
// USAGE_PATH, to be a list of organizations under this path. If polling fails as early as the
// org resolution (before even reaching USAGE_PATH), this is the path to check
// first in the Network tab.
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

// First organization uuid found. A multi-organization account would take the first one,
// which is not necessarily the active one — to be refined only if the case comes up.
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

// ---- normalization -----------------------------------------------------------

// common.js expects Unix SECONDS. resets_at arrives as ISO 8601 (with microseconds,
// Date.parse truncates them without error); milliseconds are handled out of caution, in case
// a future response returned them as-is.
function toEpochSeconds(v) {
  if (typeof v === 'number' && isFinite(v)) {
    return v > 1e11 ? Math.round(v / 1000) : v;   // > year 5138 in seconds => these are ms
  }
  if (typeof v === 'string') {
    var ms = Date.parse(v);
    if (!isNaN(ms)) return Math.round(ms / 1000);
  }
  return null;
}

// "warning"/"normal" are the only two values observed in our captures (percent 76 and
// 43, no limit reached). "over_limit" has therefore NEVER been seen on the severity side: this mapping
// is extrapolated by analogy with the old "status" of the SSE stream, to be corrected if claude.ai
// uses another word for an exceeded limit. An unknown severity or "normal" does not set
// a status: colorFor() then derives the color from the percentage alone, which stays correct
// for the nominal case.
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

// Fallback when "limits" is missing, empty, or does not carry the sought entry: five_hour /
// seven_day have no "severity", only utilization + resets_at.
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

// Turns the raw response into an object in the historical shape of "message_limit":
//   { windows: { '5h': {utilization, status?, resets_at?}, '7d': {...} } }
//
// "limits[]" takes priority because it already carries severity/is_active on top of the percentage;
// kind:"session" -> '5h', kind:"weekly_all" -> '7d'. "weekly_scoped" (per-model usage) is
// ignored: it is not the overall limit we display. As a fallback — limits missing, empty, or
// without the sought entry — we fall back to five_hour / seven_day at the root.
function parseUsage(json) {
  if (!json || typeof json !== 'object') return null;

  var limits = json.limits;
  var w5 = windowFromLimit(pickLimit(limits, 'session')) || windowFromRoot(json.five_hour);
  var w7 = windowFromLimit(pickLimit(limits, 'weekly_all')) || windowFromRoot(json.seven_day);

  if (!w5 && !w7) {
    console.warn('[usage] unknown response format: adapt parseUsage() in ' +
                 'usage-source.js. JSON received:', json);
    return null;
  }

  var out = { windows: {} };
  if (w5) out.windows['5h'] = w5;
  if (w7) out.windows['7d'] = w7;

  // extra_usage / spend carry the paid credits (equivalent of the old overageInUse of the
  // SSE stream, never observed either). Not in the scope of this fix: to be wired into
  // evaluate() in background.js if this point becomes useful again.

  return out;
}
