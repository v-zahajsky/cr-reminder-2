import { describe, expect, it } from 'vitest';

import { isBotLogin, parseUserMapping, resolveSlackId } from '../src/utils/user-mapping.js';

describe('resolveSlackId', () => {
	it('returns Slack ID when mapping exists', () => {
		expect(resolveSlackId({ radimkvet: 'U123' }, 'radimkvet')).toBe('U123');
	});

	it('returns null when mapping missing', () => {
		expect(resolveSlackId({ radimkvet: 'U123' }, 'unknown')).toBeNull();
	});

	it('returns null for empty mapping', () => {
		expect(resolveSlackId({}, 'anyone')).toBeNull();
	});
});

describe('parseUserMapping', () => {
	it('reads the short form', () => {
		expect(parseUserMapping({ radimkvet: 'U1', oklinov: 'U2' }, 'file')).toEqual({
			radimkvet: 'U1',
			oklinov: 'U2',
		});
	});

	it('reads the annotated form, keeping only the Slack ID', () => {
		const raw = { radimkvet: { slackId: 'U1', name: 'Radim' } };
		expect(parseUserMapping(raw, 'file')).toEqual({ radimkvet: 'U1' });
	});

	it('accepts both forms side by side', () => {
		const raw = { a: 'U1', b: { slackId: 'U2', name: 'B' } };
		expect(parseUserMapping(raw, 'file')).toEqual({ a: 'U1', b: 'U2' });
	});

	it('skips underscore keys so the file can document itself', () => {
		expect(parseUserMapping({ _comment: 'how to use this', a: 'U1' }, 'file')).toEqual({ a: 'U1' });
	});

	it('returns an empty mapping for an empty object', () => {
		expect(parseUserMapping({}, 'file')).toEqual({});
	});

	it('rejects a non-object payload', () => {
		expect(() => parseUserMapping([{ a: 'U1' }], 'file')).toThrow(/must contain a JSON object/);
		expect(() => parseUserMapping(null, 'file')).toThrow(/must contain a JSON object/);
	});

	it('names the offending entry when a value makes no sense', () => {
		expect(() => parseUserMapping({ radimkvet: 42 }, 'user-mapping.json')).toThrow(/"radimkvet"/);
		expect(() => parseUserMapping({ radimkvet: { name: 'no id here' } }, 'file')).toThrow(/slackId/);
	});
});

describe('isBotLogin', () => {
	it('recognises the GitHub app suffix', () => {
		expect(isBotLogin('claude[bot]')).toBe(true);
		expect(isBotLogin('radimkvet')).toBe(false);
	});
});
