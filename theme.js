// Monde isole, document_start. Fonctionnalite independante du reste de l'extension :
// personnalise le theme de claude.ai (couleur d'accent, poids de police, rayon des coins +
// ombres, police de lecture) d'apres quatre cles de storage. Ne lit ni n'ecrit aucune autre
// cle, n'emet aucune requete.
//
// UN SEUL point d'injection : un <style> unique, qui porte toutes les regles et qui est RETIRE
// (pas vide) des qu'aucun reglage n'est actif — le theme d'origine redevient alors exactement
// ce qu'il etait. C'est le chemin "Reinitialiser".
//
// Chaine de resolution de l'accent, CONFIRMEE par inspection du bouton d'envoi :
//   bg-fill-brand       -> var(--cds-fill-brand)       -> var(--cds-clay-emphasized) = #c6613f
//   bg-fill-brand-hover -> var(--cds-fill-brand-hover) -> var(--cds-clay)            = #d97757
// Ce sont des tokens de base du design system, pas propres a ce bouton : les surcharger
// repeint les autres elements de marque. On ne touche QU'A ces deux variables — pas de fond
// (--_gray-*, --cds-hsl-gray-*, --cds-oncolor-*), pas de texte, et ni --_brand-clay ni
// --cds-hsl-clay qui ne sont pas dans la chaine ci-dessus. Si un element ne change pas de
// couleur, il faut inspecter CET element pour confirmer sa vraie chaine, pas deviner une
// variable de plus.
//
// Les trois autres reglages derivent des valeurs D'ORIGINE du site, lues a l'execution : on
// n'ecrit jamais une valeur devinee. Une variable illisible n'est simplement pas surchargee,
// avec un console.warn qui la nomme.
//
// Le popup ne fait qu'ecrire dans le storage : c'est l'abonnement storage.onChanged ci-dessous
// qui applique le changement, ce qui couvre tous les onglets claude.ai a la fois sans
// rechargement et sans messagerie. Seule limite : un onglet ouvert avant l'installation ou le
// rechargement de l'extension n'a pas de content script tant qu'il n'est pas recharge.
//
// Pas d'IIFE : les fonctions de calcul doivent rester lisibles depuis vm.runInContext pour
// test-theme.js (meme procede que usage-source.js), et declarees en var/function de premier
// niveau — let/const y seraient invisibles. Les content scripts de l'extension partagent un
// seul monde isole par frame, d'ou les prefixes "accent"/"theme" sur les noms globaux.
'use strict';

// TEMPORAIRE — traces de diagnostic. Le style injecte etait absent du DOM sur claude.ai sans
// qu'on puisse dire si le script ne tournait pas, ou tournait sans trouver de couleur stockee.
// A retirer une fois la cause tranchee (les console.warn, eux, restent).
console.log('[theme] content script charge');

var THEME_STYLE_ID = '__claude_theme_v1__';

var THEME_KEYS = ['accentColor', 'fontWeightPreset', 'radiusPreset', 'fontFamily'];
var THEME_WEIGHT_PRESETS = ['thin', 'normal', 'bold'];
var THEME_RADIUS_PRESETS = ['square', 'normal', 'round'];
var THEME_FONT_PRESETS = ['sans', 'serif', 'mono'];

// Ecart de luminosite entre l'accent au repos et l'accent au survol, en absolu. Cale sur le
// vrai couple #c6613f (L 51,2 %) -> #d97757 (L 59,6 %), soit +8,4 points. En absolu plutot
// qu'en relatif : un facteur multiplicatif ecrase l'ecart sur les teintes sombres. La vraie
// paire monte aussi la saturation, on ne la reproduit pas.
var ACCENT_LIGHTEN = 0.09;

// Un cran de la graduation CSS des poids : "Fin" = -100 sur les 4 poids, "Gras" = +100. Un
// cran suffit a rendre l'ecart visible sans casser la hierarchie entre regular et bold.
var THEME_WEIGHT_DELTA = 100;

