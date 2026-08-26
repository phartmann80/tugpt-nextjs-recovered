# TuGPT — Product Status and Build Plan

**Date:** 2026-08-26
**Repo state this document is pinned to:** `main` @ `2ea2cc5`
**Counts at that commit:** 38 migrations, 21 tables, 20 pgTAP files, 11 API routes, 6 pages, 5 UI components.

This is the document every future status update tracks against. It exists because
"TuGPT is 95–98% complete" was true of one workflow and false of the product. The
numbers below are the honest ones.

---

## How to read this

Three states, and only three:

| State | Means |
|---|---|
| **DONE** | Meets the Definition of Done in §1. Nothing outstanding. |
| **PARTIAL** | Real code exists and works, but it fails at least one DoD clause. The failing clause is named. |
| **NOT STARTED** | No production code. Design, schema fragments, or credentials may exist; they are noted but they do not move the state. |

Every claim carries a `file:line` or migration reference. Where I am correcting your
baseline, the correction is marked **⚠ CORRECTION** and the evidence is the first
thing in the row.

One thing to get out of the way before the tables, because it reframes everything
else: **the full vision is roughly 12–15 engineer-months of work from here.** Not
weeks. The delivery machinery is excellent and the foundations are real, but the
built surface is one workflow (draft review) out of roughly twenty-eight, and
several of the unbuilt ones are large. §5 breaks that down. I would rather you
have that number now than discover it in October.

---

## 1. Definition of Done

You asked for this so that "finished" means the same thing to both of us. A feature
is DONE when **all seven** clauses hold. Anything less is PARTIAL, and I will say
which clause failed.

| # | Clause | Why it is on the list |
|---|---|---|
| **D1** | **Gated by `is_feature_enabled(org_id, key)`** — a real per-org flag row, global AND org, per `packages/feature-flags/src/flags.ts:6-13`. Never a constant in `KILL_SWITCHES`; that file is a kill switch, not a flag system, and `flags.test.ts:63` fails if a key is added. | ADR-015 D5, and the row-13 finding. A capability gated by a build-time constant ships on for everyone and is changeable only by deploy. |
| **D2** | **Org-scoped quota with a cost dimension** — a limit row exists, a reservation path exists, and exhaustion denies rather than degrades. For anything with a per-unit provider price, the quota counts money or tokens, not just requests. | Every remaining feature has a cost profile that request-counting cannot express. See §3-F. |
| **D3** | **RLS proven, not assumed** — org isolation enforced at the table, and a pgTAP test that fails if the policy is dropped. Cross-org read attempts are covered. | 20 pgTAP files is the standard this repo already holds itself to. |
| **D4** | **Tests at three levels** — unit for the logic, pgTAP for the schema and RPCs, and one path through the real stack (E2E or an integration test that talks to a live Supabase). No feature is done on unit tests alone. | The 2026-08-25 crash-loop passed every unit test and every build. |
| **D5** | **Observable** — structured logs with request IDs through `@tugpt/observability`, provider/model/latency recorded where a provider is called, and failures land somewhere a human will look. | |
| **D6** | **Documented where the reader will be** — the runbook if it changes operations, an ADR if it changes architecture, `.env.example` if it adds a variable, and this file's status table updated in the same PR. | |
| **D7** | **Reachable by a user without typing a URL** — it is in the navigation, or it is not shipped. | `/dashboard` currently 404s; both real pages are reachable only by typing the full path. See §3-C. |

**Two standing exceptions**, both yours, both preserved:

- **Outbound customer messaging** is never DONE by engineering alone. `whatsapp_integration` keeps its dual enforcement — the DB row *and* the hardcoded `false` at `packages/feature-flags/src/flags.ts:57`. Flipping it is a deliberate code change plus your approval, not a database edit.
- **`supabase/seed.sql` is not to be modified.** The four `global_*` rows stay. §3-J records the defect in prose instead, which is the form you asked for.

---

## 2. Status: your list, item by item

### 2.1 What you had as BUILT AND LIVE

Four of your six are PARTIAL. One is DONE and I would rate it higher than you did.

