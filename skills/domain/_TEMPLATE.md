---
name: <domain-rules-slug>
description: Cross-feature business-rules oracle — the single source of truth for judging PASS/FAIL.
last-verified: <YYYY-MM-DD>
---
# <Product> business rules (cross-feature oracle)

> Copy to `skills/domain/<product>-rules.md`. Every rule lives HERE once; feature guides link to it
> and summarize only the subset they need. Cite a source (spec, ticket, stakeholder, observed build)
> for each rule so it can be re-verified.

## 1. Glossary
| Term | Meaning |
|------|---------|
| _term_ | _definition_ |

## 2. Rules
| ID | Area | Rule (what SHOULD happen) | Source (ticket / spec / date) | Applies to features |
|----|------|---------------------------|-------------------------------|---------------------|
| R-001 | _area_ | _expected behavior_ | _PROJ-XXXX / spec §_ | `features/<feature>.md` |

## 3. Validations and error messages
| Trigger | Expected message / status | Source |
|---------|---------------------------|--------|
| _invalid input_ | _exact text / HTTP code_ | |

## 4. Roles and permissions matrix
| Role | Can | Cannot |
|------|-----|--------|
| _role_ | | |

## 5. Expected-vs-bug heuristics
Cases that look like defects but are EXPECTED (and the reverse). Example format:
- _"HTTP 4xx for <condition> is EXPECTED, not a bug."_

## 6. Open questions
| Question | Owner | Raised on |
|----------|-------|-----------|
| _unclear rule_ | _who can confirm_ | |
