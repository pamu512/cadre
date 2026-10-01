# Hack Apertus with Cadre

This guide demonstrates how to use Cadre with Apertus models to achieve evidence-backed outcomes.

## Setting Up Apertus Lanes

Apertus lanes are defined as JSON files in `~/.cadre/lanes/`. 
Example: `apertus-8b.json`.

## The Workflow

1. **Plan**: Use `cadre plan "my task"` to estimate the cost and suggest the best Apertus lane (8B for speed, 70B for reasoning).
2. **Execute**: Run `cadre go "implement feature X"`. This triggers the `ax build` pipeline.
3. **Verify**: Check the evidence gate output. If it's `APPROVE`, the task is done.

## Evidence Proof

Run `cadre proof <run-id>` to see the final bundle of diffs and test logs that proved the implementation.
