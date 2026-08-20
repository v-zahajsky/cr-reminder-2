# Slack Setup Guide

This actor posts via **Slack Bot token** (not a webhook), because webhooks cannot tag specific users. Below is the full click-through setup.

## 1. Create the Slack App

1. Go to <https://api.slack.com/apps>.
2. Click **Create New App** → **From scratch**.
3. Give it a name (e.g. `Team Pulse`) and pick the target workspace.
4. Click **Create App**.

## 2. Add Bot Token Scopes

1. In the left sidebar, click **OAuth & Permissions**.
2. Scroll to **Scopes → Bot Token Scopes**.
3. Click **Add an OAuth Scope** and add:
    - `chat:write` — required, lets the bot post to channels it has been invited to.
    - `chat:write.public` — optional, lets the bot post to any public channel without an explicit `/invite`. Recommended for convenience.

## 3. Install the app & copy the Bot Token

1. Scroll back to the top of **OAuth & Permissions**.
2. Click **Install to Workspace** → authorize.
3. After install, copy the **Bot User OAuth Token** (starts with `xoxb-…`).
4. Paste it into the actor input field `slackBotToken` (mark as secret on Apify).

> Keep this token private. Anyone with it can post as the bot.

## 4. Get the Slack Channel ID

1. In Slack, open the channel where reminders should land.
2. Click the channel name in the header to open channel details.
3. Scroll to the bottom of the modal — you'll see **Channel ID** (e.g. `C01234567`).
4. Click **Copy** → paste into the actor input `slackChannelId`.

## 5. Invite the bot to the channel (if needed)

If you added only `chat:write` (not `chat:write.public`), the bot must be a member of the channel:

```
/invite @Team Pulse
```

(Replace with your app's bot name.)

## 6. Map GitHub users → Slack user IDs

The actor tags people using their Slack user ID. For each developer you want tagged:

1. In Slack, click the person's avatar to open their profile.
2. Click the three-dot **More** menu.
3. Click **Copy member ID** — you'll get something like `U01234ABC`.
4. Add the mapping to **`user-mapping.json`** in the actor root:

    ```json
    {
    	"radimkvet": "U123ABC456",
    	"oklinov": { "slackId": "U789DEF012", "name": "Ondra" }
    }
    ```

    Either form works — the annotated one just keeps a long table readable. The key is the **GitHub login** (visible on the PR author's profile URL, e.g. `github.com/radimkvet`). Keys starting with an underscore are ignored, so the file can carry a `"_comment"`.

The table lives in a file rather than in the run input so it can grow with the team; it is deployed with the actor. The `userMapping` input field still works as an **override** on top of the file, which is the quick way to add one person without redeploying.

### What happens if a mapping is missing?

The actor still includes the PR in the message but prints the person as plaintext `@login` (no real tag, no notification) and logs a warning naming them. Add them to `user-mapping.json` before the next run.

### Who is tagged on a bot's PR?

A bot cannot act on review feedback, so for PRs opened by a GitHub app (`claude[bot]`, `dependabot[bot]`, …) the actor tags **whoever the linked ticket is assigned to**, and names the bot in the line: `(<@U123ABC> via claude[bot])`. If no linked ticket has an assignee, there is nobody to redirect to and the bot itself is tagged.

## 7. Verify end-to-end

1. In the actor input, set `mode: "all"` and `sendEmptyReport: true` — without them a quiet day looks identical to a broken run.
2. Point `githubOrg` / `githubTopic` at one small test repo.
3. Run the actor. You should see:
    - Log line `Sent Slack message to channel C…` with a timestamp.
    - A message in the target channel matching the expected format.
    - Tagged users receive a Slack notification.

If the message does not arrive:

- Check the bot is in the channel (or that `chat:write.public` is enabled).
- Check the token starts with `xoxb-` (not `xoxp-` — that's a user token).
- Check the actor log for `chat.postMessage` errors.

## Rotating the bot token

If the token leaks:

1. Slack → App page → **OAuth & Permissions** → scroll to **Revoke Tokens**, revoke the Bot Token.
2. Reinstall the app (button on the same page) → copy the new token → update `slackBotToken` on Apify.
