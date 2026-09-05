# ADR-015: TuGPT as an AI Business Operating System

## Status

**Accepted 2026-08-25** by the owner, in full and as written. Product-direction ADR, written
against the approved scope definition of the same date, which supersedes both earlier
product-direction briefs.

This ADR is architecture, not a commitment to dates. Every area in the brief is treated as
in scope. Where this document sequences work later, that is sequencing — a statement about
what must exist first — not a reduction of scope. Nothing here is dropped.

**Delivery queue is unchanged and this ADR does not touch it:** server rebuild (owner) →
draft pilot → chat MVP. Everything below describes what those three milestones are building
toward.

### Called out as binding at acceptance

Three decisions were named as binding rather than advisory. A future PR that breaks one of
these is wrong even if it is otherwise good:

- **D2's non-negotiable property** — no capability may have exactly one *possible* provider.
  Every integration PR is held to it, **including IONOS voice and HeyGen video**, whose
  credentials and accounts are already in hand. Having the vendor is not an argument for
  writing the code against that vendor.
- **D3's trust matrix per (org, agent, tool class).** One dial per agent was named as "the
  cheap and wrong version" and is closed off.
- **D5's separation of flags from entitlements.** Two systems, different lifecycles,
  different blast radii.

And a bar for D6, for the moment "thin" comes under pressure to thicken — which it will:

> **Does the AI need it in the hot path? If not, it belongs in a connector.**

### Follow-through arising from this ADR

Owner-approved, each in its own PR:

| Finding | Action | State |
|---|---|---|
| Part 3 row 13 — five readerless keys in `featureFlagService`, three defaulting to `true` | Neutralize them. The webhook's `whatsapp_integration` reader stays exactly as it is | **done 2026-08-25** |
| §3.3 — six dead `JobType` literals | **Empty the type to what exists**, rather than annotate | **done 2026-08-25** |

The preference for emptying over annotating was explicit: dead literals that read as
work-in-progress are how the pgTAP rot started.

**Correction to §3.3, recorded here rather than in the audit.** §3.3 says six of the seven
`JobType` literals are dead. It is seven — `whatsapp.process_message` appears nowhere but its
own declaration, and the queue payloads carry no `type` field for it to dispatch on, so no
literal was ever live. Emptying the type to what exists therefore emptied it to nothing, and
everything parameterized by it went with it: `packages/jobs/src/types.ts` is deleted in full,
including the unwired `InMemoryJobQueue` that ADR-014 §4 had left for a future session to
decide on. Part 3 is left as written — the pin is there to preserve the audit as it stood,
and a correction is more useful next to the action taken than smuggled into the record.

## Context

TuGPT today is one narrow slice of the product described in the brief: an inbound WhatsApp
message becomes an AI-drafted reply that a human reviews and approves. There is no outbound
send path. That slice is well built — tenant isolation is enforced at the storage layer, the
queue has a proven retry and dead-letter contract, and the review workflow has a real audit
trail — but it is a **pipeline**, and the product described in the brief is an **agent
platform**. Those are different shapes, and the difference is not a matter of adding features
to the pipeline.

The central distinction, and the thing the whole architecture below turns on:

> Today the AI produces **text that a human sends**.
> The product produces **actions that change the world**, with a human in the loop by policy
> rather than by construction.

Everything in the brief that sounds like a separate feature — voice, payments, follow-ups,
documents, the automation builder, the Employees — is downstream of that one change. An
appointment booking, a payment link, a CRM update, a call transfer and a follow-up nudge are
all the same primitive: *the model decided to do a thing, and something executed it under
constraints*. Build that primitive once and the fourteen areas become adapters onto it. Build
each area separately and there are fourteen half-agents.

---

# Part 1 — How it composes

## 1.1 Five layers

```
┌─────────────────────────────────────────────────────────────────┐
│  PACKAGING          TuGPT Employees        Automation Builder   │
│                     (bundles, 1 click)     (When / If / Then)   │
├─────────────────────────────────────────────────────────────────┤
│  AGENT RUNTIME      agent loop · trust state · handoff ·         │
│                     conversation memory · escalation            │
├─────────────────────────────────────────────────────────────────┤
│  TOOLS (ACTIONS)    calendar · payments · CRM · documents ·      │
│                     media · messaging · handoff · knowledge      │
├─────────────────────────────────────────────────────────────────┤
│  AI ROUTER          capability + cost + policy → provider route  │
│                     text · voice · image · video · embeddings    │
├─────────────────────────────────────────────────────────────────┤
│  PLATFORM           tenancy · RLS · entitlements · metering ·    │
│                     scheduling · audit · integrations · vault    │
└─────────────────────────────────────────────────────────────────┘
```

