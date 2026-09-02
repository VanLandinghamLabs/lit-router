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
  pattern: URLPatternLike;
}

/**
 * The part of `URLPattern` this router uses.
 *
 * Declared structurally rather than referencing the global so the emitted
 * `.d.ts` is self-contained: the `/// <reference types="urlpattern-polyfill" />`
 * above is not carried into declaration output, and `URLPattern` is not in
 * TypeScript's bundled `lib.dom`, so a published package typed against the
 * global fails a consumer build with `TS2304: Cannot find name 'URLPattern'`.
 * A real `URLPattern` satisfies this, so passing one still type-checks.
 */
export interface URLPatternLike {
  /**
   * The pathname pattern string, as `URLPattern.prototype.pathname` returns
   * it. Read to tell a trailing wildcard from any other positional group —
   * the groups object alone cannot (see `tailOf`).
   */
  readonly pathname: string;
  test(input: {pathname: string}): boolean;
  exec(input: {pathname: string}): {
    pathname: {groups: {[key: string]: string | undefined}};
  } | null;
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
const patternCache = new WeakMap<PathRouteConfig, URLPatternLike>();

const isPatternConfig = (route: RouteConfig): route is URLPatternRouteConfig =>
  (route as URLPatternRouteConfig).pattern !== undefined;

const getPattern = (route: RouteConfig): URLPatternLike => {
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
 * Matches a pathname pattern that ends in a wildcard, in the forms
 * `URLPattern.prototype.pathname` regenerates one: a bare `*` — which a
 * trailing `(.*)` also normalises to — or `{*}`, which the generator emits for
 * a wildcard after a modified group, e.g. `/docs{/}?*`. Either may be
 * optional (`*?`). Not a wildcard: an escaped `\*`, or a `*` that is the
 * modifier on a group (`(\d+)*`, `{/}*`) or on a named param (`:rest*`).
 * Those exclusions matter when an earlier positional group exists —
 * `/x/(\d+)/:rest*` — since that group would otherwise be taken for the tail.
 */
const TRAILING_WILDCARD = /(?:(?<![\\)}]|:[\w$]+)\*|\{\*\})\??$/;

/**
 * The tail of a match — what a trailing wildcard (`/foo/*`) captured — or
 * undefined when the pattern has none.
 *
 * Decided from the pattern, not from the groups object: an unnamed regex group
 * (`/post/(\d+)`) and a wildcard that is not last (`/foo/*` followed by
 * `/bar`) are keyed by index exactly as a tail is, and reading either as one
 * truncated `link()` and handed a child the wrong segment. When a trailing
 * wildcard is present it is the last group in the pattern, so its key is the
 * highest positional index.
 */
