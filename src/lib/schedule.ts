/**
 * Pure scheduling logic: turns recorded history into the actions to replay now.
 * No ioBroker dependencies, so it is unit-tested directly.
 */

/** One recorded value of a state, as returned by a history adapter's getHistory. */
export interface HistoryEntry {
    /** When the value was recorded (ms). */
    ts: number;
    /** The recorded value. */
    val: ioBroker.StateValue;
}

/** One planned write. */
export interface PlannedAction {
    /** State to write. */
    id: string;
    /** When to write it (ms). */
    at: number;
    /** Value to write. */
    val: ioBroker.StateValue;
    /** When the original change happened (for logging). */
    recordedAt: number;
}

/** Timing options for planWindow. */
export interface PlanOptions {
    /** How far back the replay looks, in ms (e.g. 7 days). */
    deltaMs: number;
    /** Maximum random shift applied to each change, in ms (± this value). */
    jitterMs: number;
    /** Current time. */
    now: number;
    /** Only plan actions at or after this time; anything earlier is clamped to it. */
    notBefore?: number;
    /** Random source returning [0, 1). Injected for tests. */
    random?: () => number;
}

/** Minimum gap kept between two actions on the same state, so jitter can never reorder them. */
export const MIN_GAP_MS = 1000;

/**
 * Accepts only values that can be written back to a state; history can contain nulls.
 *
 * @param val - value to check
 */
export function isReplayable(val: unknown): val is ioBroker.StateValue {
    return typeof val === 'boolean' || typeof val === 'string' || (typeof val === 'number' && Number.isFinite(val));
}

/**
 * The value a state had at time `t`: the newest entry at or before `t`.
 * Returns undefined when the history has nothing that old.
 *
 * @param entries - history entries, in any order
 * @param t - point in time (ms)
 */
export function valueAt(entries: HistoryEntry[], t: number): ioBroker.StateValue | undefined {
    let best: HistoryEntry | undefined;
    for (const e of entries) {
        if (e.ts <= t && isReplayable(e.val) && (!best || e.ts > best.ts)) {
            best = e;
        }
    }
    return best?.val;
}

/**
 * Plans the replay of the changes recorded in a past window.
 *
 * Every entry with `windowStart < ts <= windowEnd` (recorded time) becomes an action at
 * `ts + deltaMs ± jitter`. Consecutive repeats of the same value are dropped, since they would
 * not change anything. Per state, actions keep their recorded order and are at least
 * MIN_GAP_MS apart, so a random shift can never put "off" before the "on" it follows.
 *
 * @param id - state id the entries belong to
 * @param entries - history entries of that state, in any order
 * @param windowStart - start of the recorded window (exclusive), ms
 * @param windowEnd - end of the recorded window (inclusive), ms
 * @param lastValue - the value the state is replaying at windowStart (to skip repeats)
 * @param opts - timing options
 */
export function planWindow(
    id: string,
    entries: HistoryEntry[],
    windowStart: number,
    windowEnd: number,
    lastValue: ioBroker.StateValue | undefined,
    opts: PlanOptions,
): PlannedAction[] {
    const random = opts.random ?? Math.random;
    const notBefore = opts.notBefore ?? opts.now;
    const sorted = entries
        .filter(e => e.ts > windowStart && e.ts <= windowEnd && isReplayable(e.val))
        .sort((a, b) => a.ts - b.ts);

    const actions: PlannedAction[] = [];
    let previousVal = lastValue;
    let previousAt = -Infinity;
    for (const e of sorted) {
        if (e.val === previousVal) {
            continue;
        }
        const shift = opts.jitterMs > 0 ? Math.round((random() * 2 - 1) * opts.jitterMs) : 0;
        const at = Math.max(e.ts + opts.deltaMs + shift, notBefore, previousAt + MIN_GAP_MS);
        actions.push({ id, at, val: e.val, recordedAt: e.ts });
        previousVal = e.val;
        previousAt = at;
    }
    return actions;
}
