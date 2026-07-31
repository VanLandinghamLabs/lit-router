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


  test('falls back to click + popstate when the Navigation API is absent', async () => {
    // The fallback exists for engines older than Baseline (Jan 2026) and was
    // completely uncovered: Chromium always has window.navigation, so both
    // legacy handlers could be booby-trapped without failing a single test.
    // Deleting the API from the frame realm before the element connects gives
    // a genuine legacy-path run.
    const {win, doc} = await loadFrame();
    delete (win as unknown as {navigation?: unknown}).navigation;
    win.history.pushState({}, '', '/');
    const el = doc.createElement('nav-test') as NavTest;
    doc.body.appendChild(el);
    await el.updateComplete;

    assert.isFalse(el.usingNavigationApi, 'precondition: fallback path selected');

    const a = doc.createElement('a');
    a.href = '/a';
    a.textContent = 'go';
    doc.body.appendChild(a);
    a.click();
    await until('the click handler routed', () => el.entered.includes('/a'));
    await el.updateComplete;

    assert.equal(win.location.pathname, '/a');
    assert.include(el.shadowRoot!.textContent, 'A');
  });

  test('the fallback path also declines a path it cannot render', async () => {
    // _onClick calls preventDefault() before navigating, so swallowing an
    // unrenderable link here stops the browser doing the real navigation too —
    // strictly worse than the Navigation API path's version of the same bug.
    const {win, doc} = await loadFrame();
    delete (win as unknown as {navigation?: unknown}).navigation;
    win.history.pushState({}, '', '/');
    const el = doc.createElement('nav-strict') as HTMLElement & {
      usingNavigationApi: boolean;
      updateComplete: Promise<unknown>;
    };
    doc.body.appendChild(el);
    await el.updateComplete;
    // Without this the test cannot tell which path declined: the Navigation
    // API gate produces the identical observable outcome, so it would pass
    // even if the click-path gate were deleted and the `delete` above no-oped.
    assert.isFalse(el.usingNavigationApi, 'precondition: fallback path selected');

    const a = doc.createElement('a');
    a.href = '/not-a-route';
    a.textContent = 'go';
    doc.body.appendChild(a);
    (win as unknown as {__marker?: string}).__marker = 'alive';
    a.click();
    await until(
      'the browser performed a real navigation',
      () =>
        (container.contentWindow as unknown as {__marker?: string})
          ?.__marker === undefined,
      5000
    );
  });

  test('the fallback path leaves fragment-only links to the browser', async () => {
    // _onNavigate declines these via `hashChange`. Without the same guard the
    // fallback preventDefault()s (so the browser never scrolls to the
    // fragment) and re-runs the current route's enter() for a navigation that
    // did not change route.
    const {win, doc} = await loadFrame();
    delete (win as unknown as {navigation?: unknown}).navigation;
    win.history.pushState({}, '', '/');
    const el = doc.createElement('nav-test') as NavTest;
    doc.body.appendChild(el);
    await el.updateComplete;
    assert.isFalse(el.usingNavigationApi, 'precondition: fallback path selected');

    // Get onto a real route first, then click a fragment link on that page.
    const go = doc.createElement('a');
    go.href = '/a';
    doc.body.appendChild(go);
    go.click();
    await until('on /a', () => el.entered.includes('/a'));

    // `hashchange` is the discriminator. A real fragment navigation fires it;
    // preventDefault() + pushState (what the ungated handler does) does not,
    // and would also leave the URL looking identical — so asserting on
    // location.hash alone would pass either way.
    let hashChanged = false;
    win.addEventListener('hashchange', () => {
      hashChanged = true;
    });

    const frag = doc.createElement('a');
    frag.href = '#section';
    doc.body.appendChild(frag);
    frag.click();

    const enteredBeforeFragment = el.entered.length;
    await until('the browser performed the fragment navigation', () => hashChanged);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(win.location.hash, '#section');
    assert.equal(
      el.entered.length,
      enteredBeforeFragment,
      'a fragment-only move must not re-run the route (popstate fires for it too)'
    );
  });

  test('a bare "#" link is left to the browser as well', async () => {
    // anchor.hash is '' for href="#", but _onNavigate still reports
    // hashChange: true and declines — so a guard keyed on a non-empty hash
    // would disagree with it on the commonest fragment link there is.
    const {win, doc} = await loadFrame();
    delete (win as unknown as {navigation?: unknown}).navigation;
    win.history.pushState({}, '', '/');
    const el = doc.createElement('nav-test') as NavTest;
    doc.body.appendChild(el);
    await el.updateComplete;
    assert.isFalse(el.usingNavigationApi, 'precondition: fallback path selected');

    const go = doc.createElement('a');
    go.href = '/a';
    doc.body.appendChild(go);
    go.click();
    await until('on /a', () => el.entered.includes('/a'));
    const before = el.entered.length;

    const bare = doc.createElement('a');
    bare.href = '#';
    doc.body.appendChild(bare);
    bare.click();
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(el.entered.length, before, 'a bare # link must not re-route');
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
});
