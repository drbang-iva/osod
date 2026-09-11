import type {
  AccessPolicy,
  AccessPolicyResource,
  ProjectMembershipAccess,
} from "@medplum/fhirtypes";
import { OBSERVATION_STATUS_WRITE_CONSTRAINT_EXPRESSION } from "../../../policy/observation-status-machine.js";

export const FHIR_INTERACTIONS = [
  "create",
  "read",
  "update",
  "delete",
  "search",
  "history",
  "vread",
] as const;

export type FhirInteraction = (typeof FHIR_INTERACTIONS)[number];

export const PRACTICE_ROLE_IDS = [
  "provider",
  "staff",
  "admin",
] as const;

export type PracticeRoleId = (typeof PRACTICE_ROLE_IDS)[number];

export const BUSINESS_ACTIONS = [
  "identity.manage",
  "role.review",
  "chart.read",
  "chart.write",
  "patients.register",
  "clinical.sign",
  "scheduling.manage",
  "demographics.update",
  "billing-context.read",
  "watchers.manage",
  "audit.read",
  "aesthetics.procedure.write",
  "break-glass.invoke",
  "payment.charge",
  "payment.void",
  // Declared ahead of a dedicated enforcement point; no write-off route or policy rule exists yet.
  "payment.write-off",
  "payment.seal-day",
  "margin.read",
  "inventory.adjust",
  "inventory.price",
  "claims.manage",
  "finding-definitions.write",
  "protocols.author",
  "document.fax-send",
  "communications.read",
  "communications.content.read",
  "communications.send",
  "communications.call",
  "communications.optout.manage",
  "communications.preferences.manage",
  "patient.inactivate",
  "patient.merge",
] as const;

export type BusinessAction = (typeof BUSINESS_ACTIONS)[number];

export const BASELINE_BUSINESS_ACTIONS = [
  "chart.read",
  "patients.register",
  "billing-context.read",
  "document.fax-send",
  "communications.read",
  "communications.content.read",
  "communications.send",
  "communications.call",
] as const satisfies readonly BusinessAction[];

export const CREDENTIAL_BOUND_BUSINESS_ACTIONS = [
  "clinical.sign",
  "aesthetics.procedure.write",
  "break-glass.invoke",
  "protocols.author",
] as const satisfies readonly BusinessAction[];

export const OWNER_ONLY_BUSINESS_ACTIONS = [
  "identity.manage",
] as const satisfies readonly BusinessAction[];

export const GRANTABLE_BUSINESS_ACTIONS: readonly BusinessAction[] = BUSINESS_ACTIONS.filter(
  (action) =>
    !BASELINE_BUSINESS_ACTIONS.includes(action as (typeof BASELINE_BUSINESS_ACTIONS)[number]) &&
    !CREDENTIAL_BOUND_BUSINESS_ACTIONS.includes(action as (typeof CREDENTIAL_BOUND_BUSINESS_ACTIONS)[number]) &&
    !OWNER_ONLY_BUSINESS_ACTIONS.includes(action as (typeof OWNER_ONLY_BUSINESS_ACTIONS)[number]),
);

export interface EffectiveBusinessActionResult {
  actions: BusinessAction[];
  ignoredGranted: BusinessAction[];
  ignoredRevoked: BusinessAction[];
  malformed: boolean;
}

const EFFECTIVE_BUSINESS_ACTIONS_BY_ROLE_SET = new WeakMap<object, readonly BusinessAction[]>();

export type BusinessActionClass = "baseline" | "credential-bound" | "owner-only" | "grantable";

export function businessActionClass(action: BusinessAction): BusinessActionClass {
  if (BASELINE_BUSINESS_ACTIONS.includes(action as (typeof BASELINE_BUSINESS_ACTIONS)[number])) {
    return "baseline";
  }
  if (CREDENTIAL_BOUND_BUSINESS_ACTIONS.includes(
    action as (typeof CREDENTIAL_BOUND_BUSINESS_ACTIONS)[number],
  )) {
    return "credential-bound";
  }
  if (OWNER_ONLY_BUSINESS_ACTIONS.includes(action as (typeof OWNER_ONLY_BUSINESS_ACTIONS)[number])) {
    return "owner-only";
  }
  return "grantable";
}

export interface OdosRoleDeclaration {
  id: PracticeRoleId;
  display: string;
  description: string;
  businessActions: BusinessAction[];
  resourceRules: OdosResourceRule[];
  membershipParameters?: MembershipParameterDeclaration[];
}

export interface OdosResourceRule {
  resourceType: string;
  interactions: FhirInteraction[];
  scope: ResourceScope;
  readonlyFields?: string[];
  hiddenFields?: string[];
  writeConstraint?: WriteConstraintDeclaration[];
}

export type ResourceScope =
  | { kind: "practice" }
  | { kind: "patient-compartment"; parameterName: "patient_compartment" }
  | { kind: "provider-assigned-patient"; parameterName: "provider_profile" }
  | { kind: "self-profile"; parameterName: "provider_profile" }
  | { kind: "audit-only" }
  /** Criteria narrowed to the current Medplum ProjectMembership profile through %profile. */
  | { kind: "profile-search"; criteria: string }
  /** Practice-wide but fenced to a fixed search criteria (e.g. one coded singleton). */
  | { kind: "practice-search"; criteria: string };

export interface WriteConstraintDeclaration {
  description: string;
  expression: string;
}

export interface MembershipParameterDeclaration {
  name: "provider_profile" | "patient_compartment" | "license_state" | "procedure_scope";
  kind: "reference" | "string";
  description: string;
}

export interface RoleAccessParameterValues {
  providerProfileReference?: string;
  patientCompartmentReference?: string;
  licenseState?: string;
  procedureScope?: string;
}

export interface AestheticsProviderScopeInput {
  roleId: PracticeRoleId;
  licensedStates: string[];
  requestedState: string;
  procedureType?: string;
  allowedProcedureTypesByState?: Record<string, string[]>;
}

