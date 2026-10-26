#!/usr/bin/env bash
# The production dependency tree of this consumer holds no dev tooling.
#
# A product's runtime image runs `pnpm install --prod`. better-auth declares 18 OPTIONAL peers (vitest,
# drizzle-kit, react, next, prisma ...), and pnpm resolves an optional peer against whatever the
# importing project has installed; `--prod` follows the resulting optionalDependencies. Without the
# "better-auth>peer": "-" overrides in pnpm-workspace.yaml (all 16 optional peers except drizzle-orm
# and pg) the runtime tree gains them and their trees (vite, rolldown, esbuild with its Go binary ...).
# See "Keeping Better Auth's optional peers out of the runtime image" in identity's README.
#
# WHICH pnpm MATTERS. pnpm 11 honours the override; pnpm 10 (opshub's Dockerfile pins 10.33.2) keeps it
# out of the production tree too (checked 2026-10-26: re-resolving with the override is clean, without it
# vitest, vite and esbuild land in the tree), even though identity's README long said otherwise. This one
# runs BOTH, and then proves it can fail:
#
#   1. the lockfile (version-independent): better-auth's entries resolve no optional peer beyond the kept
#      two (peerDependencies declarations in the manifest copy stay: the override stops the RESOLUTION,
#      not the record);
#   2. for pnpm 10.33.2 and for the repository's pnpm (11): a frozen `--prod` install into a scratch copy, then
#      EVERY devDependency of package.json must be absent from `pnpm ls --prod --depth Infinity`;
#   3. a negative control: pnpm 10.33.2 re-resolving with the override STRIPPED and no lockfile must show the
#      leak, or the check above has stopped being able to detect it (and the script fails saying so).
#
# Installs only into scratch directories; the working tree and its node_modules stay as they are.
# NPM_CONFIG_USERCONFIG must point at a token with read:packages. `PNPM_OLD` / `PNPM_NEW` override the runners.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Both pnpm versions are named explicitly (`npx -y pnpm@x`), never taken from PATH: `pnpm` is a corepack shim,
# and in a scratch directory outside the repository it resolves to corepack's default, not to the repository's
# `packageManager`, so a plain `pnpm` here would silently be the same version twice.
pnpm_old="${PNPM_OLD:-npx -y pnpm@10.33.2}"
repo_pm="$(node -p "require('$here/../package.json').packageManager" 2>/dev/null || true)"
pnpm_new="${PNPM_NEW:-npx -y pnpm@${repo_pm#pnpm@}}"
# Peers the override KEEPS (identity uses them); everything else optional must be gone from the lockfile.
kept='drizzle-orm pg'

scratches=()
cleanup() { for d in "${scratches[@]:-}"; do if [ -n "$d" ]; then rm -rf "$d"; fi; done; }
trap cleanup EXIT

fail=0
say_fail() { echo "::error::$*"; fail=1; }

# ── 1. the lockfile ────────────────────────────────────────────────────────────────────────────────────
echo "== lockfile: better-auth carries no optional peer the override drops"
rc=0
node - "$here/pnpm-lock.yaml" $kept <<'NODE' || rc=$?
const fs = require('node:fs');
const [file, ...kept] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').split('\n');
let section = '';
let entry = '';
let block = '';
const found = [];
const entries = [];
for (const line of lines) {
  if (/^\S/.test(line)) { section = line.replace(/:.*$/, ''); entry = ''; block = ''; continue; }
  const e = /^  (\S.*?):\s*(\{\})?$/.exec(line);
  if (e) { entry = e[1].replace(/^'|'$/g, ''); block = ''; if (/^better-auth@/.test(entry)) entries.push(`${section}:${entry}`); continue; }
  if (!/^better-auth@/.test(entry)) continue;
  const b = /^    (\w+):\s*$/.exec(line);
  if (b) { block = b[1]; continue; }
  const k = /^      ([^ ][^:]*):/.exec(line);
  if (!k) continue;
  const name = k[1].replace(/'/g, '');
  // peers (packages), and what pnpm resolved them to (snapshots): either carries a peer the hook drops
  if (['optionalDependencies'].includes(block) && !kept.includes(name)) {
    found.push(`${section}:${entry} ${block}.${name}`);
  }
}
if (entries.length === 0) { console.error('::error::no better-auth entry in the lockfile: the assertion would test nothing'); process.exit(2); }
if (found.length) { console.error(`::error::better-auth carries optional peers in the lockfile:\n  ${found.join('\n  ')}`); process.exit(1); }
console.log(`ok (${entries.length} better-auth entries)`);
NODE
if [ "$rc" != 0 ]; then say_fail "the lockfile still records better-auth's optional peers (are the better-auth> overrides missing, or did the lockfile resolve without them?)"; fi

# ── 2. the production tree, on both pnpm versions ───────────────────────────────────────────────────────
# Prints the devDependencies present in the production tree of the install in $PWD (except @types/*).
leaked_dev_tools() {
  local pnpm_cmd="$1"
  $pnpm_cmd ls --prod --depth Infinity --json 2>/dev/null | node -e '
    const dev = Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).devDependencies ?? {});
    const input = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const present = new Set();
    const walk = (deps) => { for (const [name, d] of Object.entries(deps ?? {})) { present.add(name); walk(d.dependencies); walk(d.optionalDependencies); } };
    for (const project of input) { walk(project.dependencies); walk(project.optionalDependencies); }
    // @types/* are declaration files only (no code, nothing to scan or exploit); prod packages such as
    // drizzle-orm list them as optional peers, so they legitimately appear. Everything else is dev tooling.
    console.log(dev.filter((n) => present.has(n) && !n.startsWith("@types/")).join(" "));
  ' "$here/package.json"
}

