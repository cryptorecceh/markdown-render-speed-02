// md-fast — a dependency-free Markdown -> HTML renderer, byte-identical to
// marked 18.1.3 (default options: gfm on, breaks off) on the kit's practice
// set. Written from the CommonMark 0.31.2 + GFM specifications and from
// black-box probing of marked's observable behaviour.
//
// Layout: parse() -> normalise line endings -> block tree builder
// (open-container algorithm) -> tree renderer -> per-container inline pass.
// The inline pass builds a flat node list, resolves brackets and links,
// then resolves emphasis / strikethrough delimiters, then renders.

// ---------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------

const PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCT[ch.charCodeAt(0)] = 1;
const UNI_PUNCT = /[\p{P}\p{S}]/u;
const UNI_WS = /[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;

function wsCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}
function uniWsCode(c) {
  if (c < 128) return wsCode(c);
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x202f || c === 0x205f || c === 0x3000;
}
function punctCode(c) {
  if (c < 128) return PUNCT[c] === 1;
  return UNI_PUNCT.test(String.fromCodePoint(c));
}
function punctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return PUNCT[c] === 1;
  return UNI_PUNCT.test(ch);
}
function wsCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return wsCode(c);
  return UNI_WS.test(ch);
}
function alnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
const UNI_ALNUM = /[\p{L}\p{N}]/u;
// GFM emphasis classes (marked): `ye` punct excl '~', `it` notPunctSpace
// incl '~', `st` punctSpace excl '~', `X` notPunctSpace excl '~',
// `j` punctSpace incl '~', `$` punct incl '~' (= punctCh).
function punctGfmCh(ch) {
  return ch !== '' && ch !== '~' && punctCh(ch);
}
function notPunctSpaceCh(ch) {
  return ch !== '' && !wsCh(ch) && !punctCh(ch);
}
function notPunctSpaceTildeCh(ch) {
  return ch === '~' || notPunctSpaceCh(ch);
}
function punctSpaceCh(ch) {
  return ch !== '' && (wsCh(ch) || punctCh(ch));
}
function punctSpaceGfmCh(ch) {
  return ch !== '' && (wsCh(ch) || punctGfmCh(ch));
}
function isPunctCh(ch) {
  return ch !== '' && punctCh(ch);
}
function isWsCh(ch) {
  return ch !== '' && wsCh(ch);
}
function isAlnumCh(ch) {
  return ch !== '' && UNI_ALNUM.test(ch);
}
function digitCode(c) {
  return c >= 48 && c <= 57;
}
function hexCode(c) {
  return digitCode(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

// One code point ending just before index i / starting at index i.
function cpBefore(s, i) {
  if (i <= 0) return '';
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}
function cpAfter(s, i) {
  if (i >= s.length) return '';
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const l = s.charCodeAt(i + 1);
    if (l >= 0xdc00 && l <= 0xdfff) return s.slice(i, i + 2);
  }
  return s[i];
}

// ---------------------------------------------------------------------------
// Entities (marked 18.1.3 behaviour, probed)
//   * Named entities pass through untouched: any &[A-Za-z0-9]+; is kept.
//   * Numeric entities decode: &#<1-7 decimal>; or &#[xX]<1-6 hex>;
//     longer digit runs are NOT entities (the & is escaped instead).
//   * Decoded 0, surrogates, >0x10FFFF become U+FFFD.
//   * A decoded char is then HTML-escaped.
// ---------------------------------------------------------------------------

function entityAt(s, i) {
  // s[i] === '&'. Returns [endExclusive, replacement] or null.
  const n = s.length;
  if (i + 1 >= n) return null;
  if (s[i + 1] === '#') {
    let j = i + 2, hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const ds = j;
    const max = hex ? 6 : 7;
    while (j < n && j - ds < max && hexCode(s.charCodeAt(j))) {
      if (!hex && !digitCode(s.charCodeAt(j))) break;
      j++;
    }
    if (j === ds) return null;
    if (j >= n || s[j] !== ';') return null;
    let cp = parseInt(s.slice(ds, j), hex ? 16 : 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    const ch = String.fromCodePoint(cp);
    return [j + 1, escEntityCh(ch)];
  }
  let j = i + 1;
  while (j < n && alnumCode(s.charCodeAt(j))) j++;
  if (j === i + 1) return null;
  if (j >= n || s[j] !== ';') return null;
  return [j + 1, s.slice(i, j + 1)];
}

function escEntityCh(ch) {
  if (ch === '"') return '&quot;';
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === "'") return '&#39;';
  return ch;
}

// Escape text for HTML output, processing character references.
// Always escapes &, <, >, " and ' (marked escapes both quote forms).
function escText(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      const e = entityAt(s, i);
      if (e) { out += e[1]; i = e[0]; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === '<') { out += '&lt;'; i++; continue; }
    if (c === '>') { out += '&gt;'; i++; continue; }
    if (c === '"') { out += '&quot;'; i++; continue; }
    if (c === "'") { out += '&#39;'; i++; continue; }
    out += c; i++;
  }
  return out;
}

// Escape code content (& < > " '). Character references are NOT decoded
// in code spans or code blocks: a bare & is simply escaped.
// Five single-char regex passes (C++-backed) are ~10x faster than a
// char-by-char JS loop on large fenced blocks (doc-13's giant fence).
function escCode(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Clean a URL for an href/src attribute. `%` is never double-encoded.
function cleanUrl(url) {
  try {
    return encodeURI(url).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Link destination, title, label
// ---------------------------------------------------------------------------

// Parse a link destination at s[pos]. Returns {dest, end} or null.
// `<...>` form: escapes processed, no `<`, newline or unescaped `\` inside.
// Bare form: no spaces/control chars, parens balanced (one level of nesting).
function parseDest(s, pos) {
  const n = s.length;
  if (pos >= n) return null;
  if (s[pos] === '<') {
    let j = pos + 1;
    let dest = '';
    while (j < n) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { dest, end: j + 1 };
      if (c === '\\' && j + 1 < n) {
        const nc = s[j + 1];
        if (nc.charCodeAt(0) < 128 && PUNCT[nc.charCodeAt(0)] === 1) {
          dest += nc; j += 2; continue;
        }
      }
      if (c === '\\') return null;
      dest += c; j++;
    }
    return null;
  }
  let j = pos;
  let dest = '';
  let depth = 0;
  while (j < n) {
    const c = s[j];
    const cc = s.charCodeAt(j);
    if (cc <= 32 || cc === 127) break;
    if (c === '\\' && j + 1 < n) {
      const nc = s[j + 1];
      if (nc.charCodeAt(0) < 128 && PUNCT[nc.charCodeAt(0)] === 1) {
        dest += nc; j += 2; continue;
      }
      dest += c; j++; continue;
    }
    if (c === '(') {
      // Balanced parentheses are allowed in a bare destination
      // (no depth limit).
      depth++; dest += c; j++; continue;
    }
    if (c === ')') {
      if (depth === 0) break;
      depth--; dest += c; j++; continue;
    }
    dest += c; j++;
  }
  if (dest === '') return null;
  return { dest, end: j };
}

// Parse a link title at s[pos] ("...", '...', (...)). Returns {title, end}
// or null. `"` titles may span lines; `'` titles may span single lines;
// `(` titles stay on one line. Backslash escapes are processed.
function parseTitle(s, pos) {
  const n = s.length;
  const q = s[pos];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let j = pos + 1;
  let title = '';
  while (j < n) {
    const c = s[j];
    if (c === close) return { title, end: j + 1 };
    if (c === '\\' && j + 1 < n) {
      const nc = s[j + 1];
      if (nc.charCodeAt(0) < 128 && PUNCT[nc.charCodeAt(0)] === 1) {
        title += nc; j += 2; continue;
      }
      title += c; j++; continue;
    }
    if (c === '\n') {
      if (q === '(') return null;
      if (q === "'" && j + 1 < n && s[j + 1] === '\n') return null;
      title += c; j++; continue;
    }
    title += c; j++;
  }
  return null;
}

// Parse a link label at s[pos] ('[' ... ']'). The label is returned RAW
// (backslashes kept: `foo\!` does NOT match a `foo!` reference). Labels
// may not contain an unescaped `[`, may span single newlines but not blank
// lines, are at most 999 chars, and must not be whitespace-only.
// Returns {label, end} (end = index just past ']') or null.
function parseLabel(s, pos) {
  const n = s.length;
  if (pos >= n || s[pos] !== '[') return null;
  let j = pos + 1;
  let label = '';
  let nonWs = false;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) {
      label += c + s[j + 1];
      if (s[j + 1] !== ' ' && s[j + 1] !== '\t' && s[j + 1] !== '\n') nonWs = true;
      j += 2;
      continue;
    }
    if (c === '[') return null;
    if (c === ']') {
      if (!nonWs || label.length > 999) return null;
      return { label, end: j + 1 };
    }
    if (c === '\n') {
      // Newline allowed only when the next line is not blank.
      let k = j + 1;
      while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k >= n || s[k] === '\n') return null;
      label += c; j++; continue;
    }
    if (c !== ' ' && c !== '\t') nonWs = true;
    label += c; j++;
    if (label.length > 999) return null;
  }
  return null;
}

// Unicode case folding for label matching (CommonMark): full folding, so
// ẞ/ß fold to "ss", ligatures expand, Σ/ς fold to σ, µ folds to μ, İ folds
// to i + combining dot. Then whitespace collapses and the label is trimmed.
const FOLD_MAP = {
  '\u00df': 'ss', '\u1e9e': 'ss', '\u00b5': '\u03bc',
  '\u0130': 'i\u0307', '\u03a3': '\u03c3', '\u03c2': '\u03c3',
  '\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi',
  '\ufb04': 'ffl', '\ufb05': 'st', '\ufb06': 'st',
  '\u01c5': '\u01c6', '\u01c4': '\u01c6', '\u01f2': '\u01f3',
  '\u01f1': '\u01f3', '\u01c8': '\u01c9', '\u01c7': '\u01c9',
  '\u01cb': '\u01cc', '\u01ca': '\u01cc',
};
function foldLabel(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const rep = FOLD_MAP[ch];
    out += rep !== undefined ? rep : ch;
  }
  return out.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Skip spaces/tabs and at most one newline (plus its indent) — used between
// the parts of a reference definition / inline link.
function skipWsNl(text, pos) {
  let p = pos;
  while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p++;
  if (p < text.length && text[p] === '\n') {
    p++;
    while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p++;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Inline HTML tags (multi-line: attributes may span lines, quoted values
// may contain `<`, `>` and newlines). Returns the end index or -1.
// ---------------------------------------------------------------------------

function parseTag(s, pos) {
  const n = s.length;
  if (pos >= n || s[pos] !== '<') return -1;
  // Comment
  if (s.startsWith('<!--', pos)) {
    // Short forms end immediately: <!--> and <!--->.
    if (s[pos + 4] === '>') return pos + 5;
    if (s[pos + 4] === '-' && s[pos + 5] === '>') return pos + 6;
    const end = s.indexOf('-->', pos + 4);
    if (end === -1) return -1;
    return end + 3;
  }
  // Processing instruction
  if (s.startsWith('<?', pos)) {
    const end = s.indexOf('?>', pos + 2);
    if (end === -1) return -1;
    return end + 2;
  }
  // CDATA
  if (s.startsWith('<![CDATA[', pos)) {
    const end = s.indexOf(']]>', pos + 9);
    if (end === -1) return -1;
    return end + 3;
  }
  // Declaration: <! + letter ... >
  if (s.startsWith('<!', pos) && pos + 2 < n) {
    const c2 = s.charCodeAt(pos + 2);
    if (alnumCode(c2)) {
      const end = s.indexOf('>', pos + 3);
      if (end === -1) return -1;
      return end + 1;
    }
  }
  let j = pos + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n) return -1;
  const tc = s.charCodeAt(j);
  if (!((tc >= 65 && tc <= 90) || (tc >= 97 && tc <= 122))) return -1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (alnumCode(c) || c === 45) j++;
    else break;
  }
  // Attributes
  while (true) {
    // Skip whitespace (spaces, tabs, newlines). An attribute (or the
    // closing '>') must be preceded by whitespace after the tag name
    // or a previous attribute value: `<a href='x'title=y>` and
    // `<m:abc>` are NOT valid tags.
    let ws = 0;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) { j++; ws++; }
    if (j >= n) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    if (closing) return -1;
    if (ws === 0) return -1;
    // Attribute name: letter, _ or : then word chars, . : -
    const ac = s.charCodeAt(j);
    if (!((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac === 95 || ac === 58)) return -1;
    j++;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (alnumCode(c) || c === 95 || c === 58 || c === 46 || c === 45) j++;
      else break;
    }
    // Optional = value.
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
    if (k < n && s[k] === '=') {
      k++;
      while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
      if (k >= n) return -1;
      const vc = s[k];
      if (vc === '"') {
        const end = s.indexOf('"', k + 1);
        if (end === -1) return -1;
        j = end + 1;
      } else if (vc === "'") {
        const end = s.indexOf("'", k + 1);
        if (end === -1) return -1;
        j = end + 1;
      } else {
        // Unquoted: no space, ", ', =, <, >, `.
        if (vc === '"' || vc === "'" || vc === '=' || vc === '<' || vc === '>' || vc === '`') return -1;
        let e = k;
        while (e < n) {
          const cc = s[e];
          if (cc === ' ' || cc === '\t' || cc === '\n' || cc === '\r' || cc === '"' ||
              cc === "'" || cc === '=' || cc === '<' || cc === '>' || cc === '`') break;
          e++;
        }
        if (e === k) return -1;
        j = e;
      }
    }
  }
}

