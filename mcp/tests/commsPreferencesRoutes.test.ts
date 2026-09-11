import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { Bundle, Consent, Patient } from "@medplum/fhirtypes";
import { getRoleDeclaration, type BusinessAction } from "../src/authz/roles.js";
import { registerCommsApiRoutes, type CommsApiRouteDeps } from "../src/comms/comms-api.js";
import { COMMS_PURPOSES, COMMS_PREFERENCE_CHANNELS, ODOS_COMMS_OPT_OUT_EXTENSION_URL, readCommsPreferenceCells } from "../src/comms/suppression-gate.js";

const pair = { purpose: "education", channel: "email", allowed: true };
const patientReference = "Patient/synthetic-matrix";
async function fixture(options: { conflict?: boolean; businessActions?: readonly BusinessAction[]; stop?: boolean; manyPatients?: boolean } = {}) {
  let patient: Patient = { resourceType: "Patient", id: "synthetic-matrix", active: true, meta: { versionId: "3" },
    ...(options.stop ? { extension: [{ url: ODOS_COMMS_OPT_OUT_EXTENSION_URL, extension: [{ url: "channel", valueCode: "sms" }, { url: "scope", valueCode: "global" }] }] } : {}) };
  const initial = structuredClone(patient);
  const transactions: Bundle[] = [], consents: Consent[] = [];
  const fhir = {
    baseUrl: "https://fhir.invalid",
    searchUrl: (url: string): Promise<unknown> => fhir.search("Patient", Object.fromEntries(new URL(url).searchParams)),
    read: async () => structuredClone(patient),
    search: async (type: string, params: Record<string, string>) => ({ resourceType: "Bundle", type: "searchset",
      ...(options.manyPatients && type === "Patient" ? { total: 20000, link: [{ relation: "next", url: `https://fhir.invalid/fhir/R4/Patient?_offset=${Number(params._offset ?? "0") + 100}` }] } : {}),
      entry: type === "Consent" ? consents.map(resource => ({ resource })) : options.manyPatients
        ? Array.from({ length: 100 }, (_, i) => ({ resource: { resourceType: "Patient", id: `synthetic-${params._offset}-${i}`, active: true } }))
        : [{ resource: structuredClone(patient) }] }),
    executeTransactionAsActor: async (bundle: Bundle, _actor: unknown, _headers: unknown, validation: { validateResponse?: (response: Bundle) => void } = {}) => {
      transactions.push(structuredClone(bundle));
      const response: Bundle = { resourceType: "Bundle", type: "transaction-response", entry: bundle.entry!.map(() => ({ response: { status: options.conflict ? "412 Precondition Failed" : "200 OK" } })) };
      validation.validateResponse?.(response);
      for (const entry of bundle.entry!) {
        if (entry.resource?.resourceType === "Patient") patient = structuredClone(entry.resource);
        if (entry.resource?.resourceType === "Consent") consents.push({ ...structuredClone(entry.resource), id: `evidence-${consents.length}` });
      }
      return response;
    },
  };
  const app = express(); app.use(express.json());
  registerCommsApiRoutes(app, {
    authenticateService: async () => {},
    authenticate: async () => ({ staffReference: "Practitioner/synthetic-staff", actorRole: "staff", roles: ["staff"],
      ...(options.businessActions ? { businessActions: options.businessActions } : {}), fhir }),
    fhir,
    dispatch: { providerFor: () => undefined, senderNumberFor: () => undefined, providers: () => [], initialize: async () => {} },
    educationCatalog: { list: () => [], get: () => undefined }, trackedLinkStore: {},
    publicBaseUrl: "https://synthetic.invalid", practiceName: "Synthetic", now: () => "2026-09-11T12:00:00Z",
    audit: { record: async (_row: unknown, operation: () => Promise<unknown>) => operation(), recordDenied: async () => {} },
  } as unknown as CommsApiRouteDeps);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { transactions, initial, get patient() { return patient; },
    request: (path: string, method = "GET", body?: unknown) => fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }),
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}
test("preferences GET returns effective matrix and evidence rows", async () => {
  const f = await fixture(); try {
    const response = await f.request(`/communications/preferences?patient=${patientReference}`);
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.patientReference, patientReference); assert.equal(body.rows.length, 20);
    assert.equal(body.matrix.education.email.value, true);
  } finally { await f.close(); }
});
test("G2 preferences PUT all twenty ON leaves STOP extensions unchanged", async () => {
  const f = await fixture({ stop: true }); try {
    const cells = COMMS_PURPOSES.flatMap(purpose => COMMS_PREFERENCE_CHANNELS.map(channel => ({ purpose, channel, allowed: true })));
    const response = await f.request("/communications/preferences", "PUT", { patientReference, cells });
    assert.equal(response.status, 200);
    assert.deepEqual(f.patient.extension?.filter(extension => extension.url === ODOS_COMMS_OPT_OUT_EXTENSION_URL), f.initial.extension);
    assert.equal(readCommsPreferenceCells(f.patient).length, 20);
    assert.equal(f.transactions[0].entry![0].request!.ifMatch, 'W/"3"');
    const body = await response.json(); assert.equal(body.matrix.education.sms.source, "suppression");
  } finally { await f.close(); }
});
test("G6 preferences PUT requires actual preferences business action", async () => {
  const f = await fixture({ businessActions: ["communications.read"] }); try {
    const response = await f.request("/communications/preferences", "PUT", { patientReference, cells: [pair] });
    assert.equal(response.status, 403); assert.equal(f.transactions.length, 0);
  } finally { await f.close(); }
});
test("G6 removing preferences action from staff declaration refuses PUT", async () => {
  const declaration = getRoleDeclaration("staff");
  const index = declaration.businessActions.indexOf("communications.preferences.manage");
  assert.notEqual(index, -1); declaration.businessActions.splice(index, 1);
  const f = await fixture(); try {
    const response = await f.request("/communications/preferences", "PUT", { patientReference, cells: [pair] });
    assert.equal(response.status, 403); assert.equal(f.transactions.length, 0);
  } finally { declaration.businessActions.splice(index, 0, "communications.preferences.manage"); await f.close(); }
});
test("G21 preference PUT optimistic conflict returns 409", async () => {
  const f = await fixture({ conflict: true }); try {
    const response = await f.request("/communications/preferences", "PUT", { patientReference, cells: [pair] });
    assert.equal(response.status, 409); assert.deepEqual(f.patient, f.initial);
  } finally { await f.close(); }
});
test("evidence POST uses an atomic Patient Consent Provenance transaction and preserves cells", async () => {
  const f = await fixture(); try {
    assert.equal((await f.request("/communications/preferences", "PUT", { patientReference, cells: [pair] })).status, 200);
    const response = await f.request("/communications/consent-evidence", "POST", { patientReference, scope: [{ purpose: "education", channel: "email" }], method: "paper-form", formDate: "2026-09-10" });
    assert.equal(response.status, 200);
    const transaction = f.transactions[1];
    const consent = transaction.entry!.find(entry => entry.resource?.resourceType === "Consent")!;
    assert.equal(readCommsPreferenceCells(f.patient)[0].evidence?.reference, consent.fullUrl);
    assert.equal(transaction.entry!.filter(entry => entry.resource?.resourceType === "Provenance").length, 1);
    assert.equal((await response.json()).rows.find((row: { purpose: string; channel: string }) => row.purpose === "education" && row.channel === "email").evidenceStatus, "recorded");
  } finally { await f.close(); }
});
test("preferences routes reject invalid enums duplicates dates and phone keys", async () => {
  const f = await fixture(); try {
    for (const body of [{ patientReference: "+15555550100", cells: [pair] }, { patientReference, cells: [pair, pair] },
      { patientReference, cells: [{ ...pair, channel: "fax" }] }, { patientReference, cells: [pair], confirmedVia: "paper-form", formDate: "2026-02-30" },
      { patientReference, cells: [pair], confirmedVia: "paper-form", formDate: "2027-01-01" }]) {
      assert.equal((await f.request("/communications/preferences", "PUT", body)).status, 400);
    }
    assert.equal((await f.request("/communications/consent-evidence", "POST", { patientReference, scope: [{ purpose: "education", channel: "email" }], method: "paper-form" })).status, 400);
    assert.equal(f.transactions.length, 0);
  } finally { await f.close(); }
});
test("evidence gaps routes provide JSON and CSV and reject arbitrary URL cursor", async () => {
  const f = await fixture(); try {
    const response = await f.request("/communications/preferences/evidence-gaps?channel=email");
    assert.equal(response.status, 200); assert.equal((await response.json()).rows.length, 5);
    const csv = await f.request("/communications/preferences/evidence-gaps?channel=email&format=csv");
    assert.equal(csv.status, 200); assert.match(csv.headers.get("content-type")!, /text\/csv/);
    assert.match(await csv.text(), /patientReference,purpose,channel/);
    assert.equal((await f.request("/communications/preferences/evidence-gaps?cursor=https://synthetic.invalid")).status, 400);
    const foreignCursor = Buffer.from("https://foreign.invalid/fhir/R4/Patient?_offset=100").toString("base64url");
    assert.equal((await f.request(`/communications/preferences/evidence-gaps?cursor=${foreignCursor}`)).status, 400);
  } finally { await f.close(); }
});
test("CSV evidence report exposes truncation and continuation even with zero rows", async () => {
  const f = await fixture({ manyPatients: true }); try {
    const response = await f.request("/communications/preferences/evidence-gaps?tier=1&format=csv");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-ODOS-Truncated"), "true");
    assert.equal(new URL(Buffer.from(response.headers.get("X-ODOS-Cursor")!, "base64url").toString()).searchParams.get("_offset"), "10000");
    assert.equal((await response.text()).split("\r\n").length, 1);
  } finally { await f.close(); }
});