const READ_INTERACTIONS: FhirInteraction[] = ["read", "search", "history", "vread"];
const CREATE_UPDATE_INTERACTIONS: FhirInteraction[] = ["create", "update"];
const CREATE_ONLY_INTERACTIONS: FhirInteraction[] = ["create"];
const UPDATE_ONLY_INTERACTIONS: FhirInteraction[] = ["update"];

const PRACTICE_READ_RESOURCE_TYPES = [
  "Patient",
  "RelatedPerson",
  "Coverage",
  "Account",
  "AllergyIntolerance",
  "Encounter",
  "Observation",
  "Condition",
  "Procedure",
  "DiagnosticReport",
  "DocumentReference",
  "Media",
  "Device",
  "DeviceRequest",
  "MedicationAdministration",
  "MedicationRequest",
  "MedicationStatement",
  "EpisodeOfCare",
  "CarePlan",
  "Goal",
  "PlanDefinition",
  "ChargeItem",
  "ChargeItemDefinition",
  "QuestionnaireResponse",
  "Provenance",
  "Binary",
  "ServiceRequest",
  "Appointment",
  "Schedule",
  "Slot",
  "HealthcareService",
  "DeviceDefinition",
  "PaymentReconciliation",
  "Task",
  "Invoice",
  "Claim",
  "ClaimResponse",
  "CoverageEligibilityRequest",
  "CoverageEligibilityResponse",
  "Organization",
  "Practitioner",
  "PractitionerRole",
  "Communication",
  "BodyStructure",
  "CareTeam",
  "DeviceUseStatement",
  "VisionPrescription",
] as const;

const PRACTICE_READ_RESOURCE_RULES: OdosResourceRule[] = PRACTICE_READ_RESOURCE_TYPES.map(
  (resourceType) => ({ resourceType, interactions: READ_INTERACTIONS, scope: { kind: "practice" } }),
);

// Like the Provider constraint, this relies on the Undo endpoint for the unsigned gate.
const STAFF_OBSERVATION_WRITE_CONSTRAINTS: WriteConstraintDeclaration[] = [
  {
    description: "Staff and scribe findings remain preliminary until a Provider attests them.",
    expression:
      "(%before.exists().not() implies status = 'preliminary') and (%before.exists() implies ((%before.status = 'preliminary' and (status = 'preliminary' or status = 'entered-in-error')) or (%before.status = 'entered-in-error' and status = 'preliminary' and ($this is Observation))))",
  },
];

const STAFF_ENCOUNTER_WRITE_CONSTRAINTS: WriteConstraintDeclaration[] = [
  {
    description: "Staff can create or edit an Encounter only while it remains unfinished.",
    expression: "status != 'finished' and (%before.exists() implies %before.status != 'finished')",
  },
];

const STAFF_MEDICATION_REQUEST_WRITE_CONSTRAINTS: WriteConstraintDeclaration[] = [
  {
    description: "Staff cannot update an electronically transmitted prescription.",
    expression:
      "%before.extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/odos-transmission-method' and value = 'electronically-sent').empty()",
  },
  {
    description: "Staff cannot change the prescription requester after creation.",
    expression: [
      "requester.exists() = %before.requester.exists()",
      "and (requester.empty() or requester = %before.requester)",
    ].join(" "),
  },
  {
    description: "Staff cannot change the prescription recorder after creation.",
    expression: [
      "recorder.exists() = %before.recorder.exists()",
      "and (recorder.empty() or recorder = %before.recorder)",
    ].join(" "),
  },
];

const FRAME_INVENTORY_STATUS_URL =
  "https://odos2020.com/fhir/StructureDefinition/unit-status";
const FRAME_INVENTORY_STAFF_WRITE_CONSTRAINTS: WriteConstraintDeclaration[] = [
  {
    description:
      "Staff receipts create on-hand units; later writes preserve inventory identity and received-at provenance.",
    expression: [
      "(%before.exists().not() implies extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/unit-status').value = 'on_hand')",
      "and (%before.exists() implies code ~ %before.code)",
      "and (%before.exists() implies identifier ~ %before.identifier)",
      "and (%before.exists() implies extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/catalog-canonical-url').value = %before.extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/catalog-canonical-url').value)",
      "and (%before.exists() implies extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/received-at').value = %before.extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/received-at').value)",
      "and (%before.exists() implies extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/dispensary-location').value = %before.extension.where(url = 'https://odos2020.com/fhir/StructureDefinition/dispensary-location').value)",
    ].join(" "),
  },
  {
    description: "Staff can advance inventory workflow status but cannot reverse or arbitrarily adjust it.",
    expression: [
      "(%before.exists().not())",
      `or (%before.extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value)`,
      `or (%before.extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = 'on_hand' and extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value in ('reserved' | 'hold' | 'dispensed'))`,
      `or (%before.extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = 'reserved' and extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value in ('outbound' | 'at_lab' | 'dispensed'))`,
      `or (%before.extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = 'outbound' and extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value in ('at_lab' | 'inbound' | 'dispensed'))`,
      `or (%before.extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = 'at_lab' and extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value in ('inbound' | 'dispensed'))`,
      `or (%before.extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = 'inbound' and extension.where(url = '${FRAME_INVENTORY_STATUS_URL}').value = 'dispensed')`,
    ].join(" "),
  },
];

/**
 * Dispensary catalog, inventory, order + financial resources granted to front-desk at practice
 * scope (v0.6c payments authorization model, decision 2026-07-05 §2). Practice-scope not
 * patient-compartment: the dispensary is a walk-up counter, and PaymentReconciliation is not a
 * Patient-compartment resource. Frame inventory is code-fenced from every other Basic resource.
 * PaymentReconciliation stays create/read-only for staff; Phase 6a mutations cross the guarded
 * odos-core lifecycle handlers. Task/Invoice also need update (status advance / manual cash).
 */
const DISPENSARY_READ_RESOURCE_RULES: OdosResourceRule[] = [
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory-unit",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-variant-settings",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/day-seal|day-seal",
    },
  },
];

