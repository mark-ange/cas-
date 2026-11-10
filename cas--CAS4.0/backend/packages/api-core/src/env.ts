import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const shellEnvironmentKeys = new Set(Object.keys(process.env));

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key || shellEnvironmentKeys.has(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

// More specific files override shared defaults; shell-provided variables override all files.
const envFiles = new Set([
  join(projectRoot, ".env"),
  join(projectRoot, ".env.local"),
  join(projectRoot, "backend", ".env"),
  join(projectRoot, "backend", ".env.local"),
  join(process.cwd(), ".env"),
  join(process.cwd(), ".env.local"),
]);
for (const filePath of envFiles) loadEnvFile(filePath);
loadEnvFile(join(process.cwd(), ".env"));
loadEnvFile(join(process.cwd(), ".env.local"));
