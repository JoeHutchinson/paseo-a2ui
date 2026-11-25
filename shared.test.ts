import { describe, expect, it } from "vitest";
import { evaluateChecks, interpolate, resolve, resolveContext, toBool } from "./shared/expr";
import { getAt, joinPath, setAt } from "./shared/pointer";
import { applyMessages, formatActionPrompt, messageSchema, summariseContext, type SurfaceSnapshot } from "./shared/protocol";

const data = {
  user: { name: "Ada", email: "ada@example.com" },
  items: [{ title: "One", price: 1234.5 }, { title: "Two", price: 2 }],
  count: 3,
};

describe("pointer", () => {
  it("reads absolute and array paths", () => {
    expect(getAt(data, "/user/name")).toBe("Ada");
    expect(getAt(data, "/items/1/title")).toBe("Two");
    expect(getAt(data, "/missing/x")).toBeUndefined();
    expect(getAt(data, "/")).toBe(data);
  });

  it("joins relative paths onto a scope", () => {
    expect(joinPath("/items/0", "title")).toBe("/items/0/title");
    expect(joinPath("/items/0", "/count")).toBe("/count");
    expect(joinPath("/", "title")).toBe("/title");
  });

  it("sets immutably, creating containers and deleting", () => {
    const next = setAt(data as never, "/user/name", "Grace");
    expect(getAt(next, "/user/name")).toBe("Grace");
    expect(data.user.name).toBe("Ada");
    expect(setAt({}, "/a/b", 1)).toEqual({ a: { b: 1 } });
    expect(setAt({}, "/list/0", "x")).toEqual({ list: ["x"] });
    expect(setAt({ a: 1, b: 2 }, "/a", undefined)).toEqual({ b: 2 });
    expect(setAt({ a: 1 }, "/", { z: 1 })).toEqual({ z: 1 });
  });
});

describe("expressions", () => {
  const scope = { data, scope: "/" };

  it("resolves literals, bindings and relative bindings", () => {
    expect(resolve("hi", scope)).toBe("hi");
    expect(resolve({ "@path": "/user/name" }, scope)).toBe("Ada");
    expect(resolve({ "@path": "title" }, { data, scope: "/items/1" })).toBe("Two");
  });

  it("unescapes doubled @ keys in literal objects", () => {
    expect(resolve({ "@@path": "x" }, scope)).toEqual({ "@path": "x" });
  });

  it("interpolates formatString with paths and functions", () => {
    expect(interpolate("Hello ${/user/name}!", scope)).toBe("Hello Ada!");
    expect(interpolate("${title} costs ${formatNumber(value:${price}, decimals:2)}", { data, scope: "/items/0" })).toMatch(
      /^One costs 1.?234\.50$/,
    );
    expect(interpolate("literal \\${x}", scope)).toBe("literal ${x}");
    expect(interpolate("n=${@index()}", { data, scope: "/", index: 4 })).toBe("n=4");
    expect(
      resolve({ "@call": "formatString", args: { value: "${pluralize(value:${/count}, one:'# item', other:'# items')}" } }, scope),
    ).toBe("3 items");
  });

  it("formats dates with a TR35 subset", () => {
    const out = resolve(
      { "@call": "formatDate", args: { value: "2026-02-02T15:17:00", format: "EEE MMM d, yyyy h:mm a" } },
      scope,
    );
    expect(out).toBe("Mon Feb 2, 2026 3:17 PM");
  });

  it("applies boolean coercion rules", () => {
    expect(toBool("TRUE")).toBe(true);
    expect(toBool("hello")).toBe(false);
    expect(toBool(0)).toBe(false);
    expect(toBool({ valid: true })).toBe(true);
    expect(toBool({})).toBe(false);
  });

  it("evaluates checks, preferring the check message", () => {
    const checks = [
      { condition: { "@call": "required", args: { value: { "@path": "/user/phone" } } }, message: "Phone needed" },
    ];
    expect(evaluateChecks(checks, scope)?.message).toBe("Phone needed");
    expect(
      evaluateChecks([{ condition: { "@call": "email", args: { value: { "@path": "/user/email" } } } }], scope),
    ).toBeUndefined();
    const combined = [
      {
        condition: {
          "@call": "and",
          args: {
            values: [
              { "@call": "required", args: { value: { "@path": "/user/name" } } },
              { "@call": "numeric", args: { value: { "@path": "/count" }, min: 5 } },
            ],
          },
        },
        message: "Need 5",
      },
    ];
    expect(evaluateChecks(combined, scope)).toMatchObject({ valid: false, message: "Need 5" });
  });

  it("refuses openUrl outside a gesture and non-web schemes", () => {
    const call = { "@call": "openUrl", args: { url: "https://a2ui.org" } };
    expect(() => resolve(call, scope)).toThrow(/gesture/);
    const opened: string[] = [];
    resolve(call, { ...scope, onOpenUrl: (u) => opened.push(u) });
    expect(opened).toEqual(["https://a2ui.org"]);
    expect(() =>
      resolve({ "@call": "openUrl", args: { url: "javascript:alert(1)" } }, { ...scope, onOpenUrl: () => {} }),
    ).toThrow(/Blocked/);
  });

  it("resolves action context values", () => {
    expect(resolveContext({ name: { "@path": "/user/name" }, fixed: 1 }, scope)).toEqual({ name: "Ada", fixed: 1 });
  });
});

