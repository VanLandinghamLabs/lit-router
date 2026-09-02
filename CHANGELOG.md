# Changelog

## Unreleased

### Fixed

- **A route's tail is identified from its pattern, not guessed from the
  match's groups object**
  ([#4](https://github.com/VanLandinghamLabs/lit-router/issues/4)).
  `URLPattern` keys every unnamed group by position, so an unnamed regex group
  (`/post/(\d+)`) and a wildcard that is not last (`/foo/*/bar`) looked exactly
  like a trailing `/*`. Both were handed to child controllers as a tail and
  stripped from `link()`, which returned `/post/` for `/post/123` and a
  truncated `/foo/zz/b` for `/foo/zz/bar`. Only a pattern that ends in a
  wildcard now has a tail.
- **A nested `fallback` passes its tail on to its own children**
  ([#5](https://github.com/VanLandinghamLabs/lit-router/issues/5)). The
  fallback matched with a literal `/*` pattern, but a nested controller is
  handed its tail without a leading slash, which `/*` rejects: the fallback
  rendered with empty params and grandchildren were never routed or
  superseded. It now behaves like `/*` at the root and `*` when nested, with
  `params[0]` the whole tail in both cases.
- **Children are superseded when the parent moves to a route with no tail**
  ([#7](https://github.com/VanLandinghamLabs/lit-router/issues/7)). The
  propagation loop ran only when the new route had a tail, so a child
  mid-`enter()` for the previous tail was never stood down and could commit
  over a URL that had already moved on.

### Changed

- `URLPatternLike` requires `pathname`: the pattern string, which a real
  `URLPattern` exposes and which is how the tail is now identified. An object
  offering only `test()`/`exec()` no longer type-checks as a route pattern.
- A trailing `*` counts as a tail only when it is a wildcard: bare `*`, `{*}`,
  `(.*)` (which `URLPattern` normalises to `*`), optionally followed by `?`.
  A `*` that is the modifier on a group or a named param (`(\d+)*`, `{/}*`,
  `:rest*`), or an escaped `\*`, is not. Previously any pattern whose match
  produced a positional group was treated as having a tail.

### Documentation

- A nested index route is spelled `{path: ''}`
  ([#6](https://github.com/VanLandinghamLabs/lit-router/issues/6)). The tail
  handed to a child has no leading slash, so the index of a nested route space
  is the empty string; `{path: '/'}` matches nothing there. This already
  worked and is now documented and pinned by a test.

## 0.3.0

### Fixed

- **The wildcard tail handed to child controllers was selected incorrectly.**
  `getTailGroup()` picked the winning positional group with an unanchored
  `/\d+/` test and a string comparison, which went wrong two ways:

  - A *named* group whose name merely contains a digit was accepted as a
    candidate, and since a letter sorts above a digit it then won. A route like
    `/user/:id2/*` on `/user/5/docs/a` handed the child `'5'` instead of
    `'docs/a'`, and the child rendered nothing.
  - `'9' > '10'` as strings, so a pattern with eleven or more wildcards took
    the second-to-last group as its tail.

  **This changes behaviour.** If a route combines a wildcard with a param name
  containing a digit, the child controller now receives a different path — the
  correct one. Anything relying on the old selection was relying on the child
  being given the wrong segment.

- **An unset `formData` or `downloadRequest` on a `NavigateEvent` no longer
  makes the router decline every navigation.** Both are spec'd as
  nullable-but-present, so the previous strict `!== null` was correct against a
  real Navigation API but wrong under a polyfill that leaves either unset.

### Changed

- Merged the two child-routing paths (`goto()`'s propagation loop and the
  late-mount path in `_onRoutesConnected`) into a single `_routeChild()`, so
  they cannot diverge. A child skipped on the late-mount path is now also
  superseded.
- `hasRouteFor()` short-circuits when a fallback is configured instead of
  running every pattern, and the fallback no longer rebuilds a `URLPattern` on
  every navigation.
- `location.origin` is read per navigation rather than at module scope, so
  importing the package no longer touches `location` — importing it where there
  is no DOM previously threw, contradicting `sideEffects: false`.

### Known issues

`getTailGroup()` still cannot distinguish the trailing wildcard from an unnamed
regex group or a wildcard that is not last. See
[#4](https://github.com/VanLandinghamLabs/lit-router/issues/4),
[#5](https://github.com/VanLandinghamLabs/lit-router/issues/5),
[#6](https://github.com/VanLandinghamLabs/lit-router/issues/6), and
[#7](https://github.com/VanLandinghamLabs/lit-router/issues/7).

## 0.2.0

Initial release of the fork. A router for Lit built on the Navigation API,
forked from `@lit-labs/router`.
