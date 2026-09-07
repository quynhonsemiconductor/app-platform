/**
 * Port conformance suites — the behaviour a product's real adapters must have.
 *
 * The port interfaces pin method NAMES and TYPES; the compiler checks those. What
 * they cannot express is the semantics the shared auth logic depends on, and those
 * are where a Drizzle adapter silently gets it wrong: a `revokeByIdIfActive` that
 * returns `true` unconditionally still typechecks, and turns single-use refresh
 * rotation into a token that can be replayed for ever.
 *
 * So each suite is exported for a consumer to run against its own implementation:
 *
 * ```ts
 * import { describeAuthSessionRepositoryContract } from '@quynhonsemiconductor/identity/testing';
 *
 * describeAuthSessionRepositoryContract({
 *   name: 'AuthSessionDrizzleRepository',
 *   create: async () => new AuthSessionDrizzleRepository(db),
 * });
 * ```
 *
 * `describe`/`it`/`expect` are taken from the caller's vitest globals rather than
 * imported here, so this file adds no test-framework dependency to the package's
 * runtime and works in whichever project runs it.
 */
import type { AuthSession, CreateSessionInput, User } from '../domain-types';
import type { IAuthSessionRepository, IUserRepository } from '../repository-ports';

/** Minimal vitest surface these suites need, declared so the package needs no globals types. */
interface TestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
  };
  beforeEach: (fn: () => void | Promise<void>) => void;
}

function testApi(): TestApi {
  const g = globalThis as unknown as Partial<TestApi>;
  if (!g.describe || !g.it || !g.expect || !g.beforeEach) {
    throw new Error(
      'Port conformance suites need vitest globals. Enable `test.globals: true` in the ' +
        'consuming vitest config, or wrap the suite in your own describe with globals on.',
    );
  }
  return g as TestApi;
}

/**
 * User ids the session suite references.
 *
 * Exposed because a real adapter's `auth_sessions.user_id` is a foreign key: the
 * parent rows must exist before any session insert, and a suite that hid its own
 * fixture ids could not be run against a real database at all.
 */
export const SESSION_CONTRACT_USER_IDS = ['user-1', 'user-2'] as const;

export interface SessionContractOptions<Tx = unknown> {
  /** Shown in the describe title, e.g. the adapter class name. */
  name: string;
  /** Fresh, EMPTY repository per test. A shared one makes ordering matter. */
  create: () => Promise<IAuthSessionRepository<Tx>> | IAuthSessionRepository<Tx>;
  /**
   * Map the suite's logical fixture names to ids the product's columns accept.
   *
   * Defaults to identity, which is correct for the in-memory ports. A real adapter
   * whose `id`/`user_id`/`family_id` are `uuid` needs a real mapping — Postgres
   * rejects `'session-1'` with `22P02 invalid input syntax for type uuid` before a
   * single assertion runs, which is why this suite could not previously be pointed
   * at anything but the in-memory implementation.
   *
   * Must be DETERMINISTIC: the suite maps the same logical name more than once and
   * expects the same id back.
   */
  id?: (logical: string) => string;
  /**
   * Insert the parent rows {@link SESSION_CONTRACT_USER_IDS} refers to, mapped
   * through {@link SessionContractOptions.id}. Called before each test.
   *
   * Optional because the in-memory ports have no foreign keys. A real adapter that
   * omits it fails on the first insert with a constraint violation.
   */
  seedUsers?: (userIds: readonly string[]) => Promise<void> | void;
}

/**
 * The session semantics refresh-token rotation depends on. Every assertion here
 * corresponds to a real failure mode, not to a method existing.
 */
