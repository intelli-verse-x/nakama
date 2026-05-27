// =============================================================================
// realtime.ts — nk.notificationsSend helpers for tournament events
//
// Plan ref: §1I real-time push topology
//
// Notification codes (per plan):
//   TOURNAMENT_POT_UPDATE   1001 — broadcast to subscribers on pot change
//   TOURNAMENT_LB_UPDATE    1002 — broadcast on leaderboard tick (every ~5s)
//   TOURNAMENT_ELIMINATED   1003 — user-targeted on elimination cut
//   TOURNAMENT_SETTLED      1004 — user-targeted on settlement
//   PREENROLL_SCARCITY      1005 — broadcast when founder cap < 100 left
//
// Web subscribers use @heroiclabs/nakama-js socket; Unity uses ISocket.
// Both already wired in the codebase (existing IVXFriends + CreatorEvent
// patterns reference ReceivedNotification).
// =============================================================================

namespace TournamentRealtime {

  export const CODE_POT_UPDATE = 1001;
  export const CODE_LB_UPDATE = 1002;
  export const CODE_ELIMINATED = 1003;
  export const CODE_SETTLED = 1004;
  export const CODE_PREENROLL_SCARCITY = 1005;

  // Send to a list of user IDs. Nakama notificationsSend accepts a list of
  // notifications, each addressed to one userId.
  export function sendToUsers(nk: nkruntime.Nakama, userIds: string[], code: number, subject: string, content: any, persistent: boolean): void {
    if (!userIds || userIds.length === 0) return;
    var batch: nkruntime.NotificationRequest[] = [];
    for (var i = 0; i < userIds.length; i++) {
      batch.push({
        userId: userIds[i],
        subject: subject,
        content: content,
        code: code,
        persistent: persistent,
        senderId: Constants.SYSTEM_USER_ID,
      });
    }
    try {
      nk.notificationsSend(batch);
    } catch (_) {
      // best-effort — fan-out doesn't block any RPC
    }
  }

  // Convenience: one user
  export function sendToUser(nk: nkruntime.Nakama, userId: string, code: number, subject: string, content: any, persistent: boolean): void {
    sendToUsers(nk, [userId], code, subject, content, persistent);
  }

  // ── Tournament-specific helpers ────────────────────────────────────────────
  export function notifyPotUpdate(nk: nkruntime.Nakama, tournamentSlug: string, newPotBc: number, recentDelta: number, subscribers: string[]): void {
    sendToUsers(nk, subscribers, CODE_POT_UPDATE, "tournament_pot_update", {
      tournament_slug: tournamentSlug,
      pot_bc: newPotBc,
      delta_bc: recentDelta,
      ts: Math.floor(Date.now() / 1000),
    }, false);
  }

  export function notifyEliminated(nk: nkruntime.Nakama, userId: string, tournamentSlug: string, round: number, finalRank: number): void {
    sendToUser(nk, userId, CODE_ELIMINATED, "tournament_eliminated", {
      tournament_slug: tournamentSlug,
      round: round,
      final_rank: finalRank,
      ts: Math.floor(Date.now() / 1000),
    }, true);  // persistent so user sees it next session
  }

  export function notifySettled(nk: nkruntime.Nakama, userId: string, tournamentSlug: string, payoutBc: number, finalRank: number, certId: string | null): void {
    sendToUser(nk, userId, CODE_SETTLED, "tournament_settled", {
      tournament_slug: tournamentSlug,
      payout_bc: payoutBc,
      final_rank: finalRank,
      cert_id: certId,
      ts: Math.floor(Date.now() / 1000),
    }, true);
  }

  export function notifyPreEnrollScarcity(nk: nkruntime.Nakama, tournamentSlug: string, founderSpotsLeft: number, subscribers: string[]): void {
    if (founderSpotsLeft > 100) return;  // only fire under threshold
    sendToUsers(nk, subscribers, CODE_PREENROLL_SCARCITY, "preenroll_scarcity", {
      tournament_slug: tournamentSlug,
      founder_spots_left: founderSpotsLeft,
      ts: Math.floor(Date.now() / 1000),
    }, false);
  }

  // Leaderboard ticker: broadcasts current top-10 + activity snippet to all
  // subscribers; called by leaderboard helper every ~5s during active windows.
  export function notifyLeaderboardTick(nk: nkruntime.Nakama, tournamentSlug: string, topRows: any[], subscribers: string[]): void {
    sendToUsers(nk, subscribers, CODE_LB_UPDATE, "tournament_lb_update", {
      tournament_slug: tournamentSlug,
      top: topRows,
      ts: Math.floor(Date.now() / 1000),
    }, false);
  }
}
