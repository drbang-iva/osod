import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AccessPolicy, Bundle, Communication, Condition, Encounter, Patient, ProjectMembership, Provenance, Resource } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
} from "../src/authz/roles.js";
import type {
  CommsProvider,
  ConversationSummary,
  SendEmailRequest,
  SendResult,
  SendSmsRequest,
} from "../src/comms/comms-provider.js";
import {
  ODOS_COMMS_MARKETING_CONSENT_EXTENSION_URL,
  registerCommsApiRoutes,
  type CommsApiRouteDeps,
} from "../src/comms/comms-api.js";
import type { EducationContentItem } from "../src/comms/education-catalog.js";
import { checkMessageSuppression, updateInboundSuppression, ODOS_COMMS_OPT_OUT_EXTENSION_URL } from "../src/comms/suppression-gate.js";
import { authenticateStaffRoute } from "../src/payments/payment-endpoint.js";
import express from "express";
import { createOperatorScriptFhirClient } from "../src/fhir-client.js";

const PATIENT_REFERENCE = "Patient/synthetic-1";
const OPT_OUT_CLEAR_BODY = {
  patientReference: PATIENT_REFERENCE,
  reason: "Patient requested re-enrollment in person",
  identityVerification: "in-person",
} as const;
const CALL_ID = `CA${"3".repeat(32)}`;
const OTHER_CALL_ID = `CA${"8".repeat(32)}`;
const RECORDING_ID = `RE${"4".repeat(32)}`;
const EDUCATION_ITEMS: EducationContentItem[] = [
  {
    id: "dry-eye-basics",
    version: 1,
    title: "Understanding dry eye",
    kind: "video",
    audience: "patient",
    dxCodes: ["H04.123"],
    channels: ["sms", "email"],
    laneHint: "clinical",
    consentClass: "transactional",
    urls: {
      web: "https://education.invalid/dry-eye-basics/v1",
      email: "https://education.invalid/dry-eye-basics/v1/email",
    },
  },
  {
    id: "dry-eye-basics",
    version: 2,
    title: "Understanding dry eye",
    kind: "video",
    audience: "patient",
    dxCodes: ["H04.123"],
    channels: ["sms", "email"],
    laneHint: "clinical",
    consentClass: "transactional",
    urls: {
      web: "https://education.invalid/dry-eye-basics/v2",
      email: "https://education.invalid/dry-eye-basics/v2/email",
    },
  },
  {
    id: "internal-myopia-counseling-guide",
    version: 1,
    title: "Internal myopia counseling guide",
    kind: "page",
    audience: "internal",
    dxCodes: [],
    channels: ["print"],
    laneHint: "clinical",
    consentClass: "transactional",
    urls: { print: "https://education.invalid/internal-myopia-counseling-guide/v1/print" },
  },
  {
    id: "dry-eye-treatment-options",
    version: 1,
    title: "Dry eye treatment options",
    kind: "handout",
    audience: "patient",
    dxCodes: ["H04.123"],
    channels: ["sms", "email"],
    laneHint: "retail",
    consentClass: "marketing",
    urls: {
      web: "https://education.invalid/dry-eye-treatment-options/v1",
      email: "https://education.invalid/dry-eye-treatment-options/v1/email",
    },
  },
  {
    id: "dry-eye-home-care",
    version: 1,
    title: "Dry eye home care",
    kind: "handout",
    audience: "patient",
    dxCodes: ["H04.123"],
    channels: ["email", "print"],
    laneHint: "clinical",
    consentClass: "transactional",
    urls: {
      email: "https://education.invalid/dry-eye-home-care/v1/email",
      print: "https://education.invalid/dry-eye-home-care/v1/print",
    },
  },
];

test("communications RBAC gives front desk patient content without widening its FHIR scope", () => {
  const frontDeskDeclaration = getRoleDeclaration("staff");
  const frontDesk = buildMedplumAccessPolicy(frontDeskDeclaration);
  const frontDeskRule = frontDesk.resource?.find((rule) =>
    rule.resourceType === "Communication"
    && rule.criteria === "Communication?_compartment=%patient_compartment");
  assert.ok(frontDeskRule);
  assert.equal(frontDeskRule.hiddenFields, undefined);
  assert.equal(frontDeskRule.criteria, "Communication?_compartment=%patient_compartment");
  assert.equal(frontDeskRule.interaction?.includes("create"), true);
  assert.equal(frontDeskRule.interaction?.includes("update"), true);
  assert.equal(frontDeskDeclaration.businessActions.includes("communications.content.read"), true);
  assert.equal(frontDeskDeclaration.businessActions.includes("communications.optout.manage"), true);
  const internalOfficeRule = frontDesk.resource?.find((rule) =>
    rule.resourceType === "Communication" && rule.criteria?.includes("internal-office"));
  assert.ok(internalOfficeRule);
  assert.equal(internalOfficeRule.interaction?.includes("update"), false);

  for (const role of ["provider", "admin"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(role));
    const rule = policy.resource?.find((candidate) =>
      candidate.resourceType === "Communication" && candidate.criteria?.includes("%patient_compartment"));
    assert.ok(rule, role);
    assert.equal(rule.hiddenFields, undefined);
    assert.equal(rule.interaction?.includes("create"), true);
    assert.equal(rule.interaction?.includes("update"), true);
  }
  const admin = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  assert.equal(admin.resource?.some((rule) => rule.resourceType === "Communication"), true);
});

test("SMS opt-out management is held only by the front-desk staff role", () => {
  const holders = PRACTICE_ROLE_IDS.filter((role) =>
    getRoleDeclaration(role).businessActions.includes("communications.optout.manage"));

  assert.deepEqual(holders, ["staff"]);
});

test("a multi-role caller cannot attribute opt-out management to a held role that lacks the action", async () => {
  const fixture = await startServer({ roles: ["provider", "staff"] });
  try {
    const response = await request(
      fixture.base,
      "/communications/opt-out/clear",
      "POST",
      OPT_OUT_CLEAR_BODY,
      "provider",
      "provider",
    );

    assert.equal(response.status, 403);
    assert.equal(fixture.grants.length, 0);
    assert.equal(fixture.provenances.length, 0);
    assert.equal(fixture.denials.length, 1);
  } finally {
    await fixture.close();
  }
});

test("a membership-only communications grant cites the membership instead of an unrelated AccessPolicy", async () => {
  const membershipReference = "ProjectMembership/membership-provider";
  const fixture = await startServer({
    roles: ["provider"],
    businessActions: ["communications.optout.manage"],
    membershipReference,
  });
  try {
    const response = await fetch(`${fixture.base}/communications/opt-out/clear`, {
      method: "POST",
      headers: {
        authorization: "Bearer provider",
        "content-type": "application/json",
      },
      body: JSON.stringify(OPT_OUT_CLEAR_BODY),
    });

    assert.equal(response.status, 200);
    assert.equal(fixture.grants[0]?.actorRole, "provider");
    assert.equal(fixture.grants[0]?.policyUrl, membershipReference);
    assert.equal(fixture.attributedActors[0]?.policyUrl, membershipReference);
  } finally {
    await fixture.close();
  }
});

test("FHIR policy construction preserves a declared hidden-field mask", () => {
  const policy = buildMedplumAccessPolicy({
    id: "staff",
    display: "Synthetic Masked Role",
    description: "Exercises the retained field-mask mechanism.",
    businessActions: [],
    resourceRules: [{
      resourceType: "Communication",
      interactions: ["read"],
      scope: { kind: "practice" },
      hiddenFields: ["payload", "note", "text"],
    }],
  });
  assert.deepEqual(policy.resource?.[0].hiddenFields, ["payload", "note", "text"]);
});

test("every communications endpoint rejects missing authentication and audits every authenticated wrong-role denial", async () => {
  const fixture = await startServer();
  const endpoints = [
    { method: "GET", path: "/communications/education" },
    { method: "GET", path: "/communications/education/dry-eye-basics" },
    { method: "POST", path: "/communications/education/dispatch", body: {
      patientReference: PATIENT_REFERENCE,
      educationId: "dry-eye-basics",
      version: 2,
      channel: "sms",
      lane: "clinical",
      idempotencyKey: "education-auth-0001",
    } },
    { method: "POST", path: "/communications/education/enrollments/enrollment-auth/transitions", body: {
      fromStageId: "welcome",
      targetStage: { id: "consult", immediateSends: [] },
      trigger: "clinician-action",
      status: "active",
    } },
    { method: "GET", path: "/communications/conversations" },
    { method: "GET", path: `/communications/opt-out?patient=${PATIENT_REFERENCE}` },
    { method: "POST", path: "/communications/opt-out/clear", body: OPT_OUT_CLEAR_BODY },
    { method: "POST", path: "/communications/messages", body: { patientReference: PATIENT_REFERENCE, body: "Synthetic message" } },
    { method: "GET", path: "/communications/calls" },
    { method: "GET", path: `/communications/calls/${CALL_ID}` },
    { method: "POST", path: "/communications/calls", body: { patientReference: PATIENT_REFERENCE } },
    { method: "GET", path: `/communications/recordings/${RECORDING_ID}` },
  ] as const;
  try {
    for (const endpoint of endpoints) {
      const unauthenticated = await request(fixture.base, endpoint.path, endpoint.method, endpoint.body);
      assert.equal(unauthenticated.status, 401, `${endpoint.method} ${endpoint.path}`);
      const wrongRole = await request(fixture.base, endpoint.path, endpoint.method, endpoint.body, "admin", "none");
      assert.equal(wrongRole.status, 403, `${endpoint.method} ${endpoint.path}`);
    }
    assert.equal(fixture.denials.length, endpoints.length);
    assert.equal(fixture.denials.every((row) => row.eventType === "denied" && row.actionOutcome === "denied"), true);
    assert.equal(fixture.providerCalls.length, 0);
  } finally {
    await fixture.close();
  }
});

test("education list filters by diagnosis and channel while excluding internal content", async () => {
  const fixture = await startServer();
  try {
    const response = await request(
      fixture.base,
      "/communications/education?dxCode=H04.123&channel=sms",
      "GET",
      undefined,
      "staff",
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { items: EducationContentItem[]; chartDispatchLane: string };
    assert.deepEqual(body.items.map(({ id, version }) => ({ id, version })), [
      { id: "dry-eye-basics", version: 1 },
      { id: "dry-eye-basics", version: 2 },
      { id: "dry-eye-treatment-options", version: 1 },
    ]);
    assert.equal(body.items.every(({ audience }) => audience === "patient"), true);
    assert.equal(body.chartDispatchLane, "staff_switchable");
    assert.equal(fixture.grants.at(-1)?.actionReason, "communications-education-list");

    const unfiltered = await request(
      fixture.base,
      "/communications/education",
      "GET",
      undefined,
      "staff",
    );
    assert.equal(unfiltered.status, 200);
    assert.equal((await unfiltered.json() as { items: EducationContentItem[] }).items.some(
      ({ audience }) => audience === "internal",
    ), false);

    const malformed = await request(
      fixture.base,
      "/communications/education?channel=voice",
      "GET",
      undefined,
      "staff",
    );
    assert.equal(malformed.status, 400);
    assert.equal(fixture.denials.at(-1)?.actionReason, "communications-education-list-failed");
  } finally {
    await fixture.close();
  }
});

test("education list reports dispatchability from the same per-role configuration enforced at send time", async () => {
  const fixture = await startServer({
    channelRoutes: { "clinical-sms": "twilio", "transactional-sms": "twilio", email: "twilio" },
    senderNumbers: { "clinical-sms": "+18485550100" },
  });
  try {
    const response = await request(
      fixture.base,
      "/communications/education",
      "GET",
      undefined,
      "staff",
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as {
      availableChannels: {
        clinicalSms: boolean;
        frontdeskSms: boolean;
        email: boolean;
        print: boolean;
      };
    }).availableChannels, {
      clinicalSms: true,
      frontdeskSms: false,
      email: true,
      print: true,
    });
  } finally {
    await fixture.close();
  }
});

