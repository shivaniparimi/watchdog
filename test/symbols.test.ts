import { describe, expect, it } from "vitest";
import { parsePatch } from "../src/diff.js";
import { changedSymbols, findFunctions, isTrivialLine } from "../src/symbols.js";

const TS = `import { tax } from "./tax";

export function subtotal(items: Item[]): number {
  return items.reduce((s, i) => s + i.price * i.qty, 0);
}

export const applyDiscount = (total: number, code?: string): number => {
  if (code === "HALF") {
    return total / 2;
  }
  return total;
};

const double = (n: number) => n * 2;
const RATE = (1 + 2) * 3;

class Cart {
  private items: Item[] = [];

  async checkout(user: User): Promise<Receipt> {
    if (!user) throw new Error("no user");
    return { total: subtotal(this.items) };
  }
}
`;

describe("findFunctions (TypeScript)", () => {
  it("finds declarations, arrow functions and methods with correct ranges", () => {
    const defs = findFunctions(TS, "ts");
    expect(defs.map((d) => [d.name, d.start, d.end])).toEqual([
      ["subtotal", 3, 5],
      ["applyDiscount", 7, 12],
      ["double", 14, 14],
      ["checkout", 20, 23],
    ]);
  });
});

describe("findFunctions (Python)", () => {
  it("handles multi-line signatures, nested functions and dedent", () => {
    const py = [
      "def total(",          // 1
      "    items,",          // 2
      "    tax=0.1,",        // 3
      "):",                  // 4
      "    def line(i):",    // 5
      "        return i.p",  // 6
      "",                    // 7
      "    return sum(line(i) for i in items)", // 8
      "",                    // 9
      "class Cart:",         // 10
      "    async def pay(self, user):", // 11
      "        if not user:", // 12
      "            raise ValueError()", // 13
      "        return True",  // 14
      "",
      "RATE = 3",
    ].join("\n");
    expect(findFunctions(py, "python").map((d) => [d.name, d.start, d.end])).toEqual([
      ["total", 1, 8],
      ["line", 5, 6],
      ["pay", 11, 14],
    ]);
  });
});

describe("findFunctions (Go and Java)", () => {
  it("finds Go functions and methods", () => {
    const go = 'package cart\n\nfunc Total(items []Item) int {\n\treturn 0\n}\n\nfunc (c *Cart) Add(i Item) {\n\tc.items = append(c.items, i)\n}\n';
    expect(findFunctions(go, "go").map((d) => [d.name, d.start, d.end])).toEqual([
      ["Total", 3, 5],
      ["Add", 7, 9],
    ]);
  });

  it("finds Java methods but skips abstract ones and control statements", () => {
    const java = [
      "public class Cart {",
      "  public int total(List<Item> items) {",
      "    if (items.isEmpty()) {",
      "      return 0;",
      "    }",
      "    return items.size();",
      "  }",
      "  abstract void reset();",
      "}",
    ].join("\n");
    expect(findFunctions(java, "java").map((d) => [d.name, d.start, d.end])).toEqual([["total", 2, 7]]);
  });
});

describe("isTrivialLine", () => {
  it.each([
    ["", true],
    ["  // note", true],
    ["import x from 'y';", true],
    ["console.log(total);", true],
    ["});", true],
    ["return total / 2;", false],
    ["if (code === 'HALF') {", false],
  ])("ts: %j → %s", (line, trivial) => {
    expect(isTrivialLine(line, "ts")).toBe(trivial);
  });

  it.each([
    ["# comment", true],
    ["from app import x", true],
    ['"""Docstring."""', true],
    ["return a + b", false],
  ])("python: %j → %s", (line, trivial) => {
    expect(isTrivialLine(line, "python")).toBe(trivial);
  });
});

describe("changedSymbols", () => {
  it("groups changed lines by function and ignores comment-only edits", () => {
    const patch = parsePatch(
      [
        "@@ -2,11 +2,11 @@",
        " ",
        " export function subtotal(items: Item[]): number {",
        "-  // old comment",
        "+  // new comment",
        "   return items.reduce((s, i) => s + i.price * i.qty, 0);",
        " }",
        " ",
        " export const applyDiscount = (total: number, code?: string): number => {",
        "-  if (code === \"HALF\") {",
        "+  if (code === \"HALF\" || code === \"50OFF\") {",
        "     return total / 2;",
        "   }",
      ].join("\n"),
    );
    const content = TS.replace("number {\n  return items", "number {\n  // new comment\n  return items").replace(
      'code === "HALF"',
      'code === "HALF" || code === "50OFF"',
    );
    const syms = changedSymbols("src/cart.ts", "ts", content, patch);
    expect(syms.map((s) => s.name)).toEqual(["applyDiscount"]);
    expect(syms[0]!.changedLines).toEqual([9]);
    expect(syms[0]!.isNew).toBe(false);
    expect(syms[0]!.diffSnippet).toContain('L9 +   if (code === "HALF" || code === "50OFF") {');
  });

  it("marks a function as new when all of its lines were added", () => {
    const content = "export function a() {\n  return 1;\n}\n";
    const patch = parsePatch("@@ -0,0 +1,3 @@\n+export function a() {\n+  return 1;\n+}");
    expect(changedSymbols("a.ts", "ts", content, patch)[0]?.isNew).toBe(true);
  });

  it("does not blame the next function for a deleted neighbour", () => {
    const content = "function keep() {\n  return 1;\n}\n";
    const patch = parsePatch("@@ -1,6 +1,3 @@\n-function gone() {\n-  return 2;\n-}\n function keep() {\n   return 1;\n }");
    expect(changedSymbols("a.ts", "ts", content, patch)).toEqual([]);
  });
});
