// TRAP 2: TON seqno race condition guard.
// TON produces blocks every ~5s. Two TXs submitted within the same block window
// both call wo.getSeqno() and get the SAME seqno → second TX is rejected silently.
// Solution: local counter that increments immediately without waiting for chain confirmation.
// Syncs from chain every 30s to handle restarts or external sends.

type HasSeqno = { getSeqno(): Promise<number> };

let _localSeqno: number | null = null;
let _lastSyncTs = 0;
const SYNC_INTERVAL_MS = 30_000;

export async function getNextSecureSeqno(wallet: HasSeqno): Promise<number> {
  const now = Date.now();
  if (_localSeqno === null || now - _lastSyncTs > SYNC_INTERVAL_MS) {
    _localSeqno = await wallet.getSeqno();
    _lastSyncTs = now;
    console.debug(`[ton-seqno] Synced from chain: seqno=${_localSeqno}`);
  }
  const seqno = _localSeqno;
  _localSeqno++;
  return seqno;
}

export function resetLocalSeqno(): void {
  _localSeqno = null;
  _lastSyncTs = 0;
}
