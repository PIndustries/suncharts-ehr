# Licensing direction

Working product name: **SunCharts EHR**. Rust server component: **SunCharts Engine**.
Suggested remote repository: `PIndustries/suncharts-ehr`. No remote has been
created or published during bootstrap. Naming is not trademark clearance.

The current local source uses **AGPL-3.0-only** for the engine and GUI. API
specifications under `api/` use **Apache-2.0**. This follows the requested
community-oriented engine direction while keeping client generation permissive.

AGPLv3 permits commercial use, charging for hosting, and forks. Section 13 requires
a modified network-facing version to prominently offer its Corresponding Source
to users interacting with it remotely. It does not require publishing clinical
data, operational credentials, or every unrelated program used by a hosting
business. It does not prohibit a competitor from hosting a compliant fork.

The server includes a `/source` archive of build-time project sources and a GUI
source link. Modified distributions must keep the offered archive complete and
accurate, including their installation/build scripts. Dependency notices and
complete distribution compliance must be reviewed before public release.

`AGPL-3.0-only` selects version 3 specifically. `AGPL-3.0-or-later` would also let
recipients choose future FSF versions. Version 3 only is the initial preference
for a defined licensing boundary, and can be changed before publication.

The separate SunCharts applications communicate through HTTP and do not import
this Rust crate. HTTP alone is not a categorical legal exception: ensure client
and server remain independent works and review any tightly coupled extensions.
No commercial dual-license scheme or contributor relicensing grant is chosen.
Future contributions need an explicit inbound policy before assuming relicensing
rights. The engine is independently authored; no existing proprietary application source
has been transferred into it.

References:

- [AGPLv3 text](https://www.gnu.org/licenses/agpl-3.0.html), especially sections 1 and 13.
- [GNU license guidance](https://www.gnu.org/licenses/gpl-howto.html).
- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
