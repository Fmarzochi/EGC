# Skill Placement and Provenance Policy

This document defines where generated, imported, and curated skills belong, how they are identified, and what gets shipped.

## Skill Types and Placement

| Type | Root Path | Shipped | Provenance |
|------|-----------|---------|------------|
| Curated | `skills/` (repo) | Yes | Not required |
| Learned | `<EGC dir>/skills/learned/` | No | Required |
| Imported | `<EGC dir>/skills/imported/` | No | Required |
| Evolved | `~/.egc-learning/evolved/skills/` (global) or `~/.egc-learning/projects/<hash>/evolved/skills/` (per-project), one store for every tool | No | Inherits from instinct source |

`<EGC dir>` is the EGC directory of the tool in use, resolved by `getEGCDir()` in `scripts/lib/utils.js`: `~/.claude` in Claude Code, `~/.gemini` in Antigravity, `~/.cursor` in Cursor and so on; `~/.egc` when no tool is detected; `EGC_DIR` overrides it. Curated skills live in the repo under `skills/`. Install manifests reference only curated paths. Generated and imported skills live under the user home directory and are never shipped.

## Curated Skills

Location: `skills/<skill-name>/` with `SKILL.md` at root.

- Included in `manifests/install-modules.json` paths.
- Validated by `scripts/ci/validate-skills.js`.
- No provenance file. Use `origin` in SKILL.md frontmatter (egc, community) for attribution.

## Learned Skills

Location: `<EGC dir>/skills/learned/<skill-name>/`.

Created by continuous-learning (evaluate-session hook, /learn command). Default path is configurable via `skills/continuous-learning/config.json` → `learned_skills_path`.

- Not in repo. Not shipped.
- Must have `.provenance.json` sibling to `SKILL.md`.
- Loaded at runtime when directory exists.

## Imported Skills

Location: `~/.gemini/skills/imported/<skill-name>/`.

User-installed skills from external sources (URL, file copy, etc.). No automated importer exists yet; placement is by convention.

- Not in repo. Not shipped.
- Must have `.provenance.json` sibling to `SKILL.md`.

## Evolved Skills (Continuous Learning v2)

Location: `~/.egc-learning/evolved/skills/` (global) or `~/.egc-learning/projects/<hash>/evolved/skills/` (per-project).

- Not in repo. Not shipped.
- Provenance inherited from source instincts; no separate `.provenance.json` required.

## Provenance Metadata

Required for learned and imported skills. File: `.provenance.json` in the skill directory.

Required fields:

| Field | Type | Description |
|-------|------|-------------|
| source | string | Origin (URL, path, or identifier) |
| created_at | string | ISO 8601 timestamp |
| confidence | number | 0–1 |
| author | string | Who or what produced the skill |

Schema: `schemas/provenance.schema.json`. Validation: `scripts/lib/skill-evolution/provenance.js` → `validateProvenance`.

## Validator Behavior

### validate-skills.js

Scope: Curated skills only (`skills/` in repo).

- If `skills/` does not exist: exit 0 (nothing to validate).
- For each subdirectory: must contain `SKILL.md`, non-empty.
- Does not touch learned/imported/evolved roots.

### validate-install-manifests.js

Scope: Curated paths only. All `paths` in modules must exist in the repo.

- Generated/imported roots are out of scope. No manifest references them.
- Missing path → error. No optional-path handling.

### Scripts That Use Generated Roots

`scripts/skills-health.js`, `scripts/lib/skill-evolution/health.js`, session hooks: they probe `<EGC dir>/skills/learned` and `<EGC dir>/skills/imported`, the same directory the hooks write to (`--home`, `--learned-root` and `--imported-root` override it). Missing directories are treated as empty; no errors.

## Publishable vs Local-Only

| Publishable | Local-Only |
|-------------|------------|
| `skills/*` (curated) | `<EGC dir>/skills/learned/*` |
| | `<EGC dir>/skills/imported/*` |
| | `~/.egc-learning/**/evolved/**` |

Only curated skills appear in install manifests and get copied during install.

## Implementation Roadmap

1. Policy document and provenance schema (this change).
2. Add provenance validation to learned-skill write paths (evaluate-session, /learn output) so new learned skills always get `.provenance.json`.
3. Update instinct-cli evolve to write optional provenance when generating evolved skills.
4. Add `scripts/validate-provenance.js` to CI for any repo paths that must not contain learned/imported content (if needed).
5. Document learned/imported roots in CONTRIBUTING.md or user docs so contributors know not to commit them.
