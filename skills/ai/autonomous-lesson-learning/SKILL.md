---
name: autonomous-lesson-learning
description: "Autonomous loop that learns while it runs: recalls stored lessons before each iteration, saves new lessons on failures and wins, and reinforces known lessons instead of repeating mistakes. Orchestrates continuous-agent-loop patterns with the egc-memory lesson tools."
origin: EGC
---

# Autonomous Lesson Learning

Run an autonomous work loop that gets smarter every iteration. This skill is pure orchestration: it combines the loop patterns from `continuous-agent-loop` / `autonomous-loops` with the `lesson_recall`, `lesson_save`, and `lesson_reinforce` tools from the `egc-memory` MCP server. It does not reimplement loops and it does not add a new lesson store.

Works in any harness that has the `egc-memory` MCP server registered (all EGC Tier 1/2/3 targets). Nothing here is platform-specific: the loop is plain instruction-following and the memory calls are standard MCP tool calls.

## When to Activate

- Running a long multi-iteration task autonomously (fix all lint errors, raise coverage, burn down an issue list) where repeating a known mistake is expensive
- Resuming a class of work that has failed before and the failure modes are worth remembering across sessions
- Any `continuous-agent-loop` pattern (Sequential Pipeline, Continuous PR Loop) where you also want cross-session learning

Use a plain loop (`/loop-start`, `continuous-agent-loop`) instead when the task is one-off, trivial, or exploratory throwaway work where lessons would be noise.

## The Cycle

```text
+--------------------------------------------------------+
|  AUTONOMOUS LESSON LEARNING ITERATION                  |
|                                                        |
|  1. RECALL   lesson_recall({ query }) for the current  |
|              step BEFORE acting                        |
|  2. APPLY    adjust the plan using recalled lessons;   |
|              lesson_reinforce({ id }) each lesson that |
|              proved relevant                           |
|  3. ACT      execute one loop iteration (implement,    |
|              test, fix) per continuous-agent-loop      |
|  4. RECORD                                             |
|     - failure -> known lesson matches?                 |
|         yes -> lesson_reinforce({ id })                |
|         no  -> lesson_save({ content, context })       |
|     - new pattern that worked well?                    |
|         -> lesson_save with prescriptive wording       |
|  5. CHECK    stop condition met? done : goto 1         |
+--------------------------------------------------------+
```

### 1. Recall before acting

At the start of every iteration, query stored lessons for the area you are about to touch:

```
lesson_recall({ query: "flaky playwright timeout", limit: 5 })
```

`lesson_recall` searches content, context, and tags, and returns lessons ranked by confidence (default floor 0.2). Read the results and adjust the plan before executing. Skipping this step defeats the purpose of the skill.

### 2. Reinforce what proved relevant

When a recalled lesson applies to the current iteration, or a mistake it describes recurs, reinforce it by the `id` field returned from `lesson_recall`:

```
lesson_reinforce({ id: "<lesson id from lesson_recall>" })
```

Reinforcement raises confidence by 0.15 (capped at 1.0) and un-archives decayed lessons. Never save a duplicate lesson for a pattern that already exists: recall first, reinforce on match, save only on miss.

### 3. Save on failure

When an action fails during the loop (a command errors, a test breaks, a fix has to be redone), record what went wrong and why, with a `context` that says where it applies:

```
lesson_save({
  content: "npm test hangs when the dashboard watcher is left running; kill the watcher before the suite.",
  context: "test runs in the EGC dashboard package",
  tags: "testing,watcher"
})
```

Both `content` and `context` are required. Keep lessons atomic: one failure mode, one lesson. `initial_confidence` defaults to 0.7 and only needs overriding for tentative observations.

### 4. Save wins too

When a new approach works well, save it in positive, prescriptive form so the next loop starts from it:

```
lesson_save({
  content: "Always regenerate the skill index (scripts/build-skill-index.js) before running the docs tests when a skill was added.",
  context: "adding or renaming skills in the EGC repo",
  tags: "workflow,skills"
})
```

### 5. Stop conditions

Inherit the safety rules from `continuous-agent-loop`: every loop needs an explicit stop condition (max iterations, completion signal, green test suite) and quality gates between iterations. If the same lesson gets reinforced on three consecutive iterations without progress, stop the loop and escalate: that is the "repeated retries with same root cause" failure mode.

## Worked Example

Task: "fix every failing test in the suite, autonomously".

1. `lesson_recall({ query: "failing tests <project name>" })` -> a lesson says the fixture DB must be reset between runs (confidence 0.85).
2. Reset the fixture DB first, then run the suite. The lesson applied: `lesson_reinforce({ id })`.
3. Iteration 2: a fix is reverted because it broke an unrelated snapshot. No matching lesson from recall -> `lesson_save({ content: "Snapshot tests in pkg X break when locale helpers change; run pkg X snapshots after touching i18n.", context: "test fixing in project Y" })`.
4. Iteration 5: discovered that running the linter before the type checker cuts iteration time in half -> save it as a prescriptive win.
5. Suite green -> stop condition met -> loop ends.

## Division of Labor

| System | Mechanism | Speed | Use for |
|--------|-----------|-------|---------|
| autonomous-lesson-learning | explicit MCP calls inside an active loop | immediate, per-iteration | mistakes and wins observed while working |
| continuous-learning-v2 | passive hook observation, background instinct clustering | slow, cross-session | broad behavioral patterns you did not notice yourself |
| continuous-agent-loop | loop architecture, gates, recovery | n/a | the loop mechanics themselves |

autonomous-lesson-learning and `continuous-learning-v2` coexist: this skill is the fast, deliberate path (the AI knows it just failed and writes it down); v2 is the slow, passive path (hooks notice patterns the AI missed). Neither replaces the other, and both read from independent stores.

## Requirements

- `egc-memory` MCP server registered (`egc doctor` to verify)
- A loop pattern from `continuous-agent-loop` with an explicit stop condition
