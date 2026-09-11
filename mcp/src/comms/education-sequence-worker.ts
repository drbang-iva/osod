/**
 * Must not be enabled for a live practice until ODOS can read a per-patient
 * Education communication permission. Eyefinity defaults Education to Mail only;
 * sending without consulting that permission may use a channel the record does not permit.
 * See performance-od/decisions/2026-09-10-eyefinity-communication-methods-matrix-is-the-consent-model.md.
 */
import type { Basic, Bundle, Encounter, Resource } from "@medplum/fhirtypes";
import type { EducationEnrollment, EducationEnrollmentFhir, EducationEnrollmentSendOutcome, EducationEnrollmentStore } from "./education-enrollment.js";
import type { EducationScheduledSend, EducationSchedulingHoldReason } from "./education-sequence.js";
import { admitScheduledAttempt, claimScheduledAttempt, rearmScheduledAttempt, scheduledEnrollmentSnapshot, writeScheduledEnrollment, type ScheduledEnrollmentSnapshot } from "./education-sequence-store.js";
import { calculateEducationSequenceTime, educationLocalDay, type EducationBusinessCalendarResolver } from "./education-sequence-timing.js";
import { validateLocalFhirSearchNextPath } from "../fhir-search.js";
export interface EducationSequenceWorkerFhir extends EducationEnrollmentFhir {
    baseUrl: string;
    searchProject<T extends Resource>(type: T["resourceType"], project: string, params?: Record<string, string>): Promise<Bundle<T>>;
    searchProjectUrl?<T extends Resource>(url: string, type: T["resourceType"], project: string): Promise<Bundle<T>>;
}
export interface SequenceDispatchEvidence {
    outcome: EducationEnrollmentSendOutcome;
    acceptedAt?: string;
    providerInvoked: boolean | "unknown";
}
export interface SequenceStaffItem {
    enrollmentId: string;
    rowId?: string;
    patientReference?: string;
    reason: string;
    at: string;
}
export interface EducationSequenceWorkerDeps {
    fhir: EducationSequenceWorkerFhir;
    projectId: string;
    authenticate(): Promise<void>;
    store: Pick<EducationEnrollmentStore, "recordImmediateSendOutcome">;
    prepare(enrollment: EducationEnrollment, row: EducationScheduledSend): Promise<{
        kind: "ready";
        prepared: unknown;
    } | {
        kind: "held";
        reason: EducationSchedulingHoldReason;
    } | {
        kind: "deferred";
        notBefore: string;
    }>;
    execute(enrollment: EducationEnrollment, row: EducationScheduledSend, key: string, prepared: unknown): Promise<EducationEnrollmentSendOutcome>;
    reconcile(enrollment: EducationEnrollment, row: EducationScheduledSend, key: string): Promise<EducationEnrollmentSendOutcome | undefined>;
    evidence(enrollment: EducationEnrollment, row: EducationScheduledSend, key: string): Promise<SequenceDispatchEvidence | undefined>;
    staffItem(item: SequenceStaffItem): Promise<void>;
    now?: () => string;
    log?: (message: string) => void;
    resolveCalendar?: EducationBusinessCalendarResolver;
    spacingEnabled?: boolean;
    intervalMs?: number;
}
const ENROLLMENT_QUERY = { code: "https://odos2020.com/fhir/CodeSystem/basic-resource-kind|education-enrollment", _count: "100" };
export function educationSequenceWorkerIntervalMs(value: string | undefined): number {
    if (!value?.trim())
        return 60000;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 15000)
        throw new Error("ODOS_EDUCATION_SEQUENCE_WORKER_MS must be an integer interval of at least 15 seconds (in milliseconds).");
    return parsed;
}
export function startEducationSequenceWorker(deps: EducationSequenceWorkerDeps): NodeJS.Timeout {
    let running = false;
    const run = () => { if (running)
        return; running = true; void runOnce(deps).finally(() => { running = false; }); };
    run();
    const timer = setInterval(run, deps.intervalMs ?? 60000);
    timer.unref();
    return timer;
}
async function allProjectResources<T extends Resource>(deps: EducationSequenceWorkerDeps, type: T["resourceType"], params: Record<string, string>): Promise<T[]> {
    // search-contract: education-sequence.practice-enumeration
    let bundle = await deps.fhir.searchProject<T>(type, deps.projectId, params);
    const results: T[] = [];
    const followed = new Set<string>();
    for (;;) {
        results.push(...(bundle.entry ?? []).flatMap(entry => entry.resource ? [entry.resource] : []));
        const next = bundle.link?.find(link => link.relation === "next");
        if (!next)
            return results;
        if (!next.url || !deps.fhir.searchProjectUrl)
            throw new Error("Education sequence pagination unavailable.");
        const path = validateLocalFhirSearchNextPath(next.url, deps.fhir.baseUrl, type);
        if (followed.has(path))
            throw new Error("Education sequence pagination cycle.");
        followed.add(path);
        bundle = await deps.fhir.searchProjectUrl<T>(path, type, deps.projectId);
    }
}
async function readCurrent(deps: EducationSequenceWorkerDeps, id: string): Promise<ScheduledEnrollmentSnapshot> {
    const resources = await allProjectResources<Basic>(deps, "Basic", { ...ENROLLMENT_QUERY, _id: id });
    const matches = resources.filter(resource => resource.id === id && resource.meta?.project?.replace(/^Project\//, "") === deps.projectId);
    if (matches.length !== 1)
        throw new Error("Education enrollment is unavailable in this practice.");
    return scheduledEnrollmentSnapshot(matches[0]);
}
async function report(deps: EducationSequenceWorkerDeps, item: SequenceStaffItem): Promise<void> {
    try {
        await deps.staffItem(item);
    }
    catch {
        (deps.log ?? console.error)("odos-mcp: education sequence staff item could not be persisted.");
    }
}
async function hold(deps: EducationSequenceWorkerDeps, snapshot: ScheduledEnrollmentSnapshot, row: EducationScheduledSend, reason: EducationSchedulingHoldReason, detail: string, at: string): Promise<void> {
    if (["cancelled", "closed"].includes(row.disposition))
        return;
    if (row.disposition === "held" && row.holdReason === reason && row.events.at(-1)?.reason === detail)
        return;
    row.disposition = "held";
    row.holdReason = reason;
    row.events.push({ kind: "held", actor: row.senderReference, at, reason: detail });
    await writeScheduledEnrollment(deps.fhir, snapshot);
    await report(deps, { enrollmentId: snapshot.enrollment.id, rowId: row.id, patientReference: snapshot.enrollment.patientReference, reason: detail, at });
}
async function acceptanceCollision(deps: EducationSequenceWorkerDeps, enrollment: EducationEnrollment, row: EducationScheduledSend, at: string): Promise<boolean> {
    if (deps.spacingEnabled === false)
        return false;
    // Non-atomic education-only spacing: other engines and concurrent admissions are outside this check.
    const resources = await allProjectResources<Basic>(deps, "Basic", { ...ENROLLMENT_QUERY, subject: enrollment.patientReference });
    for (const resource of resources) {
        if (resource.meta?.project?.replace(/^Project\//, "") !== deps.projectId)
            continue;
        const current = scheduledEnrollmentSnapshot(resource).enrollment;
        if (current.patientReference !== enrollment.patientReference)
            continue;
        for (const other of current.scheduledSends ?? [])
            for (const attempt of other.attempts) {
                const proof = await deps.evidence(current, other, attempt.attemptKey);
                if (proof?.outcome.outcome === "sent" && proof.acceptedAt && educationLocalDay(proof.acceptedAt, row.timezone) === educationLocalDay(at, row.timezone))
                    return true;
            }
    }
    return false;
}
async function visitAfterEnrollment(deps: EducationSequenceWorkerDeps, enrollment: EducationEnrollment, row: EducationScheduledSend, at: string): Promise<string | undefined> {
    const encounters = await allProjectResources<Encounter>(deps, "Encounter", { subject: enrollment.patientReference, _count: "100" });
    return encounters.find(encounter => encounter.meta?.project?.replace(/^Project\//, "") === deps.projectId && encounter.subject?.reference === enrollment.patientReference &&
        encounter.id && `Encounter/${encounter.id}` !== enrollment.enteredFromEncounterReference && !(row.runtime?.reviewedEncounterReferences ?? []).includes(`Encounter/${encounter.id}`) &&
        ["arrived", "triaged", "in-progress", "onleave", "finished"].includes(encounter.status) && encounter.period?.start && Date.parse(encounter.period.start) >= Date.parse(enrollment.stageEnteredAt) && Date.parse(encounter.period.start) <= Date.parse(at))?.id;
}
async function reconcileRow(deps: EducationSequenceWorkerDeps, snapshot: ScheduledEnrollmentSnapshot, row: EducationScheduledSend, at: string): Promise<void> {
    const attempt = row.attempts.at(-1);
    if (!attempt)
        return;
    const send = snapshot.enrollment.immediateSends[attempt.sendIndex];
    if (!send)
        return;
    let proof = await deps.evidence(snapshot.enrollment, row, attempt.attemptKey);
    if (send.state === "indeterminate") {
        if (proof?.outcome.outcome === "sent" && proof.acceptedAt) await recordAcceptance(deps, snapshot, row, attempt.attemptKey, proof.acceptedAt);
        else await hold(deps, snapshot, row, "needs-acknowledgement", "provider-outcome-unknown", at);
        return;
    }
    if (send.state === "in-flight") {
        const outcome = await deps.reconcile(snapshot.enrollment, row, attempt.attemptKey);
        if (!outcome) {
            row.blockedBySendIndices = [...new Set([...row.blockedBySendIndices, attempt.sendIndex])];
            await hold(deps, snapshot, row, "needs-acknowledgement", "provider-outcome-unknown", at);
            return;
        }
        await deps.store.recordImmediateSendOutcome(snapshot.enrollment.id, attempt.sendIndex, outcome);
        snapshot = await readCurrent(deps, snapshot.enrollment.id);
        row = snapshot.enrollment.scheduledSends!.find(r => r.id === row.id)!;
        proof = await deps.evidence(snapshot.enrollment, row, attempt.attemptKey);
    }
    const recorded = snapshot.enrollment.immediateSends[attempt.sendIndex];
    if (recorded.state !== "resolved")
        return;
    if (recorded.outcome?.outcome === "rescheduled") {
        if (proof?.providerInvoked === false && proof.outcome.outcome === "rescheduled")
            await rearmScheduledAttempt(deps.fhir, snapshot, row.id, { providerInvoked: false, outcome: proof.outcome }, at);
        else
            await hold(deps, snapshot, row, "needs-acknowledgement", "deferral-proof-unavailable", at);
    }
    else if (recorded.outcome?.outcome === "sent") {
        if (!proof?.acceptedAt) {
            await hold(deps, snapshot, row, "needs-acknowledgement", "acceptance-time-unavailable", at);
            return;
        }
        await recordAcceptance(deps, snapshot, row, attempt.attemptKey, proof.acceptedAt);
    }
    else if (recorded.outcome?.outcome === "suppressed") {
        const reason = recorded.outcome.reason === "preference-withheld" ? "preference-withheld" : "patient-opt-out";
        await hold(deps, snapshot, row, reason, reason, at);
    }
}
async function recordAcceptance(deps: EducationSequenceWorkerDeps, snapshot: ScheduledEnrollmentSnapshot, row: EducationScheduledSend, key: string, acceptedAt: string): Promise<void> {
    const attempt = row.attempts.find(value => value.attemptKey === key)!;
    if (attempt.acceptedAt === acceptedAt && ["cancelled", "closed"].includes(row.disposition)) return;
    attempt.acceptedAt = acceptedAt;
    if (row.disposition !== "cancelled") row.disposition = "closed";
    await writeScheduledEnrollment(deps.fhir, snapshot);
}
export async function runOnce(deps: EducationSequenceWorkerDeps): Promise<void> {
    try {
        await deps.authenticate();
        if (!deps.projectId.trim())
            throw new Error("Education sequence practice is required.");
        const resources = await allProjectResources<Basic>(deps, "Basic", ENROLLMENT_QUERY);
        const handledPatients = new Set<string>();
        for (const resource of resources) {
            if (resource.meta?.project?.replace(/^Project\//, "") !== deps.projectId)
                continue;
            let enrollment: EducationEnrollment;
            try {
                enrollment = scheduledEnrollmentSnapshot(resource).enrollment;
            }
            catch {
                await report(deps, { enrollmentId: resource.id ?? "unknown", reason: "malformed-enrollment", at: deps.now?.() ?? new Date().toISOString() });
                continue;
            }
            for (const originalRow of enrollment.scheduledSends ?? []) {
                try {
                    let snapshot = await readCurrent(deps, enrollment.id);
                    if (snapshot.enrollment.patientReference !== enrollment.patientReference)
                        throw new Error("Enrollment patient changed.");
                    let row = snapshot.enrollment.scheduledSends!.find(r => r.id === originalRow.id)!;
                    const at = deps.now?.() ?? new Date().toISOString();
                    const attempt = row.attempts.at(-1);
                    const send = attempt && snapshot.enrollment.immediateSends[attempt.sendIndex];
                    if (send?.state === "in-flight" || send?.state === "resolved" || send?.state === "indeterminate") {
                        await reconcileRow(deps, snapshot, row, at);
                        continue;
                    }
                    if (row.disposition === "held")
                        await report(deps, { enrollmentId: snapshot.enrollment.id, rowId: row.id, patientReference: snapshot.enrollment.patientReference, reason: row.events.at(-1)?.reason ?? row.holdReason ?? "needs-acknowledgement", at: row.events.at(-1)?.at ?? at });
                    if (!["waiting", "scheduled"].includes(row.disposition) || snapshot.enrollment.status !== "active")
                        continue;
                    const activation = snapshot.enrollment.activations?.find(a => a.id === row.activationId);
                    if (activation?.status !== "active" || activation.stageHistorySequence !== snapshot.enrollment.stageHistory.length)
                        continue;
                    if (Date.parse(at) > Date.parse(row.latestUsefulTime)) {
                        await hold(deps, snapshot, row, "needs-acknowledgement", "latest-useful-time-exceeded", at);
                        continue;
                    }
                    const predecessor = snapshot.enrollment.scheduledSends?.find(r => r.activationId === row.activationId && r.stepIndex === row.predecessorStepIndex);
                    const acceptedAt = predecessor?.attempts.map(a => a.acceptedAt).filter((value): value is string => !!value).sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1);
                    const skip = predecessor?.runtime?.clinicianSkip;
                    const timing = calculateEducationSequenceTime(row, skip ? { kind: "clinician-skip", at: skip.at } : acceptedAt ? { kind: "accepted", at: acceptedAt } : undefined, deps.resolveCalendar);
                    if (timing.status === "held") {
                        await hold(deps, snapshot, row, "needs-acknowledgement", timing.reason, at);
                        continue;
                    }
                    const effectiveAt = new Date(Math.max(Date.parse(timing.effectiveAt), Date.parse(row.runtime?.effectiveAt ?? timing.effectiveAt))).toISOString();
                    if (Date.parse(at) < Date.parse(effectiveAt))
                        continue;
                    if (row.channel === "print") {
                        await hold(deps, snapshot, row, "needs-acknowledgement", "print-handout-due", at);
                        continue;
                    }
                    if (handledPatients.has(enrollment.patientReference))
                        continue;
                    const encounter = await visitAfterEnrollment(deps, snapshot.enrollment, row, at);
                    if (encounter) {
                        await hold(deps, snapshot, row, "patient-seen", `patient-seen:Encounter/${encounter}`, at);
                        continue;
                    }
                    const prepared = await deps.prepare(snapshot.enrollment, row);
                    if (prepared.kind === "held") {
                        if (prepared.reason === "patient-opt-out" || prepared.reason === "preference-withheld")
                            for (const future of snapshot.enrollment.scheduledSends ?? [])
                                if (future.id !== row.id && future.channel === row.channel && ["waiting", "scheduled"].includes(future.disposition)) {
                                    future.disposition = "held";
                                    future.holdReason = prepared.reason;
                                    future.events.push({ kind: "held", actor: future.senderReference, at, reason: prepared.reason });
                                }
                        await hold(deps, snapshot, row, prepared.reason, prepared.reason, at);
                        continue;
                    }
                    if (prepared.kind === "deferred") {
                        row.runtime = { ...row.runtime, effectiveAt: prepared.notBefore };
                        row.events.push({ kind: "rescheduled", actor: row.senderReference, at, reason: "quiet-hours-preflight" });
                        await writeScheduledEnrollment(deps.fhir, snapshot);
                        continue;
                    }
                    if (await acceptanceCollision(deps, snapshot.enrollment, row, deps.now?.() ?? new Date().toISOString()))
                        continue;
                    row.runtime = { ...row.runtime, effectiveAt };
                    snapshot = await admitScheduledAttempt(deps.fhir, snapshot, row.id, deps.now?.() ?? new Date().toISOString());
                    const claimed = await claimScheduledAttempt(deps.fhir, snapshot, row.id, deps.now?.() ?? new Date().toISOString());
                    if (!claimed.claimed)
                        continue;
                    handledPatients.add(enrollment.patientReference);
                    snapshot = claimed;
                    row = snapshot.enrollment.scheduledSends!.find(r => r.id === row.id)!;
                    const key = row.attempts.at(-1)!.attemptKey;
                    const outcome = await deps.execute(snapshot.enrollment, row, key, prepared.prepared);
                    await deps.store.recordImmediateSendOutcome(enrollment.id, row.attempts.at(-1)!.sendIndex, outcome);
                    const current = await readCurrent(deps, enrollment.id);
                    await reconcileRow(deps, current, current.enrollment.scheduledSends!.find(r => r.id === row.id)!, at);
                }
                catch {
                    (deps.log ?? console.error)("odos-mcp: education sequence row requires reconciliation.");
                }
            }
        }
    }
    catch {
        (deps.log ?? console.error)("odos-mcp: education sequence sweep failed.");
    }
}
