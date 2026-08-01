# Provenance

This is a fork of **`@lit-labs/router`**, which is not a standalone repository —
it lives inside the `lit/lit` monorepo at `packages/labs/router`.

| | |
|---|---|
| Upstream | https://github.com/lit/lit/tree/main/packages/labs/router |
| Upstream version | `@lit-labs/router@0.1.4` (latest published at fork time) |
| Upstream commit | `c42ee1e96b8fd61f7256f61d715daef572e76e52` |
| Forked | 2026-07-31 |
| Licence | BSD-3-Clause — unchanged, see `LICENSE` |

Original copyright **Google LLC**, retained verbatim in `LICENSE` and in every
per-file header. BSD-3-Clause requires retention of the copyright notice, the
conditions and the disclaimer — it does *not* require a modification notice
(that is Apache-2.0 §4(b)). Modified files carry one anyway, as a courtesy to
anyone diffing against upstream.

Published as `lit-navigation-router`. Deliberately *not* named
`@lit-labs/router` — that name belongs to the Lit team, and a fork
masquerading as upstream would be worse than useless when debugging. This
package is not affiliated with or endorsed by Google or the Lit team; the
reference to Lit describes what it is for.

In the source repository (not the published tarball), `UPSTREAM-README.md` and
`UPSTREAM-CHANGELOG.md` are upstream's, kept verbatim for reference, and
`.upstream-commit` records the fork point.

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
- **The legacy click/popstate path is deleted.** Ten review rounds found
  divergences between it and `_onNavigate`, and every one was in the click
  handler — structural, not luck: `_onNavigate` reads a decision the browser
  already made, while the click handler re-derived it, re-implementing the
  rules for choosing a navigable, the fragment-navigation predicate and the
  modifier-key rules. Each round found another place the re-implementation and
  the spec disagreed. On an engine without the API links become ordinary full
  page loads (slower, not broken, for a server that serves the shell on every
  route); `supportsNavigationApi()` is exported so an app can detect it.

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
- New `hasRouteFor(pathname)`, used by `Router` to decline what it cannot
  render.

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
- The `seen` set in `_supersede()` is defence in depth and unpinned **by
  construction**: since `hostDisconnected` removes its listener, no test can
  build a `_childRoutes` cycle any more.
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
- 14 new tests in `src/test/navigation_test.ts` cover the Navigation API path.
  The first asserts the suite is actually running against `window.navigation`
  rather than silently falling back — without it the rest would pass against the
  legacy path and prove nothing. It is kept as a guard for the day this
  package's requirement changes.

## Verified

`npm test` → 20 passed (6 upstream + 14 new), Chromium via Playwright.

Run `npm run clean` before a mutation check: the build is `composite`/
`incremental`, and a stale `development/` can contain a hunk's comment without
its code, greening the suite against output that lacks the change.

## Merging upstream later

`.upstream-commit` in the repository records the fork point. To pull upstream
changes:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/lit/lit.git
cd lit && git sparse-checkout set packages/labs/router
```

then diff `packages/labs/router/src` against this repo's `src`. Only
`router.ts` and `goto()` in `routes.ts` diverge meaningfully.
