// Popup : rend le dernier sondage d'usage stocke sous la cle "usage", une projection du
// moment ou la fenetre 5h atteindrait 100 %, le statut de status.claude.com (cle "status",
// source independante), le reglage des notifications de seuil et la personnalisation du theme
// de claude.ai (cles "accentColor", "fontWeightPreset", "radiusPreset" et "fontFamily",
// appliquees par theme.js), plus les reglages de l'auto-continue (cles "autoContinue*",
// appliquees par autocontinue.js et autocontinue-bg.js).
// Ne lit que "windows" ; c'est la seule partie de la reponse d'usage que parseUsage()
// normalise (voir usage-source.js).
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

// ---- statut ------------------------------------------------------------------

// On reutilise la palette de common.js pour rester coherent avec les jauges, mais PAS
// colorFor() : il attend un objet fenetre d'usage, l'appeler ici obligerait a fabriquer un faux
// { utilization } — exactement le couplage que la separation des sources evite.
var LEVEL_COLOR = {
  operational: USAGE_GREEN,
  degraded: USAGE_ORANGE,
  outage: USAGE_RED
};

var LEVEL_LABEL = {
  operational: 'Tous les systèmes opérationnels',
  degraded: 'Service dégradé',
  outage: 'Panne en cours'
};

var COMPONENT_LABEL = {
  operational: 'opérationnel',
  degraded_performance: 'performances dégradées',
  partial_outage: 'panne partielle',
  major_outage: 'panne majeure',
  under_maintenance: 'maintenance'
};

function dot(level) {
  var d = node('span', 'dot');
  d.style.background = LEVEL_COLOR[level] || USAGE_GREY;
  return d;
}

// Section entierement masquee quand la cle "status" manque (premier lancement, sondage echoue) :
// une section vide serait moins claire qu'une section absente.
function renderStatus(stored) {
  var data = stored && stored.data;
  if (!data || !data.level) return;

  var head = document.getElementById('statusHead');
  head.appendChild(dot(data.level));
  head.appendChild(node('span', null, LEVEL_LABEL[data.level] || data.level));

  // Tout nominal : on s'arrete a la ligne compacte, inutile d'etaler six composants verts.
  if (data.level !== 'operational') {
    if (data.incident && data.incident.name) {
      var inc = document.getElementById('statusIncident');
      inc.textContent = data.incident.name;   // dit POURQUOI c'est degrade
      inc.hidden = false;
    }

    var list = document.getElementById('statusList');
    (data.components || []).forEach(function (c) {
      if (c.level === 'operational') return;
      var row = node('div', 'comp');
      row.appendChild(dot(c.level));
      // Un statut que Statuspage viendrait d'inventer est montre brut plutot que masque.
      row.appendChild(node('span', null,
        c.name + ' — ' + (COMPONENT_LABEL[c.status] || c.status || c.level)));
      list.appendChild(row);
    });
  }

  document.getElementById('status').hidden = false;
}

// ---- reglages ----------------------------------------------------------------

function renderSettings(settings) {
  var box = document.getElementById('notif');
  box.checked = !!(settings && settings.notifications);
  box.addEventListener('change', function () {
    chrome.storage.local.set({ settings: { notifications: box.checked } });
  });
}

// ---- auto-continue -----------------------------------------------------------

// Fonctionnalite a part : quatre cles dediees (voir AC_KEYS dans autocontinue-source.js), ni
// dans l'objet "settings" — reserve aux notifications — ni dans les cles de theme. Le popup ne
// fait qu'ECRIRE : autocontinue.js cote page et autocontinue-bg.js cote worker reagissent via
// storage.onChanged, il n'y a donc rien a envoyer aux onglets.
function countText(s) {
  var head = s.count + (s.maxCount ? ' / ' + s.maxCount : '');
  var body = head + (s.count > 1 ? ' continuations déclenchées' : ' continuation déclenchée');
  return acMaxReached(s) ? body + ' — maximum atteint' : body;
}

function renderAutoContinue(stored) {
  var enabled = document.getElementById('acEnabled');
  var max = document.getElementById('acMax');
  var count = document.getElementById('acCount');
  var pause = document.getElementById('acPause');

  var s = acSettings(stored);

  function paint() {
    enabled.checked = s.enabled;
    count.textContent = countText(s);
    pause.textContent = s.paused ? 'Reprendre' : 'Pause';
    // La pause ne veut rien dire tant que la fonctionnalite est eteinte.
    pause.disabled = !s.enabled;
  }

  max.value = String(s.maxCount);
  paint();

  // A l'activation, on ecrit les QUATRE cles, pas seulement l'interrupteur. Ca ne change aucun
  // comportement — acSettings() traite deja une cle absente exactement comme sa valeur par
  // defaut — mais ca rend le storage lisible a la main : en inspectant chrome.storage.local on
  // voit l'etat complet, au lieu d'avoir a savoir ce que vaut une cle manquante.
  enabled.addEventListener('change', function () {
    s.enabled = enabled.checked;

    var patch = { autoContinueEnabled: s.enabled };
    if (s.enabled) {
      patch.autoContinueCount = s.count;
      patch.autoContinueMaxCount = s.maxCount;
      patch.autoContinuePaused = s.paused;
    }
    chrome.storage.local.set(patch);
    paint();
  });

  // "input" ET "change" : le popup peut etre ferme sans que le champ perde le focus, et
  // "change" ne partirait alors jamais. On borne la valeur ecrite des la frappe, mais on ne
  // reecrit le champ qu'a la validation — sinon taper "1000" le tronquerait sous les doigts.
  max.addEventListener('input', function () {
    var v = Math.floor(Number(max.value));
    s.maxCount = (isFinite(v) && v > 0) ? Math.min(v, AC_MAX_LIMIT) : 0;
    chrome.storage.local.set({ autoContinueMaxCount: s.maxCount });
    paint();
  });
  max.addEventListener('change', function () { max.value = String(s.maxCount); });

  pause.addEventListener('click', function () {
    s.paused = !s.paused;
    chrome.storage.local.set({ autoContinuePaused: s.paused });
    paint();
  });

  document.getElementById('acReset').addEventListener('click', function () {
    s.count = 0;
    chrome.storage.local.set({ autoContinueCount: 0 });
    paint();
  });
}

