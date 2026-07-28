// Service worker. Seule source de verite pour l'apparence de l'icone de toolbar.
// Il ne fait aucun reseau : il reagit aux ecritures de content.js sur la cle "usage"
// (chrome.storage.onChanged) et redessine deux anneaux concentriques sur un OffscreenCanvas
// — exterieur = fenetre 7j, interieur = fenetre 5h — plus le badge texte du % 5h.
'use strict';

importScripts('common.js');   // utilOf() et colorFor(), partages avec le popup

var TRACK = 'rgba(128,128,128,0.30)';

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

function paint(size, w7, w5) {
  var canvas = new OffscreenCanvas(size, size);
  var ctx = canvas.getContext('2d');
  var center = size / 2;
  var width = Math.max(2, Math.round(size * 0.13));
  var gap = Math.max(1, Math.round(size * 0.06));
  var outer = center - width / 2;
  var inner = outer - width - gap;

  ring(ctx, center, outer, width, utilOf(w7), colorFor(w7));
  ring(ctx, center, inner, width, utilOf(w5), colorFor(w5));
  return ctx.getImageData(0, 0, size, size);
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

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.usage) render();
});

// setIcon ne survit pas au redemarrage de Chrome : il faut redessiner au demarrage.
chrome.runtime.onStartup.addListener(render);

chrome.runtime.onInstalled.addListener(function () {
  // Les captures de la Phase 1 (sniffer) sont devenues orphelines.
  chrome.storage.local.get(null).then(function (all) {
    var stale = Object.keys(all).filter(function (k) { return k.indexOf('sniff:') === 0; });
    if (stale.length) chrome.storage.local.remove(stale).catch(function () {});
  }, function () {});
  render();
});
