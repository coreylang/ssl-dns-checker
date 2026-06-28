import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./core/runner.js";
import { notify } from "./notify/index.js";
import type { AlertsFile, StatusFile, Target } from "./core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CONFIG = resolve(ROOT, "config/targets.json");
const STATUS = resolve(ROOT, "data/status.json");
const ALERTS = resolve(ROOT, "data/alerts.json");
const HISTORY_DIR = resolve(ROOT, "data/history");

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    console.error(`Could not parse ${path}: ${(err as Error).message}`);
    return fallback;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function main() {
  const config = await readJson<{ targets: Target[] }>(CONFIG, { targets: [] });
  if (config.targets.length === 0) {
    console.error("No targets in config/targets.json — nothing to do.");
    process.exit(1);
  }

  // Optional single-target filter: `npm run check -- --target <id>`
  const idx = process.argv.indexOf("--target");
  const only = idx !== -1 ? process.argv[idx + 1] : null;
  const targets = only ? config.targets.filter((t) => t.id === only) : config.targets;
  if (only && targets.length === 0) {
    console.error(`No target with id "${only}".`);
    process.exit(1);
  }

  const priorStatus = await readJson<StatusFile | null>(STATUS, null);
  const priorAlerts = await readJson<AlertsFile>(ALERTS, { schema: 1, alerts: [] });

  console.log(`Vigil: checking ${targets.length} target${targets.length > 1 ? "s" : ""}…`);
  const { status, alerts, fired, resolved } = await run(targets, priorStatus, priorAlerts);

  await writeJson(STATUS, status);
  await writeJson(ALERTS, alerts);

  // Append a compact history snapshot (one file per UTC day; last run wins).
  const day = status.generatedAt.slice(0, 10);
  await writeJson(resolve(HISTORY_DIR, `${day}.json`), {
    generatedAt: status.generatedAt,
    summary: status.summary,
    targets: status.targets.map((t) => ({
      id: t.id,
      worst: t.worst,
      ssl: t.ssl?.daysRemaining ?? null,
      domain: t.domain_?.daysRemaining ?? null,
      dns: t.dns?.level ?? null,
    })),
  });

  await notify(fired, resolved);

  const { critical, warn, ok, unknown } = status.summary;
  console.log(
    `Done in ${status.durationMs}ms — ${critical} critical, ${warn} warning, ${ok} ok, ${unknown} unknown.`,
  );

  // Exit non-zero when something is critical so the workflow badge can reflect it.
  if (critical > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
