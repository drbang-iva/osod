import { resolvePractitionerReference } from "../authz/practitioner-reference.js";
import { buildCommsConsent, communicationPreferencesInputSchema, parsePreferenceWriteInput } from "../comms/comms-preferences.js";
import { replaceCommsPreferenceCells } from "../comms/suppression-gate.js";
import { randomInt, randomUUID } from "node:crypto";
import type {
  Account,
  Bundle,
  BundleEntry,
  Patient,
  Project,
  Reference,
  RelatedPerson,
  Resource,
} from "@medplum/fhirtypes";
import { z } from "zod";
import { grantNewlyRegisteredPatientAccess } from "../authz/role-grants.js";
import { assertBusinessActionAllowed, staffHasBusinessAction, type BusinessAction, type PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { searchProjectAll } from "../fhir-search.js";
import {
  ODOS_MRN_MAX,
  ODOS_MRN_MIN,
  ODOS_MRN_ALLOCATION_TOKEN_SYSTEM,
  ODOS_MRN_SYSTEM,
  reserveOdosMrn,
  type ReservedMrn,
} from "./patient-mrn.js";

const CONSENT_AUTHORITY_EXTENSION_URL = "https://odos2020.com/fhir/StructureDefinition/related-person-consent-authority";
const RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL = "https://odos2020.com/fhir/StructureDefinition/related-person-primary";
const COURT_ORDER_NOTES_EXTENSION_URL = "https://odos2020.com/fhir/StructureDefinition/related-person-court-order-notes";

const demographicsSchema = z.object({
  firstName: z.string(), middleName: z.string(), lastName: z.string(), preferredName: z.string(),
  birthDate: z.string(), gender: z.enum(["male", "female", "other", "unknown"]),
  phone: z.string(), email: z.string(), address: z.string(), city: z.string(), state: z.string(), postalCode: z.string(),
}).strict();

const responsiblePartySchema = z.object({
  localId: z.string().min(1), kind: z.enum(["self", "person"]),
  relationship: z.enum(["parent", "legal-guardian", "spouse", "other"]),
  firstName: z.string(), middleName: z.string(), lastName: z.string(), phone: z.string(),
  address: z.string(), city: z.string(), state: z.string(), postalCode: z.string(),
  financialResponsible: z.boolean(), consentAuthority: z.boolean(), primary: z.boolean(),
  courtOrderNotes: z.string(), effectiveDate: z.string(), endDate: z.string(),
}).strict();

const patientRegistrationInputSchema = z.object({
  demographics: demographicsSchema,
  responsibleParties: z.array(responsiblePartySchema),
  confirmDuplicate: z.boolean().default(false),
  communicationPreferences: communicationPreferencesInputSchema.optional(),
}).strict();

export type PatientRegistrationInput = z.infer<typeof patientRegistrationInputSchema>;
type ResponsiblePartyInput = PatientRegistrationInput["responsibleParties"][number];

export interface PatientRegistrationStaff {
  staffReference: string;
  actorRole: PracticeRoleId;
  roles: readonly PracticeRoleId[];
  businessActions?: readonly BusinessAction[];
  project: Reference<Project>;
}

export interface PatientRegistrationEndpointDeps {
  serviceFhir: Pick<MedplumClient, "baseUrl" | "search" | "searchProject" | "searchProjectUrl" | "create" | "read" | "update" | "patch" | "executeTransactionAsActor">;
  now?: () => string;
  logGrantFailure?: (message: string, error: unknown) => void;
}

export type PatientRegistrationEndpointResult = { status: number; body: unknown };

export function parsePatientRegistrationInput(input: unknown) {
  return patientRegistrationInputSchema.safeParse(input);
}

export async function registerPatientFromDemographics(
  input: PatientRegistrationInput,
  staff: PatientRegistrationStaff,
  deps: PatientRegistrationEndpointDeps,
): Promise<PatientRegistrationEndpointResult> {
  try {
    assertBusinessActionAllowed(staff.actorRole, "patients.register");
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 403 });
  }
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  let preferencePractitioner: string | undefined;
  if (input.communicationPreferences) {
    if (!staffHasBusinessAction(staff, "communications.preferences.manage")) {
      throw Object.assign(new Error("communications.preferences.manage role required"), { status: 403 });
    }
    try {
      parsePreferenceWriteInput({ patientReference: "Patient/registration", ...input.communicationPreferences }, recordedAt);
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error("Invalid communication preferences."), { status: 400 });
    }
    preferencePractitioner = await resolvePractitionerReference(deps.serviceFhir, staff.staffReference);
    if (!preferencePractitioner) throw new Error("Registration preferences require the registering Practitioner.");
  }
  const today = registrationDate(recordedAt);
  validateRegistration(input, today);
  const projectId = registrationProjectId(staff.project);
  const duplicates = await findExactDuplicates(deps.serviceFhir, projectId, input.demographics);
  if (duplicates.length > 0 && !input.confirmDuplicate) {
    return { status: 409, body: { kind: "duplicates", patients: duplicates } };
  }

  const reservation = await reserveMrn(deps.serviceFhir, projectId);
  const request = buildPatientIdentityTransaction(input, reservation, today, projectId, preferencePractitioner, recordedAt);
  let response: Bundle;
  try {
    response = await deps.serviceFhir.executeTransactionAsActor(
      request,
      {
        actorReference: staff.staffReference,
        actorRole: staff.actorRole,
        actionReason: "patients.register service transaction: Patient, RelatedPerson, Account",
      },
      { "X-ODOS-Source": "mcp/patient-registration" },
      {
        autoRollbackCreatedEntries: false,
        validateResponse: assertTransactionSuccess,
        reconcileError: (error) => reconcileUnknownTransactionOutcome(deps.serviceFhir, reservation, error),
      },
    );
  } catch (error) {
    if (error instanceof ConfirmedRegistrationTransactionFailure) {
      await deps.serviceFhir.update<Account>(
        "Account",
        reservation.account.id!,
        { ...reservation.account, status: "entered-in-error" },
        {
          ...(reservation.account.meta?.versionId
            ? { "If-Match": `W/"${reservation.account.meta.versionId}"` }
            : {}),
          "X-ODOS-Source": "mcp/patient-registration-rollback",
        },
      );
      throw error.transactionError;
    }
    throw error;
  }

  const patientId = createdIdFromEntry(response, 0, "Patient");
  const patient = await deps.serviceFhir.read<Patient>("Patient", patientId);
  try {
    await grantNewlyRegisteredPatientAccess(
      {
        staffReference: staff.staffReference,
        project: staff.project,
        registrationRequest: request,
        registrationResponse: response,
      },
      { serviceFhir: deps.serviceFhir },
    );
    return { status: 201, body: { kind: "created", patient } };
  } catch (error) {
    const patientReference = `Patient/${patientId}`;
    deps.logGrantFailure?.(
      `odos-mcp: patient registration access grant failed for ${patientReference}; registration preserved.`,
      error,
    );
    return {
      status: 201,
      body: {
        kind: "created",
        patient,
        warning: {
          code: "access-grant-repair-required",
          message: "The patient was registered, but your access grant did not attach. Ask a practice administrator to repair your patient access, then open the chart again.",
          patientReference,
        },
      },
    };
  }
}