const STAFF_DISPENSARY_WRITE_RESOURCE_RULES: OdosResourceRule[] = [
  {
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory-unit",
    },
    writeConstraint: FRAME_INVENTORY_STAFF_WRITE_CONSTRAINTS,
  },
  { resourceType: "DeviceRequest", interactions: CREATE_ONLY_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "ChargeItem", interactions: CREATE_ONLY_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "PaymentReconciliation", interactions: CREATE_ONLY_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "Task", interactions: CREATE_UPDATE_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "Invoice", interactions: CREATE_UPDATE_INTERACTIONS, scope: { kind: "practice" } },
];

const PAYMENT_CUSTODY_RESOURCE_RULES: OdosResourceRule[] = [
  { resourceType: "PaymentReconciliation", interactions: CREATE_ONLY_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "Invoice", interactions: UPDATE_ONLY_INTERACTIONS, scope: { kind: "practice" } },
];

const ADMIN_CORRECTION_RESOURCE_RULES: OdosResourceRule[] = [
  {
    resourceType: "HealthcareService",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: { kind: "practice" },
  },
  {
    resourceType: "ChargeItemDefinition",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: { kind: "practice" },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/visit-type-config|odos-visit-type-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: UPDATE_ONLY_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-inventory-unit",
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/basic-kind|practice-frame-variant-settings",
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_ONLY_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/day-seal|day-seal",
    },
  },
  { resourceType: "Invoice", interactions: UPDATE_ONLY_INTERACTIONS, scope: { kind: "practice" } },
];

const CLAIMS_RESOURCE_RULES: OdosResourceRule[] = [
  { resourceType: "Claim", interactions: CREATE_UPDATE_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "ClaimResponse", interactions: CREATE_UPDATE_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "CoverageEligibilityRequest", interactions: CREATE_ONLY_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "CoverageEligibilityResponse", interactions: CREATE_ONLY_INTERACTIONS, scope: { kind: "practice" } },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-era-import|odos-era-import",
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-era-import|odos-era-import",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-manual-eob|odos-manual-eob",
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-manual-eob|odos-manual-eob",
    },
  },
];

const PAYER_DIRECTORY_RESOURCE_RULES: OdosResourceRule[] = [
  { resourceType: "Organization", interactions: CREATE_ONLY_INTERACTIONS, scope: { kind: "practice" } },
];

const BILLING_IDENTITY_CONFIG_READ_RULE: OdosResourceRule = {
  resourceType: "Basic",
  interactions: READ_INTERACTIONS,
  scope: {
    kind: "practice-search",
    criteria:
      "Basic?code=https://odos2020.com/fhir/CodeSystem/billing-identity-config|odos-billing-identity-config",
  },
};

const BILLING_IDENTITY_CONFIG_WRITE_RULE: OdosResourceRule = {
  resourceType: "Basic",
  interactions: CREATE_UPDATE_INTERACTIONS,
  scope: {
    kind: "practice-search",
    criteria:
      "Basic?code=https://odos2020.com/fhir/CodeSystem/billing-identity-config|odos-billing-identity-config",
  },
};

const DIAGNOSIS_PICK_TALLY_CRITERIA =
  "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-dx-pick-tally|odos-dx-pick-tally&identifier=https://odos2020.com/fhir/NamingSystem/dx-pick-tally-practitioner|%profile";
const DIAGNOSIS_PICK_TALLY_READ_RULE: OdosResourceRule = {
  resourceType: "Basic",
  interactions: READ_INTERACTIONS,
  scope: { kind: "profile-search", criteria: DIAGNOSIS_PICK_TALLY_CRITERIA },
};
const DIAGNOSIS_PICK_TALLY_WRITE_RULE: OdosResourceRule = {
  resourceType: "Basic",
  interactions: CREATE_UPDATE_INTERACTIONS,
  scope: { kind: "profile-search", criteria: DIAGNOSIS_PICK_TALLY_CRITERIA },
};

const CHART_BASIC_RESOURCE_RULES = [
  "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-encounter-complaint|odos-encounter-complaint",
  "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-finding-section-group|odos-encounter-section-override",
  // The per-encounter Undo ledger, written by every clear in the void's own transaction and read
  // back by the strip. Anyone who may clear (Provider, Staff) must be able to write the slot.
  // Missing until 2026-09-02: the ledger POST was refused 403 on every clear and no row ever
  // existed. Guarded by encounterUndoLedgerAuthzLive.test.ts on real Medplum, not by a list check.
  "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-encounter-undo-ledger|odos-encounter-undo-ledger",
].flatMap((criteria): OdosResourceRule[] => [
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: { kind: "practice-search", criteria },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: { kind: "practice-search", criteria },
  },
]);

const FINDING_CONFIGURATION_BASIC_CRITERIA = [
  "Basic?code=https://odos2020.com/fhir/CodeSystem/osod-complaint-definition|osod-complaint-definition",
  "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-finding-definition|odos-finding-definition",
  "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-finding-section-group|odos-finding-section-group",
  "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-diagnosis-definition|odos-diagnosis-definition",
  "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-procedure-definition|odos-procedure-definition",
] as const;

const FINDING_CONFIGURATION_BASIC_READ_RESOURCE_RULES =
  FINDING_CONFIGURATION_BASIC_CRITERIA.map((criteria): OdosResourceRule => ({
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: { kind: "practice-search", criteria },
  }));

const FINDING_CONFIGURATION_BASIC_WRITE_RESOURCE_RULES =
  FINDING_CONFIGURATION_BASIC_CRITERIA.map((criteria): OdosResourceRule => ({
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: { kind: "practice-search", criteria },
  }));

const PROCEDURE_CHARGE_RULE_BASIC_RESOURCE_RULES = [
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-procedure-charge-rule",
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-procedure-charge-rule",
    },
  },
] satisfies OdosResourceRule[];

