/**
 * @license
 * Copyright 2026 VanLandingham Labs
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {assert} from '@open-wc/testing';
import type {NavTest} from './navigation_test_code.js';

const canTest =
  window.ShadowRoot &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  !(window as any).ShadyDOM?.inUse;

const until = async (
  label: string,
  pred: () => boolean,
  timeoutMs = 3000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};

(canTest ? suite : suite.skip)('Navigation API', () => {
  let container: HTMLIFrameElement;

  setup(() => {
    container = document.createElement('iframe');
    document.body.appendChild(container);
  });

  teardown(() => {
    container?.remove();
  });

  const loadFrame = async () => {
    const url = new URL('./navigation_test.html', import.meta.url);
    container.src = url.href;
    await new Promise<void>((res) => {
      const onLoad = () => {
        container.removeEventListener('load', onLoad);
        res();
      };
      container.addEventListener('load', onLoad);
    });
    return {
      win: container.contentWindow!,
      doc: container.contentDocument!,
      // The frame's <script> already evaluated the module; importing it from
      // the parent realm would yield a *different* instance, so the static
      // test state would not be the one the frame's elements are using.
      mod: (
        container.contentWindow as unknown as {
          __navTestModule: typeof import('./navigation_test_code.js');
        }
      ).__navTestModule,
    };
  };

  const mountTag = async <T extends HTMLElement>(tag: string) => {
    const {win, doc, mod} = await loadFrame();
    win.history.pushState({}, '', '/');
    const el = doc.createElement(tag) as T;
    doc.body.appendChild(el);
    await (el as unknown as {updateComplete: Promise<unknown>}).updateComplete;
    return {el, win, doc, mod};
  };

  const mount = () => mountTag<NavTest>('nav-test');
  const mountParent = () =>
    mountTag<HTMLElement & {updateComplete: Promise<unknown>}>('nav-parent');
  const mountStrict = () => mountTag<HTMLElement>('nav-strict');

  test('the suite is exercising the Navigation API, not the fallback', async () => {
    const {el, win} = await mount();
    // Guards every other test in this file: if the browser ever lacks the API,
    // these would silently pass against the legacy click/popstate path and
    // prove nothing about the thing they are named for.
    assert.isTrue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typeof (win as any).navigation?.addEventListener === 'function',
      'test browser exposes window.navigation'
    );
    assert.isTrue(el.usingNavigationApi, 'Router selected the Navigation API');
  });

  test('a superseded navigation does not win the outlet', async () => {
    const {el, win} = await mount();
    // /a's enter() is held open; /b's resolves immediately. Without honouring
    // navigateEvent.signal, /a commits whenever it is released and the outlet
    // ends up on a route the URL left — the shape of arcsync #632/#640.
    el.slowPaths.add('/a');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (win as any).navigation.navigate('/a');
    await until('/a entered', () => el.entered.includes('/a'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (win as any).navigation.navigate('/b');
    await until('/b entered', () => el.entered.includes('/b'));
    await el.updateComplete;

    // Now let the abandoned /a land.
    el.release('/a');
    await new Promise((r) => setTimeout(r, 100));
    await el.updateComplete;

    assert.equal(win.location.pathname, '/b', 'URL is on the newest route');
    assert.include(
      el.shadowRoot!.textContent,
      'B',
      'outlet must stay on the newest route after the abandoned one resolves'
    );
    assert.notInclude(
      el.shadowRoot!.textContent,
      'A',
      'the superseded route must not swap the outlet back'
    );
  });

  test('programmatic navigation is intercepted, not just anchor clicks', async () => {
    const {el, win} = await mount();
    // The legacy path only saw anchor clicks and popstate — a bare
    // history.pushState() or navigation.navigate() was invisible to it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (win as any).navigation.navigate('/a').finished;
    await el.updateComplete;

    assert.include(el.shadowRoot!.textContent, 'A');
    assert.equal(win.location.pathname, '/a');
  });

  test('back/forward is routed through the same interception path', async () => {
    const {el, win} = await mount();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = (win as any).navigation;
    // `history: 'push'` explicitly: scripted navigation with no user gesture
    // resolves `history: 'auto'` to a *replace* here, which would leave no
    // /a entry to traverse back to. Irrelevant to the router (both forms are
    // intercepted identically) but it makes the test's history deterministic.
    await nav.navigate('/a', {history: 'push'}).finished;
    // Capture the entry rather than counting back() steps: the iframe's own
    // initial document is entry 0 and has no app route, so a blind back() can
    // walk off the end of the routed history.
    const aKey = nav.currentEntry.key;
    await nav.navigate('/b', {history: 'push'}).finished;
    await el.updateComplete;
    assert.include(el.shadowRoot!.textContent, 'B');

    await nav.traverseTo(aKey).finished;
    await el.updateComplete;

    assert.equal(win.location.pathname, '/a');
    assert.include(el.shadowRoot!.textContent, 'A', 'traverse re-rendered');
  });

  test('the URL and the outlet commit together', async () => {
    const {el, win} = await mount();
    el.slowPaths.add('/a');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (win as any).navigation.navigate('/a');
    await until('/a entered', () => el.entered.includes('/a'));

    // The navigation is committed (URL moved) but not finished: this is the
    // window the legacy path had no way to represent.
    assert.equal(win.location.pathname, '/a', 'URL commits immediately');
    let finished = false;
    result.finished.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      }
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.isFalse(finished, 'navigation stays un-finished while enter() runs');

    el.release('/a');
    await until('navigation finished', () => finished);
  });

  test('a superseded navigation does not win a NESTED outlet', async () => {
    // The parent's goto() must await its children, or Router's intercept
    // handler resolves while a nested enter() is still pending. The navigation
    // then *finishes*, its signal is never aborted (a finished navigation has
    // nothing left to cancel), and the superseded child commits anyway —
    // reintroducing the whole bug one level down, on exactly the nested routes
    // real apps use.
    const {el, win, mod} = await mountParent();
    mod.NavChild.slowPaths.add('a');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = (win as any).navigation;
    nav.navigate('/x/a', {history: 'push'});
    await until('child a entered', () => mod.NavChild.entered.includes('a'));

    nav.navigate('/x/b', {history: 'push'});
    await until('child b entered', () => mod.NavChild.entered.includes('b'));
    await el.updateComplete;

    // Let the abandoned nested route land.
    mod.NavChild.gates.get('a')?.();
    await new Promise((r) => setTimeout(r, 150));
    await el.updateComplete;

    const text = el.shadowRoot!.querySelector('nav-child')!.shadowRoot!
      .textContent!;
    assert.equal(win.location.pathname, '/x/b');
    assert.include(text, 'CHILD-B', 'nested outlet stays on the newest route');
    assert.notInclude(text, 'CHILD-A', 'superseded child must not commit');
  });

  test('a reload is left alone', async () => {
    const {win} = await mount();
    // canIntercept is true for reloads. Intercepting one silently turns
    // location.reload() into "re-run goto()", so the document is never
    // replaced and the standard reload escape hatch stops working.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (win as any).__marker = 'alive';
    win.location.reload();
    await until(
      'the document was actually replaced',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (container.contentWindow as any)?.__marker === undefined,
      5000
    );
  });

  test('a path with no route is left to the browser', async () => {
    // Intercepting a path we cannot render commits the URL and then throws out
    // of goto(), stranding the address bar somewhere the outlet never went.
    // Declining lets the real navigation happen.
    const {win, doc} = await mountStrict();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (win as any).__marker = 'alive';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (win as any).navigation.navigate('/not-a-route');
    await until(
      'the browser performed a real navigation',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (container.contentWindow as any)?.__marker === undefined,
      5000
    );
    void doc;
  });

  test('rel="external" opts out on the Navigation API path too', async () => {
    // The retained legacy click path honours rel="external"; both paths this
    // package ships must agree.
    const {el, win, doc} = await mount();
    const a = doc.createElement('a');
    a.href = '/a';
    a.setAttribute('rel', 'external');
    a.textContent = 'external';
    doc.body.appendChild(a);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (win as any).__marker = 'alive';
    a.click();
    await until(
      'the browser performed a real navigation',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (container.contentWindow as any)?.__marker === undefined,
      5000
    );
    assert.notInclude(el.entered, '/a', 'route must not have been entered');
  });

  test('an aborted signal stands a goto down even with no newer goto', async () => {
    // The per-controller counter covers supersession by a *newer* goto. The
    // signal covers cancellation where no newer goto ever arrives — the user
    // hitting stop, or another listener cancelling the navigation. Exercised
    // against Routes directly, since Router only ever supplies a real
    // NavigateEvent signal.
    const {el} = await mount();
    el.slowPaths.add('/a');
    const ac = new AbortController();

    const done = el._router.goto('/a', {signal: ac.signal});
    await until('/a entered', () => el.entered.includes('/a'));

    ac.abort();
    el.release('/a');
    await done;
    await el.updateComplete;

    assert.notInclude(
      el.shadowRoot!.textContent,
      'A',
      'an aborted goto must not commit its route'
    );
  });

  test('navigation.finished waits for NESTED routes, not just the top level', async () => {
    // goto() awaits its child controllers, so intercept()'s handler — and
    // therefore navigation.finished — covers the whole tree. Without that,
    // `await navigate(...).finished` would resolve while a nested view was
    // still loading, which makes the API's central guarantee misleading for
    // anyone who awaits it before measuring or asserting.
    const {win, mod} = await mountParent();
    mod.NavChild.slowPaths.add('a');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = (win as any).navigation;
    // First hop mounts the child (its initial goto comes from
    // _onRoutesConnected). The second is the one whose finished we measure,
    // because by then the child controller is registered as a child.
    await nav.navigate('/x/b', {history: 'push'}).finished;
    mod.NavChild.entered.length = 0;

    const result = nav.navigate('/x/a', {history: 'push'});
    let finished = false;
    result.finished.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      }
    );

    await until('child a entered', () => mod.NavChild.entered.includes('a'));
    await new Promise((r) => setTimeout(r, 50));
    assert.isFalse(
      finished,
      'navigation must not finish while a nested enter() is pending'
    );

    mod.NavChild.gates.get('a')?.();
    await until('navigation finished once the child resolved', () => finished);
  });
});
