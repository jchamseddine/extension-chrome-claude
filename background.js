// Service worker. Seule source de verite pour l'usage : il interroge l'API de claude.ai
// toutes les minutes (chrome.alarms) et ecrit la cle "usage". Il tient aussi l'historique
// roulant, les notifications de seuil, et l'apparence de l'icone de toolbar — deux anneaux
// concentriques dessines sur un OffscreenCanvas, exterieur = fenetre 7j, interieur = 5h,
// plus le badge texte du % 5h.
//
// L'icone, l'historique et les notifications restent branches sur chrome.storage.onChanged :
// l'evenement se declenche aussi dans le contexte qui a ecrit, donc le sondage n'a rien a
// appeler directement.
'use strict';

// importScripts() n'existe QUE dans un WorkerGlobalScope. Chrome charge bien ce fichier dans
// un vrai service worker, mais Firefox ne supporte pas "background.service_worker" : il lit
// "background.scripts" et instancie une EVENT PAGE, c'est-a-dire une page HTML cachee, ou
// importScripts est undefined. Sans ce garde, la ligne suivante leve un ReferenceError et rien
// de ce fichier ne s'execute — ni alarme, ni sondage, ni icone.
//
// ⚠️ La liste ci-dessous est DOUBLEE dans "background.scripts" du manifest, qui charge les
// memes fichiers dans le meme ordre pour Firefox. Les deux doivent rester synchronisees :
// n'en modifier qu'une casse UN SEUL des deux navigateurs, jamais les deux — une panne
// asymetrique, donc facile a ne pas voir.
if (typeof importScripts === 'function') {
  importScripts('common.js');        // utilOf(), colorFor(), resetText(), USAGE_LABELS
  importScripts('usage-source.js');  // usageUrl(), orgsUrl(), pickOrgId(), parseUsage()
  importScripts('status-source.js'); // STATUS_URL, parseStatus()

  // Auto-continue : fonctionnalite a part, qui ne partage rien avec ce qui precede. Ces deux
  // lignes sont tout son ancrage cote worker — les retirer la supprime entierement.
  importScripts('autocontinue-source.js'); // AC_KEYS, acSettings(), acMaxReached()
  importScripts('autocontinue-bg.js');     // alarme + sondage des onglets
}

var TRACK = 'rgba(128,128,128,0.30)';

// Ordre decroissant : on cherche le plus haut seuil franchi.
var THRESHOLDS = [95, 90, 75];
var HISTORY_MAX = 50;
var NOTIFY_ICON_SIZE = 128;

// Detection de reset de fenetre : deux signaux exiges ensemble (voir isReset).
var RESET_FROM_PCT = 20;                 // en dessous, une baisse n'a rien de significatif
var RESET_MAX_AGE_MS = 10 * 60 * 1000;   // sondage a 1 min : au dela, Chrome dormait

// Textes propres aux notifications, donc pas dans USAGE_LABELS de common.js, qui sert aussi
// a l'affichage du popup.
var RESET_MESSAGES = {
  '5h': 'Ta limite de session vient de se reset, tu peux repartir à 0 %.',
  '7d': 'Ta limite hebdomadaire vient de se reset, tu peux repartir à 0 %.'
};

var ALARM = 'usage-poll';
var POLL_MINUTES = 1;   // plancher impose par chrome.alarms

// Le statut bouge rarement : inutile de solliciter status.claude.com au rythme de l'usage.
var STATUS_ALARM = 'status-poll';
var STATUS_POLL_MINUTES = 5;

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

// Un point par sondage, donc une serie reguliere a 1 point/minute — c'est ce qui donne du
// sens a la regression lineaire du popup. Sert a projeter le moment ou la fenetre 5h
// atteindrait 100 %. Cape a HISTORY_MAX : 50 points = 50 min, la fenetre d'ajustement du
// popup en couvre 30.
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

// Un reset de fenetre ne se lit pas sur resets_at seul : l'API peut renvoyer une borne
// legerement differente d'un sondage a l'autre sans reset reel. Ni sur la seule chute du
// pourcentage : ce serait alors une correction de mesure, pas une nouvelle fenetre. On exige
// donc les deux ensemble, plus la fraicheur du sondage precedent — sinon on annoncerait au
// reveil de Chrome un reset survenu il y a des heures.
function isReset(prevW, w, ageMs) {
  if (typeof ageMs !== 'number' || ageMs < 0 || ageMs > RESET_MAX_AGE_MS) return false;

  var prevSec = prevW && prevW.resets_at;
  var sec = w && w.resets_at;
  if (typeof prevSec !== 'number' || typeof sec !== 'number' || sec === prevSec) return false;

  var pu = utilOf(prevW);
  var u = utilOf(w);
  if (pu === null || u === null) return false;

  var prevPct = Math.round(pu * 100);
  return prevPct > RESET_FROM_PCT && Math.round(u * 100) < prevPct / 2;
}

