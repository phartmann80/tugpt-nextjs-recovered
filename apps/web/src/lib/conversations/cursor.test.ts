/**
 * @file cursor.test.ts
 * @description Inbox keyset cursors.
 *
 * The cursor is a query-string value that ends up inside a database filter, so
 * these are as much about what it refuses as about what it round-trips.
 */

import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from './cursor';

const ID = '11111111-1111-1111-1111-111111111111';
const AT = '2026-09-01T10:00:00.000Z';

describe('encode/decode', () => {
  it('T1: round-trips a cursor', () => {
    expect(decodeCursor(encodeCursor({ activityAt: AT, id: ID }))).toEqual({
      activityAt: AT,
      id: ID,
    });
  });

  it('T2: is opaque — the encoded form is not the timestamp', () => {
    // Not secrecy; both fields are on screen. The point is that the shape is
    // not a promise, so a caller cannot come to depend on editing it.
    const encoded = encodeCursor({ activityAt: AT, id: ID });
    expect(encoded).not.toContain(AT);
    expect(encoded).not.toContain(ID);
  });

  it('T3: survives a URL round trip without escaping', () => {
    // base64url, not base64: a `+` or `/` in a query string is a second
    // encoding problem, and the one place this value is ever used is a URL.
    const encoded = encodeCursor({ activityAt: AT, id: ID });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });
});

describe('what it refuses', () => {
  it('T4: null and empty are "no cursor", not errors', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('T5: refuses input that is not base64 of JSON', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(Buffer.from('{oh no', 'utf8').toString('base64url'))).toBeNull();
  });

  it('T6: refuses a well-formed cursor with a non-UUID id', () => {
    // The id goes into `id.lt.<value>` in a PostgREST filter. Checking its
    // shape here is the difference between a 400 and handing an arbitrary
    // string to the query builder.
    const forged = Buffer.from(JSON.stringify([AT, 'nope']), 'utf8').toString('base64url');
    expect(decodeCursor(forged)).toBeNull();
  });

  it('T7: refuses a cursor whose timestamp is not a date', () => {
    const forged = Buffer.from(JSON.stringify(['yesterday', ID]), 'utf8').toString('base64url');
    expect(decodeCursor(forged)).toBeNull();
  });

  it('T7b: refuses date formats Date.parse accepts but ISO does not', () => {
    // THE CASE THIS GUARD EXISTS FOR, and the reason `Date.parse` alone is not
    // the check. Every string below is accepted by `Date.parse`, and the first
    // three contain a comma — which, interpolated into the `.or()` clause the
    // service builds, is a filter separator rather than part of a timestamp.
    // T7 passed against a permissive check purely because 'yesterday' happens
    // to be unparseable; these do not let it.
    const parseables = [
      'Sep 1, 2026',
      'Sep 1, 2026 10:00',
      'Mon, 01 Sep 2026 10:00:00 GMT',
      '2026',
      '2026-09-01',
    ];
    for (const value of parseables) {
      expect(Number.isNaN(Date.parse(value)), `${value} should be Date.parse-able`).toBe(false);
      const forged = Buffer.from(JSON.stringify([value, ID]), 'utf8').toString('base64url');
      expect(decodeCursor(forged), value).toBeNull();
    }
  });

  it('T7c: still accepts what the encoder actually produces', () => {
    // The other half of T7b: a check tightened until it rejects everything
    // would pass every refusal test and break the feature.
    const iso = new Date('2026-09-01T10:00:00.000Z').toISOString();
    expect(decodeCursor(encodeCursor({ activityAt: iso, id: ID }))).toEqual({
      activityAt: iso,
      id: ID,
    });
    // ...and the offset form PostgREST returns for a timestamptz.
    const offset = '2026-09-01T10:00:00+00:00';
    expect(decodeCursor(encodeCursor({ activityAt: offset, id: ID }))?.activityAt).toBe(offset);
  });

  it('T8: refuses the wrong JSON shape', () => {
    const cases = [
      JSON.stringify({ activityAt: AT, id: ID }),
      JSON.stringify([AT]),
      JSON.stringify([AT, ID, 'extra']),
      JSON.stringify([1, 2]),
      JSON.stringify('a string'),
      JSON.stringify(null),
    ];
    for (const json of cases) {
      const encoded = Buffer.from(json, 'utf8').toString('base64url');
      expect(decodeCursor(encoded), json).toBeNull();
    }
  });

  it('T9: refuses a filter-injection attempt in the id', () => {
    // The concrete thing the UUID check is for. Without it this string reaches
    // an `.or()` clause, where a comma and a parenthesis are syntax.
    const forged = Buffer.from(
      JSON.stringify([AT, `x,status.eq.closed,and(id.gt.0)`]),
      'utf8'
    ).toString('base64url');
    expect(decodeCursor(forged)).toBeNull();
  });

  it('T10: refuses a filter-injection attempt in the timestamp', () => {
    const forged = Buffer.from(
      JSON.stringify([`2026-09-01,status.eq.closed`, ID]),
      'utf8'
    ).toString('base64url');
    expect(decodeCursor(forged)).toBeNull();
  });
});
