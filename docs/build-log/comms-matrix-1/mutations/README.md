# Communication matrix mutation evidence

Author verification only; these results are not an independent evaluation. Each mutation was restored before its green check. Source paths in captured output are repository-relative.

| Guard | Exact mutation | Red | Restored green | Evidence |
|---|---|---|---|---|
| G1a | Move purpose/preference withholding before the opt-out check. | 8/9 passed; exit 1 | 9/9 passed; exit 0 | [proof](G1a-proof.log) · [red](G1a-red.log) · [green](G1a-green.log) · [diff](G1a-mutation.diff) |
| G1b | Insert explicit-ON early return before suppression. This is an unsafe precedence regression, not an unreachable return after suppression. | 7/9 passed; exit 1 | 9/9 passed; exit 0 | [proof](G1b-proof.log) · [red](G1b-red.log) · [green](G1b-green.log) · [diff](G1b-mutation.diff) |
| G2 | Broaden the writer predicate to the communications URL prefix, dropping opt-out extensions while replacing cells. | 7/8 passed; exit 1 | 8/8 passed; exit 0 | [proof](G2-proof.log) · [red](G2-red.log) · [green](G2-green.log) · [diff](G2-mutation.diff) |
| G3 | Resolve explicit cells before suppression by skipping the opt-out branch for an explicit pair. | 8/9 passed; exit 1 | 9/9 passed; exit 0 | [proof](G3-proof.log) · [red](G3-red.log) · [green](G3-green.log) · [diff](G3-mutation.diff) |
| G4 | Delete appointment-reminder from the campaign-purpose map. Eight reminder-engine cases also fail. | 11/20 passed; exit 1 | 20/20 passed; exit 0 | [proof](G4-proof.log) · [red](G4-red.log) · [green](G4-green.log) · [diff](G4-mutation.diff) |
| G5 | Delete the preference registry entry; preflight reports three hard blocks instead of zero. | 3 hard blocks; exit 1 | 0 hard blocks; exit 0 | [proof](G5-proof.log) · [red](G5-red.log) · [green](G5-green.log) |
| G6 | Remove the preference-management action from the staff role; the successful PUT case becomes 403. | 0/1 passed; exit 1 | 1/1 passed; exit 0 | [proof](G6-proof.log) · [red](G6-red.log) · [green](G6-green.log) · [diff](G6-mutation.diff) |
| G7 | Hardcode the worker recorded-suppression hold reason to patient-opt-out. | 25/26 passed; exit 1 | 26/26 passed; exit 0 | [proof](G7-proof.log) · [red](G7-red.log) · [green](G7-green.log) |
| G8 | Remove preference-withheld from the stored enrollment outcome parser. | 3/4 passed; exit 1 | 4/4 passed; exit 0 | [proof](G8-proof.log) · [red](G8-red.log) · [green](G8-green.log) |
| G9 | Remove only PATIENT_COMMS_CONSENT_RULE from ROLE_REGISTRY.staff.resourceRules; the isolated evidence HTTP request becomes 403. | 0/1 passed; exit 1 | 2/2 passed; exit 0 | [proof](G9-proof.log) · [red](G9-red.log) · [green](G9-green.log) · [restored proof](G9-restored-proof.log) · [diff](G9-mutation.diff) |
| G10 | Remove the email-only condition from the staff education override. | 8/9 passed; exit 1 | 9/9 passed; exit 0 | [proof](G10-proof.log) · [red](G10-red.log) · [green](G10-green.log) · [diff](G10-mutation.diff) |
| G11 | Return from the staff email override before suppression. | 8/9 passed; exit 1 | 9/9 passed; exit 0 | [proof](G11-proof.log) · [red](G11-red.log) · [green](G11-green.log) · [diff](G11-mutation.diff) |
| G12 | Skip the post-send withheld-cell flip. | 0/1 passed; exit 1 | 1/1 passed; exit 0 | [proof](G12-proof.log) · [red](G12-red.log) · [green](G12-green.log) · [diff](G12-mutation.diff) |
| G13 | Add marketing-promo to the START cell set. | 1/3 passed; exit 1 | 3/3 passed; exit 0 | [proof](G13-proof.log) · [red](G13-red.log) · [green](G13-green.log) · [diff](G13-mutation.diff) |
| G14a | Disable the shared-number START refusal before writes. | 2/3 passed; exit 1 | 3/3 passed; exit 0 | [proof](G14a-proof.log) · [red](G14a-red.log) · [green](G14a-green.log) · [diff](G14a-mutation.diff) |
| G14b | Allow START cell writes despite a remaining global opt-out. | 2/3 passed; exit 1 | 3/3 passed; exit 0 | [proof](G14b-proof.log) · [red](G14b-red.log) · [green](G14b-green.log) · [diff](G14b-mutation.diff) |
| G15 | Bypass only the preference cell writer when constructing the registration Patient. | 24/25 passed; exit 1 | 25/25 passed; exit 0 | [proof](G15-proof.log) · [red](G15-red.log) · [green](G15-green.log) · [diff](G15-mutation.diff) |
| G16 | Restore the channel-independent legacy marketing check. | 8/9 passed; exit 1 | 9/9 passed; exit 0 | [proof](G16-proof.log) · [red](G16-red.log) · [green](G16-green.log) · [diff](G16-mutation.diff) |
| G17 | Delete the SMS legacy-marketing-consent clause. | 8/9 passed; exit 1 | 9/9 passed; exit 0 | [proof](G17-proof.log) · [red](G17-red.log) · [green](G17-green.log) · [diff](G17-mutation.diff) |
| G18 | Catch malformed preference parsing and substitute an empty explicit-cell list. | 7/9 passed; exit 1 | 9/9 passed; exit 0 | [proof](G18-proof.log) · [red](G18-red.log) · [green](G18-green.log) · [diff](G18-mutation.diff) |
| G19 | Rethrow an ordinary flip failure; HTTP 502 replaces the sent response. | 0/1 passed; exit 1 | 1/1 passed; exit 0 | [proof](G19-proof.log) · [red](G19-red.log) · [green](G19-green.log) · [diff](G19-mutation.diff) |
| G19b | Rethrow a flip conflict; HTTP 409 replaces the sent response. | 0/1 passed; exit 1 | 1/1 passed; exit 0 | [proof](G19b-proof.log) · [red](G19b-red.log) · [green](G19b-green.log) · [diff](G19b-mutation.diff) |
| G20 | Skip the registration preference permission check; unauthorized input reaches FHIR. | 24/25 passed; exit 1 | 25/25 passed; exit 0 | [proof](G20-proof.log) · [red](G20-red.log) · [green](G20-green.log) · [diff](G20-mutation.diff) |
| G21 | Rename transaction validator status property to statusRemoved; HTTP 502 replaces 409. | 0/1 passed; exit 1 | 1/1 passed; exit 0 | [proof](G21-proof.log) · [red](G21-red.log) · [green](G21-green.log) · [diff](G21-mutation.diff) |

