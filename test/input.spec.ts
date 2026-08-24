import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadUserMapping, validateInput } from '../src/runner.js';

const REQUIRED = {
	githubToken: 'ghp_x',
	githubOrg: 'apify-store',
	githubTopic: 'apify-actor',
	slackBotToken: 'xoxb-x',
	slackChannelId: 'C1',
	sendEmptyReport: false,
};

describe('validateInput', () => {
	it('fills in the documented defaults', () => {
		const input = validateInput({ ...REQUIRED });
		expect(input.mode).toBe('overdue');
		expect(input.overdueThresholdHours).toBe(24);
		expect(input.warningThresholdHours).toBe(72);
		expect(input.screamThresholdHours).toBe(168);
		expect(input.skipWeekends).toBe(true);
		expect(input.ignoreLabels).toEqual(['blocked']);
	});

	it('explains the tag and the blocked label in the default footer', () => {
		const { footerText } = validateInput({ ...REQUIRED });
		expect(footerText).toContain('PR author');
		expect(footerText).toContain('`blocked` label on the PR');
	});

	it('lets an empty footer switch the explanation off', () => {
		expect(validateInput({ ...REQUIRED, footerText: '' }).footerText).toBe('');
		expect(validateInput({ ...REQUIRED, footerText: 'custom' }).footerText).toBe('custom');
	});

	it('defaults the iteration limits to the total-age limits', () => {
		const input = validateInput({ ...REQUIRED, warningThresholdHours: 10, screamThresholdHours: 20 });
		expect(input.iterationWarningThresholdHours).toBe(10);
		expect(input.iterationScreamThresholdHours).toBe(20);
		expect(input.iterationOverdueThresholdHours).toBe(24);
	});

	it('rejects missing credentials', () => {
		expect(() => validateInput({ ...REQUIRED, githubToken: '' })).toThrow(/githubToken/);
		expect(() => validateInput({ ...REQUIRED, slackChannelId: undefined })).toThrow(/slackChannelId/);
	});

	it('rejects a non-boolean sendEmptyReport and an unknown mode', () => {
		expect(() => validateInput({ ...REQUIRED, sendEmptyReport: 'yes' })).toThrow(/sendEmptyReport/);
		expect(() => validateInput({ ...REQUIRED, mode: 'loud' })).toThrow(/mode/);
	});

	it('rejects an inverted severity pair', () => {
		expect(() => validateInput({ ...REQUIRED, warningThresholdHours: 200 })).toThrow(/screamThresholdHours/);
	});

	// A string or NaN would make every threshold comparison false and silently report nothing.
	it('rejects thresholds that are not non-negative numbers', () => {
		expect(() => validateInput({ ...REQUIRED, overdueThresholdHours: '24' })).toThrow(
			/overdueThresholdHours must be a non-negative number/,
		);
		expect(() => validateInput({ ...REQUIRED, iterationWarningThresholdHours: -1 })).toThrow(
			/iterationWarningThresholdHours/,
		);
	});

	it('rejects ignoreLabels that is not a list of strings', () => {
		expect(() => validateInput({ ...REQUIRED, ignoreLabels: 'blocked' })).toThrow(/ignoreLabels/);
		expect(() => validateInput({ ...REQUIRED, ignoreLabels: ['blocked', 7] })).toThrow(/ignoreLabels/);
	});

	it('rejects an invalid time zone', () => {
		expect(() => validateInput({ ...REQUIRED, timeZone: 'Mars/Olympus' })).toThrow(/IANA/);
	});
});

describe('loadUserMapping', () => {
	const base = validateInput({ ...REQUIRED, userMappingFile: 'no-such-mapping-file.json' });

	it('accepts the annotated form in the input overrides', () => {
		const input = { ...base, userMapping: { radimkvet: { slackId: 'U123', name: 'Radim' } } };
		expect(loadUserMapping(input)).toEqual({ radimkvet: 'U123' });
	});

	it('accepts the short form and skips underscore keys', () => {
		const input = { ...base, userMapping: { _comment: 'ignored', oklinov: 'U9' } };
		expect(loadUserMapping(input)).toEqual({ oklinov: 'U9' });
	});

	it('rejects an override that is neither a Slack ID nor a { slackId } object', () => {
		const input = { ...base, userMapping: { oklinov: 42 } };
		expect(() => loadUserMapping(input)).toThrow(/oklinov/);
	});

	describe('with a mapping file on disk', () => {
		const file = '.tmp-test-user-mapping.json';
		const path = resolve(process.cwd(), file);

		afterEach(() => {
			rmSync(path, { force: true });
		});

		it('merges the file with the input, letting the input win', () => {
			writeFileSync(
				path,
				JSON.stringify({ _comment: 'ignored', oklinov: 'UFILE', radimkvet: { slackId: 'U1' } }),
			);
			const input = validateInput({ ...REQUIRED, userMappingFile: file, userMapping: { oklinov: 'UINPUT' } });
			expect(loadUserMapping(input)).toEqual({ oklinov: 'UINPUT', radimkvet: 'U1' });
		});

		it('names the file when it does not hold valid JSON', () => {
			writeFileSync(path, '{ not json');
			const input = validateInput({ ...REQUIRED, userMappingFile: file });
			expect(() => loadUserMapping(input)).toThrow(new RegExp(`${file} is not valid JSON`));
		});

		it('names the offending entry in the file', () => {
			writeFileSync(path, JSON.stringify({ oklinov: 42 }));
			const input = validateInput({ ...REQUIRED, userMappingFile: file });
			expect(() => loadUserMapping(input)).toThrow(/oklinov/);
		});
	});
});
