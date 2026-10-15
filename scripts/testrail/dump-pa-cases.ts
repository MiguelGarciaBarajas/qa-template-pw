import 'dotenv/config';
import fs from 'node:fs';
import axios from 'axios';

const TR = (process.env.TESTRAIL_BASE_URL ?? '').replace(/\/$/, '');
const auth = Buffer.from(
  `${process.env.TESTRAIL_USERNAME ?? ''}:${process.env.TESTRAIL_API_KEY ?? ''}`
).toString('base64');
const tr = axios.create({
  baseURL: `${TR}/index.php?/api/v2`,
  headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }
});

const PROJECT = Number(process.argv[2] ?? process.env.TESTRAIL_PROJECT_ID ?? 0);
const SUITE = Number(process.argv[3] ?? process.env.TESTRAIL_SUITE_ID ?? 0);

async function main() {
  const sectionsRes = await tr.get(`/get_sections/${PROJECT}&suite_id=${SUITE}`);
  const sections = sectionsRes.data.sections ?? sectionsRes.data;
  const sectionName = new Map<number, string>();
  for (const s of sections) sectionName.set(s.id, s.name);

  const cases: any[] = [];
  let offset = 0;
  for (;;) {
    const res = await tr.get(`/get_cases/${PROJECT}&suite_id=${SUITE}&limit=250&offset=${offset}`);
    const chunk = res.data.cases ?? res.data;
    cases.push(...chunk);
    if (chunk.length < 250) break;
    offset += 250;
  }

  const out = cases.map((c) => ({
    caseId: `C${c.id}`,
    section: sectionName.get(c.section_id) ?? String(c.section_id),
    title: c.title
  }));
  fs.writeFileSync('testrail-pa-cases.json', JSON.stringify(out, null, 2));
  console.log(`sections=${sections.length} cases=${out.length}`);
  const bySection = new Map<string, number>();
  for (const c of out) bySection.set(c.section, (bySection.get(c.section) ?? 0) + 1);
  for (const [k, v] of bySection) console.log(`  ${k}: ${v}`);
}

main().catch((e) => {
  console.error('ERROR', e.response?.status, e.response?.data ?? e.message);
  process.exit(1);
});
