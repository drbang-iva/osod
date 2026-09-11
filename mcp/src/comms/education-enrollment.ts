import { createHash, randomUUID } from "node:crypto";
import type { Basic, Bundle, Extension, Resource } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { searchBounded } from "../fhir-search.js";
import { admitEducationSequence, EducationSequenceAdmissionError, assertEducationSequenceAdmissionBudget, validateStoredEducationSequences, applyEducationEnrollmentLifecycle, stopEducationSequence, EDUCATION_SEQUENCE_EXTENSION, EDUCATION_ACTIVATION_EXTENSION, type EducationSequenceInput, type EducationSequenceAdmission, type EducationLifecycleContext, type EducationSequenceStop, type EducationScheduledSend, type EducationSequenceActivation } from "./education-sequence.js";
import type { SendResult } from "./comms-provider.js";

const ENROLLMENT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/education-enrollment-id";
const ACTIVE_ENROLLMENT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/education-enrollment-active";
const BASIC_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/basic-resource-kind";
const ENROLLMENT_CODE = "education-enrollment";
const JOURNEY_ID =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-journey-id";
const JOURNEY_VERSION =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-journey-version";
const CURRENT_STAGE_ID =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-current-stage-id";
const STAGE_ENTERED_AT =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-stage-entered-at";
const ENTERED_FROM_ENCOUNTER =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-entered-from-encounter";
const ENROLLED_BY =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-enrolled-by";
const ENROLLMENT_STATUS =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-status";
const STAGE_HISTORY =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-stage-history";
const IMMEDIATE_SEND =
  "https://odos2020.com/fhir/StructureDefinition/education-enrollment-immediate-send";

export type EducationEnrollmentStatus = "active" | "completed" | "cancelled";
export type EducationEnrollmentSendState = "pending" | "in-flight" | "resolved" | "indeterminate";
export type EducationEnrollmentSendOutcome = SendResult | {
  outcome: "not-sent";
  reason: string;
} | {
  outcome: "print";
  url: string;
};

export interface JourneyDefinitionReference {
  id: string;
  version: number;
}

export interface EducationEnrollmentStageEntry {
  stageId: string;
  enteredAt: string;
  enteredBy: string;
  reason: string;
}

export interface EducationEnrollmentImmediateSend {
  content: { id: string; version: number };
  channel: "sms" | "email" | "print";
  lane: "clinical" | "frontdesk";
  idempotencyKey?: string;
  state?: EducationEnrollmentSendState;
  outcome?: EducationEnrollmentSendOutcome;
  acknowledgement?: {
    reason: string;
    acknowledgedAt: string;
    acknowledgedBy: string;
  };
}

export type EducationEnrollmentImmediateSendInput = Pick<
  EducationEnrollmentImmediateSend,
  "content" | "channel" | "lane"
>;

export interface EducationEnrollment {
  id: string;
  patientReference: string;
  journey: JourneyDefinitionReference;
  currentStageId: string;
  stageEnteredAt: string;
  enteredFromEncounterReference: string;
  enrolledBy: string;
  status: EducationEnrollmentStatus;
  stageHistory: EducationEnrollmentStageEntry[];
  immediateSends: EducationEnrollmentImmediateSend[];
  scheduledSends?: EducationScheduledSend[];
  activations?: EducationSequenceActivation[];
}

export type NewEducationEnrollment = Omit<EducationEnrollment, "id" | "immediateSends"> & {
  immediateSends: EducationEnrollmentImmediateSendInput[];
  sequence?: EducationSequenceInput;
  requestId?: string;
};

export interface EducationEnrollmentTransition {
  fromStageId: string;
  targetStageId: string;
  trigger: string;
  enteredAt: string;
  enteredBy: string;
  status: EducationEnrollmentStatus;
  immediateSends: EducationEnrollmentImmediateSendInput[];
  sequence?: EducationSequenceInput;
  requestId?: string;
}

export interface EducationEnrollmentStore {
  create(enrollment: NewEducationEnrollment): Promise<EducationEnrollment>;
  admitSequence(id: string, admission: EducationSequenceAdmission): Promise<EducationEnrollment>;
  stopSequence(id: string, stop: EducationSequenceStop): Promise<EducationEnrollment>;
  applyLifecycle(id: string, context: EducationLifecycleContext): Promise<EducationEnrollment>;
  read(id: string): Promise<EducationEnrollment | undefined>;
  listActiveForPatient(patientReference: string): Promise<EducationEnrollment[]>;
  claimImmediateSend(
    id: string,
    sendIndex: number,
  ): Promise<{ enrollment: EducationEnrollment; claimed: boolean }>;
  recordImmediateSendOutcome(
    id: string,
    sendIndex: number,
    outcome: EducationEnrollmentSendOutcome,
  ): Promise<EducationEnrollment>;
  transition(
    id: string,
    transition: EducationEnrollmentTransition,
  ): Promise<EducationEnrollment>;
  markImmediateSendIndeterminate(
    id: string,
    sendIndex: number,
    acknowledgement: NonNullable<EducationEnrollmentImmediateSend["acknowledgement"]>,
  ): Promise<EducationEnrollment>;
  clearTerminalActiveIdentifier(id: string): Promise<EducationEnrollment>;
}

export class EducationEnrollmentDuplicateError extends Error {
  constructor() {
    super("An active enrollment already exists for this patient and journey.");
    this.name = "EducationEnrollmentDuplicateError";
  }
}

export class EducationEnrollmentTransitionError extends Error {
  constructor(readonly reason: "enrollment-not-active" | "stale-from-stage" | "pending-reconciliation") {
    super(reason);
    this.name = "EducationEnrollmentTransitionError";
  }
}

