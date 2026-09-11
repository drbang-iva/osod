import type { Annotation, CodeableConcept, Communication, Identifier, Patient } from "@medplum/fhirtypes";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MedplumClient } from "../fhir-client.js";
import type {
  TwilioInboundWebhookEvent,
  TwilioRecordingWebhookEvent,
  TwilioStatusWebhookEvent,
  TwilioTranscriptionWebhookEvent,
  TwilioVoiceWebhookEvent,
} from "./adapters/twilio-adapter.js";
import type { InboundMessageEvent } from "./inbound-receiver.js";
import type { SendResult } from "./comms-provider.js";
import { inboundSuppressionLogDetails, updateInboundSuppression } from "./suppression-gate.js";

export const ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/twilio-message-sid";
export const ODOS_GHL_MESSAGE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/ghl-message-id";
export const ODOS_AWS_MESSAGE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/aws-end-user-messaging-message-id";
export const ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/twilio-call-sid";
export const ODOS_COMMS_PHONE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/phone-number";
export const ODOS_COMMS_CATEGORY_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/communication-category";
export const ODOS_PATIENT_SMS_CATEGORY = "patient-sms";
export const ODOS_PATIENT_CALL_CATEGORY = "patient-call";
export const ODOS_PATIENT_SMS_INBOUND_CATEGORY = "patient-sms-inbound";
export const ODOS_PATIENT_SMS_OUTBOUND_CATEGORY = "patient-sms-outbound";
export const ODOS_PATIENT_EMAIL_CATEGORY = "patient-email";
export const ODOS_PATIENT_EMAIL_OUTBOUND_CATEGORY = "patient-email-outbound";
export const ODOS_PATIENT_CALL_INBOUND_CATEGORY = "patient-call-inbound";
export const ODOS_PATIENT_CALL_OUTBOUND_CATEGORY = "patient-call-outbound";
export const ODOS_TWILIO_RECORDING_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/twilio-recording-sid";
export const ODOS_TWILIO_TRANSCRIPTION_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/twilio-transcription-sid";
export const ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-staff-send";
export const ODOS_COMMS_STAFF_SEND_CLAIM_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-staff-send-claim";
export const ODOS_COMMS_STAFF_SEND_PROVIDER_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-staff-send-provider";
export const ODOS_COMMS_STAFF_SEND_FINGERPRINT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-staff-send-fingerprint";
export const ODOS_COMMS_STAFF_SEND_OUTCOME_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-staff-send-outcome";
export const ODOS_COMMS_STAFF_SEND_REASON_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-staff-send-reason";
export const ODOS_COMMS_STAFF_SEND_RESCHEDULED_AT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-staff-send-rescheduled-at";
export const ODOS_COMMS_DEFAULT_PROVIDER = "twilio";
export const ODOS_COMMS_PROVIDER_MESSAGE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-provider-message-id";

const TWILIO_CALL_METADATA_AUTHOR = "ODOS Twilio call metadata";
const TWILIO_RECORDING_METADATA_AUTHOR = "ODOS Twilio recording metadata";
const TWILIO_TRANSCRIPTION_METADATA_AUTHOR = "ODOS Twilio transcription metadata";
const communicationWrites = new Map<string, Promise<void>>();

export type TwilioWebhookKind =
  | "sms-inbound"
  | "sms-status"
  | "voice-inbound"
  | "voice-status"
  | "voice-recording"
  | "voice-transcription";

export type TwilioWebhookEvent =
  | TwilioInboundWebhookEvent
  | TwilioStatusWebhookEvent
  | TwilioVoiceWebhookEvent
  | TwilioRecordingWebhookEvent
  | TwilioTranscriptionWebhookEvent;

export type CommsPersistenceFhir = Pick<MedplumClient, "search" | "searchUrl" | "create" | "update">;

