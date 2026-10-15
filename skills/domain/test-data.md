---
name: test-data
description: Canonical test data — single source for identifiers, accounts, ranges and cards used in validations.
last-verified: <YYYY-MM-DD>
---
# Canonical test data (single source — never re-list values elsewhere, link here)

> **Never store secrets here** (passwords, TOTP seeds, tokens, real card numbers, real personal data).
> Reference accounts by alias and point to where the credential lives (`.env` /
> approved secret manager) — see `wiki/docs/test-accounts.md`. Use synthetic or vendor-published test
> values only.

## 1. Accounts / roles (aliases only)
| Alias | Role | Scope (tenant/store) | Credential lives in | Notes |
|-------|------|----------------------|---------------------|-------|
| _QA_USER_ | _role_ | _scope_ | `.env` → `QA_USER_*` | |

## 2. Primary entities (identifiers)
| Key | Type | Value | State / preconditions | Expected result | Last verified |
|-----|------|-------|-----------------------|-----------------|---------------|
| _ID-1_ | _entity type_ | _value_ | _state_ | _expected_ | _YYYY-MM-DD_ |

## 3. Valid / invalid input samples
| Field | Valid sample | Invalid sample | Expected error |
|-------|--------------|----------------|----------------|
| _field_ | | | |

## 4. Ranges / sequences
| Range name | From | To | Used by | Consumed? (note when a value is burned) |
|------------|------|----|---------|-----------------------------------------|
| _range_ | | | | |

## 5. Payment / external-service test values
| Item | Test value (vendor-published only) | Purpose |
|------|------------------------------------|---------|
| _card / token_ | | |

## 6. Environment-specific fixtures
| Environment | Fixture | Value / location | Owner |
|-------------|---------|------------------|-------|
| QA | _fixture_ | | |

## 7. Data hygiene
- Mark values as consumed when a flow burns them (one-time use).
- Record the date + ticket whenever a value is re-verified or stops working.
