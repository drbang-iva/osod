import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Communication, Patient, Provenance, Resource } from "@medplum/fhirtypes";
import type {
  CommsProvider,
  SendEmailRequest,
  SendSmsRequest,
} from "../src/comms/comms-provider.js";
import type { FhirSearchParams } from "../src/fhir-client.js";
import {
  ODOS_COMMS_OPT_OUT_EXTENSION_URL,
  clearPatientSmsOptOut,
  createSuppressedCommsProvider,
  readPatientSmsOptOut,
  recordPatientSmsOptOut,
  updateInboundSuppression,
} from "../src/comms/suppression-gate.js";

function baseRequest(overrides: Partial<SendEmailRequest> = {}): SendEmailRequest {
  return {
    patientReference: "Patient/synthetic-1",
    subject: "Appointment reminder",
    body: "Your appointment is tomorrow at 10:00 AM at Main Office.",
    campaignType: "appointment-reminder",
    suppression: {},
    ...overrides,
  };
}

function patient(overrides: Partial<Patient> = {}): Patient {
  return {
    resourceType: "Patient",
    id: "synthetic-1",
    telecom: [{ system: "email", value: "patient@example.test" }],
    ...overrides,
  };
}

function fakeProvider(sent: SendEmailRequest[]): CommsProvider {
  return {
    name: "fake",
    capabilities: {
      sms: false,
      calls: false,
      email: true,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendEmail(request) {
      sent.push(request);
      return { outcome: "sent", providerMessageId: `sent-${sent.length}` };
    },
  };
}

function fakeSmsProvider(sent: SendSmsRequest[]): CommsProvider {
  return {
    name: "fake-sms",
    capabilities: {
      sms: true,
      calls: false,
      email: false,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendSms(request) {
      sent.push(request);
      return { outcome: "sent", providerMessageId: `sent-${sent.length}` };
    },
  };
}

function sendEmail(provider: CommsProvider, request: SendEmailRequest) {
  assert.ok(provider.sendEmail);
  return provider.sendEmail(request);
}

function fhirFor(
  subject: Patient,
  communications: Communication[] = [],
  onSearch?: (params: FhirSearchParams) => void,
) {
  return {
    read: async <T extends Resource>(): Promise<T> => structuredClone(subject) as T,
    search: async <T extends Resource>(
      _resourceType: T["resourceType"],
      params: FhirSearchParams = {},
    ): Promise<Bundle<T>> => {
      onSearch?.(params);
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: communications.map((resource) => ({ resource: structuredClone(resource) as T })),
      };
    },
  };
}

test("inbound STOP follows Patient pagination and suppresses every shared-number match", async () => {
  const phone = "+18645550199";
  const patients = ["synthetic-1", "synthetic-2"].map((id) => ({
    resourceType: "Patient" as const,
    id,
    meta: { versionId: "1" },
    telecom: [{ system: "phone" as const, value: phone }],
  }));
  const updated = new Map<string, Patient>();
  const fhir = {
    async search<T extends Resource>(
      resourceType: T["resourceType"],
      params: FhirSearchParams = {},
    ): Promise<Bundle<T>> {
      assert.equal(resourceType, "Patient");
      assert.deepEqual(params, { telecom: phone, _count: "100" });
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: structuredClone(patients[0]) as T }],
        link: [{ relation: "next", url: "https://odos.local/fhir/R4/Patient?page=2" }],
      };
    },
    async searchUrl<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>> {
      assert.equal(url, "https://odos.local/fhir/R4/Patient?page=2");
      assert.equal(resourceType, "Patient");
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: structuredClone(patients[1]) as T }],
      };
    },
    async update<T extends Resource>(
      resourceType: T["resourceType"],
      id: string,
      resource: T,
      headers: Record<string, string> = {},
    ): Promise<T> {
      assert.equal(resourceType, "Patient");
      assert.equal(headers["If-Match"], 'W/"1"');
      updated.set(id, structuredClone(resource) as Patient);
      return structuredClone(resource);
    },
  };

  const result = await updateInboundSuppression(fhir, {
    from: phone,
    to: "+18485550100",
    body: "STOP",
    optOutType: "STOP",
  });

  assert.deepEqual(result, { outcome: "opted-out", matchedPatients: 2 });
  assert.deepEqual([...updated.keys()], ["synthetic-1", "synthetic-2"]);
  for (const subject of updated.values()) {
    assert.equal(subject.extension?.[0]?.url, ODOS_COMMS_OPT_OUT_EXTENSION_URL);
    assert.equal(
      subject.extension?.[0]?.extension?.find((part) => part.url === "number")?.valueString,
      "+18485550100",
    );
  }
});

