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

	it('keeps unassigned bot PRs listed and unsummarized unless asked otherwise', () => {
		const input = validateInput({ ...REQUIRED });
		expect(input.notifyUnassignedBotPrs).toBe(true);
		expect(input.summarizeUnassignedBotPrs).toBe(false);
	});

	it('takes the bot PR toggles from the input', () => {
		const input = validateInput({
			...REQUIRED,
			notifyUnassignedBotPrs: false,
			summarizeUnassignedBotPrs: true,
		});
		expect(input.notifyUnassignedBotPrs).toBe(false);
		expect(input.summarizeUnassignedBotPrs).toBe(true);
	});

	it('keeps the blocked-PR reminder off unless asked for', () => {
		const input = validateInput({ ...REQUIRED });
		expect(input.reportBlockedPrs).toBe(false);
		expect(input.blockedPrThresholdHours).toBe(72);
	});

	it('takes the blocked-PR settings from the input', () => {
		const input = validateInput({
			...REQUIRED,
			reportBlockedPrs: true,
			blockedPrThresholdHours: 48,
		});
		expect(input.reportBlockedPrs).toBe(true);
		expect(input.blockedPrThresholdHours).toBe(48);
	});

	it('rejects a blocked-PR threshold that is not a non-negative number', () => {
		expect(() => validateInput({ ...REQUIRED, blockedPrThresholdHours: -1 })).toThrow(
			/blockedPrThresholdHours must be a non-negative number/,
		);
	});

	it('carries the text overrides through untouched', () => {
		expect(validateInput({ ...REQUIRED }).texts).toEqual({});
		expect(validateInput({ ...REQUIRED, texts: { footer: '' } }).texts).toEqual({ footer: '' });
	});

	// Catching the typo before the GitHub scan beats catching it after — or never.
	it('rejects a misspelled text key up front', () => {
		expect(() => validateInput({ ...REQUIRED, texts: { footerText: 'oops' } })).toThrow(/unknown text key/);
		expect(() => validateInput({ ...REQUIRED, texts: { header: 7 } })).toThrow(/must be a string/);
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

	// The time zone is no longer run input — it lives in config/config.json, and config.spec.ts
	// covers its validation.
	it('defaults the user mapping to the config folder', () => {
		expect(validateInput({ ...REQUIRED }).userMappingFile).toBe('config/user-mapping.json');
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
