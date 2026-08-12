---
inclusion: auto
description: Core coding style rules including the minimal-change ladder, immutability, file organization, error handling, and code quality standards.
---

# Coding Style

## The Minimal-Change Ladder (CRITICAL)

Stop at the FIRST rung that truly solves the request: 1 no change (it already exists), 2 deletion, 3 one-line fix at the root cause, 4 local change, 5 extend an existing seam, 6 new unit, 7 new abstraction or dependency (justify why every lower rung failed). State the rung when the choice is not obvious. Climbing without need is overengineering; refusing to climb is a half-done fix.

The Floor (never dropped): error handling, boundary validation, tests for changed behavior, security checks, resource cleanup, documented invariants.

## Immutability (CRITICAL)

ALWAYS create new objects, NEVER mutate existing ones:

```
// Pseudocode
WRONG:  modify(original, field, value) → changes original in-place
CORRECT: update(original, field, value) → returns new copy with change
```

Rationale: Immutable data prevents hidden side effects, makes debugging easier, and enables safe concurrency.

## File Organization

MANY SMALL FILES > FEW LARGE FILES:
- High cohesion, low coupling
- 200-400 lines typical, 800 max
- Extract utilities from large modules
- Organize by feature/domain, not by type

## Error Handling

ALWAYS handle errors comprehensively:
- Handle errors explicitly at every level
- Provide user-friendly error messages in UI-facing code
- Log detailed error context on the server side
- Never silently swallow errors

## Input Validation

ALWAYS validate at system boundaries:
- Validate all user input before processing
- Use schema-based validation where available
- Fail fast with clear error messages
- Never trust external data (API responses, user input, file content)

## Code Quality Checklist

Before marking work complete:
- [ ] Code is readable and well-named
- [ ] Functions are small (<50 lines)
- [ ] Files are focused (<800 lines)
- [ ] No deep nesting (>4 levels)
- [ ] Proper error handling
- [ ] No hardcoded values (use constants or config)
- [ ] No mutation (immutable patterns used)
