export function resolveSlackId(mapping: Record<string, string>, githubLogin: string): string | null {
	return mapping[githubLogin] ?? null;
}