export async function persistTwilioWebhookEvent(
  fhir: CommsPersistenceFhir,
  kind: TwilioWebhookKind,
  event: TwilioWebhookEvent,
  deps: { now?: () => string; info?: (message: string) => void } = {},
): Promise<Communication> {
  const now = deps.now?.() ?? new Date().toISOString();
  const identity = eventIdentity(kind, event);
  const persisted = await serializeCommunicationWrite(`${identity.system}|${identity.value}`, () =>
    persistTwilioWebhookEventLocked(fhir, kind, event, identity, now));
  if (kind === "sms-inbound") {
    const inbound = event as TwilioInboundWebhookEvent;
    const result = await updateInboundSuppression(fhir, {
      from: inbound.from,
      to: inbound.to,
      body: inbound.body,
      optOutType: inbound.optOutType,
    });
    (deps.info ?? console.error)(
      `odos-mcp: Twilio inbound SMS suppression ${inboundSuppressionLogDetails(result)}`,
    );
  }
  return persisted;
}

export async function persistInboundMessageEvent(
  fhir: CommsPersistenceFhir,
  event: InboundMessageEvent,
): Promise<Communication> {
  const identity = {
    system: event.providerMessageIdentifierSystem,
    value: event.providerMessageId,
    category: ODOS_PATIENT_SMS_CATEGORY,
  };
  return serializeCommunicationWrite(`${identity.system}|${identity.value}`, async () => {
    const patient = await patientForPhone(fhir, event.from);
    return persistCommunicationFragment(fhir, identity, {
      status: "completed",
      ...(patient
        ? { subject: patientReference(patient), sender: patientReference(patient) }
        : { sender: phoneReference(event.from) }),
      recipient: [phoneReference(event.to)],
      received: event.receivedAt ?? new Date().toISOString(),
      payload: [{ contentString: event.body }],
      category: [category(ODOS_PATIENT_SMS_INBOUND_CATEGORY)],
    });
  });
}

export type StaffSendReservation =
  | { state: "owner"; communication: Communication }
  | { state: "sent"; communication: Communication; providerMessageId: string }
  | { state: "terminal"; communication: Communication; result: Exclude<SendResult, { outcome: "sent" }> }
  | { state: "pending"; communication: Communication }
  | { state: "conflict"; communication: Communication };

export type StaffSmsSendReservation = StaffSendReservation;

export function findStaffSend(
  fhir: CommsPersistenceFhir,
  idempotencyKey: string,
): Promise<Communication | undefined> {
  return findCommunication(fhir, ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM, idempotencyKey);
}

export function findStaffSmsSend(
  fhir: CommsPersistenceFhir,
  idempotencyKey: string,
): Promise<Communication | undefined> {
  return findStaffSend(fhir, idempotencyKey);
}

export async function reserveStaffSend(
  fhir: CommsPersistenceFhir,
  input: {
    idempotencyKey: string;
    claimId: string;
    patientReference: string;
    senderReference: string;
    body: string;
    requestFingerprint?: string;
    frozenContext?: string;
    provider?: string;
    providerMessageIdentifierSystem?: string;
    medium?: "SMS" | "Email";
    category?: string;
    outboundCategory?: string;
  },
): Promise<StaffSendReservation> {
  const existing = await findCommunication(fhir, ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM, input.idempotencyKey);
  if (existing) return classifyStaffSendReservation(existing, input);
  const candidate: Communication = {
    resourceType: "Communication",
    status: "preparation",
    identifier: [
      { system: ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM, value: input.idempotencyKey },
      { system: ODOS_COMMS_STAFF_SEND_CLAIM_IDENTIFIER_SYSTEM, value: input.claimId },
      { system: ODOS_COMMS_STAFF_SEND_PROVIDER_IDENTIFIER_SYSTEM, value: input.provider ?? ODOS_COMMS_DEFAULT_PROVIDER },
      ...(input.requestFingerprint ? [{
        system: ODOS_COMMS_STAFF_SEND_FINGERPRINT_IDENTIFIER_SYSTEM,
        value: staffSendFingerprint(input.requestFingerprint),
      }] : []),
    ],
    category: [
      category(input.category ?? ODOS_PATIENT_SMS_CATEGORY),
      category(input.outboundCategory ?? ODOS_PATIENT_SMS_OUTBOUND_CATEGORY),
    ],
    medium: [{ text: input.medium ?? "SMS" }],
    subject: { reference: input.patientReference },
    sender: { reference: input.senderReference },
    recipient: [{ reference: input.patientReference }],
    payload: [{ contentString: input.body }, ...(input.frozenContext ? [{ contentString: input.frozenContext }] : [])],
  };
  const claimed = await fhir.create<Communication>(candidate, {
    "If-None-Exist": `identifier=${ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM}|${input.idempotencyKey}`,
  });
  return classifyStaffSendReservation(claimed, input);
}

