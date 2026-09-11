import type { Basic } from "@medplum/fhirtypes";
import { createHash } from "node:crypto";
import { enrollmentResource, type EducationEnrollment } from "./education-enrollment.js";
// Product ceilings subject to revision; these are not medically validated cadence limits.
export const EDUCATION_SEQUENCE_ACTIVATION_DELIVERY_LIMIT = 64;
export const EDUCATION_SEQUENCE_ENROLLMENT_ROW_LIMIT = 256;
export const EDUCATION_SEQUENCE_ADMISSION_BYTE_LIMIT = 1024 * 1024;
export const EDUCATION_SEQUENCE_ROW_HISTORY_RESERVE_BYTES = 1536;
export const EDUCATION_SEQUENCE_ENROLLMENT_RESERVE_BYTES = 16384;
export const EDUCATION_SEQUENCE_EXTENSION = "https://odos2020.com/fhir/StructureDefinition/education-enrollment-scheduled-send";
export const EDUCATION_ACTIVATION_EXTENSION = "https://odos2020.com/fhir/StructureDefinition/education-enrollment-sequence-activation";
export type EducationSchedulingDisposition = "waiting" | "scheduled" | "held" | "cancelled" | "closed";
export type EducationSchedulingHoldReason = "patient-opt-out" | "preference-withheld" | "patient-seen" | "content-unavailable" | "no-recipient-channel" | "needs-acknowledgement";
export interface EducationSchedulingEvent {
  kind: "started" | "stopped" | "held" | "cancelled" | "rescheduled" | "released";
  actor: string;
  at: string;
  reason: string;
}
export interface EducationSequenceStep {
  stepIndex: number;
  channel: "sms" | "email" | "print";
  lane: "clinical" | "frontdesk";
  content: {
    id: string;
    version: number;
  };
  recipientReference: string;
  plannedAt: string;
  notBefore: string;
  latestUsefulTime: string;
  anchor: "stage-entry" | "predecessor-acceptance";
  offsetDays: number;
  dayInterpretation: "calendar" | "business";
  timezone: string;
  calendar?: {
    id: string;
    version: number;
  };
  predecessorStepIndex?: number;
}
export interface EducationSequenceInput {
  id: string;
  version: number;
  steps: EducationSequenceStep[];
}
export interface EducationSequenceAdmission {
  requestId: string;
  sequence: EducationSequenceInput;
  authorizedAt: string;
  authorizedBy: string;
}
export interface EducationSequenceActivation {
  id: string;
  requestId: string;
  requestFingerprint: string;
  sequence: {
    id: string;
    version: number;
  };
  authorizedBy: string;
  authorizedAt: string;
  admissionContext?: string;
  stageHistorySequence: number;
  status: "active" | "stopped";
  history: EducationSchedulingEvent[];
}
export interface EducationScheduledSend extends EducationSequenceStep {
  id: string;
  activationId: string;
  senderReference: string;
  disposition: EducationSchedulingDisposition;
  holdReason?: EducationSchedulingHoldReason;
  blockedBySendIndices: number[];
  attempts: {
    sendIndex: number;
    attemptKey: string;
    predecessorAttemptKey?: string;
    acceptedAt?: string;
    providerNeverInvoked?: true;
  }[];
  runtime?: {
    effectiveAt?: string;
    reviewedEncounterReferences?: string[];
    clinicianSkip?: { at: string; by: string; reason: string };
  };
  events: EducationSchedulingEvent[];
}
export interface EducationLifecycleContext {
  actor: string;
  at: string;
  reason: string;
  priorImmediateSendCount?: number;
}
export interface EducationSequenceStop extends EducationLifecycleContext {
  activationId: string;
}
export class EducationSequenceAdmissionError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "EducationSequenceAdmissionError"; }
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function educationSequenceRowId(activationId: string, stepIndex: number, channel: EducationSequenceStep["channel"]): string {
  return `education-sequence-row:${hash([activationId, stepIndex, channel])}`;
}
function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new EducationSequenceAdmissionError(`${name}-required`);
}
function reference(value: string, types: string[], name: string): void {
  if (!new RegExp(`^(${types.join("|")})/[A-Za-z0-9.-]{1,64}$`).test(value))
    throw new EducationSequenceAdmissionError(`${name}-invalid`);
}
function keys(value: object, allowed: string[], name: string): void {
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !allowed.includes(key)))
    throw new EducationSequenceAdmissionError(`${name}-unknown-field`);
}
function pinned(value: {
  id: string;
  version: number;
}, name: string): void {
  if (!value || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id) || !Number.isSafeInteger(value.version) || value.version < 1)
    throw new EducationSequenceAdmissionError(`${name}-must-be-pinned`);
}
export function validateEducationSequence(sequence: EducationSequenceInput): void {
  keys(sequence, ["id", "version", "steps"], "sequence");
  pinned({ id: sequence.id, version: sequence.version }, "sequence");
  if (!Array.isArray(sequence.steps) || !sequence.steps.length)
    throw new EducationSequenceAdmissionError("sequence-steps-required");
  const identities = new Set<string>();
  for (const step of sequence.steps) {
    keys(step, ["stepIndex", "channel", "lane", "content", "recipientReference", "plannedAt", "notBefore", "latestUsefulTime", "anchor", "offsetDays", "dayInterpretation", "timezone", "calendar", "predecessorStepIndex"], "step");
    keys(step.content, ["id", "version"], "content");
    if (step.calendar)
      keys(step.calendar, ["id", "version"], "calendar");
    if (!Number.isSafeInteger(step.stepIndex) || step.stepIndex < 0)
      throw new EducationSequenceAdmissionError("step-index-invalid");
    if (!["sms", "email", "print"].includes(step.channel) || !["clinical", "frontdesk"].includes(step.lane))
      throw new EducationSequenceAdmissionError("step-channel-or-lane-invalid");
    const identity = `${step.stepIndex}:${step.channel}`;
    if (identities.has(identity))
      throw new EducationSequenceAdmissionError("duplicate-step-channel");
    identities.add(identity);
    pinned(step.content, "content");
    reference(step.recipientReference, ["Patient", "RelatedPerson"], "recipient");
    for (const field of ["plannedAt", "notBefore", "latestUsefulTime"] as const)
      if (typeof step[field] !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(step[field]) || !Number.isFinite(Date.parse(step[field])))
        throw new EducationSequenceAdmissionError(`${field}-required`);
    if (Date.parse(step.latestUsefulTime) < Date.parse(step.notBefore))
      throw new EducationSequenceAdmissionError("latest-useful-time-before-not-before");
    if (!["stage-entry", "predecessor-acceptance"].includes(step.anchor) || !Number.isSafeInteger(step.offsetDays) || step.offsetDays < 1)
      throw new EducationSequenceAdmissionError("step-anchor-or-offset-invalid");
    if (!["calendar", "business"].includes(step.dayInterpretation))
      throw new EducationSequenceAdmissionError("day-interpretation-invalid");
    text(step.timezone, "timezone");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: step.timezone });
    }
    catch {
      throw new EducationSequenceAdmissionError("timezone-invalid");
    }
    if (step.dayInterpretation === "business")
      pinned(step.calendar!, "calendar");
    else if (step.calendar)
      pinned(step.calendar, "calendar");
    if (step.anchor === "predecessor-acceptance" && (!Number.isSafeInteger(step.predecessorStepIndex) || step.predecessorStepIndex! >= step.stepIndex || !sequence.steps.some(s => s.stepIndex === step.predecessorStepIndex)))
      throw new EducationSequenceAdmissionError("predecessor-step-invalid");
  }
}
export function enrollmentAdmissionBytes(enrollment: EducationEnrollment, resource?: Basic): number {
  return Buffer.byteLength(JSON.stringify(resource ?? enrollmentResource(enrollment, "0".repeat(64))), "utf8") + (enrollment.scheduledSends?.length ?? 0) * EDUCATION_SEQUENCE_ROW_HISTORY_RESERVE_BYTES + EDUCATION_SEQUENCE_ENROLLMENT_RESERVE_BYTES;
}
export function admitEducationSequence(enrollment: EducationEnrollment, admission: EducationSequenceAdmission): void {
  validateEducationSequence(admission.sequence);
  text(admission.requestId, "request-id");
  reference(admission.authorizedBy, ["Practitioner"], "authorizing-practitioner");
  if (!Number.isFinite(Date.parse(admission.authorizedAt)))
    throw new EducationSequenceAdmissionError("authorization-time-invalid");
  const requestFingerprint = hash(canonicalize(admission.sequence));
  const existing = enrollment.activations?.find(a => a.requestId === admission.requestId);
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint)
      throw new EducationSequenceAdmissionError("request-id-conflict");
    return;
  }
  if (enrollment.status !== "active")
    throw new EducationSequenceAdmissionError("enrollment-not-active");
  if (admission.sequence.steps.length > EDUCATION_SEQUENCE_ACTIVATION_DELIVERY_LIMIT)
    throw new EducationSequenceAdmissionError("activation-delivery-limit");
  if ((enrollment.scheduledSends?.length ?? 0) + admission.sequence.steps.length > EDUCATION_SEQUENCE_ENROLLMENT_ROW_LIMIT)
    throw new EducationSequenceAdmissionError("enrollment-row-limit");
  const id = hash([enrollment.id, admission.requestId]);
  const event: EducationSchedulingEvent = { kind: "started", actor: admission.authorizedBy, at: admission.authorizedAt, reason: "sequence-authorized" };
  const activation: EducationSequenceActivation = { id, requestId: admission.requestId, requestFingerprint, sequence: { id: admission.sequence.id, version: admission.sequence.version }, authorizedBy: admission.authorizedBy, authorizedAt: admission.authorizedAt, stageHistorySequence: enrollment.stageHistory.length, status: "active", history: [event] };
  const blockers = enrollment.immediateSends.flatMap((s, i) => s.state === "in-flight" ? [i] : []);
  const scheduled = admission.sequence.steps.map((step): EducationScheduledSend => ({ ...structuredClone(step), id: educationSequenceRowId(id, step.stepIndex, step.channel), activationId: id, senderReference: enrollment.enrolledBy, disposition: blockers.length ? "held" : step.anchor === "predecessor-acceptance" ? "waiting" : "scheduled", ...(blockers.length ? { holdReason: "needs-acknowledgement" as const } : {}), blockedBySendIndices: [...blockers], attempts: [], events: [{ ...event }, ...(blockers.length ? [{ kind: "held" as const, actor: admission.authorizedBy, at: admission.authorizedAt, reason: "needs-acknowledgement" }] : [])] }));
  const candidate = { ...enrollment, activations: [...(enrollment.activations ?? []), activation], scheduledSends: [...(enrollment.scheduledSends ?? []), ...scheduled] };
  if (enrollmentAdmissionBytes(candidate) > EDUCATION_SEQUENCE_ADMISSION_BYTE_LIMIT)
    throw new EducationSequenceAdmissionError("enrollment-admission-byte-limit");
  enrollment.activations = candidate.activations;
  enrollment.scheduledSends = candidate.scheduledSends;
}
export function applyEducationEnrollmentLifecycle(enrollment: EducationEnrollment, context: EducationLifecycleContext): void {
  reference(context.actor, ["Practitioner"], "lifecycle-actor");
  text(context.reason, "lifecycle-reason");
  if (!Number.isFinite(Date.parse(context.at)))
    throw new EducationSequenceAdmissionError("lifecycle-time-invalid");
  for (const activation of enrollment.activations ?? []) {
    if (activation.status === "active" && (enrollment.status !== "active" || activation.stageHistorySequence !== enrollment.stageHistory.length)) {
      activation.status = "stopped";
      activation.history.push({ kind: "stopped", actor: context.actor, at: context.at, reason: context.reason });
    }
    for (const row of (enrollment.scheduledSends ?? []).filter(r => r.activationId === activation.id)) {
      if (activation.status === "stopped" && ["waiting", "scheduled", "held"].includes(row.disposition)) {
        row.disposition = "cancelled";
        delete row.holdReason;
        row.events.push({ kind: "cancelled", actor: context.actor, at: context.at, reason: context.reason });
      }
      if (row.disposition === "held" && row.holdReason === "needs-acknowledgement" && row.blockedBySendIndices.length > 0 && row.blockedBySendIndices.every(i => ["resolved", "indeterminate"].includes(enrollment.immediateSends[i]?.state ?? ""))) {
        row.disposition = row.anchor === "predecessor-acceptance" ? "waiting" : "scheduled";
        delete row.holdReason;
        row.events.push({ kind: "released", actor: context.actor, at: context.at, reason: context.reason });
      }
    }
  }
  for (const [index, send] of enrollment.immediateSends.entries()) {
    const linkedCancelled = (enrollment.scheduledSends ?? []).some(row => row.disposition === "cancelled" && row.attempts.some(a => a.sendIndex === index));
    if (send.state === "pending" && (enrollment.status !== "active" || index < (context.priorImmediateSendCount ?? 0) || linkedCancelled)) {
      send.state = "resolved";
      send.outcome = { outcome: "not-sent", reason: context.reason };
    }
  }
}
export function stopEducationSequence(enrollment: EducationEnrollment, stop: EducationSequenceStop): void {
  const activation = enrollment.activations?.find(a => a.id === stop.activationId);
  if (!activation)
    throw new EducationSequenceAdmissionError("activation-not-found");
  if (activation.status === "active") {
    activation.status = "stopped";
    activation.history.push({ kind: "stopped", actor: stop.actor, at: stop.at, reason: stop.reason });
  }
  applyEducationEnrollmentLifecycle(enrollment, stop);
}
export function validateStoredEducationSequences(enrollment: EducationEnrollment): void {
  const ids = new Set<string>();
  for (const activation of enrollment.activations ?? []) {
    if (!activation || ids.has(activation.id) || !["active", "stopped"].includes(activation.status))
      throw new Error("Stored sequence activation is invalid.");
    ids.add(activation.id);
    pinned(activation.sequence, "stored-sequence");
    reference(activation.authorizedBy, ["Practitioner"], "stored-author");
    if (!Number.isSafeInteger(activation.stageHistorySequence) || activation.stageHistorySequence < 1 || activation.stageHistorySequence > enrollment.stageHistory.length)
      throw new Error("Stored sequence stage occurrence is invalid.");
    text(activation.requestId, "stored-request-id");
    text(activation.requestFingerprint, "stored-request-fingerprint");
    for (const event of activation.history)
      validateEvent(event);
  }
  const rowIds = new Set<string>();
  const boundIndices = new Set<number>();
  const boundKeys = new Set<string>();
  for (const row of enrollment.scheduledSends ?? []) {
    if (!row || !ids.has(row.activationId) || rowIds.has(row.id) || row.id !== educationSequenceRowId(row.activationId, row.stepIndex, row.channel))
      throw new Error("Stored scheduled identity is invalid.");
    rowIds.add(row.id);
    if (row.runtime) {
      keys(row.runtime, ["effectiveAt", "reviewedEncounterReferences", "clinicianSkip"], "stored-worker-runtime");
      if (row.runtime.effectiveAt !== undefined && !Number.isFinite(Date.parse(row.runtime.effectiveAt)))
        throw new Error("Stored worker effective time is invalid.");
      if (row.runtime.clinicianSkip !== undefined) {
        keys(row.runtime.clinicianSkip, ["at", "by", "reason"], "stored-clinician-skip");
        reference(row.runtime.clinicianSkip.by, ["Practitioner"], "stored-skip-clinician");
        text(row.runtime.clinicianSkip.reason, "stored-skip-reason");
        if (typeof row.runtime.clinicianSkip.at !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(row.runtime.clinicianSkip.at) || !Number.isFinite(Date.parse(row.runtime.clinicianSkip.at)) || row.disposition !== "closed") throw new Error("Stored clinician skip is invalid.");
      }
      if (row.runtime.reviewedEncounterReferences !== undefined) {
        if (!Array.isArray(row.runtime.reviewedEncounterReferences)) throw new Error("Stored reviewed encounters are invalid.");
        for (const encounter of row.runtime.reviewedEncounterReferences) reference(encounter, ["Encounter"], "stored-reviewed-encounter");
      }
    }
    if (!["waiting", "scheduled", "held", "cancelled", "closed"].includes(row.disposition))
      throw new Error("Stored scheduling disposition is invalid.");
    if (row.disposition === "held" && !["patient-opt-out", "preference-withheld", "patient-seen", "content-unavailable", "no-recipient-channel", "needs-acknowledgement"].includes(row.holdReason ?? ""))
      throw new Error("Stored scheduling hold reason is invalid.");
    if (row.senderReference !== enrollment.enrolledBy)
      throw new Error("Stored scheduled sender differs from enrolling practitioner.");
    for (const index of row.blockedBySendIndices)
      if (!Number.isSafeInteger(index) || !enrollment.immediateSends[index])
        throw new Error("Stored scheduled blocker is invalid.");
    const earlierAttemptKeys = new Set<string>();
    for (const attempt of row.attempts) {
      if (!Number.isSafeInteger(attempt.sendIndex) || !enrollment.immediateSends[attempt.sendIndex])
        throw new Error("Stored scheduled attempt is invalid.");
      text(attempt.attemptKey, "stored-attempt-key");
      const send = enrollment.immediateSends[attempt.sendIndex];
      if (boundIndices.has(attempt.sendIndex) || boundKeys.has(attempt.attemptKey) || send.idempotencyKey !== attempt.attemptKey
        || send.content.id !== row.content.id || send.content.version !== row.content.version || send.channel !== row.channel || send.lane !== row.lane)
        throw new Error("Stored scheduled attempt binding is invalid.");
      if (attempt.predecessorAttemptKey !== undefined && !earlierAttemptKeys.has(attempt.predecessorAttemptKey))
        throw new Error("Stored scheduled attempt predecessor is invalid.");
      if (attempt.acceptedAt !== undefined && (typeof attempt.acceptedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(attempt.acceptedAt) || !Number.isFinite(Date.parse(attempt.acceptedAt))))
        throw new Error("Stored scheduled attempt acceptance is invalid.");
      if (attempt.providerNeverInvoked !== undefined && (attempt.providerNeverInvoked !== true || attempt.acceptedAt !== undefined))
        throw new Error("Stored scheduled attempt provider proof is invalid.");
      boundIndices.add(attempt.sendIndex);
      boundKeys.add(attempt.attemptKey);
      earlierAttemptKeys.add(attempt.attemptKey);
    }
    for (const event of row.events)
      validateEvent(event);
  }
  for (const activation of enrollment.activations ?? []) {
    const steps = (enrollment.scheduledSends ?? []).filter(row => row.activationId === activation.id).map(({ id, activationId, senderReference, disposition, holdReason, blockedBySendIndices, attempts, events, runtime, ...step }) => step);
    validateEducationSequence({ ...activation.sequence, steps });
  }
}
function validateEvent(event: EducationSchedulingEvent): void {
  if (!event || !["started", "stopped", "held", "cancelled", "rescheduled", "released"].includes(event.kind))
    throw new Error("Stored scheduling event is invalid.");
  reference(event.actor, ["Practitioner"], "stored-event-actor");
  text(event.reason, "stored-event-reason");
  if (!Number.isFinite(Date.parse(event.at)))
    throw new Error("Stored scheduling event timestamp is invalid.");
}
export function assertEducationSequenceAdmissionBudget(enrollment: EducationEnrollment, resource?: Basic): void {
  if (enrollmentAdmissionBytes(enrollment, resource) > EDUCATION_SEQUENCE_ADMISSION_BYTE_LIMIT)
    throw new EducationSequenceAdmissionError("enrollment-admission-byte-limit");
}
