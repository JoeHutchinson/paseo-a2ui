/**
 * Static safety check for the A2UI regex dialect (spec v1.0, "regex safety check"). Patterns that
 * could backtrack catastrophically are rejected before they ever run, because a runaway regex
 * blocks the JS thread and on iOS and Android that freezes the whole app.
 *
 * The checks are deliberately conservative: when overlap between two character sets cannot be
 * proven absent, they are treated as overlapping and the pattern is rejected.
 */

type Esc = "d" | "D" | "w" | "W" | "s" | "S";
type ClassItem = { lo: number; hi: number } | { esc: Esc };
type CharSet =
  | { kind: "lit"; code: number }
  | { kind: "esc"; esc: Esc }
  | { kind: "any" }
  | { kind: "class"; negated: boolean; items: ClassItem[] };

type Atom =
  | { kind: "chars"; set: CharSet }
  | { kind: "assert" }
  | { kind: "group"; alt: Alt; lookahead: boolean };

interface Term {
  atom: Atom;
  min: number;
  max: number;
}
type Seq = Term[];
interface Alt {
  branches: Seq[];
}

export const MAX_PATTERN_CODE_POINTS = 256;
export const MAX_VALUE_CODE_POINTS = 4096;

class RegexError extends Error {}

class Parser {
  pos = 0;
  constructor(readonly cps: string[]) {}

  peek(offset = 0): string | undefined {
    return this.cps[this.pos + offset];
  }

  fail(reason: string): never {
    throw new RegexError(reason);
  }

  parseAlt(): Alt {
    const branches: Seq[] = [this.parseSeq()];
    while (this.peek() === "|") {
      this.pos++;
      branches.push(this.parseSeq());
    }
    return { branches };
  }

