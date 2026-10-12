#!/usr/bin/env bash
# The production dependency tree of this consumer holds no dev tooling.
#
# A product's runtime image runs `pnpm install --prod`. better-auth lists vitest, drizzle-kit, react and
# react-dom as OPTIONAL peers, and pnpm records the ones this project has (vitest is a devDependency here)
# as optionalDependencies of better-auth, which `--prod` follows: without `.pnpmfile.cjs` the runtime tree
# gains vitest, vite, rolldown (and esbuild and drizzle-kit in a product that has drizzle-kit). See
# "Keeping Better Auth's dev-only peers out of the runtime image" in the identity README.
#
# Installs into a scratch copy, so the working tree and its node_modules stay as they are.
# Usage: check-prod-tree.sh        (NPM_CONFIG_USERCONFIG must point at a token with read:packages)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

cp "$here/package.json" "$here/pnpm-lock.yaml" "$here/pnpm-workspace.yaml" "$here/.npmrc" "$scratch/"
# A frozen install checks this file's checksum against the lockfile: leaving it out is an error, which is
# also what a Docker stage that forgot to COPY it gets.
cp "$here/.pnpmfile.cjs" "$scratch/"

cd "$scratch"
pnpm install --frozen-lockfile --prod --ignore-scripts >/dev/null

found=""
for tool in vitest vite rolldown esbuild drizzle-kit; do
  if ls node_modules/.pnpm | grep -qE "^${tool}@"; then found="$found $tool"; fi
done
if [ -n "$found" ]; then
  echo "::error::the production tree holds dev tooling:$found"
  pnpm why vitest esbuild --prod || true
  exit 1
fi
echo "production tree: no vitest, vite, rolldown, esbuild or drizzle-kit ($(ls node_modules/.pnpm | grep -vc '^lock\|^node_modules') store entries)"
