// Monde isole, document_idle. Dossiers personnalises dans la sidebar de claude.ai, sans rapport
// avec les « Projects » natifs. Fonctionnalite independante du reste de l'extension : ne lit et
// n'ecrit que les cles "folders" et "folderAssignments", n'emet aucune requete.
//
// ⚠️ C'EST LA FONCTIONNALITE LA PLUS FRAGILE DU DEPOT. Toutes les autres s'appuient sur une
// donnee (API d'usage, Statuspage) ou sur des variables CSS ; celle-ci est la seule a manipuler
// la STRUCTURE DOM native du site. Un remaniement de la sidebar la casse. D'ou trois regles :
//
//   1. Le point d'ancrage est le LIEN, a[href^="/chat/"] — le seul selecteur qui repose sur une
//      donnee (l'URL de la conversation) et pas sur une classe utilitaire. On remonte ensuite
//      au wrapper deplacable par closest('.df-drag-shiftable'), ce qui reste vrai meme si des
//      niveaux intermediaires sont ajoutes ou renommes. Le conteneur d'item
//      (div.group.relative[class*="rounded-"]) n'est JAMAIS cible : sa classe est un rayon
//      Tailwind arbitraire.
//   2. Rien n'est duplique : on DEPLACE les vrais noeuds de claude.ai dans nos blocs. Un clone
//      perdrait les gestionnaires de clic et le menu contextuel natifs.
//   3. Structure introuvable = arret propre. On n'insere rien et on le dit une fois en console,
//      plutot que de bricoler un affichage qui casserait la sidebar native.
//
// Pas d'IIFE, prefixe "cf"/"CF_" sur tous les noms de premier niveau : les content scripts de
// l'extension partagent un seul monde isole par frame (meme contrainte que theme.js et
// autocontinue.js).
'use strict';

// ---- selecteurs --------------------------------------------------------------
// Confirmes par inspection reelle du DOM. Toute reparation future commence ici — le README en
// tient le tableau, avec le role de chacun et sa fragilite.
var CF_ASIDE = 'aside.dframe-sidebar';        // coque de la sidebar, ne bouge pas d'un rendu a l'autre
var CF_SCROLL = '.dframe-nav-scroll';         // conteneur scrollable — sans lui, on s'arrete
var CF_SECTIONS = '.dframe-recents-by-mode';  // wrapper des sections, la ou on s'insere
var CF_LINK = 'a[href^="/chat/"]';            // ancrage principal
var CF_ITEM = '.df-drag-shiftable';           // wrapper deplacable, atteint par closest()

var CF_ROOT_ID = '__claude_folders_root';
var CF_STYLE_ID = '__claude_folders_style';
var CF_SLOT = 'data-cf-slot';                 // marque-page laisse a la place d'un item deplace
var CF_DRAG_TYPE = 'application/x-claude-folder';

var CF_DEBOUNCE_MS = 120;
var CF_GIVE_UP_MS = 8000;   // delai avant de conclure que la structure a change

var cfFolders = [];
var cfAssign = {};
var cfObserver = null;
var cfTarget = null;        // noeud actuellement observe, pour ne pas se reabonner pour rien
var cfTimer = null;
var cfDragging = null;      // uuid en cours de glissement : dataTransfer.getData() est illisible
var cfMenuEl = null;        // pendant dragover, seuls les types le sont
var cfDialogEl = null;      // modale de renommage ouverte, ou null
var cfEverFound = false;
var cfWarned = {};

function cfAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
}

// Une meme cause ne doit pas noyer la console a chaque re-rendu de la sidebar.
function cfWarn(key, message) {
  if (cfWarned[key]) return;
  cfWarned[key] = true;
  console.warn('[folders] ' + message);
}

// ---- storage -----------------------------------------------------------------

function cfLoad() {
  if (!cfAlive()) return Promise.resolve();

  return chrome.storage.local.get(FOLDER_KEYS).then(function (o) {
    cfFolders = folderList(o);
    cfAssign = folderAssignmentMap(o, cfFolders);
  }, function () { /* contexte invalide */ });
}

// On n'applique jamais un changement directement : on ecrit, et c'est storage.onChanged qui
// relit puis redessine. Un seul chemin, et les autres onglets suivent au passage.
function cfSave(patch) {
  if (!cfAlive()) return;
  chrome.storage.local.set(patch).catch(function () {});
}

function cfSaveFolders(folders) { cfSave({ folders: folders }); }

function cfSaveBoth(next) {
  cfSave({ folders: next.folders, folderAssignments: next.assignments });
}

// ---- style -------------------------------------------------------------------

