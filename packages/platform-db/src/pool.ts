import { Pool, type PoolConfig } from 'pg';
import { readDatabaseConfig, type DatabaseConfig, type DatabaseEnv } from './config';
import type { ConnectionTarget } from './errors';
import { guardPool, type DbLogger } from './guard';

export type { DbLogger } from './guard';

export interface CreatePoolOptions {
  /** Where pool-level errors go. Default: `console`. */
  logger?: DbLogger;
}

/** Which role's connection to build; see {@link createMigratorPool}. */
const MIGRATOR_POOL_MAX = 2;

function poolConfig(config: DatabaseConfig, host: string, max: number): PoolConfig {
  return {
    host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    // VERIFIED, never `rejectUnauthorized: false`. node-postgres treats any `ssl` object as
    // "TLS required": a server that does not offer it is refused rather than downgraded.
    // `ssl: false` is reachable only through DATABASE_SSL=disable outside production,
    // which readDatabaseConfig has already checked.
    ssl: config.caPem ? { ca: config.caPem, rejectUnauthorized: true } : false,
  };
}

function build(config: DatabaseConfig, host: string, max: number, logger: DbLogger): Pool {
  // Error listeners on the pool and every client, and backoff on connection attempts: see
  // guardPool. Without the listeners one connection dropped by a failover ends the process.
  return guardPool(new Pool(poolConfig(config, host, max)), {
    logger,
    target: `${host}:${config.port}`,
  });
}

/** What {@link pingDatabase} and error messages need to say about a pool. */
const targets = new WeakMap<Pool, ConnectionTarget>();

/** @internal The host/role a pool was built for, for error messages. */
export function targetOf(pool: Pool): ConnectionTarget {
  return targets.get(pool) ?? {};
}

function remember(pool: Pool, config: DatabaseConfig, host: string): Pool {
  targets.set(pool, { host, port: config.port, database: config.database, user: config.user });
  return pool;
}

/**
 * The application pool, from `DATABASE_*` / `DB_POOL_*`. See {@link DatabaseEnv}.
 *
 * Throws `DatabaseConfigError` synchronously for any problem that can be found without a
 * connection (missing secret, unreadable CA, `DATABASE_SSL=disable` in production). The
 * pool connects lazily; use {@link pingDatabase} to find out whether it can.
 *
 * The caller owns the pool and must `end()` it (the `/nest` module does so on shutdown).
 */
export function createPool(env: DatabaseEnv = process.env, options: CreatePoolOptions = {}): Pool {
  const config = readDatabaseConfig(env);
  return remember(
    build(config, config.host, config.max, options.logger ?? console),
    config,
    config.host,
  );
}

/**
 * The same pool for the MIGRATOR role. There is deliberately no second code path: the
 * chart's migration Job sets `DATABASE_USER` / `DATABASE_PASSWORD` to the migrator role's
 * Secret, so reading the same variables yields that role's connection, with the same
 * verified TLS.
 *
 * Differs from {@link createPool} only in defaulting to a small pool: migrations are
 * sequential, and the migrator role has its own `CONNECTION LIMIT`.
 */
export function createMigratorPool(
  env: DatabaseEnv = process.env,
  options: CreatePoolOptions = {},
): Pool {
  const config = readDatabaseConfig(env);
  const max = env.DB_POOL_MAX?.trim() ? config.max : MIGRATOR_POOL_MAX;
  return remember(build(config, config.host, max, options.logger ?? console), config, config.host);
}

/**
 * A pool against the read replica (`DATABASE_READ_HOST`, the CNPG `-ro` service), with the
 * same role, TLS and sizing as the primary. `undefined` when no read host is configured,
 * which is the normal case until a replica exists.
 */
export function createReadPool(
  env: DatabaseEnv = process.env,
  options: CreatePoolOptions = {},
): Pool | undefined {
  const config = readDatabaseConfig(env);
  if (!config.readHost) return undefined;
  return remember(
    build(config, config.readHost, config.max, options.logger ?? console),
    config,
    config.readHost,
  );
}
