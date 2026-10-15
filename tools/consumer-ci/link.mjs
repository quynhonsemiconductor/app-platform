// Point a product checkout at tarballs built from THIS pull request.
//
//   node tools/consumer-ci/link.mjs --product <dir> --tarballs <dir>
//
// For every `package.json` in the product (skipping node_modules), a dependency on one of our
// packages becomes `file:<absolute tarball>` -- but ONLY when the tarball's version satisfies the
// range that product declares for it. A product on `^7.1.0` cannot meaningfully be tested against
// identity 8.0.0: it has not adopted it, and forcing it in would turn every major into a red
// gate that nobody can fix from here. Such a dependency is skipped, and says so:
//
//     not applicable: identity@8.0.0 outside ^7.1.0
//
// `peerDependencies` are left alone: they are the range a product accepts, and that is exactly
// what must keep being tested.
//
// Outcomes:
//   * something linked                      -> exit 0, `applicable=true`
//   * every dependency was out of range     -> exit 0, `applicable=false` (the product has no
//                                              business being tested against this PR; the
//                                              workflow skips install and tests)
//   * the product depends on NONE of ours   -> exit 1. That is a different problem: a check that
//                                              quietly tests the registry versions would be
//                                              green and prove nothing.
//
// A range `semver` cannot parse (`latest`, a git URL) is linked: there is no range to be outside of.
//
// ALSO AT THE WORKSPACE ROOT, as an override. Rewriting only the manifests that name a package misses every workspace that
// reaches it WITHOUT naming it: a nested workspace such as `apps/web` that depends on platform-http gets observability as a
// PEER, which pnpm (auto-install-peers) resolves from the registry, so a release PR whose version is not published yet fails
// with ERR_PNPM_NO_MATCHING_VERSION there while the root, which names it, installs fine. So every package that was linked
// anywhere is also overridden for the whole workspace: `overrides` in pnpm-workspace.yaml (pnpm 11 reads only that) and
// `pnpm.overrides` in the root package.json (pnpm 10 reads only that). A package that was SKIPPED everywhere (out of range)
// gets no override: forcing it in would defeat the skip above.
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import semver from 'semver';
import { findManifests, rel } from './packages.mjs';

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * Rewrite one manifest object in place.
 * `tarballs` maps package name -> { file, version }.
 * Returns `{ linked: string[], skipped: { name, version, range }[] }`.
 */
export function linkManifest(json, tarballs) {
  const linked = [];
  const skipped = [];
  for (const section of SECTIONS) {
    const deps = json[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      const tarball = tarballs.get(name);
      if (!tarball) continue;
      const range = deps[name];
      if (semver.validRange(range) !== null && !semver.satisfies(tarball.version, range)) {
        skipped.push({ name, version: tarball.version, range });
        continue;
      }
      deps[name] = `file:${tarball.file}`;
      linked.push(name);
    }
  }
  return { linked, skipped };
}

/**
 * Add `overrides` entries to the text of a pnpm-workspace.yaml: into an existing `overrides:` block, or as a new one.
 * Entries already present are left alone (idempotent). `entries` maps package name -> `file:` spec.
 */
export function addWorkspaceOverrides(text, entries) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const lines = Object.entries(entries)
    .filter(([name]) => !new RegExp(`^\\s+["']?${escape(name)}["']?\\s*:`, 'm').test(text))
    .map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`);
  if (lines.length === 0) return text;
  const block = /^overrides:[ \t]*$/m.exec(text);
  if (block) {
    const at = block.index + block[0].length;
    return `${text.slice(0, at)}\n${lines.join('\n')}${text.slice(at)}`;
  }
  const sep = text.endsWith('\n') || text === '' ? '' : '\n';
  return `${text}${sep}overrides:\n${lines.join('\n')}\n`;
}

/** Set `pnpm.overrides` in a parsed root package.json (in place). */
export function addPackageJsonOverrides(json, entries) {
  json.pnpm = json.pnpm ?? {};
  json.pnpm.overrides = { ...(json.pnpm.overrides ?? {}), ...entries };
}

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main() {
  const product = resolve(option('product') ?? '');
  const dir = resolve(option('tarballs') ?? '');
  if (!option('product') || !option('tarballs')) {
    process.stderr.write('usage: link.mjs --product <dir> --tarballs <dir>\n');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const tarballs = new Map(
    manifest.map((m) => [m.name, { file: join(dir, m.file), version: m.version }]),
  );

  let linkedCount = 0;
  let skippedCount = 0;
  const linkedNames = new Set();
  for (const file of findManifests(product)) {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const { linked, skipped } = linkManifest(json, tarballs);
    if (linked.length > 0) {
      writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
      process.stdout.write(`${rel(product, file)}: linked ${linked.join(', ')}\n`);
    }
    for (const { name, version, range } of skipped) {
      process.stdout.write(
        `not applicable: ${shortName(name)}@${version} outside ${range} (${rel(product, file)})\n`,
      );
    }
    linkedCount += linked.length;
    skippedCount += skipped.length;
    for (const name of linked) linkedNames.add(name);
  }

  if (linkedNames.size > 0) {
    const entries = Object.fromEntries(
      [...linkedNames].map((name) => [name, `file:${tarballs.get(name).file}`]),
    );
    const workspaceFile = join(product, 'pnpm-workspace.yaml');
    if (existsSync(workspaceFile)) {
      writeFileSync(
        workspaceFile,
        addWorkspaceOverrides(readFileSync(workspaceFile, 'utf8'), entries),
      );
      process.stdout.write(`pnpm-workspace.yaml: overrides ${[...linkedNames].join(', ')}\n`);
    }
    const rootManifest = join(product, 'package.json');
    if (existsSync(rootManifest)) {
      const json = JSON.parse(readFileSync(rootManifest, 'utf8'));
      addPackageJsonOverrides(json, entries);
      writeFileSync(rootManifest, `${JSON.stringify(json, null, 2)}\n`);
      process.stdout.write(`package.json: pnpm.overrides ${[...linkedNames].join(', ')}\n`);
    }
  }

  if (linkedCount === 0 && skippedCount === 0) {
    process.stderr.write(
      `No dependency on ${[...tarballs.keys()].join(', ')} found in ${product}.\n`,
    );
    process.exit(1);
  }

  const applicable = linkedCount > 0;
  if (!applicable) {
    process.stdout.write(
      'Nothing in this pull request applies to this product: every package it uses is outside the range the product declares.\n',
    );
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `applicable=${applicable}\n`);
}

/** `@quynhonsemiconductor/identity` -> `identity`, as it reads in the log. */
function shortName(name) {
  return name.replace(/^@[^/]+\//, '');
}

// Run only as a script, not when the test file imports `linkManifest`. Compare REAL paths: a
// symlinked directory (macOS /tmp -> /private/tmp) made the plain `file://` comparison false,
// so `main` silently never ran and the command exited 0 having linked nothing.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  main();