Read it downward for dependency: nothing in a higher band works without the band below it
being real. That is the whole content of the roadmap in Part 4.

## 1.2 Employees and the automation builder are two front doors on one substrate

The brief asks for both, and treats them as complementary — Employees for owners who do not
want to build, the builder for owners who do. They must not be two implementations.

- An **Employee** is a *manifest*: persona + system prompt + a tool allowlist + guardrails +
  escalation rules + default trust state. Activating "AI Receptionist" writes an agent row
  bound to the org's WhatsApp connection, calendar, knowledge and CRM. Nothing about the
  runtime differs from a hand-built agent.
- An **automation** is a *rule* over the same tool set: a trigger (message received, stage
  changed, invoice overdue, time elapsed), a condition, and an ordered list of tool calls —
  some of which may be "ask the agent to decide".

The builder's `Then` clause and the Employee's tool allowlist draw from the same registry.
This is what makes the marketing claim ("pre-built, or build your own") true rather than
two codebases that happen to ship together.

**Consequence worth stating plainly:** the tool registry is the most important artifact in
the product. Its interface is a public contract for every Employee, every automation, and
eventually the customer-facing API. It deserves the same care ADR-006 demands of the provider
contract, and for the same reason.

---

# Part 2 — Decisions

## D1. The action layer is the core abstraction

**Decision.** Introduce a first-class tool/action layer. A tool is a named, versioned,
schema-typed, side-effecting capability with an owner-visible description, an idempotency
key, a permission class, and an audit record. The agent runtime executes a loop —
model proposes tool call → policy check → execute → observe → continue — rather than a single
completion.

**Why this and not "add function calling to the draft worker".** Three properties are needed
that a completion call cannot provide:

1. **Every action must be attributable and reversible-or-explainable.** The audit trail that
   exists for draft review (`ai_draft_review_events`, revisions with `created_by_type`) is the
   right model and must extend to actions. "The AI charged a customer" needs the same evidence
   quality as "the AI drafted a message".
2. **Policy is per-tool, not per-agent.** Booking an appointment and issuing a refund are not
   the same risk. Trust graduation (D3) is meaningless unless it can be expressed per tool class.
3. **Idempotency is per-tool.** A retried queue message must not create two calendar events.
   The draft pipeline learned this the hard way — `reserve_draft_usage` is idempotent per job
   precisely because redelivery is normal. Every tool needs that property from the start, not
   after the first double-booking.

**The canonical example decomposed.** "Book me a dentist appointment tomorrow afternoon"
becomes: `calendar.find_availability` → agent proposes slots → customer picks →
`calendar.create_event` → `crm.link_activity` → `messaging.send_confirmation` →
`scheduling.schedule_reminders` → `notify.employees`. Seven tool calls, six of which are
reusable by other Employees, and every one independently permissioned, metered and audited.

## D2. The AI Router is capability routing, not provider failover

**Decision.** Build the TuGPT AI Router as a capability-based selector: given
`(modality, task, org, entitlement, policy)` it returns a route. Model failover is one
behaviour of the Router, not its purpose.

**Why this is not an extension of ADR-006.** ADR-006's `AIProviderAdapter` has exactly one
method returning `text: string`, and its own header forbids expanding it without a
capability-based architecture review:

> "It intentionally does NOT yet define streaming, structured output, tool calls, embeddings,
> image/video generation, speech-to-text/text-to-speech… Those capabilities require a
> dedicated capability-based architecture review before this contract is expanded."

That review is this decision. The contract must become capability-negotiated — a provider
declares what it can do (`text.complete`, `text.tools`, `voice.synthesize`, `voice.transcribe`,
`image.generate`, `video.generate`, `embed.text`) and the Router selects on declared capability,
cost, latency class, org entitlement, and data-residency policy. The existing Langdock model
rotation is then one route's internal strategy, not the architecture.

**This ADR supersedes ADR-012's three-provider chain conceptually** (ADR-006 already superseded
it factually on 2026-08-18): resilience comes from route alternatives per capability, not from
a fixed vendor chain.

**Non-negotiable property:** no capability may have exactly one possible provider in the
architecture, even where it has exactly one *configured* provider today. The brief is explicit
about this for video; it applies equally to voice and images. The cost of a second route is
one adapter; the cost of lock-in discovered late is a rewrite under commercial pressure.

## D3. Trust graduation is the safety spine

