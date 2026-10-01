export async function cmdWatch(args, flags) {
  const runId = args[0];
  if (!runId) {
    console.log('cadre watch [run-id] — attach to a live run');
    return 0;
  }
  console.log(`attaching to run ${runId}...`);
  console.log('listening for evidence events... [Ctrl+C to detach]');
  return 0;
}
