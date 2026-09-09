// Chess plugin — standard chess on the IVX AsyncTurnMatch template.
//
// The server is the only thing that knows the rules. Clients (the kiosk
// cabinet glass and the two phones that scanned its QR) render a board and
// post {from, to}; every legality question is answered here. A phone that
// posts an illegal move, moves out of turn, or moves a piece that is not its
// colour is simply ignored by the template.
//
// So that the clients never need a rule engine of their own, each TURN_END
// broadcast carries the legal-move map for whoever is on move next. The
// phones highlight straight from that map.
//
// Mounted from src/main.ts AFTER MpKernelModule.mount() so the async-turn
// template's generator registry exists. Generators are also (re-)registered
// lazily per Goja VM from zz_mp_kernel_handlers.js — pooled VMs never run
// InitModule, so registration there is what actually serves live matches.

// chess.js 0.10.3, concatenated at global scope by postbuild.js from
// data/modules/chess/chess-engine-vendor.js. tsc never sees that file.
declare var Chess: any;

namespace ChessGame {
  export var GENERATOR_ID = "chess:standard";

  // Result strings use PGN convention so exported games are portable.
  export var RESULT_WHITE = "1-0";
  export var RESULT_BLACK = "0-1";
  export var RESULT_DRAW  = "1/2-1/2";

  export interface ILegalMove {
    to: string;
    // True when landing on `to` forces a promotion choice, so the phone knows
    // to show the piece picker instead of moving immediately.
    promo: boolean;
  }

  export interface IChessState {
    // A game is (start_fen, moves) — that pair, not `fen`, is the authoritative
    // record. Threefold repetition and the fifty-move rule are properties of
    // the whole game, and a position rebuilt from a bare FEN has forgotten
    // everything that came before it.
    start_fen: string;
    moves: string[];
    // Cache of the position after the last move, so clients and the board
    // renderer do not have to replay anything.
    fen: string;
    white: string;      // user id, "" until claimed
    black: string;      // user id, "" until claimed
    spectator: string;  // cabinet glass; watches, never seated
    result: string;     // "" while playing
    end_reason: string;
    started_unix_ms: number;
  }

  var START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  // Rebuild the full game by replaying SAN from the start position. ~40 moves
  // of replay at a 1 Hz tick is far cheaper than getting draw detection wrong.
  function rebuild(state: IChessState): any {
    var g = new Chess(state.start_fen || START_FEN);
    for (var i = 0; i < state.moves.length; i++) {
      if (!g.move(state.moves[i])) {
        // Should be unreachable: every entry was produced by this engine.
        // Fall back to the cached position so a corrupt tail cannot brick a
        // live match — draw detection degrades, the game stays playable.
        return new Chess(state.fen || state.start_fen || START_FEN);
      }
    }
    return g;
  }

  function seatOf(state: IChessState, userId: string): string {
    if (userId && userId === state.white) return "w";
    if (userId && userId === state.black) return "b";
    return "";
  }

  function actorForTurn(state: IChessState, turn: string): string {
    return turn === "w" ? state.white : state.black;
  }

  function bothSeated(state: IChessState): boolean {
    return !!state.white && !!state.black;
  }

  // Legal destination squares grouped by origin square, for the side to move.
  //
  // Deduplicated by destination: the engine reports a promotion as four moves
  // (queen, rook, bishop, knight) that all land on the same square, which
  // would draw the same target four times. The client wants one target
  // carrying a "you will have to choose a piece" flag, and sends the choice
  // back with the move.
  export function legalMap(g: any): { [from: string]: ILegalMove[] } {
    var out: { [from: string]: ILegalMove[] } = {};
    var verbose = g.moves({ verbose: true });
    for (var i = 0; i < verbose.length; i++) {
      var mv = verbose[i];
      if (!out[mv.from]) out[mv.from] = [];
      var squares = out[mv.from];
      var seen = false;
      for (var j = 0; j < squares.length; j++) {
        if (squares[j].to === mv.to) {
          if (mv.promotion) squares[j].promo = true;
          seen = true;
          break;
        }
      }
      if (!seen) squares.push({ to: mv.to, promo: !!mv.promotion });
    }
    return out;
  }

