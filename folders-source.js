// The only "data" adaptation point of custom folders, and the only brick shared
// between the page and the tests. PURE logic: no DOM, no chrome.*, no fetch — that is what
// makes it testable as-is by test-folders.js, with the same vm.runInContext technique
// as usage-source.js and theme.js.
//
// Everything touching the sidebar's DOM STRUCTURE is in folders.js, deliberately
// separate: that is the fragile part, the one that will break if claude.ai reworks its sidebar, and it
// must not drag the filing logic down with it.
//
// A feature independent of the rest of the extension: nothing in common with usage-source.js,
// status-source.js, theme.js or autocontinue-source.js.
'use strict';

var FOLDER_KEYS = ['folders', 'folderAssignments'];

// FIXED palette: we do not pick a free color, we pick one from these. A
// free color picker would allow writing grey on grey, and the 8 px dot only has
// value if the colors can be told apart at a glance. The first one is claude.ai's
// accent (--cds-clay-emphasized).
var FOLDER_COLORS = ['#c6613f', '#e0913a', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899'];

var FOLDER_NAME_MAX = 40;

// Generated identifiers are of the form "f12", but storage is editable by hand: we
// impose a form without a quote or a bracket, because folders.js finds its blocks again through a
// [data-cf-folder="<id>"] selector. A free-form id would be a selector injection there.
var FOLDER_ID_RE = /^[a-z0-9_-]{1,32}$/i;

// The conversation uuid can ONLY be obtained from the link's href: the sidebar carries no
// dedicated data-attribute. The uuid shape is required explicitly, otherwise "/chat/new" would pass for a
// conversation. Searched anywhere in the string, not only at the start: the href can be
// absolute (https://claude.ai/chat/<uuid>) as well as relative.
var FOLDER_CHAT_RE = /\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function folderUuidFromHref(href) {
  if (typeof href !== 'string') return null;

  var m = FOLDER_CHAT_RE.exec(href);
  return m ? m[1].toLowerCase() : null;
}

// ---- normalization -----------------------------------------------------------

function folderCleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, FOLDER_NAME_MAX);
}

// A color outside the palette falls back to the first one: storage is editable by hand from
// the console, and a free value would break the readability the palette guarantees.
function folderCleanColor(raw) {
  return FOLDER_COLORS.indexOf(raw) === -1 ? FOLDER_COLORS[0] : raw;
}

// ---- modals ------------------------------------------------------------------
//
// The only modal decisions (input and confirmation) that do not depend on the DOM. They
// live here like everything verifiable; folders.js only keeps their display.

// A name that does not survive the cleanup is refused. It is the SAME condition for the
// Enter key and for the action button, on creation as on renaming: if one of the three
// closed the modal without writing anything, it would read as a successful save.
function folderNameSubmittable(raw) {
  return folderCleanName(raw) !== '';
}

// The body of the delete confirmation. Here and not in folders.js for the same reason as
// the rest: it is text that depends on a count, hence something that can be wrong, hence
// something testable.
//
// The last sentence is constant and deliberate: "does this delete my conversations?"
// is THE question you ask yourself in front of a "Supprimer" button, and a confirmation that does not
// answer it forces you to look elsewhere.
function folderDeleteMessage(count) {
  // "n > 0" rather than "|| 0": it also brings a negative or unreadable count back to the empty case,
  // which is the only text that stays true whatever happens.
  var n = Number(count);
  if (!(n > 0)) n = 0;

  var sort = n === 0
    ? 'Ce dossier est vide.'
    : n === 1
      ? 'La conversation qu\'il contient retournera dans « Récents ».'
      : 'Les ' + n + ' conversations qu\'il contient retourneront dans « Récents ».';

  return sort + ' Aucune conversation ne sera supprimée.';
}

// What a key is worth in the modal. We intercept only two; everything else (typing,
// Tab, arrows) is left to the browser. Enter submits because a single-line text
// field has nothing else to do with that key — claude.ai's native modal requires a click,
// which is defensible for a form and not for a folder name.
function folderDialogKeyAction(key) {
  if (key === 'Escape') return 'cancel';
  if (key === 'Enter') return 'submit';
  return null;
}

// An entry without an id or without a usable name is DISCARDED, not repaired: a ghost folder without
// a name would be impossible to target for deletion.
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

// Assignments pointing to a vanished folder are ignored at READ time, on top
// of being cleaned up at deletion: storage may have been edited by hand, or a
// deletion may have been interrupted between the two writes.
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

// ---- folders -----------------------------------------------------------------

// Identifiers "f1", "f2"… derived from the largest existing one, and not Math.random(): creation
// stays testable, and storage reread by hand stays readable. The gap left by a deleted
// folder is never reused as long as a larger id exists, so no orphan
// assignment can end up attached to the wrong folder.
function folderNewId(folders) {
  var max = 0;
  (folders || []).forEach(function (f) {
    var m = /^f(\d+)$/.exec(f.id);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return 'f' + (max + 1);
}

// First unused color: two folders created in a row are distinguishable without asking
// the user a second time. Beyond eight, we recycle.
function folderNextColor(folders) {
  var used = {};
  (folders || []).forEach(function (f) { used[f.color] = true; });

  for (var i = 0; i < FOLDER_COLORS.length; i++) {
    if (!used[FOLDER_COLORS[i]]) return FOLDER_COLORS[i];
  }
  return FOLDER_COLORS[folders.length % FOLDER_COLORS.length];
}

// All the operations below return a NEW array (or a new map) and never
// modify the input: the caller writes the result to storage, and the current state stays
// the one reread by storage.onChanged. An empty name or an unknown id returns the input as-is,
// without error — cancelling a prompt must break nothing.
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

// Deleting a folder FREES its conversations: they become unassigned again and
// go back to "Récents". The conversation itself is never touched — this
// extension has no way of deleting one, and must never have one.
function folderDelete(folders, assignments, id) {
  return {
    folders: folders.filter(function (f) { return f.id !== id; }),
    assignments: folderFreeAll(assignments, id)
  };
}

// ---- assignments -------------------------------------------------------------

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
