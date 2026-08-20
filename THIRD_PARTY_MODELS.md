# Bundled model provenance

The canonical, machine-validated inventory is
`packages/core/assets/models/manifest.json`. Every entry pins an immutable
upstream revision and each bundled byte is checked by SHA-256 and exact size.

The current full/offline distribution intentionally bundles approximately
110 MiB of models. The release budget records this existing footprint without
growth allowance. Moving models to an explicit, integrity-checked optional
download remains the preferred follow-up; doing so also requires offline,
proxy, consent, retry, and verified-cache UX.

`@langchain/community` remains temporarily because the GitHub loader,
BM25 retriever, and LanceDB adapter do not have safe narrow-package
replacements in the current dependency line. Packaging prunes unused
entrypoints and the time-bounded exception is recorded in
`release-policy.json`.
