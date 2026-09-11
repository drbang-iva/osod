export const MEDPLUM_SEARCH_PARAMETER_SOURCE = {
  package: "@medplum/definitions",
  version: "5.1.8",
  integrity: "sha512-4MhFqiKIPlazkA5Ul8khPtMa1ryD9n7+LP8FDsgIu4kTshOr5Gv+aUONXsDIpQvU8QYwPmgRMwzdVZGXkUAOBQ==",
  files: [
    "fhir/r4/search-parameters.json",
    "fhir/r4/search-parameters-medplum.json",
    "fhir/r4/search-parameters-uscore.json",
  ],
} as const;

export const MEDPLUM_5_1_8_SEARCH_PARAMETERS = {
  AccessPolicy: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text name".split(" "),
  AllergyIntolerance: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text asserter category clinical-status code criticality date identifier last-date manifestation onset patient recorder route severity type verification-status".split(" "),
  Appointment: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text actor appointment-type based-on date end identifier location part-status patient practitioner reason-code reason-reference service-category service-type slot specialty status supporting-info".split(" "),
  AuditEvent: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text action address agent agent-name agent-role altid date entity entity-name entity-role entity-type outcome patient policy site source subtype type".split(" "),
  Basic: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text author code created identifier patient subject".split(" "),
  CarePlan: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text activity-code activity-date activity-reference based-on care-team category condition date encounter goal identifier instantiates-canonical instantiates-uri intent part-of patient performer replaces status subject".split(" "),
  ChargeItem: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text account code context entered-date enterer factor-override identifier occurrence patient performer-actor performer-function performing-organization price-override quantity requesting-organization service subject".split(" "),
  ChargeItemDefinition: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text context context-quantity context-type context-type-quantity context-type-value date description effective identifier jurisdiction publisher status title url version".split(" "),
  Claim: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text care-team created detail-udi encounter enterer facility identifier insurer item-udi patient payee priority procedure-udi provider status subdetail-udi use".split(" "),
  ClaimResponse: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text created disposition identifier insurer outcome patient payment-date request requestor status use".split(" "),
  Communication: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text based-on category encounter identifier instantiates-canonical instantiates-uri medium part-of patient priority priority-order received recipient sender sent status subject topic".split(" "),
  Condition: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text abatement-age abatement-date abatement-string asserted-date asserter body-site category clinical-status code encounter evidence evidence-detail identifier onset-age onset-date onset-info patient recorded-date severity stage subject verification-status".split(" "),
  Consent: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text action actor category consentor data date identifier organization patient period purpose scope security-label source-reference status".split(" "),
  Coverage: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text beneficiary class-type class-value dependent identifier patient payor policy-holder status subscriber type".split(" "),
  DiagnosticReport: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text based-on category code conclusion date encounter identifier issued media patient performer result results-interpreter specimen status study subject".split(" "),
  DocumentReference: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text authenticator author category contenttype custodian date description encounter event facility format identifier language location patient period related relatesto relation relationship security-label setting status subject type".split(" "),
  Encounter: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text account appointment based-on class date diagnosis discharge-disposition episode-of-care identifier length location location-period part-of participant participant-type patient practitioner reason-code reason-reference service-provider special-arrangement status subject type".split(" "),
  EpisodeOfCare: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text care-manager condition date identifier incoming-referral organization patient status type".split(" "),
  Goal: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text achievement-status category description identifier lifecycle-status patient start-date subject target-date".split(" "),
  HealthcareService: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text active characteristic coverage-area endpoint identifier location name organization program service-category service-type specialty".split(" "),
  Invoice: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text account date identifier issuer participant participant-role patient recipient status subject totalgross totalnet type".split(" "),
  Location: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text address address-city address-country address-postalcode address-state address-use endpoint identifier name near operational-status organization partof physical-type status type".split(" "),
  Media: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text based-on created device encounter identifier modality operator patient site status subject type view".split(" "),
  MedicationRequest: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text authoredon category code date encounter identifier intended-dispenser intended-performer intended-performertype intent medication patient priority priority-order requester status subject".split(" "),
  MedicationStatement: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text category code context effective identifier medication part-of patient source status subject".split(" "),
  Observation: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text based-on category code code-value-concept code-value-date code-value-quantity code-value-string combo-code combo-code-value-concept combo-code-value-quantity combo-data-absent-reason combo-value-concept combo-value-quantity component-code component-code-value-concept component-code-value-quantity component-data-absent-reason component-value-concept component-value-quantity data-absent-reason date derived-from device encounter focus has-member identifier method part-of patient performer specimen status subject value-concept value-date value-quantity value-string".split(" "),
  Organization: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text active address address-city address-country address-postalcode address-state address-use endpoint identifier name partof phonetic type".split(" "),
  Patient: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text active address address-city address-country address-postalcode address-state address-use birthdate death-date deceased email ethnicity family gender gender-identity general-practitioner given identifier language link name organization phone phonetic race telecom".split(" "),
  PaymentReconciliation: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text created disposition identifier outcome payment-issuer request requestor status".split(" "),
  PlanDefinition: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text composed-of date definition depends-on derived-from description effective identifier jurisdiction name predecessor publisher status successor title topic type url version".split(" "),
  Practitioner: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text active address address-city address-country address-postalcode address-state address-use communication email family gender given identifier name phone phonetic qualification-code qualification-davinci-pdex-where-valid telecom".split(" "),
  PractitionerRole: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text active date email endpoint identifier location organization phone practitioner role service specialty telecom".split(" "),
  Procedure: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text based-on category code date encounter identifier instantiates-canonical instantiates-uri location part-of patient performer reason-code reason-reference status subject".split(" "),
  Provenance: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text agent agent-role agent-type entity location patient recorded signature-type target when".split(" "),
  QuestionnaireResponse: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text author authored based-on encounter identifier part-of patient questionnaire source status subject".split(" "),
  Schedule: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text active actor date identifier service-category service-type specialty".split(" "),
  ServiceRequest: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text authored based-on body-site category code encounter identifier instantiates-canonical instantiates-uri intent occurrence order-detail patient performer performer-type priority priority-order reason-code replaces requester requisition specimen status subject".split(" "),
  Task: "_content _count _id _lastUpdated _profile _query _security _sort _source _tag _text authored-on based-on business-status code due-date encounter focus group-identifier identifier intent modified owner part-of patient performer period priority priority-order requester status subject".split(" "),
} as const;

