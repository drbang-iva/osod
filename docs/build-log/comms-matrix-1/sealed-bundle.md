# MATRIX-1 server implementation — author handoff

Status: needs independent review; eight base-matching full-suite environment failures remain. No independent evaluation. Base: `78a8ef6f7691ccffad2a752231f818ae2d9668bd`. Branch: `drbang-iva/comms-matrix-1`.

## Behavior

Suppression takes precedence over explicit cells and defaults. Patient preferences cover five purposes and four channels. Unknown campaign types and malformed preference extensions fail closed. Marketing email defaults ON without a legacy consent record; an email opt-out still blocks. System marketing SMS still requires legacy consent and an allowed matrix cell.

Staff transactional education email can override an explicit withheld education/email cell. Only after a successful send, a fresh versioned write records the cell ON with staff attribution. Any failed flip, including a conflict, preserves the sent result and reports `preferenceUpdate: "failed"` on the staff-only response. Automated enrollment outcomes do not gain that field.

Accepted START restores only the four nonmarketing SMS cells. Refused START writes no cells. Preferences, consent evidence, and registration use the shared cell replacement mechanic, preserving opt-out extensions exactly. Consent evidence is separate from permission; the send gate does not read Consent.

## Preconditions and scope

The base contains the required squash merge. Every premise was rechecked by symbol using the updated line map. Production campaign types at base: `staff-initiated` (staff compose), `clinical-education` (preflight and both education channels), and `appointment-reminder` (the default reminder template). Environment configuration changes the reminder channel, not its campaign type. Test-only names are inventoried below.

No production writer of a legacy marketing-consent extension or opt-out campaign-type child was found at base. Frequency-cap behavior remains unchanged: the worker maps a recorded frequency-cap suppression to `patient-opt-out`; only `preference-withheld` now survives as its distinct hold reason. This is a source-observed behavior, not a claim that frequency-cap semantics were repaired.

## Verification

[Full-suite failure comparison](failure-comparison.md) records the base and branch runs, all 23 initial failures, and their disposition. Final branch command `npm --prefix mcp test`: 4,626 total, 4,613 passed, 8 failed, 5 skipped, exit 1. Both clean-base runs: 4,578 total, 4,565 passed, 8 failed, 5 skipped, exit 1. Failure-name sets match exactly; zero branch-only failures. The new live proof executes on its own server rather than consuming the ordinary suite’s quotas. UI full command `npm --prefix ui test`: 1,341 tests, 1,341 passed, zero failed/skipped, exit 0. MCP and UI production builds each exited 0 after adding PUT to the route registrar's type interface.

[Mutation evidence: G1–G21 plus G19b](mutations/README.md). G1b injects an unsafe explicit-ON return before suppression; a return after suppression cannot defeat an already-returned STOP refusal. Every mutation is restored.

The proxy census discovered 24 backend route families and 27 proxy entries, all covered, exit 0. It is advisory and does not prove UI wiring. This server slice adds no UI control.

## Real policy evidence

The dedicated local synthetic Medplum 5.1.30 proof accepted the production Consent builder for staff, provider and admin (201), allowed status-only changes (200), and denied evidence-content changes (403). Removing the Consent grant denied creation (403). The actual evidence HTTP route returned 200 with the generated staff grant and 403 without it; G9 deleted the production staff rule and made that success assertion fail.

[Live fixture cleanup](live-fixture-cleanup.md) records the corrected teardown and earlier owned-policy cleanup. [Actual next-link capture](live-next-link.log) verifies two real Patient pages.

The synthetic policy explicitly binds the test patient's compartment, including admin; this does not prove every deployed membership has correct compartment parameters. No real patient or shared deployment was used. Tests with in-memory FHIR clients alone do not prove AccessPolicy enforcement.