// "Arrondi" = rayon x1,5. Au-dela, les petits controles (badges, champs) deviennent des
// gelules et la mise en page du site se lit mal.
var THEME_RADIUS_FACTOR = 1.5;

// "Arrondi" accentue aussi les ombres, sinon des coins plus ronds paraissent plus plats :
// longueurs px x1,2 et alpha x1,15. Simplification assumee — on ne decoupe ni les couches ni
// les positions, donc les decalages grandissent des memes 20 % que le flou. Visuellement
// subtil, et ca evite un parseur de box-shadow complet pour un format qu'on ne maitrise pas.
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

// --font-open-dyslexic est HORS PERIMETRE : claude.ai pilote deja cette police nativement
// (Reglages -> Apparence -> "Chat font"). Rien a doubler ici.

// Toutes les valeurs ci-dessous finissent concatenees dans du texte CSS : ce qui n'a pas
// exactement la forme attendue est rejete plutot qu'injecte.

function accentValid(hex) {
  return (typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex)) ? hex : null;
}

// Un prereglage hors liste est traite comme absent. Le prereglage neutre ("normal") l'est
// aussi : il n'injecte rien, donc autant le ramener a null tout de suite.
function themePreset(value, allowed, neutral) {
  return (typeof value === 'string' && allowed.indexOf(value) !== -1 && value !== neutral)
    ? value
    : null;
}

function accentByte(v) {
  var n = Math.max(0, Math.min(255, Math.round(v * 255)));
  return (n < 16 ? '0' : '') + n.toString(16);
}

// #rrggbb -> HSL -> L + ACCENT_LIGHTEN (borne a 1) -> #rrggbb. Teinte et saturation
// inchangees. Conversion a la main, aucune dependance.
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

  // d === 0 : gris achromatique, la teinte n'existe pas et le diviseur de s serait pris sur
  // un l valant 0 ou 1. On garde h = s = 0, le resultat reste gris.
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

// ---- calculs derives des valeurs d'origine ------------------------------------------------

// "400" + 100 -> "500", borne a [100, 900]. Un poids en mot-cle ("normal", "bold") ou une
// valeur vide renvoie null : on ne convertit pas, on n'injecte rien pour cette variable.
function themeShiftWeight(value, delta) {
  if (typeof value !== 'string') return null;
  var v = value.trim();
  if (!/^[0-9]{1,3}$/.test(v)) return null;
  return String(Math.max(100, Math.min(900, Number(v) + delta)));
}

// "8px" x1,5 -> "12px". Gere px/rem/em/%, gere "0" sans unite, arrondit a 2 decimales. Tout
// format inattendu (calc(), plusieurs valeurs, texte injecte) -> null.
function themeScaleLength(value, factor) {
  if (typeof value !== 'string') return null;
  var m = /^(-?(?:[0-9]+\.?[0-9]*|\.[0-9]+))(px|rem|em|%)?$/.exec(value.trim());
  if (!m) return null;
  var n = Number(m[1]);
  if (!isFinite(n)) return null;
  if (n === 0) return '0';
  if (!m[2]) return null;   // longueur non nulle sans unite : invalide en CSS
  return String(Math.round(n * factor * 100) / 100) + m[2];
}

// Accentue une ombre existante par remplacement regex : longueurs px x THEME_SHADOW_LENGTH_FACTOR,
// alpha des rgb()/rgba() x THEME_SHADOW_ALPHA_FACTOR (borne a 1). Si rien d'exploitable n'a ete
// trouve (ex. "none", ou une couleur oklch dont on ne sait pas extraire l'alpha), renvoie null
// et l'ombre est laissee intacte — plutot qu'une valeur inventee.
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
    // Seules rgba(r,g,b,a) et rgb(r g b / a) portent un alpha ; dans rgb(r,g,b) le dernier
    // nombre est le canal bleu, le toucher changerait la couleur.
    var slash = inner.indexOf('/') !== -1;
    var parts = inner.split(slash ? '/' : ',');
    if (slash ? parts.length !== 2 : parts.length !== 4) return whole;

    var a = Number(parts[parts.length - 1].trim());
    if (!isFinite(a)) return whole;   // alpha en % ou en var() : non exploitable

    touched = true;
    parts[parts.length - 1] = ' ' + (Math.round(Math.min(1, a * THEME_SHADOW_ALPHA_FACTOR) * 1000) / 1000);
    return whole.slice(0, whole.indexOf('(') + 1) + parts.join(slash ? '/' : ',') + ')';
  });

  return touched ? out : null;
}

