export async function cmdPin(args, flags) {
  if (args.length === 0) {
    console.log('pins · the only config that exists');
    console.log('builder = claude-code');
    console.log('planner = glm-5.3');
    console.log('critic = gpt-5.2');
    return 0;
  }
  console.log(`updating pin: ${args.join(' ')}`);
  return 0;
}
