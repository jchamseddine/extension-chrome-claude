// Partage entre le service worker (importScripts) et le popup (<script>). Les seuils de
// couleur doivent rester identiques des deux cotes : la barre du popup et l'anneau de
// l'icone representent la meme fenetre, une divergence serait un bug visible.
//
// Le format des reponses de claude.ai n'est pas garanti stable : une fenetre absente ou une
// utilization non numerique doit donner du gris, jamais une exception.
'use strict';

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
