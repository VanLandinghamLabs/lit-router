/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Modifications Copyright 2026 VanLandingham Labs, same license.
 * Rebuilt on the Navigation API; see NOTICE.md.
 */

import {Routes} from './routes.js';

// We cache the origin since it can't change
const origin = location.origin || location.protocol + '//' + location.host;

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

/**
 * Whether a link's `target` resolves to the navigable we are routing.
 *
 * `_onNavigate` fires for anything that stays in this navigable, so the
 * fallback has to make the same call — and `_top`/`_parent` are *not* a fixed
 * answer: unframed they are this navigable, framed they are somewhere else.
 * An earlier version rejected them outright, which meant an unframed
 * `<a target="_top">` returned without `preventDefault()` and the browser
 * replaced the document while `_onNavigate` soft-routed.
 */
export const targetsThisNavigable = (
  target: string,
  win: {top: unknown; parent: unknown; name: string} = window
): boolean =>
  target === '' ||
  target === '_self' ||
  (target === '_top' && win.top === win) ||
  (target === '_parent' && win.parent === win) ||
  (target !== '_blank' && target === win.name);

/** The URL up to but excluding the fragment. */
const preFragment = (url: string): string => {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
};

const getNavigation = (): NavigationLike | undefined =>
  (window as unknown as {navigation?: NavigationLike}).navigation;

/**
 * True when the Navigation API is available. Baseline Newly Available since
 * January 2026 (Chrome/Edge, Safari 26.2, Firefox 147); the legacy
 * click + popstate path below is kept for engines older than that.
 */
export const supportsNavigationApi = (): boolean =>
  typeof window !== 'undefined' &&
  typeof getNavigation()?.addEventListener === 'function';

/**
 * A root-level router that intercepts navigation.
 *
 * This class extends Routes so that it can also have a route configuration.
 *
 * There should only be one Router instance on a page, since the Router
 * installs global listeners. Nested routes should be configured with the
 * `Routes` class.
 *
 * ## Why the Navigation API
 *
 * The legacy path (kept below as a fallback) has a structural flaw that the
 * Navigation API removes rather than mitigates. `pushState` is synchronous and
 * `popstate` fires *after* the URL has already moved, but `goto()` awaits
 * `route.enter()` before swapping the outlet. So the URL leads and the outlet
 * lags, leaving two sources of truth: the outgoing route re-renders with stale
 * params, and two quick navigations commit in whatever order their `enter()`
 * hooks happen to resolve rather than in navigation order.
 *
 * `navigateEvent.intercept({handler})` collapses that. The browser commits the
 * URL and holds the navigation un-finished while the handler runs, and it
 * aborts `navigateEvent.signal` when a newer navigation supersedes this one —
 * which `goto()` honours, so a superseded route can no longer win the outlet.
 */
export class Router extends Routes {
  /**
   * Options forwarded to `navigateEvent.intercept()`. Leaving these unset
   * gives the browser's default scroll and focus handling, which the legacy
   * path could not offer at all.
   */
  interceptOptions?: InterceptOptions;

  private _usingNavigationApi = false;
  /** Fragment-change detection for the fallback popstate handler. */
  private _lastRoutedPath = location.pathname;
  private _lastRoutedSearch = location.search;

  /**
   * Records what was actually routed, for the fallback popstate handler.
   *
   * It has to live here rather than in the individual handlers: an app may
   * navigate with `history.pushState()` + `goto()` directly (the documented
   * pattern for programmatic navigation), which no handler observes. Tracking
   * it there instead left the field on the last *clicked* URL, so a Back after
   * a programmatic navigation looked like a fragment-only move and was
   * skipped — outlet stranded, address bar moved, i.e. this fork's own bug.
   */
  override async goto(pathname: string, options?: {signal?: AbortSignal}) {
    this._lastRoutedPath = pathname;
    this._lastRoutedSearch = location.search;
    return super.goto(pathname, options);
  }

  override hostConnected() {
    super.hostConnected();
    this._usingNavigationApi = supportsNavigationApi();
    if (this._usingNavigationApi) {
      getNavigation()!.addEventListener('navigate', this._onNavigate);
    } else {
      window.addEventListener('click', this._onClick);
      window.addEventListener('popstate', this._onPopState);
    }
    // Kick off routed rendering by going to the current URL. This is not a
    // navigation, so it never produces a `navigate` event.
    this.goto(window.location.pathname);
  }

  override hostDisconnected() {
    super.hostDisconnected();
    if (this._usingNavigationApi) {
      getNavigation()!.removeEventListener('navigate', this._onNavigate);
    } else {
      window.removeEventListener('click', this._onClick);
      window.removeEventListener('popstate', this._onPopState);
    }
  }

