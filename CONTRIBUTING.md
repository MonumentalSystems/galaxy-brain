# Contributing

Galaxy Brain is an early alpha. Small, reviewable changes with explicit security and data-model assumptions are easiest to evaluate.

1. Open an issue or discussion before large architectural work.
2. Do not commit user data, HAM memories, credentials, local paths, deployment URLs, model artifacts, or generated caches.
3. Preserve the single-user boundary unless a change includes complete tenant scoping and authorization tests.
4. Run `pnpm lint`, `pnpm typecheck`, `pnpm test:notebook-editor`, and `pnpm build` before submitting.
5. Explain behavior changes, tests, migrations, and remaining limitations in the pull request.

Security reports belong in a private GitHub advisory as described in `SECURITY.md`.
