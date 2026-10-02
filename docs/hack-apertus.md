# Hack Apertus with Cadre

How Cadre uses Apertus (Swiss open LLMs, OpenAI-compatible chat endpoint) as
its reasoning lane - Track 2B integration.

## Setup

```bash
export APERTUS_API_KEY=...          # required for live calls
export APERTUS_BASE_URL=...         # optional; default https://api.apertus.ai
```

No key? Every Apertus path skips cleanly and says why. Example:

```
$ cadre go "task" --dry
apertus: not keyed - planner uses the local scaffold, critic skipped
```

Nothing fakes a response. `apertusChat` throws `CADRE_SKIP` and callers print
the skip reason.

## Where Apertus is used

| Surface | Lane | What happens (live) |
|---|---|---|
| `cadre plan` | apertus-8b | drafts the step list after local routing; usage tokens printed |
| `cadre go` (plan step) | apertus-8b or 70b (router-picked) | numbered plan filed to the run log; fallback is the labeled local scaffold |
| `cadre go` (critique step) | apertus-70b | reviews builder output against the brief |
| `cadre debate` | apertus-70b | optional judge over the two ax lane transcripts |
| `cadre lanes` | apertus-8b/70b | listed only when the key is present |

## Key hygiene

- Read from env at call time; one Authorization header; never logged.
- `audit.log` entries go through a redactor (`key|token|secret|authorization`
  -> `[redacted]`).
- `keyFingerprint()` exposes only sha256(key).slice(0,6) so ops can confirm
  which key is loaded without seeing it.
- No key material in the repo, in run records, or in debate transcripts.

## Verifying it is live

```bash
APERTUS_API_KEY=... ./bin/cadre.js plan "refactor the router"   # look for "apertus-8b draft plan"
./bin/cadre.js go "small fix" --dry                              # "apertus: live" line
grep apertus-call ~/.cadre/audit.log | tail -1                   # usage receipts
```

Without a key, the same commands print explicit skips - that is the honest
state, not a failure.
