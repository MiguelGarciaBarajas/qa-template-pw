/**
 * Autonomous QA Agent — validate ANY Jira ticket from the terminal, no IDE assistant needed.
 *
 *   Brain : GitHub Models API (OpenAI-compatible, your GitHub token) — reads the ACs and the
 *           live ARIA tree, decides actions, reaches a verdict.
 *   Hands : Playwright over the shared Edge (CDP) — scripts/agent-browser.ts
 *   Mouth : scripts/publish-result.ts — attaches evidence, posts the rich comment, transitions.
 *
 * Usage:
 *   npx tsx scripts/agent-validate.ts PROJ-1234 [--max-steps 30] [--no-transition]
 *
 * Requires in .env:
 *   GITHUB_TOKEN          a GitHub PAT with the "models: read" permission
 *   (optional) GITHUB_MODELS_CANDIDATES   comma-separated model list
 */

import 'dotenv/config';
import fs from 'node:fs';
import OpenAI from 'openai';
import { getIssue, type JiraIssue } from './jira-client.js';
import { connectBrowser, disconnectBrowser } from './cdp-browser.js';
import { publishResult } from './publish-result.js';
import { AgentBrowser } from './agent-browser.js';
import type { ValidationResult, AcCheck } from './ticket-validator.js';
import { generateScript, type RecordedStep } from './script-generator.js';
import { resolveRunAccount, type RunAccount } from './run-account.js';
import { runPreflightChecks } from './preflight.js';
import { loadOracleContext } from './oracle-source.js';
import { loadLegacyFlowGuide, renderLegacyGuide, type LegacyFlowGuide } from './legacy-flow-map.js';
import { findSimilarTestrailCase, renderTestrailMatch, type TestrailMatch } from './testrail-oracle.js';
import { matchSectionFlowGuides, renderSectionFlowGuides, resolveSectionGuideStartUrl, type SectionFlowMatch, extractSectionFromUrl, isSectionChange } from './section-flow-map.js';
import { resolveGitHubModel, resolveModelCandidates } from './model-resolver.js';

const APP_URL  = process.env.APP_URL_QA ?? 'https://your-app-qa.example.com';
const APP_URL_LEGACY = process.env.APP_URL_LEGACY?.trim() ?? '';
const APP_ENV  = process.env.APP_ENV ?? 'QA';
const DEFAULT_MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? '45') || 45;
const DEFAULT_LEGACY_ORACLE = /^(1|true|yes)$/i.test(process.env.LEGACY_ORACLE ?? 'false');
const TESTRAIL_SUPPLEMENTAL_WHEN_MAPPED = /^(1|true|yes)$/i.test(process.env.TESTRAIL_SUPPLEMENTAL_WHEN_MAPPED ?? 'false');
const BASE_URL = 'https://models.github.ai/inference';
const TOOL_CONTENT_MAX = 1200;

interface AgentReport {
  passed: boolean;
  inconclusive?: boolean;
  summary: string;
  acChecks?: Array<{ id?: string; description: string; expected: string; observed: string; passed: boolean }>;
  parityChecks?: Array<{
    id?: string;
    scenario: string;
    legacyObserved: string;
    currentObserved: string;
    matches: boolean;
    notes?: string;
  }>;
  oracleSummary?: string;
  reproSteps?: string[];
  notValidated?: string[];
  testData?: Record<string, string>;
}

// ─── Tool definitions exposed to the model ─────────────────────────────────────
const TOOLS = [
  tool('browser_navigate', 'Navigate to a URL (handles sign-in). In legacy-oracle mode, set target to current or legacy.', { url: { type: 'string' }, target: { type: 'string', enum: ['current', 'legacy'] } }, ['url']),
  tool('browser_snapshot', 'Get the page ARIA tree (roles + names). In legacy-oracle mode, set target.', { target: { type: 'string', enum: ['current', 'legacy'] } }),
  tool('browser_click', 'Click by role+name or visible text. In legacy-oracle mode, set target.', { role: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, target: { type: 'string', enum: ['current', 'legacy'] } }),
  tool('browser_fill', 'Type into a text field. Set submit=true to press Enter. In legacy-oracle mode, set target.', { label: { type: 'string' }, placeholder: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' }, submit: { type: 'boolean' }, target: { type: 'string', enum: ['current', 'legacy'] } }, ['value']),
  tool('browser_select', 'Select an option from a dropdown. In legacy-oracle mode, set target.', { label: { type: 'string' }, name: { type: 'string' }, option: { type: 'string' }, target: { type: 'string', enum: ['current', 'legacy'] } }, ['option']),
  tool('browser_screenshot', 'Capture a screenshot as evidence. In legacy-oracle mode, set target.', { name: { type: 'string' }, target: { type: 'string', enum: ['current', 'legacy'] } }, ['name']),
  tool('browser_get_console', 'Get captured JS console errors. In legacy-oracle mode, set target.', { target: { type: 'string', enum: ['current', 'legacy'] } }),
  tool('browser_get_network', 'Get failing network calls (HTTP >= 400). In legacy-oracle mode, set target.', { target: { type: 'string', enum: ['current', 'legacy'] } }),
  {
    type: 'function' as const,
    function: {
      name: 'report_result',
      description: 'FINISH: report the validation verdict. Call exactly once when you are done.',
      parameters: {
        type: 'object',
        properties: {
          passed: { type: 'boolean', description: 'true ONLY if every acceptance criterion is confirmed working' },
          inconclusive: { type: 'boolean', description: 'true if you could NOT confirm the feature (blocked, server error, screen unreachable). Never claim pass/fail then.' },
          summary: { type: 'string', description: 'one-line verdict' },
          acChecks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                description: { type: 'string' },
                expected: { type: 'string' },
                observed: { type: 'string' },
                passed: { type: 'boolean' },
              },
              required: ['description', 'expected', 'observed', 'passed'],
            },
          },
          parityChecks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                scenario: { type: 'string' },
                legacyObserved: { type: 'string' },
                currentObserved: { type: 'string' },
                matches: { type: 'boolean' },
                notes: { type: 'string' },
              },
              required: ['scenario', 'legacyObserved', 'currentObserved', 'matches'],
            },
          },
          oracleSummary: { type: 'string', description: 'One-line parity conclusion vs legacy oracle.' },
          reproSteps: { type: 'array', items: { type: 'string' } },
          notValidated: { type: 'array', items: { type: 'string' } },
          testData: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['passed', 'summary', 'acChecks'],
      },
    },
  },
];

