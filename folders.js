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
    '.cf-bar{display:flex;align-items:center;gap:6px;padding:2px 8px;font-size:11px;opacity:.6}',
    '.cf-bar-label{flex:1;text-transform:uppercase;letter-spacing:.04em}',
    '.cf-btn{all:unset;cursor:pointer;padding:0 5px;border-radius:4px;line-height:1.4}',
    '.cf-btn:hover{background:rgba(128,128,128,.22)}',
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
    '.cf-over{outline:2px dashed currentColor;outline-offset:-2px;border-radius:8px}',
    '.cf-out{padding:5px 8px;margin-top:2px;border:1px dashed rgba(128,128,128,.5);',
      'border-radius:8px;font-size:11px;opacity:.75;text-align:center}',
    '.cf-out[hidden]{display:none}',
    '.cf-menu{position:fixed;z-index:2147483647;min-width:150px;padding:4px;border-radius:8px;' +
      'background:#1c1c1e;color:#f5f5f4;box-shadow:0 6px 24px rgba(0,0,0,.35);' +
      'font:12px/1.5 system-ui,sans-serif}',
    '.cf-menu button{all:unset;display:block;box-sizing:border-box;width:100%;padding:5px 8px;' +
      'border-radius:5px;cursor:pointer}',
    '.cf-menu button:hover{background:rgba(255,255,255,.12)}',
    '.cf-swatches{display:flex;gap:4px;padding:5px 8px}',
    '.cf-swatch{width:14px;height:14px;border-radius:999px;cursor:pointer;' +
      'border:1px solid rgba(255,255,255,.25)}'
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

// ---- menu contextuel ---------------------------------------------------------

function cfCloseMenu() {
  if (cfMenuEl && cfMenuEl.parentNode) cfMenuEl.parentNode.removeChild(cfMenuEl);
  cfMenuEl = null;
}

function cfMenu(folder, x, y) {
  cfCloseMenu();

  var menu = cfNode('div', 'cf-menu');

  var rename = cfNode('button', null, 'Renommer');
  rename.addEventListener('click', function () {
    cfCloseMenu();
    var name = window.prompt('Nouveau nom du dossier', folder.name);
    if (name !== null) cfSaveFolders(folderRename(cfFolders, folder.id, name));
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

  var del = cfNode('button', null, 'Supprimer le dossier');
  del.addEventListener('click', function () {
    cfCloseMenu();
    // Le libelle dit explicitement que les conversations survivent : c'est la question que se
    // pose l'utilisateur devant un « Supprimer ».
    var n = folderCount(cfAssign, folder.id);
    var msg = 'Supprimer le dossier « ' + folder.name + ' » ?\n\n' +
      (n ? 'Ses ' + n + ' conversation' + (n > 1 ? 's' : '') + ' retourneront dans Récents. '
         : '') + 'Aucune conversation ne sera supprimée.';
    if (window.confirm(msg)) cfSaveBoth(folderDelete(cfFolders, cfAssign, folder.id));
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
      var name = window.prompt('Nom du nouveau dossier');
      if (name !== null) cfSaveFolders(folderCreate(cfFolders, name));
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
      if (item.parentNode === target) return;
      if (!inFolder) cfLeaveSlot(item, uuid);   // premier depart : on marque sa place
      target.appendChild(item);
    } else if (inFolder) {
      cfReturnToSlot(item, uuid, section);
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
