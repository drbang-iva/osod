import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

export type SmsLaneRole = "transactional-sms" | "marketing-sms" | "clinical-sms";

export interface SmsOptOutLane {
  label: string;
  number: string;
  roles: SmsLaneRole[];
}

export interface SmsOptOutState {
  patientReference: string;
  smsOptedOut: boolean;
  remainingOptOuts: {
    global: boolean;
    numbers: string[];
  };
  smsLanes: SmsOptOutLane[];
}

export type SmsOptOutIdentityVerification = "in-person" | "phone-verified" | "portal";

export interface ClearSmsOptOutResult {
  patientReference: string;
  smsOptedOut: boolean;
  cleared: boolean;
  suppressionCleared?: boolean;
  remainingOptOuts?: {
    global: boolean;
    numbers: string[];
  };
}

export interface SmsSendResult {
  outcome: "sent" | "suppressed" | "rescheduled";
  providerMessageId?: string;
  reason?: string;
  rescheduledAt?: string;
}

export interface EducationContentItem {
  id: string;
  version: number;
  title: string;
  kind: "video" | "handout" | "report" | "page";
  audience: "patient" | "internal";
  dxCodes: string[];
  channels: Array<"sms" | "email" | "print">;
  laneHint: "clinical" | "retail";
  consentClass: "transactional" | "marketing";
  urls: {
    web?: string;
    email?: string;
    print?: string;
  };
}

export interface EducationCatalogResult {
  items: EducationContentItem[];
  chartDispatchLane: "locked_clinical" | "staff_switchable";
  availableChannels: EducationChannelAvailability;
}

export interface EducationChannelAvailability {
  clinicalSms: boolean;
  frontdeskSms: boolean;
  email: boolean;
  print: boolean;
}

export interface EducationDispatchInput {
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
}

export type EducationDispatchResult =
  | { outcome: "sent"; providerMessageId: string; chartUpdate?: "conflict" }
  | { outcome: "print"; url: string }
  | { outcome: "refused"; reason: string }
  | { outcome: "suppressed"; reason: "patient-opt-out" | "preference-withheld" | "frequency-cap" }
  | { outcome: "rescheduled"; reason: "quiet-hours"; rescheduledAt: string };

export class CommunicationsResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function readSmsOptOut(
  patientReference: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmsOptOutState> {
  const response = await fetchImpl(
    `${clinicalGraphApiBase()}/communications/opt-out?patient=${encodeURIComponent(patientReference)}`,
    { headers: authHeaders() },
  );
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      responseError(body) ?? `SMS opt-out state failed (${response.status}).`,
    );
  }
  if (!isSmsOptOutState(body)) {
    throw new CommunicationsResponseError(response.status, "SMS opt-out state returned an unexpected response.");
  }
  return body;
}

export async function recordSmsOptOut(
  input: {
    patientReference: string;
    reason: string;
    identityVerification: SmsOptOutIdentityVerification;
    scope: "global" | "per-number";
    number?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<SmsOptOutState> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/opt-out/record`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      responseError(body) ?? `SMS opt-out record failed (${response.status}).`,
    );
  }
  if (!isSmsOptOutState(body)) {
    throw new CommunicationsResponseError(response.status, "SMS opt-out record returned an unexpected response.");
  }
  return body;
}

export async function clearSmsOptOut(
  input: {
    patientReference: string;
    reason: string;
    identityVerification: SmsOptOutIdentityVerification;
    number?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ClearSmsOptOutResult> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/opt-out/clear`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      responseError(body) ?? `SMS opt-out clear failed (${response.status}).`,
    );
  }
  if (!isClearSmsOptOutResult(body)) {
    throw new CommunicationsResponseError(response.status, "SMS opt-out clear returned an unexpected response.");
  }
  return body;
}

export async function listEducation(
  query: { dxCode?: string; channel?: "sms" | "email" | "print" },
  fetchImpl: typeof fetch = fetch,
): Promise<EducationCatalogResult> {
  const params = new URLSearchParams();
  if (query.dxCode) params.set("dxCode", query.dxCode);
  if (query.channel) params.set("channel", query.channel);
  const suffix = params.size ? `?${params.toString()}` : "";
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/education${suffix}`, {
    headers: authHeaders(),
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      responseError(body) ?? `Education catalog failed (${response.status}).`,
    );
  }
  if (!isRecord(body)
    || !Array.isArray(body.items)
    || !body.items.every(isEducationContentItem)
    || (body.chartDispatchLane !== "locked_clinical" && body.chartDispatchLane !== "staff_switchable")
    || !isEducationChannelAvailability(body.availableChannels)) {
    throw new CommunicationsResponseError(response.status, "Education catalog returned an unexpected response.");
  }
  return {
    items: body.items,
    chartDispatchLane: body.chartDispatchLane,
    availableChannels: body.availableChannels,
  };
}

export async function dispatchEducation(
  input: EducationDispatchInput,
  fetchImpl: typeof fetch = fetch,
): Promise<EducationDispatchResult> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/education/dispatch`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      responseError(body) ?? dispatchRefusalReason(body) ?? `Education dispatch failed (${response.status}).`,
    );
  }
  if (!isEducationDispatchResult(body)) {
    throw new CommunicationsResponseError(response.status, "Education dispatch returned an unexpected response.");
  }
  return body;
}

function isSmsOptOutState(value: unknown): value is SmsOptOutState {
  if (!isRecord(value)
    || typeof value.patientReference !== "string"
    || typeof value.smsOptedOut !== "boolean"
    || !isRemainingOptOuts(value.remainingOptOuts)
    || !Array.isArray(value.smsLanes)) return false;
  return value.smsLanes.every((lane) =>
    isRecord(lane)
    && typeof lane.label === "string"
    && typeof lane.number === "string"
    && Array.isArray(lane.roles)
    && lane.roles.every(isSmsLaneRole));
}

