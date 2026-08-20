# Code Review Reminder — what gets into the report

The reminder bot posts a list of pull requests that are waiting for review into Slack. This page explains **exactly** which PRs are counted, which are skipped, and how the waiting time and emoji are calculated — so you can tell whether your PR is missing because of a bug or because of a rule.

---

## TL;DR

A pull request shows up in the report only when **all** of the following are true:

| #   | Condition                                                                                      |
| --- | ---------------------------------------------------------------------------------------------- |
| 1   | It lives in a repo of the configured GitHub org that carries the configured **topic**          |
| 2   | The repo is **not archived** and **not a fork**                                                |
| 3   | The PR is **open**                                                                             |
| 4   | The PR is **not a draft**                                                                      |
| 5   | Neither the PR nor any linked issue carries an **ignored label** (default: `blocked`)          |
| 6   | In `overdue` mode: it has been waiting **at least `overdueThresholdHours`** (default **24 h**) |

Fail any one of them and the PR is invisible to the report.

> **By default there is no requirement to link an issue.** Every open, non-draft PR in a scanned repo is reported. Linked issues still matter — they can mute a PR and they decide who gets tagged on bot PRs — but a PR without one is reported all the same. Teams that want the stricter behaviour can switch on `requireLinkedIssue` (section 3.3).

---

## Step by step

### 1. Which repositories are scanned

The actor asks GitHub for `topic:<githubTopic> org:<githubOrg>` — every repository in the organization tagged with a given topic. Repositories that are **archived** or that are **forks** are dropped.

> **Most common surprise:** a brand-new repo has no topics. Until someone adds the team topic to it, none of its pull requests can ever appear in the report. Topics are set on the repo GitHub page → _About_ → gear icon → _Topics_.

### 2. Which pull requests are read

All **open** PRs of each matching repo. Closed and merged PRs are never considered — the report is a snapshot of what is waiting _right now_, not a history.

### 3. Exclusion rules

#### 3.1 Drafts are skipped

A PR marked as _Draft_ is excluded. Converting it to _Ready for review_ makes it eligible — and also restarts its waiting clock (see below).

#### 3.2 Ignored labels

If the PR carries any label from the ignore list — **or if any of its linked issues carries one** — the PR is skipped. The default ignore list is a single label: `blocked`.

Label matching is **case-sensitive**, exactly as GitHub stores it. `blocked` is ignored; `Blocked` is not.

This is the intended escape hatch: label a PR (or its issue) `blocked` and the bot stops nagging about it.

#### 3.3 Linked issues — optional, but they do work

A linked issue is **not required by default**. When one is present it does two things:

1. Its labels can mute the PR (rule 3.2 above).
2. Its **assignee** decides who gets tagged when a bot opened the PR (see section 7).

**Switching `requireLinkedIssue` on** restores the old, stricter rule: a PR whose description does not close an issue is skipped entirely, however old it is. Use it when the team wants every PR traceable to a ticket; leave it off when the point is to see every review in flight.

Links are detected by scanning the **PR description text** for a GitHub closing keyword followed by an issue number:

```
close #123      closes #123      closed #123
fix #123        fixes #123       fixed #123
resolve #123    resolves #123    resolved #123
```

Matching is case-insensitive, so `Fixes #123` and `FIXES #123` both work.

What is **not** detected:

| Written as                                                      | Detected? | Why                                                      |
| --------------------------------------------------------------- | --------- | -------------------------------------------------------- |
| `Fixes #123`                                                    | ✅        | Keyword + `#number`                                      |
| `Closes #123, closes #456`                                      | ✅        | Multiple links are fine                                  |
| `#123` on its own                                               | ❌        | No closing keyword                                       |
| `Related to #123`                                               | ❌        | `Related to` is not a closing keyword                    |
| `Fixes apify/other-repo#123`                                    | ❌        | Only the plain `#number` form is parsed                  |
| `Fixes https://github.com/…/issues/123`                         | ❌        | Full URLs are not parsed                                 |
| Linked via the GitHub sidebar (_Development_ → _Link an issue_) | ❌        | Only the description text is read, not the link metadata |

With `requireLinkedIssue` off, an undetected link is not fatal — the PR is still reported. It only means the issue labels cannot mute it, and a bot PR cannot be routed to its assignee. With the setting on, an undetected link makes the PR invisible.

### 4. How the waiting time is calculated

The clock starts at the moment the PR became reviewable:

- If the PR was ever converted from draft to ready for review, the timer starts at the **most recent** _ready for review_ event.
- Otherwise (a PR opened directly as non-draft) it starts at the PR **creation time**.

So flipping a PR back to draft and then to ready again resets the counter to zero. This is deliberate — a PR pushed back to draft was not waiting on a reviewer during that time.

