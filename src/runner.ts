import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Actor, log } from 'apify';

import { GithubClient, type RawPullRequest, type RawReview, type ReviewTimestamps } from './clients/github.js';
import { SlackClient } from './clients/slack.js';
import { buildSlackMessage, isUnassignedBotPr } from './message/builder.js';
import type { InputSchema, Mode, PrRecord, RepoRef, ReviewSummary, Severity } from './types.js';
import { type AppConfig, loadConfig } from './utils/config.js';
import { parseLinkedIssueNumbers } from './utils/linked-issues.js';
import { loadTexts, parseTexts } from './utils/texts.js';
import { businessElapsedMs, humanDuration } from './utils/time.js';
import { isBotLogin, parseUserMapping, resolveSlackId } from './utils/user-mapping.js';

const HOUR_MS = 3_600_000;

// The team baseline: somebody should look at a PR within a day of it being ready.
const DEFAULT_OVERDUE_HOURS = 24;
const DEFAULT_WARNING_HOURS = 72;
const DEFAULT_SCREAM_HOURS = 168;
// Three working days parked is the point at which a blocked PR stops being fresh news.
const DEFAULT_BLOCKED_PR_HOURS = 72;
/** Everything the actor reads from disk rather than from the run input lives in one folder. */
const DEFAULT_USER_MAPPING_FILE = 'config/user-mapping.json';
const TEXTS_FILE = 'config/texts.json';
const CONFIG_FILE = 'config/config.json';

/** GitHub reports a null user for a deleted account; the tag and the self-review check must agree on the name. */
const UNKNOWN_LOGIN = 'unknown';

/** An unset threshold takes the fallback; a non-numeric one would silently make every comparison false. */
function hoursOption(o: Record<string, unknown>, key: string, fallback: number): number {
	const value = o[key];
	if (value === undefined || value === null) return fallback;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new Error(`${key} must be a non-negative number, got ${JSON.stringify(value)}`);
	}
	return value;
}

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

	const warning = hoursOption(o, 'warningThresholdHours', DEFAULT_WARNING_HOURS);
	const scream = hoursOption(o, 'screamThresholdHours', DEFAULT_SCREAM_HOURS);
	const overdue = hoursOption(o, 'overdueThresholdHours', DEFAULT_OVERDUE_HOURS);
	if (warning > scream) {
		throw new Error(`warningThresholdHours (${warning}) must be <= screamThresholdHours (${scream})`);
	}

	// Iteration limits default to the total-age limits, so an unconfigured actor behaves as before.
	const iterWarning = hoursOption(o, 'iterationWarningThresholdHours', warning);
	const iterScream = hoursOption(o, 'iterationScreamThresholdHours', scream);
	const iterOverdue = hoursOption(o, 'iterationOverdueThresholdHours', overdue);
	if (iterWarning > iterScream) {
		throw new Error(
			`iterationWarningThresholdHours (${iterWarning}) must be <= iterationScreamThresholdHours (${iterScream})`,
		);
	}

	const requireLinkedIssue = (o.requireLinkedIssue as boolean | undefined) ?? false;
	const skipWeekends = (o.skipWeekends as boolean | undefined) ?? true;

	const userMappingFile = (o.userMappingFile as string | undefined) ?? DEFAULT_USER_MAPPING_FILE;
	const userMapping = (o.userMapping as Record<string, unknown> | undefined) ?? {};
	if (typeof userMapping !== 'object' || Array.isArray(userMapping)) {
		throw new Error('userMapping must be an object { githubLogin: slackUserId }');
	}

	const ignoreLabels = (o.ignoreLabels as string[] | undefined) ?? ['blocked'];
	if (!Array.isArray(ignoreLabels) || ignoreLabels.some((l) => typeof l !== 'string')) {
		throw new Error('ignoreLabels must be a string array');
	}

	// A bot PR with no assignee tags nobody, so listing it is optional; summarising it is the
	// middle ground between nagging the channel and pretending the PR does not exist.
	const notifyUnassignedBotPrs = (o.notifyUnassignedBotPrs as boolean | undefined) ?? true;
	const summarizeUnassignedBotPrs = (o.summarizeUnassignedBotPrs as boolean | undefined) ?? false;

	// An ignored label takes a PR off the list for good; the reminder is what stops "off the list"
	// from turning into "forgotten". Opt-in, because a team that never mislays a blocked PR
	// does not need the extra block.
	const reportBlockedPrs = (o.reportBlockedPrs as boolean | undefined) ?? false;
	const blockedPrThresholdHours = hoursOption(o, 'blockedPrThresholdHours', DEFAULT_BLOCKED_PR_HOURS);

	// Validated here rather than at send time: a typo in a text key should fail the run before
	// the GitHub scan, not after it.
	const texts = (o.texts as Record<string, unknown> | undefined) ?? {};
	parseTexts(texts, 'texts input');

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
		sendEmptyReport: o.sendEmptyReport,
		notifyUnassignedBotPrs,
		summarizeUnassignedBotPrs,
		reportBlockedPrs,
		blockedPrThresholdHours,
		texts,
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
	// Overrides are parsed like the file, so the annotated { slackId } form works in both.
	const overrides = parseUserMapping(input.userMapping, 'userMapping input');
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
	} else if (Object.keys(overrides).length === 0) {
		log.warning(
			`No user mapping: "${input.userMappingFile}" does not exist and the input carries none. Nobody will be tagged.`,
		);
	} else {
		log.warning(
			`"${input.userMappingFile}" does not exist; using the ${Object.keys(overrides).length} mappings from the input only.`,
		);
	}

	const overrideLogins = Object.keys(overrides);
	if (overrideLogins.length > 0) {
		log.info(`Input overrides ${overrideLogins.length} mapping(s): ${overrideLogins.join(', ')}.`);
	}

	return { ...fromFile, ...overrides };
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
 * Reopening a PR puts it back in the queue, so both clocks restart there — the stretch it spent
 * closed was nobody's review time. The ready event stays the floor, so a PR reopened and only
 * then marked ready is not dragged backwards to the reopen.
 */
