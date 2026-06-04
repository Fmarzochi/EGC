# Release Verification

Every EGC release is published with build provenance attestations that allow you to verify the integrity and authenticity of the release assets.

## Verifying npm Package Provenance

EGC is published to npm with `--provenance`, which generates a signed provenance attestation linked to the GitHub Actions workflow that built it.

To verify:

```bash
npm audit signatures egc-universal
```

Expected output:

```
audited 1 package in Xs
1 package has a verified registry signature
1 package has a verified attestation
```

## Verifying GitHub Release Assets

Build provenance for release tarballs is attested via [GitHub Artifact Attestations](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds).

To verify a release tarball:

```bash
gh attestation verify egc-universal-<version>.tgz \
  --owner Fmarzochi \
  --repo everything-gemini
```

Expected output confirms that the artifact was produced by the `release.yml` workflow in the `Fmarzochi/everything-gemini` repository.

## Verifying the Author Identity

The attestation certificate contains the workflow identity:

- **Issuer:** `https://token.actions.githubusercontent.com`
- **Subject:** `https://github.com/Fmarzochi/everything-gemini/.github/workflows/release.yml@refs/tags/vX.Y.Z`

This confirms that the release was built by the official GitHub Actions workflow from the official repository, not from an arbitrary machine or actor.

## What Is Attested

| Asset | Attestation Type |
|-------|-----------------|
| npm tarball (`egc-universal-*.tgz`) | Build provenance (SLSA Level 2) |
| npm package (published) | npm provenance (`--provenance` flag) |

## Cryptographic Verification

All attestations use Sigstore's keyless signing infrastructure. No manual key management is required. Verification uses the public Sigstore transparency log (Rekor) to confirm the signature was created during the CI run at the time of release.
