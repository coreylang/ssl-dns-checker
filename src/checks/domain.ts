import type { DomainResult, Level, Target } from "../core/types.js";

const DAY_MS = 86_400_000;
const IANA_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";

/** EPP status codes that mean the domain has already lapsed and is winding down. */
const LAPSED_STATUSES = ["redemption", "pendingdelete", "pending delete", "redemptionperiod"];

export const DOMAIN_THRESHOLDS = [3, 7, 14, 30, 45] as const;

// TLD -> RDAP base URL. Fetched once per process from IANA, then cached.
let bootstrap: Map<string, string> | null = null;
let bootstrapPromise: Promise<Map<string, string>> | null = null;

async function loadBootstrap(): Promise<Map<string, string>> {
  if (bootstrap) return bootstrap;
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const res = await fetch(IANA_BOOTSTRAP);
      if (!res.ok) throw new Error(`IANA bootstrap ${res.status}`);
      const body = (await res.json()) as { services: [string[], string[]][] };
      const map = new Map<string, string>();
      for (const [tlds, urls] of body.services) {
        const base = urls[0]?.replace(/\/$/, "");
        if (!base) continue;
        for (const tld of tlds) map.set(tld.toLowerCase(), base);
      }
      bootstrap = map;
      return map;
    })();
  }
  return bootstrapPromise;
}

function levelForDays(days: number | null, lapsed: boolean): Level {
  if (lapsed) return "critical";
  if (days === null) return "unknown";
  if (days < 0) return "critical";
  if (days <= 14) return "critical";
  if (days <= 45) return "warn";
  return "ok";
}

interface RdapEvent {
  eventAction: string;
  eventDate: string;
}
interface RdapEntity {
  roles?: string[];
  vcardArray?: [string, [string, unknown, string, string][]];
}
interface RdapDomain {
  events?: RdapEvent[];
  status?: string[];
  entities?: RdapEntity[];
}

/**
 * Look up domain registration data via RDAP (structured JSON), not WHOIS
 * (free-form text every registrar formats differently). The sleeper value
 * is `status` — surfacing redemptionPeriod / pendingDelete is more actionable
 * than the expiry date alone, because it means the domain already expired.
 */
export async function checkDomain(target: Target): Promise<DomainResult> {
  const domain = target.domain.toLowerCase();
  const checkedAt = new Date().toISOString();

  const fail = (message: string, level: Level = "unknown"): DomainResult => ({
    kind: "domain",
    level,
    message,
    checkedAt,
    expiry: null,
    daysRemaining: null,
    registrar: null,
    statuses: [],
    source: null,
  });

  let map: Map<string, string>;
  try {
    map = await loadBootstrap();
  } catch (err) {
    return fail(`RDAP bootstrap unavailable: ${(err as Error).message}`);
  }

  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  const base = map.get(tld);
  if (!base) {
    // No RDAP coverage for this TLD (some ccTLDs). A real deployment would
    // fall back to a WHOIS library (e.g. `whoiser`) here.
    return fail(`No RDAP server for .${tld} (WHOIS fallback not configured)`);
  }

  let data: RdapDomain;
  try {
    const res = await fetch(`${base}/domain/${domain}`, {
      headers: { Accept: "application/rdap+json" },
    });
    if (res.status === 404) return fail("Domain not found in registry", "critical");
    if (!res.ok) return fail(`RDAP query ${res.status}`);
    data = (await res.json()) as RdapDomain;
  } catch (err) {
    return fail(`RDAP query failed: ${(err as Error).message}`);
  }

  const expiryRaw = data.events?.find((e) => e.eventAction === "expiration")?.eventDate ?? null;
  const expiry = expiryRaw ? new Date(expiryRaw) : null;
  const daysRemaining = expiry ? Math.floor((expiry.getTime() - Date.now()) / DAY_MS) : null;

  const statuses = data.status ?? [];
  const lapsed = statuses.some((s) =>
    LAPSED_STATUSES.some((bad) => s.toLowerCase().replace(/\s+/g, "").includes(bad.replace(/\s+/g, ""))),
  );

  const registrar =
    data.entities
      ?.find((e) => e.roles?.includes("registrar"))
      ?.vcardArray?.[1]?.find((f) => f[0] === "fn")?.[3] ?? null;

  const level = levelForDays(daysRemaining, lapsed);
  let message: string;
  if (lapsed) message = `Domain lapsed: ${statuses.join(", ")}`;
  else if (daysRemaining === null) message = "No expiry date in registry response";
  else if (daysRemaining < 0) message = `Registration expired ${-daysRemaining}d ago`;
  else message = `Renews in ${daysRemaining}d`;

  return {
    kind: "domain",
    level,
    message,
    checkedAt,
    expiry: expiry?.toISOString() ?? null,
    daysRemaining,
    registrar,
    statuses,
    source: "rdap",
  };
}
