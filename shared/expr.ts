import { getAt, joinPath } from "./pointer";
import { compileSafePattern, MAX_VALUE_CODE_POINTS } from "./regex-safety";

export interface EvalScope {
  data: unknown;
  /** Absolute pointer that relative paths resolve against. "/" at the root. */
  scope: string;
  /** Iteration index inside a template, for `@index`. */
  index?: number;
  /** Set only while handling a user gesture; required by `openUrl`. */
  onOpenUrl?: (url: string) => void;
}

export interface ValidationResult {
  valid: boolean;
  message?: string;
  code?: string;
  severity?: "error" | "warning" | "info";
  /** Built-in fallback text, used when neither the result nor the check supplies a message. */
  defaultMessage?: string;
}

type Fn = (args: Record<string, unknown>, scope: EvalScope) => unknown;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isBinding(value: unknown): value is { "@path": string } {
  return isPlainObject(value) && typeof value["@path"] === "string";
}

export function isCall(value: unknown): value is { "@call": string; args?: Record<string, unknown> } {
  return isPlainObject(value) && typeof value["@call"] === "string";
}

export function isValidationResult(value: unknown): value is ValidationResult {
  return isPlainObject(value) && typeof value.valid === "boolean";
}

export function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (isValidationResult(value)) return value.valid;
  if (typeof value === "string") return value.toLowerCase() === "true";
  if (typeof value === "number") return value !== 0;
  return false;
}

export function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function result(valid: boolean, defaultMessage?: string): ValidationResult {
  return valid ? { valid: true } : { valid: false, severity: "error", defaultMessage };
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Unicode TR35 date pattern subset: y M d E H h m s a, with 'quoted' literals. */
export function formatDatePattern(date: Date, pattern: string): string {
  const tokens = pattern.match(/'[^']*'|y+|Y+|M+|d+|E+|H+|h+|m+|s+|a+|./g) ?? [];
  return tokens
    .map((token) => {
      const c = token[0];
      const len = token.length;
      switch (c) {
        case "'":
          return token.length > 2 ? token.slice(1, -1) : "'";
        case "y":
        case "Y":
          return len === 2 ? pad(date.getFullYear() % 100) : String(date.getFullYear());
        case "M":
          if (len >= 4) return MONTHS[date.getMonth()];
          if (len === 3) return MONTHS[date.getMonth()].slice(0, 3);
          return len === 2 ? pad(date.getMonth() + 1) : String(date.getMonth() + 1);
        case "d":
          return len === 2 ? pad(date.getDate()) : String(date.getDate());
        case "E":
          return len >= 4 ? DAYS[date.getDay()] : DAYS[date.getDay()].slice(0, 3);
        case "H":
          return len === 2 ? pad(date.getHours()) : String(date.getHours());
        case "h": {
          const h = date.getHours() % 12 || 12;
          return len === 2 ? pad(h) : String(h);
        }
        case "m":
          return len === 2 ? pad(date.getMinutes()) : String(date.getMinutes());
        case "s":
          return len === 2 ? pad(date.getSeconds()) : String(date.getSeconds());
        case "a":
          return date.getHours() < 12 ? "AM" : "PM";
        default:
          return token;
      }
    })
    .join("");
}

function formatNumber(value: number, decimals: number | undefined, grouping: boolean): string {
  try {
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals ?? 2,
      useGrouping: grouping,
    }).format(value);
  } catch {
    return decimals === undefined ? String(value) : value.toFixed(decimals);
  }
}

/**
 * Parses dates without relying on engine-specific string parsing (Hermes accepts fewer formats
 * than V8) and treats offset-less values as local time, so "2026-01-16" stays the 16th everywhere.
 */
export function parseDateValue(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(text);
  if (local) {
    const [, y, mo, d, h = "0", mi = "0", sec = "0"] = local;
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  }
  const time = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (time) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(time[1]), Number(time[2]), Number(time[3] ?? 0));
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, sec = "0", frac = "", zone] = iso;
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), Math.round(Number(frac || 0) * 1000));
    if (zone === "Z") return new Date(ms);
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
    return new Date(ms - offset * 60_000);
  }
  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? undefined : fallback;
}

