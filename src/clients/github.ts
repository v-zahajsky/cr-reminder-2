import { log } from 'apify';
import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

import type { PrRecord, RepoRef } from '../types.js';

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
}

export class GithubClient {
	private readonly octokit: InstanceType<typeof OctokitWithPlugins>;
	private readonly issueLabelCache = new Map<string, string[]>();

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
					labels: (p.labels || []).map((l: { name?: string } | string) =>
						typeof l === 'string' ? { name: l } : { name: l.name ?? '' },
					),
				});
			}
		}
		return out;
	}

	async getLatestReadyForReviewAt(repo: RepoRef, prNumber: number): Promise<string | null> {
		try {
			const events = await this.octokit.paginate(this.octokit.rest.issues.listEventsForTimeline, {
				owner: repo.owner,
				repo: repo.name,
				issue_number: prNumber,
				per_page: 100,
			});
			let latest: string | null = null;
			for (const ev of events) {
				if ((ev as { event?: string }).event === 'ready_for_review') {
					const createdAt = (ev as { created_at?: string }).created_at ?? null;
					if (createdAt && (!latest || createdAt > latest)) latest = createdAt;
				}
			}
			return latest;
		} catch (err) {
			log.warning(
				`Failed to fetch timeline for ${repo.owner}/${repo.name}#${prNumber}: ${(err as Error).message}`,
			);
			return null;
		}
	}

	async getIssueLabels(repo: RepoRef, issueNumber: number): Promise<string[]> {
		const key = `${repo.owner}/${repo.name}#${issueNumber}`;
		const cached = this.issueLabelCache.get(key);
		if (cached) return cached;
		try {
			const { data } = await this.octokit.rest.issues.get({
				owner: repo.owner,
				repo: repo.name,
				issue_number: issueNumber,
			});
			const labels = (data.labels || []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
			this.issueLabelCache.set(key, labels);
			return labels;
		} catch (err) {
			log.warning(`Failed to fetch issue ${key}: ${(err as Error).message}`);
			this.issueLabelCache.set(key, []);
			return [];
		}
	}
}

export function toRawLabels(pr: Pick<PrRecord, 'labels'>): string[] {
	return pr.labels;
}
