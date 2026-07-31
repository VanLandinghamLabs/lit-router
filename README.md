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

## Browser support

The Navigation API is Baseline **Newly** Available (January 2026: Chrome/Edge,
Safari 26.2, Firefox 147). Older engines fall back automatically to the legacy
click + `popstate` path — `supportsNavigationApi()` is exported if you want to
branch on it yourself.

## Develop

```sh
npm install
npm run build        # tsc → development/
npm test             # Web Test Runner (Chromium via Playwright)
npm run check-types
```
