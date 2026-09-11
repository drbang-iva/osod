import type { Bundle, Communication, Patient, Provenance, Reference, Resource } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../authz/roles.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import type { MedplumClient } from "../fhir-client.js";
import type {
  CallRequest,
  CommsProvider,
  SendEmailRequest,
  SendResult,
  SendSmsRequest,
} from "./comms-provider.js";
import type { InboundMessageEvent, InboundOptOutType } from "./inbound-receiver.js";

export const ODOS_COMMS_MARKETING_CONSENT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-comms-marketing-consent";
export const ODOS_COMMS_OPT_OUT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-comms-opt-out";
export const ODOS_PATIENT_TIMEZONE_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-patient-timezone";
export const ODOS_COMMS_CAMPAIGN_TYPE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/comms-campaign-type";
export const ODOS_COMMS_SEND_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/comms-send";

export const COMMS_PURPOSES = ["recalls", "appointment", "product-pickup", "marketing-promo", "education"] as const;
export type CommsPurpose = typeof COMMS_PURPOSES[number];
export const COMMS_PREFERENCE_CHANNELS = ["sms", "call", "email", "mail"] as const;
export type CommsPreferenceChannel = typeof COMMS_PREFERENCE_CHANNELS[number];
export const PURPOSE_BY_CAMPAIGN_TYPE = {
  "appointment-reminder": "appointment",
  "clinical-education": "education",
} as const satisfies Record<string, CommsPurpose>;
export const MATRIX_EXEMPT_CAMPAIGN_TYPES = ["staff-initiated"] as const;
export const COMMS_PREFERENCE_DEFAULTS_VERSION = "2026-09-10";
export const COMMS_PREFERENCE_DEFAULTS: Record<CommsPurpose, Record<CommsPreferenceChannel, boolean>> = {
  recalls: { sms: true, call: true, email: true, mail: true },
  appointment: { sms: true, call: true, email: true, mail: true },
  "product-pickup": { sms: true, call: true, email: true, mail: true },
  "marketing-promo": { sms: false, call: false, email: true, mail: true },
  education: { sms: true, call: false, email: true, mail: true },
};

export function communicationPurpose(campaignType: string, consentClass?: "transactional" | "marketing"): CommsPurpose | undefined {
  if (consentClass === "marketing") return "marketing-promo";
  if ((MATRIX_EXEMPT_CAMPAIGN_TYPES as readonly string[]).includes(campaignType)) return undefined;
  const purpose = Object.hasOwn(PURPOSE_BY_CAMPAIGN_TYPE, campaignType)
    ? (PURPOSE_BY_CAMPAIGN_TYPE as Record<string, CommsPurpose>)[campaignType] : undefined;
  if (purpose) return purpose;
  throw new Error(`Communications campaignType "${campaignType}" has no communication purpose; register it in PURPOSE_BY_CAMPAIGN_TYPE.`);
}

export const ODOS_COMMS_PREFERENCE_URL = "https://odos2020.com/fhir/StructureDefinition/odos-comms-preference";
export const COMMS_PREFERENCE_SURFACES = ["staff-demographics", "staff-registration", "staff-manual-send", "inbound-start"] as const;
export type CommsPreferenceSurface = typeof COMMS_PREFERENCE_SURFACES[number];
export interface CommsPreferenceInput {
  purpose: CommsPurpose;
  channel: CommsPreferenceChannel;
  allowed: boolean;
  evidence?: Reference;
}
export interface CommsPreferenceMetadata {
  recordedAt: string;
  setBy: Reference;
  surface: CommsPreferenceSurface;
}
export interface EffectiveCell extends Partial<CommsPreferenceMetadata> {
  value: boolean;
  source: "suppression" | "explicit" | "legacy-marketing-consent" | "default";
  evidence?: Reference;
}
export type ExplicitCommsPreference = CommsPreferenceInput & CommsPreferenceMetadata;

