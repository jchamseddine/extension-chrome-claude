// Seul point d'adaptation « donnees » des dossiers personnalises, et seule brique partagee
// entre la page et les tests. Logique PURE : aucun DOM, aucun chrome.*, aucun fetch — c'est ce
// qui la rend testable telle quelle par test-folders.js, avec le meme procede vm.runInContext
// que usage-source.js et theme.js.
//
// Tout ce qui touche a la STRUCTURE DOM de la sidebar est dans folders.js, volontairement
// separe : c'est la partie fragile, celle qui cassera si claude.ai remanie sa sidebar, et elle
// ne doit pas entrainer la logique de rangement avec elle.
//
// Fonctionnalite independante du reste de l'extension : rien de commun avec usage-source.js,
// status-source.js, theme.js ni autocontinue-source.js.
'use strict';

var FOLDER_KEYS = ['folders', 'folderAssignments'];

// Palette FIXE : on ne choisit pas une couleur libre, on en pioche une parmi celles-ci. Un
// selecteur de couleur libre laisserait ecrire du gris sur gris, et la pastille de 8 px n'a de
// valeur que si les couleurs se distinguent d'un coup d'oeil. La premiere est l'accent de
// claude.ai (--cds-clay-emphasized).
var FOLDER_COLORS = ['#c6613f', '#e0913a', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899'];

var FOLDER_NAME_MAX = 40;

// Les identifiants generes sont de la forme "f12", mais le storage est editable a la main : on
// impose une forme sans guillemet ni crochet, parce que folders.js retrouve ses blocs par un
// selecteur [data-cf-folder="<id>"]. Un id libre y serait une injection de selecteur.
var FOLDER_ID_RE = /^[a-z0-9_-]{1,32}$/i;

// L'uuid de conversation ne s'obtient QUE par le href du lien : la sidebar ne porte aucun
// data-attribute dedie. Forme uuid exigee explicitement, sinon « /chat/new » passerait pour une
// conversation. Cherche partout dans la chaine, pas seulement en tete : le href peut etre
// absolu (https://claude.ai/chat/<uuid>) comme relatif.
var FOLDER_CHAT_RE = /\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function folderUuidFromHref(href) {
  if (typeof href !== 'string') return null;

  var m = FOLDER_CHAT_RE.exec(href);
  return m ? m[1].toLowerCase() : null;
}

// ---- normalisation -----------------------------------------------------------

function folderCleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, FOLDER_NAME_MAX);
}

// Une couleur hors palette retombe sur la premiere : le storage est editable a la main depuis
// la console, et une valeur libre casserait la lisibilite que la palette garantit.
function folderCleanColor(raw) {
  return FOLDER_COLORS.indexOf(raw) === -1 ? FOLDER_COLORS[0] : raw;
}

// Une entree sans id ou sans nom exploitable est JETEE, pas reparee : un dossier fantome sans
// nom serait impossible a viser pour le supprimer.
function folderList(stored) {
  var raw = stored && stored.folders;
  if (!Array.isArray(raw)) return [];

  var out = [];
  var seen = {};

  raw.forEach(function (f) {
    if (!f || typeof f.id !== 'string' || !FOLDER_ID_RE.test(f.id) || seen[f.id]) return;
    var name = folderCleanName(f.name);
    if (!name) return;

    seen[f.id] = true;
    out.push({
      id: f.id,
      name: name,
      color: folderCleanColor(f.color),
      collapsed: f.collapsed === true
    });
  });

  return out;
}

// Les assignations qui pointent vers un dossier disparu sont ignorees a la LECTURE, en plus
// d'etre nettoyees a la suppression : le storage peut avoir ete edite a la main, ou une
// suppression avoir ete interrompue entre les deux ecritures.
function folderAssignmentMap(stored, folders) {
  var raw = stored && stored.folderAssignments;
  if (!raw || typeof raw !== 'object') return {};

  var known = {};
  (folders || []).forEach(function (f) { known[f.id] = true; });

  var out = {};
  Object.keys(raw).forEach(function (uuid) {
    var id = raw[uuid];
    if (typeof id === 'string' && known[id]) out[uuid] = id;
  });
  return out;
}

