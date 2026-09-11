import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import type { Bundle, Patient, Resource } from "@medplum/fhirtypes";
import {
  COMMS_CHANNEL_ROLES,
  commsChannelRoutingFromEnv,
  commsAdapterRegistrationsFromEnv,
  commsPublicBaseUrlFromEnv,
  commsProviderConfigFromEnv,
  createCommsDispatch,
  startMcpAfterCommsInitialization,
} from "../src/comms/comms-config.js";

test("tracked-link public base config treats blank values as unset and warns only for the legacy fallback", () => {
  const cases = [
    {
      label: "absent",
      env: { ODOS_PRACTICE_PUBLIC_BASE_URL: "https://learn.ivaeyecare.com" },
      expected: "https://learn.ivaeyecare.com",
      warnings: 1,
    },
    {
      label: "empty",
      env: {
        ODOS_COMMS_PUBLIC_BASE_URL: "",
        ODOS_PRACTICE_PUBLIC_BASE_URL: "https://learn.ivaeyecare.com",
      },
      expected: "https://learn.ivaeyecare.com",
      warnings: 1,
    },
    {
      label: "whitespace",
      env: {
        ODOS_COMMS_PUBLIC_BASE_URL: "  \t",
        ODOS_PRACTICE_PUBLIC_BASE_URL: "https://learn.ivaeyecare.com",
      },
      expected: "https://learn.ivaeyecare.com",
      warnings: 1,
    },
    {
      label: "set",
      env: {
        ODOS_COMMS_PUBLIC_BASE_URL: "https://learn.ivaeyecare.com",
        ODOS_PRACTICE_PUBLIC_BASE_URL: "https://legacy.example.com",
      },
      expected: "https://learn.ivaeyecare.com",
      warnings: 0,
    },
    {
      label: "unconfigured",
      env: {},
      expected: "",
      warnings: 0,
    },
  ] as const;

  for (const scenario of cases) {
    const warnings: string[] = [];
    assert.equal(
      commsPublicBaseUrlFromEnv(scenario.env, (message) => warnings.push(message)),
      scenario.expected,
      scenario.label,
    );
    assert.equal(warnings.length, scenario.warnings, scenario.label);
    for (const warning of warnings) {
      assert.match(warning, /ODOS_COMMS_PUBLIC_BASE_URL.*ODOS_PRACTICE_PUBLIC_BASE_URL/);
    }
  }
});

function fakeFhir() {
  return {
    read: async <T extends Resource>(): Promise<T> => ({}) as T,
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({
      resourceType: "Bundle",
      type: "searchset",
    }),
  };
}

test("communications dispatch is inert without practice config and reports a clear resolution error", () => {
  const dispatch = createCommsDispatch([]);
  assert.deepEqual(dispatch.providers(), []);
  assert.throws(
    () => dispatch.getAdapter("google-workspace", fakeFhir()),
    /not configured for this practice/i,
  );
  assert.deepEqual(commsAdapterRegistrationsFromEnv({}), []);
});

