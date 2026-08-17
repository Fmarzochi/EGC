# Rewrite workflow (statistical marks, best-effort)

A statistical token-sampling mark lives in the model's word choices, so the only
way to reduce it is to re-say the content in different words. This is best-effort:
no public detector or key exists, so nothing here can certify that a vendor check
will fail. Never present a rewrite as proof of human authorship or as
"undetectable". No model is bundled; the host agent is what does the rewriting.

## When to reach for it, and when not

- Skip it when quality matters more than statistical hygiene: keep the lossless
  path (invisible + dash + metadata clean) and leave the prose as written.
- Use it only when a hygiene or privacy need justifies paying for a full rewrite
  pass over the text.
- Favor a model from a different family than the one that produced the text.
  Rewriting with the same model can restamp the result.

## Multi-pass recipe

1. Run the deterministic pass first (invisible Unicode plus long dashes).
2. Reword: shift clause order, connectors, and sentence boundaries; swap content
   and function words where the meaning allows. Keep every fact, number, name,
   and technical identifier.
3. Optional heavier pass: a natural human redraft, a round trip through a pivot
   language, or an outline-then-regenerate pass.
4. Run the deterministic pass again on the result.
5. Measure how far the text moved (the CLI reports lexical divergence) and state
   residual risk plainly: lower for short, predictable text; higher for long,
   high-entropy prose.

## Prompts (our own wording; adapt freely)

Reword while preserving meaning:

```
Restate the passage below in your own words, changing as many word choices as the
meaning allows. Reorder clauses, swap the linking words, and move where sentences
begin and end. Keep every fact, figure, name, and identifier exactly as written,
and neither add nor drop any point. Return only the reworded passage.
===
{TEXT}
```

Round-trip through a pivot language:

```
Render the passage below into {LANG}, then carry that version back into
{ORIGINAL_LANG}. Keep every fact, figure, and name unchanged. Return only the
final {ORIGINAL_LANG} passage.
```

Source code (human-language parts only):

```
In the source below, reword only the human-language parts: comments, docstrings,
and string literals. Rename local variables, parameters, and private helpers to
different but equivalent names. Behavior, exported names, and any value that
affects output must stay identical. Return only the adjusted source.
===
{TEXT}
```
