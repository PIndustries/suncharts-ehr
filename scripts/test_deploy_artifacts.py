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
        self.assertNotIn("capability:", manifest)
        self.assertNotIn("__IMAGE_REFERENCE__", manifest)
        self.assertNotIn("bootstrap_password:", manifest)

    def test_mutable_image_tag_is_rejected(self):
        request = json.loads(EXAMPLE.read_text())
        request["image_reference"] = "ghcr.io/pindustries/suncharts-ehr:latest"
        result, _ = self.render(request)
        self.assertEqual(result.returncode, 2)
        self.assertIn("sha256 digest", result.stderr)

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
        self.assertIn("http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}", dockerfile)
        self.assertIn("Acquire::http::Timeout=60", dockerfile)
        self.assertGreaterEqual(dockerfile.count("Acquire::Retries=5"), 4)
        self.assertIn("--mount=type=cache,id=suncharts-ehr-target", dockerfile)

    def test_image_workflow_actions_are_commit_pinned(self):
        workflow = (ROOT / ".github" / "workflows" / "publish-image.yml").read_text()
        uses = [line.split("uses:", 1)[1].split("#", 1)[0].strip() for line in workflow.splitlines() if "uses:" in line]
        self.assertGreaterEqual(len(uses), 7)
        for action in uses:
            self.assertRegex(action, r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}$")
        self.assertIn("cache-from: type=gha,scope=suncharts-ehr-image", workflow)
        self.assertIn("cache-to: type=gha,mode=max,scope=suncharts-ehr-image", workflow)

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
            self.assertEqual(manifest["database"]["schema_revision"], 50)
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