test("per-number STOP suppresses its sender lane while leaving a different sender lane sendable", async () => {
  const stoppedNumber = "+18485550100";
  const otherNumber = "+18645550100";
  const subject = patient({
    telecom: [{ system: "phone", value: "+18645550199" }],
    extension: [{
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [
        { url: "channel", valueCode: "sms" },
        { url: "number", valueString: stoppedNumber },
      ],
    }],
  });
  const stoppedSends: SendSmsRequest[] = [];
  const otherSends: SendSmsRequest[] = [];
  const stoppedLane = createSuppressedCommsProvider(fakeSmsProvider(stoppedSends), {
    fhir: fhirFor(subject),
    practiceTimeZone: "America/New_York",
    smsSenderNumber: stoppedNumber,
    stopScope: "per-number",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });
  const otherLane = createSuppressedCommsProvider(fakeSmsProvider(otherSends), {
    fhir: fhirFor(subject),
    practiceTimeZone: "America/New_York",
    smsSenderNumber: otherNumber,
    stopScope: "per-number",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });
  const request: SendSmsRequest = {
    patientReference: "Patient/synthetic-1",
    body: "Synthetic follow-up",
    campaignType: "staff-initiated",
    suppression: {},
  };

  assert.deepEqual(await stoppedLane.sendSms!(request), {
    outcome: "suppressed",
    reason: "patient-opt-out",
  });
  assert.equal((await otherLane.sendSms!(request)).outcome, "sent");
  assert.equal(stoppedSends.length, 0);
  assert.equal(otherSends.length, 1);
});

test("global STOP scope expands a number-specific opt-out across sender lanes", async () => {
  const subject = patient({
    telecom: [{ system: "phone", value: "+18645550199" }],
    extension: [{
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [
        { url: "channel", valueCode: "sms" },
        { url: "number", valueString: "+18485550100" },
      ],
    }],
  });
  const sent: SendSmsRequest[] = [];
  const provider = createSuppressedCommsProvider(fakeSmsProvider(sent), {
    fhir: fhirFor(subject),
    practiceTimeZone: "America/New_York",
    smsSenderNumber: "+18645550100",
    stopScope: "global",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await provider.sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Synthetic follow-up",
    campaignType: "manual",
    suppression: {},
  });

  assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
  assert.equal(sent.length, 0);
});

test("inbound STOP without a campaign type blocks clinical education on the receiving sender lane", async () => {
  const subject = patient({
    telecom: [{ system: "phone", value: "+18645550199" }],
    extension: [{
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [{ url: "channel", valueCode: "sms" }],
    }],
  });
  const sent: SendSmsRequest[] = [];
  const provider = createSuppressedCommsProvider(fakeSmsProvider(sent), {
    fhir: fhirFor(subject),
    practiceTimeZone: "America/New_York",
    smsSenderNumber: "+18645550100",
    stopScope: "per-number",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await provider.sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Synthetic practice\nhttps://synthetic.invalid/education\nReply STOP to opt out.",
    campaignType: "clinical-education",
    suppression: {},
  });

  assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
  assert.equal(sent.length, 0);
});

test("replayed inbound STOP uses If-Match once and skips an already-present SMS opt-out", async () => {
  const phone = "+18645550199";
  let subject: Patient = {
    resourceType: "Patient",
    id: "synthetic-1",
    meta: { versionId: "1" },
    telecom: [{ system: "phone", value: phone }],
  };
  let updates = 0;
  const fhir = {
    async search<T extends Resource>(): Promise<Bundle<T>> {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: structuredClone(subject) as T }],
      };
    },
    async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset" };
    },
    async update<T extends Resource>(
      resourceType: T["resourceType"],
      id: string,
      resource: T,
      headers: Record<string, string> = {},
    ): Promise<T> {
      assert.equal(resourceType, "Patient");
      assert.equal(id, "synthetic-1");
      assert.equal(headers["If-Match"], `W/"${subject.meta?.versionId}"`);
      updates += 1;
      subject = {
        ...structuredClone(resource as Patient),
        meta: { ...resource.meta, versionId: String(Number(subject.meta?.versionId) + 1) },
      };
      return structuredClone(subject) as T;
    },
  };

  await updateInboundSuppression(fhir, { from: phone, to: "+18485550100", body: "STOP" });
  await updateInboundSuppression(fhir, { from: phone, to: "+18485550100", body: "STOP" });

  assert.equal(updates, 1);
  assert.equal(subject.meta?.versionId, "2");
});

