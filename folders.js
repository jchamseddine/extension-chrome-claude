// Isolated world, document_idle. Custom folders in claude.ai's sidebar, unrelated
// to the native "Projects". A feature independent of the rest of the extension: reads and
// writes only the "folders" and "folderAssignments" keys, emits no request.
//
// Warning: THIS IS THE MOST FRAGILE FEATURE IN THE REPO. All the others rely on
// data (usage API, Statuspage) or on CSS variables; this one is the only one that manipulates
// the site's native DOM STRUCTURE. A sidebar rework breaks it. Hence three rules:
//
//   1. The anchor point is the LINK, a[href^="/chat/"] — the only selector that rests on
//      data (the conversation URL) and not on a utility class. We then walk up
//      to the movable wrapper with closest('.df-drag-shiftable'), which stays true even if
//      intermediate levels are added or renamed. The item container
//      (div.group.relative[class*="rounded-"]) is NEVER targeted: its class is an arbitrary
//      Tailwind radius.
//   2. Nothing is duplicated: we MOVE claude.ai's real nodes into our blocks. A clone
//      would lose the native click handlers and context menu.
//   3. Structure not found = clean stop. We insert nothing and say so once in the console,
//      rather than cobbling together a display that would break the native sidebar.
//
// No IIFE, "cf"/"CF_" prefix on all top-level names: the extension's content scripts
// share a single isolated world per frame (same constraint as theme.js and
// autocontinue.js).
'use strict';

// ---- selectors ---------------------------------------------------------------
// Confirmed by real DOM inspection. Any future repair starts here — the README
// keeps the table, with each one's role and its fragility.
var CF_ASIDE = 'aside.dframe-sidebar';        // sidebar shell, does not move from one render to the next
var CF_SCROLL = '.dframe-nav-scroll';         // scrollable container — without it, we stop
var CF_SECTIONS = '.dframe-recents-by-mode';  // section wrapper, where we insert ourselves
var CF_LINK = 'a[href^="/chat/"]';            // main anchor
var CF_ITEM = '.df-drag-shiftable';           // movable wrapper, reached with closest()

var CF_ROOT_ID = '__claude_folders_root';
var CF_STYLE_ID = '__claude_folders_style';
var CF_SLOT = 'data-cf-slot';                 // bookmark left in place of a moved item
var CF_DRAG_TYPE = 'application/x-claude-folder';

var CF_DEBOUNCE_MS = 120;
var CF_GIVE_UP_MS = 8000;   // delay before concluding the structure has changed

var cfFolders = [];
var cfAssign = {};
var cfObserver = null;
var cfTarget = null;        // node currently observed, so as not to resubscribe for nothing
var cfTimer = null;
var cfDragging = null;      // uuid currently being dragged: dataTransfer.getData() is unreadable
var cfMenuEl = null;        // during dragover, only the types are
var cfDialogEl = null;      // rename modal open, or null
var cfEverFound = false;
var cfWarned = {};

function cfAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
}

// A single cause must not flood the console on every sidebar re-render.
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
  }, function () { /* invalidated context */ });
}

// We never apply a change directly: we write, and it is storage.onChanged that
// rereads then redraws. A single path, and the other tabs follow along.
function cfSave(patch) {
  if (!cfAlive()) return;
  chrome.storage.local.set(patch).catch(function () {});
}

function cfSaveFolders(folders) { cfSave({ folders: folders }); }

function cfSaveBoth(next) {
  cfSave({ folders: next.folders, folderAssignments: next.assignments });
}

// ---- style -------------------------------------------------------------------