// Un seul <style>, injecte une fois. Les couleurs sont volontairement relatives (currentColor,
// gris semi-transparents) : la sidebar existe en clair et en sombre, et le theme peut en plus
// avoir ete repeint par theme.js.
function cfStyle() {
  if (document.getElementById(CF_STYLE_ID)) return;

  var css = [
    '#' + CF_ROOT_ID + '{display:flex;flex-direction:column;gap:2px;margin-bottom:6px}',
    // Le bandeau ne porte plus de padding vertical : c'est la hauteur du bouton (24 px, celle du
    // « … » natif) qui donne desormais celle de la bande, sinon les deux s'additionnaient.
    '.cf-bar{display:flex;align-items:center;gap:6px;padding:0 8px;font-size:11px;opacity:.6}',
    '.cf-bar-label{flex:1;text-transform:uppercase;letter-spacing:.04em}',
    // « all:unset » remet display a inline et efface la taille de police : les deux sont donc
    // reposees APRES, sinon le carre de 24 px n'existe pas et le « + » reste a 11 px.
    '.cf-btn{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;' +
      'min-width:24px;min-height:24px;flex:none;border-radius:6px;cursor:pointer;' +
      'font-size:15px;line-height:1}',
    '.cf-btn:hover{background:rgba(128,128,128,.22)}',
    // Meme gabarit que le « … » natif d'a cote, dont il partage le conteneur. Aucune regle
    // d'opacite ici : elle vient des variants group-hover:/group-focus-within: du site.
    '.cf-unfile{all:unset;box-sizing:border-box;display:flex;align-items:center;' +
      'justify-content:center;width:var(--df-row-ctl,24px);height:var(--df-row-ctl,24px);' +
      'flex:none;border-radius:6px;cursor:pointer;font-size:15px;line-height:1}',
    '.cf-unfile:hover{background:rgba(128,128,128,.22)}',
    '.cf-head{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:8px;' +
      'cursor:pointer;font-size:13px;user-select:none}',
    '.cf-head:hover{background:rgba(128,128,128,.16)}',
    '.cf-chev{width:10px;font-size:9px;opacity:.7;text-align:center;transition:transform .12s}',
    '.cf-collapsed .cf-chev{transform:rotate(-90deg)}',
    '.cf-dot{width:8px;height:8px;border-radius:999px;flex:none}',
    '.cf-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cf-count{font-size:11px;opacity:.55;font-variant-numeric:tabular-nums}',
    '.cf-body{display:flex;flex-direction:column;gap:1px;padding-left:10px}',
    '.cf-body[hidden]{display:none}',
    // Le conteneur de controles est en position:absolute : il ne POUSSE rien. La seule chose qui
    // empeche le titre de courir dessous est la place que le lien lui reserve a droite — et le
    // site la dimensionne pour le SEUL bouton « … ». Notre « − » elargit le conteneur sans que
    // cette reserve suive : d'ou le titre qui passe sous les deux boutons, dans les dossiers et
    // nulle part ailleurs (« Recents » n'a rien de plus a loger, et s'affiche bien).
    //
    // On rend donc la reserve pour DEUX controles, et seulement dans nos blocs. La troncature est
    // reposee ici meme si le lien la porte deja : elle est sans effet dans ce cas, mais si le site
    // masque le debordement par un degrade plutot que par des points de suspension, ce degrade ne
    // couvre plus la bonne zone une fois le conteneur elargi.
    //
    // Volontairement large plutot que juste : trop de reserve tronque le titre un peu tot, ce qui
    // ne se voit pas ; pas assez le remet sous les boutons, ce qui est le bug. Une seule valeur a
    // ajuster si le gabarit des controles change.
    '.cf-body a[href^="/chat/"]{box-sizing:border-box;min-width:0;overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap;' +
      'padding-right:calc(2 * var(--df-row-ctl,24px) + 12px)}',
    '.cf-over{outline:2px dashed currentColor;outline-offset:-2px;border-radius:8px}',
    '.cf-out{padding:5px 8px;margin-top:2px;border:1px dashed rgba(128,128,128,.5);',
      'border-radius:8px;font-size:11px;opacity:.75;text-align:center}',
    '.cf-out[hidden]{display:none}',

    // ---- menu contextuel et modale de renommage ----------------------------------
    //
    // Ces deux-la ne sont pas peints en couleurs relatives comme le reste du fichier : ils
    // COPIENT deux composants natifs precis (le menu « … » d'une conversation, la modale de
    // renommage d'une conversation), et un composant flottant qui ne ressemble a rien de ce qui
    // l'entoure se voit immediatement.
    //
    // Chaque valeur passe donc par un token du design system du site AVEC un repli en dur :
    // var(--cds-x, <valeur observee>). Les noms de tokens sont deduits de leurs classes Tailwind
    // (bg-surface-3 -> --cds-surface-3) sur le modele de la seule chaine confirmee par
    // inspection, bg-fill-brand -> --cds-fill-brand. Deduits, donc faillibles — mais un nom
    // errone ne casse rien : la valeur observee prend le relais. C'est ce qui rend cette
    // deduction acceptable ici alors qu'elle ne le serait pas pour theme.js, qui lui ECRIT ces
    // variables (voir le README : « ne pas ajouter de variable au hasard »).
    //
    // Volontairement PAS --cds-radius ni --cds-shadow-{sm,md,lg}, les seuls tokens que le depot
    // connaisse deja : ce sont ceux de BASE, et rien ne confirme qu'ils valent le rounded-card /
    // shadow-panel observes sur ces deux composants-la. Les prendre pour equivalents ferait
    // diverger notre modale de la modale native qu'elle copie — soit exactement le defaut qu'on
    // corrige. Ils sont en plus deja multiplies par theme.js pour le reglage « coins/ombres ».
    '.cf-menu,.cf-modal{' +
      '--cf-surface:var(--cds-surface-3,#fff);' +
      '--cf-text:var(--cds-text-primary,#0b0b0b);' +
      '--cf-hover:var(--cds-fill-ghost-hover,rgba(0,0,0,.06));' +
      '--cf-field:var(--cds-fill-field,rgba(0,0,0,.03));' +
      '--cf-ring:var(--cds-shadow-field-ring,inset 0 0 0 1px rgba(0,0,0,.1));' +
      '--cf-card:var(--cds-radius-card,12px);' +
      // Le seul rouge du depot. PAS de var(--cds-…) ici : les autres tokens sont deduits de
      // classes reellement observees sur le composant copie, alors qu'aucun bouton de
      // suppression du site n'a ete inspecte — deduire un nom sans rien avoir vu serait la
      // « variable au hasard » que le README interdit. Assez sombre pour porter du blanc a 7:1
      // dans les deux modes, donc une seule valeur suffit.
      '--cf-danger:#b42318;' +
      // Les trois couches decrites sur les composants natifs : un lisere de 1 px translucide,
      // puis deux ombres portees d'ampleurs differentes.
      '--cf-panel:var(--cds-shadow-panel,0 0 0 1px rgba(0,0,0,.05),0 6px 20px rgba(0,0,0,.10),' +
        '0 1px 4px rgba(0,0,0,.06));' +
      '--cf-panel-lg:var(--cds-shadow-panel-lg,0 0 0 1px rgba(0,0,0,.05),' +
        '0 12px 40px rgba(0,0,0,.16),0 2px 8px rgba(0,0,0,.08))}',

    // Les replis en dur, eux, ne suivent aucun theme : si le token du site manque, une modale
    // blanche s'afficherait en mode sombre. Cette regle ne redefinit QUE la partie repli, la
    // valeur du site restant prioritaire quand elle existe. Elle suit la preference systeme, pas
    // le reglage de claude.ai — qu'on n'a aucun moyen fiable de lire : c'est un repli de repli.
    '@media (prefers-color-scheme:dark){.cf-menu,.cf-modal{' +
      '--cf-surface:var(--cds-surface-3,#2f2f2c);' +
      '--cf-text:var(--cds-text-primary,#f5f5f4);' +
      '--cf-hover:var(--cds-fill-ghost-hover,rgba(255,255,255,.10));' +
      '--cf-field:var(--cds-fill-field,rgba(255,255,255,.06));' +
      '--cf-ring:var(--cds-shadow-field-ring,inset 0 0 0 1px rgba(255,255,255,.12));' +
      '--cf-panel:var(--cds-shadow-panel,0 0 0 1px rgba(255,255,255,.08),' +
        '0 6px 20px rgba(0,0,0,.45),0 1px 4px rgba(0,0,0,.3));' +
      '--cf-panel-lg:var(--cds-shadow-panel-lg,0 0 0 1px rgba(255,255,255,.08),' +
        '0 12px 40px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.35))}}',

    // font-family:inherit et pas une police nommee : le menu est appendu a documentElement, il
    // herite donc de la police du site — y compris celle que theme.js a pu poser.
    '.cf-menu{position:fixed;z-index:2147483647;min-width:128px;max-width:320px;padding:4px;' +
      'border-radius:var(--cf-card);background:var(--cf-surface);color:var(--cf-text);' +
      'box-shadow:var(--cf-panel);font-family:inherit;font-size:14px;line-height:1.4}',
    // « all:unset » remet display a inline et efface la taille de police : les deux sont reposees
    // APRES, comme pour .cf-btn plus haut.
    '.cf-item{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;' +
      'width:100%;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:14px}',
    '.cf-item:hover,.cf-item:focus-visible{background:var(--cf-hover)}',
    // 20 px : le gabarit des icones natives. La police de ligatures du site (Anthropicons) n'est
    // pas repliquee — on garde le trait SVG des autres boutons de l'extension (export.js).
    '.cf-item svg{width:20px;height:20px;flex:none;opacity:.75}',
    '.cf-item-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cf-swatches{display:flex;gap:6px;padding:6px 10px}',
    '.cf-swatch{width:16px;height:16px;border-radius:999px;cursor:pointer;' +
      'border:1px solid rgba(128,128,128,.35)}',

    '.cf-modal{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
      'justify-content:center;background:var(--cds-backdrop,rgba(0,0,0,.45));' +
      'font-family:inherit}',
    '.cf-modal-box{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;' +
      'width:calc(100vw - 2rem);max-width:400px;padding:20px;border-radius:var(--cf-card);' +
      'background:var(--cf-surface);color:var(--cf-text);box-shadow:var(--cf-panel-lg)}',
    '.cf-modal-title{font-size:14px;font-weight:600}',
    '.cf-modal-input{all:unset;box-sizing:border-box;width:100%;height:36px;padding:0 12px;' +
      'border-radius:8px;background:var(--cf-field);box-shadow:var(--cf-ring);' +
      'color:inherit;font-family:inherit;font-size:14px}',
    '.cf-modal-message{font-size:14px;line-height:1.5;opacity:.85}',
    '.cf-modal-actions{display:flex;justify-content:flex-end;gap:8px}',
    '.cf-modal-btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;' +
      'justify-content:center;height:36px;padding:0 14px;border-radius:8px;cursor:pointer;' +
      'font-size:14px}',
    '.cf-modal-btn:hover{background:var(--cf-hover)}',
    // Le bouton primaire est l'INVERSE de la boite, pas une couleur en dur : fond sombre sur
    // texte clair en mode clair, et l'inverse en mode sombre, sans qu'on ait a nommer un token
    // de plus ni a savoir dans quel mode on est.
    '.cf-modal-btn-primary{background:var(--cf-text);color:var(--cf-surface)}',
    '.cf-modal-btn-primary:hover{background:var(--cf-text);opacity:.85}',
    // Rouge et non « primaire foncé » : une suppression ne doit pas ressembler a un
    // enregistrement au moment ou on la vise.
    '.cf-modal-btn-danger{background:var(--cf-danger);color:#fff}',
    '.cf-modal-btn-danger:hover{background:var(--cf-danger);opacity:.85}',
    '.cf-modal-btn[disabled]{opacity:.4;cursor:default}'
  ].join('');

  var el = document.createElement('style');
  el.id = CF_STYLE_ID;
  el.textContent = css;
  (document.head || document.documentElement).appendChild(el);
}

