import fs from 'node:fs';
import path from 'node:path';

export interface LegacyFlowGuide {
  ticketKey: string;
  testrailCaseId?: string;
  title: string;
  legacyUrl?: string;
  legacySteps: string[];
  currentWorkflowHints: string[];
  parityExpectations?: string[];
  focusObjective?: string;
  stopAfterSection?: string;
  outOfScope?: string[];
}

interface LegacyFlowMapFile {
  entries: LegacyFlowGuide[];
}

const DEFAULT_MAP_PATH = path.resolve(process.cwd(), 'wiki', 'docs', 'legacy-flow-map.json');

export function loadLegacyFlowGuide(ticketKey: string): LegacyFlowGuide | null {
  const mapPath = process.env.LEGACY_FLOW_MAP_FILE?.trim() || DEFAULT_MAP_PATH;
  if (!fs.existsSync(mapPath)) return null;

  let parsed: LegacyFlowMapFile;
  try {
    parsed = JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as LegacyFlowMapFile;
  } catch {
    return null;
  }

  const key = ticketKey.trim().toUpperCase();
  const entry = (parsed.entries ?? []).find(e => e.ticketKey.trim().toUpperCase() === key);
  if (!entry) return null;

  return {
    ...entry,
    ticketKey: key,
    legacySteps: entry.legacySteps ?? [],
    currentWorkflowHints: entry.currentWorkflowHints ?? [],
    parityExpectations: entry.parityExpectations ?? [],
  };
}

export function renderLegacyGuide(guide: LegacyFlowGuide): string {
  const lines: string[] = [];
  lines.push(`Mapped legacy test flow for ${guide.ticketKey}: ${guide.title}`);
  if (guide.testrailCaseId) lines.push(`TestRail case: ${guide.testrailCaseId}`);
  if (guide.legacyUrl) lines.push(`Legacy URL: ${guide.legacyUrl}`);
  if (guide.legacySteps.length) {
    lines.push('Legacy reference steps:');
    lines.push(...guide.legacySteps.map((s, i) => `${i + 1}. ${s}`));
  }
  if (guide.currentWorkflowHints.length) {
    lines.push('Current-app equivalent workflow hints:');
    lines.push(...guide.currentWorkflowHints.map((s, i) => `${i + 1}. ${s}`));
  }
  if (guide.parityExpectations?.length) {
    lines.push('Parity expectations:');
    lines.push(...guide.parityExpectations.map((s, i) => `${i + 1}. ${s}`));
  }
  if (guide.focusObjective) {
    lines.push(`Focus objective: ${guide.focusObjective}`);
  }
  if (guide.stopAfterSection) {
    lines.push(`Stop condition: once "${guide.stopAfterSection}" is validated, conclude the ticket without continuing to downstream sections.`);
  }
  if (guide.outOfScope?.length) {
    lines.push('Out of scope for this ticket:');
    lines.push(...guide.outOfScope.map((s, i) => `${i + 1}. ${s}`));
  }
  lines.push('Use this mapping as the execution guide. Do not improvise alternate paths unless the mapped path is blocked.');
  return lines.join('\n');
}
