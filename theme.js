// Isolated world, document_start. A feature independent of the rest of the extension:
// customizes claude.ai's theme (accent color, font weight, corner radius +
// shadows, reading font) from four storage keys. Reads and writes no other
// key, emits no request.
//
// A SINGLE injection point: one unique <style>, which carries all the rules and which is REMOVED
// (not emptied) as soon as no setting is active — the original theme then becomes exactly
// what it was. That is the « Réinitialiser » path.
//
// Accent resolution chain, CONFIRMED by inspecting the send button:
//   bg-fill-brand       -> var(--cds-fill-brand)       -> var(--cds-clay-emphasized) = #c6613f
//   bg-fill-brand-hover -> var(--cds-fill-brand-hover) -> var(--cds-clay)            = #d97757
// These are base tokens of the design system, not specific to this button: overriding them
// repaints the other brand elements. We touch ONLY these two variables — no background
// (--_gray-*, --cds-hsl-gray-*, --cds-oncolor-*), no text, and neither --_brand-clay nor
// --cds-hsl-clay, which are not in the chain above. If an element does not change
// color, THAT element must be inspected to confirm its real chain, not one more
// variable guessed.
//
// The three other settings derive from the site's ORIGINAL values, read at runtime: we
// never write a guessed value. An unreadable variable is simply not overridden,
// with a console.warn naming it.
//
// The popup only writes to storage: it is the storage.onChanged subscription below
// that applies the change, which covers all claude.ai tabs at once without
// reloading and without messaging. The only limit: a tab opened before the extension was installed or
// reloaded has no content script until it is reloaded.
//
// No IIFE: the computation functions must stay visible from vm.runInContext for
// test-theme.js (same technique as usage-source.js), and declared as top-level
// var/function — let/const would be invisible there. The extension's content scripts share a
// single isolated world per frame, hence the "accent"/"theme" prefixes on the global names.
'use strict';

// TEMPORARY — diagnostic traces. The injected style was absent from the DOM on claude.ai without
// our being able to tell whether the script was not running, or was running without finding a stored color.
// To be removed once the cause is settled (the console.warn, for their part, stay).
console.log('[theme] content script loaded');

var THEME_STYLE_ID = '__claude_theme_v1__';

var THEME_KEYS = ['accentColor', 'fontWeightPreset', 'radiusPreset', 'fontFamily'];
var THEME_WEIGHT_PRESETS = ['thin', 'normal', 'bold'];
var THEME_RADIUS_PRESETS = ['square', 'normal', 'round'];
var THEME_FONT_PRESETS = ['sans', 'serif', 'mono'];

// Lightness gap between the resting accent and the hover accent, in absolute terms. Calibrated on the
// real pair #c6613f (L 51.2 %) -> #d97757 (L 59.6 %), that is +8.4 points. In absolute rather
// than relative terms: a multiplicative factor crushes the gap on dark hues. The real
// pair also raises the saturation, which we do not reproduce.
var ACCENT_LIGHTEN = 0.09;

// One step of the CSS weight scale: "Fin" = -100 on the 4 weights, "Gras" = +100. One
// step is enough to make the difference visible without breaking the hierarchy between regular and bold.
var THEME_WEIGHT_DELTA = 100;

// "Arrondi" = radius x1.5. Beyond that, the small controls (badges, fields) become
// pills and the site's layout reads poorly.
var THEME_RADIUS_FACTOR = 1.5;

// "Arrondi" also accentuates the shadows, otherwise rounder corners look flatter:
// px lengths x1.2 and alpha x1.15. An accepted simplification — we split neither the layers nor
// the positions, so the offsets grow by the same 20 % as the blur. Visually
// subtle, and it avoids a full box-shadow parser for a format we do not control.
var THEME_SHADOW_LENGTH_FACTOR = 1.2;
var THEME_SHADOW_ALPHA_FACTOR = 1.15;

