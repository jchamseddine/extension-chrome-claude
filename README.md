# Claude Usage

Personal Chrome extension (Manifest V3, vanilla JS, no build step). It displays:

1. claude.ai's **session (5 h)** and **weekly (7 d)** usage — two-ring icon,
   badge, popup;
2. an **estimate** of the context size of the open conversation, as a badge on
   the page;
3. **Claude's status** read from `status.claude.com` (claude.ai, Claude Code, API…), as a
   popup section.

It also allows, through two features completely independent of the previous ones and of each
other:

- **customizing claude.ai's theme** (accent color, font weight, corners and
  shadows, reading font);
- **automatically resuming** a reply stopped by the tool-use limit
  (*auto-continue*) — disabled by default, with a continuation counter and a pause;
- filing conversations into **custom folders** in the sidebar, unrelated
  to the native *Projects* — Warning: the most fragile feature in the repo, see its section;
- **exporting a conversation** to Markdown or PDF, from a button next to
  "Partager" — the content comes from the API, never from the DOM, hence never truncated.

Nothing leaves the machine, except towards claude.ai and status.claude.com: everything is in
`chrome.storage.local`, no third-party server.

## Installation

1. `chrome://extensions` → enable **developer mode**
2. **Load unpacked extension** → select this folder
3. Be signed in to `https://claude.ai` — polling uses the session cookies

Chrome 111+ required (`"world": "MAIN"` in a static content script).

After reloading the extension, **always reload the claude.ai tab** — otherwise the injected
patch survives but the tab can no longer serve as a relay.

## Warning: organization resolution is incomplete

`GET /api/organizations/<org>/usage` is **confirmed** by network capture (see below).
What remains an assumption is `ORGS_PATH` in [`usage-source.js`](usage-source.js) —
the path used to find `<org>` has never been captured.

If polling fails *before even* reaching the usage endpoint (look for `HTTP 404` or
`unknown response format` in the console, but on the request preceding `.../usage`), it is
`ORGS_PATH` and `pickOrgId()` that need fixing, with the same method as for usage:
**Network** tab, *Fetch/XHR* filter, spot the request that lists the organizations.

## Where the data comes from

Usage is **polled** every 60 s by the service worker (`chrome.alarms`), with
`credentials: "include"`, on `GET /api/organizations/<org>/usage`. Since the service worker has
no `claude.ai` origin, the API may refuse its request: on **401/403**, the call is replayed
from an open `claude.ai` tab, where it is same-origin (`content.js` acts as the relay). Without
an open tab and with a refusal, polling fails and the popup shows the age of the last
known value.

Context estimation, for its part, still emits **no** call: it observes the responses
claude.ai already receives.