export function createInMemoryEducationEnrollmentStore(
  deps: { generateId?: () => string } = {},
): EducationEnrollmentStore {
  const rows = new Map<string, EducationEnrollment>();
  const activeIdentifiers = new Set<string>();
  return {
    async create(input) {
      validateNewEnrollment(input);
      const activeIdentifier = activeEnrollmentIdentifier(input.patientReference, input.journey.id);
      if (activeIdentifiers.has(activeIdentifier)) {
        const existing = [...rows.values()].find(row => row.status === "active" && activeEnrollmentIdentifier(row.patientReference, row.journey.id) === activeIdentifier);
        if (input.sequence && input.requestId && existing?.activations?.some(a => a.requestId === input.requestId)) {
          if (existing.activations!.find(a => a.requestId === input.requestId)!.admissionContext !== enrollmentCreateContext(input))
            throw new EducationSequenceAdmissionError("request-id-conflict");
          const candidate = structuredClone(existing);
          admitEducationSequence(candidate, initialSequenceAdmission(input));
          return candidate;
        }
        throw new EducationEnrollmentDuplicateError();
      }
      const id = deps.generateId?.() ?? randomUUID();
      const row: EducationEnrollment = {
        ...structuredClone(input),
        id,
        immediateSends: input.immediateSends.map((send, index) => ({
          ...structuredClone(send),
          idempotencyKey: enrollmentSendIdempotencyKey(id, index),
          state: "pending",
        })),
      };
      delete (row as Partial<NewEducationEnrollment>).sequence;
      delete (row as Partial<NewEducationEnrollment>).requestId;
      if (input.sequence) { admitEducationSequence(row, initialSequenceAdmission(input)); row.activations!.at(-1)!.admissionContext = enrollmentCreateContext(input); }
      applyEducationEnrollmentLifecycle(row, {actor: input.enrolledBy, at: input.stageEnteredAt, reason: "enrollment-created"});
      if (input.sequence) assertEducationSequenceAdmissionBudget(row);
      rows.set(row.id, row);
      activeIdentifiers.add(activeIdentifier);
      return structuredClone(row);
    },
    async admitSequence(id, admission) {
      const row = rows.get(id); if (!row) throw new Error("EducationEnrollment not found.");
      const candidate = structuredClone(row); admitEducationSequence(candidate, admission); rows.set(id, candidate); return structuredClone(candidate);
    },
    async stopSequence(id, stop) {
      const row = rows.get(id); if (!row) throw new Error("EducationEnrollment not found.");
      const candidate = structuredClone(row); stopEducationSequence(candidate, stop); rows.set(id, candidate); return structuredClone(candidate);
    },
    async applyLifecycle(id, context) {
      const row = rows.get(id); if (!row) throw new Error("EducationEnrollment not found.");
      const candidate = structuredClone(row); applyEducationEnrollmentLifecycle(candidate, context); rows.set(id, candidate); return structuredClone(candidate);
    },
    async read(id) {
      const row = rows.get(id);
      return row ? structuredClone(row) : undefined;
    },
    async listActiveForPatient(patientReference) {
      requiredReference(patientReference, "Patient", "patientReference");
      return [...rows.values()]
        .filter((row) => row.status === "active" && row.patientReference === patientReference)
        .map((row) => structuredClone(row));
    },
    async claimImmediateSend(id, sendIndex) {
      const row = rows.get(id);
      if (!row) throw new Error("EducationEnrollment not found.");
      const send = immediateSend(row, sendIndex);
      if (send.state !== "pending" || row.status !== "active" || row.immediateSends.slice(0, sendIndex).some(s => s.state === "in-flight"))
        return { enrollment: structuredClone(row), claimed: false };
      send.state = "in-flight";
      return { enrollment: structuredClone(row), claimed: true };
    },
    async recordImmediateSendOutcome(id, sendIndex, outcome) {
      const row = rows.get(id);
      if (!row) throw new Error("EducationEnrollment not found.");
      recordOutcome(row, sendIndex, outcome);
      return structuredClone(row);
    },
    async transition(id, transition) {
      const row = rows.get(id);
      if (!row) throw new Error("EducationEnrollment not found.");
      const candidate = structuredClone(row);
      applyTransition(candidate, transition);
      rows.set(id, candidate);
      return structuredClone(candidate);
    },
    async markImmediateSendIndeterminate(id, sendIndex, acknowledgement) {
      const row = rows.get(id);
      if (!row) throw new Error("EducationEnrollment not found.");
      markIndeterminate(row, sendIndex, acknowledgement);
      return structuredClone(row);
    },
    async clearTerminalActiveIdentifier(id) {
      const row = rows.get(id);
      if (!row) throw new Error("EducationEnrollment not found.");
      if (row.status === "active") throw new Error("EducationEnrollment is not terminal.");
      if (row.immediateSends.some((send) => !isReconciled(send))) {
        throw new Error("EducationEnrollment terminal sends are pending reconciliation.");
      }
      activeIdentifiers.delete(activeEnrollmentIdentifier(row.patientReference, row.journey.id));
      return structuredClone(row);
    },
  };
}

export type EducationEnrollmentFhir = Pick<
  MedplumClient,
  "baseUrl" | "search" | "searchUrl" | "create" | "read" | "update"
>;

