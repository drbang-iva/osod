import { resolvePractitionerReference } from "../authz/practitioner-reference.js";
import { writeCommsPreferences, parsePreferenceWriteInput, parseConsentEvidenceInput, parseEvidenceGapFilters,
  attachCommsConsentEvidence, readCommsPreferences, reportCommsEvidenceGaps, evidenceGapCsv } from "./comms-preferences.js";
import { effectiveCommsPreferences } from "./suppression-gate.js";
import { isFhirConflict } from "../clinical-graph/fhir-conflict.js";
import type { Communication, Condition, Encounter, Patient, Provenance, RelatedPerson } from "@medplum/fhirtypes";
import { randomUUID } from "node:crypto";
import type { Application, Request, Response } from "express";
import { buildOdosAuditEventRow } from "../authz/odosAudit.js";
import {
  PRACTICE_ROLE_IDS,
  resolveDeclaredBusinessActionRole,
  staffHasBusinessAction,
  type BusinessAction,
  type PracticeRoleId,
} from "../authz/roles.js";
import type { FhirAuditRecorder, MedplumClient } from "../fhir-client.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { searchBounded } from "../fhir-search.js";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import {
  COMMS_CHANNEL_ROLES,
  type CommsDispatch,
  type CommsDispatchFhir,
  type CommsChannelRole,
} from "./comms-config.js";
import type { CommsProvider, ConversationSummary } from "./comms-provider.js";
import type { EducationSequenceOperations } from "./education-sequence-operations.js";
import type { EducationCatalogReader, EducationContentItem } from "./education-catalog.js";
import {
  EducationEnrollmentDuplicateError,
  EducationEnrollmentTransitionError,
  type EducationEnrollment,
  type EducationEnrollmentImmediateSend,
  type EducationEnrollmentSendOutcome,
  type EducationEnrollmentStore,
} from "./education-enrollment.js";
import { EducationSequenceAdmissionError, validateEducationSequence, type EducationSequenceInput } from "./education-sequence.js";
import { generateTrackedLink, type TrackedLinkStore } from "./tracked-links.js";
import {
  ODOS_COMMS_CATEGORY_SYSTEM,
  ODOS_COMMS_PROVIDER_MESSAGE_IDENTIFIER_SYSTEM,
  ODOS_PATIENT_EMAIL_CATEGORY,
  ODOS_PATIENT_EMAIL_OUTBOUND_CATEGORY,
  ODOS_PATIENT_CALL_CATEGORY,
  ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM,
  ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM,
  ODOS_TWILIO_RECORDING_IDENTIFIER_SYSTEM,
  findStaffSmsSend,
  findStaffSend,
  staffSmsTerminalResult,
  persistStaffSentSend,
  persistStaffSentSms,
  persistStaffTerminalOutcome,
  persistStaffSmsTerminalOutcome,
  reserveStaffSmsSend,
  reserveStaffSend,
} from "./comms-persistence.js";
import {
  clearPatientSmsOptOut,
  recordPatientSmsOptOut,
  hasRecordedMarketingConsent,
  readPatientSmsOptOut,
  SMS_OPT_OUT_IDENTITY_VERIFICATION_METHODS,
  type SmsOptOutIdentityVerification,
  type SmsOptOutManagementFhir,
} from "./suppression-gate.js";

export type CommsStaff = Omit<AuthenticatedStaff, "actorRole" | "roles" | "fhir"> & {
  actorRole: PracticeRoleId;
  roles: readonly PracticeRoleId[];
  authorizationPolicyUrl?: string;
  fhir: MedplumClient;
};

export interface CommsApiRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<CommsStaff | null>;
  fhir: SmsOptOutManagementFhir;
  dispatch: CommsDispatch;
  educationCatalog: EducationCatalogReader;
  enrollmentStore?: EducationEnrollmentStore;
  sequenceOperations?: EducationSequenceOperations;
  trackedLinkStore: TrackedLinkStore;
  publicBaseUrl: string;
  practiceName: string;
  chartDispatchLane?: "locked_clinical" | "staff_switchable";
  audit: FhirAuditRecorder;
  now?: () => string;
}

class CommsApiValidationError extends Error {}
class CommsPreferencePermissionError extends Error {}
class CommsApiCapabilityError extends Error {}
class PendingEducationReconciliationError extends CommsApiCapabilityError {}
class CommsApiNotFoundError extends Error {}
class CommsApiRefusalError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
class CommsProviderTimeoutError extends Error {}

type CommsApiResult =
  | { status: number; body: unknown }
  | { status: number; media: { contentType: string; bytes: Uint8Array }; headers?: Record<string, string> };

const MAX_CALL_HISTORY_WINDOW = 1_000;
const MAX_CONVERSATIONS_PER_PROVIDER = 100;
const CONVERSATION_PROVIDER_TIMEOUT_MS = 10_000;
export { ODOS_COMMS_MARKETING_CONSENT_EXTENSION_URL } from "./suppression-gate.js";
const ODOS_COMMS_EDUCATION_SEND_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-education-send";
const ODOS_COMMS_EDUCATION_ENROLLMENT_EVENT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-education-enrollment-event";

interface ConversationProviderError {
  provider: string;
  code: "conversation-list-timeout" | "conversation-list-unavailable";
}

interface ListedProviderConversations {
  provider: string;
  adapter: CommsProvider;
  conversations: ConversationSummary[];
}

