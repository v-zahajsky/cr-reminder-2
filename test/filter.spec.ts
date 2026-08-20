import { describe, expect, it } from 'vitest';

import {
	applyModeFilter,
	type EnrichedPr,
	getSeverity,
	type RecordOptions,
	resolveNotifyLogin,
	shouldIncludePr,
	toPrRecord,
	worstSeverity,
} from '../src/runner.js';
import type { PrRecord } from '../src/types.js';
import { isBotLogin } from '../src/utils/user-mapping.js';

const THRESHOLDS: RecordOptions = {
	warningThresholdHours: 72,
	screamThresholdHours: 168,
	iterationWarningThresholdHours: 72,
	iterationScreamThresholdHours: 168,
	// Most cases below are about thresholds, not calendars — keep raw elapsed time there.
	skipWeekends: false,
	timeZone: 'Europe/Prague',
};

function makeRaw(overrides: Partial<EnrichedPr['raw']> = {}): EnrichedPr['raw'] {
	return {
		number: 1,
		title: 'Example PR',
		html_url: 'https://github.com/x/y/pull/1',
		user: { login: 'alice' },
		body: '',
		created_at: '2026-04-19T00:00:00Z',
		draft: false,
		labels: [],
		requested_reviewers: [],
		requested_teams: [],
		...overrides,
	};
}

function makeEnriched(overrides: Partial<EnrichedPr> = {}): EnrichedPr {
	return {
		raw: makeRaw(),
		repo: { owner: 'x', name: 'y' },
		readyForReviewAt: '2026-04-19T00:00:00Z',
		iterationStartedAt: '2026-04-19T00:00:00Z',
		review: { approvedBy: [], approvedCount: 0, reviewerCount: 0, reviewedByCount: 0 },
		linkedIssueLabels: new Map(),
		linkedIssueAssignees: [],
		...overrides,
	};
}

describe('getSeverity', () => {
	it('returns ok below warning threshold', () => {
		expect(getSeverity(48, 72, 168)).toBe('ok');
	});
	it('returns warning at or above warning threshold', () => {
		expect(getSeverity(72, 72, 168)).toBe('warning');
		expect(getSeverity(167, 72, 168)).toBe('warning');
	});
	it('returns scream at or above scream threshold', () => {
		expect(getSeverity(168, 72, 168)).toBe('scream');
		expect(getSeverity(324, 72, 168)).toBe('scream');
	});
});

describe('isBotLogin', () => {
	it('recognises the GitHub app suffix', () => {
		expect(isBotLogin('claude[bot]')).toBe(true);
		expect(isBotLogin('dependabot[bot]')).toBe(true);
		expect(isBotLogin('radimkvet')).toBe(false);
		// A human whose name merely mentions a bot is still a human.
		expect(isBotLogin('bot-enthusiast')).toBe(false);
	});
});

describe('resolveNotifyLogin', () => {
	it('keeps a human author even when the ticket is assigned elsewhere', () => {
		expect(resolveNotifyLogin('radimkvet', ['oklinov'])).toBe('radimkvet');
	});

	it('redirects a bot-authored PR to the linked ticket assignee', () => {
		expect(resolveNotifyLogin('claude[bot]', ['oklinov'])).toBe('oklinov');
	});

	it('uses the first assignee when the ticket has several', () => {
		expect(resolveNotifyLogin('claude[bot]', ['oklinov', 'radimkvet'])).toBe('oklinov');
	});

	it('falls back to the bot when no linked ticket has an assignee', () => {
		expect(resolveNotifyLogin('claude[bot]', [])).toBe('claude[bot]');
	});
});

describe('worstSeverity', () => {
	it('picks the more severe of the two', () => {
		expect(worstSeverity('ok', 'warning')).toBe('warning');
		expect(worstSeverity('scream', 'ok')).toBe('scream');
		expect(worstSeverity('warning', 'scream')).toBe('scream');
		expect(worstSeverity('ok', 'ok')).toBe('ok');
	});
});