## Commands

- G1a: `npm --prefix mcp test -- tests/commsPreferences.test.ts`
- G1b: `npm --prefix mcp test -- tests/commsPreferences.test.ts`
- G2: `npm --prefix mcp test -- tests/commsEvidence.test.ts`
- G3: `npm --prefix mcp test -- tests/commsPreferences.test.ts`
- G4: `npm --prefix mcp test -- tests/commsPreferences.test.ts tests/reminderEngine.test.ts`
- G10: `npm --prefix mcp test -- tests/commsPreferences.test.ts`
- G11: `npm --prefix mcp test -- tests/commsPreferences.test.ts`
- G12: `npm --prefix mcp test -- '--test-name-pattern=^G12 ' tests/commsApi.test.ts`
- G13: `npm --prefix mcp test -- tests/commsStartPreferences.test.ts`
- G14a: `npm --prefix mcp test -- tests/commsStartPreferences.test.ts`
- G14b: `npm --prefix mcp test -- tests/commsStartPreferences.test.ts`
- G15: `npm --prefix mcp test -- tests/patientRegistrationAuthz.test.ts`
- G16: `npm --prefix mcp test -- tests/commsPreferences.test.ts`
- G17: `npm --prefix mcp test -- tests/commsPreferences.test.ts`
- G18: `npm --prefix mcp test -- tests/commsPreferences.test.ts`
- G19: `npm --prefix mcp test -- '--test-name-pattern=^G19 ' tests/commsApi.test.ts`
- G19b: `npm --prefix mcp test -- '--test-name-pattern=^G19b ' tests/commsApi.test.ts`
- G20: `npm --prefix mcp test -- tests/patientRegistrationAuthz.test.ts`
- G7: `npm --prefix mcp test -- tests/educationSequenceWorker.test.ts`
- G8: `npm --prefix mcp test -- tests/educationEnrollment.test.ts`