test("education detail returns newest or exact pinned version and never exposes internal content", async () => {
  const fixture = await startServer();
  try {
    const newest = await request(
      fixture.base,
      "/communications/education/dry-eye-basics",
      "GET",
      undefined,
      "provider",
    );
    assert.equal(newest.status, 200);
    assert.equal((await newest.json() as { item: EducationContentItem }).item.version, 2);

    const pinned = await request(
      fixture.base,
      "/communications/education/dry-eye-basics?version=1",
      "GET",
      undefined,
      "provider",
    );
    assert.equal(pinned.status, 200);
    assert.equal((await pinned.json() as { item: EducationContentItem }).item.version, 1);

    const internal = await request(
      fixture.base,
      "/communications/education/internal-myopia-counseling-guide",
      "GET",
      undefined,
      "provider",
    );
    assert.equal(internal.status, 404);
    assert.deepEqual(await internal.json(), { error: "Education content not found." });
    assert.equal(fixture.grants.at(-1)?.actionReason, "communications-education-read");
    assert.equal(fixture.denials.at(-1)?.actionReason, "communications-education-read-failed");
  } finally {
    await fixture.close();
  }
});

test("education dispatch refuses marketing content when recorded patient consent is absent", async () => {
  const fixture = await startServer();
  try {
    const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
      patientReference: PATIENT_REFERENCE,
      educationId: "dry-eye-treatment-options",
      version: 1,
      channel: "sms",
      lane: "frontdesk",
      idempotencyKey: "education-marketing-0001",
    }, "staff");

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      outcome: "refused",
      reason: "marketing-consent-absent",
    });
    assert.deepEqual(fixture.providerCalls, []);
  } finally {
    await fixture.close();
  }
});

test("only transactional staff chart education receives the quiet-hours exemption", async () => {
  const fixture = await startServer({
    marketingConsent: true,
    channelRoutes: { "transactional-sms": "twilio", "clinical-sms": "twilio" },
    senderNumbers: { "transactional-sms": "+18645550100", "clinical-sms": "+18485550100" },
  });
  try {
    for (const [educationId, version, lane, idempotencyKey] of [
      ["dry-eye-basics", 2, "clinical", "education-transactional-quiet-hours"],
      ["dry-eye-treatment-options", 1, "frontdesk", "education-marketing-quiet-hours"],
    ] as const) {
      const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
        patientReference: PATIENT_REFERENCE,
        educationId,
        version,
        channel: "sms",
        lane,
        idempotencyKey,
      }, "staff");
      assert.equal(response.status, 200);
    }

    assert.deepEqual(fixture.smsRequests.map(({ suppression }) => suppression), [
      { quietHoursExemption: "staff-initiated-chart-education", consentClass: "transactional" },
      { consentClass: "marketing" },
    ]);
  } finally {
    await fixture.close();
  }
});

test("clinical education SMS uses the clinical lane, one tracked link, durable send state, and send provenance", async () => {
  const fixture = await startServer({
    channelRoutes: { "transactional-sms": "ghl", "clinical-sms": "twilio" },
    senderNumbers: { "transactional-sms": "+18645550100", "clinical-sms": "+18485550100" },
  });
  try {
    const dispatchBody = {
      patientReference: PATIENT_REFERENCE,
      educationId: "dry-eye-basics",
      version: 2,
      channel: "sms",
      lane: "clinical",
      encounterReference: "Encounter/encounter-1",
      conditionReference: "Condition/condition-1",
      idempotencyKey: "education-clinical-0001",
    };
    const response = await request(fixture.base, "/communications/education/dispatch", "POST", dispatchBody, "provider");

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { outcome: "sent", providerMessageId: "SM-synthetic" });
    assert.deepEqual(fixture.adapterProviders, ["twilio"]);
    assert.equal(fixture.smsRequests.length, 1);
    assert.equal(fixture.smsRequests[0]?.campaignType, "clinical-education");
    assert.equal(fixture.smsRequests[0]?.toNumber, "+18645550199");
    assert.match(fixture.smsRequests[0]?.body ?? "", /^Synthetic Eye Care\nhttps:\/\/practice\.example\/comms\/r\/[A-Za-z0-9_-]+\nReply STOP to opt out\.$/);
    assert.doesNotMatch(fixture.smsRequests[0]?.body ?? "", /dry eye|H04\.123|Patient\//i);
    assert.deepEqual(fixture.trackedLinks.map(({ targetUrl, campaignId, messageId }) => ({ targetUrl, campaignId, messageId })), [{
      targetUrl: "https://education.invalid/dry-eye-basics/v2",
      campaignId: "dry-eye-basics@2",
      messageId: "education-clinical-0001",
    }]);
    assert.equal(fixture.persistedCommunications.length, 1);
    assert.equal(fixture.persistedCommunications[0]?.status, "in-progress");
    assert.equal(fixture.provenances.length, 1);
    const provenanceText = JSON.stringify(fixture.provenances[0]);
    assert.match(provenanceText, /Encounter\/encounter-1/);
    assert.match(provenanceText, /Condition\/condition-1/);
    assert.match(provenanceText, /dry-eye-basics@2/);
    assert.match(provenanceText, /clinical/);
    assert.match(provenanceText, /default/);
    assert.match(provenanceText, /\+18645550199/);
    const retry = await request(fixture.base, "/communications/education/dispatch", "POST", dispatchBody, "provider");
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { outcome: "sent", providerMessageId: "SM-synthetic" });
    assert.equal(fixture.smsRequests.length, 1);
    assert.equal(fixture.persistedCommunications.length, 1);
    assert.equal(fixture.trackedLinks.length, 1);
  } finally {
    await fixture.close();
  }
});

test("education print returns the published print artifact without rendering a PDF and records provenance", async () => {
  const fixture = await startServer();
  try {
    const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
      patientReference: PATIENT_REFERENCE,
      educationId: "internal-myopia-counseling-guide",
      version: 1,
      channel: "print",
      lane: "clinical",
      idempotencyKey: "education-print-0001",
    }, "provider");
    assert.equal(response.status, 404);

    const patientPrint = await request(fixture.base, "/communications/education/dispatch", "POST", {
      patientReference: PATIENT_REFERENCE,
      educationId: "dry-eye-home-care",
      version: 1,
      channel: "print",
      lane: "clinical",
      idempotencyKey: "education-print-0002",
    }, "provider");
    assert.equal(patientPrint.status, 200);
    assert.deepEqual(await patientPrint.json(), {
      outcome: "print",
      url: "https://education.invalid/dry-eye-home-care/v1/print",
    });
    assert.deepEqual(fixture.providerCalls, []);
    assert.equal(fixture.provenances.length, 1);
    assert.match(JSON.stringify(fixture.provenances[0]), /print/);
  } finally {
    await fixture.close();
  }
});

test("education email sends the published email artifact to the recorded address", async () => {
  const fixture = await startServer({ channelRoutes: { email: "twilio" } });
  try {
    const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
      patientReference: PATIENT_REFERENCE,
      educationId: "dry-eye-basics",
      version: 2,
      channel: "email",
      lane: "clinical",
      idempotencyKey: "education-email-0001",
    }, "staff");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { outcome: "sent", providerMessageId: "EM-synthetic" });
    assert.equal(fixture.emailRequests.length, 1);
    assert.equal(fixture.emailRequests[0]?.toAddress, "patient@example.test");
    assert.equal(fixture.emailRequests[0]?.body, "https://education.invalid/dry-eye-basics/v2/email");
    assert.equal(fixture.emailRequests[0]?.campaignType, "clinical-education");
  } finally {
    await fixture.close();
  }
});

test("education dispatch refuses an unconfigured lane and enforces the practice clinical lock", async () => {
  const unconfigured = await startServer({ channelRoutes: {}, senderNumbers: {} });
  try {
    const response = await request(unconfigured.base, "/communications/education/dispatch", "POST", {
      patientReference: PATIENT_REFERENCE,
      educationId: "dry-eye-basics",
      version: 2,
      channel: "sms",
      lane: "clinical",
      idempotencyKey: "education-unconfigured-0001",
    }, "provider");
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /clinical-sms lane is not configured/);
    assert.equal(unconfigured.smsRequests.length, 0);
  } finally {
    await unconfigured.close();
  }

  const locked = await startServer({
    chartDispatchLane: "locked_clinical",
    channelRoutes: { "transactional-sms": "ghl" },
    senderNumbers: { "transactional-sms": "+18645550100" },
  });
  try {
    const response = await request(locked.base, "/communications/education/dispatch", "POST", {
      patientReference: PATIENT_REFERENCE,
      educationId: "dry-eye-basics",
      version: 2,
      channel: "sms",
      lane: "frontdesk",
      idempotencyKey: "education-locked-0001",
    }, "provider");
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /locked to the clinical lane/);
    assert.equal(locked.smsRequests.length, 0);
  } finally {
    await locked.close();
  }
});

test("education SMS reports missing or non-HTTPS tracked-link setup as a 409 before minting a token", async () => {
  for (const [label, publicBaseUrl] of [["missing", ""], ["non-https", "http://practice.example"]]) {
    const fixture = await startServer({
      publicBaseUrl,
      channelRoutes: { "clinical-sms": "twilio" },
      senderNumbers: { "clinical-sms": "+18485550100" },
    });
    try {
      const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
        patientReference: PATIENT_REFERENCE,
        educationId: "dry-eye-basics",
        version: 2,
        channel: "sms",
        lane: "clinical",
        idempotencyKey: `education-${label}-public-base`,
      }, "provider");
      assert.equal(response.status, 409);
      assert.match((await response.json() as { error: string }).error, /ODOS_COMMS_PUBLIC_BASE_URL.*reachable HTTPS/i);
      assert.equal(fixture.trackedLinks.length, 0);
      assert.equal(fixture.smsRequests.length, 0);
    } finally {
      await fixture.close();
    }
  }
});

test("a terminal SMS suppression is durable and retrying the same key returns the same outcome", async () => {
  const fixture = await startServer({
    smsResult: { outcome: "suppressed", reason: "patient-opt-out" },
    channelRoutes: { "clinical-sms": "twilio" },
    senderNumbers: { "clinical-sms": "+18485550100" },
  });
  const body = {
    patientReference: PATIENT_REFERENCE,
    educationId: "dry-eye-basics",
    version: 2,
    channel: "sms",
    lane: "clinical",
    idempotencyKey: "education-suppressed-terminal",
  };
  try {
    const first = await request(fixture.base, "/communications/education/dispatch", "POST", body, "provider");
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { outcome: "suppressed", reason: "patient-opt-out" });
    const retry = await request(fixture.base, "/communications/education/dispatch", "POST", body, "provider");
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { outcome: "suppressed", reason: "patient-opt-out" });
    assert.equal(fixture.smsRequests.length, 1);
    assert.equal(fixture.persistedCommunications[0]?.status, "not-done");
  } finally {
    await fixture.close();
  }
});

test("a quiet-hours reschedule is durable and retrying the same key returns the same outcome", async () => {
  const result = {
    outcome: "rescheduled",
    reason: "quiet-hours",
    rescheduledAt: "2026-08-31T22:00:00.000Z",
  } as const;
  const fixture = await startServer({
    smsResult: result,
    channelRoutes: { "clinical-sms": "twilio" },
    senderNumbers: { "clinical-sms": "+18485550100" },
  });
  const body = {
    patientReference: PATIENT_REFERENCE,
    educationId: "dry-eye-basics",
    version: 2,
    channel: "sms",
    lane: "clinical",
    idempotencyKey: "education-rescheduled-terminal",
  };
  try {
    const first = await request(fixture.base, "/communications/education/dispatch", "POST", body, "provider");
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), result);
    const retry = await request(fixture.base, "/communications/education/dispatch", "POST", body, "provider");
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), result);
    assert.equal(fixture.smsRequests.length, 1);
    assert.equal(fixture.persistedCommunications[0]?.status, "not-done");
  } finally {
    await fixture.close();
  }
});

