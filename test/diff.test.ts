import { describe, expect, it } from "vitest";
import { parsePatch, splitGitDiff } from "../src/diff.js";

describe("parsePatch", () => {
  it("numbers added and context lines by their new-file position", () => {
    const p = parsePatch(
      [
        "@@ -10,4 +10,5 @@ function total(",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "+const c = 4;",
        " return a;",
      ].join("\n"),
    );
    expect([...p.added]).toEqual([11, 12]);
    expect([...p.commentable].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
    expect(p.entries.find((e) => e.kind === "-")).toEqual({
      kind: "-",
      newLine: 11,
      text: "const b = 2;",
    });
  });

  it("handles multiple hunks, single-line hunk headers and no-newline markers", () => {
    const p = parsePatch(
      ["@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file", "@@ -20,2 +20,3 @@", " x", "+y", " z"].join("\n"),
    );
    expect([...p.added]).toEqual([1, 21]);
    expect(p.commentable.has(22)).toBe(true);
    expect(p.entries).toHaveLength(5);
  });

  it("ignores a trailing newline instead of inventing a context line", () => {
    const p = parsePatch("@@ -1,1 +1,2 @@\n a\n+b\n");
    expect([...p.commentable]).toEqual([1, 2]);
  });
});

describe("splitGitDiff", () => {
  it("splits a multi-file git diff and detects new, deleted and renamed files", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/old.py b/old.py",
      "deleted file mode 100644",
      "--- a/old.py",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/src/b.ts b/src/c.ts",
      "similarity index 90%",
      "rename from src/b.ts",
      "rename to src/c.ts",
    ].join("\n");
    const files = splitGitDiff(diff);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/a.ts", "modified"],
      ["src/new.ts", "added"],
      ["old.py", "removed"],
      ["src/c.ts", "renamed"],
    ]);
    expect(files[0]!.patch).toBe("@@ -1 +1 @@\n-x\n+y");
    expect(files[3]!.patch).toBeUndefined();
  });
});