export function registerCommsApiRoutes(
  app: Pick<Application, "get" | "post" | "put">,
  deps: CommsApiRouteDeps,
): void {
  app.get("/communications/education/sequence-work", async (req, res) => withStaff(
    req, res, deps, "communications.read", "Task", "communications-education-sequence-work-list", undefined,
    async (staff) => {
      if (!deps.sequenceOperations) throw new CommsApiCapabilityError("Education sequence operations are not configured.");
      const items = await deps.sequenceOperations.list();
      return { status: 200, body: { items: staff.roles.includes("provider") ? items : items.map(item => ({ ...item, allowedActions: [] })) } };
    },
  ));
  app.post("/communications/education/enrollments/:enrollmentId/scheduled-sends/:rowId/review", async (req, res) => withStaff(
    req, res, deps, "communications.send", "Basic", "communications-education-sequence-review", undefined,
    async (staff) => {
      if (!deps.sequenceOperations) throw new CommsApiCapabilityError("Education sequence operations are not configured.");
      if (!staff.roles.includes("provider")) throw new CommsApiRefusalError("practitioner-review-required");
      const body = record(req.body);
      if (body.action !== "skip" && body.action !== "resume") throw new CommsApiValidationError("Review action must be skip or resume.");
      const result = await deps.sequenceOperations.review(
        resourceKey(req.params.enrollmentId, "enrollment id"),
        requiredText(req.params.rowId, "scheduled row id", 128),
        {
          action: body.action,
          reason: requiredText(body.reason, "review reason", 1000),
          expectedVersion: requiredText(body.expectedVersion, "enrollment version", 128),
          actorReference: staff.staffReference,
          ...(body.reviewedEncounterReference !== undefined ? { reviewedEncounterReference: requiredText(body.reviewedEncounterReference, "reviewed encounter", 128) } : {}),
        }, staff.fhir,
      );
      return { status: 200, body: result };
    },
  ));
  app.get("/communications/education", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.read",
    "Basic",
    "communications-education-list",
    undefined,
    async () => {
      const dxCode = educationDxCodeFromQuery(req);
      const channel = educationChannelFromQuery(req);
      const items = deps.educationCatalog.list().filter((item) =>
        item.audience === "patient"
        && (!dxCode || item.dxCodes.includes(dxCode))
        && (!channel || item.channels.includes(channel)));
      return {
        status: 200,
        body: {
          items,
          chartDispatchLane: deps.chartDispatchLane ?? "staff_switchable",
          availableChannels: {
            clinicalSms: isRoleConfigured(deps.dispatch, "clinical-sms", true),
            frontdeskSms: isRoleConfigured(deps.dispatch, "transactional-sms", true),
            email: isRoleConfigured(deps.dispatch, "email", false),
            print: true,
          },
        },
      };
    },
  ));

  app.get("/communications/education/enrollments", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.read",
    "Basic",
    "communications-education-enrollment-list",
    optOutPatientReferenceForAudit(req),
    async (staff) => {
      const patientReference = requiredPatientReference(queryString(req, "patient"));
      await readPatient(staff.fhir, patientReference);
      return {
        status: 200,
        body: {
          enrollments: await enrollmentStore(deps).listActiveForPatient(patientReference),
        },
      };
    },
  ));

  app.get("/communications/education/enrollments/:enrollmentId", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.read",
    "Basic",
    "communications-education-enrollment-read",
    undefined,
    async (staff) => {
      const enrollment = await enrollmentStore(deps).read(
        resourceKey(req.params.enrollmentId, "enrollment id"),
      );
      if (!enrollment) throw new CommsApiNotFoundError("Education enrollment not found.");
      await readPatient(staff.fhir, enrollment.patientReference);
      return { status: 200, body: { enrollment } };
    },
  ));

  app.post("/communications/education/enrollments/:enrollmentId/transitions", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.send",
    "Basic",
    "communications-education-enrollment-transition",
    undefined,
    async (staff) => {
      const body = educationEnrollmentTransitionBody(req.body);
      const store = enrollmentStore(deps);
      const enrollmentId = resourceKey(req.params.enrollmentId, "enrollment id");
      const existing = await store.read(enrollmentId);
      if (!existing) throw new CommsApiNotFoundError("Education enrollment not found.");
      const patient = await readPatient(staff.fhir, existing.patientReference);
      await assertEncounterBelongsToPatient(
        staff.fhir,
        existing.enteredFromEncounterReference,
        existing.patientReference,
      );
      for (const send of body.targetStage.immediateSends) {
        const item = deps.educationCatalog.get(send.educationId, send.version);
        if (!item || item.audience !== "patient") {
          throw new CommsApiNotFoundError("Education content not found.");
        }
        if (!item.channels.includes(send.channel)) {
          throw new CommsApiCapabilityError(`Education content is not published for ${send.channel}.`);
        }
      }
      await validateSequenceAdmission(deps, staff, patient, body.targetStage.sequence);
      const sendStartIndex = existing.immediateSends.length;
      let enrollment: EducationEnrollment;
      try {
        enrollment = await store.transition(enrollmentId, {
          requestId: body.requestId,
          sequence: body.targetStage.sequence,
          fromStageId: body.fromStageId,
          targetStageId: body.targetStage.id,
          trigger: body.trigger,
          enteredAt: deps.now?.() ?? new Date().toISOString(),
          enteredBy: staff.staffReference,
          status: body.status,
          immediateSends: body.targetStage.immediateSends.map((send) => ({
            content: { id: send.educationId, version: send.version },
            channel: send.channel,
            lane: send.lane,
          })),
        });
      } catch (error) {
        if (error instanceof EducationEnrollmentTransitionError) {
          throw new CommsApiRefusalError(error.reason);
        }
        throw error;
      }
      enrollment = await enforceEducationLifecycle(deps, staff, enrollment);
      // Fail closed: committed sends stay resumable; never replace their key or release a terminal lock early.
      await persistEducationEnrollmentTransitionProvenance(staff.fhir, {
        enrollment,
        fromStageId: body.fromStageId,
        trigger: body.trigger,
        staff,
        now: deps.now?.() ?? new Date().toISOString(),
      });
      for (let sendIndex = sendStartIndex; sendIndex < enrollment.immediateSends.length; sendIndex += 1) {
        enrollment = await dispatchEnrollmentSend(deps, staff, patient, store, enrollment, sendIndex);
      }
      if (body.status !== "active" && enrollment.immediateSends.every(send => send.state === "resolved" || send.state === "indeterminate" || send.outcome)) {
        // Fail closed: committed sends stay resumable; never replace their key or release a terminal lock early.
        enrollment = await store.clearTerminalActiveIdentifier(enrollment.id);
      }
      return { status: 200, body: { enrollment } };
    },
  ));

  app.post("/communications/education/enrollments/:enrollmentId/resume", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.send",
    "Basic",
    "communications-education-enrollment-resume",
    undefined,
    async (staff) => {
      const body = educationEnrollmentResumeBody(req.body);
      const store = enrollmentStore(deps);
      const enrollmentId = resourceKey(req.params.enrollmentId, "enrollment id");
      let enrollment = await store.read(enrollmentId);
      if (!enrollment) throw new CommsApiNotFoundError("Education enrollment not found.");
      const patient = await readPatient(staff.fhir, enrollment.patientReference);
      await assertEncounterBelongsToPatient(
        staff.fhir,
        enrollment.enteredFromEncounterReference,
        enrollment.patientReference,
      );
      enrollment = await enforceEducationLifecycle(deps, staff, enrollment);
      await persistEducationEnrollmentEventProvenances(staff.fhir, enrollment, staff);
      for (let sendIndex = 0; sendIndex < enrollment.immediateSends.length; sendIndex += 1) {
        const send = enrollment.immediateSends[sendIndex]!;
        if (send.state === "resolved" || send.state === "indeterminate" || send.outcome) continue;
        if (body.acknowledgeIndeterminate && send.state === "in-flight") {
          enrollment = await acknowledgeOrRefuseIndeterminateSend(
            staff.fhir, store, enrollment, sendIndex, body, staff,
            deps.now?.() ?? new Date().toISOString(),
          );
          continue;
        }
        if (!send.idempotencyKey) {
          enrollment = await acknowledgeOrRefuseIndeterminateSend(
            staff.fhir,
            store,
            enrollment,
            sendIndex,
            body,
            staff,
            deps.now?.() ?? new Date().toISOString(),
          );
          continue;
        }
        try {
          enrollment = await dispatchEnrollmentSend(deps, staff, patient, store, enrollment, sendIndex);
        } catch (error) {
          if (!(error instanceof PendingEducationReconciliationError)) throw error;
          enrollment = await acknowledgeOrRefuseIndeterminateSend(
            staff.fhir,
            store,
            enrollment,
            sendIndex,
            body,
            staff,
            deps.now?.() ?? new Date().toISOString(),
          );
        }
      }
      enrollment = await enforceEducationLifecycle(deps, staff, enrollment);
      if (enrollment.status !== "active") {
        // Fail closed: committed sends stay resumable; never replace their key or release a terminal lock early.
        enrollment = await store.clearTerminalActiveIdentifier(enrollment.id);
      }
      return { status: 200, body: { enrollment } };
    },
  ));

  app.post("/communications/education/enrollments/:enrollmentId/sequences", async (req, res) => withStaff(
    req, res, deps, "communications.send", "Basic", "communications-education-sequence-admission", undefined,
    async (staff) => {
      const body = record(req.body);
      const sequence = sequenceFromBody(body.sequence);
      if (!sequence) throw new CommsApiValidationError("sequence is required.");
      const store = enrollmentStore(deps);
      const id = resourceKey(req.params.enrollmentId, "enrollment id");
      const existing = await store.read(id);
      if (!existing) throw new CommsApiNotFoundError("Education enrollment not found.");
      const patient = await readPatient(staff.fhir, existing.patientReference);
      await validateSequenceAdmission(deps, staff, patient, sequence);
      const enrollment = await store.admitSequence(id, {
        requestId: idempotencyKeyFromBody(body.requestId), sequence,
        authorizedAt: deps.now?.() ?? new Date().toISOString(), authorizedBy: staff.staffReference,
      });
      return { status: 200, body: { enrollment } };
    },
  ));

  app.post("/communications/education/enrollments/:enrollmentId/sequences/:activationId/stop", async (req, res) => withStaff(
    req, res, deps, "communications.send", "Basic", "communications-education-sequence-stop", undefined,
    async (staff) => {
      const body = record(req.body);
      const store = enrollmentStore(deps);
      const id = resourceKey(req.params.enrollmentId, "enrollment id");
      const existing = await store.read(id);
      if (!existing) throw new CommsApiNotFoundError("Education enrollment not found.");
      await readPatient(staff.fhir, existing.patientReference);
      const enrollment = await store.stopSequence(id, {
        activationId: requiredText(req.params.activationId, "activation id", 128),
        actor: staff.staffReference, at: deps.now?.() ?? new Date().toISOString(), reason: requiredText(body.reason, "reason", 1000),
      });
      return { status: 200, body: { enrollment } };
    },
  ));

  app.post("/communications/education/enrollments", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.send",
    "Basic",
    "communications-education-enrollment-create",
    patientReferenceFromBody(req.body),
    async (staff) => {
      const body = educationEnrollmentBody(req.body);
      const patient = await readPatient(staff.fhir, body.patientReference);
      await assertEncounterBelongsToPatient(
        staff.fhir,
        body.encounterReference,
        body.patientReference,
      );
      for (const send of body.initialStage.immediateSends) {
        const item = deps.educationCatalog.get(send.educationId, send.version);
        if (!item || item.audience !== "patient") {
          throw new CommsApiNotFoundError("Education content not found.");
        }
        if (!item.channels.includes(send.channel)) {
          throw new CommsApiCapabilityError(`Education content is not published for ${send.channel}.`);
        }
      }
      const store = enrollmentStore(deps);
      await validateSequenceAdmission(deps, staff, patient, body.initialStage.sequence);
      const duplicates = await store.listActiveForPatient(body.patientReference);
      if (!body.initialStage.sequence && duplicates.some((enrollment) => enrollment.journey.id === body.journey.id)) {
        throw new CommsApiRefusalError("duplicate-active-enrollment");
      }
      let enrollment: EducationEnrollment;
      try {
        const enrolledAt = deps.now?.() ?? new Date().toISOString();
        enrollment = await store.create({
          requestId: body.requestId,
          sequence: body.initialStage.sequence,
          patientReference: body.patientReference,
          journey: body.journey,
          currentStageId: body.initialStage.id,
          stageEnteredAt: enrolledAt,
          enteredFromEncounterReference: body.encounterReference,
          enrolledBy: staff.staffReference,
          status: "active",
          stageHistory: [{
            stageId: body.initialStage.id,
            enteredAt: enrolledAt,
            enteredBy: staff.staffReference,
            reason: "enrollment-recorded",
          }],
          immediateSends: body.initialStage.immediateSends.map((send) => ({
            content: { id: send.educationId, version: send.version },
            channel: send.channel,
            lane: send.lane,
          })),
        });
      } catch (error) {
        if (error instanceof EducationEnrollmentDuplicateError) {
          throw new CommsApiRefusalError("duplicate-active-enrollment");
        }
        throw error;
      }
      if (enrollment.patientReference !== body.patientReference) {
        throw new Error("EducationEnrollment store returned a different patient.");
      }
      enrollment = await enforceEducationLifecycle(deps, staff, enrollment);
      // Fail closed: committed sends stay resumable; never replace their key or release a terminal lock early.
      await persistEducationEnrollmentProvenance(staff.fhir, {
        enrollment,
        staff,
        now: deps.now?.() ?? new Date().toISOString(),
      });
      for (let sendIndex = 0; sendIndex < enrollment.immediateSends.length; sendIndex += 1) {
        enrollment = await dispatchEnrollmentSend(deps, staff, patient, store, enrollment, sendIndex);
      }
      return { status: 201, body: { enrollment } };
    },
  ));

  app.get("/communications/education/:educationId", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.read",
    "Basic",
    "communications-education-read",
    undefined,
    async () => {
      const id = resourceKey(req.params.educationId, "education id");
      const version = numberFromQuery(req, "version", 1, Number.MAX_SAFE_INTEGER);
      const item = deps.educationCatalog.get(id, version);
      if (!item || item.audience !== "patient") {
        throw new CommsApiNotFoundError("Education content not found.");
      }
      return { status: 200, body: { item } };
    },
  ));

  app.post("/communications/education/dispatch", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.send",
    "Communication",
    "communications-education-dispatch",
    patientReferenceFromBody(req.body),
    async (staff) => {
      const body = educationDispatchBody(req.body);
      const patientId = body.patientReference.slice("Patient/".length);
      const patient = await staff.fhir.read<Patient>("Patient", patientId);
      if (body.idempotencyKey.startsWith("education-sequence-")) {
        throw new CommsApiRefusalError(body.channel === "print" ? "print-sequence-electronic-dispatch-refused" : "sequence-dispatch-not-enabled");
      }
      const context = record(req.body);
      if (context.enrollmentId !== undefined) {
        const enrollment = await enrollmentStore(deps).read(resourceKey(requiredText(context.enrollmentId, "enrollment id", 64), "enrollment id"));
        if (!enrollment || enrollment.patientReference !== body.patientReference) throw new CommsApiNotFoundError("Education enrollment not found.");
        await enforceEducationLifecycle(deps, staff, enrollment);
        throw new CommsApiRefusalError(body.channel === "print" ? "print-sequence-electronic-dispatch-refused" : "sequence-dispatch-not-enabled");
      }
      await enforceEducationLifecycle(deps, staff);
      return { status: 200, body: await dispatchEducation(deps, staff, patient, body) };
    },
  ));

  app.get("/communications/preferences", async (req, res) => withStaff(
    req, res, deps, "communications.read", "Patient", "communications-preferences-read",
    patientReferenceForAudit(req), async staff => {
      const patientReference = requiredPatientReference(queryString(req, "patient"));
      return { status: 200, body: await preferenceAccess(() => readCommsPreferences(staff.fhir, patientReference)) };
    },
  ));
  app.put("/communications/preferences", async (req, res) => withStaff(
    req, res, deps, "communications.preferences.manage", "Patient", "communications-preferences-write",
    patientReferenceFromBody(req.body), async staff => {
      const now = deps.now?.() ?? new Date().toISOString();
      const input = validatedPreferenceInput(() => parsePreferenceWriteInput(req.body, now));
      const actorReference = await preferencePractitioner(staff);
      await preferenceAccess(() => writeCommsPreferences(staff.fhir, input.patientReference, input.cells, {
        actorReference, actorRole: staff.actorRole, policyUrl: staff.authorizationPolicyUrl,
        recordedAt: now, surface: "staff-demographics",
      }, input));
      return { status: 200, body: await preferenceAccess(() => readCommsPreferences(staff.fhir, input.patientReference)) };
    },
  ));
  app.post("/communications/consent-evidence", async (req, res) => withStaff(
    req, res, deps, "communications.preferences.manage", "Consent", "communications-consent-evidence",
    patientReferenceFromBody(req.body), async staff => {
      const now = deps.now?.() ?? new Date().toISOString();
      const input = validatedPreferenceInput(() => parseConsentEvidenceInput(req.body, now));
      const actorReference = await preferencePractitioner(staff);
      await preferenceAccess(() => attachCommsConsentEvidence(staff.fhir, input, {
        actorReference, actorRole: staff.actorRole, policyUrl: staff.authorizationPolicyUrl,
        recordedAt: now, surface: "staff-demographics",
      }));
      return { status: 200, body: await preferenceAccess(() => readCommsPreferences(staff.fhir, input.patientReference)) };
    },
  ));
  app.get("/communications/preferences/evidence-gaps", async (req, res) => withStaff(
    req, res, deps, "communications.preferences.manage", "Consent", "communications-evidence-gaps", undefined,
    async staff => {
      const filters = validatedPreferenceInput(() => parseEvidenceGapFilters(req.query, staff.fhir.baseUrl));
      const report = await preferenceAccess(() => reportCommsEvidenceGaps(staff.fhir, filters));
      return filters.format === "csv" ? {
        status: 200, media: { contentType: "text/csv", bytes: Buffer.from(evidenceGapCsv(report)) },
        headers: { "X-ODOS-Truncated": String(report.truncated), ...(report.cursor ? { "X-ODOS-Cursor": report.cursor } : {}) },
      } : { status: 200, body: report };
    },
  ));

  app.get("/communications/opt-out", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.optout.manage",
    "Patient",
    "communications-opt-out-read",
    optOutPatientReferenceForAudit(req),
    async (staff) => {
      const patientReference = requiredPatientReference(queryString(req, "patient"));
      return { status: 200, body: await patientSmsOptOutState(staff.fhir, deps.dispatch, patientReference) };
    },
  ));

  app.post("/communications/opt-out/record", async (req, res) => withStaff(
    req, res, deps,
    "communications.optout.manage", "Patient", "communications-opt-out-record",
    patientReferenceFromBody(req.body),
    async (staff) => {
      const body = optOutRecordBody(req.body);
      try {
        const state = await recordPatientSmsOptOut(staff.fhir, body.patientReference, {
          ...body,
          actorReference: staff.staffReference,
          actorRole: staff.actorRole,
          policyUrl: staff.authorizationPolicyUrl,
          recordedAt: deps.now?.() ?? new Date().toISOString(),
        });
        return { status: 200, body: { ...state, smsLanes: configuredSmsLanes(deps.dispatch) } };
      } catch (error) {
        if (isFhirNotFound(error)) throw new CommsApiNotFoundError("Patient not found.");
        throw error;
      }
    },
  ));

  app.post("/communications/opt-out/clear", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.optout.manage",
    "Patient",
    "communications-opt-out-clear",
    patientReferenceFromBody(req.body),
    async (staff) => {
      const body = optOutClearBody(req.body);
      return {
        status: 200,
        body: await clearNamedPatientSmsOptOut(staff.fhir, deps, body, staff),
      };
    },
  ));

  app.get("/communications/conversations", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.read",
    "Communication",
    "communications-conversation-list",
    patientReferenceForAudit(req),
    async (staff) => {
      const patientReference = patientReferenceFromQuery(req);
      const conversationId = conversationIdFromQuery(req);
      const limit = numberFromQuery(req, "limit", 1, 100) ?? 50;
      const explicitProvider = explicitProviderFromQuery(req);
      const providerNames = explicitProvider
        ? [explicitProvider]
        : routedProviderNames(deps.dispatch);
      if (providerNames.length === 0) {
        throw new CommsApiCapabilityError("Conversation history is not configured for this practice.");
      }
      const includeContent = staffHasBusinessAction(staff, "communications.content.read");
      const listRequest = {
        ...(patientReference ? { patientReference } : {}),
        limit: MAX_CONVERSATIONS_PER_PROVIDER,
        includeContent,
      };
      let listedProviders: ListedProviderConversations[];
      let providerErrors: ConversationProviderError[] = [];
      if (explicitProvider) {
        const provider = adapter(deps, explicitProvider, staff.fhir);
        if (!provider.listConversations) {
          throw new CommsApiCapabilityError("Conversation history is not enabled for this communications provider.");
        }
        listedProviders = [{
          provider: explicitProvider,
          adapter: provider,
          conversations: await withConversationProviderTimeout(() => provider.listConversations!(listRequest)),
        }];
      } else {
        const results = await Promise.all(providerNames.map(async (providerName) => {
          try {
            const provider = adapter(deps, providerName, staff.fhir);
            if (!provider.listConversations) return { kind: "skipped" as const };
            return {
              kind: "listed" as const,
              value: {
                provider: providerName,
                adapter: provider,
                conversations: await withConversationProviderTimeout(() => provider.listConversations!(listRequest)),
              },
            };
          } catch (error) {
            return {
              kind: "error" as const,
              error: {
                provider: providerName,
                code: error instanceof CommsProviderTimeoutError
                  ? "conversation-list-timeout" as const
                  : "conversation-list-unavailable" as const,
              },
            };
          }
        }));
        listedProviders = results.flatMap((result) => result.kind === "listed" ? [result.value] : []);
        providerErrors = results.flatMap((result) => result.kind === "error" ? [result.error] : []);
      }
      let conversations: ConversationSummary[] = listedProviders
        .flatMap(({ provider, conversations: rows }) => rows.map((conversation) => ({
          ...conversation,
          provider,
        })))
        .sort(compareConversationActivity);
      let selectedConversation: ConversationSummary | undefined;
      if (conversationId) {
        const matches = conversations.filter((conversation) => conversation.id === conversationId);
        if (matches.length === 0) {
          if (providerErrors.length === 0) throw new CommsApiNotFoundError("Conversation not found.");
        }
        if (matches.length > 1) {
          throw new CommsApiValidationError("Conversation id is ambiguous; specify its provider.");
        }
        if (matches.length === 1) {
          selectedConversation = matches[0];
          const selectedProvider = listedProviders.find(({ provider }) =>
            provider === selectedConversation!.provider)!.adapter;
          if (includeContent && selectedProvider.getConversationMessages) {
            selectedConversation = {
              ...selectedConversation,
              messages: await selectedProvider.getConversationMessages(conversationId, { includeContent: true }),
            };
            conversations = conversations.map((conversation) =>
              sameConversation(conversation, selectedConversation!) ? selectedConversation! : conversation);
          } else if (includeContent && selectedConversation.messages.length === 0) {
            throw new CommsApiCapabilityError("Conversation thread history is not enabled for this communications provider.");
          }
        }
      }
      conversations = limitConversations(conversations, limit, selectedConversation);
      return {
        status: 200,
        body: {
          conversations: includeContent ? conversations : redactConversationBodies(conversations),
          providerErrors,
        },
      };
    },
  ));

  app.post("/communications/messages", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.send",
    "Communication",
    "communications-sms-send",
    patientReferenceFromBody(req.body),
    async (staff) => {
      const body = record(req.body);
      const patientReference = requiredPatientReference(body.patientReference);
      const text = requiredText(body.body, "SMS body", 1_600);
      const idempotencyKey = requiredIdempotencyKey(req, body);
      const provider = typeof body.provider === "string"
        ? adapterForExplicitSmsProvider(deps, providerName(body.provider), staff.fhir)
        : adapterForRole(deps, "transactional-sms", staff.fhir);
      if (!provider.sendSms) throw new CommsApiCapabilityError("SMS is not enabled for this communications provider.");
      const providerMessageIdentifierSystem =
        provider.messageIdentifierSystem ?? ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM;
      const reservation = await reserveStaffSmsSend(staff.fhir, {
        idempotencyKey,
        claimId: randomUUID(),
        patientReference,
        senderReference: staff.staffReference,
        body: text,
        provider: provider.name,
        providerMessageIdentifierSystem,
      });
      if (reservation.state === "conflict") {
        throw new CommsApiCapabilityError("SMS idempotency key was already used for a different request.");
      }
      if (reservation.state === "pending") {
        throw new CommsApiCapabilityError("SMS outcome is pending reconciliation; do not resend with a new key.");
      }
      if (reservation.state === "sent") {
        return {
          status: 200,
          body: { outcome: "sent", providerMessageId: reservation.providerMessageId },
        };
      }
      const result = await provider.sendSms({
        patientReference,
        body: text,
        campaignType: "staff-initiated",
        messageId: idempotencyKey,
        suppression: {},
      });
      if (result.outcome === "sent") {
        await persistAfterSend(() => persistStaffSentSms(staff.fhir, {
          communication: reservation.communication,
          idempotencyKey,
          providerMessageId: result.providerMessageId,
          providerMessageIdentifierSystem,
        }, { now: () => deps.now?.() ?? new Date().toISOString() }));
      }
      return { status: 200, body: result };
    },
  ));

  app.get("/communications/calls", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.read",
    "Communication",
    "communications-call-list",
    undefined,
    async (staff) => {
      const provider = adapter(deps, providerFromQuery(req, deps.dispatch, "voice"), staff.fhir);
      if (!provider.listCalls) throw new CommsApiCapabilityError("Call history is not enabled for this communications provider.");
      const limit = numberFromQuery(req, "limit", 1, MAX_CALL_HISTORY_WINDOW) ?? 50;
      const visibleIds = await visibleCallIds(staff.fhir);
      if (visibleIds.size === 0) return { status: 200, body: { calls: [] } };
      const calls = await provider.listCalls({ limit: MAX_CALL_HISTORY_WINDOW });
      return { status: 200, body: { calls: calls.filter((call) => visibleIds.has(call.id)).slice(0, limit) } };
    },
  ));

  app.get("/communications/calls/:callId", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.read",
    "Communication",
    "communications-call-read",
    undefined,
    async (staff) => {
      const provider = adapter(deps, providerFromQuery(req, deps.dispatch, "voice"), staff.fhir);
      if (!provider.getCall) throw new CommsApiCapabilityError("Call detail is not enabled for this communications provider.");
      const callId = resourceKey(req.params.callId, "call id");
      await requireVisibleTwilioIdentifier(staff.fhir, ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM, callId, "Call");
      return { status: 200, body: { call: await provider.getCall(callId) } };
    },
  ));

  app.post("/communications/calls", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.call",
    "Communication",
    "communications-call-initiate",
    patientReferenceFromBody(req.body),
    async (staff) => {
      const body = record(req.body);
      const patientReference = requiredPatientReference(body.patientReference);
      const provider = adapter(deps, providerFromBody(body, deps.dispatch, "voice"), staff.fhir);
      if (!provider.initiateCall) throw new CommsApiCapabilityError("Calling is not enabled for this communications provider.");
      return { status: 201, body: await provider.initiateCall({ patientReference }) };
    },
  ));

  app.get("/communications/recordings/:recordingId", async (req, res) => withStaff(
    req,
    res,
    deps,
    "communications.content.read",
    "Binary",
    "communications-recording-read",
    undefined,
    async (staff) => {
      const provider = adapter(deps, providerFromQuery(req, deps.dispatch, "voice"), staff.fhir);
      if (!provider.fetchRecording) {
        throw new CommsApiCapabilityError("Recording retrieval is not enabled for this communications provider.");
      }
      const recordingId = resourceKey(req.params.recordingId, "recording id");
      await requireVisibleTwilioIdentifier(
        staff.fhir,
        ODOS_TWILIO_RECORDING_IDENTIFIER_SYSTEM,
        recordingId,
        "Recording",
      );
      const recording = await provider.fetchRecording(recordingId);
      return {
        status: 200,
        media: { contentType: recording.contentType, bytes: recording.audio },
      };
    },
  ));
}