function isClearSmsOptOutResult(value: unknown): value is ClearSmsOptOutResult {
  return isRecord(value)
    && typeof value.patientReference === "string"
    && typeof value.smsOptedOut === "boolean"
    && typeof value.cleared === "boolean"
    && (value.suppressionCleared === undefined || typeof value.suppressionCleared === "boolean")
    && (value.remainingOptOuts === undefined || isRemainingOptOuts(value.remainingOptOuts));
}

function isEducationChannelAvailability(value: unknown): value is EducationChannelAvailability {
  return isRecord(value)
    && typeof value.clinicalSms === "boolean"
    && typeof value.frontdeskSms === "boolean"
    && typeof value.email === "boolean"
    && typeof value.print === "boolean";
}

function isRemainingOptOuts(value: unknown): value is SmsOptOutState["remainingOptOuts"] {
  return isRecord(value)
    && typeof value.global === "boolean"
    && Array.isArray(value.numbers)
    && value.numbers.every((number) => typeof number === "string");
}

function isSmsLaneRole(value: unknown): value is SmsLaneRole {
  return value === "transactional-sms" || value === "marketing-sms" || value === "clinical-sms";
}

function isEducationContentItem(value: unknown): value is EducationContentItem {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.version !== "number"
    || typeof value.title !== "string"
    || !["video", "handout", "report", "page"].includes(String(value.kind))
    || !["patient", "internal"].includes(String(value.audience))
    || !Array.isArray(value.dxCodes)
    || !value.dxCodes.every((code) => typeof code === "string")
    || !Array.isArray(value.channels)
    || !value.channels.every((channel) => ["sms", "email", "print"].includes(String(channel)))
    || !["clinical", "retail"].includes(String(value.laneHint))
    || !["transactional", "marketing"].includes(String(value.consentClass))
    || !isRecord(value.urls)) return false;
  return (value.urls.web === undefined || typeof value.urls.web === "string")
    && (value.urls.email === undefined || typeof value.urls.email === "string")
    && (value.urls.print === undefined || typeof value.urls.print === "string");
}

function isEducationDispatchResult(value: unknown): value is EducationDispatchResult {
  if (!isRecord(value) || typeof value.outcome !== "string") return false;
  if (value.outcome === "sent") {
    return typeof value.providerMessageId === "string"
      && (value.chartUpdate === undefined || value.chartUpdate === "conflict");
  }
  if (value.outcome === "print") return typeof value.url === "string";
  if (value.outcome === "suppressed") {
    return value.reason === "patient-opt-out" || value.reason === "preference-withheld" || value.reason === "frequency-cap";
  }
  if (value.outcome === "rescheduled") {
    return value.reason === "quiet-hours" && typeof value.rescheduledAt === "string";
  }
  return value.outcome === "refused" && typeof value.reason === "string";
}

function dispatchRefusalReason(value: unknown): string | undefined {
  return isRecord(value) && value.outcome === "refused" && typeof value.reason === "string"
    ? value.reason
    : undefined;
}

function responseError(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === "string" ? value.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function sendSms(
  input: {
    patientReference: string;
    body: string;
    idempotencyKey: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<SmsSendResult> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/messages`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as SmsSendResult & { error?: string };
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      body.error ?? `SMS send failed (${response.status}).`,
    );
  }
  return body;
}

export type EducationSequenceReviewAction = "skip" | "resume";
export interface EducationSequenceWorkItem {
  id: string;
  enrollmentId: string;
  rowId?: string;
  reason: string;
  patientReference?: string;
  at: string;
  state: "open" | "settled";
  expectedVersion?: string;
  disposition?: string;
  holdReason?: string;
  channel?: "sms" | "email" | "print";
  encounterReference?: string;
  allowedActions?: EducationSequenceReviewAction[];
}

export async function listEducationSequenceWork(fetchImpl: typeof fetch = fetch): Promise<EducationSequenceWorkItem[]> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/education/sequence-work`, { headers: authHeaders() });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) throw new CommunicationsResponseError(response.status, responseError(body) ?? dispatchRefusalReason(body) ?? "Education review list could not load.");
  if (!isRecord(body) || !Array.isArray(body.items) || !body.items.every(isEducationSequenceWorkItem))
    throw new CommunicationsResponseError(response.status, "Education review returned an unexpected response.");
  return body.items;
}

export async function reviewEducationSequenceStep(
  enrollmentId: string,
  rowId: string,
  input: { action: EducationSequenceReviewAction; reason: string; expectedVersion: string; reviewedEncounterReference?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/education/enrollments/${encodeURIComponent(enrollmentId)}/scheduled-sends/${encodeURIComponent(rowId)}/review`, {
    method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) throw new CommunicationsResponseError(response.status, responseError(body) ?? dispatchRefusalReason(body) ?? "Education review could not be recorded.");
  if (!isRecord(body) || !isRecord(body.enrollment) || typeof body.expectedVersion !== "string")
    throw new CommunicationsResponseError(response.status, "Education review returned an unexpected response. Refresh before trying again.");
}

function isEducationSequenceWorkItem(value: unknown): value is EducationSequenceWorkItem {
  if (!isRecord(value) || !["id", "enrollmentId", "reason", "at"].every(key => typeof value[key] === "string")
    || !["open", "settled"].includes(String(value.state))) return false;
  for (const key of ["rowId", "patientReference", "expectedVersion", "disposition", "holdReason", "encounterReference"])
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  return (value.channel === undefined || ["sms", "email", "print"].includes(String(value.channel)))
    && (value.allowedActions === undefined || (Array.isArray(value.allowedActions) && value.allowedActions.every(action => action === "skip" || action === "resume")));
}
