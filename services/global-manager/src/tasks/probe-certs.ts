// Cert probe worker.
// Opens a TLS connection to each (FQDN, proxy IP) pair, parses the served
// certificate, and stores the result in-process AND in the cert_probe_state
// table. The DB persistence is what lets the streak counter survive GM
// restarts, so a cert that's been failing for 23 hours doesn't reset to 0.
//
// Cadence is intentionally a single constant so it can be bumped from 60s
// (debugging) to 3600s (steady state) in one place.

import * as tls from 'node:tls';
import { db, certProbeState } from '@suiftly/database';
import { CERT_TARGETS, type CertTarget } from '../config/cert-targets.js';

export const CERT_PROBE_INTERVAL_MS = 3_600_000;

// Wait this long after startup before the first probe cycle, so rapid
// process restarts don't hammer the network or the proxies.
const STARTUP_DELAY_MS = 60_000;

const TIMEOUT_MS = 10_000;
// A cert with <= this many days left counts as a "problem to investigate" —
// renewal should have already happened by now. Status is intentionally binary
// (green/red) to avoid a third "expiring" bucket; every cert is always
// expiring eventually, only "renewal hasn't happened in time" is actionable.
const RENEWAL_OVERDUE_THRESHOLD_DAYS = 14;
// A red probe must repeat for more than this many consecutive cycles before
// the rollup status flips to red. At 1-cycle = 1-hour cadence this gives a
// full day of grace for transient proxy/network blips before alerting.
// Counter is persisted to cert_probe_state so it survives GM restart.
const FAILURE_STREAK_THRESHOLD = 24;

export type ProbeStatus = 'green' | 'red' | 'gray';

export interface ProbeResult {
  fqdn: string;
  port: number;
  pipeline: 'A' | 'B' | 'C';
  provider: string;
  // Stable identifier matching the configured proxy entry — the configured IP
  // for pinned probes, empty string for DNS-resolved (Cloudflare). Used as
  // both the in-memory cache key component and the DB primary-key component.
  ip: string;
  // Peer address observed at TLS handshake (informational; useful for
  // Cloudflare Anycast where DNS rotates). Not persisted — refilled on the
  // next probe — so it can be null after a GM restart until the next cycle.
  peerIp: string | null;
  resolvedFromDns: boolean;
  // Effective status — fed to the rollup and the dashboard tile. Stays green
  // until rawStatus has been red for more than FAILURE_STREAK_THRESHOLD
  // consecutive cycles, to suppress flaky network/proxy blips.
  status: ProbeStatus;
  // What the most recent probe actually saw (independent of the streak gate).
  rawStatus: ProbeStatus;
  // Number of consecutive cycles where rawStatus was red. Reset to 0 on the
  // first green probe. In-memory only — GM restart starts the counter over.
  consecutiveFailures: number;
  reason: string;
  notAfter: string | null;
  notBefore: string | null;
  daysUntilExpiry: number | null;
  issuer: string | null;
  subject: string | null;
  altNames: string[];
  probedAt: string;
}

export interface ProbeListResponse {
  probedAt: string | null;
  intervalMs: number;
  rollupStatus: ProbeStatus;
  results: ProbeResult[];
}

const resultsByKey = new Map<string, ProbeResult>();
let lastRunAt: string | null = null;
let probeTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
const inflight = new Map<string, Promise<ProbeResult>>();

function key(fqdn: string, provider: string, ip: string | undefined, port: number): string {
  return `${fqdn}|${provider}|${ip ?? ''}|${port}`;
}

function rowToResult(row: typeof certProbeState.$inferSelect): ProbeResult {
  return {
    fqdn: row.fqdn,
    port: row.port,
    pipeline: row.pipeline as 'A' | 'B' | 'C',
    provider: row.provider,
    ip: row.ip,
    peerIp: null,
    resolvedFromDns: row.resolvedFromDns,
    status: row.status as ProbeStatus,
    rawStatus: row.rawStatus as ProbeStatus,
    consecutiveFailures: row.consecutiveFailures,
    reason: row.reason,
    notAfter: row.notAfter ? row.notAfter.toISOString() : null,
    notBefore: row.notBefore ? row.notBefore.toISOString() : null,
    daysUntilExpiry: row.daysUntilExpiry,
    issuer: row.issuer,
    subject: row.subject,
    altNames: row.altNames ?? [],
    probedAt: row.probedAt.toISOString(),
  };
}

