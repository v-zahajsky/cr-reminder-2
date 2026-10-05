import { describe, expect, it } from 'vitest';

import {
	buildRepoSummary,
	buildSlackMessage,
	escapeSlack,
	formatApprovals,
	formatAssignee,
	formatLine,
	isNewPr,
	isUnassignedBotPr,
	severityEmoji,
} from '../src/message/builder.js';
import type { PrRecord } from '../src/types.js';
import { DEFAULT_TEXTS, type Texts } from '../src/utils/texts.js';

const NEW_HEADER = DEFAULT_TEXTS.newPrHeader;
const BOT_HEADER = DEFAULT_TEXTS.botPrSummaryHeader;

/** The default texts with no footer — most cases here are about the lines, not the legend. */
function t(over: Partial<Texts> = {}): Texts {
	return { ...DEFAULT_TEXTS, footer: '', ...over };
}

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
		reopenedAt: null,
		reopenedCount: 0,
		isDraft: false,
		labels: [],
		blockedLabels: [],
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
			':warning: [google-maps] <https://github.com/apify-store/google-maps/pull/1638|#1638 Add dataset schema and output schema> - *4d 1h 46m* (round 4d 1h 46m) - *1*/2 approved (<@U123>)',
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

	it('notes a PR that was reopened once', () => {
		const line = formatLine(makePr({ reopenedCount: 1 }), 'U1');
		expect(line).toContain('(round 4d 1h 46m, reopened 1×)');
	});

	it('counts repeated reopens', () => {
		const line = formatLine(makePr({ reopenedCount: 3 }), 'U1');
		expect(line).toContain('(round 4d 1h 46m, reopened 3×)');
	});

	it('says nothing about reopening on a PR that was never closed', () => {
		expect(formatLine(makePr(), 'U1')).not.toContain('reopened');
	});
	it('escapes < in title', () => {
		const line = formatLine(makePr({ title: 'Fix <thing>' }), 'U1');
		expect(line).toContain('|#1638 Fix &lt;thing&gt;>');
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
		const msg = buildSlackMessage(
			prs,
			{ radimkvet: 'U1', oklinov: 'U2' },
			t({ header: 'Pull requests in review:' }),
		);
		expect(msg).toBe(
			[
				'Pull requests in review:',
				'',
				':scream: [google-maps] <https://github.com/apify-store/google-maps/pull/1507|#1507 Business Lead Enrichment - Email Verification> - *13d 1h 30m* (round 2d 0h 15m) - *1*/2 approved (<@U1>)',
				':warning: [google-maps] <https://github.com/apify-store/google-maps/pull/1638|#1638 Add dataset schema and output schema> - *4d 1h 46m* (round 4d 1h 46m) - *0*/2 approved (<@U2>)',
			].join('\n'),
		);
	});

	it('emits friendly fallback when PR list is empty', () => {
		const msg = buildSlackMessage([], {}, t({ header: 'Pull requests in review:' }));
		expect(msg).toContain('No open PRs awaiting review');
	});

	it('splits PRs nobody has reviewed into their own section', () => {
		const reviewed = makePr({ number: 1, url: 'u1', title: 'Reviewed', reviewedByCount: 2 });
		const untouched = makePr({ number: 2, url: 'u2', title: 'Untouched', reviewedByCount: 0 });
		const msg = buildSlackMessage([reviewed, untouched], {}, t({ header: 'Pull requests in review:' }));

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
		const msg = buildSlackMessage([makePr({ reviewedByCount: 1 })], {}, t({ header: 'Pull requests in review:' }));
		expect(msg).not.toContain(NEW_HEADER);
	});

	it('omits the main header when every PR is new', () => {
		const msg = buildSlackMessage([makePr({ reviewedByCount: 0 })], {}, t({ header: 'Pull requests in review:' }));
		expect(msg.startsWith(NEW_HEADER)).toBe(true);
		expect(msg).not.toContain('Pull requests in review:');
	});

	it('keeps both sections ordered as given', () => {
		const prs = [
			makePr({ number: 1, url: 'u1', reviewedByCount: 0 }),
			makePr({ number: 2, url: 'u2', reviewedByCount: 3 }),
			makePr({ number: 3, url: 'u3', reviewedByCount: 0 }),
		];
		const msg = buildSlackMessage(prs, {}, t({ header: 'Header:' }));
		// The reviewed one comes first even though it was second in the input.
		expect(msg.indexOf('u2')).toBeLessThan(msg.indexOf(NEW_HEADER));
		expect(msg.indexOf('u1')).toBeGreaterThan(msg.indexOf(NEW_HEADER));
		expect(msg.indexOf('u1')).toBeLessThan(msg.indexOf('u3'));
	});

	it('accounts for every dropped PR line in the "and N more" count', () => {
		const many = Array.from({ length: 400 }, (_, i) =>
			makePr({ number: i, url: `https://example.com/pull/${i}`, title: 'x'.repeat(300), reviewedByCount: 1 }),
		);
		const msg = buildSlackMessage(many, {}, t({ header: 'Pull requests in review:' }));
		const kept = msg.split('\n').filter((line) => line.includes('https://example.com/pull/')).length;
		const omitted = Number(/\.\.\.and (\d+) more$/.exec(msg)?.[1]);
		expect(kept).toBeGreaterThan(0);
		expect(kept + omitted).toBe(400);
	});

	it('never claims a truncation that did not happen', () => {
		const msg = buildSlackMessage([makePr()], {}, t({ header: 'Pull requests in review:' }));
		expect(msg).not.toContain('...and 0 more');
	});

	it('drops the new-PR section wholesale rather than orphaning its lines', () => {
		const reviewed = Array.from({ length: 400 }, (_, i) =>
			makePr({ number: i, url: `https://example.com/pull/${i}`, title: 'x'.repeat(300), reviewedByCount: 1 }),
		);
		const untouched = makePr({ number: 999, url: 'https://example.com/pull/new-999', reviewedByCount: 0 });
		const msg = buildSlackMessage([...reviewed, untouched], {}, t({ header: 'Pull requests in review:' }));
		// A new PR may only be listed when its own header survived the cut.
		expect(msg.includes('pull/new-999') && !msg.includes(NEW_HEADER)).toBe(false);
		expect(msg).not.toContain('...and 0 more');
	});

	it('truncates without leaving a section header stranded', () => {
		const many = Array.from({ length: 400 }, (_, i) =>
			makePr({ number: i, url: `https://example.com/pull/${i}`, title: 'x'.repeat(300), reviewedByCount: 1 }),
		);
		const msg = buildSlackMessage(many, {}, t({ header: 'Pull requests in review:' }));
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

function makeBotPr(overrides: Partial<PrRecord> = {}): PrRecord {
	return makePr({ authorLogin: 'claude[bot]', notifyLogin: 'claude[bot]', ...overrides });
}

describe('isUnassignedBotPr', () => {
	it('is true when a bot PR has no human to tag', () => {
		expect(isUnassignedBotPr(makeBotPr())).toBe(true);
	});

	it('is false once a linked ticket names somebody', () => {
		expect(isUnassignedBotPr(makeBotPr({ notifyLogin: 'oklinov' }))).toBe(false);
	});

	it('is false for a human author', () => {
		expect(isUnassignedBotPr(makePr())).toBe(false);
	});
});

describe('buildRepoSummary', () => {
	it('returns nothing when there are no such PRs', () => {
		expect(buildRepoSummary([], BOT_HEADER)).toEqual([]);
	});

	it('counts per repo and names the longest waiting PR', () => {
		const prs = [
			makeBotPr({ number: 1, url: 'u1', title: 'Newer', durationMs: 1_000, durationHuman: '1h 0m' }),
			makeBotPr({ number: 2, url: 'u2', title: 'Oldest', durationMs: 9_000, durationHuman: '9d 0m' }),
		];
		expect(buildRepoSummary(prs, BOT_HEADER)).toEqual([
			BOT_HEADER,
			'',
			'• [google-maps] 2 PRs — oldest <u2|#2 Oldest> (*9d 0m*)',
		]);
	});

	it('uses the singular for a lone PR', () => {
		const line = buildRepoSummary([makeBotPr({ number: 1, url: 'u1', title: 'Only' })], BOT_HEADER)[2];
		expect(line).toBe('• [google-maps] 1 PR — oldest <u1|#1 Only> (*4d 1h 46m*)');
	});

	it('lists the busiest repo first, ties alphabetically', () => {
		const prs = [
			makeBotPr({ repo: { owner: 'apify-store', name: 'zoo' }, url: 'z1' }),
			makeBotPr({ repo: { owner: 'apify-store', name: 'booking' }, url: 'b1' }),
			makeBotPr({ repo: { owner: 'apify-store', name: 'booking' }, url: 'b2' }),
			makeBotPr({ repo: { owner: 'apify-store', name: 'amazon' }, url: 'a1' }),
		];
		const lines = buildRepoSummary(prs, BOT_HEADER).slice(2);
		expect(lines.map((l) => /\[(.+?)\]/.exec(l)?.[1])).toEqual(['booking', 'amazon', 'zoo']);
	});
});

describe('buildSlackMessage bot PRs', () => {
	const human = makePr({ number: 1, url: 'u1', title: 'Human', reviewedByCount: 2 });
	const bot = makeBotPr({ number: 2, url: 'u2', title: 'Bot', reviewedByCount: 2 });

	it('lists unassigned bot PRs by default', () => {
		const msg = buildSlackMessage([human, bot], {}, t({ header: 'Header:' }));
		expect(msg).toContain('u2');
	});

	it('drops them from the list when the toggle is off', () => {
		const msg = buildSlackMessage([human, bot], {}, t({ header: 'Header:' }), {
			notifyUnassignedBotPrs: false,
		});
		expect(msg).toContain('u1');
		expect(msg).not.toContain('u2');
	});

	it('prints the summary between the list and the footer', () => {
		const msg = buildSlackMessage([human, bot], {}, t({ header: 'Header:', footer: 'FOOTER' }), {
			notifyUnassignedBotPrs: false,
			summarizeUnassignedBotPrs: true,
		});
		expect(msg).toBe(
			[
				'Header:',
				'',
				formatLine(human, null),
				'',
				BOT_HEADER,
				'',
				'• [google-maps] 1 PR — oldest <u2|#2 Bot> (*4d 1h 46m*)',
				'',
				'FOOTER',
			].join('\n'),
		);
	});

	it('summarizes bot PRs that are also listed', () => {
		const msg = buildSlackMessage([human, bot], {}, t({ header: 'Header:' }), {
			summarizeUnassignedBotPrs: true,
		});
		expect(msg).toContain('u2|#2 Bot>');
		expect(msg).toContain(BOT_HEADER);
	});

	it('posts the summary alone when nothing else is left to list', () => {
		const msg = buildSlackMessage([bot], {}, t({ header: 'Header:' }), {
			notifyUnassignedBotPrs: false,
			summarizeUnassignedBotPrs: true,
		});
		expect(msg).toBe([BOT_HEADER, '', '• [google-maps] 1 PR — oldest <u2|#2 Bot> (*4d 1h 46m*)'].join('\n'));
	});

	it('falls back to the all-clear when the bot PRs are muted and not summarized', () => {
		const msg = buildSlackMessage([bot], {}, t({ header: 'Header:' }), { notifyUnassignedBotPrs: false });
		expect(msg).toContain('No open PRs awaiting review');
	});

	it('keeps the summary when PR lines have to be dropped', () => {
		const many = Array.from({ length: 400 }, (_, i) =>
			makePr({ number: i, url: `https://example.com/pull/${i}`, title: 'x'.repeat(300), reviewedByCount: 1 }),
		);
		const msg = buildSlackMessage([...many, bot], {}, t({ header: 'Header:', footer: 'FOOTER' }), {
			notifyUnassignedBotPrs: false,
			summarizeUnassignedBotPrs: true,
		});
		expect(msg.length).toBeLessThanOrEqual(40_000);
		expect(msg).toContain(BOT_HEADER);
		expect(msg.endsWith('FOOTER')).toBe(true);
	});
});

describe('buildSlackMessage footer', () => {
	const FOOTER = '_The tagged person is the PR author._\n_Blocked? Label the PR and say why._';

	it('appends the footer below both sections', () => {
		const reviewed = makePr({ number: 1, url: 'u1', reviewedByCount: 2 });
		const untouched = makePr({ number: 2, url: 'u2', reviewedByCount: 0 });
		const msg = buildSlackMessage([reviewed, untouched], {}, t({ header: 'Header:', footer: FOOTER }));

		expect(msg).toBe(
			[
				'Header:',
				'',
				formatLine(reviewed, null),
				'',
				NEW_HEADER,
				'',
				formatLine(untouched, null),
				'',
				FOOTER,
			].join('\n'),
		);
	});

	it('prints no footer at all when the text is empty', () => {
		const msg = buildSlackMessage([makePr()], {}, t({ header: 'Header:', footer: '' }));
		expect(msg.endsWith(formatLine(makePr(), null))).toBe(true);
		expect(msg).toBe(['Header:', '', formatLine(makePr(), null)].join('\n'));
	});

	it('leaves the all-clear message alone — there is nothing to explain', () => {
		const msg = buildSlackMessage([], {}, t({ header: 'Header:', footer: FOOTER }));
		expect(msg).not.toContain(FOOTER);
	});

	it('keeps the footer when PR lines have to be dropped', () => {
		const many = Array.from({ length: 400 }, (_, i) =>
			makePr({ number: i, url: `https://example.com/pull/${i}`, title: 'x'.repeat(300), reviewedByCount: 1 }),
		);
		const msg = buildSlackMessage(many, {}, t({ header: 'Header:', footer: FOOTER }));

		expect(msg.length).toBeLessThanOrEqual(40_000);
		expect(msg.endsWith(FOOTER)).toBe(true);
		const kept = msg.split('\n').filter((line) => line.includes('https://example.com/pull/')).length;
		const omitted = Number(/\.\.\.and (\d+) more$/m.exec(msg)?.[1]);
		expect(kept).toBeGreaterThan(0);
		expect(kept + omitted).toBe(400);
	});
});

describe('buildSlackMessage blocked PRs', () => {
	const BLOCKED_HEADER = 'Blocked PRs — make sure they are not forgotten:';
	const waiting = makePr({ number: 1, url: 'u1', title: 'Waiting', reviewedByCount: 2 });

	function makeBlockedPr(overrides: Partial<PrRecord> = {}): PrRecord {
		return makePr({ blockedLabels: ['blocked'], ...overrides });
	}

	it('counts the blocked PRs per repo under their own header', () => {
		const blocked = makeBlockedPr({ number: 9, url: 'u9', title: 'Parked' });
		const msg = buildSlackMessage([waiting], {}, t({ header: 'Header:' }), {
			blockedPrs: [blocked],
		});
		expect(msg).toBe(
			[
				'Header:',
				'',
				formatLine(waiting, null),
				'',
				BLOCKED_HEADER,
				'',
				'• [google-maps] 1 PR — oldest <u9|#9 Parked> (*4d 1h 46m*)',
			].join('\n'),
		);
	});

	it('prints nothing extra when no blocked PR qualifies', () => {
		const withOption = buildSlackMessage([waiting], {}, t({ header: 'Header:' }), {
			blockedPrs: [],
		});
		expect(withOption).toBe(buildSlackMessage([waiting], {}, t({ header: 'Header:' })));
	});

	it('sits between the bot summary and the footer', () => {
		const bot = makeBotPr({ number: 2, url: 'u2', title: 'Bot', reviewedByCount: 2 });
		const msg = buildSlackMessage([waiting, bot], {}, t({ header: 'Header:', footer: 'FOOTER' }), {
			notifyUnassignedBotPrs: false,
			summarizeUnassignedBotPrs: true,
			blockedPrs: [makeBlockedPr({ number: 9, url: 'u9' })],
		});
		expect(msg.indexOf(BLOCKED_HEADER)).toBeGreaterThan(msg.indexOf('Header:'));
		expect(msg.indexOf(BOT_HEADER)).toBeGreaterThan(msg.indexOf(BLOCKED_HEADER));
		expect(msg.endsWith('FOOTER')).toBe(true);
	});

	it('posts the blocked summary alone when nothing is waiting for review', () => {
		const msg = buildSlackMessage([], {}, t({ header: 'Header:' }), {
			blockedPrs: [makeBlockedPr({ number: 9, url: 'u9', title: 'Parked' })],
		});
		expect(msg).toBe([BLOCKED_HEADER, '', '• [google-maps] 1 PR — oldest <u9|#9 Parked> (*4d 1h 46m*)'].join('\n'));
	});

	it('keeps the blocked summary when PR lines have to be dropped', () => {
		const many = Array.from({ length: 400 }, (_, i) =>
			makePr({ number: i, url: `https://example.com/pull/${i}`, title: 'x'.repeat(300), reviewedByCount: 1 }),
		);
		const msg = buildSlackMessage(many, {}, t({ header: 'Header:', footer: 'FOOTER' }), {
			blockedPrs: [makeBlockedPr({ number: 9, url: 'u9' })],
		});
		expect(msg.length).toBeLessThanOrEqual(40_000);
		expect(msg).toContain(BLOCKED_HEADER);
		expect(msg.endsWith('FOOTER')).toBe(true);
	});
});

describe('buildSlackMessage texts', () => {
	const reviewed = makePr({ number: 1, url: 'u1', reviewedByCount: 2 });
	const untouched = makePr({ number: 2, url: 'u2', reviewedByCount: 0 });
	const bot = makeBotPr({ number: 3, url: 'u3', reviewedByCount: 2 });
	const blocked = makePr({ number: 4, url: 'u4', blockedLabels: ['blocked'] });

	it('takes every heading and the footer from the texts it is given', () => {
		const msg = buildSlackMessage(
			[reviewed, untouched, bot],
			{},
			{
				header: 'V review:',
				newPrHeader: 'Nikdo se nepodíval:',
				botPrSummaryHeader: 'Bot PR bez assignee:',
				blockedPrHeader: 'Zablokované PR:',
				footer: '_Legenda._',
			},
			{ notifyUnassignedBotPrs: false, summarizeUnassignedBotPrs: true, blockedPrs: [blocked] },
		);

		expect(msg).toContain('V review:');
		expect(msg).toContain('Nikdo se nepodíval:');
		expect(msg).toContain('Zablokované PR:');
		expect(msg).toContain('Bot PR bez assignee:');
		expect(msg.endsWith('_Legenda._')).toBe(true);
		// None of the built-in wording survives an override.
		expect(msg).not.toContain(DEFAULT_TEXTS.header);
		expect(msg).not.toContain(DEFAULT_TEXTS.blockedPrHeader);
	});

	it('uses the header even in the all-clear message', () => {
		expect(buildSlackMessage([], {}, t({ header: 'V review:' }))).toBe(
			'V review:\n\nNo open PRs awaiting review. :tada:',
		);
	});
});
