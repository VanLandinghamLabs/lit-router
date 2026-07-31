# Provenance

This is a fork of **`@lit-labs/router`**, which is not a standalone repository —
it lives inside the `lit/lit` monorepo at `packages/labs/router`.

| | |
|---|---|
| Upstream | https://github.com/lit/lit/tree/main/packages/labs/router |
| Upstream version | `@lit-labs/router@0.1.4` (latest published at fork time) |
| Upstream commit | `c42ee1e96b8fd61f7256f61d715daef572e76e52` (also in `.upstream-commit`) |
| Forked | 2026-07-31 |
| Licence | BSD-3-Clause — unchanged, see `LICENSE` |

Original copyright **Google LLC**, retained verbatim in `LICENSE` and in every
per-file header. BSD-3-Clause requires retention of the copyright notice, the
conditions and the disclaimer — it does *not* require a modification notice
(that is Apache-2.0 §4(b)). Modified files carry one anyway, as a courtesy to
anyone diffing against upstream.

This fork is **private and unpublished**. It is deliberately *not* named
`@lit-labs/router` — the npm scope belongs to the Lit team, and a fork
masquerading as upstream would be worse than useless when debugging.

`UPSTREAM-README.md` and `UPSTREAM-CHANGELOG.md` are upstream's, kept verbatim
for reference.

## Why fork

Upstream `Router` intercepts navigation with a global click listener plus
`popstate`, and commits with `history.pushState()`. That has a structural
flaw: `pushState` is synchronous and `popstate` fires *after* the URL has
already moved, but `Routes.goto()` awaits `route.enter()` before swapping the
outlet. The URL leads and the outlet lags, which leaves two sources of truth.

In arcsync that produced a run of bugs with one root cause — the outgoing route
re-rendering with stale params, and quick successive navigations committing in
whichever order their `enter()` hooks happened to resolve:

- `VanLandinghamLabs/arcsync#258` — direct load of `/markdown/:id` degraded to a demo route
- `VanLandinghamLabs/arcsync#632` — route commits landed in chunk-download order
- `VanLandinghamLabs/arcsync#640` — a route re-entered its own loader
- Tracking issue: `VanLandinghamLabs/arcsync#648`

Upstream's own source carries the matching TODO, removed in this fork because
it is now answered:

> `// TODO (justinfagnani): do we need to detect when goto() is called while a previous goto() call is still pending?`

## Changes from upstream

### `src/router.ts` — rewritten on the Navigation API

- Listens for `navigate` on `window.navigation` and calls
  `navigateEvent.intercept({handler})`. The browser commits the URL and holds
  the navigation un-finished while `goto()` runs, so URL and outlet move
  together.
- Threads `navigateEvent.signal` into `goto()` so a superseded navigation
  stands down instead of racing.
- Covers navigation the legacy path could not see at all: `navigation.navigate()`,
  `history.pushState()`, and traversals — not just anchor clicks and popstate.
- Skips what isn't ours: `!canIntercept`, `hashChange`, `downloadRequest`,
  form submissions, and cross-origin destinations.
- New `interceptOptions` field forwards `focusReset` / `scroll` to `intercept()`.
- **The legacy click/popstate path is retained as a feature-detected fallback.**
  The Navigation API reached Baseline *Newly* Available in January 2026
  (Chrome/Edge, Safari 26.2, Firefox 147); Baseline *Widely* Available is not
  until roughly mid-2028, so older engines still need the old path.

### `src/routes.ts` — behavioural changes

- `hostDisconnected` removes the `lit-routes-connected` listener that
  `hostConnected` adds. Upstream leaves it, so a host that is disconnected and
  reconnected (a `repeat()` reorder, a tab swap) ends up with two sibling
  controllers registered as each other's child — a real `_childRoutes` cycle,
  which turns `goto()`'s propagation loop and any recursive walk into a stack
  overflow. `_supersede()` also carries a visited set as defence in depth.

- `goto(pathname, options?)` accepts `options.signal`; an aborted signal after
  `enter()` resolves makes `goto()` return without committing.
- **Per-controller last-goto-wins counter.** The signal alone is not enough: a
  child controller mounts as a *result* of its parent's render, so its first
  `goto()` comes from `_onRoutesConnected` — after the parent's navigation has
  already finished, holding a signal that will never abort. Without the counter
  a slow first child load commits over a newer one. This also keeps `Routes`
  correct standalone, with no `Router` and no Navigation API involved.
