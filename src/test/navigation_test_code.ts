/**
 * @license
 * Copyright 2026 VanLandingham Labs
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {LitElement, html} from 'lit';
import {customElement} from 'lit/decorators.js';
import {Router, supportsNavigationApi} from '../router.js';
import {Routes} from '../routes.js';
import type {RouteConfig} from '../routes.js';

/**
 * A router whose `enter()` hooks can be held open per-route, so a test can
 * force two navigations to be in flight at once and control which one's
 * `enter()` resolves first. That is the ordering the Navigation API is
 * supposed to make impossible to get wrong.
 */
@customElement('nav-test')
export class NavTest extends LitElement {
  /** Resolvers for each held `enter()`, keyed by the path that is waiting. */
  readonly gates = new Map<string, () => void>();
  /** Paths whose `enter()` has been entered, in order. */
  readonly entered: string[] = [];

  /** Paths that are held rather than resolving immediately. */
  slowPaths = new Set<string>();

  usingNavigationApi = supportsNavigationApi();

  private _hold = async (path: string): Promise<boolean> => {
    this.entered.push(path);
    if (this.slowPaths.has(path)) {
      await new Promise<void>((resolve) => this.gates.set(path, resolve));
    }
    return true;
  };

  _router = new Router(this, [
    {path: '/', render: () => html`<h2>Root</h2>`},
    {
      path: '/a',
      enter: () => this._hold('/a'),
      render: () => html`<h2>A</h2>`,
    },
    {
      path: '/b',
      enter: () => this._hold('/b'),
      render: () => html`<h2>B</h2>`,
    },
  ]);

  /** Release a held `enter()`. */
  release(path: string) {
    this.gates.get(path)?.();
    this.gates.delete(path);
  }

  override render() {
    return html`${this._router.outlet()}`;
  }
}

/** Child controller for the nested-route supersession test. */
@customElement('nav-child')
export class NavChild extends LitElement {
  static gates = new Map<string, () => void>();
  static entered: string[] = [];
  static slowPaths = new Set<string>();

  private _hold = async (path: string): Promise<boolean> => {
    NavChild.entered.push(path);
    if (NavChild.slowPaths.has(path)) {
      await new Promise<void>((resolve) => NavChild.gates.set(path, resolve));
    }
    return true;
  };

  _routes = new Routes(this, [
    // No leading slash: the tail group from the parent's `/x/*` is `a`, not
    // `/a`, the convention upstream's own child fixtures use.
    {
      path: 'a',
      enter: () => this._hold('a'),
      render: () => html`<span>CHILD-A</span>`,
    },
    {
      path: 'b',
      enter: () => this._hold('b'),
      render: () => html`<span>CHILD-B</span>`,
    },
  ]);

  override render() {
    return html`${this._routes.outlet()}`;
  }
}

/** Parent whose `/x/*` route mounts the child controller above. */
@customElement('nav-parent')
export class NavParent extends LitElement {
  _router = new Router(this, [
    {path: '/', render: () => html`<h2>Root</h2>`},
    {path: '/x/*', render: () => html`<nav-child></nav-child>`},
  ]);

  override render() {
    return html`${this._router.outlet()}`;
  }
}

/** A router with no fallback, for the "decline what we can't render" test. */
@customElement('nav-strict')
export class NavStrict extends LitElement {
  usingNavigationApi = supportsNavigationApi();

  _router = new Router(this, [
    {path: '/', render: () => html`<h2>Root</h2>`},
    {path: '/known', render: () => html`<h2>Known</h2>`},
  ]);

  override render() {
    return html`${this._router.outlet()}`;
  }
}

/**
 * Two Routes controllers on one host. Disconnect + reconnect makes each
 * register the other as its child, so `_childRoutes` genuinely contains a
 * cycle, which an unguarded recursive walk turns into a stack overflow.
 */
@customElement('nav-twin')
export class NavTwin extends LitElement {
  _a = new Routes(this, [{path: '/*', render: () => html`<span>TWIN</span>`}]);
  _b = new Routes(this, [{path: '/*', render: () => html`<span>TWIN</span>`}]);

  override render() {
    return html`${this._a.outlet()}`;
  }
}

/** Grandchild, for proving supersession reaches depth 3. */
@customElement('deep-grand')
export class DeepGrand extends LitElement {
  static gates = new Map<string, () => void>();
  static entered: string[] = [];
  static slowPaths = new Set<string>();

