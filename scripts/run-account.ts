export type AuthAudience = 'employee' | 'external';

export interface RunAccount {
  email: string;
  password: string;
  secretKey: string;
  audience: AuthAudience;
}

const QA_LOGIN_EMAIL = process.env.QA_USER_EMAIL ?? '';
const AUTO_LOGIN_EMAIL = process.env.AUTO_USER ?? '';

/** Email domain of corporate "employee" SSO accounts (e.g. "@your-company.example.com"). Unset = no employee accounts. */
const EMPLOYEE_EMAIL_DOMAIN = (process.env.EMPLOYEE_EMAIL_DOMAIN ?? '').trim().toLowerCase();

/** Visible text of the sign-in chooser buttons (generic hook — adjust to your SSO landing page). */
export const SSO_EMPLOYEE_BUTTON_TEXT = process.env.SSO_EMPLOYEE_BUTTON_TEXT?.trim() || 'Employee Sign In';
export const SSO_EXTERNAL_BUTTON_TEXT = process.env.SSO_EXTERNAL_BUTTON_TEXT?.trim() || 'Customer Sign In';

function textToRegex(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'), 'i');
}
export const SSO_EMPLOYEE_BUTTON_RE = textToRegex(SSO_EMPLOYEE_BUTTON_TEXT);
export const SSO_EXTERNAL_BUTTON_RE = textToRegex(SSO_EXTERNAL_BUTTON_TEXT);

export function inferAudience(email: string): AuthAudience {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return 'employee';
  if (!EMPLOYEE_EMAIL_DOMAIN) return 'external';
  const domain = EMPLOYEE_EMAIL_DOMAIN.startsWith('@') ? EMPLOYEE_EMAIL_DOMAIN : `@${EMPLOYEE_EMAIL_DOMAIN}`;
  return normalized.endsWith(domain) ? 'employee' : 'external';
}

function loadRunAccountFromEnv(email: string): RunAccount {
  if (!email.trim()) {
    throw new Error('[Auth] Missing QA_USER_EMAIL/AUTO_USER for run account resolution.');
  }
  const audience = inferAudience(email);
  const password = (process.env.QA_USER_PASS ?? process.env.AUTO_PASS ?? '').trim();
  const secretKey = (process.env.QA_USER_TOTP ?? process.env.AUTO_TOTP ?? '').trim();

  if (audience === 'external' && (!password || !secretKey)) {
    throw new Error(
      '[Auth] External (non-employee) login requires QA_USER_PASS/AUTO_PASS and QA_USER_TOTP/AUTO_TOTP. ' +
      'Retrieve credentials from the approved secret manager; they are not stored in this repository.',
    );
  }

  return { email: email.trim(), password, secretKey, audience };
}

export function resolveRunAccount(): RunAccount {
  const candidates = [QA_LOGIN_EMAIL, AUTO_LOGIN_EMAIL]
    .map(v => v.trim())
    .filter((v, i, arr) => v && arr.indexOf(v) === i);

  if (!candidates.length) {
    throw new Error('[Auth] Missing QA_USER_EMAIL/AUTO_USER for run account resolution.');
  }

  for (const email of candidates) {
    return loadRunAccountFromEnv(email);
  }

  throw new Error('[Auth] Could not resolve a run account from the configured environment.');
}
