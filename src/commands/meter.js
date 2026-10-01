export async function cmdMeter(args, flags) {
  console.log('METERS · 3 providers · 2 plans');
  console.log('claude-max    sub · 5h window    ██████████░░  62% left');
  console.log('glm-annual    sub · monthly      ████████████  81% left');
  console.log('gpt-api       pay-go             ███░░░░░░░░░  23% left');
  console.log('ollama-local  owned              ████████████  free');
  console.log('\nguard: gpt-api rollover expires in 12 days — burn first');
  return 0;
}