var THEME_WEIGHT_VARS = ['--cds-font-weight-regular', '--cds-font-weight-medium',
  '--cds-font-weight-semibold', '--cds-font-weight-bold'];
var THEME_SHADOW_VARS = ['--cds-shadow-sm', '--cds-shadow-md', '--cds-shadow-lg'];
var THEME_RADIUS_VAR = '--cds-radius';
var THEME_FONT_VAR_LIST = ['--font-anthropic-sans', '--font-anthropic-serif',
  '--font-anthropic-mono'];
var THEME_FONT_VAR_OF = {
  sans: '--font-anthropic-sans',
  serif: '--font-anthropic-serif',
  mono: '--font-anthropic-mono'
};

// --font-open-dyslexic is OUT OF SCOPE: claude.ai already drives that font natively
// (Settings -> Appearance -> "Chat font"). Nothing to duplicate here.

// All the values below end up concatenated into CSS text: whatever does not have
// exactly the expected shape is rejected rather than injected.

function accentValid(hex) {
  return (typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex)) ? hex : null;
}

// A preset outside the list is treated as absent. The neutral preset ("normal") is
// too: it injects nothing, so we may as well bring it back to null right away.
function themePreset(value, allowed, neutral) {
  return (typeof value === 'string' && allowed.indexOf(value) !== -1 && value !== neutral)
    ? value
    : null;
}

function accentByte(v) {
  var n = Math.max(0, Math.min(255, Math.round(v * 255)));
  return (n < 16 ? '0' : '') + n.toString(16);
}

// #rrggbb -> HSL -> L + ACCENT_LIGHTEN (clamped to 1) -> #rrggbb. Hue and saturation
// unchanged. Conversion done by hand, no dependency.
function accentLighten(hex) {
  var r = parseInt(hex.slice(1, 3), 16) / 255;
  var g = parseInt(hex.slice(3, 5), 16) / 255;
  var b = parseInt(hex.slice(5, 7), 16) / 255;

  var max = Math.max(r, g, b);
  var min = Math.min(r, g, b);
  var d = max - min;
  var l = (max + min) / 2;
  var h = 0;
  var s = 0;

  // d === 0: achromatic grey, the hue does not exist and s's divisor would be taken on
  // an l equal to 0 or 1. We keep h = s = 0, the result stays grey.
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  l = Math.min(1, l + ACCENT_LIGHTEN);

  var c = (1 - Math.abs(2 * l - 1)) * s;
  var x = c * (1 - Math.abs((h / 60) % 2 - 1));
  var m = l - c / 2;
  var sector = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];

  return '#' + accentByte(sector[0] + m) + accentByte(sector[1] + m) + accentByte(sector[2] + m);
}

// ---- computations derived from the original values -----------------------------------------

// "400" + 100 -> "500", clamped to [100, 900]. A keyword weight ("normal", "bold") or an
// empty value returns null: we do not convert, we inject nothing for that variable.
function themeShiftWeight(value, delta) {
  if (typeof value !== 'string') return null;
  var v = value.trim();
  if (!/^[0-9]{1,3}$/.test(v)) return null;
  return String(Math.max(100, Math.min(900, Number(v) + delta)));
}

// "8px" x1.5 -> "12px". Handles px/rem/em/%, handles "0" without a unit, rounds to 2 decimals. Any
// unexpected format (calc(), several values, injected text) -> null.
function themeScaleLength(value, factor) {
  if (typeof value !== 'string') return null;
  var m = /^(-?(?:[0-9]+\.?[0-9]*|\.[0-9]+))(px|rem|em|%)?$/.exec(value.trim());
  if (!m) return null;
  var n = Number(m[1]);
  if (!isFinite(n)) return null;
  if (n === 0) return '0';
  if (!m[2]) return null;   // non-zero length without a unit: invalid in CSS
  return String(Math.round(n * factor * 100) / 100) + m[2];
}

