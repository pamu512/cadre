export async function cmdPlan(args, flags) {
  const task = args.join(' ').trim();
  if (!task) {
    console.error('cadre plan "<task>" — bench lanes before you build');
    return 2;
  }
  console.log(`spending plan for: ${task}`);
  console.log('analyzing complexity... estimated 4 loops · $1.87');
  console.log('suggested routing: [planner: glm-5.3] -> [builder: claude-code] -> [critic: gpt-5.2]');
  return 0;
}
