import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildCommsOptOutExtension, createSuppressedCommsProvider } from "../src/comms/suppression-gate.js";
import { test } from "node:test";
import * as api from "../src/comms/comms-api.js";

test("system actor carrying the staff quiet-hours exemption is refused before any dependency access", async () => {
  const dispatch = (api as any).dispatchEducationAs;
  assert.equal(typeof dispatch, "function");
  const f = fixture();
  await assert.rejects(dispatch({
    ...f.actor, quietHoursExemption: "staff-initiated-chart-education",
  }, f.deps, f.patient, f.body), /system.*quiet.hours exemption/i);
  assert.equal(f.requests.length, 0);
  assert.equal(f.resources.length, 0);
});

function fixture() {
  const resources: any[] = [];
  const requests: any[] = [];
  const patient: any = {resourceType: "Patient", id: "synthetic", telecom:[{system:"email",value:"synthetic@example.invalid"}]};
  const item: any = {id:"education",version:1,title:"Education",kind:"page",audience:"patient",dxCodes:[],channels:["email"],laneHint:"clinical",consentClass:"transactional",urls:{email:"https://example.invalid/education"}};
  const fhir: any = {
    baseUrl: "http://localhost/fhir/R4",
    read: async (type:string,id:string) => type === "Patient" ? patient : resources.find(r => r.resourceType === type && r.id === id),
    search: async (type:string, params:any) => ({resourceType:"Bundle",entry:resources.filter(r => r.resourceType===type && (!params.identifier || r.identifier?.some((i:any)=>`${i.system}|${i.value}`===params.identifier))).map(resource=>({resource}))}),
    create: async (r:any) => { const saved=structuredClone({...r,id:String(resources.length+1),meta:{...r.meta,versionId:randomUUID()}}); resources.push(saved); return saved; },
    update: async (type:string,id:string,r:any,headers:any) => {
      const index=resources.findIndex(r=>r.resourceType===type&&r.id===id);
      assert.equal(headers?.["If-Match"], `W/"${resources[index].meta.versionId}"`);
      const saved=structuredClone({...r,id,meta:{...r.meta,versionId:randomUUID()}});
      resources[index]=saved;return saved;
    },
  };
  const provider:any={name:"synthetic",capabilities:{email:true},preflightSuppression:async()=>undefined,sendEmail:async(request:any)=>{requests.push(request);return {outcome:"sent",providerMessageId:"receipt-1"};}};
  const deps:any={educationCatalog:{get:()=>item},dispatch:{providerFor:()=>"synthetic",senderNumberFor:()=>"+15555550100",getAdapterForRole:()=>provider},now:()=>"2026-09-10T15:00:00Z"};
  const actor:any={kind:"system",reference:"Device/education-sequence-worker",onBehalfOf:"Practitioner/enroller",fhir};
  const body:any={patientReference:"Patient/synthetic",educationId:"education",version:1,channel:"email",lane:"clinical",alsoUpdateChart:false,idempotencyKey:"sequence-attempt-1"};
  return {resources,requests,patient,item,fhir,provider,deps,actor,body};
}

test("system send keeps enrolling sender, records executor, and reconciles frozen receipt without mutable reads", async()=>{
  const f=fixture();
  const result=await (api as any).dispatchEducationAs(f.actor,f.deps,f.patient,f.body);
  assert.equal(result.outcome,"sent");
  assert.deepEqual(f.requests[0].suppression,{ consentClass: "transactional" });
  const reservation=f.resources.find(r=>r.resourceType==="Communication");
  assert.equal(reservation.sender.reference,"Practitioner/enroller");
  const provenance=f.resources.find(r=>r.resourceType==="Provenance");
  assert.ok(provenance.agent.some((a:any)=>a.who.reference==="Device/education-sequence-worker"));
  f.deps.educationCatalog.get=()=>{throw Error("catalog must not be read");};
  f.fhir.read=async()=>{throw Error("recipient must not be read");};
  f.deps.dispatch.getAdapterForRole=()=>{throw Error("provider config must not be read");};
  const replay=await (api as any).dispatchEducationAs(f.actor,f.deps,undefined,f.body,{reconcileOnly:true});
  assert.equal(replay.outcome,"sent");
  assert.equal(f.requests.length,1);
});

