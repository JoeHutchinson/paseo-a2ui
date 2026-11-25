export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function decode(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function splitPointer(pointer: string): string[] {
  if (pointer === "" || pointer === "/") return [];
  const body = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  return body.split("/").map(decode);
}

export function joinPath(scope: string, path: string): string {
  if (path.startsWith("/")) return path;
  const base = scope === "/" ? "" : scope.replace(/\/$/, "");
  if (path === "" || path === ".") return base || "/";
  return `${base}/${path}`;
}

export function getAt(root: unknown, pointer: string): unknown {
  let current: unknown = root;
  for (const token of splitPointer(pointer)) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

export function setAt(root: Json, pointer: string, value: Json | undefined): Json {
  const tokens = splitPointer(pointer);
  if (tokens.length === 0) return value === undefined ? {} : value;
  return setTokens(root, tokens, value);
}

function setTokens(node: Json, tokens: string[], value: Json | undefined): Json {
  const [head, ...rest] = tokens;
  const container: Json =
    node !== null && typeof node === "object" ? node : /^\d+$/.test(head) ? [] : {};
  const child =
    Array.isArray(container) ? container[Number(head)] : (container as Record<string, Json>)[head];
  const next = rest.length === 0 ? value : setTokens(child ?? null, rest, value);

  if (Array.isArray(container)) {
    const copy = container.slice();
    const index = Number(head);
    if (next === undefined) copy.splice(index, 1);
    else copy[index] = next;
    return copy;
  }
  const copy = { ...(container as Record<string, Json>) };
  if (next === undefined) delete copy[head];
  else copy[head] = next;
  return copy;
}
