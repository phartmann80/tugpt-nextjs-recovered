# TuGPT.ai Production Environment & Security Hardening Guide

This document describes the environment variable configurations, secret handling, and security boundaries required for deploying the TuGPT.ai platform to production.

---

## 1. Production Environment Variables Checklist

Every production environment deployment requires the following variables to be explicitly defined. Do NOT fall back to local development defaults.

| Environment Variable | Source / Value | Security Boundary |
| :---- | :---- | :---- |
| `NEXT_PUBLIC_SUPABASE_URL` | Production Supabase Project URL | Publicly accessible in browser. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production Supabase Anonymous Key | Publicly accessible in browser. |
| `SUPABASE_SERVICE_ROLE_KEY` | Production Supabase Service Role Key | **SECRET**. Server-side only. Must NEVER leak to client-side bundles. |
| `LOGICC_API_KEY` | Production Logicc AI API Key (primary draft provider) | **SECRET**. Server-side only. |
| `LOGICC_ENDPOINT_URL` | Production Logicc Endpoint URL | Server-side only. |
| `LOGICC_DEFAULT_MODEL` | Production Logicc Model Identifier | Server-side only. |
| `LANGDOCK_API_CODE` | Production Langdock Integration API Key (secondary draft provider) | **SECRET**. Server-side only. |
| `LANGDOCK_ENDPOINT_URL` | Production Langdock Endpoint URL | Server-side only. |
| `ANYMIZE_API_KEY` | Production Anymize AI API Key (tertiary fallback provider) | **SECRET**. Server-side only. |
| `ANYMIZE_ENDPOINT_URL` | Production Anymize Endpoint URL (default: https://app.anymize.ai/api/v1/llm) | Server-side only. |
| `ANYMIZE_DEFAULT_MODEL` | Production Anymize Model Identifier (must be set when enabled) | Server-side only. |
| `GATEWAY_API_MASTRA_KEY` | Production Mastra Orchestrator API Key | **SECRET**. Server-side only. |
| `GATEWAY_API_URL` | Production Mastra Endpoint URL | Server-side only. |

---

## 2. Server-Side vs. Client-Side Secret Isolation

To prevent exposing database secrets or service keys:

1. **Prefix Rule**: Only variables prefixed with `NEXT_PUBLIC_` are bundled into browser-side client bundles by Next.js.
2. **Admin Client Restrictions**: The `SUPABASE_SERVICE_ROLE_KEY` is a secret credential bypassing all PostgreSQL RLS policies. It must **never** be defined under client-side execution.
3. **Execution Guard**: `createAdminSupabaseClient` in `@tugpt/database` explicitly asserts `typeof window === 'undefined'` to block instantiation if imported or run inside client bundles.

---

## 3. Production PostgreSQL & Supabase Setup

When deploying database migrations in production:

1. **Migration-Driven**: All structural updates and grants must be driven via migrations (`supabase db push`). No manual SQL client modifications.
2. **Schema Hardening**:
   - Schema `private` holds RLS resolver functions and is inaccessible to the `anon` role.
   - All `public` tables enforce Row-Level Security (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ... FORCE ROW LEVEL SECURITY`).
3. **Audit Log Immutability**: The `trigger_prevent_audit_log_modification` trigger blocks any user-level attempts to modify or delete logs under `public.audit_logs`.

---

## 4. Worker Runtime

The background workers (draft worker, WhatsApp worker) run via `tsx` (npx tsx), which handles ESM syntax in CJS mode. The worker app (`apps/worker/package.json`) must NOT have `"type": "module"` set, as the 8 internal packages are CommonJS and Node's ESM loader cannot do named imports from CJS modules. This was resolved in PR #10 (Aug 13, 2026).