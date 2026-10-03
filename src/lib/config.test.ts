import { expect } from 'chai';
import { clampNumber, readSettings, matchesTrigger, isInstanceId, LIMITS } from './config';

describe('config.clampNumber', () => {
    it('clamps into range and rounds', () => {
        expect(clampNumber(0, LIMITS.days)).to.equal(1);
        expect(clampNumber(99, LIMITS.days)).to.equal(28);
        expect(clampNumber(6.6, LIMITS.days)).to.equal(7);
    });
    it('accepts numeric strings', () => {
        expect(clampNumber('120', LIMITS.jitterSec)).to.equal(120);
    });
    it('uses the default for anything that is not a number, including blanks', () => {
        for (const raw of [undefined, null, '', '  ', 'abc', NaN, {}]) {
            expect(clampNumber(raw, LIMITS.days)).to.equal(7);
        }
    });
    it('keeps a genuine zero where zero is allowed', () => {
        expect(clampNumber(0, LIMITS.jitterSec)).to.equal(0);
    });
});

describe('config.readSettings', () => {
    it('reads a typical config', () => {
        const s = readSettings({
            states: [{ enabled: true, id: 'alias.0.lamp.on', name: 'Lamp' }],
            historyInstance: 'history.0',
            days: 7,
            jitter: 300,
            restore: true,
            triggerId: 'tado.0.1.Home.state.presence',
            triggerValue: 'AWAY',
        });
        expect(s.states).to.deep.equal([{ id: 'alias.0.lamp.on', name: 'Lamp' }]);
        expect(s.deltaMs).to.equal(7 * 24 * 3600_000);
        expect(s.jitterMs).to.equal(300_000);
        expect(s.restore).to.equal(true);
        expect(s.triggerValue).to.equal('AWAY');
    });
    it('skips disabled, blank and duplicate rows, and names by id when no name is given', () => {
        const s = readSettings({
            states: [
                { enabled: false, id: 'a' },
                { enabled: true, id: '  ' },
                { enabled: true, id: 'b' },
                { id: 'b', name: 'again' },
                null,
            ],
        });
        expect(s.states).to.deep.equal([{ id: 'b', name: 'b' }]);
    });
    it('falls back to safe defaults for missing or invalid values', () => {
        const s = readSettings({ historyInstance: 'not an instance', days: 'x', jitter: -5 });
        expect(s.historyInstance).to.equal('');
        expect(s.deltaMs).to.equal(7 * 24 * 3600_000);
        expect(s.jitterMs).to.equal(0);
        expect(s.restore).to.equal(true);
        expect(s.states).to.deep.equal([]);
    });
});

describe('config.isInstanceId', () => {
    it('accepts adapter instance ids only', () => {
        expect(isInstanceId('history.0')).to.equal(true);
        expect(isInstanceId('sql.12')).to.equal(true);
        expect(isInstanceId('history')).to.equal(false);
        expect(isInstanceId('history.0.x')).to.equal(false);
    });
});

describe('config.matchesTrigger', () => {
    it('compares as text, ignoring case', () => {
        expect(matchesTrigger('AWAY', 'away')).to.equal(true);
        expect(matchesTrigger(true, 'true')).to.equal(true);
        expect(matchesTrigger(1, '1')).to.equal(true);
        expect(matchesTrigger('HOME', 'AWAY')).to.equal(false);
    });
    it('never matches a missing value or an empty setting', () => {
        expect(matchesTrigger(null, 'AWAY')).to.equal(false);
        expect(matchesTrigger(undefined, 'AWAY')).to.equal(false);
        expect(matchesTrigger('AWAY', '')).to.equal(false);
    });
});
