const LINES = [
  'cadre - the model-agnostic harness (experiment; wraps ax + Apertus)',
  '',
  '  cadre go "<outcome>"     the one command - scan the room, form the crew, run',
  '                           plan/build/critique/verify, gate on evidence',
  '    --dry                    routing + pipeline only, spends nothing',
  '    --impl <ax-lane>         pin the builder lane',
  '    --budget <tokens>        cap metered spend for this run',
  '    --context <file>         attach a file as context for ax build',
  '    --override               skip the ax plan gate',
  '  cadre lanes [--json]     live roster: ax registry + env-keyed APIs + yours',
  '  cadre parity "<outcome>" --ref <path|id>',
  '                           build to parity against a cited reference (ax build)',
  '  cadre plan "<task>"      real routing + spend estimate for a task',
  '  cadre meter              real usage from run records (tokens, per lane)',
  '  cadre sweep [--all]      triage leftover runs: resume-mark or retire',
  '  cadre map [--why <sym>]  index this repo (symbols, imports, hot zones)',
  '  cadre proof <run-id>     evidence bundle of a run (local run or ax run id)',
  '  cadre watch <run-id>     tail a run log live until it settles',
  '  cadre debate "<q>"       two ax lanes argue; transcripts cited',
  '  cadre pin [...]          pin roles / budget in $CADRE_HOME/pins.json',
  '  cadre mcp                MCP server on stdio (tools: lanes, plan, map, proof, meter)',
  '',
  'state: $CADRE_HOME (default ~/.cadre) · runs, pins, meters, maps, audit.log',
  'apertus: export APERTUS_API_KEY (optionally APERTUS_BASE_URL) to enable',
];

export function cmdHelp() {
  console.log(LINES.join('\n'));
}
