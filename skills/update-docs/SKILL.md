---
name: update-docs
description: Update the project's markdown docs so they describe the current state of the work. Use when the user says "/opendoc:update-docs", asks to update the docs, or when a piece of work is finished and the docs that govern it are now out of date.
---

# Update docs

The markdown docs under `.opendoc/<date-time>-<uuid>/` form a tree (`main.md` at the root, children for submodules) that describes what the project is and does. Bring them back in line with the work done in this session.

**The doc is an outline, not a store of context.** It says what each part is and does and points to where it lives — nothing more. The full context of the work lives in this chat session's history. Never copy that context into the doc: no detail, rationale, values, or step-by-step account of what was done. Your job is to keep the outline accurate, not to record the work in it.

## Steps

1. **See what was done.** Look back over this chat session to understand what the work changed about the project.
2. **Find the docs that govern it.** Start from the doc this session opened from; otherwise walk from `main.md` and pick the docs whose scope covers the work. A parent needs editing only if the work alters what it says about the child.
3. **Edit them to describe the current state.** Replace outdated statements in place; touch only affected sections. Keep each doc's language, structure and detail level. No changelogs, dates, or account of how the work was done.

## Keep it an outline

- Write the fewest words that convey what each part is and does — short bullets and headings, not paragraphs or prose.
- Never move context from the session into the doc: what happened, why, and the specifics stay in the session history. Point to where things live instead.
- When updating, prefer trimming to adding. If a section has grown into an explanation, cut it back to the outline.
