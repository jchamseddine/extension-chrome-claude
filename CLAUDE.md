# Project context

Personal Chrome extension (Manifest V3), never meant for the Web Store, which displays:
1. Session (5h) and weekly (7d) usage on claude.ai
2. The % of context used in the current conversation (a feature missing from existing tools)
3. Claude's status as read from status.claude.com

## Repo state

The repo holds the finished extension. The discovery sniffer (Phase 1) no longer exists as such:
all that remains is the cleanup of its `sniff:` keys in `onInstalled`.

Note: the public ClaudeKarma repo (jrlprost/ClaudeKarma and jrlprost/claudekarma_browser)
cannot be found (404 at both addresses) — no external reference code available.
Everything comes from our own network discovery.

Three data sources, deliberately kept separate:

- **Usage (5 h / 7 d)** — polled every 60 s by the service worker (`chrome.alarms`), written
  to the `usage` key. Extracting it from the `message_limit` SSE event has been **abandoned**:
  too fragile, and the data only moved after a message was sent.
- **Context estimation** — always passive, through the `fetch` patch in `inject.js` (size of the
  conversation GET + sent payloads + streamed text). No network call is emitted.
- **Status** — `GET https://status.claude.com/api/v2/summary.json` (public Statuspage,
  unauthenticated) polled every 5 min by a separate alarm, written to the `status` key.
  `parseStatus()` in `status-source.js` shares nothing with the other two sources.
  Endpoint and response shape **confirmed by capture** on 2026-07-30 — unlike
  `ORGS_PATH`. Two pitfalls recorded in the README: the overall level is **computed** (worst of
  the page indicator and the components, because `status.indicator` turned out to understate
  a real outage), and the filter on "claude" in component names removes nothing
  today (all six contain it).

`USAGE_PATH` (`GET /api/organizations/<org>/usage`) and `parseUsage()` in `usage-source.js`
are **confirmed** by network capture — see the README for the real response shape and
the unit pitfall (`utilization`/`percent` in 0-100, not as a 0-1 fraction). Tested by
`node test-usage-source.js`.

Warning: **`ORGS_PATH` remains an assumption**: the request that lists organizations has never
been captured — see the dedicated README section if polling fails before it even reaches
`.../usage`.

Warning: `theme.js` has **two** `content_scripts` entries. The second targets `https://a.claude.ai/*` with
`all_frames: true`: the "fullscreen" spinner (large isolated asterisk) is rendered in an iframe
on that subdomain, where the script was never injected — `all_frames` defaults to `false`,
and that was the blocker, not the domain (`https://*.claude.ai/*` already covered it, including
in `host_permissions`). Do not replace this with an `all_frames: true` on the main entry:
that would also inject the theme into the site's other iframes (artifact renderings). The main
entry carries a symmetric `exclude_matches` so the two sets stay disjoint —
modifying one without the other causes a double execution. It is the only entry in the repo tied
to a specific domain name: if Anthropic renames it, the spinner will **silently** stop
following the color.

Four features are added on top, independent of the three sources above and of each
other: **theme customization** (`theme.js`), **auto-continue**
(`autocontinue-source.js` + `autocontinue.js` + `autocontinue-bg.js`), which clicks the
"Continue" button of a reply stopped by the tool-use limit. Auto-continue requires **two
cumulative conditions** (button visible AND limit sentence in the last message only) and
has a single detector, `acTick()`, woken either by a `MutationObserver` or by the service
worker — hence the structural impossibility of a double click. Tested by
`node test-autocontinue.js` (pure logic) and `node test-autocontinue-dom.js` (stubbed DOM).

Warning: the popup's accent color control is a **palette + a hexadecimal field**, never an
`<input type="color">`: on Firefox the native picker is a window, and opening a
window **closes the anchored popup** (Mozilla bug 1292701, open since 2016) — before any
`input` event, so listening for `input` rescues nothing, and that was already the case. The general rule
is broader than color: **no control that opens a system window inside the popup**
(`type="file"` included). Same interface on both browsers, on purpose: sniffing
`userAgent` would mean two interfaces to maintain in parallel. Tested by
`node test-popup-accent.js`; details and rejected options in the README.

Warning: a convention not to break: `autoContinueMaxCount === 0` means **unlimited**, everywhere
(`AC_UNLIMITED`). It is also what `acSettings()` returns for a missing or nonsensical key, so
an unconfigured setting never blocks. A bare `count >= maxCount` comparison would block
immediately at 0: the short-circuit must come **first**, and `acMaxReached()` is the only
place in the repo where that comparison is allowed to exist. When auto-continue does not click,
the diagnosis is in the service worker console (loop state) then in the tab's
(button, sentence, counter, decision, and the actual message copied out).

