import type { PrRecord, Severity } from '../types.js';
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
 * Whoever should act on the PR. When a bot opened it the tag points at the ticket assignee,
 * so the bot is named too — otherwise being pinged for a PR you did not write is baffling.
 */
export function formatAssignee(pr: PrRecord, slackId: string | null): string {
	const tag = slackId ? `<@${slackId}>` : `@${pr.notifyLogin}`;
	if (isBotLogin(pr.authorLogin) && pr.authorLogin !== pr.notifyLogin) {
		return `${tag} via ${escapeSlack(pr.authorLogin)}`;
	}
	return tag;
}

export function formatLine(pr: PrRecord, slackId: string | null): string {
	const emoji = severityEmoji(pr.severity);
	const repo = escapeSlack(pr.repo.name);
	const link = `<${pr.url}|${escapeSlack(pr.title)}>`;
	return `${emoji} [${repo}] ${link} - *${pr.durationHuman}* (round ${pr.iterationHuman}) - ${formatApprovals(pr)} (${formatAssignee(pr, slackId)})`;
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

/** Drops PR lines from the end until the message fits, then says how many went. */
function truncate(entries: Entry[]): string {
	const kept: Entry[] = [];
	let length = 0;
	let omitted = 0;

	for (const entry of entries) {
		const addition = entry.text.length + (kept.length > 0 ? 1 : 0);
		if (omitted > 0 || length + addition + TRUNCATION_RESERVE > SLACK_MAX_TEXT_LEN) {
			if (entry.isPr) omitted++;
			continue;
		}
		kept.push(entry);
		length += addition;
	}

	// A section header left without any of its lines would read as an empty promise.
	while (kept.length > 0 && !kept[kept.length - 1].isPr) kept.pop();

	return `${kept.map((e) => e.text).join('\n')}\n...and ${omitted} more`;
}

export function buildSlackMessage(
	prs: PrRecord[],
	userMapping: Record<string, string>,
	headerText: string,
	newPrHeaderText: string,
): string {
	if (prs.length === 0) {
		return `${headerText}\n\nNo open PRs awaiting review. :tada:`;
	}

	const inReview = prs.filter((pr) => !isNewPr(pr));
	const untouched = prs.filter(isNewPr);

	const entries = section(headerText, inReview, userMapping);
	const newSection = section(newPrHeaderText, untouched, userMapping);
	if (entries.length > 0 && newSection.length > 0) entries.push({ text: '', isPr: false });
	entries.push(...newSection);

	const message = entries.map((e) => e.text).join('\n');
	return message.length <= SLACK_MAX_TEXT_LEN ? message : truncate(entries);
}