const tailOf = (
  route: RouteConfig,
  params: {[key: string]: string | undefined}
): string | undefined => {
  if (!TRAILING_WILDCARD.test(getPattern(route).pathname)) {
    return undefined;
  }
  let tailIndex = -1;
  for (const key of Object.keys(params)) {
    // Numeric, not lexicographic: '9' sorts above '10' as a string, so a
    // pattern with eleven or more wildcards picked group 9 as its tail.
    if (/^\d+$/.test(key) && Number(key) > tailIndex) {
      tailIndex = Number(key);
    }
  }
  return tailIndex < 0 ? undefined : params[String(tailIndex)];
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
   * {@link routes} match. Behaves like a `/*` route: `params[0]` is the whole
   * pathname minus its leading slash, and is handed to child controllers as
   * their tail. A nested controller's own pathname is a tail, with no leading
   * slash; the fallback accepts that too.
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
  private _currentTail: string | undefined;
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
    // Last-goto-wins, per controller. The navigation signal alone is not
    // enough: a child controller mounts as a *result* of its parent's render,
    // so its first goto() comes from `_onRoutesConnected` — after the parent's
    // navigation has already finished, and therefore with a signal that will
    // never abort. Without this counter a slow first child load commits over a
    // newer one. This also keeps `Routes` correct when used on its own, with
    // no `Router` and no Navigation API in the picture.
    const seq = ++this._gotoSeq;
    let tail: string | undefined;

    if (this.routes.length === 0 && this.fallback === undefined) {
      // If a routes controller has none of its own routes it acts like it has
      // one route of `/*` so that it passes the whole pathname as a tail
      // match.
      tail = pathname;
      this._currentPathname = '';
      // Simulate a tail group with the whole pathname
      this._currentParams = {0: tail};
    } else {
      const match = this._match(pathname);
      if (match === undefined) {
        throw new Error(`No route found for ${pathname}`);
      }
      const {route, params} = match;
      tail = match.tail;
      if (typeof route.enter === 'function') {
        const success = await route.enter(params);
        // If enter() returns false, cancel this navigation
        if (success === false) {
          return;
        }
      }
      // A newer navigation superseded this one while `enter` was awaiting.
      // Committing now would swap the outlet onto a route the URL has left.
      if (options?.signal?.aborted === true || seq !== this._gotoSeq) {
        return;
      }
      // Only update route state if the enter handler completes successfully
      this._currentRoute = route;
      this._currentParams = params;
      this._currentPathname =
        tail === undefined
          ? pathname
          : pathname.substring(0, pathname.length - tail.length);
    }
    this._currentTail = tail;

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
    // awaiting. `_routeChild` covers the per-child filtering and error policy.
    //
    // Runs whether or not there is a tail. A route without one has nothing for
    // the children to render, but they must still be superseded — otherwise a
    // child mid-`enter()` for the previous tail stays current and commits over
    // a URL that has moved on.
    for (const childRoutes of this._childRoutes) {
      this._routeChild(childRoutes, tail);
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
   * Hands a tail match to a child controller. Shared by the propagation loop in
   * `goto()` and the late-mount path in `_onRoutesConnected`, so that identical
   * input cannot be silent on one and an uncaught global throw on the other.
   *
   * A child with no route for the new tail is the expected case, not an error —
   * the outgoing branch mid-swap, or a deep link to a path the child cannot
   * render. Filtered structurally rather than by swallowing every rejection, so
   * a genuine `enter()` rejection still surfaces the way it does upstream.
   * Skipping must still supersede: `goto()` is where the counter is bumped, so
   * returning without it would leave an in-flight child navigation current,
   * free to commit over a URL that has moved on. A parent route with no tail
   * at all is the same case: nothing to route, but still something to stand
   * down.
   *
   * No abort signal is threaded through, and the goto is deliberately not
   * awaited. The parent commits its own state before children run, so a child
   * handed an already-aborted signal stands down with no newer goto() arriving
   * to correct it, leaving the nested outlet stuck — reachable, because a
   * hash-only navigation aborts the outstanding one without producing a
   * replacement. Supersession is the counter's job.
   */
  private _routeChild(child: Routes, tail: string | undefined) {
    if (tail === undefined || !child.hasRouteFor(tail)) {
      child._supersede();
      return;
    }
    void child.goto(tail).catch((err) => {
      queueMicrotask(() => {
        throw err;
      });
    });
  }

  /**
   * Invalidate any in-flight `goto()` on this controller without starting a
   * new one. Same-class access, so `_gotoSeq` stays private to `Routes`.
   */
  private _supersede(seen: Set<Routes> = new Set()): void {
    // Unreachable defence in depth. Upstream *can* produce a `_childRoutes`
    // cycle — a host carrying two Routes controllers, disconnected and
    // reconnected, ends up with each registered as the other's child — but
    // `hostDisconnected` below removes the listener that causes it, and a test
    // asserts the cycle cannot form. Kept because an unguarded recursive walk
    // over a cycle is a stack overflow rather than a misrender.
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
    // A fallback matches everything, and a controller with no routes of its own
    // behaves as if it had a single `/*` route (goto()'s special case). Either
    // way the answer is yes without running a single pattern — worth
    // short-circuiting, since `Router` asks this on every navigation.
    if (this.fallback !== undefined || this.routes.length === 0) {
      return true;
    }
    // `test()`, not `_match()`: this only needs the yes/no, and `exec()` pays
    // ~8x on a hit to build a groups object the caller would throw away.
    return this.routes.some((r) => getPattern(r).test({pathname}));
  }

  /**
   * Matches `pathname` against the installed routes and returns the first match
   * with its parsed parameters, or the fallback's match if one is configured.
   *
   * One `exec()` per candidate rather than `test()` to select and `exec()` to
   * extract: that ran the winning pattern twice, and every caller that wants a
   * route wants its params too.
   */
  private _match(pathname: string):
    | {
        route: RouteConfig;
        params: {[key: string]: string | undefined};
        tail: string | undefined;
      }
    | undefined {
    for (const route of this.routes) {
      const result = getPattern(route).exec({pathname});
      if (result !== null) {
        const params = result.pathname.groups;
        return {route, params, tail: tailOf(route, params)};
      }
    }
    if (this.fallback === undefined) {
      return undefined;
    }
    // The fallback route behaves like it has a "/*" path. This is hidden from
    // the public API; the `path` is there to return a valid RouteConfig. The
    // match itself is done by hand rather than with a real `/*` pattern: a
    // nested controller is handed its tail *without* a leading slash, which
    // `/*` does not match, so a nested fallback matched nothing — empty
    // params, no tail, and its own children never routed.
    const tail = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    return {route: {...this.fallback, path: '/*'}, params: {0: tail}, tail};
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
    // Remove the listener hostConnected added. Without this a host that is
    // disconnected and reconnected (a repeat() reorder, a tab swap) leaves the
    // sibling controller's listener installed, so on the second connect it
    // claims the re-dispatching controller as *its* child and the pair point
    // at each other — a real `_childRoutes` cycle, which recursive walks turn
    // into a stack overflow.
    this._host.removeEventListener(
      RoutesConnectedEvent.eventName,
      this._onRoutesConnected
    );
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
      const index = this._childRoutes.indexOf(childRoutes);
      if (index !== -1) {
        this._childRoutes.splice(index, 1);
      }
    };

    // A child that mounts under an existing tail match has to be caught up to
    // it — it missed the propagation loop in goto() that ran before it existed.
    // With no tail there is nothing to catch up to, and `_routeChild` then only
    // supersedes, a no-op on a freshly mounted child.
    this._routeChild(childRoutes, this._currentTail);
  };
}

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