prod_install() { # <pnpm cmd> <scratch> [extra install flags...]
  local pnpm_cmd="$1" dir="$2"; shift 2
  (cd "$dir" && $pnpm_cmd install --prod --ignore-scripts "$@" >/dev/null)
}

new_scratch() { # [--without-override] -> prints the directory
  local dir; dir="$(mktemp -d)"; scratches+=("$dir")
  cp "$here/package.json" "$here/pnpm-workspace.yaml" "$here/.npmrc" "$dir/"
  if [ "${1:-}" = "--without-override" ]; then
    # No lockfile on purpose: this scratch must RE-RESOLVE, and pnpm defaults to --frozen-lockfile
    # under CI, which would fail on the committed lockfile instead of demonstrating the leak.
    sed -i '' '/"better-auth>/d' "$dir/pnpm-workspace.yaml" 2>/dev/null ||
      sed -i '/"better-auth>/d' "$dir/pnpm-workspace.yaml"
    if grep -q '"better-auth>' "$dir/pnpm-workspace.yaml"; then
      say_fail "could not strip the override for the negative control"
    fi
  else
    cp "$here/pnpm-lock.yaml" "$dir/"
  fi
  echo "$dir"
}

old_version="$($pnpm_old --version)"; new_version="$($pnpm_new --version)"
if [ "$old_version" = "$new_version" ]; then
  say_fail "both runners are pnpm $old_version: the check would test one version twice (repository packageManager: '${repo_pm:-none}')"
fi
for pnpm_cmd in "$pnpm_old" "$pnpm_new"; do
  version="$($pnpm_cmd --version)"
  echo "== production tree with pnpm $version"
  dir="$(new_scratch)"
  prod_install "$pnpm_cmd" "$dir" --frozen-lockfile
  leaked="$(cd "$dir" && leaked_dev_tools "$pnpm_cmd")"
  if [ -n "$leaked" ]; then
    say_fail "pnpm $version: devDependencies in the production tree: $leaked"
    (cd "$dir" && $pnpm_cmd why $leaked --prod || true)
  else
    echo "ok: none of the devDependencies is in \`pnpm ls --prod --depth Infinity\`"
  fi
done

# ── 3. the negative control ─────────────────────────────────────────────────────────────────────────────
echo "== negative control: pnpm 10 re-resolving without the override must leak"
dir="$(new_scratch --without-override)"
prod_install "$pnpm_old" "$dir" --no-frozen-lockfile
leaked="$(cd "$dir" && leaked_dev_tools "$pnpm_old")"
if [ -z "$leaked" ]; then
  say_fail "the check cannot detect the leak: pnpm 10 re-resolving WITHOUT the override shows no devDependency in the production tree. Either pnpm or better-auth changed (then the override may no longer be needed: say so in the identity README), or leaked_dev_tools is broken"
else
  echo "ok: without the override pnpm 10 puts $leaked in the production tree, so the check above can fail"
fi

exit "$fail"
