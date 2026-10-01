# Maintainers

## Project Owner

| Name | GitHub | Role |
|------|--------|------|
| Felipe Marzochi | [@Fmarzochi](https://github.com/Fmarzochi) | Owner / Lead Maintainer |

## Roles and Responsibilities

### Owner / Lead Maintainer

- Final authority on technical direction and architecture decisions
- Reviews and merges pull requests to the `main` branch
- Manages GitHub repository settings, branch protection, and access controls
- Handles security vulnerability reports and coordinates disclosure
- Manages npm package publishing and GitHub releases
- Responds to issues and community inquiries

## Area Stewards

Area stewards review and triage their area without elevated access; the areas, the people and the rules are in [governance/stewards.md](governance/stewards.md).

## Access to Sensitive Resources

Access to the following resources is restricted to the project owner:

- Repository admin settings (branch protection, webhooks, secrets)
- GitHub Actions secrets and the npm trusted-publisher setting (releases publish through OIDC, so no npm token is stored)
- npm publish rights for the `@egchq/egc` package
- GitHub Security Advisories management

## Contributor Review Policy

Before any collaborator is granted write or admin access to sensitive resources:

1. The contributor must have made meaningful contributions to the project via pull requests
2. The project owner must review the contributor's history and intent
3. Permissions are granted at the minimum level required for the task
4. Access is reviewed periodically and revoked when no longer needed

This policy ensures that elevated access is never granted automatically or without explicit approval.

## Releases and Broken Versions

Releases are published only by `.github/workflows/release.yml`, from a `v*` tag, through npm trusted publishing (OIDC). No npm token is stored in the repository, and every release carries npm provenance and a GitHub build-provenance attestation that anyone can check ([Release Verification](security/RELEASE-VERIFICATION.md)).

npm never accepts a version number twice, even after `npm unpublish` ([npm unpublish policy](https://docs.npmjs.com/policies/unpublish)), so a broken release is never published again under the same number. When a published version is broken:

1. Fix the problem on `main` through a normal pull request.
2. Publish the fix as a new patch version: bump, tag, and let `release.yml` publish it.
3. From the owner's machine, with two-factor authentication, mark the broken version as deprecated and point at the fixed one:

   ```sh
   npm deprecate @egchq/egc@<broken-version> "Broken release: install <fixed-version> or later."
   ```

   Trusted publishing covers `npm publish` only, which is why deprecation runs locally and never in CI.
4. Unpublish only when a version leaks a secret or ships something harmful, and only within the window npm's policy allows. The number still cannot be reused.