test("scalar communications provider config selects exactly one SMS provider and one Voice provider", () => {
  const env = {
    ODOS_COMMS_SMS_PROVIDER: "aws",
    ODOS_COMMS_VOICE_PROVIDER: "twilio",
    ODOS_COMMS_EMAIL_PROVIDER: "google-workspace",
    AWS_SMS_REGION: "us-east-1",
    AWS_SMS_ORIGINATION_IDENTITY:
      "arn:aws:sms-voice:us-east-1:123456789012:phone-number/phone-11111111111111111111111111111111",
    AWS_SMS_SQS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/odos-sms-inbound",
    AWS_SMS_SNS_TOPIC_ARN: "arn:aws:sns:us-east-1:123456789012:odos-sms-inbound",
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "synthetic-auth-token",
    TWILIO_FROM_NUMBER: "+18645550100",
    TWILIO_VOICE_FROM_NUMBER: "+18645550100",
    TWILIO_VOICE_FORWARD_TO_NUMBER: "+18645550101",
    TWILIO_WEBHOOK_BASE_URL: "https://practice.example",
    TWILIO_VOICE_API_KEY_SID: `SK${"8".repeat(32)}`,
    TWILIO_VOICE_API_KEY_SECRET: "synthetic-voice-api-key-secret",
    GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL: "odos@synthetic.iam.gserviceaccount.com",
    GOOGLE_WORKSPACE_PRIVATE_KEY: "synthetic-private-key",
    GOOGLE_WORKSPACE_DELEGATED_USER: "info@synthetic-practice.example",
    GOOGLE_WORKSPACE_DOMAIN: "synthetic-practice.example",
    GOOGLE_WORKSPACE_FROM_ADDRESS: "info@synthetic-practice.example",
    GOOGLE_WORKSPACE_PLAN_CONFIRMED: "true",
  };
  assert.deepEqual(commsProviderConfigFromEnv(env), {
    sms_provider: "aws",
    voice_provider: "twilio",
    email_provider: "google-workspace",
  });
  const dispatch = createCommsDispatch(commsAdapterRegistrationsFromEnv(env), {
    channelRouting: commsChannelRoutingFromEnv(env),
  });

  assert.deepEqual(dispatch.providers(), ["aws", "twilio", "google-workspace"]);
  assert.equal(dispatch.providerFor("transactional-sms"), "aws");
  assert.equal(dispatch.providerFor("marketing-sms"), "aws");
  assert.equal(dispatch.providerFor("clinical-sms"), "aws");
  assert.equal(dispatch.providerFor("voice"), "twilio");
  assert.equal(dispatch.providerFor("email"), "google-workspace");
  assert.equal(dispatch.getAdapter("twilio", fakeFhir()).sendSms, undefined);
});

test("legacy scalar SMS config aliases transactional, marketing, and clinical roles without requiring new number config", () => {
  const routing = commsChannelRoutingFromEnv({ ODOS_COMMS_SMS_PROVIDER: "aws" });

  assert.equal(COMMS_CHANNEL_ROLES.includes("clinical-sms"), true);
  assert.deepEqual(routing.assignments, {
    "transactional-sms": "aws",
    "marketing-sms": "aws",
    "clinical-sms": "aws",
  });
  assert.deepEqual(routing.senderNumbers, {});
  assert.equal(routing.stopScope, "per-number");
});

test("two-lane SMS config resolves independent providers and E.164 sender numbers", () => {
  const env = {
    ODOS_COMMS_SMS_PROVIDER: "twilio",
    ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER: "+18645550100",
    ODOS_COMMS_CLINICAL_SMS_PROVIDER: "aws",
    ODOS_COMMS_CLINICAL_SMS_NUMBER: "+18485550100",
    AWS_SMS_REGION: "us-east-1",
    AWS_SMS_ORIGINATION_IDENTITY:
      "arn:aws:sms-voice:us-east-1:123456789012:phone-number/phone-11111111111111111111111111111111",
    AWS_SMS_SQS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/odos-sms-inbound",
    AWS_SMS_SNS_TOPIC_ARN: "arn:aws:sns:us-east-1:123456789012:odos-sms-inbound",
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "synthetic-auth-token",
    TWILIO_FROM_NUMBER: "+18645550100",
  };
  const routing = commsChannelRoutingFromEnv(env);
  const dispatch = createCommsDispatch(commsAdapterRegistrationsFromEnv(env), {
    channelRouting: routing,
  });

  assert.deepEqual(dispatch.providers(), ["twilio", "aws"]);
  assert.equal(dispatch.providerFor("transactional-sms"), "twilio");
  assert.equal(dispatch.providerFor("marketing-sms"), "twilio");
  assert.equal(dispatch.providerFor("clinical-sms"), "aws");
  assert.equal(dispatch.senderNumberFor("transactional-sms"), "+18645550100");
  assert.equal(dispatch.senderNumberFor("marketing-sms"), "+18645550100");
  assert.equal(dispatch.senderNumberFor("clinical-sms"), "+18485550100");
  assert.equal(dispatch.getAdapterForRole("clinical-sms", fakeFhir()).sendSms instanceof Function, true);
  assert.equal(dispatch.getAdapter("aws", fakeFhir()).sendSms instanceof Function, true);
});

