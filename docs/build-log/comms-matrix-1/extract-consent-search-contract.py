"""Verify the pinned package and generate the Consent search-contract entry."""
import base64
import hashlib
import json
import pathlib
import re
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
contract = pathlib.Path("mcp/tests/search-param-contract.ts")
source = contract.read_text()
expected = re.search(r'integrity: "([^"]+)"', source).group(1)
actual = "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
assert actual == expected, "Pinned package integrity mismatch"
files = ["search-parameters.json", "search-parameters-medplum.json", "search-parameters-uscore.json"]
codes = set()
with tarfile.open(archive) as package:
    for name in files:
        bundle = json.load(package.extractfile("package/dist/fhir/r4/" + name))
        selected = [entry["resource"] for entry in bundle["entry"]
                    if set(entry["resource"].get("base", [])) & {"Resource", "DomainResource", "Consent"}]
        codes.update(resource["code"] for resource in selected)
        print(name + ": " + str(len(selected)) + " applicable parameters")
# These query controls are present in every existing resource contract.
existing = re.search(r'  Patient: "([^"]+)"', source).group(1).split()
controls = {"_count", "_sort"}
assert controls.issubset(existing)
codes.update(controls)
assert {"patient", "category", "status", "_count"}.issubset(codes)
line = '  Consent: "' + " ".join(sorted(codes)) + '".split(" "),\n'
assert "  Consent:" not in source, "Consent contract already exists"
source = source.replace("  Coverage:", line + "  Coverage:")
contract.write_text(source)
print("Integrity verified: " + actual)
print(line.strip())
