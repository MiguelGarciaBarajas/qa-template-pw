---
name: local-word-test-plan
description: Create a local Word (.docx) test plan for a Jira Fix Version, following user-provided example documents and saving it in the product's existing Test Plans folder under your QA projects root. Use for "create a Word test plan", "local test plan", or release-linked Word test plans. Not for creating TestRail plans.
---

# Local Word Test Plan

## Scope

Produce a local `.docx` test plan tied explicitly to a Jira project and Fix
Version. This is separate from a TestRail Test Plan and the release Excel
checklist. Reuse the release's TestRail milestone; if missing, invoke the
release-documentation skill's milestone workflow as the explicitly authorized
prerequisite described below. Do not otherwise create TestRail objects,
publish to Confluence, update Jira, or send emails unless separately requested.

## Inputs

- Jira project and exact Fix Version name, ID, or URL.
- Target product(s).
- One or more user-provided Word examples, or explicit approval to use an
  existing document as the template.
- Any release-specific scope, environments, exclusions, or special instructions.

The user supplies an example Word test plan (e.g. `<product>\Test Plans\<Example Plan>.docx`) under the
destination root. Use it with the section rules below. Generate a document only when the user
requests a plan for a concrete Fix Version, not while defining this skill.
Other existing files are candidates, not automatically approved examples.
If several supplied examples conflict, clarify which is authoritative.

## Destination

**The user MUST provide the destination path** (the local root or the exact folder where
the Word documents are created) at the start of every run, before generating anything.
Ask for it if it was not given; never assume a default or another user's path, and never
create documents outside the path the user gave. Example of a root (for reference
only — each user has their own):

```text
C:\Users\<user>\<synced-folder>\QA-Projects
```

Verify the given path exists. Within it, discover the product folder and its existing test-plan directory at runtime.
Names vary; do not assume every folder is literally `Test Plans`. Record the folders you discover
(per product) here as you learn them:

| Product | Relative test-plan folder |
|---------|---------------------------|
| `<PRODUCT-A>` | `<product-folder>\Test Plans` |
| Cross-product | `<shared-folder>\TestPlans` |

Search only the relevant product's descendants before deciding a folder is missing. If no unambiguous
destination exists, request the destination; do not create a new directory on an assumption. Recheck
paths because synced (cloud) folders can change.

Never overwrite an existing plan or modify the supplied examples. Follow
the approved example's filename convention; if none exists, use
`Test Plan - <exact Fix Version name>.docx`, replacing only filename-invalid
characters. On collision, use a new numbered revision and report its path.

## Workflow

### 1. Inspect the examples

Read the complete document, including tables, headers, footers, revision
history, page setup, logos, and styles. Use Microsoft Word COM for `.doc`
examples; for `.docx`, Word COM or `python-docx` can inspect and edit.
Preserve the approved template's formatting, section order, and language.
Do not merely recreate its headings in a generic document.

Identify release-specific content versus reusable boilerplate. Replace old
release names, dates, ticket lists, URLs, and results without carrying over
stale approvals or execution claims.

### 2. Gather authoritative release data

Discover the available Atlassian MCP tools before calling them. Resolve the
Fix Version to its exact ID, name, project, and release date, then retrieve
all matching issues with pagination. Use an ID-scoped JQL such as:

```text
project = PROJ AND fixVersion = <versionId> ORDER BY issuetype, key
```

Include **Story, Bug, and Defect only** in the plan. Exclude Task and
Sub-task; report their excluded counts. Read descriptions and acceptance
criteria for every in-scope ticket. Do not derive coverage solely from titles.

Record the exact Fix Version name, ID, and clickable Jira version URL
inside the document. Build ticket-to-planned-coverage traceability with
clickable issue links, adapting it to the example's tables.

For multi-product releases, determine each ticket's product from verified
release data and user instructions. Clarify unresolved ownership and
cross-product scope; do not copy every ticket into every product's plan.

### 3. Populate the Word plan

Follow the approved example and the section rules below. These explicit
preservation rules override generic suggestions to rewrite template content.
Distinguish planning from execution.

#### Approved rules: Introduction through Testing Environments

- **Introduction bullets:** replace the old release's bullets with an
  extremely short, plain-language summary of all in-scope tickets and bugs.
  Group tickets sharing a flow into one bullet (for example, "Checkout" or
  "Import"). Do not write one bullet per ticket or copy long ticket titles.
  Summarize the changes, not detailed test scenarios; retain full ticket
  coverage elsewhere in the document.
- **Overview sentence:** preserve the paragraph starting
  `This document will provide an overview...` verbatim except for replacing
  the product name with the target product.
- **Headers:** replace the old product name from the example
  with the target product and the old date with the document creation date,
  not the release date. Preserve formatting and inspect every section's
  applicable header variants.
- **Team Name and Stakeholders:** keep the existing content, adding the QA owner's name
  to the Manual QA entry if the template lists QA members.
- **Testing Strategy and Risks & Mitigations:** preserve the template content
  verbatim, including existing criteria and intervening general testing
  sections; do not rewrite them for the release.
