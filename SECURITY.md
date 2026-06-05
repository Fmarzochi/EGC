# Security Policy

## Supported Versions

| Version | Supported |
| :--- | :--- |
| 1.0.x | Yes |

## Reporting a Vulnerability

Do not open public GitHub issues for security vulnerabilities.

Use GitHub's private vulnerability reporting:
https://github.com/Fmarzochi/EGC/security/advisories/new

Alternatively, email [fmarzochi@gmail.com](mailto:fmarzochi@gmail.com).

Include in your report:
- A description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Potential impact

## Response Timeline

- Acknowledgment: within 72 hours
- Status update: within 14 days
- Resolution or mitigation: within 90 days of confirmed vulnerability

## Scope

This policy covers the `EGC` repository, including:

- Core runtime scripts (`scripts/`)
- MCP server sources (`mcp/servers/`)
- Installation scripts (`install.sh`, `install.ps1`)
- Hook and skill definitions (`hooks/`, `skills/`)

## Out of Scope

The following are not treated as vulnerabilities under this policy:

- Vulnerabilities in third-party dependencies (report upstream)
- Issues requiring physical access to the host machine
- Denial-of-service against a local-only runtime with no network exposure
- Behaviors that require the reporter to already have write access to the host

## Secrets and Credentials Policy

Secrets and credentials used by the project are managed as follows:

- **Storage:** All secrets (e.g., `NPM_TOKEN`, `GITHUB_TOKEN`) are stored exclusively as GitHub Actions repository secrets. They are never committed to the repository or stored in plain text on disk.
- **Access:** Only the project owner has access to configure repository secrets. GitHub Actions workflows access secrets only via the `secrets.*` context, scoped to the specific job that needs them.
- **Rotation:** Secrets are rotated immediately upon suspected or confirmed compromise. NPM tokens are rotated after each publishing workflow as a best practice when feasible.
- **Scope:** Secrets are scoped to the minimum necessary permissions. The `NPM_TOKEN` is scoped to publish only. The `GITHUB_TOKEN` is granted only the permissions declared in each workflow's `permissions:` block.
- **Audit:** Secret usage is visible in the GitHub Actions run logs (values are masked). Any addition of new secrets requires maintainer approval.

## Additional Resources

- [Threat Model](docs/security/THREAT-MODEL.md)
- [Security Assessment](docs/security/SECURITY-ASSESSMENT.md)
- [Release Verification](docs/security/RELEASE-VERIFICATION.md)
- [SCA Policy](docs/security/SCA-POLICY.md)