export function createFhirEducationEnrollmentStore(
  fhir: EducationEnrollmentFhir,
): EducationEnrollmentStore {
  return {
    async create(input) {
      validateNewEnrollment(input);
      const activeIdentifier = activeEnrollmentIdentifier(input.patientReference, input.journey.id);
      const matches = await activeMatches(fhir, activeIdentifier);
      if (matches.length > 0) {
        if (input.sequence && input.requestId && matches[0]?.activations?.some(a => a.requestId === input.requestId)) {
          if (matches[0].activations!.find(a => a.requestId === input.requestId)!.admissionContext !== enrollmentCreateContext(input))
            throw new EducationSequenceAdmissionError("request-id-conflict");
          admitEducationSequence(matches[0], initialSequenceAdmission(input));
          return matches[0];
        }
        throw new EducationEnrollmentDuplicateError();
      }
      const requestId = randomUUID();
      const enrollment: EducationEnrollment = {
        ...structuredClone(input),
        id: requestId,
        immediateSends: input.immediateSends.map((send, index) => ({
          ...structuredClone(send),
          idempotencyKey: enrollmentSendIdempotencyKey(requestId, index),
          state: "pending",
        })),
      };
      delete (enrollment as Partial<NewEducationEnrollment>).sequence;
      delete (enrollment as Partial<NewEducationEnrollment>).requestId;
      if (input.sequence) {
        admitEducationSequence(enrollment, initialSequenceAdmission(input));
        enrollment.activations!.at(-1)!.admissionContext = enrollmentCreateContext(input);
      }
      applyEducationEnrollmentLifecycle(enrollment, {actor: input.enrolledBy, at: input.stageEnteredAt, reason: "enrollment-created"});
      if (input.sequence) assertEducationSequenceAdmissionBudget(enrollment);
      const resource = enrollmentResource(enrollment, activeIdentifier);
      let persisted = await fhir.create<Basic>(resource, {
        "If-None-Exist": `identifier=${ACTIVE_ENROLLMENT_IDENTIFIER_SYSTEM}|${activeIdentifier}`,
      });
      const requestWon = persisted.identifier?.some((identifier) =>
        identifier.system === ENROLLMENT_IDENTIFIER_SYSTEM && identifier.value === requestId);
      if (!requestWon) {
        const winner = parseEnrollment(persisted);
        if (input.sequence && input.requestId && winner.activations?.some(a => a.requestId === input.requestId && a.admissionContext === enrollmentCreateContext(input))) {
          admitEducationSequence(winner, initialSequenceAdmission(input));
          return winner;
        }
        throw new EducationEnrollmentDuplicateError();
      }
      if (persisted.id && persisted.id !== requestId) {
        for (const [index, sendExtension] of (persisted.extension ?? [])
          .filter((entry) => entry.url === IMMEDIATE_SEND).entries()) {
          replaceNestedExtension(sendExtension, "idempotency-key", {
            url: "idempotency-key",
            valueString: enrollmentSendIdempotencyKey(persisted.id, index),
          });
        }
        persisted = await updateEnrollmentResource(fhir, persisted);
      }
      return parseEnrollment(persisted);
    },
    async admitSequence(id, admission) {
      return mutateEnrollment(fhir, id, row => admitEducationSequence(row, admission));
    },
    async stopSequence(id, stop) {
      return mutateEnrollment(fhir, id, row => stopEducationSequence(row, stop));
    },
    async applyLifecycle(id, context) { return mutateEnrollment(fhir, id, row => applyEducationEnrollmentLifecycle(row, context)); },
    async read(id) {
      try {
        return parseEnrollment(await fhir.read<Basic>("Basic", resourceId(id, "enrollment id")));
      } catch (error) {
        if ([404, 410].includes((error as { status?: number })?.status ?? 0)) return undefined;
        throw error;
      }
    },
    async listActiveForPatient(patientReference) {
      requiredReference(patientReference, "Patient", "patientReference");
      const resources = await searchBounded<Basic>(fhir, "Basic", {
        code: `${BASIC_CODE_SYSTEM}|${ENROLLMENT_CODE}`,
        subject: patientReference,
        _count: "100",
      }, { maxPages: 10, maxRows: 1_000 });
      return resources
        .map(parseEnrollment)
        .filter((row) => row.status === "active" && row.patientReference === patientReference);
    },
    async claimImmediateSend(id, sendIndex) {
      const resource = await fhir.read<Basic>("Basic", resourceId(id, "enrollment id"));
      const enrollment = parseEnrollment(resource);
      const send = immediateSend(enrollment, sendIndex);
      if (send.state !== "pending" || enrollment.status !== "active" || enrollment.immediateSends.slice(0, sendIndex).some(s => s.state === "in-flight"))
        return { enrollment, claimed: false };
      replaceNestedExtension(immediateSendResourceExtension(resource, sendIndex), "state", {
        url: "state",
        valueCode: "in-flight",
      });
      try {
        const updated = await fhir.update<Basic>("Basic", resource.id!, resource, {
          ...enrollmentVersionHeaders(resource),
        });
        return { enrollment: parseEnrollment(updated), claimed: true };
      } catch (error) {
        if (!isFhirConflict(error)) throw error;
        return {
          enrollment: parseEnrollment(await fhir.read<Basic>("Basic", resourceId(id, "enrollment id"))),
          claimed: false,
        };
      }
    },
    async recordImmediateSendOutcome(id, sendIndex, outcome) {
      const resource = await fhir.read<Basic>("Basic", resourceId(id, "enrollment id"));
      const enrollment = parseEnrollment(resource);
      const existing = enrollment.immediateSends[sendIndex];
      if (!existing) throw new Error("EducationEnrollment immediate send index is invalid.");
      if (existing.outcome) {
        if (JSON.stringify(existing.outcome) !== JSON.stringify(outcome)) {
          throw new Error("EducationEnrollment immediate send outcome is already recorded.");
        }
        return enrollment;
      }
      if (existing.state !== "in-flight") {
        throw new Error("EducationEnrollment immediate send must be in-flight before recording an outcome.");
      }
      const sendExtension = immediateSendResourceExtension(resource, sendIndex);
      sendExtension.extension = (sendExtension.extension ?? []).filter((entry) =>
        !["state", "outcome", "provider-message-id", "provider-thread-id", "reason", "rescheduled-at", "url"]
          .includes(entry.url));
      sendExtension.extension.push({ url: "state", valueCode: "resolved" }, ...outcomeExtensions(outcome));
      const updated = await updateEnrollmentResource(fhir, resource);
      return parseEnrollment(updated);
    },
    async transition(id, transition) {
      validateTransition(transition);
      const resource = await fhir.read<Basic>("Basic", resourceId(id, "enrollment id"));
      const enrollment = parseEnrollment(resource);
      const before = JSON.stringify(enrollment);
      applyTransition(enrollment, transition);
      if (JSON.stringify(enrollment) === before) return enrollment;
      replaceEnrollmentState(resource, enrollment);
      if (transition.sequence && transition.status === "active") assertEducationSequenceAdmissionBudget(enrollment, resource);
      try {
        return parseEnrollment(await fhir.update<Basic>("Basic", resource.id!, resource, {
          ...enrollmentVersionHeaders(resource),
        }));
      } catch (error) {
        if (isFhirConflict(error)) throw new EducationEnrollmentTransitionError("stale-from-stage");
        throw error;
      }
    },
    async markImmediateSendIndeterminate(id, sendIndex, acknowledgement) {
      const resource = await fhir.read<Basic>("Basic", resourceId(id, "enrollment id"));
      const enrollment = parseEnrollment(resource);
      const send = immediateSend(enrollment, sendIndex);
      if (send.state === "indeterminate") {
        if (JSON.stringify(send.acknowledgement) !== JSON.stringify(acknowledgement)) {
          throw new Error("EducationEnrollment indeterminate acknowledgement is already recorded.");
        }
        return enrollment;
      }
      if (send.state !== "in-flight") {
        throw new Error("Only an in-flight EducationEnrollment send can be acknowledged as indeterminate.");
      }
      const sendExtension = immediateSendResourceExtension(resource, sendIndex);
      replaceNestedExtension(sendExtension, "state", { url: "state", valueCode: "indeterminate" });
      sendExtension.extension = [
        ...(sendExtension.extension ?? []).filter((entry) =>
          !["acknowledgement-reason", "acknowledged-at", "acknowledged-by"].includes(entry.url)),
        { url: "acknowledgement-reason", valueString: acknowledgement.reason },
        { url: "acknowledged-at", valueInstant: acknowledgement.acknowledgedAt },
        { url: "acknowledged-by", valueReference: { reference: acknowledgement.acknowledgedBy } },
      ];
      return parseEnrollment(await updateEnrollmentResource(fhir, resource));
    },
    async clearTerminalActiveIdentifier(id) {
      const resource = await fhir.read<Basic>("Basic", resourceId(id, "enrollment id"));
      const enrollment = parseEnrollment(resource);
      if (enrollment.status === "active") throw new Error("EducationEnrollment is not terminal.");
      if (enrollment.immediateSends.some((send) => !isReconciled(send))) {
        throw new Error("EducationEnrollment terminal sends are pending reconciliation.");
      }
      if (!resource.identifier?.some((identifier) => identifier.system === ACTIVE_ENROLLMENT_IDENTIFIER_SYSTEM)) {
        return enrollment;
      }
      resource.identifier = resource.identifier.filter((identifier) =>
        identifier.system !== ACTIVE_ENROLLMENT_IDENTIFIER_SYSTEM);
      return parseEnrollment(await updateEnrollmentResource(fhir, resource));
    },
  };
}