test("a clinical provider override does not borrow the transactional sender number", () => {
  const routing = commsChannelRoutingFromEnv({
    ODOS_COMMS_SMS_PROVIDER: "twilio",
    ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER: "+18645550100",
    ODOS_COMMS_CLINICAL_SMS_PROVIDER: "aws",
  });

  assert.equal(routing.senderNumbers["transactional-sms"], "+18645550100");
  assert.equal(routing.senderNumbers["clinical-sms"], undefined);
});

test("role-aware Twilio dispatch sends from each resolved lane number", async () => {
  const transactionalNumber = "+18645550100";
  const clinicalNumber = "+18485550100";
  const env = {
    ODOS_COMMS_SMS_PROVIDER: "twilio",
    ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER: transactionalNumber,
    ODOS_COMMS_CLINICAL_SMS_PROVIDER: "twilio",
    ODOS_COMMS_CLINICAL_SMS_NUMBER: clinicalNumber,
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "synthetic-auth-token",
    TWILIO_FROM_NUMBER: transactionalNumber,
  };
  const creates: Array<Record<string, unknown>> = [];
  const dispatch = createCommsDispatch(commsAdapterRegistrationsFromEnv(env), {
    channelRouting: commsChannelRoutingFromEnv(env),
    now: () => new Date("2026-08-30T15:00:00.000Z"),
    twilioClientFactory: () => ({
      messages: {
        async create(input) {
          creates.push(input);
          return { sid: `SM${String(creates.length).padStart(32, "0")}` };
        },
      },
    }),
  });
  const fhir = {
    ...fakeFhir(),
    async read<T extends Resource>(): Promise<T> {
      return {
        resourceType: "Patient",
        id: "synthetic-1",
      } satisfies Patient as T;
    },
  };
  const request = {
    patientReference: "Patient/synthetic-1",
    toNumber: "+18645550199",
    body: "Synthetic lane proof",
    campaignType: "staff-initiated",
    suppression: {},
  };

  const transactional = await dispatch.getAdapterForRole("transactional-sms", fhir).sendSms!(request);
  const clinical = await dispatch.getAdapterForRole("clinical-sms", fhir).sendSms!(request);

  assert.equal(transactional.outcome, "sent");
  assert.equal(clinical.outcome, "sent");
  assert.deepEqual(creates.map(({ from }) => from), [transactionalNumber, clinicalNumber]);
  assert.deepEqual(creates.map(({ messagingServiceSid }) => messagingServiceSid), [undefined, undefined]);
});

test("clinical SMS routed to GHL degrades only that role while MCP startup continues", async () => {
  const env = {
    ODOS_COMMS_SMS_PROVIDER: "ghl",
    ODOS_COMMS_CLINICAL_SMS_PROVIDER: "ghl",
    GHL_LOCATION_ID: "location-synthetic-1",
    GHL_ACCESS_TOKEN: "synthetic-location-token",
  };
  const errors: string[] = [];
  let serverBooted = false;
  const dispatch = createCommsDispatch(commsAdapterRegistrationsFromEnv(env), {
    channelRouting: commsChannelRoutingFromEnv(env),
    error: (message) => errors.push(message),
  });

  await startMcpAfterCommsInitialization(dispatch, async () => { serverBooted = true; });

  assert.equal(serverBooted, true);
  assert.equal(dispatch.providerFor("transactional-sms"), "ghl");
  assert.equal(dispatch.providerFor("marketing-sms"), "ghl");
  assert.equal(dispatch.providerFor("clinical-sms"), undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /clinical-sms.*ghl.*BAA/i);
});

test("an inherited GHL SMS provider leaves clinical SMS unassigned without a refusal warning", async () => {
  const env = {
    ODOS_COMMS_SMS_PROVIDER: "ghl",
    GHL_LOCATION_ID: "location-synthetic-1",
    GHL_ACCESS_TOKEN: "synthetic-location-token",
  };
  const errors: string[] = [];
  const dispatch = createCommsDispatch(commsAdapterRegistrationsFromEnv(env), {
    channelRouting: commsChannelRoutingFromEnv(env),
    error: (message) => errors.push(message),
  });

  await dispatch.initialize();

  assert.equal(dispatch.providerFor("transactional-sms"), "ghl");
  assert.equal(dispatch.providerFor("marketing-sms"), "ghl");
  assert.equal(dispatch.providerFor("clinical-sms"), undefined);
  assert.deepEqual(errors, []);
});