export function describeAuthSessionRepositoryContract<Tx = unknown>(
  options: SessionContractOptions<Tx>,
): void {
  const { describe, it, expect, beforeEach } = testApi();
  const id = options.id ?? ((logical: string) => logical);

  describe(`${options.name} satisfies IAuthSessionRepository`, () => {
    let repo: IAuthSessionRepository<Tx>;

    const input = (overrides: Partial<CreateSessionInput> = {}): CreateSessionInput => ({
      id: id('session-1'),
      contextId: id('context-1'),
      userId: id('user-1'),
      tokenHash: 'hash-1',
      familyId: id('family-1'),
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    });

    beforeEach(async () => {
      await options.seedUsers?.(SESSION_CONTRACT_USER_IDS.map(id));
      repo = await options.create();
    });

    it('finds a created session by its token hash', async () => {
      await repo.create(input());
      const found = await repo.findByTokenHash('hash-1');
      expect(found?.id).toBe(id('session-1'));
      expect(found?.isRevoked).toBe(false);
    });

    it('returns null for an unknown token hash rather than throwing', async () => {
      // The refresh path treats null as "reuse or forgery" and must reach that
      // branch; an adapter that throws turns a 401 into a 500.
      expect(await repo.findByTokenHash('never-issued')).toBeNull();
    });

    it('revokeByIdIfActive wins exactly once', async () => {
      // THE rotation contract. Two concurrent refreshes present the same token;
      // only one may proceed. An adapter returning `true` both times lets a stolen
      // refresh token be replayed indefinitely.
      await repo.create(input());
      expect(await repo.revokeByIdIfActive(id('session-1'))).toBe(true);
      expect(await repo.revokeByIdIfActive(id('session-1'))).toBe(false);
    });

    it('revokeByIdIfActive wins exactly once under REAL concurrency', async () => {
      // The sequential case above passes even for an adapter that reads, then
      // writes, in two statements — the second call simply observes the first's
      // committed result. Only firing them together distinguishes a genuine
      // compare-and-swap from a read-then-write with a race between the two.
      //
      // Against the in-memory ports this is still sequential and proves little;
      // against a real database it is the assertion that matters, and it is the
      // reason single-use rotation can be trusted at all.
      await repo.create(input());
      const results = await Promise.all([
        repo.revokeByIdIfActive(id('session-1')),
        repo.revokeByIdIfActive(id('session-1')),
        repo.revokeByIdIfActive(id('session-1')),
      ]);
      expect(results.filter(Boolean).length).toBe(1);
    });

    it('revokeByIdIfActive reports false for a session that never existed', async () => {
      expect(await repo.revokeByIdIfActive(id('missing-session'))).toBe(false);
    });

    it('revokeFamily revokes every session in the family and nothing outside it', async () => {
      // Theft detection revokes the whole family. Over-revoking logs out unrelated
      // sessions; under-revoking leaves the thief's descendant alive.
      await repo.create(input({ id: id('s1'), tokenHash: 'h1', familyId: id('family-a') }));
      await repo.create(input({ id: id('s2'), tokenHash: 'h2', familyId: id('family-a') }));
      await repo.create(input({ id: id('s3'), tokenHash: 'h3', familyId: id('family-b') }));

      await repo.revokeFamily(id('family-a'));

      expect((await repo.findByTokenHash('h1'))?.isRevoked).toBe(true);
      expect((await repo.findByTokenHash('h2'))?.isRevoked).toBe(true);
      expect((await repo.findByTokenHash('h3'))?.isRevoked).toBe(false);
    });

    it('revokeAllForUser revokes across families but only for that user', async () => {
      // Offboarding. Scoping this wrongly either leaves a departed employee signed
      // in or signs out the whole tenant.
      await repo.create(
        input({ id: id('s1'), tokenHash: 'h1', userId: id('user-1'), familyId: id('f1') }),
      );
      await repo.create(
        input({ id: id('s2'), tokenHash: 'h2', userId: id('user-1'), familyId: id('f2') }),
      );
      await repo.create(
        input({ id: id('s3'), tokenHash: 'h3', userId: id('user-2'), familyId: id('f3') }),
      );

      await repo.revokeAllForUser(id('user-1'));

      expect((await repo.findByTokenHash('h1'))?.isRevoked).toBe(true);
      expect((await repo.findByTokenHash('h2'))?.isRevoked).toBe(true);
      expect((await repo.findByTokenHash('h3'))?.isRevoked).toBe(false);
    });

    it('revokeById is idempotent', async () => {
      await repo.create(input());
      await repo.revokeById(id('session-1'));
      await repo.revokeById(id('session-1'));
      expect((await repo.findByTokenHash('hash-1'))?.isRevoked).toBe(true);
    });
  });
}

