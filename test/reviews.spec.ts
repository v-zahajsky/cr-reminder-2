import { describe, expect, it } from 'vitest';

import type { RawReview } from '../src/clients/github.js';
import { resolveIterationStart, summarizeReviews } from '../src/runner.js';

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
