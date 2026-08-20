import { describe, expect, it } from 'vitest';

import {
	buildSlackMessage,
	escapeSlack,
	formatApprovals,
	formatAssignee,
	formatLine,
	isNewPr,
	severityEmoji,
} from '../src/message/builder.js';
import type { PrRecord } from '../src/types.js';

const NEW_HEADER = 'New PRs — nobody has looked at these yet:';

function makePr(overrides: Partial<PrRecord> = {}): PrRecord {
	return {
		repo: { owner: 'apify-store', name: 'google-maps' },
		number: 1638,
		title: 'Add dataset schema and output schema',
		url: 'https://github.com/apify-store/google-maps/pull/1638',
		authorLogin: 'oklinov',
		notifyLogin: 'oklinov',
		linkedIssueAssignees: [],
		createdAt: '2026-04-19T00:00:00Z',
		readyForReviewAt: '2026-04-19T00:00:00Z',
		iterationStartedAt: '2026-04-19T00:00:00Z',
		isDraft: false,
		labels: [],
		body: '',
		linkedIssueNumbers: [],
		durationMs: 4 * 86_400_000 + 1 * 3_600_000 + 46 * 60_000,
		durationHours: 97.7666,
		durationHuman: '4d 1h 46m',
		durationWallMs: 4 * 86_400_000 + 1 * 3_600_000 + 46 * 60_000,
		iterationMs: 4 * 86_400_000 + 1 * 3_600_000 + 46 * 60_000,
		iterationHours: 97.7666,
		iterationHuman: '4d 1h 46m',
		iterationWallMs: 4 * 86_400_000 + 1 * 3_600_000 + 46 * 60_000,
		approvedBy: [],
		approvedCount: 0,
		reviewerCount: 2,
		reviewedByCount: 1,
		severity: 'warning',
		...overrides,
	};
}

