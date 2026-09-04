/**
 * @license
 * Copyright 2026 VanLandingham Labs
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {assert} from '@open-wc/testing';
import type {LinkRoot, LinkChild, LinkDupe} from './link_test_code.js';

const canTest =
  window.ShadowRoot &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  !(window as any).ShadyDOM?.inUse;

(canTest ? suite : suite.skip)('linkTo', () => {
  let container: HTMLIFrameElement;

  setup(async () => {
    container = document.createElement('iframe');
    document.body.appendChild(container);
  });

  teardown(() => {
    container?.remove();
  });

  const loadTestModule = async (filename: string) => {
    const testModuleUrl = new URL(filename, import.meta.url);
    container.src = testModuleUrl.href;
    await new Promise<void>((res) => {
      const loadListener = () => {
        container.removeEventListener('load', loadListener);
        res();
      };
      container.addEventListener('load', loadListener);
    });
  };

  const mountAt = async <T extends HTMLElement>(
    tagName: string,
    url: string
  ): Promise<T> => {
    await loadTestModule('./link_test.html');
    const {contentWindow, contentDocument} = container;
    contentWindow!.history.pushState({}, '', url);
    const el = contentDocument!.createElement(tagName) as T;
    contentDocument!.body.append(el);
    await (el as unknown as {updateComplete: Promise<unknown>}).updateComplete;
    await new Promise((r) => setTimeout(r, 50));
    return el;
  };

  const childOf = async (root: LinkRoot): Promise<LinkChild> => {
    const child = root.shadowRoot!.querySelector('link-child') as LinkChild;
    await (child as unknown as {updateComplete: Promise<unknown>})
      .updateComplete;
    await new Promise((r) => setTimeout(r, 50));
    return child;
  };

  test('resolves a name on the same controller', async () => {
    const el = await mountAt<LinkRoot>('link-root', '/');
    assert.equal(el.router.linkTo('home'), '/');
  });

  test('substitutes a named parameter', async () => {
    const el = await mountAt<LinkRoot>('link-root', '/');
    assert.equal(el.router.linkTo('item', {id: 'abc'}), '/item/abc');
  });

  test('reads the pattern of a URLPattern route', async () => {
    const el = await mountAt<LinkRoot>('link-root', '/');
    assert.equal(el.router.linkTo('tagged', {tag: 'lit'}), '/tag/lit');
  });

  test('a trailing wildcard defaults to the empty tail', async () => {
    const el = await mountAt<LinkRoot>('link-root', '/');
    assert.equal(el.router.linkTo('docs'), '/docs/');
  });

  test('resolves down into a mounted child, prefixed by the parent', async () => {
    const el = await mountAt<LinkRoot>('link-root', '/docs/intro');
    await childOf(el);
    assert.equal(el.router.linkTo('page', {page: 'guide'}), '/docs/guide');
  });

  test('resolves up from a child to a root route', async () => {
    const el = await mountAt<LinkRoot>('link-root', '/docs/intro');
    const child = await childOf(el);
    assert.equal(child.routes.linkTo('home'), '/');
    assert.equal(child.routes.linkTo('item', {id: 'x'}), '/item/x');
  });

  test('resolves a nested empty path to the parent prefix', async () => {
    const el = await mountAt<LinkRoot>('link-root', '/docs/intro');
    const child = await childOf(el);
    assert.equal(child.routes.linkTo('index'), '/docs/');
  });

  test('an unknown name throws and names what was asked for', async () => {
    const el = await mountAt<LinkRoot>('link-root', '/');
    assert.throws(() => el.router.linkTo('nope'), /no route named 'nope'/i);
  });

  test('a name in an unmounted branch is not resolvable', async () => {
    // `page` lives on link-child, which only mounts under /docs/*.
    const el = await mountAt<LinkRoot>('link-root', '/');
    assert.throws(() => el.router.linkTo('page', {page: 'x'}), /no route named/i);
  });

  test('a missing parameter throws and names the parameter', async () => {
    const el = await mountAt<LinkRoot>('link-root', '/');
    assert.throws(() => el.router.linkTo('item'), /missing.*\bid\b/i);
  });

  test('a duplicated name throws rather than picking one', async () => {
    const el = await mountAt<LinkDupe>('link-dupe', '/a');
    assert.throws(() => el.router.linkTo('dupe'), /more than one route named/i);
  });
});
