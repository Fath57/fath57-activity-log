import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // Benchmarks publish numbers; they are not part of the pass/fail suite.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/bench/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration specs share one database and each rebuilds the schema in
    // beforeAll. Running files in parallel would let them clobber each other.
    fileParallelism: false,
  },
  plugins: [
    swc.vite({
      jsc: {
        parser: {
          syntax: 'typescript',
          decorators: true,
          dynamicImport: true,
        },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
    }),
  ],
});
