/**
 * This service is a kill switch, not a flag system — see the header of
 * `flags.ts` for why the distinction is load-bearing. These tests exist to keep
 * it one.
 *
 * The first three are the original F1–F3: `whatsapp_integration` is off by
 * default, and it responds to being set. They prove the in-code half of the
 * dual enforcement works, and they must keep passing unchanged.
 *
 * The rest are new, and they guard the shape rather than the behaviour: the
 * service must answer for exactly one key, that key's value must be `false`,
 * and the five keys removed on 2026-08-25 must stay gone. A key added here is
 * a key that is on, or off, for every organization simultaneously — which is
 * almost never what a customer-facing capability wants, and is why these fail
 * loudly rather than quietly allowing it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureFlagService, KILL_SWITCHES, type KillSwitchKey } from './flags';

describe('feature-flags', () => {
  let service: FeatureFlagService;

  beforeEach(() => {
    service = new FeatureFlagService();
  });

  // F1: whatsapp_integration flag is disabled by default
  it('whatsapp_integration is disabled by default', () => {
    expect(service.isEnabled('whatsapp_integration')).toBe(false);
  });

  // F2: Enabling flag in tests allows webhook processing
  it('enabling flag returns true', () => {
    service.setFlag('whatsapp_integration', true);
    expect(service.isEnabled('whatsapp_integration')).toBe(true);
  });

  // F3: Disabled flag prevents all persistence and queue work
  it('disabled flag returns false', () => {
    service.setFlag('whatsapp_integration', false);
    expect(service.isEnabled('whatsapp_integration')).toBe(false);
  });

  /**
   * `isEnabled` is typed to `KillSwitchKey`, so an unknown key is normally a
   * compile error. The cast is deliberate: it reaches the runtime path that a
   * JavaScript caller, or a caller who cast their way past the type, would hit.
   * That path must be `false`.
   */
  it('unknown flag returns false', () => {
    expect(service.isEnabled('unknown_flag' as KillSwitchKey)).toBe(false);
  });
});

describe('feature-flags — the set of keys is the invariant', () => {
  /**
   * Fails the moment a key is added. That is not an obstacle to adding one; it
   * is the argument you have to have first. Add the key here and in
   * `KILL_SWITCHES`, and say in the commit why the value is right for every
   * organization at once.
   */
  it('answers for exactly one key', () => {
    expect(Object.keys(KILL_SWITCHES)).toEqual(['whatsapp_integration']);
  });

  /**
   * A kill switch that defaults to on is not a kill switch. Three of the five
   * keys removed on 2026-08-25 defaulted to `true`, which is what made them
   * dangerous rather than merely dead.
   */
  it('defaults every key to false', () => {
    for (const [key, value] of Object.entries(KILL_SWITCHES)) {
      expect(value, `${key} must default to false`).toBe(false);
    }
  });

  /**
   * The regression this change exists to prevent (ADR-015 Part 3, row 13).
   *
   * `voice_receptionist`, `image_generation` and `video_generation` name
   * capabilities the product scope asks for. If one of them reappears here, the
   * capability it gates ships enabled for every organization and changeable
   * only by a deploy — and with no migration involved, a schema review would
   * never see it. Gate those with `is_feature_enabled` or the entitlement
   * layer instead.
   */
  it.each([
    'voice_receptionist',
    'langdock_orchestrator',
    'mastra_orchestrator',
    'image_generation',
    'video_generation',
  ])('does not answer for %s', (key) => {
    expect(Object.keys(KILL_SWITCHES)).not.toContain(key);
    expect(new FeatureFlagService().isEnabled(key as KillSwitchKey)).toBe(false);
  });

  /**
   * Each instance owns its map. If the map ever became module-level state,
   * a `setFlag` in one test would leak into the exported singleton the webhook
   * imports — turning outbound WhatsApp on for whatever ran next.
   */
  it('gives each instance its own state', () => {
    const a = new FeatureFlagService();
    const b = new FeatureFlagService();

    a.setFlag('whatsapp_integration', true);

    expect(a.isEnabled('whatsapp_integration')).toBe(true);
    expect(b.isEnabled('whatsapp_integration')).toBe(false);
  });
});
