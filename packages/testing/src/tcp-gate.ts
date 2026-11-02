import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';

/**
 * A TCP port that can be switched between "nothing listens" (connect gets ECONNREFUSED, as when the
 * database pod has not started yet) and "forwards to the real server". Closing it also cuts every
 * forwarded connection, as a database restart would.
 *
 * The port is reserved once and reused on every `open()`, so a client configured with it before the
 * database exists keeps the same address throughout, like a Kubernetes Service.
 */
export interface TcpGate {
  readonly host: string;
  readonly port: number;
  /** Start forwarding to the target. */
  open(): Promise<void>;
  /** Stop listening and cut every forwarded connection. */
  close(): Promise<void>;
}

export async function createTcpGate(target: { host: string; port: number }): Promise<TcpGate> {
  const host = '127.0.0.1';
  // Reserve a free port, then release it: "closed" must mean nothing listens there.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, host, resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  let server: Server | undefined;
  const sockets = new Set<Socket>();

  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  };

  return {
    host,
    port,
    async open() {
      if (server) return;
      const s = createServer((client) => {
        const upstream = connect(target.port, target.host);
        track(client);
        track(upstream);
        client.pipe(upstream).pipe(client);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      });
      // The port was released after reserving it, so another process can take it in between.
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(port, host, () => {
          s.off('error', reject);
          resolve();
        });
      });
      server = s;
    },
    async close() {
      const s = server;
      server = undefined;
      if (!s) return;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },
  };
}
