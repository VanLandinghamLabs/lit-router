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
 * The part of `URLPattern` this router uses. Structural, not a reference to the
 * global: `URLPattern` is not in TypeScript's `lib.dom`, so typing against it
 * fails a consumer build with `TS2304`.
 */
export interface URLPatternLike {
  /** Read by `tailOf`, which the groups object alone cannot answer. */
  readonly pathname: string;
  /** `'*'` means unconstrained. `Router` gates hash interception on this. */
  readonly hash: string;
  test(input: RouteLocation): boolean;
  exec(input: RouteLocation): {
    pathname: {groups: {[key: string]: string | undefined}};
    search: {groups: {[key: string]: string | undefined}};
    hash: {groups: {[key: string]: string | undefined}};
  } | null;
}

/**
 * The parts of a location this router matches against. `search` and `hash`
 * carry no leading `?` or `#`: a real `URLPattern` canonicalises either form
 * away, but `URLPatternLike` admits implementations that do not.
 */
export interface RouteLocation {
  pathname: string;
  search: string;
  hash: string;
}

/**
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
 * A trailing wildcard as `URLPattern.prototype.pathname` regenerates it: `*` or
 * `{*}`, optionally `?`. Excludes an escaped `\*` and a `*` modifying a group
 * or named param (`(\d+)*`, `{/}*`, `:rest*`), which would otherwise let an
 * earlier group be taken for the tail. See #4.
 */
const TRAILING_WILDCARD = /(?:(?<![\\)}]|:[\w$]+)\*|\{\*\})\??$/;

/**
 * What a trailing wildcard captured, or undefined when there is none. Decided
 * from the pattern, not the groups object: an unnamed group (`/post/(\d+)`) and
 * a non-final wildcard are keyed by index exactly as a tail is. See #4.
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
    // Numeric, not lexicographic: '9' > '10' as strings.
    if (/^\d+$/.test(key) && Number(key) > tailIndex) {
      tailIndex = Number(key);
    }
  }
  return tailIndex < 0 ? undefined : params[String(tailIndex)];
};

/**
 * One piece of a pathname pattern, as `parsePattern` understands it.
 */
type PatternNode =
  | {kind: 'literal'; text: string}
  | {kind: 'param'; name: string; optional: boolean}
  | {kind: 'wildcard'; index: number; optional: boolean}
  | {kind: 'group'; nodes: Array<PatternNode>; optional: boolean};

/**
 * Parses the subset of `URLPattern` pathname syntax that can be run backwards:
 * literals, `:name`, `*`, and `{...}` groups, each optionally `?`.
 *
 * A regex group cannot be reversed, and `+` or `*` repetition has no single
 * answer, so both throw rather than guess. Named the route, not the pattern,
 * because the caller passed a name and that is what they can act on.
 */
const parsePattern = (pattern: string, name: string): Array<PatternNode> => {
  let i = 0;
  let positional = 0;

  const takeModifier = (): boolean => {
    const mod = pattern[i];
    if (mod === '?') {
      i++;
      return true;
    }
    if (mod === '+' || mod === '*') {
      throw new Error(
        `Cannot build a link to '${name}': the repeating modifier '${mod}' in ` +
          `'${pattern}' has no single reverse.`
      );
    }
    return false;
  };

  const parseNodes = (untilBrace: boolean): Array<PatternNode> => {
    const nodes: Array<PatternNode> = [];
    let literal = '';
    const flush = () => {
      if (literal !== '') {
        nodes.push({kind: 'literal', text: literal});
        literal = '';
      }
    };

    while (i < pattern.length) {
      const c = pattern[i];
      if (untilBrace && c === '}') {
        break;
      }
      if (c === '\\') {
        literal += pattern[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '(') {
        throw new Error(
          `Cannot build a link to '${name}': '${pattern}' contains a regular ` +
            `expression group, which cannot be reversed. Use a named parameter.`
        );
      }
      if (c === '{') {
        flush();
        i++;
        const inner = parseNodes(true);
        if (pattern[i] !== '}') {
          throw new Error(
            `Cannot build a link to '${name}': unbalanced '{' in '${pattern}'.`
          );
        }
        i++;
        nodes.push({kind: 'group', nodes: inner, optional: takeModifier()});
        continue;
      }
      const named = c === ':' ? /^:([A-Za-z0-9_$]+)/.exec(pattern.slice(i)) : null;
      if (named !== null) {
        flush();
        i += named[0].length;
        nodes.push({kind: 'param', name: named[1], optional: takeModifier()});
        continue;
      }
      if (c === '*') {
        flush();
        i++;
        nodes.push({
          kind: 'wildcard',
          index: positional++,
          optional: takeModifier(),
        });
        continue;
      }
      literal += c;
      i++;
    }
    flush();
    return nodes;
  };

  return parseNodes(false);
};

/** The highest wildcard index in `nodes`, or -1 when there is none. */
const maxWildcard = (nodes: Array<PatternNode>): number =>
  nodes.reduce(
    (max, node) =>
      node.kind === 'wildcard'
        ? Math.max(max, node.index)
        : node.kind === 'group'
          ? Math.max(max, maxWildcard(node.nodes))
          : max,
    -1
  );

/**
 * Builds a pathname from `nodes`, collecting the names of any parameters the
 * caller did not supply.
 *
 * `tailIndex` is the wildcard that a trailing `/*` produced, or -1. That one
 * may be left out: an empty tail is the index of a nested route space, which
 * is what `linkTo('docs')` should mean. Any other wildcard is required, since
 * dropping it would silently join the segments around it.
 */
const fillNodes = (
  nodes: Array<PatternNode>,
  params: {[key: string]: string | undefined},
  tailIndex: number,
  missing: Array<string>
): string => {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'literal':
        out += node.text;
        break;
      case 'param': {
        const value = params[node.name];
        if (value === undefined) {
          if (!node.optional) {
            missing.push(node.name);
          }
        } else {
          out += value;
        }
        break;
      }
      case 'wildcard': {
        const value = params[String(node.index)];
        if (value === undefined) {
          if (!node.optional && node.index !== tailIndex) {
            missing.push(String(node.index));
          }
        } else {
          out += value;
        }
        break;
      }
      case 'group': {
        const before = missing.length;
        const text = fillNodes(node.nodes, params, tailIndex, missing);
        if (missing.length > before && node.optional) {
          // The whole point of an optional group: drop it, and the parameters
          // it wanted stop being missing.
          missing.length = before;
        } else {
          out += text;
        }
        break;
      }
    }
  }
  return out;
};

