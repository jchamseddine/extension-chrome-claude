// Monde isole, document_idle. Fonctionnalite independante du reste de l'extension : clique le
// bouton « Continue » que claude.ai affiche quand une reponse bute sur la limite de tool-use.
// Ne lit et n'ecrit que les quatre cles autoContinue*, n'emet aucune requete reseau.
//
// La decision n'est pas prise ici : ce fichier ne fait que LIRE le DOM et remettre un
// { hasButton, lastText, otherTexts } a acDecide() (autocontinue-source.js), qui porte les deux
// conditions cumulees et le compteur. Si claude.ai change son balisage, il n'y a que les
// selecteurs ci-dessous a corriger.
//
// DEUX declencheurs, UN SEUL chemin d'execution :
//   - le MutationObserver de ce fichier : quasi instantane, mais son setTimeout est bride des
//     que l'onglet passe en arriere-plan (1 s minimum, puis 1/min apres cinq minutes cache) ;
//   - le sondage du service worker (autocontinue-bg.js), qui appelle acTick() par
//     chrome.scripting.executeScript. Une injection d'extension, elle, n'est pas bridee : c'est
//     ce qui fait marcher l'auto-continue sur un onglet minimise.
// Les deux passent par acTick(), qui porte le verrou acBusy et le delai de garde. Le
// double-clic est donc impossible PAR CONSTRUCTION, sans protocole de reservation entre les
// deux cotes : il n'y a qu'un detecteur, reveille de deux facons.
//
// Pas d'IIFE : le service worker injecte une fonction qui appelle acTick() dans ce monde isole,
// le nom doit donc etre visible depuis le global (meme contrainte que theme.js pour ses
// fonctions de calcul). Les content scripts partagent un seul monde isole par frame, d'ou le
// prefixe "ac"/"AC_" sur tous les noms de premier niveau.
'use strict';

// Conteneur de message individuel. Signale par inspection reelle : la classe Tailwind porte un
// slash ("group/message-row"), qu'il faut echapper en selecteur CSS.
//
// La liste de conversation est VIRTUALISEE : React demonte les .group/message-row hors du
// viewport a mesure qu'on scrolle, donc un querySelectorAll() ponctuel ne voit que ce qui est
// actuellement monte, jamais l'historique complet. Hypothese posee ici, PAS verifiee : le
// dernier message assistant qui nous interesse est forcement celui que l'utilisateur regarde au
// moment ou le bouton "Continue" apparait, donc monte au moment du scan periodique (deja en
// place, toutes les 5 s). Si cette hypothese est fausse et que meme ce message est demonte,
// acScan() ne trouve aucun message assistant du tout ; acLog() le signale explicitement (voir
// plus bas) plutot que d'echouer en silence.
var AC_MESSAGE_ROW_SELECTOR = '.group\\/message-row';

// Signaux de role, confirmes par inspection reelle, chacun EXCLUSIF a un seul role :
// action-bar-retry et action-bar-read-aloud n'apparaissent QUE sur un message assistant ;
// action-bar-edit n'apparait QUE sur un message utilisateur. action-bar-copy existe sur LES DEUX
// roles — piste deja ecartee, a ne jamais utiliser comme critere de distinction.
var AC_ASSISTANT_SIGNAL_SELECTOR =
  '[data-testid="action-bar-retry"], [data-testid="action-bar-read-aloud"]';

function acIsAssistantRow(row) {
  return !!row.querySelector(AC_ASSISTANT_SIGNAL_SELECTOR);
}

// Motif standard d'accessibilite (pas une supposition sur le balisage EXACT de claude.ai) : une
// copie du texte reservee au lecteur d'ecran, marquee par aria-hidden ou une classe utilitaire
// sr-only/visually-hidden. innerText/textContent l'incluent quand meme, puisqu'elle n'est ni
// display:none ni visibility:hidden — seulement retiree visuellement par un clip — d'ou le
// doublon consecutif observe en usage reel (le meme passage lu deux fois de suite). On l'ecarte
// ici sans jamais toucher au DOM reel : un parcours manuel des noeuds qui saute tout element
// matchant ce selecteur, exactement l'inverse de ce qu'un simple .innerText ferait.
var AC_HIDDEN_TEXT_SELECTOR =
  '[aria-hidden="true"], .sr-only, [class*="sr-only" i], [class*="visually-hidden" i], ' +
  '[class*="visuallyhidden" i]';