| # | Item | State | Evidence |
|---|---|---|---|
| 1 | Multi-tenant orgs / auth / RLS | **PARTIAL** ⚠ | Orgs, membership, RLS and SSR auth are real and well tested. **But `accept_invitation` and `organization_invitations` have zero TypeScript callers** — grep across `apps/` and `packages/` returns only the type definition at `packages/database/src/types.ts:274` and a comment at `apps/worker/src/e2e/milestone1.ts:947`. The RPC is complete, RLS'd, and covered by pgTAP; nothing calls it. **Nobody can be added to an organization through the product.** There is also no signup path — orgs come into existence by RPC. Fails **D7**. |
| 2 | WhatsApp inbound pipeline (flag off) | **PARTIAL** ⚠ | Webhook → `inbound_message_staging` → PGMQ → worker → `conversations`/`messages` is real and running. **But `messages` has no media columns at all** — `20260804000006_create_messages.sql` is `body TEXT` and nothing else; grep for `media`/`attachment`/`image_url` across all 38 migrations returns zero. WhatsApp sends images, audio, documents and location. Today they are silently dropped. Also `conversations.contact_phone` is a raw `TEXT` (`20260804000005:8`) — no contact entity. Fails **D2** (no media, so no per-media cost path) and blocks items 19–21. |
| 3 | AI draft generation via Langdock (flag off) | **PARTIAL — and the pilot is blocked** ⚠⚠ | See §2.4. The pipeline is real. The flag flip will deny 100% of jobs. |
| 4 | Feature-flag system | **DONE** | `is_feature_enabled` ANDs global × org inside `COALESCE(..., false)`. Three production readers: `apps/web/src/lib/draft-api/feature-gate.ts:29`, `apps/worker/src/draft-worker.ts:392`, and the E2E harness. Kill switch reduced to one key in #39, with `flags.test.ts` failing on any addition. Caveat in §3-J, which is documentation, not code. |
| 5 | Dashboard shell + API v1 + observability | **PARTIAL** ⚠ | 11 API routes and 5 components, all good. **But there is no navigation anywhere in the app** — no header, no sidebar, no nav component; `find apps/web -path "*components*"` returns five draft components and one test file. `/dashboard` has no `page.tsx`, so it 404s. There is no conversation list, no thread view, no settings, no team page, no numbers page, no billing, no analytics. It is a **draft-review tool**, not a dashboard. Calling it a "shell" overstates it — a shell implies something to hang features on, and there is nothing to hang them on yet. Fails **D7**. |
| 6 | Deploy pipeline / CI / E2E | **DONE** ⚠ (upgraded) | Four required checks — `build-and-test`, `docker-build`, `database-tests`, `deploy-scripts` — plus an approving review. The boot check added in #43 (`.github/scripts/worker-boot-check.sh`, 6 fixtures / 19 assertions) closes the gap that let the 2026-08-25 crash-loop through. Production is live and green. This is the strongest area of the project and the reason the rest is buildable at pace. |

### 2.2 What you had as NOT BUILT

Correct on 18 of 19. Three deserve a nuance.

