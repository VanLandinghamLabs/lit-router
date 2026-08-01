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
  const mountDeep = () =>
    mountTag<HTMLElement & {updateComplete: Promise<unknown>}>('deep-parent');

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
    // Nested supersession has to be covered by the per-controller goto
    // counter, because children are deliberately NOT awaited (see routes.ts —
    // awaiting the outgoing branch was tried and reverted). Without the
    // counter a superseded child commits whenever its enter() resolves,
    // reintroducing the whole bug one level down on exactly the nested routes
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

  test('rel="external" opts out', async () => {
    // `rel="external"` is a convention this router honours; neither HTML nor
    // the Navigation API defines it, so the browser will not decline these for
    // us and the filter is the only thing that does.
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


  test('a child that cannot render the new tail is still superseded', async () => {
    // The propagation loop skips a child with no route for the new tail — the
    // outgoing branch, mid-swap. Skipping must still bump that child's goto
    // counter, or an in-flight nested enter() stays current and commits over a
    // URL that has moved on. Removing the abort signal is only safe because
    // the counter always runs, including on this path.
    const {el, win, mod} = await mountParent();
    mod.NavChild.slowPaths.add('a');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = (win as any).navigation;
    nav.navigate('/x/a', {history: 'push'});
    await until('child a entered', () => mod.NavChild.entered.includes('a'));

    // 'zzz' matches the parent's /x/* but no child route, so the child is
    // skipped rather than navigated.
    nav.navigate('/x/zzz', {history: 'push'});
    await new Promise((r) => setTimeout(r, 100));

    mod.NavChild.gates.get('a')?.();
    await new Promise((r) => setTimeout(r, 150));
    await el.updateComplete;

    const child = el.shadowRoot!.querySelector('nav-child');
    const text = child?.shadowRoot?.textContent ?? '';
    assert.equal(win.location.pathname, '/x/zzz');
    assert.notInclude(
      text,
      'CHILD-A',
      'the abandoned nested route must not commit after the URL moved on'
    );
  });

  test('a deep link under a wildcard the child cannot render does not throw', async () => {
    // The late-mount path must apply the same structural filter as the
    // propagation loop, or identical input is silent one way and an uncaught
    // global error the other, depending only on whether the child was already
    // mounted.
    const {el, win, doc} = await mountParent();
    const errors: string[] = [];
    win.addEventListener('error', (e) => errors.push(String((e as ErrorEvent).message)));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (win as any).navigation.navigate('/x/zzz', {history: 'push'}).finished;
    await new Promise((r) => setTimeout(r, 150));
    await (el as unknown as {updateComplete: Promise<unknown>}).updateComplete;

    void doc;
    assert.deepEqual(errors, [], 'no uncaught error for an unrenderable tail');
  });

  test('supersession reaches a grandchild under a skipped child', async () => {
    // A skipped child never runs its own propagation loop, so bumping only its
    // counter leaves an in-flight grandchild enter() current — the same defect
    // one level deeper than the child case.
    const {el, win, mod} = await mountDeep();
    mod.DeepGrand.slowPaths.add('s');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = (win as any).navigation;
    nav.navigate('/y/m/s', {history: 'push'});
    await until('grandchild s entered', () => mod.DeepGrand.entered.includes('s'));

    // 'zzz' matches /y/* but not the child's `m/*`, so the child is skipped.
    nav.navigate('/y/zzz', {history: 'push'});
    await new Promise((r) => setTimeout(r, 100));

    mod.DeepGrand.gates.get('s')?.();
    await new Promise((r) => setTimeout(r, 200));
    await el.updateComplete;

    const text =
      el.shadowRoot
        ?.querySelector('deep-child')
        ?.shadowRoot?.querySelector('deep-grand')
        ?.shadowRoot?.textContent ?? '';
    assert.equal(win.location.pathname, '/y/zzz');
    assert.notInclude(
      text,
      'GRAND-S',
      'an abandoned grandchild route must not commit after the URL moved on'
    );
  });

  test('a reconnect does not make sibling controllers each other\'s child', async () => {
    // hostConnected adds the lit-routes-connected listener; without a matching
    // removal in hostDisconnected, a host that is disconnected and reconnected
    // (a repeat() reorder, a tab swap) leaves the sibling's listener installed,
    // so on the second connect it claims the re-dispatching controller as its
    // own child and the two point at each other. That cycle turns any
    // recursive walk — and goto()'s own propagation loop — into a stack
    // overflow.
    const {win, doc, mod} = await loadFrame();
    win.history.pushState({}, '', '/');
    const el = doc.createElement('nav-twin') as InstanceType<
      typeof mod.NavTwin
    >;
    doc.body.appendChild(el);
    await el.updateComplete;
    el.remove();
    doc.body.appendChild(el);
    await el.updateComplete;

    const probe = el as unknown as {
      _a: {_childRoutes: unknown[]; _supersede(): void};
      _b: {_childRoutes: unknown[]};
    };
    assert.equal(
      probe._a._childRoutes.length + probe._b._childRoutes.length,
      1,
      'exactly one parent/child edge, not a mutual pair'
    );

    // Both of these would recurse forever on a cycle.
    probe._a._supersede();
    await el._a.goto('/anything');
  });

});