function cfNode(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ---- glisser-deposer ---------------------------------------------------------
//
// BUG CORRIGE (vu en usage reel) : deposer une conversation sur un dossier custom l'EPINGLAIT
// dans la section native « Épinglé » au lieu de l'assigner. Les handlers appelaient pourtant
// deja preventDefault() et stopPropagation() — ce n'etait donc pas la cause. Deux defauts
// reels, chacun suffisant a reproduire le symptome :
//
//   1. RECONNAISSANCE DU GLISSEMENT. Le test se faisait sur dataTransfer.types. Or le site
//      pose son propre gestionnaire de dragstart, et une implementation de drag appelle
//      couramment dataTransfer.clearData() avant d'ecrire SON type — ce qui efface le notre.
//      Notre dragover ne reconnaissait alors plus rien, donc n'appelait pas preventDefault(),
//      donc le depot n'etait meme pas AUTORISE sur nos blocs : le navigateur le renvoyait a la
//      logique du site, qui epinglait. On ne se fie donc plus du tout a dataTransfer pour
//      IDENTIFIER le glissement — cfDragging, pose au dragstart, fait foi.
//
//   2. PHASE D'ECOUTE. stopPropagation() en phase de bouillonnement arrive trop tard si le
//      site ecoute en phase de CAPTURE sur un ancetre : la capture descend du haut, donc son
//      handler s'executait AVANT le notre. Et nos blocs sont a l'interieur de
//      .dframe-nav-scroll, donc sous n'importe quel ancetre du site. On intercepte desormais
//      sur WINDOW en capture : c'est le tout premier point de la trajectoire d'un evenement,
//      avant tout gestionnaire pose sur un descendant, quel que soit son ordre d'inscription.
//
// Consequence volontaire : plus AUCUN gestionnaire n'est pose sur les elements natifs. On
// n'agit que si la cible est dans notre sous-arbre ET qu'un glissement de conversation est en
// cours ; partout ailleurs, l'evenement passe intact et le drag natif (reorganisation,
// epinglage) fonctionne exactement comme avant.

// Marque les zones qui acceptent un depot : valeur = id du dossier, ou '' pour « retirer ».
var CF_DROP_ATTR = 'data-cf-drop';

// Zone de depot A NOUS sous cette cible, sinon null. Le test « dans notre racine » est ce qui
// garantit qu'on ne marche jamais sur les plates-bandes du site.
function cfZoneAt(target) {
  if (!target || typeof target.closest !== 'function') return null;

  var root = document.getElementById(CF_ROOT_ID);
  if (!root || !root.contains(target)) return null;
  return target.closest('[' + CF_DROP_ATTR + ']');
}

function cfHighlight(zone) {
  var root = document.getElementById(CF_ROOT_ID);
  if (!root) return;

  Array.prototype.forEach.call(root.querySelectorAll('.cf-over'), function (el) {
    if (el !== zone) el.classList.remove('cf-over');
  });
  if (zone) zone.classList.add('cf-over');
}

// La bande « Retirer du dossier » n'a de sens que si la conversation glissee est justement
// rangee quelque part. Appelee sans argument, elle se contente de cacher la bande.
function cfShowOutZone(uuid) {
  var root = document.getElementById(CF_ROOT_ID);
  var out = root && root.querySelector('.cf-out');
  if (!out) return;

  var id = uuid || cfDragging;
  out.hidden = !(id && cfAssign[id]);
}

// dataTransfer ne sert plus qu'a RECUPERER l'uuid, et seulement en secours : cfDragging est la
// source sure, puisqu'il survit a un clearData() du site.
function cfDroppedUuid(e) {
  if (cfDragging) return cfDragging;

  try { return e.dataTransfer.getData(CF_DRAG_TYPE) || null; } catch (err) { return null; }
}

function cfApplyDrop(folderId, uuid) {
  if (!uuid) return;
  cfSave({
    folderAssignments: folderId
      ? folderAssign(cfAssign, uuid, folderId)
      : folderUnassign(cfAssign, uuid)
  });
}

// On ne pose PAS draggable="true" : un <a href> l'est nativement. On n'ajoute que notre type de
// donnee, sans preventDefault, pour que le systeme de glissement du site continue de recevoir
// ce qu'il attend quand le depot ne nous concerne pas.
function cfBindDrag(link, uuid) {
  if (link.__cfDrag) return;
  link.__cfDrag = true;

  link.addEventListener('dragstart', function (e) {
    cfDragging = uuid;
    cfShowOutZone();
    try { e.dataTransfer.setData(CF_DRAG_TYPE, uuid); } catch (err) { /* pas grave */ }
  });
  link.addEventListener('dragend', function () {
    cfDragging = null;
    cfHighlight(null);
    cfShowOutZone();
  });
}

// ---- bouton « − » (retirer du dossier) ---------------------------------------
//
// Le glisser-deposer sort deja une conversation d'un dossier (bande « Retirer »), mais c'est un
// geste ; ce bouton est l'equivalent en un clic. Il ne double PAS la logique : il appelle le
// meme cfApplyDrop('', uuid) que le depot sur la bande.
//
// Il est insere DANS le conteneur de controles natif de l'item — celui qui porte deja le bouton
// « … » — et pas a cote : ce conteneur est cache au repos et revele par les variants
// group-hover:/group-focus-within: poses par le site sur l'item. En s'y installant, le bouton
// herite exactement du meme comportement d'apparition, sans qu'on gere une seule opacite.
//
// Ce conteneur est atteint par le PARENT du premier bouton de l'item qui n'est pas le notre.
// Viser l'aria-label du « … » (« Plus d'options pour… ») dependrait de la langue de l'interface,
// et ses classes sont utilitaires : ni l'un ni l'autre ne sont des ancrages acceptables ici.
//
// Le bouton ne porte AUCUN gestionnaire : le clic est intercepte sur window en capture, plus bas.
function cfCtlBar(item) {
  var buttons = item.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    if (!buttons[i].classList.contains('cf-unfile')) return buttons[i].parentElement;
  }
  return null;
}