function acVisibleText(el) {
  if (!el) return '';
  var text = '';
  (function walk(node) {
    if (node.nodeType === 3) { text += node.nodeValue; return; }  // Node.TEXT_NODE
    if (node.nodeType !== 1) return;                              // ni texte ni element : ignore
    if (node.matches && node.matches(AC_HIDDEN_TEXT_SELECTOR)) return;
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  })(el);
  return text.trim();
}

// acMessages() rend les lignes dans l'ordre du DOM, pas dans l'ordre visuel de la conversation :
// un element assistant-like present ailleurs sur la page (carte de citation, apercu
// d'historique...) qui se trouve APRES le vrai dernier message dans le document usurperait la
// position "dernier" si on se fiait a l'ordre du tableau — c'est exactement le symptome
// rapporte (texte d'une tout autre conversation). Le bouton "Continue" est lui confirme visible
// (offsetParent non nul, voir acContinueButton) : la ligne qui l'englobe EST par construction le
// vrai dernier message assistant, sans qu'on ait besoin de deviner un perimetre de page. Repli
// sur le dernier trouve dans l'ordre du DOM uniquement si le bouton n'est imbrique dans aucune
// ligne connue — hypothese non verifiee dans ce cas, signalee comme telle dans le journal.
function acLastAssistantRow(rows, button) {
  var fromButton = (button && button.closest) ? button.closest(AC_MESSAGE_ROW_SELECTOR) : null;
  if (fromButton && rows.indexOf(fromButton) !== -1) {
    return { row: fromButton, anchored: true };
  }
  return { row: rows.length ? rows[rows.length - 1] : null, anchored: false };
}

// Delai de garde apres un clic : le temps que claude.ai retire le bouton et reparte en
// streaming. Sans lui, le tick suivant reverrait le meme etat et recliquerait.
var AC_COOLDOWN_MS = 5000;

// On ne regarde le DOM qu'une fois les mutations calmees : pendant le streaming il en arrive
// des centaines par seconde, et le bouton n'apparait qu'a la fin.
var AC_QUIET_MS = 600;

var AC_TOAST_ID = '__claude_autocontinue_toast';
var AC_TOAST_MS = 4000;

var acBusy = false;
var acLastClickAt = 0;
var acQuietTimer = null;
var acToastTimer = null;

// Reflet local de « actif et pas en pause ». Sert uniquement a ne PAS payer une lecture de
// storage a chaque accalmie du DOM quand la fonctionnalite est eteinte — acTick() relit de
// toute facon les vraies valeurs avant d'agir.
var acOn = false;

function acAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
}

// ---- lecture du DOM ----------------------------------------------------------

function acMessages() {
  var rows = document.querySelectorAll(AC_MESSAGE_ROW_SELECTOR);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (acIsAssistantRow(rows[i])) out.push(rows[i]);
  }
  return out;
}

// offsetParent === null suffit a ecarter les boutons caches ici : le bouton « Continue » est
// dans le flux de la conversation, pas en position:fixed (ou offsetParent serait null meme
// visible). startsWith et pas egalite : le libelle porte parfois un suffixe — et ca couvre au
// passage « Continuer » d'une interface en francais.
//
// Le test de LIBELLE passe avant celui de VISIBILITE, uniquement pour pouvoir compter les
// boutons au bon libelle qu'on ecarte : c'est ce chiffre qui, dans le journal, distingue « pas
// de bouton » de « bouton present mais juge invisible a tort ».
function acContinueButton(stats) {
  var nodes = document.querySelectorAll('button, [role="button"]');

  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var t = (el.innerText || el.textContent || '').trim();
    if (t !== 'Continue' && t.indexOf('Continue') !== 0) continue;

    if (el.offsetParent === null) {
      if (stats) stats.hidden++;
      continue;
    }
    return el;
  }
  return null;
}

