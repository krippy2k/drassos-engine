import { mkdtempSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSrc = join(repoRoot, "fixtures", "external-consumer", "src");
const tarballDir = join(repoRoot, "artifacts", "tarballs");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

run("node", [join(repoRoot, "scripts", "pack-all.mjs")], repoRoot);

const tarballs = Object.fromEntries(
  readdirSync(tarballDir)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => {
      const name = file.replace(/-\d+\.\d+\.\d+.*\.tgz$/, "");
      return [name, join(tarballDir, file).replaceAll("\\", "/")];
    }),
);

const required = ["drassos-core", "drassos-engine", "drassos-node", "drassos-testing"];
for (const name of required) {
  if (!tarballs[name]) {
    throw new Error(`Missing packed tarball for ${name} in ${tarballDir}: ${Object.keys(tarballs).join(", ")}`);
  }
}

const banned = [/\.env/, /credentials/i, /id_rsa/, /\.pem$/];
for (const [name, file] of Object.entries(tarballs)) {
  const listing = spawnSync("tar", ["-tzf", file], { encoding: "utf8", shell: true });
  const contents = `${listing.stdout ?? ""}\n${listing.stderr ?? ""}`;
  if (listing.status !== 0) {
    throw new Error(`Unable to inspect tarball ${name}: ${contents}`);
  }
  if (banned.some((pattern) => pattern.test(contents))) {
    throw new Error(`Tarball ${name} contains unexpected files:\n${contents}`);
  }
  if (!contents.includes("package/dist/")) {
    throw new Error(`Tarball ${name} is missing dist/:\n${contents}`);
  }
  if (contents.includes("package/src/")) {
    throw new Error(`Tarball ${name} unexpectedly includes source files`);
  }
}

const work = mkdtempSync(join(tmpdir(), "drassos-consumer-"));
cpSync(fixtureSrc, join(work, "src"), { recursive: true });
writeFileSync(
  join(work, "package.json"),
  JSON.stringify(
    {
      name: "drassos-external-consumer",
      private: true,
      type: "module",
      dependencies: {
        "@drassos/core": tarballs["drassos-core"],
        "@drassos/engine": tarballs["drassos-engine"],
        "@drassos/node": tarballs["drassos-node"],
        "@drassos/testing": tarballs["drassos-testing"],
      },
      devDependencies: {
        "@types/node": "^24.3.0",
        typescript: "^5.9.2",
      },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(work, "pnpm-workspace.yaml"),
  [
    "overrides:",
    `  "@drassos/core": "${tarballs["drassos-core"]}"`,
    `  "@drassos/engine": "${tarballs["drassos-engine"]}"`,
    `  "@drassos/node": "${tarballs["drassos-node"]}"`,
    `  "@drassos/testing": "${tarballs["drassos-testing"]}"`,
    "",
  ].join("\n"),
);
writeFileSync(
  join(work, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        types: ["node"],
        skipLibCheck: true,
        noEmit: false,
        outDir: "dist",
      },
      include: ["src/**/*.ts"],
    },
    null,
    2,
  ),
);

run("pnpm", ["install"], work);
run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], work);
run("node", ["dist/index.js"], work);

console.log(`External consumer smoke test passed in ${work}`);
