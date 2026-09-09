import type Database from 'better-sqlite3';

/**
 * A counterparty the treasury has put under restriction.
 *
 * Restriction is not a refusal. Everything a restricted person may do, they may
 * still do: the same wallets, the same mandates, the same caps, the same
 * eligibility. What they may not have is an ANSWER GIVEN BY THE MACHINE. Every
 * proposal of theirs that would otherwise have been priced and offered on the
 * spot is parked in the review queue instead, for a person to decide.
 *
 * So it only ever turns a yes into "someone will look at this". It never turns
 * a no into a yes, and it never adds a refusal of its own — a frozen wallet, a
 * closed split window or an unbacked proposal is still refused for its own
 * reason, and the operator is not asked to re-decide what the rules already
 * settled.
 */
export interface RestrictionRow {
  hex_id: string;
  reason: string;
  restricted_by: string;
  restricted_at: string;
  lifted_at: string | null;
  lifted_by: string | null;
}

/** The code an offer carries when restriction is why it is under review. */
export const RESTRICTED_CODE = 'RESTRICTED';

export function restrictionReason(reason: string): string {
  const r = (reason || '').trim();
  return r
    ? `This proposal is under treasury review: ${r}`
    : 'This proposal is under treasury review; the treasury reviews every proposal from this counterparty by hand.';
}

/** The active restriction on a counterparty, or null. Lifted ones are kept, not deleted. */
export function activeRestriction(db: Database.Database, hexId: string): RestrictionRow | null {
  const hex = String(hexId || '').trim().toLowerCase();
  if (!hex) return null;
  return (db.prepare(
    'SELECT * FROM acquisition_restrictions WHERE hex_id = ? AND lifted_at IS NULL'
  ).get(hex) as RestrictionRow | undefined) || null;
}

/** Every hex under active restriction — for the admin worklist, in one query. */
export function activeRestrictionSet(db: Database.Database): Map<string, RestrictionRow> {
  const rows = db.prepare('SELECT * FROM acquisition_restrictions WHERE lifted_at IS NULL').all() as RestrictionRow[];
  return new Map(rows.map(r => [r.hex_id, r]));
}

export function listRestrictions(db: Database.Database): RestrictionRow[] {
  return db.prepare(
    'SELECT * FROM acquisition_restrictions ORDER BY lifted_at IS NOT NULL, restricted_at DESC'
  ).all() as RestrictionRow[];
}

/**
 * Put a counterparty under restriction, or refresh the reason of an existing
 * one. A reason is required: a restriction nobody can explain later is one
 * nobody can lift with confidence either.
 */
export function restrict(db: Database.Database, hexId: string, reason: string, by: string): RestrictionRow {
  const hex = String(hexId || '').trim().toLowerCase();
  const why = (reason || '').trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('INVALID_HEX');
  if (!why) throw new Error('REASON_REQUIRED');
  db.prepare(`
    INSERT INTO acquisition_restrictions (hex_id, reason, restricted_by, restricted_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(hex_id) DO UPDATE SET
      reason = excluded.reason,
      restricted_by = excluded.restricted_by,
      restricted_at = datetime('now'),
      lifted_at = NULL,
      lifted_by = NULL
  `).run(hex, why.slice(0, 500), by);
  return activeRestriction(db, hex)!;
}

/** Lift it. The row stays, stamped, so the history reads back. */
export function liftRestriction(db: Database.Database, hexId: string, by: string): boolean {
  const hex = String(hexId || '').trim().toLowerCase();
  return db.prepare(`
    UPDATE acquisition_restrictions
       SET lifted_at = datetime('now'), lifted_by = ?
     WHERE hex_id = ? AND lifted_at IS NULL
  `).run(by, hex).changes === 1;
}
