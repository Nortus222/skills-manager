# Nortus Skills Manager fork

Feature pull requests target `main`. Keep the integration checkout read-only and implement in `.claude/worktrees/<slug>` on a dedicated feature branch.

Read `REVIEW.md` before implementation and review. Preserve upstream's MIT license and authorship. Reuse existing install, source validation, locking and portable-metadata services. Test behavior in isolated temporary libraries, never against the user's live library.

Run targeted tests during implementation, then `npm run lint`, `npm run build`, `npm test`, and `cargo test --manifest-path src-tauri/Cargo.toml` before completion. Report any checks that cannot finish. Do not merge PRs.
