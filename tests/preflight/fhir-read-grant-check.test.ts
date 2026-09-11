import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AccessPolicyResource } from "@medplum/fhirtypes";
import {
  PRACTICE_ROLE_IDS,
  buildMedplumAccessPolicy,
  getRoleDeclaration,
} from "../../mcp/src/authz/roles.js";

type SourceFile = { readonly path: string; readonly text: string };
type GrantCheckResult = {
  readonly readResourceTypes: readonly string[];
  readonly excludedServiceIdentityResourceTypes: readonly string[];
  readonly excludedServiceIdentityWriteCallSites?: readonly string[];
  readonly suspectedBrokenPracticeRoleWriteCallSites?: readonly string[];
  readonly excludedNonFhirCallSites: readonly string[];
  readonly grantedResourceTypes: readonly string[];
  readonly missingResourceTypes: readonly string[];
  readonly sourceRoots: readonly string[];
  readonly includedExtensions: readonly string[];
  readonly excludedDirectoryNames: readonly string[];
  readonly limitations: readonly string[];
  readonly operations?: readonly FhirOperation[];
  readonly criteriaScopedResourceTypes?: readonly string[];
  readonly criteriaScopeCoverage?: readonly CriteriaScopeCoverage[];
};
type FhirOperation = {
  readonly path: string;
  readonly line: number;
  readonly callee: string;
  readonly interaction: "read" | "search" | "create" | "update" | "delete" | "patch";
  readonly requiredInteraction: "read" | "search" | "create" | "update" | "delete";
  readonly resourceType: string;
  readonly scopeContract?: string;
};
type CriteriaScopeCoverage = {
  readonly resourceType: string;
  readonly operations: number;
  readonly verified: number;
  readonly notVerified: number;
};
type NonFhirLiteralCallSite = {
  readonly path: string;
  readonly callee: string;
  readonly literal: string;
  readonly reason: string;
};
type ExactFhirWriteCallSite = {
  readonly path: string;
  readonly line: number;
  readonly callee: string;
  readonly resourceType: string;
  readonly reason: string;
};
type GrantCheckModule = {
  readonly collectLiteralFhirReadResourceTypes: (
    files: readonly SourceFile[],
    nonFhirCallSites?: readonly NonFhirLiteralCallSite[],
  ) => readonly string[];
  readonly findMissingFhirReadGrants: (
    readResourceTypes: readonly string[],
    grantedResourceTypes: readonly string[],
  ) => readonly string[];
  readonly runFhirReadGrantCheck: () => GrantCheckResult;
  readonly collectFhirOperations?: (
    files: readonly SourceFile[],
    nonFhirCallSites?: readonly NonFhirLiteralCallSite[],
  ) => readonly FhirOperation[];
  readonly findMissingFhirOperationGrants?: (
    operations: readonly FhirOperation[],
    grantedRules: readonly AccessPolicyResource[],
  ) => readonly FhirOperation[];
  readonly matchExactWriteInventory?: (
    operations: readonly FhirOperation[],
    inventory: readonly ExactFhirWriteCallSite[],
    inventoryName: string,
  ) => readonly FhirOperation[];
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICE_FHIR_PROBE_PATH = resolve(REPO_ROOT, "mcp/src/.fhir-read-grant-check-probe.ts");
const UI_FHIR_PROBE_PATH = resolve(REPO_ROOT, "ui/src/.fhir-read-grant-check-probe.tsx");
const DX_PICK_TALLY_CRITERIA =
  "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-dx-pick-tally|odos-dx-pick-tally&identifier=https://odos2020.com/fhir/NamingSystem/dx-pick-tally-practitioner|%profile";

async function loadGrantCheck(): Promise<GrantCheckModule> {
  try {
    return await import("../../scripts/fhir-read-grant-check.ts") as GrantCheckModule;
  } catch (error) {
    assert.fail(`FHIR read grant preflight is not implemented: ${String(error)}`);
  }
}

test("FHIR read grant scan collects every literal FHIR receiver and requires the search-contract marker for computed searches", async () => {
  const { collectLiteralFhirReadResourceTypes } = await loadGrantCheck();
  const files = [{
    path: "mcp/src/fixture.ts",
    text: [
      "async function searchResource(fhir, resourceType, params) {",
      "  // search-contract: fixture.computed-search",
      "  return fhir.search(resourceType, params);",
      "}",
      "async function optionalSearchResource(fhir, resourceType, params) {",
      "  return searchResource(fhir, resourceType, params);",
      "}",
      'await fhir.read("PlanDefinition", "plan-1");',
      'await this.fhir.search("AllergyIntolerance", { patient });',
      'await staff.fhir.search("Goal", { subject: patient });',
      'await searchResource(fhir, "CarePlan", { patient });',
      'await optionalSearchResource(fhir, "Coverage", { patient });',
      'await optionalSearchResource(fhir, "CoverageEligibilityResponse", { patient });',
      'await fhir.read(computedResourceType, id);',
      'await serviceFhir.search("ProjectMembership", { profile });',
      'await deps.serviceFhir.read("RiskAssessment", "risk-1");',
      'await serviceClient.read("User", "user-1");',
    ].join("\n"),
  }];

  assert.deepEqual(
    collectLiteralFhirReadResourceTypes(files),
    [
      "AllergyIntolerance",
      "CarePlan",
      "Coverage",
      "CoverageEligibilityResponse",
      "Goal",
      "PlanDefinition",
      "ProjectMembership",
      "RiskAssessment",
      "User",
    ],
  );
  assert.throws(
    () => collectLiteralFhirReadResourceTypes([{
      path: "mcp/src/unmarked.ts",
      text: "await fhir.search(resourceType, params);\n",
    }]),
    /search-contract/,
  );
});

test("FHIR operation scan maps every write interaction to its required Medplum grant", async () => {
  const module = await loadGrantCheck();
  assert.equal(typeof module.collectFhirOperations, "function", "write-aware operation collection must be exported");
  if (!module.collectFhirOperations) return;
  const operations = module.collectFhirOperations([{
    path: "mcp/src/write-fixture.ts",
    text: [
      'await fhir.read("Patient", "p1");',
      'await fhir.search("Observation", { subject: "Patient/p1" });',
      'await fhir.create<Condition>(condition);',
      'await fhir.create({ resourceType: "CarePlan", status: "active", intent: "plan", subject: { reference: "Patient/p1" } });',
      'await fhir.update("Encounter", "e1", encounter);',
      'await fhir.patch("MedicationRequest", "m1", []);',
      'await fhir.delete("Goal", "g1");',
    ].join("\n"),
  }]);

  assert.deepEqual(
    operations.map(({ interaction, requiredInteraction, resourceType }) => ({ interaction, requiredInteraction, resourceType })),
    [
      { interaction: "read", requiredInteraction: "read", resourceType: "Patient" },
      { interaction: "search", requiredInteraction: "search", resourceType: "Observation" },
      { interaction: "create", requiredInteraction: "create", resourceType: "Condition" },
      { interaction: "create", requiredInteraction: "create", resourceType: "CarePlan" },
      { interaction: "update", requiredInteraction: "update", resourceType: "Encounter" },
      { interaction: "patch", requiredInteraction: "update", resourceType: "MedicationRequest" },
      { interaction: "delete", requiredInteraction: "delete", resourceType: "Goal" },
    ],
  );
});

test("the PR 397 tally create fails grant comparison when its exact profile fence is absent", async () => {
  const module = await loadGrantCheck();
  assert.equal(typeof module.collectFhirOperations, "function", "scope-contract operation collection must be exported");
  assert.equal(typeof module.findMissingFhirOperationGrants, "function", "interaction-aware grant comparison must be exported");
  if (!module.collectFhirOperations || !module.findMissingFhirOperationGrants) return;
  const operations = module.collectFhirOperations([{
    path: "mcp/src/clinical-graph/diagnosis-pick-tally-store.ts",
    text: [
      `// fhir-scope-contract: ${DX_PICK_TALLY_CRITERIA}`,
      "async function initialize(fhir, resource) {",
      "  await fhir.create(resource);",
      "}",
    ].join("\n"),
  }]);
  const grantsWithoutTally = PRACTICE_ROLE_IDS.flatMap((roleId) =>
    (buildMedplumAccessPolicy(getRoleDeclaration(roleId)).resource ?? [])
      .filter((rule) => rule.criteria !== DX_PICK_TALLY_CRITERIA)
  );

  assert.deepEqual(
    module.findMissingFhirOperationGrants(operations, grantsWithoutTally),
    [{
      path: "mcp/src/clinical-graph/diagnosis-pick-tally-store.ts",
      line: 3,
      callee: "fhir.create",
      interaction: "create",
      requiredInteraction: "create",
      resourceType: "Basic",
      scopeContract: DX_PICK_TALLY_CRITERIA,
    }],
  );
});

test("the exact write ratchet rejects a stale entry instead of silently forgiving it", async () => {
  const module = await loadGrantCheck();
  assert.equal(typeof module.matchExactWriteInventory, "function");
  if (!module.matchExactWriteInventory) return;
  const operation: FhirOperation = {
    path: "ui/src/fixture.tsx",
    line: 10,
    callee: "fhir.create",
    interaction: "create",
    requiredInteraction: "create",
    resourceType: "RiskAssessment",
  };

  assert.throws(
    () => module.matchExactWriteInventory!([operation], [{
      path: operation.path,
      line: 11,
      callee: operation.callee,
      resourceType: operation.resourceType,
      reason: "fixture",
    }], "fixture ratchet"),
    /no longer matches a real ungranted call site/,
  );
});

test("the service-identity write inventory rejects an exact ui/src relocation", async () => {
  const module = await loadGrantCheck();
  assert.equal(typeof module.matchExactWriteInventory, "function");
  if (!module.matchExactWriteInventory) return;
  const relocatedAllergyWrite: FhirOperation = {
    path: "ui/src/lib/clinical-actions.ts",
    line: 64,
    callee: "fhir.create",
    interaction: "create",
    requiredInteraction: "create",
    resourceType: "AllergyIntolerance",
  };

  assert.throws(
    () => module.matchExactWriteInventory!([relocatedAllergyWrite], [{
      path: relocatedAllergyWrite.path,
      line: relocatedAllergyWrite.line,
      callee: relocatedAllergyWrite.callee,
      resourceType: relocatedAllergyWrite.resourceType,
      reason: "invented service-identity exception",
    }], "Service-identity FHIR write exclusion"),
    /service-identity.*ui\/src/i,
  );
});

test("FHIR read grant comparison reports the exact sorted subset gap", async () => {
  const { findMissingFhirReadGrants } = await loadGrantCheck();
  assert.deepEqual(
    findMissingFhirReadGrants(
      ["PlanDefinition", "MedicationRequest", "Goal", "AllergyIntolerance"],
      ["MedicationRequest", "Patient"],
    ),
    ["AllergyIntolerance", "Goal", "PlanDefinition"],
  );
});

test("an explicitly reasoned non-FHIR literal call site does not manufacture a grant demand", async () => {
  const { collectLiteralFhirReadResourceTypes } = await loadGrantCheck();
  const files = [{
    path: "ui/src/cache.ts",
    text: 'await cache.search("recent-patients");\nawait fhir.search("Patient", { active: "true" });\n',
  }];
  const allowlist = [{
    path: "ui/src/cache.ts",
    callee: "cache.search",
    literal: "recent-patients",
    reason: "Local cache lookup, not a FHIR search.",
  }];

  assert.deepEqual(collectLiteralFhirReadResourceTypes(files, allowlist), ["Patient"]);
});

test("live FHIR read grant check covers all four chart resources through compiled role policies", async () => {
  const { runFhirReadGrantCheck } = await loadGrantCheck();
  const result = runFhirReadGrantCheck();

  assert.deepEqual(result.missingResourceTypes, []);
  assert.deepEqual(result.excludedServiceIdentityResourceTypes, ["CodeSystem", "Project", "ProjectMembership", "User"]);
  assert.equal(result.excludedNonFhirCallSites.length, 7);
  assert.equal(result.excludedServiceIdentityWriteCallSites?.length, 34);
  assert.equal(
    result.excludedServiceIdentityWriteCallSites?.filter((entry) =>
      entry.startsWith("mcp/src/weno/weno-search-routes.ts:")
      && entry.includes("deps.serviceFhir.update MedicationRequest")
    ).length,
    10,
  );
  assert.equal(result.suspectedBrokenPracticeRoleWriteCallSites?.length, 0);
  assert.deepEqual(result.sourceRoots, ["mcp/src", "ui/src"]);
  assert.deepEqual(result.includedExtensions, [".ts", ".tsx"]);
  assert.deepEqual(result.excludedDirectoryNames, ["__tests__"]);
  assert.equal(result.operations?.some((operation) =>
    operation.path === "mcp/src/clinical-graph/diagnosis-pick-tally-store.ts"
    && operation.interaction === "create"
    && operation.scopeContract === DX_PICK_TALLY_CRITERIA
  ), true, "the live scan must identify the tally create and its exact scope contract");
  assert.deepEqual(result.criteriaScopedResourceTypes, [
    "Account",
    "AdverseEvent",
    "AllergyIntolerance",
    "Basic",
    "BodyStructure",
    "CarePlan",
    "CareTeam",
    "ChargeItem",
    "Communication",
    "Condition",
    "Consent",
    "Coverage",
    "Device",
    "DeviceRequest",
    "DiagnosticReport",
    "DocumentReference",
    "Encounter",
    "EpisodeOfCare",
    "Goal",
    "Media",
    "MedicationAdministration",
    "MedicationRequest",
    "MedicationStatement",
    "Observation",
    "Patient",
    "Procedure",
    "Provenance",
    "QuestionnaireResponse",
    "RelatedPerson",
    "ServiceRequest",
  ]);
  const basicCoverage = result.criteriaScopeCoverage?.find((row) => row.resourceType === "Basic");
  assert.ok(basicCoverage);
  assert.equal(basicCoverage.operations > 0, true);
  assert.equal(basicCoverage.verified > 0, true, "tally scope contracts must receive exact verification");
  assert.equal(basicCoverage.notVerified > 0, true, "opaque-ID and distant-builder Basic operations must remain explicit");
  for (const resourceType of ["AllergyIntolerance", "Goal", "MedicationRequest", "PlanDefinition"]) {
    assert.equal(result.readResourceTypes.includes(resourceType), true, `${resourceType} must be scanned`);
    assert.equal(result.grantedResourceTypes.includes(resourceType), true, `${resourceType} must be granted`);
  }
  assert.deepEqual(result.limitations, [
    "Computed read resourceTypes escape this scan.",
    "Computed create resources require a generic resource type, an object-literal resourceType, or an fhir-scope-contract marker; other computed creates escape this scan.",
    "Computed update, delete, and patch resourceTypes escape this scan.",
    "A computed search is marker-checked only when its argument is named resourceType, resource_type, or .resourceType; other names escape because receiver-independent matching would misclassify non-FHIR search APIs.",
    "Marked helper propagation follows named parameters; destructured or object-property resourceType forwarding escapes this scan.",
    "Marked helper propagation is function-name based across scanned roots; an imported helper alias escapes unless its local name matches, and same-named non-FHIR helpers require the explicit call-site allowlist.",
    "Type-level comparison does not prove criteria scope; criteria-dependent operations without an exact fhir-scope-contract are counted as NOT SCOPE-VERIFIED.",
  ]);
});

test("FHIR read grant CLI passes only with full coverage and always prints its limits", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/fhir-read-grant-check.ts"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /FHIR read grant check: PASS \(\d+ literal\/marked resourceTypes under mcp\/src \+ ui\/src\)/);
  assert.match(result.stdout, /Included source extensions: \.ts, \.tsx/);
  assert.match(result.stdout, /Excluded source directories: __tests__/);
  assert.match(result.stdout, /Excluded source extensions: all except \.ts, \.tsx/);
  assert.match(result.stdout, /ProjectMembership — service identity authorization context/);
  assert.match(result.stdout, /User — service identity account resolution/);
  assert.match(result.stdout, /Service-identity FHIR write call sites excluded \(34\):/);
  assert.match(result.stdout, /SUSPECTED BROKEN FEATURE — known ungranted practice-role write call sites \(0\):/);
  assert.match(result.stdout, /Non-FHIR literal call sites excluded:\n- mcp\/src\/bulk-data\/router\.ts:141 router\.delete/);
  assert.match(result.stdout, /other names escape because receiver-independent matching would misclassify non-FHIR search APIs/);
  assert.match(result.stdout, /Type-level comparison does not prove criteria scope/);
  assert.match(result.stdout, /Criteria-scoped resource types \(30\): Account, AdverseEvent, .*ServiceRequest/);
  assert.match(result.stdout, /Basic: \d+ operations; \d+ scope-verified; \d+ NOT SCOPE-VERIFIED/);
});