function tool(name: string, description: string, props: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'function' as const,
    function: { name, description, parameters: { type: 'object', properties: props, required } },
  };
}

function buildSystemPrompt(args: { appUrl: string; legacyOracle: boolean; legacyUrl?: string; guideEnforced?: boolean; lockedSection?: string | null; manualLogin?: boolean }): string {
  const legacySection = args.legacyOracle
    ? `\nLegacy-oracle mode is ENABLED.\n` +
      `- Compare current app (${args.appUrl}) against legacy (${args.legacyUrl ?? 'configured legacy URL'}).\n` +
      `- Use target="current" or target="legacy" on browser tools.\n` +
      `- Establish legacy behavior first, then validate current-app parity.\n` +
      `- In report_result include parityChecks[] and oracleSummary.\n` +
      `- If parity evidence is incomplete, set inconclusive=true and explain what is missing.\n`
    : '';
  const guideSection = args.guideEnforced
    ? `\nExecution guide is MANDATORY for this ticket.\n` +
      `- Follow the provided mapped workflow end-to-end before concluding.\n` +
      `- Do not stop at intermediate field issues; try at least one alternate valid input/path within the same mapped flow.\n` +
      `- Only report inconclusive after proving the mapped target behavior is unreachable and documenting attempted paths.\n` +
      `- Never report "login failed" if you are already authenticated in the app host; continue with the ticket flow and diagnose the actual feature failure.\n`
    : '';
  const sectionLockSection = args.lockedSection
    ? `\nSECTION LOCK is ACTIVE: [${args.lockedSection}]\n` +
      `- You MUST stay in the [${args.lockedSection}] section for the entire run.\n` +
      `- Any attempt to navigate to a different section will be BLOCKED by the system.\n` +
      `- Do NOT click sidebar links to go to other sections (Search, Dashboard, etc.).\n` +
      `- If the [${args.lockedSection}] feature is broken or inaccessible, document that as the failure and call report_result.\n` +
      `- Complete ALL required checks within [${args.lockedSection}] before calling report_result.\n`
    : '';
  const manualLoginSection = args.manualLogin
    ? `\nSESSION MODE: MANUAL LOGIN (externally managed)\n` +
      `- The user's browser session is already authenticated before you start.\n` +
      `- If you encounter a login screen (email/password fields, MFA code), DO NOT fill in any credentials.\n` +
      `- Instead: call browser_navigate to ${args.appUrl} to recover the session.\n` +
      `- Never call browser_fill on email, password, or OTP fields.\n`
    : '';
  return `You are an autonomous QA tester for the <Product Name> web app (${args.appUrl}).
You validate a Jira ticket by driving a real browser with the provided tools and judging each acceptance criterion against what you actually observe.

How to work:
- Start with browser_snapshot to read the page (roles + names). Re-snapshot after every navigation or click.
- Act on what is actually present. Prefer role+name; fall back to visible text.
- Workflow discipline:
  - If a store/tenant selection gate is visible, select the context FIRST.
  - Follow the real navigation path users take (left-nav, in-page dialogs) instead of global search shortcuts.
  - Use top Search only when the ticket explicitly requires searching an existing record and store context is already selected.
- Reproduce the behavior described in the ticket. Check each acceptance criterion: record Expected vs Observed.
- ALWAYS capture at least one screenshot of the decisive state — especially any bug/blocked/error state.
- Check browser_get_console and browser_get_network when something fails — include the failing endpoint/status in your report.
- Never invent test credentials. Do NOT use placeholder emails like "testuser@example.com" or "valid_user@example.com".
- If login/account data is required, use only the configured run account provided by the user prompt for this run.
- Be honest. If the criteria are met, passed=true. If you reproduce a real defect, passed=false. If you cannot reach or confirm the feature, set inconclusive=true (do NOT guess pass/fail).${legacySection}${guideSection}${sectionLockSection}${manualLoginSection}
- When done, call report_result exactly once. Do not keep acting after that.
- Keep tool calls purposeful — you have a limited step budget.`;
}

/**
 * Optional ticket-specific mandatory flow rules injected into the agent prompt.
 * Configure TICKET_FLOW_RULES_FILE with a JSON array: [{ "match": "regex", "rules": ["line 1", "line 2"], "title": "Optional title" }].
 * The regex is tested (case-insensitive) against the ticket key + summary + description + ACs.
 */
function buildTicketSpecificFlowRules(issue: JiraIssue): string {
  const file = process.env.TICKET_FLOW_RULES_FILE?.trim();
  if (!file || !fs.existsSync(file)) return '';
  const corpus = `${issue.key}\n${issue.summary}\n${issue.description}\n${issue.acceptanceCriteria}`;

  let entries: Array<{ match: string; rules: string[]; title?: string }>;
  try {
    entries = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    console.warn(`[Agent] TICKET_FLOW_RULES_FILE is not valid JSON: ${file}`);
    return '';
  }

  return entries
    .filter(e => e?.match && Array.isArray(e.rules) && new RegExp(e.match, 'i').test(corpus))
    .map(e => [e.title ? `${e.title} (do not skip):` : 'Mandatory flow (do not skip):', ...e.rules.map(r => `- ${r}`)].join('\n'))
    .join('\n\n');
}

