import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessJwtError, createAccessJwtVerifier, type AccessJwtConfig } from './access-jwt';

/**
 * Tests run against a **local JWKS server** on an ephemeral loopback port: real fetch path,
 * real caching, real rotation (an unknown `kid` triggers a refresh), no network.
 */

interface JwksServer {
  origin: string;
  fetchCount: () => number;
  setKeys: (jwks: { kid: string }[]) => Promise<void>;
  close: () => Promise<void>;
}

async function startJwksServer(): Promise<JwksServer> {
  let keys: unknown[] = [];
  let fetches = 0;
  const server: Server = createServer((_req, res) => {
    fetches += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no ephemeral port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    fetchCount: () => fetches,
    setKeys: async (next) => {
      keys = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function rsaKey(
  kid: string,
): Promise<{ privateJwk: Record<string, unknown>; publicJwk: Record<string, unknown> }> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  return {
    privateJwk: { ...(await exportJWK(privateKey)), kid, alg: 'RS256' },
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256' },
  };
}

async function signToken(
  key: Record<string, unknown> | Uint8Array,
  claims: Record<string, unknown>,
  kid: string,
  alg = 'RS256',
): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg, kid }).sign(key as never);
}

const BASE_CLAIMS = {
  iss: '',
  aud: 'test-aud-tag.access',
  sub: 'access-sub-1',
  email: 'person@example.com',
  oid: '00000000-0000-0000-0000-000000000001',
  exp: 0,
  iat: 0,
  nbf: 0,
};

function configFor(origin: string, overrides: Partial<AccessJwtConfig> = {}): AccessJwtConfig {
  return {
    teamDomain: origin,
    audience: 'test-aud-tag.access',
    clockToleranceSeconds: 5,
    jwksCooldownSeconds: 0,
    ...overrides,
  };
}

