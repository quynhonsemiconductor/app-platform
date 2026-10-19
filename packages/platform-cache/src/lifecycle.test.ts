import 'reflect-metadata';
import type { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CacheService } from './cache.service';

// A deterministic ioredis double: the lifecycle is what is under test (which listeners outlive the service), not the wire protocol.
// The real-Valkey suite in index.test.ts covers the commands. Nothing here needs Docker.
vi.mock('ioredis', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeRedis extends EventEmitter {
    static last: FakeRedis | undefined;
    status = 'connecting';
    quit = vi.fn(async () => {
      this.status = 'end';
      return 'OK';
    });
    constructor(
      readonly url: string,
      readonly opts: unknown,
    ) {
      super();
      FakeRedis.last = this;
    }
  }
  return { default: FakeRedis };
});

const FakeRedis = Redis as unknown as {
  last: EventEmitter & { status: string; quit: ReturnType<typeof vi.fn> };
};

type Client = typeof FakeRedis.last;

describe('CacheService lifecycle (no Docker)', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  let service: CacheService;
  let client: Client;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = new CacheService({ url: 'redis://127.0.0.1:1', keyPrefix: 'test:' });
    service.onModuleInit();
    client = FakeRedis.last;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs "Cache ready" on each ready event while the service runs', () => {
    client.emit('ready');
    client.emit('ready');

    expect(log.mock.calls.filter(([msg]) => msg === 'Cache ready')).toHaveLength(2);
  });

  it('removes its listeners and quits the client at shutdown', async () => {
    await service.onApplicationShutdown();

    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('ready')).toBe(0);
    // one silent error listener stays, so ioredis does not print its own unhandled-error line after the quit
    expect(client.listenerCount('error')).toBe(1);
  });

  // The late ready event: a connection that is still being established when the app shuts down (the api boot in one process, then the
  // worker boot) emits `ready` after shutdown. The service no longer runs, so it must log nothing. Fails today: the listener outlives it.
  it('logs nothing for a ready event that arrives after shutdown', async () => {
    await service.onApplicationShutdown();
    log.mockClear();

    client.emit('ready');

    expect(log).not.toHaveBeenCalledWith('Cache ready');
  });

  // quit is queued behind offline commands while the connection is still being established: a ready event can fire while it is pending.
  it('logs nothing for a ready event that fires while quit is pending', async () => {
    client.quit.mockImplementationOnce(async () => {
      client.emit('ready');
      client.status = 'end';
      return 'OK';
    });

    await service.onApplicationShutdown();

    expect(log).not.toHaveBeenCalledWith('Cache ready');
  });

  it('logs nothing for a connection error that arrives after shutdown', async () => {
    await service.onApplicationShutdown();
    error.mockClear();

    client.emit('error', new Error('ECONNRESET'));

    expect(error).not.toHaveBeenCalledWith(expect.anything(), 'Cache connection error');
  });
});