Medplum documents `%before` in [Access policies](https://www2.medplum.com/docs/access/access-policies); [server source at v5.1.30](https://github.com/medplum/medplum/blob/v5.1.30/packages/server/src/fhir/repo.ts) supplies the previous resource to write-constraint evaluation. Accessed 2026-09-11. Exact constraints compare all Consent content with presence guards while permitting only status and server-managed version metadata changes. Local FHIRPath tests exercise the unchanged and changed fields. The live proof demonstrates enforcement rather than only expression evaluation.

## Approved existing-test changes

Exact suppression-context comparisons retain exact equality and all prior fields/values:

| File:line | Added field/value |
|---|---|
| mcp/tests/commsApi.test.ts:423 | consentClass = transactional |
| mcp/tests/commsApi.test.ts:424 | consentClass = marketing |
| mcp/tests/educationDispatchActor.test.ts:46 | consentClass = transactional |
| mcp/tests/educationDispatchActor.test.ts:236 | consentClass = marketing |

Marketing changes in `educationDispatchActor.test.ts`: line 120 now holds `no-recipient-channel` for email without an address; adjacent SMS with a phone and no legacy consent holds `preference-withheld`. The prepared-send loop at line 203 sends email once without legacy consent; its adjacent email opt-out companion suppresses with `patient-opt-out` and zero calls. SMS remains suppressed, relabeled `preference-withheld`. The new staff email case at line 254 proves both default sending and opt-out suppression. The existing SMS API assertion remains 409 `marketing-consent-absent`. The loop title says “rechecks” to accurately describe both channels.

Guard inventories add only Consent and its derived count. The policy reordering fixture carries `writeConstraint`; both original assertions remain unchanged. [Generated search contract and extraction output](consent-search-contract.md) and [guard demonstrations](mutations/README.md) are retained alongside this bundle. The full fixture/inventory paths are `tests/preflight/fhir-read-grant-check.test.ts:311,382`, `tests/setup-wizard/access-policy-rules.test.ts:40`, and `mcp/tests/searchParamContract.test.ts:146`.

## Test-only campaign literal inventory

Lines below refer to base `78a8ef6f`. “Never reaches the gate” means the new fail-closed purpose-resolution step: STOP cases still traverse the existing suppression check and return before purpose lookup. Six literals were replaced and fourteen untouched. Every replacement is `staff-initiated`, retaining the original test's matrix-exempt behavior; none required appointment-reminder.

- mcp/tests/awsSqsInboundReceiver.test.ts:76 — untouched — never reaches the gate
- mcp/tests/commsConfig.test.ts:228 — replaced with staff-initiated
- mcp/tests/commsConfig.test.ts:671 — untouched — never reaches the gate
- mcp/tests/commsPersistence.test.ts:92 — untouched — never reaches the gate
- mcp/tests/commsPersistence.test.ts:142 — untouched — never reaches the gate
- mcp/tests/commsPersistence.test.ts:198 — untouched — never reaches the gate
- mcp/tests/commsSuppression.test.ts:196 — replaced with staff-initiated
- mcp/tests/commsSuppression.test.ts:232 — untouched — never reaches the gate
- mcp/tests/commsSuppression.test.ts:821 — replaced with staff-initiated
- mcp/tests/commsSuppression.test.ts:870 — replaced with staff-initiated
- mcp/tests/commsSuppression.test.ts:905 — replaced with staff-initiated
- mcp/tests/commsSuppression.test.ts:910 — replaced with staff-initiated
- mcp/tests/twilioAdapter.test.ts:205 — untouched — never reaches the gate
- mcp/tests/twilioAdapter.test.ts:248 — untouched — never reaches the gate
- mcp/tests/twilioAdapter.test.ts:293 — untouched — never reaches the gate
- mcp/tests/twilioAdapter.test.ts:300 — untouched — never reaches the gate
- mcp/tests/twilioAdapter.test.ts:350 — untouched — never reaches the gate
- mcp/tests/twilioAdapter.test.ts:361 — untouched — never reaches the gate
- mcp/tests/twilioAdapter.test.ts:403 — untouched — never reaches the gate
- mcp/tests/twilioAdapter.test.ts:482 — untouched — never reaches the gate
- Matching fixture category codes changed consistently: commsSuppression.test.ts base lines 806, 842, 894.

## Scope and follow-ups

UI editing, partner enrollment, kiosk/portal writes, legacy migration/retirement, consent retraction, recall/product-pickup senders, conflict-helper consolidation, and inbound retry remain outside this slice. Call/mail cells are stored and reported but have no new senders. Evidence reporting refuses incomplete Consent search results rather than manufacturing gaps; bounded reports expose truncation/cursor metadata.

Only vocabulary codes written by this implementation were added. FHIR URL and Consent terminology verification is recorded in `data/code-bindings/extension-urls.md` and `data/code-bindings/native-comms-slice1-ledger.md`. No new strategy decision was authored.

## Implementation files

[Complete file manifest, including evidence](files.txt). Additional approved inventory files: `mcp/tests/search-param-contract.ts`, `mcp/tests/searchParamContract.test.ts`, `tests/preflight/fhir-read-grant-check.test.ts`, and `tests/setup-wizard/access-policy-rules.test.ts`.

- `STATUS.md`
- `data/canonical-extensions/odos-comms-consent-capture.json`
- `data/canonical-extensions/odos-comms-consent-scope.json`
- `data/canonical-extensions/odos-comms-preference.json`
- `data/canonical-extensions/registry.json`
- `data/code-bindings/extension-urls.md`
- `data/code-bindings/native-comms-slice1-ledger.md`
- `data/terminology/comms-channel-codesystem.json`
- `data/terminology/comms-consent-capture-method-codesystem.json`
- `data/terminology/comms-preference-surface-codesystem.json`
- `data/terminology/comms-purpose-codesystem.json`
- `data/terminology/consent-category-codesystem.json`
- `docs/aws-sms-comms.md`
- `docs/google-workspace-comms.md`
- `mcp/src/authz/practitioner-reference.ts`
- `mcp/src/authz/roles.ts`
- `mcp/src/clinic/clinic-routes.ts`
- `mcp/src/clinic/patient-registration-endpoint.ts`
- `mcp/src/clinical-graph/provider-assignment-endpoint.ts`
- `mcp/src/comms/comms-api.ts`
- `mcp/src/comms/comms-persistence.ts`
- `mcp/src/comms/comms-preferences.ts`
- `mcp/src/comms/comms-provider.ts`
- `mcp/src/comms/education-enrollment.ts`
- `mcp/src/comms/education-sequence-worker.ts`
- `mcp/src/comms/education-sequence.ts`
- `mcp/src/comms/suppression-gate.ts`
- `mcp/tests/commsApi.test.ts`
- `mcp/tests/commsConfig.test.ts`
- `mcp/tests/commsConsentLive.test.ts`
- `mcp/tests/commsConsentPolicy.test.ts`
- `mcp/tests/commsEvidence.test.ts`
- `mcp/tests/commsPreferenceWrites.test.ts`
- `mcp/tests/commsPreferences.test.ts`
- `mcp/tests/commsPreferencesRoutes.test.ts`
- `mcp/tests/commsStartPreferences.test.ts`
- `mcp/tests/commsSuppression.test.ts`
- `mcp/tests/educationDispatchActor.test.ts`
- `mcp/tests/educationEnrollment.test.ts`
- `mcp/tests/educationSequenceWorker.test.ts`
- `mcp/tests/patientRegistrationAuthz.test.ts`
- `mcp/tests/search-param-contract.ts`
- `mcp/tests/searchParamContract.test.ts`
- `tests/preflight/fhir-read-grant-check.test.ts`
- `tests/setup-wizard/access-policy-rules.test.ts`
- `ui/src/lib/communications-client.ts`

## Commits by spec step

| Step | Commit | Change |
|---|---|---|
| 1 | 873a716d | Purpose map and consent context |
| 2 | dcf65c41 | Effective preference resolver |
| 3 | a296f754 | Gate ordering and marketing behavior |
| 4 | c0542fcb | Worker and persisted refusal reasons |
| 5 | 05a694c7 | Staff email post-send preference flip |
| 6 | 6ac4a15a | Accepted START preferences |
| 7 | 07a4f2fc | Extension registry and vocabulary |
| 8 | 7f677212 | Consent policy constraints |
| 9 | 55bcb8d1 | Versioned writes and evidence routes |
| 10 | a1dd3bca | Registration transaction |
| 11 | ee5c7635 | Server documentation |

Follow-ups: `e60feb35` corrects the prepared-send test title; `47636729` rejects inherited object names in the campaign map; `2d4eae38` applies approved guard inventories, safe bounded paging, compiler interface correction, and new-fixture teardown. `ee6f1bb1` isolates the new live proof on its own server and rejects shared-server configuration. Evidence is committed separately.