export async function reserveStaffSmsSend(
  fhir: CommsPersistenceFhir,
  input: {
    idempotencyKey: string;
    claimId: string;
    patientReference: string;
    senderReference: string;
    body: string;
    requestFingerprint?: string;
    frozenContext?: string;
    provider?: string;
    providerMessageIdentifierSystem?: string;
  },
): Promise<StaffSmsSendReservation> {
  return reserveStaffSend(fhir, input);
}

export async function persistStaffSentSend(
  fhir: CommsPersistenceFhir,
  input: {
    communication: Communication;
    idempotencyKey: string;
    providerMessageId: string;
    providerMessageIdentifierSystem?: string;
    category?: string;
    outboundCategory?: string;
    completed?: boolean;
  },
  deps: { now?: () => string } = {},
): Promise<Communication> {
  const identity = {
    system: ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM,
    value: input.idempotencyKey,
    category: input.category ?? ODOS_PATIENT_SMS_CATEGORY,
  };
  const fragment: Partial<Communication> = {
    // Carrier callbacks may advance callback-capable sends; GHL owns its downstream delivery state.
    status: input.completed || input.providerMessageIdentifierSystem === ODOS_GHL_MESSAGE_IDENTIFIER_SYSTEM
      ? "completed"
      : "in-progress",
    sent: deps.now?.() ?? new Date().toISOString(),
    identifier: [{
      system: input.providerMessageIdentifierSystem ?? ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM,
      value: input.providerMessageId,
    }],
    category: [category(input.outboundCategory ?? ODOS_PATIENT_SMS_OUTBOUND_CATEGORY)],
  };
  return serializeCommunicationWrite(`${identity.system}|${identity.value}`, async () => {
    const canonical = await updateCommunicationFragment(fhir, input.communication, fragment, identity);
    return reconcileStaffSmsDuplicates(
      fhir,
      canonical,
      identity,
      input.providerMessageId,
      input.providerMessageIdentifierSystem ?? ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM,
    );
  });
}

export const persistStaffSentSms = persistStaffSentSend;

export async function persistStaffTerminalOutcome(
  fhir: CommsPersistenceFhir,
  input: {
    communication: Communication;
    idempotencyKey: string;
    result: Exclude<SendResult, { outcome: "sent" }>;
    category?: string;
  },
): Promise<Communication> {
  const identity = {
    system: ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM,
    value: input.idempotencyKey,
    category: input.category ?? ODOS_PATIENT_SMS_CATEGORY,
  };
  const identifiers: Identifier[] = [
    { system: ODOS_COMMS_STAFF_SEND_OUTCOME_IDENTIFIER_SYSTEM, value: input.result.outcome },
    { system: ODOS_COMMS_STAFF_SEND_REASON_IDENTIFIER_SYSTEM, value: input.result.reason },
    ...(input.result.outcome === "rescheduled" ? [{
      system: ODOS_COMMS_STAFF_SEND_RESCHEDULED_AT_IDENTIFIER_SYSTEM,
      value: input.result.rescheduledAt,
    }] : []),
  ];
  return serializeCommunicationWrite(`${identity.system}|${identity.value}`, () =>
    updateCommunicationFragment(fhir, input.communication, {
      status: "not-done",
      statusReason: { text: input.result.reason },
      identifier: identifiers,
    }, identity));
}

export const persistStaffSmsTerminalOutcome = persistStaffTerminalOutcome;

