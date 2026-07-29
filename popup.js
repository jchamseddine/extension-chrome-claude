// Popup : rend le dernier sondage d'usage stocke sous la cle "usage", une projection du
// moment ou la fenetre 5h atteindrait 100 %, et le reglage des notifications de seuil.
// Ne lit que "windows" ; parseUsage() recopie aussi representativeClaim et resolved quand
// l'API les fournit, ils restent donc disponibles pour un usage futur.
'use strict';

var WINDOWS = [
  { key: '5h', withDay: false },
  { key: '7d', withDay: true }
];

var STATUS_LABEL = {
  approaching_limit: 'proche de la limite',
  over_limit: 'limite atteinte'
};

var FIT_WINDOW_MS = 30 * 60 * 1000;   // on ne regarde que les 30 dernieres minutes
var HORIZON_MS = 5 * 60 * 60 * 1000;  // repli quand resets_at manque : duree de la fenetre
var MIN_POINTS = 3;

function node(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function agoText(ms) {
  var min = Math.round(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return 'il y a ' + min + ' min';
  var h = Math.round(min / 60);
  if (h < 24) return 'il y a ' + h + ' h';
  return 'il y a ' + Math.round(h / 24) + ' j';
}

// ---- fenetres ----------------------------------------------------------------

function block(spec, w) {
  var u = utilOf(w);
  var color = colorFor(w);

  var box = node('div', 'win');

  var head = node('div', 'head');
  head.appendChild(node('span', 'label', USAGE_LABELS[spec.key]));
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

// ---- projection --------------------------------------------------------------

// Regression lineaire des moindres carres, faite a la main (aucune dependance) sur les
// points (t, utilization_5h) des 30 dernieres minutes. On cherche la droite u = a·t + b
// qui minimise la somme des carres des ecarts verticaux :
//
//   a = Σ(t − t̄)(u − ū) / Σ(t − t̄)²        (t̄ et ū = moyennes)
//
// puis on resout u = 1 sur cette droite. En passant par les moyennes, l'ordonnee a
// l'origine n'a pas besoin d'etre calculee :
//
//   u = ū + a·(t − t̄)  =>  t(u=1) = t̄ + (1 − ū) / a
//
// C'est volontairement basique : ca suppose un rythme de consommation constant, ce qui est
// faux des qu'on fait une pause. D'ou le garde-fou d'horizon a l'affichage.
function project(history, w5) {
  var now = Date.now();
  var pts = (history || []).filter(function (p) {
    return p && typeof p.t === 'number' && typeof p.u5 === 'number'
        && now - p.t <= FIT_WINDOW_MS;
  });

  if (pts.length < MIN_POINTS) return { enough: false, at: null };

  var n = pts.length;
  var mt = 0, mu = 0;
  pts.forEach(function (p) { mt += p.t; mu += p.u5; });
  mt /= n;
  mu /= n;

  var num = 0, den = 0;
  pts.forEach(function (p) {
    num += (p.t - mt) * (p.u5 - mu);
    den += (p.t - mt) * (p.t - mt);
  });

  // den = 0 : tous les points au meme instant. num <= 0 : usage stable ou en baisse,
  // il n'y a alors aucune limite a projeter.
  if (den === 0 || num <= 0) return { enough: true, at: null };

  // Une echeance posterieure au reset de la fenetre ne veut rien dire : le compteur repart
  // de zero avant, la limite ne sera jamais atteinte. resets_at est en SECONDES Unix ;
  // horizon fixe en repli quand il manque.
  var reset = (w5 && typeof w5.resets_at === 'number' && isFinite(w5.resets_at))
    ? w5.resets_at * 1000
    : 0;
  var horizon = reset > now ? reset : now + HORIZON_MS;

  var at = mt + (1 - mu) / (num / den);
  if (!isFinite(at) || at < now || at > horizon) return { enough: true, at: null };
  return { enough: true, at: at };
}

function renderProjection(history, w5) {
  var el = document.getElementById('projection');
  var p = project(history, w5);

  if (!p.enough) {
    el.textContent = "Pas assez de données pour estimer le rythme (il faut 3 minutes de sondage).";
    el.hidden = false;
    return;
  }
  if (p.at === null) return;   // rythme nul ou limite trop lointaine : rien a annoncer

  var time = new Date(p.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  el.textContent = 'À ce rythme, tu atteindras ta limite de session vers ' + time + '.';
  el.className = 'rule hot';
  el.hidden = false;
}

// ---- reglages ----------------------------------------------------------------

function renderSettings(settings) {
  var box = document.getElementById('notif');
  box.checked = !!(settings && settings.notifications);
  box.addEventListener('change', function () {
    chrome.storage.local.set({ settings: { notifications: box.checked } });
  });
}

// ---- rendu -------------------------------------------------------------------

chrome.storage.local.get(['usage', 'usageHistory', 'settings']).then(function (o) {
  renderSettings(o.settings);

  var usage = o.usage;
  var windows = (usage && usage.data && usage.data.windows) || null;
  if (!(windows && (windows['5h'] || windows['7d']))) {
    document.getElementById('empty').hidden = false;
    return;
  }

  var host = document.getElementById('windows');
  WINDOWS.forEach(function (spec) {
    host.appendChild(block(spec, windows[spec.key]));
  });
  host.hidden = false;

  renderProjection(o.usageHistory, windows['5h']);

  var footer = document.getElementById('footer');
  footer.textContent = 'Mis à jour ' + agoText(Date.now() - usage.updatedAt);
  footer.hidden = false;
}, function (e) {
  document.getElementById('empty').textContent = 'Erreur de lecture : ' + e;
  document.getElementById('empty').hidden = false;
});
