import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';
import { log } from 'apify';

import type { IssueDetails, RepoRef } from '../types.js';

const OctokitWithPlugins = Octokit.plugin(retry, throttling);

export interface RawPullRequest {
	number: number;
	title: string;
	html_url: string;
	user: { login: string } | null;
	body: string | null;
	created_at: string;
	draft: boolean;
	labels: { name: string }[];
	/** Only reviewers who have NOT submitted a review yet — GitHub drops them once they do. */
	requested_reviewers: { login: string }[];
	requested_teams: { slug: string }[];
}

export interface RawReview {
	login: string;
	/** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
	state: string;
	submittedAt: string;
}

/** The timeline fields this actor reads; GitHub sends many more, and many more kinds of event. */
export interface TimelineEvent {
	event?: string;
	created_at?: string;
}

export interface ReviewTimestamps {
	/** Latest 'ready for review' event, null if the PR was never a draft. */
	readyForReviewAt: string | null;
	/** Latest 'review requested' event — starts a new review round. */
	lastReviewRequestedAt: string | null;
	/** Latest 'reopened' event — the PR is back in the queue, so its clocks start again there. */
	lastReopenedAt: string | null;
	/** How many times the PR has been closed and reopened. */
	reopenedCount: number;
}

/** Kept pure, and separate from the fetch, so the event rules can be tested without a GitHub call. */
export function scanReviewTimeline(events: TimelineEvent[]): ReviewTimestamps {
	let readyForReviewAt: string | null = null;
	let lastReviewRequestedAt: string | null = null;
	let lastReopenedAt: string | null = null;
	let reopenedCount = 0;

	for (const e of events) {
		if (!e.created_at) continue;
		if (e.event === 'ready_for_review') {
			if (!readyForReviewAt || e.created_at > readyForReviewAt) readyForReviewAt = e.created_at;
		} else if (e.event === 'review_requested') {
			if (!lastReviewRequestedAt || e.created_at > lastReviewRequestedAt) {
				lastReviewRequestedAt = e.created_at;
			}
		} else if (e.event === 'reopened') {
			reopenedCount++;
			if (!lastReopenedAt || e.created_at > lastReopenedAt) lastReopenedAt = e.created_at;
		}
	}

	return { readyForReviewAt, lastReviewRequestedAt, lastReopenedAt, reopenedCount };
}

export class GithubClient {
	private readonly octokit: InstanceType<typeof OctokitWithPlugins>;
	private readonly issueCache = new Map<string, IssueDetails>();

	constructor(token: string) {
		this.octokit = new OctokitWithPlugins({
			auth: token,
			throttle: {
				onRateLimit: (retryAfter, options, _octokit, retryCount) => {
					log.warning(
						`GitHub rate limit hit for ${options.method} ${options.url}; retry ${retryCount} in ${retryAfter}s`,
					);
					return retryCount < 2;
				},
				onSecondaryRateLimit: (retryAfter, options) => {
					log.warning(
						`GitHub secondary rate limit for ${options.method} ${options.url}; backing off ${retryAfter}s`,
					);
					return true;
				},
			},
		});
	}

	async discoverRepos(org: string, topic: string): Promise<RepoRef[]> {
		const q = `topic:${topic} org:${org}`;
		const repos: RepoRef[] = [];
		for await (const res of this.octokit.paginate.iterator(this.octokit.rest.search.repos, {
			q,
			per_page: 100,
		})) {
			// A timed-out search returns a partial page; without this the report just silently misses repos.
			if ((res.data as unknown as { incomplete_results?: boolean }).incomplete_results) {
				log.warning(`GitHub search for "${q}" returned incomplete results — some repos may be missing.`);
			}
			for (const r of res.data) {
				if (r.archived || r.fork) continue;
				repos.push({ owner: r.owner?.login ?? org, name: r.name });
			}
		}
		return repos;
	}

	async listOpenPulls(repo: RepoRef): Promise<RawPullRequest[]> {
		const out: RawPullRequest[] = [];
		for await (const res of this.octokit.paginate.iterator(this.octokit.rest.pulls.list, {
			owner: repo.owner,
			repo: repo.name,
			state: 'open',
			per_page: 100,
		})) {
			for (const p of res.data) {
				out.push({
					number: p.number,
					title: p.title,
					html_url: p.html_url,
					user: p.user ? { login: p.user.login } : null,
					body: p.body,
					created_at: p.created_at,
					draft: Boolean(p.draft),
					labels: p.labels.map((l) => ({ name: l.name })),
					requested_reviewers: (p.requested_reviewers || []).map((u) => ({ login: u.login })),
					requested_teams: (p.requested_teams || []).map((t) => ({ slug: t.slug })),
				});
			}
		}
		return out;
	}

	/**
	 * One timeline read answers everything the clocks need: when the PR last became reviewable,
	 * when a review was last requested (which opens a new review round), and whether it has been
	 * closed and reopened since.
	 */
	async getReviewTimestamps(repo: RepoRef, prNumber: number): Promise<ReviewTimestamps> {
		try {
			const events = await this.octokit.paginate(this.octokit.rest.issues.listEventsForTimeline, {
				owner: repo.owner,
				repo: repo.name,
				issue_number: prNumber,
				per_page: 100,
			});
			return scanReviewTimeline(events as TimelineEvent[]);
		} catch (err) {
			log.warning(
				`Failed to fetch timeline for ${repo.owner}/${repo.name}#${prNumber}: ${(err as Error).message}`,
			);
			return scanReviewTimeline([]);
		}
	}

	async listReviews(repo: RepoRef, prNumber: number): Promise<RawReview[]> {
		try {
			const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
				owner: repo.owner,
				repo: repo.name,
				pull_number: prNumber,
				per_page: 100,
			});
			const out: RawReview[] = [];
			for (const r of reviews) {
				const login = r.user?.login;
				// An unsubmitted (pending) review has no submitted_at and is visible only to its author.
				if (!login || !r.submitted_at) continue;
				out.push({ login, state: r.state, submittedAt: r.submitted_at });
			}
			return out;
		} catch (err) {
			log.warning(
				`Failed to fetch reviews for ${repo.owner}/${repo.name}#${prNumber}: ${(err as Error).message}`,
			);
			return [];
		}
	}

	/** Labels gate the PR; assignees tell us who to tag when a bot opened it. Both come from one call. */
	async getIssueDetails(repo: RepoRef, issueNumber: number): Promise<IssueDetails> {
		const key = `${repo.owner}/${repo.name}#${issueNumber}`;
		const cached = this.issueCache.get(key);
		if (cached) return cached;
		try {
			const { data } = await this.octokit.rest.issues.get({
				owner: repo.owner,
				repo: repo.name,
				issue_number: issueNumber,
			});
			const labels = (data.labels || []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
			// data.assignee is the primary one and is repeated in data.assignees; keep it first.
			const assignees: string[] = [];
			if (data.assignee?.login) assignees.push(data.assignee.login);
			for (const a of data.assignees || []) {
				if (a.login && !assignees.includes(a.login)) assignees.push(a.login);
			}
			const details: IssueDetails = { labels, assignees };
			this.issueCache.set(key, details);
			return details;
		} catch (err) {
			log.warning(`Failed to fetch issue ${key}: ${(err as Error).message}`);
			const empty: IssueDetails = { labels: [], assignees: [] };
			this.issueCache.set(key, empty);
			return empty;
		}
	}
}
