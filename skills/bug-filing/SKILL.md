---
name: bug-filing
description: Standard for creating Jira bug tickets with full evidence. Use whenever filing a bug.
---

# Bug Filing Standard — QA Brain

Use this skill whenever the user asks to file, lift, clone, or create a Jira bug ticket.

## Language & AI attribution

- **All content must be in English** — title, description, repro steps, comments, and any Jira fields we populate.
- All bugs filed by the agent automatically include:
  - Label: `ai-generated`
  - Footer in description: `🤖 This bug was filed by the QA AI Agent (GitHub Copilot). Reviewed by: the QA owner.`

## Filing pattern

When creating a bug, clone the structure of a prior bug and keep the same ticket shape:

1. Title format
2. Description fields
3. Evidence embedded in the description
4. Network log attached when relevant
5. AI-generated label/footer

If the Jira screen exposes extra tabs/fields such as **Team**, **Delivery**, or **Documentation**, preserve the same defaults used by similar recent bugs unless the user asks for a change.

## Bug title format

```
{Environment} | {Section} | {minimal description}
```

- **Environment:** `QA` or `CAE`
- **Section:** The UI area where the bug occurs (e.g., `Inventory`, `Checkout`, `Dashboard`)
- **Minimal description:** One short phrase describing the symptom (not the cause)

### Examples

```
QA | Inventory | User cannot select any plate
QA | Checkout | Order number not generated after submit
QA | Dashboard | Page shows blank screen on load
CAE | Authentication | Login button unresponsive after SSO redirect
```

## Bug description fields (ALL required)

### Issue
Full description of the problem:
- What happened
- What screen/flow
- What the user was doing when it broke

### Acceptance Criteria
What the correct behavior should be:
- Clear, testable statement
- Based on the user story, design, or prior behavior

### Repro Steps
Numbered, specific steps to reproduce in under 2 minutes:
```
1. Open https://your-app-qa.example.com
2. Log in with the QA test account (role: <role>)
3. Navigate to Inventory
4. Click on any vehicle in the list
5. Observe: nothing happens — no plate selector appears
```

### Evidence (attachments)
- At minimum 1 screenshot showing the broken state
- Annotate with red box/arrow pointing to the problem
- If a form or modal: include screenshot of the full state
- **Also place the screenshots inline under `Evidence` in the description** so the bug is useful even before attachments are opened

### Network (if applicable)
- Attach the `network-errors-*.json` file if HTTP errors occurred
- Include relevant request/response in the description if helpful for devs

### Description ordering

Use this exact order unless a copied bug template already has a proven variant:

1. `Issue`
2. `Acceptance Criteria`
3. `Repro Steps`
4. `Evidence`
5. `Network`
6. `Environment`
7. AI footer

## Required Jira fields & ticket shape (match prior agent bugs EXACTLY)

`createBug` in `scripts/jira-client.ts` sets these automatically — do not drop them, and if you
POST `/issue` by hand replicate ALL of them:

- `priority`: P3 - High (`id 2`) · `labels`: `[<env>, ai-generated]` (e.g. `qa, ai-generated`)
- `fixVersions`: **`<Product> Release YYYY.MM`** (env `JIRA_FIX_VERSION`)
- **Designated Tester** custom field: configured through `JIRA_DESIGNATED_TESTER`; never
  hardcode a personal Jira identity in source.
- Instance-specific custom fields (team/squad, environment, impairment, severity, work
  classification, region…): ids differ per Jira instance — discover them with
  `GET /rest/api/2/issue/createmeta?projectKeys=PROJ&expand=projects.issuetypes.fields`, record the
  required ones (id → value) in `CONTEXT.md`, and set them in `createBug`.

Verify against a recent bug (e.g. PROJ-1234) before filing — "clone the shape".

## Formatting rules (do NOT skip)

- **Acceptance Criteria = a numbered list** (`1) … 2) … 3) …`), never a prose paragraph — see
  `scripts/templates/jira-bug-template.txt`.
- **Screenshot MUST be annotated** with a red box/arrow pointing at the defect (AGENTS.md evidence
  standard). A plain page capture is not acceptable. Annotate live before attaching, e.g. inject a
  red-bordered `<div>` + label over the target element via `page.evaluate`, then `page.screenshot`.
- Embed the annotated screenshot inline under `*Evidence:*` with `!name.png|thumbnail!`, and attach
  it BEFORE writing the description so the `!image!` reference resolves.
- Include an `*Observed behavior:*` + `*Expected behavior:*` pair; for network defects add the
  request/response table inline and attach the sanitized `*.json` capture.

## Filing via script

```typescript
import { fileBug } from './bug-reporter.js';

const issueKey = await fileBug({
  section: 'Inventory',
  description: 'User cannot select any plate',
  issue: 'When clicking a vehicle in the Inventory list, no plate selector dialog appears.',
  acceptanceCriteria: 'Clicking a vehicle should open a plate selection dialog.',
  reproSteps: '1. Navigate to Inventory\n2. Click any vehicle\n3. Observe: no dialog appears',
  screenshots: ['artifacts/explore/inventory-broken-1234567890.png'],
  networkLog: 'artifacts/explore/network-errors-inventory-1234567890.json',
  consoleErrors: ['Uncaught TypeError: Cannot read properties of undefined (reading "plates")'],
});
```

## What to copy from a prior bug

When the user says “clone an earlier bug,” reuse the same:

- Jira title pattern
- English wording style
- Issue / Acceptance Criteria / Repro Steps / Evidence / Network layout
- Evidence-first behavior for screenshots
- AI footer and `ai-generated` label

Only change the section, symptom, and evidence that are specific to the new defect.

## Severity guidance

| Severity | Description |
|----------|-------------|
| Critical | Blocks core workflow, data loss, auth failure |
| High | Feature broken, workaround unclear |
| Medium | Feature degraded, workaround exists |
| Low | Cosmetic, minor UX issue |

Set severity in the `priority` field when creating via API (not yet automated — set manually in Jira if needed).