// Accentuates an existing shadow by regex replacement: px lengths x THEME_SHADOW_LENGTH_FACTOR,
// alpha of the rgb()/rgba() x THEME_SHADOW_ALPHA_FACTOR (clamped to 1). If nothing usable was
// found (e.g. "none", or an oklch color whose alpha we cannot extract), returns null
// and the shadow is left intact — rather than an invented value.
function themeScaleShadow(value) {
  if (typeof value !== 'string') return null;
  var v = value.trim();
  if (!v || v === 'none' || /[;{}]/.test(v)) return null;

  var touched = false;

  var out = v.replace(/(-?(?:[0-9]+\.?[0-9]*|\.[0-9]+))px/g, function (whole, n) {
    touched = true;
    return (Math.round(Number(n) * THEME_SHADOW_LENGTH_FACTOR * 100) / 100) + 'px';
  });

  out = out.replace(/rgba?\(([^()]*)\)/g, function (whole, inner) {
    // Only rgba(r,g,b,a) and rgb(r g b / a) carry an alpha; in rgb(r,g,b) the last
    // number is the blue channel, touching it would change the color.
    var slash = inner.indexOf('/') !== -1;
    var parts = inner.split(slash ? '/' : ',');
    if (slash ? parts.length !== 2 : parts.length !== 4) return whole;

    var a = Number(parts[parts.length - 1].trim());
    if (!isFinite(a)) return whole;   // alpha as a % or in a var(): not usable

    touched = true;
    parts[parts.length - 1] = ' ' + (Math.round(Math.min(1, a * THEME_SHADOW_ALPHA_FACTOR) * 1000) / 1000);
    return whole.slice(0, whole.indexOf('(') + 1) + parts.join(slash ? '/' : ',') + ')';
  });

  return touched ? out : null;
}

