import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Docs lint: names the platform has retired must not come back in a README, a comment or the contract.
 *
 * Each of these was found stale in the audit that produced this test: a comment still saying a fixed window or
 * a token bucket for the sliding-window limiter, `AuthTokenCache` for something identity 8 deleted, and
 * "8.0.0 pending" after 8.0.0 shipped. The point of a test is that the
 * next stale name fails a build instead of waiting for another audit.
 *
 * To retire another name, add a rule. To keep a legitimate mention (a changelog, a migration guide, an ADR that
 * is history), allow it by file or by line, here, with the reason.
 */
interface Rule {
  name: string;
  /** What to use instead, shown in the failure. */
  use: string;
  pattern: RegExp;
  /** Files where the name is history, not a claim about now. */
  allowFiles?: RegExp;
  /** Lines that mention it on purpose (always explaining the old name). */
  allowLine?: RegExp;
}

export const RULES: Rule[] = [
  {
    name: 'AuthTokenCache',
    use: 'identity 8 has no token cache: sessions and their revocation are Better Auth’s (`revokeUserSessions`)',
    pattern: /\bAuthTokenCache\b/,
    allowFiles: /^packages\/identity\/MIGRATION-v7-to-v8\.md$|(^|\/)CHANGELOG\.md$|^docs\/adr\//,
  },
  {
    name: 'token bucket (for the platform rate limiter)',
    use: 'the rate limiter is an atomic sliding-window log (`CacheService.consumeRateLimit`)',
    pattern: /token[- ]bucket/i,
    // platform-mail's send slot IS a token bucket; the roadmaps and ADRs are history.
    allowFiles:
      /^packages\/platform-mail\/|^docs\/(adr\/|REUSE-ROADMAP\.md$|PLAN\.md$)|(^|\/)CHANGELOG\.md$/,
  },
  {
    name: 'a fixed window (for the platform rate limiter)',
    use: 'the rate limiter is a sliding window; say what a fixed window would do only to contrast it',
    pattern: /fixed[- ]window/i,
    allowFiles: /(^|\/)CHANGELOG\.md$|^docs\/(adr\/)/,
    allowLine: /\bnot a fixed|rather than a fixed|a fixed-window counter allows|than a fixed/i,
  },
  {
    name: 'a pending identity 8.0.0',
    use: 'identity 8.x has shipped (see contract §12)',
    pattern: /8\.0\.0 pending|Pending WP-10/,
    allowFiles: /(^|\/)CHANGELOG\.md$|^docs\/(adr\/|PLAN\.md$)/,
  },
];

const TEXT = /\.(md|ts|json|ya?ml|cjs|mjs|js)$/;
const root = join(import.meta.dirname, '..');

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter((file) => file && TEXT.test(file));
}

export interface Finding {
  rule: string;
  file: string;
  line: number;
  text: string;
}

/** Findings in one file's text. Pure, so the rules can be tested on strings. */
export function lint(file: string, text: string, rules: Rule[] = RULES): Finding[] {
  // This file names the retired words on purpose.
  if (file === 'tools/docs-lint.test.ts') return [];
  const out: Finding[] = [];
  const lines = text.split('\n');
  for (const rule of rules) {
    if (rule.allowFiles?.test(file)) continue;
    lines.forEach((line, i) => {
      if (rule.pattern.test(line) && !rule.allowLine?.test(line)) {
        out.push({ rule: rule.name, file, line: i + 1, text: line.trim().slice(0, 140) });
      }
    });
  }
  return out;
}

describe('docs lint: retired names', () => {
  it('no tracked README, comment, workflow or contract uses a retired name', () => {
    const findings = trackedFiles().flatMap((file) =>
      lint(file, readFileSync(join(root, file), 'utf8')),
    );
    const report = findings
      .map((f) => {
        const rule = RULES.find((r) => r.name === f.rule)!;
        return `${f.file}:${f.line}  ${f.rule}  →  ${rule.use}\n    ${f.text}`;
      })
      .join('\n');
    expect(findings, `\n${report}\n`).toEqual([]);
  });

  describe('the rules can fail (and do not over-fire)', () => {
    const hit = (file: string, text: string) => lint(file, text).map((f) => f.rule);

    it('AuthTokenCache: a whole word; history is allowed in changelogs and ADRs', () => {
      expect(hit('README.md', 'the `AuthTokenCache` denylist')).toEqual(['AuthTokenCache']);
      expect(hit('README.md', 'AuthTokenCacheFactory')).toEqual([]);
      expect(hit('packages/x/CHANGELOG.md', 'removed AuthTokenCache')).toEqual([]);
      expect(hit('docs/adr/0002-x.md', 'AuthTokenCache was decided against')).toEqual([]);
    });

    it('AuthTokenCache: flagged in a comment, allowed in the migration guide', () => {
      expect(hit('packages/platform-cache/src/x.ts', '// see `AuthTokenCache`')).toEqual([
        'AuthTokenCache',
      ]);
      expect(
        hit('packages/identity/MIGRATION-v7-to-v8.md', '| `AuthTokenCache` (denylist) |'),
      ).toEqual([]);
    });

    it('token bucket: flagged for the platform limiter, allowed in platform-mail where it is true', () => {
      expect(hit('packages/platform-cache/src/x.ts', 'a token-bucket rate-limit helper')).toEqual([
        'token bucket (for the platform rate limiter)',
      ]);
      expect(hit('packages/platform-mail/README.md', 'a token bucket of 20 a minute')).toEqual([]);
    });

    it('fixed window: flagged when it is claimed, allowed when it is contrasted', () => {
      expect(hit('packages/platform-http/src/x.ts', 'backed by Valkey fixed window')).toEqual([
        'a fixed window (for the platform rate limiter)',
      ]);
      expect(
        hit('docs/PLATFORM-CONTRACT.md', 'sliding-window log, not a fixed window, so'),
      ).toEqual([]);
      expect(
        hit('packages/platform-cache/src/x.ts', 'a fixed-window counter allows bursts'),
      ).toEqual([]);
    });

    it('a pending identity 8.0.0 is flagged in the contract', () => {
      expect(hit('docs/PLATFORM-CONTRACT.md', '`identity` 7.1.0 (8.0.0 pending)')).toEqual([
        'a pending identity 8.0.0',
      ]);
      expect(hit('docs/PLATFORM-CONTRACT.md', '**Pending WP-10.** ADR 0002 passed')).toEqual([
        'a pending identity 8.0.0',
      ]);
    });
  });
});