test("an ungranted FHIR create in mcp source makes the CLI fail with its interaction and resource type", () => {
  writeFileSync(
    SERVICE_FHIR_PROBE_PATH,
    [
      "export async function probe(serviceFhir: { create<T>(resource: T): Promise<T> }) {",
      '  await serviceFhir.create<RiskAssessment>({ resourceType: "RiskAssessment", status: "final", subject: { reference: "Patient/probe" }, code: { text: "probe" } });',
      "}",
      "",
    ].join("\n"),
  );

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/fhir-read-grant-check.ts"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
  } finally {
    unlinkSync(SERVICE_FHIR_PROBE_PATH);
  }

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Missing FHIR grants: create RiskAssessment/);
});

test("an ungranted FHIR create in ui tsx makes the CLI fail with its interaction and resource type", () => {
  writeFileSync(
    UI_FHIR_PROBE_PATH,
    [
      "export async function Probe({ fhir }) {",
      '  await fhir.create({ resourceType: "RiskAssessment", status: "final", subject: { reference: "Patient/probe" }, code: { text: "probe" } });',
      "  return <div />;",
      "}",
      "",
    ].join("\n"),
  );

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/fhir-read-grant-check.ts"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
  } finally {
    unlinkSync(UI_FHIR_PROBE_PATH);
  }

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Missing FHIR grants: create RiskAssessment/);
});

