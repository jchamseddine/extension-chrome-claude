// Shared between the service worker (importScripts) and the popup (<script>). The color
// thresholds must stay identical on both sides: the popup bar and the icon ring
// represent the same window, a divergence would be a visible bug. Same for the
// formatting of the reset time, displayed both in the popup and in the notifications.
//
// The format of claude.ai responses is not guaranteed stable: a missing window or a
// non-numeric utilization must yield grey, never an exception.
'use strict';

var USAGE_LABELS = { '5h': 'Session — 5 h', '7d': 'Semaine — 7 j' };

var USAGE_GREY = 'rgba(128,128,128,0.45)';
var USAGE_GREEN = '#22c55e';
var USAGE_YELLOW = '#eab308';
var USAGE_ORANGE = '#f97316';
var USAGE_RED = '#ef4444';

function utilOf(w) {
  if (!w || typeof w.utilization !== 'number' || !isFinite(w.utilization)) return null;
  return Math.max(0, Math.min(1, w.utilization));
}

function colorFor(w) {
  var u = utilOf(w);
  if (u === null) return USAGE_GREY;
  if (w.status === 'over_limit') return USAGE_RED;
  if (w.status === 'approaching_limit') return u >= 0.9 ? USAGE_RED : USAGE_ORANGE;
  if (u < 0.5) return USAGE_GREEN;
  if (u < 0.75) return USAGE_YELLOW;
  if (u < 0.9) return USAGE_ORANGE;
  return USAGE_RED;
}

// ---- reset time -------------------------------------------------------------

// Sample output: "dans 3 h 12"
function untilText(ms) {
  if (ms <= 0) return '';
  var min = Math.round(ms / 60000);
  if (min < 60) return ' (dans ' + min + ' min)';
  var h = Math.floor(min / 60);
  var m = min % 60;
  if (h < 24) return ' (dans ' + h + ' h' + (m ? ' ' + String(m).padStart(2, '0') : '') + ')';
  return ' (dans ' + Math.round(h / 24) + ' j)';
}

// windows.*.resets_at is always in Unix SECONDS: the usage response arrives as ISO 8601,
// but toEpochSeconds() (usage-source.js) does the conversion before writing to storage.
function resetText(sec, withDay) {
  if (typeof sec !== 'number' || !isFinite(sec)) return '';
  var d = new Date(sec * 1000);
  var now = new Date();
  var time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  var sameDay = d.toDateString() === now.toDateString();
  var when = (withDay && !sameDay)
    ? d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) + ' à ' + time
    : 'à ' + time;
  return 'Réinitialisation ' + when + untilText(d - now);
}
