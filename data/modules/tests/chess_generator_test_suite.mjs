// Chess generator test suite — node tests/chess_generator_test_suite.mjs
//
// Exercises src/games/chess/index.ts against the vendored chess.js engine
// without a running Nakama. The ChessGame namespace is lifted out of the tsc
// output rather than re-implemented here, so what is asserted is the same code
// the Goja VM loads. It touches no nkruntime symbol at runtime — the kernel
// generator interface is a compile-time type only — so it evaluates standalone.
//
// Run `npx tsc` (or `npm run build`) first; this reads build/index.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.resolve(HERE, '..');

function loadChessGame() {
  const engine = fs.readFileSync(
    path.join(MODULES, 'chess', 'chess-engine-vendor.js'), 'utf8');
  const build = fs.readFileSync(path.join(MODULES, 'build', 'index.js'), 'utf8');

  // tsc --outFile emits every namespace as `var X;(function(X){...})(X||(X={}));`.
  const start = build.indexOf('var ChessGame;');
  if (start < 0) throw new Error('ChessGame namespace not found — run npx tsc first');
  const end = build.indexOf('var ChessPlugin;', start);
  if (end < 0) throw new Error('ChessPlugin sentinel not found after ChessGame');

  const sandbox = { Date };
  vm.createContext(sandbox);
  vm.runInContext(engine, sandbox);
  vm.runInContext(build.slice(start, end), sandbox);
  return sandbox.ChessGame;
}

const ChessGame = loadChessGame();
const GEN = ChessGame.GENERATOR;

const TV = 'user-tv', WHITE = 'user-white', BLACK = 'user-black', RANDO = 'user-rando';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A match as the cabinet creates it: the glass is the spectator, no seats yet.
function newGame() {
  const init = { spectator_user_id: TV };
  const boot = GEN.initState(init, null);
  return boot.state;
}

// Seat both phones the way the template's onJoin does.
function seatBoth() {
  const state = newGame();
  const w = GEN.onActorJoin(state, WHITE, [TV, WHITE]);
  const b = GEN.onActorJoin(state, BLACK, [TV, WHITE, BLACK]);
  return { state, w, b };
}

function play(state, userId, from, to, promotion) {
  return GEN.applyMove(state, userId, { from, to, promotion });
}

check('fresh game starts unseated and hands nobody the move', () => {
  const init = { spectator_user_id: TV };
  const boot = GEN.initState(init, null);
  assert(boot.actor === '', `expected no actor, got "${boot.actor}"`);
  assert(boot.ended === false, 'fresh game must not be over');
  assert(boot.state.moves.length === 0, 'fresh game must have no moves');
});

check('the cabinet glass is never dealt a colour', () => {
  const state = newGame();
  assert(GEN.onActorJoin(state, TV, [TV]) === null, 'spectator was seated');
  assert(state.white === '' && state.black === '', 'spectator took a seat');
});

check('seats are claimed in scan order and White moves first', () => {
  const { state, w, b } = seatBoth();
  assert(w.seat_payload.color === 'w', 'first joiner should be White');
  assert(b.seat_payload.color === 'b', 'second joiner should be Black');
  assert(state.white === WHITE && state.black === BLACK, 'seats not recorded');
  assert(w.actor === '', 'nobody may move before both players are seated');
  assert(b.actor === WHITE, 'White should be on move once both are seated');
  assert(b.seat_payload.both_seated === true, 'both_seated not signalled');
});

check('a third phone spectates instead of taking a seat', () => {
  const { state } = seatBoth();
  assert(GEN.onActorJoin(state, RANDO, [TV, WHITE, BLACK, RANDO]) === null,
    'a third player was seated');
});

check('a reconnecting player keeps their original seat', () => {
  const { state } = seatBoth();
  assert(GEN.onActorJoin(state, WHITE, [TV, WHITE, BLACK]) === null,
    'reconnect re-seated an existing player');
  assert(state.white === WHITE, 'reconnect disturbed the seating');
});

check('no move is accepted before both players are seated', () => {
  const state = newGame();
  GEN.onActorJoin(state, WHITE, [TV, WHITE]);
  assert(play(state, WHITE, 'e2', 'e4') === null, 'White moved with no opponent');
});

check('legal opening moves are accepted', () => {
  const { state } = seatBoth();
  const res = play(state, WHITE, 'e2', 'e4');
  assert(res !== null, 'e4 was rejected');
  assert(res.broadcast_payload.move.san === 'e4', `expected e4, got ${res.broadcast_payload.move.san}`);
  assert(res.actor === BLACK, 'turn did not pass to Black');
  assert(state.moves.length === 1, 'move was not recorded');
});

check('illegal moves are rejected and leave the board untouched', () => {
  const { state } = seatBoth();
  assert(play(state, WHITE, 'e2', 'e5') === null, 'a two-square-too-far pawn move was allowed');
  assert(state.moves.length === 0, 'a rejected move mutated the board');
});

check('moving out of turn is rejected', () => {
  const { state } = seatBoth();
  assert(play(state, BLACK, 'e7', 'e5') === null, 'Black moved first');
});

check('a player cannot move the opponent pieces', () => {
  const { state } = seatBoth();
  play(state, WHITE, 'e2', 'e4');
  assert(play(state, WHITE, 'e7', 'e5') === null, 'White moved a black pawn');
});

check('a spectator cannot move', () => {
  const { state } = seatBoth();
  assert(play(state, TV, 'e2', 'e4') === null, 'the glass made a move');
});

