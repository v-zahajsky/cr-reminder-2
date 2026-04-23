// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';

import { run } from './runner.js';

// Disable memory snapshots to avoid wmic.exe errors on Windows
process.env.APIFY_DISABLE_OUTDATED_WARNING = '1';
process.env.APIFY_MEMORY_MBYTES = '0';
process.env.APIFY_SYSTEM_INFO_INTERVAL_MILLIS = '0';

await Actor.init();

try {
	log.info('Starting Code Review Reminder Actor run');
	await run();
	log.info('Run finished successfully');
} catch (err) {
	log.exception(err as Error, 'Actor run failed');
	throw err;
}

await Actor.exit();
