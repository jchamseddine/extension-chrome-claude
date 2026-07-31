// Seul point d'adaptation de l'auto-continue a ce que claude.ai AFFICHE, et seule brique
// partagee entre ses trois contextes (page, service worker, popup). Logique PURE : aucun DOM,
// aucun chrome.*, aucun fetch — c'est ce qui la rend testable telle quelle par
// test-autocontinue.js, avec le meme procede vm.runInContext que usage-source.js.
//
// Fonctionnalite independante du reste de l'extension : rien de commun avec usage-source.js,
// status-source.js ni theme.js, ni en donnees ni en fonctions.
'use strict';

// Les six variantes viennent de claude-autocontinue (timothy22000, MIT), qui les a relevees
// sur des messages reels. Elles sont comparees en minuscules et en sous-chaine, pas en egalite :
// la phrase est noyee dans un paragraphe dont la formulation change.
//
// PAS DE VARIANTE FRANCAISE ici : aucune n'a ete capturee, et ce depot ne code pas de valeur
// devinee (meme regle que ORGS_PATH). Sur une interface claude.ai en francais, la detection
// echouera donc sur la phrase — voir « Limites connues » du README.
var AC_LIMIT_PHRASES = [
  'tool-use limit',
  'tool use limit',
  'reached its tool',
  'exhausted the tool',
  'tool call limit',
  'continuation needed'
];

function acHasLimitPhrase(text) {
  if (typeof text !== 'string' || !text) return false;

  var low = text.toLowerCase();
  for (var i = 0; i < AC_LIMIT_PHRASES.length; i++) {
    if (low.indexOf(AC_LIMIT_PHRASES[i]) !== -1) return true;
  }
  return false;
}

// ---- reglages ----------------------------------------------------------------

var AC_KEYS = ['autoContinueEnabled', 'autoContinueMaxCount', 'autoContinueCount',
  'autoContinuePaused'];

// Borne haute du champ du popup. Au-dela, "illimite" (0) dit la meme chose plus clairement.
var AC_MAX_LIMIT = 999;

// CONVENTION, sans ambiguite et valable PARTOUT (popup, page, service worker) :
//
//     autoContinueMaxCount === 0  <=>  ILLIMITE
//
// Ce n'est pas une sentinelle choisie au hasard. C'est aussi la valeur que rend acSettings()
// quand la cle manque, vaut null, ou est aberrante — donc un reglage jamais configure
// n'interdit JAMAIS de continuer, ce qui est le comportement voulu pour un maximum non defini.
// L'alternative (0 = "aucune continuation autorisee") aurait exige une autre valeur pour
// "illimite" (-1, null) et une cle absente serait alors devenue un blocage silencieux.
//
// Corollaire non negociable : une comparaison "count >= maxCount" NUE bloquerait des le
// premier appel quand maxCount vaut 0. Le court-circuit doit donc etre explicite, et il n'y a
// qu'un seul endroit ou cette comparaison a le droit d'exister : acMaxReached().
var AC_UNLIMITED = 0;

// Normalise les quatre cles brutes du storage en un objet exploitable. Toute valeur absente ou
// aberrante retombe sur le comportement le plus prudent : desactive, compteur a zero, maximum
// illimite (voir AC_UNLIMITED ci-dessus).
//
// autoContinueCount ABSENT et autoContinueCount = 0 donnent exactement le meme resultat :
// Number(undefined) vaut NaN, que le test isFinite ecarte. Une cle manquante ne peut donc pas
// fausser la comparaison de maximum — le popup l'ecrit quand meme a l'activation, mais pour
// que le storage se lise sans ambiguite a la main, pas pour corriger un comportement.
function acSettings(o) {
  o = o || {};

  var count = Number(o.autoContinueCount);
  var max = Number(o.autoContinueMaxCount);

  return {
    enabled: o.autoContinueEnabled === true,
    paused: o.autoContinuePaused === true,
    count: (isFinite(count) && count > 0) ? Math.floor(count) : 0,
    maxCount: (isFinite(max) && max > 0) ? Math.min(Math.floor(max), AC_MAX_LIMIT) : AC_UNLIMITED
  };
}

// LE seul endroit du depot ou count et maxCount sont compares. Le court-circuit sur
// AC_UNLIMITED passe avant la comparaison, jamais apres : c'est ce qui evite qu'un maximum
// laisse a 0 — donc « illimite » — se lise comme « quota deja epuise ».
function acMaxReached(settings) {
  if (settings.maxCount === AC_UNLIMITED) return false;
  return settings.count >= settings.maxCount;
}

// ---- decision ----------------------------------------------------------------

// "scan" est ce que la page a observe, sans interpretation :
//   { hasButton, lastText, otherTexts }   otherTexts = tous les messages de l'assistant SAUF le
//                                         dernier, dans l'ordre de la conversation
//
// DEUX conditions cumulees, jamais une seule :
//   (a) un bouton « Continue » visible — un message qui parle de la limite sans bouton veut
//       dire que la reponse est finie, il n'y a rien a continuer ;
//   (b) la phrase de limite dans le DERNIER message, et NULLE PART ailleurs dans la
//       conversation. C'est le garde-fou anti-faux-positif : une conversation dont le sujet
//       EST la limite de tool-use repete la phrase de message en message, et se
//       s'auto-continuerait sans fin.
//
// Renvoie toujours une raison, y compris quand on continue : c'est ce que le journal de la
// console affiche, et ce que les tests lisent.
function acDecide(scan, settings) {
  if (!settings.enabled) return { go: false, reason: 'auto-continue desactive' };
  if (settings.paused) return { go: false, reason: 'en pause' };
  if (!scan) return { go: false, reason: 'rien a examiner' };

  if (!scan.hasButton) return { go: false, reason: 'aucun bouton Continue visible' };
  if (!acHasLimitPhrase(scan.lastText)) {
    return { go: false, reason: 'pas de phrase de limite dans le dernier message' };
  }

  var others = scan.otherTexts || [];
  for (var i = 0; i < others.length; i++) {
    if (acHasLimitPhrase(others[i])) {
      return { go: false, reason: 'phrase de limite deja presente plus haut dans la conversation' };
    }
  }

  if (acMaxReached(settings)) {
    return { go: false, reason: 'compteur maximum atteint (' + settings.maxCount + ')' };
  }

  return { go: true, reason: 'limite de tool-use detectee' };
}