// N'est pose QUE sur les items ranges dans un dossier : un item de « Recents » n'a pas de
// dossier a quitter. Conteneur introuvable = on n'insere rien et on le dit une fois, plutot que
// de coller le bouton ailleurs dans l'item, ou il serait visible en permanence.
function cfAddUnfile(item, link) {
  var bar = cfCtlBar(item);
  if (!bar) {
    cfWarn('ctl', 'aucun bouton natif dans l\'item de conversation : le bouton « − » de retrait ' +
      'n\'est pas inséré. Le retrait par glisser-déposer sur la bande « Retirer du dossier » ' +
      'reste disponible. Voir le tableau des sélecteurs du README.');
    return;
  }
  if (bar.querySelector('.cf-unfile')) return;

  var btn = cfNode('button', 'cf-unfile', '−');   // U+2212, pas un trait d'union
  btn.type = 'button';

  var title = (link.textContent || '').replace(/\s+/g, ' ').trim();
  btn.setAttribute('aria-label',
    'Retirer ' + (title ? '« ' + title + ' »' : 'cette conversation') + ' du dossier');
  btn.title = 'Retirer du dossier';

  bar.insertBefore(btn, bar.firstChild);
}

// Les items sont DEPLACES, jamais reconstruits : celui qui revient dans « Recents » emporterait
// notre bouton avec lui si on ne le retirait pas ici.
function cfDropUnfile(item) {
  var btn = item.querySelector('.cf-unfile');
  if (btn) btn.remove();
}

