# Shipped code catalogs

Public-domain CDC/NCHS and CMS code lists installed by default: ICD-10-CM,
ICD-10-PCS and HCPCS Level II. CPT is never bundled; import it separately under
its license. Regenerate with
`python3 scripts/prepare_terminology.py --all --archives <official-source-zips> --dir catalogs`.
`manifest.json` records each file's edition, effective dates, code count,
source URL and SHA-256 digests.

The engine embeds every file listed in `manifest.json` (`src/builtin_catalogs.rs`)
and installs each edition for every practice, so no practice uploads these lists.
A file is used only if its bytes match the manifest digest, so editing a catalog
without re-running `manifest.json` fails the build's own checks instead of
installing unverified data.
