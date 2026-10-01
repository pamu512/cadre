// Minimal draft-2020-12 subset validator for the lane contract.
// Zero dependencies on purpose — the harness should be a single binary you can read.
import { readFileSync } from 'node:fs';

export function validateLane(lane) {
  const errors = [];
  const fail = (path, msg) => errors.push(`${path}: ${msg}`);

  if (typeof lane !== 'object' || lane === null || Array.isArray(lane)) {
    return { valid: false, errors: ['lane: must be an object'] };
  }

  // required
  for (const key of ['name', 'good_at', 'cost', 'talks', 'proves']) {
    if (!(key in lane)) fail(key, 'required');
  }

  // name
  if ('name' in lane) {
    if (typeof lane.name !== 'string') fail('name', 'must be a string');
    else if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(lane.name)) {
      fail('name', 'must be kebab-case, ≤39 chars, start alphanumeric');
    }
  }

  // identity
  if ('identity' in lane && typeof lane.identity !== 'string') fail('identity', 'must be a string');

  // good_at
  if ('good_at' in lane) {
    if (!Array.isArray(lane.good_at)) fail('good_at', 'must be an array');
    else {
      if (lane.good_at.length < 1) fail('good_at', 'must have ≥1 item');
      lane.good_at.forEach((g, i) => {
        if (typeof g !== 'string' || g.length < 1) fail(`good_at[${i}]`, 'must be a non-empty string');
      });
    }
  }

  // cost
  const COST = ['free', 'metered', 'plan', 'rollover', 'coffee'];
  if ('cost' in lane && !COST.includes(lane.cost)) fail('cost', `must be one of ${COST.join(', ')}`);

  // talks
  const TALKS = ['terminal', 'http', 'stdin', 'chat'];
  if ('talks' in lane && !TALKS.includes(lane.talks)) fail('talks', `must be one of ${TALKS.join(', ')}`);

  // proves
  const PROVES = ['diffs', 'test-output', 'commands', 'artifacts', 'citations', 'verdict'];
  if ('proves' in lane && !PROVES.includes(lane.proves)) fail('proves', `must be one of ${PROVES.join(', ')}`);

  // craft
  if ('craft' in lane) {
    if (!Array.isArray(lane.craft)) fail('craft', 'must be an array');
    else lane.craft.forEach((c, i) => {
      if (typeof c !== 'string') fail(`craft[${i}]`, 'must be a string');
    });
  }

  // invoke
  if ('invoke' in lane && (typeof lane.invoke !== 'object' || lane.invoke === null || Array.isArray(lane.invoke))) {
    fail('invoke', 'must be an object');
  }

  // additionalProperties: false — reject unknown keys
  const KNOWN = new Set(['name', 'identity', 'good_at', 'cost', 'talks', 'proves', 'craft', 'invoke']);
  for (const key of Object.keys(lane)) {
    if (!KNOWN.has(key)) fail(key, 'unknown property (contract is closed)');
  }

  return { valid: errors.length === 0, errors };
}

export function loadLane(path) {
  const raw = readFileSync(path, 'utf-8');
  const lane = JSON.parse(raw);
  const result = validateLane(lane);
  if (!result.valid) {
    throw new Error(`invalid lane ${path}:\n  ${result.errors.join('\n  ')}`);
  }
  return lane;
}
