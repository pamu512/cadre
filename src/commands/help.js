const LINES = [
  'cadre — the model-agnostic harness (experiment; wraps ax)',
  '',
  '  cadre go "<outcome>"     the one command — musters the crew, runs the loop,',
  '                           gates on evidence (wraps ax build)',
  '  cadre lanes              who\'s here, what they\'re good at, what they cost',
  '',
  'planned (contract exists, organ not wired yet):',
  '  cadre parity "match X" --ref   build to parity, unattended, cited',
  '  cadre plan "task"              the spend planner — bench before you build',
  '  cadre meter                    windows, quotas, rollover, resets',
  '  cadre sweep                    resume or retire the leftovers',
  '  cadre map                      the living codebase graph',
  '  cadre watch [run]              attach to a live run',
  '  cadre proof [run]              the evidence bundle',
  '  cadre debate "q"               two lanes argue, citations checked',
  '  cadre pin                      optional: pin roles, cap spend',
  '  cadre mcp                      run cadre inside your editor\'s chat',
  '',
  'flags: --dry (plan without spending) · --json (lanes) · --impl lane · --override',
];

export function cmdHelp() {
  console.log(LINES.join('\n'));
}
