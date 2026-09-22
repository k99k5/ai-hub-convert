#!/usr/bin/env python3
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

SOURCE = Path(__file__).resolve().parents[2]
OLD_IMAGE = "sha256:" + "a" * 64


class DockerUpdateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gateway-update-test-")
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.repo = base / "checkout with spaces"
        self.repo.mkdir()
        self.state_dir = base / "docker"
        self.state_dir.mkdir()
        self.state_path = self.state_dir / "state.json"
        self.state_path.write_text(json.dumps({
            "mode": "ok", "container": "old", "image": OLD_IMAGE, "tags": {},
            "healthy": True, "draining": False, "active": 0, "built": False,
            "replacements": 0, "restores": 0, "resumed": 0,
        }))
        binary = base / "bin"
        binary.mkdir()
        shutil.copyfile(SOURCE / "test/scripts/fake-docker.py", binary / "docker")
        (binary / "docker").chmod(0o755)
        # Keep failure tests quick; Bash SECONDS still measures the real deadline.
        (binary / "sleep").write_text("#!/bin/sh\n/bin/sleep 0.02\n")
        (binary / "sleep").chmod(0o755)
        self.env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"],
                        DOCKER_TEST_STATE=str(self.state_dir))
        for key in ("COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_ENV_FILES"):
            self.env.pop(key, None)
        (self.repo / "scripts").mkdir()
        shutil.copyfile(SOURCE / "scripts/docker-update.sh", self.repo / "scripts/docker-update.sh")
        (self.repo / ".gitignore").write_text(".env\n.docker-update/\n")
        (self.repo / "Dockerfile").write_text("FROM example\n")
        (self.repo / ".env").write_text("UPSTREAM_BASE_URL=https://upstream.test/v1\nKEEP=secret$${KEEP}$cash\n")
        self.original_env = (self.repo / ".env").read_bytes()
        self.git("init")
        self.git("symbolic-ref", "HEAD", "refs/heads/master")
        self.git("config", "user.email", "fixture@example.test")
        self.git("config", "user.name", "Fixture")
        self.git("add", ".")
        self.git("commit", "-m", "initial fixture")
        self.remote = base / "remote.git"
        subprocess.run(["git", "init", "--bare", str(self.remote)], check=True, capture_output=True)
        self.git("remote", "add", "origin", str(self.remote))
        self.git("push", "--set-upstream", "origin", "master")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, env=self.env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def state(self, **changes):
        state = json.loads(self.state_path.read_text())
        if changes:
            state.update(changes)
            self.state_path.write_text(json.dumps(state))
        return state

    def run_update(self, *args):
        return subprocess.run(["bash", "scripts/docker-update.sh", *args], cwd=self.repo,
                              env=self.env, capture_output=True, text=True, timeout=15)

    def backup(self):
        return next((self.repo / ".docker-update/backups").iterdir())

    def test_waits_for_last_request_and_preserves_private_rollback_snapshot(self):
        self.state(active=3)
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        state = self.state()
        self.assertEqual(state["replacements"], 1)
        self.assertEqual(state["active"], 0)
        self.assertFalse(state["draining"])
        self.assertTrue(state["built"])
        self.assertEqual((self.repo / ".env").read_bytes(), self.original_env)
        backup = self.backup()
        config = json.loads((backup / "compose.json").read_text())
        self.assertNotIn("build", config["services"]["gateway"])
        self.assertEqual(config["services"]["gateway"]["environment"]["LITERAL"], "secret$$$${KEEP}$$cash")
        self.assertEqual((backup / "compose.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertNotIn("secret", result.stdout + result.stderr)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_build_failure_leaves_old_gateway_accepting_requests(self):
        self.state(mode="build-failure", active=2)
        result = self.run_update()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state()["container"], "old")
        self.assertFalse(self.state()["draining"])
        self.assertEqual(self.state()["active"], 2)
        self.assertEqual(self.state()["replacements"], 0)

    def test_drain_deadline_cancels_update_and_resumes_old_gateway(self):
        self.state(mode="busy", active=2)
        result = self.run_update("--drain-timeout", "1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("will not be killed", result.stderr)
        self.assertEqual(self.state()["replacements"], 0)
        self.assertFalse(self.state()["draining"])
        self.assertEqual(self.state()["active"], 2)
        self.assertEqual(self.state()["resumed"], 1)

    def test_signal_during_drain_resumes_without_replacing(self):
        self.state(mode="interrupt", active=1)
        process = subprocess.Popen(["bash", "scripts/docker-update.sh"], cwd=self.repo,
                                   env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 8
            while not self.state()["draining"]:
                self.assertIsNone(process.poll())
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.02)
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=8)
            self.assertEqual(process.returncode, 143, stdout + stderr)
            self.assertEqual(self.state()["replacements"], 0)
            self.assertFalse(self.state()["draining"])
            self.assertEqual(self.state()["active"], 1)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_failed_healthcheck_restores_exact_old_image(self):
        self.state(mode="health-failure")
        result = self.run_update()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state()["restores"], 1, result.stderr)
        self.assertEqual(self.state()["image"], OLD_IMAGE)
        self.assertTrue(self.state()["healthy"])
        self.assertFalse(self.state()["draining"])

    def test_failed_rollback_is_reported_as_failure(self):
        self.state(mode="rollback-failure")
        result = self.run_update()
        self.assertEqual(result.returncode, 2)
        self.assertIn("AUTOMATIC ROLLBACK FAILED", result.stderr)
        self.assertEqual(self.state()["restores"], 0)

    def test_manual_rollback_also_drains_current_requests(self):
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.state(active=2)
        result = self.run_update("--rollback", str(self.backup()))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state()["image"], OLD_IMAGE)
        self.assertEqual(self.state()["active"], 0)

    def test_refuses_images_without_drain_control(self):
        self.state(mode="no-control", active=1)
        result = self.run_update()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no container was stopped", result.stderr)
        self.assertEqual(self.state()["replacements"], 0)
        self.assertFalse(self.state()["built"])

    def test_dirty_checkout_and_parallel_updates_are_rejected(self):
        (self.repo / "Dockerfile").write_text("local changes\n")
        result = self.run_update()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("dirty", result.stderr)
        self.assertFalse(self.state()["built"])
        self.git("checkout", "--", "Dockerfile")
        with (self.repo / ".docker-update/update.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_update()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("already running", result.stderr)

    def test_git_pull_can_replace_script_without_changing_current_execution(self):
        writer = Path(self.temp.name) / "writer"
        subprocess.run(["git", "clone", str(self.remote), str(writer)], check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "fixture@example.test"], cwd=writer, check=True)
        subprocess.run(["git", "config", "user.name", "Fixture"], cwd=writer, check=True)
        (writer / "scripts/docker-update.sh").write_text("#!/bin/bash\nexit 97\n")
        subprocess.run(["git", "commit", "-am", "replace script"], cwd=writer, check=True, capture_output=True)
        subprocess.run(["git", "push"], cwd=writer, check=True, capture_output=True)
        before = self.git("rev-parse", "HEAD")
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(before, self.git("rev-parse", "HEAD"))
        self.assertEqual(self.state()["replacements"], 1)

    def test_no_pull_accepts_a_clean_detached_commit(self):
        self.git("checkout", "--detach")
        result = self.run_update("--no-pull")
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