  private _hold = async (path: string): Promise<boolean> => {
    DeepGrand.entered.push(path);
    if (DeepGrand.slowPaths.has(path)) {
      await new Promise<void>((resolve) => DeepGrand.gates.set(path, resolve));
    }
    return true;
  };

  _routes = new Routes(this, [
    {
      path: 's',
      enter: () => this._hold('s'),
      render: () => html`<span>GRAND-S</span>`,
    },
  ]);

  override render() {
    return html`${this._routes.outlet()}`;
  }
}

@customElement('deep-child')
export class DeepChild extends LitElement {
  _routes = new Routes(this, [
    {path: 'm/*', render: () => html`<deep-grand></deep-grand>`},
  ]);

  override render() {
    return html`${this._routes.outlet()}`;
  }
}

@customElement('deep-parent')
export class DeepParent extends LitElement {
  _router = new Router(this, [
    {path: '/', render: () => html`<h2>Root</h2>`},
    {path: '/y/*', render: () => html`<deep-child></deep-child>`},
  ]);

  override render() {
    return html`${this._router.outlet()}`;
  }
}

/**
 * Child of `tail-parent`, below. Renders only if it is handed the wildcard's
 * tail (`docs/…`) rather than the `:id2` param that precedes it.
 */
@customElement('tail-child')
export class TailChild extends LitElement {
  _routes = new Routes(this, [
    {path: 'docs/:doc', render: ({doc}) => html`<span>DOC-${doc}</span>`},
  ]);

  override render() {
    return html`${this._routes.outlet()}`;
  }
}

/**
 * A wildcard preceded by a named param whose name contains a digit. The tail
 * is group `0`; `id2` is not a positional group at all.
 */
@customElement('tail-parent')
export class TailParent extends LitElement {
  _router = new Router(this, [
    {path: '/', render: () => html`<h2>Root</h2>`},
    {path: '/user/:id2/*', render: () => html`<tail-child></tail-child>`},
  ]);

  override render() {
    return html`${this._router.outlet()}`;
  }
}

/** Child of `many-parent`, below. Renders only if handed group 10, not 9. */
@customElement('many-child')
export class ManyChild extends LitElement {
  _routes = new Routes(this, [
    {path: 'TAIL', render: () => html`<span>MANY-TAIL</span>`},
  ]);

  override render() {
    return html`${this._routes.outlet()}`;
  }
}

/**
 * Eleven wildcards, so the tail is group `10`, the point where a
 * lexicographic key comparison diverges from a numeric one ('9' > '10').
 */
@customElement('many-parent')
export class ManyParent extends LitElement {
  _router = new Router(this, [
    {path: '/', render: () => html`<h2>Root</h2>`},
    {
      path: '/m' + '/*'.repeat(11),
      render: () => html`<many-child></many-child>`,
    },
  ]);

  override render() {
    return html`${this._router.outlet()}`;
  }
}

/** Child of `probe-parent`: renders whatever tail it is handed, if any. */
@customElement('probe-child')
export class ProbeChild extends LitElement {
  _routes = new Routes(this, [
    {path: '*', render: (p) => html`<span>TAIL=${p[0]}</span>`},
  ]);

  override render() {
    return html`${this._routes.outlet()}`;
  }
}

/**
 * A parent the test installs routes on, so one fixture covers several pattern
 * shapes. Build them with `probeRoute()` / `probePattern()` below, from inside
 * this realm: a `TemplateResult` made by the test file's own `html` would
 * belong to a different copy of lit.
 */
@customElement('probe-parent')
export class ProbeParent extends LitElement {
  _router = new Router(this, [{path: '/', render: () => html`<h2>Root</h2>`}]);

  override render() {
    return html`${this._router.outlet()}`;
  }
}

const renderProbeChild = () => html`<probe-child></probe-child>`;

/** A path route that mounts `probe-child`. */
export const probeRoute = (path: string): RouteConfig => ({
  path,
  render: renderProbeChild,
});

/** A `URLPattern` route that mounts `probe-child`. */
export const probePattern = (pathname: string): RouteConfig => ({
  pattern: new URLPattern({pathname}),
  render: renderProbeChild,
});

/** Grandchild mounted by `fb-child`'s fallback. */
@customElement('fb-grand')
export class FbGrand extends LitElement {
  _routes = new Routes(this, [
    {path: 'docs/:doc', render: ({doc}) => html`<span>DOC-${doc}</span>`},
  ]);

  override render() {
    return html`${this._routes.outlet()}`;
  }
}

