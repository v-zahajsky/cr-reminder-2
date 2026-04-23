import type { PrRecord, Severity } from '../types.js';
import { resolveSlackId } from '../utils/user-mapping.js';

const SLACK_MAX_TEXT_LEN = 40_000;

export function escapeSlack(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function severityEmoji(severity: Severity): string {
	if (severity === 'scream') return ':scream:';
	if (severity === 'warning') return ':warning:';
	return ':hourglass_flowing_sand:';
}

export function formatLine(pr: PrRecord, slackId: string | null): string {
	const emoji = severityEmoji(pr.severity);
	const link = `<${pr.url}|${escapeSlack(pr.title)}>`;
	const tag = slackId ? `<@${slackId}>` : `@${pr.authorLogin}`;
	return `${emoji} ${link} - ${pr.durationHuman} (${tag})`;
}

export function buildSlackMessage(
	prs: PrRecord[],
	userMapping: Record<string, string>,
	headerText: string,
): string {
	if (prs.length === 0) {
		return `${headerText}\n\nNo open PRs awaiting review. :tada:`;
	}

	const lines = prs.map((pr) => formatLine(pr, resolveSlackId(userMapping, pr.authorLogin)));
	let message = `${headerText}\n\n${lines.join('\n')}`;

	if (message.length <= SLACK_MAX_TEXT_LEN) return message;

	let kept = 0;
	const keptLines: string[] = [];
	let runningLen = headerText.length + 2;
	for (const line of lines) {
		const addition = runningLen + line.length + 1 + 40;
		if (addition > SLACK_MAX_TEXT_LEN) break;
		keptLines.push(line);
		runningLen += line.length + 1;
		kept++;
	}
	const omitted = prs.length - kept;
	message = `${headerText}\n\n${keptLines.join('\n')}\n...and ${omitted} more`;
	return message;
}
