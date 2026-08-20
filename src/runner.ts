import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Actor, log } from 'apify';

import { GithubClient, type RawPullRequest, type RawReview } from './clients/github.js';
import { SlackClient } from './clients/slack.js';
import { buildSlackMessage } from './message/builder.js';
import type { InputSchema, Mode, PrRecord, RepoRef, ReviewSummary, Severity } from './types.js';
import { parseLinkedIssueNumbers } from './utils/linked-issues.js';
import { assertValidTimeZone, businessElapsedMs, humanDuration } from './utils/time.js';
import { isBotLogin, parseUserMapping } from './utils/user-mapping.js';

const HOUR_MS = 3_600_000;

// The team baseline: somebody should look at a PR within a day of it being ready.
const DEFAULT_OVERDUE_HOURS = 24;
const DEFAULT_WARNING_HOURS = 72;
const DEFAULT_SCREAM_HOURS = 168;
const DEFAULT_TIME_ZONE = 'Europe/Prague';
const DEFAULT_USER_MAPPING_FILE = 'user-mapping.json';

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

	const warning = (o.warningThresholdHours as number | undefined) ?? DEFAULT_WARNING_HOURS;
	const scream = (o.screamThresholdHours as number | undefined) ?? DEFAULT_SCREAM_HOURS;
	const overdue = (o.overdueThresholdHours as number | undefined) ?? DEFAULT_OVERDUE_HOURS;
	if (warning > scream) {
		throw new Error(`warningThresholdHours (${warning}) must be <= screamThresholdHours (${scream})`);
	}

	// Iteration limits default to the total-age limits, so an unconfigured actor behaves as before.
	const iterWarning = (o.iterationWarningThresholdHours as number | undefined) ?? warning;
	const iterScream = (o.iterationScreamThresholdHours as number | undefined) ?? scream;
	const iterOverdue = (o.iterationOverdueThresholdHours as number | undefined) ?? overdue;
	if (iterWarning > iterScream) {
		throw new Error(
			`iterationWarningThresholdHours (${iterWarning}) must be <= iterationScreamThresholdHours (${iterScream})`,
		);
	}

	const requireLinkedIssue = (o.requireLinkedIssue as boolean | undefined) ?? false;
	const skipWeekends = (o.skipWeekends as boolean | undefined) ?? true;
	const timeZone = (o.timeZone as string | undefined) ?? DEFAULT_TIME_ZONE;
	assertValidTimeZone(timeZone);

	const userMappingFile = (o.userMappingFile as string | undefined) ?? DEFAULT_USER_MAPPING_FILE;
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
		userMappingFile,
		userMapping,
		mode,
		overdueThresholdHours: overdue,
		warningThresholdHours: warning,
		screamThresholdHours: scream,
		iterationOverdueThresholdHours: iterOverdue,
		iterationWarningThresholdHours: iterWarning,
		iterationScreamThresholdHours: iterScream,
		requireLinkedIssue,
		skipWeekends,
		timeZone,
		sendEmptyReport: o.sendEmptyReport,
		headerText: (o.headerText as string | undefined) ?? 'Pull requests in review:',
		newPrHeaderText: (o.newPrHeaderText as string | undefined) ?? 'New PRs — nobody has looked at these yet:',
		ignoreLabels,
	};
}

/**
 * The mapping table lives in its own file so it can grow without touching the run input.
 * Anything passed in `userMapping` still wins, which keeps one-off fixes possible
 * without a redeploy.
 */
