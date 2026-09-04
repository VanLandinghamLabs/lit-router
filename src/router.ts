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
 * typing the handler `any`, because these properties are the correctness
 * boundary: a typo like `hashchange` for `hashChange` would silently disable a
 * filter forever. Names verified against Chromium's `NavigateEvent.prototype`.
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
 * The current location as a path string, in the form `goto()` parses. Only the
 * origin is dropped; `_onNavigate` declines anything cross-origin before it
 * gets here.
 */
const currentPath = (): string =>
  window.location.pathname + window.location.search + window.location.hash;

/**
 * True when the Navigation API is available. Baseline Newly Available since
 * January 2026 (Chrome/Edge, Safari 26.2, Firefox 147).
 *
 * This router requires it. Exported so an app can detect an unsupported engine
 * at boot and say so, rather than leaving the user to notice that every link
 * reloads the page.
 */
export const supportsNavigationApi = (): boolean =>
  typeof window !== 'undefined' &&
  typeof getNavigation()?.addEventListener === 'function';

/**
 * A root-level router that intercepts navigation via the Navigation API.
 *
 * Extends Routes, so it carries a route configuration of its own. Use one
 * Router per page, since it installs a global listener, and `Routes` for
 * nested route spaces.
 *
 * ## Why the Navigation API
 *
 * Upstream intercepted with a global click listener plus `popstate`, and
 * committed with `history.pushState()`. That is structurally racy: `pushState`
 * is synchronous and `popstate` fires after the URL has moved, but `goto()`
 * awaits `route.enter()` before swapping the outlet. The URL leads and the
 * outlet lags, leaving two sources of truth, so the outgoing route re-renders
 * with stale params and two quick navigations commit in whatever order their
 * `enter()` hooks resolve.
 *
 * `navigateEvent.intercept({handler})` collapses that. The browser commits the
 * URL and holds the navigation unfinished while the handler runs, and aborts
 * `navigateEvent.signal` when a newer navigation supersedes this one, which
 * `goto()` honours.
 *
 * ## No legacy fallback
 *
 * An earlier version kept upstream's click/popstate path for pre-2026 engines.
 * It was removed because every divergence review turned up landed in the click
 * handler, never here. That is structural: this handler reads a decision the
 * browser already made, while the click handler had to re-derive it,
 * re-implementing the rules for choosing a navigable, the fragment-navigation
 * predicate, and the modifier-key rules.
 *
 * Without the API, links fall back to full page loads. For an app whose server
 * serves the shell on every route that is slower, not broken, and
 * `supportsNavigationApi()` detects it. For real pre-2026 support, pair this
 * with a Navigation API polyfill rather than a second code path.
 */
export class Router extends Routes {
  /**
   * Options forwarded to `navigateEvent.intercept()`. Leaving these unset gives
   * the browser's default scroll and focus handling.
   */
  interceptOptions?: InterceptOptions;

  private _listening = false;

  override hostConnected() {
    super.hostConnected();
    // Gated on the exported predicate, not on `navigation !== undefined`. A
    // stub or partial polyfill under that name would otherwise throw out of
    // connectedCallback while `supportsNavigationApi()` reported the engine
    // unsupported, and then even the initial render below would not run.
    if (supportsNavigationApi()) {
      getNavigation()!.addEventListener('navigate', this._onNavigate);
      this._listening = true;
    }
    // Render the current URL. Done even without the API, which is what makes
    // the unsupported-engine degradation slow rather than blank. The rejection
    // is surfaced because on such an engine this is the only rendering path,
    // and a deep link with no matching route throws here.
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
    // `!= null`, not `!== null`: the spec types both as nullable-but-present,
    // but a polyfill leaving either unset would make a strict check true for
    // every ordinary link and silently decline the whole app.
    if (!e.canIntercept || e.downloadRequest != null || e.formData != null) {
      return;
    }

    // Fragment-only moves belong to the browser unless a route reads the
    // fragment. Intercepting them unconditionally costs every pathname-only app
    // its native in-page scrolling; declining them unconditionally is the
    // lit/lit#3517 bug this router inherited.
    if (e.hashChange && !this._constrainsHash()) {
      return;
    }

    // Reloads must stay reloads. `canIntercept` is true for them, so without
    // this `location.reload()` degrades to re-running goto() on the same path.
    // The document is never replaced, breaking the "new version available,
    // reload" escape hatch and disagreeing with the browser's refresh button.
    if (e.navigationType === 'reload') {
      return;
    }

    // `rel="external"` is this router's convention, not HTML's or the
    // Navigation API's, so the browser will not decline these for us.
    // Best-effort: `sourceElement` is missing in some engines and absent for
    // programmatic navigation.
    if (e.sourceElement?.getAttribute?.('rel') === 'external') {
      return;
    }

    // Read per navigation rather than cached at module scope. The value cannot
    // change, but reading it on import makes merely importing this module throw
    // where there is no `location`, such as SSR or a bundler evaluating for
    // tree-shaking under the package's `sideEffects: false` claim.
    const url = new URL(e.destination.url);
    if (url.origin !== window.location.origin) {
      return;
    }

    // Only intercept what we can render. `canIntercept` is true for any
    // same-origin URL, including cross-document ones, so without this a link to
    // a server-rendered page, an export endpoint, or a GET form (whose
    // `formData` is null) gets swallowed: the URL commits, goto() throws, and
    // the address bar points somewhere the outlet never went.
    const path = url.pathname + url.search + url.hash;
    if (!this.hasRouteFor(path)) {
      return;
    }

    e.intercept({
      ...this.interceptOptions,
      handler: async () => {
        // `e.signal` aborts if another navigation starts before this handler
        // resolves; goto() checks it after `enter()` and stands down.
        await this.goto(path, {signal: e.signal});
      },
    });
  };
}