async function reserveMrn(
  fhir: Pick<MedplumClient, "search" | "create">,
  projectId: string,
): Promise<ReservedMrn> {
  return reserveOdosMrn(
    {
      patientIdentifierExists: async (mrn) => {
        const existing = await fhir.search<Patient>("Patient", {
          identifier: `${ODOS_MRN_SYSTEM}|${mrn}`,
          _count: "1",
        });
        return (existing.entry ?? []).some((entry) => entry.resource?.identifier?.some(
          (identifier) => identifier.system === ODOS_MRN_SYSTEM && identifier.value === mrn
        ));
      },
      createReservation: (account, ifNoneExist) => fhir.create<Account>(
        registrationResourceInProject(account, projectId),
        {
          "If-None-Exist": ifNoneExist,
          "X-Medplum": "extended",
          "X-ODOS-Source": "mcp/patient-mrn-reservation",
        },
      ),
    },
    () => randomInt(ODOS_MRN_MIN, ODOS_MRN_MAX + 1),
    randomUUID,
  );
}

function buildPatientIdentityTransaction(
  input: PatientRegistrationInput,
  reservation: ReservedMrn,
  today: string,
  projectId: string,
  preferencePractitioner?: string,
  recordedAt?: string,
): Bundle {
  const patientFullUrl = `urn:uuid:${randomUUID()}`;
  let patient = registrationResourceInProject<Patient>({
    resourceType: "Patient",
    active: true,
    identifier: [{ use: "usual", type: { text: "ODOS medical record number" }, system: ODOS_MRN_SYSTEM, value: reservation.mrn }],
    name: [
      { use: "official", given: [input.demographics.firstName.trim(), input.demographics.middleName.trim()].filter(Boolean), family: input.demographics.lastName.trim() },
      ...(input.demographics.preferredName.trim() ? [{ use: "usual" as const, given: [input.demographics.preferredName.trim()] }] : []),
    ],
    birthDate: input.demographics.birthDate,
    gender: input.demographics.gender,
    telecom: [
      { system: "phone", use: "home", value: input.demographics.phone.trim() },
      ...(input.demographics.email.trim() ? [{ system: "email" as const, use: "home" as const, value: input.demographics.email.trim() }] : []),
    ],
    address: [input.demographics.address, input.demographics.city, input.demographics.state, input.demographics.postalCode].some((value) => value.trim())
      ? [{ use: "home", line: input.demographics.address.trim() ? [input.demographics.address.trim()] : undefined, city: input.demographics.city.trim() || undefined, state: input.demographics.state.trim() || undefined, postalCode: input.demographics.postalCode.trim() || undefined }]
      : undefined,
  }, projectId);
  let consentEntry: BundleEntry | undefined;
  if (input.communicationPreferences) {
    const preferences = input.communicationPreferences;
    const actor = { actorReference: preferencePractitioner!, actorRole: "staff" as const, recordedAt: recordedAt!, surface: "staff-registration" as const };
    const evidenceReference = preferences.confirmedVia ? `urn:uuid:${randomUUID()}` : undefined;
    patient = replaceCommsPreferenceCells(patient, preferences.cells.map(cell => ({ ...cell, ...(evidenceReference ? { evidence: { reference: evidenceReference } } : {}) })), {
      setBy: { reference: preferencePractitioner! }, surface: "staff-registration", recordedAt: recordedAt!,
    });
    if (evidenceReference) consentEntry = {
      fullUrl: evidenceReference,
      resource: registrationResourceInProject(buildCommsConsent(patientFullUrl, preferences.cells, preferences.confirmedVia!, actor, preferences.formDate), projectId),
      request: { method: "POST", url: "Consent" },
    };
  }
  const entries: BundleEntry[] = [{ fullUrl: patientFullUrl, resource: patient, request: { method: "POST", url: "Patient" } }];
  if (consentEntry) entries.push(consentEntry);
  const partyReferences = new Map<string, string>();
  for (const party of input.responsibleParties) {
    if (party.kind === "self") {
      partyReferences.set(party.localId, patientFullUrl);
      continue;
    }
    const fullUrl = `urn:uuid:${randomUUID()}`;
    partyReferences.set(party.localId, fullUrl);
    entries.push({
      fullUrl,
      resource: registrationResourceInProject(buildRelatedPerson(party, patientFullUrl, today), projectId),
      request: { method: "POST", url: "RelatedPerson" },
    });
  }
  const account = registrationResourceInProject<Account>({
    resourceType: "Account",
    id: reservation.account.id,
    meta: reservation.account.meta,
    identifier: [{ use: "usual", type: { text: "ODOS medical record number" }, system: ODOS_MRN_SYSTEM, value: reservation.mrn }],
    status: "active",
    type: { text: "Patient account" },
    name: `ODOS chart ${reservation.mrn}`,
    subject: [{ reference: patientFullUrl }],
    guarantor: input.responsibleParties.flatMap((party) => {
      if (!party.financialResponsible) return [];
      const reference = partyReferences.get(party.localId);
      if (!reference) throw new Error("Responsible party reference was not built.");
      return [{ party: { reference }, onHold: false, ...(party.kind === "person" ? { period: responsiblePartyPeriod(party) } : {}) }];
    }),
  }, projectId);
  entries.push({
    resource: account,
    request: { method: "PUT", url: `Account/${account.id}`, ...(account.meta?.versionId ? { ifMatch: `W/"${account.meta.versionId}"` } : {}) },
  });
  return { resourceType: "Bundle", type: "transaction", entry: entries };
}