const OFFICE_CHANNEL_RESOURCE_RULES: OdosResourceRule[] = [
  { resourceType: "Practitioner", interactions: READ_INTERACTIONS, scope: { kind: "practice" } },
  { resourceType: "PractitionerRole", interactions: READ_INTERACTIONS, scope: { kind: "practice" } },
  {
    resourceType: "Communication",
    interactions: CREATE_ONLY_INTERACTIONS,
    scope: { kind: "practice-search", criteria: "Communication?category=https://odos2020.com/fhir/CodeSystem/communication-category|internal-office" },
  },
  {
    resourceType: "Provenance",
    interactions: CREATE_ONLY_INTERACTIONS,
    scope: { kind: "practice-search", criteria: "Provenance?_tag=https://odos2020.com/fhir/CodeSystem/office-message-kind|acknowledgement" },
  },
];

const COMMS_CONSENT_IMMUTABLE_FIELDS = [
  "id", "implicitRules", "language", "text", "contained", "extension", "modifierExtension",
  "identifier", "scope", "category", "patient", "dateTime", "performer", "organization",
  "sourceAttachment", "sourceReference", "policy", "policyRule", "verification", "provision",
  "meta.id", "meta.extension", "meta.source", "meta.profile", "meta.security", "meta.tag",
];

const PATIENT_COMMS_CONSENT_RULE: OdosResourceRule = {
  resourceType: "Consent",
  interactions: ["create", "read", "search", "update"],
  scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  writeConstraint: [{
    description: "Recorded consent evidence is immutable except for status; server-managed metadata may advance.",
    expression: `%before.exists() implies (${COMMS_CONSENT_IMMUTABLE_FIELDS.map(
      (field) => `(${field}.exists() = %before.${field}.exists() and (${field}.empty() or ${field} = %before.${field}))`,
    ).join(" and ")})`,
  }],
};

const PATIENT_COMMUNICATION_COMPARTMENT_RULE: OdosResourceRule = {
  resourceType: "Communication",
  interactions: CREATE_UPDATE_INTERACTIONS,
  scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
};

const FRONT_DESK_PATIENT_COMMUNICATION_RULE: OdosResourceRule = {
  resourceType: "Communication",
  interactions: CREATE_UPDATE_INTERACTIONS,
  scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
};

const CLINICAL_WRITE_CONSTRAINTS: WriteConstraintDeclaration[] = [
  {
    description:
      "Signed clinical resources cannot be downgraded out of final/amended/corrected state by ordinary RBAC writes.",
    expression:
      "%before.exists() implies (%before.status != 'final' or status = 'final' or status = 'amended' or status = 'corrected' or status = 'entered-in-error')",
  },
  {
    description:
      "Observation.status must follow the v0.5c scribe-attestation-amendment state machine.",
    expression: OBSERVATION_STATUS_WRITE_CONSTRAINT_EXPRESSION,
  },
];

const PATIENT_COMPARTMENT_CLINICAL_RESOURCES = [
  "Encounter",
  "Observation",
  "Condition",
  "Procedure",
  "DiagnosticReport",
  "DocumentReference",
  "Media",
  "Device",
  "DeviceRequest",
  "MedicationAdministration",
  "MedicationStatement",
  "EpisodeOfCare",
  "CarePlan",
  "ChargeItem",
  "QuestionnaireResponse",
] as const;

const STAFF_DEMOGRAPHIC_RESOURCES = [
  "Patient",
  "RelatedPerson",
  "Coverage",
  "Account",
] as const;

const STAFF_FINDING_RESOURCES = [
  "Observation",
  "DiagnosticReport",
  "DocumentReference",
  "Media",
  "QuestionnaireResponse",
  "MedicationAdministration",
  "MedicationStatement",
] as const;

const STAFF_DEMOGRAPHIC_WRITE_RESOURCE_RULES: OdosResourceRule[] =
  STAFF_DEMOGRAPHIC_RESOURCES.map((resourceType): OdosResourceRule => ({
    resourceType,
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  }));

const STAFF_ENCOUNTER_WRITE_RESOURCE_RULE: OdosResourceRule = {
  resourceType: "Encounter",
  interactions: CREATE_UPDATE_INTERACTIONS,
  scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  writeConstraint: STAFF_ENCOUNTER_WRITE_CONSTRAINTS,
};

const STAFF_FINDING_WRITE_RESOURCE_RULES: OdosResourceRule[] =
  STAFF_FINDING_RESOURCES.map((resourceType): OdosResourceRule => ({
    resourceType,
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
    writeConstraint:
      resourceType === "Observation" || resourceType === "DiagnosticReport"
        ? STAFF_OBSERVATION_WRITE_CONSTRAINTS
        : undefined,
  }));

const STAFF_PATIENT_WRITE_RESOURCE_RULES: OdosResourceRule[] = [
  ...STAFF_DEMOGRAPHIC_WRITE_RESOURCE_RULES,
  STAFF_ENCOUNTER_WRITE_RESOURCE_RULE,
  ...STAFF_FINDING_WRITE_RESOURCE_RULES,
  {
    resourceType: "AllergyIntolerance",
    interactions: CREATE_ONLY_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  },
  {
    resourceType: "CareTeam",
    interactions: CREATE_ONLY_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  },
  {
    resourceType: "MedicationRequest",
    interactions: CREATE_ONLY_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  },
  {
    resourceType: "MedicationRequest",
    interactions: UPDATE_ONLY_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
    writeConstraint: STAFF_MEDICATION_REQUEST_WRITE_CONSTRAINTS,
  },
  {
    resourceType: "Provenance",
    interactions: ["create"],
    scope: { kind: "practice" },
  },
];