async function loadFromDb(): Promise<void> {
  const rows = await db.select().from(certProbeState);
  for (const row of rows) {
    resultsByKey.set(key(row.fqdn, row.provider, row.ip, row.port), rowToResult(row));
  }
  if (rows.length > 0) {
    const newest = rows.reduce((max, r) => (r.probedAt > max ? r.probedAt : max), rows[0].probedAt);
    lastRunAt = newest.toISOString();
  }
}

async function persistResult(r: ProbeResult): Promise<void> {
  const values = {
    fqdn: r.fqdn,
    provider: r.provider,
    ip: r.ip,
    port: r.port,
    pipeline: r.pipeline,
    status: r.status,
    rawStatus: r.rawStatus,
    consecutiveFailures: r.consecutiveFailures,
    reason: r.reason,
    resolvedFromDns: r.resolvedFromDns,
    notAfter: r.notAfter ? new Date(r.notAfter) : null,
    notBefore: r.notBefore ? new Date(r.notBefore) : null,
    daysUntilExpiry: r.daysUntilExpiry,
    issuer: r.issuer,
    subject: r.subject,
    altNames: r.altNames,
    probedAt: new Date(r.probedAt),
  };
  await db.insert(certProbeState).values(values).onConflictDoUpdate({
    target: [certProbeState.fqdn, certProbeState.provider, certProbeState.ip, certProbeState.port],
    set: { ...values, updatedAt: new Date() },
  });
}

function rollup(rs: ProbeResult[]): ProbeStatus {
  if (rs.length === 0) return 'gray';
  if (rs.some(r => r.status === 'red')) return 'red';
  if (rs.every(r => r.status === 'green')) return 'green';
  return 'gray';
}

function parseSAN(san: string | undefined): string[] {
  if (!san) return [];
  return san.split(',').map(s => s.trim().replace(/^DNS:/, '')).filter(Boolean);
}

function matchesFqdn(fqdn: string, altNames: string[], cn: string | undefined): boolean {
  const fqdnLc = fqdn.toLowerCase();
  if (cn?.toLowerCase() === fqdnLc) return true;
  for (const an of altNames) {
    const lc = an.toLowerCase();
    if (lc === fqdnLc) return true;
    if (lc.startsWith('*.')) {
      const suffix = lc.slice(1);
      if (fqdnLc.endsWith(suffix) && fqdnLc.split('.').length === lc.split('.').length) {
        return true;
      }
    }
  }
  return false;
}

function formatDN(dn: Record<string, string | string[]> | undefined): string | null {
  if (!dn) return null;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(dn)) {
    parts.push(`${k}=${Array.isArray(v) ? v.join(',') : v}`);
  }
  return parts.join(', ');
}

type RawProbe = Pick<ProbeResult,
  'rawStatus' | 'reason' | 'notAfter' | 'notBefore' | 'daysUntilExpiry' |
  'issuer' | 'subject' | 'altNames'
>;

