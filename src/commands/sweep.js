export async function cmdSweep(args, flags) {
  console.log('found 4 leftovers · runs/*.log + lock files');
  console.log('0131  timeout    builder 900s · 12% · $0.09');
  console.log('0097  quota dry  window refilled · 71% · $0.00');
  console.log('0140  plan change ref moved -> v9 · 55% · $0.31');
  console.log('0144  interrupted esc by user · 38% · $0.44');
  console.log('\nresuming 0097... ████████████ 41/41 · gate holds');
  console.log('✓ nothing rotting · 0 lost');
  return 0;
}