export interface AgentValidationOutcome {
  verdict: string;
  movedTo?: string;
  blockedReason?: string;
}

/**
 * Core autonomous validation logic — callable from ticket-flow or the CLI.
 * Accepts a pre-fetched JiraIssue (to avoid a double Jira call when invoked
 * from ticket-flow.ts) or a raw ticket key (for standalone use).
 */
export async function runAgentValidation(
  issueOrKey: JiraIssue | string,
  options: {
    maxSteps?: number;
    noTransition?: boolean;
    legacyOracle?: boolean;
    legacyUrl?: string;
    appUrl?: string;
    appEnv?: string;
    publish?: boolean;
  } = {},
): Promise<AgentValidationOutcome> {
  const {
    maxSteps = DEFAULT_MAX_STEPS,
    noTransition = false,
    legacyOracle = DEFAULT_LEGACY_ORACLE,
    legacyUrl = APP_URL_LEGACY,
    appUrl = APP_URL,
    appEnv = APP_ENV,
    publish = true,
  } = options;

  await runPreflightChecks({
    requireCDP: true,
    requireRunAccount: true,
    requireGitHubToken: true,
    autoStartCDP: true,
    throwOnError: true,
  });

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('[Agent] Missing GITHUB_TOKEN in .env (needs a GitHub PAT with the "models: read" permission).');
  }

  const issue = typeof issueOrKey === 'string' ? await getIssue(issueOrKey) : issueOrKey;
  const oracleContext = loadOracleContext(issue);
  const legacyGuide = loadLegacyFlowGuide(issue.key);
  const testrailMatch = legacyGuide && !TESTRAIL_SUPPLEMENTAL_WHEN_MAPPED ? null : findSimilarTestrailCase(issue);
  const runAccount = resolveRunAccount();
  const sectionFlowGuides = matchSectionFlowGuides(issue);
  const sectionFlowRules = renderSectionFlowGuides(sectionFlowGuides);
  const key = issue.key;
  const useLegacyOracle = legacyOracle && !!legacyUrl;
  console.log(`[Agent] ${key}: ${issue.summary}`);
  console.log(`[Agent] Brain candidates: ${resolveModelCandidates().join(', ')}`);
  console.log(`[Agent] Auth account loaded from environment: ${runAccount.email} (${runAccount.audience})`);
  if (legacyOracle && !legacyUrl) {
    console.warn('[Agent] LEGACY_ORACLE is enabled but APP_URL_LEGACY is empty — continuing without legacy oracle.');
  }
  if (useLegacyOracle) {
    console.log(`[Agent] Legacy oracle mode: ON (${legacyUrl})`);
  }
  if (legacyGuide && !TESTRAIL_SUPPLEMENTAL_WHEN_MAPPED) {
    console.log('[Agent] TestRail supplemental auto-match disabled for mapped ticket (TESTRAIL_SUPPLEMENTAL_WHEN_MAPPED=false).');
  }
  if (testrailMatch) {
    console.log(`[Agent] TestRail auto-match: ${testrailMatch.matched.caseId} (score=${testrailMatch.score})`);
  }
  if (sectionFlowGuides.length) {
    const guideIds = sectionFlowGuides.map(match => match.guide.id).join(', ');
    console.log(`[Agent] Section flow guide(s) matched: ${guideIds}`);
  }

  const client = new OpenAI({ baseURL: BASE_URL, apiKey: token, timeout: 90_000, maxRetries: 0 });
  const modelResolution = await resolveGitHubModel(client);
  if (!modelResolution.model) {
    const blockedReason = modelResolution.blockedReason ?? 'No GitHub Models candidate could be used.';
    console.warn(`[Agent] Model resolution blocked: ${blockedReason}`);
    return {
      verdict: 'blocked',
      blockedReason,
    };
  }
  console.log(`[Agent] Brain resolved to: ${modelResolution.model}`);
  const session = await connectBrowser();
  const browser = new AgentBrowser(session.page, key, {
    email: runAccount.email,
    password: runAccount.password,
    totpSecret: runAccount.secretKey,
    audience: runAccount.audience,
  });
  const legacyPage = useLegacyOracle ? await session.context.newPage() : null;
  const legacyBrowser = legacyPage
    ? new AgentBrowser(legacyPage, `${key}-legacy`, {
        email: runAccount.email,
        password: runAccount.password,
        totpSecret: runAccount.secretKey,
        audience: runAccount.audience,
      })
    : null;

  let report: AgentReport | null = null;
  let usedModel = modelResolution.model;
  const recordedSteps: RecordedStep[] = [];
  const ticketSpecificRules = buildTicketSpecificFlowRules(issue);
  let lockedSection: string | null = null;  // Set once we arrive at the section start URL

  try {
    // Pre-open the app so SSO completes once before the agent starts driving.
    await browser.navigate(appUrl);
    recordedSteps.push({ tool: 'browser_navigate', args: { url: appUrl } });
    const sectionStartUrl = resolveSectionGuideStartUrl(sectionFlowGuides, appUrl);
    if (sectionStartUrl && sectionStartUrl !== appUrl) {
      await browser.navigate(sectionStartUrl);
      recordedSteps.push({ tool: 'browser_navigate', args: { url: sectionStartUrl } });
      // Lock the section only if we successfully landed on the app (not on a B2C/auth URL)
      const landedUrl = browser.currentUrl();
      const landedSection = extractSectionFromUrl(landedUrl, appUrl);
      if (landedSection && landedSection !== 'external' && landedSection !== 'unknown' && landedSection !== 'home') {
        lockedSection = landedSection;
      } else {
        // Likely still on auth/B2C — use section from the intended start path instead
        lockedSection = extractSectionFromUrl(sectionStartUrl, appUrl);
        if (lockedSection === 'external' || lockedSection === 'unknown') lockedSection = null;
      }
      console.log(`[Agent] Section guide start URL: ${sectionStartUrl}`);
      if (lockedSection) console.log(`[Agent] Section locked to: [${lockedSection}]`);
      // Brief settle wait — lets page finish its initial API calls so the network
      // monitor's async response handlers complete before we hit the LLM.
      await session.page.waitForTimeout(2_000).catch(() => {});
    }

    const model = modelResolution.model;
    const isManualLogin = /^(1|true|yes)$/i.test(process.env.MANUAL_LOGIN ?? 'false');
    const messages: any[] = [
        { role: 'system', content: buildSystemPrompt({ appUrl, legacyOracle: useLegacyOracle, legacyUrl, guideEnforced: !!legacyGuide || !!testrailMatch || sectionFlowGuides.length > 0, lockedSection, manualLogin: isManualLogin }) },
        {
          role: 'user',
          content:
            `Validate this ticket. You are already on ${appUrl}.\n\n` +
            `Session account: ${runAccount.email} (${isManualLogin ? 'manual' : 'automated'} authentication).\n` +
            `Authentication is handled by the browser layer. Never request, print, or expose passwords, tokens, or MFA secrets in model messages or tool output.\n\n` +
            `Key: ${key}\nType: ${issue.issuetype}\nSummary: ${issue.summary}\n\n` +
            `Description / ACs / repro:\n${issue.description || issue.acceptanceCriteria || '(none)'}\n\n` +
            (ticketSpecificRules
              ? `Ticket-specific mandatory flow:\n${ticketSpecificRules}\n\n`
              : '') +
            (sectionFlowRules
              ? `${sectionFlowRules}\n\n`
              : '') +
            `Workflow expectation: follow the real UI path. Establish store/tenant context first when the app requires it, and execute through the normal navigation flow rather than top global Search.\n\n` +
            (legacyGuide
              ? `Legacy-to-current mapped workflow (authoritative for this ticket):\n${renderLegacyGuide(legacyGuide)}\n\n`
              : '') +
            (legacyGuide?.focusObjective
              ? `Ticket scope lock (mandatory): ${legacyGuide.focusObjective}\n` +
                `Do not fail or block on out-of-scope sections once this objective is validated.\n\n`
              : '') +
            (testrailMatch
              ? `${legacyGuide ? 'Supplemental ' : ''}Auto-matched TestRail legacy oracle:\n${renderTestrailMatch(testrailMatch)}\n\n`
              : '') +
            ((legacyGuide || testrailMatch)
              ? `Execution contract for this run (mandatory):\n` +
                `- Complete the mapped/testrail flow to the target behavior before calling report_result.\n` +
                `- If blocked by an intermediate field, try at least one alternate valid value/path in the same flow and continue.\n` +
                `- Return parityChecks and concrete reproSteps for attempted paths.\n\n`
              : '') +
            (oracleContext.summary
              ? `Grounded source-of-truth excerpts (prefer these when relevant):\n${oracleContext.summary}\n\n`
              : '') +
            (useLegacyOracle
              ? `Legacy oracle URL: ${legacyUrl}\nCompare legacy first, then the current app; return parityChecks + oracleSummary.\n\n`
              : '') +
            `Begin with browser_snapshot.`,
        },
    ];

    let overflowRecoveries = 0;
    let previousSignature = '';
    let repeatedSignature = 0;
    let consecutiveRateErrors = 0;

    const LLM_TIMEOUT_MS = 120_000;

    for (let step = 0; step < maxSteps && !report; step++) {
      let resp;
      let llmStartMs = 0;
      try {
        llmStartMs = Date.now();
        console.log(`[Agent] LLM call starting (step ${step + 1}, model=${model})...`);
        const llmCall = client.chat.completions.create({
          model,
          messages,
          tools: TOOLS,
          tool_choice: 'auto',
          temperature: 0,
        });
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('LLM_TIMEOUT: model call exceeded 2 minutes')), LLM_TIMEOUT_MS)
        );
        resp = await Promise.race([llmCall, timeout]);
        console.log(`[Agent] LLM responded in ${Date.now() - llmStartMs}ms`);
        consecutiveRateErrors = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('LLM_TIMEOUT')) {
          console.warn(`[Agent] LLM call timed out at step ${step + 1}/${maxSteps} — aborting ticket`);
          throw new Error(msg);
        }
        if (msg.includes('Request body too large') || msg.includes('413')) {
          overflowRecoveries++;
          messages.splice(2);
          messages.push({
            role: 'user',
            content:
             'Context was reset due size limit. Continue from the current browser state. ' +
             'Use minimal tool calls and avoid repeated snapshots.',
          });
          console.warn(`[Agent] Context overflow recovered (${overflowRecoveries}) on model ${model}.`);
          continue;
        }
        if (msg.includes('429') || msg.toLowerCase().includes('too many requests') || msg.toLowerCase().includes('rate limit')) {
          consecutiveRateErrors++;
          if (consecutiveRateErrors >= 12) {
            console.warn(`[Agent] ${consecutiveRateErrors} consecutive 429s on ${model} — quota exhausted. Publishing BLOCKED.`);
            throw new Error(`RATE_LIMIT_EXHAUSTED: ${model} hit quota limits. Wait 1h and retry.`);
          }
          const waitSec = 30;
          console.warn(`[Agent] Rate limit (429) hit at step ${step + 1} (${consecutiveRateErrors}× consecutive). Waiting ${waitSec}s before retry...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          step--;
          continue;
        }
        console.error(`[Agent] LLM error after ${Date.now() - llmStartMs}ms: ${msg.slice(0, 200)}`);
        throw err;
      }

      const m = resp.choices[0].message;
      messages.push(m);

        if (!m.tool_calls?.length) {
          messages.push({ role: 'user', content: 'Use tools briefly, then call report_result when you have enough evidence.' });
          continue;
        }

      const signature = m.tool_calls.map((t: any) => t.function?.name).join(',');
      if (signature === previousSignature) repeatedSignature++;
      else repeatedSignature = 0;
      previousSignature = signature;

      let nudge: string | null = null;
      if (repeatedSignature >= 3) {
        nudge =
          'You are repeating the same tool pattern. Stop looping. ' +
          'If evidence is sufficient, call report_result now; otherwise do one targeted snapshot and conclude.';
      }

      if (step >= maxSteps - 3) {
        nudge =
          'Final steps remaining. Prioritize closing: perform at most one targeted check and call report_result.';
      }

      for (const tc of m.tool_calls) {
        const { content, finished, updatedLockedSection } = await dispatch(tc, browser, recordedSteps, legacyBrowser, legacyGuide, testrailMatch, sectionFlowGuides, lockedSection, appUrl);
        if (finished) report = finished;
        if (updatedLockedSection) lockedSection = updatedLockedSection;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: cap(content, TOOL_CONTENT_MAX) });
      }
      if (nudge && !report) {
        messages.push({ role: 'user', content: nudge });
      }
      console.log(`[Agent] step ${step + 1}/${maxSteps} [${model}] — ${m.tool_calls.map((t: any) => t.function?.name).join(', ')}`);
      if (!report) await new Promise(r => setTimeout(r, 1_000));
    }

  } finally {
    // Guarantee at least one screenshot of the final state.
    if (!browser.screenshots.length) await browser.screenshot(`${key}-final`).catch(() => {});
    if (legacyBrowser && !legacyBrowser.screenshots.length) await legacyBrowser.screenshot(`${key}-legacy-final`).catch(() => {});
    if (legacyPage && !legacyPage.isClosed()) {
      await legacyPage.close().catch(() => {});
    }
    await disconnectBrowser(session);
  }

  const result = buildResult(
    key,
    report,
    browser,
    usedModel,
    appEnv,
    appUrl,
    oracleContext.sources,
    legacyGuide,
    testrailMatch,
    {
    legacyOracle: useLegacyOracle,
    legacyUrl,
    legacyBrowser,
  });
  console.log(`\n[Agent] Verdict: ${result.passed ? 'PASS' : result.inconclusive ? 'INCONCLUSIVE' : 'FAIL'} — ${result.summary}`);

  if (!publish) {
    const verdict = result.passed ? 'pass' : result.inconclusive ? 'inconclusive' : 'fail';
    console.log(`[Agent] Publish skipped (discovery mode) — verdict=${verdict}`);
    return { verdict };
  }

  const outcome = await publishResult(issue, result, { env: appEnv, transition: !noTransition });
  console.log(`[Agent] Published — verdict=${outcome.verdict}, attached=${outcome.attached.length}, movedTo=${outcome.movedTo ?? '(none)'}`);

  // On PASS: generate a reusable Playwright script from the recorded steps.
  // Best-effort — a generation failure must never affect the already-published verdict.
  if (outcome.verdict === 'pass' && recordedSteps.length > 0) {
    try {
      const gen = generateScript(key, issue.summary, recordedSteps);
      console.log(`[Agent] Script generated → ${gen.scriptPath} (${recordedSteps.length} steps recorded)`);
    } catch (genErr) {
      console.warn(`[Agent] Script generation failed (non-fatal): ${genErr instanceof Error ? genErr.message : genErr}`);
    }
  }

  return {
    verdict: outcome.verdict,
    movedTo: outcome.movedTo ?? undefined,
    blockedReason: outcome.blockedReason ?? undefined,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const key = args.find(a => /^PROJ-\d+$/i.test(a));
  if (!key) {
    console.log('Usage: npx tsx scripts/agent-validate.ts PROJ-1234 [--max-steps 30] [--no-transition] [--legacy-oracle] [--legacy-url https://...]');
    process.exit(1);
  }
  const maxSteps = Number(args[args.indexOf('--max-steps') + 1]) || 30;
  const noTransition = args.includes('--no-transition');
  const legacyOracle = args.includes('--legacy-oracle');
  const legacyUrl = args.includes('--legacy-url') ? (args[args.indexOf('--legacy-url') + 1] ?? '').trim() : undefined;

  await runAgentValidation(key, { maxSteps, noTransition, legacyOracle, legacyUrl });
}

async function dispatch(
  tc: any,
  browser: AgentBrowser,
  steps: RecordedStep[],
  legacyBrowser?: AgentBrowser | null,
  legacyGuide?: LegacyFlowGuide | null,
  testrailMatch?: TestrailMatch | null,
  sectionFlowGuides: SectionFlowMatch[] = [],
  lockedSection: string | null = null,
  appUrl?: string,
): Promise<{ content: string; finished?: AgentReport; updatedLockedSection?: string | null }> {
  let a: any = {};
  try { a = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { /* leave empty */ }
  const target = resolveTargetBrowser(a, browser, legacyBrowser);
  if (target.error) return { content: target.error };
  const active = target.browser;

  switch (tc.function.name) {
    case 'browser_navigate': {
      const nextUrl = a.url as string | undefined;
      
      // ABSOLUTE section lock: if a locked section is set, block any navigation
      // to a different section. The agent must stay in the locked section and call
      // report_result when done — not wander to other areas of the app.
      if (lockedSection && sectionFlowGuides.length > 0 && !target.isLegacy && nextUrl) {
        const currentUrl = active.currentUrl();
        const targetSection = extractSectionFromUrl(nextUrl, appUrl);
        
        // Allow navigation within the same section, to app root, or external URLs (like auth)
        const isWithinSection = !isSectionChange(currentUrl, nextUrl) || targetSection === 'home' || targetSection === 'unknown' || targetSection === 'external';
        if (!isWithinSection) {
          return {
            content: `SECTION LOCK [${lockedSection}]: Navigation to [${targetSection}] is BLOCKED. You must complete the [${lockedSection}] flow and call report_result from that section. If the feature is broken or inaccessible, include that as evidence in your report_result.`,
            updatedLockedSection: lockedSection,
          };
        }
      }
      
      if (!target.isLegacy) steps.push({ tool: 'browser_navigate', args: { url: a.url } });
      return { content: await active.navigate(a.url), updatedLockedSection: lockedSection };
    }
    case 'browser_click': {
      if (!target.isLegacy) steps.push({ tool: 'browser_click', args: a });
      const clickResult = await active.click(a);
      
      // Post-click section drift detection with AUTO-RECOVERY
      // After any click, if the page drifted to a different section, immediately
      // navigate back to the locked section before returning the error message.
      if (lockedSection && sectionFlowGuides.length > 0 && !target.isLegacy) {
        const urlAfterClick = active.currentUrl();
        const sectionAfterClick = extractSectionFromUrl(urlAfterClick, appUrl);
        if (sectionAfterClick !== lockedSection && sectionAfterClick !== 'unknown' && sectionAfterClick !== 'home' && sectionAfterClick !== 'external') {
          // Auto-recover: navigate back to the locked section
          const recoveryUrl = resolveSectionGuideStartUrl(sectionFlowGuides, urlAfterClick);
          if (recoveryUrl) {
            await active.navigate(recoveryUrl);
            console.log(`[SectionLock] Auto-recovered from [${sectionAfterClick}] back to [${lockedSection}]`);
          }
          return {
            content: `SECTION LOCK [${lockedSection}]: Your click navigated to [${sectionAfterClick}]. ` +
              `AUTO-RECOVERED: you are back at [${lockedSection}]. ` +
              `Do NOT click sidebar navigation links. Complete the [${lockedSection}] flow and call report_result.`,
            updatedLockedSection: lockedSection,
          };
        }
      }
      
      return { content: clickResult, updatedLockedSection: lockedSection };
    }
    case 'browser_fill': {
      // Guardrail: block login field fills when MANUAL_LOGIN is active
      const isManualLogin = /^(1|true|yes)$/i.test(process.env.MANUAL_LOGIN ?? 'false');
      if (isManualLogin && !target.isLegacy) {
        const fieldId = (a.label ?? a.placeholder ?? a.name ?? '').toLowerCase();
        const isLoginField = /email|password|passwd|otp|totp|mfa|code|sign.?in|signin/.test(fieldId);
        if (isLoginField) {
          const currentUrl = active.currentUrl();
          console.warn(`[ManualLogin] Blocked fill on login field "${fieldId}" at ${currentUrl.slice(0, 60)}`);
          return {
            content: `MANUAL LOGIN MODE: filling login fields is blocked. Authentication is externally managed. ` +
              `If you see a login screen, navigate back to ${appUrl} to recover the session instead.`,
            updatedLockedSection: lockedSection,
          };
        }
      }
      if (!target.isLegacy) steps.push({ tool: 'browser_fill', args: a });
      return { content: await active.fill(a), updatedLockedSection: lockedSection };
    }
    case 'browser_select':
      if (!target.isLegacy) steps.push({ tool: 'browser_select', args: a });
      return { content: await active.select(a), updatedLockedSection: lockedSection };
    // Read-only — don't record:
    case 'browser_snapshot':    return { content: await active.snapshot(), updatedLockedSection: lockedSection };
    case 'browser_screenshot':  return { content: await active.screenshot(a.name ?? 'state'), updatedLockedSection: lockedSection };
    case 'browser_get_console': return { content: active.getConsole(), updatedLockedSection: lockedSection };
    case 'browser_get_network': return { content: active.getNetwork(), updatedLockedSection: lockedSection };
    case 'report_result': {
      const report = a as AgentReport;
      const currentUrl = active.currentUrl();
      const gate = validateGuideCompletion(
        report,
        legacyGuide ?? null,
        testrailMatch ?? null,
        sectionFlowGuides,
        { currentUrl, isLikelyAuthenticated: isLikelyAuthenticatedUrl(currentUrl), appUrl },
      );
      if (gate) {
        console.log(`[Gate] report_result BLOCKED: ${gate}`);
        return { content: gate, updatedLockedSection: lockedSection };
      }
      return { content: 'Verdict recorded.', finished: report, updatedLockedSection: lockedSection };
    }
    default:                    return { content: `Unknown tool: ${tc.function.name}`, updatedLockedSection: lockedSection };
  }
}

function validateGuideCompletion(
  report: AgentReport,
  legacyGuide: LegacyFlowGuide | null,
  testrailMatch: TestrailMatch | null,
  sectionFlowGuides: SectionFlowMatch[],
  context: { currentUrl: string; isLikelyAuthenticated: boolean; appUrl?: string },
): string | null {
  // parityChecks are only required when the legacy oracle is active (legacyGuide is set).
  // A TestRail match alone provides flow guidance but does not imply a legacy parity run.
  const requiresParity = !!legacyGuide;
  const hasFlowGuide = !!legacyGuide || !!testrailMatch;

  if (requiresParity) {
    const parityCount = report.parityChecks?.length ?? 0;
    if (parityCount === 0) {
      return 'Guide enforcement: include parityChecks comparing legacy vs current before calling report_result.';
    }
  }

  if (hasFlowGuide) {
    // When a section flow guide is present, it handles coverage verification.
    // Skip the TestRail checkpoint gate to avoid double-gating.
    if (sectionFlowGuides.length === 0) {
      const evidenceText = collectReportText(report);
      const checkpoints = collectGuideCheckpoints(legacyGuide, testrailMatch);
      const requiredHits = Math.min(2, checkpoints.length);
      const checkpointHits = checkpoints.filter(c => matchesCheckpoint(evidenceText, c)).length;
      if (requiredHits > 0 && checkpointHits < requiredHits) {
        return `Guide enforcement: mapped/TestRail flow coverage is insufficient (${checkpointHits}/${requiredHits} checkpoints detected). Continue the guided flow and try an alternate valid path if blocked.`;
      }
    }
  }

  const sectionGate = validateSectionGuideCompletion(report, sectionFlowGuides, context);
  if (sectionGate) return sectionGate;

  const reproCount = report.reproSteps?.length ?? 0;
  // FAIL verdicts (feature is broken): require at least 1 repro step — screenshots already captured.
  // INCONCLUSIVE verdicts: require at least 2 repro steps so we document what was attempted.
  if (report.inconclusive && reproCount < 2) {
    return 'Guide enforcement: for INCONCLUSIVE include at least 2 reproSteps documenting what was attempted before report_result.';
  }
  if (!report.passed && !report.inconclusive && reproCount < 1) {
    return 'Guide enforcement: for FAIL include at least 1 reproStep describing what triggered the failure before report_result.';
  }
  return null;
}

function validateSectionGuideCompletion(
  report: AgentReport,
  sectionFlowGuides: SectionFlowMatch[],
  context: { currentUrl: string; isLikelyAuthenticated: boolean; appUrl?: string },
): string | null {
  if (!sectionFlowGuides.length) return null;

  if (context.isLikelyAuthenticated && reportsLoginFailure(report)) {
    return `Guide enforcement: login failure is inconsistent with authenticated state (URL: ${context.currentUrl}). Continue ticket flow and report the actual feature failure.`;
  }

  // Check if the agent is in a different section than expected
  const currentSection = extractSectionFromUrl(context.currentUrl, context.appUrl);
  const expectedSection = sectionFlowGuides[0]?.guide.sectionId ?? sectionFlowGuides[0]?.guide.id;
  // Allow partial matches: guide ID "section-sub-flow" should match URL segment "section"
  const sectionMatches = !expectedSection || currentSection === expectedSection
    || expectedSection.startsWith(currentSection)
    || currentSection.startsWith(expectedSection.split('-').slice(0, 2).join('-'));
  if (!sectionMatches && currentSection !== 'unknown' && currentSection !== 'home' && currentSection !== 'external') {
    // If the agent has completed required checks, allow the report even from a different section
    // Otherwise, suggest returning to the correct section
    const requiredChecks = sectionFlowGuides.flatMap(match => match.guide.requiredChecks ?? []);
    if (requiredChecks.length > 0) {
      const evidenceText = collectReportText(report);
      const checkHits = requiredChecks.filter(c => matchesCheckpoint(evidenceText, c)).length;
      if (checkHits < 1) {
        // Very few checks completed; suggest going back to the correct section
        return `Note: you are currently in [${currentSection}], but the ticket is about [${expectedSection}]. Return to the [${expectedSection}] section and complete at least one required check before reporting.`;
      }
    }
  }

  const requiredChecks = sectionFlowGuides.flatMap(match => match.guide.requiredChecks ?? []);
  if (!requiredChecks.length) return null;

  const evidenceText = collectReportText(report);
  // PASS: require 2 checkpoint hits to ensure thorough coverage was attempted.
  // FAIL/INCONCLUSIVE: require only 1 hit — defensive verdicts should not be over-gated.
  const requiredHits = report.passed ? Math.min(2, requiredChecks.length) : 1;
  const checkHits = requiredChecks.filter(c => matchesCheckpoint(evidenceText, c)).length;
  if (checkHits < requiredHits) {
    return `Guide enforcement: section flow checks are incomplete (${checkHits}/${requiredHits} required checkpoints detected). Validate required checks before report_result.`;
  }
  return null;
}

function collectReportText(report: AgentReport): string {
  const parts: string[] = [
    report.summary,
    ...(report.acChecks ?? []).flatMap(c => [c.description, c.expected, c.observed]),
    ...(report.parityChecks ?? []).flatMap(c => [c.scenario, c.legacyObserved, c.currentObserved, c.notes ?? '']),
    ...(report.reproSteps ?? []),
    ...(report.notValidated ?? []),
  ];
  return normalizeText(parts.join('\n'));
}

function collectGuideCheckpoints(legacyGuide: LegacyFlowGuide | null, testrailMatch: TestrailMatch | null): string[] {
  const candidates = [
    legacyGuide?.title ?? '',
    ...(legacyGuide?.parityExpectations ?? []).slice(0, 2),
    ...(legacyGuide?.currentWorkflowHints ?? []).slice(0, 2),
    testrailMatch?.matched.title ?? '',
    ...(testrailMatch?.matched.steps ?? []).slice(0, 2),
    ...(testrailMatch?.matched.expected ?? []).slice(0, 1),
  ]
    .map(v => v.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of candidates) {
    const n = normalizeText(c);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    unique.push(c);
  }
  return unique;
}

function matchesCheckpoint(evidenceText: string, checkpoint: string): boolean {
  const words = tokenize(checkpoint);
  if (!words.length) return false;
  const hits = words.filter(w => evidenceText.includes(w)).length;
  return hits >= Math.min(2, words.length);
}

function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(' ')
    .map(v => v.trim())
    .filter(v => v.length >= 4 && !GUIDE_STOPWORDS.has(v));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const GUIDE_STOPWORDS = new Set([
  'with', 'from', 'that', 'this', 'there', 'where', 'when', 'then', 'into', 'only', 'have', 'has', 'been',
  'were', 'will', 'would', 'could', 'about', 'your', 'them', 'they', 'what', 'which', 'while', 'after',
  'before', 'under', 'over', 'very', 'more', 'some', 'should', 'select', 'click', 'field', 'button',
  'flow', 'step', 'legacy', 'current', 'mapped', 'guide', 'oracle',
]);

function cap(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…[truncated]` : value;
}

function reportsLoginFailure(report: AgentReport): boolean {
  const corpus = collectReportText(report);
  return /(login|sign in|signin|authentication|authenticated|mfa).{0,24}(fail|error|unable|cannot|blocked|issue)|\bfailed login\b/.test(corpus);
}

function isLikelyAuthenticatedUrl(rawUrl: string): boolean {
  const host = safeHostname(rawUrl);
  if (!host) return false;
  if (host.includes('b2clogin.com') || host.includes('microsoftonline.com')) return false;
  return host.includes(new URL(APP_URL).hostname);
}

function safeHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '';
  }
}

