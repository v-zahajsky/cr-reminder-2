# Code Review Reminder (v2)

Apify Actor that scans GitHub Pull Requests awaiting review and posts a compact, tagged reminder to Slack. Focused on one job: nag the right people, and only the right people.

## What it does

1. Discovers all repositories in a GitHub organization carrying a given **topic** (e.g., `apify-actor`).
2. For each repo, lists **open Pull Requests** and enriches them with the `ready_for_review` timestamp and any linked issues (`Fixes #N`, `Closes #N`, `Resolves #N`).
3. Skips PRs that are in **draft**, have **no linked issue** (`Fixes/Closes/Resolves #N`), carry a **blocked** label, or link to an issue that carries a **blocked** label.
4. Computes how long each remaining PR has been awaiting review and assigns a severity:

   | Emoji | Default |
   |---|---|
   | `:warning:` | ≥ 3 days |
   | `:scream:` | ≥ 7 days |

5. Posts a compact message to Slack with a line per PR, tagging the PR author.

## Output format

```
Pull requests in review:

:scream: <URL|Business Lead Enrichment - Email Verification> - 13d 1h 30m (<@U123ABC>)
:warning: <URL|Add dataset schema and output schema> - 4d 1h 46m (<@U456DEF>)
```

## Modes

- `overdue` (default) — shows only PRs older than `overdueThresholdDays` (default 3).
- `all` — shows every eligible open PR regardless of age.

When there is nothing to report and `sendEmptyReport` is false (default), the actor sends nothing at all.

## Inputs

See [.actor/actor.json](.actor/actor.json) for the full schema. Required:

- `githubToken` — PAT with read access to the org's repos, PRs, and issues.
- `githubOrg` — e.g. `apify-store`.
- `githubTopic` — e.g. `apify-actor`.
- `slackBotToken` — `xoxb-…` (see [SLACK_SETUP.md](SLACK_SETUP.md)).
- `slackChannelId` — destination channel ID (e.g. `C01234567`).
- `sendEmptyReport` — boolean.

Optional:

- `userMapping` — `{ "githubLogin": "U01234ABC" }` so authors get real `<@U…>` tags.
- `mode`, `overdueThresholdDays`, `warningThresholdDays`, `screamThresholdDays`, `headerText`, `ignoreLabels`.

## Slack setup

See the detailed, click-through guide in [SLACK_SETUP.md](SLACK_SETUP.md).

## Local run

```bash
npm install
# fill storage/key_value_stores/default/INPUT.json with real values
npm start
```

## Tests

```bash
npm test
```
