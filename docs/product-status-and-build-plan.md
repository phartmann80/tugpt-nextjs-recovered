# TuGPT — Feature Status & Build Plan Against the Full Product Vision

**Date:** 2026-08-26 · **Evidence pinned to:** `main` @ `2ea2cc5` (PR #44)
**Authority:** ADR-015 (accepted 2026-08-25, in full, by the owner) + the approved product scope of the same date
**Standing rule:** this project is **not finished when the queue is empty**. It is finished when every item in §2 is live behind `is_feature_enabled` in production, per the Definition of Done in §1. Every status update from now on tracks against the item IDs in this document. Supersedes the draft at PR #45 (`docs/product-roadmap.md`), which can be closed when this lands.

**Item IDs:** `B1–B7` = your BUILT list · `N1–N19` = your NOT-BUILT list · `P1–P3` = prerequisites · `G1–G13` = items on neither of your lists (§4) · `M0–M11` = roadmap milestones (§5).

---

## 1. Definition of Done — per feature

A feature is **DONE** only when all ten base clauses hold. "Demoed once" is not done. "Merged" is not done. **LIVE** = done *and* switched on for at least one production org with monitoring evidence attached to the item ID in this file.

| # | Clause | What it means concretely |
|---|---|---|
| 1 | **Schema** | Migration(s) in `supabase/migrations/`; RLS enabled **and forced**; composite tenant FKs on the `(id, organization_id)` pattern so cross-tenant references are impossible at the storage layer (ADR-004, ADR-015 §3.2). No manual SQL in production — ever (`docs/server-migrations.md`). |
| 2 | **Gate** | Gated by `public.is_feature_enabled(org, key)` — global arming row (`false` by default) + per-org rows (ADR-010 AND semantics). **Never** gated by the in-memory `KILL_SWITCHES` map — that mechanism exists only for dual-enforcement kill switches like `whatsapp_integration` (ADR-015 D5, `packages/feature-flags/src/flags.ts` header). |
| 3 | **Quota / entitlement** | Org-scoped metering written by the feature itself: metric name, modality, units **and estimated cost**, per org / agent / feature (ADR-015 D5's four dimensions). Checked *before* execution, with a live quota period that has a real seeding path (see `P-pilot` correction). Until the entitlement layer exists (M2), each feature ships its own quota table on the `draft_quota_limits` model — never hardcoded limits. |
| 4 | **Provider** | Goes through a capability-routed adapter, not a bespoke HTTP call. D2 rule: **no capability with exactly one *possible* provider** — a second route must be at least designed and stubbed at integration time. Retries, visibility timeout, typed dead-letter with provider detail via the PGMQ contract (ADR-007/014). Idempotency key per action. |
| 5 | **Trust state** | Default trust state declared per (org, agent, tool class) — `draft_review` unless explicitly graduated (ADR-015 D3). Anything irreversible (outbound send, payment, campaign) additionally dual-enforced: code-side kill switch **and** DB row, flipped only with owner approval. |
| 6 | **Audit** | Every effect and every review writes `audit_logs` / a domain event with `created_by_type` attribution (the `ai_draft_review_events` model, generalized). Failures persist `provider_error_detail`-equivalent evidence. |
| 7 | **Tests** | Unit + integration (Vitest), pgTAP for every RPC/RLS policy, extension of the E2E harness where a pipeline crosses services, and doc-drift tests where a runbook names codes/tables. CI green: lint, typecheck, test, build, database-tests, docker-build + worker boot. |
| 8 | **UI** | Dashboard surface reachable from the app shell navigation (no URL-typing features). Customer-facing strings considered in es/en/pt from the first PR, not retrofitted. |
| 9 | **Docs** | README + relevant ADR + runbook updated; `.env.example` updated for any new variable **with exact names the code reads**; a `controlled-rollout.md`-style procedure (arm → enable one org → watch → kill switch) exists **before** the flag exists. |
| 10 | **Rollout evidence** | The item's row in this document updated with: flag rows created, first pilot org enabled, monitoring query output, and the date. No item is marked LIVE on anyone's word — only on evidence. |

**Per-feature addenda** (clauses that apply on top of the base ten):

| Feature | Additional done-means |
|---|---|
| Command Center / inbox (N1) | `needs_human` is written by real code paths; assignment + notification work for ≥2 reviewers; handoff carries a structured reason (D4). |
| Outbound anything (N1, N19, media delivery) | Owner approval recorded **per the standing directive**, two-key enforcement verified, zero-test-org outbound assertions in the E2E harness. |
| Voice agent (N4) | Real calls answered in es/en/pt end-to-end; transfer to a human verified; call + transcript rows created under RLS; second voice provider route designed (D2). |
| Follow-ups (N5) | Aggressiveness knobs owner-controlled per org; a customer reply cancels the pending sequence (D10 cancellation semantics) — tested. |
| CRM / pipeline (N6, N7) | Contact entity is the single identity; dedupe rule tested; HubSpot connector syncs both ways without leaving the tenancy boundary for hot-path reads (D6). |
| Appointments (N8) | Double-booking impossible under queue redelivery (idempotency test); reminders cancellable. |
| Payments/invoices (N9) | Idempotent link creation; reconciliation story for Ecuador bank transfer written down; collections agent never autonomous on payment demands without per-org owner signature (ADR-015 §5.2). |
| Campaigns (N19) | Opt-in state enforced in code (not just UI); throttling + Meta quality-rating monitoring wired; auto-pause tested against a simulated rating drop. |
| Image / doczip / video (N13–N15) | Cost metering live before first org enablement (video especially — ADR-015 §5.2 warns a generous free tier is dangerous). |
| Employees / automation (N2, N10) | Manifests validated against the tool registry at publish time (D7 guardrail); one registry serves both (§1.2 of ADR-015). |

---

## 2. Status

### 2.1 Your BUILT list — confirmed, with three corrections

| ID | Item | State | Evidence | Notes / corrections |
|---|---|---|---|---|
| B1 | Multi-tenant orgs, auth, RLS | **DONE (platform)** | ADR-002/003/004/005; `20260716000001_initial_schema.sql`; PR #1; pgTAP suite (~360 assertions, in CI since PR #26) | Accurate. Caveats: org **invitations** exist as table + RPC + pgTAP but have zero callers (`initial_schema.sql:73-124,245+`) — wiring is `G4`. No signup path (`G5`). |
| B2 | WhatsApp inbound pipeline (webhook → queue → worker) | **DONE (code), never served traffic** | PR #3; ADR-011/014; migrations `20260804000002–14`; worker `apps/worker/src/process-message.ts` | Accurate, and stronger than you said: the webhook is **doubly off** — hardcoded `KILL_SWITCHES.whatsapp_integration = false` returns 404 before Meta ever reaches the pipeline (`apps/web/src/app/api/v1/webhooks/whatsapp/route.ts:16,34`). Proven only by tests + the E2E harness, never by a real message. |
| B3 | AI draft generation via Langdock, retries + quotas | **DONE (code), pilot blocked** | PRs #4/#5/#15/#19/#21/#23; ADR-006; migrations `20260805000001–18`; `apps/worker/src/draft-worker.ts` | One correction, and it changes your next deliverable — see §3, `P3`: the quota system **cannot pass for any real org today**. Nothing in production writes `draft_quota_limits`. Retries/backoff/dead-letter: real. |
| B4 | Feature-flag system, global + per-org (post-#39) | **DONE** | ADR-010 + amendment (PR #22); `is_feature_enabled` RPC (`20260805000013`); PR #39 cleanup; `packages/feature-flags/src/flags.ts` | Accurate. Post-#39/#40 the in-memory service is exactly one key (`whatsapp_integration`) with tests that fail if a key is added or defaults true. Note `seed.sql:24-30` still seeds four stale `global_*` rows, all `true`, for keys nothing reads (`G12`). |
| B5 | Dashboard shell + API v1, observability/audit | **PARTIAL** | API v1: `apps/web/src/app/api/v1/**` (auth/session, drafts, orgs, health, webhook; ADR-008). Observability: `packages/observability` (ADR-009, PR #2). UI: `apps/web/src/app/dashboard/drafts/**` | Correction: there is **no shell**. One surface exists — the draft reviewer inbox + detail. No nav, no `/dashboard` index, no header (`G1`); the root `/` just redirects to the inbox (PR #30). No screen displays the stored conversation messages (`G2`). |
| B6 | Deploy pipeline, CI with boot checks, E2E harness | **DONE** | PRs #13/#14 (compose+VPS, ADR-013), #18 (E2E harness + runbook), #20 (migration preflight), #26 (pgTAP in CI), #28–#36 (proxy, certs, checklists), #41–#44 (worker tsx hotfix, runbook rewrite, dist builds + worker image boot in CI, tugpt.service owns Caddy) | Accurate — this is the hardest-built part of the repo. |
| B7 | ADR-015 accepted; #39/#40 follow-through | **DONE (decisions)** | PR #38 (ADR-015 + schema audit), #39 (flag reduction), #40 (`packages/jobs/src/types.ts` deleted; ADR-014 open question closed) | Accurate. ADR-015 is the scope of record and this document tracks it item for item. |

**Net correction to your baseline:** the platform list is right, but the product built on top of it is **one workflow** (inbound message → AI draft → human approve) with **zero production users** and **no outbound path anywhere**. Your NOT-BUILT list is correct and complete — nothing there is secretly built.

### 2.2 Your NOT-BUILT list — all 19, accounted for

| ID | Item | State | Evidence of absence / what counts toward it |
|---|---|---|---|
| N1 | WhatsApp Command Center / unified inbox (human + AI, handoff primary) | **NOT STARTED** (~10% ancestral) | The drafts inbox is the only conversation surface; it shows drafts, not threads. `conversations.status` allows `'needs_human'` but **no production code writes it** (only type reads at `apps/web/src/lib/draft-api/service.ts:317`); no assignee column (ADR-015 §3.1 #12). = G2 + G9 + M4. |
| N2 | AI Agent Builder | **NOT STARTED** | No agent entity at all — one persona per org forced by `UNIQUE(organization_id)` on `business_profiles` and `UNIQUE(business_profile_id)` on `ai_draft_configs` (ADR-015 §3.1 #1–2). The builder is data-driven manifests (D7) on the agent entity from M3. |
| N3 | Action-based AI agents (ADR-015 action primitive) | **DESIGNED, NOT STARTED** | ADR-015 D1 accepted in full. Zero code: no tool registry, no agent loop, no action audit. The one primitive everything else is an adapter onto. = M3. |
| N4 | AI Voice Agent (IONOS; ES/EN/PT; transfers; CRM records) | **NOT STARTED** | Zero code references to IONOS in `apps/`+`packages/`; `IONOS_API_KEY` present-but-empty on the server (`docs/production_environment.md:23`). No call/transcript entity. = M8, after capability contract + CRM. |
| N5 | AI Follow-Up Engine | **NOT STARTED** | No deferred execution exists — both production `pgmq.send` calls pass delay `0` (ADR-015 §3.1 #8). No sequence/rule tables. = M6, needs scheduler (M3) + CRM (M5). |
| N6 | CRM (hybrid position approved — D6) | **NOT STARTED** | No contact entity: a customer is `conversations.contact_phone TEXT`, unique only per (org, connection, phone) (`20260804000005:8,22-24`). Same person on two numbers = two rows (§3.1 #9). HubSpot: `HUBSPOT_API_KEY` in env, zero readers. = M5. |
| N7 | Sales pipeline | **NOT STARTED** | No deal/stage/activity tables anywhere. = M10, on CRM core. |
| N8 | Appointments / scheduling | **NOT STARTED** | No calendar entity; the last trace (`appointment.send_reminder` in `JobType`) was **deleted** in PR #40 as dead code. = M5 (capability) + M6 (Employee). |
| N9 | Invoices, billing, payments | **NOT STARTED** | `invoice.generate_pdf` existed only as a dead `JobType` literal, deleted PR #40. = M9, deliberately late. |
| N10 | Automation builder (When/If/Then) | **NOT STARTED** | Nothing. Shares the tool registry with Employees (ADR-015 §1.2) — cannot start before M3. = M6. |
| N11 | Analytics / insights | **NOT STARTED** (raw material exists) | Audit logs + usage tracking + job outcomes are logged but nothing aggregates them; no dashboard beyond drafts. = M10. |
| N12 | Knowledge base | **NOT STARTED** | Nothing; pgvector not in any migration. = M5 (D9: owned, pgvector, `knowledge.search` tool). |
| N13 | Document generator (PDF/zip) | **NOT STARTED (credentials only)** | `LANGDOCK_DOCZIP_*` on the server, **no code reads the names** (`docs/production_environment.md:25`). See §7 — smallest slice together with N14. |
| N14 | Image generator | **NOT STARTED (credentials only)** | `LANGDOCK_IMAGE_*` same status (`production_environment.md:24`). Owner confirms provider side works. See §7. |
| N15 | Video generator | **NOT STARTED (no provider either)** | Nothing in repo; ADR-015 names HeyGen (MCP account held) as one route and requires an open-source second route. Options + recommendation in §6. |
| N16 | Multi-model AI routing (AI Router) | **PARTIAL (~10%)** | Precursor exists: Langdock **model** rotation over a 4-model allowlist (`packages/ai-providers/src/langdock-rotation.ts`, PR #23). That is one route's internal strategy, not the Router: no capability negotiation (`AIProviderAdapter` = one method returning `text: string`, ADR-015 §3.1 #5), no modality/cost/entitlement routing. = M3. |
| N17 | Marketplace / integrations + customer-facing API | **NOT STARTED** | No credential vault (no table can hold a third-party token — §3.1/D8), no connector framework, no public API. = M11 on M3+M5. |
| N18 | Multi-number per org, seats, tier entitlements | **PARTIAL** | Multiple numbers: `whatsapp_connections` already has no `UNIQUE(organization_id)` (ADR-015 §3.2) — but every number must share one persona until the agent entity exists (collisions #1–3). Seats: invitations built-but-unwired (`G4`). Tier entitlements: boolean flags only; `minimumPlan`/`rolloutPercentage` declared, never read (§3.1 #7). = M2 (entitlements, roles) + M3 (agent entity) + M4 (per-number binding). |
| N19 | WhatsApp campaign manager (compliance-first) | **NOT STARTED** | Nothing; also blocked on outbound (owner gate) and scheduler. = M11, compliance design before code (ADR-015 §5.2). |

### 2.3 Prerequisites — your three, verified, plus one correction

| ID | Item | State | Notes |
|---|---|---|---|
| P1 | Customer/contact entity | **NOT STARTED** | Confirmed: 13 schema collisions documented (ADR-015 §3.1, audited at `3fa63d0` in PR #38). Highest-leverage item in the repo — N1, N4–N9, N17, N18 all resolve to "a thing we can attach facts to." Scheduled first in M2/M3. |
| P2 | ADR-015 action primitive | **DESIGNED, NOT STARTED** | D1–D10 accepted as binding. Build once in M3 or get fourteen half-agents — your words, and the ADR's. |
| P3 | Draft pilot (flag flip, 2–3 orgs) | **BLOCKED — correction below** | |

**⚠ The correction that changes your next step.** You named the pilot flag flip as a next deliverable. **It will not work today, and the failure mode is total.**
`reserve_draft_usage` resolves the active quota period (`20260805000015_create_draft_generation_rpcs.sql:73-84`) and returns `DENIED / NO_ACTIVE_QUOTA_PERIOD` when no `draft_quota_limits` row covers `CURRENT_DATE` (surfaces to the operator as `skip_reason = 'QUOTA_DENIED'` — `docs/controlled-rollout.md` §5). **Nothing in production ever writes that table.** The only writer in the repository is the E2E harness seeding its own test org (`apps/worker/src/e2e/milestone1.ts:449`). There is no insert in any of the 38 migrations, no admin UI, no API route, no onboarding step, no rollover job. Flip day as currently sequenced: flag true → job claimed → quota denied → **every job for every pilot org skips, immediately, with zero partial success**. Fails closed and loud — but proves nothing. M0.1 exists to fix this and it is small. **The pilot flag flip is deliverable #2 only after M0.1 ships.**

---

## 3. Where the effort actually is

| Area | Built | Remaining |
|---|---|---|
| Delivery machinery (CI, deploy, tests, runbooks) | ~95% | maintenance |
| Tenancy foundations (orgs, auth, RLS) | ~70% | invitations wiring, signup, entitlements, roles |
| The one workflow (inbound → draft → review) | ~85% | quota lifecycle, thread view, media |
| Everything else on the vision (19 items) | **~2%** | ~everything (one provider-credentials-only, one 10% precursor) |

The 2% is a statement about the denominator, not about quality: what is built is built to a standard the rest of this plan deliberately reuses (composite-FK tenancy, typed dead letters, doc-drift tests, AND-semantics flags).

---

## 4. Items on neither of your lists (G1–G13)

Thirteen gaps the vision requires that appear in neither your BUILT nor your NOT-BUILT column. Three are blockers for things you did list.

| ID | Item | Why it matters | State | Effort |
|---|---|---|---|---|
| G1 | **App shell + navigation** | No header/sidebar/nav; `/dashboard` has no index; both real pages are URL-typed (PR #30 points `/` at the inbox as a stopgap). Every feature below adds a page — there is nowhere to put it. | NOT STARTED | 4 ed |
| G2 | **Conversation thread view** | The pipeline has stored `messages` rows since August; **no screen displays them**. A reviewer approving a draft cannot see what the customer said before the trigger message. Arguably a defect in shipped functionality, not a missing feature. | NOT STARTED | 5 ed |
| G3 | **Quota period lifecycle** | §2.3 P3. Blocks the pilot. | NOT STARTED | 3 ed |
| G4 | **Organization invitation wiring** | Table, RPC (`private.accept_invitation`), RLS and pgTAP all exist (`initial_schema.sql:73-124,245+`); zero callers, and the RPC is absent from the generated `Database['public']['Functions']` map. N18 "seats" cannot start until someone can be invited. | NOT STARTED (wiring, not building) | 2 ed |
| G5 | **Signup / onboarding** | Orgs are created by RPC/SQL by us. There is no path from "a business wants TuGPT" to "a usable org" that doesn't involve an operator. | NOT STARTED | 5 ed |
| G6 | **Scheduler substrate** | Nothing can fire later (delay `0` everywhere; visibility timeout is retry backoff, not scheduling). Independently blocks N5, N8, N9, N19 and most of N10. Build once (D10): cancellable, per-org, rate-governed. | NOT STARTED | 6 ed |
| G7 | **Token & cost metering** | Quota counts *requests* (`draft_count` vs `hard_ceiling`, no metric/resource dimension — §3.1 #6). Images, voice and video are priced per unit at wildly different rates; a request counter cannot express any sellable tier. D5 requires cost, not just count, from the first tool. | NOT STARTED | 5 ed |
| G8 | **Per-org credential vault** | No table can hold a customer's HubSpot token or BYO key (WhatsApp secrets are env vars today). N17 is impossible without it; needs its own threat model **before** it is built, not after (D8, post-2026-08-24). | NOT STARTED | 5 ed |
| G9 | **Handoff + assignment** | `'needs_human'` is typed all the way to the API layer and never written by production code; no assignee, no notification. N1 stops working at about two reviewers without it. | NOT STARTED | 4 ed |
| G10 | **Media message handling** | Message kind is validated at ingest, then discarded with the staging row; `messages.body TEXT ≤ 4096`, no kind/media columns (§3.1 #10). An image and a text are indistinguishable once stored — blocks media in the inbox and media *delivery* for N13/N14/N15. | NOT STARTED | 3 ed |
| G11 | **Portuguese as a first-class locale** | ES/EN/PT is a cross-cutting promise (voice especially). `profiles.preferred_locale TEXT DEFAULT 'es'` has **no CHECK constraint** while the TS type narrows to `'es' \| 'en'` — PT is not representable in a validated way today (ADR-015 §4.1). Fix early; retrofit is expensive. | NOT STARTED | 1 ed |
| G12 | **Seed + README drift** | (1) `README.md:15,82,172` still says Langdock uses `auto` model routing — verified false against the live API 2026-08-19 (HTTP 400; `.env.example` says the same). The README is where a new engineer starts. (2) `seed.sql:24-30` seeds four `global_*` flag rows, all `true`, for keys nothing reads, shadowing real capability names — while neither key the code actually queries appears there. | Doc fixes | 1 ed |
| G13 | **Landing page** | `/` is a redirect classified `public` (`apps/web/src/app/page.tsx`). Whatever a prospective customer (or a passer-by) should see doesn't exist. Needed before any go-to-market, not before the pilot. | NOT STARTED | 3 ed |

---

## 5. The roadmap — dependency-ordered, all items

Effort in **engineer-days (ed)**, ±40%, calibrated against what this repo has actually shipped at its current standard (the draft-review workflow ≈ 18 ed end-to-end; each item below is costed to meet all ten DoD clauses). **ed ≠ calendar days** for a solo builder; treat 5 ed ≈ 1 calendar week realistically given review, deploy, and pilot-monitoring overhead.

```
M0 pilot unblock ──► M1 usable product ──► M2 tenancy & money rails ──► M3 action primitive + Router
                                                                              │
                                              ┌───────────────────────────────┼──────────────────────────────┐
                                              ▼                               ▼                              ▼
                                        M4 inbox + outbound (🔒)        M5 CRM · KB · calendar        M7 content gen (img, doc, video)
                                              │                               │                              │
                                              ▼                               ▼                              ▼
                                        M6 employees · builder · follow-ups ──► M8 voice ──► M9 money ──► M10 pipeline + insights
                                                                                                             │
                                                                                                             ▼
                                                                                                      M11 campaigns · marketplace · API
```

### M0 — Unblock the pilot · **6 ed** · nothing else starts first
| # | Item | ed | Covers |
|---|---|---|---|
| M0.1 | Quota period lifecycle: seeding path (migration/SQL procedure + smallest admin surface), period-rollover decision, pgTAP guard that fails if an org can be flag-enabled without a covering period | 3 | G3 → unblocks P3 |
| M0.2 | Pilot execution per `docs/controlled-rollout.md`: arm global, enable 2–3 orgs one at a time, ≥1 business-day monitoring each, review-quality check (§5 queries), evidence into this doc | 2 | **P3 — your deliverable #2** |
| M0.3 | G12 doc drift fixes (README auto-routing, seed.sql decision — seed change needs its own tiny PR) | 1 | G12 |

### M1 — Make the one workflow a usable product · **14 ed**
| # | Item | ed | Covers |
|---|---|---|---|
| M1.1 | App shell + navigation (layout, sidebar, `/dashboard` index; route classification updates + proxy tests) | 4 | G1 |
| M1.2 | Conversation thread view in the draft review context (messages rendered under RLS) | 5 | G2, first half of N1 |
| M1.3 | Org invitation wiring: send-invitation UI + accept route + RPC exposed in the type map | 2 | G4 |
| M1.4 | E2E harness extension to cover shell + thread view + invitations; reviewer UX polish from pilot findings | 3 | — |

### M2 — Tenancy & commercial rails (Tier-1 foundations, part 1) · **30 ed**
| # | Item | ed | Covers |
|---|---|---|---|
| M2.1 | **Contact entity**: `contacts` table (composite-FK pattern), conversation linkage, dedupe rule, backfill from `contact_phone`, locale+CHECK (es/en/pt) on the contact | 6 | **P1**, G11, unblocks N1/N4–N9/N17/N18 |
| M2.2 | Entitlements + metering layer: per (org, agent, feature, modality) usage with **cost** dimension; plan definitions; quota seeding rides this from now on | 8 | G7, N18 (tiers) |
| M2.3 | Workspace roles as data, not ENUM (Sales/Support/Admin; migration off `organization_role`) | 4 | N18, §3.1 #11 |
| M2.4 | Signup/onboarding: self-serve org creation, first user, WhatsApp connection wizard skeleton | 5 | G5 |
| M2.5 | Credential vault: encrypted per-org connected accounts (pgcrypto), threat model doc **first**, scopes | 5 | G8, unblocks N17 |
| M2.6 | Media message handling: `kind`/media columns, ingest persistence, retrieval | 2 | G10 |

### M3 — The action primitive + capability contract + Router (Tier 1, part 2) · **45 ed** · *the architectural centre of gravity*
| # | Item | ed | Covers |
|---|---|---|---|
| M3.1 | Capability-based provider contract (the ADR-006-mandated review, executed): capability negotiation supersedes `AIProviderAdapter`'s single `text` method | 8 | N16, §3.1 #5 |
| M3.2 | AI Router v1: (modality, task, org, entitlement, policy) → route; Langdock text+rotation becomes one route; cost-aware selection | 6 | **N16** |
| M3.3 | Agent entity + multi-agent per org: lift collisions #1–3, deterministic per-number routing, agent row + manifest columns | 6 | N2 (foundation), N18 (per-number persona) |
| M3.4 | **Tool registry + agent loop + action audit** (D1): named/versioned/typed tools, permission classes, idempotency keys, per-tool audit; the draft pipeline refactored as the first agent (`draft_review` trust state, one tool) | 12 | **N3, P2** |
| M3.5 | Trust graduation model: per (org, agent, tool-class) states + per-org kill switch (D3) | 4 | gates everything autonomous |
| M3.6 | Scheduler substrate: durable, cancellable, tenant-scoped, rate-governed scheduled actions on PGMQ (D10) | 6 | G6, unblocks N5/N8/N9/N19/N10 |
| M3.7 | Handoff state + assignment + `handoff.escalate` tool (D4) | 3 | G9, unblocks N1 |

### M4 — Command Center: unified inbox + outbound · **18 ed** · **🔒 owner gate on outbound**
| # | Item | ed | Covers |
|---|---|---|---|
| M4.1 | Unified inbox UI: human + AI conversations, filters, assignment, handoff queue with structured reasons, thread view promoted to first-class | 10 | **N1**, G2/G9 |
| M4.2 | Outbound messaging as a tool (`messaging.send`): two-key enforcement, per-message audit, rate limits, template handling | 6 | unblocks everything that talks back |
| M4.3 | Per-number agent binding live; multiple numbers per org end-to-end | 2 | N18 |

### M5 — CRM core, knowledge base, calendar (Tier 2) · **31 ed**
| # | Item | ed | Covers |
|---|---|---|---|
| M5.1 | Owned CRM core: contacts UI, deals, pipeline stages, activities — thin, AI-hot-path-owned (D6) | 12 | **N6** |
| M5.2 | Knowledge base: pgvector under RLS, ingestion, `knowledge.search` tool (D9) | 8 | **N12** |
| M5.3 | Calendar capability + Google/Outlook connectors over `calendar.read/write` (made capability, integrated vendors) | 8 | N8 (capability half) |
| M5.4 | Conversation memory / multi-turn context in the agent loop | 3 | §3.1 #4 |

### M6 — Employees, Agent Builder, automation, follow-ups (Tier 3) · **40 ed**
| # | Item | ed | Covers |
|---|---|---|---|
| M6.1 | Employee manifests + runtime packaging: first hires Customer Support, Receptionist, Appointment Manager (D7, publish-time validation) | 12 | N2 (product form) |
| M6.2 | AI Agent Builder UI: create/fork/edit manifests, tool allowlists, guardrails | 10 | **N2** |
| M6.3 | Automation builder (When/If/Then) over the same registry | 10 | **N10** |
| M6.4 | Follow-up engine: rule-based sequences, owner aggressiveness controls, reply-cancels-sequence | 8 | **N5** |

### M7 — Content generation: image, documents, video (Tier 3/4) · **20 ed + video decision**
| # | Item | ed | Covers |
|---|---|---|---|
| M7.1 | **Image generator** — first customer of the capability contract: `image.generate` route (Langdock agent, exact `LANGDOCK_IMAGE_*` names), flag, metering+cost, Supabase Storage, dashboard page; delivery via WhatsApp only after M4.2 | 5 | **N14** (see §7) |
| M7.2 | **Document generator** — doczip agent adapter (exact `LANGDOCK_DOCZIP_*` names), `doc.generate` capability, zip/PDF assembly, storage, download UI | 7 | **N13** (see §7) |
| M7.3 | **Video generator** — routed capability per §6 recommendation: hosted open-model route + HeyGen avatar route; self-hosted route when volume justifies; metering from clip one | 8 | **N15** (see §6) |

### M8 — Voice agent (Tier 4) · **25 ed**
| # | Item | ed | Covers |
|---|---|---|---|
| M8.1 | Call + transcript entities, `voice.*` capability on the Router, IONOS adapter + one designed second route (D2) | 10 | **N4** |
| M8.2 | Call handling: answer, ES/EN/PT (voice is where PT must be real, §4.1), book/cancel via calendar, qualify, take messages, transfer, CRM record creation | 15 | **N4** |

### M9 — Money (Tier 4) · **30 ed** · deliberately late; strictest trust states
| # | Item | ed | Covers |
|---|---|---|---|
| M9.1 | Invoicing + payment links/cards via integrated providers (per-country, capability-shaped) | 12 | **N9** |
| M9.2 | Bank-transfer path incl. Ecuador reconciliation tooling | 10 | **N9** |
| M9.3 | Billing Assistant + Collections Agent manifests — **last**, never autonomous on payment demands without per-org owner signature (§5.2) | 8 | N9 |

### M10 — Sales pipeline + analytics (Tier 3) · **15 ed**
| # | Item | ed | Covers |
|---|---|---|---|
| M10.1 | Pipeline UI + sales dashboard on CRM stages | 8 | **N7** |
| M10.2 | Insights layer: aggregation over audit/usage/conversation data into owner-facing analytics | 7 | **N11** |

### M11 — Campaigns, marketplace, public API (Tier 5) · **36 ed**
| # | Item | ed | Covers |
|---|---|---|---|
| M11.1 | Campaign manager: template management, **opt-in enforced in code**, throttling, quality-rating monitoring, auto-pause; compliance design reviewed before code (§5.2) | 14 | **N19** |
| M11.2 | Marketplace: connector framework live + HubSpot bi-directional sync, then Shopify/WooCommerce/Stripe/PayPal/Sheets/Excel/Zapier/Make/Slack/Facebook/Instagram/Gmail | 12 | **N17** |
| M11.3 | Customer-facing TuGPT API (Pro tier) on the registry contract; developer capability via the API later | 10 | **N17** |

### Totals and honest math

| Milestone | ed | | Milestone | ed |
|---|---|---|---|---|
| M0 | 6 | | M7 | 20 |
| M1 | 14 | | M8 | 25 |
| M2 | 30 | | M9 | 30 |
| M3 | 45 | | M10 | 15 |
| M4 | 18 | | M11 | 36 |
| M5 | 31 | | M6 | 40 |
| | | | **Total** | **310 ed** |

±40%. At the current standard (every item passing all ten DoD clauses): **one engineer ≈ 14–15 months**; two ≈ 7–8; three ≈ 5–6 — and M0–M1 are calendar-bound as much as effort-bound (pilot monitoring windows are days, not points). The single biggest schedule risk is starting at M7/M8 because the demos are visible there — a voice agent built before the tool layer is a demo that has to be rebuilt (ADR-015 §5.2). The dependency edges above are the schedule.

**Owner gates (decisions only you can make, marked where they bite):** 🔒 M4.2 outbound enablement (standing directive — two keys); M7.3 video vendor mix (§6); M9.3 collections autonomy (per-org, signed); M11.1 campaign compliance sign-off; pricing/tiers when M2.2 lands.

---

## 6. Video generation — options and recommendation

**Constraint set:** ADR-015 D2 (no single possible provider; pluggable is a requirement, not a preference); §5.2 (video economics — a generous free tier is genuinely dangerous); your decision that an open-source pipeline is acceptable; the VPS (`212.227.44.13`) has **no GPU**, so "self-hosted" never means "on the VPS". Landscape as of 2026-08:

**Option A — self-hosted open-source pipeline.** LTX-2/2.3 (open-sourced Jan 2026; native audio, up to 4K/50fps) runs 720p on a 24–32 GB GPU (RTX 4090/5090); ~5–8 min per 5 s clip; marginal cost ≈ **$0.06–0.10/clip** on a ~$0.76/hr rented 5090. Higher tiers: Wan 2.2 I2V (~40 GB+, H100 ≈ $2.0–2.5/hr, ≈ $0.40–0.48/clip) and HunyuanVideo 1.5 (H200-class, best open quality, ≈ $0.74–1.11/clip). Hosting shape: on-demand GPU node (RunPod/Vast/Spheron-class) or an owned workstation; a `video-worker` service consuming a `video_generation` PGMQ queue under the existing retry/dead-letter contract; ComfyUI or a thin diffusers container; output to object storage. **Costs:** cheapest per clip at utilisation, but fixed ops — CUDA/driver drift, model churn, quantization wrangling; realistically 8–12 ed to productionize plus ongoing maintenance, and 3–4× slower time-to-first-clip than B.

**Option B — hosted inference of open models (API service).** fal.ai / Replicate-class: open + frontier models behind one API, per-second billing — Wan-class ≈ **$0.05/s (480p) – $0.10/s (720p)** (≈ $0.25–0.50 per 5 s 720p clip), Kling-class ≈ $0.07/s, Veo-class ≈ $0.40+/s. Zero GPU ops; an adapter + queue + storage + UI is ~4–6 ed. Costs scale linearly with usage; no fixed infrastructure; no cold-start.

**Option C — closed avatar API.** HeyGen — account and MCP access already held (ADR-015 §4.4): ≈ **$0.017–0.067/s** for avatar video, ~$1–4/min; the strongest route for talking-head/presenter content specifically; real lock-in, which is exactly why D2 forbids it being the only route.

**Recommendation: B + C now, A when volume justifies — and always behind one routed capability.**
1. Build `video.generate` as a Router capability (M7.3) with two routes from day one: **hosted open-model route (B) as the default** for generative clips and **HeyGen (C) as the avatar route**. That satisfies D2 immediately, ships in weeks not months, and keeps per-unit costs honest and metered.
2. Add the **self-hosted LTX-2.3 route (A) on a rented 5090-class node** as the third route when monthly volume makes it pay: at ~6 clips/hr on a $0.76/hr node (~$0.13/clip all-in) vs ~$0.50/clip hosted, the ops overhead breaks even somewhere around **150–300 clips/month** — revisit at M10/M11 when real usage data exists, not before.
3. **Do not** put video on the free tier beyond a hard, metered clip count; ADR-015 §5.2 is right that this is the one modality where generosity is dangerous. Queue-native async fits the existing PGMQ contract; the only new infrastructure is object storage (shared with M7.1/M7.2) and, later, the GPU node.

## 7. Image + doczip — confirmation and placement

**Confirmed: these are the two smallest slices in the entire not-built list**, because the provider side already works and the credentials are already seated server-side under exact names (`LANGDOCK_IMAGE_*`, `LANGDOCK_DOCZIP_*` — `docs/production_environment.md:24-25`, owner-confirmed working provider-side). The remaining work is pure TuGPT: adapter, capability route, flag, quota, storage, UI, docs — the full ten-clause DoD, but on a proven provider.

Three non-negotiables, so the smallness doesn't breed shortcuts:
1. **They must not be wired onto today's `AIProviderAdapter`** — it cannot express binary output (one method, `text: string`), and its own header forbids expanding it without the capability review. They are the **first two customers of M3.1's capability contract** (`image.generate`, `doc.generate`), which makes them the cheapest possible validation of the contract before voice/video lean on it.
2. **They gate through `is_feature_enabled`** with fresh DB flag keys — *not* the removed in-memory `image_generation` key (PR #39 deleted it deliberately; recreating it is reverting a recorded decision).
3. **Delivery is split from generation.** Storage + dashboard download ships in M7; WhatsApp media delivery waits for M4.2 (owner-gated outbound). Generation without delivery is still useful (owner downloads and sends manually) and keeps the outbound gate clean.

**Placement: M7.1 (image, 5 ed) then M7.2 (doczip, 7 ed)** — image first because it is one modality with no assembly step; doczip adds file assembly, storage layout and download UX. If you want one of them earlier as a capability-contract pilot, pull **M7.1 into late M3** — nothing else in M7 has that option.

---

## 8. Keeping this document honest

- This file is the tracking instrument. Every status update references item IDs (`M3.4 done`, `N5 partial: sequences + cancellation live, UI pending`) — never free-form "done" claims.
- An item moves NOT STARTED → PARTIAL → DONE → **LIVE** only with evidence appended (flag rows, first pilot org, monitoring output, date) per DoD clause 10.
- PRs state which item ID they advance. "Finished" in any update means "meets §1", nothing else.
- The doc is re-pinned to `main` each time the evidence commit moves; ADR-015 §3's point-in-time audit is re-verified against the new pin when a collision row is deliberately lifted.
- Per the standing rule: the project is done when every N-item is **LIVE** — not when the current queue is empty, and not before.