test("preflight resolves predictable holds and quiet hours without provider calls or reservations", async()=>{
  const f=fixture();
  f.provider.preflightSuppression=async()=>({outcome:"rescheduled",reason:"quiet-hours",rescheduledAt:"2026-09-11T12:00:00Z"});
  assert.deepEqual(await (api as any).prepareEducationSequenceDispatch(f.deps,f.fhir,f.patient,f.body),{kind:"deferred",notBefore:"2026-09-11T12:00:00Z"});
  f.deps.educationCatalog.get=()=>undefined;
  assert.deepEqual(await (api as any).prepareEducationSequenceDispatch(f.deps,f.fhir,f.patient,f.body),{kind:"held",reason:"content-unavailable"});
  assert.equal(f.requests.length,0);
  assert.equal(f.resources.length,0);
});


test("scheduled SMS rechecks real quiet-hours gate after preflight and frozen deferral proves zero adapter calls", async () => {
  const f = fixture();
  f.body.channel = "sms";
  f.item.channels = ["sms"];
  f.item.urls.web = "https://example.invalid/education";
  f.patient.telecom = [{ system: "phone", value: "+15555550100" }];
  let now = new Date("2026-09-10T15:00:00Z");
  const provider = createSuppressedCommsProvider({
    ...f.provider,
    sendSms: async (request: any) => { f.requests.push(request); return { outcome: "sent", providerMessageId: "receipt" }; },
  }, { fhir: f.fhir, practiceTimeZone: "America/New_York", now: () => now });
  f.deps.dispatch.getAdapterForRole = () => provider;
  f.deps.publicBaseUrl = "https://example.invalid";
  f.deps.practiceName = "Synthetic";
  f.deps.trackedLinkStore = { create: async () => undefined };
  const prepared = await api.prepareEducationSequenceDispatch(f.deps, f.fhir, f.patient, f.body);
  assert.equal(prepared.kind, "ready");
  assert.equal(f.resources.length, 0);
  assert.equal(f.requests.length, 0);
  if (prepared.kind !== "ready") throw Error("expected ready");
  (prepared.prepared as any).suppression = { quietHoursExemption: "staff-initiated-chart-education" };
  now = new Date("2026-09-11T02:00:00Z");
  const outcome = await api.dispatchEducationAs(f.actor, f.deps, f.patient, f.body, { prepared: prepared.prepared });
  assert.equal(outcome.outcome, "rescheduled");
  assert.equal(f.requests.length, 0);
  const evidence = await api.readEducationDispatchEvidence(f.fhir, f.body, f.actor.onBehalfOf);
  assert.equal(evidence?.providerInvoked, false);
  assert.deepEqual(evidence?.outcome, outcome);
  f.deps.educationCatalog.get = () => { throw Error("withdrawn catalog must not block recovery"); };
  f.fhir.read = async () => { throw Error("patient cannot be read during recovery"); };
  const reordered = Object.fromEntries(Object.entries(f.body).reverse());
  assert.deepEqual(await api.dispatchEducationAs(f.actor, f.deps, undefined, reordered as any, { reconcileOnly: true }), outcome);
});

test("unknown reservation never invokes a provider during reconciliation", async () => {
  const f = fixture();
  await assert.rejects(api.dispatchEducationAs(f.actor, f.deps, undefined, f.body, { reconcileOnly: true }), /pending reconciliation/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.resources.length, 0);
});


test("preflight holds missing recipient, unsupported channel, absent consent, and print without admission writes", async () => {
  const f = fixture();
  f.patient.telecom = [];
  assert.deepEqual(await api.prepareEducationSequenceDispatch(f.deps, f.fhir, f.patient, f.body), { kind: "held", reason: "no-recipient-channel" });
  f.item.channels = ["sms"];
  assert.deepEqual(await api.prepareEducationSequenceDispatch(f.deps, f.fhir, f.patient, f.body), { kind: "held", reason: "content-unavailable" });
  f.item.channels = ["email"];
  f.item.consentClass = "marketing";
  assert.deepEqual(await api.prepareEducationSequenceDispatch(f.deps, f.fhir, f.patient, f.body), { kind: "held", reason: "no-recipient-channel" });
  f.body.channel = "print";
  assert.deepEqual(await api.prepareEducationSequenceDispatch(f.deps, f.fhir, f.patient, f.body), { kind: "held", reason: "needs-acknowledgement" });
  f.body.channel = "sms";
  f.item.channels = ["sms"];
  f.patient.telecom = [{ system: "phone", value: "+15555550100" }];
  assert.deepEqual(await api.prepareEducationSequenceDispatch(f.deps, f.fhir, f.patient, f.body), { kind: "held", reason: "preference-withheld" });
  assert.equal(f.resources.length, 0);
  assert.equal(f.requests.length, 0);
});

