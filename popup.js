// Popup: renders the last usage poll stored under the "usage" key, a projection of the
// moment the 5h window would reach 100 %, the status from status.claude.com ("status" key,
// an independent source), the threshold notification setting and the customization of claude.ai's
// theme ("accentColor", "fontWeightPreset", "radiusPreset" and "fontFamily" keys,
// applied by theme.js), plus the auto-continue settings ("autoContinue*" keys,
// applied by autocontinue.js and autocontinue-bg.js).
// Only reads "windows"; it is the only part of the usage response that parseUsage()
// normalizes (see usage-source.js).
'use strict';

var WINDOWS = [
  { key: '5h', withDay: false },
  { key: '7d', withDay: true }
];

var STATUS_LABEL = {
  approaching_limit: 'proche de la limite',
  over_limit: 'limite atteinte'
};

var FIT_WINDOW_MS = 30 * 60 * 1000;   // we only look at the last 30 minutes
var HORIZON_MS = 5 * 60 * 60 * 1000;  // fallback when resets_at is missing: window duration
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

// ---- windows -----------------------------------------------------------------

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

  // Status displayed only when it departs from the nominal case; an unknown value is shown
  // as-is rather than hidden.
  if (w && w.status && w.status !== 'within_limit') {
    var chip = node('span', 'status', STATUS_LABEL[w.status] || w.status);
    chip.style.background = color;
    box.appendChild(chip);
  }

  return box;
}

// ---- projection --------------------------------------------------------------

// Least-squares linear regression, done by hand (no dependency) on the
// (t, utilization_5h) points of the last 30 minutes. We look for the line u = a·t + b
// that minimizes the sum of the squares of the vertical deviations:
//
//   a = Σ(t − t̄)(u − ū) / Σ(t − t̄)²        (t̄ and ū = means)
//
// then we solve u = 1 on that line. By going through the means, the intercept
// does not need to be computed:
//
//   u = ū + a·(t − t̄)  =>  t(u=1) = t̄ + (1 − ū) / a
//
// This is deliberately basic: it assumes a constant consumption rate, which is
// false as soon as you take a break. Hence the horizon guard at display time.
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

  // den = 0: all the points at the same instant. num <= 0: usage stable or falling,
  // there is then no limit to project.
  if (den === 0 || num <= 0) return { enough: true, at: null };

  // A deadline later than the window reset means nothing: the counter starts over
  // from zero before then, the limit will never be reached. resets_at is in Unix SECONDS;
  // a fixed horizon as a fallback when it is missing.
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
    el.className = 'usage-projection';
    el.textContent = "Pas assez de données pour estimer le rythme (il faut 3 minutes de sondage).";
    el.hidden = false;
    return;
  }
  if (p.at === null) return;   // null rate or limit too far away: nothing to announce

  var time = new Date(p.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  el.textContent = 'À ce rythme, tu atteindras ta limite de session vers ' + time + '.';
  el.className = 'usage-projection is-hot';
  el.hidden = false;
}

// ---- status ------------------------------------------------------------------

// We reuse the palette from common.js to stay consistent with the gauges, but NOT
// colorFor(): it expects a usage window object, calling it here would force fabricating a fake
// { utilization } — exactly the coupling that keeping the sources separate avoids.
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

// Section entirely hidden when the "status" key is missing (first launch, failed poll):
// an empty section would be less clear than an absent one.
function renderStatus(stored) {
  var data = stored && stored.data;
  if (!data || !data.level) return;

  var head = document.getElementById('statusHead');
  head.appendChild(dot(data.level));
  head.appendChild(node('span', null, LEVEL_LABEL[data.level] || data.level));

  // All nominal: we stop at the compact line, no point laying out six green components.
  if (data.level !== 'operational') {
    if (data.incident && data.incident.name) {
      var inc = document.getElementById('statusIncident');
      inc.textContent = data.incident.name;   // says WHY it is degraded
      inc.hidden = false;
    }

    var list = document.getElementById('statusList');
    (data.components || []).forEach(function (c) {
      if (c.level === 'operational') return;
      var row = node('div', 'comp');
      row.appendChild(dot(c.level));
      // A status Statuspage might just have invented is shown raw rather than hidden.
      row.appendChild(node('span', null,
        c.name + ' — ' + (COMPONENT_LABEL[c.status] || c.status || c.level)));
      list.appendChild(row);
    });
  }

  document.getElementById('status').hidden = false;
}

