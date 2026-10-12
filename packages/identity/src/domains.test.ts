import { describe, expect, it } from 'vitest';
import {
  domainIn,
  emailDomain,
  emailInDomains,
  normalizeStaffDomains,
  parseDomains,
  staffDomainIn,
  staffDomainsProblem,
  staffEmailIn,
  staffReservedDomains,
} from './domains';

describe('domains', () => {
  it('matches exactly and by sub-domain, never by look-alike suffix', () => {
    expect(domainIn('uni.test', 'uni.test')).toBe(true);
    expect(domainIn('cs.uni.test', 'uni.test')).toBe(true);
    expect(domainIn('miuni.test', 'uni.test')).toBe(false);
    expect(domainIn('uni.test.evil.example', 'uni.test')).toBe(false);
    expect(domainIn('', 'uni.test')).toBe(false);
  });
  it('accepts comma-separated lists and ignores case and spaces', () => {
    expect(parseDomains(' A.test, b.test ,')).toEqual(['a.test', 'b.test']);
    expect(emailInDomains('X@B.TEST', 'a.test,b.test')).toBe(true);
    expect(emailDomain('no-at-sign')).toBe('');
  });
  it('an address with more than one @ has no domain', () => {
    expect(emailDomain('jane@qnsc.vn@evil.example')).toBe('');
    expect(emailDomain('@@')).toBe('');
    expect(emailDomain('jane@qnsc.vn')).toBe('qnsc.vn');
    expect(emailDomain(' Jane@QNSC.vn ')).toBe('qnsc.vn');
  });
});

describe('staff domains', () => {
  const entries = normalizeStaffDomains(['QNSC.vn ', '*.Corp.example', '']);

  it('normalises: trimmed, lower-cased, empties dropped', () => {
    expect(entries).toEqual(['qnsc.vn', '*.corp.example']);
  });

  it('an entry matches itself and NOTHING else', () => {
    expect(staffDomainIn('qnsc.vn', entries)).toBe(true);
    expect(staffDomainIn('QNSC.VN', entries)).toBe(true);
    expect(staffDomainIn('sub.qnsc.vn', entries)).toBe(false);
    expect(staffDomainIn('a.b.qnsc.vn', entries)).toBe(false);
    expect(staffDomainIn('miqnsc.vn', entries)).toBe(false);
    expect(staffDomainIn('qnsc.vn.evil.example', entries)).toBe(false);
    expect(staffDomainIn('', entries)).toBe(false);
  });

  it('"*.x" matches sub-domains at any depth, not x itself, not a look-alike', () => {
    expect(staffDomainIn('a.corp.example', entries)).toBe(true);
    expect(staffDomainIn('a.b.corp.example', entries)).toBe(true);
    expect(staffDomainIn('corp.example', entries)).toBe(false);
    expect(staffDomainIn('xcorp.example', entries)).toBe(false);
    expect(staffDomainIn('.corp.example', entries)).toBe(false); // an empty label is not a sub-domain
    expect(staffDomainIn('corp.example.evil.example', entries)).toBe(false);
  });

  it('staffEmailIn reads the domain of the address, and an address with two @ matches nothing', () => {
    expect(staffEmailIn('jane@qnsc.vn', entries)).toBe(true);
    expect(staffEmailIn('jane@sub.qnsc.vn', entries)).toBe(false);
    expect(staffEmailIn('jane@qnsc.vn@evil.example', entries)).toBe(false);
    expect(staffEmailIn('jane@x.corp.example', entries)).toBe(true);
  });

  it('what it RESERVES is wider: the bare domain and its sub-domains, however the entry is written', () => {
    expect(staffReservedDomains(entries)).toEqual(['qnsc.vn', 'corp.example']);
  });

  describe('staffDomainsProblem', () => {
    it.each([['qnsc.vn'], ['*.qnsc.vn'], ['localhost'], ['a-b.c-d.example'], ['  Qnsc.VN  ']])(
      'accepts %o',
      (entry) => {
        expect(staffDomainsProblem([entry])).toBeUndefined();
      },
    );
    it('accepts a wildcard on a domain the company owns, even with a shared label elsewhere in it', () => {
      for (const entry of [
        '*.qnsc.vn',
        '*.corp.qnsc.vn',
        '*.com.qnsc.vn',
        '*.qnsc.com.vn',
        '*.qnsc.co.uk',
      ]) {
        expect(staffDomainsProblem([entry]), entry).toBeUndefined();
      }
    });
    it('the exact form of a shared suffix is only an exact entry: "com.vn" is a domain name, not a wildcard', () => {
      expect(staffDomainsProblem(['com.vn'])).toBeUndefined();
      expect(staffDomainIn('a.com.vn', ['com.vn'])).toBe(false);
    });
    it('accepts an empty list (the staff preset then admits nobody by address)', () => {
      expect(staffDomainsProblem([])).toBeUndefined();
    });
    it.each([
      ['*.vn', /top-level/],
      ['*.localhost', /top-level/],
      ['*.com.vn', /public suffix/],
      ['*.net.vn', /public suffix/],
      ['*.org.vn', /public suffix/],
      ['*.edu.vn', /public suffix/],
      ['*.gov.vn', /public suffix/],
      ['*.ac.vn', /public suffix/],
      ['*.co.uk', /public suffix/],
      ['*.ac.uk', /public suffix/],
      ['*.gov.au', /public suffix/],
      ['*.CO.UK', /public suffix/],
      ['  *.com.vn  ', /public suffix/],
      ['*.github.io', /public suffix/],
      ['*.pages.dev', /public suffix/],
      ['*.blogspot.com', /public suffix/],
      ['*', /not a domain/],
      ['*qnsc.vn', /not a domain/],
      ['qnsc.*', /not a domain/],
      ['*.*.qnsc.vn', /not a domain/],
      ['jane@qnsc.vn', /not a domain/],
      ['qnsc.vn/x', /not a domain/],
      ['qnsc..vn', /not a domain/],
      ['.qnsc.vn', /not a domain/],
      ['qnsc.vn.', /not a domain/],
      ['-qnsc.vn', /not a domain/],
      ['qnsc vn', /not a domain/],
      ['qnsc.vn,corp.example', /not a domain/],
      ['', /not a domain/],
    ])('refuses %o', (entry, message) => {
      expect(staffDomainsProblem([entry])).toMatch(message);
    });
    it('refuses a non-string', () => {
      expect(staffDomainsProblem([42])).toMatch(/string/);
      expect(staffDomainsProblem([null])).toMatch(/string/);
    });
  });
});
