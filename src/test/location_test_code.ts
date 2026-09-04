/**
 * @license
 * Copyright 2026 VanLandingham Labs
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {LitElement, html} from 'lit';
import {customElement} from 'lit/decorators.js';
import {Router} from '../router.js';
import {Routes} from '../routes.js';

/** Records the exact argument every goto() call is handed. */
export class SpyRouter extends Router {
  seen: string[] = [];
  override async goto(path: string, options?: {signal?: AbortSignal}) {
    this.seen.push(path);
    return super.goto(path, options);
  }
}

/** Hash-only URLPattern routes, as in lit/lit#3517. */
@customElement('hash-test')
export class HashTest extends LitElement {
  _router = new SpyRouter(this, [
    {pattern: new URLPattern({hash: 'one'}), render: () => html`<h2>One</h2>`},
    {pattern: new URLPattern({hash: 'two'}), render: () => html`<h2>Two</h2>`},
  ]);

  get seen() {
    return this._router.seen;
  }

  override render() {
    return html`
      <a id="one" href="#one">one</a>
      <a id="two" href="#two">two</a>
      ${this._router.outlet()}
    `;
  }
}

/** A pathname-only app: hash navigation must stay the browser's business. */
@customElement('pathname-only-test')
export class PathnameOnlyTest extends LitElement {
  _router = new SpyRouter(this, [
    {path: '/*', render: () => html`<h2>Catch-all</h2>`},
  ]);

  get seen() {
    return this._router.seen;
  }

  override render() {
    return html`
      <a id="frag" href="#frag">frag</a>
      ${this._router.outlet()}
    `;
  }
}

/** A route constrained by `search`. */
@customElement('search-test')
export class SearchTest extends LitElement {
  _router = new Router(this, [
    {
      pattern: new URLPattern({pathname: '/deep', search: 'q=1'}),
      render: () => html`<h2>Q1</h2>`,
    },
    {
      pattern: new URLPattern({pathname: '/deep', search: 'q=2'}),
      render: () => html`<h2>Q2</h2>`,
    },
  ]);

  override render() {
    return this._router.outlet();
  }
}

/** Named groups captured from the hash should reach render(). */
@customElement('hash-group-test')
export class HashGroupTest extends LitElement {
  _router = new Router(this, [
    {
      pattern: new URLPattern({pathname: '/', hash: ':section'}),
      render: ({section}) => html`<h2>Section: ${section}</h2>`,
    },
  ]);

  override render() {
    return this._router.outlet();
  }
}

/** Nesting must keep working when a hash is present. */
@customElement('nest-test')
export class NestTest extends LitElement {
  _router = new Router(this, [
    {path: '/child/*', render: () => html`<nest-child></nest-child>`},
  ]);

  override render() {
    return this._router.outlet();
  }
}

@customElement('nest-child')
export class NestChild extends LitElement {
  _routes = new Routes(this, [
    {path: ':id', render: ({id}) => html`<h3>Child: ${id}</h3>`},
  ]);

  override render() {
    return this._routes.outlet();
  }
}

/**
 * A trailing pathname wildcard alongside a hash wildcard. Both produce a
 * positional group keyed "0"; the tail must still come from the pathname.
 */
@customElement('wildcard-hash-test')
export class WildcardHashTest extends LitElement {
  _router = new Router(this, [
    {
      pattern: new URLPattern({pathname: '/child/*', hash: '*'}),
      render: () => html`<nest-child></nest-child>`,
    },
  ]);

  override render() {
    return this._router.outlet();
  }
}
