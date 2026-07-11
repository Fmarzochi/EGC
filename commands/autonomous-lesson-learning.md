---
description: Start an autonomous loop that recalls stored lessons before each iteration and saves or reinforces lessons on failures and wins.
---

# Autonomous Lesson Learning Command

Start a learning autonomous loop: `continuous-agent-loop` mechanics plus the `egc-memory` lesson tools (`lesson_recall`, `lesson_save`, `lesson_reinforce`).

## Usage

`/autonomous-lesson-learning <task> [--pattern sequential|continuous-pr] [--max-iterations N]`

- `task`: what the loop should accomplish, with a verifiable done condition
- `--pattern`: loop architecture from `continuous-agent-loop` (default `sequential`)
- `--max-iterations`: hard stop (default 10)

## Flow

1. Read the `autonomous-lesson-learning` skill (`skills/ai/autonomous-lesson-learning/SKILL.md`) and confirm `egc-memory` is registered.
2. Confirm the task has an explicit stop condition; refuse to start without one.
3. Per iteration:
   - `lesson_recall({ query: "<current step topic>" })` before acting; apply what comes back.
   - `lesson_reinforce({ id })` for each recalled lesson that proved relevant or whose mistake recurred.
   - Execute one iteration of the chosen loop pattern.
   - On failure with no matching lesson: `lesson_save({ content, context })`.
   - On a new approach that worked well: `lesson_save` with prescriptive wording.
4. Stop on: done condition met, `--max-iterations` reached, or the same lesson reinforced three iterations in a row without progress (escalate to the user).
5. Report iterations run, lessons recalled, saved, and reinforced.

## Required Safety Checks

- Explicit stop condition before the first iteration.
- Quality gates between iterations per `continuous-agent-loop`.
- Never save a lesson without calling `lesson_recall` first; reinforce instead of duplicating.

## Arguments

$ARGUMENTS:
- `<task>` required
- `--pattern sequential|continuous-pr` optional
- `--max-iterations N` optional