describe("surface reducer", () => {
  const parse = (m: unknown) => messageSchema.parse(m);

  it("creates, updates and deletes a surface", () => {
    const surfaces = new Map<string, SurfaceSnapshot>();
    let r = applyMessages(surfaces, [
      parse({
        version: "1.0",
        createSurface: {
          surfaceId: "s1",
          components: [{ id: "root", component: "Column", children: ["t"] }, { id: "t", component: "Text", text: { "@path": "/msg" } }],
          dataModel: { msg: "hi" },
        },
      }),
    ]);
    expect(r).toMatchObject({ changed: ["s1"], errors: [], warnings: [] });
    expect(surfaces.get("s1")?.revision).toBe(1);

    r = applyMessages(surfaces, [
      parse({ updateDataModel: { surfaceId: "s1", path: "/msg", value: "bye" } }),
      parse({ updateComponents: { surfaceId: "s1", components: [{ id: "t", component: "Text", text: "static" }] } }),
    ]);
    expect(r.changed).toEqual(["s1"]);
    expect(surfaces.get("s1")?.dataModel).toEqual({ msg: "bye" });
    expect(surfaces.get("s1")?.components.t.text).toBe("static");
    expect(surfaces.get("s1")?.revision).toBe(3);

    r = applyMessages(surfaces, [parse({ deleteSurface: { surfaceId: "s1" } })]);
    expect(surfaces.get("s1")?.deleted).toBe(true);
  });

  it("reports unknown surfaces, missing refs, missing root and unknown types", () => {
    const surfaces = new Map<string, SurfaceSnapshot>();
    const r = applyMessages(surfaces, [
      parse({ updateDataModel: { surfaceId: "nope", value: {} } }),
      parse({ createSurface: { surfaceId: "s2", components: [{ id: "a", component: "Fancy", child: "ghost" }] } }),
    ]);
    expect(r.errors[0]).toMatch(/does not exist/);
    expect(r.warnings.join("\n")).toMatch(/no component with id "root"/);
    expect(r.warnings.join("\n")).toMatch(/unknown type "Fancy"/);
    expect(r.warnings.join("\n")).toMatch(/missing component "ghost"/);
  });

  it("warns when a slider's steps looks like a step size", () => {
    const surfaces = new Map<string, SurfaceSnapshot>();
    const r = applyMessages(surfaces, [
      parse({
        createSurface: {
          surfaceId: "s3",
          components: [{ id: "root", component: "Slider", min: 1, max: 50, steps: 1, value: { "@path": "/n" } }],
        },
      }),
    ]);
    expect(r.warnings.join("\n")).toMatch(/number of divisions; use 49/);
  });

  it("rejects messages with no known key", () => {
    expect(messageSchema.safeParse({ version: "1.0", somethingElse: {} }).success).toBe(false);
  });
});

describe("action prompt", () => {
  it("summarises context on one readable line", () => {
    expect(summariseContext({ title: "Offsite", tags: ["a", "b"], empty: "", n: 3 })).toBe(
      "title: Offsite · tags: a, b · empty: - · n: 3",
    );
    expect(summariseContext({ long: "x".repeat(500) }).length).toBe(240);
  });

  it("wraps the A2UI action envelope", () => {
    const text = formatActionPrompt({
      name: "submit",
      surfaceId: "s1",
      sourceComponentId: "btn",
      timestamp: "2026-11-24T00:00:00Z",
      context: { a: 1 },
      userMessage: "Submitted",
    });
    expect(text.startsWith("Submitted\na: 1\n\n<a2ui-action>")).toBe(true);
    const body = text.split("<a2ui-action>\n")[1].split("\n</a2ui-action>")[0];
    expect(JSON.parse(body)).toEqual({
      version: "1.0",
      action: { name: "submit", surfaceId: "s1", sourceComponentId: "btn", timestamp: "2026-11-24T00:00:00Z", context: { a: 1 }, userMessage: "Submitted" },
    });
  });
});