export function loadUserMapping(input: InputSchema): Record<string, string> {
	const path = resolve(process.cwd(), input.userMappingFile);
	let fromFile: Record<string, string> = {};

	if (existsSync(path)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, 'utf8'));
		} catch (err) {
			throw new Error(`${input.userMappingFile} is not valid JSON: ${(err as Error).message}`);
		}
		fromFile = parseUserMapping(parsed, input.userMappingFile);
		log.info(`Loaded ${Object.keys(fromFile).length} user mappings from ${input.userMappingFile}.`);
	} else if (Object.keys(input.userMapping).length === 0) {
		log.warning(
			`No user mapping: "${input.userMappingFile}" does not exist and the input carries none. Nobody will be tagged.`,
		);
	} else {
		log.warning(
			`"${input.userMappingFile}" does not exist; using the ${Object.keys(input.userMapping).length} mappings from the input only.`,
		);
	}

	const overrides = Object.keys(input.userMapping);
	if (overrides.length > 0) log.info(`Input overrides ${overrides.length} mapping(s): ${overrides.join(', ')}.`);

	return { ...fromFile, ...input.userMapping };
}

export function getSeverity(durationHours: number, warning: number, scream: number): Severity {
	if (durationHours >= scream) return 'scream';
	if (durationHours >= warning) return 'warning';
	return 'ok';
}

const SEVERITY_RANK: Record<Severity, number> = { ok: 0, warning: 1, scream: 2 };

