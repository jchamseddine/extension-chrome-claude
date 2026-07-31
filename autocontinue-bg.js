// Moitie service worker de l'auto-continue. Charge par importScripts() depuis background.js,
// dont il ne partage NI donnee NI fonction : deux lignes a retirer pour supprimer la
// fonctionnalite. Aucun rapport avec usage-source.js, status-source.js ni theme.js.
//
// Pourquoi le worker s'en mele alors que autocontinue.js voit deja le DOM : les setTimeout d'un
// onglet en arriere-plan sont brides (1 s minimum, puis 1/min apres cinq minutes cache), donc
// le MutationObserver de la page ne suffit pas pour un onglet minimise. Ici l'horloge est cote
// extension, hors de portee du brideur de l'onglet.
//
// Ce fichier ne DECIDE rien et ne lit aucun DOM : il ne fait que reveiller acTick() dans chaque
// onglet claude.ai, par chrome.scripting.executeScript. C'est la meme fonction que celle
// declenchee par le MutationObserver de la page, donc le verrou de acTick() suffit a garantir
// une seule continuation — pas besoin d'un protocole de reservation entre les deux cotes.
'use strict';

// chrome.alarms a un plancher d'une minute : bien trop lent pour une continuation. L'alarme ne
// sert donc qu'a RESSUSCITER le worker apres une mise en veille ; la cadence reelle vient du
// setInterval ci-dessous, qui ne vit que tant que le worker vit. Chaque executeScript repousse
// la mise en veille, donc la boucle s'auto-entretient tant qu'il y a un onglet claude.ai.
//
// Elle n'est demarree QUE si l'auto-continue est actif, non en pause et sous son maximum :
// desactive, l'extension ne maintient rien en vie.
var AC_ALARM = 'autocontinue-poll';
var AC_ALARM_MINUTES = 1;
var AC_POLL_MS = 5000;

var AC_TAB_URLS = ['https://claude.ai/*', 'https://*.claude.ai/*'];

var acTimer = null;

function acStartLoop() {
  if (acTimer) return;
  acTimer = setInterval(acPollTabs, AC_POLL_MS);
}

function acStopLoop() {
  if (!acTimer) return;
  clearInterval(acTimer);
  acTimer = null;
}

// Injectee telle quelle dans le monde isole de l'onglet : elle est SERIALISEE, donc elle ne
// peut rien capturer de ce fichier. acTick vient du content script autocontinue.js, qui vit
// dans ce meme monde isole — un onglet ouvert avant l'installation ou le rechargement de
// l'extension n'en a pas, d'ou le garde (meme limite que le relais de secours du sondage).
function acRemoteTick() {
  return (typeof acTick === 'function') ? acTick('sw') : 'pas de content script (recharger l\'onglet)';
}

// Journal de diagnostic. Deux etats meritent d'etre dits, et un seul de ces deux messages est
// visible a la fois :
//   - la boucle ne demarre pas : c'est LE cas ou rien d'autre ne peut parler, puisque ni le
//     sondage ni le MutationObserver de la page ne tournent. Sans ce message, un
//     autoContinueEnabled jamais ecrit est indiscernable d'une detection qui echoue ;
//   - la boucle tourne : chaque onglet renvoie sa raison, et c'est elle qu'on affiche.
// Anti-repetition dans les deux cas : le sondage repasse toutes les 5 s.
var acLastState = '';
var acLastTab = {};

// Ne journalise que si l'etat a CHANGE. La cle est comparee, pas le message : sans ca, un etat
// stable se reafficherait a chaque tour de boucle.
function acSay(key, message) {
  if (key === acLastState) return;
  acLastState = key;
  console.log('[autocontinue] ' + message);
}

function acIdleReason(settings) {
  if (!settings.enabled) {
    return 'auto-continue DÉSACTIVÉ (autoContinueEnabled absent ou false) — ' +
      'cocher la case dans le popup ; rien ne tourne tant que cette clé n\'est pas à true';
  }
  if (settings.paused) return 'en pause (autoContinuePaused = true)';
  return 'compteur maximum atteint : ' + settings.count + ' / ' + settings.maxCount +
    ' — « Réinitialiser » dans le popup, ou passer le maximum à 0 (illimité)';
}

function acPollTabs() {
  return chrome.storage.local.get(AC_KEYS).then(function (o) {
    var settings = acSettings(o);

    if (!settings.enabled || settings.paused || acMaxReached(settings)) {
      var raison = acIdleReason(settings);
      acSay('idle:' + raison, 'boucle arrêtée : ' + raison);
      return acStopLoop();
    }

    acStartLoop();
    return chrome.tabs.query({ url: AC_TAB_URLS }).then(function (tabs) {
      if (!tabs.length) {
        acSay('notabs', 'actif, mais aucun onglet claude.ai ouvert');
        return;
      }
      acSay('running', 'actif — sondage de ' + tabs.length + ' onglet(s) toutes les ' +
        (AC_POLL_MS / 1000) + ' s');

      tabs.forEach(function (tab) {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: acRemoteTick })
          .then(function (res) {
            // acTick() renvoie toujours sa raison en clair : c'est elle qui dit pourquoi
            // l'onglet n'a pas cliqué. Le detail (bouton, phrase, compteur) est journalisé
            // cote page, dans la console de l'onglet.
            var raison = res && res[0] && res[0].result;
            if (!raison || acLastTab[tab.id] === raison) return;
            acLastTab[tab.id] = raison;
            console.log('[autocontinue] onglet ' + tab.id + ' : ' + raison +
                        ' — détail dans la console de l\'onglet');
          })
          .catch(function () { /* onglet en cours de navigation, ou injection refusee */ });
      });
    });
  }).catch(function (e) {
    console.warn('[autocontinue] sondage echoue :', (e && e.message) || e);
  });
}

// Activer, reprendre ou reinitialiser le compteur depuis le popup doit prendre effet tout de
// suite, sans attendre l'alarme.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;

  var touched = AC_KEYS.some(function (k) { return !!changes[k]; });
  if (touched) acPollTabs();
});

chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === AC_ALARM) acPollTabs();
});

// Meme precaution que les deux autres alarmes : le code de premier niveau rejoue a chaque
// reveil du worker, et chrome.alarms.create remettrait le compte a zero. Le sondage immediat
// est dans la continuation pour redemarrer le setInterval des le reveil.
chrome.alarms.get(AC_ALARM).then(function (a) {
  if (!a) chrome.alarms.create(AC_ALARM, { periodInMinutes: AC_ALARM_MINUTES });
  acPollTabs();
}, function () { /* pas grave */ });
