// Service worker. Seule source de verite pour l'apparence de l'icone de toolbar, pour
// l'historique roulant d'usage, et pour les notifications de seuil.
// Il ne fait aucun reseau : il reagit aux ecritures de content.js sur la cle "usage"
// (chrome.storage.onChanged) et redessine deux anneaux concentriques sur un OffscreenCanvas
// — exterieur = fenetre 7j, interieur = fenetre 5h — plus le badge texte du % 5h.
'use strict';

importScripts('common.js');   // utilOf(), colorFor(), resetText(), USAGE_LABELS

var TRACK = 'rgba(128,128,128,0.30)';

// Ordre decroissant : on cherche le plus haut seuil franchi.
var THRESHOLDS = [95, 90, 75];
var HISTORY_MAX = 50;
var NOTIFY_ICON_SIZE = 128;

// Les lectures-modifications-ecritures de "usageHistory" et "notifyState" sont serialisees :
// deux onglets claude.ai peuvent ecrire "usage" a quelques millisecondes d'intervalle et se
// liraient mutuellement une valeur perimee.
var chain = Promise.resolve();

// ---- icone -------------------------------------------------------------------

function ring(ctx, center, radius, width, util, color) {
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';

  ctx.strokeStyle = TRACK;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, 2 * Math.PI);
  ctx.stroke();

  if (!util) return;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(center, center, radius, -Math.PI / 2, -Math.PI / 2 + util * 2 * Math.PI);
  ctx.stroke();
}

function canvasFor(size, w7, w5) {
  var canvas = new OffscreenCanvas(size, size);
  var ctx = canvas.getContext('2d');
  var center = size / 2;
  var width = Math.max(2, Math.round(size * 0.13));
  var gap = Math.max(1, Math.round(size * 0.06));
  var outer = center - width / 2;
  var inner = outer - width - gap;

  ring(ctx, center, outer, width, utilOf(w7), colorFor(w7));
  ring(ctx, center, inner, width, utilOf(w5), colorFor(w5));
  return canvas;
}

function paint(size, w7, w5) {
  return canvasFor(size, w7, w5).getContext('2d').getImageData(0, 0, size, size);
}

function render() {
  chrome.storage.local.get('usage').then(function (o) {
    var windows = (o.usage && o.usage.data && o.usage.data.windows) || null;
    var w5 = windows ? windows['5h'] : null;
    var w7 = windows ? windows['7d'] : null;

    chrome.action.setIcon({ imageData: { 16: paint(16, w7, w5), 32: paint(32, w7, w5) } })
      .catch(function () { /* pas grave */ });

    var u5 = utilOf(w5);
    if (u5 === null) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }
    chrome.action.setBadgeText({ text: Math.round(u5 * 100) + '%' });
    chrome.action.setBadgeBackgroundColor({ color: colorFor(w5) });
    chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }, function () { /* pas grave */ });
}

// ---- historique roulant ------------------------------------------------------

// Un point par evenement message_limit. Sert au popup a projeter le moment ou la fenetre
// 5h atteindrait 100 %. Cape a HISTORY_MAX : on jette toujours les plus anciens.
function recordHistory(data) {
  var windows = data.windows || {};
  var point = {
    t: Date.now(),
    u5: utilOf(windows['5h']),
    u7: utilOf(windows['7d'])
  };
  if (point.u5 === null && point.u7 === null) return Promise.resolve();

  return chrome.storage.local.get('usageHistory').then(function (o) {
    var h = Array.isArray(o.usageHistory) ? o.usageHistory : [];
    h.push(point);
    if (h.length > HISTORY_MAX) h = h.slice(h.length - HISTORY_MAX);
    return chrome.storage.local.set({ usageHistory: h });
  });
}

// ---- notifications de seuil --------------------------------------------------

// chrome.notifications exige un iconUrl : on encode l'icone a anneaux en PNG data-URL
// plutot que de livrer un binaire dans le depot.
function iconDataUrl(w7, w5) {
  return canvasFor(NOTIFY_ICON_SIZE, w7, w5)
    .convertToBlob({ type: 'image/png' })
    .then(function (blob) { return blob.arrayBuffer(); })
    .then(function (buf) {
      var bytes = new Uint8Array(buf);
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return 'data:image/png;base64,' + btoa(s);
    });
}