  parseSeq(): Seq {
    const seq: Seq = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === "|" || c === ")") return seq;
      const atom = this.parseAtom();
      const [min, max] = this.parseQuantifier();
      if (atom.kind === "assert" && (min !== 1 || max !== 1)) this.fail("quantified assertion");
      seq.push({ atom, min, max });
    }
  }

  parseQuantifier(): [number, number] {
    const c = this.peek();
    let range: [number, number] | null = null;
    if (c === "*") range = [0, Infinity];
    else if (c === "+") range = [1, Infinity];
    else if (c === "?") range = [0, 1];
    if (range) {
      this.pos++;
    } else if (c === "{") {
      const rest = this.cps.slice(this.pos).join("");
      const m = /^\{(\d+)(,(\d*))?\}/.exec(rest);
      if (!m) this.fail("invalid quantifier");
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      if (max < min) this.fail("invalid quantifier range");
      range = [min, max];
      this.pos += Array.from(m[0]).length;
    } else {
      return [1, 1];
    }
    if (this.peek() === "?") this.pos++;
    return range;
  }

  parseAtom(): Atom {
    const c = this.peek()!;
    if (c === "^" || c === "$") {
      this.pos++;
      return { kind: "assert" };
    }
    if (c === ".") {
      this.pos++;
      return { kind: "chars", set: { kind: "any" } };
    }
    if (c === "*" || c === "+" || c === "?" || c === "{") this.fail("nothing to repeat");
    if (c === "(") return this.parseGroup();
    if (c === "[") return { kind: "chars", set: this.parseClass() };
    if (c === "\\") return this.parseEscape(false) as Atom;
    if (c === "]" || c === "}") this.fail(`unescaped ${c}`);
    this.pos++;
    return { kind: "chars", set: { kind: "lit", code: c.codePointAt(0)! } };
  }

  parseGroup(): Atom {
    this.pos++;
    let lookahead = false;
    if (this.peek() === "?") {
      const next = this.peek(1);
      if (next === ":") this.pos += 2;
      else if (next === "=" || next === "!") {
        lookahead = true;
        this.pos += 2;
      } else if (next === "<") this.fail("lookbehind and named groups are not allowed");
      else this.fail("inline flags are not allowed");
    }
    const alt = this.parseAlt();
    if (this.peek() !== ")") this.fail("unterminated group");
    this.pos++;
    return lookahead ? { kind: "group", alt, lookahead: true } : { kind: "group", alt, lookahead: false };
  }

  /** Parses an escape. Inside a class, returns a ClassItem; outside, an Atom. */
  parseEscape(inClass: boolean): Atom | ClassItem {
    this.pos++;
    const c = this.peek();
    if (c === undefined) this.fail("trailing backslash");
    this.pos++;
    if ("dDwWsS".includes(c)) {
      return inClass ? { esc: c as Esc } : { kind: "chars", set: { kind: "esc", esc: c as Esc } };
    }
    if (c === "b" || c === "B") {
      if (inClass) this.fail("\\b inside a class");
      return { kind: "assert" };
    }
    if (/[1-9]/.test(c) || c === "k") this.fail("backreferences are not allowed");
    if (c === "p" || c === "P") this.fail("unicode property escapes are not allowed");
    if (c === "c") this.fail("control escapes \\cX are not allowed");
    let code: number;
    if (c === "0") {
      if (/[0-9]/.test(this.peek() ?? "")) this.fail("legacy octal escapes are not allowed");
      code = 0;
    } else if (c === "t") code = 9;
    else if (c === "n") code = 10;
    else if (c === "v") code = 11;
    else if (c === "f") code = 12;
    else if (c === "r") code = 13;
    else if (c === "x") code = this.hex(2);
    else if (c === "u") {
      if (this.peek() === "{") {
        const end = this.cps.indexOf("}", this.pos);
        if (end < 0) this.fail("invalid \\u{} escape");
        code = parseInt(this.cps.slice(this.pos + 1, end).join(""), 16);
        if (!Number.isFinite(code)) this.fail("invalid \\u{} escape");
        this.pos = end + 1;
      } else code = this.hex(4);
    } else if (/[\^$\\.*+?()[\]{}|/-]/.test(c)) code = c.codePointAt(0)!;
    else this.fail(`invalid escape \\${c}`);
    return inClass ? { lo: code, hi: code } : { kind: "chars", set: { kind: "lit", code } };
  }

  hex(len: number): number {
    const digits = this.cps.slice(this.pos, this.pos + len).join("");
    if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(digits)) this.fail("invalid hex escape");
    this.pos += len;
    return parseInt(digits, 16);
  }

  parseClass(): CharSet {
    this.pos++;
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.pos++;
    }
    const items: ClassItem[] = [];
    const single = (): ClassItem => {
      const c = this.peek();
      if (c === undefined) this.fail("unterminated class");
      if (c === "\\") return this.parseEscape(true) as ClassItem;
      this.pos++;
      const code = c.codePointAt(0)!;
      return { lo: code, hi: code };
    };
    while (this.peek() !== "]") {
      if (this.peek() === undefined) this.fail("unterminated class");
      const first = single();
      if (this.peek() === "-" && this.peek(1) !== "]" && this.peek(1) !== undefined) {
        this.pos++;
        const last = single();
        if ("esc" in first || "esc" in last) this.fail("class escape in a range");
        if (last.hi < first.lo) this.fail("out of order class range");
        items.push({ lo: first.lo, hi: last.hi });
      } else {
        items.push(first);
      }
    }
    this.pos++;
    return { kind: "class", negated, items };
  }
}

const ESC_TEST: Record<Esc, RegExp> = {
  d: /\d/u,
  D: /\D/u,
  w: /\w/u,
  W: /\W/u,
  s: /\s/u,
  S: /\S/u,
};
const DISJOINT_ESC = new Set(["d|s", "w|s", "d|D", "w|W", "s|S", "d|W"]);

function escDisjoint(a: Esc, b: Esc): boolean {
  return DISJOINT_ESC.has(`${a}|${b}`) || DISJOINT_ESC.has(`${b}|${a}`);
}

function itemMatches(item: ClassItem, other: CharSet): boolean {
  if ("esc" in item) return overlap({ kind: "esc", esc: item.esc }, other);
  if (item.hi - item.lo > 512) return true;
  for (let code = item.lo; code <= item.hi; code++) {
    if (overlap({ kind: "lit", code }, other)) return true;
  }
  return false;
}

/** True unless the two sets are provably disjoint. */
function overlap(a: CharSet, b: CharSet): boolean {
  if (a.kind === "any" || b.kind === "any") return true;
  if (a.kind === "class" && a.negated) return true;
  if (b.kind === "class" && b.negated) return true;
  if (a.kind === "lit" && b.kind === "lit") return a.code === b.code;
  if (a.kind === "lit" && b.kind === "esc") return ESC_TEST[b.esc].test(String.fromCodePoint(a.code));
  if (a.kind === "esc" && b.kind === "lit") return overlap(b, a);
  if (a.kind === "esc" && b.kind === "esc") return a.esc === b.esc || !escDisjoint(a.esc, b.esc);
  if (a.kind === "class") return a.items.some((item) => itemMatches(item, b));
  if (b.kind === "class") return b.items.some((item) => itemMatches(item, a));
  return true;
}