test("Twilio Messaging Service and lane sender number conflict degrades only affected SMS roles without stopping MCP", async () => {
  const env = {
    ODOS_COMMS_SMS_PROVIDER: "twilio",
    ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER: "+18645550100",
    ODOS_COMMS_CLINICAL_SMS_PROVIDER: "aws",
    ODOS_COMMS_CLINICAL_SMS_NUMBER: "+18485550100",
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "synthetic-auth-token",
    TWILIO_MESSAGING_SERVICE_SID: `MG${"2".repeat(32)}`,
    AWS_SMS_REGION: "us-east-1",
    AWS_SMS_ORIGINATION_IDENTITY:
      "arn:aws:sms-voice:us-east-1:123456789012:phone-number/phone-11111111111111111111111111111111",
    AWS_SMS_SQS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/odos-sms-inbound",
    AWS_SMS_SNS_TOPIC_ARN: "arn:aws:sns:us-east-1:123456789012:odos-sms-inbound",
  };
  const errors: string[] = [];
  let serverBooted = false;
  const dispatch = createCommsDispatch(commsAdapterRegistrationsFromEnv(env), {
    channelRouting: commsChannelRoutingFromEnv(env),
    error: (message) => errors.push(message),
  });

  await startMcpAfterCommsInitialization(dispatch, async () => { serverBooted = true; });

  assert.equal(serverBooted, true);
  assert.equal(dispatch.providerFor("transactional-sms"), undefined);
  assert.equal(dispatch.providerFor("marketing-sms"), undefined);
  assert.equal(dispatch.providerFor("clinical-sms"), "aws");
  assert.equal(errors.length, 2);
  assert.match(errors[0]!, /transactional-sms.*TWILIO_MESSAGING_SERVICE_SID.*ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER/i);
  assert.match(errors[1]!, /marketing-sms.*TWILIO_MESSAGING_SERVICE_SID.*ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER/i);
});

test("clinical-only GHL degradation does not require an unusable adapter registration", async () => {
  const env = { ODOS_COMMS_CLINICAL_SMS_PROVIDER: "ghl" };
  const errors: string[] = [];
  const dispatch = createCommsDispatch(commsAdapterRegistrationsFromEnv(env), {
    channelRouting: commsChannelRoutingFromEnv(env),
    error: (message) => errors.push(message),
  });

  await dispatch.initialize();

  assert.deepEqual(dispatch.providers(), []);
  assert.equal(dispatch.providerFor("clinical-sms"), undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /clinical-sms.*ghl.*BAA/i);
});

test("communications stop scope accepts global and rejects unknown values", () => {
  assert.equal(
    commsChannelRoutingFromEnv({ ODOS_COMMS_STOP_SCOPE: "global" }).stopScope,
    "global",
  );
  assert.throws(
    () => commsChannelRoutingFromEnv({ ODOS_COMMS_STOP_SCOPE: "patient" }),
    /ODOS_COMMS_STOP_SCOPE must be exactly one of per-number,? or global/i,
  );
});

test("scalar SMS selection rejects a second simultaneous provider", () => {
  assert.throws(
    () => commsAdapterRegistrationsFromEnv({ ODOS_COMMS_SMS_PROVIDER: "aws,twilio" }),
    /ODOS_COMMS_SMS_PROVIDER must be exactly one of aws, twilio, or ghl/i,
  );
});

test("legacy list-shaped communications config fails as an explicit breaking migration", () => {
  assert.throws(
    () => commsAdapterRegistrationsFromEnv({ ODOS_COMMS_PROVIDERS: "aws,twilio" }),
    /breaking configuration migration.*ODOS_COMMS_SMS_PROVIDER.*ODOS_COMMS_VOICE_PROVIDER/i,
  );
  assert.throws(
    () => commsChannelRoutingFromEnv({ ODOS_COMMS_CHANNEL_ROUTES: "transactional-sms=twilio" }),
    /breaking configuration migration.*ODOS_COMMS_SMS_PROVIDER.*ODOS_COMMS_VOICE_PROVIDER/i,
  );
});

