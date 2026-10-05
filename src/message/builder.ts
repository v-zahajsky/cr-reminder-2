import type { PrRecord, Severity } from '../types.js';
import type { Texts } from '../utils/texts.js';
import { isBotLogin, resolveSlackId } from '../utils/user-mapping.js';

const SLACK_MAX_TEXT_LEN = 40_000;
/** Room for the "...and N more" line appended after truncation. */
const TRUNCATION_RESERVE = 40;

export function escapeSlack(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function severityEmoji(severity: Severity): string {
	if (severity === 'scream') return ':scream:';
	if (severity === 'warning') return ':warning:';
	return ':hourglass_flowing_sand:';
}

/** Approved count in bold over the total involved, or a nudge when nobody is on the hook. */
export function formatApprovals(pr: PrRecord): string {
	if (pr.reviewerCount === 0) return 'no reviewers';
	return `*${pr.approvedCount}*/${pr.reviewerCount} approved`;
}

/**
 * Nobody has submitted a review of any kind yet — the PR is not stuck in a discussion,
 * it is simply untouched. That needs a different nudge, so it gets its own section.
 */
export function isNewPr(pr: PrRecord): boolean {
	return pr.reviewedByCount === 0;
}

/**
 * A bot opened the PR and no linked ticket named a human, so the tag falls back to the bot.
 * Such a line pings nobody: it is a repo-hygiene item, not somebody's homework.
 */
export function isUnassignedBotPr(pr: PrRecord): boolean {
	return isBotLogin(pr.authorLogin) && pr.notifyLogin === pr.authorLogin;
}

/**
 * Whoever should act on the PR. When a bot opened it the tag points at the ticket assignee,
 * so the bot is named too — otherwise being pinged for a PR you did not write is baffling.
 */
export function formatAssignee(pr: PrRecord, slackId: string | null): string {
	const tag = slackId ? `<@${slackId}>` : `@${escapeSlack(pr.notifyLogin)}`;
	if (isBotLogin(pr.authorLogin) && pr.authorLogin !== pr.notifyLogin) {
		return `${tag} via ${escapeSlack(pr.authorLogin)}`;
	}
	return tag;
}

/**
 * A reopened PR restarted both clocks at the reopen, so the durations next to it describe the
 * latest run only. The count is what stops a suspiciously young number from reading as the
 * whole story.
 */
function formatReopened(pr: PrRecord): string {
	return pr.reopenedCount > 0 ? `, reopened ${pr.reopenedCount}×` : '';
}

export function formatLine(pr: PrRecord, slackId: string | null): string {
	const emoji = severityEmoji(pr.severity);
	const repo = escapeSlack(pr.repo.name);
	const link = `<${pr.url}|#${pr.number} ${escapeSlack(pr.title)}>`;
	return `${emoji} [${repo}] ${link} - *${pr.durationHuman}* (round ${pr.iterationHuman}${formatReopened(pr)}) - ${formatApprovals(pr)} (${formatAssignee(pr, slackId)})`;
}

interface Entry {
	text: string;
	/** Only PR lines may be dropped when the message has to be shortened. */
	isPr: boolean;
}

function section(header: string, prs: PrRecord[], userMapping: Record<string, string>): Entry[] {
	if (prs.length === 0) return [];
	return [
		{ text: header, isPr: false },
		{ text: '', isPr: false },
		...prs.map((pr) => ({ text: formatLine(pr, resolveSlackId(userMapping, pr.notifyLogin)), isPr: true })),
	];
}

/** Drops PR lines from the end until the message fits the budget, then says how many went. */
function truncate(entries: Entry[], budget: number): string {
	const kept: Entry[] = [];
	let length = 0;
	let omitted = 0;
	let full = false;

	for (const entry of entries) {
		const addition = entry.text.length + (kept.length > 0 ? 1 : 0);
		// Once one entry no longer fits the rest goes with it: a shorter line further down would
		// otherwise slip in under a section header that was already dropped.
		if (full || length + addition + TRUNCATION_RESERVE > budget) {
			full = true;
			if (entry.isPr) omitted++;
			continue;
		}
		kept.push(entry);
		length += addition;
	}

	// A section header left without any of its lines would read as an empty promise.
	while (kept.length > 0 && !kept[kept.length - 1].isPr) kept.pop();

	const lines = kept.map((e) => e.text);
	if (omitted > 0) lines.push(`...and ${omitted} more`);
	return lines.join('\n');
}

/** One repo's worth of PRs nobody is being pinged about: how many, and which has waited longest. */
export function formatRepoSummaryLine(repoName: string, prs: PrRecord[]): string {
	const oldest = prs.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
	const noun = prs.length === 1 ? 'PR' : 'PRs';
	const link = `<${oldest.url}|#${oldest.number} ${escapeSlack(oldest.title)}>`;
	return `• [${escapeSlack(repoName)}] ${prs.length} ${noun} — oldest ${link} (*${oldest.durationHuman}*)`;
}

/** Header plus one line per repo, busiest first; nothing at all when there are no such PRs. */
export function buildRepoSummary(prs: PrRecord[], header: string): string[] {
	if (prs.length === 0) return [];

	const byRepo = new Map<string, PrRecord[]>();
	for (const pr of prs) {
		const bucket = byRepo.get(pr.repo.name);
		if (bucket) bucket.push(pr);
		else byRepo.set(pr.repo.name, [pr]);
	}

	const lines = Array.from(byRepo.entries())
		.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
		.map(([repoName, repoPrs]) => formatRepoSummaryLine(repoName, repoPrs));

	return [header, '', ...lines];
}

export interface MessageOptions {
	/** When false, unassigned bot PRs are kept out of the two listed sections. Defaults to true. */
	notifyUnassignedBotPrs?: boolean;
	/** When true, those PRs are counted per repo just above the footer. */
	summarizeUnassignedBotPrs?: boolean;
	/**
	 * PRs muted by an ignore label that are worth a reminder. They are not part of `prs` —
	 * the filters dropped them long before — so the caller decides which ones qualify.
	 */
	blockedPrs?: PrRecord[];
}

export function buildSlackMessage(
	prs: PrRecord[],
	userMapping: Record<string, string>,
	texts: Texts,
	options: MessageOptions = {},
): string {
	const botPrs = prs.filter(isUnassignedBotPr);
	// Muted bot PRs still exist; they just stop taking up a line each.
	const listed = options.notifyUnassignedBotPrs === false ? prs.filter((pr) => !isUnassignedBotPr(pr)) : prs;
	const summary = options.summarizeUnassignedBotPrs ? buildRepoSummary(botPrs, texts.botPrSummaryHeader) : [];
	// A blocked PR is nobody's review queue, so it gets a count rather than a line to act on.
	const blocked = buildRepoSummary(options.blockedPrs ?? [], texts.blockedPrHeader);

	if (listed.length === 0 && summary.length === 0 && blocked.length === 0) {
		return `${texts.header}\n\nNo open PRs awaiting review. :tada:`;
	}

	const inReview = listed.filter((pr) => !isNewPr(pr));
	const untouched = listed.filter(isNewPr);

	const entries = section(texts.header, inReview, userMapping);
	const newSection = section(texts.newPrHeader, untouched, userMapping);
	if (entries.length > 0 && newSection.length > 0) entries.push({ text: '', isPr: false });
	entries.push(...newSection);

	// The summary stands in for lines that are not printed and the footer explains the ones that
	// are, so neither may be the thing that gets cut: their length comes off the budget before a
	// single PR line is measured.
	const tail = [
		...(blocked.length > 0 ? ['', ...blocked] : []),
		...(summary.length > 0 ? ['', ...summary] : []),
		...(texts.footer.trim() === '' ? [] : ['', texts.footer]),
	];
	const budget = SLACK_MAX_TEXT_LEN - tail.reduce((sum, line) => sum + line.length + 1, 0);

	const message = entries.map((e) => e.text).join('\n');
	const body = message.length <= budget ? message : truncate(entries, budget);
	// With nothing listed the tail is the whole message, so its leading separator has to go.
	return (body === '' ? tail.slice(1) : [body, ...tail]).join('\n');
}
