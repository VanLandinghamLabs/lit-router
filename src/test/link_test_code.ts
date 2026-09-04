/**
 * @license
 * Copyright 2026 VanLandingham Labs
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {LitElement, html} from 'lit';
import {customElement} from 'lit/decorators.js';
import {Router} from '../router.js';
import {Routes} from '../routes.js';

@customElement('link-root')
export class LinkRoot extends LitElement {
  _router = new Router(this, [
    {name: 'home', path: '/', render: () => html`<h2>Home</h2>`},
    {
      name: 'item',
      path: '/item/:id',
      render: ({id}) => html`<h2>Item ${id}</h2>`,
    },
    {name: 'docs', path: '/docs/*', render: () => html`<link-child></link-child>`},
    {
      name: 'tagged',
      pattern: new URLPattern({pathname: '/tag/:tag'}),
      render: ({tag}) => html`<h2>Tag ${tag}</h2>`,
    },
    {path: '/unnamed', render: () => html`<h2>Unnamed</h2>`},
  ]);

  get router() {
    return this._router;
  }

  override render() {
    return this._router.outlet();
  }
}

@customElement('link-child')
export class LinkChild extends LitElement {
  _routes = new Routes(this, [
    {name: 'page', path: ':page', render: ({page}) => html`<h3>Page ${page}</h3>`},
    {name: 'index', path: '', render: () => html`<h3>Docs index</h3>`},
  ]);

  get routes() {
    return this._routes;
  }

  override render() {
    return this._routes.outlet();
  }
}

/** Two routes sharing a name, which must be reported rather than guessed at. */
@customElement('link-dupe')
export class LinkDupe extends LitElement {
  _router = new Router(this, [
    {name: 'dupe', path: '/a', render: () => html`<h2>A</h2>`},
    {name: 'dupe', path: '/b', render: () => html`<h2>B</h2>`},
  ]);

  get router() {
    return this._router;
  }

  override render() {
    return this._router.outlet();
  }
}
