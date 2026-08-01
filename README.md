# @vanlandinghamlabs/lit-router

A router for Lit, built on the [Navigation API](https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API).

Private fork of `@lit-labs/router` — see [NOTICE.md](./NOTICE.md) for provenance,
licence and the full list of changes.

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
import {Router} from '@vanlandinghamlabs/lit-router/router.js';

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

## Browser support — please read

This router **requires the Navigation API**. There is no legacy fallback.

The API is Baseline **Newly** Available (January 2026: Chrome/Edge, Safari 26.2,
Firefox 147). Baseline **Widely** Available is not until roughly mid-2028, so
older engines are still in the wild.

On an engine without it, `Router` renders the current route on load but does not
intercept navigation — every link becomes an ordinary full page load. If your
server serves the app shell on every route that is slower, not broken. If it
does not, those links 404.

`supportsNavigationApi()` is exported so you can detect this at boot:

```ts
import {supportsNavigationApi} from '@vanlandinghamlabs/lit-router/router.js';

if (!supportsNavigationApi()) {
  showUpgradePrompt();
}
```

If you need real pre-2026 support, pair this with a Navigation API polyfill
rather than a second router: one decision path, with compatibility isolated in
a layer whose whole job is spec accuracy.

## Develop

```sh
npm install
npm run build        # tsc → development/
npm test             # Web Test Runner (Chromium via Playwright)
npm run check-types
```
