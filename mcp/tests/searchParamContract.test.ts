import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import {
  assertSearchParameterKeys,
  FHIR_R4_SEARCH_RESULT_PARAMETERS,
  invalidSearchParameterKeys,
  MEDPLUM_5_1_8_SEARCH_PARAMETERS,
  MEDPLUM_SEARCH_PARAMETER_SOURCE,
  type ContractResourceType,
} from "./search-param-contract.js";

type SearchSpec = {
  resourceType: ContractResourceType;
  parameterKeys: string[];
};

const DYNAMIC_FHIR_SEARCH = "dynamic-fhir-search";
const DYNAMIC_SEARCH_SPECS: Record<string, SearchSpec[] | typeof DYNAMIC_FHIR_SEARCH> = {
  "clinic-summary.search-resource": [
    spec("Appointment", "date", "_count", "_sort"),
    spec("Encounter", "date", "_count", "_sort"),
    spec("Task", "code", "_count", "_sort"),
    spec("Provenance", "patient", "recorded", "_count", "_sort"),
    spec("Patient", "_id", "_count"),
  ],
  "patient-overview.search-resource": [
    spec("Coverage", "beneficiary", "status", "_count"),
    spec("Condition", "patient", "category", "_count"),
    spec("Procedure", "patient", "_count", "_sort"),
    spec("MedicationStatement", "patient", "status", "_count"),
    spec("MedicationRequest", "patient", "status", "_count"),
    spec("Observation", "patient", "code", "_count", "_sort"),
    spec("Condition", "patient", "category", "verification-status", "code", "_count"),
    spec("Encounter", "patient", "type", "_id", "_count", "_sort"),
    spec("Provenance", "patient", "_count", "_sort"),
    spec("DocumentReference", "subject", "identifier", "_count"),
  ],
  "iop-history.iop-observations": [spec("Observation", "subject", "code", "_count")],
  "iop-history.hysteresis-observations": [spec("Observation", "subject", "code", "_count")],
  "iop-history.target-goals": [spec("Goal", "subject", "category", "_count")],
  "iop-history.existing-target-goals": [spec("Goal", "subject", "category", "_count")],
  "eye-growth.axial-length-observations": [spec("Observation", "subject", "code", "_count")],
  "eye-growth.corneal-radius-observations": [spec("Observation", "subject", "code", "_count")],
  "eye-growth.refraction-observations": [spec("Observation", "subject", "code", "_count", "_sort")],
  "diagnosis-findings.encounter-resources": [
    spec("Condition", "encounter", "_count"),
    spec("Observation", "encounter", "_count"),
  ],
  "protocol-endpoint.search-resources": [
    spec("Condition", "encounter", "_count"),
    spec("Observation", "encounter", "_count"),
  ],
  "imaging-endpoint.search-media": [
    spec("Media", "patient", "encounter", "status", "_sort", "_count"),
    spec("Media", "_id", "_count"),
  ],
  "protocol-store.search-basic": [spec("Basic", "code", "identifier", "_count")],
  "day-ledger.search-resource": [
    spec("Invoice", "date", "_count", "_sort"),
    spec("PaymentReconciliation", "status", "created", "_count", "_sort"),
    spec("ChargeItem", "occurrence", "_count", "_sort"),
  ],
  "desk-summary.search-resource": [
    spec("Appointment", "date", "_count", "_sort"),
    spec("Task", "status", "code", "business-status", "_count", "_sort"),
    spec("Claim", "_count", "_sort"),
    spec("ClaimResponse", "_count", "_sort"),
    spec("PaymentReconciliation", "_count", "_sort"),
    spec("Invoice", "_count", "_sort"),
    spec("Patient", "_id", "_count"),
  ],
  "watcher-pagination.search-resource": [
    spec("Appointment", "date", "_count", "_sort"),
    spec("Patient", "_id", "_count"),
    spec("Invoice", "status", "_count", "_sort"),
    spec("PaymentReconciliation", "status", "_count"),
    spec("Task", "code", "_count"),
    spec("Task", "_count"),
  ],
  "weno-mapping.search-basic": [spec("Basic", "code", "_count")],
  "tools.list-patients": [spec("Patient", "name", "_count")],
  "tools.get-observations": [spec("Observation", "subject", "category", "_count")],
  "tools.get-charge-items": [spec("ChargeItem", "subject", "context", "_count")],
  "tools.fhir-search": DYNAMIC_FHIR_SEARCH,
  "tools.get-observation-history": [spec("Observation", "subject", "code", "date", "focus", "_count", "_sort")],
  "tools.get-progression-summary": [spec("Observation", "subject", "code", "date", "focus", "_count", "_sort")],
  "office-channel.search-resource": [
    spec("Communication", "category", "_count", "_sort"),
    spec("Provenance", "_tag", "recorded", "_count", "_sort"),
  ],
  "margin-ledger.search-resource": [
    spec("Invoice", "date", "_count", "_sort"),
    spec("PaymentReconciliation", "status", "created", "_count", "_sort"),
    spec("Claim", "_count", "_sort"),
    spec("ClaimResponse", "_count", "_sort"),
    spec("Task", "code", "_count", "_sort"),
    spec("ChargeItemDefinition", "_count"),
    spec("ChargeItem", "_id", "_count"),
  ],
  "claim-read-model-projector.search-resource": [
    spec("Claim", "_count", "_sort"),
    spec("ClaimResponse", "_count", "_sort"),
    spec("Task", "_count", "_sort"),
    spec("Patient", "_id", "_count"),
    spec("Practitioner", "_id", "_count"),
    spec("PractitionerRole", "_id", "_count"),
    spec("Organization", "_id", "_count"),
    spec("Location", "_id", "_count"),
  ],
  "reporting.search-resource": [
    spec("Invoice", "date", "_count"),
    spec("PaymentReconciliation", "created", "status", "_count"),
  ],
  "referral-service.encounter-resources": [
    spec("Observation", "patient", "encounter", "_count"),
    spec("CarePlan", "patient", "encounter", "_count"),
  ],
  "reminder-engine.search-anchor": [spec("Appointment", "date", "_count")],
  "series-tracker.search-complete": [
    spec("CarePlan", "subject", "instantiates-canonical", "_count"),
    spec("Procedure", "subject", "code", "_count"),
    spec("Procedure", "subject", "based-on", "_count"),
  ],
  "inbound-fax.search-resource": [
    spec("Practitioner", "telecom", "_count"),
    spec("Practitioner", "name", "_count"),
    spec("Organization", "name", "_count"),
    spec("PractitionerRole", "telecom", "_count"),
    spec("ServiceRequest", "category", "requester", "_sort", "_count"),
  ],
  "inbound-fax.find-referral": [spec("ServiceRequest", "identifier", "_count")],
  "scheduling-service.search-resource": [
    spec("Appointment", "actor"),
    spec("HealthcareService"),
    spec("Schedule"),
  ],
};