test("serviceFhir read of an ungranted non-plumbing resource makes the CLI fail with its name", () => {
  writeFileSync(
    SERVICE_FHIR_PROBE_PATH,
    [
      "export async function probe(deps: { serviceFhir: { read(t: string, i: string): Promise<unknown> } }) {",
      '  await deps.serviceFhir.read("RiskAssessment", "probe");',
      "}",
      "",
    ].join("\n"),
  );

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/fhir-read-grant-check.ts"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
  } finally {
    unlinkSync(SERVICE_FHIR_PROBE_PATH);
  }

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /FHIR read grant check: FAIL/);
  assert.match(result.stdout, /Missing resourceType grants: RiskAssessment/);
});

test("an ungranted FHIR read in ui/src makes the CLI fail with its name", () => {
  writeFileSync(
    UI_FHIR_PROBE_PATH,
    [
      "export async function probe(fhir: { read(t: string, i: string): Promise<unknown> }) {",
      '  await fhir.read("RiskAssessment", "probe");',
      "}",
      "",
    ].join("\n"),
  );

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/fhir-read-grant-check.ts"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
  } finally {
    unlinkSync(UI_FHIR_PROBE_PATH);
  }

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /FHIR read grant check: FAIL/);
  assert.match(result.stdout, /Missing resourceType grants: RiskAssessment/);
});

test("a marked computed search helper carries literal resource types across source files", async () => {
  const { collectLiteralFhirReadResourceTypes } = await loadGrantCheck();
  const files = [
    {
      path: "ui/src/lib/fhir-search.ts",
      text: [
        "export async function searchAll(fhir, resourceType, params) {",
        "  // search-contract: ui.fhir-search.all",
        "  return fhir.search(resourceType, params);",
        "}",
      ].join("\n"),
    },
    {
      path: "ui/src/scene.tsx",
      text: [
        'import { searchAll } from "./lib/fhir-search";',
        'await searchAll(fhir, "RiskAssessment", { patient });',
      ].join("\n"),
    },
  ];

  assert.deepEqual(collectLiteralFhirReadResourceTypes(files), ["RiskAssessment"]);
});