**Decision.** Every (org, agent, tool-class) triple carries a trust state:

| State | Behaviour |
|---|---|
| `draft_review` | The agent proposes; a human approves before anything leaves or changes. Today's pipeline. |
| `supervised` | The agent acts automatically; every action lands in a review queue, and a per-org kill switch reverts to `draft_review` instantly. |
| `autonomous` | The agent acts within hard limits — tool allowlist, per-period action caps, per-action value caps, and an escalation rule for anything outside them. |

**Per tool class, not per agent.** An AI Receptionist may be `autonomous` for
`calendar.find_availability` and `draft_review` for `payments.create_link` in the same
conversation. Collapsing this to one dial per agent forces owners to choose between a useless
agent and an unsafe one.

**Why this is the spine and not a feature.** Everything expensive or irreversible in the brief
— payments, collections, campaigns, outbound voice — is safe only because this exists. The
existing `whatsapp_integration` dual enforcement (a hardcoded `false` in code *and* a database
row, per ADR-010 amendment 2) is the pattern to generalize: for the highest-risk tool classes,
enabling autonomy should require both a deliberate code change and an owner action, not a
database edit.

**Ordering consequence:** the Collections Agent and Billing Assistant are named last in the
brief's own Employee list. That ordering is correct and this ADR adopts it. An agent that
chases customers for money is the one where a mistake costs the owner a customer relationship,
not just a wasted API call.

## D4. Human handoff is a conversation state with an owner, and a tool the AI can call

**Decision.** Handoff is modelled as (a) a real conversation state, (b) an assignment to a
human, and (c) `handoff.escalate` — a tool the agent invokes deliberately, with a reason.

**Why a tool and not an error path.** The brief sets the benchmark as matching and surpassing
Hello.ai here. The difference between a good and a bad handoff is whether the AI *decided* to
hand off and said why, versus the system noticing the AI failed. A tool call carries a
structured reason ("customer asked for a refund above my limit", "customer is upset",
"I do not know and the knowledge base does not say"), which is what makes the human's first
five seconds useful and what makes handoff quality measurable.

**The schema is halfway there and pointing the right way.** `conversations.status` already
declares `'needs_human'` — and no production code writes it (only pgTAP fixtures, which set it
to prove the ingest path preserves it). Nothing assigns a conversation to
a person. Making that value real, with an assignee and a reason, is the smallest change in
this ADR with the largest product consequence: it turns the draft inbox into the unified
inbox the brief asks for.

## D5. Entitlements are metered; feature flags stay a kill switch

**Decision.** Two separate systems, deliberately not merged:

- **Feature flags** (`is_feature_enabled`) remain what they are: a boolean, fail-closed,
  platform-and-org AND, used for rollout and for emergency shutdown. Do not add plans to them.
- **Entitlements** become a new layer: per (org, metric) allowances resolved from the org's
  plan, with metered usage per org, per agent, per feature, per modality.

**Why not one system.** They have different lifecycles and different blast radii. A flag is
flipped by an engineer during an incident and must be instantly, globally, obviously off. An
entitlement changes when a customer upgrades and must be transactional and auditable against
billing. Overloading `feature_flags.rules` with plan logic — the `minimumPlan` field that
exists in `packages/feature-flags` and which nothing reads — is the version of this that looks
cheap and produces an incident where a billing change silently disables a customer's WhatsApp.

**There are already two flag systems, and only one of them is the one D5 describes.**
`is_feature_enabled` is the database-backed, per-org one. Alongside it, `packages/feature-flags`
exports an in-memory singleton whose values are a hardcoded constructor map
(`flags.ts:17-25`): it reads no database, takes no `organization_id`, and `setFlag` is never
called outside its own test. It has exactly one production reader — the WhatsApp webhook's
`whatsapp_integration` check (`route.ts:16,34`), which is the hardcoded half of the dual
enforcement on that flag and stays exactly as it is. The problem is the other five keys it
ships. See Part 3, row 13.

**The metering requirement from the brief is specific and load-bearing:** *"metering must be
cheap per org, per Employee, per feature, per modality."* Four dimensions. The current quota
system has none of them — it is a single integer counter named `draft_count` against a single
`hard_ceiling`, with reservations anchored by a `NOT NULL` foreign key to
`draft_generation_jobs`. It cannot count a second thing. See Part 3.

**Cost, not just count.** The free tier is described as "AI usage hard-capped" and paid tiers
bill variable AI usage separately. That requires recording cost, not just events. Today the
provider response carries token usage and no table stores it. Every tool execution and every
model call must write a metered record with modality, tokens or units, and an attributable
cost estimate — from the first tool, not retrofitted.

