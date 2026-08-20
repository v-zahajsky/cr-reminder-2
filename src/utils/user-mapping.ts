/** GitHub marks app accounts with a "[bot]" suffix on the login. */
export function isBotLogin(login: string): boolean {
	return login.endsWith('[bot]');
}

export function resolveSlackId(mapping: Record<string, string>, githubLogin: string): string | null {
	return mapping[githubLogin] ?? null;
}

/**
 * Accepts either the short form
 *   { "githubLogin": "U123ABC" }
 * or the annotated form, which keeps a long table readable
 *   { "githubLogin": { "slackId": "U123ABC", "name": "Jane Doe" } }
 *
 * Keys starting with an underscore are ignored, so the file can carry a "_comment".
 */
export function parseUserMapping(raw: unknown, source: string): Record<string, string> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`${source} must contain a JSON object of { "githubLogin": "SlackUserId" }.`);
	}

	const mapping: Record<string, string> = {};
	for (const [login, value] of Object.entries(raw as Record<string, unknown>)) {
		if (login.startsWith('_')) continue;

		if (typeof value === 'string') {
			mapping[login] = value;
			continue;
		}
		const slackId = (value as { slackId?: unknown } | null)?.slackId;
		if (typeof slackId === 'string') {
			mapping[login] = slackId;
			continue;
		}
		throw new Error(
			`${source}: entry "${login}" must be a Slack user ID string, or an object with a "slackId" field.`,
		);
	}
	return mapping;
}
