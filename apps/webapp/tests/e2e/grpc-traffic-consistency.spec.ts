/**
 * End-to-end smoke for the T-menu → HAProxy → fluentd → DB → UI chain.
 * One scenario (10 unary requests); unit tests cover edge cases.
 */

import { test, expect } from '@playwright/test';
import {
  resetCustomer,
  ensureTestBalance,
  subscribePlatformService,
  getRecentHaproxyLogs,
} from '../helpers/db';
import { waitForToastsToDisappear } from '../helpers/locators';
import { waitAfterMutation } from '../helpers/wait-utils';

// Retry the T-menu click until the HAProxy customer map has synced.
async function fireRealTrafficUntilBillable(
  page: any,
  request: any,
  requestsButtonText: string,
  expectedCount: number,
  deadlineMs: number,
): Promise<{ sinceTs: string; logs: any[] }> {
  // -3s covers HAProxy's second-precision log timestamps vs our ISO-ms clock.
  const sinceTs = new Date(Date.now() - 3_000).toISOString();
  const deadline = Date.now() + deadlineMs;

  while (Date.now() < deadline) {
    await page.locator('button[title="Test data menu"]').click();
    await page.locator(`button:has-text("${requestsButtonText}")`).click();
    await page.locator(`text=/Real traffic: ${expectedCount}\\/${expectedCount} requests/`)
      .waitFor({ timeout: 30_000 });

    const pollUntil = Math.min(Date.now() + 18_000, deadline);
    while (Date.now() < pollUntil) {
      const logs = await getRecentHaproxyLogs(request, { since: sinceTs, limit: 200 });
      const billable = logs.filter((l: any) => l.trafficType === 1 || l.trafficType === 2);
      const requestsLanded = billable.reduce((s: number, l: any) => s + l.repeat, 0);
      if (requestsLanded >= expectedCount) {
        return { sinceTs, logs };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    await waitForToastsToDisappear(page);
  }
  throw new Error(`Never saw ${expectedCount} billable rows after repeated T-menu attempts`);
}

test.describe('gRPC real-traffic E2E consistency', () => {
  test.beforeEach(async ({ page, request }) => {
    test.setTimeout(240_000); // real HTTP + vault sync + fluentd + aggregate refresh

    await resetCustomer(request);
    await ensureTestBalance(request, 50);

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    await subscribePlatformService(page);
    await waitForToastsToDisappear(page);

    // Enable gRPC via the UI toggle. waitForVaultUpdate only tracks the
    // SMA vault, so the retry loop in fireRealTrafficUntilBillable is
    // what actually waits for HAProxy's map to catch up.
    await page.goto('/services/grpc/overview');
    await page.waitForLoadState('networkidle');
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);
    await expect(page.locator('#service-toggle'))
      .toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
    await waitForToastsToDisappear(page);
  });

  test('10 unary requests: UI "Successful (2xx)" = 10, no tt=7 rows, "<0.001 GB"', async ({ page, request }) => {
    await page.goto('/services/grpc/stats');
    await page.waitForLoadState('networkidle');

    // Phase 1: "warm up" — retry the T-menu click until we see that
    // HAProxy's customer map has caught up (first billable rows land).
    // This leaves denial rows in the DB from the vault-sync-pending
    // attempts; we wipe them in phase 2.
    await fireRealTrafficUntilBillable(page, request, '10 Requests', 10, 90_000);

    // Phase 2: wipe the pending denials + any successful warm-up traffic,
    // then fire ONE authoritative batch of 10 so the UI count is exactly
    // what this test is validating.
    await page.locator('button[title="Test data menu"]').click();
    await page.locator('button:has-text("Clear All")').click();
    await waitForToastsToDisappear(page);
    await page.waitForTimeout(2_000);

    const cleanSince = new Date(Date.now() - 3_000).toISOString();
    await page.locator('button[title="Test data menu"]').click();
    await page.locator('button:has-text("10 Requests")').click();
    await page.locator('text=/Real traffic: 10\\/10 requests/').waitFor({ timeout: 30_000 });

    // Wait for the 10 billable rows to land.
    const deadline = Date.now() + 30_000;
    let finalLogs: Awaited<ReturnType<typeof getRecentHaproxyLogs>> = [];
    while (Date.now() < deadline) {
      finalLogs = await getRecentHaproxyLogs(request, { since: cleanSince, limit: 100 });
      const billable = finalLogs.filter((l) => l.trafficType === 1 || l.trafficType === 2);
      const requestsLanded = billable.reduce((s, l) => s + l.repeat, 0);
      if (requestsLanded >= 10) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Force-refresh the continuous aggregates so the UI's tRPC queries see
    // the just-landed rows (policy refresh would take minutes otherwise).
    await page.locator('button[title="Test data menu"]').click();
    await page.locator('button:has-text("Force Sync Stats")').click();
    await waitForToastsToDisappear(page);
    await page.waitForTimeout(2_000);
    const perTT = new Map<number, { rows: number; requests: number; bytes: number }>();
    for (const l of finalLogs) {
      const cur = perTT.get(l.trafficType) ?? { rows: 0, requests: 0, bytes: 0 };
      cur.rows += 1;
      cur.requests += l.repeat;
      cur.bytes += l.bytesSent;
      perTT.set(l.trafficType, cur);
    }
    expect(perTT.get(1)?.requests ?? 0).toBe(10);
    expect(
      perTT.has(7),
      'fix B: unary traffic must NOT produce tt=7 poller rows (stick-table tracking gated on streaming path)',
    ).toBe(false);
    expect(
      perTT.has(8),
      'retag must fire only for streaming paths; unary close-logs stay tt=1',
    ).toBe(false);

    // ── UI: "Successful (2xx)" card shows exactly 10 — locks fix A ──────
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Card value format: "10 (>99%)". The leading "10 (>" is distinctive
    // enough to rule out the label's own parens ("Successful (2xx)").
    const successCard = page.locator('text=Successful (2xx)').locator('..');
    await expect(successCard).toContainText('10 (>', { timeout: 15_000 });

    // ── UI: "Usage This Month" on overview — locks fix A + C ────────────
    await page.goto('/services/grpc/overview');
    await page.waitForLoadState('networkidle');

    // Fix A propagated through billing: "10 requests @ $0.0001/req".
    await expect(page.locator('text=/10 requests @ \\$/'))
      .toBeVisible({ timeout: 15_000 });

    // Fix C: trace usage ("<0.001 GB") not indistinguishable from zero
    // ("0.000 GB"). The "<" prefix is the whole point of the fix.
    await expect(page.locator('text=/<0\\.001 GB @ \\$/'))
      .toBeVisible({ timeout: 15_000 });
  });
});