async function activeMatches(
  fhir: EducationEnrollmentFhir,
  activeIdentifier: string,
): Promise<EducationEnrollment[]> {
  const bundle = await fhir.search<Basic>("Basic", {
    identifier: `${ACTIVE_ENROLLMENT_IDENTIFIER_SYSTEM}|${activeIdentifier}`,
    _count: "2",
  });
  return resources(bundle)
    .filter(isEnrollmentResource)
    .map(parseEnrollment)
    .filter((row) => row.status === "active");
}

export function enrollmentResource(
  enrollment: EducationEnrollment,
  activeIdentifier: string,
): Basic {
  return {
    resourceType: "Basic",
    identifier: [
      { system: ENROLLMENT_IDENTIFIER_SYSTEM, value: enrollment.id },
      { system: ACTIVE_ENROLLMENT_IDENTIFIER_SYSTEM, value: activeIdentifier },
    ],
    code: {
      coding: [{
        system: BASIC_CODE_SYSTEM,
        code: ENROLLMENT_CODE,
        display: "Education enrollment",
      }],
    },
    subject: { reference: enrollment.patientReference },
    created: enrollment.stageEnteredAt.slice(0, 10),
    extension: [
      { url: JOURNEY_ID, valueString: enrollment.journey.id },
      { url: JOURNEY_VERSION, valueInteger: enrollment.journey.version },
      { url: CURRENT_STAGE_ID, valueString: enrollment.currentStageId },
      { url: STAGE_ENTERED_AT, valueInstant: enrollment.stageEnteredAt },
      { url: ENTERED_FROM_ENCOUNTER, valueReference: { reference: enrollment.enteredFromEncounterReference } },
      { url: ENROLLED_BY, valueReference: { reference: enrollment.enrolledBy } },
      { url: ENROLLMENT_STATUS, valueCode: enrollment.status },
      ...enrollment.stageHistory.map(stageHistoryExtension),
      ...enrollment.immediateSends.map(immediateSendExtension),
      ...sequenceExtensions(enrollment),
    ],
  };
}