const PROVIDER_CLINICAL_WRITE_RESOURCE_RULES: OdosResourceRule[] = [
  ...PATIENT_COMPARTMENT_CLINICAL_RESOURCES.map((resourceType): OdosResourceRule => ({
    resourceType,
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
    writeConstraint:
      resourceType === "Observation" || resourceType === "DiagnosticReport"
        ? CLINICAL_WRITE_CONSTRAINTS
        : undefined,
  })),
  ...(["AllergyIntolerance", "CareTeam", "BodyStructure", "AdverseEvent"] as const).map(
    (resourceType): OdosResourceRule => ({
      resourceType,
      interactions: CREATE_ONLY_INTERACTIONS,
      scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
    }),
  ),
  {
    resourceType: "Goal",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  },
  {
    resourceType: "MedicationRequest",
    interactions: CREATE_ONLY_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  },
  {
    resourceType: "MedicationRequest",
    interactions: UPDATE_ONLY_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  },
  {
    resourceType: "Provenance",
    interactions: ["create"],
    scope: { kind: "practice" },
  },
];

const STAFF_CORRESPONDENCE_RESOURCE_RULES: OdosResourceRule[] = [
  {
    resourceType: "ServiceRequest",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  },
  {
    resourceType: "DocumentReference",
    interactions: CREATE_ONLY_INTERACTIONS,
    scope: { kind: "patient-compartment", parameterName: "patient_compartment" },
  },
];

/**
 * Scheduler resources granted to front-desk at practice scope (scheduler Phase 3a, parallel to
 * PRs #24-#26). Practice-scope not patient-compartment: the day grid reads ALL resources'
 * Schedules, the whole visit-type catalog, and every patient's appointments for the day, and
 * booking writes Appointments for arbitrary patients — Schedule/Slot/HealthcareService are not
 * Patient-compartment resources at all, so a compartment criteria matches nothing. Mirrors the
 * v0.6c dispensary practice-scope precedent (decision 2026-07-05 §2). Schedule and Slot stay
 * direct-policy read-only: Schedule writes use the Admin-gated service route, while Slots are
 * generated in memory. HealthcareService writes use Admin's explicit practice-scoped correction
 * rule. No scheduling resource gets delete; cancellation and deactivation are state changes.
 */
const SCHEDULING_RESOURCE_RULES: OdosResourceRule[] = [
  { resourceType: "Appointment", interactions: CREATE_UPDATE_INTERACTIONS, scope: { kind: "practice" } },
  // Phase 4a: the practice scheduling-config singleton (hours/templates/blocked time/offices).
  // Criteria-fenced so the desk touches exactly one coded Basic — never Basic at large.
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/scheduling-config|odos-scheduling-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/scheduling-config|odos-scheduling-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/floor-config|odos-floor-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/floor-config|odos-floor-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/insurance-config|odos-insurance-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/insurance-config|odos-insurance-config",
    },
  },
  // Visit-type categories singleton: READ-only for the desk. The settings read-only
  // contract requires the categories section to render for front-desk while write
  // stays practice-admin-only (settings-catalog RBAC review, 2026-07-10).
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/visit-type-config|odos-visit-type-config",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/statement-message-config|odos-statement-message-config",
    },
  },
];

const APPEARANCE_CONFIG_READ_RULE: OdosResourceRule = {
  resourceType: "Basic",
  interactions: READ_INTERACTIONS,
  scope: {
    kind: "practice-search",
    criteria:
      "Basic?code=https://odos2020.com/fhir/CodeSystem/appearance-config|odos-appearance-config",
  },
};

const PROTOCOL_RUNTIME_RESOURCE_RULES = [
  "odos-plan-action-instance",
  "odos-protocol-application",
  "odos-charge-proposal",
  "odos-finding-instance",
].flatMap((code): OdosResourceRule[] => [
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: `Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|${code}`,
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria: `Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|${code}`,
    },
  },
]);

const PROTOCOL_MODULE_RESOURCE_RULES: OdosResourceRule[] = [
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-protocol-definition",
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_UPDATE_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-protocol-definition",
    },
  },
  {
    resourceType: "Basic",
    interactions: READ_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-protocol-definition-snapshot",
    },
  },
  {
    resourceType: "Basic",
    interactions: CREATE_ONLY_INTERACTIONS,
    scope: {
      kind: "practice-search",
      criteria:
        "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-protocol-definition-snapshot",
    },
  },
  ...PROTOCOL_RUNTIME_RESOURCE_RULES,
];

