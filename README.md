# Cadre

Any model. Any bot. One command.

Cadre is a model-agnostic agent harness that wraps the `ax` coordination layer, providing a unified interface for agentic workflows with a strict evidence gate.

## Core Commands

- `cadre go "<outcome>"`: Musters the crew, runs the loop, and gates on checkable evidence.
- `cadre lanes`: Lists available agent lanes, their capabilities, and costs.
- `cadre parity "<outcome>" --ref <ref>`: Builds to parity against a cited reference.
- `cadre plan "<task>"`: Benches lanes and estimates spend before building.
- `cadre meter`: Monitors windows, quotas, and rollover resets.
- `cadre sweep`: Resumes interrupted runs or retires leftovers.
- `cadre map`: Generates a living codebase graph.
- `cadre watch [run]`: Attaches to a live run.
- `cadre proof [run]`: Dumps the evidence bundle for a run.
- `cadre debate "<question>"`: Runs a cross-lane adversarial debate with citation checks.
- `cadre pin`: Manages role pinning and spend caps.
- `cadre mcp`: Exposes Cadre as an MCP server for editor integration.

## Apertus Integration

Cadre supports Apertus lanes (8B/70B) via the Hermes interface. 
Lanes are declared in `~/.cadre/lanes/*.json`.

## Evidence Gate

Nothing is DONE in Cadre unless it passes the evidence gate:
- Command + Output
- File Diffs
- Test Results
- Citations

## Installation

1. Ensure `ax` is installed at `~/.local/bin/ax`.
2. Install Cadre: `npm install -g .` (from this directory).
