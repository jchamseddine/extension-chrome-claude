// Popup : rend la derniere valeur connue de message_limit stockee sous la cle "usage".
// Ne lit que "windows" ; l'objet est stocke entier, donc representativeClaim et resolved
// restent disponibles pour un usage futur.
'use strict';

var WINDOWS = [
  { key: '5h', label: 'Session — 5 h', withDay: false },
  { key: '7d', label: 'Semaine — 7 j', withDay: true }
];

var STATUS_LABEL = {
  approaching_limit: 'proche de la limite',
  over_limit: 'limite atteinte'
};

function node(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// "dans 3 h 12" — resets_at des fenetres est en secondes Unix, pas en millisecondes.
function untilText(ms) {
  if (ms <= 0) return '';
  var min = Math.round(ms / 60000);
  if (min < 60) return ' (dans ' + min + ' min)';
  var h = Math.floor(min / 60);
  var m = min % 60;
  if (h < 24) return ' (dans ' + h + ' h' + (m ? ' ' + String(m).padStart(2, '0') : '') + ')';
  return ' (dans ' + Math.round(h / 24) + ' j)';
}

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

function agoText(ms) {
  var min = Math.round(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return 'il y a ' + min + ' min';
  var h = Math.round(min / 60);
  if (h < 24) return 'il y a ' + h + ' h';
  return 'il y a ' + Math.round(h / 24) + ' j';
}

function block(spec, w) {
  var u = utilOf(w);
  var color = colorFor(w);

  var box = node('div', 'win');

  var head = node('div', 'head');
  head.appendChild(node('span', 'label', spec.label));
  head.appendChild(node('span', 'pct', u === null ? '—' : Math.round(u * 100) + ' %'));
  box.appendChild(head);

  var bar = node('div', 'bar');
  var fill = node('i');
  fill.style.width = (u === null ? 0 : u * 100) + '%';
  fill.style.background = color;
  bar.appendChild(fill);
  box.appendChild(bar);

  var reset = w ? resetText(w.resets_at, spec.withDay) : '';
  if (reset) box.appendChild(node('div', 'reset', reset));

  // Statut affiche seulement s'il sort du cas nominal ; une valeur inconnue est montree
  // telle quelle plutot que masquee.
  if (w && w.status && w.status !== 'within_limit') {
    var chip = node('span', 'status', STATUS_LABEL[w.status] || w.status);
    chip.style.background = color;
    box.appendChild(chip);
  }

  return box;
}

chrome.storage.local.get('usage').then(function (o) {
  var usage = o.usage;
  var windows = (usage && usage.data && usage.data.windows) || null;
  var known = windows && (windows['5h'] || windows['7d']);

  if (!known) {
    document.getElementById('empty').hidden = false;
    return;
  }

  var host = document.getElementById('windows');
  WINDOWS.forEach(function (spec) {
    host.appendChild(block(spec, windows[spec.key]));
  });
  host.hidden = false;

  var footer = document.getElementById('footer');
  footer.textContent = 'Mis à jour ' + agoText(Date.now() - usage.updatedAt);
  footer.hidden = false;
}, function (e) {
  document.getElementById('empty').textContent = 'Erreur de lecture : ' + e;
  document.getElementById('empty').hidden = false;
});
