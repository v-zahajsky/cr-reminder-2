import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { log } from 'apify';

/**
 * Every piece of prose in the Slack message. They live together because they are read
 * together — a team changing the tone of the report changes all of them at once, and
 * hunting five separate input fields for that is how one of them ends up out of step.
 */
export const TEXT_KEYS = ['header', 'newPrHeader', 'botPrSummaryHeader', 'blockedPrHeader', 'footer'] as const;

export type TextKey = (typeof TEXT_KEYS)[number];
export type Texts = Record<TextKey, string>;

/**
 * Built in, so the actor produces a sensible message with no texts file and no input at all.
 *
 * The footer says two things nobody can infer from the lines above it: the tag is the PR
 * author rather than a reviewer, and there is a way out. Each line carries its own
 * underscores because Slack italics do not survive a newline.
 */
export const DEFAULT_TEXTS: Texts = {
	header: 'Pull requests in review:',
	newPrHeader: 'New PRs — nobody has looked at these yet:',
	botPrSummaryHeader: 'Bot PRs with nobody assigned:',
	blockedPrHeader: 'Blocked PRs — make sure they are not forgotten:',
	footer: [
		'_The tagged person is the PR author — chase your reviewers, or pull in someone new._',
		'_Really blocked? Put the `blocked` label on the PR and comment why — the bot then leaves it alone._',
	].join('\n'),
};

const KEY_SET = new Set<string>(TEXT_KEYS);

/**
 * Reads a partial set of texts. Only the keys that are present are returned, so the caller
 * can layer several sources over the defaults without a missing key wiping one out.
 *
 * An unknown key is an error rather than a shrug: a misspelled `blockedPRHeader` would
 * otherwise print the default text forever with nothing to say why. Keys starting with an
 * underscore are ignored, so the file can carry a "_comment".
 */
export function parseTexts(raw: unknown, source: string): Partial<Texts> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`${source} must contain a JSON object of { "textKey": "text" }.`);
	}

	const texts: Partial<Texts> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (key.startsWith('_')) continue;
		if (!KEY_SET.has(key)) {
			throw new Error(`${source}: unknown text key "${key}". Known keys: ${TEXT_KEYS.join(', ')}.`);
		}
		// An empty string is a real value — it is how the footer is switched off — so only the
		// type is checked here, never the length.
		if (typeof value !== 'string') {
			throw new Error(`${source}: text "${key}" must be a string, got ${JSON.stringify(value)}.`);
		}
		texts[key as TextKey] = value;
	}
	return texts;
}

/**
 * Built-in defaults, then the file, then the per-run override — each layer replacing only the
 * keys it names. A missing file is normal: the defaults are a complete message on their own.
 */
export function loadTexts(file: string, override: Record<string, unknown>): Texts {
	const path = resolve(process.cwd(), file);
	const fromInput = parseTexts(override, 'texts input');
	let fromFile: Partial<Texts> = {};

	if (existsSync(path)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, 'utf8'));
		} catch (err) {
			throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
		}
		fromFile = parseTexts(parsed, file);
		log.info(`Loaded ${Object.keys(fromFile).length} message text(s) from ${file}.`);
	} else {
		log.info(`"${file}" does not exist; using the built-in message texts.`);
	}

	const overridden = Object.keys(fromInput);
	if (overridden.length > 0) log.info(`Input overrides ${overridden.length} text(s): ${overridden.join(', ')}.`);

	return { ...DEFAULT_TEXTS, ...fromFile, ...fromInput };
}
