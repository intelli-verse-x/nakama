// =============================================================================
// storage.ts — Storage helpers for tournament module
//
// Plan ref: §1I Storage Layout. One file per tournament collection so each
// schema lives next to its read/write helpers.
//
// Collections:
//   tournaments_meta       — system-owned snapshot of TournamentConfig (so
//                             the cron flipping PRE_ENROLL→OPEN doesn't need
//                             to re-read TS source)
//   tournament_entries     — per-user, one row per (user × tournament)
//   tournament_submits     — per-user, one row per (user × tournament × pack)
//   tournament_pre_enroll  — per-user, one row per (user × tournament)
//   tournament_pot         — system-owned aggregate (running pot per tournament)
//   tournament_certs       — per-user, claimed certificates
// =============================================================================

namespace TournamentsStorage {

  export const COL_META = "tournaments_meta";
  export const COL_ENTRY = "tournament_entries";
  export const COL_SUBMIT = "tournament_submits";
  export const COL_PRE_ENROLL = "tournament_pre_enroll";
  export const COL_POT = "tournament_pot";
  export const COL_CERTS = "tournament_certs";
  export const COL_PICKS = "tournament_picks";
  export const COL_ELIMINATIONS = "tournament_eliminations";

  function nowSec(): number { return Math.floor(Date.now() / 1000); }

  // ── Meta (status + denormalized config snapshot) ───────────────────────────
  export interface MetaRow {
    slug: string;
    status: TournamentEconomy.TournamentStatus;
    pot_bc: number;
    entries_count: number;
    pre_enroll_count: number;
    config_snapshot: any;   // TournamentConfig at seed time
    updated_at: number;
  }

  export function readMeta(nk: nkruntime.Nakama, slug: string): MetaRow | null {
    try {
      var rows = nk.storageRead([{ collection: COL_META, key: slug, userId: Constants.SYSTEM_USER_ID }]);
      if (rows && rows.length > 0) return rows[0].value as MetaRow;
    } catch (_) { }
    return null;
  }

  export function writeMeta(nk: nkruntime.Nakama, slug: string, meta: MetaRow): void {
    meta.updated_at = nowSec();
    nk.storageWrite([{
      collection: COL_META,
      key: slug,
      userId: Constants.SYSTEM_USER_ID,
      value: meta,
      permissionRead: 2,    // public read so anonymous /tournaments page works
      permissionWrite: 0,
    }]);
  }

  export function listAllMeta(nk: nkruntime.Nakama): MetaRow[] {
    var out: MetaRow[] = [];
    try {
      var cursor = "";
      var safety = 0;
      while (safety < 5) {
        safety++;
        var page = nk.storageList(Constants.SYSTEM_USER_ID, COL_META, 100, cursor);
        if (!page || !page.objects) break;
        for (var i = 0; i < page.objects.length; i++) out.push(page.objects[i].value as MetaRow);
        if (!page.cursor) break;
        cursor = page.cursor;
      }
    } catch (_) { }
    return out;
  }

  // ── Seed (initialize from TournamentEconomy.LAUNCH_SLATE) ──────────────────
  export function seedFromConfig(nk: nkruntime.Nakama, cfg: TournamentEconomy.TournamentConfig): MetaRow {
    var existing = readMeta(nk, cfg.slug);
    if (existing) return existing;  // idempotent

    var status: TournamentEconomy.TournamentStatus = "PRE_ENROLL";
    var now = nowSec();
    if (now >= isoToUnix(cfg.open_start_iso)) status = "OPEN";
    if (now >= isoToUnix(cfg.end_iso)) status = "SETTLING";

    var meta: MetaRow = {
      slug: cfg.slug,
      status: status,
      pot_bc: cfg.pot_seed_bc | 0,
      entries_count: 0,
      pre_enroll_count: 0,
      config_snapshot: cfg,
      updated_at: now,
    };
    writeMeta(nk, cfg.slug, meta);
    return meta;
  }

  function isoToUnix(iso: string): number {
    return Math.floor(new Date(iso).getTime() / 1000);
  }

  // ── Entry rows ─────────────────────────────────────────────────────────────
  export interface EntryRow {
    entry_id: string;
    tournament_slug: string;
    user_id: string;
    paid_via: "balance" | "amoe" | "free_founder";
    bc_charged: number;
    founder_member: boolean;
    enrolled_at: number;
    eliminated_at?: number;       // for elimination format
    eliminated_round?: number;
    score: number;
    rank?: number;
    claimed_cert?: boolean;
    cert_id?: string;
  }

  function entryKey(slug: string, userId: string): string { return slug + "_" + userId; }

  export function readEntry(nk: nkruntime.Nakama, slug: string, userId: string): EntryRow | null {
    try {
      var rows = nk.storageRead([{ collection: COL_ENTRY, key: entryKey(slug, userId), userId: userId }]);
      if (rows && rows.length > 0) return rows[0].value as EntryRow;
    } catch (_) { }
    return null;
  }

