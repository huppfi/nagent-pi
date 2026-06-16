Start a data-oriented work session.

Goal: {{goal}}

Use Pi-native tools and the data-oriented-agent extension:
1. Inspect the real repository state and relevant files before proposing changes.
2. If this is non-trivial, create or update a durable artifact under `.pi/artifacts/data-agent/`.
3. State the input data, desired output, constraints, and verification plan.
4. Prefer the smallest correct transform.
5. Use `/data-checkpoint`, `/data-distill`, or `/data-campaign` when durable state should survive restart.