function acScan() {
  var stats = { hidden: 0 };
  var button = acContinueButton(stats);
  var rows = acMessages();
  var last = acLastAssistantRow(rows, button);
  var otherRows = rows.filter(function (r) { return r !== last.row; });

  return {
    hasButton: !!button,
    lastText: last.row ? acVisibleText(last.row) : '',
    otherTexts: otherRows.map(acVisibleText),
    // Purement diagnostique : acDecide() ne lit aucun des quatre suivants.
    hiddenButtons: stats.hidden,
    messageCount: rows.length,
    lastRowIndex: last.row ? rows.indexOf(last.row) : -1,
    lastRowAnchored: last.anchored
  };
}

// ---- journal de diagnostic ---------------------------------------------------

// On ne parle QUE quand il y a quelque chose a dire : un bouton « Continue » visible, ou un
// bouton au bon libelle qu'on vient d'ecarter. Le reste du temps, silence — sinon le sondage
// a 5 s noierait la console.
//
// Le dernier message est recopie quand la phrase de limite n'y est PAS trouvee : c'est le seul
// moyen de lire la formulation reelle et de l'ajouter a AC_LIMIT_PHRASES. C'est notamment ce
// qui manque pour une interface claude.ai en francais, dont aucune variante n'est connue.
var acLastLog = '';

function acLog(scan, settings, decision, origin) {
  if (!scan.hasButton && !scan.hiddenButtons) return;

  var ailleurs = scan.otherTexts.some(acHasLimitPhrase);
  var dansDernier = acHasLimitPhrase(scan.lastText);

  var lignes = [
    'bouton « Continue »  : ' + (scan.hasButton ? 'trouvé'
      : 'ÉCARTÉ — ' + scan.hiddenButtons + ' au bon libellé mais jugé invisible (offsetParent nul)'),
    'messages assistant   : ' + scan.messageCount + ' lus',
    'dernier message lu   : ' + (scan.messageCount > 0
      ? 'sélecteur ' + AC_MESSAGE_ROW_SELECTOR + ', index ' + scan.lastRowIndex + '/' +
        (scan.messageCount - 1) + ' — ' + (scan.lastRowAnchored
          ? 'ancré au bouton Continue (fiable)'
          : 'dernier trouvé dans l\'ordre du DOM (bouton non imbriqué — hypothèse à vérifier)')
      : 'aucun (voir ATTENTION ci-dessous)'),
    'phrase de limite     : ' + (dansDernier ? 'trouvée dans le dernier message'
      : 'ABSENTE du dernier message'),
    'phrase plus haut     : ' + (ailleurs ? 'OUI — bloquant (anti-faux-positif)' : 'non'),
    'compteur             : ' + settings.count + ' / ' +
      (settings.maxCount === AC_UNLIMITED ? 'illimité' : settings.maxCount),
    'actif / en pause     : ' + settings.enabled + ' / ' + settings.paused,
    'DÉCISION             : ' + (decision.go ? 'CLIQUE' : 'ignore') + ' — ' + decision.reason
  ];

  if (!dansDernier) {
    lignes.push('dernier message (500 premiers caractères), pour relever la phrase réelle :',
      '  ' + JSON.stringify(scan.lastText.slice(0, 500)));
  }

  // Cas suspect : un bouton "Continue" est visible mais aucun .group/message-row n'a ete
  // reconnu comme assistant — soit la virtualisation a demonte jusqu'au message visible a
  // l'ecran, soit les selecteurs de role ne matchent plus rien.
  if (scan.messageCount === 0) {
    lignes.push('ATTENTION              : aucun message assistant trouvé dans le DOM à cet ' +
      'instant (virtualisation ou sélecteurs de rôle obsolètes ?)');
  }

  // Anti-repetition : le sondage repasse toutes les 5 s sur un etat identique.
  var texte = lignes.join('\n  ');
  if (texte === acLastLog) return;
  acLastLog = texte;
  console.log('[autocontinue] diagnostic (' + origin + ')\n  ' + texte);
}

