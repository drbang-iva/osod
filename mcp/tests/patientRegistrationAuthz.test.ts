import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type {
  AccessPolicy,
  Account,
  Bundle,
  Patient,
  ProjectMembership,
  Resource,
} from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import express from "express";
import { registerClinicRoutes } from "../src/clinic/clinic-routes.js";
import { registerPatientFromDemographics } from "../src/clinic/patient-registration-endpoint.js";
import { grantNewlyRegisteredPatientAccess } from "../src/authz/role-grants.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  type PracticeRoleId,
} from "../src/authz/roles.js";

test("Provider, Staff, and Admin may register a patient", () => {
  const missing = (["provider", "staff", "admin"] as const).filter(
    (role) => !getRoleDeclaration(role).businessActions.includes("patients.register" as never),
  );
  assert.deepEqual(missing, [], `roles missing patients.register: ${missing.join(", ")}`);
});

test("no user AccessPolicy authorizes a compartment-less Account create", () => {
  for (const role of ["provider", "staff", "admin"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(role));
    const compartmentlessCreate = policy.resource?.find((rule) =>
      rule.resourceType === "Account" && rule.interaction?.includes("create") && !rule.criteria
    );
    assert.equal(compartmentlessCreate, undefined, `${role} must not create an unbound Account`);
  }
});

for (const role of ["provider", "staff", "admin"] as const) {
  test(`${role} registers Patient, RelatedPerson, and Account through one service transaction`, async () => {
    const fhir = new RegistrationFhir(role);
    const response = await postRegistration(role, fhir);

    assert.equal(response.status, 201);
    const body = await response.json() as { patient: Patient; warning?: unknown };
    assert.equal(body.patient.resourceType, "Patient");
    assert.equal(body.patient.id, "patient-1");
    assert.equal(body.warning, undefined);
    assert.deepEqual(
      fhir.transaction?.entry?.map((entry) => entry.resource?.resourceType),
      ["Patient", "RelatedPerson", "Account"],
    );
    assert.equal(fhir.account?.status, "active");
    assert.equal(fhir.canRead("Patient/patient-1"), true);
    assert.equal(fhir.auditRows.length, 1);
    assert.equal(fhir.auditRows[0]?.eventType, "transaction");
    assert.equal(fhir.auditRows[0]?.actorId, `${role}-1`);
    assert.equal(fhir.auditRows[0]?.actorRole, role);
    assert.equal(fhir.auditRows[0]?.resourceType, "Patient");
  });
}

test("registration creates the MRN reservation and identity resources in the caller project", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.serviceProjectId = "service-project";

  const response = await postRegistration("staff", fhir);
  const body = await response.json() as { patient: Patient; warning?: unknown };

  assert.equal(response.status, 201);
  assert.equal(body.warning, undefined);
  assert.equal(fhir.persistedReservationProjectId, "practice-1");
  assert.equal(fhir.account?.meta?.project, "practice-1");
  assert.equal(fhir.patient.meta?.project, "practice-1");
  assert.deepEqual(fhir.persistedTransactionProjectIds, ["practice-1", "practice-1", "practice-1"]);
});

test("a caller in project A never submits registration writes to service project B", async () => {
  const fhir = new RegistrationFhir("provider");
  fhir.serviceProjectId = "project-b";

  const response = await postRegistration("provider", fhir);

  assert.equal(response.status, 201);
  assert.deepEqual(fhir.submittedWriteProjectIds, [
    "practice-1",
    "practice-1",
    "practice-1",
    "practice-1",
  ]);
  assert.equal(fhir.submittedWriteProjectIds.includes("project-b"), false);
});

test("registration stops when an MRN reservation is returned from another project", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.reservationResponseProjectId = "project-b";

  const response = await postRegistration("staff", fhir);

  assert.equal(response.status, 500);
  assert.equal(fhir.transaction, undefined);
});

