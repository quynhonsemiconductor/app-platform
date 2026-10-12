import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const shipped = readFileSync(join(root, 'pnpmfile.cjs'), 'utf8');
const require = createRequire(import.meta.url);

type Manifest = {
  name: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional: boolean }>;
  dependencies?: Record<string, string>;
};
const readPackage = (
  require(join(root, 'pnpmfile.cjs')) as {
    hooks: { readPackage: (pkg: Manifest) => Manifest };
  }
).hooks.readPackage;

describe('pnpmfile.cjs (keeps Better Auth’s dev-only optional peers out of a product’s runtime image)', () => {
  const betterAuth = (): Manifest => ({
    name: 'better-auth',
    dependencies: { jose: '6.0.0' },
    peerDependencies: {
      'drizzle-kit': '>=0.31.4',
      react: '^19',
      'react-dom': '^19',
      vitest: '^4',
      'drizzle-orm': '^0.45.2',
      pg: '^8',
      next: '^16',
    },
    peerDependenciesMeta: {
      'drizzle-kit': { optional: true },
      react: { optional: true },
      'react-dom': { optional: true },
      vitest: { optional: true },
      'drizzle-orm': { optional: true },
      pg: { optional: true },
      next: { optional: true },
    },
  });

  it('drops drizzle-kit, react, react-dom and vitest from better-auth, and nothing else', () => {
    const out = readPackage(betterAuth());
    expect(Object.keys(out.peerDependencies ?? {}).sort()).toEqual(['drizzle-orm', 'next', 'pg']);
    expect(Object.keys(out.peerDependenciesMeta ?? {}).sort()).toEqual([
      'drizzle-orm',
      'next',
      'pg',
    ]);
    expect(out.dependencies).toEqual({ jose: '6.0.0' });
  });

  it('leaves every other package alone, even one with the same peers', () => {
    const other = { ...betterAuth(), name: 'some-plugin' };
    expect(readPackage(structuredClone(other))).toEqual(other);
  });

  it('copes with a better-auth that declares none of them', () => {
    expect(readPackage({ name: 'better-auth' })).toEqual({ name: 'better-auth' });
  });

  it('is shipped in the package, byte-identical to the README snippet and to the reference consumer’s copy', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('pnpmfile.cjs');

    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const snippet = readme.match(/Add this `\.pnpmfile\.cjs`[\s\S]*?```js\n([\s\S]*?)```/)?.[1];
    expect(snippet).toBeDefined();
    // The README shows the code; the shipped file also carries a header comment explaining it.
    expect(shipped.endsWith(snippet!)).toBe(true);

    expect(
      readFileSync(join(root, '..', '..', 'reference-consumer', '.pnpmfile.cjs'), 'utf8'),
    ).toBe(shipped);
  });
});
