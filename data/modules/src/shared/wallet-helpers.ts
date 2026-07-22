  namespace WalletHelpers {

    export interface GameWallet {
      userId: string;
      gameId: string;
      currencies: { game: number; tokens: number; xp: number; [key: string]: number };
      items: { [key: string]: number };
    }

    export function getGameWallet(nk: nkruntime.Nakama, userId: string, gameId: string): GameWallet {
      var key = "wallet_" + userId + "_" + gameId;
      var wallet = Storage.readJson<GameWallet>(nk, Constants.WALLETS_COLLECTION, key, userId);
      if (!wallet) {
        return {
          userId: userId,
          gameId: gameId,
          currencies: { game: 0, tokens: 0, xp: 0 },
          items: {}
        };
      }
      if (wallet.currencies) {
        if (wallet.currencies.game === undefined) wallet.currencies.game = wallet.currencies.tokens || 0;
        if (wallet.currencies.tokens === undefined) wallet.currencies.tokens = wallet.currencies.game || 0;
      }
      return wallet;
    }

    export function saveGameWallet(nk: nkruntime.Nakama, wallet: GameWallet): void {
      var key = "wallet_" + wallet.userId + "_" + wallet.gameId;
      Storage.writeJson(nk, Constants.WALLETS_COLLECTION, key, wallet.userId, wallet, 1, 1);
    }

    /** Map legacy "coins" to canonical "game"; keep game ↔ tokens mirrored. */
    function resolveCurrencyId(currencyId: string): string {
      return currencyId === "coins" ? "game" : currencyId;
    }

    function syncGameTokensMirror(wallet: GameWallet, resolvedId: string): void {
      if (resolvedId === "game" || resolvedId === "tokens") {
        var mirrored = wallet.currencies[resolvedId] || 0;
        wallet.currencies.game = mirrored;
        wallet.currencies.tokens = mirrored;
      }
    }

    export function addCurrency(nk: nkruntime.Nakama, logger: nkruntime.Logger, ctx: nkruntime.Context, userId: string, gameId: string, currencyId: string, amount: number): GameWallet {
      var resolvedId = resolveCurrencyId(currencyId);
      var wallet = getGameWallet(nk, userId, gameId);
      if (!wallet.currencies[resolvedId]) {
        wallet.currencies[resolvedId] = 0;
      }
      wallet.currencies[resolvedId] += amount;
      syncGameTokensMirror(wallet, resolvedId);
      saveGameWallet(nk, wallet);

      EventBus.emit(nk, logger, ctx, EventBus.Events.CURRENCY_EARNED, {
        userId: userId, gameId: gameId, currencyId: resolvedId, amount: amount, newBalance: wallet.currencies[resolvedId]
      });

      return wallet;
    }

    export function spendCurrency(nk: nkruntime.Nakama, logger: nkruntime.Logger, ctx: nkruntime.Context, userId: string, gameId: string, currencyId: string, amount: number): GameWallet {
      var resolvedId = resolveCurrencyId(currencyId);
      var wallet = getGameWallet(nk, userId, gameId);
      var balance = wallet.currencies[resolvedId] || 0;
      if (balance < amount) {
        throw new Error("Insufficient " + resolvedId + ": have " + balance + ", need " + amount);
      }
      wallet.currencies[resolvedId] = balance - amount;
      syncGameTokensMirror(wallet, resolvedId);
      saveGameWallet(nk, wallet);

      EventBus.emit(nk, logger, ctx, EventBus.Events.CURRENCY_SPENT, {
        userId: userId, gameId: gameId, currencyId: resolvedId, amount: amount, newBalance: wallet.currencies[resolvedId]
      });

      return wallet;
    }

    export function hasCurrency(nk: nkruntime.Nakama, userId: string, gameId: string, currencyId: string, amount: number): boolean {
      var resolvedId = resolveCurrencyId(currencyId);
      var wallet = getGameWallet(nk, userId, gameId);
      return (wallet.currencies[resolvedId] || 0) >= amount;
    }
  }