function themeNormalizeFont(v) {
  return typeof v === 'string' ? v.toLowerCase().replace(/["']/g, '').replace(/\s+/g, '') : '';
}

// Which of the three --font-anthropic-* stacks is the one actually applied to the body
// text? We compare the computed font-family against the three values rather than hard-coding
// one: it is the only variable we will override, and getting the target wrong would do nothing
// at all. No match -> null, the font option stays without effect (with a warn).
function themeDetectFontVar(vars, applied) {
  var target = themeNormalizeFont(applied);
  if (!target) return null;
  for (var i = 0; i < THEME_FONT_VAR_LIST.length; i++) {
    var v = THEME_FONT_VAR_LIST[i];
    if (vars[v] && themeNormalizeFont(vars[v]) === target) return v;
  }
  return null;
}

// ---- capturing the original values ---------------------------------------------------------

var themeOriginals = null;
var themeWarned = {};

function themeWarn(key, message) {
  if (themeWarned[key]) return;   // otherwise every re-render reprints the same warning
  themeWarned[key] = true;
  console.warn('[theme] ' + message);
}

// Memoized ONCE ONLY, and necessarily before our first write of these variables (all
// the callers are guarded by the presence of the result). Without that, our own !important
// sheet would pollute the next read: the radius would be multiplied by 1.5 in cascade on
// each preset change, and the target font would no longer be detectable.
//
// At document_start the site's sheets are not parsed yet and everything comes back empty: we
// return null WITHOUT memoizing, so we can retry (see themeScheduleRetries).
function themeCaptureOriginals() {
  if (themeOriginals) return themeOriginals;

  // The README documents the case: the tokens can be carried by .cds-root rather than <html>.
  var root = document.querySelector('.cds-root') || document.documentElement;
  var sample = document.body;
  if (!root || !sample) return null;

  var cs = getComputedStyle(root);
  var vars = {};
  var readable = false;
  THEME_WEIGHT_VARS.concat(THEME_SHADOW_VARS, THEME_FONT_VAR_LIST, [THEME_RADIUS_VAR])
    .forEach(function (v) {
      var raw = cs.getPropertyValue(v).trim();
      vars[v] = raw || null;
      if (raw) readable = true;
    });
  if (!readable) return null;

  themeOriginals = {
    vars: vars,
    fontVar: themeDetectFontVar(vars, getComputedStyle(sample).fontFamily)
  };
  return themeOriginals;
}

// ---- render ---------------------------------------------------------------------------------

// Builds the declarations of the current state and puts them in the single <style>. Returns true
// if a setting is still waiting for the original values (a retry will be needed).
//
// Note: "Carré" and the font do not need the original values for their computation, but
// they WRITE over captured variables. Applying them before the capture would make it
// wrong (--cds-radius read as 0, aliased font stack) — so they wait too.
function themeRender(state) {
  var decls = [];
  var needsOriginals = !!(state.fontWeightPreset || state.radiusPreset || state.fontFamily);
  var orig = themeCaptureOriginals();

  if (state.accentColor) {
    decls.push('--cds-clay-emphasized:' + state.accentColor + ' !important');
    decls.push('--cds-clay:' + accentLighten(state.accentColor) + ' !important');
  }

  if (state.fontWeightPreset && orig) {
    var delta = state.fontWeightPreset === 'thin' ? -THEME_WEIGHT_DELTA : THEME_WEIGHT_DELTA;
    THEME_WEIGHT_VARS.forEach(function (v) {
      var out = themeShiftWeight(orig.vars[v], delta);
      if (out) decls.push(v + ':' + out + ' !important');
      else themeWarn(v, v + ' unreadable or non-numeric (' + orig.vars[v] + '): weight not applied');
    });
  }

  if (state.radiusPreset === 'square' && orig) {
    decls.push(THEME_RADIUS_VAR + ':0 !important');
    THEME_SHADOW_VARS.forEach(function (v) { decls.push(v + ':none !important'); });
  } else if (state.radiusPreset === 'round' && orig) {
    var r = themeScaleLength(orig.vars[THEME_RADIUS_VAR], THEME_RADIUS_FACTOR);
    if (r) decls.push(THEME_RADIUS_VAR + ':' + r + ' !important');
    else themeWarn(THEME_RADIUS_VAR, THEME_RADIUS_VAR + ' unreadable or of unexpected format ('
      + orig.vars[THEME_RADIUS_VAR] + '): radius not applied');

    THEME_SHADOW_VARS.forEach(function (v) {
      var out = themeScaleShadow(orig.vars[v]);
      if (out) decls.push(v + ':' + out + ' !important');
      else themeWarn(v, v + ' not usable (' + orig.vars[v] + '): shadow left intact');
    });
  }

  if (state.fontFamily && orig) {
    var source = THEME_FONT_VAR_OF[state.fontFamily];
    // We alias the target variable onto a stack the site already defines: nothing to invent. If
    // the choice is already the stack in place, there is nothing to inject.
    if (!orig.fontVar) {
      themeWarn('fontVar', 'none of the stacks ' + THEME_FONT_VAR_LIST.join(', ')
        + ' matches the page body font-family: font not applied');
    } else if (orig.fontVar !== source) {
      decls.push(orig.fontVar + ':var(' + source + ') !important');
    }
  }

  var el = document.getElementById(THEME_STYLE_ID);

  // No declaration: we REMOVE the sheet instead of emptying it, so the original theme
  // becomes exactly what it was again.
  if (!decls.length) {
    if (el) {
      el.remove();
      console.log('[theme] stylesheet removed');   // TEMPORARY
    }
    return needsOriginals && !orig;
  }

  var created = false;
  if (!el) {
    el = document.createElement('style');
    el.id = THEME_STYLE_ID;
    // At document_start, <head> may not exist yet; a <style> placed on <html>
    // applies anyway.
    (document.head || document.documentElement).appendChild(el);
    created = true;
  }

  // !important: the site puts these tokens on :root, we must win whatever the
  // sheet insertion order.
  //
  // Three selectors because the site also declares these tokens on .cds-root:
  //   :root          -> case where the tokens are carried by <html>
  //   html.cds-root  -> same element, but specificity (0,1,1) > the site's .cds-root (0,1,0)
  //   .cds-root      -> the case that really matters. If the class is NOT on <html>, the site
  //                     puts the tokens on an element closer to the button; between two
  //                     different elements specificity does not apply, and our value inherited
  //                     from :root loses even with !important. Only matching the same
  //                     element fixes that case.
  var css = ':root,html.cds-root,.cds-root{' + decls.join(';') + ';}';
  if (el.textContent !== css) {
    el.textContent = css;
    console.log('[theme] rule applied', css);   // TEMPORARY
  }

  themeAudit(state, el, created);   // TEMPORARY
  themeWatchStyle();                // TEMPORARY

  return needsOriginals && !orig;
}

// TEMPORARY — diagnosis of the intermittent propagation bug (the color does not follow when a
// generation is in progress in the target tab). Traces, just AFTER the write, what separates the
// two hypotheses in a single line:
//
//   matches: false + attached: false -> the tag was removed from the DOM (hypothesis "site
//                                       re-render during streaming")
//   matches: false + attached: true  -> the tag is in place but a more specific rule
//                                       wins (hypothesis "temporary class on .cds-root")
//   matches: true                    -> the browser is indeed applying our color; if the screen
//                                       does not move, the problem is neither here nor in the CSS
//
// The COMPUTED value is the only proof that counts: it says what the browser really
// applies, not what we think we wrote. Reading --cds-clay-emphasized cannot pollute the
// memoization of themeCaptureOriginals(): that variable is in none of the four lists
// it captures (weights, shadows, fonts, radius).
function themeAudit(state, el, created) {
  if (!state.accentColor) return;

  var applied;
  try {
    applied = getComputedStyle(document.documentElement)
      .getPropertyValue('--cds-clay-emphasized').trim();
  } catch (e) {
    applied = '(unreadable: ' + ((e && e.message) || e) + ')';
  }

  // A single line of TEXT, not an object: Chrome's console shows objects collapsed and
  // truncated, and they copy badly. This log is made to be picked up by hand and pasted as-is
  // into a report — its raw readability matters more than its structure.
  console.log('[theme] audit — requested=' + state.accentColor +
    ' computed=' + (applied || '(empty)') +
    ' matches=' + (applied.toLowerCase() === state.accentColor.toLowerCase() ? 'YES' : 'NO') +
    ' attached=' + (el.isConnected !== false ? 'yes' : 'NO') +
    ' foundById=' + (document.getElementById(THEME_STYLE_ID) === el ? 'yes' : 'NO') +
    ' tag=' + (created ? 'created' : 'reused'));
}

// ---- tag surveillance (TEMPORARY) ----------------------------------------------------------

// Answers ONE question, and fixes none: is the tag REMOVED from the DOM by a
// site re-render? Deliberately separate from the rest — it only observes a node removal, it does
// not take part in rendering.
//
// To promote it to a permanent fix once the hypothesis is confirmed, set
// THEME_REINJECT to true: the tag is then put back immediately after each removal, from
// the current state, instead of waiting for the next storage.onChanged.
var THEME_REINJECT = false;

var themeWatcher = null;
var themeWatchedHead = false;

function themeWatchStyle() {
  if (typeof MutationObserver === 'undefined' || !document.documentElement) return;

  if (!themeWatcher) {
    themeWatcher = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var removed = records[i].removedNodes;
        for (var j = 0; j < removed.length; j++) {
          if (!removed[j] || removed[j].id !== THEME_STYLE_ID) continue;

          console.warn('[theme] tag REMOVED from the DOM at ' + new Date().toISOString() +
            ' (t+' + Math.round(typeof performance !== 'undefined' ? performance.now() : 0) +
            ' ms) — active theme: ' + (themeCurrent.accentColor || 'none') +
            (THEME_REINJECT ? ' — reinjecting' : ' — NO reinjection (debug observer)'));

          if (THEME_REINJECT) themeRender(themeCurrent);
        }
      }
    });
    themeWatcher.observe(document.documentElement, { childList: true });
  }

  // <head> may not exist on the first call (document_start): we add it as soon as it
  // appears. childList without subtree on the only two places where the tag can live —
  // during streaming the whole tree mutates continuously, a subtree would be expensive to
  // watch a single node.
  if (!themeWatchedHead && document.head) {
    themeWatchedHead = true;
    themeWatcher.observe(document.head, { childList: true });
  }
}