The displayed duration is formatted as `2d 4h 15m`; days and hours are omitted when zero, minutes are always shown.

#### Weekends do not count

Nobody reviews at the weekend, so counting Saturday and Sunday would make every Monday look like a crisis. **All waiting times exclude whole Saturdays and Sundays**, as they fall in the configured time zone (`Europe/Prague` by default).

Worked example, a PR that goes ready **Friday at 15:00**:

| Report runs   | Counted waiting time                | In the report?  |
| ------------- | ----------------------------------- | --------------- |
| Monday 09:00  | 18 h (9 h Friday + 9 h Monday)      | No — under 24 h |
| Tuesday 09:00 | 42 h (9 h Fri + 24 h Mon + 9 h Tue) | Yes             |

Monday therefore acts as the grace period for anything raised late on Friday: it will not be chased until Tuesday. (A PR that went ready early on Friday morning has already used up a full working day, so it can be flagged on Monday — the weekend is skipped, not the Friday.)

The numbers shown in the message are this weekend-adjusted time, so the durations always match the emoji. The raw calendar time is kept in the dataset as `durationWallMs` / `iterationWallMs` if you need it. Set `skipWeekends` to `false` to go back to plain calendar time.

#### Two clocks: total age and current round

Every PR carries **two** waiting times, and both are shown in the message:

| Clock             | Starts at                                 | Answers                                                    |
| ----------------- | ----------------------------------------- | ---------------------------------------------------------- |
| **Total**         | when the PR became reviewable (see above) | How long has this PR been dragging on?                     |
| **Current round** | the **latest review request** on the PR   | How long have reviewers been sitting on the current state? |

A new round starts when a review is **re-requested** — the little re-request arrow next to a reviewer name, or adding a reviewer. That is the explicit "the ball is back with you" signal.

**Pushing commits does not start a new round.** If you address the feedback and push, the round clock keeps running until you actually re-request the review. This is intentional: it keeps the clock honest for reviewers, and an author who silently pushes fixes without telling anyone is not rewarded with a reset.

The current round can never be longer than the total age. On a PR where a review was never re-requested, both numbers are identical — which, in practice, is most PRs until re-requesting becomes a habit.

### 5. Modes: `overdue` vs `all`

