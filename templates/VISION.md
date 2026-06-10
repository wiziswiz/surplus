---
# Optional per-project overrides (win over ~/.surplus/config.json defaults;
# per-task settings win over these):
# model: opus        # opus | sonnet | haiku
# effort: high       # low | medium | high | xhigh | max
---

# Vision

<!-- One paragraph: what does "this project is finished" look like?
     The /goal evaluator and the judge both read this — write it as a
     verifiable end state, not a wish. -->

## Acceptance criteria

<!-- Measurable, checkable items. Each should be demonstrable from command
     output or a UI walkthrough. -->

- [ ] ...
- [ ] ...

## Verify commands

<!-- Shell commands whose exit code / output proves the criteria. The worker
     runs these and the /goal evaluator reads the results in the transcript. -->

```sh
npm test
npm run build
```

## UI flows

<!-- Only for projects with a UI: flows the worker must walk through with
     agent-browser as if a real user, before claiming done. -->

- ...

## Guardrails

<!-- Hard constraints. Files/dirs not to touch, behavior to preserve,
     dependencies not to add. -->

- Do not push to any remote. Commit only to the current branch.
- ...
