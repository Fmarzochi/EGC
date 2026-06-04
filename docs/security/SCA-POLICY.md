# Software Composition Analysis (SCA) Policy

## Purpose

This policy defines how EGC identifies, tracks, and remediates vulnerabilities and license issues in its dependencies.

## Tooling

| Tool | Function |
|------|----------|
| Dependabot | Automated alerts and PRs for dependency vulnerabilities |
| `dependency-review.yml` | Blocks PRs that introduce high or critical severity dependencies |
| `npm audit` | Run in CI on every push; fails on high/critical findings |

## Vulnerability Remediation Thresholds

| Severity | Maximum Time to Remediate |
|----------|--------------------------|
| Critical | 7 days |
| High | 14 days |
| Moderate | 90 days |
| Low / Info | Best effort; addressed in scheduled dependency updates |

## Release Gate

No release may proceed if `npm audit` reports any `high` or `critical` vulnerability in the dependency tree. The CI release workflow enforces this check automatically.

PRs that introduce new dependencies with known vulnerabilities are automatically blocked by `dependency-review.yml` before they can be merged.

## License Policy

Dependencies must use licenses compatible with MIT (the project license). The following license families are acceptable:

- MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, CC0-1.0, 0BSD

Licenses requiring copyleft propagation (GPL, LGPL, AGPL) are not permitted without explicit maintainer approval.

## Suppression of Non-Exploitable Findings

If a vulnerability is known to affect a dependency but is not exploitable in EGC's usage context, the finding may be suppressed via:

1. A documented entry in this file, or
2. A VEX (Vulnerability Exploitability eXchange) document at `docs/security/vex/`

Any suppression must include the CVE identifier, the reason for non-exploitability, and a review date.

## SAST (Static Analysis Security Testing) Policy

| Tool | Scope | Failure Threshold |
|------|-------|------------------|
| CodeQL | JavaScript/TypeScript security queries | Any high/critical finding blocks merge |
| ESLint | Code quality and security-adjacent rules | Any error blocks merge |

SAST checks run automatically on every pull request and push to `main`. A PR cannot be merged if any SAST check fails, except when a finding is explicitly assessed as a false positive and documented in the suppression list in this file.

### SAST Remediation Thresholds

| Severity | Action |
|----------|--------|
| Critical / High | Block merge; fix required before the PR can land |
| Medium | Fix required within 30 days of the finding |
| Low / Informational | Best effort; tracked as backlog |

## Compliance

All changes to the codebase are automatically evaluated by the SCA checks listed above. PRs cannot be merged if the `dependency-review` check fails. This policy is enforced as a required status check in the branch protection rules.