test("a failed education send leaves recipient telecom unchanged", async () => {
  const fixture = await startServer({
    smsError: new Error("Synthetic provider outage"),
    channelRoutes: { "clinical-sms": "twilio" },
    senderNumbers: { "clinical-sms": "+18485550100" },
  });
  try {
    const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
      patientReference: PATIENT_REFERENCE,
      educationId: "dry-eye-basics",
      version: 2,
      channel: "sms",
      lane: "clinical",
      recipientOverride: { phone: "+18645550177" },
      alsoUpdateChart: true,
      idempotencyKey: "education-failed-chart-update",
    }, "staff");
    assert.equal(response.status, 502);
    assert.equal(fixture.recipientUpdates.length, 0);
  } finally {
    await fixture.close();
  }
});

test("education clinical references must belong to the selected patient", async () => {
  const fixture = await startServer();
  try {
    for (const reference of [
      { conditionReference: "Condition/condition-other" },
      { encounterReference: "Encounter/encounter-other" },
    ]) {
      const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
        patientReference: PATIENT_REFERENCE,
        educationId: "dry-eye-home-care",
        version: 1,
        channel: "print",
        lane: "clinical",
        ...reference,
        idempotencyKey: `education-cross-patient-${Object.keys(reference)[0]}`,
      }, "staff");
      assert.equal(response.status, 400);
      assert.match((await response.json() as { error: string }).error, /must belong to Patient\/synthetic-1/);
    }
    assert.equal(fixture.provenances.length, 0);
  } finally {
    await fixture.close();
  }
});

test("education recipient override stays send-scoped unless the explicit chart-update flag is set", async () => {
  const fixture = await startServer({
    channelRoutes: { "clinical-sms": "twilio" },
    senderNumbers: { "clinical-sms": "+18485550100" },
  });
  try {
    const wrongPatient = await request(fixture.base, "/communications/education/dispatch", "POST", {
      patientReference: PATIENT_REFERENCE,
      educationId: "dry-eye-basics",
      version: 2,
      channel: "sms",
      lane: "clinical",
      recipientOverride: { reference: "Patient/synthetic-2", phone: "+18645550177" },
      idempotencyKey: "education-override-wrong-patient",
    }, "staff");
    assert.equal(wrongPatient.status, 400);
    assert.match((await wrongPatient.json() as { error: string }).error, /must match patientReference/);

    const body = {
      patientReference: PATIENT_REFERENCE,
      educationId: "dry-eye-basics",
      version: 2,
      channel: "sms",
      lane: "clinical",
      recipientOverride: { phone: "+18645550177" },
      alsoUpdateChart: true,
      idempotencyKey: "education-override-0001",
    };
    const response = await request(fixture.base, "/communications/education/dispatch", "POST", body, "staff");
    assert.equal(response.status, 200);
    assert.equal(fixture.smsRequests[0]?.toNumber, "+18645550177");
    assert.equal(fixture.recipientUpdates.length, 1);
    assert.equal((fixture.recipientUpdates[0] as Patient).telecom?.find((point) =>
      point.system === "phone" && point.use !== "old")?.value, "+18645550177");
    assert.equal((fixture.recipientUpdates[0] as Patient).telecom?.some((point) =>
      point.system === "phone" && point.use === "old" && point.value === "+18645550199"), true);
    assert.match(JSON.stringify(fixture.provenances[0]), /Recipient override also updated chart/);
    const replay = await request(fixture.base, "/communications/education/dispatch", "POST", body, "staff");
    assert.equal(replay.status, 200);
    assert.equal(fixture.smsRequests.length, 1);
    assert.equal(fixture.recipientUpdates.length, 1);
  } finally {
    await fixture.close();
  }
});

test("opt-out routes require one explicit Patient reference and expose no phone-number clear", async () => {
  const fixture = await startServer();
  try {
    for (const path of [
      "/communications/opt-out",
      "/communications/opt-out?patient=%2B18645550199",
      "/communications/opt-out?phone=%2B18645550199",
    ]) {
      const response = await request(fixture.base, path, "GET", undefined, "staff");
      assert.equal(response.status, 400, path);
    }
    for (const body of [
      {},
      { ...OPT_OUT_CLEAR_BODY, patientReference: "+18645550199" },
      { reason: OPT_OUT_CLEAR_BODY.reason, identityVerification: OPT_OUT_CLEAR_BODY.identityVerification, phone: "+18645550199" },
      { reason: OPT_OUT_CLEAR_BODY.reason, identityVerification: OPT_OUT_CLEAR_BODY.identityVerification, patientReferences: ["Patient/synthetic-1", "Patient/synthetic-2"] },
    ]) {
      const response = await request(fixture.base, "/communications/opt-out/clear", "POST", body, "staff");
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(fixture.patients.every((patient) => patient.extension?.some((entry) =>
      entry.url === ODOS_COMMS_OPT_OUT_EXTENSION_URL)), true);
    assert.equal(fixture.provenances.length, 0);
  } finally {
    await fixture.close();
  }
});

const OPT_OUT_RECORD_BODY = {
  ...OPT_OUT_CLEAR_BODY,
  reason: "Patient asked us to stop all texts",
  scope: "global",
} as const;

test("B1 record rejects missing reason or identity without a Patient write", async () => {
  const fixture = await startServer();
  fixture.patients[0]!.extension = [];
  const before = JSON.stringify(fixture.patients);
  try {
    for (const invalid of [
      { reason: undefined }, { reason: "" }, { reason: "   " }, { reason: "x".repeat(2001) },
      { identityVerification: undefined }, { identityVerification: true }, { identityVerification: "video-call" },
    ]) {
      const response = await request(fixture.base, "/communications/opt-out/record", "POST", { ...OPT_OUT_RECORD_BODY, ...invalid }, "staff");
      assert.equal(response.status, 400, JSON.stringify(invalid));
    }
    assert.equal(JSON.stringify(fixture.patients), before);
    assert.equal(fixture.attributedActors.length, 0);
    assert.equal(fixture.provenances.length, 0);
  } finally { await fixture.close(); }
});

test("B2 recorded global suppression blocks every SMS lane like STOP until clear", async () => {
  const fixture = await startServer();
  fixture.patients[0]!.extension = [];
  try {
    const response = await request(fixture.base, "/communications/opt-out/record", "POST", OPT_OUT_RECORD_BODY, "staff");
    assert.equal(response.status, 200);
    const gate = async (number: string) => checkMessageSuppression({
      fhir: { read: async () => structuredClone(fixture.patients[0]!) } as never,
      practiceTimeZone: "America/New_York", smsSenderNumber: number,
      now: () => new Date("2026-09-10T16:00:00Z"),
    }, { patientReference: PATIENT_REFERENCE, body: "Synthetic message", campaignType: "appointment-reminder", suppression: {} } as never, "sms");
    for (const number of ["+18645550100", "+18485550100"]) {
      assert.deepEqual((await gate(number)).result, { outcome: "suppressed", reason: "patient-opt-out" });
    }
    const provenance = fixture.provenances[0]!;
    assert.equal(provenance.activity?.coding?.[0]?.code, "CREATE");
    assert.equal(provenance.activity?.coding?.[0]?.display, "Record SMS opt-out (patient request)");
    assert.equal(provenance.agent?.[0]?.who.reference, "Practitioner/staff");
    assert.deepEqual(provenance.reason, [{ text: OPT_OUT_RECORD_BODY.reason }]);
    assert.match(JSON.stringify(provenance.entity), /in-person/);
    assert.match(JSON.stringify(provenance.entity), /global/);
    const inboundPatient = structuredClone(fixture.patients[0]!);
    inboundPatient.extension = [];
    await updateInboundSuppression({
      search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [{ resource: inboundPatient }] }),
      update: async (_type: string, _id: string, patient: Patient) => { inboundPatient.extension = patient.extension; return patient; },
    } as never, { from: "+18645550199", to: "+18645550100", body: "STOP" });
    assert.deepEqual(fixture.patients[0]!.extension?.[0], {
      ...inboundPatient.extension![0], extension: inboundPatient.extension![0]!.extension!.filter((child) => child.url !== "number"),
    });
    assert.equal((await request(fixture.base, "/communications/opt-out/clear", "POST", OPT_OUT_CLEAR_BODY, "staff")).status, 200);
    assert.equal((await gate("+18485550100")).result, undefined);
  } finally { await fixture.close(); }
});

test("B3 global record widens and preserves every existing extension", async () => {
  const fixture = await startServer();
  fixture.patients[0]!.extension = [{ url: ODOS_COMMS_OPT_OUT_EXTENSION_URL, extension: [
    { url: "channel", valueCode: "sms" }, { url: "number", valueString: "+18645550100" },
  ] }];
  const before = structuredClone(fixture.patients[0]!.extension);
  try {
    const response = await request(fixture.base, "/communications/opt-out/record", "POST", OPT_OUT_RECORD_BODY, "staff");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { remainingOptOuts: unknown }).remainingOptOuts, { global: true, numbers: ["+18645550100"] });
    assert.deepEqual(fixture.patients[0]!.extension!.slice(0, before.length), before);
    assert.equal(fixture.patients[0]!.extension!.length, before.length + 1);
  } finally { await fixture.close(); }
});

test("B4 exact-scope repeats preserve bytes and write no second Provenance", async () => {
  for (const scope of ["global", "per-number"]) {
    const fixture = await startServer();
    fixture.patients[0]!.extension = [];
    try {
      const body = { ...OPT_OUT_RECORD_BODY, scope, ...(scope === "per-number" ? { number: "+18645550100" } : {}) };
      assert.equal((await request(fixture.base, "/communications/opt-out/record", "POST", body, "staff")).status, 200);
      const before = JSON.stringify(fixture.patients[0]);
      assert.equal((await request(fixture.base, "/communications/opt-out/record", "POST", body, "staff")).status, 200);
      assert.equal(JSON.stringify(fixture.patients[0]), before);
      assert.equal(fixture.provenances.length, 1);
    } finally { await fixture.close(); }
  }
});

test("B5 only action-holding staff can record an opt-out", async () => {
  const fixture = await startServer();
  fixture.patients[0]!.extension = [];
  try {
    for (const role of PRACTICE_ROLE_IDS) {
      const response = await request(fixture.base, "/communications/opt-out/record", "POST", OPT_OUT_RECORD_BODY, role);
      assert.equal(response.status, role === "staff" ? 200 : 403, role);
    }
    assert.equal(fixture.provenances.length, 1);
  } finally { await fixture.close(); }
});

test("B6 record per-number requires E.164 and rejects ambiguous or unexpected fields", async () => {
  const fixture = await startServer();
  fixture.patients[0]!.extension = [];
  try {
    for (const invalid of [
      { scope: "per-number" }, { scope: "per-number", number: "555-1234" },
      { scope: "per-number", number: 123 }, { scope: "unknown" },
      { scope: "global", number: "+18645550100" }, { unexpected: true }, { patientReference: "bad" },
    ]) {
      const response = await request(fixture.base, "/communications/opt-out/record", "POST", { ...OPT_OUT_RECORD_BODY, ...invalid }, "staff");
      assert.equal(response.status, 400, JSON.stringify(invalid));
    }
    assert.equal(fixture.provenances.length, 0);
    assert.deepEqual(fixture.patients[0]!.extension, []);
  } finally { await fixture.close(); }
});