const FUNCTIONS: Record<string, Fn> = {
  required: ({ value }) => result(!isEmpty(value), "This field is required."),
  email: ({ value }) =>
    result(
      typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
      "Enter a valid email address.",
    ),
  regex: ({ value, pattern }) => {
    const compiled = compileSafePattern(toText(pattern));
    if (!compiled.ok) throw new Error(`EXPRESSION_ERROR: regex rejected (${compiled.reason})`);
    const text = toText(value);
    if (Array.from(text).length > MAX_VALUE_CODE_POINTS) return result(false, "Value is too long.");
    return result(compiled.regex.test(text), "Invalid format.");
  },
  length: ({ value, min, max }) => {
    const len = toText(value).length;
    const lo = toNumber(min);
    const hi = toNumber(max);
    if (lo !== undefined && len < lo) return result(false, `Must be at least ${lo} characters.`);
    if (hi !== undefined && len > hi) return result(false, `Must be at most ${hi} characters.`);
    return result(true);
  },
  numeric: ({ value, min, max }) => {
    const n = toNumber(value);
    if (n === undefined) return result(false, "Must be a number.");
    const lo = toNumber(min);
    const hi = toNumber(max);
    if (lo !== undefined && n < lo) return result(false, `Must be at least ${lo}.`);
    if (hi !== undefined && n > hi) return result(false, `Must be at most ${hi}.`);
    return result(true);
  },
  and: ({ values }) => Array.isArray(values) && values.every(toBool),
  or: ({ values }) => Array.isArray(values) && values.some(toBool),
  not: ({ value }) => !toBool(value),
  formatString: ({ value }, scope) => interpolate(toText(value), scope),
  formatNumber: ({ value, decimals, grouping }) => {
    const n = toNumber(value);
    if (n === undefined) return "";
    return formatNumber(n, toNumber(decimals), grouping === undefined ? true : toBool(grouping));
  },
  formatCurrency: ({ value, currency, decimals, grouping }) => {
    const n = toNumber(value);
    if (n === undefined) return "";
    const d = toNumber(decimals);
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: toText(currency) || "USD",
        minimumFractionDigits: d,
        maximumFractionDigits: d,
        useGrouping: grouping === undefined ? true : toBool(grouping),
      }).format(n);
    } catch {
      return `${toText(currency)} ${formatNumber(n, d ?? 2, true)}`;
    }
  },
  formatDate: ({ value, format }) => {
    const date = parseDateValue(value);
    if (!date || Number.isNaN(date.getTime())) return toText(value);
    return formatDatePattern(date, toText(format) || "yyyy-MM-dd");
  },
  pluralize: (args) => {
    const n = toNumber(args.value) ?? 0;
    let rule = "other";
    try {
      rule = new Intl.PluralRules().select(n);
    } catch {
      rule = n === 1 ? "one" : "other";
    }
    if (n === 0 && args.zero !== undefined) return toText(args.zero);
    const chosen = args[rule] ?? args.other;
    return toText(chosen).replace(/#/g, String(n));
  },
  openUrl: ({ url }, scope) => {
    const target = toText(url);
    if (!scope.onOpenUrl) throw new Error("openUrl requires a user gesture");
    if (!/^(https?:|mailto:|tel:)/i.test(target)) throw new Error(`Blocked URL: ${target}`);
    scope.onOpenUrl(target);
    return undefined;
  },
  now: () => new Date().toISOString(),
  "@index": (args, scope) => {
    if (scope.index === undefined) throw new Error("EXPRESSION_ERROR: @index used outside a list template");
    return scope.index + (toNumber(args.offset) ?? 0);
  },
};

export function callFunction(name: string, args: Record<string, unknown>, scope: EvalScope): unknown {
  const fn = FUNCTIONS[name];
  if (!fn) throw new Error(`Unknown function "${name}"`);
  return fn(args, scope);
}

/** Resolves a DynamicValue: literal, `{"@path"}` binding, or `{"@call"}` function call. */
export function resolve(value: unknown, scope: EvalScope): unknown {
  if (isBinding(value)) return getAt(scope.data, joinPath(scope.scope, value["@path"]));
  if (isCall(value)) {
    const args: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value.args ?? {})) {
      args[key] = Array.isArray(raw) ? raw.map((v) => resolve(v, scope)) : resolve(raw, scope);
    }
    return callFunction(value["@call"], args, scope);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      out[key.startsWith("@@") ? key.slice(1) : key] = raw;
    }
    return out;
  }
  return value;
}

