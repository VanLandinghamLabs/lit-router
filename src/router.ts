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
 * The slice of `NavigateEvent` this router reads. Typed rather than `any`
 * because these properties are the correctness boundary: `hashchange` for
 * `hashChange` would silently disable a filter forever.
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

/** The current location in the form `goto()` parses, minus the origin. */
const currentPath = (): string =>
  window.location.pathname + window.location.search + window.location.hash;

/**
 * True when the Navigation API is available (Baseline Newly Available, January
 * 2026). This router requires it; exported so an app can detect an unsupported
 * engine at boot rather than leaving users to notice every link reloading.
 */
export const supportsNavigationApi = (): boolean =>
  typeof window !== 'undefined' &&
  typeof getNavigation()?.addEventListener === 'function';

/**
 * A root-level router that intercepts navigation via the Navigation API. Use one
 * per page, since it installs a global listener, and `Routes` for nested spaces.
 *
 * Upstream committed with `history.pushState()` and reacted to `popstate`, but
 * swapped the outlet only after awaiting `enter()`. The URL led and the outlet
 * lagged, so the outgoing route re-rendered with stale params and quick
 * navigations committed out of order. `intercept({handler})` collapses that:
 * the browser holds the navigation unfinished while the handler runs and aborts
 * `signal` when a newer one supersedes it.
 *
 * There is no legacy fallback for pre-2026 engines. Without the API links
 * become full page loads, which `supportsNavigationApi()` detects. See the
 * README for what that degrades and what it breaks.
 */
export class Router extends Routes {
  /** Forwarded to `navigateEvent.intercept()`. Unset uses browser defaults. */
  interceptOptions?: InterceptOptions;

  private _listening = false;

  override hostConnected() {
    super.hostConnected();
    // The predicate, not `navigation !== undefined`: a partial polyfill would
    // otherwise throw out of connectedCallback and skip the render below.
    if (supportsNavigationApi()) {
      getNavigation()!.addEventListener('navigate', this._onNavigate);
      this._listening = true;
    }
    // Runs even without the API, which is what makes the degradation slow
    // rather than blank. Surfaced because it is then the only rendering path.
    void this.goto(currentPath()).catch((err) => {
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
    // `!= null`: a polyfill leaving either unset would make a strict check
    // true for every link and silently decline the whole app.
    if (!e.canIntercept || e.downloadRequest != null || e.formData != null) {
      return;
    }

    // Fragment-only moves are the browser's unless a route reads the fragment.
    // Always intercepting costs native scrolling; never intercepting is
    // lit/lit#3517. See #13.
    if (e.hashChange && !this._constrainsHash()) {
      return;
    }

    // Reloads must stay reloads. `canIntercept` is true for them, so without
    // this `location.reload()` never replaces the document.
    if (e.navigationType === 'reload') {
      return;
    }

    // This router's convention, not HTML's, so the browser will not decline
    // these for us. Best-effort: `sourceElement` is not everywhere.
    if (e.sourceElement?.getAttribute?.('rel') === 'external') {
      return;
    }

    // Per navigation, not module scope: reading `location` on import throws
    // under SSR, contradicting the package's `sideEffects: false`.
    const url = new URL(e.destination.url);
    if (url.origin !== window.location.origin) {
      return;
    }

    // `canIntercept` is true for cross-document same-origin URLs too, so
    // without this a server-rendered page or GET form gets swallowed: the URL
    // commits, goto() throws, and the outlet never moves.
    const path = url.pathname + url.search + url.hash;
    if (!this.hasRouteFor(path)) {
      return;
    }

    e.intercept({
      ...this.interceptOptions,
      handler: async () => {
        // `e.signal` aborts if a newer navigation starts; goto() checks it.
        await this.goto(path, {signal: e.signal});
      },
    });
  };
}