function themeNormalizeFont(v) {
  return typeof v === 'string' ? v.toLowerCase().replace(/["']/g, '').replace(/\s+/g, '') : '';
}

// Laquelle des trois piles --font-anthropic-* est celle reellement appliquee au corps du
// texte ? On compare le font-family calcule aux trois valeurs plutot que d'en coder une en
// dur : c'est la seule variable qu'on surchargera, et se tromper de cible ne ferait rien du
// tout. Aucune correspondance -> null, l'option police reste sans effet (avec un warn).
function themeDetectFontVar(vars, applied) {
  var target = themeNormalizeFont(applied);
  if (!target) return null;
  for (var i = 0; i < THEME_FONT_VAR_LIST.length; i++) {
    var v = THEME_FONT_VAR_LIST[i];
    if (vars[v] && themeNormalizeFont(vars[v]) === target) return v;
  }
  return null;
}

// ---- capture des valeurs d'origine --------------------------------------------------------

var themeOriginals = null;
var themeWarned = {};

function themeWarn(key, message) {
  if (themeWarned[key]) return;   // sinon chaque re-rendu reimprime le meme avertissement
  themeWarned[key] = true;
  console.warn('[theme] ' + message);
}

// Memoisee UNE SEULE FOIS, et forcement avant notre premiere ecriture de ces variables (tous
// les appelants sont gardes par la presence du resultat). Sans ca, notre propre feuille en
// !important polluerait la lecture suivante : le rayon serait multiplie par 1,5 en cascade a
// chaque changement de prereglage, et la police cible ne serait plus detectable.
//
// A document_start les feuilles du site ne sont pas encore parsees et tout revient vide : on
// renvoie null SANS memoiser, pour pouvoir retenter (voir themeScheduleRetries).
function themeCaptureOriginals() {
  if (themeOriginals) return themeOriginals;

  // Le README documente le cas : les tokens peuvent etre portes par .cds-root plutot que <html>.
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

// ---- rendu ---------------------------------------------------------------------------------

// Construit les declarations de l'etat courant et les pose dans l'unique <style>. Renvoie true
// si un reglage attend encore les valeurs d'origine (il faudra reessayer).
//
// Note : "Carre" et la police n'ont pas besoin des valeurs d'origine pour leur calcul, mais
// ils ECRIVENT par-dessus des variables capturees. Les appliquer avant la capture rendrait
// celle-ci fausse (--cds-radius lu a 0, pile de police aliasee) — ils attendent donc eux aussi.
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
      else themeWarn(v, v + ' illisible ou non numerique (' + orig.vars[v] + ') : poids non applique');
    });
  }

  if (state.radiusPreset === 'square' && orig) {
    decls.push(THEME_RADIUS_VAR + ':0 !important');
    THEME_SHADOW_VARS.forEach(function (v) { decls.push(v + ':none !important'); });
  } else if (state.radiusPreset === 'round' && orig) {
    var r = themeScaleLength(orig.vars[THEME_RADIUS_VAR], THEME_RADIUS_FACTOR);
    if (r) decls.push(THEME_RADIUS_VAR + ':' + r + ' !important');
    else themeWarn(THEME_RADIUS_VAR, THEME_RADIUS_VAR + ' illisible ou de format inattendu ('
      + orig.vars[THEME_RADIUS_VAR] + ') : rayon non applique');

    THEME_SHADOW_VARS.forEach(function (v) {
      var out = themeScaleShadow(orig.vars[v]);
      if (out) decls.push(v + ':' + out + ' !important');
      else themeWarn(v, v + ' non exploitable (' + orig.vars[v] + ') : ombre laissee intacte');
    });
  }

  if (state.fontFamily && orig) {
    var source = THEME_FONT_VAR_OF[state.fontFamily];
    // On aliase la variable cible sur une pile que le site definit deja : rien a inventer. Si
    // le choix est deja la pile en place, il n'y a rien a injecter.
    if (!orig.fontVar) {
      themeWarn('fontVar', 'aucune des piles ' + THEME_FONT_VAR_LIST.join(', ')
        + ' ne correspond au font-family du corps de page : police non appliquee');
    } else if (orig.fontVar !== source) {
      decls.push(orig.fontVar + ':var(' + source + ') !important');
    }
  }

  var el = document.getElementById(THEME_STYLE_ID);

  // Aucune declaration : on RETIRE la feuille au lieu de la vider, pour que le theme d'origine
  // redevienne exactement ce qu'il etait.
  if (!decls.length) {
    if (el) {
      el.remove();
      console.log('[theme] feuille retiree');   // TEMPORAIRE
    }
    return needsOriginals && !orig;
  }

  var created = false;
  if (!el) {
    el = document.createElement('style');
    el.id = THEME_STYLE_ID;
    // A document_start, <head> peut ne pas encore exister ; un <style> pose sur <html>
    // s'applique quand meme.
    (document.head || document.documentElement).appendChild(el);
    created = true;
  }

  // !important : le site pose ces tokens sur :root, on doit gagner quel que soit l'ordre
  // d'insertion des feuilles.
  //
  // Trois selecteurs parce que le site declare aussi ces tokens sur .cds-root :
  //   :root          -> cas ou les tokens sont portes par <html>
  //   html.cds-root  -> meme element, mais specificite (0,1,1) > .cds-root (0,1,0) du site
  //   .cds-root      -> le cas qui compte vraiment. Si la classe n'est PAS sur <html>, le site
  //                     pose les tokens sur un element plus proche du bouton ; entre deux
  //                     elements differents la specificite ne joue pas, notre valeur heritee
  //                     depuis :root perd meme en !important. Seul le fait de matcher le meme
  //                     element corrige ce cas.
  var css = ':root,html.cds-root,.cds-root{' + decls.join(';') + ';}';
  if (el.textContent !== css) {
    el.textContent = css;
    console.log('[theme] regle appliquee', css);   // TEMPORAIRE
  }

  themeAudit(state, el, created);   // TEMPORAIRE
  themeWatchStyle();                // TEMPORAIRE

  return needsOriginals && !orig;
}