| Mode                | What it reports                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overdue` (default) | PRs that breach **either** limit: total age ≥ `overdueThresholdHours` (default **24 h**) **or** current round ≥ `iterationOverdueThresholdHours` (default **24 h**) |
| `all`               | Every PR that passed the filters, regardless of age                                                                                                                 |

**The 24-hour baseline.** The default inclusion limit encodes the team rule: _somebody should look at every PR within a working day of it becoming ready_. A PR nobody has picked up in 24 counted hours shows up in the report. All thresholds are configured in **hours**, so sub-day rules are expressible — raise `overdueThresholdHours` to nag less, lower it to nag sooner.

Because the two limits are combined with OR, a young PR whose current round has stalled can be reported even when its total age is still under the limit — set `iterationOverdueThresholdHours` lower than `overdueThresholdHours` to get that.

The list is always sorted **longest total waiting time first**.

### 6. The emoji next to each PR

Both clocks are graded separately, and **the worse of the two verdicts wins**.

| Emoji                         | Meaning                         | Rule (with defaults)                                                                                    |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ⏳ `:hourglass_flowing_sand:` | Waiting, still within tolerance | below both warning thresholds                                                                           |
| ⚠️ `:warning:`                | Getting old                     | total ≥ `warningThresholdHours` (72 h = 3 working days) **or** round ≥ `iterationWarningThresholdHours` |
| 😱 `:scream:`                 | Seriously overdue               | total ≥ `screamThresholdHours` (168 h = 7 working days) **or** round ≥ `iterationScreamThresholdHours`  |

So a PR open for three working weeks keeps its 😱 even if the current round only started yesterday — the total age alone is enough to earn it. Conversely, a two-day-old PR can already be ⚠️ when the iteration limits are set tighter than the total ones.

> With the defaults, a PR enters the report after 24 h but only turns ⚠️ at 72 h. The ⏳ hourglass therefore marks the PRs in their first three working days — late by the 24-hour rule, but not yet properly stale.

> **Out of the box the iteration thresholds equal the total ones.** Because a round is never longer than the total age, they never change the emoji until you lower them. Set `iterationWarningThresholdHours` / `iterationScreamThresholdHours` below the total ones to make the round clock actually bite.

### 7. Who gets tagged

The **author** of the PR is tagged, not the reviewer.

Tagging works through an explicit GitHub-login → Slack-user-ID mapping. There is no automatic matching — GitHub and Slack accounts have no reliable common identifier.

The table lives in its own file, **`user-mapping.json`** in the actor root, so it can grow with the team without bloating the run input:

```json
{
	"radimkvet": "U0ABWS1986Q",
	"oklinov": { "slackId": "U05H7KZUJUV", "name": "Ondra" }
}
```

Both forms work; the annotated one just keeps a long table readable. Keys starting with an underscore are ignored, so the file can document itself with a `"_comment"`. Slack member IDs come from the person's profile → **More** → **Copy member ID**.

The `userMapping` input field still exists as an **override**: anything listed there wins over the file. That is the escape hatch for adding one person without a redeploy. `userMappingFile` changes which file is read.

If the person is missing from that mapping, the PR is **still reported**, but they appear as plain text `@their-github-login`. It looks like a mention but notifies nobody. The actor logs a warning for each missing mapping, so adding new team members is a quick fix.

#### PRs opened by a bot

A bot cannot act on review feedback, so tagging it notifies nobody useful. When the PR author is a GitHub app — any login ending in `[bot]`, such as `claude[bot]` or `dependabot[bot]` — the report tags **whoever the linked ticket is assigned to** instead.

The assignee comes from an issue linked in the PR description (section 3.3). If several issues are linked, the first assignee found wins.

Because being pinged for a PR you did not write is baffling on its own, the line names the bot as well:

```
- 0/5 approved (@oklinov via claude[bot])
```

If a bot-authored PR links no issue, or no linked issue has an assignee, there is nobody to redirect to: the report tags the bot login itself (without the `via` suffix, which would just repeat it) and the actor logs a warning naming the PR. **Linking and assigning the ticket is what makes a bot PR reach a human.**

The dataset keeps both `authorLogin` (who opened it) and `notifyLogin` (who got tagged), so the substitution is auditable.

### 8. How many people have approved

Each line ends with an `X/Y approved` counter, with **X in bold** so the number that matters is readable at a glance.

- **X** — how many reviewers have approved. Each reviewer counts once, by their **latest decisive review**. A later comment does **not** clear an earlier approval (same as GitHub). A dismissed approval does not count.
- **Y** — everyone involved in the review: everyone who has submitted a review of any kind, **plus** everyone still waited on.

The denominator has to be built this way because `requested_reviewers` in the GitHub API lists only reviewers who have **not reviewed yet** — GitHub drops a reviewer from that list the moment they submit. Taken alone it would report an approved PR as `2/0`.

Details worth knowing:

- **`no reviewers`** instead of a counter means nobody has reviewed and nobody is requested. Not a bug — the PR is genuinely waiting on no one, which usually means someone forgot to assign a reviewer.
- A **review requested from a team** counts as one outstanding reviewer, because the API does not say how many people that expands to.
- **Comment-only reviewers count in Y but not in X.** They are involved, they just have not taken a position.
- The **author is never counted**, even when they comment on their own PR.
- The counter is purely informational — approvals do **not** remove a PR from the report. A fully approved PR keeps showing up until it is merged or closed.

### 9. New PRs get their own section

The message is split in two. PRs that **nobody has reviewed yet** — no approval, no changes requested, not even a comment review — are listed separately under their own heading:

```
Pull requests in review:

⚠️ [google-maps] Fix pagination off-by-one - 4d 0h 45m (round 4d 0h 45m) - 1/3 approved (@bob)

New PRs — nobody has looked at these yet:

⏳ [booking] Add retry logic to the scraper - 1d 2h 10m (round 1d 2h 10m) - 0/4 approved (@alice)
```

The two ask for different things. A PR in the first block is mid-conversation and needs someone to finish what they started; a PR in the second is simply untouched and needs anyone to take a first look.

**The split has no threshold of its own.** Whether a PR appears at all is still decided by the rules above — in `overdue` mode, that means 24 counted hours without progress. The new-PR section then answers "and of those, which has literally nobody opened?". A PR raised an hour ago is not in the report at all, so it cannot show up here either.

Details:

- "Looked at" means a **submitted review of any kind**. A comment-only review counts — someone engaged. Merely being _requested_ as a reviewer does not.
- Reviews by the PR author never count, so self-commenting does not move a PR out of the new section.
- Either block is omitted entirely when it has no PRs. If every reported PR is new, the message contains only the new-PR heading.
- Both blocks keep the same longest-waiting-first order, and the line format is identical.
- The heading text is configurable via `newPrHeaderText`.

### 10. When nothing is waiting

If no PR passes the filters, the behaviour depends on the `sendEmptyReport` setting:

- `false` (default) — the bot stays silent, no Slack message at all.
- `true` — the bot posts `No open PRs awaiting review. 🎉`

---

## Anatomy of a message

```
Pull requests in review:

