# Code Review Reminder (v2)

Apify Actor that scans GitHub Pull Requests awaiting review and posts a compact, tagged reminder to Slack. Focused on one job: nag the right people, and only the right people.

For the full rule set — written for the people being nagged rather than for developers — see [REPORT_RULES.md](REPORT_RULES.md).

## What it does

1. Discovers all repositories in a GitHub organization carrying a given **topic** (e.g. `google-team`), skipping archived repos and forks.
2. For each repo, lists **open Pull Requests** and enriches them with the `ready_for_review` timestamp, the latest review request, the submitted reviews, and any linked issues (`Fixes #N`, `Closes #N`, `Resolves #N`).
3. Skips PRs that are in **draft**, carry a **blocked** label, or link to an issue that carries one. A linked issue is _not_ required unless `requireLinkedIssue` is switched on.
4. Computes two waiting times per PR — **total age** and **current review round** — with weekends excluded, and grades each against its own thresholds. The worse verdict decides the emoji:

    | Emoji                      | Default           |
    | -------------------------- | ----------------- |
    | `:hourglass_flowing_sand:` | below both limits |
    | `:warning:`                | ≥ 72 h (3 days)   |
    | `:scream:`                 | ≥ 168 h (7 days)  |

5. Posts a compact message to Slack, tagging the PR author — or, for bot-authored PRs, whoever the linked ticket is assigned to. PRs that nobody has reviewed yet are listed in a separate block, because they need a first look rather than a follow-up.

## Output format

```
Pull requests in review:

:scream: [booking] <URL|feat(start-urls): support more Booking URL formats> - *13d 22h 19m* (round 13d 22h 19m) - *0*/5 approved (<@U123ABC> via claude[bot])
:warning: [google-maps] <URL|docs: pick up untracked AGENTS.local.md> - *3d 1h 50m* (round 3d 1h 50m) - *1*/4 approved (<@U456DEF>)

New PRs — nobody has looked at these yet:

:hourglass_flowing_sand: [google-trends] <URL|chore: adopt safePushData> - *1d 3h 12m* (round 1d 3h 12m) - *0*/4 approved (<@U789GHI>)
```

A PR moves into the second block when **nobody has submitted a review of any kind** — a comment-only review is enough to keep it out. The split has no threshold of its own; the usual rules decide whether a PR is reported at all. Either block is dropped when empty.

Per line: severity emoji, repository, linked PR title, total waiting time (bold), time in the current review round, approvals out of everyone involved (count bold), and the person to nudge.

## Working time

All waiting times exclude whole Saturdays and Sundays in the configured `timeZone` (`Europe/Prague`). A PR that goes ready on Friday afternoon is therefore still under the 24-hour bar on Monday morning and only surfaces on Tuesday. Set `skipWeekends` to `false` for plain calendar time.

## Modes

- `overdue` (default) — reports PRs that breach **either** limit: total age ≥ `overdueThresholdHours` (default 24) or current round ≥ `iterationOverdueThresholdHours` (default 24).
- `all` — shows every eligible open PR regardless of age.

When there is nothing to report and `sendEmptyReport` is false (default), the actor sends nothing at all.

## Inputs

See [.actor/actor.json](.actor/actor.json) for the full schema. **All thresholds are in hours.** Required:

- `githubToken` — PAT with read access to the org's repos, PRs, and issues.
- `githubOrg` — e.g. `apify-store`.
- `githubTopic` — e.g. `google-team`.
- `slackBotToken` — `xoxb-…` (see [SLACK_SETUP.md](SLACK_SETUP.md)).
- `slackChannelId` — destination channel ID (e.g. `C01234567`).
- `sendEmptyReport` — boolean.

Optional:

- `userMappingFile` — path to the GitHub → Slack table, default [user-mapping.json](user-mapping.json).
- `userMapping` — per-run overrides layered on top of that file.
- `mode`, `overdueThresholdHours`, `warningThresholdHours`, `screamThresholdHours`.
- `iterationOverdueThresholdHours`, `iterationWarningThresholdHours`, `iterationScreamThresholdHours` — the same limits for the current review round.
- `requireLinkedIssue` — when true, skip PRs whose description closes no issue.
- `skipWeekends`, `timeZone`, `headerText`, `newPrHeaderText`, `ignoreLabels`.

## Who gets tagged

Tagging needs an explicit GitHub-login → Slack-user-ID table; there is no reliable way to match the two automatically. It lives in [user-mapping.json](user-mapping.json):

```json
{
	"radimkvet": "U0ABWS1986Q",
	"oklinov": { "slackId": "U05H7KZUJUV", "name": "Ondra" }
}
```

Unmapped people are still reported, but as plain `@login` text that notifies nobody — the actor logs a warning for each one.

## Slack setup

See the detailed, click-through guide in [SLACK_SETUP.md](SLACK_SETUP.md).

## Local run

```bash
npm install
# fill storage/key_value_stores/default/INPUT.json with real values
npm start
```

Note that a successful run **posts to the configured Slack channel** — there is no dry-run mode. Point `slackChannelId` at a private test channel while experimenting.

## Tests

```bash
npm test
```
