import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSourceDir = resolve(rootDir, "../riz-mcp/.agents/skills/riz-mcp");
const vendoredDir = resolve(rootDir, "agent/subagents/coach/skills/riz-mcp");
const lockPath = resolve(rootDir, "scripts/riz-mcp-skill.lock.json");

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symbolic links are not supported: ${path}`);
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  await visit(directory);
  return files;
}

async function hashDirectory(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const files = await filesUnder(directory);
  const entries = files
    .map((path) => ({
      path,
      relativePath: relative(directory, path).split(sep).join("/"),
    }))
    .sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    );

  for (const entry of entries) {
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(await readFile(entry.path));
  }

  return hash.digest("hex");
}

function sourceCommit(sourceDir: string): string {
  return execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

async function check(): Promise<void> {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const actualHash = await hashDirectory(vendoredDir);
  if (actualHash !== lock.hash) {
    throw new Error(
      `vendored skill hash mismatch: lock has ${lock.hash}, files have ${actualHash}; run pnpm sync:riz-mcp-skill`,
    );
  }

  console.log(`[riz-mcp-skill] vendored skill matches ${lock.source}@${lock.commit}`);
}

async function sync(sourceDir: string): Promise<void> {
  const commit = sourceCommit(sourceDir);
  await rm(vendoredDir, { recursive: true, force: true });
  await mkdir(dirname(vendoredDir), { recursive: true });
  await cp(sourceDir, vendoredDir, { recursive: true });
  const lock = {
    source: "nafisazizir/riz-mcp",
    path: ".agents/skills/riz-mcp",
    commit,
    hash: await hashDirectory(vendoredDir),
  };

  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`[riz-mcp-skill] synced ${lock.source}@${commit} (${lock.hash})`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--check") {
    await check();
    return;
  }

  let sourceDir = defaultSourceDir;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--from" || !args[index + 1]) {
      throw new Error("usage: node scripts/sync-riz-mcp-skill.ts [--from <dir>] | --check");
    }
    sourceDir = resolve(process.cwd(), args[index + 1]);
    index += 1;
  }

  await sync(sourceDir);
}

main().catch((error: unknown) => {
  console.error(`[riz-mcp-skill] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