describe('shouldIncludePr', () => {
	it('drops draft PRs', () => {
		const e = makeEnriched({ raw: makeRaw({ draft: true }), linkedIssueLabels: new Map([[1, []]]) });
		expect(shouldIncludePr(e, ['blocked'])).toBe(false);
	});

	it('keeps a PR with no linked issue — every review must be visible', () => {
		const e = makeEnriched({ linkedIssueLabels: new Map() });
		expect(shouldIncludePr(e, ['blocked'])).toBe(true);
	});

	it('drops a PR with no linked issue when requireLinkedIssue is on', () => {
		const e = makeEnriched({ linkedIssueLabels: new Map() });
		expect(shouldIncludePr(e, ['blocked'], true)).toBe(false);
	});

	it('keeps a linked PR when requireLinkedIssue is on', () => {
		const e = makeEnriched({ linkedIssueLabels: new Map([[42, ['bug']]]) });
		expect(shouldIncludePr(e, ['blocked'], true)).toBe(true);
	});

	it('drops PR with blocked label', () => {
		const e = makeEnriched({
			raw: makeRaw({ labels: [{ name: 'blocked' }] }),
			linkedIssueLabels: new Map([[1, []]]),
		});
		expect(shouldIncludePr(e, ['blocked'])).toBe(false);
	});

	it('drops PR whose linked issue has blocked label', () => {
		const e = makeEnriched({ linkedIssueLabels: new Map([[42, ['bug', 'blocked']]]) });
		expect(shouldIncludePr(e, ['blocked'])).toBe(false);
	});

	it('includes non-draft PR with neutral labels and unblocked linked issues', () => {
		const e = makeEnriched({
			raw: makeRaw({ labels: [{ name: 'bug' }] }),
			linkedIssueLabels: new Map([[42, ['bug']]]),
		});
		expect(shouldIncludePr(e, ['blocked'])).toBe(true);
	});

	it('honors ignoreLabels case-sensitively (GitHub labels are case-sensitive)', () => {
		const e = makeEnriched({
			raw: makeRaw({ labels: [{ name: 'Blocked' }] }),
			linkedIssueLabels: new Map([[1, []]]),
		});
		// GitHub labels are case-sensitive; our match is literal.
		expect(shouldIncludePr(e, ['blocked'])).toBe(true);
		expect(shouldIncludePr(e, ['Blocked'])).toBe(false);
	});
});

describe('toPrRecord', () => {
	it('computes duration and severity from readyForReviewAt', () => {
		const now = Date.parse('2026-04-23T00:00:00Z');
		const e = makeEnriched({
			readyForReviewAt: '2026-04-20T00:00:00Z',
			iterationStartedAt: '2026-04-20T00:00:00Z',
		});
		const r = toPrRecord(e, now, THRESHOLDS);
		expect(r.durationHours).toBe(72);
		expect(r.severity).toBe('warning');
		expect(r.durationHuman).toBe('3d 0m');
	});

	it('clamps negative durations to 0', () => {
		const now = Date.parse('2026-04-19T00:00:00Z');
		const e = makeEnriched({
			readyForReviewAt: '2026-04-20T00:00:00Z',
			iterationStartedAt: '2026-04-20T00:00:00Z',
		});
		const r = toPrRecord(e, now, THRESHOLDS);
		expect(r.durationMs).toBe(0);
		expect(r.severity).toBe('ok');
	});

	it('tracks the current round separately from the total age', () => {
		const now = Date.parse('2026-04-30T00:00:00Z');
		const e = makeEnriched({
			readyForReviewAt: '2026-04-10T00:00:00Z',
			iterationStartedAt: '2026-04-29T00:00:00Z',
		});
		const r = toPrRecord(e, now, THRESHOLDS);
		expect(r.durationHours).toBe(480);
		expect(r.iterationHours).toBe(24);
		expect(r.iterationHuman).toBe('1d 0m');
	});

	it('takes the worse of the total and iteration severities', () => {
		const now = Date.parse('2026-04-30T00:00:00Z');
		// Total is 20 days (scream), current round only 1 day (ok) -> scream wins.
		const stale = makeEnriched({
			readyForReviewAt: '2026-04-10T00:00:00Z',
			iterationStartedAt: '2026-04-29T00:00:00Z',
		});
		expect(toPrRecord(stale, now, THRESHOLDS).severity).toBe('scream');

		// A tight iteration limit escalates a PR that the total-age limits would call ok.
		const fresh = makeEnriched({
			readyForReviewAt: '2026-04-29T00:00:00Z',
			iterationStartedAt: '2026-04-29T00:00:00Z',
		});
		const r = toPrRecord(fresh, now, {
			...THRESHOLDS,
			iterationWarningThresholdHours: 24,
			iterationScreamThresholdHours: 48,
		});
		expect(r.severity).toBe('warning');
	});

	it('carries the review summary through', () => {
		const now = Date.parse('2026-04-23T00:00:00Z');
		const e = makeEnriched({
			review: { approvedBy: ['bob'], approvedCount: 1, reviewerCount: 2, reviewedByCount: 1 },
		});
		const r = toPrRecord(e, now, THRESHOLDS);
		expect(r.approvedCount).toBe(1);
		expect(r.reviewerCount).toBe(2);
		expect(r.reviewedByCount).toBe(1);
		expect(r.approvedBy).toEqual(['bob']);
	});

	it('tags the ticket assignee instead of the bot that opened the PR', () => {
		const now = Date.parse('2026-04-23T00:00:00Z');
		const e = makeEnriched({
			raw: makeRaw({ user: { login: 'claude[bot]' } }),
			linkedIssueAssignees: ['oklinov'],
		});
		const r = toPrRecord(e, now, THRESHOLDS);
		expect(r.authorLogin).toBe('claude[bot]');
		expect(r.notifyLogin).toBe('oklinov');
	});
});