// ---- settings ----------------------------------------------------------------

function renderSettings(settings) {
  var box = document.getElementById('notif');
  box.checked = !!(settings && settings.notifications);
  box.addEventListener('change', function () {
    chrome.storage.local.set({ settings: { notifications: box.checked } });
  });
}

// The panels only fold the popup's presentation: the controls keep the same
// identifiers, the same listeners and the same writes to chrome.storage.local.
function bindDisclosure(toggleId, panelId) {
  var toggle = document.getElementById(toggleId);
  var panel = document.getElementById(panelId);
  var closeTimer = 0;

  toggle.addEventListener('click', function () {
    var open = toggle.getAttribute('aria-expanded') === 'true';
    window.clearTimeout(closeTimer);
    toggle.setAttribute('aria-expanded', String(!open));

    if (!open) {
      panel.hidden = false;
      requestAnimationFrame(function () { panel.classList.add('is-open'); });
      return;
    }

    panel.classList.remove('is-open');
    closeTimer = window.setTimeout(function () { panel.hidden = true; }, 140);
  });
}

// ---- auto-continue -----------------------------------------------------------

// A separate feature: four dedicated keys (see AC_KEYS in autocontinue-source.js), neither
// in the "settings" object — reserved for notifications — nor in the theme keys. The popup
// only WRITES: autocontinue.js on the page side and autocontinue-bg.js on the worker side react through
// storage.onChanged, so there is nothing to send to the tabs.
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
    // Pausing means nothing as long as the feature is off.
    pause.disabled = !s.enabled;
  }

  max.value = String(s.maxCount);
  paint();

  // On activation, we write the FOUR keys, not only the switch. It changes no
  // behavior — acSettings() already treats a missing key exactly like its default
  // value — but it makes storage readable by hand: inspecting chrome.storage.local shows
  // the complete state, instead of having to know what a missing key is worth.
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

  // "input" AND "change": the popup can be closed without the field losing focus, and
  // "change" would then never fire. We clamp the written value from the first keystroke, but we only
  // rewrite the field on submit — otherwise typing "1000" would truncate it under your fingers.
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

// ---- customization -----------------------------------------------------------

// claude.ai's default accent color (--cds-clay-emphasized). Serves as the displayed value
// when nothing is stored, and as the value to return to after a reset.
var DEFAULT_ACCENT = '#c6613f';

// Warning: no <input type="color"> here, and do not put one back: on Firefox, the native picker
// is a separate window, and opening a window kills the anchored popup (Mozilla bug 1292701,
// still open). The popup dies BEFORE the first "input", so the choice is lost. Palette +
// hexadecimal input: two ordinary controls, no system window. See the README.
//
// The first stop is the default value, so that « Réinitialiser » falls back on a visibly
// selected swatch.
var ACCENT_PRESETS = ['#c6613f', '#b45309', '#4d7c0f', '#0f766e', '#0369a1', '#4338ca', '#7e22ce', '#be185d'];

// theme.js (accentValid) only accepts the #rrggbb form: it is the only one we write. When
// typing, on the other hand, the "#" and the case are free.
function accentNormalize(raw) {
  var v = String(raw == null ? '' : raw).trim();
  if (v.charAt(0) !== '#') v = '#' + v;
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
}

// Order of the two sliders' stops: index 1 is the neutral preset, which injects nothing
// on the theme.js side.
var WEIGHT_PRESETS = ['thin', 'normal', 'bold'];
var RADIUS_PRESETS = ['square', 'normal', 'round'];
var NEUTRAL_INDEX = 1;

var THEME_KEYS = ['accentColor', 'fontWeightPreset', 'radiusPreset', 'fontFamily'];

// A missing or unknown value falls back to the neutral stop.
function presetIndex(list, value) {
  var i = list.indexOf(value);
  return i === -1 ? NEUTRAL_INDEX : i;
}