test("opt-out clear requires a non-empty reason and a named identity-verification method", async () => {
  const fixture = await startServer();
  try {
    for (const body of [
      { patientReference: PATIENT_REFERENCE, identityVerification: "in-person" },
      { patientReference: PATIENT_REFERENCE, reason: "", identityVerification: "in-person" },
      { patientReference: PATIENT_REFERENCE, reason: "   ", identityVerification: "in-person" },
      { patientReference: PATIENT_REFERENCE, reason: OPT_OUT_CLEAR_BODY.reason },
      { patientReference: PATIENT_REFERENCE, reason: OPT_OUT_CLEAR_BODY.reason, identityVerification: true },
      { patientReference: PATIENT_REFERENCE, reason: OPT_OUT_CLEAR_BODY.reason, identityVerification: "video-call" },
    ]) {
      const response = await request(fixture.base, "/communications/opt-out/clear", "POST", body, "staff");
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(fixture.provenances.length, 0);
    assert.equal(fixture.patients.every(hasSmsOptOut), true);
  } finally {
    await fixture.close();
  }
});

test("opt-out routes return the existing not-found shape for an unknown named Patient", async () => {
  const fixture = await startServer();
  try {
    const read = await request(
      fixture.base,
      "/communications/opt-out?patient=Patient/missing",
      "GET",
      undefined,
      "staff",
    );
    assert.equal(read.status, 404);
    assert.deepEqual(await read.json(), { error: "Patient not found." });

    const clear = await request(fixture.base, "/communications/opt-out/clear", "POST", {
      ...OPT_OUT_CLEAR_BODY,
      patientReference: "Patient/missing",
    }, "staff");
    assert.equal(clear.status, 404);
    assert.deepEqual(await clear.json(), { error: "Patient not found." });
  } finally {
    await fixture.close();
  }
});

test("clearing one named patient on a shared handset leaves the other patient suppressed", async () => {
  const fixture = await startServer({
    channelRoutes: {
      "transactional-sms": "twilio",
      "marketing-sms": "twilio",
      "clinical-sms": "twilio",
    },
    senderNumbers: {
      "transactional-sms": "+18645550100",
      "marketing-sms": "+18645550100",
      "clinical-sms": "+18485550100",
    },
  });
  try {
    const before = await request(
      fixture.base,
      `/communications/opt-out?patient=${PATIENT_REFERENCE}`,
      "GET",
      undefined,
      "staff",
    );
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), {
      patientReference: PATIENT_REFERENCE,
      smsOptedOut: true,
      remainingOptOuts: { global: true, numbers: [] },
      smsLanes: [
        {
          label: "Front-desk texts",
          number: "+18645550100",
          roles: ["transactional-sms", "marketing-sms"],
        },
        {
          label: "Clinical texts",
          number: "+18485550100",
          roles: ["clinical-sms"],
        },
      ],
    });

    const cleared = await request(fixture.base, "/communications/opt-out/clear", "POST", {
      ...OPT_OUT_CLEAR_BODY,
    }, "staff");
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), {
      patientReference: PATIENT_REFERENCE,
      smsOptedOut: false,
      cleared: true,
    });
    assert.equal(hasSmsOptOut(fixture.patients[1]!), true);
    assert.equal(hasSmsOptOut(fixture.patients[0]!), false);
    assert.equal(fixture.provenances.length, 1);
    assert.equal(fixture.provenances[0]?.agent[0]?.who.reference, "Practitioner/staff");
    assert.equal(fixture.provenances[0]?.reason?.[0]?.text, "Patient requested re-enrollment in person");
    assert.equal(
      fixture.provenances[0]?.entity?.[0]?.what.display,
      "Patient identity verification: in-person",
    );
    assert.deepEqual(fixture.attributedActors, [{
      actorReference: "Practitioner/staff",
      actorRole: "staff",
      policyUrl: "AccessPolicy/odos-staff",
      actionReason: "communications.optout.manage clear SMS opt-out",
    }]);
    assert.deepEqual(fixture.grants.map((row) => ({
      eventType: row.eventType,
      actorId: row.actorId,
      patientId: row.patientId,
      actionReason: row.actionReason,
    })), [
      {
        eventType: "read",
        actorId: "staff",
        patientId: "synthetic-1",
        actionReason: "communications-opt-out-read",
      },
      {
        eventType: "external-api-call",
        actorId: "staff",
        patientId: "synthetic-1",
        actionReason: "communications-opt-out-clear",
      },
    ]);
  } finally {
    await fixture.close();
  }
});

test("number-scoped clear reports a surviving legacy opt-out without a second Patient query", async () => {
  const fixture = await startServer();
  try {
    const response = await request(fixture.base, "/communications/opt-out/clear", "POST", {
      ...OPT_OUT_CLEAR_BODY,
      number: "+18485550100",
    }, "staff");

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      patientReference: PATIENT_REFERENCE,
      smsOptedOut: true,
      cleared: false,
      suppressionCleared: false,
      remainingOptOuts: { global: true, numbers: [] },
    });
    assert.equal(hasSmsOptOut(fixture.patients[0]!), true);
    assert.equal(fixture.provenances.length, 0);
  } finally {
    await fixture.close();
  }
});

test("opt-out clear uses the caller-bound FHIR client for the Patient write", async () => {
  const fixture = await startServer({ excludePatientWrite: true });
  try {
    const response = await request(
      fixture.base,
      "/communications/opt-out/clear",
      "POST",
      OPT_OUT_CLEAR_BODY,
      "staff",
    );

    assert.equal(response.status, 502);
    assert.equal(hasSmsOptOut(fixture.patients[0]!), true);
    assert.equal(fixture.provenances.length, 0);
  } finally {
    await fixture.close();
  }
});

test("opt-out state uses the caller-bound FHIR client for the Patient read", async () => {
  const fixture = await startServer({ excludePatientRead: true });
  try {
    const response = await request(
      fixture.base,
      `/communications/opt-out?patient=${PATIENT_REFERENCE}`,
      "GET",
      undefined,
      "staff",
    );

    assert.equal(response.status, 502);
  } finally {
    await fixture.close();
  }
});

test("a bearer-authenticated staff membership reaches the opt-out clear through the real role resolver", async () => {
  const fixture = await startServer({ resolvedStaffAuthentication: true });
  try {
    const response = await fetch(`${fixture.base}/communications/opt-out/clear`, {
      method: "POST",
      headers: {
        authorization: "Bearer logged-in-staff-token",
        "content-type": "application/json",
        "x-odos-actor-id": "real-staff",
        "x-odos-actor-role": "staff",
      },
      body: JSON.stringify(OPT_OUT_CLEAR_BODY),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      patientReference: PATIENT_REFERENCE,
      smsOptedOut: false,
      cleared: true,
    });
    assert.equal(fixture.grants[0]?.actorId, "real-staff");
    assert.equal(fixture.grants[0]?.actorRole, "staff");
    assert.equal(fixture.provenances[0]?.agent[0]?.who.reference, "Practitioner/real-staff");
  } finally {
    await fixture.close();
  }
});

test("a per-person revocation overrides the staff role on communications routes", async () => {
  const fixture = await startServer({ businessActions: [] });
  try {
    const response = await request(fixture.base, "/communications/education", "GET", undefined, "staff");
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "communications.read role required" });
  } finally {
    await fixture.close();
  }
});

test("conversation reads use caller-bound FHIR and expose bodies to front desk and clinical content roles", async () => {
  const fixture = await startServer();
  try {
    const desk = await request(fixture.base, "/communications/conversations?patient_id=synthetic-1&limit=10", "GET", undefined, "staff");
    assert.equal(desk.status, 200);
    const deskBody = await desk.json() as { conversations: ConversationSummary[] };
    assert.equal(deskBody.conversations[0].messageCount, 1);
    assert.equal(deskBody.conversations[0].messages[0].body, "Synthetic scheduling content");

    const clinician = await request(fixture.base, "/communications/conversations?patient_id=synthetic-1&limit=10", "GET", undefined, "provider");
    assert.equal(clinician.status, 200);
    const clinicianBody = await clinician.json() as { conversations: ConversationSummary[] };
    assert.equal(clinicianBody.conversations[0].messages[0].body, "Synthetic scheduling content");
    assert.deepEqual(fixture.listRequests.map((entry) => entry.includeContent), [true, true]);
    assert.equal(fixture.adapterFhirs.length, 2);
    assert.equal(fixture.authenticatedFhirs.length, 2);
    assert.notEqual(fixture.authenticatedFhirs[0], fixture.authenticatedFhirs[1]);
    assert.equal(fixture.adapterFhirs.every((fhir, index) => fhir === fixture.authenticatedFhirs[index]), true);
  } finally {
    await fixture.close();
  }
});

test("a front-desk GHL thread read is on-demand and never runs for the conversation list", async () => {
  const fixture = await startServer({ providerName: "ghl" });
  try {
    const list = await request(fixture.base, "/communications/conversations?patient_id=synthetic-1", "GET", undefined, "staff");
    assert.equal(list.status, 200);
    assert.deepEqual(fixture.threadReadRequests, []);

    const desk = await request(
      fixture.base,
      "/communications/conversations?patient_id=synthetic-1&conversation_id=conversation-synthetic-1",
      "GET",
      undefined,
      "staff",
    );
    assert.equal(desk.status, 200);
    const body = await desk.json() as { conversations: ConversationSummary[] };
    assert.deepEqual(body.conversations[0].messages, [{
      id: "ghl-thread-message-1",
      direction: "inbound",
      status: "delivered",
      occurredAt: "2026-08-03T13:00:00.000Z",
      body: "Synthetic GHL thread content",
    }]);
    assert.deepEqual(fixture.threadReadRequests, [{
      conversationId: "conversation-synthetic-1",
      includeContent: true,
    }]);
  } finally {
    await fixture.close();
  }
});

test("the API content gate strips previews and bodies and skips thread hydration without content.read", async () => {
  const frontDesk = getRoleDeclaration("staff");
  const contentActionIndex = frontDesk.businessActions.indexOf("communications.content.read");
  assert.notEqual(contentActionIndex, -1);
  frontDesk.businessActions.splice(contentActionIndex, 1);
  try {
    const fixture = await startServer({
      providers: ["twilio", "ghl"],
      channelRoutes: { voice: "twilio", "transactional-sms": "ghl" },
      conversationRows: {
        twilio: [{
          id: "conversation-synthetic-1",
          preview: "Synthetic Twilio preview",
          messages: [{ id: "twilio-message-1", direction: "inbound", status: "completed", body: "Synthetic Twilio body" }],
        }],
        ghl: [{
          id: "conversation-synthetic-2",
          preview: "Synthetic GHL preview",
          messages: [{ id: "ghl-message-1", direction: "inbound", status: "delivered", body: "Synthetic GHL body" }],
        }],
      },
    });
    try {
      const response = await request(
        fixture.base,
        "/communications/conversations?conversation_id=conversation-synthetic-1",
        "GET",
        undefined,
        "staff",
      );
      assert.equal(response.status, 200);
      const body = await response.json() as { conversations: ConversationSummary[] };
      assert.equal(body.conversations.length, 2);
      assert.equal(body.conversations.every((conversation) => conversation.preview === undefined), true);
      assert.equal(body.conversations.every((conversation) =>
        conversation.messages.every((message) => message.body === undefined)), true);
      assert.deepEqual(fixture.listRequests.map((entry) => entry.includeContent), [false, false]);
      assert.deepEqual(fixture.listProviderCalls, ["twilio", "ghl"]);
      assert.deepEqual(fixture.threadReadRequests, []);
    } finally {
      await fixture.close();
    }
  } finally {
    frontDesk.businessActions.splice(contentActionIndex, 0, "communications.content.read");
  }
});