The status comes from a separate source, on another domain and without authentication — see
[Claude's status](#claudes-status) below.

| URL (pathname) | What we get from it |
| --- | --- |
| `…/organizations/<org>/usage` | `utilization` (0-100) and `resets_at` of the 5 h and 7 d windows, `severity` per window |
| `…/chat_conversations/<uuid>/completion` (SSE) | the length of the streamed text |
| `…/chat_conversations/<uuid>` (GET JSON) | the length of the full history |
| `status.claude.com/api/v2/summary.json` | the overall indicator, the state of the Claude components, the ongoing incident |

Real response of the usage API (captured on 2026-07-29), simplified:

```json
{
  "five_hour": { "utilization": 76, "resets_at": "2026-07-29T10:49:59.074167+00:00" },
  "seven_day": { "utilization": 43, "resets_at": "2026-08-01T10:59:59.074190+00:00" },
  "limits": [
    { "kind": "session",    "percent": 76, "severity": "warning", "resets_at": "..." },
    { "kind": "weekly_all", "percent": 43, "severity": "normal",  "resets_at": "..." },
    { "kind": "weekly_scoped", "scope": { "model": { "display_name": "Fable" } }, "...": "..." }
  ],
  "extra_usage": { "is_enabled": false, "utilization": 0 },
  "spend": { "percent": 0, "enabled": false }
}
```

**`utilization` and `percent` are 0-100 integers**, not 0-1 fractions as the old
`windows.utilization` of the SSE stream was — a pitfall not to reintroduce if this file is
touched: `parseUsage()` divides by 100 exactly once, never anywhere else.

`parseUsage()` (in `usage-source.js`) normalizes this response to the historical shape of
the `message_limit` SSE event, which remains the internal contract of the `usage` key:
`{ windows: { '5h': {utilization, status?, resets_at?}, '7d': {...} } }`, `utilization` as a
0-1 fraction. Priority to `limits[]` (`kind:"session"` → 5h, `kind:"weekly_all"` → 7d;
`weekly_scoped`, per-model usage, is ignored); fallback to `five_hour`/`seven_day` at the
root if `limits` is missing, empty, or does not carry the sought entry. `severity` maps
onto `status` (`"warning"` → `approaching_limit`); `"over_limit"` has **never been observed**
on the `severity` side, that mapping is extrapolated by analogy with the old SSE stream.

A missing or mistyped field, or an unknown `severity`, is **omitted**, never set to an
invented value: `utilOf()`/`colorFor()` then yield grey or derive the color from the
percentage alone, rather than a wrong figure or an exception. Covered by
[`test-usage-source.js`](test-usage-source.js) (`node test-usage-source.js`), with the real
response above as the main test case.

`extra_usage` / `spend` (paid credits) are not wired up yet — the equivalent of the old
`overageInUse`, never observed either. To be wired into `evaluate()` in `background.js` if this
point becomes useful again.

### Claude's status

A third source, **completely independent** of the other two: another domain, a public endpoint
(no useful cookie), nothing shared in storage, and it touches neither the icon, nor the history,
nor the notifications. Polled every **5 min** by the `status-poll` alarm — the status moves
rarely, no point hitting the page at the pace of usage.

`status.claude.com` is a **Statuspage** (Atlassian): its v2 API is public and
unauthenticated. We take `summary.json` and not `status.json`, because a single request gives
the overall indicator, the components **and** the incidents. Real response (captured on
2026-07-30, an incident was active), simplified:

```json
{
  "status": { "indicator": "minor", "description": "Minor Service Outage" },
  "components": [
    { "name": "claude.ai",                     "status": "partial_outage", "group": false },
    { "name": "Claude Console (platform.claude.com)", "status": "operational", "group": false },
    { "name": "Claude API (api.anthropic.com)", "status": "partial_outage", "group": false },
    { "name": "Claude Code",                   "status": "partial_outage", "group": false },
    { "name": "Claude Cowork",                 "status": "partial_outage", "group": false },
    { "name": "Claude for Government",         "status": "operational",    "group": false }
  ],
  "incidents": [
    { "name": "Elevated errors across many models", "impact": "major", "resolved_at": null }
  ]
}
```

`parseStatus()` (in [`status-source.js`](status-source.js)) normalizes this into
`{ level, components: [{ name, level, status }], incident? }`, `level` being
`operational` / `degraded` / `outage`. Two points this capture imposes:

- **`status.indicator` can understate reality**: it announces `minor` while four
  components are in `partial_outage` and the incident has `major` impact. The overall level
  is therefore the **worst of (indicator, retained components)**, never the indicator alone.
- **The "name containing *claude*" filter removes nothing today**: all six names
  contain it. It is only there to discard a foreign component if Atlassian adds one.

An unknown — or missing — component status yields `degraded`, not `operational`: for an
outage display, a false alarm that sends you to status.claude.com costs less than an
"all is well" shown during an outage. The raw value is kept next to `level`
so it stays diagnosable. `status.description` is not carried over (English, and redundant with
`level`): the popup has its own labels. Covered by
[`test-status-source.js`](test-status-source.js) (`node test-status-source.js`), with the capture
above as the main test case.

On the popup side, the "Statut" section shrinks to **a single line** when everything is nominal
("Tous les systèmes opérationnels") and only details the components outside the nominal state, preceded by the
incident title when there is one. A link opens `status.claude.com` in a new tab for
the full detail. It reuses the palette from `common.js` but **not** `colorFor()`, which
expects a usage window object.

## Architecture

| File | World | Role |
| --- | --- | --- |
| `inject.js` | MAIN | patches `fetch` and the History API, SSE tap, character counting |
| `content.js` | isolated | fallback relay: redoes the usage fetch same-origin when the SW is refused |
| `context-estimator.js` | isolated | keeps the per-conversation context estimate and displays the badge on `/chat/*` |
| `theme.js` | isolated | overrides the site's theme tokens — **independent of the rest**; the only module also injected into the `a.claude.ai` iframe (fullscreen spinner) |
| `autocontinue.js` | isolated | reads the DOM and clicks the *Continue* button — **independent of the rest** |
| `background.js` | service worker | polls both APIs (usage 60 s, status 5 min), writes `usage` and `status`, draws the icon, notifies |
| `usage-source.js` | SW | the **only** adaptation point to the usage API: URL + `parseUsage()` |
| `status-source.js` | SW | the **only** adaptation point to status.claude.com: URL + `parseStatus()` — **independent of the rest** |
| `autocontinue-source.js` | SW + page + popup | the **only** adaptation point of auto-continue: phrases + `acDecide()`, pure logic |
| `autocontinue-bg.js` | SW | wakes `acTick()` in each claude.ai tab every 5 s — **independent of the rest** |
| `folders-source.js` | page | the **only** "data" adaptation point of folders: uuid + CRUD, pure logic |
| `folders.js` | isolated | inserts the folders and **moves** the sidebar items — Warning: **the most fragile in the repo** |
| `export-source.js` | page | the **only** adaptation point of the export: URL, `parseConversation()`, Markdown/HTML — pure logic |
| `export.js` | isolated | export button in the header, menu, download and printing — **independent of the rest** |
| `common.js` | SW + popup | shared color thresholds (`utilOf`, `colorFor`) |
| `popup.html` / `popup.js` | popup | the two usage windows, the projection, the "Statut" section, the settings |

`chrome.storage.local` keys:

- `usage` = `{ data, updatedAt }` — a single key, rewritten **on every poll** even if nothing moved
- `status` = `{ data, updatedAt }` — status from status.claude.com, rewritten on every poll
- `orgId` = cached organization uuid, invalidated on 401/403/404
- `ctx:<uuid>` = `{ chars, tokens, updatedAt }` — one key per conversation, LRU 20
- `usageHistory` = `[{ t, u5, u7 }, …]` — rolling history, 50 points max
- `notifyState` = `{ windows: { '5h': { threshold, overLimit, notifiedReset }, … }, overage }` — anti-spam
- `settings` = `{ notifications: false }` — popup settings
- `accentColor`, `fontWeightPreset`, `radiusPreset`, `fontFamily` — theme customization,
  four top-level keys; **all absent** = original theme intact (see below)
- `autoContinueEnabled`, `autoContinueMaxCount`, `autoContinueCount`, `autoContinuePaused` —
  auto-continue, four top-level keys; **all absent** = disabled (see below)
- `folders` = `[{ id, name, color, collapsed }, …]` and `folderAssignments` =
  `{ "<uuid>": "<folder id>" }` — custom sidebar folders; **absent** = no
  folder, everything stays in "Récents" (see below)

### Polling

Two independent alarms: `usage-poll` at `periodInMinutes: 1` (the floor of
`chrome.alarms`) and `status-poll` at 5 min, plus an immediate poll of each on `onStartup`
and `onInstalled` so as not to wait for the first alarm.

Status polling calls `fetchJson()` directly, **not** `getJson()`: falling back to a
claude.ai tab would make no sense for a public endpoint on another domain, and its
`[usage]` warnings would be misleading.

Since the service worker is destroyed and restarted constantly, the top-level code replays on
every wake-up: the alarm is only (re)created if `chrome.alarms.get` finds it missing —
`create` would reset the count to zero and push polling back indefinitely.

The icon, the history and the notifications stay wired to `chrome.storage.onChanged`:
the event fires **also** in the context that wrote, so polling has nothing to
call directly.

### Icon

Two concentric rings drawn in an `OffscreenCanvas`: **outer = 7 d**,
**inner = 5 h**, each colored by its own window (green < 50 %, yellow < 75 %,
orange < 90 %, red beyond; grey if the data is missing). The text badge carries the % of the
5 h window. No PNG is shipped: the service worker draws the icon as early as `onInstalled` and
`onStartup`.

### Notifications

**Disabled by default** — the checkbox is in the popup, the preference goes into
`settings.notifications`. This **single** preference governs all the notifications, thresholds
as well as reset endings.

#### Thresholds

Three thresholds: **75 %**, **90 %**, **95 %**, evaluated separately on each window. The body
of the notification gives the window, the current % and the reset time in local time.

The anti-spam memorizes the last threshold notified per window in `notifyState`. We only notify
if the crossed threshold is **higher** than the last notified one; coming back down lowers it
silently, which rearms the notification in case of a new crossing (typically
after a window reset). Two distinct notifications are added, each only once
per transition: a window moving to `over_limit`, and `overageInUse` moving to `true`.

> `overageInUse` is a leftover from the old SSE stream: the real response of the usage API does
> not carry it, it has `extra_usage`/`spend` instead (see above). The check stays in place,
> without effect, pending those fields being wired into `evaluate()` in `background.js`.

#### Reset ending

The opposite of thresholds: reporting that a window **starts over from zero**, without having to open the popup.
No additional data is collected — `resets_at` and `utilization` are already there.

`isReset()` requires **two signals together**, never just one:

1. `resets_at` has changed since the previous poll, **and**
2. utilization has dropped sharply: old % > **20**, new % < **half** of
   the old one.

Each taken in isolation produces false positives. A `resets_at` boundary moving by a few
seconds without a real reset is not ruled out by the API — keeping it alone would make the
extension ring for nothing. And a percentage drop without a new boundary is a measurement
correction, not a new window. The half threshold rather than an absolute "≈ 0 %" lets
through the common case where a message is sent within the minute following the reset.

On top of that there is a **freshness guard**: the comparison is ignored if the previous poll is
more than **10 min** old (`RESET_MAX_AGE_MS`). Without it, the first poll on Chrome's wake-up
would announce a reset that happened the day before.

The comparison point is `changes.usage.oldValue` from `storage.onChanged` — the value of the
previous poll, read from storage, hence reliable even after the service worker has been recycled.
`notifyState.windows.<key>.notifiedReset` additionally memorizes the last announced boundary: a
single notification per reset, even if the same poll were replayed.

Covered by [`test-background.js`](test-background.js) (`node test-background.js`), which exercises
the three combinations (two signals → notifies; boundary alone → no; drop alone → no), the
freshness guard, the anti-spam and threshold non-regression.

The notification icon is encoded as a PNG data-URL from the same `OffscreenCanvas` as the
toolbar icon — `chrome.notifications` requires an `iconUrl`, and that is what allows shipping
no binary in the repo.

### Estimating the time before the limit

Each poll adds a `{ t, u5, u7 }` point to `usageHistory` (50 max, the oldest ones
are discarded) — that is a regular series at 1 point/minute, which gives far more meaning to
the fit than one point per message sent. 50 points cover 50 min, the fitting
window uses 30 of them. The popup fits a **least-squares linear regression**
on the points of the last 30 minutes:

```
a = Σ(t − t̄)(u − ū) / Σ(t − t̄)²      then      t(u=1) = t̄ + (1 − ū) / a
```

Going through the means avoids having to compute the intercept. No library,
it is deliberately basic — it assumes a constant rate, which is false as soon as you take
a break.

The projection is displayed **only** if the slope is positive and the deadline falls **before
the window reset** (`windows.5h.resets_at`): beyond that, the counter starts over from zero and the
limit will never be reached. When `resets_at` is missing or already past, a fixed horizon
of 5 h serves as a fallback. Below 3 points — hence during the first 3 minutes of
polling — the popup displays "not enough data" rather than a shaky fit. Conversely,
a period without activity gives a null slope: the projection disappears instead
of announcing an imaginary deadline.

### Context estimation

**It is an estimate, not a measurement.** The POST to `/completion` only contains the
new message — the history stays on the server side. The baseline therefore comes from the
conversation GET, to which we add on the fly the characters sent then those of the streamed
reply; the total is divided by 4 to approximate a token count. Reloading the
page resynchronizes on the real value.

The estimate is kept **per conversation**, under the `ctx:<uuid>` key where `<uuid>` comes from
the `/chat_conversations/<uuid>/completion` URL. The 20 most recently updated
conversations are kept, the others are removed (LRU).

The badge reads the UUID from the **page URL**, not from the requests: moving from one
conversation to another without a reload updates the display, through the
`pushState` / `replaceState` patch installed on the MAIN side (each world has its own `History.prototype`,
patching from the isolated world would intercept nothing). Without a known estimate for the
open conversation, the badge displays *contexte non estimé* rather than a misleading
"~0 tokens".

Not counted: system instructions, tools, project documents,
web search results. The real context is therefore always larger than this figure.

### Theme customization

A separate feature: `theme.js` shares nothing with the rest of the extension (neither
`usage-source.js`, nor `background.js`, nor `common.js`), and has its own
`content_scripts` entries in the manifest so it can be removed in one block. Two entries, not one:
the second targets the `a.claude.ai` rendering iframe — see *The "fullscreen" spinner lives in an
iframe* below.

Four settings, four top-level keys (not in the `settings` object, reserved for
notifications):

| Key | Values | Absent = |
| --- | --- | --- |
| `accentColor` | `"#rrggbb"` | original color |
| `fontWeightPreset` | `"thin"` / `"normal"` / `"bold"` | `"normal"` |
| `radiusPreset` | `"square"` / `"normal"` / `"round"` | `"normal"` |
| `fontFamily` | `"sans"` / `"serif"` / `"mono"` | original font |

**A single injection point**: one `<style id="__claude_theme_v1__">` carries all the
rules, in a single `:root,html.cds-root,.cds-root{…}` declaration. `"normal"` injects
nothing for its part, and any value outside the list is treated as absent — like `accentValid`
for the color, since the content ends up concatenated into CSS text.

**`--font-open-dyslexic` is out of scope**: claude.ai already drives this font natively
(Settings → Appearance → "Chat font": Default / Match System / Dyslexic Friendly, cf. the
[help center](https://support.claude.com/en/articles/8887527-customizing-your-appearance-settings)).
The extension's menu therefore only offers sans-serif / serif / monospace.

#### Accent color

Resolution chain **confirmed by inspecting the send button**:

| Tailwind class | Variable | Alias | Original value |
| --- | --- | --- | --- |
| `bg-fill-brand` | `--cds-fill-brand` | `--cds-clay-emphasized` | `#c6613f` |
| `bg-fill-brand-hover` | `--cds-fill-brand-hover` | `--cds-clay` | `#d97757` |

These are base tokens of the design system, not specific to this button: overriding them repaints
the other brand elements. `theme.js` sets only these **two** variables for the
color, in `!important`, on the `:root,html.cds-root,.cds-root` selector:

| Selector | Why |
| --- | --- |
| `:root` | case where the tokens are carried by `<html>` |
| `html.cds-root` | same element, but specificity (0,1,1) > the site's `.cds-root` (0,1,0) |
| `.cds-root` | if the class is **not** on `<html>`, the site puts the tokens on an element closer to the button; between two different elements specificity does not apply and our value inherited from `:root` would lose even with `!important` |

To know which case you are in: `document.querySelector('.cds-root').tagName` in the claude.ai
tab's console.

The hover color is computed in JS: hex → HSL, **+9 absolute lightness points**
(hue and saturation unchanged), HSL → hex. The figure is calibrated on the real pair
`#c6613f` (L 51.2 %) → `#d97757` (L 59.6 %), that is +8.4 points. In absolute and not relative terms:
a multiplicative factor crushes the gap on dark hues. Examples:
`#c6613f → #d17e62`, `#3f6ac6 → #6285d1`, `#20304f → #2d4470`. Tested by
`node test-theme.js` (pure computations) and `node test-theme-dom.js` (what is actually written
in a given document; jsdom optional).

##### Warning: the popup control is not an `<input type="color">`, and must not become one again

Eight clickable swatches plus a free hexadecimal field, not the native picker: on Firefox,
the latter opens in a **separate window**, and opening a window **kills the anchored popup**
before the user has even chosen a color ([Mozilla bug
1292701](https://bugzilla.mozilla.org/show_bug.cgi?id=1292701), still open). The
full reasoning and the rejected options are in *Firefox port* → [The native color
picker kills the popup](#the-native-color-picker-kills-the-popup-firefox). Two
consequences for anyone touching `renderTheme()`:

- the hexadecimal field writes on `input`, as soon as the input forms a complete `#rrggbb`, but
  **does not rewrite the field** at that moment: normalizing it while typing would move the
  caret and correct the typed case. The canonical form is only restored on field blur,
  which also recovers an input left incomplete;
- **the render writes nothing.** A missing color is displayed by default without being stored, otherwise
  opening the popup would recreate the key « Réinitialiser » has just removed.

Tested by `node test-popup-accent.js` (hard-stubbed DOM, without jsdom: `renderTheme()` only
uses seven methods).

#### Weight, corners/shadows, font: derived from the original values

These three settings set **no hard-coded value**: they read the site's tokens at
runtime (`getComputedStyle`) and transform them. A variable that is unreadable or of an
unexpected format is simply not overridden, with a `console.warn` naming it.

| Constant | Value | Why |
| --- | --- | --- |
| `THEME_WEIGHT_DELTA` | ±100 | one step of the CSS scale on the 4 `--cds-font-weight-*`: visible without breaking the regular/bold hierarchy |
| `THEME_RADIUS_FACTOR` | ×1.5 | beyond that, the small controls become pills |
| `THEME_SHADOW_LENGTH_FACTOR` | ×1.2 | rounder corners look flatter without slightly stronger shadows |
| `THEME_SHADOW_ALPHA_FACTOR` | ×1.15 | same, clamped to 1 |

`themeScaleShadow()` processes `--cds-shadow-{sm,md,lg}` by regex replacement, without splitting the
layers or the positions: **the offsets therefore grow by the same 20 % as the blur.**
An accepted simplification — visually subtle, and it avoids a full `box-shadow` parser for
a format we do not control. A color whose alpha is not extractable (`oklch(… / .05)`,
alpha in `%`) leaves the shadow **intact** rather than inventing a value. "Carré" computes
nothing: `--cds-radius: 0` and the three shadows at `none`.

For the font, we **alias** the target variable onto a stack the site already defines —
`<target var>: var(--font-anthropic-serif)` — rather than hard-coding stacks. The target
variable is found at runtime by `themeDetectFontVar()`: the one of the three `--font-anthropic-*`
whose value matches the computed `font-family` of `document.body`. No match →
warn and the setting has no effect, no guessed target.

Warning: **the capture of the original values is memoized once only** (`themeCaptureOriginals`),
and every setting that writes those variables waits for it to have succeeded. Without that, our
own `!important` sheet would pollute the next read: the radius would be multiplied by
1.5 **in cascade** on each preset change, and the aliased font stack would no longer
be detectable. That is also why "Carré" and the font wait for the capture although their
computation does not need it.

At `document_start` the site's sheets are not parsed yet and everything comes back empty: the
capture returns `null` **without memoizing**, and `theme.js` retries on `DOMContentLoaded` then at
100/300/800/1500/3000 ms. Past that delay, a warn names what remains not found.

#### Propagation

**The popup sends nothing to the tabs**: it writes or removes the four keys, and each tab
reacts through `chrome.storage.onChanged` by **rereading all four** (a grouped `remove` then produces
a single coherent render). All open claude.ai tabs therefore change together, without
a reload, without going through `chrome.scripting` or `chrome.tabs`. « Réinitialiser » removes the four keys,
which **removes** the `<style>` element instead of emptying it — the original theme becomes
exactly what it was.

##### Pending: intermittent propagation during a generation — under diagnosis

Reported symptom: a color change propagated from another tab **fails more
often** when a reply generation is in progress in the target tab. **Cause not
confirmed to this day** — this section describes the instrumentation in place, not a fix.

Warning: **the first measurement point was wrong, and pointed at the wrong half of the problem.**
The `[theme] state read` log was locked by a `themeFirstLoad` variable: it only printed
**once per frame**, at page load. Seeing it in the console of a tab that does not
update therefore proved **nothing** about `storage.onChanged` — it was the log of the
initial load, and we wrongly concluded the listener had fired and that the
problem was necessarily downstream. The log now names its cause
(`initial load` / `storage.onChanged`) and prints on **every** read. General lesson:
a measurement point whose scope is narrower than it looks is worse than no
measurement point, because it produces a conclusion instead of a silence.

Two instruments, both marked `TEMPORARY`:

| Log | What it says |
| --- | --- |
| `[theme] state read (<cause>) — accent=… weight=… radius=… font=…` | a storage read happened, and **why** |
| `[theme] audit — requested=… computed=… matches=… attached=…` | what the browser **actually** applies, just after the write |
| `[theme] tag REMOVED from the DOM at <ISO> (t+… ms)` | the site removed our `<style>`, with the timestamp |

All three are **flat lines of text, not objects**: Chrome's console shows
objects collapsed and truncated, and they copy badly. These logs are made to be picked up by
hand and pasted as-is into a report, so their raw readability takes precedence over their structure.
A test freezes this (`assert` that no brace appears in the audit).

The audit is the line that decides, because it rereads the **computed** value of
`--cds-clay-emphasized` instead of trusting what we think we wrote:

| `matches` | `attached` | Reading |
| --- | --- | --- |
| `NO` | `NO` | the tag was **removed** → hypothesis "site re-render during streaming" |
| `NO` | `yes` | tag in place but **a more specific rule wins** → look for a temporary class put on `.cds-root` during the generation |
| `YES` | `yes` | the browser is indeed applying the color: the problem is neither in `themeRender` nor in the CSS |

Warning: **mandatory order before any measurement**: reload the **extension** from
`chrome://extensions`, *then* press F5 on the tabs. A tab opened before the extension was reloaded
has no content script at all anymore, and a tab reloaded before it still runs
the old code — in both cases these logs are absent, which wrongly reads as "the
propagation triggered nothing".

Reading `--cds-clay-emphasized` here has no side effect: this variable belongs to none
of the four lists captured by `themeCaptureOriginals()`, so it cannot pollute its
memoization.

**The fix gate is already written but closed**: `THEME_REINJECT`, at `false`. At `true`,
the observer goes from observation to fix and puts the tag back immediately after each
removal, instead of waiting for the next `storage.onChanged`. It is **not** open by
default, because the first hypothesis is not confirmed and opening a gate for a
supposed cause would mask the real symptom instead of solving it. Both states are tested:
closed, the removal is observed without repair; open, the tag comes back.

Warning: the observer itself is tested, and that is not overzealousness: **an observer mute because
it is broken would read exactly like "hypothesis disproved"**. It is the same misreading as that of the
log above. `test-theme-dom.js` therefore checks that a real removal does trigger the message.

The observer watches `<html>` and `<head>` in `childList` **without** `subtree`: those are the only two
places where the tag can live, and during streaming the whole tree mutates continuously —
a `subtree` would be expensive to watch a single node.

Warning: **if a brand element does not change color**, do not add a variable at
random: inspect that precise element to confirm its real resolution chain, as
was done for the send button. The background variables (`--_gray-*`,
`--cds-hsl-gray-*`, `--cds-oncolor-*`), the text ones, as well as `--_brand-clay` and
`--cds-hsl-clay` are **out of scope** — the last two do not appear in the
confirmed chain above.

#### The "fullscreen" spinner lives in an iframe, on another domain

The large isolated asterisk, shown right after sending a message before the reply text
appears, did not follow the customized color — while the **compact** spinner
(small icon + status text) already did. Diagnosis **confirmed by inspection**:
they are two different elements, in two different documents.

| | Compact spinner | Fullscreen spinner |
| --- | --- | --- |
| Where | main `claude.ai` document | `https://a.claude.ai/isolated-segment.html` iframe |
| What | `<svg fill="…">` referencing `--cds-clay` / `--cds-clay-emphasized` | rendered in a separate, cross-origin document |
| Why it followed / did not follow | `theme.js` runs in that document | `theme.js` **never** ran there |

So it was **not** one more CSS variable to override — the default lead, and the
wrong one. The `--cds-clay*` chain was the right one from the start; it simply was not
applied in that document.

Warning: **the domain was already covered; what was missing is `all_frames`.** The manifest's
`matches` use `https://*.claude.ai/*`, which already includes `a.claude.ai`. But `all_frames`
defaults to **`false`**: a content script only runs in the main frame. Since the iframe
is a sub-frame, `theme.js` was never injected there. Hence a dedicated entry:

```json
{ "matches": ["https://a.claude.ai/*"], "js": ["theme.js"],
  "run_at": "document_start", "all_frames": true }
```

It is **dedicated** rather than `all_frames: true` put on the existing `claude.ai` entry: that
would also inject `theme.js` into *all* the site's other iframes (artifact renders included),
where it has no business. The existing entry carries in exchange
`"exclude_matches": ["https://a.claude.ai/*"]`, so the two sets are **disjoint**: without
that, a top-level navigation to `a.claude.ai` would run `theme.js` twice in the
same isolated world (duplicate `storage.onChanged` listener). `host_permissions` already covered the
subdomain (`https://*.claude.ai/*`): **nothing to change there**.

**Only `theme.js` reaches this iframe.** The other modules (`inject.js`, `content.js`,
`autocontinue.js`, `folders.js`, `export.js`) keep `all_frames` at `false` and therefore have no
way to run there, although their `https://*.claude.ai/*` matches the domain. On the
programmatic injection side, `autocontinue-bg.js`'s `chrome.scripting.executeScript` does not pass
`allFrames` either, and therefore only targets the main frame. A content rendering iframe has
neither sidebar, nor header, nor *Continue* button: nothing to do there.

Warning: **this entry is coupled by name to `a.claude.ai`** — it is the only one in the manifest that
depends on a precise domain name rather than the `*.claude.ai` wildcard. If Anthropic renames or
moves this rendering subdomain, the fullscreen spinner will silently stop following the
color, **without any error message**: on the main page side everything will keep working. The
symptom to recognize is exactly the original one — compact colored, fullscreen not colored.
The check is then to inspect the iframe to collect its new domain and to update
both places (the dedicated entry's `matches` **and** the other's `exclude_matches`).

`theme.js` needed **no modification** for this reduced context: its existing
guards are already enough. The accent depends on no original value, so it is written even
in a document without `--cds-*` tokens; the three derived settings are guarded by `&& orig` and
only apply if the capture succeeded; a document still without a `<body>` makes the capture return
`null`, without memoizing. That is what
[`test-theme-dom.js`](test-theme-dom.js) locks down (7 tests, jsdom optional like the other DOM harnesses).

If the spinner stays uncolored despite this entry, **do not guess one more variable**:
it will mean another obstacle exists in that iframe (a sandbox CSP that also refuses
the injected `<style>`, for instance), and it is *that* which will need inspecting.

### Auto-continue

A fourth independent feature: when a reply hits the **tool-use limit**,
claude.ai displays a *Continue* button that must be clicked by hand. `autocontinue.js` does it
for you. **Disabled by default**, settings in the popup.

Nothing in common with `usage-source.js`, `status-source.js` or `theme.js`: four dedicated keys,
its own `content_scripts` entry, and two isolated `importScripts` at the top of `background.js`
— that is its entire anchoring, removing them deletes the feature.

| Key | Values | Absent = |
| --- | --- | --- |
| `autoContinueEnabled` | `true` / `false` | disabled |
| `autoContinueMaxCount` | `1`-`999`, or `0` | `0` = unlimited |
| `autoContinueCount` | integer ≥ 0 | `0` |
| `autoContinuePaused` | `true` / `false` | not paused |

Adaptation in [`autocontinue-source.js`](autocontinue-source.js) — **pure** logic, no
DOM, no `chrome.*`: that is what makes it testable as-is
(`node test-autocontinue.js`). The DOM selectors, for their part, are at the top of
[`autocontinue.js`](autocontinue.js), covered by `node test-autocontinue-dom.js` on a stubbed
DOM.

#### Two cumulative conditions

Detection **never** acts on a single signal:

1. a **visible** *Continue* button in the DOM — a message that mentions the limit without a
   button means the reply is finished, there is nothing to continue;
2. one of the six characteristic phrases in the **last** assistant message, and
   **nowhere else** in the conversation.

The second half of point 2 is the anti-false-positive guard: a conversation whose
*subject* is the tool-use limit repeats the phrase from message to message and would auto-continue
itself endlessly. The six variants (`tool-use limit`, `tool use limit`, `reached its tool`,
`exhausted the tool`, `tool call limit`, `continuation needed`) come from
[claude-autocontinue](https://github.com/timothy22000/claude-autocontinue) (MIT), which collected
them on real messages; they are compared in lowercase and **as substrings**, since the
surrounding wording changes. No French variant is hard-coded: none has been captured,
and this repo does not write a guessed value (same rule as `ORGS_PATH`).

#### Two triggers, one single path

| Trigger | Where | Latency | Blind spot |
| --- | --- | --- | --- |
| `MutationObserver` (600 ms lull debounce) | `autocontinue.js`, page | near-instant | its `setTimeout` are **throttled** as soon as the tab goes to the background (1 s min, then 1/min after 5 min hidden) |
| `chrome.scripting.executeScript` polling | `autocontinue-bg.js`, service worker | ≤ 5 s | tab without a content script (opened before installation) |

Both call **the same** `acTick()` function, in the tab's isolated world. The
`acBusy` lock and the 5 s guard delay it carries therefore make the double click
impossible **by construction**: there is only one detector, woken in two ways — no
reservation protocol between the worker and the page. That is what the test
*two simultaneous ticks (worker + page): a single click* locks down. It is also why `autocontinue.js`
is **not** in an IIFE: the worker injects a function that calls `acTick()`, so the name
must be visible from the isolated world's global scope (same constraint as `theme.js`).

`chrome.alarms` has a one-minute floor, far too slow for a continuation: the
`autocontinue-poll` alarm only serves to **resurrect** the worker, the 5 s cadence comes from a
`setInterval` that only lives as long as the worker lives. Each `executeScript` pushes the sleep
back, so the loop is self-sustaining as long as there is a claude.ai tab. It is only started
if auto-continue is **active, not paused and under its maximum**: disabled, the extension
keeps nothing alive.

#### `autoContinueMaxCount`: 0 means *unlimited*

Unambiguously and **everywhere** — popup, page, service worker. It is not an arbitrary
sentinel: it is also what `acSettings()` returns when the key is missing, is `null` or is
nonsensical. A maximum never configured therefore **never** forbids continuing, which is the
intended behavior for a missing setting.

The alternative — `0` = "no continuation allowed" — would have required another value for
"unlimited" (`-1`, `null`) and turned a missing key into a silent block.

Warning: non-negotiable corollary: a **bare** `count >= maxCount` comparison would block from the
first call when `maxCount` is 0. The short-circuit on `AC_UNLIMITED` must therefore come
**before** the comparison, and there is only one place in the repo where that comparison is
allowed to live: `acMaxReached()`.

`autoContinueCount` missing and `autoContinueCount = 0` behave **strictly the same**
(`Number(undefined)` is `NaN`, which the `isFinite` test discards). The popup writes the
four keys anyway on activation, but only so that storage reads unambiguously by
hand — not to fix a behavior. Five tests fix this contract, including the exact state observed
in real use.

#### Counter and notification

Each continuation increments `autoContinueCount` and shows a **toast in the page**
(bottom-right, above the context badge, 4 s) — not a `chrome.notifications`: a
continuation is an event of the conversation you are currently reading, not a system
alert. The popup shows `3 / 10 continuations déclenchées`, with « Réinitialiser » to
reset the counter to zero and « Pause » to suspend **without touching the settings**.

### Custom folders

> Warning: **this is the most fragile feature in the repo, and by far.** All the others
> rely on *data* (usage API, Statuspage) or on the design system's *CSS variables*.
> This one is the only one that manipulates claude.ai's **native DOM structure**: it
> moves real sidebar nodes. A sidebar rework breaks it — hence the selector
> table below, which is the starting point of any repair.

Files conversations into colored folders, inserted **above** "Récents", with
no relation to claude.ai's native *Projects*. Two dedicated keys:

| Key | Shape | Absent = |
| --- | --- | --- |
| `folders` | `[{ id, name, color, collapsed }, …]` | no folder |
| `folderAssignments` | `{ "<conversation uuid>": "<folder id>" }` | everything in "Récents" |

An unassigned conversation is **not touched**: it stays in "Récents", in its place.

#### Selector table

To be checked in this order the day the folders stop working. They are all at the top
of [`folders.js`](folders.js), as `CF_*` constants.

| Selector | Role | Fragility |
| --- | --- | --- |
| `a[href^="/chat/"]` | **main anchor** — the uuid is read from the `href`, there is no dedicated data-attribute | **low**: it is a URL, not a class |
| `.df-drag-shiftable` | movable wrapper, reached through `link.closest(…)` | medium: an application class, but not a utility one |
| `.dframe-nav-scroll` | scrollable container; **absent = complete stop** | medium |
| `.dframe-recents-by-mode` | section wrapper, insertion point | medium; if absent, we fall back to `.dframe-nav-scroll` with a `console.warn` |
| `aside.dframe-sidebar` | shell observed by the `MutationObserver` | low: it is the shell, it survives the re-renders |
| *parent of the item's first `button` that is not ours* | control container where the **"−"** button is placed | medium; if absent, the button is not inserted and removal by drag and drop remains the only option (`console.warn`) |

That last one is **not** targeted by `button[aria-label^="Plus d'options pour"]`, which would depend on
the interface language, nor by its classes, which are utility ones (`.absolute.opacity-0…`):
it is deduced from the row's only native button, whatever its label.

Two selectors from the inspected structure are **deliberately unused**:
`div.group.relative[class*="rounded-"]` (the item container) because its class is an arbitrary
Tailwind radius — `rounded-[var(--df-radius-pill)]` — and `div.group\/section` (the section)
because an escaped Tailwind class is exactly the kind of anchor that breaks. The section
is **deduced from the DOM** instead: it is the parent of an item that is in none of our blocks.

#### Move, never duplicate

The items filed into a folder are claude.ai's **real nodes**, moved. A clone
would lose the native click handlers and context menu attached by the site — that is the
central trade-off of this feature, and the reason for its fragility.

When an item goes into a folder, a **bookmark** (`<div hidden data-cf-slot="<uuid>">`)
stays in its exact place. Taking it out therefore puts it back at its chronological position, and not
dumbly at the end of "Récents". A site re-render destroys the bookmarks along with the rest,
which is inconsequential: after a re-render, the unassigned items are already in the right place.

Warning: **the order of operations in `cfReflow()` is not cosmetic.** Blocks whose folder
has been deleted are removed **after** the placement loop, never before: on entering the
pass they still contain their items, and removing them first would tear those
conversations out of the document until the site's next re-render. The test *folder deletion:
conversations freed, NONE lost* locks down this precise point.

#### Re-renders and pagination

The sidebar is an SPA: it re-renders on every navigation. Filing is therefore reapplied
by a `MutationObserver` (120 ms debounce) placed on `aside.dframe-sidebar` — the shell, which
survives the re-renders — and **not** a single scan at load time. As long as the shell does not exist,
we fall back to `documentElement`, then **narrow** as soon as it appears: without that we
would observe the whole document permanently, including the stream of a reply in progress.

The `takeRecords()` at the end of the pass discards the mutations the filing itself has just
caused — without it, each render would trigger another, indefinitely.

Useful consequence: an older conversation that **appears on scroll** (pagination) is
filed without a reload. The list is not virtualized for the number of items currently
observed (tested up to 21), but the code assumes that nowhere.

#### Interactions

- Native browser **drag and drop**, no library. An `<a href>` is already
  *draggable*, so we do not set `draggable="true"`: we only add our data
  type on `dragstart`, without `preventDefault`, which lets the site's drag system
  (`df-drag-shiftable`) receive what it expects when the drop does not concern us. Dropping
  on a folder assigns; to unassign, a **"Retirer du dossier"** strip appears in
  our block while dragging a filed conversation. See
  [Dropping: never touch the native zones](#dropping-never-touch-the-native-zones).
- **"−" button** on a **filed** conversation: takes it out of the folder in one click, without a
  drag gesture. It calls exactly the same unassignment as the drop on the strip, so the
  conversation also gets its chronological place back in "Récents" through its bookmark.
  It **never** appears on a "Récents" item — there would be no folder to leave.
  It is inserted **into the row's native control container**, the "…" one: that is what
  gives it, for free, the same appearance on hover and focus (Tailwind
  `group-hover:` / `group-focus-within:` variants carried by the row), without our managing a single opacity.
  Warning: this container is `position:absolute`: **it pushes nothing**. The only thing that prevents
  the title from running underneath is the space the link reserves for it on the right, and the site
  sizes it for the "…" alone. Adding a button therefore made the title run **under** the
  controls — in the folders only, since "Récents" has nothing more to house. The reserve
  is therefore recomputed for *two* controls on `.cf-body a[href^="/chat/"]`, with the truncation
  set again along the way: without effect if the link already carries it, but necessary if the site masks the
  overflow with a gradient, which would no longer cover the right zone. Deliberately generous rather than
  exact — too much reserve truncates a little early and does not show, too little brings the bug back.
  Warning: its click is intercepted on **`window` in capture**, like the drop, and the button itself
  carries **no** handler — see [The first click that did
  nothing](#the-first-click-that-did-nothing). Do not go back on it: a handler placed on the
  button is in the bubbling phase, hence at the mercy of the first `stopPropagation()` that comes along.
- **"+"** at the top of the list: input modal (empty field, « Créer » button), color
  assigned automatically — the first unused one of the 8-color palette, so that two folders
  created in a row are distinguishable without a second question. It is 24 px on a side, like the native
  "…" — the "DOSSIERS" strip therefore no longer has vertical padding of its own: otherwise the two
  heights added up.
- **Right-click on a folder**: rename, change color (8 swatches), delete.
  Deleting **frees** its conversations to "Récents" and **never** deletes a
  conversation — the extension has no way to, and must never have one. The confirmation says
  so explicitly, because that is the question you ask yourself in front of a "Supprimer".
  Menu and modals copy their native equivalents — see [Menu and modals: copying the native without
  depending on it](#menu-and-modals-copying-the-native-without-depending-on-it).
- **Click on the header**: collapse / expand. The counter shows the number of *assigned*
  conversations, which can exceed the visible number if the oldest ones are not loaded.

#### Menu and modals: copying the native without depending on it

This feature's floating components **copy a precise native component** of
claude.ai, instead of being painted in relative colors like the rest of the file. A floating
element that looks like nothing around it shows immediately — unlike a
section strip, which blends into the sidebar.

| Our component | Native model copied | Before |
| --- | --- | --- |
| Right-click menu on a folder | a conversation's "…" menu (`div[role="menu"]`, `rounded-card bg-surface-3 shadow-panel`) | hard-coded `#1c1c1e` background, dark even in a light theme |
| Input modal — creation and renaming | a conversation's rename modal (`div[role="dialog"]`, 400 px box, `shadow-panel-lg`, dimmed backdrop) | `window.prompt` |
| Delete confirmation | same box, without a field | `window.confirm` |

Those three are **browser** components: they are not only ugly, they
show at the very top of the window, far from the folder you have just targeted, and follow neither
claude.ai's theme nor the one set by `theme.js`. **None of them is left** in this
feature.

##### One shell, two modals

An **input** and a **confirmation** share the shell (`cfShell()`: overlay, box, title,
button bar, Escape, click on the backdrop, keystrokes held back) and **nothing else** — different body,
different guard, different Enter key. Hence two thin functions on top
rather than a single one with optional parameters, which would be longer to read than the two combined.

| | `cfDialog()` — input | `cfConfirm()` — confirmation |
| --- | --- | --- |
| Body | text field, bounded to `FOLDER_NAME_MAX` | message, no field |
| Action button | dark primary, **greyed out** as long as the name does not survive the cleanup | danger red, **never** greyed out — there is nothing to validate |
| Focus on opening | the field, text preselected | **« Annuler »** |
| Enter | submits | closes, through the focused button |
| Escape, « Annuler », click on the backdrop | close without acting | same |

Two deliberate departures from the native, each in one direction:

- **Enter submits the input.** The native modal requires a click, which is defensible for a
  form and not for a single-line field.
- **Enter does not confirm a deletion.** It is « Annuler » that takes the focus, so Enter
  *and* Escape close without destroying anything and confirming requires an explicit gesture — the opposite of
  `window.confirm`, whose Enter confirms. A confirmation's guard is not in the input,
  it is in the gesture asked for.

Warning: the input's guard (`folderNameSubmittable()`) must stay aligned with **both**
writes it protects: a « Créer » active on a name `folderCreate()` discards would close the
modal without any folder appearing, which reads as a successful creation. Two pure tests
check the equivalence in both directions, creation and renaming.

The confirmation text lives in `folders-source.js` (`folderDeleteMessage()`) and not in the
DOM: it is text that depends on a count, hence something that can be wrong, hence something
testable — singular/plural agreement, the empty-folder case, and the constant sentence
"Aucune conversation ne sera supprimée" that answers *the* question you ask yourself in front of a
"Supprimer" button.

##### Site tokens with hard-coded fallbacks

Every color, radius and shadow of these two components goes through `var(--cds-x, <observed value>)`.
The token names are **deduced** from their Tailwind classes (`bg-surface-3` → `--cds-surface-3`),
on the model of the only chain confirmed by inspection, `bg-fill-brand` → `--cds-fill-brand`
(see [Accent color](#accent-color)).

Warning: deduced, hence fallible — but **a wrong name breaks nothing**: the observed value takes
over. That is what makes the deduction acceptable here when it is not for `theme.js`,
which **writes** those variables ("do not add a variable at random"). Reading with a fallback is
riskless; writing on a hunch is not. A test locks down the invariant: *no site token
is used without a fallback value*.

| Our variable | Token read | Light fallback | Dark fallback |
| --- | --- | --- | --- |
| `--cf-surface` | `--cds-surface-3` | `#fff` | `#2f2f2c` |
| `--cf-text` | `--cds-text-primary` | `#0b0b0b` | `#f5f5f4` |
| `--cf-hover` | `--cds-fill-ghost-hover` | black 6 % | white 10 % |
| `--cf-field` | `--cds-fill-field` | black 3 % | white 6 % |
| `--cf-ring` | `--cds-shadow-field-ring` | 1 px inner border | same, light |
| `--cf-card` | `--cds-radius-card` | `12px` | — |
| `--cf-danger` | *none* — see below | `#b42318` | — |
| `--cf-panel`, `--cf-panel-lg` | `--cds-shadow-panel{,-lg}` | 3 layers (border + 2 drop shadows) | denser shadows |

Warning: **deliberately not `--cds-radius` or `--cds-shadow-{sm,md,lg}`**, the only tokens the
repo already knows: those are the **base** tokens, and nothing confirms they equal the
`rounded-card` / `shadow-panel` observed on these two components — the question could not be
settled without inspecting the site. Taking them as equivalent would make our modal diverge from the
native modal it copies, that is exactly the flaw fixed here. On top of that they are already
scaled by `theme.js` for the "corners/shadows" setting, while the native components
copied do not move.

Dark mode is therefore covered **twice**: by the site's token when it exists (it follows
claude.ai's setting), and otherwise by a fallback under `@media (prefers-color-scheme: dark)` — the
*system* preference, for lack of a reliable way to read the site's one. A fallback of a fallback, never the
main source. The modal's primary button, for its part, names no color: it is
the **inverse** of the box (`background: var(--cf-text); color: var(--cf-surface)`), hence dark
on light in a light theme and the opposite in a dark theme, without our having to know which mode
we are in.

Warning: **`--cf-danger` is the only one that reads no site token**, and that is deliberate: the other
names are deduced from classes *actually observed* on the copied component, whereas no claude.ai
delete button has been inspected. Deducing a `--cds-fill-danger` without having seen anything
would be exactly the "variable at random" the README forbids elsewhere — and adding it remains
one line the day the site's real convention is collected. `#b42318` carries white at ~7:1,
so a single value is enough in both modes.

The menu's **icons** do not copy the native: claude.ai goes through a proprietary ligature
font (`Anthropicons-Variable`), which we do not replicate. We keep the `currentColor` SVG
stroke of the extension's other buttons (`export.js`), at the native 20 px template. Only
the container and the item layout (icon + truncated label, `role="menu"` /
`role="menuitem"`) copy the native.

Warning: **every keystroke made in the modal is stopped at the entrance** (`stopPropagation` on
the overlay's `keydown`/`keyup`/`keypress`): claude.ai listens to the keyboard on the document for its
shortcuts, and typing `/` or `e` in a folder name must not trigger one. It is the same
concern as the rest of the file, in the other direction — here we **hold back** our events instead
of intercepting its ones, so bubbling is enough: they start from our field and
necessarily pass through the overlay before leaving it.

#### Dropping: never touch the native zones

> Fixed after a bug seen in real use: dropping a conversation on a custom folder
> **pinned** it in the native "Épinglé" section instead of assigning it.

The handlers were nevertheless already calling `preventDefault()` and `stopPropagation()` — so that
was not the cause. Two real flaws, **each sufficient** to reproduce the symptom:

| Flaw | Why it pinned | Fix |
| --- | --- | --- |
| The drag was identified by `dataTransfer.types` | The site installs its own `dragstart` and a drag implementation commonly calls `clearData()` before writing **its** type, which erases ours. Our `dragover` then recognized nothing, did not call `preventDefault()`, and the drop was not even **allowed** on our blocks: the browser sent it back to the site's logic | `cfDragging`, set at `dragstart`, is authoritative; `dataTransfer` now only serves to *retrieve* the uuid, as a backup |
| Listening in the **bubbling** phase | If the site listens in the **capture** phase on an ancestor, its handler runs *before* ours — and our blocks are inside `.dframe-nav-scroll`. `stopPropagation()` came too late | Interception on **`window` in capture**: the very first point of an event's trajectory, before any handler placed on a descendant, whatever its registration order |

Deliberate consequence: **no handler is placed on a native element anymore.** We only act
if the target is in our subtree *and* a conversation drag is in progress.
Everywhere else the event passes intact, so native reordering and pinning
work exactly as before.

That is also why **unassigning is no longer done by dropping on "Récents"**: placing a
handler on a site section was precisely what could trigger its pinning.
The "Retirer du dossier" strip is ours, in our block, and only appears while
dragging an already filed conversation.

**Pointer fallback.** `df-drag-shiftable` ("the items move apart") suggests a *pointer*
drag and not HTML5 — in which case no `dragstart`/`dragover`/`drop` is emitted and everything
above stays silent. A fallback on `pointerdown`/`pointermove`/`pointerup` then takes
over, armed **only** if no `dragstart` was seen for the current gesture: the two
paths cannot fire together, and it is the browser that decides, not us. After
a drop caught with the pointer, an Escape `keydown` is sent to the document — the site has just been
deprived of its `pointerup`, and Escape is the conventional exit of drag libraries to
cleanly cancel a drag in progress.

#### The first click that did nothing

> Fixed after a bug seen in real use: the **first** click on the "−" button did nothing,
> the next one — and all the ones after — worked. Without reloading the page in between.

It is **flaw no. 2 of the table above**, at the same place in the file: the "−" button was the
only handler of this feature that had stayed placed on an element, hence in the
**bubbling** phase.

Three leads were plausible; two are ruled out by the code itself, the third
reproduces in a test:

| Lead | Verdict |
| --- | --- |
| Handler attached twice | Impossible: `cfAddUnfile()` returns if `bar.querySelector('.cf-unfile')` exists, and a duplicate handler would do the removal **twice** (idempotent), not zero times |
| Race between inserting the button and attaching its handler | Impossible: the handler was placed **before** the insertion, in the same synchronous function |
| Click absorbed by a **capture** handler placed higher up | **That is it** — the only lead that reproduces the symptom, "first click only" included |

The mechanism: a capture descends from `window`, so it passes **before** the target. It only takes
a site handler placed in capture on an ancestor calling `stopPropagation()` for the
click never to reach the button. And a drag library commonly arms a **single-use** "click
swallower" at the end of a gesture, so that the click following a drag triggers
nothing: once consumed, everything is normal again — hence the first click, and it alone. Our own
pointer fallback contributes to it, since it deprives the site of its `pointerup` and sends it an Escape so
it cancels: that is very exactly an end of gesture.

**Fix**: the same as for the drop. Interception on **`window` in capture**, by
delegation on `.cf-unfile`, and **no** handler on the button anymore. The content script
registers at page load, hence before any swallower armed later by a gesture. The uuid is
reread from the row's link `href` at click time instead of being kept in a closure:
there is no closure anymore, and delegation settles the lifecycle of the button along the way, destroyed and
recreated on every sidebar re-render.

The test *a site click swallower can no longer eat the removal* replays the scene: a swallower in
capture on the document, a **control** (folder collapsing, handled on the element) that proves
the swallower really does eat the clicks, then the click on "−" that must get through anyway.
Verified **red before, green after** — without that, the fix would only be a hypothesis.

Warning: what remains unobserved: *which* site handler arms the swallower. The test proves the class
of causes and the immunity, not the culprit's identity — and the fix depends on neither.

#### Tests

All the filing logic — uuid parsing, creation, assignment, deletion — is in
[`folders-source.js`](folders-source.js), **pure** and tested by `node test-folders.js`.
`folders.js` only keeps the DOM. The separation is deliberate: the part that will break one day must
not drag the verifiable part along with it.

DOM placement itself has its own harness, [`test-folders-dom.js`](test-folders-dom.js),
which builds the structure of the table above in jsdom and covers the two scenarios otherwise
invisible: the SPA re-render and the conversation arriving on scroll. It is the **only**
test in the repo that needs a dependency: without `npm install jsdom` it **skips itself** instead
of failing, so the repo stays loadable as-is, without `package.json` or `node_modules`.

Dropping is covered there by a **spy** that replays the site's handler: placed on an
ancestor of our blocks, in **both** phases. The tests check that it is never called
when we drop on a folder, and that it really is — with an exact call list as evidence —
when we drop elsewhere. Its silence is therefore a guarantee, not a false negative.

The "−" button is locked down there by a test that replays **both** removals end to end —
drop on the strip on one side, click on the other — and compares the complete state, DOM *and* storage: the
only way to guarantee there is no second implementation of unassignment. A
second test protects it from the site's "click swallower" (see [The first click that did
nothing](#the-first-click-that-did-nothing)).

The modals are split in two the same way. What they **decide** is pure and tested by
`node test-folders.js`: a submittable name is exactly a name that `folderRename()` *and*
`folderCreate()` would write — the equivalence is checked in both directions rather than asserted —
then Escape cancels / Enter submits, and the confirmation text (agreement, empty folder, reassurance
always present).

What they **display** is in `test-folders-dom.js`: field pre-filled, focused and
preselected when renaming, empty and « Créer » button greyed out on creation; Enter and the action
button produce the same result; Escape, « Annuler » and the click on the backdrop write nothing
— a click *inside* the box, however, does not close; the confirmation has no field, its button carries
the danger color and the focus is on « Annuler »; neither `window.prompt` nor `window.confirm` are
called anymore; no keystroke reaches the document.

Four guards were verified **red before, green after**: empty name, keystrokes held back,
click on the backdrop limited to its target, and focus on « Annuler ».

Warning: a jsdom limitation to know about: it **does not apply** the browser rule whereby
a `drop` is only emitted if the corresponding `dragover` was neutralized. The tests therefore check
*who receives what*, not the browser's arbitration. In reality, the first flaw of the table
above has one more consequence: the `drop` never reaches our zones.

It does not replace a manual check on claude.ai: it proves the placement logic,
not that the selectors still match the real site — only the browser says that.

### Conversation export

An export button next to "Partager", in the conversation header, with two outputs:
**Markdown** and **PDF**. claude.ai exposes no native export — checked in the sidebar's "…"
menu, the conversation title's one, and the share modal — so nothing is duplicated.

No storage key: this feature stores nothing.

#### The content comes from the API, not from the DOM

This is **the** design decision of this module. The GET
`…/organizations/<org>/chat_conversations/<uuid>` is the only response that carries the whole
history — the same endpoint as the one already intercepted for context estimation
(see the header of [`inject.js`](inject.js)), hence **confirmed by capture**.

Scraping the DOM would have required scrolling through the whole conversation before exporting, and a truncated
export does not show: the file looks complete. Here, **either the export is complete, or it
fails and says so**. There is no DOM fallback, deliberately — a silently
truncated fallback would be worse than no export at all.

Warning: **the organization uuid is not guessed.** Since `ORGS_PATH` is the only unverified
assumption of the repo, depending on it would couple the export to usage polling and make it rest on
a bet. It is therefore collected from the URLs the page has **actually** called
(`performance.getEntriesByType('resource')`), at two levels:

1. the **exact** URL the site used for this conversation, query string included — we
   inherit its parameters without having to know them;
2. failing that, rebuilt from any URL carrying the organization (the site
   calls some constantly, so it is found even if the conversation GET has left the
   Resource Timing buffer, limited to 250 entries).

If neither succeeds, the export refuses to start and asks you to reload the tab.

| Selector | Role |
| --- | --- |
| `button[data-testid="wiggle-controls-actions-share"]` | **main anchor**: placement neighbour **and** style model |
| `div#dframe-header-actions-slot` | **fallback** container, if "Partager" is absent |
| `div[data-testid="chat-header"]` | observed by the `MutationObserver`; also used to frame the search |

Warning: **the anchoring starts from the "Partager" button, not from the slot** — and not the other way round, unlike the
first version. The slot had been taken for "the" stable insertion point, but it is
**absent from at least one context** (Project conversation): the export disabled itself there with a
`[export] no anchor point …` while "Partager" was indeed there. `exAnchor()`
therefore looks for "Partager" from nearest to widest — slot, then header, then document — and
places the button in *its* parent, whatever it is. Detection no longer depends on the header
shell, **without any container selector having been guessed per context**: it is the same
confirmed pair, tried in a different order. The fallback on the slot is only used if
"Partager" is not found; if both are missing, the export disables itself cleanly — that is the
only remaining case, and it stays reported.

The button **does not invent a style for itself**: it copies the `className` of the "Partager" button and the
size of its `<svg>`, so radius, hover states and theme follow the site without our having to
know them (same technique as `folders.js` for the section classes). Without a
"Partager" button, it falls back on a neutral style and reports it in the console. It is only placed on
an open conversation, and put back after each header re-render.

#### Markdown

The message text is taken **verbatim**: Claude's replies *are* markdown,
code blocks and languages included — rewriting them could only damage them. Only the title is
sanitized, because it becomes a `#` line that a line break would break. Blocks that are
not text (`tool_use`, `tool_result`, `thinking`) are discarded: an export must read
like the conversation, not like its execution trace.

#### PDF: `window.print()`, no library

No jsPDF or equivalent. We print a self-contained document and Chrome offers *Save as
PDF*. Printing goes through an **offscreen iframe** rather than a window: no
pop-up blocker to fight, and above all `print()` then prints *only* that document, not
the claude.ai page around it.

The markdown is rendered to HTML by a deliberately **partial** converter (code blocks
with their language, headings, lists, quotes, links, bold/italic) — what is not recognized
comes out as a paragraph, never lost. That is the accepted trade-off for not embedding a full
markdown parser behind a print button.

HTML escaping **always** comes before formatting: a conversation containing
`<script>` must never become a tag again in the printed document, and a
`javascript:` link is never made clickable. Two tests cover precisely those two cases.

#### File name

`<title> - YYYY-MM-DD.md` (or `.pdf`), with a cleanup aiming at the union of the Windows,
macOS and Linux forbidden sets: `<>:"/\|?*`, control characters, trailing dots or spaces — which
Windows Explorer truncates silently — and the DOS device names (`CON`, `NUL`,
`COM1`…), which Windows refuses even followed by an extension. Empty or entirely filtered title:
fallback to `conversation`.

#### Tests

`node test-export.js` covers the pure logic (32 tests): Markdown generation, escaping,
code block rendering, file name, reading the API response.
[`test-export-dom.js`](test-export-dom.js) checks the insertion of the button into the header (8 tests)
and **skips itself** without jsdom, like `test-folders-dom.js`. Three of its tests are about
context detection: header without an action slot, unrecognized header, and no anchor at
all — the first two do fail if the "slot required" condition is put back.

## Debug

**Usage is diagnosed from the service worker console** (`chrome://extensions` →
*service worker*). Possible messages, from the most frequent to the rarest:

| Message | What it means |
| --- | --- |
| `HTTP 404` on the organizations request | `ORGS_PATH` is wrong — see the dedicated section at the top |
| `unknown response format … JSON received:` | a case not covered by `parseUsage()` — add it, with a test in `test-usage-source.js` |
| `direct fetch failed (HTTP 403): falling back to a claude.ai tab` | normal, the fallback takes over |
| `no claude.ai tab open` | the API refuses the SW and there is no relay available |
| `no claude.ai tab responds` | the tab predates the extension load → reload it |
| `[status] polling failed:` | status.claude.com is unreachable — the popup simply hides the section |
| `[status] unknown response format … JSON received:` | Statuspage changed shape — fix `parseStatus()`, with a test in `test-status-source.js` |
| `[autocontinue] polling failed:` | the worker's loop could not read storage or list the tabs |

The folders, for their part, speak in the claude.ai **page** console, once per cause
so as not to flood the console on every re-render:

| Message | What it means |
| --- | --- |
| `[folders] container ".dframe-nav-scroll" not found after 8 s` | the sidebar changed — nothing was inserted, see the selector table |
| `[folders] wrapper ".dframe-recents-by-mode" not found` | degraded, not blocking: the folders are inserted directly into the scrollable container |
| `[folders] no ".df-drag-shiftable" above the conversation link` | the link is found but not the movable wrapper anymore: nothing is filed |
| `[export] no anchor point in the header: neither "…-share" nor "…-actions-slot"` | neither the "Partager" button nor the fallback slot — no button inserted. The message says whether the `chat-header` header was present: **present** = its internal structure changed, **absent** = this context has no recognized conversation header |
| `[export] button "…-share" not found` | degraded, not blocking: the button takes a neutral style instead of copying the site's one |
| `[export] unknown response format … JSON received:` | the conversation response changed shape — fix `parseConversation()`, with a test in `test-export.js` |
| `[export] failure: …` | the export stopped before writing anything; the same sentence is shown as a toast in the page |
| `[theme] state read (<cause>)` | Pending, **temporary**: a storage read, with its cause (`initial load` or `storage.onChanged`) |
| `[theme] audit — requested=… computed=… matches=…` | Pending, **temporary**: `matches` says whether the browser really applies the requested color — see the reading table in the Theme section |
| `[theme] tag REMOVED from the DOM at …` | Pending, **temporary**: the site removed our `<style>`. If this appears during a generation, the "re-render during streaming" hypothesis is confirmed and `THEME_REINJECT` can go to `true` |

#### Why auto-continue does not click

Two consoles, two halves of the answer. **Start with the service worker's one**: it is the
only one that speaks when the feature is off — in that case nothing else runs, neither the
polling nor the page's `MutationObserver`.

| Service worker console | What it means |
| --- | --- |
| `loop stopped: auto-continue DISABLED (autoContinueEnabled missing or false)` | the popup checkbox is not ticked — **nothing** runs as long as that key is not `true` |
| `loop stopped: paused` | the popup's « Pause » button |
| `loop stopped: maximum counter reached: 5 / 5` | « Réinitialiser », or set the maximum to 0 (unlimited) |
| `active, but no claude.ai tab open` | the loop is running, there is nobody to poll |
| `active — polling N tab(s) every 5 s` | all is well on this side: move on to the tab's console |
| `tab 42: no content script (reload the tab)` | tab opened before the extension was loaded |

Once the loop is active, the detail is in the **tab's** console. It only speaks
when a "Continue" button is visible — or when a button with the right label has just been discarded —
and never repeats an identical state:

```
[autocontinue] diagnostic (sw)
  "Continue" button    : found
  assistant messages   : 12 read
  last message read    : selector .group\/message-row, index 11/11 — anchored to the Continue button (reliable)
  limit phrase         : ABSENT from the last message
  phrase earlier       : no
  counter              : 0 / unlimited
  active / paused      : true / false
  DECISION             : ignores — no limit phrase in the last message
  last message (first 500 characters), to collect the real phrase:
    "Claude a atteint la limite d’utilisation d’outils pour cette réponse."
```

The lines that decide:

- **`"Continue" button    : DISCARDED — n with the right label but judged invisible`** — the button exists
  but `offsetParent` is null. It is then the visibility test that needs revisiting, not
  phrase detection.
- **`last message read    : … — anchored to the Continue button (reliable)`** confirms that the captured text
  does come from the row containing the visible button, not from an assistant-like element lower
  in the document (citation card, history preview…) that would have usurped the
  "last" position simply by coming last in `querySelectorAll()`. If the line says
  **`last one found in DOM order (button not nested — assumption to verify)`** instead,
  the anchoring failed and the text read is not guaranteed to correspond to the right message — to be checked
  by eye before concluding anything about the limit phrase.
- **`limit phrase         : ABSENT from the last message`** followed by the copied-out message — this is the case
  expected on a **French interface**, for which no variant is known (see "Limites
  connues"). The copied-out message is there precisely to collect the real wording and
  add it to `AC_LIMIT_PHRASES`, with a test in `test-autocontinue.js`. That is the only
  correct way to complete it: collected, never guessed.

Each continuation additionally writes `[autocontinue] continuation 3 (page|sw)`, with the origin
of the trigger.
To find out why *nothing* is happening, call `acTick('manual')` in that same console,
**after switching the context selector** from *top* to the extension's one (the
content scripts live in an isolated world): the function always returns its reason in plain words (`no Continue button visible`,
`limit phrase already present earlier in the conversation`, `maximum counter reached (10)`,
`no content script (reload the tab)`…).

`inject.js` has a `var DEBUG = false;` at the top — setting it to `true` makes `[usage] tap
start` / `tap end` come out in the console of **the claude.ai page**. It now only concerns
context estimation.

> **After reloading the extension, reload the claude.ai tab too.** Otherwise the tab's content
> scripts are orphaned and the fallback relay no longer answers (the service
> worker reports it explicitly).

To test the degraded states without waiting for a real limit, from the service worker
console (`chrome://extensions` → *service worker*):

```js
chrome.storage.local.set({ usage: { updatedAt: Date.now(), data: { windows: {
  '5h': { status: 'over_limit',        utilization: 0.97, resets_at: Math.floor(Date.now()/1000) + 3600 },
  '7d': { status: 'approaching_limit', utilization: 0.80, resets_at: Math.floor(Date.now()/1000) + 200000 }
} } } });
```

#### Triggering a reset notification without waiting for a real reset

The block above is not enough for the reset: `isReset()` compares the **previous** poll to the
current poll, so **two successive `set`** are needed — it is the `oldValue`/`newValue` pair of
`chrome.storage.onChanged` that carries the information, not an isolated state. Still from the service
worker console:

```js
// 1. Notifications active, and counters pre-set so that ONLY the reset notification comes out
//    (threshold: 75 prevents step 2 from also triggering a threshold crossing).
await chrome.storage.local.set({
  settings: { notifications: true },
  notifyState: { windows: { '5h': { threshold: 75, overLimit: false },
                            '7d': { threshold: 0,  overLimit: false } }, overage: false }
});

// 2. "Before" state: 5 h window well filled, boundary A.
const A = Math.floor(Date.now() / 1000) + 3600;
await chrome.storage.local.set({ usage: { updatedAt: Date.now(), data: { windows: {
  '5h': { utilization: 0.76, resets_at: A },
  '7d': { utilization: 0.43, resets_at: A + 200000 }
} } } });

// 3. "After" state: new boundary AND sharp drop -> reset detected, one notification.
await chrome.storage.local.set({ usage: { updatedAt: Date.now(), data: { windows: {
  '5h': { utilization: 0.02, resets_at: A + 18000 },
  '7d': { utilization: 0.43, resets_at: A + 200000 }
} } } });
```

Expected: **a single** notification, "Session — 5 h : reset effectué". The 7 d window keeps its
boundary, so it does not notify — which at the same time checks that the two windows are indeed
evaluated separately.

Warning: three conditions easy to miss, all imposed by `isReset()`:

| Constraint | Why | Consequence if missed |
| --- | --- | --- |
| `utilization` as a **0-1 fraction** | this is the form *after* `parseUsage()`, which divides by 100 | `0.76` written `76` → `utilOf()` clamps to 1, the drop is no longer detectable |
| less than **10 min** between steps 2 and 3 | `RESET_MAX_AGE_MS`: beyond that, Chrome was asleep and we would announce a reset several hours old | no notification |
| `resets_at` **different** between the two | a drop alone is a measurement correction, not a new window | no notification |

The real polling runs every minute and rewrites `usage`: chain the three steps without
dawdling, otherwise a real poll slips in between 2 and 3 and breaks the pair.

Negative controls, starting from step 2 — in both cases **nothing** must appear:

```js
// Sharp drop but UNCHANGED boundary -> measurement correction, not a reset.
await chrome.storage.local.set({ usage: { updatedAt: Date.now(), data: { windows: {
  '5h': { utilization: 0.02, resets_at: A }, '7d': { utilization: 0.43, resets_at: A + 200000 }
} } } });

// New boundary but WITHOUT a drop -> the API just moved its boundary.
await chrome.storage.local.set({ usage: { updatedAt: Date.now(), data: { windows: {
  '5h': { utilization: 0.74, resets_at: A + 18000 }, '7d': { utilization: 0.43, resets_at: A + 200000 }
} } } });
```

To replay the test, just restart from step 2: `A` is recomputed on the clock,
so the new boundary differs from the one memorized in `notifyState.notifiedReset` and the anti-spam
does not block. Replaying the **same** boundary, on the other hand, notifies only once — which is exactly
what the anti-spam guarantees.

Same method for the "Statut" section, which is most often green:

```js
chrome.storage.local.set({ status: { updatedAt: Date.now(), data: {
  level: 'outage',
  incident: { name: 'Elevated errors across many models', impact: 'major' },
  components: [
    { name: 'claude.ai',   level: 'outage',   status: 'partial_outage' },
    { name: 'Claude Code', level: 'degraded', status: 'degraded_performance' }
  ]
} } });
```

## Firefox port

**A single manifest**, not two folders: `background.service_worker` (Chrome) and
`background.scripts` (Firefox) coexist in the same `manifest.json`. Chrome emits the single
warning `'background.scripts' requires manifest version of 2 or lower`, loads
normally and keeps using its service worker — verified by measuring that `compat.js`
is **not** evaluated there. Two separate manifests would have meant duplicating 16 files without a
build step.

The `browser_specific_settings.gecko.strict_min_version` floor is at **128.0**, and it comes
from `world: "MAIN"` (Firefox 128+ support) — not from the behavior of `chrome.*`.

### Three pitfalls not to re-guess

**1. The list of background scripts is duplicated, and nothing keeps it in sync.**
`background` carries **two** keys: `service_worker` (Chrome) and `scripts` (Firefox, which does
not support `service_worker` and instantiates an **event page**). The same six files are therefore
listed **in two places**, in the same order: the manifest's `scripts` array, and the
`importScripts()` at the top of `background.js`. Modifying only one breaks **only one** of the two
browsers — an asymmetric failure, hence easy to miss. Since `importScripts` only exists in
a `WorkerGlobalScope`, it is guarded by `if (typeof importScripts === 'function')`: **do not
remove that guard**, it was the first real obstacle of the port.

**2. `compat.js` loads first, everywhere.** At the top of the `scripts` array, at the top of
each `content_scripts` entry — except the one in `world: "MAIN"`, where no extension API
exists and where it would be a guaranteed no-op — and at the top of `popup.html`. It aliases `chrome` onto
`browser`. It is a **safety net, not a fix**: on Firefox 153 `chrome.*` already returns
promises, but that behavior is documented nowhere (MDN only says that
`chrome.*` **accepts** callbacks). Two consequences not to forget:

- after the alias, `chrome.*` **is** `browser.*`, which is promise-only: any call in **callback
  style** becomes suspect. The repo has only **one**, `show()` in `background.js`
  (measured functional, but do not reintroduce others);
- the file is evaluated **once per `content_scripts` entry**, that is six times per frame in
  the same isolated world. It must remain **strictly idempotent**: no counter, no log,
  no cumulative side effect.

**3. The 128 floor comes from `world: "MAIN"`, not from `chrome.*`.** Do not lower it believing
it protects the promises. Under Firefox 128, `world` is an unknown key, hence **ignored**:
`inject.js` lands in the isolated world, patches the content script's `fetch` there instead of the
page's, and context estimation stops working **silently** — without an error,
without a log, with just a badge that never shows anything.

### Measurements taken

All under real conditions, on **Firefox 153.0** and **Chrome 150.0.7871.187**. This table
exists because the initial audit had classified several of these points "to be verified": three
of the five turned out to be moot, and that is the kind of conclusion one wrongly re-guesses if
it is not written down.

| Point | Verdict |
|---|---|
| `importScripts()` in a Firefox event page | Failed: **confirmed blocking.** `ReferenceError` as early as line 12 of `background.js` — it is a `WorkerGlobalScope` call, absent from an event page. Hence the `if (typeof importScripts === 'function')` guard |
| Does `chrome.*` return promises on Firefox? | OK: **yes**, contrary to what the docs suggest. The ~29 `.then()` chains work as-is. See `compat.js` for why we alias anyway |
| `OffscreenCanvas` + `action.setIcon({imageData})` | OK: **works**, including `convertToBlob()` + `btoa()`. Verified visually (icon actually repainted), not only on the API return value |
| `notifications.create()` | OK: **works** — see below |
| Usage polling with **all tabs closed** | OK: **works** — see below |
| **Auto-continue** cadence in the background | OK: **5 s, as on Chrome** — measured over 5 min only, see the reservation below |
| **Real triggering** of auto-continue (detection + click) | Warning: **not measured on Firefox.** Three attempts to provoke the tool-use limit failed: impossible to reach the test conditions, not a failed measurement — see below |
| **Export** to PDF and Markdown | OK: **works**, including in a Project conversation — see below |
| `world: "MAIN"` and `all_frames` | Supported since Firefox 128, hence the floor |
| `<input type="color">` in the popup | Failed: **confirmed blocking** on Firefox 153.0.3: the popup closes when the native picker opens, the choice is lost. Fixed by removing the `input` — see below |

#### `notifications.create()`: three suspected risks, none real

The audit classified this point **MEDIUM, to be verified**: the Mozilla docs only list `type`, `title`,
`message` and `iconUrl` as supported properties, and WebExtension schema validation is
reputedly strict. Three causes of breakage were plausible on `show()`'s single line:

1. the `priority: 2`, an undocumented property on the Firefox side;
2. the `''` id (empty string) as the first argument, where Firefox rather allows **omitting** the id;
3. the **callback style** of this call — it is the **only** one in the repo, everything else is in
   `.then()` — whereas `compat.js` makes `chrome.*` an alias of `browser.*`, promise-only
   and reputed to refuse a superfluous argument.

**The four variants succeed on Firefox 153**, and the four notifications really appear
on screen (verified visually, not only `OK` in the console). **Nothing to fix
in `show()`.** The audit had overestimated the risk on this precise point.

#### Usage polling with all tabs closed: the cookies get through

The audit feared that `fetchJson()`'s direct `fetch`, emitted from a
`moz-extension://` origin, would be a **cross-site** request whose claude.ai `SameSite=Lax/Strict`
cookies would be discarded — which would have forced a permanent fallback to `fetchViaTab()`, hence
the loss of the "polling works with the tab closed" promise.

**This fear is not confirmed on Firefox 153**: with all claude.ai tabs closed (counted at zero before the test),
a forced `pollUsage()` writes fresh data at 0 s, without a single console warning —
hence without going through the relay. The behavior is the same as on Chrome. Nothing to change.

#### Auto-continue cadence: 5 s held, but measured over 5 min only

`autocontinue-bg.js`'s 5 s `setInterval` rests on a **Chrome** assumption: each
`executeScript` pushes the sleep back, so the loop is self-sustaining. Nothing
guaranteed that on a Firefox event page, reputed to die after a few tens of seconds
of inactivity ([bug 1851373](https://bugzilla.mozilla.org/show_bug.cgi?id=1851373)).

Measurement on Firefox 153, auto-continue active, one claude.ai tab open, background console
**closed** and Firefox minimized for 5 min — the timestamps went to `storage` precisely
because an attached console prevents sleep and would have guaranteed a false positive:

```
ticks : 66 | duree : 303 s | cadence moyenne : 4,7 s/tick | ecarts <= 15 s : 65/65
```

**The loop did not die a single time.** The few 0 s gaps are the additional
calls coming from the wake-up by the `usage-poll` alarm, which replays the top level of the
file — they confirm the resurrection path, they do not contradict it.

Warning: **a reservation not to erase**: this is measured over **5 minutes**, in **one** configuration.
It says nothing about an inactivity of several hours, nor about behavior under memory pressure
or with other extensions active. The result allows changing nothing today, not
concluding that Firefox never recycles its event page.

#### Auto-continue has never been seen **clicking** on Firefox

Not to be confused with the measurement above, which is about the **loop**: we established
that `acTick()` is indeed called back every 5 s on a Firefox event page. We have **not** established
what happens when that tick falls on a real reply stopped by the tool-use limit,
because that situation could never be provoked.

**Three attempts, three failures** — targeted web searches then going through a connector:
Claude answers efficiently and never reaches the tool limit in a single turn. It is an
**impossibility of assembling the test conditions**, not a failed measurement: there is no
negative result to record, there was no test.

What bounds the extent of this gap:

- **The detection mechanism is strictly shared code** between Chrome and Firefox, and this
  port did **not** modify it. The two cumulative conditions — visible `Continue` button **and**
  limit phrase in the last assistant message only — live in `autocontinue.js` and
  `autocontinue-source.js`, without a single per-browser branch. They stay covered by
  `node test-autocontinue.js` and `node test-autocontinue-dom.js`, which run outside a browser.
- **The initial audit's Firefox-specific point of concern was about the click action**,
  not about detection: the fear was that a synthetic click would not reach a button managed
  by React, and that the usual workaround — `document.execCommand('insertText')` — would be
  necessary. Warning: **that fear targets code this repo does not have**: `acTick()` calls
  `button.click()` and nothing else (`autocontinue.js`), and `execCommand` is **deliberately
  absent** from it (see *Limites connues*). The residual risk therefore reduces to "does a `click()` on that
  precise button produce the expected effect on Firefox?" — narrower than the audit
  suggested, but **never verified under real conditions**, for lack of being able to trigger the
  situation.

**To be checked opportunistically**, the next time the tool-use limit is reached
naturally in real use on Firefox — it is the only known way to get there. The tab's
diagnostic journal (button, phrase, counter, decision, copied-out message) is then enough to
decide without instrumenting anything more.

#### Export: the 0×0 iframe prints, and the anchoring holds in a Project

Two distinct doubts about this feature. The first: `exExportPdf()` prints a **0×0**
iframe (`srcdoc`, then `contentWindow.print()`), and nothing guaranteed that Firefox would accept
a document of zero size. The second: the button anchors on "Partager", not on the
`div#dframe-header-actions-slot` slot — an anchoring that had already broken once in a
Project conversation.

**Both hold on Firefox 153**: `print()` runs without an exception, and the Markdown export
was verified both on a normal conversation **and** in a Project. The `try/catch` fallback
and its toast "Impression impossible — l'export Markdown reste disponible" did not have to
be used; they stay in place.

#### The native color picker kills the popup (Firefox)

**Symptom, observed on Firefox 153.0.3 / macOS**: clicking the accent color swatch
closes the extension popup. The system picker stays open, but the chosen color
arrives nowhere — the document that was waiting for it no longer exists. Chrome, for its part, keeps its popup.

**Cause**: an action popup is an auto-closing *panel*. It closes on focus loss,
and macOS's color picker is a **window**. This is [Mozilla bug
1292701](https://bugzilla.mozilla.org/show_bug.cgi?id=1292701) ("Autoclose popups shouldn't
close when they open a modal dialog"), open since 2016, 5 duplicates, a fix *landed then
backed out* for a Windows regression. Duplicate [1713107](https://bugzilla.mozilla.org/show_bug.cgi?id=1713107)
describes exactly our case. It applies to **any** control that opens a system window,
including an `<input type="file">`: the rule to remember is not "no `type="color"`", it is
**no control that opens a system window inside the popup**.

Three leads examined, from the least invasive to the most:

| Lead | Verdict |
| --- | --- |
| **1. A setting that prevents the closing** | Failed: **none.** Nothing on the extension side: it is the panel's behavior, not a manifest option. On the browser side there is `ui.popup.disable_autohide`, but it is an `about:config` **debugging** preference, global to all the browser's panels and to be enabled by hand on each machine — it is not a shippable fix. The only workaround Mozilla recommends is to **take the control out of the panel** (options page, tab, or `windows.create()`): that does not keep the popup open, it replaces it |
| **2. Listening for `input` rather than `change`** | Failed: **moot: it was already the case.** `renderTheme()` bound `input` **and** `change` from the arrival of the theme, and the bug is observed with both in place. It is structural: the popup dies on the picker's **opening**, hence before any value change — there is no `input` to catch, only a dead document |
| **3. Replacing the control** | OK: **retained.** Eight swatches + a free hexadecimal field: two ordinary controls, no system window, hence nothing left that could close the popup |

**Applied to both browsers**, although Chrome does not have the problem. Keeping the native
picker on the Chrome side would have meant sniffing the `userAgent` and **two interfaces to maintain
in parallel** for a secondary setting — exactly the asymmetric failure this document
already keeps a list of (cf. the duplicated list of background scripts). One interface, one
tested path.

Warning: **what we lose, and what does not show in a diff**: the system's eyedropper and palettes,
which the native picker offered for free on Chrome. The hexadecimal field keeps access to
any color, but you have to know it. That is the price paid, and it is accepted.

**What was not measured**: lead 1 was ruled out on documentation (Bugzilla) and on its
interface cost, not on a measurement. In particular, we did **not** check that a
`windows.create({type:'popup'})` window survives the native picker — it is very likely (a
window is not an auto-closing panel), but it remains a deduction. It would only have
changed the decision if we had accepted replacing the anchored popup with a window.

**How to re-measure all this** if Firefox's behavior changes one day: a dead popup no longer has
a console, so a journal that survives the document is needed. Instrument the control with
a capture listener on `pointerdown`, `focus`, `input`, `change`, `blur`, `pagehide`, plus a
heartbeat every 250 ms, and write the whole thing to `storage.local` in **a single `set` per
event** (never a `get` + `set`: it is precisely the document that can die between the
two). The journal's last line, reread on the popup's next opening, dates the document's death
and says which events preceded it.

### Known reservations

None is blocking, but none must be erased when rereading this document.

- **The auto-continue cadence is only measured over 5 minutes**, in a single
  configuration (see above). Nothing is established for an inactivity of several hours,
  under memory pressure, or with other extensions active.
- **Auto-continue has never been seen clicking on Firefox** (see above). Three attempts
  to provoke the tool-use limit failed: the situation could not be assembled, so the
  test did not take place. Detection is shared code, unmodified by the port; the only
  genuinely open point is the effect of a `button.click()` on that React button on the Firefox side. To be
  seized on the fly the day the limit falls naturally in real use.
- **The assignability of the `chrome` global has never been measured in a Firefox content script.**
  It has been in the background page (conclusive), and the temporary instrumentation that
  was to settle the content script case was removed before the measurement was redone. If
  the global turned out not to be assignable there, `compat.js` would fall back on its `catch` and the content
  scripts would stay on the native `chrome.*` — which **works** on Firefox 153. It would
  therefore be a partial coverage of the insurance (background and popup yes, content scripts no),
  **not a failure**. Re-measured by putting a line back in `compat.js` and reading the console
  of a claude.ai tab.
- **The survival of a `windows.create()` window to the native picker was not measured.** It is
  the only variant of lead 1 that could have worked, and it was ruled out on its interface
  cost (it replaces the anchored popup), not on a measurement. To be re-measured only if we
  ever consider taking a control out of the popup.
- **The AMO linter was not run.** If the extension has to be signed for a permanent
  installation in Firefox release, it will see `background.service_worker` and will probably emit its
  own warning. A warning is not a rejection, but this is not verified — it is the only thing
  that could reopen the single-manifest choice.

## Known limitations

- **Web/Service Workers = blind spot.** A content script does not run in workers;
  any `fetch` emitted from a worker by claude.ai would be invisible. No workaround.
- **The `postMessage` channel is not private.** The page can read these messages, and so can any other
  extension with a MAIN content script on claude.ai.
- **claude.ai's internal endpoints are not stable.** If the usage format changes, only
  `usage-source.js` needs fixing (and `test-usage-source.js` updating). For
  context estimation, it is the URL regexes at the top of `inject.js`. The Statuspage API,
  for its part, is a documented public API: it is the most stable of the three.
- **The status is 5 min old at worst.** The start of an incident therefore does not appear
  instantly; the link to status.claude.com is there for that.
- **`ORGS_PATH` is not verified yet** — see the dedicated section at the top.
- **`severity` → `over_limit` is an extrapolation.** Only `"warning"` and `"normal"` have
  been observed; to be fixed in `statusFromSeverity()` if claude.ai uses another word
  to report a limit being reached.
- **A multi-organization account takes the first one** returned by the API, which is not
  necessarily the active one. To be refined in `pickOrgId()` if the case comes up.
- Polling runs at **1/minute**, the floor of `chrome.alarms`: consumption made in
  a few seconds only appears at the next poll. The popup shows the age of the value.
- **The theme only applies to tabs that have a content script**: a claude.ai tab
  opened before the extension was installed or reloaded only reacts once
  reloaded. Same limit as the usage polling fallback relay.
- **At `document_start` the original values are not readable yet**: only the accent
  color applies immediately. Weight, corners/shadows and font arrive a few hundred
  milliseconds later, when the site's sheets are parsed.
- **Auto-continue rests on what claude.ai *displays*, not on an API.** Three points of
  breakage, all in `autocontinue.js`: spotting the assistant's messages — the
  `.group/message-row` container (a **virtualized** list: a one-off scan only sees what is mounted),
  filtered to the assistant role by the presence of `[data-testid="action-bar-retry"]` or
  `[data-testid="action-bar-read-aloud"]` in its action bar (`action-bar-edit` marks on the
  contrary a user message; `action-bar-copy` exists on both roles and is
  **never** used as a criterion) — recognizing the button by its label (`Continue`,
  which covers `Continuer` along the way) — and reading the text itself, which must ignore any
  copy hidden for accessibility (`[aria-hidden="true"]`, `.sr-only`, `visually-hidden`…),
  without which the same passage ends up doubled. A markup rework breaks them silently —
  detection will simply stop firing.
- **The "last message" anchors to the *Continue* button, not to DOM order.**
  `querySelectorAll('.group/message-row')` returns its results in document order, which does not
  necessarily match the visual order of the conversation: an assistant-like element
  elsewhere on the page (citation card, preview…) placed *after* the real last message in the
  DOM would otherwise usurp the "last" position. `acLastAssistantRow()` therefore finds the row that
  really contains the visible button through `.closest()`, and only falls back to the last element
  of the array if the button is nested in no known row — a fallback not verified on the
  real markup, reported as such in the diagnostic journal (`last message read`).
- **The six limit phrases are only known in English.** On a French claude.ai interface,
  condition (2) will fail: no French variant has been captured, and this repo
  does not hard-code a guessed value. To be collected on a real message, then added to
  `AC_LIMIT_PHRASES` with a test in `test-autocontinue.js`.
- **`document.execCommand('insertText')` is deliberately absent.** The reference
  [claude-autocontinue](https://github.com/timothy22000/claude-autocontinue) uses it to
  *write* into the editor (its "minimize tokens" mode): it is the only reliable method to
  trigger the React/ProseMirror synthetic events of claude.ai's input — a
  `value = …` followed by a `dispatchEvent` is not enough, React sees nothing. It is also a
  **deprecated** API, which would break if Anthropic changed the editor's implementation, just like
  the other pitfalls recorded here. This extension therefore types **nothing**: it limits
  itself to clicking the button, which does not depend on the editor. If a "continuation
  prompt" mode is ever added, it will have to go through `execCommand` and inherit that
  fragility.
- **A tab opened before installation has no auto-continue**: neither a `MutationObserver`, nor an
  `acTick()` to wake by `executeScript`. Same limit as the usage polling fallback relay and
  as the theme — reload the tab.
- **The 5 s loop keeps the service worker awake** as long as a claude.ai tab is
  open *and* auto-continue is active, not paused and under its maximum. That is the price
  of a cadence below `chrome.alarms`'s one-minute floor; disabled, nothing is
  kept alive.
- **The counter can undercount with several tabs.** `autoContinueCount` is incremented
  by a read-modify-write on the page side: two tabs continuing at the same millisecond
  can lose one unit. Without consequence on the limit itself, which stays evaluated at
  each tick.
- **The folders move nodes that React manages.** That is the accepted risk of the
  feature: if the site removes an item (deleted conversation) while it is
  in one of our blocks, its `removeChild` acts on a node that is no longer at home and can
  throw. Nothing warns of it from an extension — it is the price of the "move rather than
  duplicate" choice, which is what preserves the native clicks and context menus. In case of a broken
  sidebar, emptying `folders` and `folderAssignments` puts everything back in order.
- **A slight flicker when changing conversation is normal**: the site re-renders its
  list, briefly puts the filed items back into "Récents", and the `MutationObserver`
  moves them again 120 ms later.
- **A folder's counter can exceed the visible number**: it counts the *assigned*
  conversations, some of which are not loaded into the DOM yet (pagination on scroll).
- **claude.ai's drag implementation has not been identified** (HTML5 or pointer).
  Both paths are covered and mutually exclusive, but if one day a conversation ended up
  **both** filed in a folder *and* natively pinned, it would be the sign
  that the two systems fire together. The remedy would then be to add, after our
  drop, an explicit removal from the pinning zone — and not to widen the interception, which
  would break the native drag elsewhere. Nothing of the sort has been observed.
- **The shape of the conversation response has never been captured.** The *endpoint* has been (it is
  the context estimation one), but not the structure of its JSON:
  `parseConversation()` accepts both plausible conventions (`chat_messages`/`messages`,
  `sender`/`role`, `text`/`content[]`) rather than betting on a single one, and says so in the console
  if none matches. It is the first place to fix if the export fails while the
  button is displayed.
- **The PDF depends on a `srcdoc` iframe, which inherits claude.ai's CSP.** No script is
  injected into it (`print()` is called from outside), but if the site's policy one day forbade
  inline styles, the PDF would come out unformatted — the text, for its part, would stay
  complete. The Markdown export, which depends on no CSP, stays the safest output.
- **The PDF's markdown → HTML rendering is partial**: no tables, no footnotes, no
  raw inline HTML. What is not recognized comes out as a paragraph — never lost, but not
  formatted. The `.md` file, for its part, is the exact content.
- **The design system's token names are not guaranteed stable.** If one day the accent no longer
  changes, it is `--cds-clay-emphasized` / `--cds-clay` that must be re-confirmed by
  inspecting the send button; only `theme.js` needs fixing. For the three other
  settings, the `console.warn` directly names the variable at fault.