function classifyStaffSendReservation(
  communication: Communication,
  input: {
    claimId: string;
    patientReference: string;
    senderReference: string;
    body: string;
    requestFingerprint?: string;
    provider?: string;
    providerMessageIdentifierSystem?: string;
  },
): StaffSmsSendReservation {
  const reservedFingerprint = communication.identifier?.find((identifier) =>
    identifier.system === ODOS_COMMS_STAFF_SEND_FINGERPRINT_IDENTIFIER_SYSTEM)?.value;
  const expectedFingerprint = input.requestFingerprint
    ? staffSendFingerprint(input.requestFingerprint)
    : undefined;
  const visiblePayloadConflicts = expectedFingerprint
    ? reservedFingerprint !== expectedFingerprint
    : communication.payload !== undefined && communication.payload[0]?.contentString !== input.body;
  const reservedProvider = communication.identifier?.find((identifier) =>
    identifier.system === ODOS_COMMS_STAFF_SEND_PROVIDER_IDENTIFIER_SYSTEM)?.value ?? ODOS_COMMS_DEFAULT_PROVIDER;
  if (
    communication.subject?.reference !== input.patientReference
    || communication.sender?.reference !== input.senderReference
    || communication.recipient?.[0]?.reference !== input.patientReference
    || visiblePayloadConflicts
    || reservedProvider !== (input.provider ?? ODOS_COMMS_DEFAULT_PROVIDER)
  ) {
    return { state: "conflict", communication };
  }
  const providerMessageId = communication.identifier?.find(
    (identifier) => identifier.system === (
      input.providerMessageIdentifierSystem ?? ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM
    ),
  )?.value;
  if (providerMessageId) return { state: "sent", communication, providerMessageId };
  const terminalResult = staffSmsTerminalResult(communication);
  if (terminalResult) return { state: "terminal", communication, result: terminalResult };
  const owned = communication.identifier?.some((identifier) =>
    identifier.system === ODOS_COMMS_STAFF_SEND_CLAIM_IDENTIFIER_SYSTEM
    && identifier.value === input.claimId) === true;
  return owned
    ? { state: "owner", communication }
    : { state: "pending", communication };
}

export function staffSmsTerminalResult(
  communication: Communication,
): Exclude<SendResult, { outcome: "sent" }> | undefined {
  const value = (system: string) => communication.identifier?.find((identifier) =>
    identifier.system === system)?.value;
  const outcome = value(ODOS_COMMS_STAFF_SEND_OUTCOME_IDENTIFIER_SYSTEM);
  const reason = value(ODOS_COMMS_STAFF_SEND_REASON_IDENTIFIER_SYSTEM);
  if (outcome === "suppressed" && (reason === "patient-opt-out" || reason === "preference-withheld" || reason === "frequency-cap")) {
    return { outcome, reason };
  }
  const rescheduledAt = value(ODOS_COMMS_STAFF_SEND_RESCHEDULED_AT_IDENTIFIER_SYSTEM);
  if (outcome === "rescheduled" && reason === "quiet-hours" && rescheduledAt) {
    return { outcome, reason, rescheduledAt };
  }
  return undefined;
}

function staffSendFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function reconcileStaffSmsDuplicates(
  fhir: CommsPersistenceFhir,
  initial: Communication,
  identity: ReturnType<typeof eventIdentity>,
  providerMessageId: string,
  providerMessageIdentifierSystem: string,
): Promise<Communication> {
  let canonical = await findCommunication(fhir, identity.system, identity.value) ?? initial;
  for (let pass = 0; pass < 3; pass += 1) {
    const matches = await findCommunications(
      fhir,
      providerMessageIdentifierSystem,
      providerMessageId,
      "100",
    );
    const duplicates = matches.filter((communication) => communication.id !== canonical.id);
    if (duplicates.length === 0) return canonical;
    for (const duplicate of duplicates) {
      canonical = await updateCommunicationFragment(fhir, canonical, {
        status: duplicate.status,
        statusReason: duplicate.statusReason,
        identifier: duplicate.identifier,
        category: duplicate.category,
        note: duplicate.note,
      }, identity);
      await retireDuplicateCommunication(
        fhir,
        duplicate,
        providerMessageId,
        providerMessageIdentifierSystem,
      );
    }
  }
  throw new Error("Staff SMS duplicate reconciliation retry limit reached.");
}

