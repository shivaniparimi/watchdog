import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePatch } from "../src/diff.js";
import { fsRepo } from "../src/repo.js";
import { generateMutants, maskLine, mutateLine, mutationScore, runMutations } from "../src/verify/mutate.js";
import { proveFindings } from "../src/verify/prove.js";
import { scrubbedEnv, type RunResult, type TestRunner } from "../src/verify/runner.js";
import type { Finding } from "../src/review/report.js";
import type { AiProvider } from "../src/ai/index.js";
import { gitRepo } from "./helpers.js";

describe("maskLine", () => {
  it("blanks strings and comments but keeps positions", () => {
    const line = 'if (a === "x == y") return b; // a > b';
    const masked = maskLine(line, "ts");
    expect(masked).toHaveLength(line.length);
    expect(masked).toContain("===");
    expect(masked).not.toContain("x == y");
    expect(masked).not.toContain("a > b");
    expect(maskLine("x = 'a and b'  # c or d", "python")).not.toMatch(/and|or/);
  });
});

describe("mutateLine", () => {
  const descs = (line: string, lang: "ts" | "python" = "ts") => mutateLine(line, lang, 9).map((m) => m.description);

  it("flips comparisons, logic and booleans, one change per kind", () => {
    expect(descs("  if (a === b && c > 1) return true;")).toEqual([
      "`===` → `!==`",
      "`>` → `<=`",
      "`&&` → `||`",
      "`true` → `false`",
    ]);
    expect(mutateLine("  if (a === b && c > 1) return true;", "ts")).toHaveLength(3);
    expect(descs("    if code == 'X' and total > 50:", "python")).toEqual([
      "`==` → `!=`",
      "`>` → `<=`",
      "`and` → `or`",
    ]);
    expect(descs("    return not done", "python")).toEqual(["`not` → `(removed)`"]);
  });

  it("produces the mutated source line", () => {
    expect(mutateLine("  return total - percent;", "ts")[0]!.mutated).toBe("  return total + percent;");
  });

  it("leaves strings, comments, generics, arrows, imports, regexes and trivial lines alone", () => {
    expect(descs('  log("a > b && c");')).toEqual([]);
    expect(descs("  const xs: Array<string> = [];")).toEqual([]);
    expect(descs("  const f = (x) => x;")).toEqual([]);
    expect(descs('import { a } from "./b";')).toEqual([]);
    expect(descs("  const ok = /a+b/.test(s) && t;")).toEqual([]);
    expect(descs("  // if (a > b)")).toEqual([]);
    expect(descs("  i++;")).toEqual([]);
  });
});

describe("generateMutants", () => {
  it("only mutates added lines and spreads the budget across files", () => {
    const a = {
      path: "a.ts",
      content: "x;\nif (a > b) {}\nif (c === d) {}\n",
      patch: parsePatch("@@ -1 +1,3 @@\n x;\n+if (a > b) {}\n+if (c === d) {}"),
    };
    const b = { path: "b.ts", content: "if (e > f) {}\n", patch: parsePatch("@@ -0,0 +1 @@\n+if (e > f) {}") };
    const mutants = generateMutants([a, b], 2);
    expect(mutants.map((m) => `${m.path}:${m.line}`)).toEqual(["a.ts:2", "b.ts:1"]);
  });
});

/** A runner that "passes" unless the source on disk contains one of the given break markers. */
function fakeRunner(root: string, file: string, caughtIf: RegExp, calls: string[][] = []): TestRunner {
  return {
    framework: "vitest",
    language: "js",
    async run(files): Promise<RunResult> {
      calls.push(files);
      const src = readFileSync(join(root, file), "utf8");
      return { status: caughtIf.test(src) ? "fail" : "pass", output: "", durationMs: 1 };
    },
  };
}

describe("runMutations", () => {
  it("runs each mutant against the file's tests, records survivors, and restores the file", async () => {
    const source = "export function ok(a, b) {\n  return a > b && b > 0;\n}\n";
    const root = gitRepo({
      "src/ok.ts": "export function ok() {}\n",
      "src/ok.test.ts": "import { ok } from './ok';\n",
    });
    writeFileSync(join(root, "src/ok.ts"), source);
    // Tests notice the comparison flip but not the && → || change.
    const runner = fakeRunner(root, "src/ok.ts", /a <= b/);
    const report = await runMutations(
      [
        {
          path: "src/ok.ts",
          status: "modified",
          patch: "@@ -1 +1,3 @@\n-export function ok() {}\n+export function ok(a, b) {\n+  return a > b && b > 0;\n+}",
        },
      ],
      {
        root,
        repo: fsRepo(root),
        runners: new Map([["js", runner]]),
        ignorePaths: [],
        maxMutants: 10,
        budgetMs: 60_000,
        testTimeoutMs: 10_000,
      },
    );
    expect(report.results.map((r) => [r.description, r.status])).toEqual([
      ["`>` → `<=`", "killed"],
      ["`&&` → `||`", "survived"],
    ]);
    expect(mutationScore(report.results)).toEqual({ killed: 1, survived: 1, score: 0.5 });
    expect(readFileSync(join(root, "src/ok.ts"), "utf8")).toBe(source);
  });

  it("skips files without tests and files whose tests already fail", async () => {
    const root = gitRepo({
      "src/a.ts": "if (x > 1) {}\n",
      "src/b.ts": "if (y > 1) {}\n",
      "src/b.test.ts": "import './b';\n",
    });
    const failing: TestRunner = {
      framework: "vitest",
      language: "js",
      run: async () => ({ status: "fail", output: "", durationMs: 1 }),
    };
    const patch = (l: string) => `@@ -0,0 +1 @@\n+${l}`;
    const report = await runMutations(
      [
        { path: "src/a.ts", status: "added", patch: patch("if (x > 1) {}") },
        { path: "src/b.ts", status: "added", patch: patch("if (y > 1) {}") },
      ],
      {
        root,
        repo: fsRepo(root),
        runners: new Map([["js", failing]]),
        ignorePaths: [],
        maxMutants: 10,
        budgetMs: 60_000,
        testTimeoutMs: 10_000,
      },
    );
    expect(report.results).toEqual([]);
    expect(report.skipped).toEqual([
      { path: "src/a.ts", reason: "no tests found for this file" },
      { path: "src/b.ts", reason: "its tests don't pass as-is (fail)" },
    ]);
  });
});

