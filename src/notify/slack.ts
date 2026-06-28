import type { Alert } from "../core/types.js";

const EMOJI: Record<string, string> = {
  critical: ":red_circle:",
  warn: ":large_yellow_circle:",
  ok: ":large_green_circle:",
  unknown: ":white_circle:",
};

/**
 * Post fired/resolved alerts to a Slack incoming webhook.
 * No-op when SLACK_WEBHOOK_URL is unset, so local runs stay quiet.
 */
export async function notifySlack(fired: Alert[], resolved: Alert[]): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url || (fired.length === 0 && resolved.length === 0)) return;

  const lines: string[] = [];
  for (const a of fired) {
    lines.push(`${EMOJI[a.level] ?? ""} *${a.label}* — ${a.kind.toUpperCase()}: ${a.message}`);
  }
  for (const a of resolved) {
    lines.push(`:white_check_mark: *${a.label}* — ${a.kind.toUpperCase()} recovered`);
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
    });
    if (!res.ok) console.error(`Slack webhook returned ${res.status}`);
  } catch (err) {
    console.error(`Slack notify failed: ${(err as Error).message}`);
  }
}
