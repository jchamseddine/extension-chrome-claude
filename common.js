// Partage entre le service worker (importScripts) et le popup (<script>). Les seuils de
// couleur doivent rester identiques des deux cotes : la barre du popup et l'anneau de
// l'icone representent la meme fenetre, une divergence serait un bug visible. Idem pour le
// formatage de l'heure de reset, affichee a la fois dans le popup et dans les notifications.
//
// Le format des reponses de claude.ai n'est pas garanti stable : une fenetre absente ou une
// utilization non numerique doit donner du gris, jamais une exception.
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

// ---- heure de reset ---------------------------------------------------------

// "dans 3 h 12"
function untilText(ms) {
  if (ms <= 0) return '';
  var min = Math.round(ms / 60000);
  if (min < 60) return ' (dans ' + min + ' min)';
  var h = Math.floor(min / 60);
  var m = min % 60;
  if (h < 24) return ' (dans ' + h + ' h' + (m ? ' ' + String(m).padStart(2, '0') : '') + ')';
  return ' (dans ' + Math.round(h / 24) + ' j)';
}

// windows.*.resets_at est toujours en SECONDES Unix : la reponse d'usage arrive en ISO 8601,
// mais toEpochSeconds() (usage-source.js) fait la conversion avant l'ecriture en storage.
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