// Parse a tag that must be complete on ONE line (for HTML block type 7).
// Attributes use spaces only (no newlines inside quoted values).
function parseTagLine(s, pos) {
  const n = s.length;
  if (pos >= n || s[pos] !== '<') return -1;
  let j = pos + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n) return -1;
  const tc = s.charCodeAt(j);
  if (!((tc >= 65 && tc <= 90) || (tc >= 97 && tc <= 122))) return -1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (alnumCode(c) || c === 45) j++;
    else break;
  }
  while (true) {
    // An attribute must be preceded by whitespace (same rule as
    // parseTag): `<a href='x'title=y>` and `<m:abc>` are NOT valid tags.
    let ws = 0;
    while (j < n && (s[j] === ' ' || s[j] === '\t')) { j++; ws++; }
    if (j >= n || s[j] === '\n') return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    if (closing) return -1;
    if (ws === 0) return -1;
    const ac = s.charCodeAt(j);
    if (!((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac === 95 || ac === 58)) return -1;
    j++;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (alnumCode(c) || c === 95 || c === 58 || c === 46 || c === 45) j++;
      else break;
    }
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
    if (k < n && s[k] === '=') {
      k++;
      while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k >= n || s[k] === '\n') return -1;
      const vc = s[k];
      if (vc === '"') {
        const end = s.indexOf('"', k + 1);
        if (end === -1 || s.indexOf('\n', k + 1) !== -1 && s.indexOf('\n', k + 1) < end) return -1;
        j = end + 1;
      } else if (vc === "'") {
        const end = s.indexOf("'", k + 1);
        if (end === -1 || s.indexOf('\n', k + 1) !== -1 && s.indexOf('\n', k + 1) < end) return -1;
        j = end + 1;
      } else {
        if (vc === '"' || vc === "'" || vc === '=' || vc === '<' || vc === '>' || vc === '`') return -1;
        let e = k;
        while (e < n) {
          const cc = s[e];
          if (cc === ' ' || cc === '\t' || cc === '\n' || cc === '"' ||
              cc === "'" || cc === '=' || cc === '<' || cc === '>' || cc === '`') break;
          e++;
        }
        if (e === k) return -1;
        j = e;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inline nodes
// ---------------------------------------------------------------------------
// Node kinds: text (h = escaped html, r = raw), code (h, r = content),
// html (h = raw tag), br, soft, delim (ch, n, orig, canOpen, canClose),
// bracket (h = '[' or '![', active, image), em (tag, kids),
// link (href, title, kids, image).

function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 'text' || nd.k === 'code' || nd.k === 'html' ||
        nd.k === 'bracket') {
      out += nd.r !== undefined ? nd.r : nd.h;
    } else if (nd.k === 'delim') {
      out += nd.ch.repeat(nd.n);
    } else if (nd.k === 'br' || nd.k === 'soft') {
      out += '\n';
    } else if (nd.k === 'em' || nd.k === 'link') {
      out += plainText(nd.kids || []);
    }
  }
  return out;
}

// First / last SOURCE character of a node (for emphasis flanking
// classification in the emStrong scan). Code spans, links, html tags and
// brackets start/end with a punctuation character; a text node
// contributes its raw first / last character; an em node contributes its
// kids' boundary characters; a line break contributes '\n'.
function firstSrcCh(nd) {
  switch (nd.k) {
    case 'text': return nd.r.length ? cpAfter(nd.r, 0) : '';
    case 'code': return '`';
    case 'html': return '<';
    case 'bracket': return nd.h[0];
    case 'link': {
      // A bare-URL / email autolink's raw text is the URL itself;
      // an angle autolink starts '<' and ends '>'; a bracket link
      // starts '[' / '!' and ends ')' / ']' (both punctuation).
      if (nd.auto && nd.ext) {
        const kids = nd.kids || [];
        return kids.length ? firstSrcCh(kids[0]) : '';
      }
      if (nd.auto) return '<';
      return nd.image ? '!' : '[';
    }
    case 'delim': return nd.ch;
    case 'em': {
      const kids = nd.kids || [];
      return kids.length ? firstSrcCh(kids[0]) : '';
    }
    case 'br': case 'soft': return '\n';
    default: return '';
  }
}
function lastSrcCh(nd) {
  switch (nd.k) {
    case 'text': return nd.r.length ? cpBefore(nd.r, nd.r.length) : '';
    case 'code': return '`';
    case 'html': return '>';
    case 'bracket': return '[';
    case 'link': {
      if (nd.auto && nd.ext) {
        const kids = nd.kids || [];
        return kids.length ? lastSrcCh(kids[kids.length - 1]) : '';
      }
      if (nd.auto) return '>';
      return ']';
    }
    case 'delim': return nd.ch;
    case 'em': {
      const kids = nd.kids || [];
      return kids.length ? lastSrcCh(kids[kids.length - 1]) : '';
    }
    case 'br': case 'soft': return '\n';
    default: return '';
  }
}

// Match an Ot code span starting at s[j] (s[j] === '`'). Returns the
// index just past the closing run, or -1. The content must start and
// end with a non-backtick character; the closing run must have exactly
// the opener's length and not be followed by a backtick. (Marked's
// `anyPunctuationOutsideCode` code-span alternative.)
function otCodeSpanEnd(s, j) {
  const n = s.length;
  let L = 0;
  while (j + L < n && s[j + L] === '`') L++;
  if (j + L >= n || s[j + L] === '`') return -1;
  let m = j + L + 1;
  while (m < n) {
    if (s[m] === '`') {
      let r2 = 0;
      while (m + r2 < n && s[m + r2] === '`') r2++;
      if (r2 === L && s[m - 1] !== '`' && (m + r2 >= n || s[m + r2] !== '`')) {
        return m + r2;
      }
      m += r2;
    } else m++;
  }
  return -1;
}

// Does a blockSkip `[...](...)` (inline link) start at s[i]
// (s[i] === '[')? Mirrors marked's emStrong mask: the label is scanned
// on the Ot-cleaned text, so code spans are opaque units (their inner
// backticks do not end the label). Returns the index just past the
// closing ')', or -1.
function matchMaskedLink(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '`') {
      const e = otCodeSpanEnd(s, j);
      if (e === -1) return -1;
      j = e;
      continue;
    }
    if (c === '[') return -1;
    if (c === ']') break;
    j++;
  }
  if (j >= n || s[j] !== ']') return -1;
  if (j + 1 >= n || s[j + 1] !== '(') return -1;
  // Destination: (?:\\[\s\S]|[^\()\\]|\((?:\\[\s\S]|[^\()\\])*\\))*
  let k = j + 2;
  while (k < n) {
    const c = s[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '(') {
      k++;
      let closed = false;
      while (k < n) {
        const d = s[k];
        if (d === '\\') { k += 2; continue; }
        if (d === ')') { k++; closed = true; break; }
        if (d === '(') return -1;
        k++;
      }
      if (!closed) return -1;
      continue;
    }
    if (c === ')') return k + 1;
    k++;
  }
  return -1;
}

// Classify a * / _ delimiter run (at nodes[j]) for the emStrong scan.
// Returns 'open' (g3/g4), 'close' (g1/g2), 'both' (g5/g6), or null
// (the run matches no RDelim group and is inert for the scan).
function classifyRDelim(nodes, j, ch) {
  const prev = j > 0 ? lastSrcCh(nodes[j - 1]) : '';
  const next = j + 1 < nodes.length ? firstSrcCh(nodes[j + 1]) : '';
  const nextWsEol = next === '' || isWsCh(next);
  if (ch === '*') {
    const prevYe = punctGfmCh(prev);
    const prevIt = notPunctSpaceTildeCh(prev);
    const prevSt = punctSpaceGfmCh(prev);
    const prevWs = isWsCh(prev);
    const nextYe = punctGfmCh(next);
    const nextIt = notPunctSpaceTildeCh(next);
    const nextSt = punctSpaceGfmCh(next);
    if (prevYe && nextWsEol) return 'close';
    if (prevIt && (nextSt || next === '')) return 'close';
    if (prevSt && nextIt) return 'open';
    if (prevWs && nextYe) return 'open';
    if (prevYe && nextYe) return 'both';
    if (prevIt && nextIt) return 'both';
    return null;
  }
  const prevP = isPunctCh(prev);
  const prevX = notPunctSpaceCh(prev);
  const prevJ = punctSpaceCh(prev);
  const prevWs = isWsCh(prev);
  const nextP = isPunctCh(next);
  const nextX = notPunctSpaceCh(next);
  const nextJ = punctSpaceCh(next);
  if (prevP && nextWsEol) return 'close';
  if (prevX && (nextJ || next === '')) return 'close';
  if (prevJ && nextX) return 'open';
  if (prevWs && nextP) return 'open';
  if (prevP && nextP) return 'both';
  return null;
}

// Can the * / _ delimiter at nodes[i] open an emStrong span (marked's
// emStrong LDelim + opener gate)? kEff is the effective run length being
// tried (the run may have been split: the first origLen - kEff
// delimiters were consumed as literal text, so the walk-back applies
// and y is the ORIGINAL run length). Returns {k, y, R} or null.
// `o` is always false for a maximal run; for a split run the walk-back
// makes n = p and u = h.
function emStrongOpener(nodes, i, kEff, origLen) {
  const nd = nodes[i];
  const ch = nd.ch;
  const prevNode = i > 0 ? nodes[i - 1] : null;
  const nextNode = i + 1 < nodes.length ? nodes[i + 1] : null;
  const p = prevNode ? lastSrcCh(prevNode) : '';
  const next = nextNode ? firstSrcCh(nextNode) : '';
  const split = origLen - kEff;
  if (next === '' || isWsCh(next)) return null;
  const d = punctGfmCh(next) ? next : '';
  const h = punctSpaceCh(p);
  let nGate, u;
  if (split === 0) {
    const nArg = (prevNode && prevNode.k === 'text') ? p : '';
    nGate = nArg;
    u = nArg !== '' && punctSpaceCh(nArg) && nArg !== '*' && nArg !== '_';
    if (ch === '_') {
      const s4 = (next !== '_' && !punctGfmCh(next)) ? next : '';
      if (s4 !== '' && isAlnumCh(nArg)) return null;
    }
  } else {
    nGate = p;
    u = h;
    if (ch === '_') {
      const s4 = (next !== '_' && !punctGfmCh(next)) ? next : '';
      if (s4 !== '' && isAlnumCh(p)) return null;
    }
  }
  if (!(d === '' || nGate === '' || u)) return null;
  const R = p !== '' && !isWsCh(p) && (d !== '' || (ch === '*' && !h));
  return { k: kEff, y: origLen, R };
}

// The ^-anchored skip alternative of marked's RDelim regexes: at the
// start of a scan, a `__...*...__` region (for '*') or a
// `**..._...**` region (for '_') is skipped whole, so the single
// delimiter inside it is not counted as an open-only run. Returns the
// node index of the delimiter to skip, or -1.
function emStrongSkipIdx(nodes, oi, ch) {
  // The two delimiters of the wrapping run and the single inner one.
  const wrapCh = ch === '*' ? '_' : '*';
  const innerCh = ch;
  let j = oi + 1;
  // Phase 1: non-delimiter nodes, then the opening wrap run (exactly 2).
  while (j < nodes.length && nodes[j].k !== 'delim') j++;
  if (j >= nodes.length) return -1;
  if (nodes[j].k !== 'delim' || nodes[j].ch !== wrapCh || nodes[j].n !== 2) return -1;
  j++;
  // Phase 2: non-delimiter nodes, then the single inner delimiter.
  while (j < nodes.length && nodes[j].k !== 'delim') j++;
  if (j >= nodes.length) return -1;
  if (nodes[j].k !== 'delim' || nodes[j].ch !== innerCh || nodes[j].n !== 1) return -1;
  const innerIdx = j;
  j++;
  // Phase 3: non-delimiter nodes, then the closing wrap run (>= 2,
  // a lookahead, so it is not consumed).
  while (j < nodes.length && nodes[j].k !== 'delim') j++;
  if (j >= nodes.length) return -1;
  if (nodes[j].k !== 'delim' || nodes[j].ch !== wrapCh || nodes[j].n < 2) return -1;
  return innerIdx;
}

