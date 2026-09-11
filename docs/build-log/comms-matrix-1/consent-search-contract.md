# Consent search contract extraction

The new entry was generated, not transcribed, from the integrity-verified published package. Existing `_count` and `_sort` query controls were inherited from the existing Patient contract. The extraction script checks that patient, category, status, and `_count` are included.

Reproduction from the repository root, with the package archive in the working directory:

```sh
npm pack @medplum/definitions@5.1.8 --json
python3 docs/build-log/comms-matrix-1/extract-consent-search-contract.py medplum-definitions-5.1.8.tgz
```

The script expects the pre-change contract without Consent. Its captured output is `consent-search-contract-extraction.txt`. The reviewed package integrity matches the pinned contract exactly. The inventory resource count advances from 37 to 38; no scanner rule changed.

Validation:

- `npm --prefix mcp test -- tests/searchParamContract.test.ts tests/commsEvidence.test.ts tests/commsPreferencesRoutes.test.ts`: 22 passed, 0 failed, exit 0.
- `npm run guard:cpt`: clean, exit 0. Named report limits replace the numeric string literal.
- Mutation: delete only the generated Consent contract entry. The search-contract command exits 1; the declared resource count and unsupported-resource audit both fail. Restore the entry: the combined 22 tests pass, exit 0.

# Patient paging contract

The running synthetic server image `medplum/medplum-server:5.1.30` was inspected read-only. Its bundled source map's `src/fhir/search.ts` builds offset next links at lines 673–695 by calling `getSearchUrl` with the prior offset plus count. `getSearchUrl` uses the configured FHIR R4 resource URL. Calling the installed formatter confirms its query representation:

```js
require("@medplum/core").formatSearchQuery({
  resourceType: "Patient", count: 100, offset: 100,
  sortRules: [{ code: "_id" }],
  filters: [{ code: "active", operator: "eq", value: "true" }]
})
```

Output: `?_count=100&_offset=100&_sort=_id&active=true`.

The application does not invent an offset search parameter or widen the checked-in search contract. It follows server-issued next links through `searchUrl`, using the existing `fhirSearchNextPath` check for the same origin and exact Patient resource path. The cursor wraps that validated link; query fields are restricted, and active status, page size, and ordering are reasserted. Encoded foreign-origin links return 400. Continuations stop at a complete Patient page before exceeding the row bound, preserving the next page for resumption.

## Captured mutation bundle

- [Landed guard entry and count](consent-search-contract-landed.txt).
- [Exact mutation diff](consent-search-contract-mutation.diff): delete only the generated Consent entry.
- [Complete red output](consent-search-contract-red.log): 2 passed, 3 failed, captured process exit 1. Failures are the count, unmapped Consent source search, and the missing entry during parameter validation.
- [Complete restored output](consent-search-contract-restored.log): 22 passed, 0 failed, captured process exit 0.

The exit codes were captured from each subprocess directly, before inspecting its log. The mutation was restored in a `finally` block before the green command ran. Absolute local checkout prefixes were removed from captured stack traces; assertions and counts are unchanged.

[Live next-link capture](live-next-link.log) additionally confirms a real Patient search returns the documented next-link query and that following it returns HTTP 200.