test("scalar communications routing leaves omitted channels unassigned", () => {
  const routing = commsChannelRoutingFromEnv({ ODOS_COMMS_VOICE_PROVIDER: "none" });
  assert.equal(routing.explicit, true);
  assert.deepEqual(routing.assignments, {});
});

test("communications routing isolates synchronous provider validation failures from MCP boot", async () => {
  const env = {
    ODOS_COMMS_EMAIL_PROVIDER: "google-workspace",
    GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL: "odos@synthetic.iam.gserviceaccount.com",
    GOOGLE_WORKSPACE_PRIVATE_KEY: "synthetic-private-key",
    GOOGLE_WORKSPACE_DELEGATED_USER: "info@other-synthetic.example",
    GOOGLE_WORKSPACE_DOMAIN: "synthetic-practice.example",
    GOOGLE_WORKSPACE_FROM_ADDRESS: "info@synthetic-practice.example",
    GOOGLE_WORKSPACE_PLAN_CONFIRMED: "true",
  };
  const errors: string[] = [];
  let serverBooted = false;
  const dispatch = createCommsDispatch(commsAdapterRegistrationsFromEnv(env), {
    channelRouting: commsChannelRoutingFromEnv(env),
    error: (message) => errors.push(message),
  });
  await startMcpAfterCommsInitialization(dispatch, async () => { serverBooted = true; });
  assert.equal(serverBooted, true);
  assert.equal(dispatch.providerFor("email"), undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /email.*google-workspace.*delegated user.*configured Workspace domain/i);
});

test("communications dispatch resolves the configured Google Workspace provider behind the suppression gate", () => {
  const registrations = commsAdapterRegistrationsFromEnv({
    ODOS_COMMS_EMAIL_PROVIDER: "google-workspace",
    GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL: "odos@synthetic.iam.gserviceaccount.com",
    GOOGLE_WORKSPACE_PRIVATE_KEY: "synthetic-private-key",
    GOOGLE_WORKSPACE_DELEGATED_USER: "info@synthetic-practice.example",
    GOOGLE_WORKSPACE_DOMAIN: "synthetic-practice.example",
    GOOGLE_WORKSPACE_FROM_ADDRESS: "info@synthetic-practice.example",
    GOOGLE_WORKSPACE_PLAN_CONFIRMED: "true",
  });
  const dispatch = createCommsDispatch(registrations, {
    practiceTimeZone: "America/New_York",
  });

  assert.deepEqual(dispatch.providers(), ["google-workspace"]);
  const adapter = dispatch.getAdapter("google-workspace", fakeFhir());
  assert.equal(adapter.name, "google-workspace");
  assert.equal(adapter.capabilities.email, true);
  assert.equal(adapter.capabilities.sms, false);
});