async function retireDuplicateCommunication(
  fhir: CommsPersistenceFhir,
  initial: Communication,
  providerMessageId: string,
  providerMessageIdentifierSystem: string,
): Promise<void> {
  let current: Communication | undefined = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!current.id || !current.meta?.versionId) {
      throw new Error("Duplicate provider Communication is missing id or version; refusing an unsafe update.");
    }
    const identifiers = current.identifier?.filter((identifier) =>
      !(identifier.system === providerMessageIdentifierSystem && identifier.value === providerMessageId));
    const categories = current.category?.flatMap((concept) => {
      const coding = concept.coding?.filter((entry) =>
        entry.system !== ODOS_COMMS_CATEGORY_SYSTEM
        || ![ODOS_PATIENT_SMS_CATEGORY, ODOS_PATIENT_SMS_INBOUND_CATEGORY, ODOS_PATIENT_SMS_OUTBOUND_CATEGORY]
          .includes(entry.code ?? ""));
      return coding?.length ? [{ ...concept, coding }] : [];
    });
    const retired = Object.fromEntries(Object.entries({
      ...current,
      status: "entered-in-error",
      statusReason: { text: "Duplicate provider Communication reconciled into the staff send intent." },
      identifier: identifiers?.length ? identifiers : undefined,
      category: categories?.length ? categories : undefined,
    }).filter(([, value]) => value !== undefined)) as unknown as Communication;
    try {
      await fhir.update<Communication>("Communication", current.id, retired, {
        "If-Match": `W/"${current.meta.versionId}"`,
      });
      return;
    } catch (error) {
      if (!isFhirConflict(error) || attempt === 2) throw error;
      current = (await findCommunications(
        fhir,
        providerMessageIdentifierSystem,
        providerMessageId,
        "100",
      )).find((communication) => communication.id === current?.id);
      if (!current) return;
    }
  }
}

async function persistTwilioWebhookEventLocked(
  fhir: CommsPersistenceFhir,
  kind: TwilioWebhookKind,
  event: TwilioWebhookEvent,
  identity: ReturnType<typeof eventIdentity>,
  now: string,
): Promise<Communication> {
  const fragment = await eventFragment(fhir, kind, event, now);
  const persisted = await persistCommunicationFragment(fhir, identity, fragment);
  if (kind !== "sms-status") return persisted;
  return reconcileStatusCallbackWithStaffSms(fhir, persisted, identity.value);
}

async function reconcileStatusCallbackWithStaffSms(
  fhir: CommsPersistenceFhir,
  persisted: Communication,
  messageSid: string,
): Promise<Communication> {
  const matches = await findCommunications(fhir, ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM, messageSid, "100");
  const staffCandidates = matches.filter((communication) => communication.identifier?.some((identifier) =>
    identifier.system === ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM && Boolean(identifier.value)));
  if (staffCandidates.length === 0) return persisted;
  if (staffCandidates.length > 1) {
    throw new Error("Twilio message SID is attached to multiple staff send intents; refusing ambiguous reconciliation.");
  }
  const canonical = staffCandidates[0];
  const idempotencyKey = canonical.identifier?.find(
    (identifier) => identifier.system === ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM,
  )?.value;
  if (!idempotencyKey) return persisted;
  const staffIdentity = {
    system: ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM,
    value: idempotencyKey,
    category: ODOS_PATIENT_SMS_CATEGORY,
  };
  return serializeCommunicationWrite(`${staffIdentity.system}|${staffIdentity.value}`, () =>
    reconcileStaffSmsDuplicates(
      fhir,
      canonical,
      staffIdentity,
      messageSid,
      ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM,
    ));
}