check('the legal-move map covers the opening position', () => {
  const { b } = seatBoth();
  const legal = b.seat_payload.state.legal;
  assert(legal.e2, 'no legal moves listed for e2');
  const targets = legal.e2.map((m) => m.to).sort();
  assert(targets.join(',') === 'e3,e4', `expected e3,e4 from e2 — got ${targets}`);
  assert(Object.keys(legal).length === 10, 'expected 10 origin squares at the start');
});

check('checkmate ends the game and names the winner', () => {
  // Fool's mate: 1. f3 e5 2. g4 Qh4#
  const { state } = seatBoth();
  play(state, WHITE, 'f2', 'f3');
  play(state, BLACK, 'e7', 'e5');
  play(state, WHITE, 'g2', 'g4');
  const mate = play(state, BLACK, 'd8', 'h4');
  assert(mate !== null, 'Qh4 was rejected');
  assert(mate.ended === true, 'checkmate did not end the game');
  assert(mate.winner_user_id === BLACK, 'wrong winner');
  assert(state.result === ChessGame.RESULT_BLACK, `expected 0-1, got ${state.result}`);
  assert(state.end_reason === 'checkmate', `expected checkmate, got ${state.end_reason}`);
  assert(mate.broadcast_payload.state.legal &&
    Object.keys(mate.broadcast_payload.state.legal).length === 0,
    'a finished game still offered legal moves');
});

check('no further moves are accepted once the game is over', () => {
  const { state } = seatBoth();
  play(state, WHITE, 'f2', 'f3');
  play(state, BLACK, 'e7', 'e5');
  play(state, WHITE, 'g2', 'g4');
  play(state, BLACK, 'd8', 'h4');
  assert(play(state, WHITE, 'g1', 'h3') === null, 'a move was played after checkmate');
});

check('stalemate is scored as a draw, not a win', () => {
  // Qc4-c7 covers a7, b7 and b8 without giving check, so the cornered black
  // king has no legal reply.
  const state = GEN.initState(
    { spectator_user_id: TV, start_fen: 'k7/8/8/8/2Q5/8/8/7K w - - 0 1' }, null).state;
  state.white = WHITE;
  state.black = BLACK;
  const res = play(state, WHITE, 'c4', 'c7');
  assert(res !== null, 'Qg7 was rejected');
  assert(res.ended === true, 'stalemate did not end the game');
  assert(res.winner_user_id === '', 'stalemate produced a winner');
  assert(state.result === ChessGame.RESULT_DRAW, `expected 1/2-1/2, got ${state.result}`);
  assert(state.end_reason === 'stalemate', `expected stalemate, got ${state.end_reason}`);
});

check('promotion is flagged to the client and applied when chosen', () => {
  const state = GEN.initState(
    { spectator_user_id: TV, start_fen: '8/P6k/8/8/8/8/8/K7 w - - 0 1' }, null).state;
  GEN.onActorJoin(state, WHITE, [TV, WHITE]);
  const seated = GEN.onActorJoin(state, BLACK, [TV, WHITE, BLACK]);

  // The phone needs one target square flagged as needing a piece picker — not
  // the same square repeated once per promotion choice.
  const a7 = seated.seat_payload.state.legal.a7;
  assert(a7 && a7.length === 1, `expected a single target from a7, got ${a7 && a7.length}`);
  assert(a7[0].to === 'a8' && a7[0].promo === true, 'a8 was not flagged as a promotion');

  const res = play(state, WHITE, 'a7', 'a8', 'q');
  assert(res !== null, 'promotion was rejected');
  assert(res.broadcast_payload.move.promotion === 'q', 'promotion piece not recorded');
  assert(res.broadcast_payload.state.fen.indexOf('Q') === 0, 'no queen on a8');
});

check('threefold repetition is detected across the whole game, not one position', () => {
  // Knights shuffle out and back twice, returning to the start position a
  // third time. Only a generator that replays the move list can see this.
  const { state } = seatBoth();
  const shuffle = [
    [WHITE, 'g1', 'f3'], [BLACK, 'g8', 'f6'],
    [WHITE, 'f3', 'g1'], [BLACK, 'f6', 'g8'],
    [WHITE, 'g1', 'f3'], [BLACK, 'g8', 'f6'],
    [WHITE, 'f3', 'g1'], [BLACK, 'f6', 'g8'],
  ];
  let last = null;
  for (const [who, from, to] of shuffle) {
    last = play(state, who, from, to);
    assert(last !== null, `${from}${to} was rejected`);
  }
  assert(last.ended === true, 'threefold repetition was not detected');
  assert(state.end_reason === 'threefold_repetition',
    `expected threefold_repetition, got ${state.end_reason}`);
  assert(state.result === ChessGame.RESULT_DRAW, 'repetition should be a draw');
});

check('buildResult reports a portable game record', () => {
  const { state } = seatBoth();
  play(state, WHITE, 'e2', 'e4');
  play(state, BLACK, 'e7', 'e5');
  const out = GEN.buildResult(state, [WHITE, BLACK], '', false);
  assert(out.ply === 2, `expected 2 ply, got ${out.ply}`);
  assert(out.pgn_moves === 'e4 e5', `expected "e4 e5", got "${out.pgn_moves}"`);
  assert(out.white_user_id === WHITE && out.black_user_id === BLACK, 'seats missing from result');
});

check('an interrupted game rehydrates with the right side to move', () => {
  const { state } = seatBoth();
  play(state, WHITE, 'e2', 'e4');
  // The glass rebooted; the template reloads from storage and re-inits.
  const boot = GEN.initState({ spectator_user_id: TV }, state);
  assert(boot.actor === BLACK, 'resumed game handed the move to the wrong player');
  assert(boot.ended === false, 'resumed game was reported as finished');
  assert(boot.state.moves.join(' ') === 'e4', 'resumed game lost its move list');
});

console.log(`\nchess generator: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
