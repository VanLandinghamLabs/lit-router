/**
 * @license
 * Copyright 2026 VanLandingham Labs
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {LitElement, html} from 'lit';
import {customElement} from 'lit/decorators.js';
import {Router, supportsNavigationApi} from '../router.js';
import {Routes} from '../routes.js';

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
    // `/a` — the convention upstream's own child fixtures use.
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

declare global {
  interface HTMLElementTagNameMap {
    'deep-grand': DeepGrand;
    'deep-child': DeepChild;
    'deep-parent': DeepParent;
    'nav-test': NavTest;
    'nav-child': NavChild;
    'nav-parent': NavParent;
    'nav-strict': NavStrict;
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
  DeepGrand,
  DeepChild,
  DeepParent,
};
