import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Consent, Patient } from "@medplum/fhirtypes";
import { attachCommsConsentEvidence, buildCommsConsent, commsPreferencesWithEvidence, parseConsentEvidenceInput,
  parsePreferenceWriteInput, reportCommsEvidenceGaps, writeCommsPreferences, type CommsPreferenceActor } from "../src/comms/comms-preferences.js";
import { COMMS_PURPOSES, COMMS_PREFERENCE_CHANNELS, readCommsPreferenceCells, replaceCommsPreferenceCells,
  ODOS_COMMS_OPT_OUT_EXTENSION_URL } from "../src/comms/suppression-gate.js";
const actor: CommsPreferenceActor = { actorReference: "Practitioner/staff", actorRole: "staff", recordedAt: "2026-09-11T12:00:00Z", surface: "staff-demographics" };
const scope = [{ purpose: "education" as const, channel: "email" as const }];
function fake(patient: Patient) {
  let transaction: Bundle | undefined;
  return { get transaction() { return transaction; },
    read: async () => patient,
    executeTransactionAsActor: async (bundle: Bundle, _actor: unknown, _headers: unknown, options: { validateResponse: (response: Bundle) => void }) => {
      transaction = bundle;
      options.validateResponse({ resourceType: "Bundle", type: "transaction-response", entry: bundle.entry!.map(() => ({ response: { status: "200 OK" } })) });
      return bundle;
    },
  };
}
test("preference boundary rejects duplicate, excess, invalid enums, dates, and phone patient keys", () => {
  const input = { patientReference: "Patient/p", cells: [{ ...scope[0], allowed: true }] };
  assert.deepEqual(parsePreferenceWriteInput(input), input);
  for (const value of [{ ...input, patientReference: "+15555550100" }, { ...input, cells: [...input.cells, ...input.cells] },
    { ...input, cells: Array(21).fill(input.cells[0]) }, { ...input, cells: [{ purpose: "unknown", channel: "email", allowed: true }] },
    { ...input, confirmedVia: "paper-form" }, { ...input, confirmedVia: "in-person", formDate: "2026-09-10" },
    { ...input, confirmedVia: "paper-form", formDate: "2026-02-30" }, { ...input, confirmedVia: "paper-form", formDate: "2027-01-01" }]) {
    assert.throws(() => parsePreferenceWriteInput(value, actor.recordedAt));
  }
});
test("Consent builder records complete scope, policy and capture; evidence closes only matching active cells", () => {
  const consent = buildCommsConsent("Patient/p", scope, "paper-form", actor, "2026-09-10");
  assert.equal(consent.status, "active"); assert.equal(consent.scope.coding?.[0].code, "patient-privacy");
  assert.deepEqual(consent.performer, [{ reference: "Patient/p" }]);
  assert.equal(consent.policy?.[0].uri, "https://odos2020.com/fhir/comms-consent-policy/paper-form/2026-09-10");
  assert.deepEqual(consent.provision, { type: "permit" });
  const row = (consents: Consent[]) => commsPreferencesWithEvidence({ resourceType: "Patient", id: "p" }, consents).rows.find(row => row.purpose === "education" && row.channel === "email")!;
  assert.equal(row([consent]).evidenceStatus, "recorded");
  assert.equal(row([{ ...consent, status: "inactive" }]).evidenceStatus, "gap");
  assert.equal(row([{ ...consent, patient: { reference: "Patient/other" } }]).evidenceStatus, "gap");
});
test("G2 all twenty cells preserve suppression byte-for-byte; confirmed writes include atomic Consent and provenance", async () => {
  const optOut = { url: ODOS_COMMS_OPT_OUT_EXTENSION_URL, extension: [{ url: "channel", valueCode: "sms" }, { url: "scope", valueCode: "global" }] };
  const fhir = fake({ resourceType: "Patient", id: "p", meta: { versionId: "7" }, extension: [optOut] });
  const cells = COMMS_PURPOSES.flatMap(purpose => COMMS_PREFERENCE_CHANNELS.map(channel => ({ purpose, channel, allowed: true })));
  await writeCommsPreferences(fhir as never, "Patient/p", cells, actor, { confirmedVia: "in-person" });
  const saved = fhir.transaction!.entry![0].resource as Patient;
  assert.deepEqual(saved.extension?.filter(extension => extension.url === ODOS_COMMS_OPT_OUT_EXTENSION_URL), [optOut]);
  assert.equal(readCommsPreferenceCells(saved).length, 20);
  assert.equal(fhir.transaction!.entry![0].request!.ifMatch, 'W/"7"');
  assert.equal(fhir.transaction!.entry!.length, 3);
  assert.ok(readCommsPreferenceCells(saved).every(cell => cell.evidence?.reference === fhir.transaction!.entry![2].fullUrl));
});
test("evidence attachment preserves explicit values and setter metadata without creating default cells", async () => {
  const patient = replaceCommsPreferenceCells({ resourceType: "Patient", id: "p", meta: { versionId: "9" } }, [{ ...scope[0], allowed: false }],
    { recordedAt: "2026-09-09T12:00:00Z", setBy: { reference: "Patient/p" }, surface: "staff-registration" });
  const original = readCommsPreferenceCells(patient)[0];
  const fhir = fake(patient);
  await attachCommsConsentEvidence(fhir as never, parseConsentEvidenceInput({ patientReference: "Patient/p", scope: [...scope, { purpose: "education", channel: "sms" }], method: "in-person" }), actor);
  const cells = readCommsPreferenceCells(fhir.transaction!.entry![0].resource as Patient);
  assert.equal(cells.length, 1);
  const { evidence, ...cell } = cells[0]; assert.deepEqual(cell, original);
  assert.equal(evidence?.reference, fhir.transaction!.entry![1].fullUrl);
});
test("gap report filters tiers using active evidence and refuses incomplete evidence pages", async () => {
  const consent = buildCommsConsent("Patient/p", scope, "in-person", actor);
  const search = async (type: string) => type === "Patient" ? { resourceType: "Bundle", total: 1, entry: [{ resource: { resourceType: "Patient", id: "p", active: true } }] }
    : { resourceType: "Bundle", entry: [{ resource: consent }] };
  const result = await reportCommsEvidenceGaps({ search } as never, { channel: "email" });
  assert.equal(result.rows.length, 4); assert.equal(result.counts["3"], 4); assert.equal(result.truncated, false);
  await assert.rejects(reportCommsEvidenceGaps({ search: async (type: string) => type === "Patient" ? search(type) : { resourceType: "Bundle", total: 1, entry: [], link: [{ relation: "next", url: "anything" }] } } as never), /incomplete/);
  await assert.rejects(reportCommsEvidenceGaps({ search } as never, { cursor: "https://example.com" }), /Invalid/);
});
test("report stops at its row bound and resumes without skipping patients", async () => {
  const offsets: string[] = [];
  const search = async (type: string, params: Record<string, string>) => {
    if (type === "Consent") return { resourceType: "Bundle", entry: [] };
    offsets.push(params._offset ?? "0");
    const offset = Number(params._offset ?? "0");
    return { resourceType: "Bundle", total: 2000, ...(offset + 100 < 2000 ? { link: [{ relation: "next", url: `https://fhir.invalid/fhir/R4/Patient?_offset=${offset + 100}` }] } : {}), entry: Array.from({ length: 100 }, (_, i) => ({ resource: { resourceType: "Patient", id: `p${offset + i}`, active: true } })) };
  };
  const fhir = { search, baseUrl: "https://fhir.invalid", searchUrl: (url: string) => search("Patient", Object.fromEntries(new URL(url).searchParams)) };
  const first = await reportCommsEvidenceGaps(fhir as never);
  assert.equal(first.truncated, true); assert.ok(first.rows.length <= 10000);
  const lastId = Number(first.rows.at(-1)!.patientReference.slice("Patient/p".length));
  assert.equal(new URL(Buffer.from(first.cursor!, "base64url").toString()).searchParams.get("_offset"), String(lastId + 1));
  const second = await reportCommsEvidenceGaps(fhir as never, { cursor: first.cursor, channel: "email" });
  assert.equal(second.rows[0].patientReference, `Patient/p${lastId + 1}`);
  assert.ok(offsets.length <= 100);
});
test("report stops at 100 Patient pages even when a filter yields no rows", async () => {
  let pages = 0;
  const search = async (type: string) => type === "Consent" ? { resourceType: "Bundle", entry: [] }
    : { resourceType: "Bundle", total: 20000, link: [{ relation: "next", url: `https://fhir.invalid/fhir/R4/Patient?_offset=${pages + 100}` }], entry: Array.from({ length: 100 }, (_, i) => ({ resource: { resourceType: "Patient", id: `p${pages++}-${i}`, active: true } })) };
  const result = await reportCommsEvidenceGaps({ search, baseUrl: "https://fhir.invalid", searchUrl: () => search("Patient") } as never, { tier: "1" });
  assert.equal(pages, 10000); assert.equal(result.rows.length, 0);
  assert.equal(result.truncated, true); assert.equal(new URL(Buffer.from(result.cursor!, "base64url").toString()).searchParams.get("_offset"), "10000");
});
test("preference transaction failure preserves status for optimistic race mapping", async () => {
  const fhir = { read: async () => ({ resourceType: "Patient", id: "p", meta: { versionId: "4" } }),
    executeTransactionAsActor: async (bundle: Bundle, _a: unknown, _h: unknown, options: { validateResponse: (response: Bundle) => void }) => {
      options.validateResponse({ resourceType: "Bundle", type: "transaction-response", entry: bundle.entry!.map(() => ({ response: { status: "412 Precondition Failed" } })) });
    } };
  await assert.rejects(writeCommsPreferences(fhir as never, "Patient/p", [{ ...scope[0], allowed: true }], actor), { status: 412 });
});