function registrationResourceInProject<T extends Resource>(resource: T, projectId: string): T {
  const existingProjectId = resource.meta?.project?.replace(/^Project\//, "");
  if (existingProjectId && existingProjectId !== projectId) {
    throw new Error(`Registration resource belongs to Project/${existingProjectId}, not Project/${projectId}.`);
  }
  return { ...resource, meta: { ...resource.meta, project: projectId } };
}

function buildRelatedPerson(party: ResponsiblePartyInput, patientReference: string, today: string): RelatedPerson {
  return {
    resourceType: "RelatedPerson",
    active: responsiblePartyActiveOn(party, today),
    patient: { reference: patientReference },
    relationship: [{ text: party.relationship === "legal-guardian" ? "Legal guardian" : capitalize(party.relationship) }],
    name: [{ use: "official", given: [party.firstName.trim(), party.middleName.trim()].filter(Boolean), family: party.lastName.trim() }],
    telecom: party.phone.trim() ? [{ system: "phone", use: "home", value: party.phone.trim() }] : undefined,
    address: [party.address, party.city, party.state, party.postalCode].some((value) => value.trim())
      ? [{ use: "home", line: party.address.trim() ? [party.address.trim()] : undefined, city: party.city.trim() || undefined, state: party.state.trim() || undefined, postalCode: party.postalCode.trim() || undefined }]
      : undefined,
    period: responsiblePartyPeriod(party),
    extension: [
      { url: CONSENT_AUTHORITY_EXTENSION_URL, valueBoolean: party.consentAuthority },
      { url: RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL, valueBoolean: party.primary },
      ...(party.courtOrderNotes.trim() ? [{ url: COURT_ORDER_NOTES_EXTENSION_URL, valueString: party.courtOrderNotes.trim() }] : []),
    ],
  };
}

async function findExactDuplicates(
  fhir: Pick<MedplumClient, "baseUrl" | "searchProject" | "searchProjectUrl">,
  projectId: string,
  demographics: PatientRegistrationInput["demographics"],
): Promise<Patient[]> {
  const patients = await searchProjectAll<Patient>(fhir, "Patient", projectId, {
    given: demographics.firstName.trim(), family: demographics.lastName.trim(), birthdate: demographics.birthDate,
  });
  if (patients.some((patient) => patient.meta?.project?.replace(/^Project\//, "") !== projectId)) {
    throw new Error("Project-scoped duplicate search returned a Patient outside the caller project.");
  }
  return patients.filter((patient) => {
    const name = patient.name?.find((candidate) => candidate.use === "official") ?? patient.name?.[0];
    return normalized(name?.given?.[0]) === normalized(demographics.firstName) &&
      normalized(name?.family) === normalized(demographics.lastName) && patient.birthDate === demographics.birthDate;
  });
}

function registrationProjectId(project: Reference<Project>): string {
  const projectId = project.reference?.match(/^Project\/([A-Za-z0-9.-]{1,64})$/)?.[1];
  if (!projectId) throw new Error("Registration caller is missing a valid project reference.");
  return projectId;
}

function validateRegistration(input: PatientRegistrationInput, today: string): void {
  const errors: string[] = [];
  if (!input.demographics.firstName.trim()) errors.push("Legal first name is required.");
  if (!input.demographics.lastName.trim()) errors.push("Legal last name is required.");
  if (!isR4Date(input.demographics.birthDate)) errors.push("Date of birth must be a valid YYYY-MM-DD date.");
  if (!isPhoneNumber(input.demographics.phone)) errors.push("Enter a valid phone number.");
  if (input.demographics.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.demographics.email.trim())) errors.push("Enter a valid email address.");
  if (input.responsibleParties.length === 0) errors.push("At least one responsible party is required.");
  if (new Set(input.responsibleParties.map((party) => party.localId)).size !== input.responsibleParties.length) {
    errors.push("Responsible-party identifiers must be unique.");
  }
  const minor = isR4Date(input.demographics.birthDate) && `${Number(input.demographics.birthDate.slice(0, 4)) + 18}${input.demographics.birthDate.slice(4)}` > today;
  const selfCount = input.responsibleParties.filter((party) => party.kind === "self").length;
  if (selfCount > 1) errors.push("The patient can appear as self only once.");
  if (minor && input.responsibleParties.some((party) => party.kind === "self")) errors.push("A minor cannot be registered as their own responsible party.");
  if (!input.responsibleParties.some((party) => party.financialResponsible && responsiblePartyActiveOn(party, today))) errors.push("At least one current financially responsible party is required.");
  if (minor && !input.responsibleParties.some((party) => party.consentAuthority && responsiblePartyActiveOn(party, today))) errors.push("A minor must have at least one current consent-authority party.");
  const relatedParties = input.responsibleParties.filter((party) => party.kind === "person");
  const activePeople = relatedParties.filter((party) => responsiblePartyActiveOn(party, today));
  if (activePeople.length > 0 && activePeople.filter((party) => party.primary).length !== 1) errors.push("Choose exactly one current related person as primary.");
  for (const party of input.responsibleParties) {
    if (party.financialResponsible && [party.address, party.city, party.state, party.postalCode].some((value) => !value.trim())) errors.push("A guarantor mailing address is required.");
  }
  for (const party of relatedParties) {
    if (!party.firstName.trim() || !party.lastName.trim()) errors.push("Responsible-party name is required.");
    if (!isR4Date(party.effectiveDate)) errors.push("A valid responsible-party effective date is required.");
    if (party.endDate && !isR4Date(party.endDate)) errors.push("Responsible-party end date must be valid.");
    if (party.endDate && party.endDate < party.effectiveDate) errors.push("Responsible-party end date cannot precede the effective date.");
  }
  if (errors.length > 0) throw Object.assign(new Error(errors.join(" ")), { status: 400 });
}

function registrationDate(now: string | undefined): string { return (now ?? new Date().toISOString()).slice(0, 10); }

function assertTransactionSuccess(bundle: Bundle): void {
  const failure = (bundle.entry ?? []).find((entry) => !/^2\d\d/.test(entry.response?.status ?? ""));
  if (failure) throw new Error(`Patient registration transaction failed: ${failure.response?.status ?? "missing status"}.`);
}

class ConfirmedRegistrationTransactionFailure extends Error {
  constructor(readonly transactionError: unknown) {
    super("Patient registration transaction did not commit.", { cause: transactionError });
  }
}

async function reconcileUnknownTransactionOutcome(
  fhir: Pick<MedplumClient, "read">,
  reservation: ReservedMrn,
  transactionError: unknown,
): Promise<Bundle> {
  let account: Account;
  try {
    account = await fhir.read<Account>("Account", reservation.account.id!);
  } catch {
    throw transactionError;
  }
  if (isUnchangedReservation(account, reservation)) {
    throw new ConfirmedRegistrationTransactionFailure(transactionError);
  }
  const patientId = committedRegistrationPatientId(account, reservation);
  if (!patientId) throw transactionError;
  return {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [{ response: { status: "201 Created", location: `Patient/${patientId}` } }],
  };
}

function isUnchangedReservation(account: Account, reservation: ReservedMrn): boolean {
  return sameReservationAccount(account, reservation)
    && account.status === "on-hold"
    && account.name === `Pending ODOS chart ${reservation.mrn}`
    && !account.subject?.length
    && hasIdentifier(account, ODOS_MRN_ALLOCATION_TOKEN_SYSTEM, reservation.allocationToken);
}

function committedRegistrationPatientId(account: Account, reservation: ReservedMrn): string | undefined {
  if (
    !sameReservationAccount(account, reservation)
    || account.status !== "active"
    || account.name !== `ODOS chart ${reservation.mrn}`
    || account.subject?.length !== 1
  ) {
    return undefined;
  }
  return account.subject[0]?.reference?.match(/^Patient\/([A-Za-z0-9.-]{1,64})$/)?.[1];
}

function sameReservationAccount(account: Account, reservation: ReservedMrn): boolean {
  const reservationProject = reservation.account.meta?.project?.replace(/^Project\//, "");
  return Boolean(
    account.id === reservation.account.id
    && reservationProject
    && account.meta?.project?.replace(/^Project\//, "") === reservationProject
    && hasIdentifier(account, ODOS_MRN_SYSTEM, reservation.mrn),
  );
}

function hasIdentifier(account: Account, system: string, value: string): boolean {
  return account.identifier?.some((identifier) => identifier.system === system && identifier.value === value) ?? false;
}

function createdIdFromEntry(bundle: Bundle, index: number, resourceType: string): string {
  const id = bundle.entry?.[index]?.response?.location?.match(new RegExp(`^${resourceType}/([A-Za-z0-9.-]{1,64})(?:/|$)`))?.[1];
  if (!id) throw new Error(`Transaction response did not identify the created ${resourceType}.`);
  return id;
}

function responsiblePartyPeriod(party: ResponsiblePartyInput): { start?: string; end?: string } {
  return { ...(party.effectiveDate ? { start: party.effectiveDate } : {}), ...(party.endDate ? { end: party.endDate } : {}) };
}

function responsiblePartyActiveOn(party: ResponsiblePartyInput, today: string): boolean {
  if (party.kind === "self") return true;
  return (!party.effectiveDate || party.effectiveDate <= today) && (!party.endDate || party.endDate >= today);
}

function isR4Date(value: string): boolean {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : undefined;
  return Boolean(date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value);
}

function isPhoneNumber(value: string): boolean {
  if (!/^\+?[\d\s().-]+(?:\s*(?:x|ext\.?)\s*\d+)?$/i.test(value.trim())) return false;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

function normalized(value: string | undefined): string { return value?.trim().toLocaleLowerCase() ?? ""; }
function capitalize(value: string): string { return value[0]!.toUpperCase() + value.slice(1); }
