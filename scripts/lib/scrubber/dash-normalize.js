'use strict';

// Dash normalization: the project rule forbids long dashes as separators.
// This turns em dash, en dash, figure dash, and horizontal bar into safe
// punctuation, and leaves the ASCII hyphen-minus and the mathematical minus
// sign untouched so code, flags, and formulas keep working.
//
// The dash characters are built with String.fromCodePoint so this source stays
// pure ASCII (the repo's unicode-safety gate). Codepoints: U+2012 figure dash,
// U+2013 en dash, U+2014 em dash, U+2015 horizontal bar.
//
// Rules, in order:
//   1. A numeric range written with en/figure dash becomes an ASCII hyphen range.
//   2. Any remaining long dash acting as a clause separator becomes a comma,
//      collapsing the surrounding whitespace into ", ".

const FIGURE_EN_DASHES = String.fromCodePoint(0x2012, 0x2013);
const ALL_LONG_DASHES = String.fromCodePoint(0x2012, 0x2013, 0x2014, 0x2015);

const NUMERIC_RANGE = new RegExp(`(\\d)\\s?[${FIGURE_EN_DASHES}]\\s?(\\d)`, 'g');
const CLAUSE_DASH = new RegExp(`\\s*[${ALL_LONG_DASHES}]\\s*`, 'g');

function normalizeDashes(text) {
  let count = 0;

  let out = text.replace(NUMERIC_RANGE, (_match, before, after) => {
    count += 1;
    return `${before}-${after}`;
  });

  out = out.replace(CLAUSE_DASH, () => {
    count += 1;
    return ', ';
  });

  return { text: out, count };
}

module.exports = { normalizeDashes };