function buildResult(
  key: string,
  report: AgentReport | null,
  browser: AgentBrowser,
  usedModel: string,
  appEnv: string,
  appUrl: string,
  oracleSources: string[],
  legacyGuide: ReturnType<typeof loadLegacyFlowGuide>,
  testrailMatch: TestrailMatch | null,
  opts: { legacyOracle: boolean; legacyUrl?: string; legacyBrowser?: AgentBrowser | null },
): ValidationResult {
  const hasParityEvidence = !opts.legacyOracle || !!report?.parityChecks?.length;
  const forcedInconclusive = opts.legacyOracle && !hasParityEvidence;
  const inconclusive = report ? !!report.inconclusive || forcedInconclusive : true;
  const passed = report ? !!report.passed && !inconclusive : false;

  const acChecks: AcCheck[] = (report?.acChecks ?? []).map(c => ({
    id: c.id,
    description: c.description,
    expected: c.expected,
    observed: c.observed,
    passed: !!c.passed,
    status: c.passed ? 'pass' : inconclusive ? 'inconclusive' : 'fail',
  }));

  const parityDetails = (report?.parityChecks ?? []).map(p =>
    `${p.id ? `${p.id} ` : ''}${p.scenario}: LEGACY="${p.legacyObserved}" vs CURRENT="${p.currentObserved}" => ${p.matches ? 'MATCH' : 'MISMATCH'}${p.notes ? ` (${p.notes})` : ''}`
  );
  const parityMismatches = (report?.parityChecks ?? []).filter(p => !p.matches).length;
  const notValidated = [...(report?.notValidated ?? [])];
  if (forcedInconclusive) {
    notValidated.push('Legacy oracle comparison was required but parity evidence was not provided.');
  }

  return {
    passed,
    inconclusive,
    summary: report?.summary ?? (opts.legacyOracle
      ? 'Agent did not complete legacy parity evidence within the step budget — inconclusive.'
      : 'Agent did not reach a verdict within the step budget — inconclusive.'),
    details: parityDetails,
    screenshots: [...browser.screenshots, ...(opts.legacyBrowser?.screenshots ?? [])],
    networkLogPath: browser.hasNetworkErrors() ? browser.saveNetworkLog() : null,
    consoleErrors: [...browser.consoleErrors, ...(opts.legacyBrowser?.consoleErrors.map(e => `[legacy] ${e}`) ?? [])],
    acChecks,
    notValidated: notValidated.length ? notValidated : undefined,
    environment: `${appEnv} — ${new URL(appUrl).hostname}`,
    method: opts.legacyOracle
      ? `Autonomous agent — GitHub Models (${usedModel}) + Playwright over shared Edge (CDP) + legacy-oracle parity`
      : `Autonomous agent — GitHub Models (${usedModel}) + Playwright over shared Edge (CDP)`,
    testData: {
      ...(report?.testData ?? {}),
      ...(opts.legacyOracle ? {
        oracle: 'legacy-parity',
        legacyUrl: opts.legacyUrl ?? '',
        parityMismatches: String(parityMismatches),
        oracleSummary: report?.oracleSummary ?? (hasParityEvidence ? 'Parity evidence collected.' : 'Parity evidence missing.'),
      } : {}),
      ...(oracleSources.length ? {
        oracleSources: oracleSources.join('; '),
        oracleGrounding: 'wiki-docs',
      } : {}),
      ...(legacyGuide ? {
        testrailCaseId: legacyGuide.testrailCaseId ?? '',
        legacyFlowTitle: legacyGuide.title,
      } : {}),
      ...(testrailMatch ? {
        ...(legacyGuide
          ? {
              autoMatchedTestrailCaseId: testrailMatch.matched.caseId,
              autoMatchedTestrailCaseTitle: testrailMatch.matched.title,
              autoMatchedTestrailMatchScore: String(testrailMatch.score),
            }
          : {
              testrailCaseId: testrailMatch.matched.caseId,
              testrailCaseTitle: testrailMatch.matched.title,
              testrailMatchScore: String(testrailMatch.score),
            }),
      } : {}),
    },
    reproSteps: report?.reproSteps,
    networkCalls: browser.networkErrors(),
  };
}

function resolveTargetBrowser(
  args: Record<string, unknown>,
  browser: AgentBrowser,
  legacyBrowser?: AgentBrowser | null,
): { browser: AgentBrowser; isLegacy: boolean; error?: string } {
  const target = String(args.target ?? 'current').toLowerCase();
  if (target === 'legacy') {
    if (!legacyBrowser) {
      return {
        browser,
        isLegacy: true,
        error: 'Legacy target requested but legacy-oracle mode is not enabled for this run.',
      };
    }
    return { browser: legacyBrowser, isLegacy: true };
  }
  return { browser, isLegacy: false };
}

const invokedPath = process.argv[1] ?? '';
if (/(^|[\\/])agent-validate\.(ts|js)$/i.test(invokedPath)) {
  main().catch(err => {
    console.error('[Agent] Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