  // Classify a finished position. Returns "" while the game is still live.
  function endReason(g: any): string {
    if (!g.game_over()) return "";
    if (g.in_checkmate()) return "checkmate";
    if (g.in_stalemate()) return "stalemate";
    if (g.insufficient_material()) return "insufficient_material";
    if (g.in_threefold_repetition()) return "threefold_repetition";
    // in_draw() is true here and the three specific draws are ruled out, so
    // the only remaining cause is the fifty-move rule.
    if (g.in_draw()) return "fifty_move";
    return "game_over";
  }

  export function freshState(initParams: any): IChessState {
    var startFen = (initParams && initParams.start_fen) || START_FEN;
    return {
      start_fen: startFen,
      moves: [],
      fen: startFen,
      white: (initParams && initParams.white_user_id) || "",
      black: (initParams && initParams.black_user_id) || "",
      spectator: (initParams && initParams.spectator_user_id) || "",
      result: "",
      end_reason: "",
      started_unix_ms: Date.now()
    };
  }

  // Everything a client needs to draw the board and know what it may do.
  function publicView(state: IChessState, g: any): any {
    var over = !!state.result;
    return {
      fen: state.fen,
      turn: over ? "" : g.turn(),
      moves: state.moves,
      ply: state.moves.length,
      white: state.white,
      black: state.black,
      in_check: !over && g.in_check(),
      result: state.result,
      end_reason: state.end_reason,
      legal: over ? {} : legalMap(g)
    };
  }

  export var GENERATOR: MpKernelAsyncTurn.IAsyncTurnGenerator = {
    generatorId: GENERATOR_ID,

    initState: function (initParams, persisted) {
      var state: IChessState = persisted && persisted.moves
        ? (persisted as IChessState)
        : freshState(initParams);

      // A resumed game keeps its seats; a fresh one has none until the phones
      // scan in, and must not hand anybody the move before both are present.
      if (persisted && initParams && initParams.spectator_user_id) {
        state.spectator = initParams.spectator_user_id;
      }

      var g = rebuild(state);
      var ended = !!state.result;
      var winner = "";
      if (state.result === RESULT_WHITE) winner = state.white;
      else if (state.result === RESULT_BLACK) winner = state.black;

      return {
        state: state,
        actor: (ended || !bothSeated(state)) ? "" : actorForTurn(state, g.turn()),
        ended: ended,
        winner_user_id: winner
      };
    },

    onActorJoin: function (rawState, userId, _actors) {
      var state = rawState as IChessState;
      if (!userId || userId === state.spectator) return null;
      // Already seated — this is a reconnect, not a new player.
      if (seatOf(state, userId)) return null;

      var color: string;
      if (!state.white) {
        state.white = userId;
        color = "w";
      } else if (!state.black) {
        state.black = userId;
        color = "b";
      } else {
        return null; // Both seats taken; this presence spectates.
      }

      var g = rebuild(state);
      var ready = bothSeated(state);
      var nextActor = ready ? actorForTurn(state, g.turn()) : "";

      return {
        state: state,
        actor: nextActor,
        // The template only emits TURN_START to the presence whose turn it is,
        // and the player who sat down first is not that presence when the
        // second one arrives. SEAT_ASSIGNED goes to everyone and carries the
        // whole picture, so both phones and the glass can start from it.
        seat_payload: {
          user_id: userId,
          color: color,
          both_seated: ready,
          next_actor: nextActor,
          state: publicView(state, g)
        }
      };
    },

    applyMove: function (rawState, userId, payload) {
      var state = rawState as IChessState;
      if (state.result) return null;
      if (!bothSeated(state)) return null;

      var color = seatOf(state, userId);
      if (!color) return null;

      var g = rebuild(state);
      if (g.turn() !== color) return null;

      var from = payload && payload.from ? String(payload.from) : "";
      var to   = payload && payload.to   ? String(payload.to)   : "";
      if (!from || !to) return null;

      var request: any = { from: from, to: to };
      // Only forward a promotion when one was asked for; chess.js rejects the
      // field on moves that cannot promote.
      if (payload && payload.promotion) {
        request.promotion = String(payload.promotion).toLowerCase();
      }

      var mv = g.move(request);
      if (!mv) return null;

      state.moves.push(mv.san);
      state.fen = g.fen();

      var reason = endReason(g);
      var ended = !!reason;
      var winner = "";
      if (ended) {
        state.end_reason = reason;
        if (reason === "checkmate") {
          state.result = color === "w" ? RESULT_WHITE : RESULT_BLACK;
          winner = userId;
        } else {
          state.result = RESULT_DRAW;
        }
      }

      return {
        state: state,
        actor: ended ? "" : actorForTurn(state, g.turn()),
        ended: ended,
        winner_user_id: winner,
        broadcast_payload: {
          move: {
            san: mv.san,
            from: mv.from,
            to: mv.to,
            color: mv.color,
            piece: mv.piece,
            captured: mv.captured || "",
            promotion: mv.promotion || "",
            // castle / en-passant flags, so the board can animate the rook
            // and clear the captured pawn without re-deriving them.
            flags: mv.flags
          },
          state: publicView(state, g)
        }
      };
    },

    buildResult: function (rawState, _actors, _winnerUserId, ended) {
      var state = rawState as IChessState;
      return {
        result: state.result,
        end_reason: state.end_reason,
        ply: state.moves.length,
        pgn_moves: state.moves.join(" "),
        final_fen: state.fen,
        white_user_id: state.white,
        black_user_id: state.black,
        completed: ended
      };
    }
  };
}