## Originating run records

G6: `npx tsx --test --test-name-pattern='G2 preferences PUT all twenty ON' mcp/tests/commsPreferencesRoutes.test.ts`. The staff preference-management action was removed, the test returned exit 1, and the source was restored in `finally`.

G21: `npx tsx --test --test-name-pattern='G21 preference PUT optimistic conflict' mcp/tests/commsPreferencesRoutes.test.ts`. The validator's `status` property was renamed to `statusRemoved`, the test returned exit 1, and the source was restored in `finally`.

Both then passed the shared restored command `npm --prefix mcp test -- tests/commsPreferencesRoutes.test.ts tests/commsEvidence.test.ts`: 17/17, exit 0. [Restored output](G6-G21-restored-routes.log). These are reported as a shared restored suite, not individual one-test reruns.

G9: with the isolated synthetic-stack environment loaded privately, `node --import tsx --test '--test-name-pattern=isolated evidence HTTP route' mcp/tests/commsConsentLive.test.ts` returned exit 1. Removing the staff rule was confirmed by searching `PATIENT_COMMS_CONSENT_RULE`: the definition and provider/admin references remained, while the staff entry was absent. After restoration, the staff reference was present again. `npm --prefix mcp test -- tests/commsConsentLive.test.ts` passed 2/2, exit 0, with no skipped tests. The rerun retained raw landed-search and restored-search transcripts, the exact mutation diff, and exit statuses.

## Registry and fixture guard follow-up

G5 was rerun with `npx tsx scripts/preflight-lint.ts`. Deleting only the preference registry entry was confirmed by `rg` exit 1; preflight returned three hard blocks, exit 1. After exact restoration, preflight returned zero hard blocks, exit 0. [Exact mutation](G5-mutation.diff) · [captured statuses](G5-result.json).

The criteria-scoped inventory gains exactly `Consent`, derived from the generated role policies; its count increases from 29 to 30. The reordered admin policy fixture now carries `writeConstraint` without changing either canonical comparison assertion.

| Guard demonstration | Command | Red | Restored green | Evidence |
|---|---|---|---|---|
| Remove new Consent inventory entry | `npm --prefix mcp test -- ../tests/preflight/fhir-read-grant-check.test.ts` | 13/14 passed; exit 1 | 14/14 passed; exit 0 | [proof](inventory-proof.log) · [full output](inventory-red.log) · [green](inventory-green.log) · [diff](inventory-mutation.diff) |
| Drop writeConstraint from rebuilt rule | `npm --prefix mcp test -- ../tests/setup-wizard/access-policy-rules.test.ts` | 2/3 passed; exit 1 | 3/3 passed; exit 0 | [proof](constraint-proof.log) · [full output](constraint-red.log) · [green](constraint-green.log) · [diff](constraint-mutation.diff) |

G6 was rerun individually with `npm --prefix mcp test -- '--test-name-pattern=^G2 preferences PUT all twenty ON' tests/commsPreferencesRoutes.test.ts`: 0/1, exit 1; restored 1/1, exit 0. Its raw landed-search proof, exact diff, and captured statuses now accompany the outputs.

G21 was rerun individually with `npm --prefix mcp test -- '--test-name-pattern=^G21 preference PUT optimistic conflict' tests/commsPreferencesRoutes.test.ts`: 0/1, exit 1; restored 1/1, exit 0. Raw landed-search proof, exact diff, and captured statuses accompany both outputs.
