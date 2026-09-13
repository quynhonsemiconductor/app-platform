import { describe, expect, it } from 'vitest';
import { sanitizeObject, sanitizeString } from './sanitize';

/**
 * The three cases marked CONVERGENCE are the ones the two copies of this file
 * disagreed on. Each was correct in exactly one repo, so each is a case the
 * other silently got wrong. They are the reason this file exists.
 */
describe('sanitizeString', () => {
  it('removes a script element with its content', () => {
    expect(sanitizeString('a<script>steal()</script>b')).toBe('ab');
  });

  it.each([
    ['iframe', '<iframe src="x"></iframe>'],
    ['object', '<object data="x">'],
    ['embed', '<embed src="x">'],
    ['form', '<form action="x">'],
    ['input', '<input value="x">'],
    ['textarea', '<textarea>'],
    ['style', '<style>body{}</style>'],
  ])('removes a %s tag', (_label, markup) => {
    expect(sanitizeString(`safe${markup}safe`)).not.toMatch(/</);
  });

  /**
   * Only <script> has a content-removing pass. Every other tag is unwrapped, so
   * its body survives as inert text - `<style>body{}</style>` leaves `body{}`.
   * That is the behaviour BOTH copies already had and it is not a gap: with the
   * tag gone the text cannot execute or restyle anything. Asserted so a future
   * reader does not mistake it for one, and so tightening it is a deliberate
   * change rather than an accident.
   */
  it('unwraps a non-script tag and leaves its body as inert text', () => {
    expect(sanitizeString('safe<style>body{}</style>safe')).toBe('safebody{}safe');
  });

  /**
   * CONVERGENCE. rova stripped this and opshub did not: the pattern needs `\s*`
   * after the optional slash.
   */
  it('removes a closing tag written with a space after the slash', () => {
    expect(sanitizeString('a</ script>b')).toBe('ab');
  });

  it.each([
    ['double quoted', 'onclick="steal()"'],
    ['single quoted', "onload='steal()'"],
    ['unquoted', 'onerror=steal()'],
  ])('removes an inline handler (%s)', (_label, attr) => {
    expect(sanitizeString(`x ${attr}`)).not.toMatch(/on\w+=/i);
  });

  /**
   * CONVERGENCE, and the one that matters most. opshub handled this; rova's
   * two-pass form matched `"a'` and left `b"` behind — a PARTIAL strip, which
   * leaves live markup while looking like it worked.
   */
  it('removes a handler whose quoted value contains the other quote character', () => {
    expect(sanitizeString(`x onclick="a'b()"`)).toBe('x');
    expect(sanitizeString(`x onload='a"b()'`)).toBe('x');
  });

  it('leaves ordinary text untouched', () => {
    expect(sanitizeString('Sprint 26.1 — 80% done (on track)')).toBe(
      'Sprint 26.1 — 80% done (on track)',
    );
  });

  it('trims', () => {
    expect(sanitizeString('  padded  ')).toBe('padded');
  });
});

describe('sanitizeObject', () => {
  it('sanitizes nested strings, arrays and objects', () => {
    const out = sanitizeObject({
      name: 'a<script>x()</script>b',
      tags: ['<iframe src="x">tag', 'plain'],
      nested: { deep: 'c<iframe src="x"></iframe>d' },
    });
    expect(out.name).toBe('ab');
    expect(out.tags).toEqual(['tag', 'plain']);
    expect(out.nested).toEqual({ deep: 'cd' });
  });

  it('passes non-string primitives through unchanged', () => {
    const out = sanitizeObject({ n: 1, b: false, nul: null, undef: undefined });
    expect(out).toEqual({ n: 1, b: false, nul: null, undef: undefined });
  });

  it('does not recurse into a Date or a class instance', () => {
    class Thing {
      constructor(public value = '<script>x()</script>') {}
    }
    const date = new Date('2026-01-01T00:00:00.000Z');
    const thing = new Thing();
    const out = sanitizeObject({ date, thing });
    expect(out.date).toBe(date);
    expect(out.thing).toBe(thing);
    expect(out.thing.value).toBe('<script>x()</script>');
  });

  /**
   * CONVERGENCE. `constructor` is an ordinary writable property, so it says what
   * an object CLAIMS to be. The prototype is what it is.
   */
  it('does not recurse into an object that merely claims to be plain', () => {
    class Fake {
      constructor(public value = '<script>x()</script>') {}
    }
    const fake = new Fake();
    (fake as unknown as Record<string, unknown>).constructor = Object;

    const out = sanitizeObject({ fake });
    expect(out.fake).toBe(fake);
    expect(out.fake.value).toBe('<script>x()</script>');
  });

  it('does not recurse into a null-prototype object', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.value = '<script>x()</script>';
    expect(sanitizeObject({ bare }).bare).toBe(bare);
  });
});
