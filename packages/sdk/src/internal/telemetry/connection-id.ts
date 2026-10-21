/**
 * Generated client-side, once per `join()`, and never changed for the life
 * of that connection. This is the id a developer sees in the dashboard, in
 * `swalvo connections inspect`, and in every error report (Phase 9 spec §8).
 *
 * Prefers `crypto.randomUUID()`, which every SDK-supported browser has.
 * The manual fallback only ever matters in odd test or embedding
 * environments.
 */
export function generateConnectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `conn_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  let id = '';
  for (let i = 0; i < 32; i++) {
    id += Math.floor(Math.random() * 16).toString(16);
  }
  return `conn_${id}`;
}
