/**
 * Reconcile Vault State Task
 *
 * On GM startup, reconciles the DB vault seq with actual vault files in data_tx.
 * This handles scenarios where:
 * - DB was reset but vault files still exist
 * - GM crashed after writing vault but before updating DB
 * - Manual intervention changed state
 *
 * Strategy:
 * 1. Get current DB vault seq for each vault type
 * 2. Find latest VALID vault file in data_tx
 * 3. If data_tx seq > DB seq, update DB to match
 * 4. Only trust fully validated vaults (decryption + hash verification)
 */

import { db, systemControl } from '@suiftly/database';
import { eq } from 'drizzle-orm';
import { getLatestValidVault, computeContentHash, createVaultReader } from '@mhaxbe/vault-codec';

// Vault types to reconcile
const VAULT_TYPES = ['sma', 'smk', 'smo', 'sta', 'stk', 'sto', 'skk'] as const;
type VaultTypeCode = (typeof VAULT_TYPES)[number];

// Column mapping for vault types in system_control
const VAULT_COLUMNS: Record<VaultTypeCode, { seq: string; hash: string; entries: string }> = {
  sma: { seq: 'smaVaultSeq', hash: 'smaVaultContentHash', entries: 'smaVaultEntries' },
  smk: { seq: 'smkVaultSeq', hash: 'smkVaultContentHash', entries: 'smkVaultEntries' },
  smo: { seq: 'smoVaultSeq', hash: 'smoVaultContentHash', entries: 'smoVaultEntries' },
  sta: { seq: 'staVaultSeq', hash: 'staVaultContentHash', entries: 'staVaultEntries' },
  stk: { seq: 'stkVaultSeq', hash: 'stkVaultContentHash', entries: 'stkVaultEntries' },
  sto: { seq: 'stoVaultSeq', hash: 'stoVaultContentHash', entries: 'stoVaultEntries' },
  skk: { seq: 'skkVaultSeq', hash: 'skkVaultContentHash', entries: 'skkVaultEntries' },
};

interface ReconcileResult {
  vaultType: VaultTypeCode;
  dbSeq: number;
  dataTxSeq: number | null;
  action: 'no_change' | 'updated_db' | 'no_vault_files' | 'error';
  newDbSeq?: number;
  contentHash?: string;
  entries?: number;
  error?: string;
}

/**
 * Reconcile vault state for a specific vault type.
 *
 * @param vaultType - The vault type to reconcile
 * @returns Reconciliation result
 */
async function reconcileVaultType(vaultType: VaultTypeCode): Promise<ReconcileResult> {
  const columns = VAULT_COLUMNS[vaultType];
  const storageDir = '/opt/syncf/data_tx';

  try {
    // 1. Get current DB seq
    const [control] = await db
      .select()
      .from(systemControl)
      .where(eq(systemControl.id, 1))
      .limit(1);

    const dbSeq = (control as any)?.[columns.seq] ?? 0;
    const dbHash = (control as any)?.[columns.hash] ?? null;

    // 2. Find latest valid vault in data_tx
    const latestValid = await getLatestValidVault(vaultType, { storageDir });

    if (!latestValid || !latestValid.parsed) {
      // No valid vault files found
      if (dbSeq > 0) {
        console.log(`[RECONCILE] ${vaultType}: No valid vault files in data_tx, but DB has seq=${dbSeq}`);
        // Don't reset DB - vault files may have been cleaned up intentionally
        // The next sync will generate a new vault
      }
      return {
        vaultType,
        dbSeq,
        dataTxSeq: null,
        action: 'no_vault_files',
      };
    }

    const dataTxSeq = latestValid.parsed.seq;

    // 3. Compare and reconcile
    if (dataTxSeq > dbSeq) {
      // data_tx has newer vault than DB - update DB
      console.log(`[RECONCILE] ${vaultType}: data_tx seq=${dataTxSeq} > DB seq=${dbSeq}, updating DB`);

      // Get content hash and entry count from vault
      let contentHash = latestValid.contentHash;
      let entryCount = 0;

      // Load vault data to compute hash and count entries
      const reader = createVaultReader({ storageDir });
      const vault = await reader.loadBySeq(vaultType, dataTxSeq);
      if (vault) {
        if (!contentHash) {
          contentHash = computeContentHash(vault.data);
        }
        entryCount = Object.keys(vault.data).length;
      }

      // Update DB with seq, hash, and entries
      await db
        .update(systemControl)
        .set({
          [columns.seq]: dataTxSeq,
          [columns.hash]: contentHash ?? dbHash,
          [columns.entries]: entryCount,
          updatedAt: new Date(),
        })
        .where(eq(systemControl.id, 1));

      console.log(`[RECONCILE] ${vaultType}: DB updated to seq=${dataTxSeq}, hash=${contentHash}, entries=${entryCount}`);

      return {
        vaultType,
        dbSeq,
        dataTxSeq,
        action: 'updated_db',
        newDbSeq: dataTxSeq,
        contentHash: contentHash ?? undefined,
        entries: entryCount,
      };
    } else if (dataTxSeq < dbSeq) {
      // DB has higher seq than data_tx - unusual, log warning
      console.warn(`[RECONCILE] ${vaultType}: DB seq=${dbSeq} > data_tx seq=${dataTxSeq} (unexpected)`);
      // Don't change anything - let the next sync generate the missing vault
      return {
        vaultType,
        dbSeq,
        dataTxSeq,
        action: 'no_change',
      };
    } else {
      // Seqs match - verify content hash
      if (latestValid.contentHash && dbHash && latestValid.contentHash !== dbHash) {
        console.warn(
          `[RECONCILE] ${vaultType}: seq matches (${dbSeq}) but hash differs: ` +
            `data_tx=${latestValid.contentHash}, DB=${dbHash}`
        );
        // Update hash to match actual vault content
        await db
          .update(systemControl)
          .set({
            [columns.hash]: latestValid.contentHash,
            updatedAt: new Date(),
          })
          .where(eq(systemControl.id, 1));
      }

      console.log(`[RECONCILE] ${vaultType}: Already in sync (seq=${dbSeq})`);
      return {
        vaultType,
        dbSeq,
        dataTxSeq,
        action: 'no_change',
      };
    }
  } catch (error) {
    console.error(`[RECONCILE] ${vaultType}: Error - ${error instanceof Error ? error.message : String(error)}`);
    return {
      vaultType,
      dbSeq: 0,
      dataTxSeq: null,
      action: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Reconcile all vault types on GM startup.
 *
 * Call this before starting periodic sync to ensure DB and data_tx are in sync.
 */
export async function reconcileVaultState(): Promise<ReconcileResult[]> {
  console.log('[RECONCILE] Starting vault state reconciliation...');

  const results: ReconcileResult[] = [];

  for (const vaultType of VAULT_TYPES) {
    const result = await reconcileVaultType(vaultType);
    results.push(result);
  }

  // Summary log
  const updated = results.filter((r) => r.action === 'updated_db').length;
  const errors = results.filter((r) => r.action === 'error').length;

  console.log(
    `[RECONCILE] Complete: ${results.length} vault types checked, ` +
      `${updated} updated, ${errors} errors`
  );

  return results;
}
