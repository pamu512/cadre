// taskclass - classify a brief into a task class so routing can honor the
// contract "deterministic work goes to cheap or local lanes; judgment goes to
// frontier models". Classification is keyword-driven and STATED, never guessed
// silently: the caller prints what class was picked and why.
//
// Classes:
//   deterministic - mechanical, verifiable-by-command work: file creation,
//                   formatting, lint fixes, renames, fixture writing, builds.
//                   A cheap/local lane that passes the gate is the right owner.
//   judgment      - work whose quality is decided by reasoning: design,
//                   architecture, review, tradeoff calls, prose.
//                   Capability outweighs cost; frontier lanes earn their keep.
//   mixed         - both signals present; deterministic gets cost priority on
//                   the builder role, judgment quality on planner/critic.

const DET_MARKERS = /\b(create|write|generate|format|lint|rename|move|copy|fix\s+tests?|update\s+(deps|imports|versions?)|scaffold|bootstrap|fixture|boilerplate|repetitive|bulk|mechanical|template|convert|migrate\s+imports?)\b/i;
const JUDGMENT_MARKERS = /\b(design|architect|decide|review|analy[sz]e|tradeoff|trade-off|strategy|refactor\s+(the\s+)?architecture|evaluate|judge|critique|plan\s+the\s+approach|choose|recommend|reason(ing)?|risk)\b/i;

export function classifyTask(brief) {
  const text = String(brief || '');
  const det = DET_MARKERS.test(text);
  const jud = JUDGMENT_MARKERS.test(text);
  if (det && !jud) {
    return { class: 'deterministic', why: 'mechanical/verifiable verbs (create, format, fix tests…)', costPriority: 'free-first' };
  }
  if (jud && !det) {
    return { class: 'judgment', why: 'reasoning verbs (design, review, decide…)', costPriority: 'capability-first' };
  }
  if (det && jud) {
    return { class: 'mixed', why: 'both mechanical and reasoning signals', costPriority: 'role-dependent' };
  }
  return { class: 'unclassified', why: 'no strong signal - default routing applies', costPriority: 'default' };
}

// Role-aware policy: which cost priority applies for THIS role under THIS class
export function costPolicyFor(taskClass, role) {
  const c = typeof taskClass === 'string' ? taskClass : taskClass?.class;
  if (c === 'deterministic') return 'free-first';           // any role: cheap wins ties harder
  if (c === 'judgment') return 'capability-first';           // any role: capability wins
  if (c === 'mixed') {
    if (role === 'planner' || role === 'critic') return 'capability-first';
    if (role === 'builder' || role === 'verifier') return 'free-first';
    return 'default';
  }
  return 'default';
}
