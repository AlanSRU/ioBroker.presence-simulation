import { expect } from 'chai';
import { planWindow, valueAt, isReplayable, MIN_GAP_MS, type HistoryEntry } from './schedule';

const H = 3600_000;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 9, 3, 18, 0, 0); // a recorded "evening"

describe('schedule.valueAt', () => {
    const entries: HistoryEntry[] = [
        { ts: T0 - 2 * H, val: false },
        { ts: T0 - H, val: true },
        { ts: T0 + H, val: false },
    ];
    it('returns the newest value at or before t', () => {
        expect(valueAt(entries, T0)).to.equal(true);
        expect(valueAt(entries, T0 - H)).to.equal(true);
        expect(valueAt(entries, T0 + 2 * H)).to.equal(false);
    });
    it('returns undefined when the history has nothing that old', () => {
        expect(valueAt(entries, T0 - 3 * H)).to.equal(undefined);
    });
    it('skips values that cannot be written back', () => {
        const withNull = [...entries, { ts: T0 - 30 * 60_000, val: null as unknown as boolean }];
        expect(valueAt(withNull, T0)).to.equal(true);
    });
    it('keeps genuine zeros', () => {
        expect(valueAt([{ ts: T0, val: 0 }], T0)).to.equal(0);
    });
});

describe('schedule.isReplayable', () => {
    it('accepts booleans, strings and finite numbers only', () => {
        expect([true, false, 'on', 0, 42].every(isReplayable)).to.equal(true);
        expect([null, undefined, NaN, Infinity, {}, []].some(isReplayable)).to.equal(false);
    });
});

describe('schedule.planWindow', () => {
    const opts = { deltaMs: 7 * DAY, jitterMs: 0, now: T0 + 7 * DAY - H, random: () => 0.5 };

    it('replays each change exactly delta later without jitter', () => {
        const a = planWindow('x', [{ ts: T0, val: true }], T0 - H, T0 + H, false, opts);
        expect(a).to.deep.equal([{ id: 'x', at: T0 + 7 * DAY, val: true, recordedAt: T0 }]);
    });

    it('uses an exclusive window start and an inclusive window end', () => {
        const e = [
            { ts: T0, val: true },
            { ts: T0 + H, val: false },
        ];
        const a = planWindow('x', e, T0, T0 + H, undefined, opts);
        expect(a.map(x => x.recordedAt)).to.deep.equal([T0 + H]);
    });

    it('drops repeats, including a repeat of the value already being replayed', () => {
        const e = [
            { ts: T0, val: true },
            { ts: T0 + 60_000, val: true },
            { ts: T0 + 120_000, val: false },
        ];
        const a = planWindow('x', e, T0 - H, T0 + H, true, opts);
        expect(a.map(x => x.val)).to.deep.equal([false]);
    });

    it('keeps jitter within ± jitterMs', () => {
        for (const r of [0, 0.25, 0.75, 0.999999]) {
            const [a] = planWindow('x', [{ ts: T0, val: true }], T0 - H, T0 + H, false, {
                ...opts,
                jitterMs: 300_000,
                random: () => r,
            });
            expect(Math.abs(a.at - (T0 + 7 * DAY))).to.be.at.most(300_000);
        }
    });

    it('never reorders changes on the same state, even when jitter pulls them past each other', () => {
        let i = 0;
        const random = (): number => (i++ === 0 ? 0.999999 : 0); // first +5 min, second -5 min
        const e = [
            { ts: T0, val: true },
            { ts: T0 + 60_000, val: false },
        ];
        const a = planWindow('x', e, T0 - H, T0 + H, false, { ...opts, jitterMs: 300_000, random });
        expect(a.map(x => x.val)).to.deep.equal([true, false]);
        expect(a[1].at - a[0].at).to.be.at.least(MIN_GAP_MS);
    });

    it('keeps order across two windows when jitter pulls a change across the window edge', () => {
        // ON recorded 14 min into window 1, OFF 16 min in (window 2). ON jittered +5 min, OFF -5 min.
        const w = 15 * 60_000;
        const on = { ts: T0 + 14 * 60_000, val: true };
        const off = { ts: T0 + 16 * 60_000, val: false };
        const first = planWindow('x', [on, off], T0, T0 + w, false, {
            ...opts,
            jitterMs: 300_000,
            random: () => 0.999999,
        });
        const second = planWindow('x', [on, off], T0 + w, T0 + 2 * w, true, {
            ...opts,
            jitterMs: 300_000,
            random: () => 0,
            after: first[first.length - 1].at,
        });
        expect(first.map(x => x.val)).to.deep.equal([true]);
        expect(second.map(x => x.val)).to.deep.equal([false]);
        expect(second[0].at - first[0].at).to.be.at.least(MIN_GAP_MS);
    });

    it('clamps actions that would fall in the past to notBefore', () => {
        const now = T0 + 7 * DAY + H;
        const [a] = planWindow('x', [{ ts: T0, val: true }], T0 - H, T0 + H, false, { ...opts, now });
        expect(a.at).to.equal(now);
    });

    it('ignores entries that cannot be written back', () => {
        const e = [
            { ts: T0, val: null as unknown as boolean },
            { ts: T0 + 1, val: true },
        ];
        expect(planWindow('x', e, T0 - H, T0 + H, false, opts)).to.have.length(1);
    });
});