test("contract is frozen from Medplum 5.1.8's published definition bundles", () => {
  assert.equal(MEDPLUM_SEARCH_PARAMETER_SOURCE.package, "@medplum/definitions");
  assert.equal(MEDPLUM_SEARCH_PARAMETER_SOURCE.version, "5.1.8");
  assert.equal(MEDPLUM_SEARCH_PARAMETER_SOURCE.files.length, 3);
  assert.equal(Object.keys(MEDPLUM_5_1_8_SEARCH_PARAMETERS).length, 38);
  assert.deepEqual(FHIR_R4_SEARCH_RESULT_PARAMETERS, ["_summary"]);
});

test("historical ChargeItem status search is rejected while known-valid searches pass", () => {
  assert.throws(
    () => assertSearchParameterKeys("ChargeItem", ["status"]),
    /Medplum 5\.1\.8 rejects ChargeItem\?status/,
  );
  assert.doesNotThrow(() => assertSearchParameterKeys("ChargeItem", ["subject", "context", "_count"]));
  assert.doesNotThrow(() => assertSearchParameterKeys("ChargeItem", ["occurrence", "_count", "_sort"]));
  assert.doesNotThrow(() => assertSearchParameterKeys("PaymentReconciliation", ["status", "created", "_sort"]));
  assert.doesNotThrow(() => assertSearchParameterKeys("Task", ["code", "business-status", "_sort"]));
  assert.doesNotThrow(() => assertSearchParameterKeys("AccessPolicy", ["name:exact"]));
});

test("all direct fhir.search call sites are statically resolved or explicitly dynamic", () => {
  const calls = collectDirectFhirSearchCalls();
  const usedOverrides = new Set<string>();
  let dynamicEscapeHatches = 0;

  for (const call of calls) {
    if (call.resourceType && call.parameterKeys) {
      assert.ok(call.resourceType in MEDPLUM_5_1_8_SEARCH_PARAMETERS, `${call.location} searches unmapped ${call.resourceType}`);
      continue;
    }

    assert.ok(call.contractKey, `${call.location} has unresolved search parameters and no search-contract marker`);
    assert.ok(!usedOverrides.has(call.contractKey), `${call.location} duplicates search-contract key ${call.contractKey}`);
    const override = DYNAMIC_SEARCH_SPECS[call.contractKey];
    assert.ok(override, `${call.location} uses undeclared search-contract key ${call.contractKey}`);
    usedOverrides.add(call.contractKey);
    if (override === DYNAMIC_FHIR_SEARCH) {
      dynamicEscapeHatches += 1;
    }
  }

  assert.equal(dynamicEscapeHatches, 1, "Only the user-supplied fhir_search tool may stay dynamically typed.");
  assert.deepEqual([...usedOverrides].sort(), Object.keys(DYNAMIC_SEARCH_SPECS).sort());
});

