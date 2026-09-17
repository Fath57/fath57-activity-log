import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/** Benchmarks only. Kept out of the default suite: they publish numbers, they do not gate. */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/bench/**/*.spec.ts'],
    testTimeout: 300000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