## D6. CRM position: own the model, integrate HubSpot

**Decision. Hybrid, with TuGPT as the system of record.** Build a deliberately thin owned CRM
— contact, lead/deal, pipeline stage, activity — and treat HubSpot as one connector in the
integration marketplace offering bi-directional sync for orgs that already use it.

**Why owned rather than HubSpot-backed.** Four reasons, in order of weight:

1. **The AI reads and writes CRM in the hot path.** A WhatsApp webhook must answer Meta
   quickly; a voice agent must offer an answer inside a human pause. Putting a third-party
   API's latency and availability inside those paths makes TuGPT's reliability a function of
   HubSpot's. The brief's canonical flows — "how much do I owe?", voice → CRM → calendar — are
   all synchronous and customer-facing.
2. **Tenancy.** TuGPT's entire security posture is that isolation is enforced by the database,
   with RLS plus composite tenant-consistent foreign keys that make a cross-tenant reference
   *impossible at the storage layer*. Customer data living in a third-party account is outside
   that boundary and cannot be given the same guarantee.
3. **Pricing.** A $9–15/month tier cannot carry a per-seat CRM licence. HubSpot-backed makes
   the cheapest tiers structurally unprofitable, and those tiers are the LatAm SMB wedge.
4. **The target customer does not have HubSpot.** An Ecuadorian dentist or a Colombian
   retailer is not migrating from a CRM; they are moving off WhatsApp and a notebook. A
   HubSpot-backed product asks them to adopt two systems.

**Why integrate rather than ignore.** Orgs that do have HubSpot are exactly the larger,
higher-tier customers, and refusing to sync makes TuGPT a data island. Sync is a connector
problem, and connectors are a marketplace we are building anyway.

**The honest cost of this decision:** CRM is a lot of surface area, and "thin" will be under
constant pressure to thicken. The discipline is to build only what the AI needs in order to
act — a contact it can identify, a deal it can advance, an activity it can log — and to treat
reporting depth, custom objects and marketing automation as explicit non-goals that the
HubSpot connector serves instead.

**Prerequisite nobody should miss:** there is no contact entity today. A customer is a bare
phone-number string on a conversation, unlinked across connections. The same person messaging
two of an org's numbers is two unrelated rows. Every CRM, payment, appointment and voice
feature in the brief needs an identity to attach to, which makes the contact entity one of the
earliest items in Part 4 rather than part of "the CRM milestone".

## D7. Employees are manifests, not code

**Decision.** An Employee is data: a versioned manifest describing persona, prompt, tool
allowlist, guardrails, escalation rules, default trust states per tool class, and required
integrations. Activation instantiates an agent from the manifest and binds it to the org's
resources. Shipping a new Employee is publishing a manifest, not a deploy.

**Why.** Eight Employees are named in the brief and more will follow. If each is code, each is
a release, a test surface, and a migration risk. If each is data, they are reviewable,
diffable, versionable, and — importantly for the automation builder — the same thing an owner
can fork and edit.

**Guardrail:** manifests must be validated against the tool registry at publish time. An
Employee referencing a tool that does not exist, or requesting a permission class it is not
allowed, must fail at publish, not at 2am in a customer conversation.

## D8. Integrations: one credential vault, capability-shaped connectors

**Decision.** A single per-org connected-accounts store holding encrypted credentials with
explicit scopes, and connectors that expose *capabilities* (`calendar.read`, `calendar.write`,
`payments.create_link`, `commerce.read_orders`) rather than vendor APIs. Tools bind to
capabilities; the org's connected account decides which vendor serves it.

**Why capability-shaped.** The brief lists sixteen integrations across five categories. If
`calendar.find_availability` is written against Google Calendar, Outlook is a second
implementation of every calendar-using Employee. If it is written against a `calendar.read`
capability, Outlook is one connector.

**Security note that must not be deferred.** TuGPT currently stores no third-party credentials
at all — WhatsApp secrets are environment variables, and no table holds a token. The first
OAuth connector changes the system's risk profile materially: it introduces a store of
customer credentials for other businesses' systems. Given the 2026-08-24 compromise, that
store needs its threat model written down before it is built, not after.

## D9. Knowledge base is owned, and inside the tenancy boundary

**Decision.** Build the per-org knowledge base natively, with embeddings stored in Postgres
(`pgvector`) under the same RLS and composite-FK discipline as every other tenant table.
Retrieval is a tool (`knowledge.search`), so every Employee and every automation gets it for
free.