export const ROLE_REGISTRY: Record<PracticeRoleId, OdosRoleDeclaration> = {
  provider: {
    id: "provider",
    display: "Provider",
    description:
      "Clinical author and signer with practice-wide reads and patient-compartment-constrained writes.",
    businessActions: [
      "chart.read",
      "chart.write",
      "patients.register",
      "clinical.sign",
      "billing-context.read",
      "aesthetics.procedure.write",
      "break-glass.invoke",
      "payment.charge",
      "protocols.author",
      "document.fax-send",
      "communications.read",
      "communications.content.read",
      "communications.send",
      "communications.call",
      "communications.preferences.manage",
    ],
    membershipParameters: [
      {
        name: "provider_profile",
        kind: "reference",
        description: "Practitioner profile retained for write/action gates and attribution.",
      },
      {
        name: "patient_compartment",
        kind: "string",
        description: "Patient/<id> compartment reference granted for clinical writes.",
      },
      {
        name: "license_state",
        kind: "string",
        description: "US state where the provider credential is active for an aesthetics procedure.",
      },
      {
        name: "procedure_scope",
        kind: "string",
        description: "Practice-local aesthetics procedure category allowed under the state credential.",
      },
    ],
    resourceRules: [
      ...PRACTICE_READ_RESOURCE_RULES,
      ...PROVIDER_CLINICAL_WRITE_RESOURCE_RULES,
      ...STAFF_CORRESPONDENCE_RESOURCE_RULES,
      ...PAYMENT_CUSTODY_RESOURCE_RULES,
      BILLING_IDENTITY_CONFIG_READ_RULE,
      DIAGNOSIS_PICK_TALLY_READ_RULE,
      DIAGNOSIS_PICK_TALLY_WRITE_RULE,
      ...CHART_BASIC_RESOURCE_RULES,
      ...FINDING_CONFIGURATION_BASIC_READ_RESOURCE_RULES,
      ...OFFICE_CHANNEL_RESOURCE_RULES,
      PATIENT_COMMUNICATION_COMPARTMENT_RULE,
      PATIENT_COMMS_CONSENT_RULE,
      ...PROTOCOL_MODULE_RESOURCE_RULES,
      ...PROCEDURE_CHARGE_RULE_BASIC_RESOURCE_RULES,
      APPEARANCE_CONFIG_READ_RULE,
    ],
  },
  staff: {
    id: "staff",
    display: "Staff",
    description:
      "Routine desk, technician, optician, and billing work with preliminary finding entry but no authorship or signature.",
    businessActions: [
      "chart.read",
      "chart.write",
      "patients.register",
      "scheduling.manage",
      "demographics.update",
      "billing-context.read",
      "watchers.manage",
      "payment.charge",
      "claims.manage",
      "document.fax-send",
      "communications.read",
      "communications.content.read",
      "communications.send",
      "communications.call",
      "communications.preferences.manage",
      "communications.optout.manage",
    ],
    membershipParameters: [
      {
        name: "patient_compartment",
        kind: "string",
        description: "Patient/<id> compartment reference granted for routine writes.",
      },
    ],
    resourceRules: [
      ...PRACTICE_READ_RESOURCE_RULES,
      ...DISPENSARY_READ_RESOURCE_RULES,
      ...STAFF_PATIENT_WRITE_RESOURCE_RULES,
      ...STAFF_CORRESPONDENCE_RESOURCE_RULES,
      ...SCHEDULING_RESOURCE_RULES,
      APPEARANCE_CONFIG_READ_RULE,
      ...STAFF_DISPENSARY_WRITE_RESOURCE_RULES,
      ...CLAIMS_RESOURCE_RULES,
      ...PAYER_DIRECTORY_RESOURCE_RULES,
      BILLING_IDENTITY_CONFIG_READ_RULE,
      DIAGNOSIS_PICK_TALLY_READ_RULE,
      DIAGNOSIS_PICK_TALLY_WRITE_RULE,
      ...CHART_BASIC_RESOURCE_RULES,
      ...FINDING_CONFIGURATION_BASIC_READ_RESOURCE_RULES,
      ...PROTOCOL_RUNTIME_RESOURCE_RULES,
      ...OFFICE_CHANNEL_RESOURCE_RULES,
      FRONT_DESK_PATIENT_COMMUNICATION_RULE,
      PATIENT_COMMS_CONSENT_RULE,
    ],
  },
  admin: {
    id: "admin",
    display: "Admin / Manager",
    description:
      "Non-clinical administrative and correction authority for identities, settings, audit, money, and inventory.",
    businessActions: [
      "identity.manage",
      "role.review",
      "chart.read",
      "patients.register",
      "scheduling.manage",
      "billing-context.read",
      "watchers.manage",
      "audit.read",
      "payment.void",
      "payment.write-off",
      "payment.seal-day",
      "margin.read",
      "inventory.adjust",
      "inventory.price",
      "claims.manage",
      "finding-definitions.write",
      "document.fax-send",
      "communications.read",
      "communications.content.read",
      "communications.send",
      "communications.call",
      "communications.preferences.manage",
    ],
    resourceRules: [
      ...PRACTICE_READ_RESOURCE_RULES,
      ...DISPENSARY_READ_RESOURCE_RULES,
      { resourceType: "AccessPolicy", interactions: READ_INTERACTIONS, scope: { kind: "practice" } },
      { resourceType: "AuditEvent", interactions: READ_INTERACTIONS, scope: { kind: "audit-only" } },
      ...SCHEDULING_RESOURCE_RULES,
      ...ADMIN_CORRECTION_RESOURCE_RULES,
      ...CLAIMS_RESOURCE_RULES,
      ...PAYER_DIRECTORY_RESOURCE_RULES,
      BILLING_IDENTITY_CONFIG_READ_RULE,
      BILLING_IDENTITY_CONFIG_WRITE_RULE,
      DIAGNOSIS_PICK_TALLY_READ_RULE,
      ...FINDING_CONFIGURATION_BASIC_READ_RESOURCE_RULES,
      ...FINDING_CONFIGURATION_BASIC_WRITE_RESOURCE_RULES,
      ...OFFICE_CHANNEL_RESOURCE_RULES,
      ...PROTOCOL_MODULE_RESOURCE_RULES,
      ...PROCEDURE_CHARGE_RULE_BASIC_RESOURCE_RULES,
      PATIENT_COMMUNICATION_COMPARTMENT_RULE,
      PATIENT_COMMS_CONSENT_RULE,
      APPEARANCE_CONFIG_READ_RULE,
    ],
  },
};

export function getRoleDeclaration(roleId: PracticeRoleId): OdosRoleDeclaration {
  return ROLE_REGISTRY[roleId];
}

export const ODOS_PRACTICE_ROLE_SYSTEM = "https://odos2020.com/fhir/NamingSystem/practice-role";

const COMPOSITE_ROLE_PRECEDENCE = ["admin", "provider", "staff"] as const satisfies readonly PracticeRoleId[];
const COMPOSITE_PARAMETER_NAMES = new Set([
  "provider_profile",
  "patient_compartment",
  "license_state",
  "procedure_scope",
]);

export function compositeRoleParameterName(roleId: PracticeRoleId, parameterName: string): string {
  return `${roleId}_${parameterName}`;
}

export function buildMedplumAccessPolicy(role: OdosRoleDeclaration): AccessPolicy {
  return {
    resourceType: "AccessPolicy",
    name: `ODOS ${role.display}`,
    // Machine-readable role↔policy link so the payment endpoint can derive a caller's role from
    // their bound AccessPolicy (decision 2026-07-05 §3) rather than a spoofable client header.
    // Carried on meta.tag — Medplum's AccessPolicy resource has no identifier element.
    meta: { tag: [{ system: ODOS_PRACTICE_ROLE_SYSTEM, code: role.id }] },
    resource: role.resourceRules.map(toMedplumResourceRule),
  };
}

