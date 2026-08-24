// GitHub also accepts a colon after the keyword ("Fixes: #12"), so allow one.
const CLOSING_KEYWORDS = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi;

export function parseLinkedIssueNumbers(body: string | null | undefined): number[] {
	if (!body) return [];
	const found = new Set<number>();
	for (const match of body.matchAll(CLOSING_KEYWORDS)) {
		found.add(parseInt(match[1], 10));
	}
	return Array.from(found);
}