function probeOne(target: CertTarget, proxy: { provider: string; ip?: string }): Promise<ProbeResult> {
  const k = key(target.fqdn, proxy.provider, proxy.ip, target.port);
  const existing = inflight.get(k);
  if (existing) return existing;

  const resolvedFromDns = !proxy.ip;
  const connectHost = proxy.ip ?? target.fqdn;

  const promise = new Promise<ProbeResult>((resolve) => {
    const probedAt = new Date().toISOString();
    const base = {
      fqdn: target.fqdn,
      port: target.port,
      pipeline: target.pipeline,
      provider: proxy.provider,
      ip: proxy.ip ?? '',
      peerIp: null as string | null,
      resolvedFromDns,
      probedAt,
    };
    const fail = (reason: string): RawProbe => ({
      rawStatus: 'red',
      reason,
      notAfter: null,
      notBefore: null,
      daysUntilExpiry: null,
      issuer: null,
      subject: null,
      altNames: [],
    });

    const socket = tls.connect({
      host: connectHost,
      port: target.port,
      servername: target.fqdn,
      rejectUnauthorized: false,
      timeout: TIMEOUT_MS,
    });

    let resolved = false;
    const finish = (raw: RawProbe) => {
      if (resolved) return;
      resolved = true;
      socket.removeAllListeners();
      socket.destroy();
      const prevFailures = resultsByKey.get(k)?.consecutiveFailures ?? 0;
      const consecutiveFailures = raw.rawStatus === 'red' ? prevFailures + 1 : 0;
      const status: ProbeStatus =
        raw.rawStatus === 'red' && consecutiveFailures <= FAILURE_STREAK_THRESHOLD
          ? 'green'
          : raw.rawStatus;
      const result: ProbeResult = { ...base, ...raw, status, consecutiveFailures };
      resultsByKey.set(k, result);
      // Persist asynchronously; don't block resolution on the DB write. A
      // failed write logs but doesn't take down the probe — the in-memory
      // cache still works for the rest of this process's lifetime.
      persistResult(result).catch(err => {
        console.error('[probe-certs] persistResult failed:', err);
      });
      resolve(result);
    };

    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(true);
      if (!cert || Object.keys(cert).length === 0) {
        finish(fail('No certificate returned'));
        return;
      }
      if (resolvedFromDns && socket.remoteAddress) {
        base.peerIp = socket.remoteAddress;
      }

      const notAfter = new Date(cert.valid_to);
      const notBefore = new Date(cert.valid_from);
      const now = new Date();
      const daysUntilExpiry = Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000);
      const altNames = parseSAN((cert as { subjectaltname?: string }).subjectaltname);
      const subjectCN = (cert.subject as { CN?: string } | undefined)?.CN;
      const subjectMatches = matchesFqdn(target.fqdn, altNames, subjectCN);

      let rawStatus: ProbeStatus;
      let reason: string;
      if (notAfter <= now) {
        rawStatus = 'red';
        reason = `Expired ${-daysUntilExpiry}d ago`;
      } else if (notBefore > now) {
        rawStatus = 'red';
        reason = 'Not yet valid';
      } else if (!subjectMatches) {
        rawStatus = 'red';
        reason = `SAN mismatch (got ${altNames.join(', ') || subjectCN || 'unknown'})`;
      } else if (daysUntilExpiry <= RENEWAL_OVERDUE_THRESHOLD_DAYS) {
        rawStatus = 'red';
        reason = `Renewal overdue — ${daysUntilExpiry}d left`;
      } else {
        rawStatus = 'green';
        reason = `OK, ${daysUntilExpiry}d left`;
      }

      finish({
        rawStatus,
        reason,
        notAfter: notAfter.toISOString(),
        notBefore: notBefore.toISOString(),
        daysUntilExpiry,
        issuer: formatDN(cert.issuer as unknown as Record<string, string | string[]> | undefined),
        subject: formatDN(cert.subject as unknown as Record<string, string | string[]> | undefined),
        altNames,
      });
    });

    socket.once('timeout', () => finish(fail(`Timeout after ${TIMEOUT_MS}ms`)));
    socket.once('error', (err) => finish(fail(`Connection error: ${err.message}`)));
  }).finally(() => {
    inflight.delete(k);
  });

  inflight.set(k, promise);
  return promise;
}

function allTargets(): { target: CertTarget; proxy: { provider: string; ip?: string } }[] {
  return CERT_TARGETS.flatMap(t => t.proxies.map(p => ({ target: t, proxy: p })));
}

export async function runProbeCycle(): Promise<void> {
  const work = allTargets();
  await Promise.all(work.map(({ target, proxy }) => probeOne(target, proxy)));
  lastRunAt = new Date().toISOString();
}

export async function probeFqdn(fqdn: string): Promise<ProbeResult[]> {
  const target = CERT_TARGETS.find(t => t.fqdn === fqdn);
  if (!target) return [];
  const results = await Promise.all(target.proxies.map(p => probeOne(target, p)));
  lastRunAt = new Date().toISOString();
  return results;
}

export function getProbeResults(): ProbeListResponse {
  const results = allTargets()
    .map(({ target, proxy }) => resultsByKey.get(key(target.fqdn, proxy.provider, proxy.ip, target.port)))
    .filter((r): r is ProbeResult => r !== undefined);
  return {
    probedAt: lastRunAt,
    intervalMs: CERT_PROBE_INTERVAL_MS,
    rollupStatus: rollup(results),
    results,
  };
}

export async function startCertProbing(): Promise<void> {
  if (probeTimer || startupTimeout) return;
  // Hydrate the in-memory cache from the DB so the page shows last-known
  // state immediately AND the streak counter resumes from where it was at
  // shutdown. A 23-cycle failure streak doesn't reset to 0.
  try {
    await loadFromDb();
  } catch (err) {
    console.error('[probe-certs] loadFromDb failed (continuing with empty cache):', err);
  }
  // Initial cycle is delayed by STARTUP_DELAY_MS so a process that bounces
  // (crash loop, rolling restart) doesn't probe on every boot. The recurring
  // timer only starts after that first cycle so the cadence stays predictable.
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runProbeCycle();
    probeTimer = setInterval(() => void runProbeCycle(), CERT_PROBE_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

export function stopCertProbing(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}
