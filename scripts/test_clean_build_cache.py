# SPDX-License-Identifier: AGPL-3.0-only
import fcntl
import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest
import subprocess
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cache", Path(__file__).with_name("clean_build_cache.py"))
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class CacheMaintenance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / "Cargo.toml").write_text('[package]\nname="suncharts-engine"\nversion="0.1.0"\n')
        self.profile = self.root / "target/debug"
        self.artifact = self.profile / "deps/compiler-cache"
        self.artifact.parent.mkdir(parents=True)
        self.artifact.write_bytes(b"cache" * 100)
        self.executable = self.profile / "suncharts-engine"
        self.executable.write_bytes(b"keep executable")
        self.source = self.root / "src/main.rs"
        self.source.parent.mkdir()
        self.source.write_text("keep source")
        self.key = self.root / ".suncharts/provider-master.key"
        self.key.parent.mkdir()
        self.key.write_text("synthetic canary")

    def run_clean(self, **kwargs):
        return cache.clean([self.root], min_free=0, max_bytes=1, **kwargs)

    def test_dry_run_preserves_everything(self):
        result = self.run_clean()
        self.assertEqual(result["planned_bytes"], 500)
        self.assertTrue(self.artifact.exists())
        self.assertEqual(result["removed_bytes"], 0)

    def test_budget_retains_executable_source_and_settings(self):
        result = self.run_clean(apply=True)
        self.assertFalse(self.artifact.exists())
        self.assertEqual(result["removed_bytes"], 500)
        self.assertEqual(self.executable.read_bytes(), b"keep executable")
        self.assertEqual(self.source.read_text(), "keep source")
        self.assertEqual(self.key.read_text(), "synthetic canary")
        self.assertTrue((self.profile / ".cargo-lock").exists())

    def test_active_cargo_lock_skips_profile(self):
        with (self.profile / ".cargo-lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_clean(apply=True)
            self.assertTrue(self.artifact.exists())
            self.assertEqual(result["items"][0]["status"], "active_build_skipped")

    def test_expired_but_small_cache_is_removed(self):
        old = time.time() - 8 * 86400
        os.utime(self.artifact, (old, old))
        os.utime(self.artifact.parent, (old, old))
        result = cache.clean([self.root], apply=True, min_free=0)
        self.assertEqual(result["items"][0]["reason"], "expired")
        self.assertFalse(self.artifact.exists())

    def test_young_small_cache_is_kept(self):
        cache.clean([self.root], apply=True, min_free=0)
        self.assertTrue(self.artifact.exists())

    def test_low_disk_cleans_scoped_cache_even_below_budget(self):
        with patch.object(cache.shutil, "disk_usage", return_value=type("Disk", (), {"free": 0})()):
            result = cache.clean([self.root], apply=True, min_free=1)
        self.assertEqual(result["items"][0]["reason"], "low_disk")
        self.assertTrue(self.executable.exists())

    def test_registered_worktrees_are_discovered_without_directory_scanning(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "-C", str(self.root), "add", "Cargo.toml"], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], check=True)
        other = self.root / "worktree"
        subprocess.run(["git", "-C", str(self.root), "worktree", "add", "-q", "--detach", str(other)], check=True)
        self.assertEqual(cache.worktree_projects([self.root]), [self.root, other])

    def test_symlink_inside_cache_never_deletes_destination(self):
        outside = self.root / "outside"
        outside.mkdir()
        canary = outside / "preserve"
        canary.write_text("safe")
        (self.artifact.parent / "link").symlink_to(outside, target_is_directory=True)
        self.run_clean(apply=True)
        self.assertEqual(canary.read_text(), "safe")

    def test_target_symlink_is_rejected_before_any_cleanup(self):
        other = self.root / "other"
        other.mkdir()
        (other / "Cargo.toml").write_text((self.root / "Cargo.toml").read_text())
        (other / "target").symlink_to(self.root / "target", target_is_directory=True)
        with self.assertRaises(ValueError):
            cache.clean([self.root, other], apply=True, max_bytes=1, min_free=0)
        self.assertTrue(self.artifact.exists())

    def test_unknown_project_rejected(self):
        (self.root / "Cargo.toml").write_text('[package]\nname="unrelated"\n')
        with self.assertRaises(ValueError):
            self.run_clean(apply=True)
        self.assertTrue(self.artifact.exists())

    def test_symlink_lock_is_rejected(self):
        (self.profile / ".cargo-lock").symlink_to(self.source)
        with self.assertRaises(OSError):
            self.run_clean(apply=True)
        self.assertTrue(self.artifact.exists())

    def test_real_cargo_build_is_not_cleaned(self):
        self.source.write_text("fn main() {}")
        (self.root / "Cargo.toml").write_text('[package]\nname="suncharts-engine"\nversion="0.1.0"\nedition="2021"\n[profile.dev]\ndebug=0\nincremental=false\n')
        (self.root / "build.rs").write_text('fn main() { std::fs::write("building", "ready").unwrap(); std::thread::sleep(std::time::Duration::from_secs(3)); }')
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen(["cargo", "build", "--offline", "--quiet"],
                                       cwd=self.root, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 30
                while not (self.root / "building").exists():
                    if process.poll() is not None or time.monotonic() > deadline:
                        log.seek(0)
                        self.fail(log.read().decode())
                    time.sleep(0.02)
                result = self.run_clean(apply=True)
                self.assertTrue(any(i["status"] == "active_build_skipped" for i in result["items"]))
                self.assertTrue(self.artifact.exists())
                self.assertEqual(process.wait(timeout=20), 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    unittest.main()
