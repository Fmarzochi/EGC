# Coverage: guaranteed vs best-effort

| Target | Method | Guaranteed? |
| --- | --- | --- |
| Invisible Unicode carriers | Deterministic strip, context-aware preservation | Yes (counted) |
| Space look-alikes | Normalize to plain space | Yes (counted) |
| Cross-script letter look-alikes | Replace (aggressive mode only) | Yes (counted) |
| Long dashes | Turn into safe punctuation; ranges to ASCII hyphen | Yes (counted) |
| AI co-authorship in commits | Strip AI trailers, keep human co-authors | Yes (line count) |
| File metadata (C2PA/EXIF/XMP/props) | Re-serialize container without the block | Yes (re-inspect) |
| Statistical token-sampling text | Rewrite (paraphrase / back-translate / structural) | No, best-effort |
| Pixel / audio / video watermarks | Out of scope | No |
| C2PA soft binding | Out of scope | No |
| Model backdoors | Out of scope | No |

## Why "guaranteed" and "best-effort" are different

Guaranteed removals live in characters, structure, or metadata: they can be
found and counted, and re-inspection proves they are gone. Best-effort removal
targets a signal spread across word choice; rewriting reduces it but no public
detector or key exists to certify a vendor check will fail.

## The honest full-circle note on rewriting

Rewriting to reduce a statistical mark replaces the original wording with the
rewriting model's, which flattens tone and precision. If the plan is to rewrite
with a weaker model anyway, generating directly with that model is simpler and
gives the same result. Rewriting for hygiene makes sense only when you
specifically want the stronger model's drafting and accept the rewrite cost.
Prefer the lossless path (invisible + dash + metadata clean) when quality
matters more than statistical hygiene.
