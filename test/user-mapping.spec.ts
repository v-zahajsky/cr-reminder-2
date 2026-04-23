import { describe, expect, it } from 'vitest';

import { resolveSlackId } from '../src/utils/user-mapping.js';

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
