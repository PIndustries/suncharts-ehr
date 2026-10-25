# Release checklist

- Run formatting, Clippy, PostgreSQL integration tests, exporter tests and frontend regression checks.
- Confirm the repository contains only intended source and synthetic fixtures.
- Scan the complete source package and intended Git history for secrets.
- Verify license files, contributor guidance and private security reporting.
- Build the corresponding source archive and compare it to the tagged files.
- Verify hosted CI for the exact release commit.
- Publish accurate release notes and verify downloadable source checksums.
- Review the user interface, accessibility and supported workflows independently from automated tests.

Developer previews use synthetic data. No release is designated for clinical production until its clinical and operational acceptance requirements are met.
