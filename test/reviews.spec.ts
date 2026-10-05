import { describe, expect, it } from 'vitest';

import {
	type RawReview,
	type ReviewTimestamps,
	scanReviewTimeline,
	type TimelineEvent,
} from '../src/clients/github.js';
import { resolveIterationStart, resolvePrClocks, resolveReviewStart, summarizeReviews } from '../src/runner.js';

function review(login: string, state: string, submittedAt: string): RawReview {
	return { login, state, submittedAt };
}

describe('resolveIterationStart', () => {
	it('falls back to readyForReviewAt when review was never re-requested', () => {
		expect(resolveIterationStart('2026-04-10T00:00:00Z', null)).toBe('2026-04-10T00:00:00Z');
	});

	it('uses the review request when it is newer', () => {
		expect(resolveIterationStart('2026-04-10T00:00:00Z', '2026-04-20T00:00:00Z')).toBe('2026-04-20T00:00:00Z');
	});

	it('ignores a review request made before the PR became reviewable', () => {
		// Reviewers requested while still a draft — the round starts when the PR went ready.
		expect(resolveIterationStart('2026-04-20T00:00:00Z', '2026-04-10T00:00:00Z')).toBe('2026-04-20T00:00:00Z');
	});
});

function event(name: string, createdAt: string): TimelineEvent {
	return { event: name, created_at: createdAt };
}

describe('scanReviewTimeline', () => {
	it('takes the latest ready_for_review and review_requested', () => {
		expect(
			scanReviewTimeline([
				event('ready_for_review', '2026-04-10T00:00:00Z'),
				event('review_requested', '2026-04-11T00:00:00Z'),
				event('ready_for_review', '2026-04-12T00:00:00Z'),
				event('review_requested', '2026-04-09T00:00:00Z'),
			]),
		).toMatchObject({
			readyForReviewAt: '2026-04-12T00:00:00Z',
			lastReviewRequestedAt: '2026-04-11T00:00:00Z',
		});
	});

	it('counts the reopens and reports the latest one', () => {
		const scanned = scanReviewTimeline([
			event('closed', '2026-04-11T00:00:00Z'),
			event('reopened', '2026-04-12T00:00:00Z'),
			event('closed', '2026-04-13T00:00:00Z'),
			event('reopened', '2026-04-20T00:00:00Z'),
		]);
		expect(scanned.reopenedCount).toBe(2);
		expect(scanned.lastReopenedAt).toBe('2026-04-20T00:00:00Z');
	});

	it('reports no reopen for a PR that was never closed', () => {
		const scanned = scanReviewTimeline([event('ready_for_review', '2026-04-10T00:00:00Z')]);
		expect(scanned.reopenedCount).toBe(0);
		expect(scanned.lastReopenedAt).toBe(null);
	});

	it('ignores an event with no timestamp', () => {
		expect(scanReviewTimeline([{ event: 'reopened' }]).reopenedCount).toBe(0);
	});
});

describe('resolveReviewStart', () => {
	it('keeps the ready timestamp when the PR was never reopened', () => {
		expect(resolveReviewStart('2026-04-10T00:00:00Z', null)).toBe('2026-04-10T00:00:00Z');
	});

	it('restarts the clock at the reopen', () => {
		// The days the PR spent closed were nobody's review time.
		expect(resolveReviewStart('2026-04-10T00:00:00Z', '2026-04-20T00:00:00Z')).toBe('2026-04-20T00:00:00Z');
	});

	it('ignores a reopen that predates the PR becoming reviewable', () => {
		// Reopened, then pushed back to draft and readied again — the later event wins.
		expect(resolveReviewStart('2026-04-20T00:00:00Z', '2026-04-10T00:00:00Z')).toBe('2026-04-20T00:00:00Z');
	});
});

function timestamps(over: Partial<ReviewTimestamps> = {}): ReviewTimestamps {
	return {
		readyForReviewAt: null,
		lastReviewRequestedAt: null,
		lastReopenedAt: null,
		reopenedCount: 0,
		...over,
	};
}

describe('resolvePrClocks', () => {
	it('falls back to the creation time when the PR was never a draft', () => {
		expect(resolvePrClocks('2026-04-10T00:00:00Z', timestamps())).toEqual({
			readyForReviewAt: '2026-04-10T00:00:00Z',
			iterationStartedAt: '2026-04-10T00:00:00Z',
		});
	});

	it('restarts the round at the reopen too, not just the total age', () => {
		// The round must never predate the total age, so the re-request from before the
		// reopen cannot stay as the round start.
		expect(
			resolvePrClocks(
				'2026-04-01T00:00:00Z',
				timestamps({
					readyForReviewAt: '2026-04-10T00:00:00Z',
					lastReviewRequestedAt: '2026-04-11T00:00:00Z',
					lastReopenedAt: '2026-04-20T00:00:00Z',
					reopenedCount: 1,
				}),
			),
		).toEqual({
			readyForReviewAt: '2026-04-20T00:00:00Z',
			iterationStartedAt: '2026-04-20T00:00:00Z',
		});
	});

	it('keeps a review requested after the reopen as the round start', () => {
		expect(
			resolvePrClocks(
				'2026-04-01T00:00:00Z',
				timestamps({
					readyForReviewAt: '2026-04-10T00:00:00Z',
					lastReviewRequestedAt: '2026-04-22T00:00:00Z',
					lastReopenedAt: '2026-04-20T00:00:00Z',
					reopenedCount: 1,
				}),
			),
		).toEqual({
			readyForReviewAt: '2026-04-20T00:00:00Z',
			iterationStartedAt: '2026-04-22T00:00:00Z',
		});
	});
});

