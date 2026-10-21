#!/usr/bin/env python3
"""Run one workspace skill through wiki-manager headless mode."""

import argparse
import json
import os
import subprocess
from pathlib import Path


def workspace_name(path: Path) -> str | None:
    env_file = path / ".env"
    if not env_file.is_file():
        return None
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if line.startswith("WORKSPACE_NAME="):
            return line.split("=", 1)[1].strip().strip("'\"")
    return path.name


def find_manager_home(workspace_path: Path | None) -> Path | None:
    values = [
        os.environ.get("WIKI_MANAGER_STATE_DIR"),
        os.environ.get("LLM_WIKI_MANAGER_HOME"),
    ]
    if workspace_path:
        values.extend(str(parent) for parent in workspace_path.parents)
    for value in values:
        if not value:
            continue
        candidate = Path(value).expanduser().resolve()
        if (candidate / ".env").is_file() or (candidate / "workspaces").is_dir():
            return candidate
    return None


def read_env(path: Path) -> dict[str, str]:
    values = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")
    return values


def list_workspaces(manager_home: Path | None) -> list[dict[str, str]]:
    configured = os.environ.get("WIKI_WORKSPACES_DIR")
    root = Path(configured).expanduser() if configured else (
        manager_home / "workspaces" if manager_home else None
    )
    if not root or not root.is_dir():
        return []
    result = []
    for entry in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        env = read_env(entry / ".env")
        if not env:
            continue
        result.append({
            "name": env.get("WORKSPACE_NAME", entry.name),
            "path": env.get("WIKI_WORKSPACE_PATH", str(entry)),
        })
    return result


def bun_command() -> str:
    configured = os.environ.get("BUN_BIN")
    if configured:
        return configured
    bundled = Path.home() / ".bun" / "bin" / "bun"
    return str(bundled) if bundled.is_file() else "bun"


def manager_command(manager_home: Path | None, workspace_path: Path | None) -> list[str]:
    configured = os.environ.get("LLM_WIKI_MANAGER_BIN")
    if configured:
        configured_path = Path(configured).expanduser()
        return [bun_command(), str(configured_path)] if configured_path.suffix == ".js" else [str(configured_path)]

    candidates: list[Path] = []

    if manager_home:
        candidates.append(manager_home / "bin" / "wiki-manager.js")

    engine_home = os.environ.get("LLM_WIKI_ENGINE_HOME")
    if engine_home:
        engine_path = Path(engine_home).expanduser().resolve()
        candidates.append(engine_path.parent / "llm-wiki-manager" / "bin" / "wiki-manager.js")

    if workspace_path:
        for parent in workspace_path.parents:
            candidates.append(parent / "llm-wiki-manager" / "bin" / "wiki-manager.js")

    for candidate in candidates:
        if candidate and candidate.is_file():
            return [bun_command(), str(candidate)]

    return ["wiki-manager"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill", required=True, help="Exact workspace skill name, with optional skill arguments")
    parser.add_argument("--workspace", help="Workspace name; defaults to WORKSPACE_NAME from --workspace-path")
    parser.add_argument("--workspace-path", type=Path, help="Workspace folder used to discover its name")
    parser.add_argument("--manager-home", type=Path, help="wiki-manager state directory")
    parser.add_argument("--manager-bin", help="Path to wiki-manager.js; overrides automatic discovery")
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument("--max-turns", type=int, default=20)
    args = parser.parse_args()

    workspace_path = args.workspace_path or (
        Path(os.environ["WIKI_WORKSPACE_PATH"]).expanduser()
        if os.environ.get("WIKI_WORKSPACE_PATH") else None
    )
    if workspace_path:
        workspace_path = workspace_path.resolve()

    manager_home = (args.manager_home or find_manager_home(workspace_path))
    if manager_home:
        manager_home = manager_home.expanduser().resolve()

    workspaces = list_workspaces(manager_home)
    name = args.workspace or (workspace_name(workspace_path) if workspace_path else None) or os.environ.get("WIKI_WORKSPACE_NAME")
    if name and workspaces:
        match = next((item for item in workspaces if item["name"].lower() == name.lower()), None)
        if match:
            name = match["name"]
            workspace_path = workspace_path or Path(match["path"]).expanduser().resolve()
    if not name:
        if len(workspaces) == 1:
            name = workspaces[0]["name"]
            workspace_path = Path(workspaces[0]["path"]).expanduser().resolve()
        elif len(workspaces) > 1:
            result = {
                "status": "workspace_required",
                "skill": args.skill,
                "workspaces": workspaces,
                "message": "Multiple workspaces are available. Ask which one to use.",
                "exitCode": 2,
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 2
        else:
            raise SystemExit("No workspace found in the wiki-manager registry.")

    if args.manager_bin:
        os.environ["LLM_WIKI_MANAGER_BIN"] = str(Path(args.manager_bin).expanduser())
    command = manager_command(manager_home, workspace_path) + [
        "--headless", "--workspace", name, "--skill", args.skill,
        "--timeout", str(max(1, args.timeout)), "--max-turns", str(max(1, args.max_turns)),
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=str(manager_home) if manager_home else None,
            env={**os.environ, **({"WIKI_MANAGER_STATE_DIR": str(manager_home)} if manager_home else {})},
            capture_output=True,
            text=True,
            timeout=max(1, args.timeout) + 30,
            check=False,
        )
        result = {
            "status": "done" if completed.returncode == 0 else "failed",
            "workspace": name,
            "skill": args.skill,
            "exitCode": completed.returncode,
            "output": completed.stdout.strip(),
            "error": completed.stderr.strip(),
        }
    except subprocess.TimeoutExpired as error:
        result = {
            "status": "timeout",
            "workspace": name,
            "skill": args.skill,
            "exitCode": 124,
            "output": (error.stdout or "").strip() if isinstance(error.stdout, str) else "",
            "error": "The skill run timed out.",
        }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return int(result["exitCode"])


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # return a readable result to the desktop host
        print(json.dumps({"status": "failed", "exitCode": 1, "error": str(error)}, ensure_ascii=False, indent=2))
        raise SystemExit(1)
