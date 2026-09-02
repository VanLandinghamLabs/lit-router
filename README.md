# lit-navigation-router

[![npm version](https://img.shields.io/npm/v/lit-navigation-router)](https://www.npmjs.com/package/lit-navigation-router)

A router for Lit, built on the [Navigation API](https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API).
Published on npm as [`lit-navigation-router`](https://www.npmjs.com/package/lit-navigation-router).

Fork of [`@lit-labs/router`](https://github.com/lit/lit/tree/main/packages/labs/router)
— see [NOTICE.md](./NOTICE.md) for provenance, licence and the full list of
changes. Not affiliated with or endorsed by Google or the Lit team.

```sh
npm i lit-navigation-router
```

## Why

Upstream commits navigation with `history.pushState()` and reacts to `popstate`,
but swaps the outlet only after awaiting `route.enter()`. The URL therefore
leads and the outlet lags, so the route being left re-renders with stale params
and two quick navigations can commit out of order.

`navigateEvent.intercept()` removes that: the browser commits the URL and holds
the navigation un-finished while the handler runs, and aborts
`navigateEvent.signal` when a newer navigation supersedes this one.

## Usage

Identical to upstream:

```ts
import {Router} from 'lit-navigation-router/router.js';

class MyApp extends LitElement {
  private _router = new Router(this, [
    {path: '/', render: () => html`<h1>Home</h1>`},
    {
      path: '/item/:id',
      enter: async () => {
        await import('./item-view.js'); // awaited before the outlet swaps
        return true;
      },
      render: ({id}) => html`<item-view .id=${id}></item-view>`,
    },
  ]);

  render() {
    return html`${this._router.outlet()}`;
  }
}
```

Two additions:

```ts
// Forwarded to navigateEvent.intercept()
this._router.interceptOptions = {scroll: 'manual', focusReset: 'manual'};

// goto() takes an abort signal; Router passes navigateEvent.signal for you
await routes.goto('/item/1', {signal});
```

## Nested routes and tails

A route whose pattern ends in a wildcard — `/docs/*` — hands what the wildcard
matched (the *tail*) to any `Routes` controller mounted by its `render()`. The
tail has no leading slash, and child routes are written the same way:

```ts
// Parent
{path: '/docs/*', render: () => html`<my-docs></my-docs>`}

// Child, inside <my-docs>
private _routes = new Routes(this, [
  {path: '', render: () => html`<h2>Docs</h2>`}, // /docs/
  {path: ':page', render: ({page}) => html`<doc-page .page=${page}></doc-page>`}, // /docs/intro
]);
```

The index of a nested route space is the empty tail, spelled `{path: ''}`.
`{path: '/'}` matches nothing there: it would need a tail of `/`, i.e. a URL of
`/docs//`.

Only a trailing wildcard produces a tail. An unnamed regex group
(`/post/(\d+)`) or a wildcard followed by more pattern (`/a/*/b`) is a
parameter of that route, available as `params[0]`; it is neither passed to
children nor stripped from `link()`. A `fallback` behaves like a `/*` route and
passes the whole pathname on as the tail. Nested, it accepts the slash-less
tail it is handed and passes that on.

## Browser support — please read

This router **requires the Navigation API**. There is no legacy fallback.

The API is Baseline **Newly** Available (January 2026: Chrome/Edge, Safari 26.2,
Firefox 147). Baseline **Widely** Available is not until roughly mid-2028, so
older engines are still in the wild.

On an engine without it, `Router` renders the current route on load but does not
intercept navigation — every link becomes an ordinary full page load. If your
server serves the app shell on every route that is slower, not broken. If it
does not, those links 404.

**One case is genuinely broken, not just slow.** If you navigate
programmatically with `history.pushState()` + `router.goto()`, nothing listens
for the resulting `popstate` — so Back moves the URL while the outlet stays put,
which is the URL/outlet split this fork exists to eliminate. Apps using that
pattern should gate on `supportsNavigationApi()` rather than accept the
degradation.

`supportsNavigationApi()` is exported so you can detect this at boot:

```ts
import {supportsNavigationApi} from 'lit-navigation-router/router.js';

if (!supportsNavigationApi()) {
  showUpgradePrompt();
}
```

If you need real pre-2026 support, pair this with a Navigation API polyfill
rather than a second router: one decision path, with compatibility isolated in
a layer whose whole job is spec accuracy.

## `URLPattern`

Route patterns are compiled with `URLPattern`, which this package uses from the
global scope and does **not** polyfill — same as upstream. Every engine that has
the Navigation API also has `URLPattern`, so if the support check above passes
you need nothing. If you support older engines anyway, load
[`urlpattern-polyfill`](https://www.npmjs.com/package/urlpattern-polyfill)
before the router:

```ts
import {URLPattern} from 'urlpattern-polyfill';
if (!globalThis.URLPattern) {
  (globalThis as {URLPattern?: unknown}).URLPattern = URLPattern;
}
```

The published types do not depend on it — `URLPatternRouteConfig.pattern` is
typed structurally, so a consumer build never needs the polyfill's types.

## Develop

```sh
npm install
npm run build        # tsc → development/
npm test             # Web Test Runner (Chromium via Playwright)
npm run check-types
```
