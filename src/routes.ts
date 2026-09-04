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
 * A RouteConfig that matches against a given [`URLPattern`](https://developer.mozilla.org/en-US/docs/Web/API/URLPattern).
 *
 * Routes are only checked within the current origin, so only `pathname`,
 * `search` and `hash` are matched.
 */
export interface URLPatternRouteConfig extends BaseRouteConfig {
  pattern: URLPatternLike;
}

/**
 * The part of `URLPattern` this router uses.
 *
 * Structural rather than a reference to the global, so the emitted `.d.ts` is
 * self-contained. The triple-slash reference above is not carried into
 * declaration output and `URLPattern` is not in TypeScript's `lib.dom`, so
 * typing against the global fails a consumer build with `TS2304`.
 */
export interface URLPatternLike {
  /**
   * The pathname pattern string. Read to tell a trailing wildcard from any
   * other positional group, which the groups object alone cannot. See `tailOf`.
   */
  readonly pathname: string;
  /**
   * The hash pattern string. `'*'` means the route places no constraint on the
   * fragment, which is what `URLPattern` fills in for an omitted component.
   * `Router` reads this to decide whether a fragment-only navigation is its
   * business or the browser's.
   */
  readonly hash: string;
  test(input: RouteLocation): boolean;
  exec(input: RouteLocation): {
    pathname: {groups: {[key: string]: string | undefined}};
    search: {groups: {[key: string]: string | undefined}};
    hash: {groups: {[key: string]: string | undefined}};
  } | null;
}

/**
 * The parts of a location this router matches against.
 *
 * `search` and `hash` carry no leading `?` or `#`. A real `URLPattern`
 * canonicalises either form away, but `URLPatternLike` admits other
 * implementations, so the delimiters are stripped here instead.
 */
export interface RouteLocation {
  pathname: string;
  search: string;
  hash: string;
}

/**
 * Splits `path` into the components a pattern is matched against.
 *
 * Not `new URL(path, origin)`: a nested controller's path is a tail, a bare
 * relative segment like `abc`, which `URL` would resolve and mangle.
 */
const parseLocation = (path: string): RouteLocation => {
  const hashIndex = path.indexOf('#');
  const hash = hashIndex === -1 ? '' : path.slice(hashIndex + 1);
  const beforeHash = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const searchIndex = beforeHash.indexOf('?');
  return {
    pathname: searchIndex === -1 ? beforeHash : beforeHash.slice(0, searchIndex),
    search: searchIndex === -1 ? '' : beforeHash.slice(searchIndex + 1),
    hash,
  };
};

/** Re-attaches `search` and `hash` to a pathname. Inverse of `parseLocation`. */
const formatLocation = (
  pathname: string,
  {search, hash}: {search: string; hash: string}
): string =>
  pathname + (search === '' ? '' : `?${search}`) + (hash === '' ? '' : `#${hash}`);

export type RouteConfig = PathRouteConfig | URLPatternRouteConfig;

// Keyed by config object so `routes` can stay a plain mutable array that users
// push new PathRouteConfigs onto.
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
 * Matches a pathname pattern ending in a wildcard, in the forms
 * `URLPattern.prototype.pathname` regenerates: a bare `*` (which a trailing
 * `(.*)` normalises to) or `{*}`, either optionally followed by `?`.
 *
 * Excludes an escaped `\*` and a `*` that modifies a group (`(\d+)*`, `{/}*`)
 * or a named param (`:rest*`). Those exclusions decide correctness when an
 * earlier positional group exists, as in `/x/(\d+)/:rest*`, where that group
 * would otherwise be taken for the tail.
 */
const TRAILING_WILDCARD = /(?:(?<![\\)}]|:[\w$]+)\*|\{\*\})\??$/;