/** Runs a pathname pattern backwards. Throws naming every missing parameter. */
const fillPattern = (
  pattern: string,
  params: {[key: string]: string | undefined},
  name: string
): string => {
  const nodes = parsePattern(pattern, name);
  const missing: Array<string> = [];
  const tailIndex = TRAILING_WILDCARD.test(pattern) ? maxWildcard(nodes) : -1;
  const text = fillNodes(nodes, params, tailIndex, missing);
  if (missing.length > 0) {
    throw new Error(
      `Cannot build a link to '${name}': missing parameter` +
        `${missing.length > 1 ? 's' : ''} ` +
        missing.map((m) => `'${m}'`).join(', ') +
        ` for pattern '${pattern}'.`
    );
  }
  return text;
};

/**
 * A reactive controller that performs location-based routing using a
 * configuration of URL patterns and associated render callbacks.
 */
export class Routes implements ReactiveController {
  private readonly _host: ReactiveControllerHost & HTMLElement;

  /**
   * The installed routes, in precedence order. Mutable, but mutating it starts
   * no route transition; call `goto()` if a different route now matches.
   */
  routes: Array<RouteConfig> = [];

  /**
   * Matched when no route in {@link routes} does. Behaves like `/*`, so
   * `params[0]` is the whole pathname minus any leading slash.
   */
  fallback?: BaseRouteConfig;

  private readonly _childRoutes: Array<Routes> = [];

  private _parentRoutes: Routes | undefined;

  /** Monotonic goto counter; see the last-goto-wins note in goto(). */
  private _gotoSeq = 0;

  private _currentPathname: string | undefined;
  private _currentTail: string | undefined;
  /** Ambient, not tailed: only the pathname nests. */
  private _currentSearch = '';
  private _currentHash = '';
  private _currentRoute: RouteConfig | undefined;
  private _currentParams: {
    [key: string]: string | undefined;
  } = {};

  /** Must run in hostDisconnected, or this controller can receive another
   * route's tail match. */
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
   * A URL for the route named `name`, with `params` substituted into its
   * pattern.
   *
   * Lets a component say which route it means instead of where that route
   * currently lives, so moving a route subtree does not silently break every
   * hardcoded link inside it.
   *
   * Resolution covers the mounted controller tree: this controller, its
   * ancestors, and any descendant that has rendered. A route in a branch that
   * has not mounted yet is not addressable, because the mapping from a parent
   * route to its child controller only exists once that parent has rendered.
   * An unknown or ambiguous name throws rather than producing a wrong URL.
   */
  linkTo(
    name: string,
    params: {[key: string]: string | undefined} = {}
  ): string {
    let root: Routes = this;
    while (root._parentRoutes !== undefined) {
      root = root._parentRoutes;
    }

    const found: Array<{owner: Routes; route: RouteConfig}> = [];
    const visit = (routes: Routes, seen: Set<Routes>) => {
      // Cycle guard, matching `_supersede`; see the note there.
      if (seen.has(routes)) {
        return;
      }
      seen.add(routes);
      for (const route of routes.routes) {
        if (route.name === name) {
          found.push({owner: routes, route});
        }
      }
      for (const child of routes._childRoutes) {
        visit(child, seen);
      }
    };
    visit(root, new Set());

    if (found.length === 0) {
      throw new Error(
        `No route named '${name}' in the mounted route tree. Names are only ` +
          `resolvable once the controller holding them has rendered.`
      );
    }
    if (found.length > 1) {
      throw new Error(
        `More than one route named '${name}' in the mounted route tree.`
      );
    }

    const {owner, route} = found[0];
    // The owner's own segment is being replaced by the generated one, so the
    // prefix is everything above it.
    const prefix = owner._parentRoutes?.link() ?? '';
    return prefix + fillPattern(getPattern(route).pathname, params, name);
  }