export function readCommsPreferenceCells(patient: Patient): ExplicitCommsPreference[] {
  const seen = new Set<string>();
  return (patient.extension ?? []).filter(e => e.url === ODOS_COMMS_PREFERENCE_URL).map(e => {
    const parts = e.extension ?? [];
    const required = ["purpose", "channel", "allowed", "recordedAt", "setBy", "surface"];
    const fail = (): never => { throw new Error("Malformed or duplicate communication preference extension."); };
    if (Object.keys(e).some(k => k.startsWith("value")) || parts.some(p => ![...required, "evidence"].includes(p.url))
      || required.some(name => parts.filter(p => p.url === name).length !== 1)
      || parts.filter(p => p.url === "evidence").length > 1) fail();
    const value = (name: string, key: string): unknown => {
      const part = parts.find(p => p.url === name);
      if (!part) return undefined;
      if (part.extension || Object.keys(part).filter(k => k.startsWith("value")).some(k => k !== key)) fail();
      return (part as unknown as Record<string, unknown>)[key];
    };
    const purpose = value("purpose", "valueCode") as CommsPurpose;
    const channel = value("channel", "valueCode") as CommsPreferenceChannel;
    const allowed = value("allowed", "valueBoolean") as boolean;
    const recordedAt = value("recordedAt", "valueDateTime") as string;
    const setBy = value("setBy", "valueReference") as Reference;
    const surface = value("surface", "valueCode") as CommsPreferenceSurface;
    const evidence = value("evidence", "valueReference") as Reference | undefined;
    if (!COMMS_PURPOSES.includes(purpose) || !COMMS_PREFERENCE_CHANNELS.includes(channel)
      || typeof allowed !== "boolean" || typeof recordedAt !== "string" || Number.isNaN(Date.parse(recordedAt))
      || !/^(Practitioner|Patient|RelatedPerson)\/[A-Za-z0-9.-]{1,64}$/.test(setBy?.reference ?? "")
      || !COMMS_PREFERENCE_SURFACES.includes(surface)
      || (parts.some(p => p.url === "evidence") && !/^(Consent\/[A-Za-z0-9.-]{1,64}|urn:uuid:[A-Za-z0-9-]+)$/.test(evidence?.reference ?? ""))) fail();
    const pair = `${purpose}/${channel}`;
    if (seen.has(pair)) fail();
    seen.add(pair);
    return { purpose, channel, allowed, recordedAt, setBy, surface, ...(evidence ? { evidence } : {}) };
  });
}

export function replaceCommsPreferenceCells(patient: Patient, cells: CommsPreferenceInput[], metadata: CommsPreferenceMetadata): Patient {
  readCommsPreferenceCells(patient);
  const extensions: NonNullable<Patient["extension"]> = cells.map(cell => ({
    url: ODOS_COMMS_PREFERENCE_URL,
    extension: [
      { url: "purpose", valueCode: cell.purpose }, { url: "channel", valueCode: cell.channel },
      { url: "allowed", valueBoolean: cell.allowed }, { url: "recordedAt", valueDateTime: metadata.recordedAt },
      { url: "setBy", valueReference: metadata.setBy }, { url: "surface", valueCode: metadata.surface },
      ...(cell.evidence ? [{ url: "evidence", valueReference: cell.evidence }] : []),
    ],
  }));
  readCommsPreferenceCells({ resourceType: "Patient", extension: extensions });
  const next = { ...patient, extension: [
    ...(patient.extension ?? []).filter(e => e.url !== ODOS_COMMS_PREFERENCE_URL || !cells.some(cell =>
      e.extension?.some(p => p.url === "purpose" && p.valueCode === cell.purpose)
      && e.extension?.some(p => p.url === "channel" && p.valueCode === cell.channel))),
    ...extensions,
  ] };
  return next;
}

export function effectiveCommsPreferences(patient: Patient, options: { smsSenderNumber?: string; stopScope?: SmsStopScope }): Record<CommsPurpose, Record<CommsPreferenceChannel, EffectiveCell>> {
  const explicit = readCommsPreferenceCells(patient);
  return Object.fromEntries(COMMS_PURPOSES.map(purpose => [purpose, Object.fromEntries(COMMS_PREFERENCE_CHANNELS.map(channel => {
    let cell: EffectiveCell;
    if (isOptedOut(patient, channel, "", channel === "sms" ? options.smsSenderNumber : undefined, options.stopScope ?? "per-number")) {
      cell = { value: false, source: "suppression" };
    } else {
      const stored = explicit.find(c => c.purpose === purpose && c.channel === channel);
      if (stored) {
        const { allowed, purpose: _purpose, channel: _channel, ...metadata } = stored;
        cell = { value: allowed, source: "explicit", ...metadata };
      } else if (purpose === "marketing-promo" && channel === "sms" && hasRecordedMarketingConsent(patient)) {
        cell = { value: true, source: "legacy-marketing-consent" };
      } else {
        cell = { value: COMMS_PREFERENCE_DEFAULTS[purpose][channel], source: "default" };
      }
    }
    return [channel, cell];
  }))])) as Record<CommsPurpose, Record<CommsPreferenceChannel, EffectiveCell>>;
}

export type SuppressionFhir = Pick<MedplumClient, "baseUrl" | "read" | "search" | "searchUrl">;
export type InboundSuppressionFhir = Pick<MedplumClient, "search" | "searchUrl" | "update">;
export type SmsOptOutManagementFhir = Pick<MedplumClient, "read" | "executeTransactionAsActor">;
export const SMS_OPT_OUT_IDENTITY_VERIFICATION_METHODS = [
  "in-person",
  "phone-verified",
  "portal",
] as const;
export type SmsOptOutIdentityVerification = typeof SMS_OPT_OUT_IDENTITY_VERIFICATION_METHODS[number];
export type SmsStopScope = "per-number" | "global";