function sequenceFromBody(value: unknown): EducationSequenceInput | undefined {
  if (value === undefined) return undefined;
  const sequence = record(value) as unknown as EducationSequenceInput;
  validateEducationSequence(sequence);
  return structuredClone(sequence);
}

async function validateSequenceAdmission(
  deps: CommsApiRouteDeps, staff: CommsStaff, patient: Patient, sequence?: EducationSequenceInput,
): Promise<void> {
  if (!sequence) return;
  for (const step of sequence.steps) {
    const item = deps.educationCatalog.get(step.content.id, step.content.version);
    if (!item || item.audience !== "patient") throw new CommsApiNotFoundError("Education content not found.");
    if (!item.channels.includes(step.channel)) throw new CommsApiCapabilityError(`Education content is not published for ${step.channel}.`);
    if (step.channel === "sms" && item.consentClass === "marketing" && !hasRecordedMarketingConsent(patient)) throw new CommsApiRefusalError("marketing-consent-absent");
    if (deps.chartDispatchLane === "locked_clinical" && step.lane !== "clinical") throw new CommsApiCapabilityError("Education dispatch is locked to the clinical lane for this practice.");
    if (step.recipientReference.startsWith("Patient/")) {
      if (step.recipientReference !== `Patient/${patient.id}`) throw new CommsApiValidationError("Sequence recipient must belong to the enrolled patient.");
    } else {
      const recipient = await staff.fhir.read<RelatedPerson>("RelatedPerson", step.recipientReference.split("/")[1]!);
      if (recipient.patient.reference !== `Patient/${patient.id}`) throw new CommsApiValidationError("Sequence recipient must belong to the enrolled patient.");
    }
  }
}

async function enforceEducationLifecycle(deps: CommsApiRouteDeps, staff: CommsStaff, enrollment: EducationEnrollment): Promise<EducationEnrollment>;
async function enforceEducationLifecycle(deps: CommsApiRouteDeps, staff: CommsStaff): Promise<undefined>;
async function enforceEducationLifecycle(deps: CommsApiRouteDeps, staff: CommsStaff, enrollment?: EducationEnrollment): Promise<EducationEnrollment | undefined> {
  if (!enrollment) return undefined;
  return enrollmentStore(deps).applyLifecycle(enrollment.id, {
    actor: staff.staffReference, at: deps.now?.() ?? new Date().toISOString(), reason: "lifecycle-reconciliation",
  });
}

async function dispatchEnrollmentSend(
  deps: CommsApiRouteDeps,
  staff: CommsStaff,
  patient: Patient,
  store: EducationEnrollmentStore,
  enrollment: EducationEnrollment,
  sendIndex: number,
): Promise<EducationEnrollment> {
  let current = await enforceEducationLifecycle(deps, staff, enrollment);
  let send = current.immediateSends[sendIndex];
  if (!send) throw new Error("EducationEnrollment immediate send index is invalid.");
  if (send.state === "resolved" || send.state === "indeterminate" || send.outcome) return current;
  const idempotencyKey = send.idempotencyKey;
  if (!idempotencyKey) {
    throw new PendingEducationReconciliationError(
      "Education send outcome is pending reconciliation; do not resend with a new key.",
    );
  }
  const scheduled = current.scheduledSends?.find((row) => row.attempts.some((attempt) => attempt.sendIndex === sendIndex && attempt.attemptKey === idempotencyKey));
  if (send.state === "pending" && (scheduled || idempotencyKey.startsWith("education-sequence-"))) {
    throw new CommsApiRefusalError("scheduled-attempt-requires-worker-claim");
  }
  let reconcileOnly = true;
  if (send.state === "pending") {
    const claim = await store.claimImmediateSend(current.id, sendIndex);
    current = claim.enrollment;
    send = current.immediateSends[sendIndex]!;
    reconcileOnly = !claim.claimed;
  }
  if (send.state === "resolved" || send.state === "indeterminate" || send.outcome) return current;
  if (send.state !== "in-flight") {
    throw new PendingEducationReconciliationError(
      "Education send outcome is pending reconciliation; do not resend with a new key.",
    );
  }
  const outcome = await dispatchEducation(deps, staff, patient, {
    patientReference: current.patientReference,
    educationId: send.content.id,
    version: send.content.version,
    channel: send.channel,
    lane: send.lane,
    alsoUpdateChart: false,
    encounterReference: current.enteredFromEncounterReference,
    idempotencyKey,
    ...(scheduled ? { recipientOverride: { reference: scheduled.recipientReference } } : {}),
  }, { reconcileOnly, senderReference: current.enrolledBy });
  return store.recordImmediateSendOutcome(current.id, sendIndex, outcome);
}