function show(msg, url) {
  chrome.notifications.create('', {
    type: 'basic',
    iconUrl: url,
    title: msg.title,
    message: msg.message,
    priority: 2
  }, function () {
    if (chrome.runtime.lastError) console.warn('[usage] notification', chrome.runtime.lastError.message);
  });
}

// Le plus haut seuil franchi par pct, 0 si aucun.
function crossedThreshold(pct) {
  for (var i = 0; i < THRESHOLDS.length; i++) {
    if (pct >= THRESHOLDS[i]) return THRESHOLDS[i];
  }
  return 0;
}

// Anti-spam : on memorise le dernier seuil notifie par fenetre. On ne notifie que quand le
// seuil franchi est SUPERIEUR au dernier notifie ; redescendre le baisse silencieusement,
// ce qui reautorise la notification si le seuil est refranchi (reset de fenetre, par ex.).
function evaluate(data, state) {
  var msgs = [];
  var windows = data.windows || {};

  Object.keys(USAGE_LABELS).forEach(function (key) {
    var w = windows[key];
    var st = state.windows[key] || { threshold: 0, overLimit: false };
    var label = USAGE_LABELS[key];
    var u = utilOf(w);

    if (u !== null) {
      var pct = Math.round(u * 100);
      var crossed = crossedThreshold(pct);
      if (crossed > st.threshold) {
        msgs.push({
          title: label + ' : ' + crossed + ' % atteint',
          message: pct + ' % utilisé. ' + (resetText(w.resets_at, key === '7d') || 'Reset inconnu.')
        });
      }
      st.threshold = crossed;
    }

    var over = !!(w && w.status === 'over_limit');
    if (over && !st.overLimit) {
      msgs.push({
        title: label + ' : limite atteinte',
        message: 'Cette fenêtre est épuisée. ' + (resetText(w.resets_at, key === '7d') || 'Reset inconnu.')
      });
    }
    st.overLimit = over;

    state.windows[key] = st;
  });

  // Champ jamais observe dans nos captures : lu aux deux emplacements plausibles, et
  // simplement ignore s'il n'existe pas.
  var overage = !!(data.overageInUse || (data.resolved && data.resolved.overageInUse));
  if (overage && !state.overage) {
    msgs.push({
      title: 'Crédits payants en cours de consommation',
      message: "Le forfait inclus est épuisé : l'usage actuel est facturé en supplément."
    });
  }
  state.overage = overage;

  return msgs;
}

function maybeNotify(data) {
  return chrome.storage.local.get(['settings', 'notifyState']).then(function (o) {
    // Desactivees par defaut : sans reglage enregistre, on ne notifie pas.
    if (!(o.settings && o.settings.notifications)) return;

    var state = o.notifyState || {};
    if (!state.windows) state.windows = {};

    var msgs = evaluate(data, state);
    return chrome.storage.local.set({ notifyState: state }).then(function () {
      if (!msgs.length) return;
      var windows = data.windows || {};
      return iconDataUrl(windows['7d'], windows['5h']).then(function (url) {
        msgs.forEach(function (m) { show(m, url); });
      });
    });
  });
}

// ---- declencheurs ------------------------------------------------------------

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes.usage) return;
  render();

  var data = changes.usage.newValue && changes.usage.newValue.data;
  if (!data) return;
  chain = chain
    .then(function () { return recordHistory(data); })
    .then(function () { return maybeNotify(data); })
    .catch(function (e) { console.warn('[usage]', e); });
});

// setIcon ne survit pas au redemarrage de Chrome : il faut redessiner au demarrage.
chrome.runtime.onStartup.addListener(render);

chrome.runtime.onInstalled.addListener(function () {
  // Cles orphelines : captures de la Phase 1 (sniffer), et "context" d'avant la
  // segmentation par conversation (remplacee par les cles "ctx:<uuid>").
  chrome.storage.local.get(null).then(function (all) {
    var stale = Object.keys(all).filter(function (k) {
      return k.indexOf('sniff:') === 0 || k === 'context';
    });
    if (stale.length) chrome.storage.local.remove(stale).catch(function () {});
  }, function () {});
  render();
});