export interface InboundSuppressionResult {
  outcome: "opted-out" | "opted-in" | "opt-in-refused-shared-number" | "opt-in-refused-broader-opt-out" | "unchanged" | "no-patient-match";
  matchedPatients: number;
  remainingOptOuts?: {
    global: boolean;
    numbers: string[];
  };
}

export interface SuppressionGateDeps {
  fhir: SuppressionFhir;
  practiceTimeZone: string;
  smsSenderNumber?: string;
  stopScope?: SmsStopScope;
  now?: () => Date;
}

export interface PatientSmsOptOutState {
  patientReference: string;
  smsOptedOut: boolean;
  remainingOptOuts: {
    global: boolean;
    numbers: string[];
  };
}

export interface ClearPatientSmsOptOutResult {
  patientReference: string;
  smsOptedOut: boolean;
  cleared: boolean;
  suppressionCleared?: boolean;
  remainingOptOuts?: {
    global: boolean;
    numbers: string[];
  };
}

export async function readPatientSmsOptOut(
  fhir: Pick<MedplumClient, "read">,
  patientReference: string,
): Promise<PatientSmsOptOutState> {
  const patient = await readPatient(fhir, patientReference);
  const remainingOptOuts = summarizeSmsOptOuts(patient.extension ?? []);
  return {
    patientReference,
    smsOptedOut: remainingOptOuts.global || remainingOptOuts.numbers.length > 0,
    remainingOptOuts,
  };
}

export function buildCommsOptOutExtension(channel: CommsPreferenceChannel | "all", number?: string): NonNullable<Patient["extension"]>[number] {
  return { url: ODOS_COMMS_OPT_OUT_EXTENSION_URL, extension: [
    { url: "channel", valueCode: channel },
    ...(number ? [{ url: "number", valueString: number }] : []),
  ] };
}

export async function recordPatientSmsOptOut(
  fhir: SmsOptOutManagementFhir,
  patientReference: string,
  input: {
    actorReference: string;
    actorRole: PracticeRoleId;
    policyUrl?: string;
    recordedAt: string;
    reason: string;
    identityVerification: SmsOptOutIdentityVerification;
    scope: SmsStopScope;
    number?: string;
  },
): Promise<PatientSmsOptOutState> {
  const patient = await readPatient(fhir, patientReference);
  const existing = patient.extension ?? [];
  const number = input.scope === "per-number" ? e164(input.number ?? "", "SMS opt-out record number") : undefined;
  const duplicate = existing.some((extension) => isOwnedSmsOptOut(extension) && smsOptOutNumber(extension) === number);
  const nextExtensions = duplicate ? existing : [...existing, buildCommsOptOutExtension("sms", number)];
  if (!duplicate) {
    if (!patient.id || !patient.meta?.versionId) {
      throw new Error("SMS opt-out record requires the Patient to have an id and version.");
    }
    const provenance: Provenance = {
      ...buildProvenance({
        targetReferences: [patientReference],
        recorded: input.recordedAt,
        activityCode: "CREATE",
        activityDisplay: "Record SMS opt-out (patient request)",
        agents: [{ whoReference: input.actorReference, typeCode: "author" }],
        entityValues: [
          { role: "source", display: `Patient identity verification: ${input.identityVerification}` },
          { role: "source", display: `SMS opt-out scope: ${input.scope}${number ? ` (${number})` : ""}` },
        ],
      }),
      reason: [{ text: input.reason }],
    };
    const transaction: Bundle = {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        { resource: { ...patient, extension: nextExtensions }, request: {
          method: "PUT", url: patientReference, ifMatch: `W/"${patient.meta.versionId}"`,
        } },
        { resource: provenance, request: { method: "POST", url: "Provenance" } },
      ],
    };
    await fhir.executeTransactionAsActor(transaction, {
      actorReference: input.actorReference,
      actorRole: input.actorRole,
      ...(input.policyUrl ? { policyUrl: input.policyUrl } : {}),
      actionReason: "communications.optout.manage record SMS opt-out",
    }, { "X-ODOS-Source": "mcp/comms-opt-out-record" }, {
      validateResponse: (response) => assertSmsOptOutTransaction(response, transaction.entry!.length),
    });
  }
  const remainingOptOuts = summarizeSmsOptOuts(nextExtensions);
  return { patientReference, smsOptedOut: remainingOptOuts.global || remainingOptOuts.numbers.length > 0, remainingOptOuts };
}