async function acknowledgeOrRefuseIndeterminateSend(
  fhir: MedplumClient,
  store: EducationEnrollmentStore,
  enrollment: EducationEnrollment,
  sendIndex: number,
  body: EducationEnrollmentResumeBody,
  staff: CommsStaff,
  now: string,
): Promise<EducationEnrollment> {
  if (!body.acknowledgeIndeterminate) {
    throw new CommsApiRefusalError("pending-reconciliation");
  }
  if (!staff.roles.includes("provider")) throw new CommsApiRefusalError("practitioner-acknowledgement-required");
  const acknowledgement = {
    reason: body.reason,
    acknowledgedAt: now,
    acknowledgedBy: staff.staffReference,
  };
  await persistEducationEnrollmentIndeterminateProvenance(fhir, {
    enrollment,
    sendIndex,
    acknowledgement,
    staff,
  });
  return store.markImmediateSendIndeterminate(enrollment.id, sendIndex, acknowledgement);
}

async function persistEducationEnrollmentEventProvenances(
  fhir: MedplumClient,
  enrollment: EducationEnrollment,
  staff: CommsStaff,
): Promise<void> {
  await persistEducationEnrollmentProvenance(fhir, {
    enrollment,
    staff,
    now: enrollment.stageHistory[0]!.enteredAt,
  });
  for (let index = 1; index < enrollment.stageHistory.length; index += 1) {
    const entry = enrollment.stageHistory[index]!;
    const previous = enrollment.stageHistory[index - 1]!;
    await persistEducationEnrollmentTransitionProvenance(fhir, {
      enrollment,
      fromStageId: previous.stageId,
      toStageId: entry.stageId,
      trigger: entry.reason,
      status: index === enrollment.stageHistory.length - 1 ? enrollment.status : "active",
      eventSequence: index + 1,
      enteredBy: entry.enteredBy,
      staff,
      now: entry.enteredAt,
    });
  }
}

export type EducationDispatchActor =
  | { kind: "staff"; staff: CommsStaff }
  | { kind: "system"; reference: string; onBehalfOf: string; fhir: MedplumClient; quietHoursExemption?: never };

type EducationDispatchIdentity = { staffReference: string; fhir: MedplumClient; executingReference?: string };
export interface PreparedEducationSequenceDispatch {
  body: EducationDispatchBody;
  item: EducationContentItem;
  recipient: { reference: string; value: string; resource: Patient | RelatedPerson };
  laneSelection: "default" | "overridden";
  campaignId: string;
}
export type EducationSequencePreparation =
  | { kind: "ready"; prepared: PreparedEducationSequenceDispatch }
  | { kind: "held"; reason: "content-unavailable" | "no-recipient-channel" | "patient-opt-out" | "preference-withheld" | "needs-acknowledgement" }
  | { kind: "deferred"; notBefore: string };

async function prepareEducationDispatch(
  deps: CommsApiRouteDeps, fhir: MedplumClient, patient: Patient, body: EducationDispatchBody,
): Promise<Omit<PreparedEducationSequenceDispatch, "body">> {
  const item = deps.educationCatalog.get(body.educationId, body.version);
  if (!item || item.audience !== "patient") {
    throw new CommsApiNotFoundError("Education content not found.");
  }
  if (!item.channels.includes(body.channel)) {
    throw new CommsApiCapabilityError(`Education content is not published for ${body.channel}.`);
  }
  if (
    deps.chartDispatchLane === "locked_clinical"
    && body.lane !== "clinical"
  ) {
    throw new CommsApiCapabilityError("Education dispatch is locked to the clinical lane for this practice.");
  }
  await assertEducationClinicalReferences(fhir, body);
  if (body.channel === "sms" && item.consentClass === "marketing" && !hasRecordedMarketingConsent(patient)) {
    throw new CommsApiRefusalError("marketing-consent-absent");
  }
  const recipient = await resolveEducationRecipient(fhir, patient, body);
  const defaultLane = item.laneHint === "retail" ? "frontdesk" : "clinical";
  const laneSelection = body.lane === defaultLane ? "default" : "overridden";
  const campaignId = `${item.id}@${item.version}`;

  return { item, recipient, laneSelection, campaignId };
}

export async function prepareEducationSequenceDispatch(
  deps: CommsApiRouteDeps, fhir: MedplumClient, patient: Patient, body: EducationDispatchBody,
): Promise<EducationSequencePreparation> {
  if (body.channel === "print") return { kind: "held", reason: "needs-acknowledgement" };
  let prepared: Omit<PreparedEducationSequenceDispatch, "body">;
  try {
    prepared = await prepareEducationDispatch(deps, fhir, patient, body);
  } catch (error) {
    if (error instanceof CommsApiNotFoundError) return { kind: "held", reason: "content-unavailable" };
    if (error instanceof CommsApiRefusalError) return { kind: "held", reason: error.reason === "marketing-consent-absent" ? "preference-withheld" : "patient-opt-out" };
    if (error instanceof CommsApiCapabilityError || error instanceof CommsApiValidationError) {
      return { kind: "held", reason: /published/.test(error.message) ? "content-unavailable" : "no-recipient-channel" };
    }
    throw error;
  }
  const role = body.channel === "email" ? "email" : educationSmsRole(body.lane);
  if (!isRoleConfigured(deps.dispatch, role, body.channel === "sms")) return { kind: "held", reason: "no-recipient-channel" };
  const provider = adapterForRole(deps, role, fhir);
  if ((body.channel === "email" && !provider.sendEmail) || (body.channel === "sms" && !provider.sendSms)) {
    return { kind: "held", reason: "no-recipient-channel" };
  }
  const url = body.channel === "email" ? prepared.item.urls.email : prepared.item.urls.web;
  if (!url) return { kind: "held", reason: "content-unavailable" };
  if (body.channel === "sms") assertEducationPublicBaseUrl(deps.publicBaseUrl);
  if (!provider.preflightSuppression) throw new CommsApiCapabilityError("Education sequence provider lacks a suppression preflight probe.");
  const result = await provider.preflightSuppression({
    patientReference: body.patientReference, body: url, subject: prepared.item.title,
    campaignType: "clinical-education", campaignId: prepared.campaignId, messageId: body.idempotencyKey,
    suppression: { consentClass: prepared.item.consentClass, ...(prepared.item.consentClass === "marketing" ? { requiresMarketingConsent: true } : {}) },
  }, body.channel);
  if (result?.outcome === "rescheduled") return { kind: "deferred", notBefore: result.rescheduledAt };
  if (result?.outcome === "suppressed") return { kind: "held", reason: result.reason === "preference-withheld" ? "preference-withheld" : "patient-opt-out" };
  return { kind: "ready", prepared: structuredClone({ body, ...prepared }) };
}

function educationDispatchIdentity(body: EducationDispatchBody, includeAttempt = true): string {
  return JSON.stringify([
    body.patientReference, body.educationId, body.version, body.channel, body.lane,
    body.recipientOverride?.reference, body.recipientOverride?.phone, body.recipientOverride?.email,
    body.alsoUpdateChart, body.encounterReference, body.conditionReference,
    includeAttempt ? body.idempotencyKey : undefined,
  ]);
}

interface FrozenEducationDispatch {
  kind: "education-dispatch";
  executingReference?: string;
  body: EducationDispatchBody;
  item: EducationContentItem;
  recipientValue: string;
  laneSelection: "default" | "overridden";
  providerMessageIdentifierSystem: string;
}

export async function readEducationDispatchEvidence(fhir: MedplumClient, body: EducationDispatchBody, senderReference: string): Promise<{
  outcome: EducationEnrollmentSendOutcome;
  acceptedAt?: string;
  providerInvoked: boolean | "unknown";
  frozen: FrozenEducationDispatch;
} | undefined> {
  const communication = await findStaffSend(fhir, body.idempotencyKey);
  if (!communication) return undefined;
  if (communication.subject?.reference !== body.patientReference || communication.sender?.reference !== senderReference) {
    throw new CommsApiCapabilityError("Education frozen reservation identity conflict.");
  }
  const serialized = communication.payload?.[1]?.contentString;
  if (!serialized) return undefined;
  const frozen = JSON.parse(serialized) as FrozenEducationDispatch;
  if (frozen.kind !== "education-dispatch" || educationDispatchIdentity(frozen.body) !== educationDispatchIdentity(body)) {
    throw new CommsApiCapabilityError("Education frozen reservation request conflict.");
  }
  const providerMessageId = communication.identifier?.find((identifier) => identifier.system === frozen.providerMessageIdentifierSystem)?.value;
  if (providerMessageId) return { outcome: { outcome: "sent", providerMessageId }, acceptedAt: communication.sent, providerInvoked: true, frozen };
  const outcome = staffSmsTerminalResult(communication);
  return outcome ? { outcome, providerInvoked: outcome.outcome === "rescheduled" ? false : "unknown", frozen } : undefined;
}

type EducationDispatchResult = EducationEnrollmentSendOutcome & { chartUpdate?: "conflict"; preferenceUpdate?: "failed" };

async function dispatchEducation(
  deps: CommsApiRouteDeps, staff: CommsStaff, patient: Patient, body: EducationDispatchBody,
  options: { reconcileOnly?: boolean; senderReference?: string } = {},
): Promise<EducationDispatchResult> {
  let chartConflict = false;
  let preferenceFailed = false;
  const result = await dispatchEducationInternal({ kind: "staff", staff }, deps, patient, body, options,
    () => { chartConflict = true; }, () => { preferenceFailed = true; });
  return result.outcome === "sent" ? { ...result, ...(chartConflict ? { chartUpdate: "conflict" as const } : {}), ...(preferenceFailed ? { preferenceUpdate: "failed" as const } : {}) } : result;
}

export async function dispatchEducationAs(
  actor: EducationDispatchActor,
  deps: CommsApiRouteDeps,
  patient: Patient | undefined,
  body: EducationDispatchBody,
  options: { reconcileOnly?: boolean; senderReference?: string; prepared?: PreparedEducationSequenceDispatch } = {},
): Promise<EducationEnrollmentSendOutcome> {
  return dispatchEducationInternal(actor, deps, patient, body, options);
}