test("provider-side opt-out cannot prove the adapter was never invoked", async () => {
  const f = fixture();
  f.provider.sendEmail = async (request: any) => { f.requests.push(request); return { outcome: "suppressed", reason: "patient-opt-out" }; };
  await api.dispatchEducationAs(f.actor, f.deps, f.patient, f.body);
  assert.equal(f.requests.length, 1);
  const evidence = await api.readEducationDispatchEvidence(f.fhir, f.body, f.actor.onBehalfOf);
  assert.equal(evidence?.providerInvoked, "unknown");
});

test("frozen recovery refuses changed enrollment sender or different logical request", async () => {
  const f = fixture();
  await api.dispatchEducationAs(f.actor, f.deps, f.patient, f.body);
  await assert.rejects(api.dispatchEducationAs({ ...f.actor, onBehalfOf: "Practitioner/other" }, f.deps, undefined, f.body, { reconcileOnly: true }), /identity conflict/);
  await assert.rejects(api.dispatchEducationAs(f.actor, f.deps, undefined, { ...f.body, educationId: "different" }, { reconcileOnly: true }), /request conflict/);
  assert.equal(f.requests.length, 1);
});


test("staff actor reconciles frozen system receipt with original executor and cannot start sequence keys", async () => {
  const f = fixture();
  f.body.idempotencyKey = "education-sequence-synthetic-recovery";
  const staff: any = { kind: "staff", staff: { staffReference: "Practitioner/resuming", fhir: f.fhir } };
  await assert.rejects(api.dispatchEducationAs(staff, f.deps, f.patient, f.body), /requires-worker-claim/);
  assert.equal(f.requests.length, 0);
  const create = f.fhir.create;
  let failProvenance = true;
  f.fhir.create = async (resource: any) => {
    if (resource.resourceType === "Provenance" && failProvenance) throw Error("synthetic lost provenance write");
    return create(resource);
  };
  await assert.rejects(api.dispatchEducationAs(f.actor, f.deps, f.patient, f.body), /lost provenance write/);
  assert.equal(f.requests.length, 1);
  failProvenance = false;
  const result = await api.dispatchEducationAs(staff, f.deps, undefined, f.body, { reconcileOnly: true, senderReference: f.actor.onBehalfOf });
  assert.equal(result.outcome, "sent");
  const provenance = f.resources.find(r => r.resourceType === "Provenance");
  assert.ok(provenance.agent.some((agent: any) => agent.who.reference === f.actor.reference));
  assert.ok(provenance.agent.some((agent: any) => agent.who.reference === f.actor.onBehalfOf));
  assert.equal(f.requests.length, 1);
});

