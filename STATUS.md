# ODOS Build Status

**Generated:** 2026-07-07
**Current odos tag:** `v0.6a` at commit `ce6e94f` (main has since shipped Tier-2 cash dispensary #19–#21, the v0.6c payments kernel + card path #22–#23, the ODOS scheduler #24–#30, and the scheduler Pass-2 follow-ons #31–#34, #36, #38 — all currently untagged; v0.6c tags at slice close)
**Branch:** `main` at `ccc097e`

This is the operator-facing dashboard: what works end-to-end, what's verified, what's not production-ready, what's next. Full per-milestone build narrative is in [`docs/build-log/`](docs/build-log/). Architectural rationale lives in the companion private business repo at [`performance-od`](https://github.com/drbang-iva/performance-od).

For the architectural overview + working-directory conventions, see [`AGENTS.md`](AGENTS.md). For the distilled current-state operator view (one-pager), see [`docs/operator-dashboard.md`](docs/operator-dashboard.md).

---

## What works end-to-end today

### v0.55 integration spine (SHIPPED 2026-05-05, odos tag `v0.55` at `e8c8d9e`)

- SMART on FHIR v2 authorization with patient-directed token revocation per §170.315(g)(10)(vi) 1-hour window
- SMART app registry — third-party SMART apps integrate via the local registry; seed catalog ships empty
- CDS Hooks 2.0.1 with locally-enforced service trust (external CDS off by default; opt-in only)
- AgentOps governance — every AI agent action audited, blockable, undoable; Device-AIAST agent identity (hybrid per-agent + per-vendor-model linked via `Device.parent`)
- Bulk Data $export (FHIR Bulk Data 1.0.0 STU1)
- §170.315(g)(10) Patient Access API with patient-directed authorization
- SMART Backend Services with file-download trust-boundary split
- Truthful CapabilityStatement with severity-aware suppression
- Information Blocking Safety Valve composition (RFC 7807 problem-details + 10-code §171 enum)

### v0.55 substrate (shipped Apr 2026)

- Identity + RBAC + AccessPolicy (5 role types: provider, tech, front-desk, billing, admin)
- Audit substrate — every PHI access fires `AuditEvent`; durable attribution via `Provenance`
- DR drill: broad isolated backup/restore integrity + v0.6a frames 32/32 canonical checks + 5/5 table integrity
- Scribe attestation / amendment substrate (compensating-transaction rollback reuses v0.5c nullify/amend)
- Local-hardware setup wizard (`npm run setup-practice`)
- Local preflight linter (`npm run preflight`) — Pass 4 custom lint rules (19 active)
- Local Medplum foundation (Postgres + Redis + Medplum server via Docker Compose)
- HL7 v3 ActCode + ObservationValue (AIAST / DICTAST / CPLYCUI)
- Clinical encounter UI baseline (patient picker, comprehensive exam start, structured-finding section saves, sign + finish)

### v0.6a Frames Data (SHIPPED 2026-05-09, odos tag `v0.6a` at `ce6e94f`)

- HCPCS V-series terminology sync (`odos_terminology_hcpcs`)
- `odos_frames_catalog` — append-only Type-2 SCD catalog table (~500K-1M industry SKU capacity)
- `odos_practice_frames_inventory` — per-practice inventory state with FK to canonical catalog
- FHIR `ChargeItemDefinition` builder cross-referencing frame SKUs via canonical URLs
- Frames Data ingest — bulk-file-ingest pathway (Access-Point-like local-subscriber workflow; no outbound HTTP to vendor)
- Inventory management UI primitive
- 11 new AuditEvent event_types (frames bulk + hcpcs + csv export + subscription toggle)

### Tier-2 cash dispensary (SHIPPED 2026-07-03/04, PRs #19–#21)

- Cash spectacle order kernel — DeviceRequest (order, `basedOn → VisionPrescription`) + Task 17-status lifecycle (`businessStatus`) + ChargeItem lines + CASH/CHECK Invoice with `odos-payment-tender` extension + PPAY/FAMILY discount priceComponents; single FHIR transaction Bundle
- Frame attach/dispense with version-guarded inventory decrement (reuses v0.6a Frames Data)
- Lab-order emitter T0 — DCS/OMA-shaped model + printable lab sheet (transport-independent; T1 direct-DCS deferred)
- Patient receipt / financial summary — hard-reconciled to `Invoice.totalGross/totalNet` (throws on mismatch); printable
- Proven by live end-to-end walkthrough on the local Medplum stack (order → payment → lifecycle → dispense → lab sheet → receipt)

### v0.6c payments kernel + card path (SHIPPED to main 2026-07-05, PRs #22–#23; v0.6c closes after Stripe test-mode + live front-desk walkthrough)

- Invoice↔PaymentReconciliation seam — Invoice = the bill; PaymentReconciliation = the settling processor payment (`detail[0].request → Invoice`); manual cash/check keeps the Invoice tender extension and emits no PR (seam spec, performance-od 2026-07-05)
- Vendor-neutral `PaymentProcessorAdapter` (charge/refund/void/settle/status) + manual-cash adapter + Clover REST Pay Display adapter (cloud, doc-verified shapes; OAuth token never persisted)
- Unified `POST /payments/charge` on odos-core — the processor secret lives server-side only; 9 new `payment.*` audit event types
- Payments authorization model — caller-token PR writes governed by Medplum AccessPolicy; front-desk dispensary RBAC grants at practice scope (also fixes the latent gap that made the cash order flow admin-only); identity-derived role gate via the `practice-role` `meta.tag` on AccessPolicy (no client role header)
- Dispensary card checkout UI — untendered order → device charge → PR-backed receipt; declined/failed leaves the order payable; receipt-consistency guard (cash vs card render identical money) mutation-proven

### ODOS scheduler — unified, modular, FHIR-native (SHIPPED to main 2026-07-06, PRs #24–#30; untagged)

Front-desk-first scheduler serving three clinic modes (eyecare-only / aesthetics-only / both-combined) selected by practice config; design brief in performance-od 2026-07-06. Built one slice per PR, each through a multi-agent close audit + fix round (~48 confirmed findings caught-and-fixed across the series, zero broken merges).

- **Data model + service layer** (#24) — clinic-mode axis (discipline visibility filtering); visit-type catalog as `HealthcareService` (duration/color/eligible-resources via `odos-*` extensions, new types are DATA); resources as `Schedule` actors (Practitioner/Location/Device); `Appointment` builder on the Eyefinity model — serviceType, vision+medical coverage extensions, two status axes (Appointment Status ↔ R4 `appointment-status`; Confirmation Status extension), urgent/follow-up; availability → `Slot` from operating hours + blocked time. Service layer has zero UI coupling.
- **Day-view resource grid** (#25) — columns = mode-filtered resources, color-by-type blocks with billing-context-on-block, free/busy/blocked shading, v8 dark palette; live clinic-mode selector.
- **Appointment CRUD** (#26) — Eyefinity details modal, patient quick-card (masked SSN, balance), book/edit/move/cancel/check-in, non-patient blocks; merge-onto-real-resource update path (preserves `slot`/foreign extensions), server-side conflict scope.
- **Front-desk scheduling RBAC** (#27) — `Appointment` create/read/update + `Schedule`/`Slot`/`HealthcareService` read at practice scope; the scheduler is operable under a real front-desk login.
- **Config persistence** (#28) — practice scheduling config (hours, per-resource templates, blocked time, offices) persists as one coded `Basic` singleton (`odos-scheduling-config`), criteria-fenced front-desk grant.
- **Settings + offices + find-next-available** (#29) — hours/blocked-time/offices editors, config hydration, office selector, Find Open (Eyefinity "Find Open") feeding the booking modal.
- **Week + month views** (#30) — Monday-start week (single resource × 7 days) and month density-scan calendar; one ranged query per window; verified-correct calendar math (leap Feb, day-of-month clamp, practice-local bucketing).

### ODOS scheduler Pass-2 follow-ons (SHIPPED to main 2026-07-07, PRs #31–#34, #36, #38; untagged)

Post-#30 refinements, each its own slice + PR, each through the gate set (ui build + mcp suite + Pass-4 preflight):

- **Pass-2 foundation** (#31) — shared `ResourceDayColumn` extracted so day + week render through one block component (restores the week's dropped insurance line + badges); week/month→day wrong-day render flash fixed via day-scoped `appointmentsByDay[date]` + an atomic `openDay` action; Find-Open gated to day view; two dead exports removed. This extraction is also the seam the exploded/Plexus renderer plugs into.
- **Out-of-hours rendering** (#32) — appointments booked outside a resource's operating hours now expand the time axis to cover them, instead of bucketing to the right day but silently not rendering (day + week).
- **Demo-seed script** (#33) — `npm run seed-scheduler` seeds resources / visit-types / appointments for local front-desk walkthroughs.
- **Per-office booking increment** (#34) — 10/15/30/60-min grid granularity configurable per office (Settings → Offices; `resolveSlotMinutes`).
- **Vertical zoom** (#36) — a `−`/`+` toolbar control scales row height (`round(ROW_HEIGHT × zoom)`, clamped `[0.5, 1.75]`) independently of the booking increment, so a fine increment no longer makes a single hour fill the screen; session-scoped viewing preference shared by day + week.
- **Short-block content density** (#38) — a 10/15-min block (~40px) no longer clips: below a height threshold it shows a compact cue strip (status glyph + urgent/billing attention dots), and the full clipped detail (both status axes, insurance line, badges) moves to a read-only hover card (keyboard-focus accessible). Pure `scheduler-block-density` module (11 new tests) + `AppointmentHoverCard`. First shipped rung of the front-desk cockpit disclosure ladder (design doc below).

---

## What's verified

### v0.6c payments evidence (2026-07-05, PRs #22–#23 both CI-green: mcp typecheck+tests, ui build, Pass 4 preflight, CodeRabbit)

| Gate | Result | Source |
|---|---|---|
| Broad MCP suite | 1293 pass / 23 fail — all 23 are live-Medplum integration tests (local stack down; same set skips on CI) | `npm test` (mcp) |
| Payments-boundary tests (seam, adapters, dispatch, endpoint, RBAC, resolver, UI helper) | ~60 new tests green across 7 test files | `mcp/tests/payment*.test.ts`, `cloverAdapter`, `manualCashAdapter`, `opticalCheckoutPaymentUi`, `v05a-authz` additions |
| Receipt-consistency guard (§8: cash vs card identical money) | green, mutation-proven | `mcp/tests/paymentSeamConsistency.test.ts` |
| Attribution invariant (body-supplied staffReference ignored) | green (impostor test) | `mcp/tests/paymentChargeHandler.test.ts` |
| PCI posture | no token/PAN path; Clover OAuth token asserted absent from persisted PR | grep gate + unit assertion |
| `tsc --noEmit` (mcp) + ui build | clean | local + CI |
| Mandate 14 ledger | seam + Clover + endpoint + RBAC rows | `data/code-bindings/payment-reconciliation-seam-ledger.md` |

### Tier-2 cash dispensary evidence (2026-07-03/04)

- Live end-to-end DoD walkthrough on the local Medplum 5.1.8 stack: order → frame attach (inventory 3→2) → PPAY discount → CASH payment Bundle → lifecycle to dispensed; server-side verification of the full FHIR graph
- Full mcp suite 1265/1265 green against the live stack at merge time (PR #19); receipt hard-reconciliation proven on live data (PR #21)

### v0.6a close evidence (2026-05-09)

| Gate | Result | Source |
|---|---|---|
| v0.6a fixture tests | 14/14 (consolidated from 22 fixture concepts) | `mcp/tests/v06a-frames-data.test.ts` |
| Pass 4 lint | 19/19 rules clean, 0 warnings | `npm run preflight` |
| DR drill | broad restore integrity + v0.6a frames 32/32 canonical checks + 5/5 table integrity | `npm run dr-drill` |
| Broad MCP suite | 1201/1201 (1187 v0.55e baseline + 14 new v0.6a) | `npm test` |
| Mandate 14 verification ledger | 10/20 rows closed at consumption time | `data/code-bindings/v0.6-verification-ledger.md` |
| Mandate 15 boundary audit | 3 checks appended | `docs/build-log/2026-05-09-v0.6a-frames-data.md` |
| v0.55a-e substrate | Untouched (one v0.35b role-list regression fixed in same commit) | broad suite rerun clean |

### v0.55 close evidence (2026-05-05)

- Broad MCP suite: 1187/1187 fresh stack + 1187/1187 restored stack
- Focused v0.55e suite: 34/34
- DR drill: 32/32 + 5/5 integrity (audit_events 62/62, Provenance 10/10, Binary 4/4, AccessPolicy round-trip)
- 5/5 close-audit steps cleared: HTI-5 Proposed Rule verified; HL7 AI Transparency IG carry-into-v0.6; first-eyecare-marketplace artifact removed; §170.315(g)(10)(viii)(B) eCFR verified; test-count regression observation cleared

### Audit math (v0.6a)

13 SQL mutations → 26 fan-out FHIR resources (DeviceDefinition + ChargeItemDefinition) → 1 FHIR Task wrapper + 26 + 26 + 1 + 1 = **55 attribution artifacts per ingest run**. `Provenance.target` references FHIR canonical URLs, never raw SQL row PKs.

---

## What is NOT production-ready

| Capability | Status | Lands at |
|---|---|---|
| Insurance eligibility check | Not built | v0.6b PVerify (next) |
| Card payments | **Code-complete, not yet live-validated** — Clover adapter + charge endpoint + checkout UI shipped; live card-present gated on Clover sandbox Dev Kit / bank ISV answer; Stripe test-mode adapter pending operator account update | v0.6c close |
| Patient financing (CareCredit / Cherry / Sunbit) | Not built (adapter slots exist) | v0.6c+ per practice demand |
| Electronic claim submission | **Shipped, not yet live-validated** — Stedi 837P submission, 277CA retrieval, ERA queues, and eight claims screens are implemented; live use remains gated by practice enrollment and clearinghouse configuration | v0.6d close |
| DICOM device integration | Not built | v0.6e DICOM Supp 247 |
| E-prescribing | **Code-complete, not yet live-validated** — deliberate saved-prescription WENO Switch NewRx send, durable send guard, and preferred-pharmacy snapshot are implemented; certification and the separate inbound ERROR/VERIFY receiver remain go-live gates | v0.6f close |
| Payer FHIR connectors (270/271 alt) | Not built | v0.6g |
| HIPAA-compliant email | Not built | v0.6h Paubox |
| TEFCA / Direct Trust messaging | Not built | v0.65 (scope-reduced per HTI-5) |
| MIPS / MVP reporting | Not built | v0.7 |
| CPT third-party vendor integration | Not built | v0.7 |
| ONC certification execution | Not built | v0.8 |
| General-purpose customer install path | Not built | post-Tier-1 pilot validation |

Plus the operational lessons that carry forward into v0.6b: see [`docs/operator-dashboard.md`](docs/operator-dashboard.md) for the four v0.6a-operational lessons (#32-#35) and the forward-gate table.

---

## Known gaps + safety limits

- **Medplum AuditEvent does not surface `X-ODOS-Source` in 5.1.8.** Verified empirically at v0.2.5. ODOS still sends the header for ingress attribution; FHIR `Provenance` is the durable per-resource attribution path.
- **Medplum 5.1.8 mixed transaction-response handling.** Server can return a mixed transaction-response instead of rolling back every successful entry after a later entry failure. ODOS client transaction helpers compensate by deleting resources created in the failed response. Section-save tests assert no created clinical resource persists after the covered failure mode.
- **Frames Data AV-roster Ledger #8** carries a `[provisional — single-source as of 2026-05-09]` flag in v0.6a error messages until a secondary independent source corroborates beyond Noridian DME MAC.
- **Profile snapshots are intentionally checked in.** Medplum profile validation requires snapshots in this stack; source files in `data/profiles/` are larger than hand-written differentials.
- **No claim of HIPAA "compliance" as a software product.** The practice is the covered entity. ODOS ships infrastructure that makes compliance *operationally achievable* (local-only, audit-by-default, BAA-free posture). The pilot README states this explicitly.
- **No claim of ONC certification.** §170.315(g)(10) Patient Access *surface* shipped at v0.55e; full ONC certification is a v0.8+ gate.
- **No claim of production-readiness at v0.6a.** This is developmental code under milestone-locked development.

---

## v0.6c close-out checklist (remaining)

- [ ] Stripe TEST-MODE adapter (operator updating the Stripe account; drops into the dispatch as one adapter file + env registration)
- [ ] Clover sandbox operator steps (`docs/payments-clover-sandbox.md`) — developer account, test merchant, RAID, OAuth token; live card-present gated on Dev Kit purchase decision / bank ISV answer
- [ ] AccessPolicy re-seed so existing policies carry the `practice-role` `meta.tag` (pre-pilot: safe; noted in `docs/install.md`)
- [ ] Live walkthrough as a REAL front-desk user (not admin) — cash regression + endpoint rail (manual-cash method) + card path once a processor target exists
- [ ] Front-desk frame-inventory dispense grant (the remaining piece for a fully non-admin cash walkthrough; small follow-on)
- [ ] Tag `v0.6c` + close audit

## ODOS scheduler — remaining

Shipped since the #24–#30 core (all 2026-07-07): Pass-2 foundation (#31), out-of-hours rendering (#32), demo-seed (#33), per-office booking increment (#34), vertical zoom (#36), short-block density (#38) — see the shipped subsection above.

**Front-desk cockpit design (Fable, 2026-07-07).** The design-forward work is now a committed spec: `performance-od/decisions/2026-07-07-odos-frontdesk-cockpit-design.md` — a host+guest-layers cockpit (swappable Schedule/Floor center + phone-width comms panels behind an iOS-badge dock), covering the disclosure ladder, the floor board (auto-location trust rules, typed waits, pinned staff jobs), the comms organs with a GHL-first `CommsProvider` seam, and a `ScheduleProvider` seam (native default; Foxfire adapter open). Phase 1 (short-block density) shipped as #38; Phases 2–8 are mechanical builds off the locked spec.

- [ ] **Cockpit Phase 2 — shell** — `/frontdesk` route: swappable center stage (Schedule ⇄ Floor), badge dock, guest-panel mechanics (slide-over, drag-to-float, per-workstation memory).
- [ ] **Cockpit Phases 3–8** — floor board + auto-location + typed waits/jobs (floor track); GHL `CommsProvider` + Messages/Calls/Requests/Call Pop + Team Chat + Reviews (comms track). See design doc §8.
- [ ] **Live front-desk walkthrough** — book/move/check-in a synthetic patient on the local stack under a real front-desk login; validates the #27 grants + the Pass-2 fixes end-to-end. Operator-driven (agent does not drive auth); seed is ready via `npm run seed-scheduler`.
- [ ] **Operator decision** — practice-wide `Patient` read for the booking picker (currently patient-compartment scoped; widening PHI scope is an operator-level authz call).

## Next-release checklist (v0.6b PVerify)

- [ ] Author Wave-1 codex prompt (substrate + builders + UI per Lesson 33 sub-prompt split)
- [ ] Drive Gem `gem-knowledge-v0.6b` folder + GPT custom-instructions refresh (Mandate 16 absence-audit pre-flight)
- [ ] Wave-2 ODOS Architect GPT pressure-test
- [ ] Wave-3 ODOS Architect Gem independent review (fresh chat, no Wave-2 exposure)
- [ ] Wave-4 ODOS Architect Gem triangulation (Wave-2 in Knowledge folder)
- [ ] Integrate binding amendments into Wave-1 prompt
- [ ] Operator paste into Codex Cloud → execute on odos branch `drbang-iva/v0.6b-pverify`
- [ ] All Wave-1 acceptance criteria gates clear (fixtures + Pass 4 lint + DR drill + broad suite + ledger pre-flight)
- [ ] PR review + squash-merge + tag `v0.6b`
- [ ] Close audit: PROVISIONAL ledger items, HTI-5 named-checkpoint status, Anthropic per-commit re-verify if surface touched, operational lessons captured

---

## Pilot-readiness checklist (Tier-1 "Install + Chart + Safety")

Tier-1 has zero in-flight v0.6 dependencies. v0.55 + v0.6a substrate is what we validate first.

- [ ] Document install steps end-to-end (`docs/install.md` expanded coverage)
- [ ] Verify install on practice hardware (the proving-ground practice's own Mac Studio, NUC, or Linux box)
- [ ] Confirm `npm run preflight` clean on non-dev hardware
- [ ] Onboard admin Practitioner + AccessPolicies via setup wizard
- [ ] Chart a real test visit (refraction, IOP, anterior/posterior segment, sign + finish)
- [ ] Verify `AuditEvent` count for the visit: canonical synthetic Tier-1 visit baseline is 8 ODOS audit rows + 8 FHIR AuditEvent projections (`npm run audit-verify`)
- [ ] Run DR drill on practice hardware — broad restore integrity plus v0.6a frames 32/32 + 5/5 must pass
- [ ] Patient Access API returns valid bulk NDJSON for the test patient
- [ ] CapabilityStatement reflects truthful certification posture (not certified as a complete system; specific surfaces named)
- [ ] Documented gaps section in `docs/install.md` enumerates every v0.6+ capability still in flight

Full Tier-1 acceptance criteria + rationale + v0.6 ranking against pilot tiers: [`docs/operator-dashboard.md`](docs/operator-dashboard.md).

---

## How to verify locally

```bash
# 1. Stand up the Medplum stack
npm run up
docker-compose ps  # all three: running (healthy)

# 2. Install Node deps + FHIR profiles
npm install
cd mcp && npm install && cd ..
npm run install-profiles  # idempotent

# 3. Run MCP test suite
cd mcp && npm test
# Expected: 1201/1201 passing (v0.6a baseline)

# 4. Run UI checks
cd ui && npm install && npm run build
# Expected: build clean; existing large-chunk warning only

# 5. Run preflight + DR drill
npm run preflight  # Pass 4 lint, 19 rules, 0 warnings
npm run audit-verify  # 8 ODOS audit rows + 8 FHIR AuditEvent projections
npm run dr-drill      # broad restore integrity + v0.6a frames 32/32 + 5/5

# 6. Smoke test
npm run poc
# Expected: ✓ Logged in / ✓ Created Patient / ✓ Created Encounter / ✓ Created ChargeItem
```

---

## Reference docs (canonical)

Inside this repo:

- [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md) — current-state agent + architecture brief
- [`README.md`](README.md) — public-facing intro + developer quickstart
- [`docs/operator-dashboard.md`](docs/operator-dashboard.md) — distilled current-state view + Tier-1 milestone + v0.6 ranking
- [`docs/install.md`](docs/install.md) — install walkthrough
- [`docs/build-log/`](docs/build-log/) — full per-slice build evidence
- [`data/code-bindings/`](data/code-bindings/) — verification ledger files

Companion **private** business repo ([`performance-od`](https://github.com/drbang-iva/performance-od) — maintainer-only):

- Master build sheet, mandates, per-slice decisions, four-wave triangulation research files, first-pilot-milestone decision + bet, episodic memory.

---

## License

AGPL-3.0 application code. Apache-2.0 dependencies underneath. Derivative works must share source — practitioner-owned, practitioner-shared.

- Communication matrix server slice: suppression-first preferences, consent evidence routes and bounded evidence-gap export implemented on the task branch; independent evaluation and preference screens remain pending.
