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
 * True when the Navigation API is available. Baseline Newly Available since
 * January 2026 (Chrome/Edge, Safari 26.2, Firefox 147); the legacy
 * click + popstate path below is kept for engines older than that.
 */
export const supportsNavigationApi = (): boolean =>
  typeof window !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof (window as any).navigation?.addEventListener === 'function';

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
  interceptOptions?: {
    focusReset?: 'after-transition' | 'manual';
    scroll?: 'after-transition' | 'manual';
  };

  private _usingNavigationApi = false;

  override hostConnected() {
    super.hostConnected();
    this._usingNavigationApi = supportsNavigationApi();
    if (this._usingNavigationApi) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).navigation.addEventListener('navigate', this._onNavigate);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).navigation.removeEventListener(
        'navigate',
        this._onNavigate
      );
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _onNavigate = (e: any) => {
    // Not ours to handle: anything the browser says cannot be intercepted,
    // fragment-only moves, downloads, and form submissions.
    if (!e.canIntercept || e.hashChange || e.downloadRequest !== null) {
      return;
    }
    if (e.formData) {
      return;
    }

    const url = new URL(e.destination.url);
    if (url.origin !== origin) {
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
      e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey;
    if (e.defaultPrevented || isNonNavigationClick) {
      return;
    }

    const anchor = e
      .composedPath()
      .find((n) => (n as HTMLElement).tagName === 'A') as
      | HTMLAnchorElement
      | undefined;
    if (
      anchor === undefined ||
      anchor.target !== '' ||
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

    e.preventDefault();
    if (href !== location.href) {
      window.history.pushState({}, '', href);
      this.goto(anchor.pathname);
    }
  };

  private _onPopState = (_e: PopStateEvent) => {
    this.goto(window.location.pathname);
  };
}
