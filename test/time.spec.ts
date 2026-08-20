import { describe, expect, it } from 'vitest';

import { businessElapsedMs, humanDuration, msToDays } from '../src/utils/time.js';

describe('humanDuration', () => {
	it('returns "0m" for zero ms', () => {
		expect(humanDuration(0)).toBe('0m');
	});

	it('rounds sub-minute to 0m', () => {
		expect(humanDuration(59_000)).toBe('0m');
	});

	it('formats minutes only', () => {
		expect(humanDuration(5 * 60_000)).toBe('5m');
	});

	it('formats hours + minutes', () => {
		expect(humanDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
	});

	it('formats full "13d 1h 30m" like in the spec', () => {
		const ms = 13 * 86_400_000 + 1 * 3_600_000 + 30 * 60_000;
		expect(humanDuration(ms)).toBe('13d 1h 30m');
	});

	it('omits zero hour segment', () => {
		const ms = 4 * 86_400_000 + 0 * 3_600_000 + 12 * 60_000;
		expect(humanDuration(ms)).toBe('4d 12m');
	});
});

describe('msToDays', () => {
	it('converts 1 day', () => {
		expect(msToDays(86_400_000)).toBe(1);
	});

	it('gives fractional days', () => {
		expect(msToDays(43_200_000)).toBe(0.5);
	});
});

describe('businessElapsedMs', () => {
	const TZ = 'Europe/Prague';

	it('returns zero for a non-positive range', () => {
		const t = Date.parse('2026-08-19T10:00:00Z');
		expect(businessElapsedMs(t, t, TZ)).toBe(0);
		expect(businessElapsedMs(t, t - 1000, TZ)).toBe(0);
	});

	it('passes weekday time through untouched', () => {
		const from = Date.parse('2026-08-19T08:00:00Z'); // Wednesday
		const to = Date.parse('2026-08-20T08:00:00Z'); // Thursday
		expect(businessElapsedMs(from, to, TZ)).toBe(86_400_000);
	});

	it('drops both weekend days from a Friday-to-Monday span', () => {
		const friday = Date.parse('2026-08-21T13:00:00Z'); // Friday 15:00 Prague
		const monday = Date.parse('2026-08-24T13:00:00Z'); // Monday 15:00 Prague
		// 3 calendar days, but Saturday and Sunday do not count.
		expect(businessElapsedMs(friday, monday, TZ)).toBe(86_400_000);
	});

	it('ignores a weekend fully contained in the span', () => {
		const thursday = Date.parse('2026-08-20T10:00:00Z');
		const tuesday = Date.parse('2026-08-25T10:00:00Z');
		expect(businessElapsedMs(thursday, tuesday, TZ)).toBe(3 * 86_400_000);
	});

	it('respects the time zone when placing the weekend boundary', () => {
		// Saturday 00:30 Prague is still Friday 22:30 UTC — the zone decides.
		const from = Date.parse('2026-08-21T21:00:00Z'); // Friday 23:00 Prague
		const to = Date.parse('2026-08-21T23:00:00Z'); // Saturday 01:00 Prague
		expect(businessElapsedMs(from, to, TZ)).toBe(3_600_000);
		expect(businessElapsedMs(from, to, 'UTC')).toBe(2 * 3_600_000);
	});
});
