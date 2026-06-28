import type { Alert } from "../core/types.js";

/**
 * Open a GitHub issue for each newly-fired critical alert, and close it when
 * the matching alert resolves. Uses the Actions-provided GITHUB_TOKEN and
 * GITHUB_REPOSITORY, so it just works inside a workflow with no extra secrets.
 * No-op outside Actions.
 *
 * Issues are de-duplicated by a hidden marker in the body: <!-- vigil:<id> -->.
 */
const API = "https://api.github.com";

function repoInfo(): { owner: string; repo: string } | null {
  const full = process.env.GITHUB_REPOSITORY; // "owner/repo"
  if (!full) return null;
  const [owner, repo] = full.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

async function gh(path: string, init: RequestInit, token: string) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function findIssue(owner: string, repo: string, marker: string, token: string): Promise<number | null> {
  const q = encodeURIComponent(`repo:${owner}/${repo} is:issue label:vigil "${marker}"`);
  const res = await gh(`/search/issues?q=${q}`, { method: "GET" }, token);
  if (!res.ok) return null;
  const body = (await res.json()) as { items?: { number: number }[] };
  return body.items?.[0]?.number ?? null;
}

export async function notifyGitHubIssues(fired: Alert[], resolved: Alert[]): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const info = repoInfo();
  if (!token || !info) return;
  const { owner, repo } = info;

  for (const a of fired) {
    if (a.level !== "critical") continue;
    const marker = `<!-- vigil:${a.id} -->`;
    const existing = await findIssue(owner, repo, marker, token);
    if (existing) continue;
    await gh(
      `/repos/${owner}/${repo}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: `[Vigil] ${a.label}: ${a.kind.toUpperCase()} — ${a.message}`,
          body: `${marker}\nVigil detected a ${a.level} condition.\n\n- **Target:** ${a.label}\n- **Check:** ${a.kind}\n- **Detail:** ${a.message}\n- **Fired:** ${a.firedAt}\n`,
          labels: ["vigil", a.kind],
        }),
      },
      token,
    );
  }

  for (const a of resolved) {
    const marker = `<!-- vigil:${a.id} -->`;
    const number = await findIssue(owner, repo, marker, token);
    if (!number) continue;
    await gh(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: `Recovered at ${a.resolvedAt}. Closing.` }),
    }, token);
    await gh(`/repos/${owner}/${repo}/issues/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    }, token);
  }
}