describe("kitchen-sink fixture", () => {
  it("parses and applies without errors or warnings", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(new URL("./fixtures/kitchen-sink.json", import.meta.url), "utf8")) as unknown[];
    const surfaces = new Map<string, SurfaceSnapshot>();
    const result = applyMessages(surfaces, raw.map((m) => messageSchema.parse(m)));
    expect(result).toEqual({ changed: ["kitchen_sink"], errors: [], warnings: [] });
    const data = surfaces.get("kitchen_sink")!.dataModel;
    expect(interpolate("${@index()}. ${item} x${qty}", { data, scope: "/orders/1", index: 1 })).toBe("1. Gadget x1");
  });
});

describe("review fixes", () => {
  const scope = { data, scope: "/" };

  it("accepts the spec's safe regex examples and rejects its unsafe ones", async () => {
    const { compileSafePattern } = await import("./shared/regex-safety");
    for (const ok of ["^[a-z]+@[a-z]+\\.com$", "^(?=.*\\d).{8,}$", "\\w+\\s+\\w+", "^\\d{10}$", "^(a|b)+$", "^[A-Z]{2}\\d{4}$"]) {
      expect(compileSafePattern(ok), ok).toMatchObject({ ok: true });
    }
    for (const bad of ["(a+)+$", "(a|ab)*c", "\\d+\\s*\\d+", "(\\w)\\1", "(?<=a)b", "(?<n>a)", "\\p{L}", "(?i)a", "a".repeat(257), "^(a+)+$"]) {
      expect(compileSafePattern(bad), bad).toMatchObject({ ok: false });
    }
  });

  it("fails a check fast instead of hanging on a catastrophic pattern", () => {
    const started = Date.now();
    const failure = evaluateChecks(
      [{ condition: { "@call": "regex", args: { value: "a".repeat(28) + "!", pattern: "^(a+)+$" } }, message: "bad" }],
      scope,
    );
    expect(failure?.valid).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("supports @index offset and rejects it outside a template", () => {
    expect(interpolate("#${@index(offset: 1)}", { data, scope: "/items/0", index: 0 })).toBe("#1");
    expect(interpolate("[${@index()}]", scope)).toBe("[]");
  });

  it("formats date-only values in local time", () => {
    expect(resolve({ "@call": "formatDate", args: { value: "2026-01-16", format: "MMM dd, yyyy" } }, scope)).toBe("Jan 16, 2026");
    expect(resolve({ "@call": "formatDate", args: { value: "2026-01-16 10:05", format: "HH:mm" } }, scope)).toBe("10:05");
  });

  it("drops a failed interpolation entirely", () => {
    expect(interpolate("A ${foo(value:1)} B", scope)).toBe("A  B");
    expect(interpolate("A ${formatNumber(value:${bar(x:1)}, decimals:2)} B", scope)).toBe("A  B");
  });

  it("requires a value on updateDataModel", () => {
    expect(messageSchema.safeParse({ updateDataModel: { surfaceId: "a", path: "/x" } }).success).toBe(false);
    expect(messageSchema.safeParse({ updateDataModel: { surfaceId: "a", path: "/x", value: null } }).success).toBe(true);
  });

  it("warns the agent about regex checks the renderer will reject", () => {
    const surfaces = new Map<string, SurfaceSnapshot>();
    const r = applyMessages(surfaces, [
      messageSchema.parse({
        createSurface: {
          surfaceId: "s4",
          components: [
            {
              id: "root",
              component: "TextField",
              label: "x",
              value: { "@path": "/x" },
              "@checks": [{ condition: { "@call": "regex", args: { value: { "@path": "/x" }, pattern: "(a+)+" } } }],
            },
          ],
        },
      }),
    ]);
    expect(r.warnings.join("\n")).toMatch(/regex "\(a\+\)\+".*rejects/);
  });
});