test("registration access grant rejects a Patient outside the caller project", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.patient.meta = { ...fhir.patient.meta, project: "other-practice" };
  fhir.returnOutOfProjectPatient = true;

  await assert.rejects(
    grantNewlyRegisteredPatientAccess(
      {
        staffReference: "Practitioner/staff-1",
        project: { reference: "Project/practice-1" },
        registrationRequest: {
          resourceType: "Bundle",
          type: "transaction",
          entry: [{
            resource: { resourceType: "Patient" },
            request: { method: "POST", url: "Patient" },
          }],
        },
        registrationResponse: {
          resourceType: "Bundle",
          type: "transaction-response",
          entry: [{ response: { status: "201 Created", location: "Patient/patient-1/_history/1" } }],
        },
      },
      { serviceFhir: fhir },
    ),
    /Newly registered Patient is not owned by the caller's project/,
  );
  assert.equal(fhir.grantPatchAttempts, 0);
});

test("a role without patients.register is refused before any service FHIR call", async () => {
  const actions = getRoleDeclaration("staff").businessActions;
  const index = actions.indexOf("patients.register");
  assert.notEqual(index, -1);
  actions.splice(index, 1);
  let fhirCalls = 0;
  const serviceFhir = new Proxy({}, {
    get: () => async () => {
      fhirCalls += 1;
      throw new Error("service FHIR must not be reached");
    },
  });
  try {
    await assert.rejects(
      registerPatientFromDemographics(
        REGISTRATION_BODY as never,
        {
          staffReference: "Practitioner/staff-1",
          actorRole: "staff",
          roles: ["staff"],
          project: { reference: "Project/practice-1" },
        },
        { serviceFhir: serviceFhir as never, now: () => "2026-08-25T12:00:00.000Z" },
      ),
      /lacks business action patients\.register/,
    );
    assert.equal(fhirCalls, 0);
  } finally {
    actions.splice(index, 0, "patients.register");
  }
});

test("a failed identity transaction leaves no Patient and marks its MRN reservation entered-in-error", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.failTransaction = true;

  const response = await postRegistration("staff", fhir);

  assert.equal(response.status, 500);
  assert.equal(fhir.patientCreated, false);
  assert.equal(fhir.account?.status, "entered-in-error");
});

test("a committed identity transaction with a dropped response is reconciled and preserved", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.dropCommittedTransactionResponse = true;

  const response = await postRegistration("staff", fhir);
  const body = await response.json() as { patient: Patient; warning?: unknown };

  assert.equal(response.status, 201);
  assert.equal(body.patient.id, "patient-1");
  assert.equal(body.warning, undefined);
  assert.equal(fhir.patientCreated, true);
  assert.equal(fhir.account?.status, "active");
  assert.equal(fhir.canRead("Patient/patient-1"), true);
});

test("a membership version conflict is refetched and retried before registration returns", async () => {
  const fhir = new RegistrationFhir("provider");
  fhir.conflictGrantOnce = true;

  const response = await postRegistration("provider", fhir);
  const body = await response.json() as { warning?: unknown };

  assert.equal(response.status, 201);
  assert.equal(body.warning, undefined);
  assert.equal(fhir.grantPatchAttempts, 2);
  assert.equal(fhir.canRead("Patient/patient-1"), true);
});

test("registration grants access when the caller membership omits active", async () => {
  const fhir = new RegistrationFhir("staff");
  delete fhir.membership.active;

  const response = await postRegistration("staff", fhir);
  const body = await response.json() as { warning?: unknown };

  assert.equal(response.status, 201);
  assert.equal(body.warning, undefined);
  assert.equal(fhir.canRead("Patient/patient-1"), true);
});

test("inactive memberships do not consume the registration membership search count", async () => {
  const fhir = new RegistrationFhir("staff");
  delete fhir.membership.active;
  fhir.memberships.unshift(
    inactiveMembership("inactive-1", fhir.membership),
    inactiveMembership("inactive-2", fhir.membership),
    inactiveMembership("inactive-3", fhir.membership),
  );

  const response = await postRegistration("staff", fhir);
  const body = await response.json() as { warning?: unknown };

  assert.equal(response.status, 201);
  assert.equal(body.warning, undefined);
  assert.equal(fhir.canRead("Patient/patient-1"), true);
});