export function parseEnrollment(resource: Basic): EducationEnrollment {
  if (!isEnrollmentResource(resource)) throw new Error("Basic is not an EducationEnrollment.");
  const id = resource.id ?? extensionStringIdentifier(resource, ENROLLMENT_IDENTIFIER_SYSTEM);
  const patientReference = resource.subject?.reference ?? "";
  const journeyId = extensionValue(resource, JOURNEY_ID, "valueString");
  const journeyVersion = extensionNumber(resource, JOURNEY_VERSION, "valueInteger");
  const currentStageId = extensionValue(resource, CURRENT_STAGE_ID, "valueString");
  const stageEnteredAt = extensionValue(resource, STAGE_ENTERED_AT, "valueInstant");
  const enteredFromEncounterReference = extensionReference(resource, ENTERED_FROM_ENCOUNTER);
  const enrolledBy = extensionReference(resource, ENROLLED_BY);
  const status = extensionValue(resource, ENROLLMENT_STATUS, "valueCode") as EducationEnrollmentStatus;
  const enrollment: EducationEnrollment = {
    id: resourceId(id, "stored enrollment id"),
    patientReference: requiredReference(patientReference, "Patient", "stored patient reference"),
    journey: {
      id: definitionId(journeyId, "stored journey id"),
      version: positiveInteger(journeyVersion, "stored journey version"),
    },
    currentStageId: definitionId(currentStageId, "stored current stage id"),
    stageEnteredAt: instant(stageEnteredAt, "stored stage entered timestamp"),
    enteredFromEncounterReference: requiredReference(
      enteredFromEncounterReference,
      "Encounter",
      "stored entered-from encounter reference",
    ),
    enrolledBy: requiredReference(enrolledBy, "Practitioner", "stored enrolled-by reference"),
    status,
    stageHistory: (resource.extension ?? [])
      .filter((entry) => entry.url === STAGE_HISTORY)
      .map(parseStageHistory),
    immediateSends: (resource.extension ?? [])
      .filter((entry) => entry.url === IMMEDIATE_SEND)
      .map(parseImmediateSend),
  };
  const scheduled = (resource.extension ?? []).filter(e => e.url === EDUCATION_SEQUENCE_EXTENSION);
  const activations = (resource.extension ?? []).filter(e => e.url === EDUCATION_ACTIVATION_EXTENSION);
  if (scheduled.length) enrollment.scheduledSends = scheduled.map(e => JSON.parse(e.valueString ?? "null"));
  if (activations.length) enrollment.activations = activations.map(e => JSON.parse(e.valueString ?? "null"));
  validateEnrollment(enrollment);
  return enrollment;
}

function stageHistoryExtension(entry: EducationEnrollmentStageEntry): Extension {
  return {
    url: STAGE_HISTORY,
    extension: [
      { url: "stage-id", valueString: entry.stageId },
      { url: "entered-at", valueInstant: entry.enteredAt },
      { url: "entered-by", valueReference: { reference: entry.enteredBy } },
      { url: "reason", valueCode: entry.reason },
    ],
  };
}

function immediateSendExtension(send: EducationEnrollmentImmediateSend): Extension {
  return {
    url: IMMEDIATE_SEND,
    extension: [
      { url: "content-id", valueString: send.content.id },
      { url: "content-version", valueInteger: send.content.version },
      { url: "channel", valueCode: send.channel },
      { url: "lane", valueCode: send.lane },
      ...(send.idempotencyKey ? [{ url: "idempotency-key", valueString: send.idempotencyKey }] : []),
      ...(send.state ? [{ url: "state", valueCode: send.state }] : []),
      ...(send.outcome ? outcomeExtensions(send.outcome) : []),
      ...(send.acknowledgement ? [
        { url: "acknowledgement-reason", valueString: send.acknowledgement.reason },
        { url: "acknowledged-at", valueInstant: send.acknowledgement.acknowledgedAt },
        { url: "acknowledged-by", valueReference: { reference: send.acknowledgement.acknowledgedBy } },
      ] : []),
    ],
  };
}

function outcomeExtensions(outcome: EducationEnrollmentSendOutcome): Extension[] {
  return [
    { url: "outcome", valueCode: outcome.outcome },
    ...(outcome.outcome === "sent" ? [
      { url: "provider-message-id", valueString: outcome.providerMessageId },
      ...(outcome.providerThreadId
        ? [{ url: "provider-thread-id", valueString: outcome.providerThreadId }]
        : []),
    ] : []),
    ...(outcome.outcome === "not-sent" ? [{ url: "reason", valueString: outcome.reason }] : []),
    ...(outcome.outcome === "suppressed" ? [{ url: "reason", valueCode: outcome.reason }] : []),
    ...(outcome.outcome === "rescheduled" ? [
      { url: "reason", valueCode: outcome.reason },
      { url: "rescheduled-at", valueInstant: outcome.rescheduledAt },
    ] : []),
    ...(outcome.outcome === "print" ? [{ url: "url", valueUrl: outcome.url }] : []),
  ];
}

function parseStageHistory(extension: Extension): EducationEnrollmentStageEntry {
  return {
    stageId: definitionId(nestedValue(extension, "stage-id", "valueString"), "stored stage history id"),
    enteredAt: instant(nestedValue(extension, "entered-at", "valueInstant"), "stored stage history timestamp"),
    enteredBy: requiredReference(
      nestedReference(extension, "entered-by"),
      "Practitioner",
      "stored stage history actor",
    ),
    reason: definitionId(nestedValue(extension, "reason", "valueCode"), "stored stage history reason"),
  };
}

function parseImmediateSend(extension: Extension): EducationEnrollmentImmediateSend {
  const channel = nestedValue(extension, "channel", "valueCode");
  const lane = nestedValue(extension, "lane", "valueCode");
  const outcomeCode = nestedValue(extension, "outcome", "valueCode", false);
  const idempotencyKey = nestedValue(extension, "idempotency-key", "valueString", false);
  const state = nestedValue(extension, "state", "valueCode", false);
  const acknowledgementReason = nestedValue(extension, "acknowledgement-reason", "valueString", false);
  const send: EducationEnrollmentImmediateSend = {
    content: {
      id: definitionId(nestedValue(extension, "content-id", "valueString"), "stored content id"),
      version: positiveInteger(
        nestedNumber(extension, "content-version", "valueInteger"),
        "stored content version",
      ),
    },
    channel: channel as EducationEnrollmentImmediateSend["channel"],
    lane: lane as EducationEnrollmentImmediateSend["lane"],
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(state ? { state: state as EducationEnrollmentSendState } : outcomeCode ? { state: "resolved" as const } : {}),
    ...(outcomeCode ? { outcome: parseOutcome(extension, outcomeCode) } : {}),
    ...(acknowledgementReason ? {
      acknowledgement: {
        reason: acknowledgementReason,
        acknowledgedAt: nestedValue(extension, "acknowledged-at", "valueInstant"),
        acknowledgedBy: nestedReference(extension, "acknowledged-by"),
      },
    } : {}),
  };
  validateImmediateSend(send);
  return send;
}

