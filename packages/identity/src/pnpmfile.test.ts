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

describe('pnpmfile.cjs (keeps Better Auth’s optional peers out of a product’s runtime image)', () => {
  const OPTIONAL = [
    '@lynx-js/react',
    '@prisma/client',
    '@sveltejs/kit',
    '@tanstack/react-start',
    '@tanstack/solid-start',
    'drizzle-kit',
    'drizzle-orm',
    'mongodb',
    'mysql2',
    'next',
    'pg',
    'prisma',
    'react',
    'react-dom',
    'solid-js',
    'svelte',
    'vitest',
    'vue',
  ];
  const betterAuth = (): Manifest => ({
    name: 'better-auth',
    dependencies: { jose: '6.0.0' },
    peerDependencies: Object.fromEntries(OPTIONAL.map((name) => [name, '*'])),
    peerDependenciesMeta: Object.fromEntries(OPTIONAL.map((name) => [name, { optional: true }])),
  });

  it('declares 18 optional peers in this fixture, as better-auth 1.7.7 does', () => {
    expect(OPTIONAL).toHaveLength(18);
  });

  it('drops EVERY optional peer of better-auth except drizzle-orm and pg', () => {
    const out = readPackage(betterAuth());
    expect(Object.keys(out.peerDependencies ?? {}).sort()).toEqual(['drizzle-orm', 'pg']);
    expect(Object.keys(out.peerDependenciesMeta ?? {}).sort()).toEqual(['drizzle-orm', 'pg']);
    expect(out.dependencies).toEqual({ jose: '6.0.0' });
  });

  it('never touches a peer that is not optional, or has no meta: a future required peer is kept', () => {
    const manifest = betterAuth();
    manifest.peerDependencies!['some-new-required'] = '^1';
    manifest.peerDependencies!['declared-without-meta'] = '^1';
    manifest.peerDependenciesMeta!['declared-but-not-optional'] = { optional: false };
    manifest.peerDependencies!['declared-but-not-optional'] = '^1';
    const out = readPackage(manifest);
    expect(Object.keys(out.peerDependencies ?? {}).sort()).toEqual([
      'declared-but-not-optional',
      'declared-without-meta',
      'drizzle-orm',
      'pg',
      'some-new-required',
    ]);
  });

  it('leaves every other package alone, even one with the same peers', () => {
    const other = { ...betterAuth(), name: 'some-plugin' };
    expect(readPackage(structuredClone(other))).toEqual(other);
    const scoped = { ...betterAuth(), name: '@better-auth/core' };
    expect(readPackage(structuredClone(scoped))).toEqual(scoped);
  });

  it('copes with a better-auth that declares no peers at all', () => {
    expect(readPackage({ name: 'better-auth' })).toEqual({ name: 'better-auth' });
    expect(readPackage({ name: 'better-auth', peerDependencies: {} })).toEqual({
      name: 'better-auth',
      peerDependencies: {},
    });
  });

  it('matches the installed better-auth: every peer it declares is optional, and the two kept ones exist', () => {
    // If a Better Auth bump adds a REQUIRED peer, or renames drizzle-orm/pg, this is where it shows.
    const dir = join(root, 'node_modules', 'better-auth', 'package.json');
    const installed = JSON.parse(readFileSync(dir, 'utf8')) as Manifest;
    const peers = Object.keys(installed.peerDependencies ?? {});
    for (const peer of peers) {
      expect(installed.peerDependenciesMeta?.[peer]?.optional, peer).toBe(true);
    }
    expect(peers).toEqual(expect.arrayContaining(['drizzle-orm', 'pg']));
    const out = readPackage(structuredClone(installed));
    expect(Object.keys(out.peerDependencies ?? {}).sort()).toEqual(['drizzle-orm', 'pg']);
  });

  it('is shipped in the package, and the README snippet and the reference consumer’s copy are identical to it', () => {
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
