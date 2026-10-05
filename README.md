# Code Review Reminder (v2)

Apify Actor that scans GitHub Pull Requests awaiting review and posts a compact, tagged reminder to Slack. Focused on one job: nag the right people, and only the right people.

For the full rule set — written for the people being nagged rather than for developers — see [REPORT_RULES.md](REPORT_RULES.md).

## What it does

1. Discovers all repositories in a GitHub organization carrying a given **topic** (e.g. `google-team`), skipping archived repos and forks.
2. For each repo, lists **open Pull Requests** and enriches them with the `ready_for_review` timestamp, the latest review request, the submitted reviews, and any linked issues (`Fixes #N`, `Closes #N`, `Resolves #N`).
3. Skips PRs that are in **draft**, carry a **blocked** label, or link to an issue that carries one. A linked issue is _not_ required unless `requireLinkedIssue` is switched on.
4. Computes two waiting times per PR — **total age** and **current review round** — with weekends excluded, and grades each against its own thresholds. The worse verdict decides the emoji:

    | Emoji                      | Default                  |
    | -------------------------- | ------------------------ |
    | `:hourglass_flowing_sand:` | below both limits        |
    | `:warning:`                | ≥ 72 h (3 working days)  |
    | `:scream:`                 | ≥ 168 h (7 working days) |

5. Posts a compact message to Slack, tagging the PR author — or, for bot-authored PRs, whoever the linked ticket is assigned to. PRs that nobody has reviewed yet are listed in a separate block, because they need a first look rather than a follow-up.

## Output format

```
Pull requests in review:

:scream: [booking] <URL|feat(start-urls): support more Booking URL formats> - *13d 22h 19m* (round 13d 22h 19m) - *0*/5 approved (<@U123ABC> via claude[bot])
:warning: [google-maps] <URL|docs: pick up untracked AGENTS.local.md> - *3d 1h 50m* (round 3d 1h 50m, reopened 2×) - *1*/4 approved (<@U456DEF>)

New PRs — nobody has looked at these yet:

:hourglass_flowing_sand: [google-trends] <URL|chore: adopt safePushData> - *1d 3h 12m* (round 1d 3h 12m) - *0*/4 approved (<@U789GHI>)

_The tagged person is the PR author — chase your reviewers, or pull in someone new._
_Really blocked? Put the `blocked` label on the PR and comment why — the bot then leaves it alone._
```

A PR moves into the second block when **nobody has submitted a review of any kind** — a comment-only review is enough to keep it out. The split has no threshold of its own; the usual rules decide whether a PR is reported at all. Either block is dropped when empty.

Per line: severity emoji, repository, linked PR title, total waiting time (bold), time in the current review round, how many times the PR has been reopened (only when it has), approvals out of everyone involved (count bold), and the person to nudge.

The footer states the two things no line can convey on its own — that the tag is the **author**, not a reviewer, and that a genuinely blocked PR can be muted. It is reserved before the message is shortened, so it survives truncation; setting the `footer` text to `""` drops it.

## Reopened PRs

Closing a PR takes it out of the report — only open PRs are read at all — and reopening it puts it back. **Both clocks then start again at the reopen**, because the stretch the PR spent closed was nobody's review time; a PR reopened this morning is a fresh review request, not a week-old one.

That would quietly hide the history, so the line says so: `(round 1d 2h 30m, reopened 2×)`. The count stays on the line for as long as the PR is open. A PR that was never closed shows nothing extra.

The dataset carries `reopenedCount` and `reopenedAt` for the same reason.

## Working time

All waiting times exclude whole Saturdays and Sundays in the time zone set in [config/config.json](config/config.json) (`Europe/Prague`). A PR that goes ready on Friday afternoon is therefore still under the 24-hour bar on Monday morning and only surfaces on Tuesday. Set `skipWeekends` to `false` for plain calendar time.

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