// Scan forward from the opener at nodes[oi] for a matching closer
// (marked's emStrong scan loop). Returns
// {closerIdx, bUsed, use} or null.
function emStrongScan(nodes, oi, open) {
  const opener = nodes[oi];
  const ch = opener.ch;
  const k = open.k;
  const y = open.y;
  const R = open.R;
  let m = k, f = 0;
  const skipIdx = emStrongSkipIdx(nodes, oi, ch);
  for (let j = oi + 1; j < nodes.length; j++) {
    const nd = nodes[j];
    if (nd.k !== 'delim' || nd.ch !== ch || nd.masked) continue;
    if (j === skipIdx) continue;
    const b = nd.n;
    if (b <= 0) continue;
    const cls = classifyRDelim(nodes, j, ch);
    if (cls === null) continue;
    if (cls === 'open') { m += b; continue; }
    if (cls === 'both' || R) {
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    m -= b;
    if (m > 0) continue;
    const bUsed = Math.min(b, b + m + f);
    // marked: min(k, b) odd -> em (use 1), even -> strong (use 2).
    const use = (Math.min(k, bUsed) % 2 === 1) ? 1 : 2;
    return { closerIdx: j, bUsed, use };
  }
  return null;
}

// Clear the emStrong-mask flag on delimiter nodes in list (used when a
// link forms: the link text is its own scope, so its _ / * are visible
// to the emStrong scan again).
function unmaskDelims(list) {
  for (const nd of list) {
    if (nd.k === 'delim') nd.masked = false;
    else if ((nd.k === 'link' || nd.k === 'em') && nd.kids) unmaskDelims(nd.kids);
  }
}

// Resolve * / _ emphasis with marked's emStrong scan. When a span is
// formed, its kids are resolved recursively (mirroring marked's
// re-tokenisation of the inner text). A run whose full-length scan
// fails is retried shortened by one delimiter at a time (marked's
// lexer consumes one delimiter as text and retries at the next).
function emStrongPass(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const nd = nodes[i];
    if (nd.k !== 'delim' || (nd.ch !== '*' && nd.ch !== '_') || nd.masked) {
      i++;
      continue;
    }
    let formed = null;
    for (let kEff = nd.n; kEff >= 1; kEff--) {
      const open = emStrongOpener(nodes, i, kEff, nd.n);
      if (!open) continue;
      const res = emStrongScan(nodes, i, open);
      if (!res) continue;
      formed = { open, res, kEff };
      break;
    }
    if (!formed) { i++; continue; }
    const { res, kEff } = formed;
    const closer = nodes[res.closerIdx];
    const use = res.use;
    const tag = use === 2 ? 'strong' : 'em';
    const kids = [];
    const openerLeft = kEff - use;
    if (openerLeft > 0) {
      kids.push({ k: 'delim', ch: nd.ch, n: openerLeft, orig: nd.orig, canOpen: nd.canOpen, canClose: nd.canClose, masked: false });
    }
    for (let q = i + 1; q < res.closerIdx; q++) kids.push(nodes[q]);
    const closerLeft = res.bUsed - use;
    if (closerLeft > 0) {
      kids.push({ k: 'delim', ch: closer.ch, n: closerLeft, orig: closer.orig, canOpen: closer.canOpen, canClose: closer.canClose, masked: false });
    }
    const emNode = { k: 'em', tag, kids };
    const rep = [];
    const split = nd.n - kEff;
    if (split > 0) {
      rep.push({ k: 'text', h: escText(nd.ch.repeat(split)), r: nd.ch.repeat(split) });
    }
    rep.push(emNode);
    const closerRemain = closer.n - res.bUsed;
    if (closerRemain > 0) {
      rep.push({ k: 'delim', ch: closer.ch, n: closerRemain, orig: closer.orig, canOpen: closer.canOpen, canClose: closer.canClose, masked: false });
    }
    nodes.splice(i, res.closerIdx - i + 1, ...rep);
    resolveEmphasis(kids);
    // Continue from the node after the em node (the leftover closer,
    // if any, is re-examined as a potential opener).
    i = i + (split > 0 ? 1 : 0) + 1;
  }
}

// Resolve ~ strikethrough with the CommonMark delimiter-stack
// algorithm (unchanged behaviour; ~ keeps its existing canOpen/canClose).
function delPass(nodes) {
  const openers = [];
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (nd.k !== 'delim' || nd.ch !== '~') continue;
    if (nd.canClose) {
      let opIdx = -1;
      for (let j = openers.length - 1; j >= 0; j--) {
        if (openers[j] !== nd) { opIdx = j; break; }
      }
      if (opIdx !== -1) {
        const op = openers[opIdx];
        const use = (op.n >= 2 && nd.n >= 2) ? 2 : 1;
        const oi = nodes.indexOf(op);
        const ci = nodes.indexOf(nd);
        const kids = nodes.slice(oi + 1, ci);
        const delNode = { k: 'em', tag: 'del', kids };
        op.n -= use;
        nd.n -= use;
        const rep = [];
        if (op.n > 0) rep.push(op);
        rep.push(delNode);
        if (nd.n > 0) rep.push(nd);
        nodes.splice(oi, ci - oi + 1, ...rep);
        // The del's inner text is a fresh scope (marked re-tokenises
        // it): resolve emphasis inside it (e.g. a **strong** whose
        // closer abuts the closing ~~).
        resolveEmphasis(kids);
        openers.splice(opIdx + 1);
        if (op.n === 0) openers.splice(opIdx, 1);
        if (nd.n > 0) {
          if (nd.canOpen && openers.indexOf(nd) === -1) openers.push(nd);
          i = oi + rep.length - 2;
        } else {
          i = oi + rep.length - 1;
        }
        continue;
      }
    }
    if (nd.canOpen && nd.n > 0) {
      if (openers.indexOf(nd) === -1) openers.push(nd);
    }
  }
}

// Resolve emphasis / strikethrough delimiters in place (CommonMark
// delimiter-stack algorithm, with the odd-match rule for * and _).
function resolveEmphasis(nodes) {
  for (const nd of nodes) {
    // Emphasis inside a link / image is resolved within the link's own
    // kids (a separate scope); recurse before treating the node as opaque.
    if (nd.k === 'link' && nd.kids) resolveEmphasis(nd.kids);
  }
  emStrongPass(nodes);
  delPass(nodes);
}

// Render a resolved node list to HTML.
function renderInlineNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 'text' || nd.k === 'code' || nd.k === 'html' ||
        nd.k === 'br' || nd.k === 'soft') {
      out += nd.h;
    } else if (nd.k === 'delim') {
      out += nd.ch.repeat(nd.n);
    } else if (nd.k === 'bracket') {
      out += nd.h;
    } else if (nd.k === 'em') {
      out += '<' + nd.tag + '>' + renderInlineNodes(nd.kids) + '</' + nd.tag + '>';
    } else if (nd.k === 'link') {
      const href = escText(nd.href === null ? '' : nd.href, true);
      if (nd.image) {
        const alt = escText(plainText(nd.kids || []), true);
        out += '<img src="' + href + '" alt="' + alt + '"';
        if (nd.title) out += ' title="' + escText(nd.title, true) + '"';
        out += '>';
      } else {
        out += '<a href="' + href + '"';
        if (nd.title) out += ' title="' + escText(nd.title, true) + '"';
        out += '>' + renderInlineNodes(nd.kids || []) + '</a>';
      }
    }
  }
  return out;
}

// Email / extended-URL scanning helpers (GFM autolinks).

const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/;
const EMAIL_DOMAIN_LABEL = /[A-Za-z0-9-_]/;

// Scan an email domain starting at s[pos] (pos = first domain char),
// mirroring marked's email regex: labels of [A-Za-z0-9-_], dots, and
// a (?![\w-]) lookahead after the final label (backtracking over a
// trailing _ or -). Returns the domain end index, or -1 if there is
// no valid domain (needs at least one dot, last label ending alnum).
// When the domain ends right before a '_' that closes an unmatched
// '_' emphasis opener (the email sits inside _..._ / __...__), the
// full domain is used instead of the backtracked one — marked
// resolves the emphasis first, so inside the em the email has no
// trailing '_'.
function scanEmailDomain(s, pos, hasUnderscoreOpener) {
  const n = s.length;
  let j = pos;
  while (j < n) {
    const c = s[j];
    if (EMAIL_DOMAIN_LABEL.test(c)) { j++; continue; }
    if (c === '.') {
      if (j + 1 < n && EMAIL_DOMAIN_LABEL.test(s[j + 1])) { j++; continue; }
      break;
    }
    break;
  }
  // fullEnd: the greedy domain trimmed to an alnum-ending label.
  let fullEnd = j;
  while (fullEnd > pos && !alnumCode(s.charCodeAt(fullEnd - 1))) fullEnd--;
  if (fullEnd === pos) return -1;
  let hasDot = false;
  for (let k = pos; k < fullEnd; k++) if (s[k] === '.') { hasDot = true; break; }
  if (!hasDot) return -1;
  if (fullEnd < n) {
    const nc = s[fullEnd];
    if (nc === '_' || nc === '-') {
      if (nc === '_' && hasUnderscoreOpener) return fullEnd;
      // Backtrack to the previous label end (its next char is '.',
      // which passes the lookahead); no dot left means no domain.
      let back = -1;
      for (let k = fullEnd - 1; k >= pos; k--) {
        if (s[k] === '.') { back = k; break; }
      }
      if (back === -1) return -1;
      let dotBefore = false;
      for (let k = pos; k < back; k++) if (s[k] === '.') { dotBefore = true; break; }
      if (!dotBefore) return -1;
      return back;
    }
  }
  return fullEnd;
}

// Scan a domain starting at s[pos] (pos = first domain char). Returns the
// end index, or -1 if there is no valid domain (needs at least one dot).
function scanDomain(s, pos) {
  const n = s.length;
  let j = pos;
  let labels = 0;
  let lastDot = -1;
  while (j < n) {
    const c = s[j];
    if (EMAIL_DOMAIN_LABEL.test(c)) { j++; continue; }
    if (c === '.') {
      // A dot must be followed by a label char.
      if (j + 1 >= n || !EMAIL_DOMAIN_LABEL.test(s[j + 1])) break;
      labels++;
      lastDot = j;
      j++;
      continue;
    }
    break;
  }
  if (labels === 0) return -1;
  // The domain must not end with a dot or with -/_ as the final char of
  // the last label (the last label must end with an alnum).
  if (j === pos) return -1;
  const lastCh = s[j - 1];
  if (lastCh === '.' || lastCh === '-' || lastCh === '_') return -1;
  return j;
}

// Trim a greedy extended URL to its real end (backpedal): drop trailing
// punctuation, unbalanced ')', and a trailing &name; entity.
function trimUrlEnd(url) {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (ch === ')') {
      // Keep a trailing ')' iff it is matched by a '(' earlier in
      // the URL, scanning left to right (an unmatched ')' in the
      // middle does not consume the match).
      let depth = 0;
      for (let k = 0; k < end - 1; k++) {
        if (url[k] === '(') depth++;
        else if (url[k] === ')' && depth > 0) depth--;
      }
      if (depth === 0) { end--; continue; }
      return end;
    }
    if ('?!.,:;*_\'"~'.indexOf(ch) !== -1) {
      if (ch === ';') {
        let k = end - 2;
        while (k >= 0 && alnumCode(url.charCodeAt(k))) k--;
        if (k >= 0 && url[k] === '&') { end = k; continue; }
      }
      end--;
      continue;
    }
    return end;
  }
  return end;
}

// Is the raw source text s[from..to) bracket-balanced (for link-text
// matching)? Counts '[' / ']' while skipping backslash escapes and
// code spans. An unmatched ']' or a dangling '[' makes it unbalanced.
function balancedText(s, from, to) {
  let depth = 0;
  let j = from;
  while (j < to) {
    const c = s[j];
    if (c === '\\' && j + 1 < to) { j += 2; continue; }
    if (c === '`') {
      // Mirror marked's link-text label pattern: a backtick run is
      // consumable only as a code span (an opening run, non-backtick
      // content, and a closing run of ANY length — the next backtick
      // run ends it) or as a dangling run immediately before the
      // ']' — and the dangling run needs at least 2 backticks
      // (marked's ``+(?=\]) is a literal backtick plus one-or-more:
      // a single ` before ] does NOT match, so `[foo`](/uri)` forms
      // no link). An unmatched run anywhere else blocks the link:
      // `[foo `bar baz](u)` and `[x ``a ` b`` y](u)` do not form in
      // marked, while `[for table ``a ` b``](u)` does (the trailing
      // 2-backtick run sits right before ']').
      let k = j;
      while (k < to && s[k] === '`') k++;
      let m = k;
      let found = -1;
      while (m < to) {
        if (s[m] === '`') {
          let e = m;
          while (e < to && s[e] === '`') e++;
          found = e;
          break;
        }
        m++;
      }
      if (found === -1) {
        if (k !== to || k - j < 2) return false;
        j = k;
        continue;
      }
      j = found;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth < 0) return false;
    }
    j++;
  }
  return depth === 0;
}

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------

// GFM inLink state (marked's inline lexer state.inLink): set by an
// unclosed <a ...> tag, cleared by </a>. While set, bare-URL and
// email autolinks are suppressed (angle autolinks and bracket links
// are not). Persists across paragraphs for the whole document;
// reset in parse().
let inLink = false;