**Why not a hosted vector service.** Same reasoning as D6.2: this is the org's proprietary
business content — pricing, policies, procedures. Moving it outside the database means
inventing a second tenancy enforcement mechanism and being right about it. `pgvector` is not
the fastest option at very large scale; TuGPT's scale per tenant is a small business's document
set, and the tenancy guarantee is worth more than the benchmark.

## D10. A scheduling substrate is a platform primitive, not a follow-up feature

**Decision.** Build durable, tenant-scoped, cancellable scheduled work — "run this at this
time, unless something cancels it" — as shared infrastructure.

**Why it is called out as its own decision.** Four separate areas of the brief are blocked on
it and would otherwise each invent their own: the follow-up engine (24h and 3-day sequences),
appointment reminders, payment reminders, and the campaign manager. Today nothing in the system
can defer work — both production enqueue sites pass a literal `0` delay, and the only
time-based columns are lazily-evaluated expiry windows. Nothing fires.

**Design constraint from the brief:** the owner controls follow-up aggressiveness, and a
follow-up must be cancelled when the customer replies. So the primitive is not a cron; it is a
*cancellable, per-org, rate-governed scheduled action* whose cancellation is driven by
conversation events. Getting that wrong is how a product acquires a reputation for nagging.

---

# Part 3 — Data-model sanity check

Requested: multiple named agents per org, multiple WhatsApp numbers per org, tier entitlements,
follow-up scheduling, payments/invoices, voice-call records. **No migrations proposed here.**

> **This part is a point-in-time audit, not a decision.** Every claim and line number below was
> verified against `main` at `3fa63d0`. Unlike the rest of the ADR it is expected to go stale,
> and that is correct: when a row's constraint is deliberately lifted, the row is *supposed* to
> stop being true. It is deliberately **not** covered by a doc-drift test — such a test would
> fail on exactly the changes this ADR is asking for, and would train people to edit the record
> to appease CI. Re-verify against the commit above rather than trusting it at a later date.

## 3.1 What the schema actively fights

| # | Constraint / fact | Where | What it blocks | Severity |
|---|---|---|---|---|
| 1 | `UNIQUE (organization_id)` on `business_profiles` — "one business profile per organization" | `20260804000001:18-20` | **Multiple named agents per org.** The constraint propagates by composite FK into `whatsapp_connections`, `ai_draft_configs`, `ai_drafts` and `draft_generation_jobs`, so it is not a local change | **Highest** |
| 2 | `UNIQUE (business_profile_id)` on `ai_draft_configs` | `20260805000001:31-33` | One prompt/persona per profile, therefore one per org | **Highest** |
| 3 | Profile resolution is `SELECT id … WHERE organization_id = … LIMIT 1` with no ordering and no selection key | `20260805000017:136-139` | Even if #1 were lifted, routing would be nondeterministic. This is the code that must change *with* the constraint | High |
| 4 | `DraftRequest.sourceMessageText: string` — a single string in, no history | `packages/ai-orchestration/src/types.ts:29-34` | Conversation memory, multi-turn, retrieval, tool loops. Every agent behaviour in the brief needs more than one string | **Highest** |
| 5 | `AIProviderAdapter` = one method returning `text: string`; no capability negotiation | `packages/ai-providers/src/adapter.ts:50-65` | Voice, image, video, embeddings, tool calls, and therefore the Router | **Highest** |
| 6 | Quota is `draft_count`/`reserved_count` vs `hard_ceiling`, with **no metric or resource dimension**, and reservations `NOT NULL` FK'd to `draft_generation_jobs` | `20260805000004`, `…05`, `…06` | Metering anything that is not a draft. There is nowhere for a second metric to live | High |
| 7 | Entitlement is boolean-only. `is_feature_enabled` ANDs two booleans; `minimumPlan` and `rolloutPercentage` are declared and never read; `feature-gate.ts` states the entitlement source does not exist | `20260805000013:13-24`, `packages/feature-flags/src/flags.ts:4-5`, `apps/web/src/lib/draft-api/feature-gate.ts:3` | Tiers, numeric limits, usage-based billing | High |
| 8 | No deferred execution anywhere. Both production `pgmq.send` calls pass delay `0`; visibility timeout is capped at 3600s and is retry backoff, not scheduling | `20260804000009:90-99`, `20260805000017:158-166` | Follow-ups, reminders, campaigns, collections | High |
| 9 | No contact entity. A customer is `conversations.contact_phone TEXT`, unique only per (org, connection, phone) | `20260804000005:8,22-24` | CRM, payments, appointments, voice→CRM. The same person on two org numbers is two unrelated rows | High |
| 10 | `messages.body TEXT ≤ 4096`, no kind/media column; message kind is validated at ingest then discarded with the staging row | `20260804000006:33-35`, `20260805000017:121-122` | Media, documents, images, voice notes — an image and a text are indistinguishable once stored | Medium |
| 11 | `organization_role` is a Postgres ENUM | `20260716000001:19-25` | Sales/Support/Admin workspace roles are DDL, not data | Medium |
| 12 | `conversations.status` has `'needs_human'` declared but **no production writer**, and no assignment column | `20260804000005:10` | Human handoff, the unified inbox, trust graduation's review queue | Medium (but cheap to fix) |
| 13 | A **second, in-memory flag system** alongside `is_feature_enabled`: a hardcoded constructor map that reads no database and takes no `organization_id`. Its one production reader is the webhook's `whatsapp_integration` check. Its other five keys — `voice_receptionist`, `langdock_orchestrator`, `mastra_orchestrator`, `image_generation`, `video_generation` — have **no reader anywhere**, and three default to `true` | `packages/feature-flags/src/flags.ts:17-25,31-54`, `apps/web/src/app/api/v1/webhooks/whatsapp/route.ts:16,34` | Per-org or per-tier gating of voice, image and video — the three capabilities whose names already sit in that file. It cannot express an org-specific answer even in principle | High |