export function buildMedplumCompositeAccessPolicy(
  roleIds: readonly PracticeRoleId[],
): AccessPolicy {
  const roles = PRACTICE_ROLE_IDS.filter((roleId) => roleIds.includes(roleId));
  if (roles.length === 0) {
    throw new Error("A composite AccessPolicy requires at least one practice role.");
  }
  if (new Set(roleIds).size !== roles.length) {
    throw new Error("A composite AccessPolicy requires unique recognized practice roles.");
  }

  const rules = new Map<string, {
    resourceType: string;
    interaction: NonNullable<AccessPolicyResource["interaction"]>[number];
    criteria?: string;
    constraintAlternatives: NonNullable<AccessPolicyResource["writeConstraint"]>[];
  }>();
  for (const roleId of COMPOSITE_ROLE_PRECEDENCE) {
    if (!roles.includes(roleId)) continue;
    for (const sourceRule of getRoleDeclaration(roleId).resourceRules.map(toMedplumResourceRule)) {
      const rule = namespaceCompositeRule(sourceRule, roleId);
      for (const interaction of rule.interaction ?? []) {
        const key = JSON.stringify([rule.resourceType, interaction, rule.criteria ?? null]);
        const existing = rules.get(key);
        const constraints = structuredClone(rule.writeConstraint ?? []);
        if (!existing) {
          rules.set(key, {
            resourceType: rule.resourceType,
            interaction,
            ...(rule.criteria ? { criteria: rule.criteria } : {}),
            constraintAlternatives: [constraints],
          });
        } else if (!existing.constraintAlternatives.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(constraints),
        )) {
          existing.constraintAlternatives.push(constraints);
        }
      }
    }
  }

  const resource: AccessPolicyResource[] = [...rules.values()].map((rule) => {
    const writeConstraint = compositeWriteConstraint(rule.constraintAlternatives);
    return {
      resourceType: rule.resourceType,
      interaction: [rule.interaction],
      ...(rule.criteria ? { criteria: rule.criteria } : {}),
      ...(writeConstraint ? { writeConstraint } : {}),
    };
  });

  return {
    resourceType: "AccessPolicy",
    name: `ODOS Composite ${roles.map((roleId) => getRoleDeclaration(roleId).display).join(" + ")}`,
    meta: {
      tag: roles.map((code) => ({ system: ODOS_PRACTICE_ROLE_SYSTEM, code })),
    },
    resource,
  };
}

function namespaceCompositeRule(
  rule: AccessPolicyResource,
  roleId: PracticeRoleId,
): AccessPolicyResource {
  const namespace = (expression: string): string => expression.replace(
    /%([A-Za-z][A-Za-z0-9_]*)/g,
    (match, parameterName: string) => COMPOSITE_PARAMETER_NAMES.has(parameterName)
      ? `%${compositeRoleParameterName(roleId, parameterName)}`
      : match,
  );
  return {
    ...structuredClone(rule),
    ...(rule.criteria ? { criteria: namespace(rule.criteria) } : {}),
    ...(rule.writeConstraint ? {
      writeConstraint: rule.writeConstraint.map((constraint) => ({
        ...constraint,
        ...(constraint.expression ? { expression: namespace(constraint.expression) } : {}),
      })),
    } : {}),
  };
}

function compositeWriteConstraint(
  alternatives: readonly NonNullable<AccessPolicyResource["writeConstraint"]>[],
): AccessPolicyResource["writeConstraint"] | undefined {
  if (alternatives.some((constraints) => constraints.length === 0)) return undefined;
  if (alternatives.length === 1) return structuredClone(alternatives[0]);
  const expression = alternatives.map((constraints) =>
    `(${constraints.map((constraint) => `(${constraint.expression})`).join(" and ")})`
  ).join(" or ");
  return [{
    language: "text/fhirpath",
    description: "Allow the write constraints of any compiled practice role.",
    expression,
  }];
}

