import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { log } from 'apify';

import { assertValidTimeZone } from './time.js';

/**
 * Settings that decide how the actor computes, rather than what a given run reports.
 * They live in a file instead of the run input because nobody is expected to touch them:
 * offering a team's time zone as a per-run knob invites it to be changed by accident.
 */
export const CONFIG_KEYS = ['timeZone'] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type AppConfig = Record<ConfigKey, string>;

/** Built in, so the actor runs correctly with no config file at all. */
export const DEFAULT_CONFIG: AppConfig = {
	timeZone: 'Europe/Prague',
};

const KEY_SET = new Set<string>(CONFIG_KEYS);

/**
 * Reads a partial config. Only the keys present are returned, so the file can name one
 * setting without wiping the rest. An unknown key is an error — a misspelled `timezone`
 * would otherwise leave the default in place with nothing to say why.
 */
export function parseConfig(raw: unknown, source: string): Partial<AppConfig> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`${source} must contain a JSON object of { "setting": "value" }.`);
	}

	const config: Partial<AppConfig> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (key.startsWith('_')) continue;
		if (!KEY_SET.has(key)) {
			throw new Error(`${source}: unknown setting "${key}". Known settings: ${CONFIG_KEYS.join(', ')}.`);
		}
		if (typeof value !== 'string') {
			throw new Error(`${source}: setting "${key}" must be a string, got ${JSON.stringify(value)}.`);
		}
		config[key as ConfigKey] = value;
	}

	// A zone the platform cannot resolve would silently misplace every weekend boundary.
	if (config.timeZone !== undefined) assertValidTimeZone(config.timeZone);
	return config;
}

/** Built-in defaults with the file layered over them; a missing file is normal. */
export function loadConfig(file: string): AppConfig {
	const path = resolve(process.cwd(), file);
	if (!existsSync(path)) {
		log.info(`"${file}" does not exist; using the built-in configuration.`);
		return { ...DEFAULT_CONFIG };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch (err) {
		throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
	}

	const fromFile = parseConfig(parsed, file);
	log.info(`Loaded ${Object.keys(fromFile).length} setting(s) from ${file}.`);
	return { ...DEFAULT_CONFIG, ...fromFile };
}
