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

Original copyright **Google LLC**, retained in `LICENSE` and in the per-file
headers. Modified files carry an additional VanLandingham Labs modification
notice under the same licence, as BSD-3-Clause requires.

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

### `src/routes.ts` — one behavioural change

- `goto(pathname, options?)` accepts `options.signal`. After `enter()` resolves,
  an aborted signal makes `goto()` return without committing. The option is
  propagated to child routes. Everything else is untouched.

### Build and tests

Upstream's package is wired into the lit monorepo (wireit, `@lit-internal/scripts`,
`treemirror`, `../../tests`). This fork replaces that with plain `tsc` + Web Test
Runner so it stands alone. Test changes:

- Imports rewritten from `@lit-labs/router/*` to relative paths.
- `stripExpressionComments` reimplemented locally (`src/test/test-helpers.ts`)
  in place of the monorepo-internal `@lit-labs/testing`.
- `chai` → `@open-wc/testing` (browser-native ESM).
- **Upstream's 6 tests are otherwise unmodified and pass**, which is the main
  evidence that the rewrite preserves existing behaviour.
- 5 new tests in `src/test/navigation_test.ts` cover the Navigation API path.
  The first asserts the suite is actually running against `window.navigation`
  rather than silently falling back — without it the other four would pass
  against the legacy path and prove nothing.

## Verified

`npm test` → 11 passed (6 upstream + 5 new), Chromium via Playwright.

The signal guard is mutation-checked: replacing `if (signal?.aborted)` with a
dead condition fails `a superseded navigation does not win the outlet` with
`expected 'A' to include 'B'` — the superseded route swapping the outlet back,
which is the exact failure this fork exists to prevent.

## Merging upstream later

`.upstream-commit` records the fork point. To pull upstream changes:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/lit/lit.git
cd lit && git sparse-checkout set packages/labs/router
```

then diff `packages/labs/router/src` against this repo's `src`. Only
`router.ts` and `goto()` in `routes.ts` diverge meaningfully.