test("communications dispatch resolves configured Google Workspace and Twilio providers", () => {
  const registrations = commsAdapterRegistrationsFromEnv({
    ODOS_COMMS_EMAIL_PROVIDER: "google-workspace",
    ODOS_COMMS_SMS_PROVIDER: "twilio",
    ODOS_COMMS_VOICE_PROVIDER: "twilio",
    GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL: "odos@synthetic.iam.gserviceaccount.com",
    GOOGLE_WORKSPACE_PRIVATE_KEY: "synthetic-private-key",
    GOOGLE_WORKSPACE_DELEGATED_USER: "info@synthetic-practice.example",
    GOOGLE_WORKSPACE_DOMAIN: "synthetic-practice.example",
    GOOGLE_WORKSPACE_FROM_ADDRESS: "info@synthetic-practice.example",
    GOOGLE_WORKSPACE_PLAN_CONFIRMED: "true",
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "synthetic-auth-token",
    TWILIO_MESSAGING_SERVICE_SID: `MG${"2".repeat(32)}`,
    TWILIO_VOICE_FROM_NUMBER: "+18645550100",
    TWILIO_VOICE_FORWARD_TO_NUMBER: "+18645550101",
    TWILIO_WEBHOOK_BASE_URL: "https://practice.example",
    TWILIO_VOICE_API_KEY_SID: `SK${"8".repeat(32)}`,
    TWILIO_VOICE_API_KEY_SECRET: "synthetic-voice-api-key-secret",
    ODOS_HIPAA_MODE: "true",
    TWILIO_REAL_TIME_TRANSCRIPTION_ENABLED: "true",
    TWILIO_MEDIA_URL_AUTH_ACKNOWLEDGED: "true",
  });
  const dispatch = createCommsDispatch(registrations, {
    practiceTimeZone: "America/New_York",
    fetchImpl: (async () => Response.json({ sid: `SM${"3".repeat(32)}` })) as typeof fetch,
  });

  assert.deepEqual(dispatch.providers(), ["twilio", "google-workspace"]);
  const adapter = dispatch.getAdapter("twilio", fakeFhir());
  assert.equal(adapter.name, "twilio");
  assert.equal(adapter.capabilities.sms, true);
  assert.equal(adapter.capabilities.calls, true);
  assert.equal(adapter.capabilities.email, false);
  assert.equal(typeof adapter.sendSms, "function");
  assert.equal(typeof adapter.initiateCall, "function");
  assert.equal(typeof adapter.fetchRecording, "function");
  assert.equal(registrations[0]?.provider === "twilio" && registrations[0].config.hipaaMode, true);
  assert.equal(
    registrations[0]?.provider === "twilio" && registrations[0].config.realTimeTranscriptionEnabled,
    true,
  );
});

test("communications dispatch resolves a configured GHL provider behind ODOS suppression", () => {
  const registrations = commsAdapterRegistrationsFromEnv({
    ODOS_COMMS_SMS_PROVIDER: "ghl",
    GHL_LOCATION_ID: "location-synthetic-1",
    GHL_ACCESS_TOKEN: " synthetic-location-token\n",
  });
  const dispatch = createCommsDispatch(registrations, {
    practiceTimeZone: "America/New_York",
  });

  assert.deepEqual(dispatch.providers(), ["ghl"]);
  assert.equal(registrations[0]?.provider, "ghl");
  if (registrations[0]?.provider !== "ghl") throw new Error("Expected GHL registration.");
  assert.equal(registrations[0].config.accessToken, "synthetic-location-token");
  const adapter = dispatch.getAdapter("ghl", fakeFhir());
  assert.equal(adapter.name, "ghl");
  assert.equal(adapter.capabilities.sms, true);
  assert.equal(adapter.capabilities.conversations, true);
  assert.equal(adapter.capabilities.calls, false);
  assert.equal(adapter.messageIdentifierSystem, "https://odos2020.com/fhir/NamingSystem/ghl-message-id");
  assert.equal(typeof adapter.searchContacts, "function");
  assert.equal(typeof adapter.upsertContact, "function");
});

test("Twilio Voice env configuration is all-or-nothing and stays disabled for the existing SMS-only shape", () => {
  const [smsOnly] = commsAdapterRegistrationsFromEnv({
    ODOS_COMMS_SMS_PROVIDER: "twilio",
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "synthetic-auth-token",
    TWILIO_MESSAGING_SERVICE_SID: `MG${"2".repeat(32)}`,
    TWILIO_WEBHOOK_BASE_URL: "https://practice.example",
  });
  if (smsOnly.provider !== "twilio") throw new Error("Expected Twilio registration.");
  assert.equal(smsOnly.config.voiceFromNumber, undefined);
  assert.equal(smsOnly.config.webhookBaseUrl, "https://practice.example");

  assert.throws(() => commsAdapterRegistrationsFromEnv({
    ODOS_COMMS_SMS_PROVIDER: "twilio",
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "synthetic-auth-token",
    TWILIO_MESSAGING_SERVICE_SID: `MG${"2".repeat(32)}`,
    TWILIO_VOICE_FROM_NUMBER: "+18645550100",
  }), /Voice configuration is partial.*TWILIO_VOICE_FORWARD_TO_NUMBER/i);
});