export async function clearPatientSmsOptOut(
  fhir: SmsOptOutManagementFhir,
  patientReference: string,
  input: {
    actorReference: string;
    actorRole: PracticeRoleId;
    policyUrl?: string;
    recordedAt: string;
    reason: string;
    identityVerification: SmsOptOutIdentityVerification;
    number?: string;
  },
): Promise<ClearPatientSmsOptOutResult> {
  const patient = await readPatient(fhir, patientReference);
  const existing = patient.extension ?? [];
  const number = input.number ? e164(input.number, "SMS opt-out clear number") : undefined;
  const nextExtensions = existing.filter((extension) =>
    !isOwnedSmsOptOut(extension)
    || (number !== undefined && smsOptOutNumber(extension) !== number));
  const remainingOptOuts = summarizeSmsOptOuts(nextExtensions);
  const scopeStillSuppressed = number !== undefined
    && (remainingOptOuts.global || remainingOptOuts.numbers.includes(number));
  if (nextExtensions.length === existing.length) {
    return number === undefined
      ? { patientReference, smsOptedOut: false, cleared: false }
      : {
          patientReference,
          smsOptedOut: scopeStillSuppressed,
          cleared: false,
          suppressionCleared: !scopeStillSuppressed,
          remainingOptOuts,
        };
  }
  if (!patient.id || !patient.meta?.versionId) {
    throw new Error("SMS opt-out clear requires the Patient to have an id and version.");
  }
  const provenance: Provenance = {
    ...buildProvenance({
      targetReferences: [patientReference],
      recorded: input.recordedAt,
      activityCode: "UPDATE",
      activityDisplay: "Clear SMS opt-out",
      agents: [{ whoReference: input.actorReference, typeCode: "author" }],
      entityValues: [{
        role: "source",
        display: `Patient identity verification: ${input.identityVerification}`,
      }, ...(number ? [{ role: "source" as const, display: `SMS opt-out number scope: ${number}` }] : [])],
    }),
    reason: [{ text: input.reason }],
  };
  const transaction: Bundle = {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        resource: {
          ...patient,
          extension: nextExtensions.length ? nextExtensions : undefined,
        },
        request: {
          method: "PUT",
          url: patientReference,
          ifMatch: `W/"${patient.meta.versionId}"`,
        },
      },
      { resource: provenance, request: { method: "POST", url: "Provenance" } },
    ],
  };
  await fhir.executeTransactionAsActor(
    transaction,
    {
      actorReference: input.actorReference,
      actorRole: input.actorRole,
      ...(input.policyUrl ? { policyUrl: input.policyUrl } : {}),
      actionReason: "communications.optout.manage clear SMS opt-out",
    },
    { "X-ODOS-Source": "mcp/comms-opt-out-clear" },
    { validateResponse: (response) => assertSmsOptOutTransaction(response, transaction.entry!.length) },
  );
  return number === undefined
    ? { patientReference, smsOptedOut: false, cleared: true }
    : {
        patientReference,
        smsOptedOut: scopeStillSuppressed,
        cleared: true,
        suppressionCleared: !scopeStillSuppressed,
        remainingOptOuts,
      };
}

export async function updateInboundSuppression(
  fhir: InboundSuppressionFhir,
  event: Pick<InboundMessageEvent, "from" | "to" | "body" | "optOutType">,
): Promise<InboundSuppressionResult> {
  const optOutType = event.optOutType ?? inboundOptOutType(event.body);
  const initialBundle = await fhir.search<Patient>("Patient", { telecom: event.from, _count: "100" });
  const patients = await collectInboundPatients(fhir, initialBundle);
  if (patients.length === 0) return { outcome: "no-patient-match", matchedPatients: 0 };
  if (optOutType === "START" && patients.length > 1) {
    return { outcome: "opt-in-refused-shared-number", matchedPatients: patients.length };
  }
  if (!optOutType || optOutType === "HELP") {
    return { outcome: "unchanged", matchedPatients: patients.length };
  }
  let remainingOptOuts: InboundSuppressionResult["remainingOptOuts"];
  // Suppression follows the destination number, so every Patient sharing it must be updated.
  for (const patient of patients) {
    if (!patient.id || !patient.meta?.versionId) {
      throw new Error("Inbound SMS suppression requires every matched Patient to have an id and version.");
    }
    const existing = patient.extension ?? [];
    let nextExtensions = optOutType === "STOP"
      ? existing.some((extension) =>
          isOwnedSmsOptOut(extension)
          && (smsOptOutNumber(extension) === undefined || smsOptOutNumber(extension) === event.to))
        ? existing
        : [...existing, {
            url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
            extension: [
              { url: "channel", valueCode: "sms" },
              { url: "number", valueString: event.to },
            ],
          }]
      : existing.filter((extension) =>
          !isOwnedSmsOptOut(extension) || smsOptOutNumber(extension) !== event.to);
    if (optOutType === "START") {
      remainingOptOuts = summarizeSmsOptOuts(nextExtensions);
      if (!remainingOptOuts.global) {
        const purposes: CommsPurpose[] = ["recalls", "appointment", "product-pickup", "education"];
        const explicit = readCommsPreferenceCells(patient);
        if (!purposes.every(purpose => explicit.some(cell => cell.purpose === purpose && cell.channel === "sms" && cell.allowed))) {
          nextExtensions = replaceCommsPreferenceCells({ ...patient, extension: nextExtensions }, purposes.map(purpose => ({ purpose, channel: "sms", allowed: true })), {
            setBy: { reference: `Patient/${patient.id}` }, surface: "inbound-start", recordedAt: new Date().toISOString(),
          }).extension!;
        }
      }
    }
    if (nextExtensions.length === existing.length && nextExtensions.every((entry, index) => entry === existing[index])) {
      continue;
    }
    await fhir.update<Patient>("Patient", patient.id, {
      ...patient,
      extension: nextExtensions.length ? nextExtensions : undefined,
    }, { "If-Match": `W/"${patient.meta.versionId}"` });
  }
  return {
    outcome: optOutType === "STOP"
      ? "opted-out"
      : remainingOptOuts?.global
        ? "opt-in-refused-broader-opt-out"
        : "opted-in",
    matchedPatients: patients.length,
    ...(remainingOptOuts ? { remainingOptOuts } : {}),
  };
}

