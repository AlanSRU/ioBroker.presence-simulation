import { expect } from 'chai';
import { clock, dateTime } from './format';

describe('format', () => {
    const t = new Date(2026, 8, 6, 8, 4, 9).getTime(); // local time, 6 Sep 2026 08:04:09
    it('formats a 24-hour clock with leading zeros', () => {
        expect(clock(t)).to.equal('08:04:09');
    });
    it('formats an unambiguous date and time', () => {
        expect(dateTime(t)).to.equal('2026-09-06 08:04');
    });
});
