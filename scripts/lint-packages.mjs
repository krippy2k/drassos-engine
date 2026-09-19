import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const coreFiles = walk(join(repoRoot, "packages/core/src")).filter((file) => file.endsWith(".ts"));
const banned = /from ["'](?:node:|pg["']|pino["']|@electric-sql\/pglite|@drassos\/(?:node|engine|testing))/;
let failed = false;
for (const file of coreFiles) {
  const source = readFileSync(file, "utf8");
  if (banned.test(source)) {
    console.error(`Core boundary violation: ${file}`);
    failed = true;
  }
}

const manifests = ["core", "node", "testing", "engine"].map((name) => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "packages", name, "package.json"), "utf8"));
  return { name: pkg.name, deps: { ...pkg.dependencies, ...pkg.peerDependencies }, pkg };
});

const graph = Object.fromEntries(manifests.map((item) => [item.name, Object.keys(item.deps).filter((dep) => dep.startsWith("@drassos/"))]));
if ((graph["@drassos/core"] ?? []).length > 0) {
  console.error("@drassos/core must not depend on other Drassos packages");
  failed = true;
}
if ((graph["@drassos/node"] ?? []).includes("@drassos/testing")) {
  console.error("@drassos/node must not depend on @drassos/testing");
  failed = true;
}

for (const item of manifests) {
  const exportKeys = Object.keys(item.pkg.exports ?? {});
  if (exportKeys.some((key) => key.includes("internal") || key.includes("/src/"))) {
    console.error(`${item.name} exports leak internals: ${exportKeys.join(", ")}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log("Package lint passed");