- `userMappingFile` — path to the GitHub → Slack table, default [config/user-mapping.json](config/user-mapping.json).
- `userMapping` — per-run overrides layered on top of that file.
- `mode`, `overdueThresholdHours`, `warningThresholdHours`, `screamThresholdHours`.
- `iterationOverdueThresholdHours`, `iterationWarningThresholdHours`, `iterationScreamThresholdHours` — the same limits for the current review round.
- `requireLinkedIssue` — when true, skip PRs whose description closes no issue.
- `notifyUnassignedBotPrs` — when false, bot PRs with no assignee are kept out of the list (see below).
- `summarizeUnassignedBotPrs` — the per-repo summary of those PRs.
- `reportBlockedPrs`, `blockedPrThresholdHours` — the reminder about muted PRs (see below).
- `texts` — overrides of the message headings and footer, layered over [config/texts.json](config/texts.json) (see below).
- `skipWeekends`, `ignoreLabels`.

## Bot PRs with nobody assigned

A bot-authored PR is tagged to the assignee of its linked ticket. When there is no assignee there is nobody to tag, so the line nags the whole channel and nobody in particular. Two independent toggles decide what happens to those PRs:

- `notifyUnassignedBotPrs` (default `true`) — set to `false` to keep them out of both listed sections. They are still scanned and still pushed to the dataset.
- `summarizeUnassignedBotPrs` (default `false`) — prints a per-repo count just above the footer, naming the PR that has waited longest:

```
Bot PRs with nobody assigned:

• [booking] 3 PRs — oldest <URL|#412 chore: bump dependencies> (*13d 22h 19m*)
• [google-maps] 1 PR — oldest <URL|#1601 fix: retry on 429> (*2d 0h 15m*)
```

The summary counts every unassigned bot PR, whether or not it is also listed individually. Like the footer, it is reserved before the message is shortened, so truncation never eats it.

## Blocked PRs

An `ignoreLabels` label (default `blocked`) takes a PR off the list for good — which is the point, and also the risk: nobody sees it again. `reportBlockedPrs` (default `false`) adds a per-repo count of those PRs above the bot summary:

```
Blocked PRs — make sure they are not forgotten:

• [booking] 3 PRs — oldest <URL|#412 chore: bump dependencies> (*13d 22h 19m*)
• [google-maps] 1 PR — oldest <URL|#1601 fix: retry on 429> (*4d 5h 2m*)
```

Nobody is tagged — a blocked PR waits on whatever blocks it, not on a reviewer. Only PRs open at least `blockedPrThresholdHours` (default `72`) are counted, measured from when the PR became reviewable, since the moment a label landed on a linked issue is not visible on the PR. They are pushed to the dataset with `blockedLabels` naming the labels that muted them. See [REPORT_RULES.md](REPORT_RULES.md) section 3.2.1.

## The config folder

Three things the actor reads from disk rather than from the run input, all in [config/](config/):

| File                                                 | Holds                                             |
| ---------------------------------------------------- | ------------------------------------------------- |
| [config/config.json](config/config.json)             | `timeZone` — where the weekend boundaries fall    |
| [config/texts.json](config/texts.json)               | every heading and the footer of the Slack message |
| [config/user-mapping.json](config/user-mapping.json) | the GitHub login → Slack user ID table            |

The **time zone is deliberately not a run setting**: it says where the team is, not what a given run should report, and the answer changes roughly never. Offering it as a per-run field only invites it to be changed by accident. Default `Europe/Prague`, used only while `skipWeekends` is on; an unrecognised zone or an unknown key in the file fails the run.

## Message texts

Every heading and the footer live in one file, [config/texts.json](config/texts.json), rather than in five input fields — changing the tone of the report is one edit, not a hunt:

```json
{
	"header": "Pull requests in review:",
	"newPrHeader": "New PRs — nobody has looked at these yet:",
	"botPrSummaryHeader": "Bot PRs with nobody assigned:",
	"blockedPrHeader": "Blocked PRs — make sure they are not forgotten:",
	"footer": "_The tagged person is the PR author …_"
}
```

The `texts` input field overrides single keys of that file, exactly as `userMapping` overrides `config/user-mapping.json`: `{ "footer": "" }` prints no legend, and nothing else changes. An empty string is a value, not an omission. An **unknown key fails the run** and the error lists the keys that exist, so a misspelled `blockedPRHeader` cannot quietly print the default forever. Delete the file and the built-in defaults are used.

## Who gets tagged

Tagging needs an explicit GitHub-login → Slack-user-ID table; there is no reliable way to match the two automatically. It lives in [config/user-mapping.json](config/user-mapping.json):

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
