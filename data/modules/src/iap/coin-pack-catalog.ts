namespace CoinPackCatalog {

  interface CoinPackEntry {
    /** Canonical Apple App Store product ID (matches client ShopProductConfig.ProductIds). */
    productId: string;
    /** Base coin amount before bonus. */
    base: number;
    /** Bonus percentage applied on top of base. */
    bonusPercent: number;
  }

  // Single server-side source of truth. Mirrors client ShopProductConfig.CoinPacks.
  // grant = base + round(base * bonusPercent / 100)
  var COIN_PACKS: CoinPackEntry[] = [
    { productId: "com.intelliverse.quizverse.coins.500", base: 500, bonusPercent: 0 },
    { productId: "com.intelliverse.quizverse.coins.1200", base: 1200, bonusPercent: 20 },
    { productId: "com.intelliverse.quizverse.coins.2500", base: 2500, bonusPercent: 25 },
    { productId: "com.intelliverse.quizverse.coins.6500", base: 6500, bonusPercent: 30 },
    { productId: "com.intelliverse.quizverse.coins.15000", base: 15000, bonusPercent: 50 }
  ];

  /** True when the productId is any coin pack (mirrors client ShopProductConfig.IsCoinPack). */
  export function isCoinPack(productId: string): boolean {
    if (!productId) {
      return false;
    }
    return productId.indexOf("coins.") !== -1;
  }

  /**
   * Resolve the total coins to grant for a coin pack product, including bonus.
   * Returns null when the productId is not a known coin pack.
   */
  export function resolveCoinGrant(productId: string): number | null {
    if (!productId) {
      return null;
    }
    var normalized = stripStoreSuffix(productId);
    for (var i = 0; i < COIN_PACKS.length; i++) {
      var entry = COIN_PACKS[i];
      if (matchesProduct(normalized, entry.productId)) {
        return entry.base + Math.round((entry.base * entry.bonusPercent) / 100);
      }
    }
    return null;
  }

  // Strip Android base-plan suffix ("productId:baseplan").
  function stripStoreSuffix(productId: string): string {
    var colon = productId.indexOf(":");
    if (colon > 0) {
      return productId.substring(0, colon);
    }
    return productId;
  }

  // Exact canonical match, or trailing "coins.<n>" segment match so store-prefixed IDs resolve.
  function matchesProduct(productId: string, canonical: string): boolean {
    if (productId === canonical) {
      return true;
    }
    var suffix = canonical.substring(canonical.indexOf("coins."));
    return endsWith(productId, suffix);
  }

  function endsWith(value: string, suffix: string): boolean {
    return value.length >= suffix.length &&
      value.substring(value.length - suffix.length) === suffix;
  }
}