namespace ChessPlugin {
  // Kept for adapter introspection only. The registerRpc() call below must
  // pass a literal string: Nakama's Goja AST walker resolves the handler by
  // source name and cannot follow a namespaced property lookup. See the same
  // note in QuizVersePlugin.
  export var RPC_CREATE_MATCH = "chess_create_match";

  function nakamaError(msg: string, code: number): nkruntime.Error {
    return { message: msg, code: code };
  }

  // The cabinet calls this, then prints two QRs pointing at the returned
  // match. Seats are claimed on join, in scan order: first phone is White.
  export function rpcCreateMatch(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
  ): string {
    var raw: any;
    try {
      raw = JSON.parse(payload || "{}");
    } catch (e) {
      throw nakamaError("bad json", nkruntime.Codes.INVALID_ARGUMENT);
    }

    // A distinct async game id per cabinet session, so a glass reboot
    // rehydrates the board instead of resuming somebody else's game.
    var gameId = (raw.game_id && String(raw.game_id)) || ("chess_" + nk.uuidv4());

    // Kiosk default: a walk-up player who wanders off must not pin the
    // cabinet for a week, which is what the template's async default implies.
    var moveTimeoutMs = (typeof raw.move_timeout_ms === "number" && raw.move_timeout_ms > 0)
      ? raw.move_timeout_ms
      : 5 * 60 * 1000;

    var templateInit: any = {
      generator_id:          ChessGame.GENERATOR_ID,
      game_id:               gameId,
      game_label:            "chess",
      move_timeout_ms:       moveTimeoutMs,
      max_match_duration_ms: (typeof raw.max_match_duration_ms === "number")
        ? raw.max_match_duration_ms
        : 60 * 60 * 1000,
      // The glass joins to watch; it must never be dealt a colour.
      spectator_user_id:     ctx.userId || ""
    };

    var matchId: string;
    try {
      matchId = nk.matchCreate(MpKernelModule.TEMPLATE_IDS.ASYNC_TURN_V1, {
        game_id: "chess",
        region: raw.region || "",
        template_init: templateInit,
        creator_user_id: ctx.userId || ""
      });
    } catch (err: any) {
      logger.warn("[Chess] matchCreate failed: " + (err && err.message ? err.message : String(err)));
      throw nakamaError("matchCreate failed", nkruntime.Codes.INTERNAL);
    }

    return JSON.stringify({
      match_id: matchId,
      template_id: MpKernelModule.TEMPLATE_IDS.ASYNC_TURN_V1,
      game_id: "chess",
      async_game_id: gameId,
      spectator_user_id: ctx.userId || "",
      move_timeout_ms: moveTimeoutMs,
      server_unix_ms: Date.now()
    });
  }

  // Idempotent — registerGenerator overwrites by id. Called once per Goja VM
  // from zz_mp_kernel_handlers.js, because the pooled VMs that serve live
  // matches never run InitModule.
  export function registerGenerators(): void {
    MpKernelAsyncTurn.registerGenerator(ChessGame.GENERATOR);
  }

  // Single-arg on purpose so postbuild's autoInvokeRegister re-runs it on
  // every pooled VM; the body must contain only registerRpc calls.
  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("chess_create_match", rpcCreateMatch);
  }
}
