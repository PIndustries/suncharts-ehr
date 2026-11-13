import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.ci_rust_shards import build_plan, integration_tests


ROOT = Path(__file__).resolve().parents[1]
RENDER = ROOT / "deploy" / "render_kubernetes.py"
EXAMPLE = ROOT / "deploy" / "provisioning-request.example.json"
RELEASE = ROOT / "scripts" / "build_release_manifest.py"


class DeploymentArtifactsTest(unittest.TestCase):
    def render(self, request):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "request.json"
            output = Path(directory) / "runtime.yaml"
            source.write_text(json.dumps(request))
            result = subprocess.run(
                ["python3", str(RENDER), str(source), "--output", str(output)],
                capture_output=True,
                text=True,
            )
            return result, output.read_text() if output.exists() else ""

    def test_digest_qualified_request_renders_tenant_runtime(self):
        request = json.loads(EXAMPLE.read_text())
        result, manifest = self.render(request)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("sc-ehr-00000000000040008000000000000003", manifest)
        self.assertIn(request["image_reference"], manifest)
        self.assertIn("path: /ready", manifest)
        self.assertIn("readOnlyRootFilesystem: true", manifest)
        self.assertIn("secretName: suncharts-ehr-connect-bootstrap", manifest)
        self.assertIn("ENGINE_MANAGED_CONNECT_BOOTSTRAP_FILE", manifest)
        self.assertIn("ENGINE_DEPLOYED_IMAGE_REFERENCE", manifest)
        self.assertIn("ENGINE_DEPLOYED_VERSION", manifest)
        self.assertIn("name: ENGINE_ENVIRONMENT\n              value: production", manifest)
        self.assertNotIn("capability:", manifest)
        self.assertNotIn("__IMAGE_REFERENCE__", manifest)
        self.assertNotIn("bootstrap_password:", manifest)

    def test_mutable_image_tag_is_rejected(self):
        request = json.loads(EXAMPLE.read_text())
        request["image_reference"] = "ghcr.io/pindustries/suncharts-ehr:latest"
        result, _ = self.render(request)
        self.assertEqual(result.returncode, 2)
        self.assertIn("sha256 digest", result.stderr)

    def test_provisioning_version_requires_exact_numeric_build(self):
        request = json.loads(EXAMPLE.read_text())
        for invalid in (
            "26.11.06.0",
            "26.11.06.1-dev",
            "26.11.06.1+sha.abcdef",
            "2026.11.06.1",
            "26.1.06.1",
        ):
            with self.subTest(version=invalid):
                request["expected_version"] = invalid
                result, _ = self.render(request)
                self.assertEqual(result.returncode, 2)
                self.assertIn("YY.MM.DD.BUILD", result.stderr)

    def test_provisioning_version_allows_positive_multi_digit_build(self):
        request = json.loads(EXAMPLE.read_text())
        request["expected_version"] = "26.11.06.12"
        result, manifest = self.render(request)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('value: "26.11.06.12"', manifest)

    def test_provisioning_schema_matches_renderer_version_contract(self):
        schema = json.loads((ROOT / "deploy" / "provisioning-request.schema.json").read_text())
        self.assertEqual(
            schema["properties"]["expected_version"]["pattern"],
            r"^[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[1-9][0-9]*$",
        )

    def test_unknown_request_fields_are_rejected(self):
        request = json.loads(EXAMPLE.read_text())
        request["password"] = "must-not-enter-contract"
        result, _ = self.render(request)
        self.assertEqual(result.returncode, 2)
        self.assertIn("fields do not match", result.stderr)

    def test_container_bases_are_digest_pinned(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertRegex(dockerfile, r"rust:1\.89-bookworm@sha256:[0-9a-f]{64}")
        self.assertRegex(dockerfile, r"debian:bookworm-slim@sha256:[0-9a-f]{64}")
        self.assertIn('ARG DEBIAN_SNAPSHOT="20250910T000000Z"', dockerfile)
        self.assertIn("https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}", dockerfile)
        self.assertIn(
            "COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt",
            dockerfile,
        )
        runtime = dockerfile.split("FROM ${RUNTIME_IMAGE} AS runtime", 1)[1]
        self.assertNotIn("apt-get", runtime)
        self.assertNotIn("snapshot.debian.org", runtime)
        self.assertNotIn("curl", runtime.split("# The digest-pinned runtime", 1)[0])
        self.assertIn(
            'CMD ["/usr/local/bin/suncharts-engine", "--healthcheck"]', runtime
        )
        self.assertGreaterEqual(dockerfile.count("Acquire::http::Timeout=60"), 2)
        self.assertGreaterEqual(dockerfile.count("Acquire::https::Timeout=60"), 2)
        self.assertGreaterEqual(dockerfile.count("Acquire::Retries=5"), 2)

    def test_dependency_layer_precedes_application_source(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        dependency_copy = dockerfile.index("COPY Cargo.toml Cargo.lock ./")
        dependency_build = dockerfile.index("cargo build --locked --release", dependency_copy)
        application_stage = dockerfile.index("FROM dependencies AS application")
        application_copy = dockerfile.index("COPY . .", application_stage)
        application_build = dockerfile.index("cargo build --locked --release", application_copy)

        self.assertLess(dependency_copy, dependency_build)
        self.assertLess(dependency_build, application_stage)
        self.assertLess(application_stage, application_copy)
        self.assertLess(application_copy, application_build)
        self.assertNotIn("suncharts-ehr-target", dockerfile)
        self.assertIn("COPY --from=application /out/suncharts-engine", dockerfile)

    def test_image_workflow_actions_are_commit_pinned(self):
        workflow = (ROOT / ".github" / "workflows" / "publish-image.yml").read_text()
        uses = [line.split("uses:", 1)[1].split("#", 1)[0].strip() for line in workflow.splitlines() if "uses:" in line]
        local = [action for action in uses if action.startswith("./")]
        external = [action for action in uses if not action.startswith("./")]
        self.assertEqual(local, ["./.github/workflows/full-regression.yml"])
        self.assertGreaterEqual(len(external), 7)
        for action in external:
            self.assertRegex(action, r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}$")
        self.assertIn("cache-from: type=gha,scope=suncharts-ehr-amd64", workflow)
        self.assertIn("cache-to: type=gha,mode=max,scope=suncharts-ehr-amd64", workflow)
        self.assertIn("timeout-minutes: 60", workflow)
        self.assertIn("cache-from: type=gha,scope=suncharts-ehr-arm64", workflow)
        self.assertIn("cache-to: type=gha,mode=max,scope=suncharts-ehr-arm64", workflow)

    def test_release_publication_requires_full_regression(self):
        workflow = (ROOT / ".github" / "workflows" / "publish-image.yml").read_text()
        amd64 = workflow.split("  publish_amd64:", 1)[1].split("  publish_arm64:", 1)[0]
        self.assertIn("needs: [full_regression, build_amd64]", amd64)
        self.assertIn("needs.full_regression.result == 'success'", amd64)
        self.assertIn("needs.build_amd64.result == 'success'", amd64)
        full = (ROOT / ".github" / "workflows" / "full-regression.yml").read_text()
        self.assertIn("cargo clippy --locked --all-targets -- -D warnings", full)
        self.assertIn("cargo fmt --check", full)
        self.assertIn("cargo test --locked --no-run", full)
        self.assertIn("cargo test --locked --doc", full)
        self.assertIn("scripts/ci_rust_shards.py run", full)
        # The authentication boundary still runs, first, in the security shard.
        self.assertEqual(
            build_plan(integration_tests())["security"][0], "partner_support_sso"
        )
        self.assertIn("python3 -m unittest discover -s scripts -p 'test_*.py'", full)
        self.assertIn("test_*.cjs", full)
        self.assertIn("node --check", full)
        self.assertNotIn("continue-on-error", full)

    def test_regression_gate_requires_every_regression_job(self):
        full = (ROOT / ".github" / "workflows" / "full-regression.yml").read_text()
        jobs = re.findall(r"^  ([a-z0-9-]+):$", full.split("\njobs:\n", 1)[1], re.M)
        self.assertEqual(jobs[-1], "full-regression")
        self.assertGreaterEqual(len(jobs), 7)
        gate = full.split("\n  full-regression:\n", 1)[1]
        self.assertIn("name: Full Rust, UI, and security regression", gate)
        self.assertIn("if: always()", gate)
        for job in jobs[:-1]:
            self.assertIn(f"      - {job}\n", gate)
            variable = job.upper().replace("-", "_")
            self.assertIn(f"{variable}: ${{{{ needs.{job}.result }}}}", gate)
            self.assertIn(f'test "${variable}" = success', gate)
            # Only the gate may run conditionally; a skipped check is a lost check.
            body = re.split(r"\n  [a-z0-9-]+:\n", full.split(f"\n  {job}:\n", 1)[1])[0]
            self.assertIsNone(re.search(r"^    if:", body, re.M), job)

    def test_image_is_built_in_parallel_but_published_only_after_the_gate(self):
        workflow = (ROOT / ".github" / "workflows" / "publish-image.yml").read_text()
        build = workflow.split("  build_amd64:", 1)[1].split("  publish_amd64:", 1)[0]
        amd64 = workflow.split("  publish_amd64:", 1)[1].split("  publish_arm64:", 1)[0]
        regression = workflow.split("  full_regression:", 1)[1].split("  build_amd64:", 1)[0]

        # The parallel build waits for nothing and can publish nothing.
        self.assertNotIn("needs:", build)
        self.assertNotIn("needs:", regression)
        self.assertIn("permissions:\n      contents: read\n", build)
        self.assertIn("push: false", build)
        self.assertIn("outputs: type=cacheonly", build)
        self.assertNotIn("push: true", build)
        self.assertNotIn("login-action", build)
        self.assertNotIn("secrets.", build)
        self.assertNotIn("actions/attest", build)
        self.assertNotIn("upload-artifact", build)
        self.assertNotIn("tags:", build)
        self.assertIn("platforms: linux/amd64", build)
        # Same inputs as the published build, so its cached layers are reused.
        for line in (
            "context: .",
            "RUST_IMAGE=${{ env.RUST_IMAGE }}",
            "RUNTIME_IMAGE=${{ env.RUNTIME_IMAGE }}",
            "DEBIAN_SNAPSHOT=${{ env.DEBIAN_SNAPSHOT }}",
            "cache-from: type=gha,scope=suncharts-ehr-amd64",
            "cache-to: type=gha,mode=max,scope=suncharts-ehr-amd64",
        ):
            self.assertIn(line, build)
            self.assertIn(line, amd64)

        # Publication keeps every release guarantee.
        self.assertIn("push: true", amd64)
        self.assertIn("tags: ${{ env.IMAGE_NAME }}:sha-${{ github.sha }}", amd64)
        self.assertIn("provenance: mode=max", amd64)
        self.assertIn("sbom: true", amd64)
        self.assertIn("subject-digest: ${{ steps.image.outputs.digest }}", amd64)
        self.assertIn("push-to-registry: true", amd64)
        self.assertIn("Record immutable provisioning input", amd64)
        self.assertIn("Attest release control manifest", amd64)
        self.assertIn("Prepare immutable GitHub Release assets", amd64)
        self.assertEqual(workflow.count("push: true"), 2)
        self.assertEqual(
            workflow.count("permissions:\n  contents: write\n  packages: write\n"
                           "  id-token: write\n  attestations: write\n"), 1)

    def test_release_fast_path_does_not_wait_for_arm_emulation(self):
        workflow = (ROOT / ".github" / "workflows" / "publish-image.yml").read_text()
        amd64 = workflow.split("  publish_amd64:", 1)[1].split("  publish_arm64:", 1)[0]
        arm64 = workflow.split("  publish_arm64:", 1)[1].split("  community-notification:", 1)[0]

        self.assertIn("platforms: linux/amd64", amd64)
        self.assertNotIn("setup-qemu-action", amd64)
        self.assertIn("Build release control manifest", amd64)
        self.assertIn("Attach immutable inputs to existing GitHub Release", amd64)
        self.assertIn("platforms: linux/arm64", arm64)
        self.assertIn("setup-qemu-action", arm64)
        self.assertIn("continue-on-error: true", arm64)
        self.assertIn("github.event_name == 'schedule'", arm64)
        self.assertIn("inputs.lane == 'arm64-mirror'", arm64)
        self.assertIn("provenance: mode=max", arm64)
        self.assertIn("sbom: true", arm64)
        self.assertIn("Attest the ARM64 mirror digest", arm64)

    def test_release_manifest_binds_digest_source_and_schema(self):
        version = (ROOT / "BUILD_VERSION").read_text().strip()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "release.json"
            result = subprocess.run(
                [
                    "python3", str(RELEASE),
                    "--image-reference", "ghcr.io/pindustries/suncharts-ehr@sha256:" + "b" * 64,
                    "--source-commit", "c" * 40,
                    "--source-tag", "v" + version,
                    "--workflow-ref", "PIndustries/suncharts-ehr/.github/workflows/publish-image.yml@refs/tags/v" + version,
                    "--rust-image", "rust:1.89-bookworm@sha256:" + "d" * 64,
                    "--runtime-image", "debian:bookworm-slim@sha256:" + "e" * 64,
                    "--debian-snapshot", "20250910T000000Z",
                    "--output", str(output),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            manifest = json.loads(output.read_text())
            self.assertEqual(manifest["version"], version)
            self.assertEqual(manifest["database"]["schema_revision"], 105)
            self.assertEqual(manifest["database"]["rollback_mode"], "restore_pre_update_backup")
            self.assertTrue(manifest["image_reference"].endswith("b" * 64))

    def test_release_tag_must_match_build_version(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [
                    "python3", str(RELEASE),
                    "--image-reference", "ghcr.io/pindustries/suncharts-ehr@sha256:" + "b" * 64,
                    "--source-commit", "c" * 40,
                    "--source-tag", "v00.00.00.1",
                    "--workflow-ref", "workflow",
                    "--rust-image", "rust:1.89-bookworm@sha256:" + "d" * 64,
                    "--runtime-image", "debian:bookworm-slim@sha256:" + "e" * 64,
                    "--debian-snapshot", "20250910T000000Z",
                    "--output", str(Path(directory) / "release.json"),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("tag must exactly match", result.stdout)


DEV_WORKFLOW_REF = "PIndustries/suncharts-ehr/.github/workflows/publish-dev-preview.yml@refs/heads/main"


class DevPreviewTest(unittest.TestCase):
    """A dev preview ships without the full regression and can never be production."""

    def manifest(self, *extra, workflow_ref=DEV_WORKFLOW_REF, dev=True, tag=None):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "release.json"
            command = [
                "python3", str(RELEASE),
                "--image-reference", "ghcr.io/pindustries/suncharts-ehr@sha256:" + "b" * 64,
                "--source-commit", "0123456789ab" + "c" * 28,
                "--workflow-ref", workflow_ref,
                "--rust-image", "rust:1.89-bookworm@sha256:" + "d" * 64,
                "--runtime-image", "debian:bookworm-slim@sha256:" + "e" * 64,
                "--debian-snapshot", "20250910T000000Z",
                "--output", str(output),
                *extra,
            ]
            if dev:
                command.append("--dev-preview")
            if tag:
                command += ["--source-tag", tag]
            result = subprocess.run(command, capture_output=True, text=True)
            return result, json.loads(output.read_text()) if output.exists() else None

    def test_dev_preview_manifest_is_marked_and_unique_per_commit(self):
        version = (ROOT / "BUILD_VERSION").read_text().strip()
        result, manifest = self.manifest()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(manifest["contract_version"], "dev-preview-1")
        self.assertEqual(manifest["channel_eligibility"], ["dev"])
        self.assertIs(manifest["production_eligible"], False)
        # The image still reports BUILD_VERSION, so the manifest version does too.
        self.assertEqual(manifest["version"], version)
        self.assertEqual(manifest["preview"]["build_id"], f"{version}+dev.0123456789ab")
        self.assertEqual(manifest["preview"]["release"], "dev-0123456789ab")
        self.assertEqual(manifest["preview"]["full_regression"], "not_required")
        self.assertEqual(manifest["source"]["branch"], "main")
        self.assertNotIn("tag", manifest["source"])
        self.assertEqual(manifest["attestation"]["workflow_ref"], DEV_WORKFLOW_REF)

    def test_dev_preview_manifest_fails_the_production_contract(self):
        _, manifest = self.manifest()
        production = json.loads((ROOT / "deploy" / "release-manifest.schema.json").read_text())
        preview = json.loads((ROOT / "deploy" / "dev-preview-manifest.schema.json").read_text())

        properties = production["properties"]
        self.assertFalse(production["additionalProperties"])
        self.assertNotEqual(manifest["contract_version"], properties["contract_version"]["const"])
        self.assertNotIn("dev", properties["channel_eligibility"]["items"]["enum"])
        self.assertEqual(properties["channel_eligibility"]["items"]["enum"], ["preview", "stable"])
        self.assertIn("tag", properties["source"]["required"])
        self.assertNotIn("preview", properties)
        self.assertNotIn("production_eligible", properties)
        self.assertNotIn("branch", properties["source"]["properties"])

        # The preview contract accepts exactly what the builder writes.
        self.assertEqual(sorted(manifest), sorted(preview["required"]))
        self.assertEqual(sorted(manifest), sorted(preview["properties"]))
        self.assertFalse(preview["additionalProperties"])
        for key in ("contract_version", "channel_eligibility", "production_eligible"):
            self.assertEqual(manifest[key], preview["properties"][key]["const"])
        self.assertEqual(sorted(manifest["source"]), sorted(preview["properties"]["source"]["required"]))
        self.assertEqual(sorted(manifest["preview"]), sorted(preview["properties"]["preview"]["required"]))
        for key, rule in preview["properties"]["preview"]["properties"].items():
            if "pattern" in rule:
                self.assertRegex(manifest["preview"][key], rule["pattern"])
        self.assertEqual(
            manifest["attestation"]["workflow_ref"],
            preview["properties"]["attestation"]["properties"]["workflow_ref"]["const"],
        )

    def test_dev_preview_and_production_manifests_cannot_be_crossed(self):
        version = (ROOT / "BUILD_VERSION").read_text().strip()
        production_ref = "PIndustries/suncharts-ehr/.github/workflows/publish-image.yml@refs/tags/v" + version

        result, manifest = self.manifest(tag="v" + version)
        self.assertEqual(result.returncode, 2)
        self.assertIsNone(manifest)
        self.assertIn("never from a release tag", result.stdout)

        for workflow_ref in (
            production_ref,
            DEV_WORKFLOW_REF.replace("refs/heads/main", "refs/heads/feature"),
            DEV_WORKFLOW_REF.replace("refs/heads/main", "refs/tags/v" + version),
        ):
            result, manifest = self.manifest(workflow_ref=workflow_ref)
            self.assertEqual(result.returncode, 2, workflow_ref)
            self.assertIsNone(manifest)

        result, manifest = self.manifest(dev=False, tag="v" + version)
        self.assertEqual(result.returncode, 2)
        self.assertIsNone(manifest)
        self.assertIn("cannot build a production release manifest", result.stdout)

        result, manifest = self.manifest(dev=False)
        self.assertEqual(result.returncode, 2)
        self.assertIsNone(manifest)

        result, manifest = self.manifest(dev=False, tag="v" + version, workflow_ref=production_ref)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(manifest["contract_version"], "1")
        self.assertEqual(manifest["channel_eligibility"], ["preview", "stable"])
        self.assertNotIn("preview", manifest)
        self.assertNotIn("production_eligible", manifest)
        self.assertEqual(manifest["source"]["tag"], "v" + version)

    def test_dev_preview_workflow_publishes_from_main_without_the_regression(self):
        workflow = (ROOT / ".github" / "workflows" / "publish-dev-preview.yml").read_text()
        self.assertIn("on:\n  push:\n    branches: [main]\n\n", workflow)
        triggers = workflow.split("\non:\n", 1)[1].split("\nconcurrency:", 1)[0]
        self.assertEqual(triggers, "  push:\n    branches: [main]\n")
        for trigger in ("workflow_dispatch", "workflow_call", "schedule", "pull_request"):
            self.assertNotIn(trigger, workflow)
        self.assertIn("if: github.event_name == 'push' && github.ref == 'refs/heads/main'", workflow)
        self.assertNotIn("needs:", workflow)
        self.assertNotIn("full-regression", workflow)
        self.assertNotIn("continue-on-error", workflow)
        self.assertIn("\npermissions:\n  contents: read\n", workflow)

        uses = [line.split("uses:", 1)[1].split("#", 1)[0].strip() for line in workflow.splitlines() if "uses:" in line]
        self.assertGreaterEqual(len(uses), 6)
        for action in uses:
            self.assertRegex(action, r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}$")

        # Same outputs the rollout tooling consumes for a release.
        self.assertIn("provenance: mode=max", workflow)
        self.assertIn("sbom: true", workflow)
        self.assertIn("subject-digest: ${{ steps.image.outputs.digest }}", workflow)
        self.assertIn("push-to-registry: true", workflow)
        self.assertIn("subject-path: release-manifest.json", workflow)
        self.assertIn("--dev-preview", workflow)
        self.assertNotIn("--source-tag", workflow)
        self.assertIn('--workflow-ref "$GITHUB_WORKFLOW_REF"', workflow)
        self.assertIn(
            "release-manifest.json release-assets.sha256 image-reference.txt build-inputs.sha256 build-inputs.env \\\n"
            "            image.attestation.json release-manifest.attestation.json",
            workflow,
        )

        # Never the production tag, release or commit image tag.
        self.assertIn("tags: ${{ env.IMAGE_NAME }}:dev-sha-${{ github.sha }}", workflow)
        self.assertNotIn(":sha-${{ github.sha }}", workflow)
        self.assertIn('echo "release=dev-${GITHUB_SHA:0:12}"', workflow)
        self.assertIn("--draft --prerelease --latest=false", workflow)
        self.assertIn("--draft=false --prerelease --latest=false", workflow)
        self.assertIn("already exists and is immutable", workflow)
        self.assertNotIn("GITHUB_REF_NAME", workflow)

    def test_dev_preview_builds_the_same_image_inputs_as_a_release(self):
        preview = (ROOT / ".github" / "workflows" / "publish-dev-preview.yml").read_text()
        release = (ROOT / ".github" / "workflows" / "publish-image.yml").read_text()
        for name in ("IMAGE_NAME", "RUST_IMAGE", "RUNTIME_IMAGE", "DEBIAN_SNAPSHOT"):
            lines = [line for line in release.splitlines() if line.startswith(f"  {name}: ")]
            self.assertEqual(len(lines), 1, name)
            self.assertIn(lines[0] + "\n", preview)
        self.assertIn("cache-from: type=gha,scope=suncharts-ehr-amd64", preview)
        self.assertIn("cache-to: type=gha,mode=max,scope=suncharts-ehr-amd64", preview)

    def test_production_publication_is_untouched_by_main_pushes(self):
        release = (ROOT / ".github" / "workflows" / "publish-image.yml").read_text()
        triggers = release.split("\non:\n", 1)[1].split("\nconcurrency:", 1)[0]
        self.assertIn("  push:\n    tags: ['v*']\n", triggers)
        self.assertNotIn("branches", triggers)
        self.assertNotIn("dev-preview", release)
        self.assertNotIn("--dev-preview", release)
        self.assertIn('--source-tag "$GITHUB_REF_NAME"', release)
        amd64 = release.split("  publish_amd64:", 1)[1].split("  publish_arm64:", 1)[0]
        self.assertIn("needs.full_regression.result == 'success'", amd64)
        # A regression run on main is advisory: it publishes and gates nothing.
        full = (ROOT / ".github" / "workflows" / "full-regression.yml").read_text()
        self.assertIn("\npermissions:\n  contents: read\n", full)
        self.assertNotIn("packages: write", full)
        self.assertNotIn("id-token", full)


if __name__ == "__main__":
    unittest.main()