test("communications env config fails closed when selected provider credentials are partial", () => {
  assert.throws(
    () => commsAdapterRegistrationsFromEnv({
      ODOS_COMMS_EMAIL_PROVIDER: "google-workspace",
      GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL: "odos@synthetic.iam.gserviceaccount.com",
    }),
    /partially configured|missing GOOGLE_WORKSPACE_PRIVATE_KEY/i,
  );
  assert.throws(
    () => commsAdapterRegistrationsFromEnv({ ODOS_COMMS_SMS_PROVIDER: "unknown" }),
    /ODOS_COMMS_SMS_PROVIDER must be exactly one of/i,
  );
  assert.throws(
    () => commsAdapterRegistrationsFromEnv({
      ODOS_COMMS_SMS_PROVIDER: "ghl",
      GHL_LOCATION_ID: "location-synthetic-1",
    }),
    /missing GHL_ACCESS_TOKEN/i,
  );
  assert.throws(
    () => commsAdapterRegistrationsFromEnv({
      ODOS_COMMS_SMS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    }),
    /missing TWILIO_AUTH_TOKEN/i,
  );
  assert.throws(
    () => commsAdapterRegistrationsFromEnv({
      ODOS_COMMS_SMS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "synthetic-auth-token",
    }),
    /TWILIO_MESSAGING_SERVICE_SID.*TWILIO_FROM_NUMBER/i,
  );
  assert.throws(
    () => commsAdapterRegistrationsFromEnv({
      ODOS_COMMS_SMS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "synthetic-auth-token",
      TWILIO_MESSAGING_SERVICE_SID: `MG${"2".repeat(32)}`,
      ODOS_HIPAA_MODE: "yes",
    }),
    /ODOS_HIPAA_MODE must be true or false/i,
  );
});

test("communications env config trims Twilio single-line secrets", () => {
  const [registration] = commsAdapterRegistrationsFromEnv({
    ODOS_COMMS_SMS_PROVIDER: "twilio",
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    TWILIO_AUTH_TOKEN: " synthetic-auth-token\n",
    TWILIO_API_KEY_SID: `SK${"2".repeat(32)}`,
    TWILIO_API_KEY_SECRET: " synthetic-key-secret\n",
    TWILIO_MESSAGING_SERVICE_SID: `MG${"3".repeat(32)}`,
  });

  assert.equal(registration.provider, "twilio");
  if (registration.provider !== "twilio") throw new Error("Expected Twilio registration.");
  assert.equal(registration.config.authToken, "synthetic-auth-token");
  assert.equal(registration.config.apiKeySecret, "synthetic-key-secret");
});

test("communications startup logs whether Twilio HIPAA mode is enabled or disabled", async () => {
  const logs: string[] = [];
  let poolLists = 0;
  const clientFactory = () => ({
    messages: { create: async () => ({ sid: `SM${"3".repeat(32)}` }) },
    messaging: {
      v1: {
        services: () => ({
          phoneNumbers: {
            async list() {
              poolLists += 1;
              return [{ phoneNumber: "+18645550100", countryCode: "US" }];
            },
          },
        }),
      },
    },
  });
  const enabled = createCommsDispatch([{
    provider: "twilio",
    config: {
      accountSid: `AC${"1".repeat(32)}`,
      authToken: "synthetic-auth-token",
      messagingServiceSid: `MG${"2".repeat(32)}`,
      hipaaMode: true,
    },
  }], { info: (message) => logs.push(message), twilioClientFactory: clientFactory });
  const disabled = createCommsDispatch([{
    provider: "twilio",
    config: {
      accountSid: `AC${"1".repeat(32)}`,
      authToken: "synthetic-auth-token",
      messagingServiceSid: `MG${"2".repeat(32)}`,
    },
  }], { info: (message) => logs.push(message), twilioClientFactory: clientFactory });

  await enabled.initialize();
  await disabled.initialize();

  assert.equal(poolLists, 1);
  assert.deepEqual(logs, [
    "odos-mcp: Twilio HIPAA posture ENABLED; US-only destinations and senders are enforced.",
    "odos-mcp: Twilio HIPAA posture DISABLED; international destinations and senders are permitted.",
  ]);
});