- Child `goto()`s stay **unawaited** (as upstream) and, like upstream, are given
  **no abort signal** — the parent commits before children run, so a child
  handed an aborted signal stands down with no newer `goto()` to correct it and
  the nested outlet sticks. A child with no route for the new tail (the outgoing
  branch, mid-swap) is skipped structurally via `hasRouteFor`, so a genuine
  `enter()` rejection still surfaces rather than being swallowed. An
  earlier revision awaited them to make `navigation.finished` cover the whole
  tree; that was wrong twice over — at that point `requestUpdate()` has not run,
  so `_childRoutes` still holds the *outgoing* branch, and awaiting it both
  gated the parent's outlet swap on an `enter()` for a tail that child would
  never render, and let its `No route found` throw strand the parent entirely.
  Nested supersession is the counter's job, not the await's.
- The fallback click path gained the same `hasRouteFor` gate (it calls
  `preventDefault()` first, so swallowing an unrenderable link there also stops
  the browser doing the real navigation) and a fragment-only-link guard. A
  fragment move is a same-document navigation, so it fires `popstate` too —
  `_onPopState` therefore no-ops when only the fragment changed, which is the
  other half of matching `_onNavigate`'s `hashChange` behaviour.
- New `hasRouteFor(pathname)`, used by `Router` to decline what it cannot
  render.

### What the fallback promises

The legacy click/popstate path is **best-effort compatibility for pre-2026
engines, not a decision-identical twin of `_onNavigate`.** Nine review rounds on
this fork found real divergences in it and every one was in `_onClick`; the
Navigation API path has been stable throughout. The parity table is what keeps
the two aligned on the inputs it can vary, and the known gaps are listed below
rather than pretended away.

If your browser support baseline is Safari 26.2 / Firefox 147 or newer, deleting
the fallback outright removes this entire class of defect and about a third of
`router.ts`.

### Known limits

- `navigation.finished` covers the top-level route, not nested ones. Making it
  cover the tree needs awaiting the children the navigation is moving *to*,
  which means awaiting past `requestUpdate()` and the host's update cycle — a
  materially bigger change than it looks.
- `hasRouteFor()` is a no-op for apps that configure a root `fallback`, since
  every path then matches. That is the app's stated intent, but it means the
  "decline what we cannot render" fix does not reach that configuration.
- `goto()` still ignores the query string (upstream limitation), so a GET form
  whose action matches a route is intercepted and loses its query.
- **Fallback path only**, all verified divergences from `_onNavigate` that are
  not fixed: a link inside a **closed** shadow root (`composedPath()` is
  retargeted, so the anchor is invisible to a `window` listener) and an SVG
  `<a>` (lowercase `tagName`, `href.baseVal`). `<area>` *is* handled.
- The `seen` set in `_supersede()` is defence in depth and unpinned **by
  construction**: since `hostDisconnected` removes its listener, no test can
  build a `_childRoutes` cycle any more.
- An app setting `interceptOptions = {scroll: 'manual'}` gets no scroll on the
  Navigation API path but still gets the browser's on the fallback.
- A child skipped because it cannot render the new tail keeps its previously
  *committed* outlet — it is superseded (no in-flight navigation can commit)
  but not cleared, so it goes on rendering the route the URL has left. Upstream
  had the same end state by a different route (`No route found` threw before
  any state changed). Clearing it needs `_currentRoute` reset plus a host
  update, which is a behaviour change rather than a bug fix.

### Build and tests

Upstream's package is wired into the lit monorepo (wireit, `@lit-internal/scripts`,
`treemirror`, `../../tests`). This fork replaces that with plain `tsc` + Web Test
Runner so it stands alone. Test changes:

- Imports rewritten from `@lit-labs/router/*` to relative paths.
- `stripExpressionComments` reimplemented locally (`src/test/test-helpers.ts`)
  in place of the monorepo-internal `@lit-labs/testing`.
- `chai` → `@open-wc/testing` (browser-native ESM).
- Two `(r: RouteConfig)` annotations added in `router_test.ts` (upstream relied
  on monorepo-wide inference). **Otherwise upstream's 6 tests are unmodified and
  pass**, which is the main evidence that the rewrite preserves behaviour.