  export function writeEntry(nk: nkruntime.Nakama, slug: string, userId: string, entry: EntryRow): void {
    nk.storageWrite([{
      collection: COL_ENTRY,
      key: entryKey(slug, userId),
      userId: userId,
      value: entry,
      permissionRead: 1,
      permissionWrite: 0,
    }]);
  }

  // List entries across all users for a tournament (system call; used at settle time).
  // Because Nakama storage is per-user-keyed, we need to use a separate index
  // collection. For MVP we walk users via leaderboard records (which we write
  // on every submit). See below.
  export interface PublicEntrySummary {
    user_id: string;
    score: number;
    eliminated_at?: number;
    eliminated_round?: number;
    founder_member: boolean;
  }

  // ── Submit rows (idempotent per pack) ──────────────────────────────────────
  export interface SubmitRow {
    idempotency_key: string;
    tournament_slug: string;
    pack_id: string;
    user_id: string;
    answers_count: number;
    score: number;
    correct: number;
    total: number;
    latency_ms: number;
    duration_ms: number;
    submitted_at: number;
    status: "counted" | "soft_dq" | "throttled";
    soft_dq_reasons?: string[];
  }

  function submitKey(slug: string, userId: string, packId: string): string {
    return slug + "_" + userId + "_" + packId;
  }

  function submitIdemKey(idempotencyKey: string): string {
    return "submit_idem_" + idempotencyKey;
  }

  export function readSubmitIdem(nk: nkruntime.Nakama, userId: string, idempotencyKey: string): SubmitRow | null {
    try {
      var rows = nk.storageRead([{ collection: COL_SUBMIT, key: submitIdemKey(idempotencyKey), userId: userId }]);
      if (rows && rows.length > 0) return rows[0].value as SubmitRow;
    } catch (_) { }
    return null;
  }

  export function writeSubmit(nk: nkruntime.Nakama, userId: string, idempotencyKey: string, row: SubmitRow): void {
    nk.storageWrite([
      {
        collection: COL_SUBMIT,
        key: submitIdemKey(idempotencyKey),
        userId: userId,
        value: row,
        permissionRead: 1,
        permissionWrite: 0,
      },
      // Also write a non-idempotency-keyed row for the (tournament × pack) view.
      {
        collection: COL_SUBMIT,
        key: submitKey(row.tournament_slug, userId, row.pack_id),
        userId: userId,
        value: row,
        permissionRead: 1,
        permissionWrite: 0,
      },
    ]);
  }

  // ── Pre-enroll rows ────────────────────────────────────────────────────────
  export interface PreEnrollRow {
    tournament_slug: string;
    user_id: string;
    enrolled_at: number;
    founder_rank?: number;          // 1-1000 if Founder Member
    referred_by?: string;            // referral code that brought this user
  }

  export function readPreEnroll(nk: nkruntime.Nakama, slug: string, userId: string): PreEnrollRow | null {
    try {
      var rows = nk.storageRead([{ collection: COL_PRE_ENROLL, key: slug, userId: userId }]);
      if (rows && rows.length > 0) return rows[0].value as PreEnrollRow;
    } catch (_) { }
    return null;
  }

  export function writePreEnroll(nk: nkruntime.Nakama, slug: string, userId: string, row: PreEnrollRow): void {
    nk.storageWrite([{
      collection: COL_PRE_ENROLL,
      key: slug,
      userId: userId,
      value: row,
      permissionRead: 1,
      permissionWrite: 0,
    }]);
  }

  // ── Pot bookkeeping (incremental, atomic-ish via read+write under cron lock) ──
  export function incrementPot(nk: nkruntime.Nakama, slug: string, deltaBc: number): number {
    var meta = readMeta(nk, slug);
    if (!meta) return 0;
    meta.pot_bc = (meta.pot_bc | 0) + (deltaBc | 0);
    if (deltaBc > 0) meta.entries_count = (meta.entries_count | 0) + 1;
    writeMeta(nk, slug, meta);
    return meta.pot_bc;
  }

  export function incrementPreEnrollCount(nk: nkruntime.Nakama, slug: string): number {
    var meta = readMeta(nk, slug);
    if (!meta) return 0;
    meta.pre_enroll_count = (meta.pre_enroll_count | 0) + 1;
    // §1F pot-amplification: house adds 5 BC to pot per 10 enrollments.
    if (meta.pre_enroll_count % 10 === 0) {
      meta.pot_bc = (meta.pot_bc | 0) + TournamentEconomy.HOUSE_PRE_ENROLL_SUBSIDY_BC_PER_ENROLLEE * 10;
    }
    writeMeta(nk, slug, meta);
    return meta.pre_enroll_count;
  }
}