// TEMPORAIRE — diagnostic du bug de propagation intermittente (la couleur ne suit pas quand une
// generation est en cours dans l'onglet cible). Trace, juste APRES l'ecriture, ce qui separe les
// deux hypotheses en une seule ligne :
//
//   concordant: false + attachee: false -> la balise a ete retiree du DOM (hypothese « re-rendu
//                                          du site pendant le streaming »)
//   concordant: false + attachee: true  -> la balise est en place mais une regle plus specifique
//                                          gagne (hypothese « classe temporaire sur .cds-root »)
//   concordant: true                    -> le navigateur applique bien notre couleur ; si l'ecran
//                                          ne bouge pas, le probleme n'est ni ici ni dans le CSS
//
// La valeur CALCULEE est la seule preuve qui compte : elle dit ce que le navigateur applique
// vraiment, pas ce qu'on croit avoir ecrit. Lire --cds-clay-emphasized ne peut pas polluer la
// memoisation de themeCaptureOriginals() : cette variable n'est dans aucune des quatre listes
// qu'elle capture (poids, ombres, polices, rayon).
function themeAudit(state, el, created) {
  if (!state.accentColor) return;

  var applied;
  try {
    applied = getComputedStyle(document.documentElement)
      .getPropertyValue('--cds-clay-emphasized').trim();
  } catch (e) {
    applied = '(illisible : ' + ((e && e.message) || e) + ')';
  }

  console.log('[theme] audit', {
    demande: state.accentColor,
    calcule: applied,
    concordant: applied.toLowerCase() === state.accentColor.toLowerCase(),
    attachee: el.isConnected !== false,
    retrouveeParId: document.getElementById(THEME_STYLE_ID) === el,
    balise: created ? 'creee' : 'reutilisee'
  });
}

