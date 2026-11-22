// Fast site builder — a from-scratch, dependency-free reimplementation of the
// makefun-site 1.0.0 build, written to return byte-identical output faster.
//
// How it is faster than the reference:
//  - One fused Markdown pass: blocks are lexed and rendered in a single scan
//    instead of building a token array first and walking it again.
//  - The inline renderer copies maximal plain runs in one slice and only
//    touches the characters that need escaping or start a construct, instead
//    of escaping one character at a time through a regex replace.
//  - Output is accumulated in arrays and joined once, never `+=` in a loop.
//  - Slugs and long dates are memoised (tag names and dates repeat a lot).
//  - Front matter is parsed by scanning the source string directly, with no
//    split of the whole file and no join to rebuild the body.
//  - Word counting and the small line classifiers are hand-rolled loops, not
//    regexes, so the hot paths never pay regex setup.
// The semantics (every rule, every report line, every error string) follow
// makefun-site's README and reference code exactly; the code is the reference
// wherever the two differ.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ------------------------------------------------------------------ text

/** Push `text` with & < > " ' escaped onto `out` (an array of chunks). */
function escInto(out, text) {
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 38 || code === 60 || code === 62 || code === 34 || code === 39) {
      if (i > run) out.push(text.slice(run, i));
      out.push(code === 38 ? '&amp;' : code === 60 ? '&lt;' : code === 62 ? '&gt;' : code === 34 ? '&quot;' : '&#39;');
      run = i + 1;
    }
  }
  if (text.length > run) out.push(text.slice(run));
}

const NEEDS_ESC = /[&<>"']/;

/** `text` with & < > " ' escaped, as a string. */
function escStr(text) {
  if (!NEEDS_ESC.test(text)) return text;
  const out = [];
  escInto(out, text);
  return out.join('');
}

/** Whether the code unit is JavaScript whitespace (\s, no unicode flag). ASCII letters and digits take the short path. */
function isSpaceCode(c) {
  if (c <= 0x20) return c === 0x20 || (c >= 0x09 && c <= 0x0d);
  if (c < 0x80) return false;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** Whether `s` holds any whitespace character. */
function hasSpace(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20) {
      if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) return true;
    } else if (c >= 0x80 && (c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
      c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff)) return true;
  }
  return false;
}

/** The words of `text`: its runs of characters other than whitespace. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let sp;
    if (c <= 0x20) sp = c === 0x20 || (c >= 0x09 && c <= 0x0d);
    else if (c < 0x80) sp = false;
    else sp = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
      c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (sp) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// --------------------------------------------------------------- slugs

const MARKS = /\p{M}/gu;

/** Slugs already computed, keyed by their text (pure function, safe to share). */
const slugCache = new Map();
/** Long dates already computed, keyed by their YYYY-MM-DD string. */
const dateCache = new Map();

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-" left at the cut dropped), "untitled" when nothing is left. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  // NFKD is the identity on ASCII and ASCII holds no combining marks, so the
  // normalise-and-strip step can be skipped for ASCII-only text.
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) { ascii = false; break; }
  const plain = ascii ? text : text.normalize('NFKD').replace(MARKS, '');
  const parts = [];
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = parts.length > 0;
      continue;
    }
    if (gap) parts.push('-');
    gap = false;
    parts.push(keep);
  }
  let out = parts.join('');
  if (out.length > 64) out = out.slice(0, 64);
  let cut = out.length;
  while (cut > 0 && out.charCodeAt(cut - 1) === 45) cut--;
  if (cut !== out.length) out = out.slice(0, cut);
  const slug = out === '' ? 'untitled' : out;
  if (slugCache.size < 100000) slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const out = `${d} ${MONTHS[m - 1]} ${y}`;
  dateCache.set(date, out);
  return out;
}

// ---------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isLowerKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95; // a-z or _
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // "
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    const out = [];
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out.push(n);
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out.push(c);
    }
    return { value: out.join('') };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // [
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4)); mo = Number(raw.slice(5, 7)); d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let i = 0;
      while (i < raw.length) {
        const start = i;
        while (i < raw.length) {
          const c = raw.charCodeAt(i);
          if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) i++;
          else break;
        }
        if (i === start) return { error: 'key "slug": not a slug' };
        if (i === raw.length) break;
        if (raw.charCodeAt(i) !== 45) return { error: 'key "slug": not a slug' };
        i++;
        if (i === raw.length) return { error: 'key "slug": not a slug' };
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. The body is sliced out of `text` directly, never split and re-joined.
 */