function folderById(folders, id) {
  for (var i = 0; i < (folders || []).length; i++) {
    if (folders[i].id === id) return folders[i];
  }
  return null;
}

function folderCount(assignments, id) {
  var n = 0;
  Object.keys(assignments || {}).forEach(function (uuid) {
    if (assignments[uuid] === id) n++;
  });
  return n;
}

// ---- dossiers ----------------------------------------------------------------

// Identifiants "f1", "f2"… deduits du plus grand existant, et pas Math.random() : la creation
// reste testable, et le storage relu a la main reste lisible. Le trou laisse par un dossier
// supprime n'est jamais reutilise tant qu'un id plus grand existe, donc aucune assignation
// orpheline ne peut se retrouver rattachee au mauvais dossier.
function folderNewId(folders) {
  var max = 0;
  (folders || []).forEach(function (f) {
    var m = /^f(\d+)$/.exec(f.id);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return 'f' + (max + 1);
}

// Premiere couleur non utilisee : deux dossiers crees a la suite se distinguent sans demander
// une seconde fois a l'utilisateur. Au-dela de huit, on recycle.
function folderNextColor(folders) {
  var used = {};
  (folders || []).forEach(function (f) { used[f.color] = true; });

  for (var i = 0; i < FOLDER_COLORS.length; i++) {
    if (!used[FOLDER_COLORS[i]]) return FOLDER_COLORS[i];
  }
  return FOLDER_COLORS[folders.length % FOLDER_COLORS.length];
}

// Toutes les operations ci-dessous rendent un NOUVEAU tableau (ou une nouvelle map) et ne
// modifient jamais l'entree : l'appelant ecrit le resultat en storage, et l'etat courant reste
// celui relu par storage.onChanged. Un nom vide ou un id inconnu rend l'entree telle quelle,
// sans erreur — annuler un prompt ne doit rien casser.
function folderCreate(folders, name) {
  var clean = folderCleanName(name);
  if (!clean) return folders;

  return folders.concat([{
    id: folderNewId(folders),
    name: clean,
    color: folderNextColor(folders),
    collapsed: false
  }]);
}

function folderPatch(folders, id, patch) {
  if (!folderById(folders, id)) return folders;

  return folders.map(function (f) {
    if (f.id !== id) return f;
    var next = { id: f.id, name: f.name, color: f.color, collapsed: f.collapsed };
    Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
    return next;
  });
}

function folderRename(folders, id, name) {
  var clean = folderCleanName(name);
  return clean ? folderPatch(folders, id, { name: clean }) : folders;
}

function folderRecolor(folders, id, color) {
  return folderPatch(folders, id, { color: folderCleanColor(color) });
}

function folderToggle(folders, id) {
  var f = folderById(folders, id);
  return f ? folderPatch(folders, id, { collapsed: !f.collapsed }) : folders;
}

// Supprimer un dossier LIBERE ses conversations : elles redeviennent non assignees et
// retournent dans « Recents ». La conversation elle-meme n'est jamais touchee — cette
// extension n'a aucun moyen d'en supprimer une, et ne doit jamais en avoir.
function folderDelete(folders, assignments, id) {
  return {
    folders: folders.filter(function (f) { return f.id !== id; }),
    assignments: folderFreeAll(assignments, id)
  };
}

// ---- assignations ------------------------------------------------------------

function folderAssign(assignments, uuid, id) {
  if (!uuid || !id) return assignments;

  var out = {};
  Object.keys(assignments || {}).forEach(function (k) { out[k] = assignments[k]; });
  out[uuid] = id;
  return out;
}

function folderUnassign(assignments, uuid) {
  var out = {};
  Object.keys(assignments || {}).forEach(function (k) {
    if (k !== uuid) out[k] = assignments[k];
  });
  return out;
}

function folderFreeAll(assignments, id) {
  var out = {};
  Object.keys(assignments || {}).forEach(function (uuid) {
    if (assignments[uuid] !== id) out[uuid] = assignments[uuid];
  });
  return out;
}
