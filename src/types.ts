export type Mode = 'overdue' | 'all';
export type Severity = 'ok' | 'warning' | 'scream';

export interface InputSchema {
	githubToken: string;
	githubOrg: string;
	githubTopic: string;
	slackBotToken: string;
	slackChannelId: string;
	/** Path to the mapping table, relative to the actor root. */
	userMappingFile: string;
	/** Optional per-run overrides layered on top of the file; parsed like the file itself. */
	userMapping: Record<string, unknown>;
	mode: Mode;
	overdueThresholdHours: number;
	warningThresholdHours: number;
	screamThresholdHours: number;
	iterationOverdueThresholdHours: number;
	iterationWarningThresholdHours: number;
	iterationScreamThresholdHours: number;
	requireLinkedIssue: boolean;
	skipWeekends: boolean;
	sendEmptyReport: boolean;
	/** When false, bot PRs that no linked ticket assigns to a human are left out of the list. */
	notifyUnassignedBotPrs: boolean;
	/** When true, those bot PRs are counted per repo above the footer instead of vanishing silently. */
	summarizeUnassignedBotPrs: boolean;
	/** When true, PRs muted by an ignore label are counted per repo so they are not forgotten. */
	reportBlockedPrs: boolean;
	/** How old a blocked PR must be before it is worth reminding anyone about. */
	blockedPrThresholdHours: number;
	/** Per-run overrides of the message texts, layered over texts.json and the built-in defaults. */
	texts: Record<string, unknown>;
	ignoreLabels: string[];
}

export interface RepoRef {
	owner: string;
	name: string;
}

/** Labels and assignees of a linked issue, read from a single issues.get call. */
export interface IssueDetails {
	labels: string[];
	assignees: string[];
}

/** How many of the people involved in the review have approved. */
export interface ReviewSummary {
	/** Reviewers whose latest decisive review is an approval. */
	approvedBy: string[];
	approvedCount: number;
	/** Everyone who reviewed, plus everyone still waited on. 0 = nobody is on the hook. */
	reviewerCount: number;
	/** How many people have actually submitted a review. 0 = nobody has looked yet. */
	reviewedByCount: number;
}

export interface PrRecord {
	repo: RepoRef;
	number: number;
	title: string;
	url: string;
	/** Who opened the PR — may be a bot. */
	authorLogin: string;
	/** Who actually gets tagged: the author, or the linked ticket assignee for bot-authored PRs. */
	notifyLogin: string;
	linkedIssueAssignees: string[];
	createdAt: string;
	readyForReviewAt: string;
	/** Start of the current review round — see resolveIterationStart(). */
	iterationStartedAt: string;
	/** How many times the PR was closed and reopened; 0 on a PR that never was. */
	reopenedCount: number;
	/** The latest reopen — where both clocks restart. Null when it never happened. */
	reopenedAt: string | null;
	isDraft: boolean;
	labels: string[];
	/** Ignore labels found on the PR or a linked issue — empty on every reported PR. */
	blockedLabels: string[];
	body: string;
	linkedIssueNumbers: number[];
	/** Waiting time the thresholds and the message use — weekends excluded when skipWeekends is on. */
	durationMs: number;
	durationHours: number;
	durationHuman: string;
	/** Raw calendar time, kept for reference in the dataset. */
	durationWallMs: number;
	iterationMs: number;
	iterationHours: number;
	iterationHuman: string;
	iterationWallMs: number;
	approvedBy: string[];
	approvedCount: number;
	reviewerCount: number;
	reviewedByCount: number;
	/** Worse of the total-age severity and the current-round severity. */
	severity: Severity;
}