| # | Item | State | Evidence / nuance |
|---|---|---|---|
| 7 | WhatsApp Command Center / unified inbox | **NOT STARTED** | `DraftInbox.tsx` lists *drafts*, not conversations. No route lists conversations; no thread view exists. The "Conversation" panel in `DraftDetail.tsx:214-222` is literally `<span>Status: {draft.conversation.status}</span>` — one line, and it is the status enum, not a message. |
| 8 | AI Agent Builder | **NOT STARTED** (foundation exists) ⚠ | `ai_draft_configs` is a per-org prompt config table — business instructions, personality, response rules, tone, max length — and `buildPromptMessages` consumes all five. That is roughly the data model for one agent with no tools. There is no UI to edit it, no concept of multiple agents, and no tools. Call it 15% of a foundation, 0% of the feature. |
| 9 | Action-based agents | **NOT STARTED** | `packages/ai-providers/src/adapter.ts:1-17` says it outright: the contract "intentionally does NOT yet define streaming, structured output, tool calls, embeddings, image/video generation, speech-to-text/text-to-speech, cancellation, retry policy, or usage/cost reporting." The header is accurate and it is the single biggest architectural gap on this list. |
| 10 | AI Voice Agent (IONOS) | **NOT STARTED** | Zero readers of `IONOS_*` anywhere in `apps/` or `packages/`. No STT, no TTS, no audio dependency. Confirms your read exactly. |
| 11 | Follow-Up Engine | **NOT STARTED** | Also blocked on something not on your list: **there is no scheduler.** Both production `pgmq.send` calls pass delay `0`. Nothing in TuGPT can currently make anything happen later. See §3-E. |
| 12 | CRM | **NOT STARTED** | Blocked on the contact entity (item 26). |
| 13 | Sales pipeline | **NOT STARTED** | Blocked on 12. |
| 14 | Appointments | **NOT STARTED** | Blocked on 12 and the scheduler. |
| 15 | Invoices / billing / payments | **NOT STARTED** | Blocked on entitlements (item 24) and on a payment provider — **which is a cost decision and therefore yours**. |
| 16 | Automation builder | **NOT STARTED** | Blocked on 9 and the scheduler. |
| 17 | Analytics | **NOT STARTED** (cheapest on the list) ⚠ | `audit_logs`, `draft_usage_tracking` and `ai_draft_review_events` are already accumulating the events. Analytics here is a read layer over data that exists, not new instrumentation. Highest value per day of work of anything in the NOT BUILT column. |
| 18 | Knowledge base | **NOT STARTED** | **pgvector is not enabled.** The four extensions across 38 migrations are `pgcrypto`, `uuid-ossp`, `btree_gist`, `pgmq`. Needs an extension decision before any KB work starts. |
| 19 | Document generator (PDF + zip) | **NOT STARTED** | `LANGDOCK_DOCZIP_*` credentials are in production and **no code reads them** — confirmed. See §6. |
| 20 | Image generator | **NOT STARTED** | `LANGDOCK_IMAGE_*` likewise. Also blocked on media columns and object storage. See §6. |
| 21 | Video generator | **NOT STARTED** | No provider chosen. See §5. |
| 22 | Multi-model AI routing | **PARTIAL** ⚠ | `packages/ai-providers/src/langdock-rotation.ts` is a real rotation engine over the four-model allowlist (`langdock.ts:17`), cheapest first. But it rotates on **failure only**, and only two failure shapes: `HTTP_429` (`:72`) and an `HTTP_400` whose provider detail matches a model-rejection regex (`:76-77`). There is no routing on capability, cost, task type, or organization. It is failover, not routing. |
| 23 | Marketplace / integrations + HubSpot + customer-facing API | **NOT STARTED** | Two hidden prerequisites. (a) **There is nowhere to store a customer's own credentials** — no per-org secret table. (b) **`/api/v1` is not a public API**: every route authenticates by Supabase SSR cookie (`apps/web/src/app/api/v1/drafts/route.ts:27-32`). There is no API-key or token path. A customer-facing API is new work, not exposure of existing work. |
| 24 | Multiple numbers / seats / tier entitlements | **PARTIAL / BLOCKED** ⚠ | Three separate things with three different states. **Numbers:** `whatsapp_connections` has no `UNIQUE(organization_id)` — N numbers per org is already allowed — but `business_profiles_organization_unique` (`20260804000001:19`) forces every number in an org to share one persona. **Seats:** blocked on the unwired invitation flow (item 1). **Tiers:** **no plan, tier, subscription or entitlement table exists.** `organizations` is `id, name, slug, logo_url, created_at, updated_at, deleted_at` and nothing else (`20260716000001:51`). |
| 25 | WhatsApp campaign manager | **NOT STARTED** | Gated behind outbound, which is yours to approve. |

### 2.3 Prerequisites