describe('createAccessJwtVerifier', () => {
  let jwks: JwksServer;
  let keyA: Awaited<ReturnType<typeof rsaKey>>;
  let keyB: Awaited<ReturnType<typeof rsaKey>>;

  beforeAll(async () => {
    jwks = await startJwksServer();
    keyA = await rsaKey('kid-a');
    keyB = await rsaKey('kid-b');
    await jwks.setKeys([keyA.publicJwk as never]);
  });
  afterAll(async () => {
    await jwks.close();
  });

  function token(
    claims: Record<string, unknown>,
    key = keyA,
    kid = 'kid-a',
    alg = 'RS256',
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const fresh = { exp: now + 600, iat: now, nbf: now };
    return signToken(
      key.privateJwk,
      { ...BASE_CLAIMS, ...fresh, iss: jwks.origin, ...claims },
      kid,
      alg,
    );
  }

  it('verifies a valid token and maps oid, email, sub', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    const principal = await verifier.verify(await token({}));
    expect(principal).toEqual({
      oid: '00000000-0000-0000-0000-000000000001',
      email: 'person@example.com',
      sub: 'access-sub-1',
    });
  });

  it('rejects a token signed by an unknown key', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    await expect(verifier.verify(await token({}, keyB, 'kid-b'))).rejects.toMatchObject({
      name: 'AccessJwtError',
      code: 'invalid_signature',
    } satisfies Partial<AccessJwtError>);
  });

  it('rejects a tampered payload', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    const raw = await token({});
    const [head, , sig] = raw.split('.');
    // Flip the subject inside the payload, keep the signature: verification must fail.
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...BASE_CLAIMS, iss: jwks.origin, sub: 'attacker' }),
    ).toString('base64url');
    await expect(verifier.verify(`${head}.${forgedPayload}.${sig}`)).rejects.toMatchObject({
      code: 'invalid_signature',
    });
  });

  it('rejects a symmetric-algorithm token (alg confusion)', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    // An HS256 token signed with an attacker-chosen secret: the RS256 pin must reject
    // it before any key material from the JWKS is consulted.
    const secret = new TextEncoder().encode('attacker-hs256-secret');
    const forged = await signToken(secret, { ...BASE_CLAIMS, iss: jwks.origin }, 'kid-a', 'HS256');
    await expect(verifier.verify(forged)).rejects.toMatchObject({ code: 'wrong_algorithm' });
  });

  it('rejects an expired token', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifier.verify(await token({ exp: now - 300, iat: now - 600, nbf: now - 600 })),
    ).rejects.toMatchObject({
      code: 'expired',
    });
  });

  it('rejects a not-yet-valid token', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifier.verify(await token({ exp: now + 600, nbf: now + 300 })),
    ).rejects.toMatchObject({
      code: 'not_yet_valid',
    });
  });

  it('rejects a token from another issuer', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    await expect(
      verifier.verify(await token({ iss: 'https://evil.example.com' })),
    ).rejects.toMatchObject({
      code: 'bad_issuer',
    });
  });

  it('rejects a token minted for another Access app (audience)', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    await expect(verifier.verify(await token({ aud: 'other-app.access' }))).rejects.toMatchObject({
      code: 'bad_audience',
    });
  });

  it('accepts a configured audience list', async () => {
    const verifier = createAccessJwtVerifier(
      configFor(jwks.origin, { audience: ['a', 'test-aud-tag.access'] }),
    );
    await expect(verifier.verify(await token({}))).resolves.toMatchObject({ sub: 'access-sub-1' });
  });

  it('reads the oid from a configured claim path', async () => {
    const verifier = createAccessJwtVerifier(
      configFor(jwks.origin, { oidClaimPath: 'custom.oid' }),
    );
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      ...BASE_CLAIMS,
      iss: jwks.origin,
      exp: now + 600,
      iat: now,
      nbf: now,
      oid: undefined,
      custom: { oid: 'custom-oid-42' },
    };
    await expect(
      verifier.verify(await signToken(keyA.privateJwk, claims, 'kid-a')),
    ).resolves.toMatchObject({
      oid: 'custom-oid-42',
    });
  });

  it('refuses to map identity when the oid claim is absent and the fallback is off (default)', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      ...BASE_CLAIMS,
      iss: jwks.origin,
      exp: now + 600,
      iat: now,
      nbf: now,
      oid: undefined,
    };
    await expect(
      verifier.verify(await signToken(keyA.privateJwk, claims, 'kid-a')),
    ).rejects.toMatchObject({
      code: 'missing_principal',
    });
  });

  it('falls back to email only when explicitly enabled', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin, { allowEmailFallback: true }));
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      ...BASE_CLAIMS,
      iss: jwks.origin,
      exp: now + 600,
      iat: now,
      nbf: now,
      oid: undefined,
    };
    await expect(
      verifier.verify(await signToken(keyA.privateJwk, claims, 'kid-a')),
    ).resolves.toEqual({
      oid: null,
      email: 'person@example.com',
      sub: 'access-sub-1',
    });
  });

  it('caches the JWKS: repeated verifications fetch once', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    const t = await token({});
    const before = jwks.fetchCount();
    await verifier.verify(t);
    await verifier.verify(t);
    expect(jwks.fetchCount()).toBe(before + 1);
  });

  it('is rotation-safe: an unknown kid triggers a JWKS refresh', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    await verifier.verify(await token({})); // warm the cache with kid-a
    await jwks.setKeys([keyB.publicJwk as never]); // rotate: the server now serves only kid-b
    await expect(verifier.verify(await token({}, keyB, 'kid-b'))).resolves.toMatchObject({
      sub: 'access-sub-1',
    });
  });

  it('a JWKS carrying the same kid twice is a JWKS problem (jwks_unavailable), not a bad token', async () => {
    const dupe = await rsaKey('kid-a'); // same kid as keyA, served twice
    await jwks.setKeys([keyA.publicJwk as never, dupe.publicJwk as never]);
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    await expect(verifier.verify(await token({}))).rejects.toMatchObject({
      code: 'jwks_unavailable',
    });
    await jwks.setKeys([keyA.publicJwk as never]); // put the fixture back
  });

  it('rejects a malformed token', async () => {
    const verifier = createAccessJwtVerifier(configFor(jwks.origin));
    await expect(verifier.verify('not-a-jwt')).rejects.toMatchObject({ code: 'malformed' });
  });

  it('rejects a config with a non-origin teamDomain', () => {
    expect(() => createAccessJwtVerifier(configFor('example-team.cloudflareaccess.com'))).toThrow(
      AccessJwtError,
    );
    expect(() =>
      createAccessJwtVerifier(configFor('ftp://example-team.cloudflareaccess.com')),
    ).toThrow(AccessJwtError);
  });

  it('rejects a config without an audience', () => {
    expect(() => createAccessJwtVerifier(configFor(jwks.origin, { audience: '' }))).toThrow(
      AccessJwtError,
    );
  });
});

