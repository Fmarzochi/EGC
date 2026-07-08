---
name: continuous-learning
description: Automatically extract reusable patterns from Gemini Code sessions and save them as learned skills for future use.
origin: EGC
---

# Continuous Learning Skill

Automatically evaluates Gemini Code sessions on end to extract reusable patterns that can be saved as learned skills.

## When to Activate

- Setting up automatic pattern extraction from Gemini Code sessions
- Configuring the Stop hook for session evaluation
- Reviewing or curating learned skills in `~/.gemini/skills/learned/`
- Adjusting extraction thresholds or pattern categories
- Comparing v1 (this) vs v2 (instinct-based) approaches

## Status

This v1 skill is still supported, but `continuous-learning-v2` is the preferred path for new installs. Keep v1 when you explicitly want the simpler Stop-hook extraction flow or need compatibility with older learned-skill workflows.

## How It Works

This skill runs as a **Stop hook** at the end of each session:

1. **Session Evaluation**: Checks if session has enough messages (default: 10+)
2. **Pattern Detection**: Identifies extractable patterns from the session
3. **Skill Extraction**: Saves useful patterns to `~/.gemini/skills/learned/`

## Configuration

Edit `config.json` to customize:

```json
{
  "min_session_length": 10,
  "extraction_threshold": "medium",
  "auto_approve": false,
  "learned_skills_path": "~/.gemini/skills/learned/",
  "patterns_to_detect": [
    "error_resolution",
    "user_corrections",
    "workarounds",
    "debugging_techniques",
    "project_specific"
  ],
  "ignore_patterns": [
    "simple_typos",
    "one_time_fixes",
    "external_api_issues"
  ]
}
```

## Pattern Types

| Pattern | Description |
|---------|-------------|
| `error_resolution` | How specific errors were resolved |
| `user_corrections` | Patterns from user corrections |
| `workarounds` | Solutions to framework/library quirks |
| `debugging_techniques` | Effective debugging approaches |
| `project_specific` | Project-specific conventions |

## Hook Setup

Add to your `~/.gemini/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "~/.gemini/skills/continuous-learning/evaluate-session.sh"
      }]
    }]
  }
}
```

## Why Stop Hook?

- **Lightweight**: Runs once at session end
- **Non-blocking**: Doesn't add latency to every message
- **Complete context**: Has access to full session transcript

## Related

- [Felipe Marzochi](https://x.com/MarzochiFelipe) - Section on continuous learning
- `/learn` command - Manual pattern extraction mid-session

---

## Comparison Notes (Research: Jan 2025)

### vs instinct-based observation (continuous-learning-v2)

The instinct-based design in `continuous-learning-v2` takes a more granular approach:

| Feature | This skill | Instinct-based v2 |
|---------|--------------|---------------|
| Observation | Stop hook (end of session) | PreToolUse/PostToolUse hooks (100% reliable) |
| Analysis | Main context | Background agent (Haiku) |
| Granularity | Full skills | Atomic "instincts" |
| Confidence | None | 0.3-0.9 weighted |
| Evolution | Direct to skill | Instincts → cluster → skill/command/agent |
| Sharing | None | Export/import instincts |

**Why the v2 design observes through hooks:** skill-triggered observation is probabilistic, firing on only part of the relevant events, while hook-driven observation fires on every tool call. Atomic instincts with confidence scores then become the unit of learned behavior instead of whole skills.

### Potential v2 Enhancements

1. **Instinct-based learning** - Smaller, atomic behaviors with confidence scoring
2. **Background observer** - Haiku agent analyzing in parallel
3. **Confidence decay** - Instincts lose confidence if contradicted
4. **Domain tagging** - code-style, testing, git, debugging, etc.
5. **Evolution path** - Cluster related instincts into skills/commands

See: `docs/continuous-learning-v2-spec.md` for full spec.
