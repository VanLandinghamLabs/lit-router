import {playwrightLauncher} from '@web/test-runner-playwright';

export default {
  files: ['development/test/**/*_test.js'],
  nodeResolve: true,
  // The upstream suite uses mocha's TDD interface (suite/test/setup/teardown).
  testFramework: {
    config: {ui: 'tdd', timeout: '10000'},
  },
  browsers: [playwrightLauncher({product: 'chromium'})],
  // Router drives the real document URL, so every test runs inside an iframe
  // (see router_test.ts). Serving from the package root keeps the iframe's
  // relative module paths resolvable.
  rootDir: '.',
};