function parseOutcome(extension: Extension, code: string): EducationEnrollmentSendOutcome {
  if (code === "not-sent") return { outcome: "not-sent", reason: nestedValue(extension, "reason", "valueString") };
  if (code === "sent") {
    return {
      outcome: "sent",
      providerMessageId: nestedValue(extension, "provider-message-id", "valueString"),
      ...(nestedValue(extension, "provider-thread-id", "valueString", false)
        ? { providerThreadId: nestedValue(extension, "provider-thread-id", "valueString") }
        : {}),
    };
  }
  if (code === "suppressed") {
    const reason = nestedValue(extension, "reason", "valueCode");
    if (reason !== "patient-opt-out" && reason !== "preference-withheld" && reason !== "frequency-cap") {
      throw new Error("Stored EducationEnrollment suppressed reason is invalid.");
    }
    return { outcome: "suppressed", reason };
  }
  if (code === "rescheduled") {
    if (nestedValue(extension, "reason", "valueCode") !== "quiet-hours") {
      throw new Error("Stored EducationEnrollment rescheduled reason is invalid.");
    }
    return {
      outcome: "rescheduled",
      reason: "quiet-hours",
      rescheduledAt: instant(
        nestedValue(extension, "rescheduled-at", "valueInstant"),
        "stored rescheduled timestamp",
      ),
    };
  }
  if (code === "print") {
    return { outcome: "print", url: httpsUrl(nestedValue(extension, "url", "valueUrl")) };
  }
  throw new Error("Stored EducationEnrollment send outcome is invalid.");
}

function validateNewEnrollment(input: NewEducationEnrollment): void {
  validateEnrollment({
    ...input,
    id: "validation-id",
    immediateSends: input.immediateSends.map((send, index) => ({
      ...send,
      idempotencyKey: enrollmentSendIdempotencyKey("validation-id", index),
      state: "pending",
    })),
  });
}

function validateTransition(transition: EducationEnrollmentTransition): void {
  definitionId(transition.fromStageId, "transition from-stage id");
  definitionId(transition.targetStageId, "transition target-stage id");
  definitionId(transition.trigger, "transition trigger");
  instant(transition.enteredAt, "transition entered timestamp");
  requiredReference(transition.enteredBy, "Practitioner", "transition actor");
  if (!["active", "completed", "cancelled"].includes(transition.status)) {
    throw new Error("EducationEnrollment transition status is invalid.");
  }
  for (const send of transition.immediateSends) {
    validateImmediateSendInput(send);
  }
}

function applyTransition(
  enrollment: EducationEnrollment,
  transition: EducationEnrollmentTransition,
): void {
  validateTransition(transition);
  if (transition.sequence && transition.requestId && enrollment.activations?.some(a => a.requestId === transition.requestId)) {
    if (enrollment.activations!.find(a => a.requestId === transition.requestId)!.admissionContext !== enrollmentTransitionContext(transition))
      throw new EducationSequenceAdmissionError("request-id-conflict");
    admitEducationSequence(enrollment, { requestId: transition.requestId, sequence: transition.sequence, authorizedBy: transition.enteredBy, authorizedAt: transition.enteredAt });
    return;
  }
  if (enrollment.status !== "active") {
    throw new EducationEnrollmentTransitionError("enrollment-not-active");
  }
  if (enrollment.currentStageId !== transition.fromStageId) {
    throw new EducationEnrollmentTransitionError("stale-from-stage");
  }
  if (!enrollment.activations?.length && !transition.sequence && transition.status === "active" && enrollment.immediateSends.some((send) => !isReconciled(send))) {
    throw new EducationEnrollmentTransitionError("pending-reconciliation");
  }
  const priorImmediateSendCount = enrollment.immediateSends.length;
  enrollment.currentStageId = transition.targetStageId;
  enrollment.stageEnteredAt = transition.enteredAt;
  enrollment.status = transition.status;
  enrollment.stageHistory.push({
    stageId: transition.targetStageId,
    enteredAt: transition.enteredAt,
    enteredBy: transition.enteredBy,
    reason: transition.trigger,
  });
  applyEducationEnrollmentLifecycle(enrollment, {actor: transition.enteredBy, at: transition.enteredAt, reason: transition.trigger, priorImmediateSendCount});
  if (transition.sequence && transition.status === "active")
    admitEducationSequence(enrollment, { requestId: transition.requestId ?? "", sequence: transition.sequence, authorizedBy: transition.enteredBy, authorizedAt: transition.enteredAt });
  if (transition.sequence && transition.status === "active") enrollment.activations!.at(-1)!.admissionContext = enrollmentTransitionContext(transition);
  const sendStartIndex = enrollment.immediateSends.length;
  enrollment.immediateSends.push(...transition.immediateSends.map((send, index) => ({
    ...structuredClone(send),
    idempotencyKey: enrollmentTransitionSendIdempotencyKey(
      enrollment.id,
      transition.targetStageId,
      sendStartIndex + index,
    ),
    state: "pending" as const,
  })));
  applyEducationEnrollmentLifecycle(enrollment, {actor: transition.enteredBy, at: transition.enteredAt, reason: transition.trigger});
  if (transition.sequence && transition.status === "active") assertEducationSequenceAdmissionBudget(enrollment);
}

function validateEnrollment(enrollment: EducationEnrollment): void {
  resourceId(enrollment.id, "enrollment id");
  requiredReference(enrollment.patientReference, "Patient", "patientReference");
  definitionId(enrollment.journey.id, "journey id");
  positiveInteger(enrollment.journey.version, "journey version");
  definitionId(enrollment.currentStageId, "current stage id");
  instant(enrollment.stageEnteredAt, "stage entered timestamp");
  requiredReference(enrollment.enteredFromEncounterReference, "Encounter", "entered-from encounter reference");
  requiredReference(enrollment.enrolledBy, "Practitioner", "enrolled-by reference");
  if (!["active", "completed", "cancelled"].includes(enrollment.status)) {
    throw new Error("EducationEnrollment status is invalid.");
  }
  if (enrollment.stageHistory.length === 0) {
    throw new Error("EducationEnrollment stage history is required.");
  }
  for (const entry of enrollment.stageHistory) {
    definitionId(entry.stageId, "stage history id");
    instant(entry.enteredAt, "stage history timestamp");
    requiredReference(entry.enteredBy, "Practitioner", "stage history actor");
    definitionId(entry.reason, "stage history reason");
  }
  for (const send of enrollment.immediateSends) validateImmediateSend(send);
  validateStoredEducationSequences(enrollment);
}