async function persistCommunicationFragment(
  fhir: CommsPersistenceFhir,
  identity: ReturnType<typeof eventIdentity>,
  fragment: Partial<Communication>,
): Promise<Communication> {
  const existing = await findCommunication(fhir, identity.system, identity.value);
  if (!existing) {
    const baseCategory = category(identity.category);
    const created = await fhir.create<Communication>({
      resourceType: "Communication",
      status: fragment.status ?? "unknown",
      medium: [{ text: identity.category === ODOS_PATIENT_SMS_CATEGORY ? "SMS" : "Voice call" }],
      ...fragment,
      identifier: mergeIdentifiers(
        [{ system: identity.system, value: identity.value }],
        fragment.identifier,
      ),
      category: mergeCategories([baseCategory], fragment.category),
    }, {
      "If-None-Exist": `identifier=${identity.system}|${identity.value}`,
    });
    const merged = mergeCommunication(created, fragment, identity);
    if (isDeepStrictEqual(created, merged)) return created;
    const winner = await findCommunication(fhir, identity.system, identity.value);
    if (!winner?.id) throw new Error("Persisted Twilio Communication is missing its FHIR id.");
    const mergedWinner = mergeCommunication(winner, fragment, identity);
    if (isDeepStrictEqual(winner, mergedWinner)) return winner;
    return updateCommunicationFragment(fhir, winner, fragment, identity);
  }
  return updateCommunicationFragment(fhir, existing, fragment, identity);
}

async function updateCommunicationFragment(
  fhir: CommsPersistenceFhir,
  initial: Communication,
  fragment: Partial<Communication>,
  identity: ReturnType<typeof eventIdentity>,
): Promise<Communication> {
  let current = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!current.id) throw new Error("Persisted Twilio Communication is missing its FHIR id.");
    if (!current.meta?.versionId) {
      throw new Error("Persisted Twilio Communication is missing its FHIR version; refusing an unsafe update.");
    }
    const merged = mergeCommunication(current, fragment, identity);
    if (isDeepStrictEqual(current, merged)) return current;
    try {
      return await fhir.update<Communication>("Communication", current.id, merged, {
        "If-Match": `W/"${current.meta.versionId}"`,
      });
    } catch (error) {
      if (!isFhirConflict(error) || attempt === 2) throw error;
      const latest = await findCommunication(fhir, identity.system, identity.value);
      if (!latest) throw new Error("Persisted Twilio Communication disappeared during conflict recovery.");
      current = latest;
    }
  }
  throw new Error("Twilio Communication update retry limit reached.");
}

function mergeCommunication(
  existing: Communication,
  fragment: Partial<Communication>,
  identity: ReturnType<typeof eventIdentity>,
): Communication {
  const acceptStatus = acceptsIncomingStatus(existing.status, existing.statusReason, fragment.status);
  const incomingNotes = acceptStatus
    ? fragment.note
    : fragment.note?.filter((note) => note.authorString !== TWILIO_CALL_METADATA_AUTHOR);
  return Object.fromEntries(Object.entries({
    ...existing,
    ...fragment,
    identifier: mergeIdentifiers(
      existing.identifier,
      [{ system: identity.system, value: identity.value }, ...(fragment.identifier ?? [])],
    ),
    category: mergeCategories(
      existing.category ?? [category(identity.category)],
      fragment.category,
    ),
    medium: existing.medium ?? [{ text: identity.category === ODOS_PATIENT_SMS_CATEGORY ? "SMS" : "Voice call" }],
    note: mergeNotes(existing.note, incomingNotes),
    payload: fragment.payload ?? existing.payload,
    subject: fragment.subject ?? existing.subject,
    sender: fragment.sender ?? existing.sender,
    recipient: fragment.recipient ?? existing.recipient,
    received: existing.received ?? fragment.received,
    sent: existing.sent ?? fragment.sent,
    status: acceptStatus ? fragment.status ?? existing.status : existing.status,
    statusReason: acceptStatus ? fragment.statusReason ?? existing.statusReason : existing.statusReason,
  }).filter(([, value]) => value !== undefined)) as unknown as Communication;
}

async function serializeCommunicationWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = communicationWrites.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  communicationWrites.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (communicationWrites.get(key) === tail) communicationWrites.delete(key);
  }
}

function eventIdentity(kind: TwilioWebhookKind, event: TwilioWebhookEvent) {
  if (kind === "sms-inbound" || kind === "sms-status") {
    return {
      system: ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM,
      value: (event as TwilioInboundWebhookEvent | TwilioStatusWebhookEvent).messageSid,
      category: ODOS_PATIENT_SMS_CATEGORY,
    };
  }
  return {
    system: ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM,
    value: (event as TwilioVoiceWebhookEvent | TwilioRecordingWebhookEvent | TwilioTranscriptionWebhookEvent).callId,
    category: ODOS_PATIENT_CALL_CATEGORY,
  };
}