test("conversation listing merges distinct routed providers, sorts globally, tags rows, and limits after merge", async () => {
  const fixture = await startServer({
    providers: ["twilio", "ghl"],
    channelRoutes: {
      voice: "twilio",
      "transactional-sms": "ghl",
      "marketing-sms": "ghl",
      email: "twilio",
    },
    conversationRows: {
      twilio: [{
        id: "twilio-newest",
        patientReference: PATIENT_REFERENCE,
        updatedAt: "2026-08-03T15:00:00.000Z",
        unreadCount: 1,
        messages: [{ id: "twilio-message", direction: "inbound", status: "completed" }],
      }, {
        id: "twilio-without-date",
        patientReference: PATIENT_REFERENCE,
        messages: [],
      }],
      ghl: [{
        id: "ghl-middle",
        patientReference: PATIENT_REFERENCE,
        updatedAt: "2026-08-03T14:00:00.000Z",
        unreadCount: 2,
        messages: [{ id: "ghl-message", direction: "outbound", status: "delivered" }],
      }, {
        id: "ghl-oldest-dated",
        patientReference: PATIENT_REFERENCE,
        updatedAt: "2026-08-03T13:00:00.000Z",
        messages: [],
      }],
    },
  });
  try {
    const response = await request(fixture.base, "/communications/conversations?limit=4", "GET", undefined, "staff");
    assert.equal(response.status, 200);
    const body = await response.json() as {
      conversations: ConversationSummary[];
      providerErrors: unknown[];
    };
    assert.deepEqual(body.conversations.map(({ id, provider }) => ({ id, provider })), [
      { id: "twilio-newest", provider: "twilio" },
      { id: "ghl-middle", provider: "ghl" },
      { id: "ghl-oldest-dated", provider: "ghl" },
      { id: "twilio-without-date", provider: "twilio" },
    ]);
    assert.equal(body.conversations.every((conversation) =>
      conversation.patientReference === PATIENT_REFERENCE), true);
    assert.deepEqual(body.providerErrors, []);
    assert.deepEqual(fixture.listProviderCalls, ["twilio", "ghl"]);
    assert.deepEqual(fixture.listRequests.map(({ limit }) => limit), [100, 100]);

    const limited = await request(fixture.base, "/communications/conversations?limit=2", "GET", undefined, "staff");
    assert.equal(limited.status, 200);
    assert.deepEqual((await limited.json() as { conversations: ConversationSummary[] }).conversations
      .map(({ id, provider }) => ({ id, provider })), [
      { id: "twilio-newest", provider: "twilio" },
      { id: "ghl-middle", provider: "ghl" },
    ]);
    assert.deepEqual(fixture.listProviderCalls, ["twilio", "ghl", "twilio", "ghl"]);
  } finally {
    await fixture.close();
  }
});

test("a failed provider degrades to non-PHI status while successful conversations remain", async () => {
  const fixture = await startServer({
    providers: ["twilio", "ghl"],
    channelRoutes: { voice: "twilio", "transactional-sms": "ghl" },
    conversationFailures: ["ghl"],
    conversationRows: {
      twilio: [{ id: "twilio-survivor", updatedAt: "2026-08-03T15:00:00.000Z", messages: [] }],
    },
  });
  try {
    const response = await request(fixture.base, "/communications/conversations", "GET", undefined, "staff");
    assert.equal(response.status, 200);
    const responseText = await response.text();
    assert.equal(responseText.includes("+18645550199"), false);
    const body = JSON.parse(responseText) as {
      conversations: ConversationSummary[];
      providerErrors: Array<{ provider: string; code: string }>;
    };
    assert.deepEqual(body.conversations.map(({ id, provider }) => ({ id, provider })), [
      { id: "twilio-survivor", provider: "twilio" },
    ]);
    assert.deepEqual(body.providerErrors, [{ provider: "ghl", code: "conversation-list-unavailable" }]);
    assert.deepEqual(fixture.listProviderCalls, ["twilio", "ghl"]);

    const unresolved = await request(
      fixture.base,
      "/communications/conversations?conversation_id=ghl-unavailable-thread",
      "GET",
      undefined,
      "staff",
    );
    assert.equal(unresolved.status, 200);
    const unresolvedBody = await unresolved.json() as {
      conversations: ConversationSummary[];
      providerErrors: Array<{ provider: string; code: string }>;
    };
    assert.deepEqual(unresolvedBody.conversations.map(({ id, provider }) => ({ id, provider })), [
      { id: "twilio-survivor", provider: "twilio" },
    ]);
    assert.deepEqual(unresolvedBody.providerErrors, [{ provider: "ghl", code: "conversation-list-unavailable" }]);
    assert.deepEqual(fixture.threadReadRequests, []);
  } finally {
    await fixture.close();
  }
});

test("a routed provider without conversation-list capability is skipped without an error", async () => {
  const fixture = await startServer({
    providers: ["twilio", "email-only"],
    channelRoutes: { "transactional-sms": "twilio", email: "email-only" },
    conversationUnsupported: ["email-only"],
    conversationRows: {
      twilio: [{ id: "twilio-only", messages: [] }],
    },
  });
  try {
    const response = await request(fixture.base, "/communications/conversations", "GET", undefined, "staff");
    assert.equal(response.status, 200);
    const body = await response.json() as {
      conversations: ConversationSummary[];
      providerErrors: unknown[];
    };
    assert.deepEqual(body.conversations.map(({ id, provider }) => ({ id, provider })), [
      { id: "twilio-only", provider: "twilio" },
    ]);
    assert.deepEqual(body.providerErrors, []);
    assert.deepEqual(fixture.listProviderCalls, ["twilio"]);
  } finally {
    await fixture.close();
  }
});

test("thread hydration resolves the owning provider before limiting and unresolvable ids return 404", async () => {
  const fixture = await startServer({
    providers: ["twilio", "ghl"],
    channelRoutes: { voice: "twilio", "transactional-sms": "ghl" },
    conversationRows: {
      twilio: [{ id: "newer-thread", updatedAt: "2026-08-03T15:00:00.000Z", messages: [] }],
      ghl: [{ id: "requested-older-thread", updatedAt: "2026-08-03T13:00:00.000Z", messages: [] }],
    },
  });
  try {
    const hydrated = await request(
      fixture.base,
      "/communications/conversations?limit=1&conversation_id=requested-older-thread",
      "GET",
      undefined,
      "staff",
    );
    assert.equal(hydrated.status, 200);
    const hydratedBody = await hydrated.json() as { conversations: ConversationSummary[] };
    assert.equal(hydratedBody.conversations.length, 1);
    assert.equal(hydratedBody.conversations[0].id, "requested-older-thread");
    assert.equal(hydratedBody.conversations[0].provider, "ghl");
    assert.equal(hydratedBody.conversations[0].messages[0].body, "Synthetic GHL thread content");
    assert.deepEqual(fixture.threadAdapterProviders, ["ghl"]);

    const missing = await request(
      fixture.base,
      "/communications/conversations?limit=1&conversation_id=missing-thread",
      "GET",
      undefined,
      "staff",
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Conversation not found." });
    assert.deepEqual(fixture.threadAdapterProviders, ["ghl"]);
  } finally {
    await fixture.close();
  }
});

test("an explicit provider query keeps conversation listing on that one provider", async () => {
  const fixture = await startServer({
    providers: ["twilio", "ghl"],
    channelRoutes: { voice: "twilio", "transactional-sms": "ghl" },
    conversationRows: {
      twilio: [{ id: "twilio-thread", messages: [] }],
      ghl: [{ id: "ghl-thread", messages: [] }],
    },
  });
  try {
    const response = await request(
      fixture.base,
      "/communications/conversations?provider=ghl",
      "GET",
      undefined,
      "staff",
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { conversations: ConversationSummary[] };
    assert.deepEqual(body.conversations.map(({ id, provider }) => ({ id, provider })), [
      { id: "ghl-thread", provider: "ghl" },
    ]);
    assert.deepEqual(fixture.listProviderCalls, ["ghl"]);
  } finally {
    await fixture.close();
  }
});

test("front-desk SMS succeeds and reaches a durable sent reservation", async () => {
  const fixture = await startServer();
  try {
    const messageRequest = {
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic staff message",
      idempotencyKey: "synthetic-send-0001",
    };
    const sent = await request(fixture.base, "/communications/messages", "POST", messageRequest, "staff");
    assert.equal(sent.status, 200);
    assert.deepEqual(await sent.json(), { outcome: "sent", providerMessageId: "SM-synthetic" });
    assert.deepEqual(fixture.providerCalls, ["sendSms"]);
    assert.equal(fixture.persistedCommunications.length, 1);
    assert.equal(fixture.persistedCommunications[0].status, "in-progress");
    assert.equal(fixture.persistedCommunications[0].subject?.reference, PATIENT_REFERENCE);
    assert.equal(fixture.persistedCommunications[0].sender?.reference, "Practitioner/staff");
    assert.equal(fixture.persistedCommunications[0].recipient?.[0].reference, PATIENT_REFERENCE);
    assert.equal(fixture.persistedCommunications[0].sent, "2026-08-02T15:00:00.000Z");
    assert.equal(fixture.persistedCommunications[0].payload?.[0].contentString, "Synthetic staff message");
    assert.match(JSON.stringify(fixture.persistedCommunications[0].identifier), /SM-synthetic/);
    const retry = await request(fixture.base, "/communications/messages", "POST", messageRequest, "staff");
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { outcome: "sent", providerMessageId: "SM-synthetic" });
    assert.deepEqual(fixture.providerCalls, ["sendSms"]);

    const calls = await request(fixture.base, "/communications/calls?limit=12", "GET", undefined, "staff");
    assert.equal(calls.status, 200);
    assert.equal((await calls.json() as { calls: unknown[] }).calls.length, 1);

    const call = await request(fixture.base, `/communications/calls/${CALL_ID}`, "GET", undefined, "staff");
    assert.equal(call.status, 200);
    assert.equal((await call.json() as { call: { id: string } }).call.id, CALL_ID);

    const initiated = await request(fixture.base, "/communications/calls", "POST", {
      patientReference: PATIENT_REFERENCE,
    }, "staff");
    assert.equal(initiated.status, 201);
    assert.deepEqual(await initiated.json(), { callId: CALL_ID });

    const recording = await request(fixture.base, `/communications/recordings/${RECORDING_ID}`, "GET", undefined, "provider");
    assert.equal(recording.status, 200);
    assert.equal(recording.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual([...new Uint8Array(await recording.arrayBuffer())], [1, 2, 3]);

    assert.equal(fixture.grants.length, 6);
    assert.equal(fixture.grants.every((row) => row.actionOutcome === "granted"), true);
    assert.deepEqual(fixture.providerCalls, ["sendSms", "listCalls", "getCall", "initiateCall", "fetchRecording"]);
  } finally {
    await fixture.close();
  }
});

test("staff SMS requires a stable idempotency key and retries never dispatch twice", async () => {
  const fixture = await startServer();
  const body = {
    patientReference: PATIENT_REFERENCE,
    body: "Synthetic idempotent message",
    idempotencyKey: "synthetic-send-0002",
  };
  try {
    const missing = await request(fixture.base, "/communications/messages", "POST", {
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic idempotent message",
    }, "staff");
    assert.equal(missing.status, 400);

    const first = await request(fixture.base, "/communications/messages", "POST", body, "staff");
    const retry = await request(fixture.base, "/communications/messages", "POST", body, "staff");
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { outcome: "sent", providerMessageId: "SM-synthetic" });
    assert.deepEqual(fixture.providerCalls, ["sendSms"]);
    assert.equal(fixture.persistedCommunications.length, 1);
  } finally {
    await fixture.close();
  }
});

test("staff SMS persists the selected provider message identifier", async () => {
  const fixture = await startServer({ providerName: "ghl" });
  try {
    const sent = await request(fixture.base, "/communications/messages", "POST", {
      provider: "ghl",
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic GHL staff message",
      idempotencyKey: "synthetic-ghl-send-0001",
    }, "staff");
    assert.equal(sent.status, 200);
    assert.equal(fixture.persistedCommunications[0].identifier?.some((identifier) =>
      identifier.system === "https://odos2020.com/fhir/NamingSystem/ghl-message-id"
      && identifier.value === "SM-synthetic"), true);
    assert.equal(fixture.persistedCommunications[0].identifier?.some((identifier) =>
      identifier.system === "https://odos2020.com/fhir/NamingSystem/twilio-message-sid"), false);
    assert.equal(fixture.persistedCommunications[0].status, "completed");
  } finally {
    await fixture.close();
  }
});

test("new SMS uses transactional routing while a reply preserves its explicit thread provider", async () => {
  const fixture = await startServer({
    providers: ["twilio", "ghl"],
    channelRoutes: { voice: "twilio", "transactional-sms": "ghl" },
  });
  try {
    const first = await request(fixture.base, "/communications/messages", "POST", {
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic new conversation",
      idempotencyKey: "synthetic-route-new-0001",
    }, "staff");
    assert.equal(first.status, 200);

    const reply = await request(fixture.base, "/communications/messages", "POST", {
      provider: "twilio",
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic thread reply",
      idempotencyKey: "synthetic-route-reply-0001",
    }, "staff");
    assert.equal(reply.status, 200);

    const calls = await request(fixture.base, "/communications/calls?limit=1", "GET", undefined, "staff");
    assert.equal(calls.status, 200);
    assert.deepEqual(fixture.adapterProviders, ["ghl", "twilio", "twilio"]);
  } finally {
    await fixture.close();
  }
});

test("an explicit provider is rejected when it cannot identify one sender lane", async () => {
  const fixture = await startServer({
    providers: ["twilio"],
    channelRoutes: {
      "transactional-sms": "twilio",
      "marketing-sms": "twilio",
      "clinical-sms": "twilio",
    },
    senderNumbers: {
      "transactional-sms": "+18645550100",
      "marketing-sms": "+18645550100",
      "clinical-sms": "+18485550100",
    },
  });
  try {
    const response = await request(fixture.base, "/communications/messages", "POST", {
      provider: "twilio",
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic ambiguous reply",
      idempotencyKey: "synthetic-route-ambiguous-0001",
    }, "staff");

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Communications provider \"twilio\" has multiple SMS sender lanes; the request must identify one lane.",
    });
    assert.deepEqual(fixture.adapterProviders, []);
  } finally {
    await fixture.close();
  }
});