// BUG CORRIGE (vu en usage reel) : le PREMIER clic sur « − » ne faisait rien, le suivant — et tous
// les suivants — marchait, sans rechargement de la page.
//
// Le gestionnaire etait pose sur le bouton, donc en phase de BOUILLONNEMENT. Il suffit qu'un
// gestionnaire du site pose en CAPTURE sur un ancetre appelle stopPropagation() pour que le clic
// n'atteigne JAMAIS le bouton : la capture descend depuis window, elle passe donc avant. Et une
// bibliotheque de glissement arme couramment un « avaleur de clic » A USAGE UNIQUE en fin de geste,
// pour que le clic qui suit un glissement ne declenche rien — d'ou « le premier clic seulement,
// puis plus jamais ». Notre propre repli pointeur y contribue : il prive le site de son pointerup
// et lui envoie un Échap pour qu'il annule, ce qui est justement une fin de geste.
//
// C'est le defaut n° 2 du bug d'epinglage (voir plus haut), au meme endroit du fichier et corrige
// de la meme facon : interception sur WINDOW en capture, le tout premier point de la trajectoire.
// Notre content script s'inscrit au chargement de la page, donc avant tout avaleur arme plus tard
// par un geste.
//
// La delegation regle au passage le cycle de vie : le bouton est detruit et recree a chaque
// re-rendu de la sidebar, et plus aucun exemplaire ne porte de gestionnaire a (re)brancher.
function cfOnUnfileClick(e) {
  if (!e.target || typeof e.target.closest !== 'function') return;

  var btn = e.target.closest('.cf-unfile');
  if (!btn) return;

  // Le bouton est un frere du lien, pas un descendant : le clic ne navigue pas de lui-meme. On le
  // neutralise quand meme, pour qu'il n'atteigne aucun gestionnaire de ligne du site.
  e.preventDefault();
  e.stopPropagation();

  // L'uuid est relu dans le DOM plutot que garde dans une fermeture : c'est la meme regle que
  // partout ailleurs — il ne s'obtient que par le href du lien — et il n'y a plus de fermeture.
  var item = btn.closest(CF_ITEM);
  var link = item && item.querySelector(CF_LINK);
  if (link) cfApplyDrop('', folderUuidFromHref(link.getAttribute('href')));
}

window.addEventListener('click', cfOnUnfileClick, true);

// ---- interception (window, phase de capture) ---------------------------------

function cfOnDragOver(e) {
  if (!cfDragging) return;   // pas un glissement de conversation : on ne touche a rien

  var zone = cfZoneAt(e.target);
  if (!zone) { cfHighlight(null); return; }

  // preventDefault sur dragover est ce qui AUTORISE le depot : sans lui, le navigateur refuse
  // la cible et le glissement retombe sur la logique du site.
  e.preventDefault();
  e.stopPropagation();
  try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* pas grave */ }
  cfHighlight(zone);
}

function cfOnDrop(e) {
  if (!cfDragging) return;

  var zone = cfZoneAt(e.target);
  if (!zone) return;

  e.preventDefault();
  e.stopPropagation();
  cfHighlight(null);
  cfApplyDrop(zone.getAttribute(CF_DROP_ATTR), cfDroppedUuid(e));
}

['dragenter', 'dragover'].forEach(function (name) {
  window.addEventListener(name, cfOnDragOver, true);
});
window.addEventListener('drop', cfOnDrop, true);

// ---- repli pointeur ----------------------------------------------------------
//
// « df-drag-shiftable » suggere un glissement au POINTEUR (les items s'ecartent au survol),
// pas le drag-and-drop HTML5. Dans ce cas aucun dragstart/dragover/drop n'est emis et tout ce
// qui precede reste muet. Ce repli ne s'arme donc QUE si aucun dragstart n'a ete vu pour le
// geste en cours (cfDragging est reste nul) : les deux voies ne peuvent pas se declencher
// ensemble, et c'est le navigateur qui choisit, pas nous.
var CF_POINTER_SLOP = 6;   // en deca, c'est un clic, pas un glissement
var cfPointer = null;

function cfOnPointerDown(e) {
  cfPointer = null;
  if (e.button !== 0 || !e.target || typeof e.target.closest !== 'function') return;

  var link = e.target.closest(CF_LINK);
  if (!link) return;

  var uuid = folderUuidFromHref(link.getAttribute('href'));
  if (uuid) cfPointer = { uuid: uuid, x: e.clientX, y: e.clientY, moved: false };
}

function cfOnPointerMove(e) {
  if (!cfPointer || cfPointer.moved) return;
  if (Math.abs(e.clientX - cfPointer.x) + Math.abs(e.clientY - cfPointer.y) < CF_POINTER_SLOP) return;

  cfPointer.moved = true;
  cfShowOutZone(cfPointer.uuid);
}

function cfOnPointerUp(e) {
  var drag = cfPointer;
  cfPointer = null;
  cfHighlight(null);
  cfShowOutZone();

  if (!drag || !drag.moved || cfDragging) return;   // clic simple, ou voie HTML5 deja active

  var zone = cfZoneAt(document.elementFromPoint(e.clientX, e.clientY));
  if (!zone) return;   // relache ailleurs : le site fait ce qu'il veut, y compris epingler

  e.preventDefault();
  e.stopPropagation();
  cfApplyDrop(zone.getAttribute(CF_DROP_ATTR), drag.uuid);

  // On vient de priver le site de son pointerup : sans ca son glissement resterait suspendu.
  // Échap est la sortie conventionnelle des bibliotheques de drag pour annuler proprement.
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true
    }));
  } catch (err) { /* pas grave */ }
}

window.addEventListener('pointerdown', cfOnPointerDown, true);
window.addEventListener('pointermove', cfOnPointerMove, true);
window.addEventListener('pointerup', cfOnPointerUp, true);

// ---- modales -----------------------------------------------------------------
//
// Remplacent window.prompt (creation, renommage) et window.confirm (suppression). Ces trois-la
// sont des composants du NAVIGATEUR : ils s'affichent en haut de la fenetre, loin du dossier
// qu'on vient de viser, et ne suivent ni le theme de claude.ai ni celui pose par theme.js. Nos
// modales copient celles du site — meme boite centree, meme fond assombri, memes deux boutons.
//
// Une SAISIE et une CONFIRMATION partagent la coque (overlay, boite, titre, barre de boutons,
// Échap, clic sur le fond, frappes retenues) et rien d'autre : corps different, garde-fou
// different, touche Entree differente. D'ou deux fonctions minces sur une coque commune, plutot
// qu'une seule a parametres optionnels — qui serait plus longue a lire que les deux reunies.
//
// Independantes du reste : elles ne connaissent que folders-source.js, comme tout ce fichier.

function cfCloseDialog() {
  if (cfDialogEl && cfDialogEl.parentNode) cfDialogEl.parentNode.removeChild(cfDialogEl);
  cfDialogEl = null;
}

function cfModalBtn(label, variant) {
  var btn = cfNode('button', 'cf-modal-btn' + (variant ? ' ' + variant : ''), label);
  btn.type = 'button';
  return btn;
}