test("registration appends every named compartment parameter on a stacked composite membership", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.policy.id = "provider-staff-admin";
  fhir.policy.resource = ["provider", "staff", "admin"].flatMap((role) => [
    {
      resourceType: "Patient",
      criteria: `Patient?_compartment=%${role}_patient_compartment`,
    },
    {
      resourceType: "Encounter",
      criteria: `Encounter?_compartment=%${role}_patient_compartment&participant=%${role}_provider_profile`,
    },
  ]);
  fhir.membership.access = [{ policy: { reference: "AccessPolicy/provider-staff-admin" } }];

  const response = await postRegistration("staff", fhir);

  assert.equal(response.status, 201);
  assert.deepEqual(fhir.membership.access?.[1]?.parameter, [
    { name: "admin_patient_compartment", valueString: "Patient/patient-1" },
    { name: "admin_provider_profile", valueReference: { reference: "Practitioner/staff-1" } },
    { name: "provider_patient_compartment", valueString: "Patient/patient-1" },
    { name: "provider_provider_profile", valueReference: { reference: "Practitioner/staff-1" } },
    { name: "staff_patient_compartment", valueString: "Patient/patient-1" },
    { name: "staff_provider_profile", valueReference: { reference: "Practitioner/staff-1" } },
  ]);
});

test("persistent grant failure preserves the active registration and returns asserted repair guidance", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.failGrantAlways = true;
  const logs: string[] = [];

  const response = await postRegistration("staff", fhir, (message) => logs.push(message));
  const body = await response.json() as {
    patient: Patient;
    warning: { code: string; message: string; patientReference: string };
  };

  assert.equal(response.status, 201);
  assert.equal(body.patient.active, true);
  assert.equal(fhir.patientCreated, true);
  assert.equal(fhir.account?.status, "active");
  assert.equal(body.warning.code, "access-grant-repair-required");
  assert.match(body.warning.message, /practice administrator.*repair.*patient access/i);
  assert.equal(body.warning.patientReference, "Patient/patient-1");
  assert.deepEqual(logs, [
    "odos-mcp: patient registration access grant failed for Patient/patient-1; registration preserved.",
  ]);
});

test("an exact pre-existing Patient is returned as a duplicate and never receives a registration grant", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.exactDuplicate = true;

  const response = await postRegistration("staff", fhir);
  const body = await response.json() as { patients: Patient[] };

  assert.equal(response.status, 409);
  assert.deepEqual(body.patients.map((patient) => patient.id), ["preexisting-1"]);
  assert.equal(fhir.transaction, undefined);
  assert.equal(fhir.grantPatchAttempts, 0);
  assert.equal(fhir.canRead("Patient/preexisting-1"), false);
});

test("an exact duplicate on a later project-scoped search page still requires confirmation", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.exactDuplicateOnSecondPage = true;

  const response = await postRegistration("staff", fhir);
  const body = await response.json() as { patients: Patient[] };

  assert.equal(response.status, 409);
  assert.deepEqual(body.patients.map((patient) => patient.id), ["preexisting-1"]);
  assert.equal(fhir.transaction, undefined);
});

test("duplicate detection never returns a Patient owned by another project", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.exactDuplicate = true;
  fhir.duplicateProjectId = "other-practice";

  const response = await postRegistration("staff", fhir);
  const body = await response.json() as { patients?: Patient[] };

  assert.equal(response.status, 500);
  assert.equal(body.patients, undefined);
  assert.equal(fhir.transaction, undefined);
});

test("confirmDuplicate creates a distinct server-owned Patient after the duplicate warning", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.exactDuplicate = true;

  const response = await postRegistration("staff", fhir, undefined, {
    ...REGISTRATION_BODY,
    confirmDuplicate: true,
  });
  const body = await response.json() as { patient: Patient };

  assert.equal(response.status, 201);
  assert.equal(body.patient.id, "patient-1");
  assert.equal(fhir.patientCreated, true);
  assert.equal(fhir.canRead("Patient/patient-1"), true);
  assert.equal(fhir.canRead("Patient/preexisting-1"), false);
});

