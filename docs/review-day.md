# Review-day checklist

One sitting. Merge in stack order. **Do not deploy until the whole stack is on `main`.**

**Host:** `212.227.44.13` / `/opt/tugpt` · **Prod URL:** `https://tugpt.app`  
**Runbooks after merge:** `docs/server-migrations.md` then `docs/production_environment.md` §5.5. Flag flips: `docs/controlled-rollout.md` (not a review-day step).

---

## Gate (every head)

- [ ] CI **green on that head**: `build-and-test`, **`database-tests`**, `deploy-scripts`, `docker-build`. Local cold-DB green is not a substitute.
- [ ] Base is the previous merged SHA (or `main` for the bottom of the stack).
- [ ] Review in order. Do not skip a security-critical PR because later ones look small.
- [ ] **Do not deploy** after a single merge unless the sitting’s rule says so.

If `database-tests` is red: **stop**. The suite author diagnoses from CI logs and ships the fix on the affected branch. Do not merge around a red pgTAP job.

---

## Stack (update this table when the stack changes)

| Order | PR | Why it is in this sitting | Gate |
|---|---|---|---|
| 1 | **#68** Token/cost accounting | Bottom of the usage stack | Merged `1da635123e296616c272db23d9ec0c3a8baa8f8a` (head `74e9fbb`). **Not deployed.** |
| 2 | **#69** Encrypted secret storage | **Security-critical — key handling.** Extra time. | Wait: `database-tests` red |
| 3 | **#70** Gladia transcription | Flag-off adapter; billed on provider quantity | Wait: stacked on #69 |
| 4 | **#71** Multi-currency (Langdock EUR) | Meter must not sum mixed currencies | Wait: stacked on #70 |
| 5 | **#72** FX at ECB reference rate | Seeds **1.1578 USD/EUR, dated 2026-09-02** | Wait: stacked on #71 |
| 6 | **#73** Transcript ingest | Not open yet | — |

After **#72** is on `main`: refreshing the ECB rate is a **standing monthly ops task**. Preflight should nag when the rate is stale — confirm that check exists before calling the sitting done.

---

## Per-PR (10 minutes, 30 for #69)

- [ ] Diff is the claimed surface (stacked PRs: review *this* PR’s files, not the whole stack).
- [ ] Migrations: additive, new version, grants + `FORCE RLS` if a new table. Never edit an already-applied file.
- [ ] pgTAP: `plan(n)` matches assertions; deferred constraints tested with `SET CONSTRAINTS ALL IMMEDIATE` where needed; fixtures assert they are the thing under test.
- [ ] Worker: usage/cost recording must not fail the job; secrets never in logs.
- [ ] **#69 only:** who holds the key, where it lives at rest, what the DB can see, rotation, and what happens if the key is missing.

Approve → merge (merge commit, keep branch until the stack is done if later PRs retarget). Record **merge SHA**.

---

## After the last PR of the sitting is on `main`

Still **one deploy for the whole stack**, not one per PR.

1. `git fetch` / confirm `main` SHA is the last merge.
2. `docs/server-migrations.md` §1: dry-run, then `supabase db push --db-url`. Migrations **from `main` only**.
3. `docs/production_environment.md` §5.5: `git pull` + `systemctl restart tugpt.service`. Do **not** `git pull` if the box has an uncommitted hotfix.
4. Health: `curl -fsS https://tugpt.app/api/v1/health`; both workers running (`docker compose -p tugpt ps`).
5. `sudo sh deploy/check-host.sh` → 0 failed. Cert check if TLS was touched.
6. Preflight: `docs/server-migrations.md` §4.
7. **Do not** flip `ai_draft_generation` or `whatsapp_integration` here.

---

## Do not

- Merge a red `database-tests` head.
- Deploy #68 (or any prefix) alone.
- Apply migrations from a feature branch.
- Dig pgTAP failures in a review sitting if the suite author owns the diagnosis.
- Enable outbound WhatsApp from this checklist.
