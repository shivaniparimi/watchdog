import type { RepoReader } from "../src/testMap.js";

export function memoryRepo(files: Record<string, string>): RepoReader {
  return {
    listFiles: () => Object.keys(files),
    read: (path) => files[path] ?? null,
  };
}

/** Build a unified-diff patch that adds every line of `content` (a brand-new file). */
export function addedFilePatch(content: string): string {
  const lines = content.split("\n");
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}