## 3.2 What the schema already supports — do not rebuild it

- **Multiple WhatsApp numbers per org already work.** `whatsapp_connections` has no
  `UNIQUE (organization_id)`; the only uniqueness is `provider_phone_number_id` globally, which
  correctly stops two orgs claiming the same Meta number. The blocker is not the connection
  table — it is #1 and #2, which force every number to share one persona.
- **Tenant isolation is strong and should be the pattern for every new table.** Composite
  `UNIQUE (id, organization_id)` targets with children FK'ing on `(child_id, organization_id)`
  make cross-tenant references impossible at the storage layer, independent of RLS. Every new
  entity in this ADR — contacts, deals, appointments, invoices, calls, documents, tools,
  agents — must follow it.
- **`organization_id` is never caller-supplied in a privileged RPC.** Every SECURITY DEFINER
  function locks its anchor row and derives the org. This is the right discipline for tool
  execution too: a tool must never take an org id as an argument.
- **The audit and revision model is the right shape for actions.** `created_by_type` with a
  CHECK forcing system↔user consistency, plus immutable audit logs, is exactly what tool
  execution records need.
- **The queue's failure semantics are proven.** Retry with backoff, a bounded attempt count, a
  typed dead-letter path with provider detail captured. Tool execution should reuse it rather
  than invent a parallel mechanism.

## 3.3 A note on `packages/jobs/src/types.ts`

`JobType` declares seven job names — including `appointment.send_reminder`,
`invoice.generate_pdf`, `crm.sync_contact`, `ai.process_transcript`, `ai.generate_image`,
`ai.generate_video`. **Six of the seven have no handler, no table, no queue and no caller.**
They are the only place appointments, invoices, CRM or media generation appear in the
repository at all.

They should be read as an early sketch of this brief, not as partial implementations. Anyone
planning from the codebase alone could mistake them for work in progress; they are not, and
the type should either be emptied to what exists or annotated, so it stops implying otherwise.

---

# Part 4 — Dependency-ordered roadmap

Ordering is by dependency, not by value. An item may appear early because much depends on it
even if it ships no visible feature. **Make / Buy / Integrate** is called per area.

## Tier 0 — current queue (unchanged, owner-sequenced)

Server rebuild → draft pilot → chat MVP. Everything below assumes these are done.

## Tier 1 — Foundations (nothing above works without these)

