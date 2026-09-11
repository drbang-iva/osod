# Synthetic fixture cleanup

The initial live fixture left generated role-policy clones behind because its resource tracker did not retain references. This contaminated the subsequent base-suite environment and caused canonical-role counts to exceed one; it was introduced by this proof fixture, not established as a base product defect.

A read-only inventory identified 11 Patients whose family name was exactly `TEST-MatrixConsent`, 42 canonical-tagged policies whose compartment criteria referred exactly to those Patients, and 42 policy-linked memberships and clients. Cleanup deleted only those 42 policies, 42 memberships, and 42 clients. The 11 older Patients were left unchanged.

The corrected new fixture tracks its Patient, Practitioner, policies, clients, memberships and Consent. Its teardown searches only Consent and Provenance linked to its own Patient, then deletes the deduplicated tracked references. Teardown runs on assertion failure as well as success.

Before the corrected live rerun: 0 matching policy clones, 0 linked memberships, 0 linked clients. The live tests passed 2/2, exit 0. After teardown: the same zero counts; the original 11 Patients were unchanged. The source-mutation G9 rerun then returned 0/1, exit 1, and its restored run returned 2/2, exit 0. Full-suite execution is sequential to avoid observing temporary fixture policies.

## Rate-limit isolation correction

Sequential teardown prevented policy pollution but did not isolate shared authentication and FHIR rate limits. The new proof now requires its own `ODOS_MATRIX_BASE_URL`, `ODOS_MATRIX_ADMIN_EMAIL`, and `ODOS_MATRIX_ADMIN_PASSWORD`; it does not use the shared suite credentials. The dedicated server has independent PostgreSQL, Redis, signing keys, and synthetic account. The original suite server remains unchanged.

Configuration validation rejects the same normalized server origin and rejects loopback hostname aliases using the same effective port. A same-port alias probe failed before authentication with the expected configuration assertion. The valid dedicated run passed 2/2, exit 0. Inventory after teardown found zero proof Patients, policy clones, memberships, and clients. G9 source-removal RED and restored GREEN were recaptured against this dedicated server.
