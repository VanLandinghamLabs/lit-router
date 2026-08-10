/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Modifications Copyright 2026 VanLandingham Labs, same license.
 * Rebuilt on the Navigation API; see NOTICE.md.
 */

import {Routes} from './routes.js';

/**
 * The slice of `NavigateEvent` this router reads. Declared locally rather than
 * typing the handler `any`: these properties *are* the correctness boundary, so
 * a typo like `hashchange` for `hashChange` would silently disable a filter
 * forever. Names verified against Chromium's `NavigateEvent.prototype`.
 */
interface NavigateEventLike {
  readonly canIntercept: boolean;
  readonly hashChange: boolean;
  readonly downloadRequest: string | null;
  readonly formData: FormData | null;
  readonly navigationType: 'push' | 'replace' | 'reload' | 'traverse';
  readonly signal: AbortSignal;
  readonly destination: {readonly url: string};
  /** Not in every engine yet; used only as a best-effort `rel` check. */
  readonly sourceElement?: Element | null;
  intercept(options: InterceptOptions & {handler?: () => Promise<void>}): void;
}

/** The subset of `NavigationInterceptOptions` this router forwards. */
export interface InterceptOptions {
  focusReset?: 'after-transition' | 'manual';
  scroll?: 'after-transition' | 'manual';
}

interface NavigationLike {
  addEventListener(
    type: 'navigate',
    listener: (e: NavigateEventLike) => void
  ): void;
  removeEventListener(
    type: 'navigate',
    listener: (e: NavigateEventLike) => void
  ): void;
}

const getNavigation = (): NavigationLike | undefined =>
  (window as unknown as {navigation?: NavigationLike}).navigation;

/**
 * True when the Navigation API is available — Baseline Newly Available since
 * January 2026 (Chrome/Edge, Safari 26.2, Firefox 147).
 *
 * This router **requires** it. Exported so an app can detect an unsupported
 * engine at boot and say so, rather than leaving the user to notice that every
 * link reloads the page.
 */
export const supportsNavigationApi = (): boolean =>
  typeof window !== 'undefined' &&
  typeof getNavigation()?.addEventListener === 'function';

/**
 * A root-level router that intercepts navigation via the Navigation API.
 *
 * This class extends Routes so that it can also have a route configuration.
 *
 * There should only be one Router instance on a page, since the Router
 * installs a global listener. Nested routes should be configured with the
 * `Routes` class.
 *
 * ## Why the Navigation API
 *
 * Upstream intercepted navigation with a global click listener plus `popstate`
 * and committed with `history.pushState()`. That is structurally racy:
 * `pushState` is synchronous and `popstate` fires *after* the URL has already
 * moved, but `goto()` awaits `route.enter()` before swapping the outlet. The
 * URL leads and the outlet lags, leaving two sources of truth — the outgoing
 * route re-renders with stale params, and two quick navigations commit in
 * whatever order their `enter()` hooks happen to resolve.
 *
 * `navigateEvent.intercept({handler})` collapses that. The browser commits the
 * URL and holds the navigation un-finished while the handler runs, and it
 * aborts `navigateEvent.signal` when a newer navigation supersedes this one —
 * which `goto()` honours, so a superseded route can no longer win the outlet.
 *
 * ## No legacy fallback
 *
 * An earlier version of this fork kept upstream's click/popstate path for
 * pre-2026 engines. It was removed deliberately. Ten review rounds found
 * divergences between the two paths and **every one was in the click handler**,
 * never in this one — which is structural, not luck: this handler reads a
 * decision the browser has already made, while the click handler had to
 * re-derive it, re-implementing the rules for choosing a navigable, the
 * fragment-navigation predicate, and the modifier-key rules. Each round found
 * another place where the re-implementation and the spec disagreed.
 *
 * On an engine without the API, links fall back to ordinary full page loads.
 * For an app whose server serves the shell on every route that still works —
 * it is slower, not broken — and `supportsNavigationApi()` lets you detect it.
 * If real pre-2026 support is ever needed, use a Navigation API polyfill: one
 * decision path, with compatibility isolated in a layer whose whole job is
 * spec accuracy.
 */