| # | Item | State | Notes |
|---|---|---|---|
| 26 | Contact entity | **NOT STARTED** | The highest-leverage single item on this document. Items 12, 13, 14, 15, 25 and most of 11 all resolve to "a thing we can attach facts to," and today that thing is a phone-number string on a conversation row. Build it once, early, and six features get cheaper. |
| 27 | ADR-015 action primitive | **NOT STARTED** (designed and accepted) | ADR-015 is Accepted with D1–D10 binding. The design is done; none of it is built. |
| 28 | Draft-generation pilot | **BLOCKED** ⚠⚠ | §2.4. |

### 2.4 ⚠ The correction that changes your next step

You named the pilot flag flip as one of the two next deliverables. **It will not work today, and the failure mode is total rather than partial.**

`reserve_draft_usage` resolves the active quota period like this
(`supabase/migrations/20260805000015_create_draft_generation_rpcs.sql:73-84`):

```sql
SELECT id, hard_ceiling, period_start, period_end INTO v_quota_limit
FROM public.draft_quota_limits
WHERE organization_id = v_org_id
  AND CURRENT_DATE >= period_start
  AND CURRENT_DATE <  period_end
ORDER BY period_start DESC
LIMIT 1
FOR UPDATE;

IF NOT FOUND THEN
  status := 'DENIED';
  reason := 'NO_ACTIVE_QUOTA_PERIOD';
```

**Nothing in production ever writes `draft_quota_limits`.** The only writer in the
entire repository is the E2E harness at `apps/worker/src/e2e/milestone1.ts:449`,
which inserts a row for its own test org and is not a production path. There is no
`INSERT INTO draft_quota_limits` in any of the 38 migrations. There is no admin UI,
no API route, no onboarding step, and no scheduled job that creates a period.

So the sequence on flip day is: flag goes true → draft worker claims the job →
`reserve_draft_usage` finds no row covering `CURRENT_DATE` → `DENIED /
NO_ACTIVE_QUOTA_PERIOD` → every job for every pilot org, immediately, with no
partial success to learn from.

This is a good failure in one narrow sense — it fails closed, loudly, with a typed
reason — but it means the pilot proves nothing until quota rows exist. **M0 in §5
exists solely to fix this**, and it is small: a seeding path, a period-rollover
decision, and a pgTAP test that fails if an org can be flag-enabled without a
covering quota period.

I would rather hand you this now than have us discover it live.

---

## 3. Items that were on neither list

Ten things the vision requires that appear in neither your BUILT nor your NOT BUILT
column. Most are small; three are blockers for features you did list.

| | Item | Why it matters | State |
|---|---|---|---|
| **A** | **Organization invitation wiring** | The table, RPC, RLS and 10 pgTAP assertions all exist. Zero callers, and the RPC is not even in the `Database['public']['Functions']` type map. "Seats" (item 24) cannot start until someone can be invited. | NOT STARTED (2 ed — it is wiring, not building) |
| **B** | **Quota period lifecycle** | §2.4. Blocks the pilot. | NOT STARTED (3 ed) |
| **C** | **Application shell and navigation** | No header, no sidebar, no nav. `/dashboard` 404s. Both real pages are reachable only by typing the URL. Every feature below adds a page, and there is nowhere to put it. **D7 is unachievable for anything until this exists.** | NOT STARTED (4 ed) |
| **D** | **Conversation thread view** | The inbound pipeline has been storing `messages` rows since August. **No screen in the product displays them.** A reviewer approving a draft cannot see what the customer said before the message that triggered it. This is arguably a defect in shipped functionality, not a missing feature. | NOT STARTED (5 ed) |
| **E** | **Scheduler / deferred execution** | Both production `pgmq.send` calls pass delay `0`. Nothing can happen later. Follow-ups (11), appointments (14), campaigns (25) and most of the automation builder (16) each independently require this. Build once. | NOT STARTED (4 ed) |
| **F** | **Token and cost accounting** | `draft_quota_limits` counts *requests*. The rotation design is premised on per-model token buckets, and images, video and voice are priced per unit at wildly different rates — a video second can cost 100× a text draft. A request counter cannot express any tier you would actually sell. **D2 depends on this.** | NOT STARTED (5 ed) |
| **G** | **Per-org secret storage** | No table can hold a customer's HubSpot token, their own WhatsApp credentials, or a BYO provider key. Item 23 is impossible without it, and it needs an encryption decision (pgcrypto is already enabled). | NOT STARTED (4 ed) |
| **H** | **Signup / onboarding** | Organizations are created by RPC. There is no path from "a business wants TuGPT" to "a usable org" that does not involve one of us running SQL. | NOT STARTED (5 ed) |
| **I** | **Handoff and assignment** | `conversations.status` allows `needs_human`, and the value is typed all the way to `apps/web/src/lib/draft-api/service.ts:317` — but **nothing writes it**. There is no assignee column and no notification. A shared inbox without assignment stops working at about two people. | NOT STARTED (4 ed) |
| **J** | **Two documentation defects** | (1) `README.md:15`, `:82` and `:172` state that Langdock uses `auto` model routing. That is false and was verified false against the live API on 2026-08-19 — `langdock.ts:24-30` says sending `auto` returns HTTP 400, and `.env.example` says the same. The README is the one place a new engineer starts. (2) `supabase/seed.sql:26-29` seeds four `global_*` flag rows, all `true`, with zero readers, whose names shadow real capabilities — while neither key the code actually queries appears there at all. **Per your instruction the seed file is not modified**; this row is the note you said was acceptable instead. | Doc fix (0.5 ed) |