// La coque ne sait rien de ce qu'elle contient : l'appelant fournit le corps (champ ou message)
// et son bouton d'action deja cable. Elle n'ajoute que « Annuler » et les trois facons de fermer
// sans agir — bouton, Échap, clic sur le fond.
function cfShell(title, body, action) {
  cfCloseDialog();

  var overlay = cfNode('div', 'cf-modal');
  var box = cfNode('div', 'cf-modal-box');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');

  var cancel = cfModalBtn('Annuler');
  cancel.addEventListener('click', cfCloseDialog);

  // Le fond assombri, et seulement lui : un clic dans la boite ne ferme rien.
  overlay.addEventListener('mousedown', function (e) {
    if (e.target === overlay) cfCloseDialog();
  });

  // Aucune frappe faite dans la modale ne doit atteindre le site : claude.ai ecoute le clavier
  // sur le document pour ses propres raccourcis, et une lettre tapee ici n'a rien a y faire.
  // C'est la meme preoccupation que le reste du fichier, dans l'autre sens — ici on retient nos
  // evenements plutot que d'intercepter les siens, donc le bouillonnement suffit : ils partent
  // de la boite, ils passent forcement par l'overlay avant d'en sortir.
  //
  // La coque ne traite qu'Échap : c'est la seule touche qui veut dire la meme chose dans les
  // deux modales. Entree n'appartient qu'a la saisie, qui la branche elle-meme sur son champ.
  ['keydown', 'keyup', 'keypress'].forEach(function (name) {
    overlay.addEventListener(name, function (e) {
      e.stopPropagation();
      if (name !== 'keydown' || folderDialogKeyAction(e.key) !== 'cancel') return;
      e.preventDefault();
      cfCloseDialog();
    });
  });

  var actions = cfNode('div', 'cf-modal-actions');
  actions.appendChild(cancel);
  actions.appendChild(action);

  box.appendChild(cfNode('div', 'cf-modal-title', title));
  box.appendChild(body);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.documentElement.appendChild(overlay);

  cfDialogEl = overlay;
  return cancel;
}

// Saisie d'un nom : creation (champ vide) comme renommage (champ pre-rempli).
function cfDialog(title, value, actionLabel, onSave) {
  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'cf-modal-input';
  input.value = value;
  input.setAttribute('aria-label', title);
  // Le nettoyage coupe deja a cette longueur : la borner ici evite de saisir un texte qui
  // disparaitrait silencieusement a l'enregistrement.
  input.maxLength = FOLDER_NAME_MAX;

  var save = cfModalBtn(actionLabel, 'cf-modal-btn-primary');

  // Le bouton grise et la touche Entree posent la MEME question, une seule fois ecrite.
  function sync() { save.disabled = !folderNameSubmittable(input.value); }

  // Un champ vide ne ferme pas la modale : la refermer sans rien ecrire se lirait comme une
  // sauvegarde reussie. On ferme AVANT d'appeler onSave, pour que l'ecriture en storage et le
  // redessin qu'elle declenche ne trouvent plus la modale ouverte.
  function commit() {
    if (!folderNameSubmittable(input.value)) return;
    var name = input.value;
    cfCloseDialog();
    onSave(name);
  }

  input.addEventListener('input', sync);
  save.addEventListener('click', commit);
  input.addEventListener('keydown', function (e) {
    if (folderDialogKeyAction(e.key) !== 'submit') return;
    e.preventDefault();
    commit();
  });

  cfShell(title, input, save);
  sync();
  input.focus();
  input.select();   // pre-selectionne : au renommage, retaper suffit a remplacer le nom
}

// Confirmation d'une action destructrice : pas de champ, donc rien a valider et aucun bouton
// jamais grise — le garde-fou n'est pas dans la saisie, il est dans le geste demande.
//
// C'est « Annuler » qui prend le focus, pas le bouton rouge : Entree et Échap referment donc
// tous deux sans rien detruire, et confirmer demande un geste explicite. L'inverse d'un
// window.confirm, dont la touche Entree valide.
function cfConfirm(title, message, actionLabel, onConfirm) {
  var act = cfModalBtn(actionLabel, 'cf-modal-btn-danger');
  act.addEventListener('click', function () {
    cfCloseDialog();
    onConfirm();
  });

  cfShell(title, cfNode('div', 'cf-modal-message', message), act).focus();
}

// ---- menu contextuel ---------------------------------------------------------

function cfCloseMenu() {
  if (cfMenuEl && cfMenuEl.parentNode) cfMenuEl.parentNode.removeChild(cfMenuEl);
  cfMenuEl = null;
}

