# Changelog

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
