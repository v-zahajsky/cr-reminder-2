import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CONFIG_KEYS, DEFAULT_CONFIG, loadConfig, parseConfig } from '../src/utils/config.js';

describe('parseConfig', () => {
	it('returns only the keys it was given', () => {
		expect(parseConfig({ timeZone: 'Europe/Berlin' }, 'config.json')).toEqual({ timeZone: 'Europe/Berlin' });
	});

	it('ignores keys starting with an underscore so the file can document itself', () => {
		expect(parseConfig({ _comment: 'why', timeZone: 'UTC' }, 'config.json')).toEqual({ timeZone: 'UTC' });
	});

	it('rejects an unknown key rather than silently ignoring it', () => {
		expect(() => parseConfig({ timezone: 'UTC' }, 'config.json')).toThrow(/unknown/i);
		// The message has to name what is allowed, or the typo is a guessing game.
		expect(() => parseConfig({ timezone: 'UTC' }, 'config.json')).toThrow(/timeZone/);
	});

	it('rejects a time zone the platform does not know', () => {
		expect(() => parseConfig({ timeZone: 'Mars/Olympus' }, 'config.json')).toThrow(/IANA/);
	});

	it('rejects a value that is not a string', () => {
		expect(() => parseConfig({ timeZone: 2 }, 'config.json')).toThrow(/must be a string/);
	});

	it('rejects anything that is not a JSON object', () => {
		expect(() => parseConfig([], 'config.json')).toThrow(/config\.json/);
	});
});

describe('DEFAULT_CONFIG', () => {
	it('covers every key, so the actor runs with no config file at all', () => {
		expect(Object.keys(DEFAULT_CONFIG).sort()).toEqual([...CONFIG_KEYS].sort());
	});

	it('puts the weekend boundaries where the team is', () => {
		expect(DEFAULT_CONFIG.timeZone).toBe('Europe/Prague');
	});
});

describe('loadConfig', () => {
	const FILE = 'config/config.spec.tmp.json';
	const path = resolve(process.cwd(), FILE);

	afterEach(() => {
		rmSync(path, { force: true });
	});

	it('falls back to the built-in config when the file is missing', () => {
		expect(loadConfig(FILE)).toEqual(DEFAULT_CONFIG);
	});

	it('takes the time zone from the file', () => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ timeZone: 'America/New_York' }));
		expect(loadConfig(FILE).timeZone).toBe('America/New_York');
	});

	it('names the file when its JSON is broken', () => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, '{ not json');
		expect(() => loadConfig(FILE)).toThrow(/config\.spec\.tmp\.json/);
	});
});