---

## 4. Where the effort actually is

Before the sequence, the shape of the problem — because it is not what the 95%
figure suggested.

| Area | Built | Remaining |
|---|---|---|
| Delivery machinery (CI, deploy, tests, runbook) | ~95% | Maintenance |
| Tenancy foundations (orgs, auth, RLS) | ~70% | Invitations, signup, entitlements |
| One workflow: inbound → draft → review | ~85% | Quota lifecycle, thread view, media |
| **Everything else on the vision** | **~2%** | **Everything else on the vision** |

The 2% is not a criticism of the work — the built part is built to a high standard,
and that standard is why the rest can move quickly. It is a statement about
denominator. The product vision has roughly twenty-eight features; one of them is
nearly finished.

---

## 5. The roadmap

Dependency-ordered. Effort in **engineer-days (ed)**, calibrated against work this
repo has actually shipped: the draft review workflow — 5 components, 8 routes, RPCs,
RLS, pgTAP — was on the order of 18 ed. These numbers assume the same standard,
i.e. every item meeting all seven DoD clauses. They are ±40%, and they are honest
rather than comfortable.

### M0 — Unblock the pilot · 5 ed · **do this first, nothing else**

| Item | ed | Notes |
|---|---|---|
| Quota period seeding + rollover (**3-B**) | 3 | An RPC that creates a period for an org, a decision on rollover (monthly calendar vs. rolling 30d), and a pgTAP test asserting an org cannot be flag-enabled without a covering period. |
| Pilot runbook + rollback | 1 | Exact commands, the metric that says "working", and the one that says "stop". |
| README `auto` correction (**3-J**) | 0.5 | |
| Seed-flag note in docs (**3-J**) | 0.5 | Prose only — seed file untouched. |

**Exit:** you and I flip `ai_draft_generation` for 2–3 orgs together, and a real draft appears in the dashboard.

### M1 — A team can actually use it · 24 ed

Everything here is a prerequisite for something later. None of it is optional.

| Item | ed |
|---|---|
| **Contact entity** (26) — table, backfill from `conversations.contact_phone`, RLS, pgTAP | 6 |
| App shell + navigation (**3-C**) — unblocks **D7** for every later item | 4 |
| Conversation thread view (**3-D**) | 5 |
| Unified inbox (7) — conversation list, filters, search | 5 |
| Invitation flow wiring (**3-A**) | 2 |
| Handoff + assignment (**3-I**) | 4 — *overlaps the inbox; 2 if built together* |

### M2 — Tenancy the business model needs · 26 ed

| Item | ed |
|---|---|
| Plans / entitlements schema + resolution (24) — ADR-015 D5: entitlements ≠ flags | 8 |
| Token + cost accounting (**3-F**) — retrofits D2 onto quota | 5 |
| Per-org secret storage (**3-G**) | 4 |
| Per-number persona — drop `business_profiles_organization_unique`, add resolution (24) | 3 |
| Signup / onboarding (**3-H**) | 5 |
| Analytics v1 (17) — read layer over `audit_logs` + `draft_usage_tracking` | 4 |