test("a caller-supplied Patient id is rejected before registration FHIR calls", async () => {
  const fhir = new RegistrationFhir("staff");
  const response = await postRegistration("staff", fhir, undefined, {
    ...REGISTRATION_BODY,
    patientId: "preexisting-1",
  });

  assert.equal(response.status, 400);
  assert.equal(fhir.searchCalls, 0);
  assert.equal(fhir.grantPatchAttempts, 0);
});

test("authoritative registration validation rejects form-invalid input before service FHIR", async () => {
  const invalidBodies = [
    {
      ...REGISTRATION_BODY,
      demographics: { ...REGISTRATION_BODY.demographics, phone: "1" },
    },
    {
      ...REGISTRATION_BODY,
      demographics: { ...REGISTRATION_BODY.demographics, birthDate: "1980-01-02" },
      responsibleParties: [
        { ...REGISTRATION_BODY.responsibleParties[0], kind: "self", localId: "self-1" },
        { ...REGISTRATION_BODY.responsibleParties[0], kind: "self", localId: "self-2" },
      ],
    },
    {
      ...REGISTRATION_BODY,
      demographics: { ...REGISTRATION_BODY.demographics, birthDate: "1980-01-02" },
      responsibleParties: [{
        ...REGISTRATION_BODY.responsibleParties[0],
        endDate: "2026-02-30",
      }],
    },
    {
      ...REGISTRATION_BODY,
      demographics: { ...REGISTRATION_BODY.demographics, birthDate: "1980-01-02" },
      responsibleParties: [
        REGISTRATION_BODY.responsibleParties[0],
        { ...REGISTRATION_BODY.responsibleParties[0], primary: false },
      ],
    },
    {
      ...REGISTRATION_BODY,
      demographics: { ...REGISTRATION_BODY.demographics, birthDate: "1980-01-02" },
      responsibleParties: [{
        ...REGISTRATION_BODY.responsibleParties[0],
        kind: "self",
        relationship: "other",
        address: "",
        city: "",
        state: "",
        postalCode: "",
        consentAuthority: false,
        primary: false,
      }],
    },
  ];

  for (const body of invalidBodies) {
    const fhir = new RegistrationFhir("staff");
    const response = await postRegistration("staff", fhir, undefined, body);
    assert.equal(response.status, 400);
    assert.equal(fhir.searchCalls, 0);
  }
});

const REGISTRATION_BODY = {
  demographics: {
    firstName: "Synthetic",
    middleName: "",
    lastName: "Registration",
    preferredName: "",
    birthDate: "2010-01-02",
    gender: "female",
    phone: "864-555-0100",
    email: "",
    address: "1 Synthetic Way",
    city: "Greenville",
    state: "SC",
    postalCode: "29601",
  },
  responsibleParties: [{
    localId: "guardian",
    kind: "person",
    relationship: "legal-guardian",
    firstName: "Responsible",
    middleName: "",
    lastName: "Person",
    phone: "864-555-0101",
    address: "1 Synthetic Way",
    city: "Greenville",
    state: "SC",
    postalCode: "29601",
    financialResponsible: true,
    consentAuthority: true,
    primary: true,
    courtOrderNotes: "",
    effectiveDate: "2026-08-25",
    endDate: "",
  }],
  confirmDuplicate: false,
} as const;

