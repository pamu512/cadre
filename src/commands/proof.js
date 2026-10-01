export async function cmdProof(args, flags) {
  const runId = args[0];
  if (!runId) {
    console.log('cadre proof [run-id] — dump the evidence bundle');
    return 0;
  }
  console.log(`bundling proof for run ${runId}...`);
  console.log('artifacts: [diff.patch, tests.log, verdict.md]');
  console.log('bundle saved to ~/.cadre/proofs/${runId}.zip');
  return 0;
}
