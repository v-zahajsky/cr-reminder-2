export type Mode = 'overdue' | 'all';
export type Severity = 'ok' | 'warning' | 'scream';

export interface InputSchema {
	githubToken: string;
	githubOrg: string;
	githubTopic: string;
	slackBotToken: string;
	slackChannelId: string;
	userMapping: Record<string, string>;
	mode: Mode;
	overdueThresholdDays: number;
	warningThresholdDays: number;
	screamThresholdDays: number;
	sendEmptyReport: boolean;
	headerText: string;
	ignoreLabels: string[];
}

export interface RepoRef {
	owner: string;
	name: string;
}

export interface PrRecord {
	repo: RepoRef;
	number: number;
	title: string;
	url: string;
	authorLogin: string;
	createdAt: string;
	readyForReviewAt: string;
	isDraft: boolean;
	labels: string[];
	body: string;
	linkedIssueNumbers: number[];
	durationMs: number;
	durationDays: number;
	durationHuman: string;
	severity: Severity;
}