// ---- personnalisation --------------------------------------------------------

// Couleur d'accent par defaut de claude.ai (--cds-clay-emphasized). Sert de valeur affichee
// quand rien n'est stocke, et de retour apres reinitialisation.
var DEFAULT_ACCENT = '#c6613f';

// Ordre des crans des deux curseurs : l'index 1 est le prereglage neutre, qui n'injecte rien
// cote theme.js.
var WEIGHT_PRESETS = ['thin', 'normal', 'bold'];
var RADIUS_PRESETS = ['square', 'normal', 'round'];
var NEUTRAL_INDEX = 1;

var THEME_KEYS = ['accentColor', 'fontWeightPreset', 'radiusPreset', 'fontFamily'];

// Une valeur absente ou inconnue retombe sur le cran neutre.
function presetIndex(list, value) {
  var i = list.indexOf(value);
  return i === -1 ? NEUTRAL_INDEX : i;
}

// On n'ecrit que les quatre cles ci-dessus : c'est theme.js, cote page, qui reagit via
// storage.onChanged et repeint tous les onglets claude.ai ouverts. Le popup n'a donc rien a
// envoyer aux onglets, et l'extension n'a besoin ni de "tabs" ni de "scripting".
function renderTheme(stored) {
  var accent = document.getElementById('accent');
  var weight = document.getElementById('fontWeight');
  var radius = document.getElementById('radiusPreset');
  var family = document.getElementById('fontFamily');

  accent.value = (typeof stored.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(stored.accentColor))
    ? stored.accentColor
    : DEFAULT_ACCENT;
  weight.value = String(presetIndex(WEIGHT_PRESETS, stored.fontWeightPreset));
  radius.value = String(presetIndex(RADIUS_PRESETS, stored.radiusPreset));
  family.value = ['sans', 'serif', 'mono'].indexOf(stored.fontFamily) === -1 ? '' : stored.fontFamily;

  // "input" : les controles natifs emettent en continu pendant le glissement, ce qui donne un
  // apercu live. chrome.storage.local n'a pas de quota d'ecriture horaire.
  // "change" en filet : le selecteur de couleur s'ouvre dans une fenetre separee et le popup
  // peut perdre le focus ; si les "input" du glissement se perdent, la validation ecrit quand meme.
  function bind(el, save) {
    el.addEventListener('input', save);
    el.addEventListener('change', save);
  }

  bind(accent, function () { chrome.storage.local.set({ accentColor: accent.value }); });
  bind(weight, function () {
    chrome.storage.local.set({ fontWeightPreset: WEIGHT_PRESETS[Number(weight.value)] });
  });
  bind(radius, function () {
    chrome.storage.local.set({ radiusPreset: RADIUS_PRESETS[Number(radius.value)] });
  });
  // "Defaut" (valeur vide) supprime la cle : c'est le seul moyen de revenir a la police
  // d'origine sans passer par "Reinitialiser".
  bind(family, function () {
    if (family.value) chrome.storage.local.set({ fontFamily: family.value });
    else chrome.storage.local.remove('fontFamily');
  });

  document.getElementById('themeReset').addEventListener('click', function () {
    accent.value = DEFAULT_ACCENT;
    weight.value = String(NEUTRAL_INDEX);
    radius.value = String(NEUTRAL_INDEX);
    family.value = '';
    // Un seul remove pour les quatre cles : theme.js n'en fait qu'un rendu, et l'element
    // <style> disparait au lieu d'etre vide.
    chrome.storage.local.remove(THEME_KEYS);
  });
}

// ---- rendu -------------------------------------------------------------------

chrome.storage.local.get(['usage', 'usageHistory', 'settings', 'status']
  .concat(THEME_KEYS).concat(AC_KEYS)).then(function (o) {
  renderSettings(o.settings);
  renderAutoContinue(o);
  renderTheme(o);
  // Avant le garde sur "windows" : sinon le statut disparaitrait precisement quand l'usage est
  // indisponible, c'est-a-dire pendant une panne.
  renderStatus(o.status);

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