test("inbound START reports no effect when a surviving legacy opt-out still suppresses the lane", async () => {
  const phone = "+18645550199";
  const laneNumber = "+18485550100";
  const subject: Patient = {
    resourceType: "Patient",
    id: "synthetic-1",
    meta: { versionId: "1" },
    telecom: [{ system: "phone", value: phone }],
    extension: [{
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [{ url: "channel", valueCode: "sms" }],
    }],
  };
  let updates = 0;
  const fhir = {
    async search<T extends Resource>(): Promise<Bundle<T>> {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: structuredClone(subject) as T }],
      };
    },
    async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset" };
    },
    async update<T extends Resource>(): Promise<T> {
      updates += 1;
      throw new Error("Legacy-only START must not write a no-op Patient update.");
    },
  };

  const result = await updateInboundSuppression(fhir, {
    from: phone,
    to: laneNumber,
    body: "START",
  });

  assert.deepEqual(result, {
    outcome: "opt-in-refused-broader-opt-out",
    matchedPatients: 1,
    remainingOptOuts: { global: true, numbers: [] },
  });
  assert.equal(updates, 0);
});

test("an explicit Patient clear removes only that patient's SMS opt-out with versioned Provenance", async () => {
  const optedOut = (id: string): Patient => ({
    resourceType: "Patient",
    id,
    meta: { versionId: "7" },
    telecom: [{ system: "phone", value: "+18645550199" }],
    extension: [{
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [{ url: "channel", valueCode: "sms" }],
    }],
  });
  const patients = new Map([
    ["synthetic-1", optedOut("synthetic-1")],
    ["synthetic-2", optedOut("synthetic-2")],
  ]);
  let transaction: Bundle | undefined;
  let actor: { actorReference: string; actorRole: string; actionReason: string } | undefined;
  const fhir = {
    async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
      assert.equal(resourceType, "Patient");
      const found = patients.get(id);
      if (!found) throw new Error(`Missing Patient/${id}`);
      return structuredClone(found) as T;
    },
    async executeTransactionAsActor(
      request: Bundle,
      transactionActor: { actorReference: string; actorRole: string; actionReason: string },
    ): Promise<Bundle> {
      transaction = structuredClone(request);
      actor = transactionActor;
      const patientEntry = request.entry?.[0];
      assert.equal(patientEntry?.request?.method, "PUT");
      assert.equal(patientEntry.request.url, "Patient/synthetic-1");
      assert.equal(patientEntry.request.ifMatch, 'W/"7"');
      patients.set("synthetic-1", structuredClone(patientEntry.resource as Patient));
      return {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: [
          { response: { status: "200 OK", location: "Patient/synthetic-1/_history/8" } },
          { response: { status: "201 Created", location: "Provenance/prov-1/_history/1" } },
        ],
      };
    },
  };

  assert.deepEqual(await readPatientSmsOptOut(fhir, "Patient/synthetic-1"), {
    patientReference: "Patient/synthetic-1",
    smsOptedOut: true,
    remainingOptOuts: { global: true, numbers: [] },
  });
  const result = await clearPatientSmsOptOut(fhir, "Patient/synthetic-1", {
    actorReference: "Practitioner/staff-1",
    actorRole: "staff",
    recordedAt: "2026-08-30T15:00:00.000Z",
    reason: "Patient requested re-enrollment in person",
    identityVerification: "in-person",
  });

  assert.deepEqual(result, {
    patientReference: "Patient/synthetic-1",
    smsOptedOut: false,
    cleared: true,
  });
  assert.equal(await readPatientSmsOptOut(fhir, "Patient/synthetic-2").then((state) => state.smsOptedOut), true);
  assert.equal(await readPatientSmsOptOut(fhir, "Patient/synthetic-1").then((state) => state.smsOptedOut), false);
  assert.deepEqual(actor, {
    actorReference: "Practitioner/staff-1",
    actorRole: "staff",
    actionReason: "communications.optout.manage clear SMS opt-out",
  });
  const provenance = transaction?.entry?.[1]?.resource as Provenance;
  assert.equal(provenance.resourceType, "Provenance");
  assert.equal(provenance.recorded, "2026-08-30T15:00:00.000Z");
  assert.deepEqual(provenance.target, [{ reference: "Patient/synthetic-1" }]);
  assert.equal(provenance.agent[0]?.who.reference, "Practitioner/staff-1");
  assert.equal(provenance.reason?.[0]?.text, "Patient requested re-enrollment in person");
  assert.equal(provenance.entity?.[0]?.role, "source");
  assert.equal(provenance.entity?.[0]?.what.display, "Patient identity verification: in-person");
});

