# Vigil

**An SSL, domain, and DNS expiry watch that runs entirely on GitHub.** No server, no database, no hosting bill. GitHub Actions runs the checks on a schedule; the results are committed back to the repo; a static dashboard is published to GitHub Pages.

Where [Beacon](https://github.com/) answers *"is it up right now,"* Vigil answers *"is something about to lapse on me in three weeks."* It watches three slow-moving failures that active probes structurally miss:

- **TLS certificate expiry** — and the separate case of a cert with valid dates whose chain won't verify.
- **Domain registration expiry** — via RDAP, surfacing EPP status codes like `redemptionPeriod` that mean the domain *already lapsed*.
- **DNS drift** — record-set changes against either the previous observation or a pinned baseline.

---

## Can this really run on GitHub Pages?

Short answer: **the dashboard does; the checks can't, and don't need to.**

GitHub Pages serves static files only — no Node process, no sockets, no scheduler. The checks are inherently backend work: a browser cannot open a raw `tls.connect()` to inspect a certificate, and RDAP servers will mostly CORS-block a browser. So Vigil splits along that line:

```
            ┌──────────────────────────────────────────────────────┐
            │                   GitHub Actions                      │
            │  (cron: every 6h)                                     │
            │                                                       │
            │   src/run.ts ──► TLS probe ─┐                         │
            │                  RDAP lookup ┼─► data/status.json     │
            │                  DNS snapshot┘    data/alerts.json    │
            │                                   data/history/*.json │
            │                       │                               │
            │            commit back to repo (persistence)          │
            │                       │                               │
            │            notify: Slack / GitHub issues              │
            └───────────────────────┼───────────────────────────────┘
                                    │ artifact
            ┌───────────────────────▼───────────────────────────────┐
            │                   GitHub Pages                         │
            │   web/ (React + Vite) reads data/status.json           │
            │   → static dashboard, no backend                       │
            └────────────────────────────────────────────────────────┘
```

- **Actions is the scheduler and the backend.** It has Node, outbound network, TLS, and DNS — everything the checks need.
- **Committed JSON is the database.** Results are committed back to `main`, which gives free cross-run persistence (the alert state machine needs it) and a git-based audit log of every change.
- **Pages is the dashboard.** A static React app reads the JSON. This part genuinely runs on Pages.

The check *core* in `src/checks/` is plain, dependency-free TypeScript. If you ever want the always-on, server-hosted version, the same `lib` drops straight into a Node/Express service.

---

## Setup

1. **Use this repo** (fork or "Use this template").

2. **Edit `config/targets.json`** with what you want to watch:

   ```json
   {
     "targets": [
       {
         "id": "my-site",
         "label": "My Site",
         "domain": "example.com",
         "checks": { "ssl": true, "domain": true, "dns": true }
       }
     ]
   }
   ```

3. **Enable Pages:** repo **Settings → Pages → Source → GitHub Actions**.

4. **Run it:** the **monitor** workflow runs on a 6-hour cron, or trigger it now from the **Actions** tab → *monitor* → *Run workflow*. The first run replaces the sample data and publishes your dashboard to `https://<you>.github.io/<repo>/`.

No secrets are required. The dashboard works with the sample data in `data/` until the first real run.

### Optional notifications

| Secret | Effect |
| --- | --- |
| `SLACK_WEBHOOK_URL` | Posts fired/recovered alerts to a Slack incoming webhook. |
| *(none needed)* | The built-in `GITHUB_TOKEN` lets Vigil open a GitHub issue per critical alert and close it on recovery. |

Set secrets under **Settings → Secrets and variables → Actions**.

---

## Configuration reference

Each target in `config/targets.json`:

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Stable slug, unique across the config. Used as the key in results and alerts. |
| `label` | yes | Display name in the dashboard. |
| `domain` | yes | Registrable domain (used for domain + DNS checks). |
| `sslHost` | no | Host for the TLS connection. Defaults to `domain`. |
| `port` | no | TLS port. Defaults to `443`. |
| `checks` | no | `{ ssl, domain, dns }` toggles. Each defaults to `true`. |
| `dnsTypes` | no | Record types to snapshot. Defaults to `["A","AAAA","MX","NS","TXT"]`. |
| `dnsBaseline` | no | Pinned record set. When present, drift is measured against it instead of the previous observation. |

### A note on DNS drift and CDNs

Domains behind a CDN or round-robin DNS (Cloudflare, Fastly, GitHub Pages itself) return a **rotating set of A/AAAA records per query**, so naive drift detection on those types is noisy by design. For CDN-fronted hosts, scope `dnsTypes` to the stable records:

```json
{ "id": "cdn-site", "label": "CDN Site", "domain": "example.com",
  "dnsTypes": ["NS", "MX", "SOA"] }
```

`NS`, `MX`, and `SOA` (with the serial excluded) are the ones where a change is genuinely meaningful — a hijack, a registrar move, or a misconfigured zone.

---

## Alert behavior

Alerts fire **once per threshold crossing**, not once per run. Each `(target, kind, threshold)` is a row in a small state machine:

- TLS thresholds: 30 / 14 / 7 / 3 days remaining.
- Domain thresholds: 45 / 30 / 14 / 7 / 3 days remaining.
- State alerts (expired, lapsed, chain-invalid, no-records, DNS drift) fire immediately.

Crossing 30 → 14 → 7 sends one notification each, not a daily reminder for three weeks. A renewal that pushes expiry back out **auto-resolves** the open alerts and sends a recovery. This mirrors Beacon's incident reconciliation: don't re-page for an ongoing condition.

---

## Local development

```bash
# Engine — run the checks against your config, writing to data/
npm install
npm run check                 # all targets
npm run check -- --target id  # one target

# Dashboard
cd web
npm install
cp -r ../data public/data     # let the dashboard read local results
npm run dev
```

`npm run typecheck` at the root type-checks the engine.

---

## Project layout

```
config/targets.json      what to watch
src/
  checks/                ssl.ts · domain.ts · dns.ts  (the dependency-free core)
  core/
    types.ts             shared contract (also the dashboard's data shapes)
    alerts.ts            the threshold state machine
    runner.ts            orchestrates a run + aggregation
  notify/                console · slack · github issues
  run.ts                 CLI entrypoint the Action calls
web/                     React + Vite dashboard (deploys to Pages)
data/                    generated results, committed by the Action
.github/workflows/
  monitor.yml            cron checks + Pages deploy
```

## License

MIT