  /**
   * Navigates this controller to `path`, which may carry a search and hash.
   * Navigates child routes but not parent ones, so it is not yet a general page
   * navigation API.
   *
   * `options.signal` makes the navigation abandonable. `enter()` is awaited, so
   * a second `goto()` can finish while the first is still resolving; without a
   * signal the slower one commits last onto a route the URL has left.
   */
  async goto(path: string, options?: {signal?: AbortSignal}) {
    // TODO (justinfagnani): handle absolute vs relative paths separately.

    const location = parseLocation(path);
    const {pathname} = location;

    // Last-goto-wins. The signal alone is not enough: a child's first goto()
    // comes from `_onRoutesConnected`, after the parent's navigation finished,
    // so its signal never aborts. Also keeps `Routes` correct standalone.
    const seq = ++this._gotoSeq;
    let tail: string | undefined;

    if (this.routes.length === 0 && this.fallback === undefined) {
      // No routes of its own acts as a single `/*`, passing the whole pathname
      // on as a tail.
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
      // Superseded while `enter` awaited; committing would strand the outlet.
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

    // Not awaited. `requestUpdate()` has not run, so `_childRoutes` still holds
    // the outgoing branch: awaiting gates the parent's swap on a controller
    // that will never render, and its `No route found` would skip
    // `requestUpdate()` below and strand the outlet on a committed URL.
    //
    // Runs even with no tail, so children still get superseded. See #7.
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
   * Hands a tail match to a child. Shared by `goto()`'s propagation loop and the
   * late-mount path, so identical input behaves identically on both.
   *
   * A child with no route for the tail is expected, not an error: the outgoing
   * branch mid-swap, or a deep link it cannot render. Filtered structurally so
   * a genuine `enter()` rejection still surfaces. Skipping must still supersede.
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

  /** Invalidate any in-flight `goto()` here without starting a new one. */
  private _supersede(seen: Set<Routes> = new Set()): void {
    // Defence in depth: a `_childRoutes` cycle cannot form (hostDisconnected,
    // plus a test), but an unguarded walk over one is a stack overflow.
    if (seen.has(this)) {
      return;
    }
    seen.add(this);
    this._gotoSeq++;
    // A skipped child never runs its own propagation loop, so recurse or an
    // in-flight grandchild `enter()` stays current.
    for (const child of this._childRoutes) {
      child._supersede(seen);
    }
  }

  /**
   * True when this controller or any below it constrains the hash. `Router`
   * gates fragment-only interception on this, so a pathname-only app keeps
   * native scrolling. Walks children because only the root sees the event.
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
   * True when this controller can render `path`. `Router` gates interception on
   * this: intercepting what we cannot render commits the URL and then throws,
   * leaving the address bar moved and the outlet stale.
   */
  hasRouteFor(path: string): boolean {
    // A fallback matches everything, and no routes behaves as one `/*`. Worth
    // short-circuiting: `Router` asks this on every navigation.
    if (this.fallback !== undefined || this.routes.length === 0) {
      return true;
    }
    // `test()`, not `_match()`: `exec()` pays ~8x on a hit to build groups the
    // caller would throw away.
    const location = parseLocation(path);
    return this.routes.some((r) => getPattern(r).test(location));
  }

  /**
   * The first route matching `location`, or the fallback's match. One `exec()`
   * per candidate; selecting with `test()` first ran the winner twice.
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
        // Named only. Every component numbers positional groups from zero, so
        // a merged "0" could masquerade as the tail. See #13.
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
    // Matched by hand, not with a real `/*` pattern: a nested controller gets
    // its tail without a leading slash, which `/*` rejects. See #5.
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
    // Without this, a disconnected and reconnected host leaves a sibling's
    // listener installed and the two claim each other as children: a
    // `_childRoutes` cycle, which recursive walks turn into a stack overflow.
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

    // Catch up a child that mounted after goto()'s propagation loop ran.
    this._routeChild(childRoutes, this._currentTail);
  };
}

/** Announces a Routes controller to its parent when the host connects. */
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