// Anti-spam : on memorise le dernier seuil notifie par fenetre. On ne notifie que quand le
// seuil franchi est SUPERIEUR au dernier notifie ; redescendre le baisse silencieusement,
// ce qui reautorise la notification si le seuil est refranchi (reset de fenetre, par ex.).
//
// "prev" est l'enveloppe { data, updatedAt } du sondage precedent, telle que storage.onChanged
// la fournit en oldValue : elle vient du storage, donc elle survit au recyclage du worker.
function evaluate(data, state, prev) {
  var msgs = [];
  var windows = data.windows || {};
  var prevWindows = (prev && prev.data && prev.data.windows) || {};
  var ageMs = (prev && typeof prev.updatedAt === 'number' && isFinite(prev.updatedAt))
    ? Date.now() - prev.updatedAt
    : -1;   // pas de sondage precedent exploitable : aucun reset detectable

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

    // Anti-spam propre au reset : on memorise la derniere borne annoncee. Redondant avec la
    // comparaison a prev dans le cas nominal, mais garantit le "une seule fois par reset"
    // meme si le meme sondage etait rejoue.
    if (isReset(prevWindows[key], w, ageMs) && st.notifiedReset !== w.resets_at) {
      msgs.push({
        title: label + ' : reset effectué',
        message: RESET_MESSAGES[key] + ' ' + resetText(w.resets_at, key === '7d')
      });
      st.notifiedReset = w.resets_at;
    }

    state.windows[key] = st;
  });

  // Vestige de l'ancien flux SSE : ce champ n'existe pas dans la reponse reelle de
  // /organizations/<org>/usage (elle porte extra_usage/spend a la place, pas encore cables
  // ici — voir usage-source.js). Laisse en l'etat, sans effet tant que rien ne le peuple.
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

function maybeNotify(data, prev) {
  return chrome.storage.local.get(['settings', 'notifyState']).then(function (o) {
    // Desactivees par defaut : sans reglage enregistre, on ne notifie pas.
    if (!(o.settings && o.settings.notifications)) return;

    var state = o.notifyState || {};
    if (!state.windows) state.windows = {};

    var msgs = evaluate(data, state, prev);
    return chrome.storage.local.set({ notifyState: state }).then(function () {
      if (!msgs.length) return;
      var windows = data.windows || {};
      return iconDataUrl(windows['7d'], windows['5h']).then(function (url) {
        msgs.forEach(function (m) { show(m, url); });
      });
    });
  });
}

// ---- sondage de l'API --------------------------------------------------------

// Le service worker n'a pas d'origine claude.ai : credentials:'include' envoie bien les
// cookies de session, mais rien ne garantit que l'API accepte une requete sans les
// Origin/Referer qu'elle attend. On tente donc d'abord depuis ici — ca marche onglet ferme —
// et on se rabat sur un onglet claude.ai ouvert, ou le fetch est same-origin.
function fetchJson(url) {
  return fetch(url, {
    credentials: 'include',
    headers: { accept: 'application/json' }
  }).then(function (res) {
    if (!res.ok) {
      var e = new Error('HTTP ' + res.status);
      e.status = res.status;
      throw e;
    }
    return res.json();
  });
}

// Les onglets charges avant l'installation ou le rechargement de l'extension n'ont pas de
// content script vivant : leur sendMessage rejette. On essaie donc les onglets a la suite.
function askTabs(tabs, url, i, lastErr) {
  if (i >= tabs.length) {
    throw new Error(lastErr || 'aucun onglet claude.ai ne repond (recharger l\'onglet)');
  }
  return chrome.tabs.sendMessage(tabs[i].id, { kind: 'fetchUsage', url: url })
    .then(function (r) {
      if (r && r.ok) return r.json;
      var e = new Error((r && r.error) || 'reponse vide');
      if (r && r.status) e.status = r.status;
      throw e;
    })
    .catch(function (e) {
      // Un refus HTTP se reproduira a l'identique sur les autres onglets : inutile d'insister.
      if (e && e.status) throw e;
      return askTabs(tabs, url, i + 1, String((e && e.message) || e));
    });
}

function fetchViaTab(url) {
  return chrome.tabs.query({ url: ['https://claude.ai/*', 'https://*.claude.ai/*'] })
    .then(function (tabs) {
      if (!tabs.length) throw new Error('aucun onglet claude.ai ouvert');
      return askTabs(tabs, url, 0, null);
    });
}