export function buildProjectMembershipAccess(input: {
  policyReference: string;
  parameters?: RoleAccessParameterValues;
}): ProjectMembershipAccess[] {
  const parameter = [
    input.parameters?.providerProfileReference
      ? {
          name: "provider_profile",
          valueReference: { reference: input.parameters.providerProfileReference },
        }
      : undefined,
    input.parameters?.patientCompartmentReference
      ? { name: "patient_compartment", valueString: input.parameters.patientCompartmentReference }
      : undefined,
    input.parameters?.licenseState
      ? { name: "license_state", valueString: input.parameters.licenseState.toUpperCase() }
      : undefined,
    input.parameters?.procedureScope
      ? { name: "procedure_scope", valueString: input.parameters.procedureScope }
      : undefined,
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return [
    {
      policy: { reference: input.policyReference },
      ...(parameter.length ? { parameter } : {}),
    },
  ];
}

export function assertBusinessActionAllowed(
  roleId: PracticeRoleId,
  businessAction: BusinessAction,
  effectiveActions?: readonly BusinessAction[],
): void {
  if (effectiveActions && !effectiveActions.includes(businessAction)) {
    throw new Error(
      `ODOS RBAC preflight denied: person-level permissions lack business action ${businessAction}.`,
    );
  }
  const role = getRoleDeclaration(roleId);
  if (!effectiveActions && !role.businessActions.includes(businessAction)) {
    throw new Error(
      `ODOS RBAC preflight denied: role ${roleId} lacks business action ${businessAction}.`,
    );
  }
}

export function resolveBusinessActionRole(
  roles: readonly PracticeRoleId[],
  businessAction: BusinessAction,
  effectiveActions?: readonly BusinessAction[],
): PracticeRoleId | undefined {
  const resolvedEffectiveActions = effectiveActions ?? EFFECTIVE_BUSINESS_ACTIONS_BY_ROLE_SET.get(roles);
  if (resolvedEffectiveActions && !resolvedEffectiveActions.includes(businessAction)) return undefined;
  const role = resolveDeclaredBusinessActionRole(roles, businessAction);
  return role ?? (resolvedEffectiveActions?.includes(businessAction) ? roles[0] : undefined);
}

export function resolveDeclaredBusinessActionRole(
  roles: readonly PracticeRoleId[],
  businessAction: BusinessAction,
): PracticeRoleId | undefined {
  return PRACTICE_ROLE_IDS.find(
    (roleId) =>
      roles.includes(roleId) &&
      getRoleDeclaration(roleId).businessActions.includes(businessAction),
  );
}

export function bindEffectiveBusinessActions(
  roles: readonly PracticeRoleId[],
  actions: readonly BusinessAction[],
): void {
  EFFECTIVE_BUSINESS_ACTIONS_BY_ROLE_SET.set(roles, actions);
}

export function staffHasBusinessAction(
  staff: {
    actorRole?: unknown;
    roles?: readonly PracticeRoleId[];
    businessActions?: readonly BusinessAction[];
  },
  action: BusinessAction,
): boolean {
  if (staff.businessActions) return staff.businessActions.includes(action);
  const roles = staff.roles?.length
    ? staff.roles
    : PRACTICE_ROLE_IDS.includes(staff.actorRole as PracticeRoleId)
    ? [staff.actorRole as PracticeRoleId]
    : [];
  return resolveBusinessActionRole(roles, action) !== undefined;
}

export function effectiveBusinessActions(
  roles: readonly PracticeRoleId[],
  granted: unknown,
  revoked: unknown,
): EffectiveBusinessActionResult {
  const roleUnion = new Set<BusinessAction>(
    roles.flatMap((role) => getRoleDeclaration(role).businessActions),
  );
  const parsedGranted = parseBusinessActionDelta(granted);
  const parsedRevoked = parseBusinessActionDelta(revoked);
  if (!parsedGranted || !parsedRevoked) {
    return {
      actions: BUSINESS_ACTIONS.filter((action) => roleUnion.has(action)),
      ignoredGranted: [],
      ignoredRevoked: [],
      malformed: true,
    };
  }

  const effective = new Set<BusinessAction>([
    ...BASELINE_BUSINESS_ACTIONS,
    ...roleUnion,
  ]);
  const ignoredGranted: BusinessAction[] = [];
  for (const action of parsedGranted) {
    if (GRANTABLE_BUSINESS_ACTIONS.includes(action)) effective.add(action);
    else appendUniqueAction(ignoredGranted, action);
  }
  const ignoredRevoked: BusinessAction[] = [];
  for (const action of parsedRevoked) {
    if (BASELINE_BUSINESS_ACTIONS.includes(action as (typeof BASELINE_BUSINESS_ACTIONS)[number])) {
      appendUniqueAction(ignoredRevoked, action);
    } else {
      effective.delete(action);
    }
  }

  return {
    actions: BUSINESS_ACTIONS.filter((action) => effective.has(action)),
    ignoredGranted,
    ignoredRevoked,
    malformed: false,
  };
}

function parseBusinessActionDelta(value: unknown): BusinessAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: BusinessAction[] = [];
  for (const action of value) {
    if (typeof action !== "string" || !BUSINESS_ACTIONS.includes(action as BusinessAction)) {
      return undefined;
    }
    appendUniqueAction(parsed, action as BusinessAction);
  }
  return parsed;
}

function appendUniqueAction(actions: BusinessAction[], action: BusinessAction): void {
  if (!actions.includes(action)) actions.push(action);
}

export function assertAestheticsProviderScope(input: AestheticsProviderScopeInput): void {
  if (input.roleId !== "provider") {
    return;
  }

  const requestedState = normalizeState(input.requestedState);
  const licensedStates = input.licensedStates.map(normalizeState);
  if (!licensedStates.includes(requestedState)) {
    throw new Error(
      `ODOS RBAC preflight denied: provider is not credentialed for ${requestedState}.`,
    );
  }

  if (!input.procedureType || !input.allowedProcedureTypesByState) {
    return;
  }

  const allowed = input.allowedProcedureTypesByState[requestedState] ?? [];
  if (!allowed.includes(input.procedureType)) {
    throw new Error(
      `ODOS RBAC preflight denied: provider credential for ${requestedState} does not include ${input.procedureType}.`,
    );
  }
}

export function accessPolicyHasNoBusinessActionVocabulary(policy: AccessPolicy): boolean {
  const serialized = JSON.stringify(policy);
  return BUSINESS_ACTIONS.every((action) => !serialized.includes(action));
}

function toMedplumResourceRule(rule: OdosResourceRule): AccessPolicyResource {
  return {
    resourceType: rule.resourceType,
    interaction: rule.interactions,
    ...(criteriaForRule(rule) ? { criteria: criteriaForRule(rule) } : {}),
    ...(rule.hiddenFields ? { hiddenFields: rule.hiddenFields } : {}),
    ...(rule.readonlyFields ? { readonlyFields: rule.readonlyFields } : {}),
    ...(rule.writeConstraint
      ? {
          writeConstraint: rule.writeConstraint.map((constraint) => ({
            language: "text/fhirpath" as const,
            description: constraint.description,
            expression: constraint.expression,
          })),
        }
      : {}),
  };
}

function criteriaForRule(rule: OdosResourceRule): string | undefined {
  switch (rule.scope.kind) {
    case "practice":
    case "audit-only":
      return undefined;
    case "patient-compartment":
      return `${rule.resourceType}?_compartment=%${rule.scope.parameterName}`;
    case "provider-assigned-patient":
      return `${rule.resourceType}?general-practitioner=%${rule.scope.parameterName}`;
    case "self-profile":
      return `${rule.resourceType}?_id=%${rule.scope.parameterName}.id`;
    case "profile-search":
    case "practice-search":
      return rule.scope.criteria;
  }
}

function normalizeState(state: string): string {
  const normalized = state.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error(`Expected two-letter US state code; received "${state}".`);
  }
  return normalized;
}
