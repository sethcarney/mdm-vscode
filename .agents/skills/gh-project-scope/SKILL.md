---
name: gh-project-scope
category: github-pm
description: Break a feature or project into a set of well-defined GitHub issues, create a milestone to group them, and wire up cross-references between related issues. Use when the user wants to plan and scope a project, epic, or multi-issue feature — not just a single issue.
user-invocable: true
allowed-tools: Bash
---

# GitHub Project Scoping

Use this skill to turn a high-level goal ("build a user authentication system") into a concrete, ordered set of GitHub issues with a milestone, proper labels, and cross-references. The output is a fully-created GitHub milestone with all issues filed.

---

## Prerequisites

```bash
gh auth status       # must be authenticated
gh repo view         # must be inside a git repo with a GitHub remote
```

---

## Scoping Workflow Overview

```
1. Understand the goal
2. Identify the milestone (or create one)
3. Decompose into issues
4. Validate the scope with the user
5. Create labels
6. Create the milestone
7. Create issues in dependency order
8. Cross-reference related issues
9. Print the summary
```

---

## Step 1 — Understand the Goal

Ask the user for:

| Question                                                       | Why it matters                                 |
| -------------------------------------------------------------- | ---------------------------------------------- |
| What is the end-user outcome when this project is done?        | Keeps issues outcome-focused, not task-focused |
| What is explicitly out of scope for this project?              | Prevents unbounded scope during decomposition  |
| Is there a target release date or sprint?                      | Informs milestone due date                     |
| Are there known dependencies or constraints?                   | Surfaces blockers early                        |
| Who is the primary audience — users, developers, or operators? | Shapes how acceptance criteria are written     |

---

## Step 2 — Decompose Into Issues

Break the goal into **the smallest independently shippable units of work**. Each issue must:

- Be completable without requiring another issue in this project to merge first (or have an explicit dependency noted)
- Have clear acceptance criteria on its own
- Represent a meaningful increment — not a micro-task like "write a test" unless that's genuinely isolated work

### Decomposition patterns

**Feature slice** (recommended default): cut vertically through the stack for each user-visible capability.

```
❌ "Build the database layer"        ← horizontal, not shippable alone
✓  "User can register with email"    ← vertical, delivers value
```

**Dependency chain**: when sequential work is unavoidable, make dependencies explicit.

```
Issue 1: Set up database schema for users
Issue 2: Implement registration API (depends on #1)
Issue 3: Build registration UI (depends on #2)
```

**Spike**: when the right approach is unknown, create a time-boxed investigation issue.

```
Title: "Spike: evaluate auth library options (2h timebox)"
Acceptance criteria: Decision documented in issue comments with recommendation
```

### Typical issue count

| Project size         | Issues | Milestone duration |
| -------------------- | ------ | ------------------ |
| Small feature        | 2–5    | 1–2 sprints        |
| Medium feature       | 5–10   | 2–4 sprints        |
| Large feature / epic | 10–20  | 1–2 quarters       |

If decomposition yields more than 20 issues, the scope is too large — split into multiple milestones.

---

## Step 3 — Validate With the User

Before creating anything, present the full plan:

```
Milestone: <name> (due: <date or TBD>)

Issues:
  1. [type: feature, size: small]  "Set up database schema for users"
  2. [type: feature, size: medium] "Implement registration API" (depends on #1)
  3. [type: feature, size: medium] "Build registration UI" (depends on #2)
  4. [type: chore, size: small]    "Add integration tests for registration flow"
  5. [type: docs, size: small]     "Document registration API endpoints"

Total estimated size: ~3 days of focused work
```

Ask: "Does this capture everything? Anything missing or out of scope?"

Make adjustments before proceeding. Do not create issues until the user confirms.

---

## Step 4 — Create the Milestone

```bash
# Check if the milestone already exists
gh milestone list

# Create it (due-on is optional, format: YYYY-MM-DDTHH:MM:SSZ)
gh api repos/{owner}/{repo}/milestones \
  --method POST \
  --field title="<milestone name>" \
  --field description="<one-line description of what this milestone delivers>" \
  --field due_on="<YYYY-MM-DDTHH:MM:SSZ>"
```

Note the milestone number from the response — you'll need it when creating issues.

---

## Step 5 — Create Labels

Check which labels exist and create any missing ones:

```bash
gh label list
```

Standard label sets — see `gh-issue` skill for the full table. Create missing labels:

```bash
gh label create "type: feature" --color "0075ca" --description "New capability"
gh label create "size: small"   --color "c2e0c6" --description "Under 4 hours"
gh label create "size: medium"  --color "fef2c0" --description "4–16 hours"
gh label create "size: large"   --color "f9d0c4" --description "Over 16 hours"
```

---

## Step 6 — Create Issues in Dependency Order

Create issues starting with those that have no dependencies. Use the `gh-issue` skill's body template for each:

```bash
gh issue create \
  --title "<title>" \
  --body "$(cat <<'BODY'
## Background

<why this issue exists in the context of the project>

## Acceptance Criteria

- [ ] <criterion>
- [ ] <criterion>

## Out of Scope

- <item>

## Technical Notes

Part of milestone: <milestone name>
BODY
)" \
  --label "type: feature,size: medium" \
  --milestone "<milestone name>"
```

Capture each issue number after creation. `gh issue create` outputs the URL — extract the number from it.

---

## Step 7 — Add Cross-References

After all issues exist, edit any that have dependencies to add references:

```bash
gh issue edit <number> --body "$(gh issue view <number> --json body --jq .body)

---
**Depends on:** #<other-number>"
```

For issues that are blocked by another:

```bash
# Add a note to the blocked issue
gh issue comment <blocked-number> --body "Blocked by #<blocking-number> — will begin after that merges."
```

GitHub automatically creates backlinks when you reference an issue number, so both issues surface the relationship.

---

## Step 8 — Print the Summary

After all issues are created, output a summary the user can paste into a project doc or team channel:

```
## <Milestone Name>

Milestone: <URL>

| # | Title | Labels | Size |
|---|-------|--------|------|
| #1 | Set up database schema | type: feature | small |
| #2 | Implement registration API | type: feature | medium |
| #3 | Build registration UI | type: feature | medium |
| #4 | Integration tests | type: chore | small |
| #5 | Document API endpoints | type: docs | small |

Total issues: 5 | Estimated: ~3 days
```

---

## Keeping Issues Focused

As you draft each issue, apply these checks:

- **The title is a complete thought**: "Add password reset flow" not "Password reset"
- **Acceptance criteria are outcomes, not tasks**: "User receives a reset email within 30 seconds" not "Call SendGrid API"
- **Each issue could be assigned to a different person**: if coupling is so tight that two issues must go to the same person, consider merging them
- **The out-of-scope section names at least one thing**: forces explicit boundary-drawing

---

## Common Pitfalls

- **Creating the milestone last**: create it first so you can attach issues as you go.
- **Circular dependencies**: if A depends on B and B depends on A, merge them into one issue.
- **Forgetting non-feature work**: chores (migrations, config), tests, and docs are real work — include them in the scope.
- **Skipping the validation step**: creating 15 issues and then restructuring them is painful. Always confirm the plan first.
- **No out-of-scope on the milestone**: add a "What this milestone does NOT include" section to the milestone description to prevent scope creep at the project level.