  /**
   * Handles same-document navigation from every source at once: anchor clicks,
   * `navigation.navigate()`, `history.pushState()`, and back/forward. The
   * legacy path needed two listeners to cover a strict subset of these, and
   * could not observe programmatic navigation at all.
   */
  private _onNavigate = (e: NavigateEventLike) => {
    // Not ours to handle: anything the browser says cannot be intercepted,
    // fragment-only moves, downloads, and POST form submissions.
    if (!e.canIntercept || e.hashChange || e.downloadRequest !== null) {
      return;
    }
    if (e.formData) {
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

    // Honour the `rel="external"` opt-out that the legacy click path has, so
    // the two paths this package ships agree. Best-effort: `sourceElement` is
    // not in every engine, and is absent for programmatic navigation.
    if (e.sourceElement?.getAttribute?.('rel') === 'external') {
      return;
    }

    const url = new URL(e.destination.url);
    if (url.origin !== origin) {
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

  private _onClick = (e: MouseEvent) => {
    const isNonNavigationClick =
      e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
    if (e.defaultPrevented || isNonNavigationClick) {
      return;
    }

    const anchor = e
      .composedPath()
      .find(
        (n) =>
          n instanceof HTMLAnchorElement || n instanceof HTMLAreaElement
      ) as HTMLAnchorElement | HTMLAreaElement | undefined;
    if (
      anchor === undefined ||
      !targetsThisNavigable(anchor.target, window) ||
      anchor.hasAttribute('download') ||
      anchor.getAttribute('rel') === 'external'
    ) {
      return;
    }

    const href = anchor.href;
    if (href === '' || href.startsWith('mailto:')) {
      return;
    }

    const location = window.location;
    if (anchor.origin !== origin) {
      return;
    }

    // Fragment-only move: leave it to the browser, as `_onNavigate` does via
    // `hashChange`. Otherwise the fallback would preventDefault() (so no
    // scroll-to-fragment) and re-run the current route's `enter()`. `anchor.hash` is `''` for `<a href="#">` — the commonest
    // fragment link there is — so the `endsWith('#')` arm is needed to catch
    // it. The hash test itself must stay: without it a plain self-link
    // (`<a href="/a">` while on `/a`) also matches, and returning there skips
    // the `preventDefault()` below, so the browser does a full
    // document-replacing reload where the Navigation API path soft re-routes.
    // The browser's own fragment-navigation predicate, term for term:
    // destination differs from current, has a fragment, and is equal ignoring
    // the fragment. Compared on the raw serialisation rather than via
    // `URL.pathname`/`.search`, because those normalise a bare `?` away — so
    // `/a` -> `/a?#s` read as a fragment-only move while the browser treated
    // it as a cross-document navigation. Same normalisation hole the earlier
    // `hash !== '' || endsWith('#')` arm existed to patch, on the query side.
    if (
      href !== location.href &&
      href.indexOf('#') !== -1 &&
      preFragment(href) === preFragment(location.href)
    ) {
      return;
    }

    // Same gate as the Navigation API path, and it matters more here: this
    // handler calls preventDefault() before navigating, so swallowing a link
    // we cannot render would stop the browser doing the real navigation *and*
    // strand the URL. Both paths this package ships must agree.
    if (!this.hasRouteFor(anchor.pathname)) {
      return;
    }

    // Cancel the browser's navigation — except for the identical-URL fragment
    // case, which we route *and* let the browser scroll to. `intercept()`
    // defaults to `scroll: 'after-transition'`, so the Navigation API path
    // scrolls there; preventDefault()ing here would leave clicking the TOC
    // entry you are already on looking dead on the fallback. The browser's own
    // navigation for it is a same-URL replace, so it adds no history entry and
    // its popstate is one `_onPopState` already no-ops.
    if (href !== location.href || href.indexOf('#') === -1) {
      e.preventDefault();
    }
    // pushState only when the URL actually changes — no duplicate history
    // entry for a self-link — but route either way. `_onNavigate` re-runs
    // `enter()` for a click on the already-active route, and the two paths
    // must reach the same decision for the same (URL, href) pair.
    if (href !== location.href) {
      window.history.pushState({}, '', href);
    }
    void this.goto(anchor.pathname).catch((err) => {
      queueMicrotask(() => {
        throw err;
      });
    });
  };

  private _onPopState = (_e: PopStateEvent) => {
    // A fragment navigation is a same-document navigation, so it fires
    // popstate too. Routing on it re-runs the current route's `enter()` for a
    // move that changed no route — the other half of what the fragment guard
    // in _onClick addresses, and the remaining disagreement with
    // `_onNavigate`, which declines these outright via `hashChange`.
    const {pathname, search} = window.location;
    if (pathname === this._lastRoutedPath && search === this._lastRoutedSearch) {
      return;
    }
    void this.goto(pathname).catch((err) => {
      queueMicrotask(() => {
        throw err;
      });
    });
  };
}
