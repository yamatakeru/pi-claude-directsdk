# Maintaining the repository

## Triage issues

Use these issue searches:

- New reports: `is:issue is:open label:needs-triage`
- Waiting for a reporter: `is:issue is:open label:needs-info`
- Verified bugs: `is:issue is:open label:bug label:confirmed`

Remove `needs-triage` after reviewing an issue. Use `needs-info` only when specific information is missing.
Remove `needs-info` and `awaiting-response` when the requested information arrives. Use `confirmed` for verified problems.
Link duplicates to the existing issue before closing them.

The daily cleanup workflow only handles `needs-info` issues. It reminds after 30 inactive days and closes after another 14.
Confirmed issues and milestone issues are exempt. The workflow does not clean up pull requests.

Closing an issue automatically locks its discussion. Cleanup also locks the issues it closes.
Existing closed issues are not backfilled. To continue a discussion after reopening an issue, manually unlock it in GitHub.
Reporters can request reopening through a new help issue that links the closed issue.
See [contribution guidance](../CONTRIBUTING.md) for the reporter-facing policy.

Public contributions are issue-only. If an unsolicited pull request arrives, explain that policy and close it.
Maintainer pull requests remain available for branch review and CI.

## Watch the upstream tracker

`.github/workflows/upstream-watch.yml` runs daily and appends upstream
[anthropics/claude-code](https://github.com/anthropics/claude-code) issues to a single
`Upstream Claude Code watch` issue. It looks for two kinds of report:

- A literal identifier this transport writes or reads: the billing identity label, the
  `CLAUDE_CODE_*` variables the child receives, `isUsingOverage`, `unifiedWindows`, or the
  setting that decides whether replayed thinking is sent (`CLAUDE_CODE_RUSTLING_PIXEL`,
  `tengu_rustling_pixel`).
- A report about the SDK, `claude -p`, or headless use that also discusses metering. Reports
  about the desktop app, VS Code, Cowork, and other clients stay out of this group.

Search hits are only a recall step, because GitHub search treats hyphens and underscores as
word breaks. Relevance is decided on the raw issue text. The tracker issue body holds the last
scan date and the numbers already reported, so a rerun never repeats an item, and that issue
doubles as the archive. Deleting the state marker stops the job rather than duplicating the
archive.

The same job reports when the published `@anthropic-ai/claude-code` version leaves
`QUALIFIED_CLI_RANGE`. That is the signal to repeat the verification in [testing.md](testing.md).

Run the workflow manually from the Actions tab to preview a report with `dry_run`. Set
`lookback_days` to widen the window, which applies only while no previous report exists.

## Develop on branches

Push work to a branch. CI checks types and compilation on branch pushes and pull requests targeting `main`.
These checks do not exercise the installed Pi runtime or make paid model requests.
Use the [verification guidance](testing.md) for local runtime checks.

Merge the branch into `main` with a squash merge once CI passes. Installations that follow `main` pick the change up with `pi update git:github.com/yamatakeru/pi-claude-native`; there is no npm release.

To release, bump `version` in `package.json` and both `version` fields at the top of `package-lock.json` in a pull request. The README's pinned-install example names the new tag, so create it right after the merge, on the squash commit the merge put on `main`. Push the tag first, then publish the release on it:

```sh
git tag v<x.y.z> <squash-commit-sha> && git push origin v<x.y.z> &&
  gh release create v<x.y.z> --verify-tag --title v<x.y.z> --notes-file <notes>
```

`git push` refuses a tag that already exists on the remote and fails when the remote is unreachable, so the release is never published on another commit. `--verify-tag` publishes only on the pushed tag.

Installations pinned to a tag stay on it until the user changes the ref.

## Security and dependencies

Dependabot vulnerability alerts remain enabled. Automatic security-update and version-update pull requests are disabled.
Review alerts in GitHub's Security tab and update affected dependencies on a maintenance branch.
Review CodeQL and secret-scanning alerts there as well. See the [security policy](../SECURITY.md) for private reports.

Workflow actions are pinned to full commit SHAs. When updating one, verify the upstream release and commit before changing the pin.
Branch CI has read-only repository access.
