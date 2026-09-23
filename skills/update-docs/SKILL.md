---
name: update-docs
description: Update the project's markdown docs so they describe the current state of the work. Use when the user says "/opendoc:update-docs", asks to update the docs, or when a piece of work is finished and the docs that govern it are now out of date.
---

# Update docs

The markdown docs under `.opendoc/<date-time>-<uuid>/` form a tree (`main.md` at the root, children for submodules) that describes what the project is and does. Bring them back in line with the work.

## Steps

1. **Find what changed.** Read `git diff` and `git diff <base>...HEAD` (`<base>` is usually `main`), plus anything the user described.
2. **Find the docs that govern it.** Start from the doc this session opened from; otherwise walk from `main.md` and pick the docs whose scope covers the change. A parent needs editing only if the change alters what it says about the child.
3. **Edit them to describe the current state.** Replace outdated statements in place; touch only affected sections. Keep each doc's language, structure and detail level. No changelogs, dates, or "how the work was done".
4. **Report.** List which docs changed, one line each. Don't commit unless asked.

## Keep docs concise

The docs are an outline, never prose. Write the fewest words that convey what each part is and does — short bullets and headings, not paragraphs. When updating, prefer trimming to adding; never pad a doc with detail the code or a diff already carries.
