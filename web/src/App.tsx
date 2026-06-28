import { useEffect, useMemo, useState } from "react";
import type {
  DnsResult,
  DomainResult,
  Level,
  SslResult,
  StatusFile,
  TargetStatus,
} from "./types.ts";

const DATA_URL = `${import.meta.env.BASE_URL}data/status.json`;

// Threshold ticks the runway bar is marked against (days). Domain uses a wider
// runway because registrations are renewed on a yearly cadence.
const SSL_TICKS = [30, 14, 7, 3, 1];
const DOMAIN_TICKS = [60, 30, 14, 7, 1];
const RUNWAY_MAX = { ssl: 45, domain: 90 } as const;

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function App() {
  const [status, setStatus] = useState<StatusFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(DATA_URL, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`status.json returned ${r.status}`);
        return r.json();
      })
      .then((d: StatusFile) => alive && setStatus(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  const sorted = useMemo(() => {
    if (!status) return [];
    const rank: Record<Level, number> = { critical: 0, warn: 1, unknown: 2, ok: 3 };
    return [...status.targets].sort((a, b) => rank[a.worst] - rank[b.worst]);
  }, [status]);

  if (error) {
    return (
      <Shell>
        <div className="empty">
          <h2>No data yet</h2>
          <p>
            Couldn't load <code>{DATA_URL}</code> ({error}). The dashboard reads
            results the GitHub Action commits to <code>data/status.json</code>.
            Once the workflow has run once, this fills in.
          </p>
        </div>
      </Shell>
    );
  }

  if (!status) {
    return (
      <Shell>
        <div className="empty">
          <p className="loading">Loading watch data…</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell summary={status} sorted={sorted}>
      <div className="grid">
        {sorted.map((t) => (
          <TargetCard key={t.id} target={t} />
        ))}
      </div>
    </Shell>
  );
}

function Shell({
  children,
  summary,
  sorted,
}: {
  children: React.ReactNode;
  summary?: StatusFile;
  sorted?: TargetStatus[];
}) {
  const total = sorted?.length ?? 0;
  return (
    <div className="page">
      <header className="masthead">
        <div className="brand">
          <span className="mark" aria-hidden />
          <div>
            <h1>Vigil</h1>
            <p className="tagline">SSL · domain · DNS expiry watch</p>
          </div>
        </div>
        {summary && (
          <div className="summary" role="status">
            <Stat n={summary.summary.critical} label="critical" tone="critical" />
            <Stat n={summary.summary.warn} label="warning" tone="warn" />
            <Stat n={summary.summary.ok} label="clear" tone="ok" />
            <div className="ran">
              <span className="ran-count">{total} watched</span>
              <span className="ran-time">checked {relativeTime(summary.generatedAt)}</span>
            </div>
          </div>
        )}
      </header>
      <main>{children}</main>
      <footer className="footer">
        <span>
          Checks run in GitHub Actions; this page is static on GitHub Pages.
        </span>
        {summary && <span className="mono">run {summary.durationMs}ms</span>}
      </footer>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: Level }) {
  return (
    <div className={`stat stat--${tone} ${n === 0 ? "stat--zero" : ""}`}>
      <span className="stat-n">{n}</span>
      <span className="stat-l">{label}</span>
    </div>
  );
}

function TargetCard({ target }: { target: TargetStatus }) {
  return (
    <article className={`card card--${target.worst}`}>
      <div className="card-head">
        <h2>{target.label}</h2>
        <code className="domain">{target.domain}</code>
      </div>
      <div className="lanes">
        {target.ssl && <SslLane r={target.ssl} />}
        {target.domain_ && <DomainLane r={target.domain_} />}
        {target.dns && <DnsLane r={target.dns} />}
      </div>
    </article>
  );
}

/** The signature device: a depleting runway with threshold ticks. */
function Runway({
  days,
  max,
  ticks,
  level,
}: {
  days: number | null;
  max: number;
  ticks: number[];
  level: Level;
}) {
  const pct = days === null ? 0 : Math.max(0, Math.min(1, days / max));
  return (
    <div className="runway" aria-hidden>
      <div className={`runway-fill runway-fill--${level}`} style={{ width: `${pct * 100}%` }} />
      {ticks.map((t) => (
        <span key={t} className="tick" style={{ left: `${Math.min(100, (t / max) * 100)}%` }}>
          <span className="tick-label">{t}</span>
        </span>
      ))}
    </div>
  );
}

function Countdown({ days, level }: { days: number | null; level: Level }) {
  if (days === null) return <span className={`days days--${level}`}>—</span>;
  if (days < 0)
    return (
      <span className={`days days--critical`}>
        {Math.abs(days)}
        <span className="days-unit">d ago</span>
      </span>
    );
  return (
    <span className={`days days--${level}`}>
      {days}
      <span className="days-unit">d</span>
    </span>
  );
}

function SslLane({ r }: { r: SslResult }) {
  return (
    <section className={`lane lane--${r.level}`}>
      <div className="lane-top">
        <span className="lane-name">TLS certificate</span>
        <Countdown days={r.daysRemaining} level={r.level} />
      </div>
      <Runway days={r.daysRemaining} max={RUNWAY_MAX.ssl} ticks={SSL_TICKS} level={r.level} />
      <p className="lane-msg">{r.message}</p>
      <dl className="meta">
        <div>
          <dt>issuer</dt>
          <dd className="mono">{r.issuer ?? "—"}</dd>
        </div>
        <div>
          <dt>chain</dt>
          <dd className={`mono ${r.authorized ? "" : "bad"}`}>
            {r.authorized ? "verified" : "unverified"}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function DomainLane({ r }: { r: DomainResult }) {
  const lapsed = r.statuses.some((s) => /redemption|pending\s*delete/i.test(s));
  return (
    <section className={`lane lane--${r.level}`}>
      <div className="lane-top">
        <span className="lane-name">Registration</span>
        <Countdown days={r.daysRemaining} level={r.level} />
      </div>
      <Runway days={r.daysRemaining} max={RUNWAY_MAX.domain} ticks={DOMAIN_TICKS} level={r.level} />
      <p className="lane-msg">{r.message}</p>
      <dl className="meta">
        <div>
          <dt>registrar</dt>
          <dd className="mono">{r.registrar ?? "—"}</dd>
        </div>
      </dl>
      {lapsed && (
        <div className="codes codes--bad">
          {r.statuses
            .filter((s) => /redemption|pending\s*delete/i.test(s))
            .map((s) => (
              <span key={s} className="mono code">
                {s}
              </span>
            ))}
        </div>
      )}
    </section>
  );
}

function DnsLane({ r }: { r: DnsResult }) {
  return (
    <section className={`lane lane--${r.level} lane--dns`}>
      <div className="lane-top">
        <span className="lane-name">DNS records</span>
        <span className={`pill pill--${r.level}`}>
          {r.drift.length > 0 ? `${r.drift.length} changed` : r.level === "critical" ? "no records" : "stable"}
        </span>
      </div>
      <p className="lane-msg">{r.message}</p>
      {r.drift.length > 0 ? (
        <pre className="diff mono">
          {r.drift.map((line) => (
            <span key={line} className={line.startsWith("+") ? "add" : "del"}>
              {line}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : (
        <div className="recordset">
          {Object.entries(r.records).map(([type, vals]) => (
            <div key={type} className="recordrow">
              <span className="rtype mono">{type}</span>
              <span className="rvals mono">{vals.join(" · ")}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export { App };
