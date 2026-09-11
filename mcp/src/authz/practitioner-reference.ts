import type { PractitionerRole } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";

export async function resolvePractitionerReference(
  fhir: Pick<MedplumClient, "read">,
  staffReference: string,
): Promise<string | undefined> {
  if (/^Practitioner\/[A-Za-z0-9.-]{1,64}$/.test(staffReference)) {
    return staffReference;
  }
  const roleId = staffReference.match(/^PractitionerRole\/([A-Za-z0-9.-]{1,64})$/)?.[1];
  if (!roleId) {
    return undefined;
  }
  const role = await fhir.read<PractitionerRole>("PractitionerRole", roleId);
  return /^Practitioner\/[A-Za-z0-9.-]{1,64}$/.test(role.practitioner?.reference ?? "")
    ? role.practitioner?.reference
    : undefined;
}