// Icone au trait, comme celles d'export.js : les icones natives du menu passent par une police
// de ligatures proprietaire (Anthropicons), qu'on ne cherche pas a repliquer. Seuls le
// conteneur et la mise en forme du texte copient le natif.
function cfIcon(d) {
  var ns = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  var path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

// Structure de l'item natif : une icone de gabarit fixe, puis un libelle qui prend la place
// restante et se tronque. Le raccourci clavier du troisieme span n'a pas d'equivalent chez nous.
function cfItem(label, d) {
  var btn = cfNode('button', 'cf-item');
  btn.type = 'button';
  btn.setAttribute('role', 'menuitem');
  btn.appendChild(cfIcon(d));
  btn.appendChild(cfNode('span', 'cf-item-label', label));
  return btn;
}

// Crayon et corbeille au trait. Le rayon d'arc du crayon (3) couvre la corde de 5,66 : en
// dessous, le navigateur redimensionne les rayons lui-meme et l'arc se deforme.
var CF_ICON_RENAME = 'M4 20h4L19 9a3 3 0 10-4-4L4 16v4z';
var CF_ICON_DELETE = 'M4 7h16M10 7V5a1 1 0 011-1h2a1 1 0 011 1v2M6 7v12a1 1 0 001 1h10a1 1 0 001-1V7';

function cfMenu(folder, x, y) {
  cfCloseMenu();

  var menu = cfNode('div', 'cf-menu');
  menu.setAttribute('role', 'menu');

  var rename = cfItem('Renommer', CF_ICON_RENAME);
  rename.addEventListener('click', function () {
    cfCloseMenu();
    cfDialog('Renommer le dossier', folder.name, 'Enregistrer', function (name) {
      cfSaveFolders(folderRename(cfFolders, folder.id, name));
    });
  });
  menu.appendChild(rename);

  var swatches = cfNode('div', 'cf-swatches');
  FOLDER_COLORS.forEach(function (color) {
    var dot = cfNode('span', 'cf-swatch');
    dot.style.background = color;
    dot.title = color;
    dot.addEventListener('click', function () {
      cfCloseMenu();
      cfSaveFolders(folderRecolor(cfFolders, folder.id, color));
    });
    swatches.appendChild(dot);
  });
  menu.appendChild(swatches);

  var del = cfItem('Supprimer le dossier', CF_ICON_DELETE);
  del.addEventListener('click', function () {
    cfCloseMenu();
    cfConfirm('Supprimer le dossier « ' + folder.name + ' » ?',
      folderDeleteMessage(folderCount(cfAssign, folder.id)), 'Supprimer', function () {
        cfSaveBoth(folderDelete(cfFolders, cfAssign, folder.id));
      });
  });
  menu.appendChild(del);

  // Position fixe, puis on la corrige si le menu deborde en bas ou a droite.
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.documentElement.appendChild(menu);

  var box = menu.getBoundingClientRect();
  if (box.right > window.innerWidth) menu.style.left = Math.max(0, window.innerWidth - box.width - 4) + 'px';
  if (box.bottom > window.innerHeight) menu.style.top = Math.max(0, window.innerHeight - box.height - 4) + 'px';

  cfMenuEl = menu;
}

document.addEventListener('click', function (e) {
  if (cfMenuEl && !cfMenuEl.contains(e.target)) cfCloseMenu();
}, true);

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') cfCloseMenu();
}, true);

// ---- blocs de dossiers -------------------------------------------------------

function cfBlock(root, folder) {
  var block = root.querySelector('[data-cf-folder="' + folder.id + '"]');

  if (!block) {
    block = cfNode('div');
    block.setAttribute('data-cf-folder', folder.id);

    var head = cfNode('div', 'cf-head');
    head.appendChild(cfNode('span', 'cf-chev', '▾'));
    head.appendChild(cfNode('span', 'cf-dot'));
    head.appendChild(cfNode('span', 'cf-name'));
    head.appendChild(cfNode('span', 'cf-count'));

    head.addEventListener('click', function () {
      cfSaveFolders(folderToggle(cfFolders, folder.id));
    });
    head.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var f = folderById(cfFolders, folder.id);
      if (f) cfMenu(f, e.clientX, e.clientY);
    });

    var body = cfNode('div', 'cf-body');
    body.setAttribute('data-cf-body', folder.id);

    // Deposer sur l'en-tete OU dans le corps range dans ce dossier — viser une bande de 4 px
    // quand le dossier est vide serait injouable. L'interception vit sur window (voir plus
    // haut) : ces attributs sont tout ce qu'elle a besoin de trouver.
    head.setAttribute(CF_DROP_ATTR, folder.id);
    body.setAttribute(CF_DROP_ATTR, folder.id);

    block.appendChild(head);
    block.appendChild(body);
    root.appendChild(block);
  }

  var head = block.querySelector('.cf-head');
  var body = block.querySelector('.cf-body');
  head.querySelector('.cf-dot').style.background = folder.color;
  head.querySelector('.cf-name').textContent = folder.name;
  head.querySelector('.cf-count').textContent = String(folderCount(cfAssign, folder.id));
  block.classList.toggle('cf-collapsed', folder.collapsed);
  body.hidden = folder.collapsed;

  return body;
}

function cfRoot(parent) {
  var root = document.getElementById(CF_ROOT_ID);

  if (!root) {
    root = cfNode('div');
    root.id = CF_ROOT_ID;

    var bar = cfNode('div', 'cf-bar');
    bar.appendChild(cfNode('span', 'cf-bar-label', 'Dossiers'));

    var add = cfNode('button', 'cf-btn', '+');
    add.title = 'Nouveau dossier';
    add.addEventListener('click', function () {
      // Champ vide, et non un nom par defaut : un « Dossier 1 » pre-rempli serait valide d'un
      // Entree distrait, et il faudrait ensuite le renommer.
      cfDialog('Nouveau dossier', '', 'Créer', function (name) {
        cfSaveFolders(folderCreate(cfFolders, name));
      });
    });
    bar.appendChild(add);
    root.appendChild(bar);

    // Sortir une conversation d'un dossier se fait sur CETTE bande, a nous, et plus par un
    // depot sur la section « Récents » native. Poser un gestionnaire sur un element du site
    // etait precisement ce qui pouvait declencher son epinglage : desormais aucun element
    // natif ne porte quoi que ce soit de notre part. Elle n'apparait que pendant le
    // glissement d'une conversation deja rangee — sinon elle n'aurait aucun sens.
    var out = cfNode('div', 'cf-out', 'Retirer du dossier');
    out.setAttribute(CF_DROP_ATTR, '');
    out.hidden = true;
    root.appendChild(out);
  }

  // Au-dessus des sections natives, et remis en tete si un re-rendu a insere quelque chose
  // avant nous.
  if (root.parentNode !== parent || parent.firstChild !== root) {
    parent.insertBefore(root, parent.firstChild);
  }
  return root;
}

// ---- deplacement des items ---------------------------------------------------

// Marque-page laisse a la place exacte d'un item range dans un dossier. C'est ce qui permet de
// le remettre a SA place chronologique quand on l'en sort, et pas simplement a la fin de
// « Recents ». Un re-rendu du site les detruit avec le reste, ce qui n'est pas un probleme :
// apres un re-rendu, les items non assignes sont deja au bon endroit.
function cfLeaveSlot(item, uuid) {
  // Un re-rendu du site peut avoir remis l'item dans « Recents » sans detruire le marque-page
  // precedent : on ne garde jamais qu'un seul marque-page par conversation.
  var old = document.querySelector('[' + CF_SLOT + '="' + uuid + '"]');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  var slot = cfNode('div');
  slot.setAttribute(CF_SLOT, uuid);
  slot.hidden = true;
  item.parentNode.insertBefore(slot, item);
}