// ---- wiring ---------------------------------------------------------------------------------

var themeCurrent = { accentColor: null, fontWeightPreset: null, radiusPreset: null, fontFamily: null };
var themeRetryScheduled = false;

// Decreasing retries (~3 s in total) while the site's sheets are being parsed. Past
// that delay we give up: a warn names the variables not found, no value is guessed.
var THEME_RETRY_MS = [100, 300, 800, 1500, 3000];

function themeReadState(o) {
  return {
    accentColor: accentValid(o.accentColor),
    fontWeightPreset: themePreset(o.fontWeightPreset, THEME_WEIGHT_PRESETS, 'normal'),
    radiusPreset: themePreset(o.radiusPreset, THEME_RADIUS_PRESETS, 'normal'),
    fontFamily: themePreset(o.fontFamily, THEME_FONT_PRESETS, null)
  };
}

function themeScheduleRetries() {
  if (themeRetryScheduled) return;
  themeRetryScheduled = true;

  document.addEventListener('DOMContentLoaded', function () { themeRender(themeCurrent); });

  THEME_RETRY_MS.forEach(function (ms, i) {
    setTimeout(function () {
      var pending = themeRender(themeCurrent);
      if (pending && i === THEME_RETRY_MS.length - 1) {
        themeWarn('originals', 'original values still unreadable after ' + ms
          + ' ms: weight, radius/shadows and font not applied');
      }
    }, ms);
  });
}

