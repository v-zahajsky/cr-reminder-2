const DAY_MS = 86_400_000;

/**
 * Offset between the given instant and how a wall clock in `timeZone` reads it.
 * Derived from Intl rather than hard-coded, so DST is handled per instant.
 */
function tzOffsetMs(ms: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(new Date(ms));
	const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
	// Some engines render midnight as hour 24 when hour12 is false.
	const hour = get('hour') === 24 ? 0 : get('hour');
	return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - ms;
}

/**
 * Elapsed milliseconds between two instants, ignoring whole Saturdays and Sundays
 * as they fall in `timeZone`. Nobody reviews at the weekend, so a PR that went ready
 * on Friday should not look two days stale on Monday morning.
 */
export function businessElapsedMs(startMs: number, endMs: number, timeZone: string): number {
	if (!(endMs > startMs)) return 0;
	let total = 0;
	let cursor = startMs;
	// Walk one local calendar day at a time; the offset is re-read each step so DST cannot drift.
	while (cursor < endMs) {
		const offset = tzOffsetMs(cursor, timeZone);
		const local = cursor + offset;
		const localDayStart = Math.floor(local / DAY_MS) * DAY_MS;
		let nextMidnight = localDayStart + DAY_MS - offset;
		const offsetAtMidnight = tzOffsetMs(nextMidnight, timeZone);
		if (offsetAtMidnight !== offset) nextMidnight = localDayStart + DAY_MS - offsetAtMidnight;
		if (nextMidnight <= cursor) nextMidnight = cursor + DAY_MS;

		const segmentEnd = Math.min(nextMidnight, endMs);
		const weekday = new Date(local).getUTCDay();
		if (weekday !== 0 && weekday !== 6) total += segmentEnd - cursor;
		cursor = segmentEnd;
	}
	return total;
}

/** Fails with a readable message instead of a bare RangeError deep inside a run. */
export function assertValidTimeZone(timeZone: string): void {
	try {
		Intl.DateTimeFormat(undefined, { timeZone });
	} catch {
		throw new Error(`timeZone "${timeZone}" is not a valid IANA time zone name (for example "Europe/Prague").`);
	}
}

export function msToMinutes(ms: number): number {
	return Math.floor(ms / 60000);
}

export function msToHours(ms: number): number {
	return ms / 3600000;
}

export function msToDays(ms: number): number {
	return ms / 86_400_000;
}

export function humanDuration(ms: number): string {
	const totalMinutes = Math.floor(ms / 60000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes - days * 24 * 60) / 60);
	const minutes = totalMinutes % 60;
	const parts: string[] = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	parts.push(`${minutes}m`);
	return parts.join(' ');
}
