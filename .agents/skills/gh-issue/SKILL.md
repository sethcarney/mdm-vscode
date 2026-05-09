---
name: gh-issue
category: github-pm
description: Create a well-structured GitHub issue with clear acceptance criteria using the GitHub CLI. Triggered when the user wants to file a GitHub issue, report a bug, or define a feature. Guides information gathering, formats the issue body, and runs `gh issue create`.
user-invocable: true
allowed-tools: Bash
---

# GitHub Issue Creation

Use this skill to create a well-defined GitHub issue with a consistent structure: clear title, problem context, explicit acceptance criteria, and out-of-scope boundaries. The issue body is crafted before calling `gh`, so the user can review it first.

---

## Prerequisites

```bash
gh auth status          # must be authenticated
gh repo view            # must be inside a git repo with a GitHub remote
```

If either fails, stop and tell the user what to fix before continuing.

---

## Information to Gather

Before drafting the issue, collect the following. Ask for anything missing — do not invent it.

| Field | What to ask |
|---|---|
| **Type** | Bug, feature, chore, or docs? |
| **Title** | One-line summary (imperative mood: "Add …", "Fix …", "Remove …") |
| **Problem / motivation** | What's broken or missing, and why does it matter? |
| **Acceptance criteria** | What must be true for this issue to be closed? |
| **Out of scope** | What related things will *not* be addressed? (optional but valuable) |
| **Technical notes** | Known constraints, relevant files, dependencies (optional) |
| **Labels** | Defaults suggested below; ask user to confirm or override |
| **Assignee** | Leave blank unless user specifies |
| **Milestone** | Leave blank unless one exists (`gh milestone list`) |

---

## Deriving Acceptance Criteria

If the user hasn't provided acceptance criteria, derive them from the description using these rules:

- **Each criterion is independently verifiable** — a reviewer can check it without interpretation.
- **Write from the user/system perspective**, not the implementation perspective.
  - Good: "User sees an error message when submitting an empty form"
  - Bad: "Add validation to the form handler"
- **Cover the happy path first**, then edge cases and error states.
- **Include a non-regression criterion** when fixing a bug: "The scenario described in this issue no longer reproduces."
- Aim for 3–7 criteria. If more are needed, the issue is probably too large — suggest splitting it.

---

## Issue Body Template

Use this exact structure for the body:

```markdown
## Background

<1–3 sentences: the problem or motivation. Why does this issue exist?>

## Acceptance Criteria

- [ ] <Criterion 1 — verifiable outcome>
- [ ] <Criterion 2>
- [ ] <Criterion 3>

## Out of Scope

- <Item explicitly not covered by this issue>

## Technical Notes

<Optional: relevant files, architecture constraints, prior art, dependencies. Omit section entirely if nothing to add.>
```

- Keep **Background** factual and concise — no implementation details.
- The **Out of Scope** section prevents scope creep during review and implementation.
- Omit **Technical Notes** entirely if there's nothing useful to add.

---

## Label Conventions

Suggest labels from these standard sets. Create missing labels with `gh label create` if they don't exist.

**Type** (pick one):
| Label | Color | Use for |
|---|---|---|
| `type: feature` | `#0075ca` | New capability |
| `type: bug` | `#d73a4a` | Something broken |
| `type: chore` | `#e4e669` | Maintenance, deps, config |
| `type: docs` | `#0052cc` | Documentation only |

**Size** (pick one, based on effort estimate):
| Label | Color | Rough effort |
|---|---|---|
| `size: small` | `#c2e0c6` | < 4 hours |
| `size: medium` | `#fef2c0` | 4–16 hours |
| `size: large` | `#f9d0c4` | > 16 hours — consider splitting |

**Priority** (optional):
| Label | Color | Use for |
|---|---|---|
| `priority: high` | `#b60205` | Blocking other work |
| `priority: medium` | `#fbca04` | Normal queue |
| `priority: low` | `#0e8a16` | Nice to have |

Check what labels already exist before creating new ones:

```bash
gh label list
```

---

## Creating the Issue

### 1. Show the draft to the user

Always present the full title and body before running `gh issue create`. Allow the user to edit before confirming.

### 2. Create required labels

```bash
# Example: create a label that doesn't exist yet
gh label create "type: feature" --color "0075ca" --description "New capability"
```

### 3. Create the issue

```bash
gh issue create \
  --title "<title>" \
  --body "$(cat <<'BODY'
## Background

<background>

## Acceptance Criteria

- [ ] <criterion>

## Out of Scope

- <item>
BODY
)" \
  --label "type: feature,size: medium"
```

Add `--assignee "@me"` if the user is self-assigning. Add `--milestone "<name>"` if a milestone was specified.

### 4. Confirm and share

After creation, `gh` prints the issue URL. Share it with the user.

---

## Splitting Oversized Issues

If acceptance criteria exceed 7 items, or the issue spans multiple independent concerns, recommend splitting. A good split keeps each issue:

- Independently shippable
- Reviewable without the other issues
- Clearly titled so the relationship is obvious

Link related issues in the body using `#<number>` references after creation.

---

## Common Pitfalls

- **Vague titles**: "Fix bug" or "Improve performance" are not useful. Titles should name the specific thing.
- **Acceptance criteria that describe implementation**: "Refactor the service layer" is a task, not a criterion. Rephrase as an observable outcome.
- **Missing out-of-scope**: Without it, reviewers assume everything related is included.
- **No milestone on planned work**: If a milestone exists for the current sprint/release, attach the issue to it.
