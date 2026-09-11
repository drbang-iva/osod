import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Patient } from "@medplum/fhirtypes";
import { writeCommsPreferences } from "../src/comms/comms-preferences.js";

const actor = { actorReference: "Practitioner/synthetic-staff", actorRole: "staff" as const,
  recordedAt: "2026-09-11T15:00:00Z", surface: "staff-manual-send" as const };

test("preference write reads fresh and atomically records versioned Patient and per-cell Provenance", async () => {
  let transaction: Bundle | undefined;
  const patient: Patient = { resourceType: "Patient", id: "synthetic", meta: { versionId: "7" } };
  let reads = 0;
  const fhir: any = {
    read: async () => { reads++; return patient; },
    executeTransactionAsActor: async (bundle: Bundle, attribution: unknown, headers: unknown, options: any) => {
      transaction = bundle;
      assert.equal(reads, 1);
      assert.equal((attribution as any).actorReference, actor.actorReference);
      const response: Bundle = { resourceType: "Bundle", type: "transaction-response", entry: bundle.entry!.map(() => ({ response: { status: "200 OK" } })) };
      options.validateResponse(response);
      return response;
    },
  };
  await writeCommsPreferences(fhir, "Patient/synthetic", [{ purpose: "education", channel: "email", allowed: true }], actor);
  assert.equal(transaction?.entry?.[0].request?.ifMatch, 'W/"7"');
  assert.equal(transaction?.entry?.[0].request?.url, "Patient/synthetic");
  const provenance: any = transaction?.entry?.[1].resource;
  assert.equal(provenance.resourceType, "Provenance");
  assert.equal(provenance.entity.length, 1);
  assert.equal(provenance.entity[0].role, "source");
  assert.match(provenance.entity[0].what.display, /education.*email.*true/);
});

test("G21 preference transaction conflict retains HTTP status", async () => {
  const fhir: any = {
    read: async () => ({ resourceType: "Patient", id: "synthetic", meta: { versionId: "7" } }),
    executeTransactionAsActor: async (bundle: Bundle, actor: unknown, headers: unknown, options: any) => {
      options.validateResponse({ resourceType: "Bundle", type: "transaction-response", entry: bundle.entry!.map(() => ({ response: { status: "412 Precondition Failed" } })) });
    },
  };
  await assert.rejects(writeCommsPreferences(fhir, "Patient/synthetic", [{ purpose: "education", channel: "email", allowed: true }], actor), (error: any) => error.status === 412);
});