export function inboundSuppressionLogDetails(result: InboundSuppressionResult): string {
  const remaining = result.remainingOptOuts
    ? ` remainingGlobal=${result.remainingOptOuts.global} remainingNumbers=${result.remainingOptOuts.numbers.join(",") || "none"}`
    : "";
  return `outcome=${result.outcome} matchedPatients=${result.matchedPatients}${remaining}`;
}

async function collectInboundPatients(
  fhir: InboundSuppressionFhir,
  initialBundle: Bundle<Patient>,
): Promise<Patient[]> {
  let bundle = initialBundle;
  const patients = (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
  const followedLinks = new Set<string>();
  while (bundle.link?.some((link) => link.relation === "next")) {
    if (!fhir.searchUrl) {
      throw new Error("Inbound SMS suppression pagination requires FHIR next-link support.");
    }
    const next = bundle.link.find((link) => link.relation === "next")!.url;
    if (followedLinks.has(next)) {
      throw new Error("Inbound SMS suppression Patient search returned a repeated next link.");
    }
    followedLinks.add(next);
    bundle = await fhir.searchUrl<Patient>(next, "Patient");
    patients.push(...(bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []));
  }
  return patients;
}

export function inboundOptOutType(body: string): InboundOptOutType | undefined {
  const keyword = body.trim().split(/\s+/, 1)[0]?.toUpperCase();
  if (["ARRET", "CANCEL", "END", "OPT-OUT", "OPTOUT", "QUIT", "REMOVE", "STOP", "TD", "UNSUBSCRIBE"].includes(keyword)) {
    return "STOP";
  }
  if (["START", "UNSTOP"].includes(keyword)) return "START";
  if (keyword === "HELP") return "HELP";
  return undefined;
}

export function createSuppressedCommsProvider(
  provider: CommsProvider,
  deps: SuppressionGateDeps,
): CommsProvider {
  return {
    name: provider.name,
    preflightSuppression: (request, channel) => checkMessageSuppression(deps, request, channel).then((checked) => checked.result),
    ...(provider.messageIdentifierSystem
      ? { messageIdentifierSystem: provider.messageIdentifierSystem }
      : {}),
    capabilities: provider.capabilities,
    ...(provider.sendEmail ? {
      async sendEmail(request: SendEmailRequest): Promise<SendResult> {
        return gatedSend(deps, request, "email", (patient, now) => provider.sendEmail!({
          ...request,
          toAddress: request.toAddress ?? patientEmail(patient, now),
        }));
      },
    } : {}),
    ...(provider.sendSms ? {
      async sendSms(request: SendSmsRequest): Promise<SendResult> {
        return gatedSend(deps, request, "sms", (patient, now) => provider.sendSms!({
          ...request,
          toNumber: request.toNumber ?? patientPhone(patient, now),
        }));
      },
    } : {}),
    ...(provider.initiateCall ? {
      // Live staff click-to-call is not automated outreach, so messaging opt-out,
      // frequency-cap, and quiet-hours suppression do not apply.
      async initiateCall(request: CallRequest): Promise<{ callId: string }> {
        const patient = await readPatient(deps.fhir, request.patientReference);
        return provider.initiateCall!({
          ...request,
          toNumber: request.toNumber ?? patientPhone(patient, deps.now?.() ?? new Date()),
        });
      },
    } : {}),
    ...(provider.getCall ? {
      getCall: (callId: string) => provider.getCall!(callId),
    } : {}),
    ...(provider.listCalls ? {
      listCalls: (request = {}) => provider.listCalls!(request),
    } : {}),
    ...(provider.fetchRecording ? {
      fetchRecording: (recordingId: string) => provider.fetchRecording!(recordingId),
    } : {}),
    ...(provider.fetchTranscription ? {
      fetchTranscription: (transcriptionId: string) => provider.fetchTranscription!(transcriptionId),
    } : {}),
    ...(provider.listConversations ? {
      listConversations: (request = {}) => provider.listConversations!(request),
    } : {}),
    ...(provider.searchContacts ? {
      searchContacts: (request) => provider.searchContacts!(request),
    } : {}),
    ...(provider.upsertContact ? {
      upsertContact: (contact) => provider.upsertContact!(contact),
    } : {}),
  };
}

async function gatedSend(
  deps: SuppressionGateDeps,
  request: SendEmailRequest | SendSmsRequest,
  channel: "email" | "sms",
  send: (patient: Patient, now: Date) => Promise<SendResult>,
): Promise<SendResult> {
  const checked = await checkMessageSuppression(deps, request, channel);
  return checked.result ?? send(checked.patient, checked.now);
}

export async function checkMessageSuppression(
  deps: SuppressionGateDeps,
  request: SendEmailRequest | SendSmsRequest,
  channel: "email" | "sms",
): Promise<{ patient: Patient; now: Date; result?: Exclude<SendResult, { outcome: "sent" }> }> {
  const now = deps.now?.() ?? new Date();
  const patient = await readPatient(deps.fhir, request.patientReference);
  if (isOptedOut(
    patient,
    channel,
    request.campaignType,
    channel === "sms" ? deps.smsSenderNumber : undefined,
    deps.stopScope ?? "per-number",
  )) {
    return { patient, now, result: { outcome: "suppressed", reason: "patient-opt-out" } };
  }
  if (channel === "sms" && request.suppression.requiresMarketingConsent && !hasRecordedMarketingConsent(patient)) {
    return { patient, now, result: { outcome: "suppressed", reason: "preference-withheld" } };
  }
  const purpose = communicationPurpose(request.campaignType, request.suppression.consentClass);
  if (purpose && !effectiveCommsPreferences(patient, deps)[purpose][channel].value
    && !(request.suppression.staffEducationOverride && channel === "email" && purpose === "education")) {
    return { patient, now, result: { outcome: "suppressed", reason: "preference-withheld" } };
  }
  if (
    request.suppression.frequencyCapDays !== undefined
    && await isFrequencyCapped(
      deps.fhir,
      patient,
      request.campaignType,
      request.suppression.frequencyCapDays,
      now,
      request.messageId,
    )
  ) {
    return { patient, now, result: { outcome: "suppressed", reason: "frequency-cap" } };
  }
  const timeZone = patientTimeZone(patient, deps.practiceTimeZone);
  // Product judgment, not a settled legal conclusion: live staff chart education mirrors
  // click-to-call because it is not automated outreach. Marketing never receives this value;
  // whether quiet-hours rules bind in-encounter informational texts remains unverified.
  if (
    request.suppression.quietHoursExemption !== "staff-initiated-chart-education"
    && !insideQuietHoursWindow(now, timeZone)
  ) {
    return { patient, now, result: {
      outcome: "rescheduled",
      reason: "quiet-hours",
      rescheduledAt: nextWindowOpen(now, timeZone),
    } };
  }
  return { patient, now };
}

export function hasRecordedMarketingConsent(patient: Patient): boolean {
  const consent = patient.extension?.find((extension) =>
    extension.url === ODOS_COMMS_MARKETING_CONSENT_EXTENSION_URL);
  if (!consent) return false;
  const allowed = consent.extension?.find((part) => part.url === "consent")?.valueBoolean;
  const recorded = consent.extension?.find((part) => part.url === "recorded")?.valueDateTime;
  return allowed === true && typeof recorded === "string" && !Number.isNaN(Date.parse(recorded));
}

async function readPatient(fhir: Pick<MedplumClient, "read">, reference: string): Promise<Patient> {
  const match = /^Patient\/([A-Za-z0-9.-]{1,64})$/.exec(reference);
  if (!match) {
    throw new Error(`Communications patientReference must be Patient/…, got "${reference}".`);
  }
  return fhir.read<Patient>("Patient", match[1]);
}

function isOwnedSmsOptOut(extension: NonNullable<Patient["extension"]>[number]): boolean {
  // No campaign-scoped SMS opt-out writer exists today. If one is introduced, revisit ownership:
  // unscoped clear would erase it, while STOP deduplication could swallow a genuine global STOP.
  return extension.url === ODOS_COMMS_OPT_OUT_EXTENSION_URL
    && extension.extension?.some((part) => part.url === "channel" && part.valueCode === "sms") === true;
}

function smsOptOutNumber(extension: NonNullable<Patient["extension"]>[number]): string | undefined {
  return extension.extension?.find((part) => part.url === "number")?.valueString;
}

function summarizeSmsOptOuts(extensions: NonNullable<Patient["extension"]>): {
  global: boolean;
  numbers: string[];
} {
  const owned = extensions.filter(isOwnedSmsOptOut);
  return {
    global: owned.some((extension) => smsOptOutNumber(extension) === undefined),
    numbers: [...new Set(owned.flatMap((extension) => {
      const number = smsOptOutNumber(extension);
      return number ? [number] : [];
    }))].sort(),
  };
}

function assertSmsOptOutTransaction(response: Bundle, expectedEntries: number): void {
  if (response.resourceType !== "Bundle" || response.type !== "transaction-response") {
    throw new Error("SMS opt-out did not return a transaction-response Bundle.");
  }
  if (response.entry?.length !== expectedEntries) {
    throw new Error("SMS opt-out returned an incomplete transaction response.");
  }
  const failed = response.entry.find((entry) => !/^2\d\d/.test(entry.response?.status ?? ""));
  if (failed) {
    throw Object.assign(new Error(`SMS opt-out failed with status ${failed.response?.status ?? "unknown"}.`), {
      status: Number.parseInt(failed.response?.status ?? "", 10),
    });
  }
}

function isOptedOut(
  patient: Patient,
  channel: string,
  campaignType: string,
  smsSenderNumber: string | undefined,
  stopScope: SmsStopScope,
): boolean {
  return patient.extension?.some((entry) => {
    if (entry.url !== ODOS_COMMS_OPT_OUT_EXTENSION_URL) return false;
    const configuredChannel = entry.extension?.find((part) => part.url === "channel")?.valueCode;
    const configuredCampaign = entry.extension?.find((part) => part.url === "campaign-type")?.valueCode;
    const configuredNumber = entry.extension?.find((part) => part.url === "number")?.valueString;
    const channelMatches = !configuredChannel || configuredChannel === "all" || configuredChannel === channel;
    const campaignMatches = !configuredCampaign || configuredCampaign === campaignType;
    const numberMatches = channel !== "sms"
      || stopScope === "global"
      || !configuredNumber
      || !smsSenderNumber
      || configuredNumber === smsSenderNumber;
    return channelMatches && campaignMatches && numberMatches;
  }) ?? false;
}

function e164(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error(`${label} must use E.164 format.`);
  }
  return normalized;
}

