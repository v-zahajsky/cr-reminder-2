import { describe, expect, it } from 'vitest';

import { applyModeFilter, getSeverity, shouldIncludePr, toPrRecord, type EnrichedPr } from '../src/runner.js';
import type { PrRecord } from '../src/types.js';

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
		...overrides,
	};
}

function makeEnriched(overrides: Partial<EnrichedPr> = {}): EnrichedPr {
	return {
		raw: makeRaw(),
		repo: { owner: 'x', name: 'y' },
		readyForReviewAt: '2026-04-19T00:00:00Z',
		linkedIssueLabels: new Map(),
		...overrides,
	};
}

describe('getSeverity', () => {
	it('returns ok below warning threshold', () => {
		expect(getSeverity(2, 3, 7)).toBe('ok');
	});
	it('returns warning at or above warning threshold', () => {
		expect(getSeverity(3, 3, 7)).toBe('warning');
		expect(getSeverity(6.9, 3, 7)).toBe('warning');
	});
	it('returns scream at or above scream threshold', () => {
		expect(getSeverity(7, 3, 7)).toBe('scream');
		expect(getSeverity(13.5, 3, 7)).toBe('scream');
	});
});

describe('shouldIncludePr', () => {
	it('drops draft PRs', () => {
		const e = makeEnriched({ raw: makeRaw({ draft: true }), linkedIssueLabels: new Map([[1, []]]) });
		expect(shouldIncludePr(e, ['blocked'])).toBe(false);
	});

	it('drops PR without any linked issue', () => {
		const e = makeEnriched({ linkedIssueLabels: new Map() });
		expect(shouldIncludePr(e, ['blocked'])).toBe(false);
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
		const e = makeEnriched({ readyForReviewAt: '2026-04-20T00:00:00Z' });
		const r = toPrRecord(e, now, 3, 7);
		expect(r.durationDays).toBe(3);
		expect(r.severity).toBe('warning');
		expect(r.durationHuman).toBe('3d 0m');
	});

	it('clamps negative durations to 0', () => {
		const now = Date.parse('2026-04-19T00:00:00Z');
		const e = makeEnriched({ readyForReviewAt: '2026-04-20T00:00:00Z' });
		const r = toPrRecord(e, now, 3, 7);
		expect(r.durationMs).toBe(0);
		expect(r.severity).toBe('ok');
	});
});

describe('applyModeFilter', () => {
	function makeRec(days: number): PrRecord {
		return {
			repo: { owner: 'x', name: 'y' },
			number: 1,
			title: 't',
			url: 'u',
			authorLogin: 'a',
			createdAt: '',
			readyForReviewAt: '',
			isDraft: false,
			labels: [],
			body: '',
			linkedIssueNumbers: [],
			durationMs: days * 86_400_000,
			durationDays: days,
			durationHuman: `${days}d 0m`,
			severity: days >= 7 ? 'scream' : days >= 3 ? 'warning' : 'ok',
		};
	}

	it('returns all records in "all" mode', () => {
		const recs = [makeRec(0.5), makeRec(5), makeRec(10)];
		expect(applyModeFilter(recs, 'all', 3)).toHaveLength(3);
	});

	it('keeps only records >= overdueThresholdDays in "overdue" mode', () => {
		const recs = [makeRec(2), makeRec(3), makeRec(10)];
		expect(applyModeFilter(recs, 'overdue', 3).map((r) => r.durationDays)).toEqual([3, 10]);
	});
});