function parseInline(src, refs) {
  const nodes = [];
  const brackets = [];
  // Masked `[...](...)` spans (marked's emStrong mask: a blockSkip
  // inline link — valid or not — hides its _ / * from the emStrong
  // scan). Recorded when a '[' is seen; delim nodes inside a span get
  // masked=true at push time.
  const maskedSpans = [];
  function isMaskedPos(p) {
    for (let q = maskedSpans.length - 1; q >= 0; q--) {
      const sp = maskedSpans[q];
      if (p >= sp[0] && p < sp[1]) return true;
    }
    return false;
  }
  let pending = '';
  let pendingStart = 0;
  let lastOut = '';
  let i = 0;
  const n = src.length;

  function prevOut() {
    if (pending.length) return pending[pending.length - 1];
    return lastOut;
  }
  function wwwOK() {
    const c = prevOut();
    return c === '' || c === ' ' || c === '\t' || c === '\n' || c === '\r' ||
      c === '\f' || c === '(' || c === '*' || c === '_' || c === '~' ||
      c === '>' || wsCh(c);
  }
  function flush() {
    if (!pending) return;
    const html = escText(pending);
    const last = nodes[nodes.length - 1];
    if (last && last.k === 'text') { last.h += html; last.r += pending; }
    else nodes.push({ k: 'text', h: html, r: pending });
    lastOut = html[html.length - 1];
    pending = '';
  }
  function pushNode(node, lastChar) {
    flush();
    nodes.push(node);
    lastOut = lastChar;
  }
  function pushAutolink(text, hrefText) {
    flush();
    const link = {
      k: 'link', href: cleanUrl(hrefText), title: null,
      kids: [{ k: 'text', h: escText(text), r: text }], image: false,
      auto: true,
    };
    nodes.push(link);
    lastOut = '>';
  }

  // Does this node list contain a (non-image) link, recursing into
  // emphasis but not into images (an image's alt text is not link text).
  // A link may not contain another (bracket) link, but autolinks do not
  // count: an angle autolink stays a nested link inside link text, and
  // an extended autolink (bare URL / email) is flattened back to text
  // when the outer link forms (see stripExtAutolinks in tryLink).
  function containsLink(list) {
    for (const nd of list) {
      if (nd.k === 'link' && !nd.image && !nd.auto) return true;
      if (nd.k === 'em' && containsLink(nd.kids)) return true;
    }
    return false;
  }

  // Replace extended autolinks (bare URL / www. / email) in list with
  // their plain-text child, recursing into emphasis. Angle autolinks
  // are kept as links.
  function stripExtAutolinks(list) {
    const out = [];
    for (const nd of list) {
      if (nd.k === 'link' && nd.auto && nd.ext) {
        out.push(...nd.kids);
      } else if (nd.k === 'em') {
        out.push({ ...nd, kids: stripExtAutolinks(nd.kids) });
      } else {
        out.push(nd);
      }
    }
    return out;
  }

  // Try to form a link/image for brackets[b] at the ']' at closePos.
  // Returns the index just past the link, or -1.
  function tryLink(b, closePos) {
    flush();
    const br = brackets[b];
    const bIdx = nodes.indexOf(br);
    if (bIdx === -1) return -1;
    // The label for a shortcut / collapsed reference is the RAW source
    // text of the bracket content (backslashes kept: `\]` stays `\]`),
    // not the parsed plain text (where `\]` has become `]`).
    const rawLabel = foldLabel(src.slice(br.srcPos, closePos));
    let end = -1, dest = null, title = null;
    const after = closePos + 1;
    if (after < n && src[after] === '(') {
      // Inline link.
      let j = skipWsNl(src, after + 1);
      let d = null;
      if (j < n && src[j] === ')') {
        d = { end: j, dest: '' };
      } else {
        d = parseDest(src, j);
      }
      if (d) {
        j = skipWsNl(src, d.end);
        let t = null;
        if (j < n && (src[j] === '"' || src[j] === "'" || src[j] === '(')) {
          t = parseTitle(src, j);
          if (t) j = skipWsNl(src, t.end);
        }
        if (j < n && src[j] === ')') {
          end = j + 1;
          dest = d.dest;
          title = t ? t.title : null;
        }
      }
      // A failed inline link falls back to a shortcut reference.
      if (end === -1) {
        const ref = rawLabel ? refs[rawLabel] : undefined;
        if (ref) { end = after; dest = ref.dest; title = ref.title; }
      }
    } else if (after < n && src[after] === '[') {
      // Full / collapsed reference link.
      if (after + 1 < n && src[after + 1] === ']') {
        const ref = rawLabel ? refs[rawLabel] : undefined;
        if (ref) { end = after + 2; dest = ref.dest; title = ref.title; }
      } else {
        const lab = parseLabel(src, after);
        if (lab) {
          const ref = refs[foldLabel(lab.label)];
          if (ref) { end = lab.end; dest = ref.dest; title = ref.title; }
        }
      }
    } else {
      // Shortcut reference link.
      const ref = rawLabel ? refs[rawLabel] : undefined;
      if (ref) { end = after; dest = ref.dest; title = ref.title; }
    }
    if (end === -1 || dest === null) return -1;
    let kids = nodes.slice(bIdx + 1);
    // A link may not contain another link. Once a bracket's text holds
    // a link it can never form one, so deactivate it: otherwise a
    // later bare-URL scan would stop at its ']' and truncate the URL.
    if (!br.image && containsLink(kids)) {
      br.active = false;
      return -1;
    }
    // Extended autolinks inside the link text flatten back to plain
    // text (a bare URL / email is not autolinked inside link text).
    kids = stripExtAutolinks(kids);
    // The link formed, so its text is its own scope: unmask its
    // delimiters for the emStrong scan.
    unmaskDelims(kids);
    // Deactivate brackets inside the link text. When a LINK forms,
    // also deactivate every ancestor LINK bracket: its text now holds
    // a link, so it can never form one (and a later bare-URL scan
    // must not stop at its ']'). Image brackets are exempt: an
    // image's alt text may contain a link.
    for (let k = 0; k < brackets.length; k++) {
      if (k === b) continue;
      const other = brackets[k];
      if (!other.active) continue;
      if (nodes.indexOf(other) > bIdx) other.active = false;
      else if (!br.image && !other.image) other.active = false;
    }
    const link = {
      k: 'link', href: cleanUrl(dest),
      title: title !== null && title !== undefined ? title : null,
      kids, image: br.image,
    };
    nodes.splice(bIdx, nodes.length - bIdx, link);
    lastOut = '>';
    return end;
  }

  // Would a link form if a ']' were at closePos? Same decision as
  // tryLink (balanced label + valid destination / reference + no
  // nested bracket link), but without touching the node list. Used by
  // the code-span matcher: marked tries the link tokenizer before
  // the code span, so a code span must not swallow the ']' of a link
  // that would form (its label's mismatched backtick runs are then
  // literal text, parsed when the link text is re-tokenised).
  function wouldFormLink(closePos) {
    const after = closePos + 1;
    for (let k = 0; k < brackets.length; k++) {
      const br = brackets[k];
      if (!br.active) continue;
      if (!balancedText(src, br.srcPos, closePos)) continue;
      const rawLabel = foldLabel(src.slice(br.srcPos, closePos));
      let end = -1, dest = null, title = null;
      if (after < n && src[after] === '(') {
        let j = skipWsNl(src, after + 1);
        let d = null;
        if (j < n && src[j] === ')') d = { end: j, dest: '' };
        else d = parseDest(src, j);
        if (d) {
          j = skipWsNl(src, d.end);
          let t = null;
          if (j < n && (src[j] === '"' || src[j] === "'" || src[j] === '(')) {
            t = parseTitle(src, j);
            if (t) j = skipWsNl(src, t.end);
          }
          if (j < n && src[j] === ')') {
            end = j + 1; dest = d.dest; title = t ? t.title : null;
          }
        }
        if (end === -1) {
          const ref = rawLabel ? refs[rawLabel] : undefined;
          if (ref) { end = after; dest = ref.dest; title = ref.title; }
        }
      } else if (after < n && src[after] === '[') {
        if (after + 1 < n && src[after + 1] === ']') {
          const ref = rawLabel ? refs[rawLabel] : undefined;
          if (ref) { end = after + 2; dest = ref.dest; title = ref.title; }
        } else {
          const lab = parseLabel(src, after);
          if (lab) {
            const ref = refs[foldLabel(lab.label)];
            if (ref) { end = lab.end; dest = ref.dest; title = ref.title; }
          }
        }
      } else {
        const ref = rawLabel ? refs[rawLabel] : undefined;
        if (ref) { end = after; dest = ref.dest; title = ref.title; }
      }
      if (end === -1 || dest === null) continue;
      const bIdx = nodes.indexOf(br);
      if (bIdx === -1) continue;
      if (!br.image && containsLink(nodes.slice(bIdx + 1))) continue;
      return true;
    }
    return false;
  }

  // Try an email autolink at the '@' at atPos. Returns the end index or -1.
  function tryEmail(atPos) {
    // Source-level gate: a backslash-escaped character cannot be part of
    // a bare email's local part (cm-606: `foo\+@bar.example.com` is
    // literal text). Scan the local part in the SOURCE; if it runs
    // straight into a backslash, the first local char was escaped.
    let sj = atPos - 1;
    while (sj >= 0) {
      const ch = src[sj];
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
          (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' ||
          ch === '+' || ch === '-') {
        sj--;
      } else break;
    }
    if (sj >= 0 && src[sj] === '\\') return -1;
    // Local part: scan backwards in pending (restricted set).
    let start = pending.length;
    while (start > 0) {
      const ch = pending[start - 1];
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
          (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' ||
          ch === '+' || ch === '-') {
        start--;
      } else break;
    }
    if (start === pending.length) return -1;
    const local = pending.slice(start);
    // Scheme prefix (mailto: / xmpp:) immediately before the local part.
    let scheme = '';
    let linkStart = start;
    const before = pending.slice(0, start);
    if (before.endsWith('mailto:')) {
      const sPos = start - 7;
      const prev = sPos === 0 ? lastOut : pending[sPos - 1];
      if (sPos === 0 || !alnumCode(prev.charCodeAt(0))) {
        scheme = 'mailto:'; linkStart = sPos;
      }
    } else if (before.endsWith('xmpp:')) {
      const sPos = start - 5;
      const prev = sPos === 0 ? lastOut : pending[sPos - 1];
      if (sPos === 0 || !alnumCode(prev.charCodeAt(0))) {
        scheme = 'xmpp:'; linkStart = sPos;
      }
    }
    // Domain (needs at least one dot). An unmatched '_' opener
    // before the email means a trailing '_' is the emphasis closer,
    // so the full domain is used (see scanEmailDomain).
    let hasUnderscoreOpener = false;
    for (let k = nodes.length - 1; k >= 0; k--) {
      const nd = nodes[k];
      if (nd.k === 'delim' && nd.ch === '_' && nd.canOpen && nd.n > 0) {
        hasUnderscoreOpener = true;
        break;
      }
    }
    const dEnd = scanEmailDomain(src, atPos + 1, hasUnderscoreOpener);
    if (dEnd === -1) return -1;
    let end = dEnd;
    let text = scheme + local + '@' + src.slice(atPos + 1, dEnd);
    let hrefText = scheme ? text : 'mailto:' + text;
    if (scheme === 'xmpp:') {
      // Optional single /[A-Za-z0-9@.]+ path segment.
      if (dEnd < n && src[dEnd] === '/') {
        let j = dEnd + 1;
        while (j < n) {
          const cc = src[j];
          if (alnumCode(cc.charCodeAt(0)) || cc === '@' || cc === '.') j++;
          else break;
        }
        if (j > dEnd + 1) {
          text += src.slice(dEnd, j);
          hrefText = text;
          end = j;
        }
      }
    }
    pending = pending.slice(0, linkStart);
    flush();
    const link = {
      k: 'link', href: cleanUrl(hrefText), title: null,
      kids: [{ k: 'text', h: escText(text), r: text }], image: false,
      auto: true, ext: true,
    };
    nodes.push(link);
    lastOut = '>';
    return end;
  }

  // Try an extended autolink (www. / scheme://) at pos. Returns the end
  // index or -1.
  function tryExtUrl(pos, isWww) {
    let j;
    if (isWww) {
      j = pos + 4;
    } else {
      const m = /^(https?:\/\/|ftp:\/\/)/i.exec(src.slice(pos, pos + 8));
      if (!m) return -1;
      j = pos + m[0].length;
    }
    // Domain labels.
    const domStart = j;
    let k = j;
    while (k < n) {
      const cc = src[k];
      if (alnumCode(cc.charCodeAt(0)) || cc === '-') { k++; continue; }
      if (cc === '.') {
        if (k + 1 < n && (alnumCode(src.charCodeAt(k + 1)) || src[k + 1] === '-')) {
          k++; continue;
        }
        break;
      }
      break;
    }
    if (k === domStart) return -1;
    // Rest: any chars except whitespace and '<'. Inside link text
    // (an active '['), stop at ']' so the bracket can still close and
    // form the outer link; the bare URL inside link text is plain
    // text, not an autolink (stripExtAutolinks handles it).
    const inBrackets = brackets.some((br) => br.active);
    let end = k;
    while (end < n) {
      const cc = src[end];
      if (cc === ' ' || cc === '\t' || cc === '\n' || cc === '\r' ||
          cc === '\f' || cc === '<') break;
      if (cc === ']' && inBrackets) break;
      // A `(` right after a `]` (or its percent-encoding `%5D`)
      // ends the bare URL — unless the `(` is closed by a matching
      // `)` later in the URL (balanced parens stay in the URL, e.g.
      // `...page=4)%5D(./docs/create.md)` is one URL).
      if (cc === '(' && end > pos) {
        const afterBracket = src[end - 1] === ']' ||
          (end - 3 >= pos && src[end - 3] === '%' && src[end - 2] === '5' &&
            (src[end - 1] === 'D' || src[end - 1] === 'd'));
        if (afterBracket) {
          let hasClose = false;
          for (let q = end + 1; q < n; q++) {
            const cq = src[q];
            if (cq === ' ' || cq === '\t' || cq === '\n' || cq === '\r' || cq === '\f' || cq === '<') break;
            if (cq === ')') { hasClose = true; break; }
          }
          if (!hasClose) break;
        }
      }
      end++;
    }
    const url = src.slice(pos, pos + trimUrlEnd(src.slice(pos, end)));
    if (!url) return -1;
    flush();
    const hrefText = isWww ? 'http://' + url : url;
    const link = {
      k: 'link', href: cleanUrl(hrefText), title: null,
      kids: [{ k: 'text', h: escText(url), r: url }], image: false,
      auto: true, ext: true,
    };
    nodes.push(link);
    lastOut = '>';
    return pos + url.length;
  }

  // Is the whole string a valid email for an angle autolink?
  function angleEmail(inner) {
    const at = inner.indexOf('@');
    if (at <= 0) return false;
    const local = inner.slice(0, at);
    for (let k = 0; k < local.length; k++) {
      if (!EMAIL_LOCAL.test(local[k])) return false;
    }
    const dom = inner.slice(at + 1);
    // Domain: labels of alnum, starting/ending alnum, max 63 chars, dots.
    let j = 0;
    let labels = 0;
    while (j < dom.length) {
      const ls = j;
      while (j < dom.length && (alnumCode(dom.charCodeAt(j)) || dom[j] === '-')) j++;
      if (j === ls) return false;
      if (j - ls > 63) return false;
      if (!alnumCode(dom.charCodeAt(ls)) || !alnumCode(dom.charCodeAt(j - 1))) return false;
      labels++;
      if (j >= dom.length) break;
      if (dom[j] !== '.') return false;
      j++;
      if (j >= dom.length) return false;
    }
    if (labels < 2) return false;
    return true;
  }

  while (i < n) {
    const c = src[i];
    // Extended autolinks: www. (lowercase only, needs a boundary before
    // it) and schemes.
    if (c === 'w') {
      if (!inLink && src.slice(i, i + 4) === 'www.' && wwwOK()) {
        const end = tryExtUrl(i, true);
        if (end !== -1) { i = end; pendingStart = i; continue; }
      }
    } else if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
      const low = src.slice(i, i + 8).toLowerCase();
      if (!inLink && (low.startsWith('http://') || low.startsWith('https://') ||
          low.startsWith('ftp://'))) {
        const end = tryExtUrl(i, false);
        if (end !== -1) { i = end; pendingStart = i; continue; }
      }
    }
    // Line break (soft / hard).
    if (c === '\n') {
      let sp = 0;
      while (sp < pending.length && pending[pending.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        pending = pending.slice(0, pending.length - sp);
        flush();
        nodes.push({ k: 'br', h: '<br>' });
        lastOut = '>';
        i++;
        // A hard break strips the next line's leading spaces/tabs.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        pendingStart = i;
        continue;
      }
      flush();
      nodes.push({ k: 'soft', h: '\n' });
      lastOut = '\n';
      i++;
      pendingStart = i;
      continue;
    }
    // Backslash escape / hard break.
    if (c === '\\') {
      if (i + 1 < n) {
        const nc = src[i + 1];
        if (nc === '\n') {
          flush();
          nodes.push({ k: 'br', h: '<br>' });
          lastOut = '>';
          i += 2;
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          pendingStart = i;
          continue;
        }
        const code = nc.charCodeAt(0);
        if (code < 128 && PUNCT[code] === 1) {
          if (nc === '&') {
            // A literal '&' must not merge into a fake entity.
            flush();
            const last = nodes[nodes.length - 1];
            if (last && last.k === 'text') { last.h += '&amp;'; last.r += '&'; }
            else nodes.push({ k: 'text', h: '&amp;', r: '&' });
            lastOut = ';';
            i += 2;
            pendingStart = i;
            continue;
          }
          pending += nc;
          i += 2;
          continue;
        }
      }
      pending += '\\';
      i++;
      continue;
    }
    // Code span.
    if (c === '`') {
      let run = 1;
      while (i + run < n && src[i + run] === '`') run++;
      let j = i + run, found = -1;
      while (j < n) {
        if (src[j] === ']' && brackets.length) {
          // An unescaped ']' that would close a link: the link wins
          // over the code span (marked's tokenizer order), so do not
          // form a span that swallows it. But marked's emStrong mask
          // (blockSkip precode-code) still masks the would-be code
          // span — from this opener to its exact-length closer — so
          // any * / _ inside it stays invisible to the emStrong scan.
          let bs = 0;
          for (let q = j - 1; q >= 0 && src[q] === '\\'; q--) bs++;
          if (bs % 2 === 0 && wouldFormLink(j)) {
            let k = j;
            while (k < n) {
              if (src[k] === '`') {
                let r2 = 1;
                while (k + r2 < n && src[k + r2] === '`') r2++;
                if (r2 === run) { maskedSpans.push([i, k + run]); break; }
                k += r2;
              } else k++;
            }
            break;
          }
        }
        if (src[j] === '`') {
          let r2 = 1;
          while (j + r2 < n && src[j + r2] === '`') r2++;
          if (r2 === run) { found = j; break; }
          j += r2;
        } else j++;
      }
      if (found !== -1) {
        let content = src.slice(i + run, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' &&
            content[content.length - 1] === ' ') {
          let allSpace = true;
          for (let q = 0; q < content.length; q++) {
            if (content[q] !== ' ') { allSpace = false; break; }
          }
          if (!allSpace) content = content.slice(1, -1);
        }
        pushNode({ k: 'code', h: '<code>' + escCode(content) + '</code>', r: content }, '>');
        i = found + run;
        pendingStart = i;
        continue;
      }
      pending += src.slice(i, i + run);
      i += run;
      continue;
    }
    // Emphasis / strikethrough delimiters.
    if (c === '*' || c === '_' || c === '~') {
      let run = 1;
      while (i + run < n && src[i + run] === c) run++;
      if (c === '~' && run >= 3) {
        pending += src.slice(i, i + run);
        i += run;
        continue;
      }
      const before = cpBefore(src, i);
      const after = cpAfter(src, i + run);
      const beforeWs = before === '' || wsCh(before);
      const afterWs = after === '' || wsCh(after);
      const beforePunct = before !== '' && punctCh(before);
      const afterPunct = after !== '' && punctCh(after);
      const leftFl = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFl = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFl && (!rightFl || beforePunct);
        canClose = rightFl && (!leftFl || afterPunct);
      } else {
        canOpen = leftFl;
        canClose = rightFl;
      }
      if (!canOpen && !canClose) {
        pending += src.slice(i, i + run);
        i += run;
        continue;
      }
      const use = c === '~' ? Math.min(run, 2) : run;
      pushNode({ k: 'delim', ch: c, n: use, orig: run, canOpen, canClose, masked: isMaskedPos(i) }, c);
      i += use;
      continue;
    }
    // Angle autolink / raw HTML tag.
    if (c === '<') {
      const gt = src.indexOf('>', i + 1);
      if (gt !== -1) {
        const inner = src.slice(i + 1, gt);
        if (inner.length > 0 && !/[\s\x00-\x1f<>]/.test(inner)) {
          const m = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):(.*)$/.exec(inner);
          if (m) {
            pushAutolink(inner, inner);
            i = gt + 1;
            pendingStart = i;
            continue;
          }
          if (angleEmail(inner)) {
            pushAutolink(inner, 'mailto:' + inner);
            i = gt + 1;
            pendingStart = i;
            continue;
          }
        }
      }
      const tagEnd = parseTag(src, i);
      if (tagEnd !== -1) {
        const raw = src.slice(i, tagEnd);
        // marked's tag tokenizer: a literal "<a " opens inLink,
        // "</a>" closes it; while inLink, bare-URL and email
        // autolinks are suppressed.
        if (/^<a /i.test(raw)) inLink = true;
        else if (/^<\/a>/i.test(raw)) inLink = false;
        pushNode({ k: 'html', h: raw, r: raw }, '>');
        i = tagEnd;
        pendingStart = i;
        continue;
      }
      pending += '<';
      i++;
      continue;
    }
    // Link / image bracket.
    if (c === '[' || (c === '!' && i + 1 < n && src[i + 1] === '[')) {
      const isImg = c === '!';
      // Record a masked `[...](...)` span for the emStrong scan.
      if (!isImg) {
        const mEnd = matchMaskedLink(src, i);
        if (mEnd !== -1) maskedSpans.push([i, mEnd]);
      } else {
        const mEnd = matchMaskedLink(src, i + 1);
        if (mEnd !== -1) maskedSpans.push([i + 1, mEnd]);
      }
      const node = {
        k: 'bracket', h: isImg ? '![' : '[', r: isImg ? '![' : '[',
        active: true, image: isImg,
      };
      pushNode(node, '[');
      brackets.push(node);
      i += isImg ? 2 : 1;
      // srcPos: the source index just after the '['; the shortcut /
      // collapsed label is the raw source text from here to the ']'.
      node.srcPos = i;
      pendingStart = i;
      continue;
    }
    // Closing bracket: try to form a link. Marked (and the spec) match a
    // link from the OUTERMOST '[' whose text has balanced brackets:
    // `[a [b]](/u)` links `a [b]`, while `[a [b](/u)` links only `b`
    // (the outer text `a [b` is unbalanced there). So try active
    // brackets outermost-first, skipping any whose text between the
    // bracket and this ']' has unbalanced brackets.
    if (c === ']') {
      let done = false;
      for (let k = 0; k < brackets.length && !done; k++) {
        const br = brackets[k];
        if (!br.active) continue;
        if (!balancedText(src, br.srcPos, i)) continue;
        const end = tryLink(k, i);
        if (end !== -1) {
          brackets[k].active = false;
          i = end;
          pendingStart = i;
          done = true;
        }
      }
      if (done) continue;
      pending += ']';
      i++;
      continue;
    }
    // Email autolink (suppressed while inside an unclosed <a>).
    if (c === '@') {
      const end = inLink ? -1 : tryEmail(i);
      if (end !== -1) {
        i = end;
        pendingStart = i;
        continue;
      }
      pending += '@';
      i++;
      continue;
    }
    // Plain text character.
    pending += c;
    i++;
  }
  flush();
  resolveEmphasis(nodes);
  return renderInlineNodes(nodes);
}