test("scoped clear reports a surviving legacy global opt-out without claiming the lane was cleared", async () => {
  const subject: Patient = {
    resourceType: "Patient",
    id: "synthetic-1",
    meta: { versionId: "7" },
    telecom: [{ system: "phone", value: "+18645550199" }],
    extension: [{
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [{ url: "channel", valueCode: "sms" }],
    }],
  };
  let transactions = 0;
  const fhir = {
    async read<T extends Resource>(): Promise<T> {
      return structuredClone(subject) as T;
    },
    async executeTransactionAsActor(): Promise<Bundle> {
      transactions += 1;
      throw new Error("Scoped clear must not write when no numbered opt-out matches.");
    },
  };

  const result = await clearPatientSmsOptOut(fhir, "Patient/synthetic-1", {
    actorReference: "Practitioner/staff-1",
    actorRole: "staff",
    recordedAt: "2026-08-30T15:00:00.000Z",
    reason: "Patient requested clinical-lane re-enrollment in person",
    identityVerification: "in-person",
    number: "+18485550100",
  });

  assert.deepEqual(result, {
    patientReference: "Patient/synthetic-1",
    smsOptedOut: true,
    cleared: false,
    suppressionCleared: false,
    remainingOptOuts: { global: true, numbers: [] },
  });
  assert.equal(transactions, 0);
});

test("scoped clear removes only its numbered lane and reports the other numbered opt-out", async () => {
  const clinicalNumber = "+18485550100";
  const frontDeskNumber = "+18645550100";
  const subject: Patient = {
    resourceType: "Patient",
    id: "synthetic-1",
    meta: { versionId: "7" },
    extension: [clinicalNumber, frontDeskNumber].map((number) => ({
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [
        { url: "channel", valueCode: "sms" },
        { url: "number", valueString: number },
      ],
    })),
  };
  let writtenPatient: Patient | undefined;
  const fhir = {
    async read<T extends Resource>(): Promise<T> {
      return structuredClone(subject) as T;
    },
    async executeTransactionAsActor(request: Bundle): Promise<Bundle> {
      writtenPatient = structuredClone(request.entry?.[0]?.resource as Patient);
      return {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: [
          { response: { status: "200 OK" } },
          { response: { status: "201 Created" } },
        ],
      };
    },
  };

  const result = await clearPatientSmsOptOut(fhir, "Patient/synthetic-1", {
    actorReference: "Practitioner/staff-1",
    actorRole: "staff",
    recordedAt: "2026-08-30T15:00:00.000Z",
    reason: "Patient requested clinical-lane re-enrollment in person",
    identityVerification: "in-person",
    number: clinicalNumber,
  });

  assert.deepEqual(result, {
    patientReference: "Patient/synthetic-1",
    smsOptedOut: false,
    cleared: true,
    suppressionCleared: true,
    remainingOptOuts: { global: false, numbers: [frontDeskNumber] },
  });
  assert.deepEqual(
    writtenPatient?.extension?.[0]?.extension?.find((part) => part.url === "number")?.valueString,
    frontDeskNumber,
  );
});

test("PMS-side patient/channel opt-out suppresses before the provider call", async () => {
  const sent: SendEmailRequest[] = [];
  const optedOut = patient({
    extension: [{
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [{ url: "channel", valueCode: "email" }],
    }],
  });
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(optedOut),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await sendEmail(provider, baseRequest());
  assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
  assert.equal(sent.length, 0);
});

