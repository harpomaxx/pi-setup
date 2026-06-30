---
name: weekly-workflowy-summary
description: Create a weekly grouped summary from the user's Workflowy calendar. Use when the user asks for last week's tasks, a weekly work summary, or to organize Workflowy calendar items into categories like writing, classes, and research with short explanatory lines.
---

# Weekly Workflowy Summary

Use this skill to produce a concise weekly summary from the user's Workflowy calendar.

## Workflow

1. Determine the requested week.
   - If the user says "last week", use the previous Monday through Sunday relative to the current date.
   - If the user asks for a specific date range, use that range.
   - If unclear, ask a brief clarification.
2. Call `workflowy_list_calendar` with:
   - `start_date`: first day of the week/range in `YYYY-MM-DD`
   - `end_date`: last day of the week/range in `YYYY-MM-DD`
   - `include_completed`: `true`
3. Read all calendar items and ignore truly empty items.
4. Consolidate duplicates or near-duplicates before summarizing.
   - Treat "Muris paper", "Muris AD&D paper", and "Work on Muris AD&D paper" as the same Muris AD&D paper item unless the user says otherwise.
5. Organize items into groups. Default groups:
   - **Writing / admin**
   - **Classes**
   - **Research**
   - **Research meetings / collaboration**
6. Add one short explanatory line to each item.
   - Keep each explanation factual and modest.
   - If the calendar item lacks details, say "likely" or use a generic explanation rather than inventing specifics.
7. If the user corrects a category or explanation, update the summary and remember it for the current conversation.

## User-specific grouping notes

Use these preferences when applicable:

- Meetings with course students, office hours, teaching support, grading, class notes, or course preparation belong under **Classes**.
- The user teaches courses including **IA** and **Algorithms**; items mentioning these courses should usually be grouped under **Classes**.
- **Aida and Martina** are examples of course students; do not treat them as recurring unless they appear in the calendar item.
- **Muris**, **Vero**, and **Tati/Tatii** are the user's PhD students. Meetings with them usually belong under **Research meetings / collaboration**, not Classes.
- PhD students may work on different topics from week to week; infer the topic from the calendar item text or notes, and avoid hard-coding a fixed topic unless the item says it.
- **Cristian** is the user's CONICET supervisor; meetings with Cristian belong under research meetings/supervision.
- **Vero and Harm** meetings are usual PhD sync-up meetings; if the calendar item mentions a paper or topic, describe the sync-up as focused on that.
- **Muris paper** and **Muris AD&D paper** can refer to the same work when they appear in the same weekly context; merge only clear duplicates or near-duplicates.

## Output format

Use this format:

```markdown
### Writing / admin
- **Item name** — Short explanatory line.

### Classes
- **Item name** — Short explanatory line.

### Research
- **Item name** — Short explanatory line.

### Research meetings / collaboration
- **Item name** — Short explanatory line.
```

Only include groups that have items unless the user asks for all groups.
