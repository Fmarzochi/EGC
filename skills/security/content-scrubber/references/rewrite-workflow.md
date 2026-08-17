# Rewrite workflow (statistical marks, best-effort)

Statistical token-sampling watermarks live in word choice, so the only way to
reduce them is to rewrite the prose. This is best-effort: no public detector or
key exists, so nothing here can certify a vendor check will fail. Never present
a rewrite as proof of human authorship or as "undetectable". There is no model
bundled; the agent is the rewrite model.

## When to do it, and when not to

- Skip it when quality matters more than statistical hygiene: use the lossless
  path (invisible + dash + metadata clean) and keep the original prose.
- Do it only when you want the stronger model's drafting and accept a rewrite
  pass for a hygiene or privacy requirement.
- Prefer a non-origin, open-weight model for the rewrite (rewriting text with
  the same model that produced it can re-stamp it).

## Multi-pass recipe

1. Deterministic clean first (invisible Unicode + dashes).
2. Paraphrase: change clause order, connectors, and sentence boundaries; replace
   content and function words where meaning allows. Preserve every fact, number,
   name, and technical identifier.
3. Optional stronger pass: a natural-human rewrite, a back-translation through a
   pivot language, or an outline-then-regenerate pass.
4. Deterministic clean again on the result.
5. Report residual risk honestly: lower for short, predictable text; higher for
   long, high-entropy prose.

## Prompts

Paraphrase (preserve meaning):

```
Rewrite the following text with substantially different wording at the token
level. Change clause order, connectors, and sentence boundaries; replace content
and function words where meaning allows. Preserve all facts, numbers, names, and
technical identifiers. Do not add or remove claims. Output only the rewritten text.
---
{TEXT}
```

Back-translate (two steps):

```
Translate the following text to {LANG}. Output only the translation.
```
```
Translate the following text back to {ORIGINAL_LANG}. Preserve meaning; use
natural phrasing. Output only the translation.
```

Code (natural-language parts only):

```
Rewrite only the natural-language parts of this code (comments, docstrings,
string literals) with different wording, and rename local variables and private
helpers to equivalent names. Preserve program behavior, public API names, and
every value that affects output. Output only the rewritten code.
---
{TEXT}
```
