import { describe, expect, it } from "vitest";
import { classifyFile } from "../src/classify.js";

describe("classifyFile", () => {
  it.each([
    ["src/cart/total.ts", "source"],
    ["app/models.py", "source"],
    ["pkg/cart/total.go", "source"],
    ["src/main/java/com/shop/Cart.java", "source"],
    ["src/cart/total.test.ts", "test"],
    ["src/__tests__/total.ts", "test"],
    ["tests/test_models.py", "test"],
    ["app/models_test.py", "test"],
    ["pkg/cart/total_test.go", "test"],
    ["src/test/java/com/shop/CartTest.java", "test"],
    ["README.md", "ignore"],
    ["package.json", "ignore"],
    ["src/types.d.ts", "ignore"],
    ["dist/index.js", "ignore"],
    ["node_modules/x/index.js", "ignore"],
    ["vite.config.ts", "ignore"],
    ["app/__init__.py", "ignore"],
    ["db/migrations/0001_init.py", "ignore"],
  ])("%s → %s", (path, kind) => {
    expect(classifyFile(path)).toBe(kind);
  });

  it("applies user ignore globs", () => {
    expect(classifyFile("scripts/seed.ts", ["scripts/**"])).toBe("ignore");
  });
});
