import json
import subprocess
import tempfile
import unittest
from pathlib import Path


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
        self.assertIn("needs: full_regression", amd64)
        self.assertIn("needs.full_regression.result == 'success'", amd64)
        full = (ROOT / ".github" / "workflows" / "full-regression.yml").read_text()
        self.assertIn("cargo clippy --locked --all-targets -- -D warnings", full)
        self.assertIn("cargo test --locked", full)
        self.assertIn("--test partner_support_sso", full)
        self.assertIn("test_*.cjs", full)

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
            self.assertEqual(manifest["database"]["schema_revision"], 87)
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


if __name__ == "__main__":
    unittest.main()