for (const channel of ["email", "sms"] as const) {
test(`final gate rechecks prepared system marketing ${channel} after consent is revoked`, async () => {
  const f = fixture();
  f.item.consentClass = "marketing";
  f.patient.extension = [{
    url: api.ODOS_COMMS_MARKETING_CONSENT_EXTENSION_URL,
    extension: [
      { url: "consent", valueBoolean: true },
      { url: "recorded", valueDateTime: "2026-09-10T14:00:00Z" },
    ],
  }];
  f.body.channel = channel;
  if (channel === "sms") {
    f.item.channels = ["sms"];
    f.item.urls.web = "https://example.invalid/education";
    f.patient.telecom = [{ system: "phone", value: "+15555550100" }];
    f.provider.sendSms = f.provider.sendEmail;
    f.deps.publicBaseUrl = "https://example.invalid";
    f.deps.practiceName = "Synthetic";
    f.deps.trackedLinkStore = { create: async () => undefined };
  }
  const stalePatient = structuredClone(f.patient);
  const provider = createSuppressedCommsProvider(f.provider, {
    fhir: f.fhir, practiceTimeZone: "America/New_York", now: () => new Date("2026-09-10T15:00:00Z"),
  });
  f.deps.dispatch.getAdapterForRole = () => provider;
  const preparation = await api.prepareEducationSequenceDispatch(f.deps, f.fhir, stalePatient, f.body);
  assert.equal(preparation.kind, "ready");
  if (preparation.kind !== "ready") throw Error("expected ready");
  f.patient.extension = [];
  const result = await api.dispatchEducationAs(f.actor, f.deps, stalePatient, f.body, { prepared: preparation.prepared });
  assert.deepEqual(result, channel === "email" ? { outcome: "sent", providerMessageId: "receipt-1" } : { outcome: "suppressed", reason: "preference-withheld" });
  assert.equal(f.requests.length, channel === "email" ? 1 : 0);
  const evidence = await api.readEducationDispatchEvidence(f.fhir, f.body, f.actor.onBehalfOf);
  assert.deepEqual(evidence?.outcome, result);
  if (channel === "email") {
    f.patient.extension = [buildCommsOptOutExtension("email")];
    f.requests.length = 0;
    const blocked = await api.dispatchEducationAs(f.actor, f.deps, f.patient, { ...f.body, idempotencyKey: "sequence-email-opt-out" });
    assert.deepEqual(blocked, { outcome: "suppressed", reason: "patient-opt-out" });
    assert.equal(f.requests.length, 0);
  }
  f.fhir.read = async () => { throw Error("frozen reconciliation must not recheck consent"); };
  assert.deepEqual(await api.dispatchEducationAs(f.actor, f.deps, undefined, f.body, { reconcileOnly: true }), result);
});

}

test("recorded system marketing receipt reconciles after consent and catalog are withdrawn", async () => {
  const f = fixture();
  f.item.consentClass = "marketing";
  f.patient.extension = [{
    url: api.ODOS_COMMS_MARKETING_CONSENT_EXTENSION_URL,
    extension: [
      { url: "consent", valueBoolean: true },
      { url: "recorded", valueDateTime: "2026-09-10T14:00:00Z" },
    ],
  }];
  const provider = createSuppressedCommsProvider(f.provider, {
    fhir: f.fhir, practiceTimeZone: "America/New_York", now: () => new Date("2026-09-10T15:00:00Z"),
  });
  f.deps.dispatch.getAdapterForRole = () => provider;
  const result = await api.dispatchEducationAs(f.actor, f.deps, f.patient, f.body);
  assert.equal(result.outcome, "sent");
  assert.deepEqual(f.requests[0].suppression, { requiresMarketingConsent: true, consentClass: "marketing" });
  f.patient.extension = [];
  f.deps.educationCatalog.get = () => { throw Error("withdrawn catalog"); };
  f.fhir.read = async () => { throw Error("mutable patient unavailable"); };
  assert.deepEqual(await api.dispatchEducationAs(f.actor, f.deps, undefined, f.body, { reconcileOnly: true }), result);
  assert.equal(f.requests.length, 1);
});

test("system actor cannot request a chart update or produce chart metadata", async () => {
  const f = fixture();
  await assert.rejects(api.dispatchEducationAs(f.actor, f.deps, f.patient, { ...f.body, alsoUpdateChart: true }),
    /system education dispatch requires an electronic send without chart mutation/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.resources.length, 0);
  const result = await api.dispatchEducationAs(f.actor, f.deps, f.patient, f.body);
  assert.equal("chartUpdate" in result, false);
});

test("staff marketing email follows default ON but email opt-out still suppresses", async () => {
  const f = fixture();
  f.item.consentClass = "marketing";
  const provider = createSuppressedCommsProvider(f.provider, { fhir: f.fhir, practiceTimeZone: "UTC", now: () => new Date("2026-09-10T15:00:00Z") });
  f.deps.dispatch.getAdapterForRole = () => provider;
  const actor: any = { kind: "staff", staff: { staffReference: "Practitioner/staff", fhir: f.fhir } };
  assert.deepEqual(await api.dispatchEducationAs(actor, f.deps, f.patient, f.body), { outcome: "sent", providerMessageId: "receipt-1" });
  assert.equal(f.requests.length, 1);
  f.patient.extension = [buildCommsOptOutExtension("email")];
  f.requests.length = 0;
  assert.deepEqual(await api.dispatchEducationAs(actor, f.deps, f.patient, { ...f.body, idempotencyKey: "staff-email-opt-out" }), { outcome: "suppressed", reason: "patient-opt-out" });
  assert.equal(f.requests.length, 0);
});
