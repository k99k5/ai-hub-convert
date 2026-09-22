#!/usr/bin/env python3
"""Docker boundary fixture; tests still run real Bash, Git, locks and snapshots."""
import json
import os
import pathlib
import sys

args = sys.argv[1:]
directory = pathlib.Path(os.environ["DOCKER_TEST_STATE"])
state_path = directory / "state.json"
state = json.loads(state_path.read_text())
with (directory / "commands.jsonl").open("a") as log:
    log.write(json.dumps(args) + "\n")


def finish(code=0, output=None):
    temporary = state_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state))
    temporary.replace(state_path)
    if output is not None:
        print(output)
    sys.exit(code)


old_image = "sha256:" + "a" * 64
new_image = "sha256:" + "b" * 64
if args[0] == "info":
    finish()
if args[:3] == ["compose", "up", "--help"]:
    finish(output="--wait --wait-timeout")
if args[0] == "inspect":
    if args[-1] != state["container"]:
        finish(1)
    fmt = args[args.index("--format") + 1] if "--format" in args else ""
    if "com.docker.compose.project" in fmt:
        finish(output="fixture")
    if fmt == "{{.Image}}":
        finish(output=state["image"])
    if "Health" in fmt:
        finish(output="true " + ("healthy" if state["healthy"] else "unhealthy"))
    if "Running" in fmt:
        finish(output="true")
    finish(output="[]")
if args[0] == "ps":
    finish(output=state["container"])
if args[:2] == ["image", "tag"]:
    state["tags"][args[-1]] = args[-2]
    finish()
if args[:2] == ["image", "inspect"]:
    image = state["tags"].get(args[-1])
    finish(0 if image else 1, image)
if args[0] == "exec":
    if state["mode"] == "no-control" or args[3] != state["container"]:
        finish(1)
    operation = args[-1]
    if operation == "drain":
        state["draining"] = True
    elif operation == "resume":
        state["draining"] = False
        state["resumed"] += 1
    elif state["draining"] and state["mode"] not in ("busy", "interrupt"):
        state["active"] = max(0, state["active"] - 1)
    finish(output=json.dumps({"version": 1, "pid": 1, "draining": state["draining"], "activeRequests": state["active"]}))
if args[0] == "compose":
    commands = ("config", "ps", "build", "up")
    command = next((part for part in args[1:] if part in commands), None)
    recovery = any(part.endswith("/compose.json") for part in args)
    if command == "config":
        if "--format" in args:
            finish(output=json.dumps({
                "name": "fixture", "services": {"gateway": {
                    "build": {"context": str(pathlib.Path.cwd()), "dockerfile": "Dockerfile"},
                    "environment": {"UPSTREAM_BASE_URL": "https://upstream.test/v1", "LITERAL": "secret$${KEEP}$cash"},
                    "ports": [{"target": 3000, "published": "3000", "protocol": "tcp"}],
                }},
            }))
        finish()
    if command == "ps":
        finish(output=state["container"])
    if command == "build":
        if state["mode"] == "build-failure":
            finish(11)
        state["built"] = True
        finish()
    if command == "up":
        # Central safety assertion: never replace a container with accepted work.
        if state["active"] != 0 or not state["draining"]:
            print("REPLACED BEFORE DRAIN COMPLETED", file=sys.stderr)
            finish(90)
        assert "--no-deps" in args and "--no-build" in args and "--wait" in args
        assert args[args.index("--pull") + 1] == "never"
        if recovery:
            if state["mode"] == "rollback-failure":
                finish(13)
            state.update(container="restored", image=old_image, healthy=True, draining=False)
            state["restores"] += 1
        else:
            state.update(container="new", image=new_image, draining=False)
            state["replacements"] += 1
            if state["mode"] in ("health-failure", "rollback-failure"):
                state["healthy"] = False
                finish(12)
        finish()
print("Unexpected Docker command: " + repr(args), file=sys.stderr)
finish(99)
