import { log } from 'apify';
import { WebClient } from '@slack/web-api';

export class SlackClient {
	private readonly client: WebClient;

	constructor(botToken: string) {
		this.client = new WebClient(botToken);
	}

	async postMessage(channelId: string, text: string): Promise<void> {
		const res = await this.client.chat.postMessage({
			channel: channelId,
			text,
			unfurl_links: false,
			unfurl_media: false,
			mrkdwn: true,
		});
		if (!res.ok) {
			throw new Error(`chat.postMessage returned not ok: ${JSON.stringify(res)}`);
		}
		log.info(`Sent Slack message to channel ${channelId} (ts=${res.ts})`);
	}
}
