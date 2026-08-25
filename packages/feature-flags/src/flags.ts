/**
 * The in-process kill switch.
 *
 * READ THIS BEFORE ADDING A KEY.
 *
 * There are two feature-flag mechanisms in TuGPT and they are not
 * interchangeable:
 *
 *   1. `is_feature_enabled(p_organization_id, p_flag_key)` — the database RPC.
 *      Per-organization, changeable at runtime, ANDs a global row with an org
 *      row. **This is the only legitimate gate for a customer-facing
 *      capability.** Anything that must be on for one organization and off for
 *      another belongs there, or in the entitlement layer (ADR-015 D5).
 *
 *   2. This file. A hardcoded, org-blind, build-time constant. It cannot
 *      express a per-organization answer *even in principle* — `isEnabled`
 *      takes no organization argument and there is nowhere for one to come
 *      from. Changing it requires a code change and a deploy.
 *
 * Mechanism 2 exists for exactly one purpose: to be the second, in-code half of
 * the dual enforcement on `whatsapp_integration`, so that enabling outbound
 * WhatsApp takes a deliberate code change *and* a database row, never a
 * database edit alone (ADR-010 amendment 2). That is a property of a kill
 * switch, not of a flag system.
 *
 * Until 2026-08-25 this file also carried five keys with no reader anywhere —
 * `voice_receptionist`, `langdock_orchestrator`, `mastra_orchestrator`,
 * `image_generation`, `video_generation` — three of them defaulting to `true`.
 * Three of the five name capabilities the product scope asks for (ADR-015
 * Part 3, row 13). Whoever came to build voice, images or video would have
 * reached for the flag already wearing the right name and shipped the
 * capability enabled for every organization — with no migration involved, so
 * nothing in a schema review would have caught it. They are removed rather than
 * set to `false`, because a key that exists and reads `false` invites being
 * flipped to `true`, whereas a key that does not exist sends you to
 * `is_feature_enabled`, which is where you were always supposed to go.
 *
 * The rule that follows: **a new key here must be a kill switch whose value is
 * correct for every organization at once.** If you cannot say that out loud
 * about the key you are adding, it does not belong in this file.
 */

/**
 * Every key this service answers for, with its build-time value.
 *
 * Exhaustive by construction: `isEnabled` returns `false` for anything absent,
 * and `flags.test.ts` fails if this object gains a key, or if any value in it
 * is `true`. Both failures are the point — they make adding a key, or
 * defaulting one to on, a deliberate act somebody has to argue for.
 */
export const KILL_SWITCHES = {
  /**
   * Outbound WhatsApp. Hardcoded `false`, and one half of the dual enforcement
   * described above — the database row is the other half. Enabling this is an
   * owner decision, not an engineering one.
   */
  whatsapp_integration: false,
} as const;

export type KillSwitchKey = keyof typeof KILL_SWITCHES;

export class FeatureFlagService {
  private flags: Map<string, boolean> = new Map(Object.entries(KILL_SWITCHES));

  /**
   * Test seam. Production code must never call this.
   *
   * The map is per-process — the web app and each worker construct their own —
   * so a runtime `setFlag` would change the answer in one process and not the
   * others. That is the worst available property for a kill switch: off where
   * you looked, on where the traffic went.
   */
  public setFlag(key: KillSwitchKey, isEnabled: boolean): void {
    this.flags.set(key, isEnabled);
  }

  /**
   * Fail-closed: an unknown key is `false`, never `true`.
   *
   * The `KillSwitchKey` parameter type makes an unknown key a compile error
   * rather than a silent `false`. The runtime fallback still stands, for
   * callers reaching this from untyped code or through a cast.
   */
  public isEnabled(key: KillSwitchKey): boolean {
    return this.flags.get(key) ?? false;
  }
}

export const featureFlagService = new FeatureFlagService();
