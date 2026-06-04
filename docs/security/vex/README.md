# VEX Documents

This directory contains Vulnerability Exploitability eXchange (VEX) documents for EGC.

VEX documents communicate the exploitability status of known vulnerabilities in dependencies that are present in the dependency tree but are not exploitable in EGC's usage context.

## Current Status

`npm audit` reports zero known vulnerabilities in EGC's dependency tree as of 2026-06-04.

When vulnerabilities are reported in the future that do not affect EGC:
1. A VEX document will be created in OpenVEX format (`*.openvex.json`)
2. The document will include the CVE identifier, the affected package, and the non-exploitability justification
3. The document will be updated when the upstream vulnerability is resolved or when the assessment changes

## Format

VEX documents follow the [OpenVEX specification](https://github.com/openvex/spec).
