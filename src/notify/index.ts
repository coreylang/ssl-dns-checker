import type { Alert } from "../core/types.js";
import { notifySlack } from "./slack.js";
import { notifyGitHubIssues } from "./githubIssue.js";

const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
};

function colorFor(level: Alert["level"]): string {
  if (level === "critical") return C.red;
  if (level === "warn") return C.yellow;
  return C.green;
}

/** Always print to the run log; fan out to Slack + GitHub when configured. */
export async function notify(fired: Alert[], resolved: Alert[]): Promise<void> {
  for (const a of fired) {
    console.log(`${colorFor(a.level)}● FIRED${C.reset} ${a.label} [${a.kind}] ${a.message}`);
  }
  for (const a of resolved) {
    console.log(`${C.green}● RESOLVED${C.reset} ${a.label} [${a.kind}]`);
  }
  if (fired.length === 0 && resolved.length === 0) {
    console.log(`${C.dim}No alert state changes this run.${C.reset}`);
  }

  await Promise.all([notifySlack(fired, resolved), notifyGitHubIssues(fired, resolved)]);
}