// A single <style>, injected once. The colors are deliberately relative (currentColor,
// semi-transparent greys): the sidebar exists in light and dark, and the theme may on top of that
// have been repainted by theme.js.
function cfStyle() {
  if (document.getElementById(CF_STYLE_ID)) return;

  var css = [
    '#' + CF_ROOT_ID + '{display:flex;flex-direction:column;gap:2px;margin-bottom:6px}',
    // The strip no longer carries vertical padding: it is the button height (24 px, that of the
    // native "…") that now gives the strip's height, otherwise the two added up.
    '.cf-bar{display:flex;align-items:center;gap:6px;padding:0 8px;font-size:11px;opacity:.6}',
    '.cf-bar-label{flex:1;text-transform:uppercase;letter-spacing:.04em}',
    // "all:unset" resets display to inline and clears the font size: both are therefore
    // set again AFTER, otherwise the 24 px square does not exist and the "+" stays at 11 px.
    '.cf-btn{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;' +
      'min-width:24px;min-height:24px;flex:none;border-radius:6px;cursor:pointer;' +
      'font-size:15px;line-height:1}',
    '.cf-btn:hover{background:rgba(128,128,128,.22)}',
    // Same template as the native "…" next to it, whose container it shares. No opacity
    // rule here: it comes from the site's group-hover:/group-focus-within: variants.
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
    // The control container is position:absolute: it PUSHES nothing. The only thing that
    // prevents the title from running underneath is the space the link reserves for it on the right — and the
    // site sizes that for the "…" button ALONE. Our "−" widens the container without
    // that reserve following: hence the title running under both buttons, inside the folders and
    // nowhere else ("Recents" has nothing more to house, and displays fine).
    //
    // So we make the reserve for TWO controls, and only in our blocks. The truncation is
    // set again here even if the link already carries it: it has no effect in that case, but if the site
    // masks the overflow with a gradient rather than an ellipsis, that gradient no longer
    // covers the right zone once the container is widened.
    //
    // Deliberately generous rather than exact: too much reserve truncates the title a little early, which
    // does not show; too little puts it back under the buttons, which is the bug. A single value to
    // adjust if the controls' template changes.
    '.cf-body a[href^="/chat/"]{box-sizing:border-box;min-width:0;overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap;' +
      'padding-right:calc(2 * var(--df-row-ctl,24px) + 12px)}',
    '.cf-over{outline:2px dashed currentColor;outline-offset:-2px;border-radius:8px}',
    '.cf-out{padding:5px 8px;margin-top:2px;border:1px dashed rgba(128,128,128,.5);',
      'border-radius:8px;font-size:11px;opacity:.75;text-align:center}',
    '.cf-out[hidden]{display:none}',

    // ---- context menu and rename modal -------------------------------------------
    //
    // These two are not painted in relative colors like the rest of the file: they
    // COPY two specific native components (a conversation's "…" menu, a conversation's
    // rename modal), and a floating component that looks like nothing around
    // it shows immediately.
    //
    // Each value therefore goes through a token of the site's design system WITH a hard-coded fallback:
    // var(--cds-x, <observed value>). The token names are deduced from their Tailwind classes
    // (bg-surface-3 -> --cds-surface-3) on the model of the only chain confirmed by
    // inspection, bg-fill-brand -> --cds-fill-brand. Deduced, hence fallible — but a wrong
    // name breaks nothing: the observed value takes over. That is what makes this
    // deduction acceptable here when it would not be for theme.js, which WRITES these
    // variables (see the README: "do not add a variable at random").
    //
    // Deliberately NOT --cds-radius or --cds-shadow-{sm,md,lg}, the only tokens the repo
    // already knows: those are the BASE ones, and nothing confirms they equal the rounded-card /
    // shadow-panel observed on these two components. Taking them as equivalent would make
    // our modal diverge from the native modal it copies — that is exactly the flaw we are
    // fixing. On top of that they are already scaled by theme.js for the "corners/shadows" setting.
    '.cf-menu,.cf-modal{' +
      '--cf-surface:var(--cds-surface-3,#fff);' +
      '--cf-text:var(--cds-text-primary,#0b0b0b);' +
      '--cf-hover:var(--cds-fill-ghost-hover,rgba(0,0,0,.06));' +
      '--cf-field:var(--cds-fill-field,rgba(0,0,0,.03));' +
      '--cf-ring:var(--cds-shadow-field-ring,inset 0 0 0 1px rgba(0,0,0,.1));' +
      '--cf-card:var(--cds-radius-card,12px);' +
      // The only red in the repo. NO var(--cds-…) here: the other tokens are deduced from
      // classes actually observed on the copied component, whereas no delete button of the
      // site has been inspected — deducing a name without having seen anything would be the
      // "variable at random" the README forbids. Dark enough to carry white at 7:1
      // in both modes, so a single value is enough.
      '--cf-danger:#b42318;' +
      // The three layers described on the native components: a 1 px translucent border,
      // then two drop shadows of different magnitudes.
      '--cf-panel:var(--cds-shadow-panel,0 0 0 1px rgba(0,0,0,.05),0 6px 20px rgba(0,0,0,.10),' +
        '0 1px 4px rgba(0,0,0,.06));' +
      '--cf-panel-lg:var(--cds-shadow-panel-lg,0 0 0 1px rgba(0,0,0,.05),' +
        '0 12px 40px rgba(0,0,0,.16),0 2px 8px rgba(0,0,0,.08))}',

    // The hard-coded fallbacks, for their part, follow no theme: if the site's token is missing, a white
    // modal would show in dark mode. This rule redefines ONLY the fallback part, the
    // site's value staying authoritative when it exists. It follows the system preference, not
    // claude.ai's setting — which we have no reliable way to read: it is a fallback of a fallback.
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

    // font-family:inherit and not a named font: the menu is appended to documentElement, so it
    // inherits the site's font — including the one theme.js may have set.
    '.cf-menu{position:fixed;z-index:2147483647;min-width:128px;max-width:320px;padding:4px;' +
      'border-radius:var(--cf-card);background:var(--cf-surface);color:var(--cf-text);' +
      'box-shadow:var(--cf-panel);font-family:inherit;font-size:14px;line-height:1.4}',
    // "all:unset" resets display to inline and clears the font size: both are set again
    // AFTER, as for .cf-btn above.
    '.cf-item{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;' +
      'width:100%;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:14px}',
    '.cf-item:hover,.cf-item:focus-visible{background:var(--cf-hover)}',
    // 20 px: the native icons' template. The site's ligature font (Anthropicons) is
    // not replicated — we keep the SVG stroke of the extension's other buttons (export.js).
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
    // The primary button is the INVERSE of the box, not a hard-coded color: dark background on
    // light text in light mode, and the opposite in dark mode, without our having to name one
    // more token or to know which mode we are in.
    '.cf-modal-btn-primary{background:var(--cf-text);color:var(--cf-surface)}',
    '.cf-modal-btn-primary:hover{background:var(--cf-text);opacity:.85}',
    // Red and not "dark primary": a deletion must not look like a save
    // at the moment you aim at it.
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

// ---- drag and drop -----------------------------------------------------------
//
// FIXED BUG (seen in real use): dropping a conversation on a custom folder PINNED it
// in the native "Épinglé" section instead of assigning it. The handlers were nevertheless
// already calling preventDefault() and stopPropagation() — so that was not the cause. Two real
// flaws, each sufficient to reproduce the symptom:
//
//   1. DRAG RECOGNITION. The test was done on dataTransfer.types. But the site
//      installs its own dragstart handler, and a drag implementation commonly
//      calls dataTransfer.clearData() before writing ITS type — which erases ours.
//      Our dragover then recognized nothing anymore, hence did not call preventDefault(),
//      hence the drop was not even ALLOWED on our blocks: the browser sent it back to the
//      site's logic, which pinned. So we no longer rely on dataTransfer at all to
//      IDENTIFY the drag — cfDragging, set at dragstart, is authoritative.
//
//   2. LISTENING PHASE. stopPropagation() in the bubbling phase comes too late if the
//      site listens in the CAPTURE phase on an ancestor: capture descends from the top, so its
//      handler ran BEFORE ours. And our blocks are inside
//      .dframe-nav-scroll, hence under any ancestor of the site. We now intercept
//      on WINDOW in capture: it is the very first point of an event's trajectory,
//      before any handler installed on a descendant, whatever its registration order.
//
// Deliberate consequence: NO handler is installed on the native elements anymore. We
// act only if the target is in our subtree AND a conversation drag is in
// progress; everywhere else, the event passes intact and the native drag (reordering,
// pinning) works exactly as before.

// Marks the zones that accept a drop: value = folder id, or '' for "remove".
var CF_DROP_ATTR = 'data-cf-drop';

// A drop zone OF OURS under this target, null otherwise. The "inside our root" test is what
// guarantees we never tread on the site's turf.
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

// The "Retirer du dossier" strip only makes sense if the dragged conversation is indeed
// filed somewhere. Called without an argument, it just hides the strip.
function cfShowOutZone(uuid) {
  var root = document.getElementById(CF_ROOT_ID);
  var out = root && root.querySelector('.cf-out');
  if (!out) return;

  var id = uuid || cfDragging;
  out.hidden = !(id && cfAssign[id]);
}

// dataTransfer now only serves to RETRIEVE the uuid, and only as a backup: cfDragging is the
// reliable source, since it survives a clearData() by the site.
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

// We do NOT set draggable="true": an <a href> is natively. We only add our data
// type, without preventDefault, so the site's drag system keeps receiving
// what it expects when the drop does not concern us.
function cfBindDrag(link, uuid) {
  if (link.__cfDrag) return;
  link.__cfDrag = true;

  link.addEventListener('dragstart', function (e) {
    cfDragging = uuid;
    cfShowOutZone();
    try { e.dataTransfer.setData(CF_DRAG_TYPE, uuid); } catch (err) { /* harmless */ }
  });
  link.addEventListener('dragend', function () {
    cfDragging = null;
    cfHighlight(null);
    cfShowOutZone();
  });
}

// ---- "−" button (remove from folder) -----------------------------------------
//
// Drag and drop already takes a conversation out of a folder ("Retirer" strip), but that is a
// gesture; this button is the one-click equivalent. It does NOT duplicate the logic: it calls the
// same cfApplyDrop('', uuid) as the drop on the strip.
//
// It is inserted INSIDE the item's native control container — the one that already carries the
// "…" button — and not next to it: that container is hidden at rest and revealed by the
// group-hover:/group-focus-within: variants the site puts on the item. By settling there, the button
// inherits exactly the same appearance behavior, without our managing a single opacity.
//
// That container is reached through the PARENT of the item's first button that is not ours.
// Targeting the "…" aria-label ("Plus d'options pour…") would depend on the interface language,
// and its classes are utility ones: neither is an acceptable anchor here.
//
// The button carries NO handler: the click is intercepted on window in capture, further down.
function cfCtlBar(item) {
  var buttons = item.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    if (!buttons[i].classList.contains('cf-unfile')) return buttons[i].parentElement;
  }
  return null;
}

// Placed ONLY on items filed in a folder: an item from "Recents" has no
// folder to leave. Container not found = we insert nothing and say so once, rather than
// sticking the button elsewhere in the item, where it would be permanently visible.
function cfAddUnfile(item, link) {
  var bar = cfCtlBar(item);
  if (!bar) {
    cfWarn('ctl', 'no native button in the conversation item: the "−" removal button ' +
      'is not inserted. Removal by drag and drop onto the "Retirer du dossier" strip ' +
      'stays available. See the selector table in the README.');
    return;
  }
  if (bar.querySelector('.cf-unfile')) return;

  var btn = cfNode('button', 'cf-unfile', '−');   // U+2212, not a hyphen
  btn.type = 'button';

  var title = (link.textContent || '').replace(/\s+/g, ' ').trim();
  btn.setAttribute('aria-label',
    'Retirer ' + (title ? '« ' + title + ' »' : 'cette conversation') + ' du dossier');
  btn.title = 'Retirer du dossier';

  bar.insertBefore(btn, bar.firstChild);
}

// The items are MOVED, never rebuilt: the one going back to "Recents" would take
// our button with it if we did not remove it here.
function cfDropUnfile(item) {
  var btn = item.querySelector('.cf-unfile');
  if (btn) btn.remove();
}

// FIXED BUG (seen in real use): the FIRST click on "−" did nothing, the next one — and all
// the ones after — worked, without reloading the page.
//
// The handler was installed on the button, hence in the BUBBLING phase. It only takes a
// site handler installed in CAPTURE on an ancestor calling stopPropagation() for the click
// to NEVER reach the button: capture descends from window, so it goes first. And a
// drag library commonly arms a SINGLE-USE "click swallower" at the end of a gesture,
// so that the click following a drag triggers nothing — hence "the first click only,
// then never again". Our own pointer fallback contributes to it: it deprives the site of its pointerup
// and sends it an Escape so it cancels, which is precisely an end of gesture.
//
// This is flaw no. 2 of the pinning bug (see above), at the same place in the file and fixed
// the same way: interception on WINDOW in capture, the very first point of the trajectory.
// Our content script registers at page load, hence before any swallower armed later
// by a gesture.
//
// Delegation settles the lifecycle along the way: the button is destroyed and recreated on every
// sidebar re-render, and no instance carries a handler to (re)wire anymore.
function cfOnUnfileClick(e) {
  if (!e.target || typeof e.target.closest !== 'function') return;

  var btn = e.target.closest('.cf-unfile');
  if (!btn) return;

  // The button is a sibling of the link, not a descendant: the click does not navigate by itself. We
  // neutralize it anyway, so it reaches no row handler of the site.
  e.preventDefault();
  e.stopPropagation();

  // The uuid is reread from the DOM rather than kept in a closure: it is the same rule as
  // everywhere else — it can only be obtained from the link's href — and there is no closure anymore.
  var item = btn.closest(CF_ITEM);
  var link = item && item.querySelector(CF_LINK);
  if (link) cfApplyDrop('', folderUuidFromHref(link.getAttribute('href')));
}

window.addEventListener('click', cfOnUnfileClick, true);

// ---- interception (window, capture phase) ------------------------------------

function cfOnDragOver(e) {
  if (!cfDragging) return;   // not a conversation drag: we touch nothing

  var zone = cfZoneAt(e.target);
  if (!zone) { cfHighlight(null); return; }

  // preventDefault on dragover is what ALLOWS the drop: without it, the browser refuses
  // the target and the drag falls back to the site's logic.
  e.preventDefault();
  e.stopPropagation();
  try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* harmless */ }
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

// ---- pointer fallback --------------------------------------------------------
//
// "df-drag-shiftable" suggests a POINTER drag (the items move apart on hover),
// not HTML5 drag-and-drop. In that case no dragstart/dragover/drop is emitted and everything
// above stays silent. This fallback therefore arms itself ONLY if no dragstart has been seen for the
// current gesture (cfDragging stayed null): the two paths cannot fire
// together, and it is the browser that chooses, not us.
var CF_POINTER_SLOP = 6;   // below that, it is a click, not a drag
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

  if (!drag || !drag.moved || cfDragging) return;   // plain click, or HTML5 path already active

  var zone = cfZoneAt(document.elementFromPoint(e.clientX, e.clientY));
  if (!zone) return;   // released elsewhere: the site does what it wants, including pinning

  e.preventDefault();
  e.stopPropagation();
  cfApplyDrop(zone.getAttribute(CF_DROP_ATTR), drag.uuid);

  // We have just deprived the site of its pointerup: without this its drag would stay suspended.
  // Escape is the conventional exit of drag libraries to cancel cleanly.
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true
    }));
  } catch (err) { /* harmless */ }
}