async function isFrequencyCapped(
  fhir: SuppressionFhir,
  patient: Patient,
  campaignType: string,
  capDays: number,
  now: Date,
  messageId: string | undefined,
): Promise<boolean> {
  if (!Number.isInteger(capDays) || capDays <= 0) {
    throw new Error("Communications frequencyCapDays must be a positive integer.");
  }
  if (!patient.id) {
    throw new Error("Patient must have an id before communications suppression can be evaluated.");
  }
  if (!messageId?.trim()) {
    throw new Error("Frequency-capped communications require a persisted messageId claim.");
  }
  const cutoff = new Date(now.getTime() - capDays * 86_400_000).toISOString();
  const candidates = await fhir.search<Communication>("Communication", [
    ["subject", `Patient/${patient.id}`],
    ["category", `${ODOS_COMMS_CAMPAIGN_TYPE_SYSTEM}|${campaignType}`],
    ["status", "in-progress,completed"],
    ["_lastUpdated", `ge${cutoff}`],
    ["_count", "100"],
  ]);
  const communications = await collectCommunications(fhir, candidates);
  if (communications.some((communication) =>
    communication.status === "completed"
    && Boolean(communication.sent)
    && Date.parse(communication.sent!) >= Date.parse(cutoff)
    && matchesFrequencyCapScope(communication, patient.id!, campaignType))) {
    return true;
  }
  const claims = communications.filter((communication) =>
    communication.status === "in-progress"
    && matchesFrequencyCapScope(communication, patient.id!, campaignType));
  const current = claims.find((communication) =>
    frequencyCapClaimId(communication) === messageId);
  if (!current) {
    throw new Error("Frequency-capped communication claim is not visible in FHIR search.");
  }
  const winner = [...claims].sort(compareFrequencyCapClaims)[0];
  return frequencyCapClaimId(winner) !== messageId;
}

