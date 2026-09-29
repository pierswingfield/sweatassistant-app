// U1-11/U1-19b: SERVER MIRROR of client/src/class-name.js (the client is ESM,
// the server CJS, and the image builds them separately, so it is a copy, and
// server/test-class-name-parity.js pins the two to identical output). The server
// has no discipline-pill label table, so `label` is omitted: the discipline's
// own head ("TRAIN") does the stripping. Use these for every server-composed
// string that names a class (push bodies, calendar).

/**
 * Head of a discipline string: JAB's discipline can be a whole class name
 * ("TRAIN - Lower (Focus)"); the discipline proper is "TRAIN".
 */
function disciplineHead(discipline = '') {
  return String(discipline || '').trim().split(/\s*[:\-\u2013]\s*/)[0].trim();
}


/**
 * Presentable class name: drop the redundant discipline prefix, then normalise
 * SHOUTING into sentence case.
 *
 * Providers prefix the discipline onto the class name because their own UI has
 * no separate discipline column — "TRAIN - Upper (Focus)", "BOXING Core &
 * Power", "RIDE: Signature 45". Our rows already show a discipline pill beside
 * the name, so the prefix is repeated on every row and steals the width the
 * actual name needs.
 *
 * Separator-agnostic on purpose: JAB uses " - ", Psycle uses ": ", and
 * "BOXING Core & Power" uses nothing at all. The timetable previously handled
 * only "TYPE: " and so left both JAB forms untouched.
 *
 * Only strips when what remains is non-empty — "BOXING" as a whole class name
 * keeps its name rather than rendering as a blank cell.
 */
function cleanClassNameWith(name = '', discipline = '', label = '') {
  let n = String(name || '').trim();
  if (!n) return '';

  // U1-11: what the row's pill says can differ from the raw `discipline` string.
  // MarianaTek's `discipline` is `class_type.name`, which is usually the FULL
  // class name ("TRAIN - Upper (Focus)"), so stripping only the raw discipline
  // never matched (it would need a separator AFTER the whole name). The prefix
  // to drop is the discipline's own head ("TRAIN") or the pill's label ("Train").
  const disc = String(discipline || '').trim();
  const head = disc.split(/\s*[:\-–]\s*/)[0].trim();
  const candidates = [...new Set([disc, head, label, 'recovery'].filter(Boolean).map(String))]
    .sort((a, b) => b.length - a.length); // longest prefix first
  for (const c of candidates) {
    const esc = c.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Optional separator: colon, dash, en-dash, or plain whitespace.
    const re = new RegExp(`^${esc}(?:\\s*[:\\-–]\\s*|\\s+)`, 'i');
    if (!re.test(n)) continue;
    let rest = n.replace(re, '').trim();
    // A remainder wrapped entirely in brackets is the real name with decoration
    // around it: "RECOVERY (Members)" should read "Members", not "(Members)".
    const bracketed = rest.match(/^\((.+)\)$/);
    if (bracketed) rest = bracketed[1].trim();
    // Refuse to strip when what's left isn't a name on its own. "Barre 55" would
    // otherwise become "55" — the discipline pill says Barre, but a row reading
    // just "55" has lost the thing a person scans for.
    if (!rest || !/[A-Za-z]/.test(rest)) continue;
    n = rest;
    break;
  }

  return toSentenceCase(n);
}

/**
 * Sentence case, but only for text that is actually shouting.
 *
 * A name already in mixed case ("Signature 45", "Core & Glutes") is left alone —
 * re-casing it can only lose information. Short all-caps tokens are treated as
 * acronyms and preserved, so "HIIT" and "TRX" survive a conversion that would
 * otherwise render them "Hiit" and "Trx".
 */
function toSentenceCase(text) {
  const str = String(text || '').trim();
  if (!str) return str;
  const letters = str.replace(/[^A-Za-z]/g, '');
  if (!letters) return str;
  const upperRatio = (str.replace(/[^A-Z]/g, '').length) / letters.length;
  if (upperRatio < 0.7) return str; // already mixed case — leave it

  const words = str.split(/(\s+)/).map((token) => {
    if (/^\s+$/.test(token)) return token;
    const bare = token.replace(/[^A-Za-z]/g, '');
    // Keep short all-caps tokens as acronyms (HIIT, TRX, EMS, AMRAP is 5 but
    // reads fine either way — 4 is the conservative cut).
    if (bare.length > 0 && bare.length <= 4 && bare === bare.toUpperCase()) return token;
    return token.toLowerCase();
  });
  let out = words.join('');
  // Capitalise the first letter that exists, wherever it is.
  out = out.replace(/[a-z]/, (c) => c.toUpperCase());
  return out;
}

/**
 * Group token for surfaces WITHOUT a discipline pill (push bodies, calendar
 * titles): the discipline's head, so JAB's whole-name discipline
 * "TRAIN - Lower (Focus)" reads "TRAIN", never the full class name.
 */
function groupToken(discipline = '') {
  return disciplineHead(discipline);
}

module.exports = { disciplineHead, cleanClassNameWith, toSentenceCase, groupToken, cleanClassName: (n, d) => cleanClassNameWith(n, d, '') };