/**
 * A nested controller whose *fallback* mounts a grandchild. It is handed the
 * tail from `/f/*` with no leading slash, and the fallback must pass it on.
 */
@customElement('fb-child')
export class FbChild extends LitElement {
  _routes = new Routes(
    this,
    [{path: 'known', render: () => html`<span>KNOWN</span>`}],
    {
      fallback: {
        render: (p) => html`<span>FB=${p[0]}</span><fb-grand></fb-grand>`,
      },
    }
  );

  override render() {
    return html`${this._routes.outlet()}`;
  }
}

@customElement('fb-parent')
export class FbParent extends LitElement {
  _router = new Router(this, [
    {path: '/', render: () => html`<h2>Root</h2>`},
    {path: '/f/*', render: () => html`<fb-child></fb-child>`},
  ]);

  override render() {
    return html`${this._router.outlet()}`;
  }
}

/** A child with an index route, spelled as the empty tail. */
@customElement('idx-child')
export class IdxChild extends LitElement {
  _routes = new Routes(this, [
    {path: '', render: () => html`<span>INDEX</span>`},
    {path: ':id', render: ({id}) => html`<span>ID-${id}</span>`},
  ]);

  override render() {
    return html`${this._routes.outlet()}`;
  }
}

@customElement('idx-parent')
export class IdxParent extends LitElement {
  _router = new Router(this, [
    {path: '/', render: () => html`<h2>Root</h2>`},
    {path: '/i/*', render: () => html`<idx-child></idx-child>`},
  ]);

  override render() {
    return html`${this._router.outlet()}`;
  }
}

/** Child whose `enter()` can be held, for the no-tail supersession test. */
@customElement('sup-child')
export class SupChild extends LitElement {
  static gates = new Map<string, () => void>();
  static entered: string[] = [];
  static slowPaths = new Set<string>();

  private _hold = async (path: string): Promise<boolean> => {
    SupChild.entered.push(path);
    if (SupChild.slowPaths.has(path)) {
      await new Promise<void>((resolve) => SupChild.gates.set(path, resolve));
    }
    return true;
  };

  _routes = new Routes(this, [
    {
      path: 'docs/:doc',
      enter: ({doc}) => this._hold(`docs/${doc}`),
      render: ({doc}) => html`<span>DOC-${doc}</span>`,
    },
  ]);

  override render() {
    return html`${this._routes.outlet()}`;
  }
}

const renderSupChild = () => html`<sup-child></sup-child>`;

/**
 * Both routes render the child through the same template, so on the move from
 * `/u/5/docs/a` to `/u/5` lit keeps the same `sup-child` element connected,
 * which is what makes a stale nested commit observable.
 */
@customElement('sup-parent')
export class SupParent extends LitElement {
  _router = new Router(this, [
    {path: '/', render: () => html`<h2>Root</h2>`},
    {path: '/u/:id/*', render: renderSupChild},
    {path: '/u/:id', render: renderSupChild},
  ]);

  override render() {
    return html`${this._router.outlet()}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'probe-child': ProbeChild;
    'probe-parent': ProbeParent;
    'fb-grand': FbGrand;
    'fb-child': FbChild;
    'fb-parent': FbParent;
    'idx-child': IdxChild;
    'idx-parent': IdxParent;
    'sup-child': SupChild;
    'sup-parent': SupParent;
    'tail-child': TailChild;
    'tail-parent': TailParent;
    'many-child': ManyChild;
    'many-parent': ManyParent;
    'deep-grand': DeepGrand;
    'deep-child': DeepChild;
    'deep-parent': DeepParent;
    'nav-test': NavTest;
    'nav-child': NavChild;
    'nav-parent': NavParent;
    'nav-strict': NavStrict;
    'nav-twin': NavTwin;
  }
}

// Expose this module on the frame's window so the parent realm can reach the
// same instance (and therefore the same static test state) that the frame's
// elements use. Importing it again from the parent would create a second copy.
(window as unknown as {__navTestModule: unknown}).__navTestModule = {
  NavTest,
  NavChild,
  NavParent,
  NavStrict,
  NavTwin,
  DeepGrand,
  DeepChild,
  DeepParent,
  TailChild,
  TailParent,
  ManyChild,
  ManyParent,
  ProbeChild,
  ProbeParent,
  probeRoute,
  probePattern,
  FbGrand,
  FbChild,
  FbParent,
  IdxChild,
  IdxParent,
  SupChild,
  SupParent,
};