test("PMS-side SMS opt-out blocks a send before resolving or calling Twilio", async () => {
  const sent: SendSmsRequest[] = [];
  const optedOut = patient({
    telecom: [{ system: "phone", value: "+18645550199" }],
    extension: [{
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [{ url: "channel", valueCode: "sms" }],
    }],
  });
  const provider = createSuppressedCommsProvider({
    name: "twilio",
    capabilities: {
      sms: true,
      calls: false,
      email: false,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendEmail() {
      throw new Error("Twilio does not support email.");
    },
    async sendSms(request) {
      sent.push(request);
      return { outcome: "sent", providerMessageId: "unexpected" };
    },
  }, {
    fhir: fhirFor(optedOut),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await provider.sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Reminder: appointment tomorrow. Reply STOP to unsubscribe.",
    campaignType: "appointment-reminder",
    suppression: {},
  });

  assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
  assert.equal(sent.length, 0);
});

test("allowed SMS resolves an active Patient.telecom phone before calling Twilio", async () => {
  const sent: SendSmsRequest[] = [];
  const subject = patient({
    telecom: [
      { system: "phone", use: "old", value: "+18645550111" },
      { system: "phone", use: "work", value: "+18645550122" },
      { system: "phone", use: "mobile", value: "+18645550199" },
    ],
  });
  const provider = createSuppressedCommsProvider({
    name: "twilio",
    capabilities: {
      sms: true,
      calls: false,
      email: false,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendEmail() {
      throw new Error("Twilio does not support email.");
    },
    async sendSms(request) {
      sent.push(request);
      return { outcome: "sent", providerMessageId: "sms-1" };
    },
  }, {
    fhir: fhirFor(subject),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await provider.sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Reminder: appointment tomorrow. Reply STOP to unsubscribe.",
    campaignType: "appointment-reminder",
    suppression: {},
  });

  assert.equal(result.outcome, "sent");
  assert.equal(sent[0].toNumber, "+18645550199");
});

test("SMS-specific Patient.telecom takes precedence over mobile and other phones", async () => {
  const sent: SendSmsRequest[] = [];
  const subject = patient({
    telecom: [
      { system: "phone", use: "work", value: "+18645550122" },
      { system: "phone", use: "mobile", value: "+18645550199" },
      { system: "sms", value: "+18645550188" },
    ],
  });
  const provider = createSuppressedCommsProvider({
    name: "twilio",
    capabilities: {
      sms: true,
      calls: false,
      email: false,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendSms(request) {
      sent.push(request);
      return { outcome: "sent", providerMessageId: "sms-1" };
    },
  }, {
    fhir: fhirFor(subject),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  await provider.sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Reminder: appointment tomorrow. Reply STOP to unsubscribe.",
    campaignType: "appointment-reminder",
    suppression: {},
  });

  assert.equal(sent[0].toNumber, "+18645550188");
});

test("outside quiet hours reschedules to the next patient-local 8 AM rather than sending or dropping", async () => {
  const sent: SendEmailRequest[] = [];
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(patient()),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T06:00:00.000Z"),
  });

  const result = await sendEmail(provider, baseRequest());
  assert.deepEqual(result, {
    outcome: "rescheduled",
    reason: "quiet-hours",
    rescheduledAt: "2026-07-30T12:00:00.000Z",
  });
  assert.equal(sent.length, 0);
});

test("live staff transactional chart education bypasses quiet hours", async () => {
  const sent: SendSmsRequest[] = [];
  const provider = createSuppressedCommsProvider({
    name: "fake",
    capabilities: {
      sms: true,
      calls: false,
      email: false,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendSms(request) {
      sent.push(request);
      return { outcome: "sent", providerMessageId: "sms-1" };
    },
  }, {
    fhir: fhirFor(patient({ telecom: [{ system: "phone", value: "+18645550199" }] })),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T06:00:00.000Z"),
  });

  const result = await provider.sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Synthetic in-visit education",
    campaignType: "clinical-education",
    suppression: { quietHoursExemption: "staff-initiated-chart-education" },
  });

  assert.equal(result.outcome, "sent");
  assert.equal(sent.length, 1);
});

