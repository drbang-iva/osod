import { resolvePractitionerReference } from "../authz/practitioner-reference.js";
import type {
  AccessPolicy,
  Appointment,
  Bundle,
  Patient,
  ProjectMembership,
  ProjectMembershipAccess,
} from "@medplum/fhirtypes";
import { z } from "zod";
import type { MedplumClient } from "../fhir-client.js";
import {
  assertBusinessActionAllowed,
  staffHasBusinessAction,
  type BusinessAction,
  type PracticeRoleId,
} from "../authz/roles.js";

export interface ProviderAssignmentEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: Pick<MedplumClient, "read">;
  } | null>;
  serviceFhir: Pick<MedplumClient, "read" | "search" | "patch">;
}

export interface ProviderAssignmentEndpointResult {
  status: number;
  body: unknown;
}

const patientIdSchema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const appointmentIdSchema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const WRITE_HEADERS = { "X-ODOS-Source": "mcp/assign_provider" } as const;

type ProviderAssignmentEndpointInput = {
  authHeader: string | undefined;
} & (
  | { patientId: unknown; appointmentId?: never }
  | { patientId?: never; appointmentId: unknown }
);

type PatientCompartmentPolicyBinding = {
  policyReference: string;
  patientParameterNames: string[];
};

export async function handleProviderAssignmentRequest(
  deps: ProviderAssignmentEndpointDeps,
  input: ProviderAssignmentEndpointInput,
): Promise<ProviderAssignmentEndpointResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to assign a provider." } };
  }
  if (!staffHasBusinessAction(staff, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const target = await resolveAssignmentTarget(staff.fhir, input);
  if ("result" in target) return target.result;

  const practitionerReference = await resolvePractitionerReference(
    deps.serviceFhir,
    staff.staffReference,
  );
  if (!practitionerReference) {
    return {
      status: 409,
      body: { error: "The authenticated staff profile is not backed by a Practitioner." },
    };
  }

  const patientReference = `Patient/${target.patientId}`;
  const memberships = await deps.serviceFhir.search<ProjectMembership>("ProjectMembership", {
    profile: staff.staffReference,
  });
  const membership = memberships.entry?.[0]?.resource;
  const policyReferences = membershipPolicyReferences(membership);
  if (!membership?.id || policyReferences.length === 0) {
    return { status: 403, body: { error: "No assignable clinician membership was found." } };
  }
  const qualifyingPolicyBindings = await patientCompartmentPolicyBindings(
    deps.serviceFhir,
    policyReferences,
  );
  if (qualifyingPolicyBindings.length === 0) {
    return {
      status: 409,
      body: { error: "No referenced AccessPolicy consumes %patient_compartment." },
    };
  }

  const patient = target.patient ?? await deps.serviceFhir.read<Patient>("Patient", target.patientId);
  const patientAlreadyAssigned = patient.generalPractitioner?.some(
    (reference) => reference.reference === practitionerReference,
  ) ?? false;
  const missingPolicyBindings = qualifyingPolicyBindings.filter(
    (binding) => !hasPatientCompartmentGrantForPolicy(
      membership,
      patientReference,
      binding,
    ),
  );
  const membershipAlreadyGranted = missingPolicyBindings.length === 0;

  if (!patientAlreadyAssigned) {
    await deps.serviceFhir.patch<Patient>(
      "Patient",
      target.patientId,
      patient.generalPractitioner?.length
        ? [{ op: "add", path: "/generalPractitioner/-", value: { reference: practitionerReference } }]
        : [{ op: "add", path: "/generalPractitioner", value: [{ reference: practitionerReference }] }],
      versionHeaders(patient.meta?.versionId),
    );
  }

  if (!membershipAlreadyGranted) {
    const access = missingPolicyBindings.map((binding) =>
      patientAccessEntry(
        binding.policyReference,
        practitionerReference,
        patientReference,
        binding.patientParameterNames,
      )
    );
    await deps.serviceFhir.patch<ProjectMembership>(
      "ProjectMembership",
      membership.id,
      membership.access?.length
        ? access.map((value) => ({ op: "add" as const, path: "/access/-", value }))
        : [{ op: "add", path: "/access", value: access }],
      versionHeaders(membership.meta?.versionId),
    );
  }

  return {
    status: 200,
    body: {
      assigned: !patientAlreadyAssigned || !membershipAlreadyGranted,
      patientReference,
      practitionerReference,
      patientUpdated: !patientAlreadyAssigned,
      membershipUpdated: !membershipAlreadyGranted,
    },
  };
}

async function resolveAssignmentTarget(
  callerFhir: Pick<MedplumClient, "read">,
  input: ProviderAssignmentEndpointInput,
): Promise<
  | { patientId: string; patient?: Patient }
  | { result: ProviderAssignmentEndpointResult }
> {
  if ("appointmentId" in input) {
    const parsedAppointmentId = appointmentIdSchema.safeParse(input.appointmentId);
    if (!parsedAppointmentId.success) {
      return { result: { status: 400, body: { error: "A valid Appointment id is required." } } };
    }
    let appointment: Appointment;
    try {
      appointment = await callerFhir.read<Appointment>("Appointment", parsedAppointmentId.data);
    } catch (error) {
      const status = providerAssignmentErrorStatus(error);
      if (status === 403) {
        return {
          result: {
            status,
            body: { error: "You do not have permission to access this appointment." },
          },
        };
      }
      if (status === 404) {
        return { result: { status: 404, body: { error: "Appointment not found." } } };
      }
      throw error;
    }
    const patientId = appointment.participant
      .map((participant) => participant.actor?.reference?.match(/^Patient\/([A-Za-z0-9.-]{1,64})$/)?.[1])
      .find((id): id is string => Boolean(id));
    if (!patientId) {
      return {
        result: {
          status: 409,
          body: { error: "The Appointment does not identify an assignable Patient." },
        },
      };
    }
    return { patientId };
  }

  const parsedPatientId = patientIdSchema.safeParse(input.patientId);
  if (!parsedPatientId.success) {
    return { result: { status: 400, body: { error: "A valid Patient id is required." } } };
  }
  try {
    const patient = await callerFhir.read<Patient>("Patient", parsedPatientId.data);
    return { patientId: parsedPatientId.data, patient };
  } catch (error) {
    const status = providerAssignmentErrorStatus(error);
    if (status === 403) {
      return {
        result: {
          status,
          body: { error: "You do not have permission to access this patient." },
        },
      };
    }
    if (status === 404) {
      return { result: { status: 404, body: { error: "Patient not found." } } };
    }
    throw error;
  }
}

export function providerAssignmentErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

export function hasPatientCompartmentGrant(
  membership: ProjectMembership,
  patientReference: string,
): boolean {
  return membership.access?.some((access) =>
    access.parameter?.some(
      (parameter) =>
        (parameter.name === "patient_compartment"
          || parameter.name.endsWith("_patient_compartment")) &&
        parameter.valueString === patientReference,
    ),
  ) ?? false;
}

export function patientAccessEntry(
  policyReference: string,
  practitionerReference: string,
  patientReference: string,
  patientParameterNames: readonly string[] = ["patient_compartment"],
): ProjectMembershipAccess {
  // Medplum 5.1.8 substitutes one value per parameter name, so each patient needs a
  // complete access[] policy instance instead of repeated patient_compartment parameters.
  return {
    policy: { reference: policyReference },
    parameter: patientParameterNames.flatMap((patientParameterName) => {
      const prefix = patientParameterName.slice(0, -"patient_compartment".length);
      return [
        {
          name: `${prefix}provider_profile`,
          valueReference: { reference: practitionerReference },
        },
        {
          name: patientParameterName,
          valueString: patientReference,
        },
      ];
    }),
  };
}


function membershipPolicyReferences(membership: ProjectMembership | undefined): string[] {
  const references = [
    ...(membership?.access?.map((access) => access.policy?.reference) ?? []),
    membership?.accessPolicy?.reference,
  ];
  return [...new Set(references.filter(
    (reference): reference is string => /^AccessPolicy\/[A-Za-z0-9.-]{1,64}$/.test(reference ?? ""),
  ))];
}

async function patientCompartmentPolicyBindings(
  fhir: Pick<MedplumClient, "read">,
  policyReferences: string[],
): Promise<PatientCompartmentPolicyBinding[]> {
  const policies = await Promise.all(policyReferences.map((reference) =>
    fhir.read<AccessPolicy>("AccessPolicy", reference.slice("AccessPolicy/".length))
  ));
  return policyReferences.flatMap((policyReference, index) => {
    const parameterNames = new Set<string>();
    for (const rule of policies[index]?.resource ?? []) {
      const expressions = [
        rule.criteria,
        ...((rule.writeConstraint ?? []).map((constraint) => constraint.expression)),
      ];
      for (const expression of expressions) {
        for (const match of expression?.matchAll(
          /%((?:(?:admin|provider|staff)_)?patient_compartment)(?![A-Za-z0-9_])/g,
        ) ?? []) {
          parameterNames.add(match[1]!);
        }
      }
    }
    return parameterNames.size > 0
      ? [{ policyReference, patientParameterNames: [...parameterNames] }]
      : [];
  });
}

function hasPatientCompartmentGrantForPolicy(
  membership: ProjectMembership,
  patientReference: string,
  binding: PatientCompartmentPolicyBinding,
): boolean {
  return membership.access?.some((access) =>
    access.policy?.reference === binding.policyReference &&
    binding.patientParameterNames.every((parameterName) => access.parameter?.some(
      (parameter) => parameter.name === parameterName && parameter.valueString === patientReference,
    ))
  ) ?? false;
}

function versionHeaders(versionId: string | undefined): Record<string, string> {
  return {
    ...WRITE_HEADERS,
    ...(versionId ? { "If-Match": `W/"${versionId}"` } : {}),
  };
}

function staffMay(role: PracticeRoleId, action: BusinessAction): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
