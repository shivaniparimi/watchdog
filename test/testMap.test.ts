import { describe, expect, it } from "vitest";
import { candidateTests, mentionExcerpt, sourceStem, testStem } from "../src/testMap.js";
import { memoryRepo } from "./helpers.js";

describe("stems", () => {
  it.each([
    ["src/cart/total.test.ts", "total"],
    ["tests/test_total.py", "total"],
    ["app/total_test.py", "total"],
    ["src/test/java/CartTest.java", "cart"],
  ])("testStem(%s) = %s", (path, stem) => expect(testStem(path)).toBe(stem));

  it("uses the folder name for index files", () => {
    expect(sourceStem("src/cart/index.ts")).toBe("cart");
  });
});

describe("candidateTests", () => {
  it("matches by file name and by import, across ts/js, and ignores other languages", () => {
    const repo = memoryRepo({
      "src/cart/total.ts": "",
      "src/cart/total.test.ts": "",
      "test/checkout.spec.js": "import { total } from '../src/cart/total';",
      "test/unrelated.test.ts": "import { x } from '../src/other';",
      "tests/test_total.py": "",
    });
    expect(candidateTests("src/cart/total.ts", repo).sort()).toEqual([
      "src/cart/total.test.ts",
      "test/checkout.spec.js",
    ]);
  });

  it("matches Python tests that import the module", () => {
    const repo = memoryRepo({
      "app/billing.py": "",
      "tests/test_invoices.py": "from app.billing import charge\n",
      "tests/test_other.py": "from app.users import get\n",
    });
    expect(candidateTests("app/billing.py", repo)).toEqual(["tests/test_invoices.py"]);
  });

  it("treats Go tests in the same package directory as candidates", () => {
    const repo = memoryRepo({
      "pkg/cart/total.go": "",
      "pkg/cart/helpers_test.go": "",
      "pkg/other/x_test.go": "",
    });
    expect(candidateTests("pkg/cart/total.go", repo)).toEqual(["pkg/cart/helpers_test.go"]);
  });
});

describe("candidateTests import resolution", () => {
  it("only counts relative imports that resolve to the source file itself", () => {
    const repo = memoryRepo({
      "examples/demo/pricing.ts": "",
      "test/pipeline.test.ts":
        'const sample = `import { price } from "./pricing";`;\nimport { x } from "../src/pipeline.js";',
      "test/other.test.ts": 'import { price } from "./pricing";', // resolves to test/pricing, a different file
      "examples/demo/flow.test.ts": 'import { price } from "./pricing.js";',
      "test/alias.test.ts": 'import { price } from "@/demo/pricing";',
      "test/dynamic.test.ts": 'const m = await import("../examples/demo/pricing");',
    });
    expect(candidateTests("examples/demo/pricing.ts", repo).sort()).toEqual([
      "examples/demo/flow.test.ts",
      "test/alias.test.ts",
      "test/dynamic.test.ts",
    ]);
  });

  it("matches an import of a folder to its index file", () => {
    const repo = memoryRepo({
      "src/cart/index.ts": "",
      "test/checkout.test.ts": 'import { total } from "../src/cart";',
    });
    expect(candidateTests("src/cart/index.ts", repo)).toEqual(["test/checkout.test.ts"]);
  });
});

describe("mentionExcerpt", () => {
  it("returns numbered lines around whole-word mentions only", () => {
    const content = "a\nb\nexpect(applyDiscount(10)).toBe(5)\nc\nd\nconst applyDiscountX = 1";
    const ex = mentionExcerpt(content, "applyDiscount", 1)!;
    expect(ex).toBe("2: b\n3: expect(applyDiscount(10)).toBe(5)\n4: c");
    expect(mentionExcerpt("nothing here", "applyDiscount")).toBeNull();
  });
});