export type ContractResourceType = keyof typeof MEDPLUM_5_1_8_SEARCH_PARAMETERS;

export const MEDPLUM_5_1_8_CHAINED_SEARCH_PARAMETERS = {
  PractitionerRole: ["practitioner.name"],
} as const;

export const FHIR_R4_SEARCH_RESULT_PARAMETERS = ["_summary"] as const;

export function invalidSearchParameterKeys(
  resourceType: ContractResourceType,
  parameterKeys: Iterable<string>,
): string[] {
  const allowed = new Set<string>([
    ...MEDPLUM_5_1_8_SEARCH_PARAMETERS[resourceType],
    ...FHIR_R4_SEARCH_RESULT_PARAMETERS,
  ]);
  const allowedChains = new Set<string>(
    resourceType === "PractitionerRole"
      ? MEDPLUM_5_1_8_CHAINED_SEARCH_PARAMETERS.PractitionerRole
      : [],
  );
  return [...parameterKeys]
    .filter((key) => {
      const parameter = key.split(":", 1)[0];
      return !allowed.has(parameter) && !allowedChains.has(parameter);
    })
    .sort();
}

export function assertSearchParameterKeys(
  resourceType: ContractResourceType,
  parameterKeys: Iterable<string>,
): void {
  const invalid = invalidSearchParameterKeys(resourceType, parameterKeys);
  if (invalid.length > 0) {
    throw new Error(
      `Medplum 5.1.8 rejects ${invalid.map((key) => `${resourceType}?${key}`).join(", ")}`,
    );
  }
}