export function resolveReviewStart(readyForReviewAt: string, lastReopenedAt: string | null): string {
	if (!lastReopenedAt) return readyForReviewAt;
	return lastReopenedAt > readyForReviewAt ? lastReopenedAt : readyForReviewAt;
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

export interface PrClocks {
	readyForReviewAt: string;
	iterationStartedAt: string;
}

/**
 * Where the two clocks start, from one timeline read. The PR became reviewable at the ready
 * event, or at its creation when it was never a draft; a reopen pushes that forward. The round
 * then starts at the later of that and the last re-request, which is what keeps the round from
 * ever predating the total age.
 */
export function resolvePrClocks(createdAt: string, timestamps: ReviewTimestamps): PrClocks {
	const readyForReviewAt = resolveReviewStart(timestamps.readyForReviewAt ?? createdAt, timestamps.lastReopenedAt);
	return {
		readyForReviewAt,
		iterationStartedAt: resolveIterationStart(readyForReviewAt, timestamps.lastReviewRequestedAt),
	};
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
		const state = r.state.toUpperCase();
		// A pending review has not been submitted, so nobody has looked yet.
		if (state === 'PENDING') continue;
		reviewed.add(r.login);
		if (state === 'COMMENTED') continue;
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
	reopenedCount: number;
	reopenedAt: string | null;
	review: ReviewSummary;
	linkedIssueLabels: Map<number, string[]>;
	/** Assignees of the linked issues, primary first, deduplicated across issues. */
	linkedIssueAssignees: string[];
}

/**
 * Which ignore labels mute this PR, whether they sit on the PR itself or on a linked issue.
 * Naming them rather than answering yes/no is what lets the report say why a PR is missing.
 * Order follows ignoreLabels so the answer does not depend on how GitHub orders labels.
 */
export function blockingLabels(e: EnrichedPr, ignoreLabels: string[]): string[] {
	const present = new Set(e.raw.labels.map((l) => l.name));
	for (const labels of e.linkedIssueLabels.values()) {
		for (const l of labels) present.add(l);
	}
	return ignoreLabels.filter((l) => present.has(l));
}

export function shouldIncludePr(e: EnrichedPr, ignoreLabels: string[], requireLinkedIssue = false): boolean {
	if (e.raw.draft) return false;
	// By default every open PR in review is visible; requireLinkedIssue restores the stricter rule.
	// Either way linked issues still mute PRs by label and route bot PRs to an assignee.
	if (requireLinkedIssue && e.linkedIssueLabels.size === 0) return false;
	return blockingLabels(e, ignoreLabels).length === 0;
}

/** The run input decides the thresholds; the config file decides where the weekend falls. */
export type RecordOptions = Pick<
	InputSchema,
	| 'warningThresholdHours'
	| 'screamThresholdHours'
	| 'iterationWarningThresholdHours'
	| 'iterationScreamThresholdHours'
	| 'skipWeekends'
	| 'ignoreLabels'
> &
	Pick<AppConfig, 'timeZone'>;

/** Waiting time as the thresholds see it: calendar time, minus weekends when configured. */
function elapsedMs(startedAt: string, now: number, options: RecordOptions): number {
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
	const authorLogin = e.raw.user?.login ?? UNKNOWN_LOGIN;

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
		reopenedCount: e.reopenedCount,
		reopenedAt: e.reopenedAt,
		isDraft: e.raw.draft,
		labels: e.raw.labels.map((l) => l.name),
		blockedLabels: blockingLabels(e, options.ignoreLabels),
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

/**
 * Blocked PRs old enough to be worth a reminder, oldest first.
 *
 * The clock is the PR's total age, not how long the label has been on: a label added to a
 * linked issue leaves no trace on the PR, so "blocked since" is not a number we can read.
 * The threshold exists to keep freshly parked PRs out — a PR blocked this morning is not
 * forgotten yet.
 */
export function selectBlockedPrs(records: PrRecord[], thresholdHours: number): PrRecord[] {
	return records
		.filter((r) => r.blockedLabels.length > 0 && r.durationHours >= thresholdHours)
		.sort((a, b) => b.durationMs - a.durationMs);
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
	const timestamps = await github.getReviewTimestamps(repo, raw.number);
	const { readyForReviewAt, iterationStartedAt } = resolvePrClocks(raw.created_at, timestamps);

	const reviews = await github.listReviews(repo, raw.number);
	const review = summarizeReviews(
		reviews,
		raw.requested_reviewers.map((u) => u.login),
		raw.requested_teams.length,
		raw.user?.login ?? UNKNOWN_LOGIN,
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

	return {
		raw,
		repo,
		readyForReviewAt,
		iterationStartedAt,
		reopenedCount: timestamps.reopenedCount,
		reopenedAt: timestamps.lastReopenedAt,
		review,
		linkedIssueLabels,
		linkedIssueAssignees,
	};
}

export async function run(): Promise<void> {
	const rawInput = (await Actor.getInput()) ?? {};
	const input = validateInput(rawInput);

	const userMapping = loadUserMapping(input);
	const texts = loadTexts(TEXTS_FILE, input.texts);
	const config = loadConfig(CONFIG_FILE);
	// Thresholds come from the run, the weekend calendar from the config file.
	const recordOptions: RecordOptions = { ...input, ...config };

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
	// Nothing scanned is not the same as nothing waiting — an "all clear" report here would be a lie.
	if (repos.length === 0) {
		throw new Error(
			`No repository in org "${input.githubOrg}" carries topic "${input.githubTopic}" — nothing was scanned. Check the org and the topic.`,
		);
	}

	const enriched: EnrichedPr[] = [];
	let drafts = 0;
	let failedRepos = 0;
	for (const repo of repos) {
		let pulls: RawPullRequest[] = [];
		try {
			pulls = await github.listOpenPulls(repo);
		} catch (err) {
			failedRepos++;
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

	if (failedRepos === repos.length) {
		throw new Error(
			`Failed to list pull requests for all ${failedRepos} scanned repos (see the warnings above) — refusing to report an empty result.`,
		);
	}

	const filtered = enriched.filter((e) => shouldIncludePr(e, input.ignoreLabels, input.requireLinkedIssue));
	const gate = input.requireLinkedIssue ? 'label and linked-issue filters' : 'label filters';
	log.info(`${filtered.length}/${enriched.length} non-draft PRs pass ${gate}; ${drafts} drafts skipped.`);
	if (input.skipWeekends) log.info(`Weekends are excluded from waiting times (time zone ${config.timeZone}).`);

	const now = Date.now();
	let records = filtered.map((e) => toPrRecord(e, now, recordOptions));
	records = applyModeFilter(records, input.mode, input.overdueThresholdHours, input.iterationOverdueThresholdHours);
	records.sort((a, b) => b.durationMs - a.durationMs);

	log.info(`Mode=${input.mode}: ${records.length} PRs will be reported.`);

	// Blocked PRs never reach `records` — the label filter dropped them, which is the point.
	// They are rebuilt here so the report can remind the team that they are still sitting there.
	const blockedRecords = input.reportBlockedPrs
		? selectBlockedPrs(
				enriched
					.filter((e) => blockingLabels(e, input.ignoreLabels).length > 0)
					.map((e) => toPrRecord(e, now, recordOptions)),
				input.blockedPrThresholdHours,
			)
		: [];
	if (input.reportBlockedPrs) {
		log.info(
			`${blockedRecords.length} blocked PR(s) older than ${input.blockedPrThresholdHours}h will be summarized.`,
		);
	}

	// Blocked records go to the dataset too — it is the ground truth for "why is my PR missing",
	// and `blockedLabels` is the answer.
	await Actor.pushData([...records, ...blockedRecords]);

	const unassignedBotPrs = records.filter(isUnassignedBotPr);
	if (unassignedBotPrs.length > 0) {
		log.info(
			`${unassignedBotPrs.length} bot PR(s) have no assignee to tag (listed=${input.notifyUnassignedBotPrs}, summarized=${input.summarizeUnassignedBotPrs}).`,
		);
	}

	for (const r of records) {
		if (resolveSlackId(userMapping, r.notifyLogin)) continue;
		if (isBotLogin(r.notifyLogin)) {
			// Muting them was the point of the toggle — repeating it per PR is just noise.
			if (!input.notifyUnassignedBotPrs) continue;
			log.warning(
				`${r.repo.name}#${r.number} was opened by ${r.notifyLogin} and no linked ticket has an assignee — nobody will be notified.`,
			);
		} else {
			log.warning(`No Slack mapping for GitHub user: ${r.notifyLogin}`);
		}
	}

	if (records.length === 0 && failedRepos > 0) {
		log.warning(`${failedRepos} repo(s) could not be scanned, so this empty result may be incomplete.`);
	}

	// The summary is content too: a report that only counts bot PRs is still worth posting.
	const listedCount = input.notifyUnassignedBotPrs ? records.length : records.length - unassignedBotPrs.length;
	const hasContent =
		listedCount > 0 ||
		(input.summarizeUnassignedBotPrs && unassignedBotPrs.length > 0) ||
		blockedRecords.length > 0;

	if (!hasContent && !input.sendEmptyReport) {
		log.info('Nothing to report and sendEmptyReport=false — skipping Slack notification.');
		return;
	}

	const message = buildSlackMessage(records, userMapping, texts, {
		notifyUnassignedBotPrs: input.notifyUnassignedBotPrs,
		summarizeUnassignedBotPrs: input.summarizeUnassignedBotPrs,
		blockedPrs: blockedRecords,
	});
	log.info(`Slack payload:\n${message}`);

	try {
		await slack.postMessage(input.slackChannelId, message);
	} catch (err) {
		log.error(`Failed to post Slack message: ${(err as Error).message}`);
		throw err;
	}
}
