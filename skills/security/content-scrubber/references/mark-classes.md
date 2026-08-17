# Mark classes

An AI provenance mark falls into one of these families. Knowing which family a
mark belongs to is what separates an honest clean from a false promise.

## 1. Invisible / edit-based text (deterministic, verifiable)

Characters with no visible glyph, or that look like a plain space, used as
carriers or leaking in from broken pastes.

| Kind | Examples |
| --- | --- |
| zero_width | ZWSP, ZWNJ, ZWJ, word joiner, BOM |
| bidi | LRM, RLM, LRE/RLE/PDF, isolates, overrides |
| tag_chars | U+E0001, U+E0020..U+E007F |
| variation_selector | VS1..VS256 |
| private_use | U+E000..F8FF and the supplementary PUA planes |
| space | NBSP, en/em space, ideographic space, ... |
| confusable | Cyrillic / fullwidth Latin look-alikes (aggressive) |

Removed by the deterministic engine and verifiable by codepoint count.

Load-bearing invisibles are preserved: emoji joiners and variation selectors,
script joiners inside complex scripts, complete flag tag sequences, same-script
fillers (Mongolian free variation selectors, Khmer inherent vowels, Hangul jamo
fillers), RTL directional marks, and paired bidi embeddings. The same character
between plain ASCII stays a carrier and is stripped.

## 2. Long dashes (deterministic, verifiable)

Em dash, en dash, figure dash, and horizontal bar used as clause separators are
turned into safe punctuation. Numeric ranges written with an en/figure dash
become an ASCII hyphen range. The ASCII hyphen-minus and the mathematical minus
sign are never touched, so code, flags, and formulas keep working.

## 3. Statistical / token-sampling text (best-effort)

The model biases which tokens it picks according to a pseudo-random pattern. The
signal lives in word choice, spread across nearly every sentence, not in any
character or metadata. It can only be reduced by rewriting a substantial part of
the text. No public detector or key exists, so removal cannot be certified.
See `rewrite-workflow.md`.

## 4. File provenance metadata

Signed Content Credentials (C2PA), EXIF, XMP, and document properties embedded
in images and documents. Removed by re-serializing the container without the
metadata block; verifiable by re-inspecting. (Handled by later Scrubber phases.)

## 5. Out of scope

Pixel/audio/video watermarks, C2PA soft binding (an in-content mark that can
re-link to a remote manifest after metadata is stripped), and data-driven model
backdoors. Removing a mark from families 1, 2, and 4 does not clear these.