async function postRegistration(
  role: PracticeRoleId,
  serviceFhir: RegistrationFhir,
  logRegistrationGrantFailure?: (message: string, error: unknown) => void,
  body: unknown = REGISTRATION_BODY,
): Promise<Response> {
  const app = express();
  app.use(express.json());
  registerClinicRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({
      staffReference: `Practitioner/${role}-1`,
      actorRole: role,
      roles: [role],
      project: { reference: "Project/practice-1" },
      fhir: {} as never,
    }),
    serviceFhir,
    logRegistrationGrantFailure,
    now: () => "2026-08-25T12:00:00.000Z",
  } as never);
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}/clinic/patients`, {
      method: "POST",
      headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => error ? reject(error) : resolve())
    );
  }
}

class RegistrationFhir {
  readonly baseUrl = "http://fhir.test";
  account?: Account;
  transaction?: Bundle;
  serviceProjectId = "practice-1";
  reservationResponseProjectId?: string;
  persistedReservationProjectId?: string;
  returnOutOfProjectPatient = false;
  readonly submittedWriteProjectIds: string[] = [];
  readonly persistedTransactionProjectIds: string[] = [];
  failTransaction = false;
  dropCommittedTransactionResponse = false;
  patientCreated = false;
  conflictGrantOnce = false;
  failGrantAlways = false;
  exactDuplicate = false;
  exactDuplicateOnSecondPage = false;
  duplicateProjectId = "practice-1";
  searchCalls = 0;
  grantPatchAttempts = 0;
  readonly membership: ProjectMembership;
  readonly memberships: ProjectMembership[];
  readonly auditRows: OdosAuditEventRecord[] = [];
  patient: Patient = {
    resourceType: "Patient",
    id: "patient-1",
    meta: { versionId: "1", project: "Project/practice-1" },
    active: true,
    name: [{ use: "official", given: ["Synthetic"], family: "Registration" }],
    birthDate: "2010-01-02",
  };
  readonly policy: AccessPolicy;

  constructor(role: PracticeRoleId) {
    this.membership = {
      resourceType: "ProjectMembership",
      id: `${role}-membership`,
      meta: { versionId: "1", project: "Project/practice-1" },
      project: { reference: "Project/practice-1" },
      profile: { reference: `Practitioner/${role}-1` },
      active: true,
      access: [{ policy: { reference: `AccessPolicy/${role}` } }],
    };
    this.memberships = [this.membership];
    this.policy = {
      resourceType: "AccessPolicy",
      id: role,
      meta: { project: "Project/practice-1" },
      resource: [{
        resourceType: "Patient",
        criteria: "Patient?_compartment=%patient_compartment",
      }],
    };
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    this.searchCalls += 1;
    if (resourceType === "Patient") {
      const duplicate = this.exactDuplicate && params.given
        ? {
            ...this.patient,
            id: "preexisting-1",
            meta: { versionId: "1", project: `Project/${this.duplicateProjectId}` },
          }
        : undefined;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: duplicate ? [{ resource: duplicate as T }] : [],
      };
    }
    throw new Error(`unexpected search ${resourceType}`);
  }

  async searchProject<T extends Resource>(
    resourceType: T["resourceType"],
    projectId: string,
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    assert.equal(projectId, "practice-1");
    const resources = resourceType === "ProjectMembership"
      ? this.memberships
        .filter((membership) => !params.profile || membership.profile?.reference === params.profile)
        .filter((membership) => params.active === "true" ? membership.active === true : true)
        .filter((membership) => params["active:not"] === "false" ? membership.active !== false : true)
        .slice(0, Number(params._count ?? this.memberships.length))
      : resourceType === "AccessPolicy"
      ? this.policy
      : resourceType === "Patient"
      ? params.given
        ? this.exactDuplicate
          ? {
              ...this.patient,
              id: "preexisting-1",
              meta: { versionId: "1", project: `Project/${this.duplicateProjectId}` },
            }
          : undefined
        : this.returnOutOfProjectPatient || projectIdFromMeta(this.patient.meta?.project) === projectId
          ? this.patient
          : undefined
      : undefined;
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: Array.isArray(resources)
        ? resources.map((resource) => ({ resource: resource as T }))
        : resources
        ? [{ resource: resources as T }]
        : [],
      link: resourceType === "Patient" && params.given && this.exactDuplicateOnSecondPage
        ? [{ relation: "next", url: "http://fhir.test/fhir/R4/Patient?_project=practice-1&_cursor=next" }]
        : undefined,
    };
  }

  async searchProjectUrl<T extends Resource>(
    _url: string,
    resourceType: T["resourceType"],
    projectId: string,
  ): Promise<Bundle<T>> {
    assert.equal(resourceType, "Patient");
    assert.equal(projectId, "practice-1");
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: [{
        resource: {
          ...this.patient,
          id: "preexisting-1",
          meta: { versionId: "1", project: "Project/practice-1" },
        } as T,
      }],
    };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    assert.equal(resource.resourceType, "Account");
    const requestedProjectId = projectIdFromMeta(resource.meta?.project) ?? this.serviceProjectId;
    this.submittedWriteProjectIds.push(requestedProjectId);
    this.persistedReservationProjectId = this.reservationResponseProjectId ?? requestedProjectId;
    this.account = {
      ...(resource as Account),
      id: "reservation-1",
      meta: { versionId: "1", project: this.persistedReservationProjectId },
    };
    return structuredClone(this.account) as T;
  }

  async executeTransaction(bundle: Bundle): Promise<Bundle> {
    assert.equal(this.auditRows.length, 1, "registration transaction must execute inside human-attributed audit");
    this.transaction = structuredClone(bundle);
    if (this.failTransaction) throw new Error("synthetic transaction failure");
    this.persistedTransactionProjectIds.splice(0);
    for (const entry of bundle.entry ?? []) {
      if (!entry.resource) continue;
      const projectId = projectIdFromMeta(entry.resource.meta?.project) ?? this.serviceProjectId;
      this.submittedWriteProjectIds.push(projectId);
      this.persistedTransactionProjectIds.push(projectId);
    }
    this.patientCreated = true;
    this.patient = {
      ...this.patient,
      meta: {
        ...this.patient.meta,
        project: this.persistedTransactionProjectIds[0],
      },
    };
    this.account = {
      ...(bundle.entry?.at(-1)?.resource as Account),
      id: "reservation-1",
      status: "active",
      subject: [{ reference: "Patient/patient-1" }],
      meta: { versionId: "2", project: this.persistedTransactionProjectIds.at(-1) },
    };
    if (this.dropCommittedTransactionResponse) {
      throw new Error("synthetic connection loss after commit");
    }
    return {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: [
        { response: { status: "201 Created", location: "Patient/patient-1/_history/1" } },
        { response: { status: "201 Created", location: "RelatedPerson/related-1/_history/1" } },
        { response: { status: "200 OK", location: "Account/reservation-1/_history/2" } },
      ],
    };
  }

  async executeTransactionAsActor(
    bundle: Bundle,
    actor: { actorReference: string; actorRole: PracticeRoleId },
    _headers: Record<string, string>,
    options: {
      validateResponse?: (response: Bundle) => void;
      reconcileError?: (error: unknown) => Promise<Bundle>;
    },
  ): Promise<Bundle> {
    this.auditRows.push({
      eventType: "transaction",
      actorId: actor.actorReference.replace(/^Practitioner\//, ""),
      actorRole: actor.actorRole,
      resourceType: bundle.entry?.[0]?.resource?.resourceType,
    } as OdosAuditEventRecord);
    try {
      const response = await this.executeTransaction(bundle);
      options.validateResponse?.(response);
      return response;
    } catch (error) {
      if (!options.reconcileError) throw error;
      return options.reconcileError(error);
    }
  }

  async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
    assert.equal(resourceType, "Account");
    assert.equal(id, "reservation-1");
    this.account = structuredClone(resource as Account);
    return structuredClone(resource);
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    if (resourceType === "Patient" && id === "patient-1") return structuredClone(this.patient) as T;
    if (resourceType === "Account" && id === "reservation-1" && this.account) {
      return structuredClone(this.account) as T;
    }
    throw new Error(`unexpected read ${resourceType}/${id}`);
  }

  async patch<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    operations: Array<{ op: string; path: string; value?: unknown }>,
  ): Promise<T> {
    assert.equal(resourceType, "ProjectMembership");
    assert.equal(id, this.membership.id);
    this.grantPatchAttempts += 1;
    if (this.conflictGrantOnce && this.grantPatchAttempts === 1) {
      throw Object.assign(new Error("synthetic version conflict"), { status: 412 });
    }
    if (this.failGrantAlways) throw new Error("synthetic grant persistence failure");
    for (const operation of operations) {
      if (operation.path === "/access/-") {
        this.membership.access?.push(operation.value as NonNullable<ProjectMembership["access"]>[number]);
      } else if (operation.path === "/access") {
        this.membership.access = operation.value as ProjectMembership["access"];
      }
    }
    this.membership.meta = { ...this.membership.meta, versionId: "2" };
    return structuredClone(this.membership) as T;
  }

  canRead(patientReference: string): boolean {
    return this.membership.access?.some((access) => access.parameter?.some(
      (parameter) => parameter.valueString === patientReference,
    )) ?? false;
  }
}

function inactiveMembership(id: string, membership: ProjectMembership): ProjectMembership {
  return {
    ...structuredClone(membership),
    id,
    active: false,
  };
}

function projectIdFromMeta(project: string | undefined): string | undefined {
  return project?.replace(/^Project\//, "");
}

test("G15 registration includes explicit communication cells attributed to registering staff", async () => {
  const { readCommsPreferenceCells } = await import("../src/comms/suppression-gate.js");
  const fhir = new RegistrationFhir("staff");
  const response = await postRegistration("staff", fhir, undefined, {
    ...REGISTRATION_BODY,
    communicationPreferences: { cells: [{ purpose: "education", channel: "sms", allowed: false }] },
  });
  assert.equal(response.status, 201);
  const created = fhir.transaction!.entry![0].resource as Patient;
  const cells = readCommsPreferenceCells(created);
  assert.equal(cells.length, 1);
  assert.deepEqual({ purpose: cells[0].purpose, channel: cells[0].channel, allowed: cells[0].allowed, setBy: cells[0].setBy, surface: cells[0].surface }, {
    purpose: "education", channel: "sms", allowed: false, setBy: { reference: "Practitioner/staff-1" }, surface: "staff-registration",
  });
});

test("G20 registration without effective preference permission creates nothing", async () => {
  let calls = 0;
  const fhir: any = new Proxy({}, { get: () => async () => { calls++; throw Error("FHIR must not be reached"); } });
  await assert.rejects(registerPatientFromDemographics({
    ...structuredClone(REGISTRATION_BODY),
    communicationPreferences: { cells: [{ purpose: "education", channel: "sms", allowed: true }] },
  } as any, {
    staffReference: "Practitioner/staff-1", actorRole: "staff", roles: ["staff"], project: { reference: "Project/practice-1" }, businessActions: ["patients.register"],
  } as any, { serviceFhir: fhir }), (error: any) => error.status === 403);
  assert.equal(calls, 0);
});

test("registration paper evidence and preference references share the Patient creation transaction", async () => {
  const { readCommsPreferenceCells } = await import("../src/comms/suppression-gate.js");
  class EvidenceRegistrationFhir extends RegistrationFhir {
    override async executeTransaction(bundle: Bundle): Promise<Bundle> {
      await super.executeTransaction(bundle);
      return { resourceType: "Bundle", type: "transaction-response", entry: bundle.entry!.map((entry, index) => ({ response: {
        status: entry.request!.method === "POST" ? "201 Created" : "200 OK",
        location: index === 0 ? "Patient/patient-1/_history/1" : `${entry.resource!.resourceType}/synthetic-${index}/_history/1`,
      } })) };
    }
  }
  const fhir = new EvidenceRegistrationFhir("staff");
  const response = await postRegistration("staff", fhir, undefined, {
    ...REGISTRATION_BODY,
    communicationPreferences: { cells: [{ purpose: "education", channel: "email", allowed: true }], confirmedVia: "paper-form", formDate: "2026-08-24" },
  });
  assert.equal(response.status, 201);
  const entries = fhir.transaction!.entry!;
  const patientEntry = entries[0];
  const consentEntry = entries.find(entry => entry.resource?.resourceType === "Consent")!;
  assert.ok(consentEntry);
  const consent = consentEntry.resource as import("@medplum/fhirtypes").Consent;
  assert.equal(consent.patient?.reference, patientEntry.fullUrl);
  assert.equal(consent.performer?.[0].reference, patientEntry.fullUrl);
  assert.equal(consent.dateTime, "2026-08-24");
  assert.equal(readCommsPreferenceCells(patientEntry.resource as Patient)[0].evidence?.reference, consentEntry.fullUrl);
});