export class Router extends Routes {
  /**
   * Options forwarded to `navigateEvent.intercept()`. Leaving these unset
   * gives the browser's default scroll and focus handling.
   */
  interceptOptions?: InterceptOptions;

  private _listening = false;

  override hostConnected() {
    super.hostConnected();
    // Gated on the exported predicate, not on `navigation !== undefined`:
    // a stub or partial polyfill under that name would otherwise make this
    // branch throw out of connectedCallback while `supportsNavigationApi()`
    // told the app it was unsupported — and then even the initial render below
    // would not run.
    if (supportsNavigationApi()) {
      getNavigation()!.addEventListener('navigate', this._onNavigate);
      this._listening = true;
    }
    // Kick off routed rendering by going to the current URL. Done even without
    // the API: a full page load still renders the right route, which is what
    // makes the unsupported-engine degradation "slow" rather than "blank".
    // Surfaced rather than left as a bare unhandled rejection, matching the
    // convention in routes.ts: on an engine without the API this is the *only*
    // rendering path, and a deep link with no matching route throws here.
    void this.goto(window.location.pathname).catch((err) => {
      queueMicrotask(() => {
        throw err;
      });
    });
  }

  override hostDisconnected() {
    super.hostDisconnected();
    if (this._listening) {
      getNavigation()?.removeEventListener('navigate', this._onNavigate);
      this._listening = false;
    }
  }

  /**
   * Handles same-document navigation from every source at once: anchor clicks,
   * `navigation.navigate()`, `history.pushState()`, and back/forward.
   */
  private _onNavigate = (e: NavigateEventLike) => {
    // Not ours to handle: anything the browser says cannot be intercepted,
    // fragment-only moves, downloads, and POST form submissions.
    if (
      !e.canIntercept ||
      e.hashChange ||
      e.downloadRequest !== null ||
      e.formData !== null
    ) {
      return;
    }

    // Reloads must stay reloads. `canIntercept` is true for them, so without
    // this `location.reload()` silently degrades to re-running goto() on the
    // same path — the document is never replaced, breaking the standard
    // "new version available, reload" escape hatch. (It would also disagree
    // with the browser's own refresh button, which is not interceptable.)
    if (e.navigationType === 'reload') {
      return;
    }

    // `rel="external"` is a convention this router honours — it is not defined
    // by HTML or by the Navigation API, so the browser will not decline these
    // for us. Best-effort: `sourceElement` is not in every engine, and is
    // absent for programmatic navigation.
    if (e.sourceElement?.getAttribute?.('rel') === 'external') {
      return;
    }

    // Read per navigation rather than cached at module scope: the value cannot
    // change, but reading it on import makes merely importing this module throw
    // where there is no `location` (SSR, a bundler evaluating for tree-shaking
    // under the package's `sideEffects: false` claim).
    const url = new URL(e.destination.url);
    if (url.origin !== window.location.origin) {
      return;
    }

    // Only intercept what we can actually render. `canIntercept` is true for
    // any same-origin URL, including cross-document ones — so without this a
    // link to a server-rendered page, an export endpoint, or a GET form
    // (whose `formData` is null) gets swallowed: the URL commits, goto()
    // throws "No route found", and the address bar is left pointing somewhere
    // the outlet never went. Declining lets the browser do the real
    // navigation, which is the correct outcome.
    if (!this.hasRouteFor(url.pathname)) {
      return;
    }

    e.intercept({
      ...this.interceptOptions,
      handler: async () => {
        // `e.signal` aborts if another navigation starts before this handler
        // resolves; goto() checks it after `enter()` and stands down.
        await this.goto(url.pathname, {signal: e.signal});
      },
    });
  };
}
