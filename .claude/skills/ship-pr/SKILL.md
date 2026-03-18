---
name: ship-pr
description: Full PR lifecycle for solo workflow — cut feature branch from local main commits, push, create PR, wait for merge confirmation, clean up, sync main, compact context.
argument-hint: "<branch-name or PR title>"
---

# Ship PR Skill

Solo workflow: commits land on local `main` first, then get shipped as a PR via a feature branch.

**Optional branch name / PR title:** $ARGUMENTS

---

## Step 1 — Verify state

```bash
git status
git branch --show-current
git log origin/main..HEAD --oneline
```

Must satisfy ALL of:
- Currently on `main`
- No uncommitted changes (clean working tree)
- At least one commit ahead of `origin/main`

If working tree is dirty: stop, tell the user to commit their changes first.
If not on `main`: stop, ask whether to proceed anyway.
If no commits ahead of `origin/main`: stop, nothing to ship.

Capture the list of commits ahead as COMMITS.

---

## Step 2 — Name the feature branch

If `$ARGUMENTS` is provided, use it as BRANCH (slugify if needed: lowercase, spaces→hyphens).

Otherwise derive BRANCH from the commits:
- Look at the first/most descriptive commit message
- Use conventional prefix if obvious: `feat/`, `fix/`, `docs/`, `refactor/`, `chore/`
- Slugify to max 40 chars
- Show the proposed branch name and ask the user to confirm or rename

---

## Step 3 — Cut the feature branch & reset local main

```bash
# Create feature branch at current HEAD (carries all local commits)
git checkout -b BRANCH

# Reset local main back to remote — so main stays clean
git checkout main
git reset --hard origin/main
```

Confirm: "Feature branch `BRANCH` created. Local `main` reset to `origin/main`."

---

## Step 4 — Push

```bash
git push -u origin BRANCH
```

If push fails, report the error and stop.

---

## Step 5 — Create PR

Gather context:

```bash
git log origin/main..BRANCH --oneline
git diff origin/main...BRANCH --stat
```

Draft:
- **Title:** use `$ARGUMENTS` if it looks like a title (contains spaces); otherwise derive from COMMITS
- **Body:** bullet summary of changes + short Test plan checklist

```bash
gh pr create --title "TITLE" --body "BODY"
```

If `gh pr create` fails with a permissions error, print the GitHub URL shown during `git push` and display the suggested title and body for the user to paste manually.

---

## Step 6 — Wait for merge

Tell the user:

> "PR is open. Let me know when it's merged and I'll clean up."

Wait for the user to confirm (e.g. "merged", "done", "thanks").

---

## Step 7 — Clean up & sync

```bash
git checkout main
git pull
git branch -d BRANCH
```

Report: "Done. `main` is now at $(git log -1 --oneline)."

---

## Step 8 — Compact context

Run `/compact` to compress the conversation history and free up context window.
