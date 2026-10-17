import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as sender from './sender';

/**
 * `/sender` exists so a product with its own outbox can send without installing `platform-jobs` and pg-boss. That holds only while nothing it
 * reaches imports them (or the queue, the ledger or the smoke test, which do): walk the imports from the entry and fail on any of those.
 */
describe('@quynhonsemiconductor/platform-mail/sender', () => {
  const reached = new Set<string>();
  const offenders: string[] = [];
  const walk = (file: string): void => {
    if (reached.has(file)) return;
    reached.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)';/gms)) {
      const spec = m[1] as string;
      if (spec.startsWith('.')) {
        if (/\/(jobs|state|smoke|nest)(\/|$)/.test(spec)) offenders.push(`${file} -> ${spec}`);
        else walk(join(dirname(file), `${spec}.ts`));
      } else if (spec.startsWith('@quynhonsemiconductor/platform-jobs') || spec === 'pg-boss') {
        offenders.push(`${file} -> ${spec}`);
      }
    }
  };

  it('reaches neither platform-jobs, pg-boss, the queue, the ledger nor the smoke test', () => {
    walk(join(import.meta.dirname, 'sender.ts'));
    expect(reached.size).toBeGreaterThan(3);
    expect(offenders).toEqual([]);
  });

  it('exports what a sender needs', () => {
    expect(typeof sender.createEmailSender).toBe('function');
    expect(typeof sender.readMailConfig).toBe('function');
    expect(typeof sender.MailSendError).toBe('function');
    expect(typeof sender.MailConfigError).toBe('function');
    expect(sender).not.toHaveProperty('registerMailJobs');
  });

  it('is declared as a subpath, with the legacy-resolution shim, and platform-jobs is an optional peer', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as {
      exports: Record<string, unknown>;
      files: string[];
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    expect(pkg.exports['./sender']).toBeDefined();
    expect(pkg.files).toEqual(expect.arrayContaining(['sender.js', 'sender.d.ts']));
    expect(pkg.peerDependenciesMeta['@quynhonsemiconductor/platform-jobs']?.optional).toBe(true);
  });
});