describe("scrubbedEnv", () => {
  it("removes tokens, keys and Action inputs but keeps PATH", () => {
    const env = scrubbedEnv({
      PATH: "/bin",
      HOME: "/home/x",
      GITHUB_TOKEN: "t",
      "INPUT_GEMINI-API-KEY": "k",
      ANTHROPIC_API_KEY: "k",
      ACTIONS_RUNTIME_TOKEN: "t",
      NPM_AUTH: "a",
    });
    expect(Object.keys(env).sort()).toEqual([
      "CI",
      "FORCE_COLOR",
      "HOME",
      "NODE_ENV",
      "NO_COLOR",
      "PATH",
      "PYTHONDONTWRITEBYTECODE",
    ]);
  });
});

describe("proveFindings", () => {
  const source = "export function applyCoupon(total, percent) {\n  return total - percent;\n}\n";
  const finding = (over: Partial<Finding> = {}): Finding => ({
    path: "src/cart.ts",
    line: 2,
    start_line: null,
    severity: "major",
    category: "bug",
    title: "Coupon subtracts a flat amount",
    body: "",
    suggestion: "  return total * (1 - percent / 100);",
    inline: true,
    ...over,
  });

  function setup(submissions: object[]) {
    const root = gitRepo({ "src/cart.ts": source, "src/cart.test.ts": "import './cart';\n" });
    const calls: string[][] = [];
    // The proof test "fails" while the bug is present and "passes" once the fix is applied;
    // a test file importing ./nope "can't run".
    const runner: TestRunner = {
      framework: "vitest",
      language: "js",
      async run(files): Promise<RunResult> {
        calls.push(files);
        const proof = files.find((f) => f.includes("watchdog-proof"));
        const test = proof ? readFileSync(join(root, proof), "utf8") : "";
        if (test.includes("./nope")) return { status: "error", output: "Failed to resolve import", durationMs: 1 };
        if (test.includes("REFUTE")) return { status: "pass", output: "", durationMs: 1 };
        const fixed = readFileSync(join(root, "src/cart.ts"), "utf8").includes("1 - percent / 100");
        return { status: fixed ? "pass" : "fail", output: "expected 190 to be 180", durationMs: 1 };
      },
    };
    const queue = [...submissions];
    const prompts: string[] = [];
    const provider = {
      name: "gemini",
      model: "fake",
      reviewChars: 1e6,
      maxIterations: 5,
      runAgent: async (req: { user: string }) => {
        prompts.push(req.user);
        return { output: queue.shift() ?? null, toolCalls: 0 };
      },
    } as unknown as AiProvider;
    const options = {
      provider,
      root,
      repo: fsRepo(root),
      runners: new Map([["js" as const, runner]]),
      files: [],
      maxProofs: 5,
      testTimeoutMs: 10_000,
    };
    return { root, calls, prompts, options };
  }

  it("confirms a bug when its test fails, verifies the fix, and cleans up", async () => {
    const { root, calls, options } = setup([
      { path: "src/x.test.ts", code: "test ./cart", why_it_fails: "190 not 180" },
    ]);
    const proofs = await proveFindings([finding()], options);
    expect(proofs.get(0)).toMatchObject({
      status: "confirmed",
      fixVerified: true,
      testPath: "src/watchdog-proof-1.test.ts",
    });
    expect(calls[1]).toEqual(["src/watchdog-proof-1.test.ts", "src/cart.test.ts"]); // fix run includes related tests
    expect(readFileSync(join(root, "src/cart.ts"), "utf8")).toBe(source);
    expect(() => readFileSync(join(root, "src/watchdog-proof-1.test.ts"))).toThrow();
  });

  it("dismisses a finding whose test passes", async () => {
    const { options } = setup([{ path: "src/x.test.ts", code: "REFUTE", why_it_fails: "" }]);
    expect((await proveFindings([finding()], options)).get(0)?.status).toBe("refuted");
  });

  it("gives the model the error and one more try when its test can't run", async () => {
    const { prompts, options } = setup([
      { path: "src/x.test.ts", code: "import ./nope", why_it_fails: "" },
      { path: "src/x.test.ts", code: "test ./cart", why_it_fails: "" },
    ]);
    expect((await proveFindings([finding()], options)).get(0)?.status).toBe("confirmed");
    expect(prompts[1]).toContain("couldn't run");
    expect(prompts[1]).toContain("Failed to resolve import");
  });

  it("only tries provable categories, rejects paths outside the repo, and respects maxProofs", async () => {
    const { options } = setup([{ path: "../../evil.test.ts", code: "x", why_it_fails: "" }]);
    const proofs = await proveFindings(
      [finding({ category: "style" }), finding({ severity: "nit" }), finding(), finding()],
      { ...options, maxProofs: 1 },
    );
    expect([...proofs.keys()]).toEqual([2]);
    expect(proofs.get(2)).toMatchObject({
      status: "inconclusive",
      note: expect.stringMatching(/outside the repository/),
    });
  });
});
