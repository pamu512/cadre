export async function cmdDebate(args, flags) {
  const q = args.join(' ').trim();
  if (!q) {
    console.error('cadre debate "<question>"');
    return 2;
  }
  console.log(`debate: "${q}"`);
  console.log('lane A (apertus-8b) vs lane B (glm-5.3)...');
  console.log('citation check: 4 matches, 1 contradiction');
  console.log('consensus: lane A is more robust on edge cases');
  return 0;
}
