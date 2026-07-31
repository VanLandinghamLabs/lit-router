/**
 * @license
 * Copyright 2026 VanLandingham Labs
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {LitElement, html} from 'lit';
import {customElement} from 'lit/decorators.js';
import {Router, supportsNavigationApi} from '../router.js';

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

declare global {
  interface HTMLElementTagNameMap {
    'nav-test': NavTest;
  }
}