export function worstSeverity(a: Severity, b: Severity): Severity {
	return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * A new review round starts when someone is asked to review again. Pushing commits does not
 * reset the clock — the re-request is the explicit "ball is back with you" signal.
 * The PR becoming reviewable is the floor, so a request made while still a draft does not count.
 */
export function resolveIterationStart(readyForReviewAt: string, lastReviewRequestedAt: string | null): string {
	if (!lastReviewRequestedAt) return readyForReviewAt;
	return lastReviewRequestedAt > readyForReviewAt ? lastReviewRequestedAt : readyForReviewAt;
}

/**
 * Counts approvals against everyone involved in the review.
 *
 * The denominator cannot come from requested_reviewers alone: GitHub removes a reviewer from
 * that list the moment they submit a review, so an approved PR reports zero requested reviewers.
 * We therefore take everyone who reviewed, plus everyone still waited on.
 */
export function summarizeReviews(
	reviews: RawReview[],
	requestedLogins: string[],
	requestedTeamCount: number,
	authorLogin: string,
): ReviewSummary {
	// Comment-only reviews do not clear an earlier approval, so they never decide a reviewer's state.
	const decisive = new Map<string, RawReview>();
	const reviewed = new Set<string>();

	for (const r of reviews) {
		if (r.login === authorLogin) continue;
		reviewed.add(r.login);
		const state = r.state.toUpperCase();
		if (state === 'COMMENTED' || state === 'PENDING') continue;
		const prev = decisive.get(r.login);
		if (!prev || r.submittedAt > prev.submittedAt) decisive.set(r.login, r);
	}

	const involved = new Set(reviewed);
	for (const login of requestedLogins) {
		if (login !== authorLogin) involved.add(login);
	}

	const approvedBy = Array.from(decisive.entries())
		.filter(([, r]) => r.state.toUpperCase() === 'APPROVED')
		.map(([login]) => login)
		.sort();

	return {
		approvedBy,
		approvedCount: approvedBy.length,
		// A pending team request is one unknown-sized slot; count it as a single outstanding reviewer.
		reviewerCount: involved.size + requestedTeamCount,
		reviewedByCount: reviewed.size,
	};
}

/**
 * Bots open PRs but cannot act on review feedback, so tagging them notifies nobody.
 * For a bot-authored PR we tag whoever the linked ticket is assigned to instead.
 */
export function resolveNotifyLogin(authorLogin: string, linkedIssueAssignees: string[]): string {
	if (!isBotLogin(authorLogin)) return authorLogin;
	return linkedIssueAssignees[0] ?? authorLogin;
}

export interface EnrichedPr {
	raw: RawPullRequest;
	repo: RepoRef;
	readyForReviewAt: string;
	iterationStartedAt: string;
	review: ReviewSummary;
	linkedIssueLabels: Map<number, string[]>;
	/** Assignees of the linked issues, primary first, deduplicated across issues. */
	linkedIssueAssignees: string[];
}

export function shouldIncludePr(e: EnrichedPr, ignoreLabels: string[], requireLinkedIssue = false): boolean {
	if (e.raw.draft) return false;
	// By default every open PR in review is visible; requireLinkedIssue restores the stricter rule.
	// Either way linked issues still mute PRs by label and route bot PRs to an assignee.
	if (requireLinkedIssue && e.linkedIssueLabels.size === 0) return false;
	const ignoreSet = new Set(ignoreLabels);
	if (e.raw.labels.some((l) => ignoreSet.has(l.name))) return false;
	for (const labels of e.linkedIssueLabels.values()) {
		if (labels.some((l) => ignoreSet.has(l))) return false;
	}
	return true;
}

export type RecordOptions = Pick<
	InputSchema,
	| 'warningThresholdHours'
	| 'screamThresholdHours'
	| 'iterationWarningThresholdHours'
	| 'iterationScreamThresholdHours'
	| 'skipWeekends'
	| 'timeZone'
>;

/** Waiting time as the thresholds see it: calendar time, minus weekends when configured. */
export function elapsedMs(startedAt: string, now: number, options: RecordOptions): number {
	const startMs = Date.parse(startedAt);
	if (!options.skipWeekends) return Math.max(0, now - startMs);
	return businessElapsedMs(startMs, now, options.timeZone);
}

export function toPrRecord(e: EnrichedPr, now: number, options: RecordOptions): PrRecord {
	const durationMs = elapsedMs(e.readyForReviewAt, now, options);
	const durationHours = durationMs / HOUR_MS;
	const iterationMs = elapsedMs(e.iterationStartedAt, now, options);
	const iterationHours = iterationMs / HOUR_MS;

	const totalSeverity = getSeverity(durationHours, options.warningThresholdHours, options.screamThresholdHours);
	const iterationSeverity = getSeverity(
		iterationHours,
		options.iterationWarningThresholdHours,
		options.iterationScreamThresholdHours,
	);
	const authorLogin = e.raw.user?.login ?? 'unknown';

	return {
		repo: e.repo,
		number: e.raw.number,
		title: e.raw.title,
		url: e.raw.html_url,
		authorLogin,
		notifyLogin: resolveNotifyLogin(authorLogin, e.linkedIssueAssignees),
		linkedIssueAssignees: e.linkedIssueAssignees,
		createdAt: e.raw.created_at,
		readyForReviewAt: e.readyForReviewAt,
		iterationStartedAt: e.iterationStartedAt,
		isDraft: e.raw.draft,
		labels: e.raw.labels.map((l) => l.name),
		body: e.raw.body ?? '',
		linkedIssueNumbers: Array.from(e.linkedIssueLabels.keys()),
		durationMs,
		durationHours,
		durationHuman: humanDuration(durationMs),
		durationWallMs: Math.max(0, now - Date.parse(e.readyForReviewAt)),
		iterationMs,
		iterationHours,
		iterationHuman: humanDuration(iterationMs),
		iterationWallMs: Math.max(0, now - Date.parse(e.iterationStartedAt)),
		approvedBy: e.review.approvedBy,
		approvedCount: e.review.approvedCount,
		reviewerCount: e.review.reviewerCount,
		reviewedByCount: e.review.reviewedByCount,
		severity: worstSeverity(totalSeverity, iterationSeverity),
	};
}

/** In 'overdue' mode a PR qualifies when it breaches either limit. */
export function applyModeFilter(
	records: PrRecord[],
	mode: Mode,
	overdueHours: number,
	iterationOverdueHours: number,
): PrRecord[] {
	if (mode === 'all') return records;
	return records.filter((r) => r.durationHours >= overdueHours || r.iterationHours >= iterationOverdueHours);
}

async function enrichPullRequest(github: GithubClient, repo: RepoRef, raw: RawPullRequest): Promise<EnrichedPr> {
	const { readyForReviewAt: readyEvent, lastReviewRequestedAt } = await github.getReviewTimestamps(repo, raw.number);
	const readyForReviewAt = readyEvent ?? raw.created_at;
	const iterationStartedAt = resolveIterationStart(readyForReviewAt, lastReviewRequestedAt);

	const reviews = await github.listReviews(repo, raw.number);
	const review = summarizeReviews(
		reviews,
		raw.requested_reviewers.map((u) => u.login),
		raw.requested_teams.length,
		raw.user?.login ?? '',
	);

	const linkedNumbers = parseLinkedIssueNumbers(raw.body);
	const linkedIssueLabels = new Map<number, string[]>();
	const linkedIssueAssignees: string[] = [];
	for (const n of linkedNumbers) {
		const { labels, assignees } = await github.getIssueDetails(repo, n);
		linkedIssueLabels.set(n, labels);
		for (const a of assignees) {
			if (!linkedIssueAssignees.includes(a)) linkedIssueAssignees.push(a);
		}
	}

	return { raw, repo, readyForReviewAt, iterationStartedAt, review, linkedIssueLabels, linkedIssueAssignees };
}

export async function run(): Promise<void> {
	const rawInput = (await Actor.getInput()) ?? {};
	const input = validateInput(rawInput);

	const userMapping = loadUserMapping(input);

	const github = new GithubClient(input.githubToken);
	const slack = new SlackClient(input.slackBotToken);

	// Fail fast on a bad Slack token — otherwise we would burn the whole GitHub scan first.
	await slack.assertAuth();

	log.info(`Discovering repos with topic "${input.githubTopic}" in org "${input.githubOrg}"…`);
	let repos: RepoRef[];
	try {
		repos = await github.discoverRepos(input.githubOrg, input.githubTopic);
	} catch (err) {
		if ((err as { status?: number }).status === 401) {
			throw new Error(
				'GitHub rejected the token (401 Bad credentials) — githubToken is invalid, expired or revoked. Generate a new PAT with read access to pull requests, issues and metadata.',
			);
		}
		throw err;
	}
	log.info(`Found ${repos.length} repos matching topic.`);

	const enriched: EnrichedPr[] = [];
	let drafts = 0;
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
			// Drafts are excluded anyway; skipping here saves two API calls per draft.
			if (pr.draft) {
				drafts++;
				continue;
			}
			const e = await enrichPullRequest(github, repo, pr);
			enriched.push(e);
		}
	}

	const filtered = enriched.filter((e) => shouldIncludePr(e, input.ignoreLabels, input.requireLinkedIssue));
	const gate = input.requireLinkedIssue ? 'label and linked-issue filters' : 'label filters';
	log.info(`${filtered.length}/${enriched.length} non-draft PRs pass ${gate}; ${drafts} drafts skipped.`);
	if (input.skipWeekends) log.info(`Weekends are excluded from waiting times (time zone ${input.timeZone}).`);

	const now = Date.now();
	let records = filtered.map((e) => toPrRecord(e, now, input));
	records = applyModeFilter(records, input.mode, input.overdueThresholdHours, input.iterationOverdueThresholdHours);
	records.sort((a, b) => b.durationMs - a.durationMs);

	log.info(`Mode=${input.mode}: ${records.length} PRs will be reported.`);

	await Actor.pushData(records);

	for (const r of records) {
		if (userMapping[r.notifyLogin]) continue;
		if (isBotLogin(r.notifyLogin)) {
			log.warning(
				`${r.repo.name}#${r.number} was opened by ${r.notifyLogin} and no linked ticket has an assignee — nobody will be notified.`,
			);
		} else {
			log.warning(`No Slack mapping for GitHub user: ${r.notifyLogin}`);
		}
	}

	if (records.length === 0 && !input.sendEmptyReport) {
		log.info('No PRs to report and sendEmptyReport=false — skipping Slack notification.');
		return;
	}

	const message = buildSlackMessage(records, userMapping, input.headerText, input.newPrHeaderText);
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