async function dispatchEducationInternal(
  actor: EducationDispatchActor,
  deps: CommsApiRouteDeps,
  patient: Patient | undefined,
  body: EducationDispatchBody,
  options: { reconcileOnly?: boolean; senderReference?: string; prepared?: PreparedEducationSequenceDispatch },
  onRecipientConflict?: () => void,
  onPreferenceFailure?: () => void,
): Promise<EducationEnrollmentSendOutcome> {
  if (actor.kind === "system" && "quietHoursExemption" in actor) {
    throw new CommsApiRefusalError("system actor cannot carry a quiet-hours exemption");
  }
  if (actor.kind === "staff" && body.idempotencyKey.startsWith("education-sequence-") && !options.reconcileOnly) {
    throw new CommsApiRefusalError("scheduled-attempt-requires-worker-claim");
  }
  const staff: EducationDispatchIdentity = actor.kind === "staff" ? actor.staff : {
    staffReference: actor.onBehalfOf, fhir: actor.fhir, executingReference: actor.reference,
  };
  if (actor.kind === "system" && (body.alsoUpdateChart || body.channel === "print")) {
    throw new CommsApiRefusalError("system education dispatch requires an electronic send without chart mutation");
  }
  const senderReference = actor.kind === "system" ? actor.onBehalfOf : options.senderReference ?? staff.staffReference;
  if (options.reconcileOnly && (actor.kind === "system" || body.idempotencyKey.startsWith("education-sequence-"))) {
    const evidence = await readEducationDispatchEvidence(staff.fhir, body, senderReference);
    if (evidence) {
      if (evidence.outcome.outcome === "sent") {
        await persistAfterSend(() => persistEducationSendProvenance(staff.fhir, {
          ...evidence.frozen, staff: evidence.frozen.executingReference ? { ...staff, staffReference: senderReference, executingReference: evidence.frozen.executingReference } : staff, now: deps.now?.() ?? new Date().toISOString(),
        }));
      }
      return evidence.outcome;
    }
    throw new PendingEducationReconciliationError("Education send outcome is pending reconciliation; do not resend with a new key.");
  }
  if (!patient) throw new CommsApiValidationError("Patient is required to prepare a new education send.");
  if (options.prepared) {
    if (educationDispatchIdentity(options.prepared.body, false) !== educationDispatchIdentity(body, false)) {
      throw new CommsApiValidationError("Prepared education request does not match dispatch.");
    }
  }
  const { item, recipient, laneSelection, campaignId } = options.prepared ?? await prepareEducationDispatch(deps, staff.fhir, patient, body);
  const requiredConsent = { consentClass: item.consentClass,
    ...(actor.kind === "system" && item.consentClass === "marketing" ? { requiresMarketingConsent: true } : {}) };
  const frozenContext = (providerMessageIdentifierSystem: string): string => JSON.stringify({
    kind: "education-dispatch", executingReference: staff.executingReference, body, item, recipientValue: recipient.value, laneSelection, providerMessageIdentifierSystem,
  } satisfies FrozenEducationDispatch);
  if (body.channel === "print") {
    const url = item.urls.print;
    if (!url) throw new CommsApiCapabilityError("Education print artifact is not published.");
    if (body.alsoUpdateChart) {
      await updateEducationRecipient(staff.fhir, recipient, body, staff);
    }
    await persistEducationSendProvenance(staff.fhir, {
      body,
      item,
      staff,
      recipientValue: recipient.value,
      laneSelection,
      now: deps.now?.() ?? new Date().toISOString(),
    });
    return { outcome: "print", url };
  }

  if (body.channel === "email") {
    const url = item.urls.email;
    if (!url) throw new CommsApiCapabilityError("Education email artifact is not published.");
    requireConfiguredRole(deps.dispatch, "email", false);
    const provider = adapterForRole(deps, "email", staff.fhir);
    if (!provider.sendEmail) {
      throw new CommsApiCapabilityError("Email is not enabled for the configured education provider.");
    }
    const providerMessageIdentifierSystem =
      provider.messageIdentifierSystem ?? ODOS_COMMS_PROVIDER_MESSAGE_IDENTIFIER_SYSTEM;
    const existingSend = await findStaffSend(staff.fhir, body.idempotencyKey);
    if (options.reconcileOnly && !existingSend) {
      throw new PendingEducationReconciliationError(
        "Education send outcome is pending reconciliation; do not resend with a new key.",
      );
    }
    const reservation = await reserveStaffSend(staff.fhir, {
      idempotencyKey: body.idempotencyKey,
      claimId: randomUUID(),
      patientReference: body.patientReference,
      senderReference,
      body: url,
      requestFingerprint: JSON.stringify({
        patientReference: body.patientReference,
        recipient: recipient.value,
        education: campaignId,
        lane: body.lane,
        provider: provider.name,
        recipientReference: recipient.reference,
        alsoUpdateChart: body.alsoUpdateChart,
        encounterReference: body.encounterReference,
        conditionReference: body.conditionReference,
        channel: "email",
      }),
      provider: provider.name,
      providerMessageIdentifierSystem,
      frozenContext: frozenContext(providerMessageIdentifierSystem),
      medium: "Email",
      category: ODOS_PATIENT_EMAIL_CATEGORY,
      outboundCategory: ODOS_PATIENT_EMAIL_OUTBOUND_CATEGORY,
    });
    if (reservation.state === "conflict") {
      throw new CommsApiCapabilityError("Education idempotency key was already used for a different request.");
    }
    if (reservation.state === "pending") {
      throw new PendingEducationReconciliationError(
        "Education send outcome is pending reconciliation; do not resend with a new key.",
      );
    }
    if (reservation.state === "sent") {
      if (body.alsoUpdateChart) {
        const updated = await updateSentEducationRecipient(staff.fhir, recipient, body, staff);
        if (!updated) {
          onRecipientConflict?.();
          body = { ...body, alsoUpdateChart: false };
        }
      }
      await persistAfterSend(() => persistEducationSendProvenance(staff.fhir, {
        body,
        item,
        staff,
        recipientValue: recipient.value,
        laneSelection,
        now: deps.now?.() ?? new Date().toISOString(),
      }));
      return { outcome: "sent", providerMessageId: reservation.providerMessageId };
    }
    if (reservation.state === "terminal") return reservation.result;
    if (options.reconcileOnly) {
      throw new PendingEducationReconciliationError(
        "Education send outcome is pending reconciliation; do not resend with a new key.",
      );
    }
    const staffEducationOverride = actor.kind === "staff" && item.consentClass === "transactional";
    const withheldEducationEmail = staffEducationOverride && !effectiveCommsPreferences(patient, {}).education.email.value;
    const result = await provider.sendEmail({
      patientReference: body.patientReference,
      toAddress: recipient.value,
      subject: item.title,
      body: url,
      campaignType: "clinical-education",
      campaignId,
      messageId: body.idempotencyKey,
      suppression: { ...requiredConsent, ...(staffEducationOverride ? { staffEducationOverride: true as const } : {}) },
    });
    if (result.outcome === "sent") {
      if (withheldEducationEmail && actor.kind === "staff") {
        try {
          await writeCommsPreferences(actor.staff.fhir, body.patientReference, [{ purpose: "education", channel: "email", allowed: true }], {
            actorReference: await preferencePractitioner(actor.staff), actorRole: actor.staff.actorRole,
            policyUrl: actor.staff.authorizationPolicyUrl, recordedAt: deps.now?.() ?? new Date().toISOString(), surface: "staff-manual-send",
          });
        } catch {
          onPreferenceFailure?.();
          console.error("odos-mcp: education email sent; preference update failed.");
        }
      }
      await persistAfterSend(() => persistStaffSentSend(staff.fhir, {
        communication: reservation.communication,
        idempotencyKey: body.idempotencyKey,
        providerMessageId: result.providerMessageId,
        providerMessageIdentifierSystem,
        category: ODOS_PATIENT_EMAIL_CATEGORY,
        outboundCategory: ODOS_PATIENT_EMAIL_OUTBOUND_CATEGORY,
        completed: true,
      }, { now: () => deps.now?.() ?? new Date().toISOString() }));
      if (body.alsoUpdateChart) {
        const updated = await updateSentEducationRecipient(staff.fhir, recipient, body, staff);
        if (!updated) {
          onRecipientConflict?.();
          body = { ...body, alsoUpdateChart: false };
        }
      }
      await persistAfterSend(() => persistEducationSendProvenance(staff.fhir, {
        body,
        item,
        staff,
        recipientValue: recipient.value,
        laneSelection,
        now: deps.now?.() ?? new Date().toISOString(),
      }));
    } else {
      await persistStaffTerminalOutcome(staff.fhir, {
        communication: reservation.communication,
        idempotencyKey: body.idempotencyKey,
        result,
        category: ODOS_PATIENT_EMAIL_CATEGORY,
      });
    }
    return result;
  }

  const role = educationSmsRole(body.lane);
  requireConfiguredRole(deps.dispatch, role, true);
  const provider = adapterForRole(deps, role, staff.fhir);
  if (!provider.sendSms) {
    throw new CommsApiCapabilityError("SMS is not enabled for the configured education lane.");
  }
  const targetUrl = item.urls.web;
  if (!targetUrl) throw new CommsApiCapabilityError("Education web artifact is not published.");
  assertEducationPublicBaseUrl(deps.publicBaseUrl);
  const existingSend = await findStaffSmsSend(staff.fhir, body.idempotencyKey);
  if (options.reconcileOnly && !existingSend) {
    throw new PendingEducationReconciliationError(
      "Education send outcome is pending reconciliation; do not resend with a new key.",
    );
  }
  const smsBody = existingSend?.payload?.[0]?.contentString ?? await educationSmsBody(deps, {
    targetUrl,
    campaignId,
    messageId: body.idempotencyKey,
  });
  const providerMessageIdentifierSystem =
    provider.messageIdentifierSystem ?? ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM;
  const reservation = await reserveStaffSmsSend(staff.fhir, {
    idempotencyKey: body.idempotencyKey,
    claimId: randomUUID(),
    patientReference: body.patientReference,
    senderReference,
    body: smsBody,
    requestFingerprint: JSON.stringify({
      patientReference: body.patientReference,
      recipient: recipient.value,
      education: campaignId,
      targetUrl,
      lane: body.lane,
      provider: provider.name,
      recipientReference: recipient.reference,
      alsoUpdateChart: body.alsoUpdateChart,
      encounterReference: body.encounterReference,
      conditionReference: body.conditionReference,
    }),
    provider: provider.name,
    providerMessageIdentifierSystem,
    frozenContext: frozenContext(providerMessageIdentifierSystem),
  });
  if (reservation.state === "conflict") {
    throw new CommsApiCapabilityError("Education idempotency key was already used for a different request.");
  }
  if (reservation.state === "pending") {
    throw new PendingEducationReconciliationError(
      "Education send outcome is pending reconciliation; do not resend with a new key.",
    );
  }
  if (reservation.state === "sent") {
    if (body.alsoUpdateChart) {
      const updated = await updateSentEducationRecipient(staff.fhir, recipient, body, staff);
      if (!updated) {
        onRecipientConflict?.();
        body = { ...body, alsoUpdateChart: false };
      }
    }
    await persistAfterSend(() => persistEducationSendProvenance(staff.fhir, {
      body,
      item,
      staff,
      recipientValue: recipient.value,
      laneSelection,
      now: deps.now?.() ?? new Date().toISOString(),
    }));
    return { outcome: "sent", providerMessageId: reservation.providerMessageId };
  }
  if (reservation.state === "terminal") {
    return reservation.result;
  }
  if (options.reconcileOnly) {
    throw new PendingEducationReconciliationError(
      "Education send outcome is pending reconciliation; do not resend with a new key.",
    );
  }
  const result = await provider.sendSms({
    patientReference: body.patientReference,
    toNumber: recipient.value,
    body: smsBody,
    campaignType: "clinical-education",
    campaignId,
    messageId: body.idempotencyKey,
    suppression: actor.kind === "staff" && item.consentClass === "transactional"
      ? { ...requiredConsent, quietHoursExemption: "staff-initiated-chart-education" }
      : requiredConsent,
  });
  if (result.outcome === "sent") {
    await persistAfterSend(() => persistStaffSentSms(staff.fhir, {
      communication: reservation.communication,
      idempotencyKey: body.idempotencyKey,
      providerMessageId: result.providerMessageId,
      providerMessageIdentifierSystem,
    }, { now: () => deps.now?.() ?? new Date().toISOString() }));
    if (body.alsoUpdateChart) {
      const updated = await updateSentEducationRecipient(staff.fhir, recipient, body, staff);
      if (!updated) {
        onRecipientConflict?.();
        body = { ...body, alsoUpdateChart: false };
      }
    }
    await persistAfterSend(() => persistEducationSendProvenance(staff.fhir, {
      body,
      item,
      staff,
      recipientValue: recipient.value,
      laneSelection,
      now: deps.now?.() ?? new Date().toISOString(),
    }));
  } else {
    await persistStaffSmsTerminalOutcome(staff.fhir, {
      communication: reservation.communication,
      idempotencyKey: body.idempotencyKey,
      result,
    });
  }
  return result;
}

async function withStaff(
  req: Request,
  res: Response,
  deps: CommsApiRouteDeps,
  action: BusinessAction,
  resourceType: string,
  actionReason: string,
  patientReference: string | undefined,
  operation: (staff: CommsStaff) => Promise<CommsApiResult>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required for patient communications." });
      return;
    }
    const actorId = staff.staffReference.replace(/^Practitioner\//, "");
    const authorization = actingAuthorization(req, staff, action);
    const claimedActorId = req.header("X-ODOS-Actor-Id")?.trim();
    if (!authorization || (claimedActorId && claimedActorId !== actorId && claimedActorId !== staff.staffReference)) {
      await deps.audit.recordDenied(buildOdosAuditEventRow({
        eventType: "denied",
        eventTime: deps.now?.(),
        actorId,
        actorRole: staff.actorRole,
        patientReference,
        resourceType,
        actionOutcome: "denied",
        actionReason: `${action} role required`,
        policyUrl: `AccessPolicy/odos-${staff.actorRole}`,
        ipAddress: req.ip?.replace(/^::ffff:/, ""),
        userAgent: req.header("user-agent"),
      }));
      res.status(403).json({ error: `${action} role required` });
      return;
    }
    const { actorRole, policyUrl } = authorization;
    const eventType = req.method === "GET" ? "read" : "external-api-call";
    const auditContext = {
      eventType,
      eventTime: deps.now?.(),
      actorId,
      actorRole,
      patientReference,
      resourceType,
      policyUrl,
      ipAddress: req.ip?.replace(/^::ffff:/, ""),
      userAgent: req.header("user-agent"),
    } as const;
    let result: CommsApiResult;
    try {
      result = await deps.audit.record(buildOdosAuditEventRow({
        ...auditContext,
        actionOutcome: "granted",
        actionReason,
      }), () => operation({ ...staff, actorRole, authorizationPolicyUrl: policyUrl }));
    } catch (error) {
      if (!isAuditSubstrateUnavailable(error)) {
        await deps.audit.recordDenied(buildOdosAuditEventRow({
          ...auditContext,
          actionOutcome: "denied",
          actionReason: `${actionReason}-failed`,
        }));
      }
      throw error;
    }
    if ("media" in result) {
      if (result.headers) res.set(result.headers);
      res.status(result.status).type(result.media.contentType).send(Buffer.from(result.media.bytes));
    } else {
      res.status(result.status).json(result.body);
    }
  } catch (error) {
    if (res.headersSent) return;
    if (error instanceof EducationSequenceAdmissionError) {
      res.status(409).json({ outcome: "refused", reason: error.message });
      return;
    }
    if (error instanceof CommsPreferencePermissionError) {
      res.status(403).json({ error: "Communication preference access denied." });
      return;
    }
    if (error instanceof CommsApiValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof CommsApiCapabilityError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof CommsApiRefusalError) {
      res.status(409).json({ outcome: "refused", reason: error.reason });
      return;
    }
    if (error instanceof CommsApiNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (isFhirConflict(error)) {
      res.status(409).json({ error: "This patient's record changed while you were working. Reload and try again." });
      return;
    }
    console.error("odos-mcp: patient communications route failed.");
    res.status(502).json({ error: "Patient communications service failed." });
  }
}