describe('weekend handling', () => {
	const WEEKEND_AWARE: RecordOptions = { ...THRESHOLDS, skipWeekends: true };

	function readyAt(iso: string): EnrichedPr {
		return makeEnriched({ readyForReviewAt: iso, iterationStartedAt: iso });
	}

	// 2026-08-21 is a Friday, 2026-08-24 a Monday, 2026-08-25 a Tuesday (Europe/Prague).
	it('does not count the weekend, so a Friday PR is still fresh on Monday morning', () => {
		const pr = readyAt('2026-08-21T13:00:00Z'); // Friday 15:00 Prague
		const mondayMorning = Date.parse('2026-08-24T07:00:00Z'); // Monday 09:00 Prague
		const r = toPrRecord(pr, mondayMorning, WEEKEND_AWARE);
		// 9h of Friday plus 9h of Monday — under the 24h bar.
		expect(r.durationHours).toBeCloseTo(18, 5);
		expect(r.durationWallMs).toBe(mondayMorning - Date.parse('2026-08-21T13:00:00Z'));
	});

	it('reports that same Friday PR on Tuesday', () => {
		const pr = readyAt('2026-08-21T13:00:00Z');
		const tuesdayMorning = Date.parse('2026-08-25T07:00:00Z');
		const r = toPrRecord(pr, tuesdayMorning, WEEKEND_AWARE);
		expect(r.durationHours).toBeCloseTo(42, 5);
		expect(r.durationHours).toBeGreaterThanOrEqual(24);
	});

	it('counts no time at all across a pure weekend', () => {
		const pr = readyAt('2026-08-22T06:00:00Z'); // Saturday
		const sundayEvening = Date.parse('2026-08-23T18:00:00Z');
		expect(toPrRecord(pr, sundayEvening, WEEKEND_AWARE).durationMs).toBe(0);
	});

	it('counts calendar time when skipWeekends is off', () => {
		const pr = readyAt('2026-08-21T13:00:00Z');
		const mondayMorning = Date.parse('2026-08-24T07:00:00Z');
		expect(toPrRecord(pr, mondayMorning, THRESHOLDS).durationHours).toBeCloseTo(66, 5);
	});
});

describe('applyModeFilter', () => {
	function severityFor(hours: number): PrRecord['severity'] {
		if (hours >= 168) return 'scream';
		if (hours >= 72) return 'warning';
		return 'ok';
	}

	function makeRec(hours: number, iterationHours = hours): PrRecord {
		return {
			repo: { owner: 'x', name: 'y' },
			number: 1,
			title: 't',
			url: 'u',
			authorLogin: 'a',
			notifyLogin: 'a',
			linkedIssueAssignees: [],
			createdAt: '',
			readyForReviewAt: '',
			iterationStartedAt: '',
			isDraft: false,
			labels: [],
			body: '',
			linkedIssueNumbers: [],
			durationMs: hours * 3_600_000,
			durationHours: hours,
			durationHuman: `${hours}h 0m`,
			durationWallMs: hours * 3_600_000,
			iterationMs: iterationHours * 3_600_000,
			iterationHours,
			iterationHuman: `${iterationHours}h 0m`,
			iterationWallMs: iterationHours * 3_600_000,
			approvedBy: [],
			approvedCount: 0,
			reviewerCount: 0,
			reviewedByCount: 0,
			severity: severityFor(hours),
		};
	}

	it('returns all records in "all" mode', () => {
		const recs = [makeRec(12), makeRec(120), makeRec(240)];
		expect(applyModeFilter(recs, 'all', 24, 24)).toHaveLength(3);
	});

	it('keeps only records >= overdueThresholdHours in "overdue" mode', () => {
		// The 24h baseline: a PR nobody looked at within a day shows up, a 23h-old one does not.
		const recs = [makeRec(23), makeRec(24), makeRec(240)];
		expect(applyModeFilter(recs, 'overdue', 24, 24).map((r) => r.durationHours)).toEqual([24, 240]);
	});

	it('keeps a young PR whose current round already breaches the iteration limit', () => {
		// Total 12h (under the 24h total limit) but the round breaches a 6h iteration limit.
		const recs = [makeRec(12, 12)];
		expect(applyModeFilter(recs, 'overdue', 24, 6)).toHaveLength(1);
	});

	it('keeps an old PR even when its current round just started', () => {
		const recs = [makeRec(480, 2)];
		expect(applyModeFilter(recs, 'overdue', 24, 24)).toHaveLength(1);
	});
});