window.addEventListener('pointerdown', cfOnPointerDown, true);
window.addEventListener('pointermove', cfOnPointerMove, true);
window.addEventListener('pointerup', cfOnPointerUp, true);

// ---- modals ------------------------------------------------------------------
//
// Replace window.prompt (creation, renaming) and window.confirm (deletion). Those three
// are BROWSER components: they show at the top of the window, far from the folder
// you have just targeted, and follow neither claude.ai's theme nor the one set by theme.js. Our
// modals copy the site's ones — same centred box, same dimmed backdrop, same two buttons.
//
// An INPUT and a CONFIRMATION share the shell (overlay, box, title, button bar,
// Escape, click on the backdrop, keystrokes held back) and nothing else: different body, different
// guard, different Enter key. Hence two thin functions over a common shell, rather
// than a single one with optional parameters — which would be longer to read than the two combined.
//
// Independent of the rest: they know only folders-source.js, like this whole file.

function cfCloseDialog() {
  if (cfDialogEl && cfDialogEl.parentNode) cfDialogEl.parentNode.removeChild(cfDialogEl);
  cfDialogEl = null;
}

function cfModalBtn(label, variant) {
  var btn = cfNode('button', 'cf-modal-btn' + (variant ? ' ' + variant : ''), label);
  btn.type = 'button';
  return btn;
}