// ---------------------------------------------------------------------------
// Block parser (CommonMark open-container algorithm + GFM tables)
// ---------------------------------------------------------------------------

// Cursor over one source line: index, column, and the remainder of a
// partially consumed tab (rendered as spaces).
class Cur {
  constructor(line) {
    this.s = line;
    this.i = 0;
    this.col = 0;
    this.part = 0;
  }
  ch() {
    if (this.part > 0) return ' ';
    return this.i < this.s.length ? this.s[this.i] : '';
  }
  adv1() {
    if (this.part > 0) {
      this.part--;
      this.col++;
      if (this.part === 0) this.i++;
    } else if (this.i < this.s.length) {
      this.i++;
      this.col++;
    }
  }
  advCols(n) {
    while (n > 0 && this.i < this.s.length) {
      if (this.part > 0) {
        const take = Math.min(n, this.part);
        this.part -= take;
        this.col += take;
        n -= take;
        if (this.part === 0) this.i++;
      } else {
        const c = this.s[this.i];
        if (c === ' ') { this.i++; this.col++; n--; }
        else if (c === '\t') {
          const w = 4 - (this.col % 4);
          if (n < w) { this.part = w - n; this.col += n; n = 0; }
          else { this.i++; this.col += w; n -= w; }
        } else break;
      }
    }
  }
  advSpace() {
    while (this.i < this.s.length) {
      if (this.part > 0) {
        this.col += this.part;
        this.part = 0;
        this.i++;
      } else {
        const c = this.s[this.i];
        if (c === ' ') { this.i++; this.col++; }
        else if (c === '\t') { this.i++; this.col += 4 - (this.col % 4); }
        else break;
      }
    }
  }
  blank() {
    for (let j = this.i; j < this.s.length; j++) {
      const c = this.s[j];
      if (c !== ' ' && c !== '\t') return false;
    }
    return true;
  }
  indent() {
    let col = this.col, j = this.i, part = this.part;
    if (part > 0) { col += part; j++; part = 0; }
    while (j < this.s.length) {
      const c = this.s[j];
      if (c === ' ') { col++; j++; }
      else if (c === '\t') { col += 4 - (col % 4); j++; }
      else break;
    }
    return col - this.col;
  }
  rest() {
    if (this.part > 0) return ' '.repeat(this.part) + this.s.slice(this.i + 1);
    return this.s.slice(this.i);
  }
  save() { return { i: this.i, col: this.col, part: this.part }; }
  load(sv) { this.i = sv.i; this.col = sv.col; this.part = sv.part; }
}

function mkBlock(type, up) {
  const b = {
    type, kids: [], lines: [], open: true, up: up || null,
    lastBlank: false, lastLazy: false,
  };
  if (up) up.kids.push(b);
  return b;
}
function lastOpenKid(b) {
  for (let i = b.kids.length - 1; i >= 0; i--) {
    if (b.kids[i].open) return b.kids[i];
  }
  return null;
}

// Expand leading tabs in s to spaces, given that s starts at absolute
// column startCol. Used for fenced-code content inside a container:
// a tab at the content position expands to the next tab stop
// (e.g. a tab at col 2 becomes 2 spaces). At the top level
// (startCol 0) a leading tab stays literal, so callers only use this
// when inside a container.
function expandLeadTabs(s, startCol) {
  let col = startCol, j = 0;
  let out = '';
  while (j < s.length) {
    const c = s[j];
    if (c === ' ') { out += ' '; col++; j++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      j++;
    } else break;
  }
  return out + s.slice(j);
}

// Strip up to ncols columns of leading whitespace from a string.
// A tab straddling the boundary leaves spaces for its remainder.
// Strip up to n leading whitespace characters from a fenced-code
// content line. A tab counts as ONE character here (marked's fence
// rule): a tab that starts inside the strip region is removed whole,
// not partially expanded. So `\tfoo` under a 3-space fence becomes
// `foo`, and ` \tfoo` becomes `foo`, while `    foo` becomes ` foo`.
function stripFenceLead(s, n) {
  let i = 0;
  while (i < s.length && i < n && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(i);
}

function stripLead(s, ncols) {
  let i = 0, col = 0;
  while (i < s.length && col < ncols) {
    const c = s[i];
    if (c === ' ') { i++; col++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w > ncols) return ' '.repeat(col + w - ncols) + s.slice(i + 1);
      i++; col += w;
    } else break;
  }
  return s.slice(i);
}

// Match a blockquote marker at the cursor. Advances on success.
function matchQuote(st) {
  let spaces = 0;
  while (spaces < 3) {
    const c = st.ch();
    if (c === ' ') { st.advCols(1); spaces++; }
    else if (c === '\t') {
      const w = 4 - (st.col % 4);
      if (spaces + w > 3) break;
      st.advCols(w);
      spaces += w;
    } else break;
  }
  if (st.ch() !== '>') return false;
  st.adv1();
  // One optional space/tab after the marker: consume a single column only
  // (a tab is partially consumed, leaving the rest as spaces).
  // Marked expands the tab relative to the marker length (its J step)
  // and then strips `>` + 1 space, so the tab's width comes from the
  // marker length (leading spaces + '>'), not the absolute column:
  // `>\tfoo` leaves 2 spaces, `  >\tfoo` leaves 2, `   >\tfoo` leaves 2.
  const c = st.ch();
  if (c === ' ') st.advCols(1);
  else if (c === '\t') {
    const markerLen = spaces + 1;
    const w = 4 - (markerLen % 4);
    const remain = w - 1;
    if (remain > 0) {
      st.part = remain;
      st.col += 1;
    } else {
      st.i++;
      st.col += w;
    }
  }
  return true;
}

// Match a list item's content indent at the cursor.
function matchItem(st, item) {
  // The item's content indent is stored RELATIVE to its container's
  // content start (see startList): the container markers consume a
  // different number of columns on each line (e.g. `   > >` vs `>>`),
  // so an absolute column from the creation line is wrong here.
  const target = st.col + item.relContent;
  while (st.col < target) {
    const c = st.ch();
    if (c === ' ') { st.advCols(1); continue; }
    if (c === '\t') {
      const w = 4 - (st.col % 4);
      if (st.col + w > target) {
        st.part = st.col + w - target;
        st.col = target;
        return true;
      }
      st.advCols(w);
      continue;
    }
    return false;
  }
  return st.col === target || (st.col > target && st.part > 0);
}