// We only write the four keys above: it is theme.js, on the page side, that reacts through
// storage.onChanged and repaints every open claude.ai tab. The popup therefore has nothing to
// send to the tabs, and the extension needs neither "tabs" nor "scripting".
function renderTheme(stored) {
  var swatches = document.getElementById('accentSwatches');
  var hex = document.getElementById('accentHex');
  var preview = document.getElementById('accentPreview');
  var weight = document.getElementById('fontWeight');
  var radius = document.getElementById('radiusPreset');
  var family = document.getElementById('fontFamily');

  var accent = accentNormalize(stored.accentColor) || DEFAULT_ACCENT;

  weight.value = String(presetIndex(WEIGHT_PRESETS, stored.fontWeightPreset));
  radius.value = String(presetIndex(RADIUS_PRESETS, stored.radiusPreset));
  family.value = ['sans', 'serif', 'mono'].indexOf(stored.fontFamily) === -1 ? '' : stored.fontFamily;

  // paint() does NOT touch the input field: while typing, rewriting it would move the
  // caret and fight with the typed case. show() is the complete version, for the cases where
  // it is the code that imposes the value (initial render, swatch, field blur, reset).
  function paint(value) {
    accent = value;
    preview.style.background = value;
    for (var i = 0; i < swatches.children.length; i++) {
      var b = swatches.children[i];
      b.setAttribute('aria-pressed', String(b.dataset.color === value));
    }
  }

  function show(value) {
    paint(value);
    hex.value = value;
    hex.setAttribute('aria-invalid', 'false');
  }

  function saveAccent(value) { chrome.storage.local.set({ accentColor: value }); }

  ACCENT_PRESETS.forEach(function (c) {
    var b = node('button', 'swatch');
    b.type = 'button';
    b.dataset.color = c;
    b.style.background = c;
    b.setAttribute('aria-label', "Couleur d'accent " + c);
    b.addEventListener('click', function () { show(c); saveAccent(c); });
    swatches.appendChild(b);
  });

  show(accent);

  // Same live preview as the sliders: we write as soon as the input forms a complete color,
  // without waiting for submission.
  hex.addEventListener('input', function () {
    var v = accentNormalize(hex.value);
    hex.setAttribute('aria-invalid', v ? 'false' : 'true');
    if (!v) return;
    paint(v);
    saveAccent(v);
  });

  // On leaving the field, we redisplay the color actually applied: otherwise an input left
  // incomplete would stay on screen although it was never written.
  hex.addEventListener('blur', function () { show(accent); });

  // "input": the native controls emit continuously while dragging, which gives a
  // live preview. chrome.storage.local has no hourly write quota.
  // "change" as a safety net, for the paths that do not emit "input" (keyboard on the <select>,
  // release after an aborted drag).
  function bind(el, save) {
    el.addEventListener('input', save);
    el.addEventListener('change', save);
  }

  bind(weight, function () {
    chrome.storage.local.set({ fontWeightPreset: WEIGHT_PRESETS[Number(weight.value)] });
  });
  bind(radius, function () {
    chrome.storage.local.set({ radiusPreset: RADIUS_PRESETS[Number(radius.value)] });
  });
  // "Défaut" (empty value) removes the key: it is the only way to get back to the original
  // font without going through « Réinitialiser ».
  bind(family, function () {
    if (family.value) chrome.storage.local.set({ fontFamily: family.value });
    else chrome.storage.local.remove('fontFamily');
  });

  document.getElementById('themeReset').addEventListener('click', function () {
    show(DEFAULT_ACCENT);
    weight.value = String(NEUTRAL_INDEX);
    radius.value = String(NEUTRAL_INDEX);
    family.value = '';
    // A single remove for the four keys: theme.js does a single render of it, and the
    // <style> element disappears instead of being empty.
    chrome.storage.local.remove(THEME_KEYS);
  });
}

// ---- render ------------------------------------------------------------------

chrome.storage.local.get(['usage', 'usageHistory', 'settings', 'status']
  .concat(THEME_KEYS).concat(AC_KEYS)).then(function (o) {
  bindDisclosure('autocontinue-toggle', 'autocontinue-panel');
  bindDisclosure('theme-toggle', 'theme-panel');
  renderSettings(o.settings);
  renderAutoContinue(o);
  renderTheme(o);
  // Before the guard on "windows": otherwise the status would disappear precisely when usage is
  // unavailable, that is to say during an outage.
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
