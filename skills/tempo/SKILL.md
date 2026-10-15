---
name: tempo
description: Fill Tempo for a day to 8h — 2h morning admin ticket (2×1h) + 30m validation blocks, Activity=Development.
---

# Tempo Autofill (`/tempo`)

Use this skill when the user asks to fill Tempo quickly (for example: `/tempo`).

## Goal

Fill the **current day** in Tempo to complete **8h total** using ticket blocks and fixed activity.

## Hard rules

1. Every worklog must set **Activity = Development**.
2. Worklogs after the morning are created in **30m blocks**; the **morning ticket uses two 1h blocks** (see rule 5).
3. Fill only what is needed to complete **8h** for the target day.
4. Use tickets that were already used by the user during the same day (or recent day pattern if day is empty).
5. **08:00–10:00 (the first 2 hours) is the morning admin ticket**, as two 1h blocks with the same ticket:
   - 08:00–09:00 → comment `Working on issue <KEY>`
   - 09:00–10:00 → comment `Daily meeting`
6. Keep this morning ticket fixed until the user says otherwise.

## Morning ticket (rotates weekly)

The morning ticket is the weekly admin task (pin it with `TEMPO_MORNING_TICKET`, or set
`TEMPO_MORNING_SUMMARY` to a summary fragment so it is auto-detected).
It rotates each week — ask the user or use the one they give you.

- Week 1 (Jul 1W): `PROJ-1234`
- Week 2 (Jul 2W): `PROJ-1234`

Blocks 08:00–09:00 and 09:00–10:00 both use this ticket (1h each = 2h total).

## Allocation logic

After the 08:00–09:00 fixed hour:

## Allocation logic

After the 08:00–10:00 fixed morning ticket (2h):

1. Continue from **10:00** onward with 30m blocks.
2. Prefer unique tickets first (respecting the day's pattern).
3. If there are few tickets (e.g., 3), cycle them repeatedly until 8h is complete.
4. If there are many tickets (e.g., 50+), use only the amount needed to reach 8h (12 × 30m).
5. Stop exactly at 8h (no overfill). 2h morning + 12 × 30m = 28800s.

## Reusable script (preferred)

`scripts/tempo/fill-day.ts` fills ONE day end-to-end (resolves `originTaskId` via Jira,
builds the pattern, checks the day is empty, POSTs worklogs, verifies 28800s):

```
npx tsx scripts/tempo/fill-day.ts --date 2026-07-15 --morning PROJ-1234 \
  --tickets "PROJ-1234,PROJ-1234,..." [--dry-run] [--force]
```

- **Always `--dry-run` first** to review the plan, then run for real.
- Safe by default: aborts if the day already has worklogs (pass `--force` to add anyway).
- **PowerShell gotcha:** QUOTE the `--tickets` value (`"PROJ-1,PROJ-2"`) — unquoted commas
  become spaces (PS array coercion). The script also splits on whitespace as a fallback.
- Auth = `JIRA_TOKEN` (Bearer) — works for both Jira API and `tempo-timesheets` endpoints.
- Read existing day state via `POST /jira/rest/tempo-timesheets/4/worklogs/search`
  (body `{from, to, worker:[process.env.TEMPO_WORKER]}`). A **GET** on `/worklogs/` returns 405.

## Manual endpoint (if scripting by hand)

1. Read existing worklogs for the target day (search endpoint above).
2. Create blocks via `POST /jira/rest/tempo-timesheets/4/worklogs/` with fields:
   - `worker` = `TEMPO_WORKER` from `.env`
   - `originTaskId` (numeric Jira issue id, from `GET /issue/<KEY>?fields=id`)
   - `started` (`YYYY-MM-DD HH:mm:ss.SSS`)
   - `timeSpentSeconds` / `billableSeconds` (3600 morning, 1800 rest)
   - `comment`
   - `attributes._Activity_ = { workAttributeId: 32, value: "Development" }`
3. Verify day total equals `28800` seconds (8h).

## Notes

- Never change other days unless user explicitly asks.
- If duplicates exist in the same day/time slot, remove extras and keep one valid entry.
- If a ticket key cannot be resolved to `originTaskId`, skip it and move to the next candidate.
