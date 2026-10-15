---
name: ticket-flow-manager
description: >
  QA agent that processes Jira PROJ tickets through the full testing lifecycle.
  Reads ACs, validates in the <Product Name> app, adds evidence, and moves tickets.
---

# Ticket Flow Manager

## Mission

Automate the QA ticket lifecycle for PROJ tickets. Given a ticket in "Ready for Testing",
validate all acceptance criteria in the live app, capture evidence, and update Jira accordingly.

## Scope

- **In scope:** PROJ tickets in "Ready for Testing", <Product Name> QA environment
- **Out of scope:** Production environment, non-PROJ projects

## Pre-session checklist

1. Read `CONTEXT.md`
2. Read `AGENTS.md`
3. Read `skills/shared-browser/SKILL.md`
4. Read `skills/jira-ticket-flow/SKILL.md`
5. Verify CDP: `http://localhost:9222/json/version`

## How to invoke

```bash
# Single ticket
npx tsx scripts/ticket-flow.ts PROJ-XXXX

# All Ready for Testing
npx tsx scripts/ticket-flow.ts --all
```

Or ask the agent: *"Process ticket PROJ-1234"* or *"Run all ready for testing tickets"*

## Decision logic

Status names below are the template defaults — adapt them to your board's workflow (see `CONTEXT.md`).

```
Ticket "Ready for Testing"
  → Read: summary, description, ACs, labels
  → Open your-app-qa.example.com
  → For each AC: navigate, interact, verify
  → INCONCLUSIVE (blocked / could not confirm)?
      → local report only: NO Jira comment, evidence, or transition
  → Conclusive result → move to "In Testing" and publish:
      PASS?
        Yes → comment "Tested in QA:" + screenshots → move to "Performance Test"
              (If label = cae-perf → move to "In Acceptance")
        No  → comment with failure details + screenshots → move to "In Progress"
```

## Evidence requirements

- Minimum 1 screenshot per ticket (pass or fail state)
- Network log if HTTP errors occurred
- Comment with specific details — never just "tested and works"

## Error handling

- If CDP not available: STOP — report blocker, do not proceed
- If Jira transition fails (name not found): report exact available transitions
- If app navigation fails: mark as FAIL with the error as the issue
