/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Modifications Copyright 2026 VanLandingham Labs, same license. See NOTICE.md.
 */

/// <reference types="urlpattern-polyfill" />

import type {ReactiveController, ReactiveControllerHost} from 'lit';

export interface BaseRouteConfig {
  name?: string | undefined;
  render?: (params: {[key: string]: string | undefined}) => unknown;
  enter?: (params: {
    [key: string]: string | undefined;
  }) => Promise<boolean> | boolean;
}

/**
 * A RouteConfig that matches against a `path` string. `path` must be a
 * [`URLPattern` compatible pathname pattern](https://developer.mozilla.org/en-US/docs/Web/API/URLPattern/pathname).
 */
export interface PathRouteConfig extends BaseRouteConfig {
  path: string;
}

/**
 * A RouteConfig that matches against a given [`URLPattern`](https://developer.mozilla.org/en-US/docs/Web/API/URLPattern)
 *
 * While `URLPattern` can match against protocols, hostnames, and ports,
 * routes will only be checked for matches if they're part of the current
 * origin. This means that the pattern is limited to checking `pathname` and
 * `search`.
 */
export interface URLPatternRouteConfig extends BaseRouteConfig {
  pattern: URLPattern;
}

/**
 * A description of a route, which path or pattern to match against, and a
 * render() callback used to render a match to the outlet.
 */
export type RouteConfig = PathRouteConfig | URLPatternRouteConfig;

// A cache of URLPatterns created for PathRouteConfig.
// Rather than converting all given RoutConfigs to URLPatternRouteConfig, this
// lets us make `routes` mutable so users can add new PathRouteConfigs
// dynamically.
const patternCache = new WeakMap<PathRouteConfig, URLPattern>();

const isPatternConfig = (route: RouteConfig): route is URLPatternRouteConfig =>
  (route as URLPatternRouteConfig).pattern !== undefined;

const getPattern = (route: RouteConfig) => {
  if (isPatternConfig(route)) {
    return route.pattern;
  }
  let pattern = patternCache.get(route);
  if (pattern === undefined) {
    patternCache.set(route, (pattern = new URLPattern({pathname: route.path})));
  }
  return pattern;
};

/**
 * A reactive controller that performs location-based routing using a
 * configuration of URL patterns and associated render callbacks.
 */
export class Routes implements ReactiveController {
  private readonly _host: ReactiveControllerHost & HTMLElement;

  /*
   * The currently installed set of routes in precedence order.
   *
   * This array is mutable. To dynamically add a new route you can write:
   *
   * ```ts
   * this._routes.routes.push({
   *   path: '/foo',
   *   render: () => html`<p>Foo</p>`,
   * });
   * ```
   *
   * Mutating this property does not trigger any route transitions. If the
   * changes may result is a different route matching for the current path, you
   * must instigate a route update with `goto()`.
   */
  routes: Array<RouteConfig> = [];

  /**
   * A default fallback route which will always be matched if none of the
   * {@link routes} match. Implicitly matches to the path "/*".
   */
  fallback?: BaseRouteConfig;

  /*
   * The current set of child Routes controllers. These are connected via
   * the routes-connected event.
   */
  private readonly _childRoutes: Array<Routes> = [];

  private _parentRoutes: Routes | undefined;

  /*
   * State related to the current matching route.
   *
   * We keep this so that consuming code can access current parameters, and so
   * that we can propagate tail matches to child routes if they are added after
   * navigation / matching.
   */
  /** Monotonic goto counter; see the last-goto-wins note in goto(). */
  private _gotoSeq = 0;

  private _currentPathname: string | undefined;
  private _currentRoute: RouteConfig | undefined;
  private _currentParams: {
    [key: string]: string | undefined;
  } = {};

  /**
   * Callback to call when this controller is disconnected.
   *
   * It's critical to call this immediately in hostDisconnected so that this
   * controller instance doesn't receive a tail match meant for another route.
   */
  // TODO (justinfagnani): Do we need this now that we have a direct reference
  // to the parent? We can call `this._parentRoutes.disconnect(this)`.
  private _onDisconnect: (() => void) | undefined;

  constructor(
    host: ReactiveControllerHost & HTMLElement,
    routes: Array<RouteConfig>,
    options?: {fallback?: BaseRouteConfig}
  ) {
    (this._host = host).addController(this);
    this.routes = [...routes];
    this.fallback = options?.fallback;
  }

  /**
   * Returns a URL string of the current route, including parent routes,
   * optionally replacing the local path with `pathname`.
   */
  link(pathname?: string): string {
    if (pathname?.startsWith('/')) {
      return pathname;
    }
    if (pathname?.startsWith('.')) {
      throw new Error('Not implemented');
    }
    pathname ??= this._currentPathname;
    return (this._parentRoutes?.link() ?? '') + pathname;
  }

