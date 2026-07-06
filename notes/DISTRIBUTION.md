# Distributing convoy

The install story: `brew install --cask myobie/convoy/convoy` → `Convoy.app` in `/Applications` +
the `convoy` CLI on PATH. Tap: [myobie/homebrew-convoy](https://github.com/myobie/homebrew-convoy).

## Cutting a release

```sh
# 1. Build release artifacts
swift build -c release --product convoy
scripts/bundle.sh                      # → .build/bundler/Convoy.app (ad-hoc signed)

# 2. Stage + zip (flat: Convoy.app and convoy at the archive root)
mkdir -p stage && cp -R .build/bundler/Convoy.app stage/ && cp .build/release/convoy stage/
ditto -c -k --sequesterRsrc stage convoy-<version>-macos-arm64.zip
shasum -a 256 convoy-<version>-macos-arm64.zip     # → cask sha256

# 3. GitHub release
gh release create v<version> convoy-<version>-macos-arm64.zip --repo myobie/convoy --prerelease

# 4. Update the tap cask (version + sha256) and push myobie/homebrew-convoy
```

## The Gatekeeper / provenance gotcha (and why the cask does what it does)

An **un-notarized, downloaded** binary is blocked by Gatekeeper on first exec. For an app that's
the familiar right-click → Open. For a **CLI it's a hard block** — you can't right-click a binary,
and headless it hangs forever on a consent decision that never comes.

Two layers cause it, and both must be defeated (until notarization):
1. **File-level quarantine** — the `com.apple.quarantine` xattr the download carries. `macOS cp`
   *propagates* it, so a copy must be followed by `xattr -c`.
2. **Path-level provenance** — syspolicyd records that a path was extracted from a quarantined
   download. This survives clearing the xattr *in place*. A copy to a **fresh path** avoids it.

So the cask installs the CLI as a **fresh, xattr-cleared copy** at `#{HOMEBREW_PREFIX}/bin/convoy`
(not a symlink to the tainted Caskroom path), and strips the app's quarantine xattr. Result: the
CLI runs immediately and the app opens without the prompt. All of this is a stopgap — **notarizing
the build makes every line of it unnecessary.**

## Notarization drop-in (when creds land)

Signing is already swappable (`CONVOY_SIGN_IDENTITY`). A Developer ID cert is present
("Developer ID Application: Shareup Software Corporation"); the only missing piece is notarytool
credentials. When they arrive:

```sh
# store creds once
xcrun notarytool store-credentials convoy \
    --apple-id <apple-id> --team-id <team-id> --password <app-specific-password>

# sign with Developer ID instead of ad-hoc, then notarize + staple
CONVOY_SIGN_IDENTITY="Developer ID Application: Shareup Software Corporation (762ZKAAPM9)" \
    scripts/bundle.sh
ditto -c -k --keepParent .build/bundler/Convoy.app Convoy.app.zip
xcrun notarytool submit Convoy.app.zip --keychain-profile convoy --wait
xcrun stapler staple .build/bundler/Convoy.app
# re-zip with the CLI, re-release, bump the cask sha256
```

Once notarized, drop the cask's `postflight` (restore a plain `binary "convoy"` stanza) — the
quarantine/provenance workaround is no longer needed.

## Known gaps

- **arm64 only.** A universal (arm64 + x86_64) slice is a follow-up: `swift build --arch arm64
  --arch x86_64`.
- **Prerelease.** v0.1.0 is a demo prerelease; not yet a stable tag.