export interface UserContractOptions<Tx = unknown> {
  name: string;
  /**
   * Fresh repository per test, seeded with `seed` so the suite does not depend on
   * a create method the port does not expose.
   */
  create: (seed: User[]) => Promise<IUserRepository<Tx>> | IUserRepository<Tx>;
  /** A user the suite can look up; must have a stable `id` and `email`. */
  seedUser: User;
  /**
   * An id that is VALID for the product's column type but matches no row.
   *
   * Defaults to `'nobody'`, which is fine in memory and wrong against a `uuid`
   * column: Postgres raises `22P02 invalid input syntax for type uuid` rather
   * than returning null, so the adapter fails a test it actually satisfies. Pass
   * a well-formed, unused id instead.
   */
  absentId?: string;
  /** An address valid for the product's column that matches no row. */
  absentEmail?: string;
}

/** The user-lookup and JIT-provisioning semantics the SSO login path depends on. */
export function describeUserRepositoryContract<Tx = unknown>(
  options: UserContractOptions<Tx>,
): void {
  const { describe, it, expect, beforeEach } = testApi();

  describe(`${options.name} satisfies IUserRepository`, () => {
    let repo: IUserRepository<Tx>;
    const seeded = options.seedUser;
    const absentId = options.absentId ?? 'nobody';
    const absentEmail = options.absentEmail ?? 'nobody@example.test';

    beforeEach(async () => {
      repo = await options.create([seeded]);
    });

    it('finds a seeded user by id and by email', async () => {
      expect((await repo.findById(seeded.id))?.id).toBe(seeded.id);
      expect((await repo.findByEmail(seeded.email))?.id).toBe(seeded.id);
    });

    it('returns null for unknown lookups rather than throwing', async () => {
      // Null, not an exception: the SSO path branches on it to decide whether to
      // provision, so an adapter that throws turns a first-time login into a 500.
      expect(await repo.findById(absentId)).toBeNull();
      expect(await repo.findByEmail(absentEmail)).toBeNull();
    });

    it('findSsoIdentity returns null before any link exists', async () => {
      expect(await repo.findSsoIdentity('entra', 'oid-unknown')).toBeNull();
    });

    it('upsertBySsoIdentity is idempotent for the same identity', async () => {
      // A user signing in twice — or two tabs racing the first login — must not
      // produce two users. The real adapter gets this from a unique constraint.
      const first = await repo.upsertBySsoIdentity('entra', 'oid-1', 'new@example.test', 'New');
      const second = await repo.upsertBySsoIdentity('entra', 'oid-1', 'new@example.test', 'New');
      expect(second.id).toBe(first.id);
    });

    it('upsertBySsoIdentity links to the EXISTING user when the email already exists', async () => {
      // Otherwise an invited user who then signs in via SSO gets a second account
      // and loses every grant attached to the first.
      const linked = await repo.upsertBySsoIdentity(
        'entra',
        'oid-2',
        seeded.email,
        seeded.displayName,
      );
      expect(linked.id).toBe(seeded.id);
      expect((await repo.findSsoIdentity('entra', 'oid-2'))?.userId).toBe(seeded.id);
    });

    it('updateProfile returns the updated row', async () => {
      const updated = await repo.updateProfile(seeded.id, { displayName: 'Renamed' });
      expect(updated.displayName).toBe('Renamed');
      expect((await repo.findById(seeded.id))?.displayName).toBe('Renamed');
    });

    it('updateLastLogin does not change identity fields', async () => {
      await repo.updateLastLogin(seeded.id);
      const after = await repo.findById(seeded.id);
      expect(after?.id).toBe(seeded.id);
      expect(after?.email).toBe(seeded.email);
    });
  });
}

/** Re-exported so a consumer can type its own fixtures without deep imports. */
export type { AuthSession, CreateSessionInput, User };
