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

## Access to Sensitive Resources

Access to the following resources is restricted to the project owner:

- Repository admin settings (branch protection, webhooks, secrets)
- GitHub Actions secrets (`NPM_TOKEN`, `GITHUB_TOKEN`)
- npm publish rights for the `egc-universal` package
- GitHub Security Advisories management

## Contributor Review Policy

Before any collaborator is granted write or admin access to sensitive resources:

1. The contributor must have made meaningful contributions to the project via pull requests
2. The project owner must review the contributor's history and intent
3. Permissions are granted at the minimum level required for the task
4. Access is reviewed periodically and revoked when no longer needed

This policy ensures that elevated access is never granted automatically or without explicit approval.
