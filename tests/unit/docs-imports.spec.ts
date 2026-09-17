import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Keeps the README and the example honest.
 *
 * Documentation drifts silently: a rename passes every test, ships, and the first
 * thing a new user copies no longer compiles. This extracts every
 * `import { … } from 'fath57-activity-log…'` in README.md and examples/, writes them
 * into one throwaway file, and type-checks it against the built declarations.
 *
 * It delegates to `tsc` rather than inspecting `require()` output on purpose: a
 * runtime check cannot see type-only exports, and a heuristic for telling types
 * from values ("starts with a capital") excuses precisely the typo it is meant to
 * catch. An earlier version of this test did exactly that and passed on a
 * deliberately broken import.
 *
 * Skipped when dist/ is absent so `npm test` does not require a prior build.
 */
const root = join(__dirname, '../..');
const distReady = existsSync(join(root, 'dist', 'index.d.ts'));

const ENTRYPOINTS: Record<string, string> = {
  'fath57-activity-log': 'dist/index',
  'fath57-activity-log/mikro-orm': 'dist/adapters/mikro-orm/index',
  'fath57-activity-log/postgres': 'dist/adapters/postgres/index',
  'fath57-activity-log/migrations': 'dist/migrations/index',
  'fath57-activity-log/feed': 'dist/feed/index',
  'fath57-activity-log/audit': 'dist/audit/index',
};

interface DocImport {
  label: string;
  specifier: string;
  names: string[];
}

function namedImports(label: string, source: string): DocImport[] {
  const found: DocImport[] = [];
  const re = /import\s*\{([^}]+)\}\s*from\s*['"](fath57-activity-log[^'"]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const names = m[1]
      .split(',')
      .map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    found.push({ label, specifier: m[2], names });
  }
  return found;
}

function collectDocImports(): DocImport[] {
  const out = namedImports('README.md', readFileSync(join(root, 'README.md'), 'utf8'));

  const examples = join(root, 'examples');
  if (existsSync(examples)) {
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') || full.endsWith('.md')) {
          out.push(...namedImports(full.slice(root.length + 1), readFileSync(full, 'utf8')));
        }
      }
    };
    walk(examples);
  }
  return out;
}

describe('README and examples import only things the package exports', () => {
  const imports = collectDocImports();

  it('finds documented imports to check', () => {
    expect(imports.length).toBeGreaterThan(0);
  });

  it('references only known entrypoints', () => {
    const unknown = imports
      .filter((i) => !(i.specifier in ENTRYPOINTS))
      .map((i) => `${i.label}: ${i.specifier}`);
    expect(unknown).toEqual([]);
  });

  it('type-checks every documented import against the built declarations', () => {
    if (!distReady) return;

    const dir = mkdtempSync(join(tmpdir(), 'fath57-docs-'));
    try {
      const lines = imports.map((imp, i) => {
        const target = join(root, ENTRYPOINTS[imp.specifier]).replace(/\\/g, '/');
        const alias = imp.names.map((n) => `${n} as ${n}_${i}`).join(', ');
        return `// ${imp.label}\nimport { ${alias} } from '${target}';`;
      });
      // Reference the aliases so nothing is elided before it can be checked.
      const uses = imports.flatMap((imp, i) =>
        imp.names.map((n) => `export type __${n}_${i} = typeof ${n}_${i} | ${n}_${i};`),
      );

      const file = join(dir, 'docs-imports.ts');
      writeFileSync(file, [...lines, '', ...uses, ''].join('\n'));

      try {
        execFileSync(
          join(root, 'node_modules', '.bin', 'tsc'),
          ['--noEmit', '--skipLibCheck', '--strict', 'false', '--target', 'ES2022',
           '--module', 'CommonJS', '--moduleResolution', 'Node', file],
          { cwd: root, stdio: 'pipe' },
        );
      } catch (err: any) {
        const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
        // Only import-resolution problems matter here; the aliasing trick above
        // can upset unrelated rules, and those are not what this guards.
        const relevant = output
          .split('\n')
          .filter((l: string) => /has no exported member|Cannot find module/.test(l));
        expect(relevant, relevant.join('\n')).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
