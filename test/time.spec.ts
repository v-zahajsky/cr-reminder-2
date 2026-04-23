import { describe, expect, it } from 'vitest';

import { humanDuration, msToDays } from '../src/utils/time.js';

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