Warning: the sidebar's **custom folders** (`folders-source.js` + `folders.js`) are the
**most fragile feature in the repo**: the only one that manipulates claude.ai's native DOM
structure rather than CSS variables or API data. It **moves** the real conversation
nodes (never a clone, otherwise native clicks and menus would be lost), anchors
on `a[href^="/chat/"]` then `closest('.df-drag-shiftable')`, and reapplies itself through a
`MutationObserver` on `aside.dframe-sidebar`. **Do not re-guess the selectors**: they are
confirmed by inspection and recorded in a README table, with their respective fragility.
The "−" button (one-click removal) is placed in the row's native control container,
reached through the parent of the item's first `button` that is not ours — definitely not through
`aria-label^="Plus d'options pour"`, which depends on the interface language. That is what makes it
inherit the hover state without managing opacity, and it calls the **same** `cfApplyDrop('', uuid)`
as the drop on the "Retirer" strip: one single unassignment, two entry points. Its click is
intercepted on `window` in **capture**, by delegation on `.cf-unfile`, and the button itself carries
**no** handler: on bubbling, the first click was eaten by a
single-use "click swallower" of the site — same flaw and same fix as for the drop. Do
not put an `addEventListener` back on it.
Its floating components — right-click menu, input modal (creation and renaming),
delete confirmation — **copy a specific native component** of claude.ai: there is
**no** `window.prompt` or `window.confirm` left in this feature. Input and confirmation
share the `cfShell()` shell and nothing else (body, guard and Enter key differ) —
do not merge them into a single function with optional parameters. The confirmation gives focus
to **"Annuler"**, not to the red button: Enter closes it instead of destroying, unlike a
`window.confirm`. Every color, radius and
shadow there goes through `var(--cds-x, <observed value>)`: the token names are **deduced** from
their Tailwind classes, which is only acceptable because we **read** them with a fallback — a
wrong name falls back to the observed value. Do not replace those fallbacks with a bare token, and do not
rewire these components onto `--cds-radius` / `--cds-shadow-{sm,md,lg}`: those are the base
tokens, which `theme.js` already scales, and nothing confirms they equal the `rounded-card` /
`shadow-panel` observed here. Dark mode is covered by the site's token when it exists, and
by a `@media (prefers-color-scheme: dark)` fallback otherwise.

All the verifiable logic lives in `folders-source.js` (`node test-folders.js`); DOM
placement has an optional jsdom harness, `node test-folders-dom.js`, which skips itself if jsdom is absent —
the repo stays free of `package.json` and `node_modules`.

**Conversation export** (`export-source.js` + `export.js`) adds a button next to
"Partager". A design decision not to undo: **the content comes from the API**
(`…/chat_conversations/<uuid>`, the same GET that `inject.js` intercepts), never from the
DOM — scraping would have required scrolling through the whole conversation, and a truncated export does not
show. There is **no DOM fallback**, deliberately. The organization uuid is not guessed
either: it is picked up from the URLs the page actually called
(`performance.getEntriesByType('resource')`), precisely so as not to depend on `ORGS_PATH`. The
PDF goes through `window.print()` in an offscreen iframe, without any library. Tested by
`node test-export.js` (pure logic) and `node test-export-dom.js` (optional jsdom).

Warning: the button's anchoring starts from **"Partager"**, not from the `div#dframe-header-actions-slot` slot:
the latter is absent from at least one context (Project conversation), where export
wrongly disabled itself. `exAnchor()` looks for "Partager" from nearest to widest and places the
button in *its* parent, whatever it is — so **do not put back a "slot
required" condition**, and do not add a per-context container selector: that is exactly
what this order avoids. The slot only serves as a fallback, and the clean shutdown only survives if both
are missing.

The repo is **ported to Firefox** (MV3), with a **single manifest** shared with Chrome.
Verified under real conditions on Firefox 153 and Chrome 150; the details of the measurements,
verdicts and reservations are in the "Portage Firefox" section of the README. Only three
pitfalls are worth knowing before touching the code:

Warning: `background` carries **two** keys: `service_worker` (Chrome) and `scripts` (Firefox, which does
not support `service_worker` and instantiates an **event page**). The same six files are therefore
listed **in two places**, in the same order — the manifest's `scripts` array, and the
`importScripts()` at the top of `background.js`. Nothing keeps them in sync: modifying only one breaks
**only one** of the two browsers, which makes it an asymmetric failure, easy to miss.
Since `importScripts` only exists in a `WorkerGlobalScope`, it is guarded by
`if (typeof importScripts === 'function')` — **do not remove that guard**, it was the first
real obstacle of the port.

Warning: `compat.js` must be loaded **first** in every context: the `scripts` array, every
`content_scripts` entry **except** the one in `world: "MAIN"` (no extension API exists there),
and `popup.html`. It aliases `chrome` onto `browser`, and it is a **safety net, not a
fix**: on Firefox 153 `chrome.*` already returns promises, but that behavior is
documented nowhere. Two consequences: after the alias `chrome.*` **is** `browser.*`, which is
promise-only, so any call in **callback style** becomes suspect — the repo has only one,
`show()` in `background.js`; and since the file is evaluated **six times per frame** (once per
`content_scripts` entry), it must remain **strictly idempotent**: no counter, no log.

Warning: `strict_min_version: "128.0"` comes from `world: "MAIN"` (Firefox 128+), **not** from the behavior
of `chrome.*`. Do not lower it believing it protects the promises: below 128, `world` is
an unknown key and therefore ignored, `inject.js` lands in the isolated world, and context
estimation **silently** stops working.

## Technical constraints

- Manifest V3 only, vanilla JS, no build step — loadable directly in developer
  mode through chrome://extensions, or through `about:debugging` on the Firefox side. **A single
  manifest for both browsers**: see the pitfalls above before touching it.
- All data stays local (chrome.storage.local) — never a third-party server. The
  network traffic emitted by the extension goes to claude.ai (usage polling) and status.claude.com
  (status polling), nothing else.
- claude.ai's internal endpoints are not guaranteed stable: the code must stay
  simple to fix if a response format changes. Hence `usage-source.js` and
  `status-source.js`, a single adaptation point per source.

---

# Behavioral guidelines

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
