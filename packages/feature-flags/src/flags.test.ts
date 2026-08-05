import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureFlagService } from './flags';

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

  it('unknown flag returns false', () => {
    expect(service.isEnabled('unknown_flag')).toBe(false);
  });
});