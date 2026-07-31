/**
 * @license
 * Copyright 2026 VanLandingham Labs
 * SPDX-License-Identifier: BSD-3-Clause
 */

/**
 * Local stand-in for `@lit-labs/testing`'s helper of the same name, which is a
 * monorepo-internal package. Strips the marker comments lit renders around
 * binding sites so tests can assert on plain text.
 */
export const stripExpressionComments = (html: string): string =>
  html.replace(/<!--\?lit\$[0-9]+\$-->|<!--\??-->/g, '');
