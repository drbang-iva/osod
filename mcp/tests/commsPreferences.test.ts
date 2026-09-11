import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import * as gate from "../src/comms/suppression-gate.js";
const metadata = { recordedAt: "2026-09-11T15:00:00Z", setBy: { reference: "Practitioner/staff" }, surface: "staff-demographics" as const };
const patient: Patient = { resourceType: "Patient", id: "synthetic" };
test("preference defaults remain implicit and explicit cells retain attribution", () => {
  assert.equal(gate.effectiveCommsPreferences(patient, {}).education.sms.value, true);
  assert.equal(gate.effectiveCommsPreferences(patient, {})["marketing-promo"].sms.value, false);
  const updated = gate.replaceCommsPreferenceCells(patient, [{ purpose: "education", channel: "sms", allowed: false }], metadata);
  assert.deepEqual(gate.effectiveCommsPreferences(updated, {}).education.sms, { value: false, source: "explicit", ...metadata });
  assert.equal(patient.extension, undefined);
});
test("malformed and duplicate preference extensions refuse resolution", () => {
  const updated = gate.replaceCommsPreferenceCells(patient, [{ purpose: "education", channel: "sms", allowed: false }], metadata);
  const duplicate = { ...updated, extension: [...updated.extension!, ...updated.extension!] };
  assert.throws(() => gate.effectiveCommsPreferences(duplicate, {}), /preference/);
  updated.extension![0].extension = updated.extension![0].extension!.filter(e => e.url !== "allowed");
  assert.throws(() => gate.effectiveCommsPreferences(updated, {}), /preference/);
});
const deps = (p: Patient) => ({ fhir: { read: async () => p } as any, practiceTimeZone: "UTC", now: () => new Date("2026-09-11T15:00:00Z") });
const request = (suppression = {}) => ({ patientReference: "Patient/synthetic", campaignType: "clinical-education", body: "Education", suppression });
test("G4 and manual campaign types fail closed", async () => {
  for (const campaignType of ["manual", "unknown", "toString", "__proto__"]) await assert.rejects(gate.checkMessageSuppression(deps(patient), { ...request(), campaignType }, "sms"), /has no communication purpose/);
  assert.equal((await gate.checkMessageSuppression(deps(patient), { ...request(), campaignType: "appointment-reminder" }, "sms")).result, undefined);
});
test("G16 marketing email is default ON while legacy marketing SMS remains withheld", async () => {
  const req = request({ consentClass: "marketing", requiresMarketingConsent: true });
  assert.equal((await gate.checkMessageSuppression(deps(patient), req, "email")).result, undefined);
  assert.deepEqual((await gate.checkMessageSuppression(deps(patient), req, "sms")).result, { outcome: "suppressed", reason: "preference-withheld" });
});
test("G17 explicit marketing SMS ON cannot bypass legacy consent", async () => {
  const p = gate.replaceCommsPreferenceCells(patient, [{ purpose: "marketing-promo", channel: "sms", allowed: true }], metadata);
  assert.deepEqual((await gate.checkMessageSuppression(deps(p), request({ consentClass: "marketing", requiresMarketingConsent: true }), "sms")).result, { outcome: "suppressed", reason: "preference-withheld" });
});
test("G18 malformed cell refuses a send", async () => {
  const p = gate.replaceCommsPreferenceCells(patient, [{ purpose: "education", channel: "sms", allowed: false }], metadata);
  p.extension![0].extension!.pop();
  await assert.rejects(gate.checkMessageSuppression(deps(p), request(), "sms"), /preference/);
});
test("G10 override is restricted to education email", async () => {
  const p = gate.replaceCommsPreferenceCells(patient, [{ purpose: "education", channel: "sms", allowed: false }, { purpose: "education", channel: "email", allowed: false }], metadata);
  assert.deepEqual((await gate.checkMessageSuppression(deps(p), request({ staffEducationOverride: true }), "sms")).result, { outcome: "suppressed", reason: "preference-withheld" });
  assert.equal((await gate.checkMessageSuppression(deps(p), request({ staffEducationOverride: true }), "email")).result, undefined);
});
test("G1 G3 STOP wins over explicit education SMS ON and resolver reports suppression", async () => {
  const p = gate.replaceCommsPreferenceCells({ ...patient, extension: [gate.buildCommsOptOutExtension("sms")] }, [{ purpose: "education", channel: "sms", allowed: true }], metadata);
  assert.deepEqual(gate.effectiveCommsPreferences(p, {}).education.sms, { value: false, source: "suppression" });
  assert.deepEqual((await gate.checkMessageSuppression(deps(p), request(), "sms")).result, { outcome: "suppressed", reason: "patient-opt-out" });
});
test("G11 staff email override cannot bypass email unsubscribe", async () => {
  const p = gate.replaceCommsPreferenceCells({ ...patient, extension: [gate.buildCommsOptOutExtension("email")] }, [{ purpose: "education", channel: "email", allowed: false }], metadata);
  assert.deepEqual((await gate.checkMessageSuppression(deps(p), request({ staffEducationOverride: true }), "email")).result, { outcome: "suppressed", reason: "patient-opt-out" });
});