- **Dependencies:** preserve the section and table unchanged.
- **Testing Environments:** replace the product and environment list. Use verified environments
  per product (some products may have **QA and Production only** — document such exceptions here
  as you learn them); never add UAT/PERF unless verified, and do not invent environment URLs.

#### Approved rules: Feature Breakdown

Analyze every Story, Bug, and Defect as a senior QA engineer. Create one
complete ticket-specific block per in-scope issue, identifying its key,
title, and Jira link. Group repeated flows under a common flow heading
(for example, Checkout or Import), but retain a separate block for **each**
ticket within that group. Grouping must never collapse distinct tickets
into one generic block or lose their acceptance criteria.

For each ticket, preserve the template's block structure and populate:

- **Description:** an extremely brief description in simple words.
- **Impact Analysis:** identify the flow or flows affected by the change.
- **Brainstorm / Positive testing:** concise, simple sentences describing
  the expected successful behavior, based on the ticket's acceptance criteria.
- **Brainstorm / Negative Testing:** concise, simple sentences describing
  relevant invalid inputs, denied actions, or error paths derived from the
  criteria and affected flow. Distinguish QA-derived scenarios from explicit
  criteria; do not invent business rules. If criteria are missing or unclear,
  identify the gap rather than claim complete coverage.
- **Testing Strategy:** leave exactly as in the template, including
  `One and Done Testing (Will never be run again)`.

Keep the remaining block labels and reusable boilerplate unless the user
instructs otherwise. Do not carry forward old release execution claims
as new results.

**Milestone link:** replace the old TestRail milestone hyperlink in every
ticket block with the verified milestone for this Fix Version and product.
Use the milestone URL (`index.php?/milestones/view/<id>`), not the plan
or run URL. Ensure every block has this link, including template blocks
that previously lacked one.

1. Look up and verify the milestone created by the release-documentation
   workflow, matching exact Fix Version name and target TestRail project.
2. If missing, invoke `release-documentation` and follow its milestone
   creation workflow and prerequisites. Reuse existing release objects;
   do not bypass its requirements or fabricate a milestone URL. If that
   workflow requires further inputs or cannot finish, report the prerequisite
   as blocked rather than claim the Word plan is complete.
3. Independently verify the resulting milestone's ID, name, project, and
   URL before inserting it into the document.

#### Approved rules: Final sections

- **Test considerations for brainstorming:** preserve the entire section
  exactly, including its table, values, notes, and existing reference link.
- **Reviewers and Sign Offs:** preserve the entire section and table exactly.
  Do not add reviewers, dates, or approvals.

#### Data honesty

- Dates not set in Jira or supplied by the user remain `TBD`.
  The header creation date is known at generation time and is not `TBD`.
- Unknown environments, owners, approvals, or dependencies remain explicit
  pending items; never fill them with plausible guesses.
- Copy actual workflow statuses accurately, including Performance Test.
- Untested cases are not failures; open tickets are readiness risks, not
  proof that no testing occurred or that deployment is prohibited.
- Link existing TestRail milestone/plan/runs only when independently verified.
  Do not assume historical counts are current.
- Do not attribute cases to SmartLearn unless their generation is verified.
- Do not include credentials, tokens, or sensitive test-account data.

### 4. Save and verify

Use Word-compatible tooling. Prefer editing a copy of the template with
Microsoft Word COM when fidelity or fields matter; `python-docx` is suitable
for supported `.docx` structures. Never write plain text with a `.docx`
extension. Update fields/table of contents in Word where applicable.

Save to the resolved absolute product path. Close only documents opened by
this run; do not close user documents or terminate shared Office processes.
On an error, report it and release this run's COM objects in `finally`.

Reopen the saved file from disk and verify:

- Valid Word document with the expected sections, styles, and populated tables.
- Correct product and exact Fix Version name/ID/link.
- All in-scope tickets represented, with exclusions explained.
- Exactly one complete Feature Breakdown block per Story/Bug/Defect,
  even when grouped under shared flow headings; no Task/Sub-task blocks.
- Descriptions remain extremely brief; impact and positive/negative
  scenarios reflect each ticket's flow and acceptance criteria.
- Every ticket block links to the verified release milestone; no stale
  milestone URLs remain.
- No stale release details, fabricated dates, results, or approvals.
- Working hyperlink targets, no unexplained template placeholders.
- Layout reviewed in Microsoft Word when available, including table overflow,
  page breaks, headers/footers, and table of contents.
- Introduction bullets group shared flows and remain extremely short;
  the overview paragraph differs only in product name.
- Headers show the target product and creation date; Manual QA lists the
  QA owner per the template.
- Preserved strategy, general testing, risks, and dependencies match the
  source template; environment lists match the verified environments per product.
- Per-ticket Testing Strategy, Test considerations for brainstorming, and
  Reviewers and Sign Offs match the template unchanged.

Report the actual absolute `.docx` path, the template used, the linked Fix
Version, and any remaining `TBD` items. Local save verification is not proof
of cloud-sync (e.g. OneDrive/Drive) synchronization; do not claim synchronization unless checked.
