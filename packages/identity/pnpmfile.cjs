/**
 * pnpm install hooks for a product that depends on `@quynhonsemiconductor/identity`.
 *
 * Copy this file to `.pnpmfile.cjs` at the root of the product (next to `pnpm-workspace.yaml`) and copy it
 * into every Docker stage that runs `pnpm install` (a frozen install checks its checksum against the
 * lockfile). See "Keeping Better Auth's optional peers out of the runtime image" in identity's README.
 *
 * WHY. `better-auth` 1.7.7 declares 18 peer dependencies, every one of them OPTIONAL: they serve its CLI (`drizzle-kit`),
 * its React and Svelte/Vue/Solid clients, its test helpers (`vitest`), and the databases and frameworks it can
 * run on (`prisma`, `mongodb`, `mysql2`, `next` ...). Nothing of that is used at runtime here. pnpm resolves an
 * optional peer against whatever the importing project has installed, so a product with `vitest` or `drizzle-kit`
 * in its devDependencies gets each one written into better-auth's lockfile snapshot as an optionalDependency,
 * and `pnpm install --prod` follows optional dependencies. The runtime image then holds vitest, drizzle-kit and
 * their trees (esbuild with its Go binary, vite, rolldown ...). That is how a Trivy CRITICAL on esbuild's
 * bundled Go stdlib reached opshub's image. Any other optional peer a product happens to have (react, next,
 * prisma ...) leaks the same way.
 *
 * So every OPTIONAL peer of better-auth is dropped from its manifest, except the two identity uses:
 * `drizzle-orm` and `pg`. A peer that is not optional is never touched, so a future better-auth that really
 * needs something keeps it. Identity pins better-auth exactly and runs its own conformance kit on every bump.
 *
 * Changing this file changes the lockfile: re-run `pnpm install` after adding, editing or removing it.
 */
const KEPT_PEERS_OF_BETTER_AUTH = ['drizzle-orm', 'pg'];

function readPackage(pkg) {
  if (pkg.name === 'better-auth') {
    for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
      const optional = pkg.peerDependenciesMeta?.[peer]?.optional === true;
      if (optional && !KEPT_PEERS_OF_BETTER_AUTH.includes(peer)) {
        delete pkg.peerDependencies[peer];
        delete pkg.peerDependenciesMeta[peer];
      }
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
