---
id: test-accounts
title: "Test Accounts (Secure Setup)"
sidebar_label: "Test Accounts"
---

# Test Accounts (Secure Setup)

This repository documents how to choose and use QA account roles, but it intentionally stores no
usernames, passwords, TOTP seeds, session tokens, or recovery codes.

## Credential source

Retrieve QA credentials from your organization's approved secret manager or request them from the QA
lead through an approved secure channel. **Use dedicated QA/test accounts — never a personal
corporate email or personal credentials.** Never add credentials to:

- `.env.example`, Markdown, JSON, screenshots, network logs, or source code
- model prompts, Jira comments, terminal output, or CI logs
- Git commits, pull requests, issue descriptions, or chat messages

Local credentials belong only in `.env`, which is ignored by Git:

```dotenv
QA_USER_EMAIL=
QA_USER_PASS=
QA_USER_TOTP=

# Backward-compatible aliases used by some scripts
AUTO_USER=
AUTO_PASS=
AUTO_TOTP=
```

Single-sign-on (SSO) accounts normally need only `QA_USER_EMAIL`; username/password logins with MFA
need all three values. Adjust to your identity provider.

## Account-role selection

Do not infer authorization from an account name. Query the server record (your product's
users/claims endpoint — document it in the product's feature guide, e.g.
`GET /api/<users-or-claims-endpoint>`) and verify the role and assigned scope (tenant / store /
organization) at the start of each run.

| Account type | Use it for |
|--------------|------------|
| Admin / elevated role | Admin navigation, cross-scope and configuration flows |
| Scoped / standard role | Authorization-boundary tests (it must NOT see other scopes) |

Account provisioning can change — re-verify role and scope on every run, and record the verified
aliases (never secrets) in `skills/domain/test-data.md`.

## Username / password + MFA login

1. Open the QA application and start Sign In.
2. Enter the configured `QA_USER_EMAIL`.
3. Enter `QA_USER_PASS`.
4. Select the authenticator-app method if an MFA method chooser appears.
5. Generate the current six-digit code from `QA_USER_TOTP` and submit it immediately.

TOTP codes use a 30-second window. Generate them only in memory at runtime:

```ts
import * as OTPAuth from 'otpauth';

const secret = process.env.QA_USER_TOTP;
if (!secret) throw new Error('Missing QA_USER_TOTP');

const code = new OTPAuth.TOTP({
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  secret: OTPAuth.Secret.fromBase32(secret),
}).generate();
```

Do not use web-based TOTP generators because they disclose the seed to another service.

## SSO login

Enter the configured `QA_USER_EMAIL` on the identity provider's home-realm page. A cached SSO session
in the shared Edge profile should complete the login without exposing a password or MFA seed to the
automation. See `skills/shared-browser/SKILL.md` ("Login hook") for how the login is wired per product.

## Verification checklist

1. Run `npm run preflight`.
2. Confirm the account resolves from environment variables.
3. Confirm the authenticated claims/profile response has the expected role and scope.
4. Keep `.env` and `.auth/` untracked.
5. Before every push, inspect staged files and run a secret scan.
