# Coding Style

## Immutability (CRITICAL)

ALWAYS create new objects, NEVER mutate existing ones:

```
// Pseudocode
WRONG:  modify(original, field, value) → changes original in-place
CORRECT: update(original, field, value) → returns new copy with change
```

Rationale: Immutable data prevents hidden side effects, makes debugging easier, and enables safe concurrency.

## The Ladder (decide BEFORE writing)

KISS, DRY, and YAGNI below say *what* to value. The ladder says *when to stop*. Run it
before writing code, and stop at the first rung that holds:

1. Does this need to be built at all? Speculative need means skip it, and say so in one line.
2. Does it already exist in this codebase? A helper, util, type, or pattern already here gets
   reused, not re-written. Re-implementing what lives a few files over is the most common waste.
3. Does the standard library do this? Use it.
4. Does a native platform feature cover it? A native input control over a component library,
   a declarative style rule over scripting, a database constraint over application code.
5. Does an already-installed dependency solve it? Use it. Never add a new dependency for what
   a few lines can do.
6. Can it be one line? Make it one line.
7. Only then: write the minimum code that works.

The ladder runs **after** you understand the problem, never instead of it. Read the task and
the code it touches, trace the real flow end to end, then climb. The smallest change in the
wrong place is not efficient, it is a second bug.

**Precedence:** the ladder decides *whether and how much* code gets written. Every other rule
in this file decides *what that code looks like once it exists*. They do not compete: a rung
that says "do not build it" ends the question, and once you are writing, the style rules below
are binding in full.

**Bug fix means root cause, not symptom.** A report names a symptom. Before editing, find every
caller of the function you are about to touch. One guard in the shared function is a smaller
diff than one guard per caller, and patching only the path the ticket names leaves sibling
callers broken.

**Mark deliberate shortcuts.** A simplification that cuts a real corner with a known ceiling
(a global lock, a quadratic scan, a naive heuristic) gets a comment naming the ceiling and the
upgrade path, so the next reader inherits the decision instead of the mystery.

## Core Principles

### KISS (Keep It Simple)

- Prefer the simplest solution that actually works
- Avoid premature optimization
- Optimize for clarity over cleverness

### DRY (Don't Repeat Yourself)

- Extract repeated logic into shared functions or utilities
- Avoid copy-paste implementation drift
- Introduce abstractions when repetition is real, not speculative

### YAGNI (You Aren't Gonna Need It)

- Do not build features or abstractions before they are needed
- Avoid speculative generality
- Start simple, then refactor when the pressure is real

## File Organization

MANY SMALL FILES > FEW LARGE FILES:
- High cohesion, low coupling
- 200-400 lines typical, 800 max
- Extract utilities from large modules
- Organize by feature/domain, not by type

**This governs existing structure, not new work.** The two are easy to read as contradictory,
so the split is explicit: a change adds the fewest files it can, and an existing file is split
once it actually crosses the threshold above. Scattering a small change across several new
files to look modular is the failure mode this rule does not license. Splitting an 800-line
module that genuinely grew is the one it requires.

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

## Never Simplified Away

The ladder shortens the solution. It never shortens this list, and "it was one line" is not a
defence for anything below:

- Input validation at trust boundaries (see Input Validation above)
- Error handling that prevents data loss (see Error Handling above)
- Security controls and authorization checks
- Accessibility basics
- Calibration that real hardware needs, because a physical clock drifts and a physical sensor
  reads off, and a minimal model cannot see that
- Anything the user explicitly asked to keep. If the user wants the full version, build it and
  do not re-argue.

Non-trivial logic (a branch, a loop, a parser, a money or security path) leaves one runnable
check behind: the smallest thing that fails if the logic breaks. Trivial one-liners need none,
YAGNI applies to tests too.

This list exists because "prefer shorter code" without it measurably drops guards: in the
benchmark this ladder is derived from, the arm given only "prefer one-liner solutions" wrote
the fewest lines and was the only one to let a path-traversal input escape its base directory.
The lines it saved were the check.

## Naming Conventions

- Variables and functions: `camelCase` with descriptive names
- Booleans: prefer `is`, `has`, `should`, or `can` prefixes
- Interfaces, types, and components: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Custom hooks: `camelCase` with a `use` prefix

## Code Smells to Avoid

### Deep Nesting

Prefer early returns over nested conditionals once the logic starts stacking.

### Magic Numbers

Use named constants for meaningful thresholds, delays, and limits.

### Long Functions

Split large functions into focused pieces with clear responsibilities.

## Code Quality Checklist

Before marking work complete:
- [ ] Code is readable and well-named
- [ ] Functions are small (<50 lines)
- [ ] Files are focused (<800 lines)
- [ ] No deep nesting (>4 levels)
- [ ] Proper error handling
- [ ] No hardcoded values (use constants or config)
- [ ] No mutation (immutable patterns used)
