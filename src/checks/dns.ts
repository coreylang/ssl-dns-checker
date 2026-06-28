import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import type {
  DnsRecordSet,
  DnsRecordType,
  DnsResult,
  Level,
  Target,
} from "../core/types.js";

const DEFAULT_TYPES: DnsRecordType[] = ["A", "AAAA", "MX", "NS", "TXT"];

/** Resolve a record type, returning [] on NODATA/NXDOMAIN rather than throwing. */
async function resolveType(
  resolver: Resolver,
  domain: string,
  type: DnsRecordType,
): Promise<string[]> {
  try {
    switch (type) {
      case "A":
        return (await resolver.resolve4(domain)).sort();
      case "AAAA":
        return (await resolver.resolve6(domain)).sort();
      case "NS":
        return (await resolver.resolveNs(domain)).map((s) => s.toLowerCase()).sort();
      case "MX":
        return (await resolver.resolveMx(domain))
          .map((m) => `${m.priority} ${m.exchange.toLowerCase()}`)
          .sort();
      case "TXT":
        return (await resolver.resolveTxt(domain)).map((parts) => parts.join("")).sort();
      case "CNAME":
        return (await resolver.resolveCname(domain)).map((s) => s.toLowerCase()).sort();
      case "SOA": {
        const soa = await resolver.resolveSoa(domain);
        // Exclude the serial: it bumps on every zone edit and would flag drift constantly.
        return [`${soa.nsname} ${soa.hostmaster} refresh=${soa.refresh} ttl=${soa.minttl}`];
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}

function normalize(records: DnsRecordSet): string {
  const keys = Object.keys(records).sort();
  return keys.map((k) => `${k}:${(records[k] ?? []).join("|")}`).join("\n");
}

function hashOf(records: DnsRecordSet): string {
  return createHash("sha256").update(normalize(records)).digest("hex").slice(0, 16);
}

/** Produce human-readable diff lines between two record sets. */
function diff(prev: DnsRecordSet, next: DnsRecordSet): string[] {
  const lines: string[] = [];
  const types = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const type of [...types].sort()) {
    const before = new Set(prev[type] ?? []);
    const after = new Set(next[type] ?? []);
    for (const v of after) if (!before.has(v)) lines.push(`+ ${type} ${v}`);
    for (const v of before) if (!after.has(v)) lines.push(`- ${type} ${v}`);
  }
  return lines;
}

/**
 * Snapshot the record set and compare it to a reference. Two modes:
 *  - against a pinned `dnsBaseline` (catches unannounced prod changes), or
 *  - against the previous observation (catches hijacks and fat-finger edits).
 * Drift is a `warn`, not a `critical`: it's a "look at this", not an outage.
 */
export async function checkDns(
  target: Target,
  previous: DnsResult | null,
): Promise<DnsResult> {
  const checkedAt = new Date().toISOString();
  const types = target.dnsTypes ?? DEFAULT_TYPES;
  const resolver = new Resolver({ timeout: 8000, tries: 2 });

  const records: DnsRecordSet = {};
  await Promise.all(
    types.map(async (t) => {
      const values = await resolveType(resolver, target.domain, t);
      if (values.length) records[t] = values;
    }),
  );

  const recordHash = hashOf(records);
  const hasBaseline = !!target.dnsBaseline && Object.keys(target.dnsBaseline).length > 0;

  let comparedTo: DnsResult["comparedTo"];
  let drift: string[] = [];
  let level: Level = "ok";
  let message: string;

  if (hasBaseline) {
    comparedTo = "baseline";
    drift = diff(target.dnsBaseline as DnsRecordSet, records);
    if (drift.length) {
      level = "warn";
      message = `Drifted from pinned baseline (${drift.length} change${drift.length > 1 ? "s" : ""})`;
    } else {
      message = "Matches pinned baseline";
    }
  } else if (previous && previous.recordHash) {
    comparedTo = "previous";
    if (previous.recordHash !== recordHash) {
      drift = diff(previous.records, records);
      level = "warn";
      message = `Records changed since last check (${drift.length} change${drift.length > 1 ? "s" : ""})`;
    } else {
      message = "Stable since last check";
    }
  } else {
    comparedTo = "first-observation";
    message = `Baseline captured (${Object.keys(records).length} record types)`;
  }

  if (Object.keys(records).length === 0) {
    level = "critical";
    message = "No DNS records resolved";
  }

  return {
    kind: "dns",
    level,
    message,
    checkedAt,
    recordHash,
    records,
    comparedTo,
    drift,
  };
}