// The shell knows nothing of what it contains: the caller supplies the body (field or message)
// and its already-wired action button. It only adds « Annuler » and the three ways to close
// without acting — button, Escape, click on the backdrop.
function cfShell(title, body, action) {
  cfCloseDialog();

  var overlay = cfNode('div', 'cf-modal');
  var box = cfNode('div', 'cf-modal-box');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');

  var cancel = cfModalBtn('Annuler');
  cancel.addEventListener('click', cfCloseDialog);

  // The dimmed backdrop, and only it: a click inside the box closes nothing.
  overlay.addEventListener('mousedown', function (e) {
    if (e.target === overlay) cfCloseDialog();
  });

  // No keystroke made in the modal must reach the site: claude.ai listens to the keyboard
  // on the document for its own shortcuts, and a letter typed here has no business there.
  // It is the same concern as the rest of the file, in the other direction — here we hold back our
  // events rather than intercept its ones, so bubbling is enough: they start
  // from the box, they necessarily pass through the overlay before leaving it.
  //
  // The shell only handles Escape: it is the only key that means the same thing in both
  // modals. Enter belongs only to the input, which wires it onto its own field.
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

// Entering a name: creation (empty field) as well as renaming (pre-filled field).
function cfDialog(title, value, actionLabel, onSave) {
  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'cf-modal-input';
  input.value = value;
  input.setAttribute('aria-label', title);
  // The cleanup already cuts at this length: bounding it here avoids typing text that
  // would silently disappear on save.
  input.maxLength = FOLDER_NAME_MAX;

  var save = cfModalBtn(actionLabel, 'cf-modal-btn-primary');

  // The greyed-out button and the Enter key ask the SAME question, written once.
  function sync() { save.disabled = !folderNameSubmittable(input.value); }

  // An empty field does not close the modal: closing it without writing anything would read as a
  // successful save. We close BEFORE calling onSave, so that the storage write and the
  // redraw it triggers no longer find the modal open.
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
  input.select();   // pre-selected: when renaming, retyping is enough to replace the name
}

// Confirmation of a destructive action: no field, hence nothing to validate and no button
// ever greyed out — the guard is not in the input, it is in the gesture asked for.
//
// It is « Annuler » that takes the focus, not the red button: Enter and Escape therefore both
// close without destroying anything, and confirming requires an explicit gesture. The opposite of a
// window.confirm, whose Enter key confirms.
function cfConfirm(title, message, actionLabel, onConfirm) {
  var act = cfModalBtn(actionLabel, 'cf-modal-btn-danger');
  act.addEventListener('click', function () {
    cfCloseDialog();
    onConfirm();
  });

  cfShell(title, cfNode('div', 'cf-modal-message', message), act).focus();
}

// ---- context menu ------------------------------------------------------------

function cfCloseMenu() {
  if (cfMenuEl && cfMenuEl.parentNode) cfMenuEl.parentNode.removeChild(cfMenuEl);
  cfMenuEl = null;
}

// Stroke icon, like those of export.js: the menu's native icons go through a proprietary
// ligature font (Anthropicons), which we do not try to replicate. Only the
// container and the text formatting copy the native one.
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

// Structure of the native item: an icon of fixed template, then a label that takes the remaining
// space and truncates. The keyboard shortcut of the third span has no equivalent on our side.
function cfItem(label, d) {
  var btn = cfNode('button', 'cf-item');
  btn.type = 'button';
  btn.setAttribute('role', 'menuitem');
  btn.appendChild(cfIcon(d));
  btn.appendChild(cfNode('span', 'cf-item-label', label));
  return btn;
}

// Pencil and bin, stroked. The pencil's arc radius (3) covers the chord of 5.66: below
// that, the browser resizes the radii itself and the arc distorts.
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

  // Fixed position, then corrected if the menu overflows at the bottom or on the right.
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

// ---- folder blocks -----------------------------------------------------------

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

    // Dropping on the header OR in the body files into this folder — aiming at a 4 px strip
    // when the folder is empty would be unplayable. The interception lives on window (see
    // above): these attributes are all it needs to find.
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
      // Empty field, and not a default name: a pre-filled « Dossier 1 » would be confirmed by an
      // absent-minded Enter, and would then have to be renamed.
      cfDialog('Nouveau dossier', '', 'Créer', function (name) {
        cfSaveFolders(folderCreate(cfFolders, name));
      });
    });
    bar.appendChild(add);
    root.appendChild(bar);

    // Taking a conversation out of a folder happens on THIS strip, ours, and no longer by a
    // drop on the native « Récents » section. Installing a handler on a site element
    // was precisely what could trigger its pinning: from now on no native
    // element carries anything of ours. It only appears while
    // dragging a conversation already filed — otherwise it would make no sense.
    var out = cfNode('div', 'cf-out', 'Retirer du dossier');
    out.setAttribute(CF_DROP_ATTR, '');
    out.hidden = true;
    root.appendChild(out);
  }

  // Above the native sections, and put back at the top if a re-render inserted something
  // before us.
  if (root.parentNode !== parent || parent.firstChild !== root) {
    parent.insertBefore(root, parent.firstChild);
  }
  return root;
}