// ---- surveillance de la balise (TEMPORAIRE) ------------------------------------------------

// Repond a UNE question, et n'en corrige aucune : la balise est-elle RETIREE du DOM par un
// re-rendu du site ? Volontairement separe du reste — il n'observe qu'un retrait de noeud, il ne
// participe pas au rendu.
//
// Pour le promouvoir en correctif permanent une fois l'hypothese confirmee, passer
// THEME_REINJECT a true : la balise est alors reposee immediatement apres chaque retrait, a
// partir de l'etat courant, au lieu d'attendre le prochain storage.onChanged.
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

          console.warn('[theme] balise RETIREE du DOM à ' + new Date().toISOString() +
            ' (t+' + Math.round(typeof performance !== 'undefined' ? performance.now() : 0) +
            ' ms) — theme actif : ' + (themeCurrent.accentColor || 'aucun') +
            (THEME_REINJECT ? ' — reinjection' : ' — AUCUNE reinjection (observateur de debug)'));

          if (THEME_REINJECT) themeRender(themeCurrent);
        }
      }
    });
    themeWatcher.observe(document.documentElement, { childList: true });
  }

  // <head> peut ne pas exister au premier appel (document_start) : on l'ajoute des qu'il
  // apparait. childList sans subtree sur les deux seuls endroits ou la balise peut vivre —
  // pendant un streaming l'arbre entier mute en continu, un subtree couterait cher pour
  // surveiller un unique noeud.
  if (!themeWatchedHead && document.head) {
    themeWatchedHead = true;
    themeWatcher.observe(document.head, { childList: true });
  }
}

// ---- cablage --------------------------------------------------------------------------------

var themeCurrent = { accentColor: null, fontWeightPreset: null, radiusPreset: null, fontFamily: null };
var themeRetryScheduled = false;

// Retentes degressives (~3 s au total) le temps que les feuilles du site soient parsees. Passe
// ce delai on abandonne : un warn nomme les variables introuvables, aucune valeur n'est devinee.
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
        themeWarn('originals', 'valeurs d\'origine toujours illisibles apres ' + ms
          + ' ms : poids, rayon/ombres et police non appliques');
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
    // TEMPORAIRE — trace CHAQUE lecture, avec sa cause.
    //
    // Ce log etait auparavant limite au premier chargement (var themeFirstLoad). Le voir en
    // console ne prouvait donc PAS qu'une propagation avait eu lieu — c'etait le log du
    // chargement de la page — alors que c'est exactement la conclusion qu'on en tirait en
    // diagnostiquant le bug de propagation intermittente. Un point de mesure qui ne mesure pas
    // ce qu'on croit est pire que pas de point de mesure du tout : il oriente vers l'aval.
    console.log('[theme] etat lu (' + cause + ')', o);
    themeApply(themeReadState(o));
  }, function (e) {
    // Pas de catch muet : un echec de lecture ici est indistinguable de cles absentes, et
    // c'est exactement ce qui a rendu la panne indiagnosticable.
    console.warn('[theme] lecture storage echouee', e);
  });
}

if (typeof chrome !== 'undefined' && chrome.storage) {
  themeLoad('chargement initial');
  themeWatchStyle();   // TEMPORAIRE

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    var touched = THEME_KEYS.some(function (k) { return k in changes; });
    // Relecture complete plutot que lecture du seul delta : le reset supprime les quatre cles
    // d'un coup, un evenement suffit alors a produire un unique rendu coherent. Apres un
    // remove(), les cles sont absentes et themeReadState les ramene toutes a null.
    if (touched) themeLoad('storage.onChanged');
  });
}
