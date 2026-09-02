import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom for the DOM-touching suites (capability gates, theming). The pure
    // logic suites don't need it but it is cheap enough not to split the config.
    environment: 'jsdom',
  },
});
