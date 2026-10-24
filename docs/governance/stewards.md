# Area Stewards

EGC has one maintainer. Stewards are the people who own an area with him: the first reviewer on pull requests that touch it, the first triage on its issues, and the ones who keep its documentation honest. Stewardship is a role, not access: merges, releases and repository settings stay with the maintainer, and any elevated access follows the policy in [MAINTAINERS.md](../MAINTAINERS.md).

## What a steward does

- Reviews pull requests in the area when requested, with the same bar the maintainer applies: proof over claims, a test for every behavior that changes.
- Triages issues in the area: reproduces, labels, asks for what is missing, points to the fix or picks it up.
- Keeps the area's documentation and its line in [support levels](support-levels.md) truthful.
- Says when the area needs a decision only the maintainer can make.

## How someone becomes one

Sustained, merged contributions in an area, followed by an invitation from the maintainer and the person's acceptance. Invited candidates are listed here with an `invited` status and the date of the invitation; the status changes to `accepted` with the date once they accept. A steward can step down at any time by saying so.

## How the role is wired

- **Review.** [`.github/stewards.json`](../../.github/stewards.json) is the machine-readable twin of the table below, with the paths of each area. When a pull request opens, [`steward-review.yml`](../../.github/workflows/steward-review.yml) requests the review of the accepted steward of every area the changed files touch, unless the steward is the author. `tests/ci/request-steward-review.test.js` fails when the file and the table disagree, so a change to one is a change to both.
- **Triage.** A steward who accepts receives the repository's `triage` permission and nothing above it: labels, assignees and the state of issues and pull requests, no access to the code or the settings. GitHub also requires it to request the review.
- **Labels.** Issues and pull requests of an area carry its labels: `platform: windows` and `tool: opencode` for Windows and OpenCode, `area: memory` for Session Mesh, `area: installer` for Installer.

## Areas and stewards

| Area | Scope | Steward | Status |
|---|---|---|---|
| Windows and OpenCode | Windows installs, the PowerShell installer, the OpenCode adapter and plugin | [@Akisolu](https://github.com/Akisolu) | accepted 2026-09-14 |

Areas without a steward are owned by the maintainer until someone takes them on. The Session Mesh and Installer invitations of 2026-09-12 lapsed without an answer on 2026-10-24 (Discussion #1442); both areas are the maintainer's.