describe('summarizeReviews', () => {
	it('reports nobody involved when there are no reviews and no requests', () => {
		expect(summarizeReviews([], [], 0, 'alice')).toEqual({
			approvedBy: [],
			approvedCount: 0,
			reviewerCount: 0,
			reviewedByCount: 0,
		});
	});

	it('counts a reviewer who already approved, even though GitHub dropped them from requested_reviewers', () => {
		const s = summarizeReviews([review('bob', 'APPROVED', '2026-04-20T00:00:00Z')], [], 0, 'alice');
		expect(s.approvedCount).toBe(1);
		expect(s.reviewerCount).toBe(1);
	});

	it('adds still-pending requested reviewers to the denominator', () => {
		const s = summarizeReviews([review('bob', 'APPROVED', '2026-04-20T00:00:00Z')], ['carol'], 0, 'alice');
		expect(s.approvedCount).toBe(1);
		expect(s.reviewerCount).toBe(2);
		expect(s.approvedBy).toEqual(['bob']);
	});

	it('does not double-count a reviewer who reviewed and was asked again', () => {
		const s = summarizeReviews([review('bob', 'CHANGES_REQUESTED', '2026-04-20T00:00:00Z')], ['bob'], 0, 'alice');
		expect(s.approvedCount).toBe(0);
		expect(s.reviewerCount).toBe(1);
	});

	it('uses each reviewer latest decisive review', () => {
		const s = summarizeReviews(
			[
				review('bob', 'CHANGES_REQUESTED', '2026-04-20T00:00:00Z'),
				review('bob', 'APPROVED', '2026-04-22T00:00:00Z'),
			],
			[],
			0,
			'alice',
		);
		expect(s.approvedCount).toBe(1);
	});

	it('does not let a later comment clear an approval', () => {
		const s = summarizeReviews(
			[review('bob', 'APPROVED', '2026-04-20T00:00:00Z'), review('bob', 'COMMENTED', '2026-04-22T00:00:00Z')],
			[],
			0,
			'alice',
		);
		expect(s.approvedCount).toBe(1);
		expect(s.reviewerCount).toBe(1);
	});

	it('counts a comment-only reviewer in the denominator but not as an approval', () => {
		const s = summarizeReviews([review('bob', 'COMMENTED', '2026-04-20T00:00:00Z')], [], 0, 'alice');
		expect(s.approvedCount).toBe(0);
		expect(s.reviewerCount).toBe(1);
	});

	it('does not count a dismissed approval', () => {
		const s = summarizeReviews([review('bob', 'DISMISSED', '2026-04-20T00:00:00Z')], [], 0, 'alice');
		expect(s.approvedCount).toBe(0);
		expect(s.reviewerCount).toBe(1);
	});

	it('treats an unsubmitted (pending) review as nobody having looked', () => {
		const s = summarizeReviews([review('bob', 'PENDING', '2026-04-20T00:00:00Z')], [], 0, 'alice');
		expect(s.reviewedByCount).toBe(0);
		expect(s.approvedCount).toBe(0);
		expect(s.reviewerCount).toBe(0);
	});

	it('ignores self-reviews by the PR author', () => {
		const s = summarizeReviews([review('alice', 'APPROVED', '2026-04-20T00:00:00Z')], ['alice'], 0, 'alice');
		expect(s.approvedCount).toBe(0);
		expect(s.reviewerCount).toBe(0);
	});

	it('reports nobody has looked while reviewers are only requested', () => {
		const s = summarizeReviews([], ['bob', 'carol'], 0, 'alice');
		expect(s.reviewedByCount).toBe(0);
		expect(s.reviewerCount).toBe(2);
	});

	it('counts a comment-only review as somebody having looked', () => {
		const s = summarizeReviews([review('bob', 'COMMENTED', '2026-04-20T00:00:00Z')], ['carol'], 0, 'alice');
		expect(s.reviewedByCount).toBe(1);
		expect(s.approvedCount).toBe(0);
	});

	it('does not count a self-review as somebody having looked', () => {
		const s = summarizeReviews([review('alice', 'COMMENTED', '2026-04-20T00:00:00Z')], [], 0, 'alice');
		expect(s.reviewedByCount).toBe(0);
	});

	it('counts each pending team request as one outstanding reviewer', () => {
		const s = summarizeReviews([], [], 2, 'alice');
		expect(s.reviewerCount).toBe(2);
	});

	it('aggregates several reviewers', () => {
		const s = summarizeReviews(
			[
				review('bob', 'APPROVED', '2026-04-20T00:00:00Z'),
				review('carol', 'APPROVED', '2026-04-21T00:00:00Z'),
				review('dave', 'CHANGES_REQUESTED', '2026-04-21T00:00:00Z'),
			],
			['erin'],
			0,
			'alice',
		);
		expect(s.approvedBy).toEqual(['bob', 'carol']);
		expect(s.approvedCount).toBe(2);
		expect(s.reviewerCount).toBe(4);
	});
});