// Parse a list marker at the cursor. Advances the cursor past the marker
// and its following whitespace (up to the content indent). Returns the
// marker info or null (cursor restored on failure).
function parseMarker(st) {
  const saved = st.save();
  const startCol = st.col;
  const c = st.ch();
  let ordered = false, bullet = '', delim = '', start = 0, markerW = 0;
  if (c === '-' || c === '+' || c === '*') {
    bullet = c;
    markerW = 1;
    st.adv1();
  } else if (c >= '0' && c <= '9') {
    const ds = st.i;
    while (st.i < st.s.length && st.s[st.i] >= '0' && st.s[st.i] <= '9') {
      st.i++;
      st.col++;
    }
    if (st.i - ds > 9) { st.load(saved); return null; }
    start = parseInt(st.s.slice(ds, st.i), 10);
    const dc = st.ch();
    if (dc !== '.' && dc !== ')') { st.load(saved); return null; }
    delim = dc;
    markerW = (st.i - ds) + 1;
    st.adv1();
    ordered = true;
  } else {
    return null;
  }
  // Whitespace after the marker.
  const wsSaved = st.save();
  let spaces = 0;
  while (true) {
    const cc = st.ch();
    if (cc === ' ') { st.advCols(1); spaces++; }
    else if (cc === '\t') {
      const w = 4 - (st.col % 4);
      st.advCols(w);
      spaces += w;
    } else break;
  }
  let contentCol, blank = false;
  if (st.i >= st.s.length && st.part === 0) {
    blank = true;
    contentCol = startCol + markerW + 1;
  } else if (spaces >= 5) {
    contentCol = startCol + markerW + 1;
    st.load(wsSaved);
    st.advCols(contentCol - st.col);
  } else if (spaces >= 1) {
    contentCol = st.col;
  } else {
    st.load(saved);
    return null;
  }
  return { ordered, bullet, delim, start, markerCol: startCol, contentCol, blank };
}

// ATX heading at the cursor. Returns {level, content} or null.
function parseATX(st) {
  const s = st.s;
  let j = st.i, level = 0;
  while (j < s.length && s[j] === '#') { level++; j++; }
  if (level === 0 || level > 6) return null;
  if (j >= s.length) return { level, content: '' };
  const c = s[j];
  if (c !== ' ' && c !== '\t') return null;
  let content = s.slice(j).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // Closing sequence: a run of #s preceded by whitespace (or the whole).
  const m = /^(.*?)[ \t]+#+$/.exec(content);
  if (m) content = m[1].replace(/[ \t]+$/, '');
  else if (/^#+$/.test(content)) content = '';
  return { level, content };
}

// Fenced code at the cursor. Returns {char, len, info} or null.
function parseFence(st) {
  const s = st.s;
  let j = st.i;
  const ch = s[j];
  let len = 0;
  while (j < s.length && s[j] === ch) { len++; j++; }
  if (len < 3) return null;
  const info = s.slice(j).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { char: ch, len, info };
}

// Thematic break at the cursor (indent already <= 3).
function isThematicBreak(st) {
  const s = st.s;
  let j = st.i;
  let marker = '';
  let count = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === ' ' || c === '\t') { j++; continue; }
    if (marker === '') {
      if (c === '-' || c === '*' || c === '_') { marker = c; count = 1; j++; continue; }
      return false;
    }
    if (c === marker) { count++; j++; continue; }
    return false;
  }
  return count >= 3;
}

// Setext underline at the cursor. Returns 1 (=), 2 (-), or 0.
function parseSetext(st) {
  const s = st.s;
  let j = st.i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
  if (j >= s.length) return 0;
  const marker = s[j];
  if (marker !== '=' && marker !== '-') return 0;
  j++;
  while (j < s.length && s[j] === marker) j++;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
  if (j !== s.length) return 0;
  return marker === '=' ? 1 : 2;
}

// HTML block types. Type 1 = pre/script/style/textarea (ends at the closing
// tag). Types 6 = block tag names, 7 = any other complete tag alone on the
// line (both end at a blank line). `title` is a type 6 tag, not type 1.
const HTML_T1 = ['pre', 'script', 'style', 'textarea'];
const HTML_T6 = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block type (1-7) starting at the cursor, or 0.
function htmlBlockType(st) {
  const s = st.s;
  let j = st.i;
  if (s[j] !== '<') return 0;
  if (s.startsWith('<!--', j)) return 2;
  if (s.startsWith('<?', j)) return 3;
  if (s.startsWith('<![CDATA[', j)) return 5;
  if (s.startsWith('<!', j) && j + 2 < s.length) {
    const c2 = s.charCodeAt(j + 2);
    if (alnumCode(c2)) return 4;
  }
  let k = j + 1;
  let closing = false;
  if (s[k] === '/') { closing = true; k++; }
  if (k >= s.length) return 0;
  const tc = s.charCodeAt(k);
  if (!((tc >= 65 && tc <= 90) || (tc >= 97 && tc <= 122))) return 0;
  let name = '';
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (alnumCode(c) || c === 45) { name += s[k].toLowerCase(); k++; }
    else break;
  }
  if (!closing && HTML_T1.indexOf(name) !== -1) return 1;
  if (HTML_T6.has(name)) return 6;
  // Type 7: any other complete tag, alone on the line.
  const tagEnd = parseTagLine(s, j);
  if (tagEnd !== -1) {
    let rest = s.slice(tagEnd);
    if (/^[ \t]*$/.test(rest)) return 7;
  }
  return 0;
}

// Does this line end an open HTML block of the given type? (Types 6/7
// never end this way; they end at a blank line.)
function htmlLineEnds(line, kind, tag) {
  if (kind === 1) {
    // Case-insensitive search for </tag followed by space/tab/>///EOL,
    // without lowercasing the whole line.
    const needle = '</' + tag;
    let idx = 0;
    while (true) {
      idx = line.toLowerCase().indexOf(needle, idx);
      if (idx === -1) return false;
      const after = line[idx + needle.length];
      if (after === undefined || after === ' ' || after === '\t' ||
          after === '>' || after === '/') return true;
      idx++;
    }
  }
  if (kind === 2) return line.indexOf('-->') !== -1;
  if (kind === 3) return line.indexOf('?>') !== -1;
  if (kind === 4) return line.indexOf('>') !== -1;
  if (kind === 5) return line.indexOf(']]>') !== -1;
  return false;
}

// Table helpers -------------------------------------------------------------

// Split a table row/header line into cells. Returns [] for a lone '|'.
// Split a table row into cells, mirroring marked's de() exactly:
// each pipe is replaced by " |" (separator) or "|" (escaped — an odd
// number of backslashes immediately before it), the result is split
// on " |", an empty first/last cell is dropped, cells are trimmed,
// and \| becomes |. When e (header length) is given, rows are padded
// with "" or truncated to e cells.
function splitCells(line, e) {
  let t = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '|') {
      let escaped = false;
      let p = i;
      while (--p >= 0 && line[p] === '\\') escaped = !escaped;
      t += escaped ? '|' : ' |';
      continue;
    }
    t += c;
  }
  const n = t.split(' |');
  if (n.length && n[0].trim() === '') n.shift();
  if (n.length && n[n.length - 1].trim() === '') n.pop();
  if (e !== undefined) {
    if (n.length > e) n.splice(e);
    else while (n.length < e) n.push('');
  }
  for (let s = 0; s < n.length; s++) n[s] = n[s].trim().replace(/\\\|/g, '|');
  return n;
}

// Parse a table delimiter row. Returns alignments or null.
function parseDelimRow(line) {
  const cells = splitCells(line);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Does the line start a block? (Used for lazy-continuation and table-row
// decisions.) An empty list item cannot interrupt a paragraph, and an
// ordered list needs start 1 to interrupt one — EXCEPT when the
// paragraph sits directly inside a list item, where an ordered list of
// any start number interrupts it (the new list nests inside the item).
// When inPara is false (not interrupting a paragraph, e.g. a table row)
// the start-1 rule does not apply either.
function startsBlock(st, inPara, inItem) {
  const ind = st.indent();
  if (ind >= 4) return false;
  // Skip the leading indent so the checks below see the first
  // non-whitespace character.
  const save0 = st.save();
  st.advCols(ind);
  const c = st.ch();
  let r = false;
  if (c === '#') r = parseATX(st) !== null;
  else if (c === '`' || c === '~') r = parseFence(st) !== null;
  else if (c === '<') {
    const t = htmlBlockType(st);
    r = t >= 1 && t <= 6;
  }
  else if (c === '>') r = true;
  else if (c === '-' || c === '+' || c === '*') {
    if (isThematicBreak(st)) r = true;
    else {
      const save = st.save();
      const m = parseMarker(st);
      st.load(save);
      if (m) {
        if (!m.ordered) r = !m.blank;
        else r = (!inPara || inItem || m.start === 1) && !m.blank;
      }
    }
  }
  else if (c >= '0' && c <= '9') {
    const save = st.save();
    const m = parseMarker(st);
    st.load(save);
    r = !!(m && m.ordered && (!inPara || inItem || m.start === 1) && !m.blank);
  }
  st.load(save0);
  return r;
}

// Does the line start a new item in the list that contains the paragraph
// `tip`? Returns that list, or null. The line must be at the list's own
// container level: every quote/item enclosing the list must have matched.
function startsNewItem(st, tip, lastMatched) {
  if (st.indent() >= 4) return null;
  if (isThematicBreak(st)) return null;
  // Walk from the tip itself (not tip.up): after a blank line the tip can
  // be an empty list item, and its parent list must still be found.
  // When a list is rejected (its enclosing containers did not match this
  // line), keep walking up: the marker may belong to an OUTER list.
  let b = tip;
  while (b) {
    if (b.type === 'item' && b.up && b.up.type === 'list') {
      const list = b.up;
      let ok = true;
      let anc = list.up;
      while (anc && anc.type !== 'doc') {
        if (anc.type === 'quote' || anc.type === 'item') {
          let b2 = lastMatched;
          let found = false;
          while (b2) {
            if (b2 === anc) { found = true; break; }
            b2 = b2.up;
          }
          if (!found) { ok = false; break; }
        }
        anc = anc.up;
      }
      if (!ok) { b = b.up; continue; }
      const save = st.save();
      // Skip the leading indent (up to 3 columns) before parsing the
      // marker: the cursor is at the container's content start, not at
      // the marker.
      st.advCols(st.indent());
      const m = parseMarker(st);
      st.load(save);
      if (!m) return null;
      const sameType = m.ordered === list.ordered &&
        (!m.ordered ? list.bullet === m.bullet : list.delim === m.delim);
      return sameType ? list : null;
    }
    b = b.up;
  }
  return null;
}

// A new block added to an item that already has children, after a blank
// line, makes the enclosing list loose.
function markLoose(parent, wasBlank) {
  if (!wasBlank) return;
  if (parent && parent.type === 'item' && parent.kids.length > 0 &&
      parent.up && parent.up.type === 'list') {
    parent.up.tight = false;
  }
}

// Collect link reference definitions from the start of a paragraph's
// lines. Mutates `refs`. Returns the remaining lines (leading spaces kept).
function collectRefdefs(lines, refs) {
  const text = lines.join('\n');
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    let p = pos;
    let ind = 0;
    while (p < n && text[p] === ' ' && ind < 3) { p++; ind++; }
    if (p >= n || text[p] !== '[') break;
    const lbl = parseLabel(text, p);
    if (!lbl) break;
    if (lbl.end >= n || text[lbl.end] !== ':') break;
    let q = skipWsNl(text, lbl.end + 1);
    if (q >= n) break;
    let dest;
    if (text[q] === '<') {
      let e = q + 1;
      while (e < n && text[e] !== '>' && text[e] !== '\n') e++;
      if (e >= n || text[e] !== '>') break;
      dest = text.slice(q + 1, e);
      q = e + 1;
    } else {
      const d = parseDest(text, q);
      if (!d) break;
      dest = d.dest;
      q = d.end;
    }
    const r = skipWsNl(text, q);
    let title = '';
    let endPos;
    if (r < n && (text[r] === '"' || text[r] === "'" || text[r] === '(')) {
      if (r === q) break;
      const t = parseTitle(text, r);
      if (t) {
        let s2 = t.end;
        while (s2 < n && (text[s2] === ' ' || text[s2] === '\t')) s2++;
        if (s2 >= n || text[s2] === '\n') {
          title = t.title;
          endPos = s2 < n ? s2 + 1 : s2;
        } else {
          let s3 = q;
          while (s3 < n && (text[s3] === ' ' || text[s3] === '\t')) s3++;
          if (s3 < n && text[s3] !== '\n') break;
          endPos = s3 < n ? s3 + 1 : s3;
        }
      } else {
        let s3 = q;
        while (s3 < n && (text[s3] === ' ' || text[s3] === '\t')) s3++;
        if (s3 < n && text[s3] !== '\n') break;
        endPos = s3 < n ? s3 + 1 : s3;
      }
    } else {
      let s2 = q;
      while (s2 < n && (text[s2] === ' ' || text[s2] === '\t')) s2++;
      if (s2 < n && text[s2] !== '\n') break;
      endPos = s2 < n ? s2 + 1 : s2;
    }
    const norm = foldLabel(lbl.label);
    if (!norm) break;
    if (!(norm in refs)) refs[norm] = { dest, title };
    pos = endPos;
  }
  const rest = text.slice(pos);
  if (rest === '') return [];
  return rest.split('\n');
}

// Strip one indented-code level (up to 4 columns, or a tab) from the start
// of a line, but only when the line is indented at least 4 columns.
function codeStrip(content) {
  let col = 0, j = 0;
  while (j < content.length) {
    const c = content[j];
    if (c === ' ') { col++; j++; }
    else if (c === '\t') { col += 4 - (col % 4); j++; }
    else break;
  }
  if (col < 4) return content;
  let k = 0, c2 = 0;
  while (k < content.length) {
    const ch = content[k];
    if (ch === ' ') {
      c2++;
      k++;
      if (c2 === 4) return content.slice(k);
    } else if (ch === '\t') {
      return content.slice(k + 1);
    } else break;
  }
  return content;
}

function leadingCols(s) {
  let col = 0, j = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === ' ') { col++; j++; }
    else if (c === '\t') { col += 4 - (col % 4); j++; }
    else break;
  }
  return col;
}