function cfReturnToSlot(item, uuid, fallback) {
  var slot = document.querySelector('[' + CF_SLOT + '="' + uuid + '"]');
  if (slot && slot.parentNode) {
    slot.parentNode.replaceChild(item, slot);
    return;
  }
  if (fallback) fallback.appendChild(item);
}

// Section native = le parent d'un item qui n'est PAS dans un de nos blocs. Deduite du DOM au
// lieu d'etre ciblee par sa classe (group/section) : une classe Tailwind echappee est
// exactement le genre de selecteur qu'on veut eviter.
function cfNativeSection(scroll, root) {
  var items = scroll.querySelectorAll(CF_ITEM);
  for (var i = 0; i < items.length; i++) {
    if (!root.contains(items[i]) && items[i].parentElement) return items[i].parentElement;
  }
  return null;
}

// ---- rendu -------------------------------------------------------------------

function cfReflow() {
  if (!cfAlive()) return;

  var scroll = document.querySelector(CF_SCROLL);
  if (!scroll) return;   // sidebar pas encore rendue, ou page sans sidebar : pas une erreur
  cfEverFound = true;

  var parent = scroll.querySelector(CF_SECTIONS);
  if (!parent) {
    cfWarn('sections', 'wrapper « ' + CF_SECTIONS + ' » introuvable : les dossiers sont ' +
      'inseres directement dans « ' + CF_SCROLL +' ». Vérifier le tableau des sélecteurs du README.');
    parent = scroll;
  }

  cfStyle();
  var root = cfRoot(parent);

  var bodies = {};
  cfFolders.forEach(function (f) { bodies[f.id] = cfBlock(root, f); });

  // Sert uniquement de destination de repli quand un marque-page a disparu : plus aucun
  // gestionnaire n'est pose dessus.
  var section = cfNativeSection(scroll, root);

  // querySelectorAll rend les liens dans l'ordre du document, donc ceux deja ranges d'abord
  // (nos blocs sont en tete) puis ceux de « Recents » : l'ordre interne d'un dossier est stable
  // d'un passage a l'autre.
  Array.prototype.forEach.call(scroll.querySelectorAll(CF_LINK), function (link) {
    var uuid = folderUuidFromHref(link.getAttribute('href'));
    if (!uuid) return;

    var item = link.closest(CF_ITEM);
    if (!item) {
      cfWarn('item', 'aucun « ' + CF_ITEM + ' » au-dessus du lien de conversation : la sidebar ' +
        'a change de structure, les dossiers ne rangent plus rien. Voir le tableau des ' +
        'sélecteurs du README.');
      return;
    }

    cfBindDrag(link, uuid);

    var target = bodies[cfAssign[uuid]];
    var inFolder = root.contains(item);

    if (target) {
      // Avant le retour anticipe : un item deja a sa place a pu perdre son bouton dans un
      // re-rendu du site, qui reconstruit ses controles sans toucher a notre placement.
      cfAddUnfile(item, link);
      if (item.parentNode === target) return;
      if (!inFolder) cfLeaveSlot(item, uuid);   // premier depart : on marque sa place
      target.appendChild(item);
    } else {
      cfDropUnfile(item);
      if (inFolder) cfReturnToSlot(item, uuid, section);
    }
  });

  // APRES la boucle, jamais avant : un bloc dont le dossier vient d'etre supprime contient
  // encore ses items a l'entree de cfReflow(). Le supprimer d'abord les arracherait du document
  // — les conversations disparaitraient de la sidebar jusqu'au prochain re-rendu du site.
  // folderDelete() ayant libere leurs assignations, la boucle vient de les rendre a « Recents ».
  Array.prototype.forEach.call(root.querySelectorAll('[data-cf-folder]'), function (block) {
    if (!bodies[block.getAttribute('data-cf-folder')]) block.remove();
  });
}

// ---- observation -------------------------------------------------------------

// La sidebar se re-rend a chaque navigation (SPA) et peut charger des conversations plus
// anciennes au scroll : un scan unique au chargement ne tiendrait pas. On observe donc la
// coque, qui survit aux re-rendus, plutot que le conteneur scrollable, qui peut etre remplace.
//
// takeRecords() en fin de passe jette les mutations que cfReflow() vient elle-meme de
// provoquer — sans quoi chaque rendu en declencherait un autre, indefiniment.
function cfSchedule() {
  clearTimeout(cfTimer);
  cfTimer = setTimeout(function () {
    cfWatch();
    cfReflow();
    if (cfObserver) cfObserver.takeRecords();
  }, CF_DEBOUNCE_MS);
}

// Tant que la coque n'existe pas, on se rabat sur documentElement — c'est cher, mais c'est le
// seul moyen de voir la sidebar apparaitre. Des qu'elle est la on RESSERRE dessus : sans ca on
// observerait tout le document en permanence, y compris le flux d'une reponse en cours.
// Reevalue a chaque passe, ce qui rattrape aussi le cas ou la coque serait remplacee.
function cfWatch() {
  var target = document.querySelector(CF_ASIDE) || document.documentElement;
  if (!target || target === cfTarget) return;

  if (cfObserver) cfObserver.disconnect();
  cfObserver = new MutationObserver(cfSchedule);
  cfObserver.observe(target, { childList: true, subtree: true });
  cfTarget = target;
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (!changes.folders && !changes.folderAssignments) return;
  cfLoad().then(cfReflow);
});

cfLoad().then(function () {
  cfWatch();
  cfReflow();

  // Si la structure attendue n'est jamais apparue, on le dit UNE fois, explicitement : c'est le
  // premier message a chercher le jour ou claude.ai remanie sa sidebar.
  //
  // Mais SEULEMENT si la coque existe : une page de connexion n'a pas de sidebar du tout, et
  // s'en plaindre serait crier au loup. Coque presente + conteneur absent = vraie anomalie.
  setTimeout(function () {
    if (cfEverFound || !document.querySelector(CF_ASIDE)) return;
    cfWarn('scroll', 'conteneur « ' + CF_SCROLL + ' » introuvable après ' +
      (CF_GIVE_UP_MS / 1000) + ' s : les dossiers personnalisés sont désactivés et rien n\'a ' +
      'été inséré. La sidebar de claude.ai a probablement changé — voir le tableau des ' +
      'sélecteurs dans le README.');
  }, CF_GIVE_UP_MS);
});
