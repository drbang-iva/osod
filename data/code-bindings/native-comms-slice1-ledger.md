# Native communications Slice 1 verification ledger

Access date: 2026-07-30

Scope: vendor-neutral `CommsProvider`, Google Workspace Gmail API adapter, FHIR R4
`Communication` send-state, shared suppression gate, and tracked-link `Basic` records. No medical,
billing, or medication codes are asserted.

## Google Workspace API

| Artifact | Chosen value | Source 1 URL | Source 2 URL | Access date | Status |
|---|---|---|---|---|---|
| Unattended Workspace authorization | Service account with domain-wide delegation; Super Admin authorizes client ID and scopes once; delegated JWT `sub` is the Workspace user being impersonated | https://developers.google.com/workspace/guides/create-credentials#domain-wide_delegation | https://developers.google.com/identity/protocols/oauth2/service-account | 2026-07-30 | verified |
| Least-privilege send scope | `https://www.googleapis.com/auth/gmail.send` | https://developers.google.com/workspace/gmail/api/auth/scopes | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send | 2026-07-30 | verified |
| Send endpoint and payload | `POST /gmail/v1/users/{userId}/messages/send`; RFC 2822 MIME carried as base64url `raw`; successful response includes Message id | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send | https://developers.google.com/workspace/gmail/api/guides/sending | 2026-07-30 | verified |
| Paid Workspace Gmail daily limit | 2,000 messages per user over a rolling 24 hours; Google says limits can change without notice | https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace | https://developers.google.com/workspace/gmail/api/reference/quota | 2026-07-30 | PROVISIONAL — one primary source for the mailbox limit; the API quota page documents separate rate quotas |
| PHI operator prerequisite | Customer must accept Google's BAA in Admin console before using PHI; Gmail API cannot verify acceptance | https://knowledge.workspace.google.com/admin/compliance/hipaa-compliance-with-google-workspace-and-cloud-identity | https://workspace.google.com/terms/2015/1/hipaa_functionality/ | 2026-07-30 | verified |

## FHIR R4 persistence

Element names were also read from the installed
`@medplum/fhirtypes/dist/Communication.d.ts`, `Basic.d.ts`, `Appointment.d.ts`, and `Patient.d.ts`
and are typechecked by `cd mcp && npx tsc --noEmit`.

| Artifact | Chosen value | Source 1 URL | Source 2 URL | Access date | Status |
|---|---|---|---|---|---|
| Outbound send-state | `Communication` with `identifier`, `status`, `category`, `medium`, `subject`, `about`, `sent`, and `payload.contentString` | https://hl7.org/fhir/R4/communication.html | https://build.fhir.org/communication.html | 2026-07-30 | verified |
| Send natural-key idempotency | conditional create with `If-None-Exist: identifier={system}\|{value}` before provider dispatch | https://hl7.org/fhir/R4/http.html#ccreate | https://hl7.org/fhir/R4/search.html#token | 2026-07-30 | verified |
| Appointment anchor and portable search | `Appointment.start`/`.end` are FHIR dateTime fields; the standard R4 `date` search targets `Appointment.start`, so end-anchor campaigns query `date` with explicit padding and filter `.end`; Patient is resolved from `participant.actor` | https://hl7.org/fhir/R4/appointment.html | https://www.hl7.org/fhir/R4/searchparameter-registry.html | 2026-07-30 | verified |
| Email resolution | `Patient.telecom` ContactPoint where `system = email`, excluding `use = old` and expired periods | https://hl7.org/fhir/R4/patient.html | https://build.fhir.org/patient.html | 2026-07-30 | verified |
| Tracked-link and click records | local coded `Basic` resources with identifiers and ODOS extensions | https://hl7.org/fhir/R4/basic.html | https://build.fhir.org/basic.html | 2026-07-30 | verified |

## Suppression law and local vocabulary

The shared gate conservatively applies the same clamp to every Slice-1 email send so future SMS and
call adapters cannot bypass it. The federal time window directly governs telephone solicitations;
applying it to reminder email too is an ODOS conservative product rule, not a claim that the cited
telephone rule independently regulates email.

| Artifact | Chosen value | Source 1 URL | Source 2 URL | Access date | Status |
|---|---|---|---|---|---|
| Quiet-hours window | 8:00 a.m. inclusive through 9:00 p.m. exclusive at the called party's local time; outside-window queue resumes at next 8:00 a.m. | https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200 | https://docs.fcc.gov/public/attachments/DOC-290134A1.pdf | 2026-07-30 | verified |
| Review-request frequency cap supported by config but not enabled for reminders | 90 days for future `review-request` campaign rows | accepted design `performance-od/decisions/2026-07-30-odos-review-request-module-design.md` | `mcp/tests/commsSuppression.test.ts` | 2026-07-30 | verified (local) |
| ODOS extensions and code systems | comms opt-out, patient timezone, send claim/anchor/offset/reschedule/provider message metadata, tracked-link metadata; local campaign/channel/basic-kind vocabularies; preference cells, consent scope/capture and purpose/surface/capture-method/consent-category vocabularies (matrix extension 2026-09-11) | `mcp/src/comms/` and `mcp/src/reminders/` | `data/canonical-extensions/registry.json` | 2026-07-30 | verified (local) |

| Communication evidence Consent | R4 active status, required scope and category; patient-privacy scope; permit provision; policy URI satisfies ppc-1 | https://hl7.org/fhir/R4/consent.html and https://hl7.org/fhir/R4/valueset-consent-scope.html | https://hl7.org/fhir/R4/consent-definitions.html and https://terminology.hl7.org/CodeSystem-consentscope.json; installed @medplum/fhirtypes 4.5.2 Consent declaration | 2026-09-11 | verified |
| Complex preference/evidence extensions | Extension base canonical, URL discriminated child slices and constrained value types | https://hl7.org/fhir/R4/extension.profile.json | https://hl7.org/fhir/R4/extension-patient-birthplace.json and https://hl7.org/fhir/R4/elementdefinition-definitions.html; installed StructureDefinition and ElementDefinition declarations | 2026-09-11 | verified |
| Consent update constraint | Medplum evaluates the incoming resource with previous stored resource available as %before; only status and server version metadata may change | https://www2.medplum.com/docs/access/access-policies | https://github.com/medplum/medplum/blob/v5.1.30/packages/server/src/fhir/repo.ts#L2104-L2113 | 2026-09-11 | verified; synthetic 5.1.30 create/status update accepted and policy-content change denied for staff, provider and admin |