test("MCP boot continues when Twilio pool verification fails while SMS stays fail-closed", async () => {
  const errors: string[] = [];
  let poolLists = 0;
  let messageCreates = 0;
  let serverBooted = false;
  const dispatch = createCommsDispatch([
    {
      provider: "google-workspace",
      config: {
        serviceAccountEmail: "odos@synthetic.iam.gserviceaccount.com",
        privateKey: "synthetic-private-key",
        delegatedUserEmail: "info@synthetic-practice.example",
        workspaceDomain: "synthetic-practice.example",
        fromAddress: "info@synthetic-practice.example",
        workspacePlanConfirmed: true,
      },
    },
    {
      provider: "twilio",
      config: {
        accountSid: `AC${"1".repeat(32)}`,
        authToken: "synthetic-auth-token",
        messagingServiceSid: `MG${"2".repeat(32)}`,
        hipaaMode: true,
      },
    },
  ], {
    now: () => new Date("2026-08-09T00:00:00.000Z"),
    error: (message) => errors.push(message),
    twilioClientFactory: () => ({
      messages: {
        async create() {
          messageCreates += 1;
          return { sid: `SM${"3".repeat(32)}` };
        },
      },
      messaging: {
        v1: {
          services: () => ({
            phoneNumbers: {
              async list() {
                poolLists += 1;
                throw new Error("synthetic restricted key 403");
              },
            },
          }),
        },
      },
    }),
  });

  await startMcpAfterCommsInitialization(dispatch, async () => {
    serverBooted = true;
  });

  assert.equal(dispatch.getAdapter("google-workspace", fakeFhir()).capabilities.email, true);
  const adapter = dispatch.getAdapter("twilio", fakeFhir());
  await assert.rejects(adapter.sendSms!({
    patientReference: "Patient/synthetic-1",
    toNumber: "+18645550199",
    body: "Synthetic HIPAA-mode message.",
    campaignType: "manual",
    suppression: {},
  }), /cannot verify.*Messaging Service.*HIPAA/i);

  assert.equal(serverBooted, true);
  assert.equal(poolLists, 1);
  assert.equal(messageCreates, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /communications provider "twilio".*degraded/i);
  assert.match(errors[0]!, /synthetic restricted key 403/i);
  assert.match(errors[0]!, /twilio\/messaging\/services\.phonenumbers\/list/i);
  assert.match(errors[0]!, /continues starting/i);
});

test("communications dispatch reuses one Google adapter token cache across resolved sends", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let tokenCalls = 0;
  let gmailCalls = 0;
  const dispatch = createCommsDispatch([{
    provider: "google-workspace",
    config: {
      serviceAccountEmail: "odos@synthetic.iam.gserviceaccount.com",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      delegatedUserEmail: "info@synthetic-practice.example",
      workspaceDomain: "synthetic-practice.example",
      fromAddress: "info@synthetic-practice.example",
      workspacePlanConfirmed: true,
    },
  }], {
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
    fetchImpl: (async (input) => {
      if (String(input).includes("oauth2.googleapis.com")) {
        tokenCalls += 1;
        return Response.json({ access_token: "synthetic-token", expires_in: 3600 });
      }
      gmailCalls += 1;
      return Response.json({ id: `message-${gmailCalls}` });
    }) as typeof fetch,
  });
  const fhir = {
    ...fakeFhir(),
    read: async <T extends Resource>(): Promise<T> => ({
      resourceType: "Patient",
      id: "synthetic-1",
      telecom: [{ system: "email", value: "patient@example.test" }],
    } satisfies Patient) as T,
  };
  const request = {
    patientReference: "Patient/synthetic-1",
    subject: "Appointment reminder",
    body: "Your appointment is tomorrow at Main Office.",
    campaignType: "appointment-reminder",
    suppression: {},
  };

  const adapter = dispatch.getAdapter("google-workspace", fhir);
  assert.ok(adapter.sendEmail);
  await adapter.sendEmail(request);
  await adapter.sendEmail(request);

  assert.equal(gmailCalls, 2);
  assert.equal(tokenCalls, 1);
});
