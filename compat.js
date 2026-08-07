// To be loaded FIRST in every context, before any other script of the repo.
//
// SAFETY NET, NOT THE FIX FOR AN OBSERVED BUG. Verified under real conditions on
// Firefox 153.0: chrome.* already returns real promises there, exactly like browser.*, so
// the repo's ~29 .then() chains work as-is, without this file.
//
// Why add it anyway: this behavior is documented NOWHERE. MDN and Extension
// Workshop only say that chrome.* ACCEPTS callbacks — never that it returns a
// promise when the callback is omitted. It is an implementation detail (a single
// promise-based implementation, the callback being only an optional wrapper), not a
// contract. An undocumented surface can change without a release note, and the failure would
// here be total and silent: the 29 sites throwing TypeError at once, in every context
// at the same time. So we alias onto browser.*, which is documented.
//
// Cannot break anything, by construction:
//   - Firefox      : the alias succeeds and the whole repo moves to the documented surface;
//   - Chrome >= 148: "browser" ALSO exists since that version and exposes the SAME API
//     objects as "chrome" (chrome.tabs === browser.tabs, documented by Google), so the alias
//     happens there but changes nothing in behavior. Measured on Chrome 150: the two
//     TOP-level objects stay distinct (chrome === browser is false), only the
//     sub-APIs are shared — do not use "chrome === browser" as proof that this
//     file has run somewhere, it is not one;
//   - Chrome < 148 : "browser" does not exist, the condition is false, this file does NOTHING;
//   - if the global were not assignable, the catch leaves us on the native chrome.*,
//     that is to say exactly the state that works today.
//
// Warning: one known condition disables "browser" on the Chrome side: declaring a devtools_page
// turns the namespace off for the WHOLE extension. We have none. If we added one, the
// condition below would become false and we would fall back to the native chrome.* — clean
// degradation, but worth knowing.
//
// Warning: A CONSEQUENCE NOT TO FORGET WHEN WRITING CODE: after this alias, "chrome.*" IS
// "browser.*", which is promise-only on the Firefox side and rejects a superfluous callback argument.
// Any call in callback style therefore becomes suspect. The repo has only ONE,
// show() in background.js — everywhere else it is .then(). Do not reintroduce any.
//
// Warning: this file is evaluated ONCE PER content_scripts ENTRY, that is six times per frame, in
// the same isolated world. It must therefore stay strictly idempotent: no counter, no log,
// no cumulative side effect here.
//
// Deliberately without 'use strict' and without an IIFE: we need to assign the "chrome" global itself,
// which the rest of the repo calls by that name. That is what avoids having to rename the
// ~150 occurrences of "chrome." to an alias name.
try {
  if (typeof browser !== 'undefined' && browser.runtime) chrome = browser;
} catch (e) { /* global not assignable: we keep the native chrome.* */ }