async function eventFragment(
  fhir: CommsPersistenceFhir,
  kind: TwilioWebhookKind,
  event: TwilioWebhookEvent,
  now: string,
): Promise<Partial<Communication>> {
  switch (kind) {
    case "sms-inbound": {
      const inbound = event as TwilioInboundWebhookEvent;
      const patient = await patientForPhone(fhir, inbound.from);
      return {
        status: "completed",
        ...(patient ? { subject: patientReference(patient), sender: patientReference(patient) } : { sender: phoneReference(inbound.from) }),
        recipient: [phoneReference(inbound.to)],
        received: now,
        payload: [{ contentString: inbound.body }],
        category: [category(ODOS_PATIENT_SMS_INBOUND_CATEGORY)],
      };
    }
    case "sms-status": {
      const status = event as TwilioStatusWebhookEvent;
      return {
        status: communicationStatusForMessage(status.messageStatus),
        statusReason: { text: `Twilio message status: ${status.messageStatus}` },
      };
    }
    case "voice-inbound":
    case "voice-status": {
      const voice = event as TwilioVoiceWebhookEvent;
      const patientPhone = voice.direction === "inbound" ? voice.from : voice.to;
      const patient = patientPhone.startsWith("+") ? await patientForPhone(fhir, patientPhone) : undefined;
      const inbound = voice.direction === "inbound";
      const sender = inbound
        ? patient ? patientReference(patient) : phoneReference(voice.from)
        : phoneReference(voice.from);
      const recipient = inbound
        ? [phoneReference(voice.to)]
        : [patient ? patientReference(patient) : phoneReference(voice.to)];
      return {
        status: communicationStatusForCall(voice.status),
        ...(patient ? { subject: patientReference(patient) } : {}),
        sender,
        recipient,
        ...(kind === "voice-inbound" ? { received: now } : {}),
        category: [category(inbound ? ODOS_PATIENT_CALL_INBOUND_CATEGORY : ODOS_PATIENT_CALL_OUTBOUND_CATEGORY)],
        statusReason: { text: `Twilio call status: ${voice.status}` },
        ...(voice.recordingId ? {
          identifier: [{ system: ODOS_TWILIO_RECORDING_IDENTIFIER_SYSTEM, value: voice.recordingId }],
        } : {}),
        note: [metadataNote(TWILIO_CALL_METADATA_AUTHOR, now, {
          direction: inbound ? "inbound" : "outbound",
          status: voice.status,
          durationSeconds: voice.durationSeconds,
        })],
      };
    }
    case "voice-recording": {
      const recording = event as TwilioRecordingWebhookEvent;
      return {
        identifier: [{ system: ODOS_TWILIO_RECORDING_IDENTIFIER_SYSTEM, value: recording.recordingId }],
        note: [metadataNote(TWILIO_RECORDING_METADATA_AUTHOR, now, {
          status: recording.status,
          durationSeconds: recording.durationSeconds,
          channels: recording.channels,
        })],
      };
    }
    case "voice-transcription": {
      const transcription = event as TwilioTranscriptionWebhookEvent;
      return {
        identifier: [{ system: ODOS_TWILIO_TRANSCRIPTION_IDENTIFIER_SYSTEM, value: transcription.transcriptionId }],
        note: [metadataNote(TWILIO_TRANSCRIPTION_METADATA_AUTHOR, now, {
          event: transcription.event,
          timestamp: transcription.timestamp,
          sequenceId: transcription.sequenceId,
          languageCode: transcription.languageCode,
          track: transcription.track,
          confidence: transcription.confidence,
          final: transcription.final,
        })],
      };
    }
  }
}

async function findCommunication(
  fhir: CommsPersistenceFhir,
  system: string,
  value: string,
): Promise<Communication | undefined> {
  const matches = await findCommunications(fhir, system, value, "2");
  if (matches.length > 1) throw new Error(`Twilio Communication identifier ${value} is not unique.`);
  return matches[0];
}