function parseBlocks(src, refs) {
  src = src.replace(/\r\n?/g, '\n');
  const inputEndsNl = src.endsWith('\n');
  let lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const root = mkBlock('doc', null);
  let lastLineBlank = false;
  // Deepest container matched by the most recent blank line. A blank
  // line nested inside a child block (e.g. a blockquote inside an item)
  // does not separate the list's items, so it must not loosen the list.
  let lastBlankBlock = null;

  function getTip() {
    let b = root;
    while (true) {
      const lc = lastOpenKid(b);
      if (!lc) return b;
      b = lc;
    }
  }
  function closeBlock(b) {
    b.open = false;
    if (b.type === 'para') {
      const rest = collectRefdefs(b.lines, refs);
      b.lines = rest;
      if (!rest.length || rest.join('').trim() === '') {
        const par = b.up;
        const idx = par.kids.indexOf(b);
        if (idx !== -1) par.kids.splice(idx, 1);
      }
    }
  }
  function closeTo(stop) {
    let b = getTip();
    while (b !== stop) {
      closeBlock(b);
      b = b.up;
    }
  }
  // Innermost unmatched quote/item in the tip's chain (null if none).
  function innermostUnmatched(tip, lastMatched) {
    let b = tip.up;
    while (b && b !== lastMatched) {
      if (b.type === 'quote' || b.type === 'item') return b;
      b = b.up;
    }
    return null;
  }
  // Is the tip paragraph inside a list item?
  function paraInItem(tip) {
    let b = tip.up;
    while (b) {
      if (b.type === 'item') return true;
      b = b.up;
    }
    return false;
  }
  // Does the line start a list marker while the paragraph sits inside a
  // list item? Such a line always starts a new list (never a lazy line),
  // whatever the marker's type or start number.
  function startsOuterList(st, tip) {
    if (!paraInItem(tip)) return false;
    const save = st.save();
    const m = parseMarker(st);
    st.load(save);
    return !!m;
  }
  // Adjust a lazy continuation line: strip the innermost unmatched list
  // item's content indent, then the code-merge strip where it applies.
  function lazyAdjust(content, tip, lastMatched) {
    const inner = innermostUnmatched(tip, lastMatched);
    if (inner && inner.type === 'item') {
      if (leadingCols(content) >= inner.relContent) {
        content = stripLead(content, inner.relContent);
      }
    }
    const inItem = tip.up && tip.up.type === 'item';
    if (inItem) content = codeStrip(content);
    else if (inner && inner.type === 'quote') content = codeStrip(content);
    return { content, inner };
  }

  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const st = new Cur(line);
    // --- 1. Match open containers ---
    let container = root;
    let allMatched = true;
    let matchedQuote = false;
    // Absolute column just before the innermost successful matchQuote
    // on this line: tab stops in the line's remaining leading
    // whitespace are relative to this frame (marked's blockquote J
    // processing), not to the absolute column.
    let quoteFrameStart = -1;
    let cur = root;
    while (true) {
      const child = lastOpenKid(cur);
      if (!child) break;
      if (child.type === 'list') {
        cur = child;
        continue;
      }
      if (child.type !== 'quote' && child.type !== 'item') break;
      if (child.type === 'item' && st.blank()) {
        container = child;
        cur = child;
        continue;
      }
      const sv = st.save();
      let ok = false;
      // Only the innermost SUCCESSFUL matchQuote sets the frame; a
      // failed attempt (e.g. a lazy line missing the inner '>') must
      // not overwrite it, or later tab stops use the wrong frame.
      let qfs = quoteFrameStart;
      if (child.type === 'quote') {
        qfs = st.col;
        ok = matchQuote(st);
      } else ok = matchItem(st, child);
      if (!ok) {
        st.load(sv);
        allMatched = false;
        break;
      }
      if (child.type === 'quote') { matchedQuote = true; quoteFrameStart = qfs; }
      container = child;
      cur = child;
    }
    let lastMatched = container;
    const restEmpty = st.i >= st.s.length && st.part === 0;
    let blank = matchedQuote ? restEmpty : st.blank();
    const tip = getTip();
    // A whitespace-only line is a (empty) table row, not a blank line,
    // exactly when its tab-expanded width is 4 columns (a lone tab, or
    // spaces + a tab reaching col 4). Anything else whitespace-only
    // ends the table.
    if (blank && tip.type === 'table' && !matchedQuote) {
      const rest = st.rest();
      if (/^[ \t]+$/.test(rest)) {
        let col = st.col;
        for (let q = 0; q < rest.length; q++) {
          if (rest[q] === ' ') col++;
          else col += 4 - (col % 4);
        }
        if (col - st.col === 4) blank = false;
      }
    }
    if (!allMatched && !blank) {
      const newItemList = startsNewItem(st, tip, lastMatched);
      if (newItemList) lastMatched = newItemList;
    }

    // --- 2. Lazy continuation of a paragraph ---
    if (!allMatched && !blank && tip.type === 'para') {
      if (!startsBlock(st, true, tip.up && tip.up.type === 'item') && !startsNewItem(st, tip, lastMatched) &&
          !startsOuterList(st, tip)) {
        // Lazy continuation: expand leading tabs against the quote
        // frame first (marked's J), so a tab after `> ` becomes
        // spaces instead of being stripped as indented-code indent
        // by lazyAdjust's codeStrip.
        let raw = st.rest();
        if (matchedQuote) raw = expandLeadTabs(raw, st.col - quoteFrameStart);
        const adj = lazyAdjust(raw, tip, lastMatched);
        let content = adj.content;
        // A lazy setext-underline line inside a blockquote is padded to
        // a 4-space indent (it stays literal text in the paragraph).
        if (adj.inner && adj.inner.type === 'quote' && parseSetext(new Cur(content))) {
          const col = leadingCols(content);
          if (col < 4) content = ' '.repeat(4 - col) + content;
        }
        tip.lines.push(content);
        tip.lastLazy = true;
        lastLineBlank = false;
        continue;
      }
    }

    // --- 2b. Fenced-code content inside a list item ignores container
    // matching, but ONLY once the fence already holds a content line.
    // A first content line that drops below the item's indent ends
    // the fence (it is empty) and the item; later lines are literal
    // fence content. A line that itself opens a fence closes this
    // one instead, and a line that fails a blockquote marker is
    // outside the fence.
    let fenceContentLine = false;
    if (!allMatched && !blank && tip.type === 'fence' &&
        tip.lines && tip.lines.length > 0) {
      const inner = innermostUnmatched(tip, lastMatched);
      if (inner && inner.type === 'item') {
        const sv = st.save();
        const isFence = parseFence(st) !== null;
        st.load(sv);
        if (!isFence) fenceContentLine = true;
      }
    }

    // --- 3. Close unmatched blocks ---
    if (!allMatched && !fenceContentLine) closeTo(lastMatched);

    // --- 4. Blank line handling ---
    if (blank) {
      let t2 = getTip();
      if (t2.type === 'html' && (t2.htmlKind === 6 || t2.htmlKind === 7)) {
        t2.afterBlank = true;
      } else if (t2.type !== 'html') {
        // Types 1-5: marked's html regex only swallows the newline
        // run right after the block, so the trailing newline is
        // dropped only when the following line is TRULY empty
        // (after container stripping) — a whitespace-only line
        // does not absorb it (space-blank probe). Types 6-7
        // swallow blank lines wholesale (handled above).
        if (st.rest() === '') {
          let lastBlk = t2;
          while (lastBlk.kids.length) lastBlk = lastBlk.kids[lastBlk.kids.length - 1];
          if (lastBlk.type === 'html' && !lastBlk.open) lastBlk.afterBlank = true;
        }
      }
      const insideLeaf = (function () {
        if (!t2.up) return true;
        let b = lastMatched;
        while (b) { if (b === t2.up) return true; b = b.up; }
        return false;
      })();
      if (t2.type === 'para' || t2.type === 'head') {
        closeBlock(t2);
      } else if (t2.type === 'fence') {
        // Tilde fences never dedent (marked's Dt only strips for
        // backtick fences): keep the line as-is. Backtick fences
        // strip up to fenceCol whitespace chars, a tab counting as
        // one char (marked's Dt) — never expanded to spaces.
        if (insideLeaf) t2.lines.push(t2.fenceChar === '~' ? st.rest() : stripFenceLead(st.rest(), t2.fenceCol || 0));
        else closeBlock(t2);
      } else if (t2.type === 'code') {
        if (insideLeaf) {
          st.advCols(4);
          t2.lines.push(st.rest());
        } else closeBlock(t2);
      } else if (t2.type === 'html') {
        const hk = t2.htmlKind;
        if (hk === 6 || hk === 7) { t2.endedAtBlank = true; closeBlock(t2); }
        else if (insideLeaf) t2.lines.push(st.rest());
        else closeBlock(t2);
      } else if (t2.type === 'table') {
        closeBlock(t2);
      }
      // An empty list item followed by a blank line is closed (the list
      // stays open; a later same-type marker rejoins it).
      const tb = getTip();
      if (tb.type === 'item' && tb.kids.length === 0 && tb.blank) {
        closeBlock(tb);
      }
      let b = getTip();
      while (b) { b.lastBlank = true; b = b.up; }
      lastLineBlank = true;
      lastBlankBlock = lastMatched;
      continue;
    }
    const wasBlank = lastLineBlank;
    lastLineBlank = false;

    // --- 5. Open leaf blocks that consume the line directly ---
    let leaf = getTip();
    if (leaf.type === 'fence') {
      const ind = st.indent();
      if (ind <= 3) {
        const save = st.save();
        st.advCols(ind);
        const c = st.ch();
        if (c === leaf.fenceChar) {
          let j = st.i, len = 0;
          while (j < st.s.length && st.s[j] === c) { len++; j++; }
          if (len >= leaf.fenceLen) {
            const rest = st.s.slice(j);
            if (/^[ \t]*$/.test(rest)) {
              // A fenced block drops its last content line when it is
              // empty (the blank line just before the closing fence).
              // A whitespace-only line (e.g. two spaces) is kept.
              const L = leaf.lines;
              if (L.length && L[L.length - 1] === '') L.pop();
              closeBlock(leaf); continue;
            }
          }
        }
        st.load(save);
      }
      let fcontent = st.rest();
      // Tabs in the leading whitespace expand to spaces; the tab
      // stops are relative to the innermost quote frame when inside
      // a blockquote (marked's J), else to the absolute column.
      // Marked never expands tabs in fence content itself (Dt only
      // strips the fence indent for backtick fences).
      if (matchedQuote) fcontent = expandLeadTabs(fcontent, st.col - quoteFrameStart);
      else if (st.col > 0) fcontent = expandLeadTabs(fcontent, st.col);
      // Tilde fences never dedent.
      leaf.lines.push(leaf.fenceChar === '~' ? fcontent : stripFenceLead(fcontent, leaf.fenceCol || 0));
      continue;
    }
    if (leaf.type === 'code') {
      const ind = st.indent();
      if (ind >= 4) {
        st.advCols(4);
        leaf.lines.push(st.rest());
        continue;
      }
      closeBlock(leaf);
      leaf = getTip();
    }
    if (leaf.type === 'html') {
      const hk = leaf.htmlKind;
      const rest = st.rest();
      leaf.lines.push(rest);
      leaf.trailNl = (ln < lines.length - 1) || inputEndsNl;
      if (hk >= 1 && hk <= 5 && htmlLineEnds(rest, hk, leaf.htmlTag)) closeBlock(leaf);
      continue;
    }
    if (leaf.type === 'table') {
      if (!startsBlock(st, false, false)) {
        leaf.rows.push(splitCells(st.rest(), leaf.header.length));
        continue;
      }
      closeBlock(leaf);
      leaf = getTip();
    }

    // --- 6. Paragraph continuation / setext / table delimiter ---
    if (leaf.type === 'para') {
      const ind = st.indent();
      if (ind <= 3) {
        const setext = parseSetext(st);
        if (setext) {
          const rest = collectRefdefs(leaf.lines, refs);
          if (!rest.length || rest.join('').trim() === '') {
            const par = leaf.up;
            const idx = par.kids.indexOf(leaf);
            if (idx !== -1) par.kids.splice(idx, 1);
            leaf.open = false;
          } else {
            leaf.lines = rest;
            leaf.type = 'head';
            leaf.level = setext;
            closeBlock(leaf);
            continue;
          }
        } else if (startsBlock(st, true, leaf.up && leaf.up.type === 'item')) {
          closeBlock(leaf);
        } else {
          const aligns = parseDelimRow(st.rest());
          if (aligns && leaf.lines.length) {
            const headerCells = splitCells(leaf.lines[leaf.lines.length - 1]);
            if (headerCells.length === aligns.length) {
              const headerLine = leaf.lines.pop();
              const header = splitCells(headerLine);
              if (leaf.lines.length === 0) {
                const par = leaf.up;
                const idx = par.kids.indexOf(leaf);
                if (idx !== -1) par.kids.splice(idx, 1);
                leaf.open = false;
              } else {
                closeBlock(leaf);
              }
              const tbl = mkBlock('table', lastMatched);
              tbl.align = aligns;
              tbl.header = header;
              tbl.rows = [];
              continue;
            }
          }
          let content = st.rest();
          if (matchedQuote) content = expandLeadTabs(content, st.col - quoteFrameStart);
          if (leaf.up && leaf.up.type === 'item') content = codeStrip(content);
          leaf.lines.push(content);
          leaf.lastLazy = false;
          continue;
        }
      } else {
        let content = st.rest();
        if (matchedQuote) content = expandLeadTabs(content, st.col - quoteFrameStart);
        if (leaf.up && leaf.up.type === 'item') content = codeStrip(content);
        leaf.lines.push(content);
        leaf.lastLazy = false;
        continue;
      }
    }

    // --- 7. New block starts ---
    const ind = st.indent();
    // The container's content start column, before the leading indent
    // is skipped: the reference point for a new item's relative indent.
    const containerCol = st.col;
    const saveI = st.save();
    markLoose(lastMatched, wasBlank);
    if (ind < 4) {
      st.advCols(ind);
      const c = st.ch();
      if (c === '#') {
        const atx = parseATX(st);
        if (atx) {
          const h = mkBlock('head', lastMatched);
          h.level = atx.level;
          h.lines = [atx.content];
          h.open = false;
          continue;
        }
      }
      if (c === '`' || c === '~') {
        const f = parseFence(st);
        if (f) {
          const fb = mkBlock('fence', lastMatched);
          fb.fenceChar = f.char;
          fb.fenceLen = f.len;
          fb.info = f.info;
          fb.fenceCol = ind;
          continue;
        }
      }
      if (c === '-' || c === '*' || c === '_') {
        if (isThematicBreak(st)) {
          const hr = mkBlock('hr', lastMatched);
          hr.open = false;
          continue;
        }
      }
      if (c === '<') {
        const ht = htmlBlockType(st);
        if (ht >= 1 && ht <= 7) {
          const hb = mkBlock('html', lastMatched);
          hb.htmlKind = ht;
          if (ht === 1) {
            const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(st.s.slice(st.i));
            hb.htmlTag = m ? m[1].toLowerCase() : '';
          }
          st.load(saveI);
          const firstLine = st.rest();
          hb.lines.push(firstLine);
          hb.trailNl = (ln < lines.length - 1) || inputEndsNl;
          if (ht >= 1 && ht <= 5 && htmlLineEnds(firstLine, ht, hb.htmlTag)) hb.open = false;
          continue;
        }
      }
      if (c === '>') {
        const q = mkBlock('quote', lastMatched);
        matchQuote(st);
        firstLineIn(q, st, wasBlank);
        continue;
      }
      if (c === '-' || c === '+' || c === '*' || (c >= '0' && c <= '9')) {
        const save = st.save();
        const m = parseMarker(st);
        if (m) {
          startList(lastMatched, m, st, wasBlank, containerCol);
          continue;
        }
        st.load(save);
      }
      st.load(saveI);
    }
    if (ind >= 4) {
      st.advCols(4);
      const cb = mkBlock('code', lastMatched);
      cb.lines.push(st.rest());
      continue;
    }
    const p = mkBlock('para', lastMatched);
    p.lines.push(st.rest());
  }

  closeTo(root);
  return root;

  // --- helpers used inside the loop (hoisted function declarations) ---
  function startList(parent, m, st, wasBlank, containerCol) {
    let list = null;
    let listParent = parent;
    if (parent.type === 'list' && parent.open) {
      const sameType = m.ordered === parent.ordered &&
        (!m.ordered ? parent.bullet === m.bullet : parent.delim === m.delim);
      if (sameType) {
        list = parent;
      } else {
        listParent = parent.up;
      }
    }
    if (!list) {
      const last = listParent.kids.length ? listParent.kids[listParent.kids.length - 1] : null;
      if (last && last.type === 'list' && last.open) {
        const sameType = m.ordered === last.ordered &&
          (!m.ordered ? last.bullet === m.bullet : last.delim === m.delim);
        if (sameType) list = last;
      }
    }
    if (!list) {
      list = mkBlock('list', listParent);
      list.ordered = m.ordered;
      list.delim = m.delim;
      list.bullet = m.bullet;
      list.start = m.start;
      list.tight = true;
    } else if (wasBlank) {
      // A new item after a blank line loosens the list only when the
      // blank line was at the list/item level. Walk up from the blank
      // line's deepest container: reaching the list or one of its
      // items means the blank separates the items; reaching a quote /
      // html / fence / code / table first means the blank is contained
      // inside that block and does not separate them. Nested list
      // structure in between does not block it.
      let atLevel = false;
      let bb = lastBlankBlock;
      while (bb) {
        if (bb === list) { atLevel = true; break; }
        if (bb.type === 'item' && bb.up === list) { atLevel = true; break; }
        if (bb.type === 'quote' || bb.type === 'html' || bb.type === 'fence' ||
            bb.type === 'code' || bb.type === 'table') break;
        bb = bb.up;
      }
      if (atLevel) list.tight = false;
    }
    const item = mkBlock('item', list);
    item.markerCol = m.markerCol;
    item.contentCol = m.contentCol;
    // Relative content indent: columns from the container's content
    // start to the item's content (used by matchItem / lazyAdjust).
    item.relContent = m.contentCol - containerCol;
    item.blank = m.blank;
    if (!m.blank) {
      firstLineIn(item, st, wasBlank);
    }
  }

  // Process the rest of a line as the first content of a newly opened
  // container (blockquote or list item). Returns 'consumed'.
  function firstLineIn(containerBlock, st, wasBlank) {
    if (st.blank()) return 'consumed';
    const ind = st.indent();
    // The container's content start column (reference point for a
    // nested item's relative indent).
    const containerCol = st.col;
    const saveI = st.save();
    let c = st.ch();
    if (ind < 4) {
      st.advCols(ind);
      c = st.ch();
      if (c === '#') {
        const atx = parseATX(st);
        if (atx) {
          const h = mkBlock('head', containerBlock);
          h.level = atx.level;
          h.lines = [atx.content];
          h.open = false;
          return 'consumed';
        }
      }
      if (c === '`' || c === '~') {
        const f = parseFence(st);
        if (f) {
          const fb = mkBlock('fence', containerBlock);
          fb.fenceChar = f.char;
          fb.fenceLen = f.len;
          fb.info = f.info;
          fb.fenceCol = ind;
          return 'consumed';
        }
      }
      if (c === '-' || c === '*' || c === '_') {
        if (isThematicBreak(st)) {
          const hr = mkBlock('hr', containerBlock);
          hr.open = false;
          return 'consumed';
        }
      }
      if (c === '<') {
        const ht = htmlBlockType(st);
        if (ht >= 1 && ht <= 7) {
          const hb = mkBlock('html', containerBlock);
          hb.htmlKind = ht;
          if (ht === 1) {
            const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(st.s.slice(st.i));
            hb.htmlTag = m ? m[1].toLowerCase() : '';
          }
          st.load(saveI);
          const firstLine = st.rest();
          hb.lines.push(firstLine);
          hb.trailNl = true;
          if (ht >= 1 && ht <= 5 && htmlLineEnds(firstLine, ht, hb.htmlTag)) hb.open = false;
          return 'consumed';
        }
      }
      if (c === '>') {
        const q = mkBlock('quote', containerBlock);
        matchQuote(st);
        firstLineIn(q, st, wasBlank);
        return 'consumed';
      }
      if (c === '-' || c === '+' || c === '*' || (c >= '0' && c <= '9')) {
        const save = st.save();
        const m = parseMarker(st);
        if (m) {
          startList(containerBlock, m, st, wasBlank, containerCol);
          return 'consumed';
        }
        st.load(save);
      }
      st.load(saveI);
    }
    if (ind >= 4) {
      st.advCols(4);
      const cb = mkBlock('code', containerBlock);
      cb.lines.push(st.rest());
      return 'consumed';
    }
    const p = mkBlock('para', containerBlock);
    p.lines.push(st.rest());
    return 'consumed';
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderBlocks(root, refs) {
  let out = '';
  for (const b of root.kids) out += renderBlock(b, refs);
  return out;
}

function renderBlock(b, refs) {
  switch (b.type) {
    case 'para': {
      if (!b.lines.length) return '';
      const text = b.lines.join('\n').replace(/\n$/, '');
      if (text.trim() === '') return '';
      return '<p>' + parseInline(text, refs) + '</p>\n';
    }
    case 'head': {
      const text = b.lines.join('\n').replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
      return '<h' + b.level + '>' + parseInline(text, refs) + '</h' + b.level + '>\n';
    }
    case 'code': {
      let text = b.lines.join('\n').replace(/\n+$/, '');
      if (text !== '') text += '\n';
      return '<pre><code>' + escCode(text) + '</code></pre>\n';
    }
    case 'fence': {
      const rawFirst = b.info ? b.info.split(/\s+/)[0] : '';
      let firstWord = '';
      for (let i = 0; i < rawFirst.length; i++) {
        const cc = rawFirst.charCodeAt(i);
        if (cc === 92 && i + 1 < rawFirst.length &&
            rawFirst.charCodeAt(i + 1) < 128 &&
            PUNCT[rawFirst.charCodeAt(i + 1)] === 1) {
          firstWord += rawFirst[i + 1];
          i++;
        } else {
          firstWord += rawFirst[i];
        }
      }
      const info = firstWord ? ' class="language-' + escText(firstWord, true) + '"' : '';
      const content = b.lines.length ? b.lines.join('\n') + '\n' : '';
      return '<pre><code' + info + '>' + escCode(content) + '</code></pre>\n';
    }
    case 'html': {
      const text = b.lines.join('\n');
      // marked's html block keeps its trailing newline unless the
      // block is followed by a blank line (its html regex + ge()
      // trimming drop it exactly then). The afterBlank flag is set
      // by the blank-line handling (empty following line for types
      // 1-5, any blank line for types 6-7). A trailing newline is
      // present only when the block is followed by another line in
      // the SAME container (a next sibling) — a block that merely
      // ends its container (e.g. <div> as a list item's last
      // content) has none — except a top-level last block when the
      // input itself ends with a newline.
      if (b.afterBlank) return text;
      const sibs = b.up ? b.up.kids : [];
      const idx = sibs.indexOf(b);
      if (idx !== -1 && idx < sibs.length - 1) return text + '\n';
      const topLevel = b.up && b.up.type === 'doc';
      if (topLevel && b.trailNl) return text + '\n';
      return text;
    }
    case 'hr': {
      return '<hr>\n';
    }
    case 'quote': {
      let out = '<blockquote>\n';
      for (const child of b.kids) out += renderBlock(child, refs);
      out += '</blockquote>\n';
      return out;
    }
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const item of b.kids) out += renderBlock(item, refs);
      out += '</' + tag + '>\n';
      return out;
    }
    case 'item': {
      let out = '<li>';
      const tight = b.up.tight;
      const kids = b.kids;
      // GFM task list: the first paragraph may start with a checkbox.
      let taskHtml = '';
      let taskFirst = false;
      if (kids.length > 0 && kids[0].type === 'para' && kids[0].lines.length > 0) {
        const firstLine = kids[0].lines[0];
        const m = /^\[([ xX])\][ \t]+\S/.exec(firstLine);
        if (m) {
          const checked = m[1] === 'x' || m[1] === 'X';
          taskHtml = checked
            ? '<input checked="" disabled="" type="checkbox">'
            : '<input disabled="" type="checkbox">';
          taskFirst = true;
        }
      }
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.type === 'para') {
          let lines = child.lines;
          if (i === 0 && taskFirst) {
            lines = child.lines.slice();
            lines[0] = lines[0].slice(3);
          }
          const text = lines.join('\n').replace(/\n$/, '');
          if (text.trim() === '') continue;
          const inner = (i === 0 && taskFirst ? taskHtml : '') +
            parseInline(text, refs);
          if (tight) out += inner;
          else out += '<p>' + inner + '</p>\n';
        } else {
          out += renderBlock(child, refs);
        }
      }
      out += '</li>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < b.header.length; i++) {
        const align = b.align[i] ? ' align="' + b.align[i] + '"' : '';
        out += '<th' + align + '>' + parseInline(b.header[i], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let i = 0; i < b.header.length; i++) {
            const cell = i < row.length ? row[i] : '';
            const align = b.align[i] ? ' align="' + b.align[i] + '"' : '';
            out += '<td' + align + '>' + parseInline(cell, refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    default:
      return '';
  }
}