describe('escapeSlack', () => {
	it('escapes <, >, &', () => {
		expect(escapeSlack('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
	});
});

describe('severityEmoji', () => {
	it('maps severities to emojis', () => {
		expect(severityEmoji('scream')).toBe(':scream:');
		expect(severityEmoji('warning')).toBe(':warning:');
		expect(severityEmoji('ok')).toBe(':hourglass_flowing_sand:');
	});
});

describe('formatApprovals', () => {
	it('renders the approved-of-involved ratio with the count in bold', () => {
		expect(formatApprovals(makePr({ approvedCount: 1, reviewerCount: 2 }))).toBe('*1*/2 approved');
	});

	it('flags a PR nobody is on the hook for', () => {
		expect(formatApprovals(makePr({ approvedCount: 0, reviewerCount: 0 }))).toBe('no reviewers');
	});
});

describe('formatAssignee', () => {
	it('shows just the tag for a human author', () => {
		expect(formatAssignee(makePr(), 'U1')).toBe('<@U1>');
	});

	it('names the bot behind a redirected tag', () => {
		const pr = makePr({ authorLogin: 'claude[bot]', notifyLogin: 'oklinov' });
		expect(formatAssignee(pr, 'U2')).toBe('<@U2> via claude[bot]');
	});

	it('does not repeat the bot when there was no assignee to redirect to', () => {
		const pr = makePr({ authorLogin: 'claude[bot]', notifyLogin: 'claude[bot]' });
		expect(formatAssignee(pr, null)).toBe('@claude[bot]');
	});
});

describe('formatLine', () => {
	it('renders repo, tag, both durations and the approval count', () => {
		const line = formatLine(makePr({ approvedCount: 1 }), 'U123');
		expect(line).toBe(
			':warning: [google-maps] <https://github.com/apify-store/google-maps/pull/1638|Add dataset schema and output schema> - *4d 1h 46m* (round 4d 1h 46m) - *1*/2 approved (<@U123>)',
		);
	});

	it('falls back to the notify login, not the bot author, when the mapping is missing', () => {
		const line = formatLine(makePr({ authorLogin: 'claude[bot]', notifyLogin: 'oklinov' }), null);
		expect(line).toContain('(@oklinov via claude[bot])');
	});

	it('shows the shorter current round of a long-running PR', () => {
		const line = formatLine(makePr({ durationHuman: '20d 0m', iterationHuman: '1d 2h 0m' }), 'U1');
		expect(line).toContain('*20d 0m* (round 1d 2h 0m)');
	});

	it('falls back to @login when mapping missing', () => {
		const line = formatLine(makePr(), null);
		expect(line).toContain('(@oklinov)');
	});

	it('uses :scream: for scream severity', () => {
		const line = formatLine(makePr({ severity: 'scream' }), 'U9');
		expect(line.startsWith(':scream: [google-maps] ')).toBe(true);
	});

	it('escapes < in title', () => {
		const line = formatLine(makePr({ title: 'Fix <thing>' }), 'U1');
		expect(line).toContain('|Fix &lt;thing&gt;>');
	});
});

describe('buildSlackMessage', () => {
	it('assembles header + all PR lines', () => {
		const prs = [
			makePr({
				severity: 'scream',
				title: 'Business Lead Enrichment - Email Verification',
				authorLogin: 'radimkvet',
				notifyLogin: 'radimkvet',
				durationHuman: '13d 1h 30m',
				iterationHuman: '2d 0h 15m',
				approvedCount: 1,
				reviewerCount: 2,
				number: 1507,
				url: 'https://github.com/apify-store/google-maps/pull/1507',
			}),
			makePr(),
		];
		const msg = buildSlackMessage(prs, { radimkvet: 'U1', oklinov: 'U2' }, 'Pull requests in review:', NEW_HEADER);
		expect(msg).toBe(
			[
				'Pull requests in review:',
				'',
				':scream: [google-maps] <https://github.com/apify-store/google-maps/pull/1507|Business Lead Enrichment - Email Verification> - *13d 1h 30m* (round 2d 0h 15m) - *1*/2 approved (<@U1>)',
				':warning: [google-maps] <https://github.com/apify-store/google-maps/pull/1638|Add dataset schema and output schema> - *4d 1h 46m* (round 4d 1h 46m) - *0*/2 approved (<@U2>)',
			].join('\n'),
		);
	});

	it('emits friendly fallback when PR list is empty', () => {
		const msg = buildSlackMessage([], {}, 'Pull requests in review:', NEW_HEADER);
		expect(msg).toContain('No open PRs awaiting review');
	});

	it('splits PRs nobody has reviewed into their own section', () => {
		const reviewed = makePr({ number: 1, url: 'u1', title: 'Reviewed', reviewedByCount: 2 });
		const untouched = makePr({ number: 2, url: 'u2', title: 'Untouched', reviewedByCount: 0 });
		const msg = buildSlackMessage([reviewed, untouched], {}, 'Pull requests in review:', NEW_HEADER);

		expect(msg).toBe(
			[
				'Pull requests in review:',
				'',
				formatLine(reviewed, null),
				'',
				NEW_HEADER,
				'',
				formatLine(untouched, null),
			].join('\n'),
		);
	});

	it('omits the new-PR section when everything has been looked at', () => {
		const msg = buildSlackMessage([makePr({ reviewedByCount: 1 })], {}, 'Pull requests in review:', NEW_HEADER);
		expect(msg).not.toContain(NEW_HEADER);
	});

	it('omits the main header when every PR is new', () => {
		const msg = buildSlackMessage([makePr({ reviewedByCount: 0 })], {}, 'Pull requests in review:', NEW_HEADER);
		expect(msg.startsWith(NEW_HEADER)).toBe(true);
		expect(msg).not.toContain('Pull requests in review:');
	});

	it('keeps both sections ordered as given', () => {
		const prs = [
			makePr({ number: 1, url: 'u1', reviewedByCount: 0 }),
			makePr({ number: 2, url: 'u2', reviewedByCount: 3 }),
			makePr({ number: 3, url: 'u3', reviewedByCount: 0 }),
		];
		const msg = buildSlackMessage(prs, {}, 'Header:', NEW_HEADER);
		// The reviewed one comes first even though it was second in the input.
		expect(msg.indexOf('u2')).toBeLessThan(msg.indexOf(NEW_HEADER));
		expect(msg.indexOf('u1')).toBeGreaterThan(msg.indexOf(NEW_HEADER));
		expect(msg.indexOf('u1')).toBeLessThan(msg.indexOf('u3'));
	});

	it('truncates without leaving a section header stranded', () => {
		const many = Array.from({ length: 400 }, (_, i) =>
			makePr({ number: i, url: `https://example.com/pull/${i}`, title: 'x'.repeat(300), reviewedByCount: 1 }),
		);
		const msg = buildSlackMessage(many, {}, 'Pull requests in review:', NEW_HEADER);
		expect(msg.length).toBeLessThanOrEqual(40_000);
		expect(msg).toMatch(/\.\.\.and \d+ more$/);
	});
});

describe('isNewPr', () => {
	it('is true only when nobody has submitted a review', () => {
		expect(isNewPr(makePr({ reviewedByCount: 0 }))).toBe(true);
		expect(isNewPr(makePr({ reviewedByCount: 1 }))).toBe(false);
	});
});