### M3 — Outbound · 18 ed · **🔒 OWNER GATE**

Nothing here starts without your explicit approval, and the dual enforcement on
`whatsapp_integration` stays until you remove it deliberately in code.

| Item | ed |
|---|---|
| Media columns + object storage (**§2.1 item 2**) — also unblocks M5 entirely | 6 |
| Outbound send path — no code exists today, not even a stub | 6 |
| Delivery status reconciliation (`sent`/`delivered`/`read`/`failed` already in the CHECK) | 3 |
| Scheduler / deferred execution (**3-E**) — build once, four features consume it | 4 |

### M4 — The action primitive · 42 ed · *the architectural centre of gravity*

This is ADR-015 becoming real. Everything in M5–M9 is cheaper after it and
substantially more expensive without it.

| Item | ed |
|---|---|
| Capability-aware provider contract (**ADR-006 revision**) — retire the single-method adapter | 8 |
| Tool/action registry + execution (9, 27) | 10 |
| Agent loop — plan → call → observe → respond | 8 |
| Per-(org, agent, tool class) trust matrix (ADR-015 D3) | 6 |
| Multi-model routing on capability and cost (22) — extends rotation rather than replacing it | 4 |
| Agent builder UI (8) | 6 |

### M5 — Content generation · 17 ed · *rides on M3 media + M4 capability contract*

| Item | ed |
|---|---|
| Image generator (20) — `LANGDOCK_IMAGE_*` already provisioned | 4 |
| Document generator, PDF + zip (19) — `LANGDOCK_DOCZIP_*` already provisioned | 5 |
| Video generator (21) — see §6 | 8 |

### M6 — Knowledge and memory · 22 ed

| Item | ed |
|---|---|
| pgvector decision + enablement (18) | 2 |
| KB ingestion + chunking | 8 |
| Retrieval into the prompt path | 5 |
| Conversation memory — `buildPromptMessages` returns exactly `[system, user]` today (`prompt-builder.ts:47-50`) | 7 |

### M7 — Business objects · 52 ed

| Item | ed |
|---|---|
| CRM (12) | 12 |
| Sales pipeline (13) | 10 |
| Appointments (14) — needs M3 scheduler | 12 |
| Invoices / billing / payments (15) — **payment provider is a cost decision, yours** | 18 |

### M8 — Automation · 38 ed

| Item | ed |
|---|---|
| Follow-up engine (11) | 8 |
| Automation builder (16) | 16 |
| Campaign manager (25) | 14 |

### M9 — Platform and integrations · 44 ed

| Item | ed |
|---|---|
| Customer-facing API (23) — API-key auth, versioning, rate limits; `/api/v1` is cookie-only today | 10 |
| Integration framework + marketplace (23) | 12 |
| HubSpot connector (23) | 8 |
| Voice agent, IONOS (10) — needs M3 audio media + M4 capability contract | 14 |

### Totals

| Milestone | ed | Cumulative |
|---|---|---|
| M0 Pilot unblock | 5 | 5 |
| M1 Team usability | 24 | 29 |
| M2 Tenancy | 26 | 55 |
| M3 Outbound 🔒 | 18 | 73 |
| M4 Action primitive | 42 | 115 |
| M5 Content generation | 17 | 132 |
| M6 Knowledge + memory | 22 | 154 |
| M7 Business objects | 52 | 206 |
| M8 Automation | 38 | 244 |
| M9 Platform | 44 | 288 |

**≈ 288 engineer-days ≈ 58 engineer-weeks ≈ 13–14 engineer-months** for the full
vision at the current quality bar.

Two things worth saying plainly about that number:

1. **M0–M2 is 55 ed and it is where the leverage is.** At the end of M2 you have a product a paying customer can sign up for, invite colleagues to, run on multiple numbers, and be billed against — with one AI workflow. That is a sellable thing. Everything after M2 widens it.
2. **The order is not negotiable in its first half.** M1's contact entity and M2's entitlements are load-bearing for six and four later features respectively. Building any M7 item before them means building it twice.

---

## 6. Video generation

Your decision — that an open-source pipeline is acceptable — is the right one, and I
want to separate the two questions it contains, because conflating them is how this
usually goes wrong.

**Open weights is a portability decision. Hosting is an operations decision. They
are independent, and you can have the first without paying for the second.**

That framing matters here specifically because of ADR-015 **D2 — no single
provider**, which you held to IONOS and HeyGen at acceptance. An open-weight model
satisfies D2 structurally: the same checkpoint runs on fal, on Replicate, on RunPod
serverless, or on our own GPU. Choosing an open-weight model *is* the D2 compliance;
where it runs is then a cost question we can revisit any month without an
architecture change. A proprietary API model cannot give you that no matter how many
vendors you sign.

### The landscape, as of August 2026

| Model | Licence | Weights | Notes |
|---|---|---|---|
| **Wan 3.0 14B** (Alibaba) | Apache 2.0 | Yes, ~April 2026 | Currently the strongest open option. ~24GB+ VRAM. Reported 4K, 30s clips. |
| **Wan 3.0 1.3B** | Apache 2.0 | Yes | ~8GB VRAM — runs on commodity hardware. |
| **Wan 2.2 / 2.2-S2V / 2.2-Animate** | Apache 2.0 | Yes | The proven, widely-tooled generation. 14B FP8 fits a 24GB card. |
| Wan 2.5 / 2.6 | — | **No** | Deliberately closed to monetise audio-sync and 1080p. Worth knowing: Alibaba open-sources selectively, so "Wan is open source" is version-specific. |
| **HunyuanVideo** (Tencent) | Open weights | Yes | 13B, 720p, ~15s. 80GB recommended at full precision. |
| **LTX-Video / LTX-2** | Open weights | Yes | Speed-optimised; runs from ~12GB. The efficiency choice. |
| Kling 3.0, Veo 3.1, Seedance 2.0, Runway Gen-4 | Proprietary | No | Better output; no portability. |

*Note on sources: this comes from secondary comparison sites, and I found at least
one factual error among them (a vendor attribution swapped between Alibaba and
ByteDance). Treat the capability claims as directional. **Re-verify licence,
checkpoint and price against the vendor's own pages at implementation time** — that
is a task in M5, not something to take on trust from this document.*

### Cost, worked through

Roughly, a 4-second 720p clip from a Wan-class 14B model at FP8 takes **60–120s on a
24GB card**.

| Path | Unit economics | 4s clip |
|---|---|---|
| **A. Hosted API, open-weight model** (fal / Replicate) | Open-weight video ~$0.04–$0.09/s | **$0.16–$0.36** |
| **B. Serverless GPU, our own weights** (RunPod flex, RTX 4090 class @ ~$1.10/hr) | ~90s compute | **~$0.028** |
| **C. Dedicated GPU pod** (RunPod community 4090 @ ~$0.34/hr, or L40S @ ~$0.79/hr) | ~$245–570/month, **billed idle or not** | ~$0.0085 at saturation; **effectively infinite at pilot volume** |
| **D. Proprietary API** (Kling 3.0 Pro ~$0.09/s, Veo 3.1 full ~$0.20/s) | | **$0.36–$0.80** |

### Recommendation

**Path A now, architected so Path B is a config change, and Path C never — or not
until the numbers demand it.**

Concretely:

1. **Build a `VideoGenerationProvider` behind the M4 capability contract**, with the *model* named in configuration and the *host* named separately. Two backends at launch — that is D2, and it is nearly free when the model is open-weight because the same checkpoint runs on both.
2. **Launch on a hosted open-weight endpoint** (fal-class). At ~$0.25/clip and pilot volumes, video is a rounding error, and we pay nothing for the weeks nobody generates a video.
3. **Move to serverless GPU when volume justifies it.** The crossover is not per-clip — Path B beats Path A by ~$0.13–0.33/clip — it is the engineering and ops cost of getting there, which is realistically 5–8 ed plus ongoing care. **Break-even is on the order of 30,000–60,000 clips.** For an SMB WhatsApp assistant, that is a long way off, and the day it stops being far off is a good day.
4. **Path C is a trap at our stage.** A dedicated pod bills 24/7 for a workload that will be bursty and near-zero for months. It only makes sense above roughly 60% GPU utilisation, which implies volumes we are nowhere near.
5. **Quota this per-second of output, in money, from day one** (**D2**, item 3-F). Video is the feature most capable of producing a surprising invoice, and a request counter cannot see it coming.

**What I need from you:** picking a hosted endpoint means signing up for a paid
service, which is your call under the standing escalation rule. I am not going to
create an account or spend anything. When we reach M5 I will bring you a
one-page comparison with current verified prices and a recommended vendor, and you
decide.

---

## 7. Image and doczip: confirming they are the smallest slices

**Yes — with one correction, and it changes where image lands.**

You are right that the provider work is done. `LANGDOCK_IMAGE_*` and
`LANGDOCK_DOCZIP_*` are provisioned in production; the Langdock adapter, the error
taxonomy, the rotation engine, the metrics and the retry semantics all already
exist and are tested. Neither feature needs a new provider relationship, which is
genuinely what makes them small — 4 ed and 5 ed against 8 ed for video and 14 ed for
voice.

The correction is what "smallest" is measured against:

- **doczip is genuinely the smallest.** A PDF or zip is a file the user downloads from the dashboard. It needs object storage and a download route — both of which M2/M3 bring — but it does not need the WhatsApp message path at all. **It could ship immediately after M3's storage work, and it is a good first proof of the M4 capability contract precisely because its delivery path is simple.**
- **image is not as small as it looks, because of `messages`.** An image the customer never receives is a demo. Delivering one over WhatsApp requires the media columns that do not exist (§2.1 item 2) *and* the outbound send path that does not exist — which is M3, which is behind your gate. So image is 4 ed of image work sitting on top of ~12 ed of prerequisite that it shares with everything else outbound.

So the honest placement is what §5 already has: both in **M5**, after M3 supplies
media and storage and M4 supplies the capability contract. **doczip first** as the
proving run for the new contract, **image second** once outbound is real, **video
third** once the two-backend provider is wired.

One thing I want to flag rather than decide: **whoever wires these must use exactly
the `LANGDOCK_IMAGE_*` / `LANGDOCK_DOCZIP_*` variable names**, per your deployment
note. I have put that in the M5 rows so it is not rediscovered later.

---

## 8. What I need from you

| | Ask | Why it is yours, not mine |
|---|---|---|
| 1 | **Schedule the M0 pilot flip** — after the quota work lands, not before | Your standing rule: a supervised moment we schedule together |
| 2 | **Approve or defer M3 (outbound)** | Standing escalation (a). Nothing outbound moves without it, and it gates M5's image path and all of M8 |
| 3 | **Confirm the M0–M2-first sequencing** | If you want a specific later feature earlier, tell me and I will re-cut the plan — but I will show you what it costs in rework first |
| 4 | **Payment provider decision (M7)** | Standing escalation (b) |
| 5 | **Video endpoint vendor (M5)** | Standing escalation (b). I will bring verified prices and a recommendation |
| 6 | **pgvector on staging + production (M6)** | Extension enablement on the live database — standing escalation (c) and (d) |

Nothing in M0 needs anything from you except the flip at the end of it, so I am
starting there.

---

## 9. Keeping this document honest

Per your instruction that every status update tracks against this list:

- Every feature PR updates its row in §2 **in the same PR**. That is **D6**, and it is why D6 names this file specifically.
- The **PARTIAL → DONE** transition requires naming which DoD clause was the last one outstanding and what closed it. "Looks finished" is not a transition.
- New work discovered along the way gets a row in §3 with an effort estimate, not a mention in a status note. §3 is where the ten items above came from, and there will be more.
- **The project is not finished until every row in §2 and §3 reads DONE.** Not when the queue is empty.
