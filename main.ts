// DipCatcher: a mean-reversion dip-buyer for cbBTC/USDC 1-minute bars.
//
// Idea (from the dev window): 1-minute cbBTC is noise-dominated (a typical
// bar moves ~6 bps) while a full-size round trip costs ~30-40 bps in fees,
// slippage and pool impact, so trend-chasing on 1-minute signals whipsaws
// itself to death. What works on the dev window is buying a real dip and
// letting the price mean-revert: buy when the close sits at least 120 bps
// below the 240-bar rolling high, sell at +200 bps, at -200 bps, or after
// 240 bars held. A 60-bar cooldown after every filled sell, a trend filter
// (no buys while the 480-bar return is worse than -100 bps) and a hard stop
// after 2 consecutive losing sells keep a trending day from bleeding it.
//
// Parameters were picked on the kit's real local grader, not on a simulator:
// TP 120/150/180/200/220 grade +$13.64/+$17.81/+$20.23/+$22.00/+$22.00 while
// TP 250 collapses to +$1.52 (the target stops being reached and trades exit
// on max-hold instead), so TP 200 sits on the plateau with margin from the
// cliff. DIP 100 whipsaws (loses in the first half of the dev window) while
// DIP 120 wins in both halves. A breakout trend leg was tested and rejected:
// it cuts the dev grade from +$21.83 to +$7.59 in simulation, so the bot
// stays dip-only.
//
// The bot speaks agent-fun/bars-replay/v1 through the kit shim: the harness
// sends one hello, then one batch per bar (each batch carries the bar that
// just closed, the fills of the orders decided on the previous batch, and
// the account), and the bot answers every batch with exactly one reply of
// orders. Orders decided on a batch fill at the next bar's open. All maths
// is exact bigint arithmetic; no clock, no randomness, no network, no files
// outside the repo, so two runs on the same data answer byte for byte.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// Dip depth: buy when close is this far below the 240-bar high (bps).
const DIP_BPS = 120n;
// Take profit / stop loss vs the fill price (bps).
const TP_BPS = 200n;
const SL_BPS = 200n;
// Longest a position is held, in bars.
const MAX_HOLD_BARS = 240;
// Bars to wait after a filled sell before buying again.
const COOLDOWN_BARS = 60;
// Trend filter: skip buys while the 480-bar return is worse than this (bps).
const TREND_MIN_BPS = -100n;
// Stop buying for the rest of the window after this many losing sells in a row.
const MAX_LOSS_STREAK = 2;
// No new buys after this many bars seen (a late buy cannot reach its target
// before the final flatten sells it at a loss to fees).
const LAST_BUY_BAR = 1200;
// Lookbacks, in bars seen.
const HIGH_BARS = 240;
const TREND_BARS = 480;
// Max slippage vs the latest close an order tolerates (bps).
const MAX_SLIPPAGE_BPS = 200;

/** Closes seen so far, in bar order (one entry per bar that carried CBBTC). */
const closes: bigint[] = [];
/** The fill price of the open position, null while flat. */
let entryPrice: bigint | null = null;
/** Bars held since the buy filled. */
let holdBars = 0;
/** Bars seen before buying again (cooldown after a filled sell). */
let cooldownUntil = 0;
/** Consecutive filled sells that lost money vs their entry. */
let lossStreak = 0;
/** True once the loss-streak stop has tripped. */
let stopped = false;

/** The highest close of the last `n` bars seen, or null without `n` bars. */
function rollingHigh(n: number): bigint | null {
  if (closes.length < n) return null;
  let hi = closes[closes.length - n];
  for (let i = closes.length - n + 1; i < closes.length; i++) {
    if (closes[i]! > hi!) hi = closes[i]!;
  }
  return hi;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold the fills of the orders decided on the previous batch in first:
    // a filled buy sets the entry price, a filled sell clears it and starts
    // the cooldown (and counts a loss toward the loss streak).
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = BigInt(fill.price);
        holdBars = 0;
      } else if (fill.side === 'sell') {
        if (entryPrice !== null && BigInt(fill.price) < entryPrice) lossStreak += 1;
        else lossStreak = 0;
        if (lossStreak >= MAX_LOSS_STREAK) stopped = true;
        entryPrice = null;
        holdBars = 0;
        cooldownUntil = closes.length + COOLDOWN_BARS;
      }
    }

    // Record this batch's bar, if CBBTC traded this minute.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) closes.push(BigInt(bar.c));

    // Never trade during a warm-up: those orders are rejected anyway.
    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];
    const pos = state.positions.get(SYMBOL);

    if (pos !== undefined && pos.qty > 0n) {
      // Flat position bookkeeping: a position we hold without a recorded
      // entry (should not happen) is measured from the current close.
      if (entryPrice === null) entryPrice = close;
      holdBars += 1;
      const entry = entryPrice;
      // Take profit: close more than TP above the fill price.
      if ((close - entry) * 10_000n > entry * TP_BPS) {
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      // Stop loss: close more than SL below the fill price.
      if ((entry - close) * 10_000n > entry * SL_BPS) {
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      // Max hold: give the reversion a bounded time, then take what is there.
      if (holdBars >= MAX_HOLD_BARS) {
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: look for a dip to buy.
    if (stopped) return [];
    if (closes.length >= LAST_BUY_BAR) return [];
    if (closes.length < cooldownUntil) return [];
    const high = rollingHigh(HIGH_BARS);
    if (high === null) return [];
    // Buy when the close is at least DIP_BPS below the 240-bar high.
    if (close * 10_000n >= high * (10_000n - DIP_BPS)) return [];
    // Trend filter: do not catch a falling knife while the 480-bar return
    // is worse than TREND_MIN_BPS.
    if (closes.length >= TREND_BARS) {
      const then = closes[closes.length - TREND_BARS]!;
      if (close * 10_000n < then * (10_000n + TREND_MIN_BPS)) return [];
    }
    const cash = state.cash;
    if (cash <= 0n) return [];
    const room = state.weightRoom(SYMBOL);
    const spend = cash < room ? cash : room;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
