---
name: lazy-code
description: Use this skill when writing, adding, refactoring, fixing, or reviewing code, and when choosing a library or dependency. Forces the smallest solution that actually works: question whether the task needs to exist (YAGNI), reuse what the codebase already has, reach for the standard library and native platform features before custom code and before new dependencies, one line before fifty. Also use when the user says "be lazy", "simplest solution", "minimal solution", "do less", "shortest path", or complains about over-engineering, bloat, boilerplate, or unnecessary dependencies. Supports intensity levels lite, full, and ultra. Do NOT use for non-coding requests such as research, investigation, documentation, prose, translation, or summaries, where the ruleset is pure token cost with no code to shrink.
origin: EGC
---

# Lazy Code: the smallest solution that actually works

Lazy means efficient, not careless. The best code is the code never written.

This is the deep version of the ladder in `rules/common/coding-style.md`. The rules file carries
the ladder always-on because it is short. This skill carries what does not earn always-on space:
intensity levels, the output contract, and worked examples.

## When this skill pays, and when it costs

It pays on tasks with room to over-build, where a custom component competes with a native
platform feature. Measured on real agent sessions against a real repository: 54% fewer lines in
aggregate, 22% fewer tokens, 20% lower cost, 27% less time.

The aggregate hides the shape, and the shape is the useful part. On irreducible work such as a
plain CRUD endpoint, every arm converged and the saving was roughly zero. On over-build traps it
reached 94%, because the alternative to hand-building a date picker is one native input. It never
produced more code than the baseline.

It costs, with no return, on requests that are not code. That is why this is a routed skill and
not a permanent instruction.

**Provider note that decides whether to load this at all:** the saving is not universal. On
reasoning models whose baseline output is already terse, an always-on ruleset is re-sent as input
on every call and the input overhead outweighs the lines saved, turning a 20% saving into a
26-39% loss. Load this per task, never as a standing preamble, and the inversion does not happen.

## The ladder

Stop at the first rung that holds:

1. **Does this need to exist at all?** Speculative need means skip it, and say so in one line.
2. **Already in this codebase?** Reuse the helper, util, type, or pattern that already lives
   here. Look before you write. Re-implementing what sits a few files over is the most common waste.
3. **Standard library does it?** Use it.
4. **Native platform feature covers it?** A native input control over a component library, a
   declarative style rule over scripting, a database constraint over application code.
5. **Already-installed dependency solves it?** Use it. Never add a new one for what a few lines do.
6. **Can it be one line?** One line.
7. **Only then:** the minimum code that works.

Two rungs work, take the higher one and move on. The ladder is a reflex, not a research project.

**It runs after comprehension, never instead of it.** Read the task and the code it touches, trace
the real flow end to end, then climb. A small diff you do not understand is not efficiency, it is
a confident wrong fix wearing efficiency as a costume.

**Bug fix means root cause.** A report names a symptom. Find every caller of the function you are
about to touch before editing. One guard in the shared function is a smaller diff than one guard
per caller, and fixing only the path the ticket names leaves sibling callers broken.

## Intensity

| Level | Behaviour |
|-------|-----------|
| lite  | Build what was asked, then name the lazier alternative in one line. The user picks. |
| full  | The ladder enforced. Standard library and native features first. Shortest diff, shortest explanation. Default. |
| ultra | Deletion before addition. Ship the minimal version and challenge the rest of the requirement in the same response. |

Worked example, for the request "add a cache for these API responses":

- **lite:** ships the cache, then notes that the standard library's memoization decorator covers
  this in one line if owning a cache class is not wanted.
- **full:** applies the standard library memoization decorator with a size bound. Skips the custom
  cache class, and says to add one when the built-in measurably falls short.
- **ultra:** no cache until a profiler asks for one. When it does, the built-in decorator. A
  hand-rolled expiry cache is a bug farm with a hit rate.

## Output contract

Code first. Then at most three short lines: what was skipped, and when to add it.

If the explanation runs longer than the code, delete the explanation. Every paragraph defending a
simplification is complexity smuggled back in as prose.

Explanation the user explicitly asked for, such as a report, a walkthrough, or per-phase notes, is
not debt. Give it in full. The rule is only against unrequested prose.

A complex request gets the lazy version and the question in the same response, never a stall:
build the smaller thing, then ask whether the larger thing is actually needed.

## Never simplified away

Input validation at trust boundaries, error handling that prevents data loss, security controls,
authorization checks, accessibility basics, the calibration real hardware needs, and anything the
user explicitly asked to keep. If the user insists on the full version, build it without re-arguing.

Non-trivial logic leaves one runnable check behind: the smallest thing that fails if the logic
breaks. No frameworks, no fixtures, no per-function suites unless asked. Trivial one-liners need
no test, YAGNI applies to tests too.

This list is not decoration. In the benchmark this skill derives from, the arm given only "prefer
one-liner solutions" wrote the fewest lines and was the only arm to let a path-traversal input
escape its base directory. The three lines it saved were the check. That is the entire difference
between lazy and careless.

## Attribution

The ladder, the intensity levels, and the never-simplify list are adapted from
[ponytail](https://github.com/DietrichGebert/ponytail) by Dietrich Gebert, MIT licensed. The
benchmark figures cited here are from that project's published agentic evaluation. Adapted for
EGC to be routed per task rather than always-on, which is what keeps the saving from inverting on
non-Claude reasoning models.
