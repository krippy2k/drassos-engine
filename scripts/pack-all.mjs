import { mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "artifacts", "tarballs");
mkdirSync(outDir, { recursive: true });

const packages = ["core", "engine", "node", "testing"];
for (const name of packages) {
  const cwd = join(repoRoot, "packages", name);
  const build = spawnSync("pnpm", ["build"], { cwd, stdio: "inherit", shell: true });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
  const packed = spawnSync("pnpm", ["pack", "--pack-destination", outDir], { cwd, stdio: "inherit", shell: true });
  if (packed.status !== 0) {
    process.exit(packed.status ?? 1);
  }
}

console.log("Packed tarballs:");
for (const file of readdirSync(outDir).filter((item) => item.endsWith(".tgz"))) {
  console.log(`  ${join(outDir, file)}`);
}
