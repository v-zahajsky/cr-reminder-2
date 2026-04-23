import { Actor, log } from 'apify';

import { GithubClient, type RawPullRequest } from './clients/github.js';
import { SlackClient } from './clients/slack.js';
import { buildSlackMessage } from './message/builder.js';
import type { InputSchema, Mode, PrRecord, RepoRef, Severity } from './types.js';
import { parseLinkedIssueNumbers } from './utils/linked-issues.js';
import { humanDuration } from './utils/time.js';

const DEFAULT_WARNING_DAYS = 3;
const DEFAULT_SCREAM_DAYS = 7;
const DEFAULT_OVERDUE_DAYS = 3;

export function validateInput(input: unknown): InputSchema {
	if (!input || typeof input !== 'object') throw new Error('Input must be an object');
	const o = input as Record<string, unknown>;

	if (!o.githubToken || typeof o.githubToken !== 'string') throw new Error('Missing githubToken');
	if (!o.githubOrg || typeof o.githubOrg !== 'string') throw new Error('Missing githubOrg');
	if (!o.githubTopic || typeof o.githubTopic !== 'string') throw new Error('Missing githubTopic');
	if (!o.slackBotToken || typeof o.slackBotToken !== 'string') throw new Error('Missing slackBotToken');
	if (!o.slackChannelId || typeof o.slackChannelId !== 'string') throw new Error('Missing slackChannelId');
	if (typeof o.sendEmptyReport !== 'boolean') throw new Error('sendEmptyReport must be a boolean');

	const mode = (o.mode as Mode | undefined) ?? 'overdue';
	if (mode !== 'overdue' && mode !== 'all') throw new Error(`mode must be "overdue" or "all", got "${mode}"`);

	const warning = (o.warningThresholdDays as number | undefined) ?? DEFAULT_WARNING_DAYS;
	const scream = (o.screamThresholdDays as number | undefined) ?? DEFAULT_SCREAM_DAYS;
	const overdue = (o.overdueThresholdDays as number | undefined) ?? DEFAULT_OVERDUE_DAYS;
	if (warning > scream) {
		throw new Error(`warningThresholdDays (${warning}) must be <= screamThresholdDays (${scream})`);
	}

	const userMapping = (o.userMapping as Record<string, string> | undefined) ?? {};
	if (typeof userMapping !== 'object' || Array.isArray(userMapping)) {
		throw new Error('userMapping must be an object { githubLogin: slackUserId }');
	}

	const ignoreLabels = (o.ignoreLabels as string[] | undefined) ?? ['blocked'];
	if (!Array.isArray(ignoreLabels)) throw new Error('ignoreLabels must be a string array');

	return {
		githubToken: o.githubToken,
		githubOrg: o.githubOrg,
		githubTopic: o.githubTopic,
		slackBotToken: o.slackBotToken,
		slackChannelId: o.slackChannelId,
		userMapping,
		mode,
		overdueThresholdDays: overdue,
		warningThresholdDays: warning,
		screamThresholdDays: scream,
		sendEmptyReport: o.sendEmptyReport,
		headerText: (o.headerText as string | undefined) ?? 'Pull requests in review:',
		ignoreLabels,
	};
}

export function getSeverity(durationDays: number, warning: number, scream: number): Severity {
	if (durationDays >= scream) return 'scream';
	if (durationDays >= warning) return 'warning';
	return 'ok';
}

export interface EnrichedPr {
	raw: RawPullRequest;
	repo: RepoRef;
	readyForReviewAt: string;
	linkedIssueLabels: Map<number, string[]>;
}

export function shouldIncludePr(e: EnrichedPr, ignoreLabels: string[]): boolean {
	if (e.raw.draft) return false;
	if (e.linkedIssueLabels.size === 0) return false;
	const ignoreSet = new Set(ignoreLabels);
	if (e.raw.labels.some((l) => ignoreSet.has(l.name))) return false;
	for (const labels of e.linkedIssueLabels.values()) {
		if (labels.some((l) => ignoreSet.has(l))) return false;
	}
	return true;
}

