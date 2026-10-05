import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEXTS, loadTexts, parseTexts, TEXT_KEYS } from '../src/utils/texts.js';

describe('parseTexts', () => {
	it('returns only the keys it was given', () => {
		expect(parseTexts({ header: 'Reviews:' }, 'texts input')).toEqual({ header: 'Reviews:' });
	});

	it('keeps an empty string — that is how a text is switched off', () => {
		expect(parseTexts({ footer: '' }, 'texts input')).toEqual({ footer: '' });
	});

	it('ignores keys starting with an underscore so the file can document itself', () => {
		expect(parseTexts({ _comment: 'anything', header: 'Reviews:' }, 'texts.json')).toEqual({ header: 'Reviews:' });
	});

	it('rejects an unknown key rather than silently printing the default', () => {
		expect(() => parseTexts({ blockedPRHeader: 'oops' }, 'texts.json')).toThrow(/blockedPRHeader/);
		// The message has to say what is allowed, or the typo is a guessing game.
		expect(() => parseTexts({ blockedPRHeader: 'oops' }, 'texts.json')).toThrow(/blockedPrHeader/);
	});

	it('rejects a value that is not a string', () => {
		expect(() => parseTexts({ header: 42 }, 'texts.json')).toThrow(/header/);
		expect(() => parseTexts({ header: null }, 'texts.json')).toThrow(/header/);
	});

	it('rejects anything that is not a JSON object', () => {
		expect(() => parseTexts(['header'], 'texts.json')).toThrow(/texts\.json/);
		expect(() => parseTexts('header', 'texts.json')).toThrow(/texts\.json/);
	});
});

describe('DEFAULT_TEXTS', () => {
	it('covers every key the message needs, so the actor runs without a texts file', () => {
		expect(Object.keys(DEFAULT_TEXTS).sort()).toEqual([...TEXT_KEYS].sort());
	});

	it('explains the tag and the blocked label in the footer', () => {
		expect(DEFAULT_TEXTS.footer).toContain('PR author');
		expect(DEFAULT_TEXTS.footer).toContain('`blocked` label on the PR');
	});
});

describe('loadTexts', () => {
	const FILE = 'texts.spec.tmp.json';
	const path = resolve(process.cwd(), FILE);

	afterEach(() => {
		rmSync(path, { force: true });
	});

	it('falls back to the built-in texts when the file is missing', () => {
		expect(loadTexts(FILE, {})).toEqual(DEFAULT_TEXTS);
	});

	it('layers the file over the built-in texts, key by key', () => {
		writeFileSync(path, JSON.stringify({ header: 'Reviews:' }));
		const texts = loadTexts(FILE, {});
		expect(texts.header).toBe('Reviews:');
		expect(texts.newPrHeader).toBe(DEFAULT_TEXTS.newPrHeader);
	});

	it('lets the input override win over the file', () => {
		writeFileSync(path, JSON.stringify({ header: 'From file:' }));
		expect(loadTexts(FILE, { header: 'From input:' }).header).toBe('From input:');
	});

	it('honours an empty override — the footer really is switched off', () => {
		writeFileSync(path, JSON.stringify({ footer: 'From file' }));
		expect(loadTexts(FILE, { footer: '' }).footer).toBe('');
	});

	it('names the file when its JSON is broken', () => {
		writeFileSync(path, '{ not json');
		expect(() => loadTexts(FILE, {})).toThrow(new RegExp(FILE));
	});
});
