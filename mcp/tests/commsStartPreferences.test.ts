import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient, Bundle } from "@medplum/fhirtypes";
import { updateInboundSuppression, readCommsPreferenceCells, replaceCommsPreferenceCells, recordPatientSmsOptOut } from "../src/comms/suppression-gate.js";
const from = "+15555550199", to = "+15555550100";
function fixture(count = 1) {
  const patients: Patient[] = Array.from({ length: count }, (_, i) => ({ resourceType: "Patient", id: `synthetic-${i}`, meta: { versionId: "1" }, telecom: [{ system: "phone", value: from }] }));
  let writes = 0;
  const fhir: any = {
    search: async () => ({ resourceType: "Bundle", type: "searchset", entry: patients.map(resource => ({ resource: structuredClone(resource) })) }),
    read: async (_type: string, id: string) => structuredClone(patients.find(p => p.id === id)),
    update: async (_type: string, id: string, resource: Patient, headers: Record<string, string>) => {
      const index = patients.findIndex(p => p.id === id);
      assert.equal(headers["If-Match"], `W/"${patients[index].meta!.versionId}"`);
      writes++;
      patients[index] = { ...structuredClone(resource), meta: { versionId: String(writes + 1) } };
      return structuredClone(patients[index]);
    },
    executeTransactionAsActor: async (bundle: Bundle, _actor: unknown, _headers: unknown, options: any) => {
      const entry = bundle.entry![0];
      await fhir.update("Patient", (entry.resource as Patient).id, entry.resource, { "If-Match": entry.request!.ifMatch });
      const response = { resourceType: "Bundle", type: "transaction-response", entry: bundle.entry!.map(() => ({ response: { status: "200 OK" } })) };
      options.validateResponse(response); return response;
    },
  };
  return { patients, fhir, writes: () => writes };
}
test("G13 START atomically restores four explicit text cells without marketing and is idempotent", async () => {
  const f = fixture();
  await updateInboundSuppression(f.fhir, { from, to, body: "STOP" });
  const result = await updateInboundSuppression(f.fhir, { from, to, body: "START" });
  assert.equal(result.outcome, "opted-in");
  const cells = readCommsPreferenceCells(f.patients[0]);
  assert.deepEqual(cells.map(c => c.purpose).sort(), ["appointment", "education", "product-pickup", "recalls"]);
  assert.ok(cells.every(c => c.allowed && c.channel === "sms" && c.surface === "inbound-start" && c.setBy.reference === "Patient/synthetic-0"));
  assert.equal(f.writes(), 2);
  await updateInboundSuppression(f.fhir, { from, to, body: "START" });
  assert.equal(f.writes(), 2);
});
test("START without an opt-out still replaces withheld text cells", async () => {
  const f = fixture();
  f.patients[0] = replaceCommsPreferenceCells(f.patients[0], [{ purpose: "education", channel: "sms", allowed: false }], { setBy: { reference: "Practitioner/staff" }, surface: "staff-demographics", recordedAt: "2026-09-11T15:00:00Z" });
  await updateInboundSuppression(f.fhir, { from, to, body: "START" });
  assert.equal(readCommsPreferenceCells(f.patients[0]).filter(c => c.allowed).length, 4);
  assert.equal(f.writes(), 1);
});
test("G14 shared-number and broader-opt-out STARTs write no preference cells", async () => {
  const shared = fixture(2);
  assert.equal((await updateInboundSuppression(shared.fhir, { from, to, body: "START" })).outcome, "opt-in-refused-shared-number");
  assert.equal(shared.writes(), 0);
  for (const p of shared.patients) assert.equal(readCommsPreferenceCells(p).length, 0);
  const f = fixture();
  await recordPatientSmsOptOut(f.fhir, "Patient/synthetic-0", { actorReference: "Practitioner/staff", actorRole: "staff", recordedAt: "2026-09-11T15:00:00Z", reason: "Synthetic request", identityVerification: "in-person", scope: "global" });
  assert.equal((await updateInboundSuppression(f.fhir, { from, to, body: "START" })).outcome, "opt-in-refused-broader-opt-out");
  assert.equal(readCommsPreferenceCells(f.patients[0]).length, 0);
  assert.equal(f.writes(), 1);
});
