# ADR-009: Observability and Audit Logging

## Status
Accepted

## Context
Production compliance requires structured log telemetry and immutable audit logging for security events (login, organization creation, role changes, data modifications).

## Decision
1. Application Telemetry: `@tugpt/observability` provides `Logger` generating structured JSON records (`timestamp`, `level`, `message`, `context`, `error`).
2. Performance & Latency: `MetricsCollector` records latency metrics, execution durations, and AI token counts.
3. Database Audit Logging: `public.audit_logs` table stores:
   - `id`, `organization_id`, `actor_id`, `action`, `resource`, `details` (jsonb), `ip_address`, `created_at`.
4. Append-Only Enforcement: RLS policies on `audit_logs` allow `INSERT` and `SELECT` for authenticated members, but strictly reject `UPDATE` and `DELETE` queries for non-superusers.
5. Secret Redaction in Logs: The `Logger` sanitizes all context values via `sanitizeValue()`, which redacts:
   - Values whose key matches sensitive patterns (`password`, `secret`, `token`, `authorization`, `api_key`, `cookie`, `private_key`, `service_role_key`, `credential`).
   - Inline Bearer tokens (`Bearer\s+[A-Za-z0-9-_.=]+`) in string values.
   - API keys (`sk-...`, `sbp_...`) in string values.
6. Error Message Sanitization: As of PR #2, `err.message` is also passed through `sanitizeValue()` before being included in the log payload. Previously, error messages were logged raw, which could leak secrets if an error message contained a token or key value.

## Consequences
- Guaranteed audit trail for forensic investigation.
- Real-time observability formatted for cloud logging aggregators (Datadog, GCP Cloud Logging).
- Secrets in error messages are now redacted alongside secrets in context values, preventing accidental leakage through thrown errors.

## Security Implications
Audit trail cannot be tampered with or deleted by malicious organization admins or compromised user accounts.
Secrets in error messages are now treated with the same redaction as secrets in context values.