// ---- moving the items --------------------------------------------------------

// Bookmark left at the exact place of an item filed into a folder. That is what allows
// putting it back in ITS chronological place when it is taken out, and not simply at the end of
// "Recents". A site re-render destroys them along with the rest, which is not a problem:
// after a re-render, the unassigned items are already in the right place.
function cfLeaveSlot(item, uuid) {
  // A site re-render may have put the item back into "Recents" without destroying the previous
  // bookmark: we never keep more than one bookmark per conversation.
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

// Native section = the parent of an item that is NOT in one of our blocks. Deduced from the DOM
// instead of being targeted by its class (group/section): an escaped Tailwind class is
// exactly the kind of selector we want to avoid.
function cfNativeSection(scroll, root) {
  var items = scroll.querySelectorAll(CF_ITEM);
  for (var i = 0; i < items.length; i++) {
    if (!root.contains(items[i]) && items[i].parentElement) return items[i].parentElement;
  }
  return null;
}

// ---- render ------------------------------------------------------------------

function cfReflow() {
  if (!cfAlive()) return;

  var scroll = document.querySelector(CF_SCROLL);
  if (!scroll) return;   // sidebar not rendered yet, or page without a sidebar: not an error
  cfEverFound = true;

  var parent = scroll.querySelector(CF_SECTIONS);
  if (!parent) {
    cfWarn('sections', 'wrapper "' + CF_SECTIONS + '" not found: the folders are ' +
      'inserted directly into "' + CF_SCROLL +'". Check the selector table in the README.');
    parent = scroll;
  }

  cfStyle();
  var root = cfRoot(parent);

  var bodies = {};
  cfFolders.forEach(function (f) { bodies[f.id] = cfBlock(root, f); });

  // Only serves as a fallback destination when a bookmark has vanished: no handler
  // is installed on it anymore.
  var section = cfNativeSection(scroll, root);

  // querySelectorAll returns the links in document order, hence the already-filed ones first
  // (our blocks are at the top) then those of "Recents": the internal order of a folder is stable
  // from one pass to the next.
  Array.prototype.forEach.call(scroll.querySelectorAll(CF_LINK), function (link) {
    var uuid = folderUuidFromHref(link.getAttribute('href'));
    if (!uuid) return;

    var item = link.closest(CF_ITEM);
    if (!item) {
      cfWarn('item', 'no "' + CF_ITEM + '" above the conversation link: the sidebar ' +
        'has changed structure, the folders no longer file anything. See the selector ' +
        'table in the README.');
      return;
    }

    cfBindDrag(link, uuid);

    var target = bodies[cfAssign[uuid]];
    var inFolder = root.contains(item);

    if (target) {
      // Before the early return: an item already in its place may have lost its button in a
      // site re-render, which rebuilds its controls without touching our placement.
      cfAddUnfile(item, link);
      if (item.parentNode === target) return;
      if (!inFolder) cfLeaveSlot(item, uuid);   // first departure: we mark its place
      target.appendChild(item);
    } else {
      cfDropUnfile(item);
      if (inFolder) cfReturnToSlot(item, uuid, section);
    }
  });

  // AFTER the loop, never before: a block whose folder has just been deleted still contains
  // its items when cfReflow() is entered. Removing it first would tear them out of the document
  // — the conversations would disappear from the sidebar until the next site re-render.
  // Since folderDelete() has freed their assignments, the loop has just returned them to "Recents".
  Array.prototype.forEach.call(root.querySelectorAll('[data-cf-folder]'), function (block) {
    if (!bodies[block.getAttribute('data-cf-folder')]) block.remove();
  });
}

// ---- observation -------------------------------------------------------------

// The sidebar re-renders on every navigation (SPA) and can load older conversations
// on scroll: a single scan at load time would not hold. So we observe the
// shell, which survives the re-renders, rather than the scrollable container, which can be replaced.
//
// takeRecords() at the end of a pass discards the mutations cfReflow() has itself just
// caused — without which each render would trigger another, indefinitely.
function cfSchedule() {
  clearTimeout(cfTimer);
  cfTimer = setTimeout(function () {
    cfWatch();
    cfReflow();
    if (cfObserver) cfObserver.takeRecords();
  }, CF_DEBOUNCE_MS);
}

// As long as the shell does not exist, we fall back on documentElement — it is expensive, but it is the
// only way to see the sidebar appear. As soon as it is there we NARROW onto it: without that we
// would observe the whole document permanently, including the stream of a reply in progress.
// Re-evaluated on every pass, which also catches the case where the shell would be replaced.
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

  // If the expected structure never appeared, we say so ONCE, explicitly: it is the
  // first message to look for the day claude.ai reworks its sidebar.
  //
  // But ONLY if the shell exists: a login page has no sidebar at all, and
  // complaining about it would be crying wolf. Shell present + container absent = a real anomaly.
  setTimeout(function () {
    if (cfEverFound || !document.querySelector(CF_ASIDE)) return;
    cfWarn('scroll', 'container "' + CF_SCROLL + '" not found after ' +
      (CF_GIVE_UP_MS / 1000) + ' s: custom folders are disabled and nothing was ' +
      'inserted. claude.ai\'s sidebar has probably changed — see the selector ' +
      'table in the README.');
  }, CF_GIVE_UP_MS);
});
