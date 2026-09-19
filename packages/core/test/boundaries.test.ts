import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

describe("package boundaries", () => {
  it("does not import Node infrastructure from core source", () => {
    const files = walk(join(root, "src")).filter((file) => file.endsWith(".ts"));
    const banned = /from ["'](?:node:|pg["']|pino["']|@electric-sql\/pglite|@drassos\/(?:node|engine|testing))/;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(banned);
    }
  });

  it("exposes only the documented public entry points", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
      publishConfig: { exports: Record<string, unknown> };
    };
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./errors", "./types"]);
    expect(Object.keys(manifest.publishConfig.exports).sort()).toEqual([".", "./errors", "./types"]);
    expect(JSON.stringify(manifest.exports)).not.toMatch(/src\/internal/);
  });
});
