import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { VALKEY_IMAGE } from './docker';

export interface StartValkeyOptions {
  /** Override the image. Default: {@link VALKEY_IMAGE}. */
  image?: string;
  /**
   * Run the server in CLUSTER mode as a one-node cluster owning all 16384 slots, so a command whose keys hash
   * to different slots fails with `CROSSSLOT` exactly as it does on ElastiCache Serverless / a real cluster.
   * Connect with a plain (non-cluster) ioredis client: every slot is on this node, so there are no redirects.
   */
  cluster?: boolean;
}

export interface ValkeyHarness {
  readonly host: string;
  readonly port: number;
  /** `redis://host:port` — Valkey speaks the Redis protocol, so ioredis connects with it as is. */
  readonly url: string;
  /** Run `valkey-cli <args>` inside the container and return its trimmed stdout. */
  command(...args: string[]): Promise<string>;
  /** Remove every key in every database. Use between tests. */
  flush(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start a Valkey container.
 *
 * Deliberately returns no client: the harness must not pin an ioredis version on the packages
 * that use it. Connect with whatever client the package under test already depends on.
 */
export async function startValkey(options: StartValkeyOptions = {}): Promise<ValkeyHarness> {
  const started: StartedTestContainer = await new GenericContainer(options.image ?? VALKEY_IMAGE)
    .withExposedPorts(6379)
    .withCommand(
      options.cluster
        ? ['valkey-server', '--cluster-enabled', 'yes', '--cluster-config-file', '/tmp/nodes.conf']
        : ['valkey-server'],
    )
    // BOTH, deliberately. The log line proves the server is up INSIDE the container; it says nothing
    // about the port Docker maps on the host, which can refuse for a moment after it (measured:
    // 4-10 of 16 parallel containers got ECONNREFUSED on a connect made right after start()).
    // `forListeningPorts` also connects to the mapped host port, so start() returns only once a
    // client on the host can actually reach the server.
    .withWaitStrategy(
      Wait.forAll([Wait.forListeningPorts(), Wait.forLogMessage(/Ready to accept connections/)]),
    )
    .withStartupTimeout(60_000)
    .start();

  const host = started.getHost();
  const port = started.getMappedPort(6379);

  const command = async (...args: string[]): Promise<string> => {
    const result = await started.exec(['valkey-cli', ...args]);
    if (result.exitCode !== 0) {
      throw new Error(`valkey-cli ${args[0] ?? ''} failed (${result.exitCode}): ${result.output}`);
    }
    return result.output.trim();
  };

  if (options.cluster) {
    await command('CLUSTER', 'ADDSLOTSRANGE', '0', '16383');
    for (let i = 0; i < 100; i += 1) {
      if ((await command('CLUSTER', 'INFO')).includes('cluster_state:ok')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return {
    host,
    port,
    url: `redis://${host}:${port}`,
    command,
    flush: async () => {
      await command('FLUSHALL');
    },
    stop: async () => {
      await started.stop();
    },
  };
}