test("an unassigned channel role is reported as unavailable without resolving an adapter", async () => {
  const fixture = await startServer({ providers: ["twilio"], channelRoutes: {} });
  try {
    const response = await request(fixture.base, "/communications/messages", "POST", {
      patientReference: PATIENT_REFERENCE,
      body: "Synthetic unavailable route",
      idempotencyKey: "synthetic-route-none-0001",
    }, "staff");
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'Communications role "transactional-sms" is not configured for this practice.',
    });
    assert.deepEqual(fixture.adapterProviders, []);
  } finally {
    await fixture.close();
  }
});

test("a post-send FHIR failure leaves a durable unknown outcome and blocks duplicate dispatch", async () => {
  const fixture = await startServer({ failSmsCompletion: true });
  const body = {
    patientReference: PATIENT_REFERENCE,
    body: "Synthetic uncertain message",
    idempotencyKey: "synthetic-send-0003",
  };
  try {
    const first = await request(fixture.base, "/communications/messages", "POST", body, "staff");
    assert.equal(first.status, 502);
    const retry = await request(fixture.base, "/communications/messages", "POST", body, "staff");
    assert.equal(retry.status, 409);
    assert.deepEqual(fixture.providerCalls, ["sendSms"]);
  } finally {
    await fixture.close();
  }
});

test("recording retrieval degrades cleanly when media authentication is not acknowledged", async () => {
  const fixture = await startServer({ recordingEnabled: false });
  try {
    const response = await request(fixture.base, `/communications/recordings/${RECORDING_ID}`, "GET", undefined, "provider");
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Recording retrieval is not enabled for this communications provider." });
  } finally {
    await fixture.close();
  }
});

test("recording retrieval requires a persisted call visible to the caller's FHIR policy", async () => {
  const fixture = await startServer({ recordingVisible: false });
  try {
    const response = await request(fixture.base, `/communications/recordings/${RECORDING_ID}`, "GET", undefined, "provider");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Recording not found." });
    assert.deepEqual(fixture.providerCalls, []);
    assert.equal(fixture.grants.length, 0);
    assert.equal(fixture.denials.length, 1);
    assert.equal(fixture.denials[0].actionOutcome, "denied");
    assert.equal(fixture.denials[0].eventType, "read");
  } finally {
    await fixture.close();
  }
});

test("call history and detail require persisted calls visible to the caller's FHIR policy", async () => {
  const fixture = await startServer({ callVisible: false });
  try {
    const list = await request(fixture.base, "/communications/calls?limit=12", "GET", undefined, "provider");
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { calls: [] });

    const detail = await request(fixture.base, `/communications/calls/${CALL_ID}`, "GET", undefined, "provider");
    assert.equal(detail.status, 404);
    assert.deepEqual(await detail.json(), { error: "Call not found." });
    assert.deepEqual(fixture.providerCalls, []);
  } finally {
    await fixture.close();
  }
});

test("call history applies the requested limit after filtering the provider window by visible calls", async () => {
  const fixture = await startServer();
  try {
    const response = await request(fixture.base, "/communications/calls?limit=1", "GET", undefined, "provider");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { calls: Array<{ id: string }> }).calls.map((call) => call.id), [CALL_ID]);
    assert.deepEqual(fixture.callListRequests, [{ limit: 1_000 }]);
  } finally {
    await fixture.close();
  }
});

const CONFLICT_MESSAGE = "This patient's record changed while you were working. Reload and try again.";

async function fhirWriterError(status: 412 | 500, method: "POST" | "PUT" = "POST"): Promise<Error> {
  const app = express();
  app.use((_req, res) => res.status(status).send("Synthetic write failure"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const fhir = createOperatorScriptFhirClient({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    reason: "Synthetic conflict fixture through the real FHIR writer",
  });
  try {
    let failure: unknown;
    try {
      if (method === "POST") await fhir.executeTransaction({ resourceType: "Bundle", type: "transaction", entry: [] });
      else await fhir.update("Patient", "synthetic-1", { resourceType: "Patient", id: "synthetic-1" });
    } catch (error) { failure = error; }
    assert.ok(failure instanceof Error);
    const path = method === "POST" ? "/fhir/R4 [Bundle]" : "/fhir/R4/Patient/:id [Patient]";
    assert.equal(failure.message, `FHIR ${method} ${path} ${status} ${status === 412 ? "Precondition Failed" : "Internal Server Error"}: Synthetic write failure`);
    assert.equal((failure as Error & { status: number }).status, status);
    assert.doesNotMatch(failure.message, /FHIR (409|412)\b/);
    return failure;
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

for (const action of ["record", "clear"] as const) {
  for (const shape of ["toError", "transaction-entry"] as const) {
    test(`conflict mapping: ${action} ${shape} returns 409 without Patient or Provenance writes`, async () => {
      const fixture = await startServer(shape === "toError"
        ? { optOutTransactionError: await fhirWriterError(412) }
        : { optOutTransactionResponse: {
          resourceType: "Bundle", type: "transaction-response",
          entry: [{ response: { status: "412 Precondition Failed" } }, { response: { status: "424 Failed Dependency" } }],
        } });
      if (action === "record") fixture.patients[0]!.extension = [];
      const before = structuredClone(fixture.patients);
      try {
        const response = await request(fixture.base, `/communications/opt-out/${action}`, "POST",
          action === "record" ? OPT_OUT_RECORD_BODY : OPT_OUT_CLEAR_BODY, "staff");
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: CONFLICT_MESSAGE });
        assert.deepEqual(fixture.patients, before);
        assert.deepEqual(fixture.provenances, []);
        assert.equal(fixture.attributedActors.length, 1);
      } finally { await fixture.close(); }
    });
  }
}

test("conflict mapping: toError 500 remains 502", async () => {
  const fixture = await startServer({ optOutTransactionError: await fhirWriterError(500) });
  fixture.patients[0]!.extension = [];
  const before = structuredClone(fixture.patients);
  try {
    const response = await request(fixture.base, "/communications/opt-out/record", "POST", OPT_OUT_RECORD_BODY, "staff");
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Patient communications service failed." });
    assert.deepEqual(fixture.patients, before);
    assert.deepEqual(fixture.provenances, []);
  } finally { await fixture.close(); }
});

for (const malformed of [
  { resourceType: "Bundle", type: "batch-response", entry: [] },
  { resourceType: "Bundle", type: "transaction-response", entry: [] },
] as Bundle[]) {
  test(`conflict mapping: malformed ${malformed.type} remains 502`, async () => {
    const fixture = await startServer({ optOutTransactionResponse: malformed });
    fixture.patients[0]!.extension = [];
    const before = structuredClone(fixture.patients);
    try {
      const response = await request(fixture.base, "/communications/opt-out/record", "POST", OPT_OUT_RECORD_BODY, "staff");
      assert.equal(response.status, 502);
      assert.deepEqual(fixture.patients, before);
      assert.deepEqual(fixture.provenances, []);
    } finally { await fixture.close(); }
  });
}

for (const channel of ["sms", "email"] as const) {
  test(`post-send recipient conflict: ${channel} remains sent with provenance`, async () => {
    const fixture = await startServer({
      channelRoutes: { "clinical-sms": "twilio", email: "twilio" },
      senderNumbers: { "clinical-sms": "+18485550100" },
      recipientUpdateError: await fhirWriterError(412, "PUT"),
    });
    const before = structuredClone(fixture.patients);
    try {
      const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
        patientReference: PATIENT_REFERENCE, educationId: "dry-eye-basics", version: 2,
        channel, lane: "clinical", recipientOverride: channel === "sms"
          ? { phone: "+18645550177" } : { email: "changed@example.test" },
        alsoUpdateChart: true, idempotencyKey: `education-recipient-conflict-${channel}`,
      }, "staff");
      assert.equal(response.status, 200);
      const result = await response.json() as Record<string, unknown>;
      assert.equal(result.outcome, "sent");
      assert.equal(result.chartUpdate, "conflict");
      assert.deepEqual(fixture.patients, before);
      assert.deepEqual(fixture.recipientUpdates, []);
      assert.equal(fixture.smsRequests.length + fixture.emailRequests.length, 1);
      assert.equal(fixture.provenances.length, 1);
      assert.doesNotMatch(JSON.stringify(fixture.provenances), /Recipient override also updated chart/);
    } finally { await fixture.close(); }
  });
}

test("print chart update refuses before provenance or output", async () => {
  const fixture = await startServer();
  const before = structuredClone(fixture.patients);
  try {
    const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
      patientReference: PATIENT_REFERENCE, educationId: "dry-eye-home-care", version: 1,
      channel: "print", lane: "clinical", alsoUpdateChart: true,
      recipientOverride: { email: "changed@example.test" }, idempotencyKey: "print-chart-refusal",
    }, "staff");
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "alsoUpdateChart requires a phone or email recipient override." });
    assert.deepEqual(fixture.provenances, []);
    assert.deepEqual(fixture.recipientUpdates, []);
    assert.deepEqual(fixture.persistedCommunications, []);
    assert.deepEqual(fixture.patients, before);
  } finally { await fixture.close(); }
});

for (const channel of ["compose", "sms", "email"] as const) {
  test(`post-send persistence conflict: ${channel} remains 502`, async () => {
    const fixture = await startServer({
      channelRoutes: { "clinical-sms": "twilio", "transactional-sms": "twilio", email: "twilio" },
      senderNumbers: { "clinical-sms": "+18485550100", "transactional-sms": "+18485550100" },
      completionError: await fhirWriterError(412, "PUT"),
    });
    try {
      const response = await request(fixture.base, channel === "compose" ? "/communications/messages" : "/communications/education/dispatch", "POST", channel === "compose" ? {
        patientReference: PATIENT_REFERENCE, body: "Synthetic message", idempotencyKey: "completion-conflict-compose",
      } : {
        patientReference: PATIENT_REFERENCE, educationId: "dry-eye-basics", version: 2,
        channel, lane: "clinical", idempotencyKey: `completion-conflict-${channel}`,
      }, "staff");
      assert.equal(response.status, 502);
      assert.equal(fixture.smsRequests.length + fixture.emailRequests.length, 1);
    } finally { await fixture.close(); }
  });
}
for (const channel of ["sms", "email"] as const) {
  test(`post-send provenance conflict: ${channel} remains 502`, async () => {
    const fixture = await startServer({
      channelRoutes: { "clinical-sms": "twilio", "transactional-sms": "twilio", email: "twilio" },
      senderNumbers: { "clinical-sms": "+18485550100", "transactional-sms": "+18485550100" },
      provenanceError: await fhirWriterError(412, "PUT"),
    });
    try {
      const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
        patientReference: PATIENT_REFERENCE, educationId: "dry-eye-basics", version: 2,
        channel, lane: "clinical", idempotencyKey: `completion-conflict-${channel}`,
      }, "staff");
      assert.equal(response.status, 502);
      assert.equal(fixture.smsRequests.length + fixture.emailRequests.length, 1);
    } finally { await fixture.close(); }
  });
}

