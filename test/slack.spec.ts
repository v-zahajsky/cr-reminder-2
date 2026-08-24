import { describe, expect, it } from 'vitest';

import { describeSlackError } from '../src/clients/slack.js';

describe('describeSlackError', () => {
	it('turns a known Slack error code into an actionable hint', () => {
		const message = describeSlackError({ data: { error: 'not_in_channel' } });
		expect(message).toContain('not_in_channel');
		expect(message).toContain('/invite');
	});

	it('returns the bare code when no hint is written for it', () => {
		expect(describeSlackError({ data: { error: 'ratelimited' } })).toBe('ratelimited');
	});

	it('falls back to the error message when Slack sent no code', () => {
		expect(describeSlackError(new Error('socket hang up'))).toBe('socket hang up');
	});

	it('survives a rejection that is not an Error', () => {
		expect(describeSlackError('boom')).toBe('boom');
		expect(describeSlackError(undefined)).toBe('undefined');
	});
});