function validateImmediateSend(send: EducationEnrollmentImmediateSend): void {
  validateImmediateSendInput(send);
  if (send.idempotencyKey !== undefined && !send.idempotencyKey.trim()) {
    throw new Error("EducationEnrollment immediate-send idempotency key is invalid.");
  }
  if (send.state !== undefined && !["pending", "in-flight", "resolved", "indeterminate"].includes(send.state)) {
    throw new Error("EducationEnrollment immediate-send state is invalid.");
  }
  if (send.state === "resolved" && !send.outcome) {
    throw new Error("Resolved EducationEnrollment immediate send requires an outcome.");
  }
  if (send.outcome && send.state !== "resolved") {
    throw new Error("EducationEnrollment immediate-send outcome requires resolved state.");
  }
  if (send.state === "indeterminate" && !send.acknowledgement) {
    throw new Error("Indeterminate EducationEnrollment immediate send requires acknowledgement.");
  }
  if (send.acknowledgement && send.state !== "indeterminate") {
    throw new Error("EducationEnrollment immediate-send acknowledgement requires indeterminate state.");
  }
  if (send.acknowledgement) {
    nonEmpty(send.acknowledgement.reason, "acknowledgement reason");
    instant(send.acknowledgement.acknowledgedAt, "acknowledgement timestamp");
    requiredReference(send.acknowledgement.acknowledgedBy, "Practitioner", "acknowledgement actor");
  }
}

function validateImmediateSendInput(send: EducationEnrollmentImmediateSendInput): void {
  definitionId(send.content.id, "content id");
  positiveInteger(send.content.version, "content version");
  if (!["sms", "email", "print"].includes(send.channel)) {
    throw new Error("EducationEnrollment immediate-send channel is invalid.");
  }
  if (!["clinical", "frontdesk"].includes(send.lane)) {
    throw new Error("EducationEnrollment immediate-send lane is invalid.");
  }
}

function recordOutcome(
  enrollment: EducationEnrollment,
  sendIndex: number,
  outcome: EducationEnrollmentSendOutcome,
): void {
  const send = enrollment.immediateSends[sendIndex];
  if (!send) throw new Error("EducationEnrollment immediate send index is invalid.");
  if (send.outcome) {
    if (JSON.stringify(send.outcome) !== JSON.stringify(outcome)) {
      throw new Error("EducationEnrollment immediate send outcome is already recorded.");
    }
    return;
  }
  if (send.state !== "in-flight") {
    throw new Error("EducationEnrollment immediate send must be in-flight before recording an outcome.");
  }
  send.outcome = structuredClone(outcome);
  send.state = "resolved";
}

function markIndeterminate(
  enrollment: EducationEnrollment,
  sendIndex: number,
  acknowledgement: NonNullable<EducationEnrollmentImmediateSend["acknowledgement"]>,
): void {
  nonEmpty(acknowledgement.reason, "acknowledgement reason");
  instant(acknowledgement.acknowledgedAt, "acknowledgement timestamp");
  requiredReference(acknowledgement.acknowledgedBy, "Practitioner", "acknowledgement actor");
  const send = immediateSend(enrollment, sendIndex);
  if (send.state === "indeterminate") {
    if (JSON.stringify(send.acknowledgement) !== JSON.stringify(acknowledgement)) {
      throw new Error("EducationEnrollment indeterminate acknowledgement is already recorded.");
    }
    return;
  }
  if (send.state !== "in-flight") {
    throw new Error("Only an in-flight EducationEnrollment send can be acknowledged as indeterminate.");
  }
  send.state = "indeterminate";
  send.acknowledgement = structuredClone(acknowledgement);
}

function immediateSend(enrollment: EducationEnrollment, sendIndex: number): EducationEnrollmentImmediateSend {
  const send = enrollment.immediateSends[sendIndex];
  if (!send) throw new Error("EducationEnrollment immediate send index is invalid.");
  return send;
}

function isReconciled(send: EducationEnrollmentImmediateSend): boolean {
  return send.state === "resolved" || send.state === "indeterminate" || Boolean(send.outcome);
}

function enrollmentSendIdempotencyKey(enrollmentId: string, sendIndex: number): string {
  return `enrollment:${enrollmentId}:stage1:${sendIndex + 1}`;
}

function enrollmentTransitionSendIdempotencyKey(
  enrollmentId: string,
  stageId: string,
  sendIndex: number,
): string {
  return `enrollment:${enrollmentId}:stage:${stageId}:${sendIndex + 1}`;
}

function activeEnrollmentIdentifier(patientReference: string, journeyId: string): string {
  return createHash("sha256")
    .update(`${patientReference}\u0000${journeyId}`)
    .digest("hex");
}

function replaceExtension(resource: Basic, url: string, replacement: Extension): void {
  resource.extension = [
    ...(resource.extension ?? []).filter((extension) => extension.url !== url),
    replacement,
  ];
}

function replaceNestedExtension(extension: Extension, url: string, replacement: Extension): void {
  extension.extension = [
    ...(extension.extension ?? []).filter((entry) => entry.url !== url),
    replacement,
  ];
}

function immediateSendResourceExtension(resource: Basic, sendIndex: number): Extension {
  const extension = resource.extension?.filter((entry) => entry.url === IMMEDIATE_SEND)[sendIndex];
  if (!extension) throw new Error("EducationEnrollment immediate send extension is missing.");
  return extension;
}

function isFhirConflict(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 409 || status === 412;
}