- 46 new tests in `src/test/navigation_test.ts` cover the Navigation API path.
  The first asserts the suite is actually running against `window.navigation`
  rather than silently falling back — without it the rest would pass against the
  legacy path and prove nothing. Two more delete `window.navigation` from the
  frame realm before mounting, which is the only way to genuinely exercise the
  retained fallback — Chromium always has the API, so before this both legacy
  handlers could be booby-trapped without failing a single test.

## Verified

`npm test` → 52 passed (6 upstream + 46 new), Chromium via Playwright.

Run `npm run clean` before a mutation check: the build is `composite`/
`incremental`, and a stale `development/` can contain a hunk's comment without
its code, greening the suite against output that lacks the change.

### Click-decision parity

`src/test/navigation_test.ts` ends with a table-driven suite asserting the one
invariant `_onClick` has: **for any (current URL, anchor href) pair, the legacy
path and `_onNavigate` reach the same decision** — routed in place, or handed to
the browser.

It exists because the per-case tests above it were not enough. Each pinned the
symptom a specific review had named, and each was satisfiable without the
invariant holding: the guard was widened until a bare `#` link worked (which
broke self-links into full page reloads), then narrowed until self-links worked
(which left the fallback a silent no-op where the Navigation API path
re-routes). Both regressions shipped. The parity table catches both — and the
second one is caught by *nothing else in the suite*.

Add a row here before touching `_onClick`. Two things make the table actually
bite, both learned the hard way:

- **Vary pathname and search, not just the fragment.** With every row starting
  at `/a` and targeting `/a`, those conjuncts go unpinned and a widened guard
  passes — how one shipped regression got through.
- **Vary the anchor's attributes.** `_onClick` branches on `target`, `download`
  and `rel`, so a table keyed on `(start, href)` covers a *projection* of the
  handler's input domain, not the domain. `target="_self"` diverged through
  every earlier round because of exactly this.

Every conjunct of the fragment guard is individually mutation-pinned by a row.

**The table cannot reach every input.** `decide()` runs each case inside an
iframe, so the *framing context* is pinned — and framed, `_top`/`_parent`
genuinely do target elsewhere, which is what made an earlier `_self`-only check
look correct for two rounds. Anything `_onClick` reads that the table cannot
vary needs a direct test instead; `targetsThisNavigable()` is exported and unit
-tested for exactly that reason. The full list of what `_onClick` reads:
`button`, `metaKey`, `ctrlKey`, `shiftKey`, `altKey`, `defaultPrevented`,
`composedPath()` (element kind **and** shadow mode), `target` × framing,
`download`, `rel`, `href`, `origin`, `pathname`, `search`, `hash` — plus
trusted-vs-synthetic events, which the harness cannot produce.

Every guard added by this fork is mutation-checked — each one deleted
individually fails at least one test (except `_supersede()`'s `seen` set, see
Known limits):

| Guard | Test that fails |
|---|---|
| per-controller goto counter | a superseded navigation does not win a NESTED outlet |
| `signal.aborted` check | an aborted signal stands a goto down even with no newer goto |
| `navigationType === 'reload'` filter | a reload is left alone |
| `rel="external"` filter | rel="external" opts out on the Navigation API path too |
| `hasRouteFor()` gate (Navigation API path) | a path with no route is left to the browser |
| `hasRouteFor()` gate (fallback click path) | the fallback path also declines a path it cannot render |
| fragment-link guard (fallback click path) | the fallback path leaves fragment-only links to the browser |
| `_supersede()` on a skipped child | a child that cannot render the new tail is still superseded |
| `hasRouteFor` filter (late-mount path) | a deep link under a wildcard the child cannot render does not throw |
| popstate fragment no-op | a bare "#" link is left to the browser as well |
| `goto()` bookkeeping sync | Back after a programmatic pushState still routes |
| self-link hash condition | a self-link does not reload the document |
| recursive `_supersede()` | supersession reaches a grandchild under a skipped child |
| `hostDisconnected` listener removal | a reconnect does not make sibling controllers each other's child |
| `target="_self"` acceptance | click decision parity: target="_self" |
| conditional `preventDefault()` | re-clicking the fragment you are on still scrolls |
| pushState gate in `_onClick` | a self-link does not add a history entry |
| identical-URL clause in the fragment guard | click decision parity: the fragment link you are already on |

## Merging upstream later

`.upstream-commit` records the fork point. To pull upstream changes:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/lit/lit.git
cd lit && git sparse-checkout set packages/labs/router
```

then diff `packages/labs/router/src` against this repo's `src`. Only
`router.ts` and `goto()` in `routes.ts` diverge meaningfully.
