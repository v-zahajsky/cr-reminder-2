import { describe, expect, it } from 'vitest';

import { parseLinkedIssueNumbers } from '../src/utils/linked-issues.js';

describe('parseLinkedIssueNumbers', () => {
	it('returns empty for null/empty body', () => {
		expect(parseLinkedIssueNumbers(null)).toEqual([]);
		expect(parseLinkedIssueNumbers(undefined)).toEqual([]);
		expect(parseLinkedIssueNumbers('')).toEqual([]);
	});

	it('matches "Fixes #N"', () => {
		expect(parseLinkedIssueNumbers('Fixes #42')).toEqual([42]);
	});

	it('matches all closing keyword variants (case-insensitive)', () => {
		const body = 'Closes #1, fix #2, closed #3, fixes #4, fixed #5, Resolves #6, resolved #7';
		expect(parseLinkedIssueNumbers(body).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	it('ignores plain "See #99" references', () => {
		expect(parseLinkedIssueNumbers('See #99 for details')).toEqual([]);
	});

	it('deduplicates repeats', () => {
		expect(parseLinkedIssueNumbers('Fixes #7 and also closes #7')).toEqual([7]);
	});

	it('ignores cross-repo references ("owner/repo#N")', () => {
		expect(parseLinkedIssueNumbers('Fixes apify/other#5')).toEqual([]);
	});

	it('matches multiple independent references', () => {
		expect(parseLinkedIssueNumbers('Closes #1\nFixes #2\nResolves #3').sort((a, b) => a - b)).toEqual([1, 2, 3]);
	});
});