describe('resilience and default configuration', () => {
  let keyA: Awaited<ReturnType<typeof rsaKey>>;
  let jwks: JwksServer;
  beforeAll(async () => {
    keyA = await rsaKey('kid-a');
    jwks = await startJwksServer();
    await jwks.setKeys([keyA.publicJwk as never]);
  });
  afterAll(async () => {
    await jwks.close();
  });

  it('cools down JWKS refetches: tokens inside the cooldown fetch once', async () => {
    const jwksSrv = await startJwksServer();
    // 0.2 s here = 200 ms to jose. If the seconds→milliseconds conversion were dropped, the
    // cooldown would be 0.2 ms and the tokens spaced 10 ms apart would each trigger a fetch.
    const verifier = createAccessJwtVerifier({
      teamDomain: jwksSrv.origin,
      audience: 'test-aud-tag.access',
      jwksCooldownSeconds: 0.2,
    });
    const key = await rsaKey('kid-unknown');
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 3; i += 1) {
      const t = await signToken(
        key.privateJwk,
        { ...BASE_CLAIMS, iss: jwksSrv.origin, exp: now + 600, iat: now, nbf: now },
        'kid-unknown',
      );
      await expect(verifier.verify(t)).rejects.toMatchObject({ code: 'invalid_signature' });
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(jwksSrv.fetchCount()).toBe(1);
    await jwksSrv.close();
  });

  it('reports a JWKS outage as jwks_unavailable, not as a bad token', async () => {
    const jwksSrv = await startJwksServer();
    const verifier = createAccessJwtVerifier(configFor(jwksSrv.origin));
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const now = Math.floor(Date.now() / 1000);
    const t = await signToken(
      (await exportJWK(privateKey)) as Record<string, unknown>,
      { ...BASE_CLAIMS, iss: jwksSrv.origin, exp: now + 600, iat: now, nbf: now },
      'kid-unserved',
    );
    await jwksSrv.close(); // outage: the JWKS endpoint is gone before the first verify
    await expect(verifier.verify(t)).rejects.toMatchObject({ code: 'jwks_unavailable' });
  });

  it('fetches at most once per default cooldown when a burst of unknown-kid tokens arrives', async () => {
    // DEFAULT config: the 30 s cooldown must throttle the whole burst to one fetch.
    const jwksSrv = await startJwksServer();
    const verifier = createAccessJwtVerifier({
      teamDomain: jwksSrv.origin,
      audience: 'test-aud-tag.access',
    });
    const key = await rsaKey('kid-unknown');
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i += 1) {
      const t = await signToken(
        key.privateJwk,
        { ...BASE_CLAIMS, iss: jwksSrv.origin, exp: now + 600, iat: now, nbf: now },
        'kid-unknown',
      );
      await expect(verifier.verify(t)).rejects.toMatchObject({ code: 'invalid_signature' });
    }
    expect(jwksSrv.fetchCount()).toBe(1);
    await jwksSrv.close();
  });

  it('reports a JWKS that answers 500 as jwks_unavailable', async () => {
    const server: Server = createServer((_q, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const verifier = createAccessJwtVerifier(configFor(`http://127.0.0.1:${port}`));
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const now = Math.floor(Date.now() / 1000);
    const t = await signToken(
      (await exportJWK(privateKey)) as Record<string, unknown>,
      { ...BASE_CLAIMS, iss: `http://127.0.0.1:${port}`, exp: now + 600, iat: now, nbf: now },
      'kid-a',
    );
    await expect(verifier.verify(t)).rejects.toMatchObject({ code: 'jwks_unavailable' });
    server.close();
  });

  it('reports a hung JWKS as jwks_unavailable (fetch timeout)', async () => {
    const server: Server = createServer(() => {
      // never responds
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const verifier = createAccessJwtVerifier(
      configFor(`http://127.0.0.1:${port}`, { jwksTimeoutSeconds: 0.2 }),
    );
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const now = Math.floor(Date.now() / 1000);
    const t = await signToken(
      (await exportJWK(privateKey)) as Record<string, unknown>,
      { ...BASE_CLAIMS, iss: `http://127.0.0.1:${port}`, exp: now + 600, iat: now, nbf: now },
      'kid-a',
    );
    await expect(verifier.verify(t)).rejects.toMatchObject({ code: 'jwks_unavailable' });
    server.close();
  });

  it.each(['ES256', 'PS256'] as const)(
    'rejects a %s token (only RS256 is allowed)',
    async (alg) => {
      const verifier = createAccessJwtVerifier(configFor(jwks.origin));
      const { privateKey } = await generateKeyPair(alg, { extractable: true });
      const privJwk = await exportJWK(privateKey);
      const now = Math.floor(Date.now() / 1000);
      const t = await signToken(
        privJwk as Record<string, unknown>,
        {
          ...BASE_CLAIMS,
          iss: jwks.origin,
          aud: 'test-aud-tag.access',
          sub: 's',
          exp: now + 600,
          iat: now,
          nbf: now,
        },
        'kid-a',
        alg,
      );
      await expect(verifier.verify(t)).rejects.toMatchObject({ code: 'wrong_algorithm' });
    },
  );
});
