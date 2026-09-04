/**
 * @license
 * Copyright 2026 VanLandingham Labs
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {assert} from '@open-wc/testing';
import type {
  HashTest,
  PathnameOnlyTest,
  SearchTest,
  HashGroupTest,
  NestTest,
  WildcardHashTest,
} from './location_test_code.js';
import {stripExpressionComments} from './test-helpers.js';

const canTest =
  window.ShadowRoot &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  !(window as any).ShadyDOM?.inUse;

(canTest ? suite : suite.skip)('Search and hash routing', () => {
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

  /** Mounts `tagName` in the iframe at `url` and settles the router. */
  const mountAt = async <T extends HTMLElement>(
    tagName: string,
    url: string
  ): Promise<T> => {
    await loadTestModule('./location_test.html');
    const {contentWindow, contentDocument} = container;
    contentWindow!.history.pushState({}, '', url);
    const el = contentDocument!.createElement(tagName) as T;
    contentDocument!.body.append(el);
    await (el as unknown as {updateComplete: Promise<unknown>}).updateComplete;
    await new Promise((r) => setTimeout(r, 50));
    return el;
  };

  const rendered = (el: HTMLElement) =>
    stripExpressionComments(el.shadowRoot!.innerHTML);

  test('a hash-only route matches a deep link to its hash', async () => {
    const el = await mountAt<HashTest>('hash-test', '/#two');
    assert.include(rendered(el), '<h2>Two</h2>');
    assert.notInclude(rendered(el), '<h2>One</h2>');
  });

  test('goto() is handed the search and hash, not just the pathname', async () => {
    const el = await mountAt<HashTest>('hash-test', '/deep?q=1#two');
    assert.deepEqual(el.seen, ['/deep?q=1#two']);
  });

  test('clicking a hash link routes to the matching hash route', async () => {
    const el = await mountAt<HashTest>('hash-test', '/#one');
    assert.include(rendered(el), '<h2>One</h2>');

    (el.shadowRoot!.querySelector('#two') as HTMLAnchorElement).click();
    await new Promise((r) => setTimeout(r, 100));
    await el.updateComplete;

    assert.include(rendered(el), '<h2>Two</h2>');
    assert.notInclude(rendered(el), '<h2>One</h2>');
  });

  test('a pathname-only app does not intercept hash navigation', async () => {
    const el = await mountAt<PathnameOnlyTest>('pathname-only-test', '/a');
    const before = el.seen.length;

    (el.shadowRoot!.querySelector('#frag') as HTMLAnchorElement).click();
    await new Promise((r) => setTimeout(r, 100));
    await el.updateComplete;

    assert.equal(container.contentWindow!.location.hash, '#frag');
    assert.equal(
      el.seen.length,
      before,
      'no route constrains the hash, so the browser keeps its native scroll'
    );
  });

  test('a search-constrained route matches the query string', async () => {
    const el = await mountAt<SearchTest>('search-test', '/deep?q=2');
    assert.include(rendered(el), '<h2>Q2</h2>');
    assert.notInclude(rendered(el), '<h2>Q1</h2>');
  });

  test('named groups captured from the hash reach render()', async () => {
    const el = await mountAt<HashGroupTest>('hash-group-test', '/#intro');
    assert.include(rendered(el), '<h2>Section: intro</h2>');
  });

  test('a child route still matches its tail when a hash is present', async () => {
    const el = await mountAt<NestTest>('nest-test', '/child/abc#frag');
    const child = el.shadowRoot!.querySelector('nest-child') as HTMLElement;
    await (child as unknown as {updateComplete: Promise<unknown>})
      .updateComplete;
    await new Promise((r) => setTimeout(r, 50));
    assert.include(rendered(child), '<h3>Child: abc</h3>');
  });

  test('the tail comes from the pathname when the hash also has a wildcard', async () => {
    const el = await mountAt<WildcardHashTest>(
      'wildcard-hash-test',
      '/child/abc#frag'
    );
    const child = el.shadowRoot!.querySelector('nest-child') as HTMLElement;
    await (child as unknown as {updateComplete: Promise<unknown>})
      .updateComplete;
    await new Promise((r) => setTimeout(r, 50));
    assert.include(rendered(child), '<h3>Child: abc</h3>');
  });
});
