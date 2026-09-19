# keel evals

Two layers:

1. **`keel simulate`** (69 scenarios) — the enforcement layer against a throwaway repo with fake build tools. Fast, offline, and run in CI.
2. **`claude plugin eval`** cases below — end-to-end behaviour with a real model, checking that the skills drive the CLI correctly.

Each case: the prompt, the repo state to start from, and what must be true afterwards.