export function toPrRecord(
	e: EnrichedPr,
	now: number,
	warningDays: number,
	screamDays: number,
): PrRecord {
	const durationMs = Math.max(0, now - Date.parse(e.readyForReviewAt));
	const durationDays = durationMs / 86_400_000;
	return {
		repo: e.repo,
		number: e.raw.number,
		title: e.raw.title,
		url: e.raw.html_url,
		authorLogin: e.raw.user?.login ?? 'unknown',
		createdAt: e.raw.created_at,
		readyForReviewAt: e.readyForReviewAt,
		isDraft: e.raw.draft,
		labels: e.raw.labels.map((l) => l.name),
		body: e.raw.body ?? '',
		linkedIssueNumbers: Array.from(e.linkedIssueLabels.keys()),
		durationMs,
		durationDays,
		durationHuman: humanDuration(durationMs),
		severity: getSeverity(durationDays, warningDays, screamDays),
	};
}

export function applyModeFilter(records: PrRecord[], mode: Mode, overdueDays: number): PrRecord[] {
	if (mode === 'all') return records;
	return records.filter((r) => r.durationDays >= overdueDays);
}

async function enrichPullRequest(github: GithubClient, repo: RepoRef, raw: RawPullRequest): Promise<EnrichedPr> {
	const readyEvent = await github.getLatestReadyForReviewAt(repo, raw.number);
	const readyForReviewAt = readyEvent ?? raw.created_at;

	const linkedNumbers = parseLinkedIssueNumbers(raw.body);
	const linkedIssueLabels = new Map<number, string[]>();
	for (const n of linkedNumbers) {
		const labels = await github.getIssueLabels(repo, n);
		linkedIssueLabels.set(n, labels);
	}

	return { raw, repo, readyForReviewAt, linkedIssueLabels };
}

export async function run(): Promise<void> {
	const rawInput = (await Actor.getInput()) ?? {};
	const input = validateInput(rawInput);

	const github = new GithubClient(input.githubToken);
	const slack = new SlackClient(input.slackBotToken);

	log.info(`Discovering repos with topic "${input.githubTopic}" in org "${input.githubOrg}"…`);
	const repos = await github.discoverRepos(input.githubOrg, input.githubTopic);
	log.info(`Found ${repos.length} repos matching topic.`);

	const enriched: EnrichedPr[] = [];
	for (const repo of repos) {
		let pulls: RawPullRequest[] = [];
		try {
			pulls = await github.listOpenPulls(repo);
		} catch (err) {
			log.warning(`Failed to list pulls for ${repo.owner}/${repo.name}: ${(err as Error).message}`);
			continue;
		}
		log.info(`${repo.owner}/${repo.name}: ${pulls.length} open PRs`);
		for (const pr of pulls) {
			const e = await enrichPullRequest(github, repo, pr);
			enriched.push(e);
		}
	}

	const filtered = enriched.filter((e) => shouldIncludePr(e, input.ignoreLabels));
	log.info(`${filtered.length}/${enriched.length} PRs pass filters (draft/labels/linked-issue blocked).`);

	const now = Date.now();
	let records = filtered.map((e) => toPrRecord(e, now, input.warningThresholdDays, input.screamThresholdDays));
	records = applyModeFilter(records, input.mode, input.overdueThresholdDays);
	records.sort((a, b) => b.durationMs - a.durationMs);

	log.info(`Mode=${input.mode}: ${records.length} PRs will be reported.`);

	await Actor.pushData(records);

	for (const r of records) {
		if (!input.userMapping[r.authorLogin]) {
			log.warning(`No Slack mapping for GitHub user: ${r.authorLogin}`);
		}
	}

	if (records.length === 0 && !input.sendEmptyReport) {
		log.info('No PRs to report and sendEmptyReport=false — skipping Slack notification.');
		return;
	}

	const message = buildSlackMessage(records, input.userMapping, input.headerText);
	log.info('=== SLACK PAYLOAD ===');
	log.info(message);
	log.info('=== END SLACK PAYLOAD ===');

	try {
		await slack.postMessage(input.slackChannelId, message);
	} catch (err) {
		log.error(`Failed to post Slack message: ${(err as Error).message}`);
		throw err;
	}
}
