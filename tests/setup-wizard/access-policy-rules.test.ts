import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicyResource } from "@medplum/fhirtypes";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
} from "../../mcp/src/authz/roles.js";
import {
  PolicyDriftError,
  assertCanonicalPolicyRules,
  canonicalPolicyRules,
  canonicalPolicyValue,
} from "../../scripts/access-policy-rules.js";

test("canonicalization preserves nested values while removing undefined and sorting arrays", () => {
  assert.deepEqual(
    canonicalPolicyValue({
      z: undefined,
      nested: {
        beta: [{ y: 2, omitted: undefined }, { y: 1 }],
        alpha: "kept",
      },
    }),
    {
      nested: {
        alpha: "kept",
        beta: [{ y: 1 }, { y: 2 }],
      },
    },
  );
});

test("admin canonicalization ignores rule, interaction, and object-key ordering", () => {
  const expected = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  const reordered = structuredClone(expected);
  reordered.resource = [...(reordered.resource ?? [])]
    .reverse()
    .map((rule): AccessPolicyResource => Object.fromEntries([
      ...(rule.criteria === undefined ? [] : [["criteria", rule.criteria] as const]),
      ...(rule.writeConstraint === undefined ? [] : [["writeConstraint", rule.writeConstraint] as const]),
      ["interaction", [...(rule.interaction ?? [])].reverse()],
      ["resourceType", rule.resourceType],
    ]) as AccessPolicyResource);

  assert.equal(canonicalPolicyRules(reordered), canonicalPolicyRules(expected));
  assert.doesNotThrow(() => assertCanonicalPolicyRules(reordered, "admin"));
});

test("admin canonicalization detects audit, every correction Basic shape, and billing identity drift", () => {
  const canonical = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  const cases = [
    {
      label: "AuditEvent audit-only read rule",
      mutate(policy: typeof canonical): void {
        policy.resource = policy.resource?.filter((rule) => rule.resourceType !== "AuditEvent");
      },
    },
    {
      label: "inventory-unit Basic correction rule",
      mutate(policy: typeof canonical): void {
        const rule = policy.resource?.find((candidate) =>
          candidate.criteria?.includes("practice-frame-inventory-unit")
          && candidate.interaction?.length === 1
          && candidate.interaction[0] === "update"
        );
        assert.ok(rule);
        rule.criteria = `${rule.criteria}-drifted`;
      },
    },
    {
      label: "variant-settings Basic correction rule",
      mutate(policy: typeof canonical): void {
        const rule = policy.resource?.find((candidate) =>
          candidate.criteria?.includes("practice-frame-variant-settings")
          && candidate.interaction?.includes("create")
        );
        assert.ok(rule);
        rule.interaction = ["read"];
      },
    },
    {
      label: "day-seal Basic correction rule",
      mutate(policy: typeof canonical): void {
        const rule = policy.resource?.find((candidate) =>
          candidate.criteria?.includes("day-seal|day-seal")
          && candidate.interaction?.length === 1
          && candidate.interaction[0] === "create"
        );
        assert.ok(rule);
        rule.criteria = `${rule.criteria}-drifted`;
      },
    },
    {
      label: "billing identity configuration write rule",
      mutate(policy: typeof canonical): void {
        const rule = policy.resource?.find((candidate) =>
          candidate.criteria?.includes("billing-identity-config")
          && candidate.interaction?.includes("create")
        );
        assert.ok(rule);
        rule.interaction = ["read"];
      },
    },
  ];

  for (const { label, mutate } of cases) {
    const drifted = structuredClone(canonical);
    mutate(drifted);
    assert.throws(
      () => assertCanonicalPolicyRules(drifted, "admin"),
      (error) => error instanceof PolicyDriftError && error.role === "admin",
      label,
    );
  }
});