// ---- toast -------------------------------------------------------------------

// Volontairement un toast dans la page et pas chrome.notifications : une continuation est un
// evenement de la conversation qu'on est en train de lire, pas une alerte systeme. Cale
// au-dessus de la pastille de contexte (bas-droite, ~22 px de haut) pour ne pas la recouvrir.
function acToast(text) {
  var root = document.documentElement;
  if (!root) return;

  var el = document.getElementById(AC_TOAST_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = AC_TOAST_ID;
    el.style.cssText = [
      'position:fixed !important',
      'bottom:44px !important',
      'right:12px !important',
      'z-index:2147483647 !important',
      'padding:5px 10px !important',
      'border-radius:999px !important',
      'background:rgba(20,20,22,.88) !important',
      'color:#f5f5f4 !important',
      'font:11px/1.4 system-ui,sans-serif !important',
      'letter-spacing:.01em !important',
      'pointer-events:none !important',
      'white-space:nowrap !important'
    ].join(';');
  }

  el.textContent = text;
  if (el.parentNode !== root) root.appendChild(el);

  clearTimeout(acToastTimer);
  acToastTimer = setTimeout(function () {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, AC_TOAST_MS);
}

// ---- declenchement -----------------------------------------------------------

// Renvoie une promesse de raison, en clair : c'est la valeur que le service worker recupere de
// son executeScript, donc ce qu'on lit en console quand rien ne se passe.
//
// Le verrou n'est PAS relache par le delai de garde : acBusy ne couvre que la lecture-decision
// -ecriture, acLastClickAt couvre l'apres-clic. Deux roles distincts, deux variables.
function acTick(origin) {
  if (acBusy) return Promise.resolve('deja en cours');
  if (Date.now() - acLastClickAt < AC_COOLDOWN_MS) return Promise.resolve('delai de garde');
  if (!acAlive()) return Promise.resolve('contexte d\'extension invalide');

  acBusy = true;
  return chrome.storage.local.get(AC_KEYS).then(function (o) {
    var settings = acSettings(o);
    var scan = acScan();
    var decision = acDecide(scan, settings);

    acLog(scan, settings, decision, origin);
    if (!decision.go) return decision.reason;

    // Le scan et le clic ne sont pas le meme instant : le bouton a pu partir entre les deux.
    var button = acContinueButton();
    if (!button) return 'bouton disparu entre la detection et le clic';

    acLastClickAt = Date.now();
    button.click();

    var count = settings.count + 1;
    acToast('Auto-continue — continuation ' + count +
            (settings.maxCount ? ' / ' + settings.maxCount : ''));

    return chrome.storage.local.set({ autoContinueCount: count }).then(function () {
      console.log('[autocontinue] continuation ' + count + ' (' + origin + ')');
      return 'continuation ' + count;
    });
  }).catch(function (e) {
    return 'echec : ' + ((e && e.message) || e);
  }).then(function (reason) {
    acBusy = false;
    return reason;
  });
}

// ---- cablage -----------------------------------------------------------------

function acReadState() {
  if (!acAlive()) return;
  chrome.storage.local.get(['autoContinueEnabled', 'autoContinuePaused']).then(function (o) {
    acOn = o.autoContinueEnabled === true && o.autoContinuePaused !== true;
  }, function () { /* contexte invalide */ });
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (!changes.autoContinueEnabled && !changes.autoContinuePaused) return;
  acReadState();
});

// Debounce sur l'accalmie : pendant le streaming le timer est repousse en boucle, et acTick()
// ne part qu'une fois la reponse posee — c'est-a-dire au moment ou le bouton existe.
if (document.documentElement) {
  new MutationObserver(function () {
    if (!acOn) return;
    clearTimeout(acQuietTimer);
    acQuietTimer = setTimeout(function () { acTick('page'); }, AC_QUIET_MS);
  }).observe(document.documentElement, { childList: true, subtree: true });
}

acReadState();
