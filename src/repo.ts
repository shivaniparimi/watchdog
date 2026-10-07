import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoReader } from "./testMap.js";

/** Reads a git checkout on disk. `overrides` replaces specific files (e.g. exact PR-head versions). */
export function fsRepo(root: string, overrides: Map<string, string> = new Map()): RepoReader {
  let files: string[] | undefined;
  const cache = new Map<string, string | null>(overrides);

  return {
    listFiles() {
      files ??= execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
        .split("\n")
        .filter(Boolean);
      return files;
    },
    read(path) {
      if (!cache.has(path)) {
        let content: string | null = null;
        try {
          content = readFileSync(join(root, path), "utf8");
        } catch {
          // Missing or unreadable (e.g. deleted in the working tree).
        }
        cache.set(path, content);
      }
      return cache.get(path) ?? null;
    },
  };
}
