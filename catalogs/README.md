# Shipped code catalogs

Public-domain CDC/NCHS and CMS code lists installed by default: ICD-10-CM,
ICD-10-PCS and HCPCS Level II. CPT is never bundled; import it separately under
its license. Regenerate with
`python3 scripts/prepare_terminology.py --all --archives <official-source-zips> --dir catalogs`.
`manifest.json` records each file's edition, effective dates, code count,
source URL and SHA-256 digests.
