/**
 * pnpm install hooks for a product that depends on `@quynhonsemiconductor/identity`.
 *
 * Copy this file to `.pnpmfile.cjs` at the root of the product (next to `pnpm-workspace.yaml`) and copy it
 * into every Docker stage that runs `pnpm install` (a frozen install checks its checksum against the
 * lockfile). See "Keeping Better Auth's dev-only peers out of the runtime image" in identity's README.
 *
 * WHY. `better-auth` lists `drizzle-kit`, `react`, `react-dom` and `vitest` as OPTIONAL peer dependencies:
 * they serve its CLI, its React client and its test helpers, and nothing at runtime. pnpm resolves an optional
 * peer against whatever the importing project has installed, so a product with `vitest` or `drizzle-kit` in
 * its devDependencies gets each one written into better-auth's lockfile snapshot as an optionalDependency,
 * and `pnpm install --prod` follows optional dependencies. The runtime image then holds vitest, drizzle-kit
 * and their trees (esbuild with its Go binary, vite, rolldown ...). That is how a Trivy CRITICAL on esbuild's
 * bundled Go stdlib reached opshub's image.
 *
 * Dropping those four peers from better-auth's manifest stops pnpm resolving them. Nothing is lost: identity
 * does not use `auth generate`, `better-auth/react` or `better-auth/test`. `drizzle-orm` and `pg`, the peers
 * that ARE used, are left alone.
 *
 * Changing this file changes the lockfile: re-run `pnpm install` after adding, editing or removing it.
 */
const DEV_ONLY_PEERS_OF_BETTER_AUTH = ['drizzle-kit', 'react', 'react-dom', 'vitest'];

function readPackage(pkg) {
  if (pkg.name === 'better-auth') {
    for (const peer of DEV_ONLY_PEERS_OF_BETTER_AUTH) {
      delete pkg.peerDependencies?.[peer];
      delete pkg.peerDependenciesMeta?.[peer];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