test("staff chart education quiet-hours exemption does not bypass opt-out or frequency caps", async () => {
  const optOutPatient = patient({
    telecom: [{ system: "phone", value: "+18645550199" }],
    extension: [{
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [{ url: "channel", valueCode: "sms" }],
    }],
  });
  const prior: Communication = {
    resourceType: "Communication",
    status: "completed",
    sent: "2026-07-29T14:00:00.000Z",
    subject: { reference: "Patient/synthetic-1" },
    category: [{ coding: [{
      system: "https://odos2020.com/fhir/CodeSystem/comms-campaign-type",
      code: "clinical-education",
    }] }],
  };
  const optOutSends: SendSmsRequest[] = [];
  const cappedSends: SendSmsRequest[] = [];
  const makeProvider = (sent: SendSmsRequest[], subject: Patient, communications: Communication[] = []) =>
    createSuppressedCommsProvider({
      name: "fake",
      capabilities: {
        sms: true,
        calls: false,
        email: false,
        contacts: false,
        conversations: false,
        reviews: false,
      },
      async sendSms(request) {
        sent.push(request);
        return { outcome: "sent", providerMessageId: "sms-1" };
      },
    }, {
      fhir: fhirFor(subject, communications),
      practiceTimeZone: "America/New_York",
      now: () => new Date("2026-07-30T06:00:00.000Z"),
    });
  const suppression = {
    quietHoursExemption: "staff-initiated-chart-education" as const,
    frequencyCapDays: 90,
  };

  assert.deepEqual(await makeProvider(optOutSends, optOutPatient).sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Synthetic in-visit education",
    campaignType: "clinical-education",
    suppression,
  }), { outcome: "suppressed", reason: "patient-opt-out" });
  assert.deepEqual(await makeProvider(
    cappedSends,
    patient({ telecom: [{ system: "phone", value: "+18645550199" }] }),
    [prior],
  ).sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Synthetic in-visit education",
    campaignType: "clinical-education",
    messageId: "current-education",
    suppression,
  }), { outcome: "suppressed", reason: "frequency-cap" });
  assert.equal(optOutSends.length, 0);
  assert.equal(cappedSends.length, 0);
});

test("a configured campaign frequency cap suppresses a repeat inside the lookback window", async () => {
  const sent: SendEmailRequest[] = [];
  let searchQuery: URLSearchParams | undefined;
  const prior: Communication = {
    resourceType: "Communication",
    status: "completed",
    sent: "2026-07-01T14:00:00.000Z",
    subject: { reference: "Patient/synthetic-1" },
    category: [{
      coding: [{
        system: "https://odos2020.com/fhir/CodeSystem/comms-campaign-type",
        code: "staff-initiated",
      }],
    }],
  };
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(patient(), [prior], (params) => {
      searchQuery = new URLSearchParams(
        params as ConstructorParameters<typeof URLSearchParams>[0],
      );
    }),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await sendEmail(provider, baseRequest({
    campaignType: "staff-initiated",
    messageId: "current-send",
    suppression: { frequencyCapDays: 90 },
  }));
  assert.deepEqual(result, { outcome: "suppressed", reason: "frequency-cap" });
  assert.equal(sent.length, 0);
  assert.equal(searchQuery?.get("subject"), "Patient/synthetic-1");
  assert.equal(searchQuery?.get("patient"), null);
});

test("frequency-cap evaluation follows FHIR next links before allowing a send", async () => {
  const sent: SendEmailRequest[] = [];
  let nextReads = 0;
  const prior: Communication = {
    resourceType: "Communication",
    status: "completed",
    sent: "2026-07-01T14:00:00.000Z",
    subject: { reference: "Patient/synthetic-1" },
    category: [{
      coding: [{
        system: "https://odos2020.com/fhir/CodeSystem/comms-campaign-type",
        code: "staff-initiated",
      }],
    }],
  };
  const fhir = {
    ...fhirFor(patient()),
    baseUrl: "https://odos.local/",
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({
      resourceType: "Bundle",
      type: "searchset",
      link: [{ relation: "next", url: "https://odos.local/fhir/R4/Communication?page=2" }],
    }),
    searchUrl: async <T extends Resource>(): Promise<Bundle<T>> => {
      nextReads += 1;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: structuredClone(prior) as T }],
      };
    },
  };
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir,
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await sendEmail(provider, baseRequest({
    campaignType: "staff-initiated",
    messageId: "current-send",
    suppression: { frequencyCapDays: 90 },
  }));

  assert.deepEqual(result, { outcome: "suppressed", reason: "frequency-cap" });
  assert.equal(nextReads, 1);
  assert.equal(sent.length, 0);
});

