import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * §9 / §11.1 — the architectural boundary, enforced.
 *
 * `core/` must depend on neither an ORM, nor a database driver, nor NestJS, nor
 * any outer ring. The ports of §11.1 are worthless as a seam if nothing defends
 * the direction of the arrows: a single convenient import re-couples the core to
 * MikroORM, silently, and the next adapter becomes impossible again.
 *
 * This is a lint, not a runtime test, but it belongs with the tests because it is
 * the only thing standing between the layout and its own erosion.
 */
const SRC = join(__dirname, '../../src');
const CORE = join(SRC, 'core');

const FORBIDDEN_PACKAGES = [
  '@mikro-orm/',
  '@nestjs/',
  'typeorm',
  'sequelize',
  '@prisma/',
  'drizzle-orm',
  'pg',
  'knex',
];

const OUTER_RINGS = ['feed/', 'audit/', 'adapters/', 'migrations/', 'common/'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:from|require\()\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) specifiers.push(m[1]);
  return specifiers;
}

describe('core/ has no ORM, driver, framework or outer-ring dependency', () => {
  const files = walk(CORE);

  it('finds the core ring', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => relative(SRC, f)))('%s imports nothing forbidden', (rel) => {
    const source = readFileSync(join(SRC, rel), 'utf8');
    const offenders: string[] = [];

    for (const spec of importsOf(source)) {
      if (FORBIDDEN_PACKAGES.some((p) => spec === p.replace(/\/$/, '') || spec.startsWith(p))) {
        offenders.push(`${spec} (forbidden package)`);
      }
      if (spec.startsWith('.') && OUTER_RINGS.some((ring) => spec.includes(`../${ring}`))) {
        offenders.push(`${spec} (outer ring)`);
      }
    }

    expect(offenders, `${rel} must stay ORM-free, found: ${offenders.join(', ')}`).toEqual([]);
  });

  it('allows the node: builtins the core does use', () => {
    const all = files.flatMap((f) => importsOf(readFileSync(f, 'utf8')));
    const external = all.filter((s) => !s.startsWith('.'));
    expect(external.every((s) => s.startsWith('node:'))).toBe(true);
  });
});
