/**
 * Validates and clamps the instance configuration. jsonConfig min/max only limits the admin
 * UI, so every number is clamped here as well.
 */

/** One state to replay. */
export interface SimulatedState {
    /** Full state id, e.g. alias.0.sitting.left.on */
    id: string;
    /** Label for logs and info states (the id when none is configured). */
    name: string;
}

/** Validated instance settings. */
export interface Settings {
    /** States to replay (enabled, de-duplicated). */
    states: SimulatedState[];
    /** History instance to read from, e.g. history.0 ('' when invalid). */
    historyInstance: string;
    /** How far back the replay looks, in ms. */
    deltaMs: number;
    /** Maximum random shift per change, in ms. */
    jitterMs: number;
    /** Restore the states saved at the start when the simulation stops. */
    restore: boolean;
    /** Optional state that starts/stops the simulation ('' when unused). */
    triggerId: string;
    /** Value of the trigger state that means "away". */
    triggerValue: string;
}

/** Allowed ranges and defaults of the numeric settings. */
export const LIMITS = {
    days: { min: 1, max: 28, def: 7 },
    jitterSec: { min: 0, max: 1800, def: 300 },
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Clamps a configured number into [min, max]; anything that is not a finite number uses the default.
 *
 * @param raw - configured value
 * @param limits - allowed range and default
 * @param limits.min - lowest allowed value
 * @param limits.max - highest allowed value
 * @param limits.def - value used when `raw` is not a number
 */
export function clampNumber(raw: unknown, limits: { min: number; max: number; def: number }): number {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
        return limits.def;
    }
    return Math.min(limits.max, Math.max(limits.min, Math.round(n)));
}

/**
 * An instance id such as "history.0" or "influxdb.1".
 *
 * @param s - value to check
 */
export function isInstanceId(s: unknown): s is string {
    return typeof s === 'string' && /^[a-z0-9_-]+\.\d+$/.test(s);
}

/**
 * Builds validated settings from the raw adapter config.
 *
 * @param native - the instance's native config
 */
export function readSettings(native: Record<string, unknown>): Settings {
    const rows = Array.isArray(native.states) ? (native.states as Record<string, unknown>[]) : [];
    const seen = new Set<string>();
    const states: SimulatedState[] = [];
    for (const row of rows) {
        const id = typeof row?.id === 'string' ? row.id.trim() : '';
        if (!id || row.enabled === false || seen.has(id)) {
            continue;
        }
        seen.add(id);
        states.push({ id, name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id });
    }
    return {
        states,
        historyInstance: isInstanceId(native.historyInstance) ? native.historyInstance : '',
        deltaMs: clampNumber(native.days, LIMITS.days) * DAY_MS,
        jitterMs: clampNumber(native.jitter, LIMITS.jitterSec) * 1000,
        restore: native.restore !== false,
        triggerId: typeof native.triggerId === 'string' ? native.triggerId.trim() : '',
        triggerValue: typeof native.triggerValue === 'string' ? native.triggerValue.trim() : '',
    };
}

/**
 * Whether a trigger state's value means "away". Compared as text, case-insensitively,
 * so "AWAY", true and 1 can all be matched from the config field.
 *
 * @param val - the trigger state's value
 * @param wanted - the configured "away" value
 */
export function matchesTrigger(val: unknown, wanted: string): boolean {
    if (wanted === '' || !(typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean')) {
        return false;
    }
    return String(val).trim().toLowerCase() === wanted.toLowerCase();
}
