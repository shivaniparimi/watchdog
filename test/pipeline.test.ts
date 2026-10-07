import { describe, expect, it, vi } from "vitest";
import { findTestGaps, type Judge } from "../src/pipeline.js";
import { inlineComments, shouldFail, summaryMarkdown, SUMMARY_MARKER } from "../src/report.js";
import type { ChangedFile, Config } from "../src/types.js";
import { addedFilePatch, memoryRepo } from "./helpers.js";

const config: Config = { ignorePaths: [], maxFunctions: 40, failOn: "none" };

const pricing = `export function price(qty: number): number {
  if (qty < 0) throw new Error("negative");
  return qty * 10;
}

export function label(qty: number): string {
  return qty + " items";
}

export function shipping(weight: number): number {
  return weight > 10 ? 15 : 5;
}
`;

const pricingTest = `import { price, label } from "./pricing";

it("prices", () => {
  expect(price(2)).toBe(20);
});

it("labels", () => {
  expect(label(2)).toBe("2 items");
});
`;

function setup(changedTest: boolean) {
  const repo = memoryRepo({
    "src/pricing.ts": pricing,
    "src/pricing.test.ts": pricingTest,
    "README.md": "",
  });
  const files: ChangedFile[] = [
    { path: "src/pricing.ts", status: "added", patch: addedFilePatch(pricing) },
    { path: "README.md", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
  ];
  if (changedTest)
    files.push({
      path: "src/pricing.test.ts",
      status: "modified",
      patch: "@@ -8 +8 @@\n-x\n+y",
    });
  return { repo, files };
}

describe("findTestGaps without AI", () => {
  it("sorts functions into covered, unverified and untested", async () => {
    const { repo, files } = setup(false);
    const result = await findTestGaps(files, repo, config);
    const byName = Object.fromEntries(result.findings.map((f) => [f.name, f]));

    expect(byName.shipping!.status).toBe("untested");
    expect(byName.price!.status).toBe("needs-judgment");
    expect(byName.price!.verdict.uncertain).toBe(true);
    expect(result.aiNote).toMatch(/AI review is off/);

    const comments = inlineComments(result);
    expect(comments.map((c) => [c.path, c.line])).toEqual([["src/pricing.ts", 10]]);
  });

  it("treats a test changed in the PR that mentions the function as covered", async () => {
    const { repo, files } = setup(true);
    const result = await findTestGaps(files, repo, config);
    expect(result.findings.find((f) => f.name === "label")!.status).toBe("covered-in-pr");
  });
});

describe("findTestGaps with AI", () => {
  it("sends only undecided functions to the judge and uses its verdicts", async () => {
    const { repo, files } = setup(true);
    const judge = vi.fn<Judge>(async (symbols) => {
      const verdicts = new Map();
      for (const s of symbols) {
        verdicts.set(s.id, {
          covered: false,
          risk: s.name === "price" ? "high" : "low",
          reason: s.name === "price" ? "The negative-quantity error path is never tested." : "Shipping tiers untested.",
          suggestedTest: s.name === "price" ? 'it("rejects negative", () => expect(() => price(-1)).toThrow());' : "",
          source: "ai",
        });
      }
      return verdicts;
    });

    const result = await findTestGaps(files, repo, config, judge);
    // price and label are both mentioned in the changed test, so they skip the judge; shipping is untested.
    expect(judge.mock.calls[0]![0].map((s) => s.name)).toEqual(["shipping"]);
    expect(result.findings[0]!.name).toBe("shipping");
    expect(shouldFail(result, "low")).toBe(true);
    expect(shouldFail(result, "medium")).toBe(false);
  });

  it("falls back to rule verdicts when the judge throws", async () => {
    const { repo, files } = setup(false);
    const result = await findTestGaps(files, repo, config, async () => {
      throw new Error("rate limited");
    });
    expect(result.aiNote).toMatch(/AI review failed \(rate limited\)/);
    expect(result.findings.find((f) => f.name === "shipping")!.verdict.source).toBe("rule");
  });
});

describe("summaryMarkdown", () => {
  it("includes the marker and a row per function", async () => {
    const { repo, files } = setup(false);
    const md = summaryMarkdown(await findTestGaps(files, repo, config));
    expect(md.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(md).toContain("| `shipping` | `src/pricing.ts:10` | ⚠️ Untested |");
    expect(md).toContain("❔ Unverified");
  });

  it("says so when nothing relevant changed", async () => {
    const md = summaryMarkdown(
      await findTestGaps(
        [
          {
            path: "README.md",
            status: "modified",
            patch: "@@ -1 +1 @@\n-a\n+b",
          },
        ],
        memoryRepo({}),
        config,
      ),
    );
    expect(md).toContain("No source files with logic changes");
  });
});
