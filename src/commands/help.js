const LINES = [
  'cadre - the model-agnostic harness (experiment; wraps ax + Apertus)',
  '',
  '  cadre go "<outcome>"     the one command - scan the room, form the crew, run',
  '                           plan/build/critique/verify, gate on evidence',
  '    --dry                    routing + pipeline only, spends nothing',
  '    --impl <ax-lane>         pin the builder lane',
  '    --budget <tokens>        cap metered spend for this run',
  '    --scope <glob>           scope lock: diff outside it = run rejected',
  '    --context <file>         attach a file as context for ax build',
  '    --override               skip the ax plan gate / quiet hours',
  '  cadre lanes [--json]     live roster: ax registry + env-keyed APIs + yours',
  '  cadre parity "<outcome>" --ref <path|id>',
  '                           build to parity against a cited reference (ax build)',
  '  cadre plan "<task>"      routing + spend estimate + bench ranking from history',
  '  cadre meter [--set ...]  entitlement ledger: quotas, resets, pacing, real burn',
  '                           --set lane=L --quota N --reset ISO [--rail official]',
  '  cadre sweep [--all]      triage leftovers: evidence snapshot, retire or resume',
  '  cadre map [--why <sym>]  index this repo (symbols, imports, hot zones)',
  '  cadre proof <run-id>     evidence bundle; --verify re-runs commands vs reality',
  '  cadre watch <run-id>     tail a run log live; --replay prints the settled log',
  '  cadre debate "<q>"       two ax lanes argue; transcripts cited',
  '  cadre pin [...]          --role <r>=<l> · --budget <tok> · --quiet HH:MM-HH:MM',
  '  cadre mcp                MCP server on stdio (tools: lanes, plan, map, proof, meter)',
  '',
  'state: $CADRE_HOME (default ~/.cadre) · runs (with locks), pins, meters, maps, audit.log',
  'apertus: export APERTUS_API_KEY (optionally APERTUS_BASE_URL) to enable',
];

export function cmdHelp() {
  console.log(LINES.join('\n'));
}