async function startServer(options: {
  optOutTransactionError?: Error;
  optOutTransactionResponse?: Bundle;
  recipientUpdateError?: Error;
  completionError?: Error;
  provenanceError?: Error;
  recordingEnabled?: boolean;
  recordingVisible?: boolean;
  callVisible?: boolean;
  failSmsCompletion?: boolean;
  providerName?: "twilio" | "ghl";
  providers?: string[];
  channelRoutes?: Partial<Record<"voice" | "transactional-sms" | "marketing-sms" | "clinical-sms" | "email", string>>;
  senderNumbers?: Partial<Record<"transactional-sms" | "marketing-sms" | "clinical-sms", string>>;
  conversationRows?: Record<string, ConversationSummary[]>;
  conversationFailures?: string[];
  conversationUnsupported?: string[];
  resolvedStaffAuthentication?: boolean;
  businessActions?: readonly import("../src/authz/roles.js").BusinessAction[];
  roles?: readonly (typeof PRACTICE_ROLE_IDS)[number][];
  membershipReference?: string;
  excludePatientRead?: boolean;
  excludePatientWrite?: boolean;
  chartDispatchLane?: "locked_clinical" | "staff_switchable";
  publicBaseUrl?: string;
  smsResult?: SendResult;
  smsError?: Error;
  marketingConsent?: boolean;
} = {}) {
  const providerCalls: string[] = [];
  const smsRequests: SendSmsRequest[] = [];
  const emailRequests: SendEmailRequest[] = [];
  const trackedLinks: Array<{
    token: string;
    targetUrl: string;
    campaignId: string;
    messageId: string;
    createdAt: string;
  }> = [];
  const adapterProviders: string[] = [];
  const callListRequests: Array<{ limit?: number }> = [];
  const listRequests: Array<{ provider: string; limit?: number; includeContent?: boolean }> = [];
  const listProviderCalls: string[] = [];
  const threadReadRequests: Array<{ conversationId: string; includeContent?: boolean }> = [];
  const threadAdapterProviders: string[] = [];
  const grants: OdosAuditEventRecord[] = [];
  const denials: OdosAuditEventRecord[] = [];
  const persistedCommunications: Communication[] = [];
  const patients: Patient[] = ["synthetic-1", "synthetic-2"].map((id) => ({
    resourceType: "Patient",
    id,
    meta: { versionId: "1" },
    telecom: [
      { system: "phone", value: "+18645550199" },
      { system: "email", value: "patient@example.test" },
    ],
    extension: [
      {
        url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
        extension: [{ url: "channel", valueCode: "sms" }],
      },
      ...(options.marketingConsent && id === "synthetic-1" ? [{
        url: ODOS_COMMS_MARKETING_CONSENT_EXTENSION_URL,
        extension: [
          { url: "consent", valueBoolean: true },
          { url: "recorded", valueDateTime: "2026-08-02T14:00:00.000Z" },
        ],
      }] : []),
    ],
  }));
  const encounters: Encounter[] = [
    { resourceType: "Encounter", id: "encounter-1", status: "in-progress", class: { code: "AMB" }, subject: { reference: PATIENT_REFERENCE } },
    { resourceType: "Encounter", id: "encounter-other", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/synthetic-2" } },
  ];
  const conditions: Condition[] = [
    { resourceType: "Condition", id: "condition-1", subject: { reference: PATIENT_REFERENCE } },
    { resourceType: "Condition", id: "condition-other", subject: { reference: "Patient/synthetic-2" } },
  ];
  const provenances: Provenance[] = [];
  const recipientUpdates: Resource[] = [];
  const attributedActors: Array<{
    actorReference: string;
    actorRole: string;
    actionReason: string;
    policyUrl?: string;
  }> = [];
  const authenticatedFhirs: unknown[] = [];
  const adapterFhirs: unknown[] = [];
  const conversation: ConversationSummary = {
    id: "conversation-synthetic-1",
    patientReference: PATIENT_REFERENCE,
    updatedAt: "2026-08-02T15:00:00.000Z",
    messageCount: 1,
    preview: "Synthetic scheduling preview",
    messages: [{
      id: "comm-1",
      direction: "inbound",
      status: "completed",
      occurredAt: "2026-08-02T15:00:00.000Z",
      from: "+18645550199",
      to: "+18645550100",
      body: "Synthetic scheduling content",
    }],
  };
  const provider: CommsProvider = {
    name: options.providerName ?? "twilio",
    messageIdentifierSystem: options.providerName === "ghl"
      ? "https://odos2020.com/fhir/NamingSystem/ghl-message-id"
      : "https://odos2020.com/fhir/NamingSystem/twilio-message-sid",
    capabilities: { sms: true, calls: true, email: true, contacts: false, conversations: true, reviews: false },
    async sendSms(request) {
      providerCalls.push("sendSms");
      smsRequests.push(structuredClone(request));
      if (options.smsError) throw options.smsError;
      return options.smsResult ?? { outcome: "sent", providerMessageId: "SM-synthetic" };
    },
    async sendEmail(request) {
      providerCalls.push("sendEmail");
      emailRequests.push(structuredClone(request));
      return { outcome: "sent", providerMessageId: "EM-synthetic" };
    },
    async listCalls(request = {}) {
      providerCalls.push("listCalls");
      callListRequests.push(request);
      return [
        { id: OTHER_CALL_ID, from: "+18645550198", to: "+18645550100", status: "completed", direction: "inbound" as const },
        { id: CALL_ID, from: "+18645550199", to: "+18645550100", status: "completed", direction: "inbound" as const },
      ].slice(0, request.limit);
    },
    async getCall(id) {
      providerCalls.push("getCall");
      return { id, from: "+18645550199", to: "+18645550100", status: "completed", direction: "inbound" };
    },
    async initiateCall() {
      providerCalls.push("initiateCall");
      return { callId: CALL_ID };
    },
    ...(options.recordingEnabled === false ? {} : {
      async fetchRecording() {
        providerCalls.push("fetchRecording");
        return { id: RECORDING_ID, callId: CALL_ID, status: "completed", contentType: "audio/mpeg", audio: Uint8Array.from([1, 2, 3]) };
      },
    }),
  };
  const audit: CommsApiRouteDeps["audit"] = {
    async record(row, operation) {
      const result = await operation();
      grants.push(row);
      return result;
    },
    async recordDenied(row) {
      denials.push(row);
    },
  };
  const serviceFhir = {
    async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
      if (resourceType === "Patient") {
        return {
          resourceType: "Bundle",
          type: "searchset",
          entry: patients.map((patient) => ({ resource: structuredClone(patient) as T })),
        };
      }
      if (resourceType !== "ProjectMembership") {
        throw new Error(`Unexpected service FHIR search for ${resourceType}.`);
      }
      const membership: ProjectMembership = {
        resourceType: "ProjectMembership",
        id: "membership-staff",
        user: { reference: "User/real-staff" },
        profile: { reference: "Practitioner/real-staff" },
        project: { reference: "Project/practice-one" },
        access: [{ policy: { reference: "AccessPolicy/odos-staff" } }],
      };
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: membership as T }],
      };
    },
    async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
      if (resourceType === "AccessPolicy" && id === "odos-staff") {
        return {
          resourceType: "AccessPolicy",
          id,
          meta: { tag: [{ system: ODOS_PRACTICE_ROLE_SYSTEM, code: "staff" }] },
        } as T;
      }
      if (resourceType !== "Patient") {
        throw new Error(`Unexpected service FHIR read for ${resourceType}/${id}.`);
      }
      const found = patients.find((patient) => patient.id === id);
      if (!found) throw Object.assign(new Error(`Missing Patient/${id}`), { status: 404 });
      return structuredClone(found) as T;
    },
    async executeTransactionAsActor(
      request: Bundle,
      actor: { actorReference: string; actorRole: string; actionReason: string },
      _headers: Record<string, string> = {},
      transactionOptions: { validateResponse?: (response: Bundle) => void } = {},
    ): Promise<Bundle> {
      attributedActors.push(structuredClone(actor));
      const patientEntry = request.entry?.[0];
      const patient = patientEntry?.resource as Patient;
      const patientId = patientEntry?.request?.url?.match(/^Patient\/([A-Za-z0-9.-]+)$/)?.[1];
      const index = patients.findIndex((candidate) => candidate.id === patientId);
      if (index < 0) throw new Error("Synthetic opt-out transaction Patient missing.");
      assert.equal(patientEntry?.request?.ifMatch, `W/"${patients[index]!.meta?.versionId}"`);
      if (options.optOutTransactionError) throw options.optOutTransactionError;
      if (options.optOutTransactionResponse) {
        transactionOptions.validateResponse?.(options.optOutTransactionResponse);
        return options.optOutTransactionResponse;
      }
      patients[index] = {
        ...structuredClone(patient),
        meta: { ...patient.meta, versionId: String(Number(patients[index]!.meta?.versionId) + 1) },
      };
      const provenance = structuredClone(request.entry?.[1]?.resource as Provenance);
      provenances.push({ ...provenance, id: `provenance-${provenances.length + 1}` });
      const response: Bundle = {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: [
          { response: { status: "200 OK", location: `Patient/${patientId}/_history/${patients[index]!.meta?.versionId}` } },
          { response: { status: "201 Created", location: `Provenance/${provenances.at(-1)!.id}/_history/1` } },
        ],
      };
      transactionOptions.validateResponse?.(response);
      return response;
    },
  };
  const deps: CommsApiRouteDeps = {
    authenticateService: async () => undefined,
    authenticate: async (header) => {
      let resolvedStaff: Awaited<ReturnType<typeof authenticateStaffRoute>>;
      let role: string | undefined;
      if (options.resolvedStaffAuthentication) {
        resolvedStaff = await authenticateStaffRoute({
          baseUrl: "http://synthetic-medplum",
          authHeader: header,
          serviceClient: serviceFhir as never,
          audit,
          fetchImpl: async () => new Response(JSON.stringify({
            profile: { resourceType: "Practitioner", id: "real-staff" },
            user: { resourceType: "User", id: "real-staff", email: "staff@example.test" },
          }), { status: 200, headers: { "content-type": "application/json" } }),
        });
        if (!resolvedStaff) return null;
        role = resolvedStaff.actorRole;
      } else {
        role = header?.replace("Bearer ", "");
        if (!role || !["admin", "provider", "staff", "admin", "provider"].includes(role)) return null;
      }
      const accessPolicy = buildMedplumAccessPolicy(getRoleDeclaration(role as never));
      const communicationRule = accessPolicy.resource?.find((rule) =>
        rule.resourceType === "Communication" && rule.criteria?.includes("_compartment"));
      const communicationUpdateAllowed = accessPolicy.resource?.some((rule) =>
        (rule.resourceType === "Communication" || rule.resourceType === "*")
        && (rule.interaction?.includes("update") || rule.interaction?.includes("*"))) === true;
      const hiddenFields = communicationRule?.hiddenFields ?? [];
      const callerView = <T extends Resource>(resource: T): T => {
        const view = structuredClone(resource);
        if (view.resourceType === "Communication") {
          const fields = view as unknown as Record<string, unknown>;
          for (const field of hiddenFields) delete fields[field];
        }
        return view;
      };
      const callerFhir = {
        async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
          if (options.excludePatientRead) {
            throw Object.assign(new Error("Synthetic caller AccessPolicy denied Patient read"), { status: 403 });
          }
          const found = resourceType === "Patient"
            ? patients.find((patient) => patient.id === id)
            : resourceType === "Encounter"
              ? encounters.find((encounter) => encounter.id === id)
              : resourceType === "Condition"
                ? conditions.find((condition) => condition.id === id)
                : undefined;
          if (!found) throw Object.assign(new Error(`Missing ${resourceType}/${id}`), { status: 404 });
          return structuredClone(found) as T;
        },
        async search(_resourceType: string, params: Record<string, string> = {}) {
          if (params.category) {
            return {
              resourceType: "Bundle",
              type: "searchset",
              entry: options.callVisible === false ? [] : [{
                resource: {
                  resourceType: "Communication",
                  id: "call-communication-1",
                  status: "completed",
                  subject: { reference: PATIENT_REFERENCE },
                  identifier: [{
                    system: "https://odos2020.com/fhir/NamingSystem/twilio-call-sid",
                    value: CALL_ID,
                  }],
                },
              }],
            };
          }
          if (
            params.identifier?.startsWith("https://odos2020.com/fhir/NamingSystem/twilio-message-sid|")
            || params.identifier?.startsWith("https://odos2020.com/fhir/NamingSystem/ghl-message-id|")
          ) {
            const system = params.identifier.slice(0, params.identifier.lastIndexOf("|"));
            const value = params.identifier.slice(params.identifier.lastIndexOf("|") + 1);
            return {
              resourceType: "Bundle",
              type: "searchset",
              entry: persistedCommunications
                .filter((communication) => communication.identifier?.some((identifier) =>
                  identifier.system === system
                  && identifier.value === value))
                .map((resource) => ({ resource: callerView(resource) })),
            };
          }
          if (params.identifier?.startsWith("https://odos2020.com/fhir/NamingSystem/comms-staff-send|")) {
            const value = params.identifier.slice(params.identifier.lastIndexOf("|") + 1);
            return {
              resourceType: "Bundle",
              type: "searchset",
              entry: persistedCommunications
                .filter((communication) => communication.identifier?.some((identifier) =>
                  identifier.system === "https://odos2020.com/fhir/NamingSystem/comms-staff-send"
                  && identifier.value === value))
                .map((resource) => ({ resource: callerView(resource) })),
            };
          }
          if (params.identifier?.startsWith("https://odos2020.com/fhir/NamingSystem/twilio-call-sid|")) {
            return {
              resourceType: "Bundle",
              type: "searchset",
              entry: options.callVisible === false ? [] : [{
                resource: {
                  resourceType: "Communication",
                  id: "call-communication-1",
                  status: "completed",
                  subject: { reference: PATIENT_REFERENCE },
                  identifier: [{
                    system: "https://odos2020.com/fhir/NamingSystem/twilio-call-sid",
                    value: CALL_ID,
                  }],
                },
              }],
            };
          }
          return {
            resourceType: "Bundle",
            type: "searchset",
            entry: options.recordingVisible === false ? [] : [{
              resource: {
                resourceType: "Communication",
                id: "call-communication-1",
                status: "completed",
                subject: { reference: PATIENT_REFERENCE },
                identifier: [{
                  system: "https://odos2020.com/fhir/NamingSystem/twilio-recording-sid",
                  value: RECORDING_ID,
                }],
              },
            }],
          };
        },
        async searchUrl() {
          throw new Error("Unexpected FHIR pagination in communications API test.");
        },
        async create<T extends Resource>(resource: T): Promise<T> {
          if (resource.resourceType === "Provenance" && options.provenanceError) throw options.provenanceError;
          const persisted = {
            ...resource,
            id: `persisted-${persistedCommunications.length + 1}`,
            meta: { ...resource.meta, versionId: "1" },
          } as T;
          if (persisted.resourceType === "Communication") {
            persistedCommunications.push(structuredClone(persisted as Communication));
          }
          if (persisted.resourceType === "Provenance") {
            provenances.push(structuredClone(persisted as Provenance));
          }
          return callerView(persisted);
        },
        async update<T extends Resource>(_resourceType: T["resourceType"], id: string, resource: T, headers: Record<string, string> = {}): Promise<T> {
          const index = persistedCommunications.findIndex((candidate) => candidate.id === id);
          if (
            resource.resourceType === "Communication"
            && !communicationUpdateAllowed
          ) {
            throw Object.assign(new Error("Synthetic AccessPolicy denied Communication update"), { status: 403 });
          }
          if (
            options.failSmsCompletion
            && resource.resourceType === "Communication"
            && resource.identifier?.some((identifier) =>
              identifier.system === "https://odos2020.com/fhir/NamingSystem/twilio-message-sid")
          ) {
            options.failSmsCompletion = false;
            throw Object.assign(new Error("Synthetic FHIR outage"), { status: 503 });
          }
          if (options.completionError && resource.resourceType === "Communication"
            && (smsRequests.length + emailRequests.length) > 0) throw options.completionError;
          const restored = structuredClone(resource);
          if (restored.resourceType === "Patient" || restored.resourceType === "RelatedPerson") {
            if (options.recipientUpdateError) {
              assert.equal(headers["If-Match"], `W/"${resource.meta?.versionId}"`);
              throw options.recipientUpdateError;
            }
            recipientUpdates.push(structuredClone(restored));
          }
          if (restored.resourceType === "Communication" && index >= 0) {
            const fields = restored as unknown as Record<string, unknown>;
            const storedFields = persistedCommunications[index] as unknown as Record<string, unknown>;
            for (const field of hiddenFields) {
              if (fields[field] === undefined && storedFields[field] !== undefined) {
                fields[field] = structuredClone(storedFields[field]);
              }
            }
          }
          const persisted = {
            ...restored,
            id,
            meta: { ...resource.meta, versionId: String(Number(persistedCommunications[index]?.meta?.versionId ?? "0") + 1) },
          } as T;
          if (persisted.resourceType === "Patient") {
            const patientIndex = patients.findIndex((patient) => patient.id === persisted.id);
            if (patientIndex >= 0) patients[patientIndex] = structuredClone(persisted);
          }
          if (persisted.resourceType === "Communication" && index >= 0) {
            persistedCommunications[index] = structuredClone(persisted as Communication);
          }
          return callerView(persisted);
        },
        async executeTransactionAsActor(
          request: Bundle,
          actor: { actorReference: string; actorRole: string; actionReason: string },
          headers: Record<string, string> = {},
          transactionOptions: { validateResponse?: (response: Bundle) => void } = {},
        ): Promise<Bundle> {
          if (options.excludePatientWrite) {
            throw Object.assign(new Error("Synthetic caller AccessPolicy denied Patient write"), { status: 403 });
          }
          return serviceFhir.executeTransactionAsActor(request, actor, headers, transactionOptions);
        },
      } as never;
      authenticatedFhirs.push(callerFhir);
      if (resolvedStaff) return { ...resolvedStaff, businessActions: options.businessActions ?? resolvedStaff.businessActions, fhir: callerFhir };
      return {
        staffReference: `Practitioner/${role}`,
        actorRole: role as never,
        roles: options.roles ?? [role as never],
        businessActions: options.businessActions,
        membershipReference: options.membershipReference,
        fhir: callerFhir,
      };
    },
    fhir: serviceFhir,
    dispatch: {
      providers: () => options.providers ?? [options.providerName ?? "twilio"],
      providerFor: (role) => options.channelRoutes === undefined
        ? options.providerName ?? "twilio"
        : options.channelRoutes[role],
      senderNumberFor: (role) => options.senderNumbers?.[role as keyof typeof options.senderNumbers],
      getAdapter: (providerName, callerFhir) => {
        adapterProviders.push(providerName);
        adapterFhirs.push(callerFhir);
        const conversationListUnsupported = options.conversationUnsupported?.includes(providerName) === true;
        return {
          ...provider,
          name: providerName,
          capabilities: {
            ...provider.capabilities,
            conversations: !conversationListUnsupported,
          },
          messageIdentifierSystem: providerName === "ghl"
            ? "https://odos2020.com/fhir/NamingSystem/ghl-message-id"
            : "https://odos2020.com/fhir/NamingSystem/twilio-message-sid",
          listConversations: conversationListUnsupported
            ? undefined
            : async (request = {}) => {
              listProviderCalls.push(providerName);
              listRequests.push({ provider: providerName, ...request });
              if (options.conversationFailures?.includes(providerName)) {
                throw new Error("Synthetic vendor failure for +18645550199");
              }
              return structuredClone(options.conversationRows?.[providerName] ?? [conversation]);
            },
          async getConversationMessages(conversationId, request) {
            threadAdapterProviders.push(providerName);
            threadReadRequests.push({ conversationId, ...request });
            return [{
              id: `${providerName}-thread-message-1`,
              direction: "inbound",
              status: "delivered",
              occurredAt: "2026-08-03T13:00:00.000Z",
              ...(request?.includeContent ? { body: "Synthetic GHL thread content" } : {}),
            }];
          },
        };
      },
      initialize: async () => undefined,
    },
    educationCatalog: {
      list: () => structuredClone(EDUCATION_ITEMS),
      get: (id, version) => {
        const matches = EDUCATION_ITEMS.filter((item) => item.id === id);
        const selectedVersion = version ?? Math.max(...matches.map((item) => item.version));
        const item = matches.find((candidate) => candidate.version === selectedVersion);
        return item ? structuredClone(item) : undefined;
      },
    },
    trackedLinkStore: {
      async create(link) {
        trackedLinks.push(structuredClone(link));
      },
      async find(token) {
        return trackedLinks.find((link) => link.token === token);
      },
      async logClick() {},
    },
    publicBaseUrl: options.publicBaseUrl === undefined ? "https://practice.example" : options.publicBaseUrl,
    practiceName: "Synthetic Eye Care",
    chartDispatchLane: options.chartDispatchLane,
    audit,
    now: () => "2026-08-02T15:00:00.000Z",
  };
  const app = express();
  app.use(express.json());
  registerCommsApiRoutes(app, deps);
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    providerCalls,
    smsRequests,
    emailRequests,
    trackedLinks,
    adapterProviders,
    callListRequests,
    listRequests,
    listProviderCalls,
    threadReadRequests,
    threadAdapterProviders,
    grants,
    denials,
    persistedCommunications,
    patients,
    provenances,
    recipientUpdates,
    attributedActors,
    authenticatedFhirs,
    adapterFhirs,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function hasSmsOptOut(patient: Patient): boolean {
  return patient.extension?.some((entry) => entry.url === ODOS_COMMS_OPT_OUT_EXTENSION_URL) ?? false;
}