function isEnrollmentResource(resource: Basic): boolean {
  return resource.code.coding?.some((coding) =>
    coding.system === BASIC_CODE_SYSTEM && coding.code === ENROLLMENT_CODE) === true;
}

function resources(bundle: Bundle<Basic>): Basic[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function extensionStringIdentifier(resource: Basic, system: string): string {
  return resource.identifier?.find((identifier) => identifier.system === system)?.value ?? "";
}

function extensionValue(
  resource: Basic,
  url: string,
  field: "valueString" | "valueCode" | "valueInstant",
): string {
  const value = resource.extension?.find((entry) => entry.url === url)?.[field];
  return typeof value === "string" ? value : "";
}

function extensionNumber(resource: Basic, url: string, field: "valueInteger"): number {
  const value = resource.extension?.find((entry) => entry.url === url)?.[field];
  return typeof value === "number" ? value : Number.NaN;
}

function extensionReference(resource: Basic, url: string): string {
  return resource.extension?.find((entry) => entry.url === url)?.valueReference?.reference ?? "";
}

function nestedValue(
  extension: Extension,
  url: string,
  field: "valueString" | "valueCode" | "valueInstant" | "valueUrl",
  required = true,
): string {
  const value = extension.extension?.find((entry) => entry.url === url)?.[field];
  if (typeof value === "string") return value;
  if (!required) return "";
  throw new Error(`Stored EducationEnrollment ${url} is missing.`);
}

function nestedNumber(extension: Extension, url: string, field: "valueInteger"): number {
  const value = extension.extension?.find((entry) => entry.url === url)?.[field];
  return typeof value === "number" ? value : Number.NaN;
}

function nestedReference(extension: Extension, url: string): string {
  return extension.extension?.find((entry) => entry.url === url)?.valueReference?.reference ?? "";
}

function resourceId(value: string, label: string): string {
  if (!/^[A-Za-z0-9.-]{1,64}$/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredReference(value: string, resourceType: "Patient" | "Encounter" | "Practitioner", label: string): string {
  if (!new RegExp(`^${resourceType}/[A-Za-z0-9.-]{1,64}$`).test(value)) {
    throw new Error(`${label} must be ${resourceType}/<id>.`);
  }
  return value;
}

function definitionId(value: string, label: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function instant(value: string, label: string): string {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid.`);
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function httpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Stored EducationEnrollment print URL is invalid.");
  }
  if (url.protocol !== "https:") throw new Error("Stored EducationEnrollment print URL is invalid.");
  return value;
}

function initialSequenceAdmission(input: NewEducationEnrollment): EducationSequenceAdmission {
  return { requestId: input.requestId ?? "", sequence: input.sequence!, authorizedBy: input.enrolledBy, authorizedAt: input.stageEnteredAt };
}
function sequenceExtensions(enrollment: EducationEnrollment): Extension[] {
  return [...(enrollment.activations ?? []).map(a => ({ url: EDUCATION_ACTIVATION_EXTENSION, valueString: JSON.stringify(a) })), ...(enrollment.scheduledSends ?? []).map(row => ({ url: EDUCATION_SEQUENCE_EXTENSION, valueString: JSON.stringify(row) }))];
}
export function replaceEnrollmentState(resource: Basic, enrollment: EducationEnrollment): void {
  const urls = new Set([CURRENT_STAGE_ID, STAGE_ENTERED_AT, ENROLLMENT_STATUS, STAGE_HISTORY, IMMEDIATE_SEND, EDUCATION_SEQUENCE_EXTENSION, EDUCATION_ACTIVATION_EXTENSION]);
  resource.extension = [...(resource.extension ?? []).filter(e => !urls.has(e.url)),
    { url: CURRENT_STAGE_ID, valueString: enrollment.currentStageId }, { url: STAGE_ENTERED_AT, valueInstant: enrollment.stageEnteredAt }, { url: ENROLLMENT_STATUS, valueCode: enrollment.status },
    ...enrollment.stageHistory.map(stageHistoryExtension), ...enrollment.immediateSends.map(immediateSendExtension), ...sequenceExtensions(enrollment)];
}
async function mutateEnrollment(fhir: EducationEnrollmentFhir, id: string, mutate: (row: EducationEnrollment) => void): Promise<EducationEnrollment> {
  const resource = await fhir.read<Basic>("Basic", resourceId(id, "enrollment id"));
  const enrollment = parseEnrollment(resource);
  const before = JSON.stringify(enrollment);
  const priorActivationCount = enrollment.activations?.length ?? 0;
  mutate(enrollment);
  if (JSON.stringify(enrollment) === before)
    return enrollment;
  if (!resource.meta?.versionId)
    throw new Error("EducationEnrollment version is required.");
  replaceEnrollmentState(resource, enrollment);
  if ((enrollment.activations?.length ?? 0) > priorActivationCount)
    assertEducationSequenceAdmissionBudget(enrollment, resource);
  return parseEnrollment(await updateEnrollmentResource(fhir, resource));
}
export async function updateEnrollmentResource(fhir: EducationEnrollmentFhir, resource: Basic): Promise<Basic> {
  try {
    return await fhir.update<Basic>("Basic", resource.id!, resource, enrollmentVersionHeaders(resource));
  } catch (error) {
    if (isFhirConflict(error)) throw new EducationSequenceAdmissionError("stale-enrollment-version");
    throw error;
  }
}
function enrollmentCreateContext(input: NewEducationEnrollment): string {
  return JSON.stringify([input.patientReference, input.journey, input.currentStageId, input.enteredFromEncounterReference, input.enrolledBy, input.status, input.immediateSends]);
}
function enrollmentTransitionContext(input: EducationEnrollmentTransition): string {
  return JSON.stringify([input.fromStageId, input.targetStageId, input.trigger, input.enteredBy, input.status, input.immediateSends]);
}
function enrollmentVersionHeaders(resource: Basic): Record<string, string> {
  if (!resource.meta?.versionId)
    throw new Error("EducationEnrollment version is required.");
  return { "If-Match": `W/"${resource.meta.versionId}"` };
}