test("static audit finds zero invalid search parameters", () => {
  const violations = collectSearchSpecs().flatMap(({ location, spec: current }) =>
    invalidSearchParameterKeys(current.resourceType, current.parameterKeys).map((parameter) => ({
      location,
      resourceType: current.resourceType,
      parameter,
    })),
  );

  assert.deepEqual(violations, []);
});

test("static audit rejects a mistyped dynamic override key", () => {
  const overrides = { ...DYNAMIC_SEARCH_SPECS };
  overrides["referral-service.encounter-resource"] = [
    spec("Observation", "patient", "encounter", "_count"),
  ];

  assert.throws(
    () => collectSearchSpecs(overrides),
    /Contract override referral-service\.encounter-resource has no matching call site/,
  );
});

function spec(resourceType: ContractResourceType, ...parameterKeys: string[]): SearchSpec {
  return { resourceType, parameterKeys };
}

function collectSearchSpecs(
  overrides: Record<string, SearchSpec[] | typeof DYNAMIC_FHIR_SEARCH> = DYNAMIC_SEARCH_SPECS,
): Array<{ location: string; spec: SearchSpec }> {
  const usedOverrides = new Set<string>();
  const specs = collectDirectFhirSearchCalls().flatMap((call) => {
    if (call.resourceType && call.parameterKeys) {
      return [{
        location: call.location,
        spec: spec(call.resourceType as ContractResourceType, ...call.parameterKeys),
      }];
    }
    if (!call.contractKey) {
      throw new Error(`${call.location} has unresolved search parameters and no search-contract marker`);
    }
    if (usedOverrides.has(call.contractKey)) {
      throw new Error(`${call.location} duplicates search-contract key ${call.contractKey}`);
    }
    const override = overrides[call.contractKey];
    if (override === undefined) {
      throw new Error(`${call.location} uses undeclared search-contract key ${call.contractKey}`);
    }
    usedOverrides.add(call.contractKey);
    return override === DYNAMIC_FHIR_SEARCH ? [] : override.map((current) => ({
      location: call.location,
      spec: current,
    }));
  });
  const unusedOverrides = Object.keys(overrides).filter((key) => !usedOverrides.has(key));
  if (unusedOverrides.length > 0) {
    throw new Error(`Contract override ${unusedOverrides[0]} has no matching call site`);
  }
  return specs;
}

function collectDirectFhirSearchCalls(): Array<{
  location: string;
  contractKey?: string;
  resourceType?: string;
  parameterKeys?: string[];
}> {
  const sourceRoot = resolve(process.cwd(), "src");
  return sourceFiles(sourceRoot).flatMap((file) => {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const calls: Array<{
      location: string;
      contractKey?: string;
      resourceType?: string;
      parameterKeys?: string[];
    }> = [];

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "search"
        && /(^|\.)fhir$/.test(node.expression.expression.getText(source))
      ) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        const contractKey = searchContractKey(node, source);
        const resourceType = stringLiteral(node.arguments[0]);
        const parameterKeys = extractParameterKeys(node.arguments[1]);
        calls.push({
          location: `${relative(process.cwd(), file).replaceAll("\\", "/")}:${position.line + 1}`,
          ...(contractKey ? { contractKey } : {}),
          ...(resourceType ? { resourceType } : {}),
          ...(parameterKeys ? { parameterKeys } : {}),
        });
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
    return calls;
  });
}

function searchContractKey(node: ts.CallExpression, source: ts.SourceFile): string | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    const leadingTrivia = source.text.slice(current.getFullStart(), current.getStart(source));
    const match = leadingTrivia.match(/search-contract:\s*([a-z0-9]+(?:[.-][a-z0-9]+)*)/);
    if (match) return match[1];
    current = current.parent;
  }
  return undefined;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function stringLiteral(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return stringLiteral(node.expression);
  return undefined;
}

function extractParameterKeys(node: ts.Expression | undefined): string[] | undefined {
  if (!node) return [];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return extractParameterKeys(node.expression);
  if (ts.isConditionalExpression(node)) {
    const whenTrue = extractParameterKeys(node.whenTrue);
    const whenFalse = extractParameterKeys(node.whenFalse);
    return whenTrue && whenFalse ? [...new Set([...whenTrue, ...whenFalse])].sort() : undefined;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const keys = node.elements.map((element) => {
      if (!ts.isArrayLiteralExpression(element)) return undefined;
      return stringLiteral(element.elements[0] as ts.Expression | undefined);
    });
    return keys.every((key): key is string => key !== undefined) ? [...new Set(keys)].sort() : undefined;
  }
  if (!ts.isObjectLiteralExpression(node)) return undefined;

  const keys: string[] = [];
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spreadKeys = extractParameterKeys(property.expression);
      if (!spreadKeys) return undefined;
      keys.push(...spreadKeys);
      continue;
    }
    const name = propertyName(property.name);
    if (!name) return undefined;
    keys.push(name);
  }
  return [...new Set(keys)].sort();
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return stringLiteral(name.expression);
  return undefined;
}
