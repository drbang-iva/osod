import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createMedplumClient } from "../src/fhir-client.js";
import { registerCommsApiRoutes, type CommsApiRouteDeps } from "../src/comms/comms-api.js";
import { buildCommsConsent } from "../src/comms/comms-preferences.js";
import { TEST_FHIR_AUDIT_RECORDER, TEST_FHIR_AUDIT_CONTEXT } from "./fhirAuditTestStub.js";
import { test, type TestContext } from "node:test";
import type { Consent, Patient, Practitioner, Provenance, Resource } from "@medplum/fhirtypes";
import { buildMedplumAccessPolicy, getRoleDeclaration, PRACTICE_ROLE_IDS } from "../src/authz/roles.js";
import { searchAll } from "../src/fhir-search.js";
import { createAuthenticatedFhirClient } from "./integration-helpers.js";
import { cleanupReferences, createRoleClient, fhirRequest } from "./liveRoleClient.js";

async function liveConsentProof(t: TestContext, routeOnly: boolean) {
  if (process.env.ODOS_MATRIX_LIVE !== "1") { t.skip("Dedicated synthetic matrix live lane only"); return; }
  const baseUrl = process.env.ODOS_MATRIX_BASE_URL;
  const email = process.env.ODOS_MATRIX_ADMIN_EMAIL;
  const password = process.env.ODOS_MATRIX_ADMIN_PASSWORD;
  assert.ok(baseUrl && email && password, "Dedicated matrix URL and credentials are required for its live lane");
  if (process.env.MEDPLUM_BASE_URL) {
    const shared = new URL(process.env.MEDPLUM_BASE_URL);
    const dedicated = new URL(baseUrl);
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
    assert.notEqual(dedicated.origin, shared.origin, "Matrix proof must use a separate server from the shared live suite");
    if (loopback.has(shared.hostname) && loopback.has(dedicated.hostname)) {
      assert.notEqual(dedicated.port || "80", shared.port || (shared.protocol === "https:" ? "443" : "80"), "Matrix proof must use a separate loopback port");
    }
  }
  assert.match(baseUrl, /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
  const { fhir, accessToken } = await createAuthenticatedFhirClient({ baseUrl, email, password });
  const projectId = await fhir.getActiveProjectId();
  const cleanup: string[] = [];
  const track = <T extends Resource>(resource: T): T => {
    assert.ok(resource.id);
    cleanup.push(`${resource.resourceType}/${resource.id}`);
    return resource;
  };
  const patient = track(await fhir.create<Patient>({ resourceType: "Patient", active: true, name: [{ family: "TEST-MatrixConsent" }] }));
  t.after(async () => {
    try {
      for (const resource of await searchAll<Consent>(fhir, "Consent", { patient: `Patient/${patient.id}` })) track(resource);
      for (const resource of await searchAll<Provenance>(fhir, "Provenance", { target: `Patient/${patient.id}` })) track(resource);
    } finally {
      await cleanupReferences(baseUrl, accessToken, [...new Set(cleanup)]);
    }
  });
  const practitioner = track(await fhir.create<Practitioner>({ resourceType: "Practitioner", active: true }));
  const patientReference = `Patient/${patient.id}`;
  const sample = buildCommsConsent(patientReference, [{ purpose: "education", channel: "email" }], "in-person", {
    actorReference: `Practitioner/${practitioner.id}`, actorRole: "staff", recordedAt: new Date().toISOString(), surface: "staff-demographics",
  });
  for (const roleId of PRACTICE_ROLE_IDS) {
    if (routeOnly && roleId !== "staff") continue;
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    // Bind the synthetic patient's compartment explicitly, including Admin clients.
    policy.resource = policy.resource!.map((rule) => ({ ...rule, ...(rule.criteria ? { criteria: rule.criteria.replaceAll("%patient_compartment", patientReference) } : {}) }));
    const savedPolicy = track(await fhir.create(policy));
    const client = await createRoleClient({ baseUrl, roleId, policyReference: `AccessPolicy/${savedPolicy.id}`, patientReference, practitionerReference: `Practitioner/${practitioner.id}`, projectId, runId: randomUUID(), adminToken: accessToken, track });
    if (!routeOnly) {
    const created = await fhirRequest<Consent>(baseUrl, client.token, "POST", "Consent", sample);
    assert.equal(created.status, 201, `${roleId} valid Consent create: ${created.summary}`);
    assert.ok(created.body?.id);
    const current = track(created.body!);
    const updated = await fhirRequest<Consent>(baseUrl, client.token, "PUT", `Consent/${current.id}`, { ...current, status: "inactive" });
    assert.equal(updated.status, 200, `${roleId} status-only update: ${updated.summary}`);
    const changed = structuredClone(updated.body!);
    changed.policy = [{ uri: "urn:changed" }];
    const deniedChange = await fhirRequest(baseUrl, client.token, "PUT", `Consent/${current.id}`, changed);
    assert.equal(deniedChange.status, 403, `${roleId} evidence content immutable: ${deniedChange.summary}`);
    }
    const deniedPolicy = track(await fhir.create({ ...policy, resource: policy.resource!.filter((rule) => rule.resourceType !== "Consent") }));
    const deniedClient = await createRoleClient({ baseUrl, roleId, policyReference: `AccessPolicy/${deniedPolicy.id}`, patientReference, practitionerReference: `Practitioner/${practitioner.id}`, projectId, runId: randomUUID(), adminToken: accessToken, track });
    if (!routeOnly) {
    const denied = await fhirRequest(baseUrl, deniedClient.token, "POST", "Consent", sample);
    assert.equal(denied.status, 403, `${roleId} removed Consent grant denies create: ${denied.summary}`);
    }
    if (routeOnly) {
      const app = express();
      app.use(express.json());
      const deps = {
        authenticateService: async () => {},
        authenticate: async (header: string | undefined) => {
          const token = header?.replace("Bearer ", "");
          if (token !== client.token && token !== deniedClient.token) return null;
          return { staffReference: `Practitioner/${practitioner.id}`, actorRole: "staff", roles: ["staff"],
            businessActions: getRoleDeclaration("staff").businessActions, grantedBusinessActions: [], revokedBusinessActions: [], membershipBusinessActionsMalformed: false,
            fhir: createMedplumClient({ baseUrl, accessToken: token, audit: TEST_FHIR_AUDIT_RECORDER, auditContext: TEST_FHIR_AUDIT_CONTEXT }),
          };
        },
        fhir, dispatch: {}, educationCatalog: {}, trackedLinkStore: {}, publicBaseUrl: "http://localhost", practiceName: "Synthetic proof", audit: TEST_FHIR_AUDIT_RECORDER,
      } as unknown as CommsApiRouteDeps;
      registerCommsApiRoutes(app, deps);
      const server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const routeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/communications/consent-evidence`;
        for (const [token, expected] of [[client.token, 200], [deniedClient.token, 403]] as const) {
          const response = await fetch(routeUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ patientReference, scope: [{ purpose: "education", channel: "email" }], method: "in-person" }) });
          const body = await response.text();
          t.diagnostic(`evidence HTTP expected ${expected}, actual ${response.status}: ${response.status === expected ? "verified" : body}`);
          assert.equal(response.status, expected, `Evidence HTTP route ${body}`);
        }
      } finally {
        server.close();
        await once(server, "close");
      }
    }
    if (!routeOnly) t.diagnostic(`${roleId}: Consent create 201; status update 200; content update 403; removed grant create 403`);
  }
 }

test("isolated Medplum enforces Consent grants and immutable evidence", t => liveConsentProof(t, false));
test("isolated evidence HTTP route enforces generated staff Consent grant", t => liveConsentProof(t, true));
