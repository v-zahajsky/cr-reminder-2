// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';

import { run } from './runner.js';

await Actor.init();

try {
	log.info('Starting Code Review Reminder Actor run');
	await run();
	log.info('Run finished successfully');
} catch (err) {
	const error = err as Error;
	log.error(`Actor run failed: ${error.message}`);
	log.debug(error.stack ?? '');
	await Actor.fail(error.message);
}

await Actor.exit();