function nullableSeq(seq: Seq): boolean {
  return seq.every((t) => t.min === 0 || t.atom.kind === "assert" || (t.atom.kind === "group" && (t.atom.lookahead || nullableAlt(t.atom.alt))));
}

function nullableAlt(alt: Alt): boolean {
  return alt.branches.some(nullableSeq);
}

function containsUnbounded(alt: Alt): boolean {
  return alt.branches.some((seq) =>
    seq.some((t) => t.max === Infinity || (t.atom.kind === "group" && !t.atom.lookahead && containsUnbounded(t.atom.alt))),
  );
}

/** "A group whose only content is one quantified atom counts as that atom." */
function unwrap(term: Term): Term {
  let current = term;
  while (current.atom.kind === "group" && !current.atom.lookahead && current.atom.alt.branches.length === 1) {
    const only = current.atom.alt.branches[0];
    if (only.length !== 1 || current.min !== 1 || current.max !== 1) break;
    current = only[0];
  }
  return current;
}

/** Character set a term can consume, or "any" when it is a non-trivial group. */
function termSet(term: Term): CharSet {
  const t = unwrap(term);
  return t.atom.kind === "chars" ? t.atom.set : { kind: "any" };
}

/** First-character sets a branch can start with; null when unknown (treated as overlapping). */
function firstSets(seq: Seq): CharSet[] | null {
  for (const term of seq) {
    if (term.atom.kind === "assert" || (term.atom.kind === "group" && term.atom.lookahead)) continue;
    if (term.min === 0) return null;
    if (term.atom.kind === "chars") return [term.atom.set];
    const sets: CharSet[] = [];
    for (const branch of term.atom.alt.branches) {
      const inner = firstSets(branch);
      if (!inner) return null;
      sets.push(...inner);
    }
    return sets;
  }
  return null;
}

function check(alt: Alt) {
  for (const seq of alt.branches) {
    seq.forEach((term) => {
      const atom = term.atom;
      if (atom.kind !== "group") return;
      check(atom.alt);
      if (atom.lookahead) return;
      // Rule 2: a repeating quantifier over something that itself repeats without bound.
      if (term.max > 1 && containsUnbounded(atom.alt)) {
        throw new RegexError("nested unbounded quantifiers");
      }
      // Rule 3: an unbounded quantifier over an alternation whose branches share a first character.
      if (term.max === Infinity && atom.alt.branches.length > 1) {
        const sets = atom.alt.branches.map(firstSets);
        if (sets.some((s) => s === null)) throw new RegexError("ambiguous repeated alternation");
        const flat = sets as CharSet[][];
        for (let i = 0; i < flat.length; i++) {
          for (let j = i + 1; j < flat.length; j++) {
            if (flat[i].some((a) => flat[j].some((b) => overlap(a, b)))) {
              throw new RegexError("ambiguous repeated alternation");
            }
          }
        }
      }
    });
    // Rule 4: adjacent unbounded atoms with overlapping character sets.
    for (let i = 0; i < seq.length; i++) {
      if (seq[i].max !== Infinity) continue;
      for (let j = i + 1; j < seq.length; j++) {
        const between = seq.slice(i + 1, j);
        if (!nullableSeq(between)) break;
        if (seq[j].max === Infinity && overlap(termSet(seq[i]), termSet(seq[j]))) {
          throw new RegexError("adjacent overlapping unbounded quantifiers");
        }
      }
    }
  }
}

export type CompiledPattern = { ok: true; regex: RegExp } | { ok: false; reason: string };

const cache = new Map<string, CompiledPattern>();

export function compileSafePattern(pattern: string): CompiledPattern {
  const cached = cache.get(pattern);
  if (cached) return cached;
  let result: CompiledPattern;
  const cps = Array.from(pattern);
  try {
    if (cps.length > MAX_PATTERN_CODE_POINTS) throw new RegexError(`longer than ${MAX_PATTERN_CODE_POINTS} code points`);
    const parser = new Parser(cps);
    const alt = parser.parseAlt();
    if (parser.pos !== cps.length) throw new RegexError("unbalanced parenthesis");
    check(alt);
    result = { ok: true, regex: new RegExp(pattern, "u") };
  } catch (error) {
    result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (cache.size > 200) cache.clear();
  cache.set(pattern, result);
  return result;
}
