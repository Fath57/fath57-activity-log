import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * §2.1 — the published surface.
 *
 * Every subpath in `exports` must resolve to files the build actually produces.
 * A broken entry is invisible in this repository (relative imports still work)
 * and only fails for consumers, after publication.
 */
const root = join(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('package exports map', () => {
  const entries = Object.entries(pkg.exports as Record<string, any>);

  it('declares the adapter subpaths the portability seam promises', () => {
    const paths = entries.map(([k]) => k);
    expect(paths).toContain('./mikro-orm');
    expect(paths).toContain('./postgres');
  });

  it.each(entries)('%s points at built artefacts', (_subpath, target: any) => {
    // Skipped rather than failed when dist/ is absent: `npm test` must not
    // require a prior build, but a stale or wrong path must still be caught.
    if (!existsSync(join(root, 'dist'))) return;
    for (const file of [target.types, target.default]) {
      expect(existsSync(join(root, file)), `${file} missing from dist/`).toBe(true);
    }
  });

  it('marks every ORM peer optional, so the core installs alone', () => {
    const meta = pkg.peerDependenciesMeta ?? {};
    for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
      if (peer.startsWith('@mikro-orm/')) {
        expect(meta[peer]?.optional, `${peer} must be an optional peer`).toBe(true);
      }
    }
  });

  it('keeps @nestjs and reflect-metadata as required peers', () => {
    const meta = pkg.peerDependenciesMeta ?? {};
    for (const peer of ['@nestjs/common', '@nestjs/core', 'reflect-metadata']) {
      expect(pkg.peerDependencies[peer]).toBeDefined();
      expect(meta[peer]?.optional).not.toBe(true);
    }
  });

  it('ships no runtime dependencies', () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
