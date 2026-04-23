const CLOSING_KEYWORDS = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

export function parseLinkedIssueNumbers(body: string | null | undefined): number[] {
	if (!body) return [];
	const found = new Set<number>();
	for (const match of body.matchAll(CLOSING_KEYWORDS)) {
		const n = parseInt(match[1], 10);
		if (!Number.isNaN(n)) found.add(n);
	}
	return Array.from(found);
}
