## Why

Electron Packager silently keeps an existing architecture-specific output when overwrite is not enabled, so `out/` can contain and launch an older application even after a successful-looking build command. The current generic package command also leaves the intended macOS architecture ambiguous.

## What Changes

- Configure macOS packaging to replace an existing output for the requested architecture.
- Provide explicit, architecture-specific package commands and a single macOS release command that builds every supported distribution target.
- Add a post-package verifier that fails when the expected `.app` or `app.asar` is missing, stale, or does not contain the current renderer source fingerprint.
- Document the supported build and verification commands.

## Capabilities

### New Capabilities

- `release-packaging`: Produce and verify fresh, architecture-specific macOS application bundles before they are launched or distributed.

### Modified Capabilities

- None.

## Impact

- Affected code: `forge.config.js`, `package.json`, a new build-verification script and its tests, plus release documentation.
- No runtime application APIs or project data formats change.