  /**
   * Navigates this routes controller to `pathname`.
   *
   * This does not navigate parent routes, so it isn't (yet) a general page
   * navigation API. It does navigate child routes if pathname matches a
   * pattern with a tail wildcard pattern (`/*`).
   *
   * Pass `options.signal` to make the navigation abandonable. `enter()` is
   * awaited, so a second `goto()` can start — and finish — while the first is
   * still resolving its route; without a signal the slower one commits last
   * and the outlet ends up on a route the URL has already left. `Router`
   * threads `NavigateEvent.signal` through for exactly this reason.
   */
  async goto(pathname: string, options?: {signal?: AbortSignal}) {
    // TODO (justinfagnani): handle absolute vs relative paths separately.

    // TODO (justinfagnani): generalize this to handle query params and
    // fragments. It currently only handles path names because it's easier to
    // completely disregard the origin for now. The click handler only does
    // an in-page navigation if the origin matches anyway.
    const signal = options?.signal;
    // Last-goto-wins, per controller. The navigation signal alone is not
    // enough: a child controller mounts as a *result* of its parent's render,
    // so its first goto() comes from `_onRoutesConnected` — after the parent's
    // navigation has already finished, and therefore with a signal that will
    // never abort. Without this counter a slow first child load commits over a
    // newer one. This also keeps `Routes` correct when used on its own, with
    // no `Router` and no Navigation API in the picture.
    const seq = ++this._gotoSeq;
    const superseded = () => signal?.aborted === true || seq !== this._gotoSeq;
    let tailGroup: string | undefined;

    if (this.routes.length === 0 && this.fallback === undefined) {
      // If a routes controller has none of its own routes it acts like it has
      // one route of `/*` so that it passes the whole pathname as a tail
      // match.
      tailGroup = pathname;
      this._currentPathname = '';
      // Simulate a tail group with the whole pathname
      this._currentParams = {0: tailGroup};
    } else {
      const route = this._getRoute(pathname);
      if (route === undefined) {
        throw new Error(`No route found for ${pathname}`);
      }
      const pattern = getPattern(route);
      const result = pattern.exec({pathname});
      const params = result?.pathname.groups ?? {};
      tailGroup = getTailGroup(params);
      if (typeof route.enter === 'function') {
        const success = await route.enter(params);
        // If enter() returns false, cancel this navigation
        if (success === false) {
          return;
        }
      }
      // A newer navigation superseded this one while `enter` was awaiting.
      // Committing now would swap the outlet onto a route the URL has left.
      if (superseded()) {
        return;
      }
      // Only update route state if the enter handler completes successfully
      this._currentRoute = route;
      this._currentParams = params;
      this._currentPathname =
        tailGroup === undefined
          ? pathname
          : pathname.substring(0, pathname.length - tailGroup.length);
    }

    // Propagate the tail match to children — deliberately NOT awaited.
    //
    // Awaiting looks like it would make `navigation.finished` cover the whole
    // tree, and an earlier revision of this fork did it. It is wrong twice
    // over. At this point `requestUpdate()` has not run, so `_childRoutes`
    // still holds the *outgoing* branch's controller: awaiting it gates the
    // parent's outlet swap on an `enter()` for a tail that controller will
    // never render (a hung one blocks the navigation forever), and if that
    // child has no route for the new tail its `No route found` throw
    // propagates out of here and `requestUpdate()` below never runs — URL
    // committed, outlet stranded, i.e. this fork's own thesis bug one level
    // down. Nested supersession is handled by the goto counter above, not by
    // awaiting. Errors are swallowed rather than left as unhandled rejections.
    if (tailGroup !== undefined) {
      for (const childRoutes of this._childRoutes) {
        // No signal, for the same reason as the late-mount path below: the
        // parent commits before children run, so a child handed an aborted
        // signal stands down with no newer goto() arriving to correct it,
        // leaving the nested outlet stuck. A hash-only navigation aborts the
        // outstanding one without producing a replacement, so this is
        // reachable. Supersession is the counter's job.
        //
        // The expected failure here is a child with no route for the new tail
        // — the outgoing branch, mid-swap. Filter that structurally rather
        // than swallowing everything, so a genuine `enter()` rejection still
        // surfaces the way it does upstream instead of vanishing.
        if (!childRoutes.hasRouteFor(tailGroup)) {
          // Skip the navigation but still supersede: `goto()` is where the
          // counter is bumped, so returning early here would leave an
          // in-flight child navigation current, free to commit over a URL that
          // has moved on. Removing the abort signal above is only safe because
          // the counter always runs — including here.
          childRoutes._supersede();
          continue;
        }
        void childRoutes.goto(tailGroup).catch((err) => {
          queueMicrotask(() => {
            throw err;
          });
        });
      }
    }
    this._host.requestUpdate();
  }

  /**
   * The result of calling the current route's render() callback.
   */
  outlet() {
    return this._currentRoute?.render?.(this._currentParams);
  }

  /**
   * The current parsed route parameters.
   */
  get params() {
    return this._currentParams;
  }