test("concurrent in-progress claims elect exactly one deterministic frequency-cap winner", async () => {
  const sent: SendEmailRequest[] = [];
  const claims: Communication[] = ["claim-a", "claim-b"].map((value) => ({
    resourceType: "Communication",
    status: "in-progress",
    meta: { lastUpdated: "2026-07-30T13:59:00.000Z" },
    identifier: [{
      system: "https://odos2020.com/fhir/NamingSystem/comms-send",
      value,
    }],
    subject: { reference: "Patient/synthetic-1" },
    category: [{
      coding: [{
        system: "https://odos2020.com/fhir/CodeSystem/comms-campaign-type",
        code: "staff-initiated",
      }],
    }],
  }));
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(patient(), claims),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const winner = await sendEmail(provider, baseRequest({
    campaignType: "staff-initiated",
    messageId: "claim-a",
    suppression: { frequencyCapDays: 90 },
  }));
  const loser = await sendEmail(provider, baseRequest({
    campaignType: "staff-initiated",
    messageId: "claim-b",
    suppression: { frequencyCapDays: 90 },
  }));

  assert.equal(winner.outcome, "sent");
  assert.deepEqual(loser, { outcome: "suppressed", reason: "frequency-cap" });
  assert.equal(sent.length, 1);
});

test("an allowed send resolves Patient.telecom email and reaches the provider", async () => {
  const sent: SendEmailRequest[] = [];
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(patient()),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await sendEmail(provider, baseRequest());
  assert.equal(result.outcome, "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].toAddress, "patient@example.test");
});

test("email resolution skips a ContactPoint whose validity starts in the future", async () => {
  const sent: SendEmailRequest[] = [];
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(patient({
      telecom: [
        {
          system: "email",
          value: "future@example.test",
          period: { start: "2026-08-01T00:00:00.000Z" },
        },
        { system: "email", value: "active@example.test" },
      ],
    })),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  await sendEmail(provider, baseRequest());

  assert.equal(sent[0].toAddress, "active@example.test");
});

const RECORD_INPUT = {
  actorReference: "Practitioner/staff", actorRole: "staff", recordedAt: "2026-09-10T16:00:00Z",
  reason: "Patient asked for no texts", identityVerification: "in-person", scope: "global",
} as const;

test("record requires a fresh Patient version before writing", async () => {
  let writes = 0;
  await assert.rejects(recordPatientSmsOptOut({
    read: async () => patient(),
    executeTransactionAsActor: async () => { writes++; throw new Error("Unexpected write"); },
  } as never, "Patient/synthetic-1", RECORD_INPUT), /requires the Patient to have an id and version/);
  assert.equal(writes, 0);
});

test("record refuses failed or incomplete transaction responses and propagates conflicts", async () => {
  for (const response of [
    { resourceType: "Bundle", type: "searchset", entry: [] },
    { resourceType: "Bundle", type: "transaction-response", entry: [{ response: { status: "200 OK" } }] },
    { resourceType: "Bundle", type: "transaction-response", entry: [{ response: { status: "200 OK" } }, { response: { status: "403 Forbidden" } }] },
  ] as Bundle[]) {
    await assert.rejects(recordPatientSmsOptOut({
      read: async () => patient({ meta: { versionId: "8" } }),
      executeTransactionAsActor: async (_request: Bundle, _actor: unknown, headers: unknown, options: { validateResponse: (bundle: Bundle) => void }) => {
        assert.deepEqual(headers, { "X-ODOS-Source": "mcp/comms-opt-out-record" });
        options.validateResponse(response);
        return response;
      },
    } as never, "Patient/synthetic-1", RECORD_INPUT), /SMS opt-out/);
  }
  const conflict = Object.assign(new Error("Concurrent Patient edit"), { status: 412 });
  await assert.rejects(recordPatientSmsOptOut({
    read: async () => patient({ meta: { versionId: "8" } }),
    executeTransactionAsActor: async () => { throw conflict; },
  } as never, "Patient/synthetic-1", RECORD_INPUT), (error) => error === conflict);
});
