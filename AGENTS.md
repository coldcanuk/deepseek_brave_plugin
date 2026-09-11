# AGENTS.md

Instructions for automated agents working in this repository.

## Prime Directive

**It is strictly prohibited to write or save directly to `main`.**

`main` is the published branch: it is what a harness operator installs from, and
what CI reports on. A commit made straight to it has no review boundary, no
worktree to verify in, and no branch to abandon if the work turns out wrong.

## The workflow

1. **Create a worktree.** Always, for every change, however small. Do not edit
   files in the primary checkout and do not commit there:

   ```sh
   git worktree add .worktrees/<short-name> -b <type>/<short-name>
   ```

   `.worktrees/` is already in `.gitignore`. Keep it that way: an un-ignored
   worktree adds an entire second checkout to `git status` and to
   `npm run check:secrets`, which deliberately scans exactly what `git add -A`
   would publish.

2. **Do the work and verify it there.** `cd` into the worktree, make the change,
   and run the gates before committing anything:

   ```sh
   npm run check     # secrets, lint, both declaration checks, tests, coverage
   ```

   Nothing is proposed until it is green.

3. **Commit as per your plan.** One commit per coherent theme, with the reasoning
   in the message — *why* the change is correct, not a restatement of the diff.
   Intermediate commits must each leave the tree coherent.

4. **Push the branch.**

   ```sh
   git push -u origin <branch>
   ```

5. **Merge the pull request.** Merge to `main` only after the branch is pushed
   and green. Use `--no-ff` so the work keeps a visible boundary:

   ```sh
   git checkout main && git pull
   git merge --no-ff <branch>
   ```

6. **Delete the unused worktree.** After the merge succeeds, remove both the
   worktree and the branch that has been merged:

   ```sh
   git worktree remove .worktrees/<short-name>
   git branch -d <branch>          # -D only if it was not merged
   git push origin --delete <branch>
   rmdir .worktrees 2>/dev/null    # when it is the last one
   ```

## Notes

- The primary checkout at the repository root is for reading and for `main`
  bookkeeping. If it holds uncommitted changes when you merge, resolve that
  first: mirror the working tree into the worktree, prove the two are identical
  with `diff -r`, and only then clean the primary checkout.
- `npm test` runs the suite through `scripts/check-test-gate.mjs`, which fails if
  the runner executes too few tests. A test command that looks green while
  running nothing is the failure mode that gate exists to catch.
- CI runs every gate on Node 20, 22, and 24. Verify a version-sensitive change on
  the oldest supported Node before pushing, not after.