function request(base: string, path: string, method: string, body?: unknown, role?: string, claimedRole = role): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(role ? {
        authorization: `Bearer ${role}`,
        "x-odos-actor-role": claimedRole!,
        "x-odos-actor-id": role,
      } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

for (const failure of [undefined, new Error("Synthetic preference write failure"), Object.assign(new Error("Synthetic preference conflict"), { status: 412 })]) {
  test(failure ? `G19${"status" in failure ? "b" : ""} sent email survives preference flip failure` : "G12 staff email flips withheld Education email ON with staff provenance", async () => {
    const { replaceCommsPreferenceCells, readCommsPreferenceCells } = await import("../src/comms/suppression-gate.js");
    const fixture = await startServer({ optOutTransactionError: failure });
    try {
      fixture.patients[0] = replaceCommsPreferenceCells(fixture.patients[0], [{ purpose: "education", channel: "email", allowed: false }], {
        setBy: { reference: "Practitioner/staff" }, surface: "staff-demographics", recordedAt: "2026-08-01T15:00:00Z",
      });
      const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
        patientReference: PATIENT_REFERENCE, educationId: "dry-eye-basics", version: 2, channel: "email", lane: "clinical", idempotencyKey: "education-preference-flip",
      }, "staff");
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.equal(body.outcome, "sent");
      assert.equal(fixture.emailRequests.length, 1);
      assert.equal(fixture.emailRequests[0].suppression.staffEducationOverride, true);
      if (failure) {
        assert.equal(body.preferenceUpdate, "failed");
        assert.equal(readCommsPreferenceCells(fixture.patients[0])[0].allowed, false);
      } else {
        const cell = readCommsPreferenceCells(fixture.patients[0])[0];
        assert.equal(cell.allowed, true);
        assert.equal(cell.surface, "staff-manual-send");
        assert.equal(cell.setBy.reference, "Practitioner/staff");
        assert.equal(fixture.attributedActors.length, 1);
      }
    } finally { await fixture.close(); }
  });
}
