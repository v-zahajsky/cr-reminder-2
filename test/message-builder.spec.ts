import { describe, expect, it } from 'vitest';

import { buildSlackMessage, escapeSlack, formatLine, severityEmoji } from '../src/message/builder.js';
import type { PrRecord } from '../src/types.js';

function makePr(overrides: Partial<PrRecord> = {}): PrRecord {
	return {
		repo: { owner: 'apify-store', name: 'google-maps' },
		number: 1638,
		title: 'Add dataset schema and output schema',
		url: 'https://github.com/apify-store/google-maps/pull/1638',
		authorLogin: 'oklinov',
		createdAt: '2026-04-19T00:00:00Z',
		readyForReviewAt: '2026-04-19T00:00:00Z',
		isDraft: false,
		labels: [],
		body: '',
		linkedIssueNumbers: [],
		durationMs: 4 * 86_400_000 + 1 * 3_600_000 + 46 * 60_000,
		durationDays: 4,
		durationHuman: '4d 1h 46m',
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

describe('formatLine', () => {
	it('renders tag when Slack ID is known', () => {
		const line = formatLine(makePr(), 'U123');
		expect(line).toBe(
			':warning: <https://github.com/apify-store/google-maps/pull/1638|Add dataset schema and output schema> - 4d 1h 46m (<@U123>)',
		);
	});

	it('falls back to @login when mapping missing', () => {
		const line = formatLine(makePr(), null);
		expect(line).toContain('(@oklinov)');
	});

	it('uses :scream: for scream severity', () => {
		const line = formatLine(makePr({ severity: 'scream' }), 'U9');
		expect(line.startsWith(':scream: ')).toBe(true);
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
				durationHuman: '13d 1h 30m',
				number: 1507,
				url: 'https://github.com/apify-store/google-maps/pull/1507',
			}),
			makePr(),
		];
		const msg = buildSlackMessage(prs, { radimkvet: 'U1', oklinov: 'U2' }, 'Pull requests in review:');
		expect(msg).toBe(
			[
				'Pull requests in review:',
				'',
				':scream: <https://github.com/apify-store/google-maps/pull/1507|Business Lead Enrichment - Email Verification> - 13d 1h 30m (<@U1>)',
				':warning: <https://github.com/apify-store/google-maps/pull/1638|Add dataset schema and output schema> - 4d 1h 46m (<@U2>)',
			].join('\n'),
		);
	});

	it('emits friendly fallback when PR list is empty', () => {
		const msg = buildSlackMessage([], {}, 'Pull requests in review:');
		expect(msg).toContain('No open PRs awaiting review');
	});
});