async function visibleCallIds(fhir: CommsDispatchFhir): Promise<Set<string>> {
  const communications = await searchBounded<Communication>(fhir, "Communication", {
    category: `${ODOS_COMMS_CATEGORY_SYSTEM}|${ODOS_PATIENT_CALL_CATEGORY}`,
    _sort: "-_lastUpdated",
    _count: "100",
  }, { maxPages: 10, maxRows: 1_000 });
  return new Set(communications.flatMap((communication) => communication.identifier ?? []).flatMap((identifier) =>
    identifier.system === ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM && identifier.value ? [identifier.value] : []));
}

async function requireVisibleTwilioIdentifier(
  fhir: CommsDispatchFhir,
  system: string,
  value: string,
  label: string,
): Promise<void> {
  const bundle = await fhir.search<Communication>("Communication", {
    identifier: `${system}|${value}`,
    _count: "2",
  });
  const matches = (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []).filter((communication) =>
    communication.identifier?.some((identifier) =>
      identifier.system === system && identifier.value === value));
  if (matches.length === 0) throw new CommsApiNotFoundError(`${label} not found.`);
  if (matches.length > 1) throw new Error(`Twilio ${label.toLowerCase()} identifier ${value} is not unique.`);
}

function actingAuthorization(
  req: Request,
  staff: CommsStaff,
  action: BusinessAction,
): { actorRole: PracticeRoleId; policyUrl: string } | undefined {
  const claimed = req.header("X-ODOS-Actor-Role")?.trim();
  if (claimed) {
    if (!PRACTICE_ROLE_IDS.includes(claimed as PracticeRoleId)) return undefined;
    const role = claimed as PracticeRoleId;
    return staff.roles.includes(role)
      && staffHasBusinessAction(staff, action)
      && resolveDeclaredBusinessActionRole([role], action) === role
      ? { actorRole: role, policyUrl: `AccessPolicy/odos-${role}` }
      : undefined;
  }
  if (!staffHasBusinessAction(staff, action)) return undefined;
  const declaredRole = resolveDeclaredBusinessActionRole(staff.roles, action);
  if (declaredRole) {
    return { actorRole: declaredRole, policyUrl: `AccessPolicy/odos-${declaredRole}` };
  }
  return staff.membershipReference
    ? { actorRole: staff.actorRole, policyUrl: staff.membershipReference }
    : undefined;
}

function enrollmentStore(deps: CommsApiRouteDeps): EducationEnrollmentStore {
  if (!deps.enrollmentStore) {
    throw new CommsApiCapabilityError("Education enrollment persistence is not configured.");
  }
  return deps.enrollmentStore;
}

async function patientSmsOptOutState(
  fhir: SmsOptOutManagementFhir,
  dispatch: CommsDispatch,
  patientReference: string,
) {
  try {
    return {
      ...await readPatientSmsOptOut(fhir, patientReference),
      smsLanes: configuredSmsLanes(dispatch),
    };
  } catch (error) {
    if (isFhirNotFound(error)) throw new CommsApiNotFoundError("Patient not found.");
    throw error;
  }
}

function configuredSmsLanes(dispatch: CommsDispatch): Array<{
  label: string;
  number: string;
  roles: CommsChannelRole[];
}> {
  const roles = ["transactional-sms", "marketing-sms", "clinical-sms"] as const;
  const byNumber = new Map<string, CommsChannelRole[]>();
  for (const role of roles) {
    if (!dispatch.providerFor(role)) continue;
    const number = dispatch.senderNumberFor(role);
    if (!number) continue;
    byNumber.set(number, [...(byNumber.get(number) ?? []), role]);
  }
  return [...byNumber].map(([number, laneRoles]) => ({
    label: smsLaneLabel(laneRoles),
    number,
    roles: laneRoles,
  }));
}

function smsLaneLabel(roles: readonly CommsChannelRole[]): string {
  const frontDesk = roles.some((role) => role === "transactional-sms" || role === "marketing-sms");
  const clinical = roles.includes("clinical-sms");
  if (frontDesk && clinical) return "Front-desk and clinical texts";
  return clinical ? "Clinical texts" : "Front-desk texts";
}

async function clearNamedPatientSmsOptOut(
  fhir: SmsOptOutManagementFhir,
  deps: CommsApiRouteDeps,
  body: {
    patientReference: string;
    reason: string;
    identityVerification: SmsOptOutIdentityVerification;
    number?: string;
  },
  staff: CommsStaff,
) {
  try {
    return await clearPatientSmsOptOut(fhir, body.patientReference, {
      actorReference: staff.staffReference,
      actorRole: staff.actorRole,
      policyUrl: staff.authorizationPolicyUrl,
      recordedAt: deps.now?.() ?? new Date().toISOString(),
      reason: body.reason,
      identityVerification: body.identityVerification,
      number: body.number,
    });
  } catch (error) {
    if (isFhirNotFound(error)) throw new CommsApiNotFoundError("Patient not found.");
    throw error;
  }
}

function isFhirNotFound(error: unknown): boolean {
  return [404, 410].includes((error as { status?: number })?.status ?? 0);
}

function isAuditSubstrateUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current.message.includes("audit substrate unavailable")) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

function adapter(
  deps: CommsApiRouteDeps,
  provider: string,
  callerFhir: CommsDispatchFhir,
): CommsProvider {
  return deps.dispatch.getAdapter(provider, callerFhir);
}

function adapterForRole(
  deps: CommsApiRouteDeps,
  role: CommsChannelRole,
  callerFhir: CommsDispatchFhir,
): CommsProvider {
  return deps.dispatch.getAdapterForRole?.(role, callerFhir)
    ?? deps.dispatch.getAdapter(providerForRole(deps.dispatch, role), callerFhir);
}

function adapterForExplicitSmsProvider(
  deps: CommsApiRouteDeps,
  provider: string,
  callerFhir: CommsDispatchFhir,
): CommsProvider {
  const smsRoles = [
    "transactional-sms",
    "marketing-sms",
    "clinical-sms",
  ] as const;
  const senderNumbers = new Set(smsRoles.flatMap((role) =>
    deps.dispatch.providerFor(role) === provider
      ? [deps.dispatch.senderNumberFor(role)].filter(
          (number): number is string => number !== undefined,
        )
      : []));
  if (senderNumbers.size > 1) {
    throw new CommsApiValidationError(
      `Communications provider "${provider}" has multiple SMS sender lanes; the request must identify one lane.`,
    );
  }
  return adapter(deps, provider, callerFhir);
}

function redactConversationBodies(conversations: ConversationSummary[]): ConversationSummary[] {
  return conversations.map(({ preview: _preview, ...conversation }) => ({
    ...conversation,
    messages: conversation.messages.map(({ body: _body, ...message }) => message),
  }));
}

async function withConversationProviderTimeout<T>(operation: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new CommsProviderTimeoutError("Conversation provider timed out.")),
          CONVERSATION_PROVIDER_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function routedProviderNames(dispatch: CommsDispatch): string[] {
  return [...new Set(COMMS_CHANNEL_ROLES.flatMap((role) => {
    const provider = dispatch.providerFor(role);
    return provider ? [provider] : [];
  }))];
}

function explicitProviderFromQuery(req: Request): string | undefined {
  const explicit = queryString(req, "provider");
  return explicit ? providerName(explicit) : undefined;
}

function compareConversationActivity(left: ConversationSummary, right: ConversationSummary): number {
  const leftTime = conversationActivityTime(left.updatedAt);
  const rightTime = conversationActivityTime(right.updatedAt);
  if (leftTime === rightTime) return 0;
  return rightTime > leftTime ? 1 : -1;
}

function conversationActivityTime(updatedAt: string | undefined): number {
  if (!updatedAt) return Number.NEGATIVE_INFINITY;
  const value = Date.parse(updatedAt);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function sameConversation(left: ConversationSummary, right: ConversationSummary): boolean {
  return left.id === right.id && left.provider === right.provider;
}

function limitConversations(
  conversations: ConversationSummary[],
  limit: number,
  selected: ConversationSummary | undefined,
): ConversationSummary[] {
  const limited = conversations.slice(0, limit);
  if (!selected || limited.some((conversation) => sameConversation(conversation, selected))) {
    return limited;
  }
  return [...limited.slice(0, limit - 1), selected].sort(compareConversationActivity);
}

function providerFromQuery(
  req: Request,
  dispatch: CommsDispatch,
  role: "voice" | "transactional-sms",
): string {
  const explicit = queryString(req, "provider");
  return explicit ? providerName(explicit) : providerForRole(dispatch, role);
}

function providerFromBody(
  body: Record<string, unknown>,
  dispatch: CommsDispatch,
  role: "voice" | "transactional-sms",
): string {
  return typeof body.provider === "string"
    ? providerName(body.provider)
    : providerForRole(dispatch, role);
}

function providerForRole(dispatch: CommsDispatch, role: CommsChannelRole): string {
  const provider = dispatch.providerFor(role);
  if (!provider) {
    throw new CommsApiCapabilityError(`Communications role "${role}" is not configured for this practice.`);
  }
  return provider;
}

function requiredIdempotencyKey(req: Request, body: Record<string, unknown>): string {
  const value = req.header("Idempotency-Key") ?? body.idempotencyKey;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new CommsApiValidationError("Idempotency-Key header or idempotencyKey body field is required.");
  }
  return value;
}

function providerName(value: string): string {
  const provider = value.trim();
  if (!/^[a-z0-9-]{1,64}$/.test(provider)) throw new CommsApiValidationError("Communications provider is invalid.");
  return provider;
}

function patientReferenceFromQuery(req: Request): string | undefined {
  const value = queryString(req, "patientReference", "patient_id", "patientId");
  if (!value) return undefined;
  return requiredPatientReference(value.startsWith("Patient/") ? value : `Patient/${value}`);
}

function conversationIdFromQuery(req: Request): string | undefined {
  const value = queryString(req, "conversationId", "conversation_id");
  return value ? resourceKey(value, "conversation id") : undefined;
}

function patientReferenceForAudit(req: Request): string | undefined {
  const value = queryString(req, "patientReference", "patient_id", "patientId");
  if (!value) return undefined;
  const reference = value.startsWith("Patient/") ? value : `Patient/${value}`;
  return /^Patient\/[A-Za-z0-9.-]{1,64}$/.test(reference) ? reference : undefined;
}

function optOutPatientReferenceForAudit(req: Request): string | undefined {
  const value = queryString(req, "patient");
  return value && /^Patient\/[A-Za-z0-9.-]{1,64}$/.test(value) ? value : undefined;
}

function patientReferenceFromBody(value: unknown): string | undefined {
  const body = record(value);
  return typeof body.patientReference === "string" && /^Patient\/[A-Za-z0-9.-]{1,64}$/.test(body.patientReference)
    ? body.patientReference
    : undefined;
}

function requiredPatientReference(value: unknown): string {
  if (typeof value !== "string" || !/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(value)) {
    throw new CommsApiValidationError("patientReference must be Patient/<id>.");
  }
  return value;
}

function optOutRecordBody(value: unknown) {
  const body = record(value);
  if (body.scope !== "global" && body.scope !== "per-number") {
    throw new CommsApiValidationError("scope must be global or per-number.");
  }
  const { scope, ...fields } = body;
  const validated = optOutClearBody(fields);
  if (scope === "global" && body.number !== undefined) {
    throw new CommsApiValidationError("number is only accepted for per-number scope.");
  }
  return {
    ...validated,
    scope: scope as "global" | "per-number",
    ...(scope === "per-number" ? { number: requiredE164(body.number, "number") } : {}),
  };
}

function optOutClearBody(value: unknown): {
  patientReference: string;
  reason: string;
  identityVerification: SmsOptOutIdentityVerification;
  number?: string;
} {
  const body = record(value);
  const unexpected = Object.keys(body).filter((key) =>
    key !== "patientReference"
    && key !== "reason"
    && key !== "identityVerification"
    && key !== "number");
  if (unexpected.length > 0) {
    throw new CommsApiValidationError(
      "Opt-out clear accepts only patientReference, reason, identityVerification, and number.",
    );
  }
  const patientReference = requiredPatientReference(body.patientReference);
  const reason = requiredText(body.reason, "reason", 2_000);
  if (
    typeof body.identityVerification !== "string"
    || !SMS_OPT_OUT_IDENTITY_VERIFICATION_METHODS.includes(
      body.identityVerification as SmsOptOutIdentityVerification,
    )
  ) {
    throw new CommsApiValidationError(
      `identityVerification must be one of: ${SMS_OPT_OUT_IDENTITY_VERIFICATION_METHODS.join(", ")}.`,
    );
  }
  return {
    patientReference,
    reason,
    identityVerification: body.identityVerification as SmsOptOutIdentityVerification,
    ...(body.number === undefined ? {} : { number: requiredE164(body.number, "number") }),
  };
}