async function collectCommunications(
  fhir: SuppressionFhir,
  initialBundle: Bundle<Communication>,
): Promise<Communication[]> {
  let bundle = initialBundle;
  const communications = (bundle.entry ?? []).flatMap((entry) =>
    entry.resource ? [entry.resource] : []);
  let pages = 1;
  while (bundle.link?.some((link) => link.relation === "next")) {
    if (pages >= 100 || communications.length >= 10_000) {
      throw new Error("Communications frequency-cap search exceeded its 100-page or 10000-row bound.");
    }
    if (!fhir.searchUrl) {
      throw new Error("Communications frequency-cap pagination requires FHIR next-link support.");
    }
    const next = bundle.link.find((link) => link.relation === "next")!.url;
    bundle = await fhir.searchUrl<Communication>(next, "Communication");
    communications.push(...(bundle.entry ?? []).flatMap((entry) =>
      entry.resource ? [entry.resource] : []));
    pages += 1;
  }
  if (communications.length > 10_000) {
    throw new Error("Communications frequency-cap search exceeded its 10000-row bound.");
  }
  return communications;
}

function compareFrequencyCapClaims(left: Communication, right: Communication): number {
  const leftUpdated = Date.parse(left.meta?.lastUpdated ?? "");
  const rightUpdated = Date.parse(right.meta?.lastUpdated ?? "");
  if (!Number.isFinite(leftUpdated) || !Number.isFinite(rightUpdated)) {
    throw new Error("Frequency-capped Communication claims require FHIR meta.lastUpdated.");
  }
  return leftUpdated - rightUpdated
    || frequencyCapClaimId(left).localeCompare(frequencyCapClaimId(right));
}

