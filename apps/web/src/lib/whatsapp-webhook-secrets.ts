/**
 * Reading the two WhatsApp webhook secrets, in the one place that reads them.
 *
 * WHY THIS FILE EXISTS
 *
 * The webhook route used to open with:
 *
 *     const APP_SECRET   = process.env.WHATSAPP_APP_SECRET   || '';
 *     const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
 *
 * Both lines are the same mistake, and it is a mistake that reads as caution.
 * `|| ''` looks like a safe default. It is not a default at all — it is a
 * *value*, and both of these secrets are compared against something an
 * anonymous caller controls:
 *
 *   * `token === VERIFY_TOKEN` — so `?hub.verify_token=` (empty) matches, and
 *     anyone on the internet can complete Meta's webhook handshake against this
 *     endpoint.
 *   * `verifySignature(body, sig, APP_SECRET)` — HMAC keyed on the empty
 *     string, which anyone can compute. Forge the header, and arbitrary
 *     "customer messages" enter the ingestion pipeline as genuine.
 *
 * Neither is exploitable today: `whatsapp_integration` is false and both
 * handlers 404 before reaching any of this. That is exactly why it is worth
 * fixing now. The day the flag is flipped is the day a missing line in
 * `/etc/tugpt/web.env` stops being a typo and becomes an open endpoint, and
 * that day is not the day to discover it — the check that would have caught it
 * is this one, and it costs nothing while the flag is off.
 *
 * A missing secret must therefore fail *closed*: not "verify against nothing",
 * but "refuse, and say why on the server". The distinction is the whole file.
 *
 * WHY IT IS READ PER REQUEST
 *
 * The old constants were evaluated once, at module load. Rotating a secret then
 * required a restart to take effect, and — worse for a guard like this — the
 * value a test observes is whatever `process.env` held the first time anything
 * imported the route, which is luck rather than a fixture. Reading an
 * environment variable per request costs nothing measurable next to the HMAC
 * that follows it.
 */

/** A secret that is present and usable, or the reason it is not. */
export type SecretResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Read one webhook secret from a raw environment value.
 *
 * Unset, empty, and whitespace-only are all the same condition: nobody
 * deliberately configures a secret of three spaces. Whitespace-only is the
 * shape a real misconfiguration takes — a shell here-doc that kept its
 * indentation, a quoted empty value in an env file, a copy-paste that took the
 * newline and nothing else.
 *
 * The value is NOT trimmed when it is present. A secret with a leading space is
 * a secret with a leading space; silently trimming it would make this endpoint
 * accept a token Meta will never send, which is a different bug with the same
 * symptom (verification mysteriously failing) and one that would be blamed on
 * Meta.
 */
export function readSecret(name: string, raw: string | undefined): SecretResult {
  if (raw === undefined) {
    return { ok: false, reason: `${name} is not set` };
  }
  if (raw.trim() === '') {
    return { ok: false, reason: `${name} is set but empty` };
  }
  return { ok: true, value: raw };
}

/**
 * Report a missing secret to the server log.
 *
 * Only ever the variable's *name* and its state — never the value, and never
 * anything from the request. `docs/production_environment.md` says no secrets
 * and no customer data in logs, and a function whose whole job is to talk about
 * a secret is where that rule is easiest to break.
 *
 * It logs on every occurrence rather than once per process. Under a flipped
 * flag and Meta's retries that is repetitive — but the failure this exists to
 * surface is an endpoint silently rejecting every real delivery, and the
 * remedy for a repetitive log is reading it once. A "log only the first time"
 * needs module-level state, which survives across tests and makes the guard
 * itself conditional on execution order. Noisy beats stateful here.
 */
export function reportMissingSecret(reason: string): void {
  // eslint-disable-next-line no-console
  console.error(
    `[whatsapp-webhook] refusing request: ${reason}. ` +
      'The endpoint cannot authenticate callers without it. ' +
      'Set it in /etc/tugpt/web.env and restart the web service.'
  );
}