async function findCommunications(
  fhir: CommsPersistenceFhir,
  system: string,
  value: string,
  count: string,
): Promise<Communication[]> {
  const bundle = await fhir.search<Communication>("Communication", {
    identifier: `${system}|${value}`,
    _count: count,
  });
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

async function patientForPhone(
  fhir: CommsPersistenceFhir,
  phone: string,
): Promise<Patient | undefined> {
  const bundle = await fhir.search<Patient>("Patient", { telecom: phone, _count: "2" });
  const matches = (bundle.entry ?? []).flatMap((entry) => entry.resource?.id ? [entry.resource] : []);
  return matches.length === 1 ? matches[0] : undefined;
}

function patientReference(patient: Patient) {
  return { reference: `Patient/${patient.id}` } as const;
}

function phoneReference(phone: string) {
  return { identifier: { system: ODOS_COMMS_PHONE_IDENTIFIER_SYSTEM, value: phone } };
}

function communicationStatusForMessage(status: string): Communication["status"] {
  if (["delivered", "read"].includes(status)) return "completed";
  if (["failed", "undelivered"].includes(status)) return "not-done";
  if (["accepted", "queued", "sending", "sent", "scheduled"].includes(status)) return "in-progress";
  return "unknown";
}

function communicationStatusForCall(status: TwilioVoiceWebhookEvent["status"]): Communication["status"] {
  if (status === "completed") return "completed";
  if (["busy", "failed", "no-answer", "canceled"].includes(status)) return "not-done";
  return "in-progress";
}

function acceptsIncomingStatus(
  existing: Communication["status"],
  existingReason: Communication["statusReason"],
  incoming: Communication["status"] | undefined,
): boolean {
  if (!incoming) return false;
  if (existing !== "completed" && existing !== "not-done") return true;
  return incoming === existing && existingReason === undefined;
}

function isFhirConflict(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  const message = error instanceof Error ? error.message : String(error);
  return status === 409 || status === 412 || /FHIR (409|412)\b/.test(message);
}

function category(code: string): CodeableConcept {
  return { coding: [{ system: ODOS_COMMS_CATEGORY_SYSTEM, code }] };
}

const MULTI_VALUE_IDENTIFIER_SYSTEMS = new Set([ODOS_TWILIO_RECORDING_IDENTIFIER_SYSTEM]);

function mergeIdentifiers(existing: Identifier[] | undefined, incoming: Identifier[] | undefined): Identifier[] | undefined {
  if (!incoming?.length) return existing;
  const replacedSystems = new Set(incoming.flatMap((identifier) =>
    identifier.system && !MULTI_VALUE_IDENTIFIER_SYSTEMS.has(identifier.system) ? [identifier.system] : []));
  const incomingKeys = new Set(incoming.map((identifier) => `${identifier.system}|${identifier.value}`));
  return [
    ...incoming,
    ...(existing ?? []).filter((identifier) =>
      !replacedSystems.has(identifier.system ?? "")
      && !incomingKeys.has(`${identifier.system}|${identifier.value}`)),
  ];
}

function mergeCategories(existing: CodeableConcept[] | undefined, incoming: CodeableConcept[] | undefined): CodeableConcept[] | undefined {
  if (!incoming?.length) return existing;
  const codes = new Set(incoming.flatMap((concept) => concept.coding ?? []).map((coding) => `${coding.system}|${coding.code}`));
  return [
    ...(existing ?? []).filter((concept) => !concept.coding?.some((coding) => codes.has(`${coding.system}|${coding.code}`))),
    ...incoming,
  ];
}

function mergeNotes(existing: Annotation[] | undefined, incoming: Annotation[] | undefined): Annotation[] | undefined {
  if (!incoming?.length) return existing;
  const authors = new Set(incoming.map((note) => note.authorString));
  return [...(existing ?? []).filter((note) => !authors.has(note.authorString)), ...incoming];
}

function metadataNote(
  authorString: string,
  time: string,
  metadata: Record<string, string | number | boolean | undefined>,
): Annotation {
  return {
    authorString,
    time,
    text: Object.entries(metadata)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join("; "),
  };
}