// Un 404 dit que l'URL est fausse : le repli ne ferait que produire le meme 404 depuis
// l'onglet. On ne se rabat que sur ce qui peut vraiment tenir a l'origine de l'appelant.
function getJson(url) {
  return fetchJson(url).catch(function (e) {
    if (e && e.status && e.status !== 401 && e.status !== 403) throw e;
    console.warn('[usage] fetch direct echoue (' + ((e && e.message) || e) +
                 ') : repli sur un onglet claude.ai');
    return fetchViaTab(url);
  });
}

// L'uuid d'organisation ne change jamais en pratique : on le met en cache pour ne pas payer
// une requete de plus a chaque sondage (le worker meurt entre deux alarmes, un cache memoire
// ne survivrait pas).
function resolveOrg() {
  if (!usageNeedsOrg()) return Promise.resolve(null);

  return chrome.storage.local.get('orgId').then(function (o) {
    if (o.orgId) return o.orgId;
    return getJson(orgsUrl()).then(function (json) {
      var id = pickOrgId(json);
      if (!id) throw new Error('aucun uuid d\'organisation dans la reponse de ' + orgsUrl());
      return chrome.storage.local.set({ orgId: id }).then(function () { return id; });
    });
  });
}

function pollUsage() {
  return resolveOrg()
    .then(function (org) { return getJson(usageUrl(org)); })
    .then(function (json) {
      var data = parseUsage(json);
      if (!data) return;   // parseUsage a deja dit en console ce qui manque

      // Ecrit a chaque sondage meme si rien n'a bouge : "updatedAt" doit refleter la
      // fraicheur reelle de la donnee, et usageHistory a besoin d'un echantillonnage regulier.
      return chrome.storage.local.set({ usage: { data: data, updatedAt: Date.now() } });
    })
    .catch(function (e) {
      console.warn('[usage] sondage echoue :', (e && e.message) || e);
      // Un uuid d'organisation perime rendrait le sondage muet pour toujours : on le jette
      // pour que le prochain reveil le redemande.
      if (e && (e.status === 401 || e.status === 403 || e.status === 404)) {
        return chrome.storage.local.remove('orgId').catch(function () {});
      }
    });
}

// ---- sondage du statut -------------------------------------------------------

// Source totalement independante de l'usage : autre domaine, endpoint public, et rien de
// commun en storage. Elle ne touche ni l'icone, ni l'historique, ni les notifications.
function pollStatus() {
  // fetchJson() et pas getJson() : le repli sur un onglet claude.ai n'a aucun sens pour un
  // endpoint public d'un autre domaine, et ses avertissements "[usage]" seraient trompeurs.
  return fetchJson(STATUS_URL)
    .then(function (json) {
      var data = parseStatus(json);
      if (!data) return;   // parseStatus a deja dit en console ce qui manque

      return chrome.storage.local.set({ status: { data: data, updatedAt: Date.now() } });
    })
    .catch(function (e) {
      console.warn('[status] sondage echoue :', (e && e.message) || e);
    });
}

// ---- declencheurs ------------------------------------------------------------

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes.usage) return;
  render();

  var data = changes.usage.newValue && changes.usage.newValue.data;
  if (!data) return;
  var prev = changes.usage.oldValue;   // sondage precedent, pour la detection de reset
  chain = chain
    .then(function () { return recordHistory(data); })
    .then(function () { return maybeNotify(data, prev); })
    .catch(function (e) { console.warn('[usage]', e); });
});

chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === ALARM) pollUsage();
  if (a.name === STATUS_ALARM) pollStatus();
});

// Le service worker est detruit et relance en permanence ; ce code de premier niveau
// rejoue donc a chaque reveil. chrome.alarms.create remet le compte a zero, ce qui
// repousserait le sondage indefiniment : on ne cree que si l'alarme manque.
chrome.alarms.get(ALARM).then(function (a) {
  if (!a) chrome.alarms.create(ALARM, { periodInMinutes: POLL_MINUTES });
}, function () { /* pas grave */ });

chrome.alarms.get(STATUS_ALARM).then(function (a) {
  if (!a) chrome.alarms.create(STATUS_ALARM, { periodInMinutes: STATUS_POLL_MINUTES });
}, function () { /* pas grave */ });

// setIcon ne survit pas au redemarrage de Chrome : il faut redessiner au demarrage.
chrome.runtime.onStartup.addListener(function () {
  render();
  pollUsage();   // ne pas attendre la premiere alarme pour avoir une donnee a afficher
  pollStatus();
});

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
  pollUsage();
  pollStatus();
});