function frequencyCapClaimId(communication: Communication): string {
  const value = communication.identifier?.find(
    (identifier) => identifier.system === ODOS_COMMS_SEND_IDENTIFIER_SYSTEM,
  )?.value;
  if (!value) {
    throw new Error("Frequency-capped Communication claims require the ODOS send identifier.");
  }
  return value;
}

function matchesFrequencyCapScope(
  communication: Communication,
  patientId: string,
  campaignType: string,
): boolean {
  return communication.subject?.reference === `Patient/${patientId}`
    && (communication.category?.some((category) =>
      category.coding?.some((coding) =>
        coding.system === ODOS_COMMS_CAMPAIGN_TYPE_SYSTEM && coding.code === campaignType)) ?? false);
}

function patientEmail(patient: Patient, now: Date): string {
  const email = patient.telecom?.find((point) =>
    point.system === "email"
    && point.use !== "old"
    && Boolean(point.value?.trim())
    && (!point.period?.start || Date.parse(point.period.start) <= now.getTime())
    && (!point.period?.end || Date.parse(point.period.end) > now.getTime()))
    ?.value?.trim();
  if (!email) {
    throw new Error(`Patient/${patient.id ?? "unknown"} has no active email in Patient.telecom.`);
  }
  return email;
}

function patientPhone(patient: Patient, now: Date): string {
  const active = (patient.telecom ?? []).filter((point) =>
    (point.system === "sms" || point.system === "phone")
    && point.use !== "old"
    && Boolean(point.value?.trim())
    && (!point.period?.start || Date.parse(point.period.start) <= now.getTime())
    && (!point.period?.end || Date.parse(point.period.end) > now.getTime()));
  const phone = (
    active.find((point) => point.system === "sms")
    ?? active.find((point) => point.use === "mobile")
    ?? active[0]
  )?.value?.trim();
  if (!phone) {
    throw new Error(`Patient/${patient.id ?? "unknown"} has no active phone in Patient.telecom.`);
  }
  return phone;
}

function patientTimeZone(patient: Patient, practiceTimeZone: string): string {
  const patientZone = patient.extension?.find(
    (entry) => entry.url === ODOS_PATIENT_TIMEZONE_EXTENSION_URL,
  )?.valueString;
  return validTimeZone(patientZone) ? patientZone! : assertTimeZone(practiceTimeZone);
}

function insideQuietHoursWindow(now: Date, timeZone: string): boolean {
  const parts = localParts(now, timeZone);
  const minute = parts.hour * 60 + parts.minute;
  return minute >= 8 * 60 && minute < 21 * 60;
}

function nextWindowOpen(now: Date, timeZone: string): string {
  const parts = localParts(now, timeZone);
  const minute = parts.hour * 60 + parts.minute;
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (minute >= 21 * 60) day.setUTCDate(day.getUTCDate() + 1);
  return zonedWallTimeToIso(
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    8,
    0,
    timeZone,
  );
}

function localParts(date: Date, timeZone: string) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: assertTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(formatted.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function zonedWallTimeToIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): string {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const represented = localParts(new Date(guess), timeZone);
    const representedMs = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    );
    guess += target - representedMs;
  }
  return new Date(guess).toISOString();
}

function validTimeZone(value: string | undefined): boolean {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function assertTimeZone(value: string): string {
  if (!validTimeZone(value)) {
    throw new Error(`Communications practice time zone "${value}" is invalid.`);
  }
  return value;
}

export function communicationResources(bundle: { entry?: Array<{ resource?: Resource }> }): Communication[] {
  return (bundle.entry ?? []).flatMap((entry) =>
    entry.resource?.resourceType === "Communication" ? [entry.resource] : []);
}