function requiredE164(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\+[1-9]\d{7,14}$/.test(value.trim())) {
    throw new CommsApiValidationError(`${label} must use E.164 format.`);
  }
  return value.trim();
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new CommsApiValidationError(`${label} must contain 1-${max} characters.`);
  }
  return value.trim();
}

function requiredInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new CommsApiValidationError(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value as number;
}

export type EducationDispatchBody = {
  patientReference: string;
  educationId: string;
  version: number;
  channel: "sms" | "email" | "print";
  lane: "clinical" | "frontdesk";
  recipientOverride?: {
    reference?: string;
    phone?: string;
    email?: string;
  };
  alsoUpdateChart: boolean;
  encounterReference?: string;
  conditionReference?: string;
  idempotencyKey: string;
};

// Slice 5a limitation: the journey id/version pin is recorded but is not yet enforced against a definition store; the caller-supplied stage and sends are persisted as the execution truth.
type EducationEnrollmentBody = {
  requestId?: string;
  patientReference: string;
  encounterReference: string;
  journey: { id: string; version: number };
  initialStage: {
    sequence?: EducationSequenceInput;
    id: string;
    immediateSends: Array<{
      educationId: string;
      version: number;
      channel: "sms" | "email" | "print";
      lane: "clinical" | "frontdesk";
    }>;
  };
};

type EducationEnrollmentTransitionBody = {
  requestId?: string;
  fromStageId: string;
  targetStage: {
    sequence?: EducationSequenceInput;
    id: string;
    immediateSends: Array<{
      educationId: string;
      version: number;
      channel: "sms" | "email" | "print";
      lane: "clinical" | "frontdesk";
    }>;
  };
  trigger: string;
  status: "active" | "completed" | "cancelled";
};

type EducationEnrollmentResumeBody =
  | { acknowledgeIndeterminate: false; reason?: never }
  | { acknowledgeIndeterminate: true; reason: string };

function educationEnrollmentBody(value: unknown): EducationEnrollmentBody {
  const body = record(value);
  const journey = record(body.journey);
  const initialStage = record(body.initialStage);
  const sequence = sequenceFromBody(initialStage.sequence);
  const immediateSends = initialStage.immediateSends === undefined && sequence ? [] : initialStage.immediateSends;
  if (!Array.isArray(immediateSends) || (immediateSends.length === 0 && !sequence?.steps.length)) {
    throw new CommsApiValidationError("initialStage must contain at least one immediate send or one sequence step.");
  }
  return {
    patientReference: requiredPatientReference(body.patientReference),
    encounterReference: requiredReference(body.encounterReference, "Encounter", "encounterReference"),
    journey: {
      id: definitionKey(journey.id, "journey.id"),
      version: requiredInteger(journey.version, "journey.version", 1, Number.MAX_SAFE_INTEGER),
    },
    ...(sequence ? { requestId: idempotencyKeyFromBody(body.requestId) } : {}),
    initialStage: {
      ...(sequence ? { sequence } : {}),
      id: definitionKey(initialStage.id, "initialStage.id"),
      immediateSends: immediateSends.map((value, index) => {
        const send = record(value);
        const channel = send.channel;
        if (channel !== "sms" && channel !== "email" && channel !== "print") {
          throw new CommsApiValidationError(
            `initialStage.immediateSends[${index}].channel must be sms, email, or print.`,
          );
        }
        const lane = send.lane;
        if (lane !== "clinical" && lane !== "frontdesk") {
          throw new CommsApiValidationError(
            `initialStage.immediateSends[${index}].lane must be clinical or frontdesk.`,
          );
        }
        return {
          educationId: definitionKey(
            send.educationId,
            `initialStage.immediateSends[${index}].educationId`,
          ),
          version: requiredInteger(
            send.version,
            `initialStage.immediateSends[${index}].version`,
            1,
            Number.MAX_SAFE_INTEGER,
          ),
          channel,
          lane,
        };
      }),
    },
  };
}

function educationEnrollmentTransitionBody(value: unknown): EducationEnrollmentTransitionBody {
  const body = record(value);
  const targetStage = record(body.targetStage);
  const sequence = sequenceFromBody(targetStage.sequence);
  const immediateSends = targetStage.immediateSends === undefined && sequence ? [] : targetStage.immediateSends;
  if (!Array.isArray(immediateSends)) {
    throw new CommsApiValidationError("targetStage.immediateSends must be an array.");
  }
  const status = body.status;
  if (status !== "active" && status !== "completed" && status !== "cancelled") {
    throw new CommsApiValidationError("status must be active, completed, or cancelled.");
  }
  return {
    ...(sequence ? { requestId: idempotencyKeyFromBody(body.requestId) } : {}),
    fromStageId: definitionKey(body.fromStageId, "fromStageId"),
    targetStage: {
      ...(sequence ? { sequence } : {}),
      id: definitionKey(targetStage.id, "targetStage.id"),
      immediateSends: immediateSends.map((value, index) => {
        const send = record(value);
        const channel = send.channel;
        if (channel !== "sms" && channel !== "email" && channel !== "print") {
          throw new CommsApiValidationError(
            `targetStage.immediateSends[${index}].channel must be sms, email, or print.`,
          );
        }
        const lane = send.lane;
        if (lane !== "clinical" && lane !== "frontdesk") {
          throw new CommsApiValidationError(
            `targetStage.immediateSends[${index}].lane must be clinical or frontdesk.`,
          );
        }
        return {
          educationId: definitionKey(
            send.educationId,
            `targetStage.immediateSends[${index}].educationId`,
          ),
          version: requiredInteger(
            send.version,
            `targetStage.immediateSends[${index}].version`,
            1,
            Number.MAX_SAFE_INTEGER,
          ),
          channel,
          lane,
        };
      }),
    },
    trigger: definitionKey(body.trigger, "trigger"),
    status,
  };
}

function educationEnrollmentResumeBody(value: unknown): EducationEnrollmentResumeBody {
  const body = record(value);
  const unexpected = Object.keys(body).filter((key) =>
    key !== "acknowledgeIndeterminate" && key !== "reason");
  if (unexpected.length > 0) {
    throw new CommsApiValidationError(
      "Enrollment resume accepts only acknowledgeIndeterminate and reason.",
    );
  }
  if (body.acknowledgeIndeterminate === undefined || body.acknowledgeIndeterminate === false) {
    if (body.reason !== undefined) {
      throw new CommsApiValidationError(
        "reason requires acknowledgeIndeterminate to be explicitly true.",
      );
    }
    return { acknowledgeIndeterminate: false };
  }
  if (body.acknowledgeIndeterminate !== true) {
    throw new CommsApiValidationError("acknowledgeIndeterminate must be boolean.");
  }
  return {
    acknowledgeIndeterminate: true,
    reason: requiredText(body.reason, "reason", 2_000),
  };
}

function educationDispatchBody(value: unknown): EducationDispatchBody {
  const body = record(value);
  const channel = body.channel;
  if (channel !== "sms" && channel !== "email" && channel !== "print") {
    throw new CommsApiValidationError("channel must be sms, email, or print.");
  }
  const lane = body.lane;
  if (lane !== "clinical" && lane !== "frontdesk") {
    throw new CommsApiValidationError("lane must be clinical or frontdesk.");
  }
  if (body.alsoUpdateChart !== undefined && typeof body.alsoUpdateChart !== "boolean") {
    throw new CommsApiValidationError("alsoUpdateChart must be boolean.");
  }
  return {
    patientReference: requiredPatientReference(body.patientReference),
    educationId: resourceKey(typeof body.educationId === "string" ? body.educationId : undefined, "education id"),
    version: requiredInteger(body.version, "version", 1, Number.MAX_SAFE_INTEGER),
    channel,
    lane,
    recipientOverride: recipientOverride(body.recipientOverride),
    alsoUpdateChart: body.alsoUpdateChart === true,
    encounterReference: optionalReference(body.encounterReference, "Encounter"),
    conditionReference: optionalReference(body.conditionReference, "Condition"),
    idempotencyKey: idempotencyKeyFromBody(body.idempotencyKey),
  };
}

function recipientOverride(value: unknown): EducationDispatchBody["recipientOverride"] {
  if (value === undefined) return undefined;
  const input = record(value);
  const reference = input.reference === undefined
    ? undefined
    : optionalRecipientReference(input.reference);
  const phone = input.phone === undefined ? undefined : requiredE164(input.phone, "recipientOverride.phone");
  const email = input.email === undefined ? undefined : requiredEmail(input.email, "recipientOverride.email");
  if (!phone && !email) {
    throw new CommsApiValidationError("recipientOverride must include phone or email.");
  }
  return { reference, phone, email };
}

function optionalRecipientReference(value: unknown): string {
  if (typeof value !== "string" || !/^(?:Patient|RelatedPerson)\/[A-Za-z0-9.-]{1,64}$/.test(value)) {
    throw new CommsApiValidationError("recipientOverride.reference must be Patient/<id> or RelatedPerson/<id>.");
  }
  return value;
}

function optionalReference(value: unknown, resourceType: "Encounter" | "Condition"): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !new RegExp(`^${resourceType}/[A-Za-z0-9.-]{1,64}$`).test(value)) {
    throw new CommsApiValidationError(`${resourceType.toLowerCase()}Reference must be ${resourceType}/<id>.`);
  }
  return value;
}

function requiredReference(
  value: unknown,
  resourceType: "Encounter",
  label: string,
): string {
  if (typeof value !== "string" || !new RegExp(`^${resourceType}/[A-Za-z0-9.-]{1,64}$`).test(value)) {
    throw new CommsApiValidationError(`${label} must be ${resourceType}/<id>.`);
  }
  return value;
}

function definitionKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new CommsApiValidationError(`${label} is invalid.`);
  }
  return value;
}

function idempotencyKeyFromBody(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new CommsApiValidationError("idempotencyKey is required.");
  }
  return value;
}

function educationSmsRole(lane: EducationDispatchBody["lane"]): CommsChannelRole {
  return lane === "clinical" ? "clinical-sms" : "transactional-sms";
}

function requireConfiguredRole(
  dispatch: CommsDispatch,
  role: CommsChannelRole,
  senderNumberRequired: boolean,
): void {
  if (!isRoleConfigured(dispatch, role, senderNumberRequired)) {
    throw new CommsApiCapabilityError(
      `Education ${role} lane is not configured; open communications setup to choose a provider${senderNumberRequired ? " and sender number" : ""}.`,
    );
  }
}

function isRoleConfigured(
  dispatch: CommsDispatch,
  role: CommsChannelRole,
  senderNumberRequired: boolean,
): boolean {
  return Boolean(
    dispatch.providerFor(role)
    && (!senderNumberRequired || dispatch.senderNumberFor(role)),
  );
}

async function resolveEducationRecipient(
  fhir: MedplumClient,
  patient: Patient,
  body: EducationDispatchBody,
): Promise<{ reference: string; value: string; resource: Patient | RelatedPerson }> {
  const reference = body.recipientOverride?.reference ?? body.patientReference;
  if (reference.startsWith("Patient/") && reference !== body.patientReference) {
    throw new CommsApiValidationError("recipientOverride Patient must match patientReference.");
  }
  const resource = reference === body.patientReference
    ? patient
    : await fhir.read<RelatedPerson>("RelatedPerson", reference.slice("RelatedPerson/".length));
  if (resource.resourceType === "RelatedPerson" && resource.patient.reference !== body.patientReference) {
    throw new CommsApiValidationError("recipientOverride RelatedPerson does not belong to this patient.");
  }
  const overridden = body.channel === "sms"
    ? body.recipientOverride?.phone
    : body.channel === "email"
      ? body.recipientOverride?.email
      : undefined;
  const recorded = body.channel === "sms"
    ? telecomValue(resource, "phone")
    : body.channel === "email"
      ? telecomValue(resource, "email")
      : reference;
  const value = overridden ?? recorded;
  if (!value) {
    throw new CommsApiCapabilityError(
      body.channel === "sms" ? "The selected recipient has no SMS number on file." : "The selected recipient has no email address on file.",
    );
  }
  return { reference, value, resource };
}

async function readPatient(fhir: MedplumClient, patientReference: string): Promise<Patient> {
  try {
    return await fhir.read<Patient>("Patient", patientReference.slice("Patient/".length));
  } catch (error) {
    if (isFhirNotFound(error)) throw new CommsApiNotFoundError("Patient not found.");
    throw error;
  }
}

