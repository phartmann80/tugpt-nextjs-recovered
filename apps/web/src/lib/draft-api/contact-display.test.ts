/**
 * @file contact-display.test.ts
 * @description Masking a customer's phone number.
 *
 * Small function, and the reason it has its own file is the reason it exists:
 * the rule was previously implemented inline in one method and simply absent
 * from the one below it. A rule with no single definition has no single test
 * either, and the untested half is the half that was wrong.
 */

import { describe, it, expect } from 'vitest';
import { maskContact } from './contact-display';

describe('maskContact', () => {
  it('T1: shows the last four characters and nothing else', () => {
    expect(maskContact('+593991234567')).toBe('***-***-4567');
    expect(maskContact('12345')).toBe('***-***-2345');
  });

  it('T2: never returns a value that contains the whole input', () => {
    // The property, stated as a property rather than as examples. Anything the
    // caller passes must come back shorter than it went in, or masked out.
    for (const phone of ['+593991234567', '5551234', '12345', 'abcdefgh']) {
      const masked = maskContact(phone) as string;
      expect(masked, phone).not.toContain(phone);
    }
  });

  it('T3: masks a short identifier completely', () => {
    // `contact_phone` is CHECK-constrained to 1–32 characters, so four is
    // legal — and "show the last four" of a four-character value shows all of
    // it. This is the one input where the naive rule does the opposite of its
    // job, which is why it is a branch and not a comment.
    expect(maskContact('1234')).toBe('***-***-****');
    expect(maskContact('12')).toBe('***-***-****');
    expect(maskContact('1')).toBe('***-***-****');
  });

  it('T4: returns null for nothing to mask', () => {
    // A caller that has no phone gets null rather than `***-***-` — a partial
    // mask reads as a real value that happens to be short.
    expect(maskContact(null)).toBeNull();
    expect(maskContact(undefined)).toBeNull();
    expect(maskContact('')).toBeNull();
    expect(maskContact('   ')).toBeNull();
  });

  it('T5: is stable — the same input always masks the same way', () => {
    // Two fields in one response derive from the same number. They agreed by
    // accident before, because both happened to be written the same way; now
    // they agree because they are the same call.
    expect(maskContact('+593991234567')).toBe(maskContact('+593991234567'));
  });
});
