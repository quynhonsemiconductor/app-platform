import { describe, expect, it } from 'vitest';
import type { AccountContext } from './accounts';
import { reservedDomainCheck } from './reserved';

const noContext = (): Promise<AccountContext> => {
  throw new Error('the staff check must not read the database');
};
const staff = reservedDomainCheck({
  staffDomains: ['qnsc.vn'],
  withSso: false,
  getContext: noContext,
});

describe('reservedDomainCheck (company addresses never become password or consumer-provider accounts)', () => {
  it('reserves the staff domain and its sub-domains, case-insensitively', async () => {
    for (const email of ['jane@qnsc.vn', 'Jane@QNSC.vn', 'jane@sub.qnsc.vn', 'jane@a.b.qnsc.vn']) {
      expect(await staff(email), email).toBe(true);
    }
  });

  it('does not reserve another domain or a look-alike', async () => {
    for (const email of ['jane@elsewhere.example', 'jane@miqnsc.vn', 'jane@qnsc.vn.evil.example']) {
      expect(await staff(email), email).toBe(false);
    }
  });

  it('FAILS CLOSED for an address with an @ but no domain it can name: two @, or nothing after the @', async () => {
    for (const email of [
      'jane@qnsc.vn@evil.example',
      'jane@evil.example@qnsc.vn',
      'jane@',
      'a@b@c@d',
      '@@',
      'jane@  ',
    ]) {
      expect(await staff(email), email).toBe(true);
    }
  });

  it('a string with no @ at all is not an address, and is not reserved here (the email validation refuses it)', async () => {
    expect(await staff('no-at-sign')).toBe(false);
    expect(await staff('')).toBe(false);
  });
});