/**
 * What a trailing wildcard (`/foo/*`) captured, or undefined when the pattern
 * has none.
 *
 * Decided from the pattern, not the groups object. An unnamed regex group
 * (`/post/(\d+)`) and a non-final wildcard (`/foo/*` followed by `/bar`) are
 * keyed by index exactly as a tail is; reading either as one truncated `link()`
 * and handed a child the wrong segment. A trailing wildcard is the last group
 * in its pattern, so its key is the highest positional index.
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
    // Numeric, not lexicographic: '9' sorts above '10' as a string, so eleven
    // or more wildcards picked group 9 as the tail.
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

  /**
   * The installed routes, in precedence order.
   *
   * Mutable, but mutating it starts no route transition. If the change means a
   * different route now matches, call `goto()`.
   */
  routes: Array<RouteConfig> = [];

  /**
   * Matched when no route in {@link routes} does. Behaves like `/*`:
   * `params[0]` is the whole pathname minus any leading slash, and is handed to
   * child controllers as their tail.
   */
  fallback?: BaseRouteConfig;

  private readonly _childRoutes: Array<Routes> = [];

  private _parentRoutes: Routes | undefined;

  /** Monotonic goto counter; see the last-goto-wins note in goto(). */
  private _gotoSeq = 0;

  private _currentPathname: string | undefined;
  private _currentTail: string | undefined;
  /**
   * Ambient rather than tailed: only the pathname nests, so a child is handed
   * the parent's tail as its pathname but the same search and hash.
   */
  private _currentSearch = '';
  private _currentHash = '';
  private _currentRoute: RouteConfig | undefined;
  private _currentParams: {
    [key: string]: string | undefined;
  } = {};

  /**
   * Must be called in hostDisconnected, or this controller can receive a tail
   * match meant for another route.
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
   * Navigates this controller to `path`, which may carry a search and hash.
   *
   * Does not navigate parent routes, so it is not yet a general page
   * navigation API. It does navigate child routes when the path matches a
   * pattern with a tail wildcard.
   *
   * Pass `options.signal` to make the navigation abandonable. `enter()` is
   * awaited, so a second `goto()` can start and finish while the first is still
   * resolving; without a signal the slower one commits last and the outlet ends
   * up on a route the URL has left. `Router` threads `NavigateEvent.signal`
   * through for this.
   */
  async goto(path: string, options?: {signal?: AbortSignal}) {
    // TODO (justinfagnani): handle absolute vs relative paths separately.

    const location = parseLocation(path);
    const {pathname} = location;

    // Last-goto-wins, per controller. The navigation signal alone is not
    // enough: a child mounts as a result of its parent's render, so its first
    // goto() comes from `_onRoutesConnected`, after the parent's navigation has
    // finished and therefore with a signal that will never abort. Without this
    // counter a slow first child load commits over a newer one. It also keeps
    // `Routes` correct on its own, with no `Router` and no Navigation API.
    const seq = ++this._gotoSeq;
    let tail: string | undefined;

    if (this.routes.length === 0 && this.fallback === undefined) {
      // A controller with no routes of its own acts as if it had one `/*`
      // route, passing the whole pathname on as a tail.
      tail = pathname;
      this._currentPathname = '';
      this._currentParams = {0: tail};
    } else {
      const match = this._match(location);
      if (match === undefined) {
        throw new Error(`No route found for ${path}`);
      }
      const {route, params} = match;
      tail = match.tail;
      if (typeof route.enter === 'function') {
        const success = await route.enter(params);
        if (success === false) {
          return;
        }
      }
      // A newer navigation superseded this one while `enter` was awaiting.
      // Committing now would swap the outlet onto a route the URL has left.
      if (options?.signal?.aborted === true || seq !== this._gotoSeq) {
        return;
      }
      this._currentRoute = route;
      this._currentParams = params;
      this._currentPathname =
        tail === undefined
          ? pathname
          : pathname.substring(0, pathname.length - tail.length);
    }
    this._currentTail = tail;
    this._currentSearch = location.search;
    this._currentHash = location.hash;

    // Deliberately not awaited. `requestUpdate()` has not run yet, so
    // `_childRoutes` still holds the outgoing branch's controller: awaiting it
    // would gate the parent's outlet swap on an `enter()` for a tail that
    // controller will never render, and a child with no route for the new tail
    // would throw `No route found` out of here, skipping `requestUpdate()` and
    // stranding the outlet on a committed URL. Supersession is the counter's
    // job, not the await's.
    //
    // Runs even with no tail: a route without one has nothing for children to
    // render, but they must still be superseded, or a child mid-`enter()` for
    // the previous tail commits over a URL that has moved on.
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
   * `goto()` and the late-mount path in `_onRoutesConnected`, so identical
   * input cannot be silent on one and an uncaught throw on the other.
   *
   * A child with no route for the new tail is expected, not an error: the
   * outgoing branch mid-swap, or a deep link the child cannot render. Filtered
   * structurally rather than by swallowing rejections, so a genuine `enter()`
   * rejection still surfaces. Skipping must still supersede, or an in-flight
   * child navigation stays current and can commit over a URL that has moved on.
   */
  private _routeChild(child: Routes, tail: string | undefined) {
    if (tail === undefined) {
      child._supersede();
      return;
    }
    const childPath = formatLocation(tail, {
      search: this._currentSearch,
      hash: this._currentHash,
    });
    if (!child.hasRouteFor(childPath)) {
      child._supersede();
      return;
    }
    void child.goto(childPath).catch((err) => {
      queueMicrotask(() => {
        throw err;
      });
    });
  }

  /**
   * Invalidate any in-flight `goto()` on this controller without starting a
   * new one.
   */
  private _supersede(seen: Set<Routes> = new Set()): void {
    // Defence in depth. `hostDisconnected` removes the listener that could
    // produce a `_childRoutes` cycle, and a test asserts one cannot form, but
    // an unguarded recursive walk over a cycle is a stack overflow rather than
    // a misrender.
    if (seen.has(this)) {
      return;
    }
    seen.add(this);
    this._gotoSeq++;
    // On the navigating branch the child's own propagation loop reaches the
    // grandchildren, but a skipped child never runs one, so without this an
    // in-flight grandchild `enter()` stays current.
    for (const child of this._childRoutes) {
      child._supersede(seen);
    }
  }

  /**
   * True when this controller or any below it has a route that constrains the
   * hash.
   *
   * `Router` gates interception of fragment-only navigation on this. Ungated, a
   * pathname-only app would have every in-page anchor swallowed and re-rendered
   * instead of scrolled. Walks children because a nested controller may route
   * on the hash while the top-level `Router`, the only one that sees the
   * navigate event, does not.
   */
  protected _constrainsHash(seen: Set<Routes> = new Set()): boolean {
    // Cycle guard, matching `_supersede`; see the note there.
    if (seen.has(this)) {
      return false;
    }
    seen.add(this);
    return (
      this.routes.some((r) => getPattern(r).hash !== '*') ||
      this._childRoutes.some((c) => c._constrainsHash(seen))
    );
  }

  /**
   * True when this controller can render `path`.
   *
   * `Router` gates interception on this. Intercepting a path we cannot render
   * commits the URL and then throws out of `goto()`, leaving the address bar
   * moved and the outlet stale; declining lets the browser handle a
   * server-rendered page, an export endpoint, or a GET form.
   */
  hasRouteFor(path: string): boolean {
    // A fallback matches everything, and a controller with no routes behaves as
    // if it had one `/*` route. Worth short-circuiting, since `Router` asks
    // this on every navigation.
    if (this.fallback !== undefined || this.routes.length === 0) {
      return true;
    }
    // `test()`, not `_match()`: this needs only the yes/no, and `exec()` pays
    // ~8x on a hit to build a groups object the caller would throw away.
    const location = parseLocation(path);
    return this.routes.some((r) => getPattern(r).test(location));
  }

  /**
   * The first route matching `location` with its parsed parameters, or the
   * fallback's match if one is configured.
   *
   * One `exec()` per candidate rather than `test()` to select and `exec()` to
   * extract, which ran the winning pattern twice.
   */
  private _match(location: RouteLocation):
    | {
        route: RouteConfig;
        params: {[key: string]: string | undefined};
        tail: string | undefined;
      }
    | undefined {
    for (const route of this.routes) {
      const result = getPattern(route).exec(location);
      if (result !== null) {
        const params: {[key: string]: string | undefined} = {
          ...result.pathname.groups,
        };
        // Named groups only. Every component numbers its positional groups from
        // zero independently, so `/child/*` with a hash of `*` yields a "0" in
        // both, and `tailOf` picks the tail by highest numeric key. Merging
        // them would let a fragment masquerade as the tail.
        for (const groups of [result.search.groups, result.hash.groups]) {
          for (const [key, value] of Object.entries(groups)) {
            if (!/^\d+$/.test(key)) {
              params[key] = value;
            }
          }
        }
        return {route, params, tail: tailOf(route, result.pathname.groups)};
      }
    }
    if (this.fallback === undefined) {
      return undefined;
    }
    // The fallback behaves like a `/*` path; the `path` here only makes it a
    // valid RouteConfig. Matched by hand rather than with a real `/*` pattern
    // because a nested controller is handed its tail without a leading slash,
    // which `/*` rejects, so a nested fallback matched nothing and its own
    // children never routed.
    const {pathname} = location;
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
    // Without this, a host that is disconnected and reconnected (a repeat()
    // reorder, a tab swap) leaves the sibling controller's listener installed,
    // so on the second connect it claims the re-dispatching controller as its
    // child and the pair point at each other: a `_childRoutes` cycle, which
    // recursive walks turn into a stack overflow.
    this._host.removeEventListener(
      RoutesConnectedEvent.eventName,
      this._onRoutesConnected
    );
    this._onDisconnect?.();
    this._parentRoutes = undefined;
  }

  private _onRoutesConnected = (e: RoutesConnectedEvent) => {
    // Ignore our own event, which we receive because we dispatch on the host.
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

    // A child mounting under an existing tail match missed the propagation loop
    // in goto() that ran before it existed, so catch it up.
    this._routeChild(childRoutes, this._currentTail);
  };
}

/**
 * Fired from a Routes controller when its host connects, to announce the child
 * route and connect it to a parent controller.
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