function themeApply(state) {
  themeCurrent = state;
  if (themeRender(state)) themeScheduleRetries();
}

function themeLoad(cause) {
  chrome.storage.local.get(THEME_KEYS).then(function (o) {
    // TEMPORARY — traces EVERY read, with its cause.
    //
    // This log was previously limited to the first load (var themeFirstLoad). Seeing it in
    // the console therefore did NOT prove that a propagation had happened — it was the log of the
    // page load — whereas that is exactly the conclusion we drew from it while
    // diagnosing the intermittent propagation bug. A measurement point that does not measure
    // what you think is worse than no measurement point at all: it points you downstream.
    console.log('[theme] state read (' + cause + ') — accent=' + (o.accentColor || 'none') +
      ' weight=' + (o.fontWeightPreset || '-') + ' radius=' + (o.radiusPreset || '-') +
      ' font=' + (o.fontFamily || '-'));
    themeApply(themeReadState(o));
  }, function (e) {
    // No silent catch: a read failure here is indistinguishable from missing keys, and
    // that is exactly what made the failure impossible to diagnose.
    console.warn('[theme] storage read failed', e);
  });
}

if (typeof chrome !== 'undefined' && chrome.storage) {
  themeLoad('initial load');
  themeWatchStyle();   // TEMPORARY

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    var touched = THEME_KEYS.some(function (k) { return k in changes; });
    // Full reread rather than reading the delta alone: the reset removes the four keys
    // at once, so a single event is enough to produce one coherent render. After a
    // remove(), the keys are absent and themeReadState brings them all back to null.
    if (touched) themeLoad('storage.onChanged');
  });
}