/** Resolves without throwing; returns `fallback` on error. */
export function tryResolve(value: unknown, scope: EvalScope, fallback?: unknown): unknown {
  try {
    return resolve(value, scope);
  } catch {
    return fallback;
  }
}

/** Resolves every value of an action `context` object. */
export function resolveContext(
  context: Record<string, unknown> | undefined,
  scope: EvalScope,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(context ?? {})) out[key] = tryResolve(raw, scope, null);
  return out;
}

// ---- formatString ---------------------------------------------------------------------------

class Parser {
  pos = 0;
  constructor(
    readonly src: string,
    readonly scope: EvalScope,
  ) {}

  peek(): string {
    return this.src[this.pos] ?? "";
  }

  skipSpace() {
    while (/\s/.test(this.peek())) this.pos++;
  }

  /** Parses the body of `${...}` up to its matching `}` and evaluates it. */
  expression(): unknown {
    this.skipSpace();
    let value: unknown;
    if (this.src.startsWith("${", this.pos)) {
      this.pos += 2;
      value = this.expression();
    } else {
      const start = this.pos;
      while (this.pos < this.src.length && !/[}(,)\s]/.test(this.peek())) this.pos++;
      const word = this.src.slice(start, this.pos);
      this.skipSpace();
      if (this.peek() === "(") {
        this.pos++;
        value = callFunction(word, this.args(), this.scope);
      } else {
        value = this.literalOrPath(word);
      }
    }
    this.skipSpace();
    if (this.peek() === "}") this.pos++;
    return value;
  }

  literalOrPath(word: string): unknown {
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(word)) return Number(word);
    return getAt(this.scope.data, joinPath(this.scope.scope, word));
  }

  args(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    let positional = 0;
    for (;;) {
      this.skipSpace();
      if (this.peek() === ")") {
        this.pos++;
        return args;
      }
      if (this.pos >= this.src.length) return args;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(this.src.slice(this.pos));
      let name = `arg${positional++}`;
      if (match) {
        name = match[1];
        this.pos += match[0].length;
      }
      args[name] = this.argValue();
      if (!match && positional === 1) args.value = args[name];
      this.skipSpace();
      if (this.peek() === ",") this.pos++;
    }
  }

  argValue(): unknown {
    this.skipSpace();
    const c = this.peek();
    if (c === "'" || c === '"') {
      const end = this.src.indexOf(c, this.pos + 1);
      const text = this.src.slice(this.pos + 1, end < 0 ? undefined : end);
      this.pos = end < 0 ? this.src.length : end + 1;
      return text;
    }
    if (this.src.startsWith("${", this.pos)) {
      this.pos += 2;
      return this.expression();
    }
    const start = this.pos;
    while (this.pos < this.src.length && !/[,)]/.test(this.peek())) this.pos++;
    return this.literalOrPath(this.src.slice(start, this.pos).trim());
  }
}

/** Returns the index just past the `}` that closes a `${` whose body starts at `start`. */
function skipExpression(template: string, start: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = start; i < template.length; i++) {
    const c = template[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "$" && template[i + 1] === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return template.length;
}

export function interpolate(template: string, scope: EvalScope): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    if (template.startsWith("\\${", i)) {
      out += "${";
      i += 3;
    } else if (template.startsWith("${", i)) {
      const parser = new Parser(template, scope);
      parser.pos = i + 2;
      try {
        out += toText(parser.expression());
        i = parser.pos;
      } catch {
        // Drop the whole failed expression rather than leaking its unparsed tail into the text.
        i = skipExpression(template, i + 2);
      }
    } else {
      out += template[i++];
    }
  }
  return out;
}

/** Evaluates `@checks`; returns the first failure, or undefined when all pass. */
export function evaluateChecks(checks: unknown, scope: EvalScope): ValidationResult | undefined {
  if (!Array.isArray(checks)) return undefined;
  for (const check of checks) {
    if (!isPlainObject(check)) continue;
    const message = typeof check.message === "string" ? check.message : undefined;
    const value = tryResolve(check.condition, scope, false);
    if (isValidationResult(value)) {
      if (!value.valid) {
        return {
          ...value,
          message: value.message ?? message ?? value.defaultMessage ?? "Invalid value.",
          severity: value.severity ?? "error",
        };
      }
    } else if (!toBool(value)) {
      return { valid: false, message: message ?? "Invalid value.", severity: "error" };
    }
  }
  return undefined;
}