😱 [google-search] Add retry logic to the scraper - 9d 3h 12m (round 2d 1h 5m) - 1/2 approved (@alice)
⚠️ [booking] Fix pagination off-by-one - 4d 0h 45m (round 4d 0h 45m) - 0/1 approved (@bob)
```

Each line is: `emoji` · `[repository]` · `PR title` (a link to the PR) · `total waiting time` (bold) · `round: time in the current review round` · `approvals` (count in bold) · `person to nudge` (plus `via <bot>` when a bot opened it).

The repository name is prefixed because one report covers every repo carrying the team topic, and PR titles alone (`chore: bump @apify/actor-utils to v0.1.8`, appearing in four repos at once) do not say where the work lives.

Both durations are working time — weekends are already deducted.

In the example, the first PR has been open for over nine working days but its current round started two days ago (the author re-requested review then), and one of the two people involved has approved. The second PR was never re-requested, so both times are the same.

If the message would exceed the Slack limit of 40 000 characters, the oldest PRs are kept and the rest is summarised as `...and N more`.

---

## What the report deliberately does _not_ check

These often come up as "should it not also…?" — currently, no:

- **Review state as a filter.** Approvals are counted and displayed, but they never remove a PR from the report — a fully approved PR keeps appearing until it is merged or closed. The same goes for a PR with changes requested.
- **Whether a reviewer is even assigned.** A PR with no requested reviewer is still reported; it just shows `no reviewers`.
- **Commits and comments as activity.** Pushing to the branch, commenting and resolving threads move neither clock. Only becoming reviewable and re-requesting a review do.
- **Public holidays.** Only Saturdays and Sundays are skipped; a bank holiday counts as a working day.
- **CI status, mergeability, conflicts.**
- **Repos without the team topic**, archived repos and forks — invisible by design.

---

## Configuration reference

These knobs live in the actor input on Apify; the values below are the defaults. **All thresholds are in hours**, and they measure working time when `skipWeekends` is on.

| Parameter                        | Default                                     | Meaning                                                                                   |
| -------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `githubOrg`                      | —                                           | Organization whose repos are scanned                                                      |
| `githubTopic`                    | —                                           | Only repos carrying this topic are scanned                                                |
| `mode`                           | `overdue`                                   | `overdue` = only late PRs, `all` = everything eligible                                    |
| `overdueThresholdHours`          | `24`                                        | In `overdue` mode, hide PRs younger than this — the "someone must look within a day" rule |
| `warningThresholdHours`          | `72`                                        | From this total age the PR gets ⚠️                                                        |
| `screamThresholdHours`           | `168`                                       | From this total age the PR gets 😱                                                        |
| `iterationOverdueThresholdHours` | `24`                                        | In `overdue` mode, report a PR whose current round reaches this age                       |
| `iterationWarningThresholdHours` | `72`                                        | From this round age the PR gets ⚠️                                                        |
| `iterationScreamThresholdHours`  | `168`                                       | From this round age the PR gets 😱                                                        |
| `requireLinkedIssue`             | `false`                                     | When on, skip PRs whose description does not close an issue                               |
| `skipWeekends`                   | `true`                                      | Exclude Saturdays and Sundays from every waiting time                                     |
| `timeZone`                       | `Europe/Prague`                             | IANA zone deciding where the weekend boundaries fall                                      |
| `ignoreLabels`                   | `["blocked"]`                               | Labels (on the PR or its linked issue) that mute a PR                                     |
| `sendEmptyReport`                | `false`                                     | Whether to post when nothing is waiting                                                   |
| `headerText`                     | `Pull requests in review:`                  | Heading of the main block                                                                 |
| `newPrHeaderText`                | `New PRs — nobody has looked at these yet:` | Heading of the block for PRs nobody has reviewed                                          |
| `userMappingFile`                | `user-mapping.json`                         | File holding the GitHub login → Slack user ID table                                       |
| `userMapping`                    | `{}`                                        | Per-run overrides layered on top of that file                                             |

Constraints: `warningThresholdHours` ≤ `screamThresholdHours`, and `iterationWarningThresholdHours` ≤ `iterationScreamThresholdHours`. Violating either fails the run immediately, as does an unknown `timeZone`.

---

## "My PR is not in the report" — checklist

Go through these in order; the first one that fails is your answer.

1. Does the repo carry the team **topic**? Is it archived or a fork?
2. Is the PR **open** and **not a draft**?
3. Does the PR or its linked issue carry the `blocked` label?
4. Is `requireLinkedIssue` on? If so, does the description really close an issue (`Fixes #123`)?
5. Has it been waiting long enough for the current mode — either clock, 24 working hours by default? Remember the weekend does not count.
6. Was it recently flipped from draft to ready? That reset both clocks.

Still unexplained? Every run also stores the full list of reported PRs — including both waiting times, the raw calendar time, severity, approvals and linked issue numbers — in the actor dataset on Apify, which is the ground truth for what the bot saw.