| # | Item | Why it is first | Call |
|---|---|---|---|
| 1.1 | **Capability-based provider contract** (supersedes the provisional `AIProviderAdapter`) | Blocks the Router, and therefore voice, image, video, embeddings and tool calls. ADR-006 requires this review before expansion | **Make** |
| 1.2 | **Contact entity** | Blocks CRM, payments, appointments, voice→CRM, follow-ups. Everything customer-shaped needs an identity | **Make** |
| 1.3 | **Agent entity + multi-agent per org** (resolves collisions #1, #2, #3) | Blocks Employees, per-number persona, the whole packaging layer | **Make** |
| 1.4 | **Tool registry + agent loop + action audit** | The product's core primitive (D1) | **Make** |
| 1.5 | **Scheduling substrate** (durable, cancellable, tenant-scoped) | Blocks follow-ups, reminders, campaigns, collections (D10) | **Make** |
| 1.6 | **Metering + entitlements** (metric-dimensioned; cost as well as count) | Blocks tiers, and blocks turning on any expensive modality safely (D5) | **Make** |
| 1.7 | **Human handoff state + assignment + `handoff.escalate`** | Blocks the unified inbox and trust graduation's review queue (D4). Cheapest item in Tier 1 | **Make** |
| 1.8 | **Trust graduation model** (per org × agent × tool class) | Gates every autonomous behaviour that follows (D3) | **Make** |

Note 1.1 and 1.4 are separable but should land together: a tool-calling loop needs a provider
contract that can express tool calls.

## Tier 2 — First capabilities (each depends only on Tier 1)

| # | Item | Depends on | Call |
|---|---|---|---|
| 2.1 | **Conversation memory / multi-turn context** (resolves #4) | 1.4 | **Make** |
| 2.2 | **Knowledge base + `knowledge.search`** | 1.4, pgvector | **Make** (D9) |
| 2.3 | **Owned CRM core**: contacts, deals, pipeline stages, activities | 1.2, 1.4 | **Make** (D6) |
| 2.4 | **Calendar capability + Google/Outlook connectors** | 1.4, 1.5, D8 vault | **Integrate** (Google, Microsoft) over a **made** capability |
| 2.5 | **Integration framework + credential vault** | 1.4 | **Make** framework, **Integrate** each connector |
| 2.6 | **Outbound messaging as a tool** (the first genuinely irreversible action) | 1.4, 1.7, 1.8 | **Make** — and requires explicit owner approval per the standing directive |
| 2.7 | **Unified dashboard + inbox**, human + AI conversation management | 1.7, 2.1 | **Make** |
| 2.8 | **Workspace roles** (Sales / Support / Admin; resolves #11) | — | **Make** |

## Tier 3 — The differentiators

| # | Item | Depends on | Call |
|---|---|---|---|
| 3.1 | **AI Follow-up engine** | 1.5, 2.3, owner aggressiveness controls | **Make** |
| 3.2 | **AI Router** (multi-model, multi-modality routing) | 1.1, 1.6 | **Make** |
| 3.3 | **TuGPT Employee manifests** — first hires: Customer Support, Receptionist, Appointment Manager | 1.3, 1.4, 1.8, 2.2–2.4 | **Make** (D7) |
| 3.4 | **Automation builder (When/If/Then)** | 1.4, 1.5, 3.3 (shared registry) | **Make** |
| 3.5 | **Sales pipeline UI + sales dashboard** | 2.3 | **Make** |
| 3.6 | **AI Insights layer** | 2.3, 3.5, 1.6 | **Make** |
| 3.7 | **AI Document generator** (proposals, quotes, invoices, contracts → PDF) | 1.4, 2.3 | **Make** templating; **Integrate** a render engine |
| 3.8 | **HubSpot connector** (bi-directional sync) | 2.3, 2.5 | **Integrate** (D6) |

## Tier 4 — Modalities and money

| # | Item | Depends on | Call |
|---|---|---|---|
| 4.1 | **Voice agent** — answer calls, ES/EN/PT, book/cancel, transfer, qualify, take messages, create CRM records | 1.1, 1.4, 1.6, 2.3, 2.4; needs a call/transcript entity | **Integrate — IONOS** (API already held), behind a routed `voice.*` capability so a second provider is possible |
| 4.2 | **Payments & invoicing** — links, cards, bank transfer, local providers, confirmations, balances, reminders | 1.2, 1.4, 1.5, 1.8, 2.3 | **Integrate per country.** Ecuador bank transfer is the hard case and likely needs reconciliation tooling, not just a gateway |
| 4.3 | **AI Creative Studio** (images) | 1.1, 1.6, 3.2 | **Integrate**, pluggable, cheapest-adequate route |
| 4.4 | **AI Video generator** | 1.1, 1.6, 3.2 | **Integrate — HeyGen (MCP, account held) + at least one open-source route.** Pluggable is a requirement, not a preference |
| 4.5 | **AI Collections Agent, AI Billing Assistant** | 4.2, 1.8 at its strictest | **Make** manifests — deliberately last, per the brief |

## Tier 5 — Scale and platform

| # | Item | Depends on | Call |
|---|---|---|---|
| 5.1 | **WhatsApp campaign manager** (compliant high-volume) | 1.5, 1.6, 2.6, template management | **Make** on Meta's rails — **Integrate** Meta template approval |
| 5.2 | **Remaining marketplace connectors** — Shopify, WooCommerce, Stripe, PayPal, Sheets, Excel, Zapier, Make, Slack, Facebook, Instagram, Gmail | 2.5 | **Integrate** each |
| 5.3 | **Customer-facing TuGPT API** (Pro tier) | 1.4 registry stability, 1.6 | **Make** |
| 5.4 | **Developer capability via the AI workspace API** (repo analysis, review, fixes, tests) | 1.4, 5.3 | **Make** |

## 4.1 Languages and markets

Spanish, English and Portuguese are a cross-cutting requirement, not a milestone. Two
consequences worth fixing early because retrofitting them is expensive:

- Locale belongs on the **contact** (1.2) and the **agent** (1.3), not only on the user
  profile. The customer's language is not the operator's language. Note `profiles.preferred_locale`
  today has no CHECK constraint despite the TypeScript type narrowing it to `'es' | 'en'` —
  Portuguese is not yet representable in a validated way.
- Voice (4.1) is where language support is hardest and least substitutable. It should be a
  provider-selection criterion in the Router from the start.

---

# Part 5 — Consequences, risks, and what this does not decide

## 5.1 Consequences

- **The draft pipeline becomes a special case of the agent runtime**, not a separate system:
  an agent whose trust state is `draft_review` and whose only tool is "propose a reply".
  That is a good outcome — it means the pilot's hard-won correctness carries forward — but it
  does mean the draft path will be refactored, not merely extended.
- **The tool registry becomes a public contract** for Employees, automations and eventually
  customers. Versioning it badly is expensive later.
- **Cost becomes a first-class product concern.** With voice, images and video routed per task,
  per-org cost attribution is the difference between a margin and a surprise.

## 5.2 Risks I would want the owner to see named

- **Scope-to-foundation ratio.** Eight of the fourteen areas depend on Tier 1 items that do not
  exist at all today. This is not an argument for less scope; it is an argument for resisting
  the temptation to start at Tier 4, where the visible demos are. A voice agent built before the
  tool layer is a demo that has to be rebuilt.
- **Autonomous collections.** An agent that pursues customers for money is the highest-regret
  failure mode in the product. The brief already sequences it last; this ADR reinforces that,
  and recommends it never reach `autonomous` for the payment-demand tool class without an
  explicit, per-org, owner-signed decision.
- **WhatsApp campaign compliance.** Meta's policy is the binding constraint, not our
  throughput. A compliance mistake risks the org's number, which is the customer's business
  phone line. This is a product-design problem before it is an engineering one.
- **Video economics.** The brief already says it: no promising free video forever. Pluggable
  providers protect the architecture; they do not protect the pricing. Video is the one
  capability where a generous free tier could be genuinely dangerous.
- **The already-named flags that default to on.** `voice_receptionist`, `image_generation` and
  `video_generation` exist today as keys in an in-memory map with no reader, and the first
  defaults to `true`. When those capabilities get built, wiring each to the flag that already
  bears its name is the obvious move and the wrong one: that service is org-blind and
  DB-blind, so the capability would ship enabled for every organization, changeable only by a
  code change and a deploy — and since no migration is involved, nothing in a schema review
  would catch it. Anything gated per customer must be gated by `is_feature_enabled` or by the
  entitlement layer, never by that map.
- **The credential vault raises the stakes of a breach.** After 2026-08-24, adding a store of
  other businesses' OAuth tokens deserves its own threat model and its own review.

## 5.3 What this ADR does not decide

- Table designs, column names, or any migration. Part 3 is a collision report, not a schema.
- The tool registry's concrete interface — that deserves its own ADR alongside the capability
  contract, and is the single most consequential interface decision in the product.
- Published pricing. The tiers in the brief are treated here only as architectural input:
  metering must be cheap along four dimensions and entitlements must ride the entitlement
  system rather than being hardcoded.
- Which specific image/video/payment vendors are chosen. This ADR fixes only that each must be
  routable and replaceable.

## References

- ADR-003 (multi-tenant model), ADR-004 (RLS and private helpers) — the tenancy discipline
  every new entity must follow
- ADR-006 (provider adapter, provisional) — the contract D2 supersedes, and whose own header
  requires this review before expansion
- ADR-007 (background jobs), ADR-014 (PGMQ) — the substrate D10 extends
- ADR-010 (feature flags, amended) — the boolean AND semantics D5 preserves and declines to
  overload
- `docs/controlled-rollout.md` — the trust model D3 generalizes from drafts to actions
