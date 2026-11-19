# Shipped code catalogs

Public-domain CDC/NCHS and CMS code lists installed by default: ICD-10-CM,
ICD-10-PCS and HCPCS Level II. CPT is never bundled; import it separately under
its license. The dataset specifications (edition, source URL and effective
dates for every catalog) live in `datasets.json`; `prepare_terminology.py`
reads them from there. Regenerate with
`python3 scripts/prepare_terminology.py --all --archives <official-source-zips> --dir catalogs`.
`manifest.json` records each file's edition, effective dates, code count,
source URL and SHA-256 digests.

`python3 scripts/prepare_terminology.py discover` probes the official sources
for the next HCPCS quarter and the next ICD-10-CM / ICD-10-PCS fiscal year,
and installs whatever already exists: new entries in `datasets.json`, new
`*.json.gz` files and an updated `manifest.json`. The
`code-lists-refresh.yml` workflow runs it weekly and opens a pull request with
the result. A new HCPCS edition is added with an open `effective_end` and
previous editions keep theirs unchanged: editions already shipped are
immutable, and the server selects the newest edition whose start is on or
before the service date.

The engine embeds every file listed in `manifest.json` (`src/builtin_catalogs.rs`)
and installs each edition for every practice, so no practice uploads these lists.
A file is used only if its bytes match the manifest digest, so editing a catalog
without re-running `manifest.json` fails the build's own checks instead of
installing unverified data.
