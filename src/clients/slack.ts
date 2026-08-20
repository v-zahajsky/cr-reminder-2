import { WebClient } from '@slack/web-api';
import { log } from 'apify';

const ERROR_HINTS: Record<string, string> = {
	invalid_auth:
		'Slack rejected the token. slackBotToken must be the Bot User OAuth Token (xoxb-…) of an installed app.',
	not_authed: 'No Slack token was sent — slackBotToken is empty.',
	account_inactive: 'The token belongs to a deactivated app or workspace — reinstall the app.',
	missing_scope: 'The bot token lacks the chat:write scope. Add it under OAuth & Permissions and reinstall.',
	not_in_channel:
		'The bot is not a member of the channel. Run "/invite @<bot name>" there, or add the chat:write.public scope (public channels only).',
	channel_not_found:
		'slackChannelId matches no channel the bot can see. Copy the ID (C…) from the channel details; private channels also need an /invite.',
	is_archived: 'The target channel is archived.',
};

function describe(err: unknown): string {
	const code = (err as { data?: { error?: string } }).data?.error;
	if (!code) return (err as Error).message;
	const hint = ERROR_HINTS[code];
	return hint ? `${code} — ${hint}` : code;
}

export class SlackClient {
	private readonly client: WebClient;

	constructor(botToken: string) {
		this.client = new WebClient(botToken);
	}

	/** Cheap pre-flight so a bad token fails immediately instead of after the whole GitHub scan. */
	async assertAuth(): Promise<void> {
		try {
			const res = await this.client.auth.test();
			log.info(`Slack auth OK — bot "${res.user}" in workspace "${res.team}"`);
		} catch (err) {
			throw new Error(`Slack auth check failed: ${describe(err)}`);
		}
	}

	async postMessage(channelId: string, text: string): Promise<void> {
		let res;
		try {
			res = await this.client.chat.postMessage({
				channel: channelId,
				text,
				unfurl_links: false,
				unfurl_media: false,
				mrkdwn: true,
			});
		} catch (err) {
			throw new Error(`chat.postMessage to ${channelId} failed: ${describe(err)}`);
		}
		if (!res.ok) {
			throw new Error(`chat.postMessage returned not ok: ${JSON.stringify(res)}`);
		}
		log.info(`Sent Slack message to channel ${channelId} (ts=${res.ts})`);
	}
}