async function assertEncounterBelongsToPatient(
  fhir: MedplumClient,
  encounterReference: string,
  patientReference: string,
): Promise<void> {
  let encounter: Encounter;
  try {
    encounter = await fhir.read<Encounter>(
      "Encounter",
      encounterReference.slice("Encounter/".length),
    );
  } catch (error) {
    if (isFhirNotFound(error)) throw new CommsApiNotFoundError("Encounter not found.");
    throw error;
  }
  if (encounter.subject?.reference !== patientReference) {
    throw new CommsApiValidationError(`encounterReference must belong to ${patientReference}.`);
  }
}

async function assertEducationClinicalReferences(
  fhir: MedplumClient,
  body: EducationDispatchBody,
): Promise<void> {
  if (body.encounterReference) {
    const encounter = await fhir.read<Encounter>("Encounter", body.encounterReference.slice("Encounter/".length));
    if (encounter.subject?.reference !== body.patientReference) {
      throw new CommsApiValidationError(`encounterReference must belong to ${body.patientReference}.`);
    }
  }
  if (body.conditionReference) {
    const condition = await fhir.read<Condition>("Condition", body.conditionReference.slice("Condition/".length));
    if (condition.subject.reference !== body.patientReference) {
      throw new CommsApiValidationError(`conditionReference must belong to ${body.patientReference}.`);
    }
  }
}

function assertEducationPublicBaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CommsApiCapabilityError(
      "Set ODOS_COMMS_PUBLIC_BASE_URL to the practice's reachable HTTPS base URL before sending tracked education links.",
    );
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new CommsApiCapabilityError(
      "Set ODOS_COMMS_PUBLIC_BASE_URL to the practice's reachable HTTPS base URL before sending tracked education links.",
    );
  }
}

async function educationSmsBody(
  deps: Pick<CommsApiRouteDeps, "trackedLinkStore" | "publicBaseUrl" | "practiceName">,
  input: { targetUrl: string; campaignId: string; messageId: string },
): Promise<string> {
  const tracked = await generateTrackedLink({
    store: deps.trackedLinkStore,
    publicBaseUrl: deps.publicBaseUrl,
    ...input,
  });
  return `${deps.practiceName}\n${tracked.url}\nReply STOP to opt out.`;
}

function telecomValue(resource: Patient | RelatedPerson, system: "phone" | "email"): string | undefined {
  const candidates = (resource.telecom ?? []).filter((telecom) =>
    telecom.system === system && telecom.value && telecom.use !== "old");
  const preferred = system === "phone"
    ? candidates.find((telecom) => telecom.use === "mobile") ?? candidates[0]
    : candidates[0];
  return preferred?.value;
}

async function persistAfterSend(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (!isFhirConflict(error)) throw error;
    throw new Error("Message accepted, but its delivery record could not be saved.", { cause: error });
  }
}

async function updateSentEducationRecipient(
  ...args: Parameters<typeof updateEducationRecipient>
): Promise<boolean> {
  try {
    await updateEducationRecipient(...args);
    return true;
  } catch (error) {
    if (!isFhirConflict(error)) throw error;
    return false;
  }
}

async function updateEducationRecipient(
  fhir: MedplumClient,
  recipient: { reference: string; resource: Patient | RelatedPerson },
  body: EducationDispatchBody,
  staff: EducationDispatchIdentity,
): Promise<void> {
  const system = body.channel === "sms" ? "phone" : body.channel === "email" ? "email" : undefined;
  const value = system === "phone" ? body.recipientOverride?.phone : body.recipientOverride?.email;
  if (!system || !value) {
    throw new CommsApiValidationError("alsoUpdateChart requires a phone or email recipient override.");
  }
  const resource = recipient.resource;
  if (resource.telecom?.some((entry) =>
    entry.system === system && entry.use !== "old" && entry.value === value)) return;
  if (!resource.id || !resource.meta?.versionId) {
    throw new CommsApiCapabilityError("The selected recipient cannot be updated without a current resource version.");
  }
  const telecom = (resource.telecom ?? []).map((entry) =>
    entry.system === system && entry.use !== "old" ? { ...entry, use: "old" as const } : entry);
  telecom.push({ system, value, ...(system === "phone" ? { use: "mobile" as const } : {}) });
  await fhir.update(resource.resourceType, resource.id, { ...resource, telecom }, {
    "If-Match": `W/\"${resource.meta.versionId}\"`,
    "X-ODOS-Source": "mcp/comms-education-recipient-update",
    "X-ODOS-Actor-Id": staff.staffReference,
  });
}

async function persistEducationSendProvenance(
  fhir: MedplumClient,
  input: {
    body: EducationDispatchBody;
    item: EducationContentItem;
    staff: EducationDispatchIdentity;
    recipientValue: string;
    laneSelection: "default" | "overridden";
    now: string;
  },
): Promise<void> {
  const targets = [
    input.body.patientReference,
    input.body.encounterReference,
    input.body.conditionReference,
  ].filter((reference): reference is string => Boolean(reference));
  const provenance: Provenance = {
    ...buildProvenance({
      targetReferences: targets,
      recorded: input.now,
      activityCode: "CREATE",
      activityDisplay: "Dispatch patient education",
      agents: [
        { whoReference: input.staff.staffReference, typeCode: "author" },
        ...(input.staff.executingReference ? [{ whoReference: input.staff.executingReference, typeCode: "performer" }] : []),
      ],
      entityValues: [
        { role: "source", display: `Education content: ${input.item.id}@${input.item.version}` },
        { role: "source", display: `Channel: ${input.body.channel}` },
        { role: "source", display: `Lane: ${input.body.lane} (${input.laneSelection})` },
        { role: "source", display: `Recipient: ${input.recipientValue}` },
        ...(input.body.alsoUpdateChart ? [{ role: "source" as const, display: "Recipient override also updated chart" }] : []),
      ],
    }),
    meta: {
      tag: [{
        system: ODOS_COMMS_EDUCATION_SEND_IDENTIFIER_SYSTEM,
        code: input.body.idempotencyKey,
      }],
    },
  };
  await fhir.create(provenance, {
    "If-None-Exist": `_tag=${ODOS_COMMS_EDUCATION_SEND_IDENTIFIER_SYSTEM}|${input.body.idempotencyKey}`,
  });
}

async function persistEducationEnrollmentProvenance(
  fhir: MedplumClient,
  input: {
    enrollment: EducationEnrollment;
    staff: CommsStaff;
    now: string;
  },
): Promise<void> {
  const eventKey = `enrollment:${input.enrollment.id}:create`;
  const provenance: Provenance = {
    ...buildProvenance({
      targetReferences: [
        input.enrollment.patientReference,
        input.enrollment.enteredFromEncounterReference,
        `Basic/${input.enrollment.id}`,
      ],
      recorded: input.now,
      activityCode: "CREATE",
      activityDisplay: "Enroll patient in education journey",
      agents: [{ whoReference: input.enrollment.stageHistory[0]!.enteredBy, typeCode: "author" }],
      entityValues: [
        {
          role: "source",
          display: `Journey: ${input.enrollment.journey.id}@${input.enrollment.journey.version}`,
        },
        { role: "source", display: `Initial stage: ${input.enrollment.stageHistory[0]!.stageId}` },
      ],
    }),
    meta: {
      tag: [{ system: ODOS_COMMS_EDUCATION_ENROLLMENT_EVENT_IDENTIFIER_SYSTEM, code: eventKey }],
    },
  };
  await fhir.create(provenance, {
    "If-None-Exist": `_tag=${ODOS_COMMS_EDUCATION_ENROLLMENT_EVENT_IDENTIFIER_SYSTEM}|${eventKey}`,
  });
}

async function persistEducationEnrollmentTransitionProvenance(
  fhir: MedplumClient,
  input: {
    enrollment: EducationEnrollment;
    fromStageId: string;
    toStageId?: string;
    trigger: string;
    status?: EducationEnrollment["status"];
    eventSequence?: number;
    enteredBy?: string;
    staff: CommsStaff;
    now: string;
  },
): Promise<void> {
  const eventKey = `enrollment:${input.enrollment.id}:transition:${input.eventSequence ?? input.enrollment.stageHistory.length}`;
  const provenance: Provenance = {
    ...buildProvenance({
      targetReferences: [
        input.enrollment.patientReference,
        input.enrollment.enteredFromEncounterReference,
        `Basic/${input.enrollment.id}`,
      ],
      recorded: input.now,
      activityCode: "UPDATE",
      activityDisplay: "Transition education journey enrollment",
      agents: [{ whoReference: input.enteredBy ?? input.staff.staffReference, typeCode: "author" }],
      entityValues: [
        {
          role: "source",
          display: `Stage transition: ${input.fromStageId} -> ${input.toStageId ?? input.enrollment.currentStageId}`,
        },
        { role: "source", display: `Trigger: ${input.trigger}` },
        { role: "source", display: `Status: ${input.status ?? input.enrollment.status}` },
      ],
    }),
    meta: {
      tag: [{ system: ODOS_COMMS_EDUCATION_ENROLLMENT_EVENT_IDENTIFIER_SYSTEM, code: eventKey }],
    },
  };
  await fhir.create(provenance, {
    "If-None-Exist": `_tag=${ODOS_COMMS_EDUCATION_ENROLLMENT_EVENT_IDENTIFIER_SYSTEM}|${eventKey}`,
  });
}

async function persistEducationEnrollmentIndeterminateProvenance(
  fhir: MedplumClient,
  input: {
    enrollment: EducationEnrollment;
    sendIndex: number;
    acknowledgement: NonNullable<EducationEnrollmentImmediateSend["acknowledgement"]>;
    staff: CommsStaff;
  },
): Promise<void> {
  const send = input.enrollment.immediateSends[input.sendIndex];
  if (!send) throw new Error("EducationEnrollment immediate send index is invalid.");
  const eventKey = `enrollment:${input.enrollment.id}:send:${input.sendIndex + 1}:indeterminate`;
  const provenance: Provenance = {
    ...buildProvenance({
      targetReferences: [
        input.enrollment.patientReference,
        input.enrollment.enteredFromEncounterReference,
        `Basic/${input.enrollment.id}`,
      ],
      recorded: input.acknowledgement.acknowledgedAt,
      activityCode: "UPDATE",
      activityDisplay: "Acknowledge indeterminate education send",
      agents: [{ whoReference: input.staff.staffReference, typeCode: "author" }],
      entityValues: [
        { role: "source", display: `Immediate send: ${input.sendIndex + 1}` },
        { role: "source", display: `Idempotency key: ${send.idempotencyKey ?? "legacy-unrecorded"}` },
        { role: "source", display: `Reason: ${input.acknowledgement.reason}` },
      ],
    }),
    meta: {
      tag: [{ system: ODOS_COMMS_EDUCATION_ENROLLMENT_EVENT_IDENTIFIER_SYSTEM, code: eventKey }],
    },
  };
  await fhir.create(provenance, {
    "If-None-Exist": `_tag=${ODOS_COMMS_EDUCATION_ENROLLMENT_EVENT_IDENTIFIER_SYSTEM}|${eventKey}`,
  });
}

function requiredEmail(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new CommsApiValidationError(`${label} must be a valid email address.`);
  }
  return value.trim();
}

function numberFromQuery(req: Request, name: string, min: number, max: number): number | undefined {
  const value = queryString(req, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CommsApiValidationError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function queryString(req: Request, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = req.query[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function resourceKey(value: string | string[] | undefined, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9.-]{1,128}$/.test(value)) {
    throw new CommsApiValidationError(`${label} is invalid.`);
  }
  return value;
}

function educationDxCodeFromQuery(req: Request): string | undefined {
  const value = queryString(req, "dxCode");
  if (value === undefined) return undefined;
  if (!/^[A-Z][0-9A-Z]{1,2}(?:\.[0-9A-Z]{1,4})?$/.test(value)) {
    throw new CommsApiValidationError("dxCode is invalid.");
  }
  return value;
}

function educationChannelFromQuery(req: Request): EducationContentItem["channels"][number] | undefined {
  const value = queryString(req, "channel");
  if (value === undefined) return undefined;
  if (value !== "sms" && value !== "email" && value !== "print") {
    throw new CommsApiValidationError("channel must be sms, email, or print.");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validatedPreferenceInput<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) { throw new CommsApiValidationError(error instanceof Error ? error.message : "Invalid communication preferences."); }
}

async function preferenceAccess<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 403) {
      throw new CommsPreferencePermissionError();
    }
    if (isFhirNotFound(error)) throw new CommsApiNotFoundError("Patient or consent evidence not found.");
    throw error;
  }
}
async function preferencePractitioner(staff: CommsStaff): Promise<string> {
  const reference = await preferenceAccess(() => resolvePractitionerReference(staff.fhir, staff.staffReference));
  if (!reference) throw new CommsApiValidationError("Communication preferences require a staff Practitioner.");
  return reference;
}