export function parse(markdown) {
  const refs = {};
  // Pre-pass: collect link reference definitions from the whole
  // document so forward references resolve (a refdef defined in a
  // later paragraph must be visible when an earlier paragraph is
  // parsed inline). Only top-level refdef paragraphs are collected
  // here (up to 3 spaces, after a blank line, outside fenced code);
  // refdefs inside containers are still collected when their own
  // paragraph is parsed. First definition wins, so re-collecting a
  // definition later is harmless.
  // preCollectRefdefs disabled: it collects refdefs from inside fenced
  // code blocks (its raw-line fence tracking cannot model the empty-
  // fence rule), which wrongly enables forward links like doc-23's
  // [by-32]. The main parse collects refdefs container-aware.
  const root = parseBlocks(markdown, refs);
  inLink = false;
  return renderBlocks(root, refs);
}

// Scan the raw input for top-level link reference definition
// paragraphs and add them to refs.
function preCollectRefdefs(input, refs) {
  const lines = input.split('\n');
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fm) {
      const ch = fm[1][0];
      const len = fm[1].length;
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fenceLen = len;
      } else if (ch === fenceChar && len >= fenceLen &&
          /^[ \t]*$/.test(fm[2])) {
        // A closing fence contains only backticks/tildes + whitespace.
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    let ind = 0;
    while (ind < line.length && line[ind] === ' ') ind++;
    if (ind > 3 || ind >= line.length || line[ind] !== '[') continue;
    if (i > 0 && lines[i - 1].trim() !== '') continue;
    const rest = collectRefdefs(lines.slice(i), refs);
    const consumed = (lines.length - i) - rest.length;
    if (consumed > 0) i += consumed - 1;
  }
}
