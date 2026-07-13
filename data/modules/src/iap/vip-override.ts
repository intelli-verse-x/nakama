// ---------------------------------------------------------------------------
//  vip-override.ts  —  hard-coded Nakama user IDs with permanent Pro+ access
//
//  Mirrors Unity Trivia.Monetization.VipUserOverride and web lap-vip-override.ts.
//  Used by quizverse_get_entitlements + quizverse_lap_note_quota so VIP QA
//  accounts are not blocked by free-tier note limits or missing RC grants.
// ---------------------------------------------------------------------------

namespace QvVipOverride {

  // Keep in sync with:
  //   Assets/_QuizVerse/Scripts/Monetization/VipUserOverride.cs
  //   web/lib/link-and-play/lap-vip-override.ts
  var VIP_IDS: string[] = [
    "6ffac0b4-d999-4736-8741-898b2d36101b", // tester
    "99a67d10-30e8-4ba6-ade5-8856beb07fcd", // Kartik — lehey82964@gixpos.com
  ];

  var _vipSet: { [id: string]: boolean } = null;

  function vipSet(): { [id: string]: boolean } {
    if (_vipSet) return _vipSet;
    _vipSet = {};
    for (var i = 0; i < VIP_IDS.length; i++) {
      var id = String(VIP_IDS[i] || "").trim().toLowerCase();
      if (id) _vipSet[id] = true;
    }
    return _vipSet;
  }

  export function isVipUserId(userId: string): boolean {
    if (!userId) return false;
    return !!vipSet()[String(userId).trim().toLowerCase()];
  }

  /** Synthetic Pro+ subscription snapshot for VIP accounts. */
  export function vipSubscriptionSnapshot(): any {
    return {
      tier: "pro_plus",
      status: "active",
      productId: "vip_override",
      store: "vip_override",
      expiresAt: null,
      entitlement_ids: ["pro_plus", "pro", "plus", "linkplay_pro", "linkplay_proplus"],
      updatedAt: new Date().toISOString(),
      source: "vip_override"
    };
  }
}