  /**
   * Invalidate any in-flight `goto()` on this controller without starting a
   * new one. Same-class access, so `_gotoSeq` stays private to `Routes`.
   */
  private _supersede(seen: Set<Routes> = new Set()): void {
    // `_childRoutes` can genuinely contain a cycle: a host carrying two Routes
    // controllers that is disconnected and reconnected ends up with each
    // registered as the other's child. Harmless while this was one increment;
    // once it recurses, unguarded it is a stack overflow.
    if (seen.has(this)) {
      return;
    }
    seen.add(this);
    this._gotoSeq++;
    // Recursive: on the navigating branch the child's own propagation loop
    // reaches the grandchildren, but a skipped child never runs one — so
    // without this an in-flight grandchild `enter()` stays current and commits
    // over a URL that has moved on, the same defect one level deeper.
    for (const child of this._childRoutes) {
      child._supersede(seen);
    }
  }

  /**
   * True when this controller can render `pathname` — i.e. a route matches, or
   * a fallback is configured.
   *
   * `Router` gates interception on this: intercepting a path we cannot render
   * commits the URL and then throws out of `goto()`, leaving the address bar
   * moved and the outlet stale. Letting the browser handle it instead means a
   * server-rendered page, an export endpoint, or a GET form still works.
   */
  hasRouteFor(pathname: string): boolean {
    // Mirrors goto()'s special case: a controller with no routes of its own
    // behaves as if it had a single `/*` route.
    if (this.routes.length === 0 && this.fallback === undefined) {
      return true;
    }
    return this._getRoute(pathname) !== undefined;
  }

  /**
   * Matches `url` against the installed routes and returns the first match.
   */
  private _getRoute(pathname: string): RouteConfig | undefined {
    const matchedRoute = this.routes.find((r) =>
      getPattern(r).test({pathname: pathname})
    );
    if (matchedRoute || this.fallback === undefined) {
      return matchedRoute;
    }
    if (this.fallback) {
      // The fallback route behaves like it has a "/*" path. This is hidden from
      // the public API but is added here to return a valid RouteConfig.
      return {...this.fallback, path: '/*'};
    }
    return undefined;
  }

  hostConnected() {
    this._host.addEventListener(
      RoutesConnectedEvent.eventName,
      this._onRoutesConnected
    );
    const event = new RoutesConnectedEvent(this);
    this._host.dispatchEvent(event);
    this._onDisconnect = event.onDisconnect;
  }

  hostDisconnected() {
    // When this child routes controller is disconnected because a parent
    // outlet rendered a different template, disconnecting will ensure that
    // this controller doesn't receive a tail match meant for another route.
    this._onDisconnect?.();
    this._parentRoutes = undefined;
  }

  private _onRoutesConnected = (e: RoutesConnectedEvent) => {
    // Don't handle the event fired by this routes controller, which we get
    // because we do this.dispatchEvent(...)
    if (e.routes === this) {
      return;
    }

    const childRoutes = e.routes;
    this._childRoutes.push(childRoutes);
    childRoutes._parentRoutes = this;

    e.stopImmediatePropagation();
    e.onDisconnect = () => {
      // Remove route from this._childRoutes:
      // `>>> 0` converts -1 to 2**32-1
      this._childRoutes?.splice(
        this._childRoutes.indexOf(childRoutes) >>> 0,
        1
      );
    };

    const tailGroup = getTailGroup(this._currentParams);
    // Same structural filter as the propagation path in goto(): a child that
    // mounts under a tail it cannot render is the expected case (a deep link
    // to `/x/unknown`), not an error. Without this the two call sites disagree
    // — silent there, uncaught global throw here — for identical input.
    if (tailGroup !== undefined && childRoutes.hasRouteFor(tailGroup)) {
      // No signal here on purpose. The parent commits its own state before
      // children run, so by the time a late child mounts the navigation may
      // already have been aborted — handing it that signal makes it stand down
      // with no newer goto() ever arriving to correct it, leaving the nested
      // outlet blank permanently. The goto counter covers what matters
      // (supersession by a newer goto).
      void childRoutes.goto(tailGroup).catch((err) => {
        queueMicrotask(() => {
          throw err;
        });
      });
    }
  };
}

/**
 * Returns the tail of a pathname groups object. This is the match from a
 * wildcard at the end of a pathname pattern, like `/foo/*`
 */
const getTailGroup = (groups: {[key: string]: string | undefined}) => {
  let tailKey: string | undefined;
  for (const key of Object.keys(groups)) {
    if (/\d+/.test(key) && (tailKey === undefined || key > tailKey!)) {
      tailKey = key;
    }
  }
  return tailKey && groups[tailKey];
};

/**
 * This event is fired from Routes controllers when their host is connected to
 * announce the child route and potentially connect to a parent routes controller.
 */
export class RoutesConnectedEvent extends Event {
  static readonly eventName = 'lit-routes-connected';
  readonly routes: Routes;
  onDisconnect?: () => void;

  constructor(routes: Routes) {
    super(RoutesConnectedEvent.eventName, {
      bubbles: true,
      composed: true,
      cancelable: false,
    });
    this.routes = routes;
  }
}

declare global {
  interface HTMLElementEventMap {
    [RoutesConnectedEvent.eventName]: RoutesConnectedEvent;
  }
}