function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing line: a line that is exactly '---'.
  let pos = nl === -1 ? text.length : nl + 1;
  let closeStart = -1;
  let closeEnd = -1;
  let i = pos;
  while (i <= text.length) {
    let e = text.indexOf('\n', i);
    if (e === -1) e = text.length;
    if (e - i === 3 && text.charCodeAt(i) === 45 && text.charCodeAt(i + 1) === 45 && text.charCodeAt(i + 2) === 45) {
      closeStart = i;
      closeEnd = e;
      break;
    }
    if (e === text.length) break;
    i = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1; // 0-based index of the line being read (the opening --- is line 0)
  let cur = pos;
  while (cur < closeStart) {
    let e = text.indexOf('\n', cur);
    if (e === -1 || e > closeStart) e = closeStart;
    const line = text.slice(cur, e);
    // Blank (spaces and tabs only) or a comment ("#" first): skipped.
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      // "key: value": a key of a-z and _, a colon, one space and the value.
      let j = 0;
      while (j < line.length && isLowerKeyChar(line.charCodeAt(j))) j++;
      if (j === 0 || line.charCodeAt(j) !== 58) return { error: `line ${lineNo + 1} is not "key: value"` };
      const key = line.slice(0, j);
      const rest = line.slice(j + 1);
      let raw;
      if (rest === '') raw = '';
      else if (rest.charCodeAt(0) === 32) raw = rest.slice(1);
      else return { error: `line ${lineNo + 1} is not "key: value"` };
      let rEnd = raw.length;
      while (rEnd > 0 && (raw.charCodeAt(rEnd - 1) === 32 || raw.charCodeAt(rEnd - 1) === 9)) rEnd--;
      if (rEnd !== raw.length) raw = raw.slice(0, rEnd);
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineNo++;
    cur = e + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ------------------------------------------------------------- markdown

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence opening line's language, or null (``` plus an optional language, then spaces or tabs only). */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence (``` then spaces or tabs only). */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (1 to 6 #, at least one space or tab, then non-empty text). */
function headingOf(line) {
  let c = 0;
  while (c < 6 && line.charCodeAt(c) === 35) c++;
  if (c === 0) return null;
  if (c === 6 && line.charCodeAt(6) === 35) return null;
  let j = c;
  if (line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9) return null;
  while (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9) j++;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === j) return null;
  return { depth: c, text: line.slice(j, end) };
}

/** Whether `line` is a thematic break (--- or ***, then spaces or tabs only). */
function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const d = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && d === 45) || (a === 42 && b === 42 && d === 42))) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text after "- " or "* ", or null. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text after "N. ", or null (1 to 9 digits). */
function orderedItem(line) {
  let j = 0;
  while (j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null; // '.' then ' '
  return { num: line.slice(0, j), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let j = 0;
  while (line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !isSpaceCode(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, within [from, end), or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, within [from, end), or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The inline characters that need handling: \ ` * [ and the HTML specials & < > " '. */
const INTEREST = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '[', '&', '<', '>', '"', "'"]) INTEREST[ch.charCodeAt(0)] = 1;

/**
 * `s[start..end)` rendered inline onto `out` (an array of chunks); `link(target)` is a link's href.
 * Plain runs are copied in one slice; only the characters that need escaping or start a construct are handled one by one.
 * Dispatch is on the character code through a table, so a plain character costs one table probe.
 */
function inlineInto(s, start, end, link, out) {
  let i = start;
  let run = start;
  while (i < end) {
    const code = s.charCodeAt(i);
    if (code >= 128 || INTEREST[code] === 0) {
      i++;
      continue;
    }
    if (code === 92) { // backslash
      if (i + 1 < end && ESCAPABLE.has(s[i + 1])) {
        if (i > run) out.push(s.slice(run, i));
        out.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]);
        i += 2;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (code === 96) { // backtick
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<code>');
        escInto(out, s.slice(i + 1, j));
        out.push('</code>');
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (code === 42) { // *
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, end);
        if (j > i + 2) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<strong>');
          inlineInto(s, i + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<em>');
        inlineInto(s, i + 1, j, link, out);
        out.push('</em>');
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (code === 91) { // [
      const k = findUnescaped(s, ']', i + 1, end);
      let m = -1;
      if (k !== -1 && s[k + 1] === '(') {
        const r = s.indexOf(')', k + 2);
        if (r !== -1 && r < end) m = r;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasSpace(target)) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<a href="');
        escInto(out, link(target));
        out.push('">');
        inlineInto(s, i + 1, k, link, out);
        out.push('</a>');
        i = m + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    // Anything left here is one of & < > " ' (the table let only those through).
    if (i > run) out.push(s.slice(run, i));
    out.push(code === 38 ? '&amp;' : code === 60 ? '&lt;' : code === 62 ? '&gt;' : code === 34 ? '&quot;' : '&#39;');
    i++;
    run = i;
  }
  if (end > run) out.push(s.slice(run, end));
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Lexing and rendering happen in one pass over the lines, and the whole page's HTML is built in a single chunk array
 * and joined once; the excerpt and the toc entries are sliced out of that array, never re-rendered.
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      parts.push('<pre><code');
      if (lang !== '') {
        parts.push(' class="language-');
        parts.push(escStr(lang));
        parts.push('"');
      }
      parts.push('>');
      while (i < n && !isFenceClose(lines[i])) {
        parts.push(escStr(lines[i]));
        parts.push('\n');
        i++;
      }
      i++;
      parts.push('</code></pre>', '\n');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      parts.push(`<h${hd.depth} id="${id}">`);
      const mark = parts.length;
      inlineInto(hd.text, 0, hd.text.length, link, parts);
      const html = hd.depth === 2 || hd.depth === 3 ? parts.slice(mark).join('') : null;
      parts.push(`</h${hd.depth}>`, '\n');
      if (html !== null) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      parts.push('<hr>', '\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) { // '>'
      const raw = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        raw.push(l);
        i++;
      }
      const kept = [];
      for (const l of raw) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>', '\n');
      else {
        const text = kept.join('\n');
        parts.push('<blockquote>\n<p>');
        inlineInto(text, 0, text.length, link, parts);
        parts.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    const bText = bulletText(line);
    const oItem = bText === null ? orderedItem(line) : null;
    if (bText !== null || oItem !== null) {
      const ordered = oItem !== null;
      const start = ordered ? Number(oItem.num) : 1;
      const items = [[trimLine(ordered ? oItem.text : bText)]];
      i++;
      while (i < n) {
        const l = lines[i];
        let m = null;
        if (ordered) {
          const om = orderedItem(l);
          if (om !== null) m = om.text;
        } else {
          m = bulletText(l);
        }
        if (m !== null) {
          items.push([trimLine(m)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      parts.push(ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (const partsOfItem of items) {
        const text = partsOfItem.join('\n');
        parts.push('<li>');
        inlineInto(text, 0, text.length, link, parts);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>`, '\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const text = body.join('\n');
    parts.push('<p>');
    const mark = parts.length;
    inlineInto(text, 0, text.length, link, parts);
    if (excerpt === null) excerpt = parts.slice(mark).join('');
    parts.push('</p>', '\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src[a..b)` holds only spaces and tabs. */
function onlySpaces(src, a, b) {
  for (let j = a; j < b; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }) onto `out`; `ctx` holds the parsed templates and the include depth. */
function renderInto(nodes, scope, ctx, depth, out) {
  for (let nIdx = 0; nIdx < nodes.length; nIdx++) {
    const n = nodes[nIdx];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escStr(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderInto(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderInto(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ----------------------------------------------------------------- build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target; // '/' or '#'
      // A scheme: a letter, then letters, digits, +, - or ., then ':'.
      const colon = target.indexOf(':');
      if (colon > 0) {
        const first = target.charCodeAt(0);
        if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
          let scheme = true;
          for (let j = 1; j < colon; j++) {
            const c = target.charCodeAt(j);
            if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) { scheme = false; break; }
          }
          if (scheme) return target;
        }
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      if (rel === '') return target;
      let path = linkCache.get(`${dir}\0${rel}`);
      if (path === undefined) {
        const parts = [...dirParts];
        let bad = false;
        for (const seg of rel.split('/')) {
          if (seg === '' || seg === '.') continue;
          if (seg === '..') {
            if (parts.length === 0) { bad = true; break; }
            parts.pop();
          } else parts.push(seg);
        }
        path = bad ? null : parts.join('/');
        linkCache.set(`${dir}\0${rel}`, path);
      }
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = countWords(s.body);
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  // One shared scope holds site, tags and recent; each render adds only its own vars on top of it (the render's vars
  // never name site, tags or recent, so lookups resolve exactly as they would from one merged object).
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderInto(nodes, { vars, parent: baseScope }, ctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of kept) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
