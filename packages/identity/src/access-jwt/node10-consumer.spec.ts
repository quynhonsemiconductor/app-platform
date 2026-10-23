import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Rova consumes this package with TypeScript's legacy `moduleResolution: node` under CommonJS,
 * which ignores the package `exports` map: it resolves `@quynhonsemiconductor/identity/access-jwt`
 * to the **root** `access-jwt.js` / `access-jwt.d.ts` shims (same reason `nest.*` and `testing.*`
 * exist). This spec proves both halves against a real consumer fixture:
 *  1. `tsc --moduleResolution node` typechecks a consumer that imports the subpath by name;
 *  2. `node -e require(...)` loads the CommonJS shim and gets the runtime exports.
 * Requires `dist/` to exist — CI (and the pre-push gate) builds before testing, like `pnpm test` does.
 */

const require = createRequire(import.meta.url);
const pkgRoot = join(__dirname, '..', '..'); // .../packages/identity
const fixtureRoot = join(__dirname, 'node10-consumer-fixture');

describe('access-jwt node10-consumer (rova-style resolution)', () => {
  beforeAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    mkdirSync(fixtureRoot, { recursive: true });
    // A real install nests the package at node_modules/@quynhonsemiconductor/identity — node10
    // resolves the subpath to <that dir>/access-jwt.(js|d.ts), the root shims.
    mkdirSync(join(fixtureRoot, 'node_modules', '@quynhonsemiconductor'), { recursive: true });
    symlinkSync(pkgRoot, join(fixtureRoot, 'node_modules', '@quynhonsemiconductor', 'identity'), 'dir');
    writeFileSync(
      join(fixtureRoot, 'consumer.ts'),
      [
        "import { createAccessJwtVerifier, AccessJwtError, type AccessJwtConfig } from '@quynhonsemiconductor/identity/access-jwt';",
        '',
        'const config: AccessJwtConfig = { teamDomain: "https://qnsic.cloudflareaccess.com", audience: "aud" };',
        'const verifier = createAccessJwtVerifier(config);',
        'export type Probe = [typeof verifier.verify, typeof AccessJwtError];',
      ].join('\n'),
    );
    writeFileSync(
      join(fixtureRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          // rova-style legacy resolution; TS 6 deprecates it, so the fixture silences the deprecation
          ignoreDeprecations: "6.0",
          strict: true,
          module: 'commonjs',
          moduleResolution: 'node',
          target: 'es2022',
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files: ['consumer.ts'],
      }),
    );
  });
  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('typechecks a consumer under moduleResolution node', () => {
    const typescriptPkg = join(require.resolve('typescript/package.json'), '..', 'bin', 'tsc');
    const result = (() => {
      try {
        execFileSync(process.execPath, [typescriptPkg, '-p', 'tsconfig.json'], { cwd: fixtureRoot, stdio: 'pipe' });
        return 'ok';
      } catch (e) {
        return `${(e as { stderr?: Buffer }).stderr?.toString() ?? ''}${(e as { stdout?: Buffer }).stdout?.toString() ?? ''}`.trim();
      }
    })();
    expect(result).toBe('ok');
  });

  it('loads through the CommonJS shim at runtime', () => {
    const loaded: unknown = execFileSync(
      process.execPath,
      [
        '-e',
        "const m = require('@quynhonsemiconductor/identity/access-jwt'); if (typeof m.createAccessJwtVerifier !== 'function') throw new Error('shim broken');",
      ],
      { cwd: fixtureRoot, stdio: 'pipe' },
    );
    expect(loaded).toBeDefined();
  });
});
