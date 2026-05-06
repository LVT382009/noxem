"""Noxem CLI — hermes noxem status, config, search, advisor."""

import json
import os
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

SERVER_DEFAULT = "http://127.0.0.1:3001"


def _get_server():
    return os.environ.get("NOXEM_SERVER", SERVER_DEFAULT)


def _api_get(path):
    url = f"{_get_server()}{path}"
    try:
        with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=5) as r:
            return json.loads(r.read().decode())
    except URLError as e:
        return {"error": str(e)}


def _cmd_status(args):
    """Show Noxem server status and memory stats."""
    health = _api_get("/health")
    if "error" in health:
        print(f"[Noxem] Server unreachable at {_get_server()}: {health['error']}")
        return

    print("=== Noxem Memory Server ===")
    print(f"  Status:     OK")
    print(f"  URL:        {_get_server()}")
    print(f"  Version:    {health.get('version', '?')}")
    print(f"  Embedding:  {'READY' if health.get('embedding') else 'NOT LOADED'}")
    print(f"  Advisor:    {'ENABLED' if health.get('advisor') else 'DISABLED'}")
    print(f"  Mode:       {health.get('mode', '?')}")

    stats = _api_get("/memory/stats")
    if "error" not in stats:
        print(f"\n  Memory Stats:")
        print(f"    Active: {stats.get('active', '?')} memories")
        for row in stats.get("breakdown", []):
            print(f"      [{row['status']}] {row['type']}: {row['count']}")


def _cmd_search(args):
    """Search memories."""
    if not args.query:
        print("Usage: hermes noxem search <query>")
        return
    data = _api_get(f"/memory/search?q={args.query}&limit={args.limit}")
    results = data.get("results", [])
    if not results:
        print("No memories found.")
        return
    print(f"Found {len(results)} memories:")
    for i, m in enumerate(results, 1):
        print(f"\n  [{i}] ({m.get('type', '?')}) [rel: {m.get('score', 0):.2f}]")
        print(f"      {m.get('text', '')[:200]}")
        print(f"      session: {m.get('session_id', '')[:20]}")


def _cmd_advice(args):
    """Get advisor analysis."""
    data = _api_get("/memory/advisor/analysis")
    print(data.get("analysis", "No advisor analysis available."))


def _cmd_config(args):
    """Show current config."""
    config_path = Path.home() / ".hermes" / "noxem.json"
    if config_path.exists():
        print(config_path.read_text())
    else:
        print("No noxem.json config found. Run `hermes memory setup` first.")


def _cmd_run(args):
    """Run maintenance manually."""
    result = _api_post("/memory/maintenance/run")
    print(f"Maintenance: {json.dumps(result, indent=2)}")


def _api_post(path):
    import urllib.parse
    url = f"{_get_server()}{path}"
    try:
        with urlopen(Request(url, data=b"{}", headers={"Content-Type": "application/json"}), timeout=30) as r:
            return json.loads(r.read().decode())
    except URLError as e:
        return {"error": str(e)}


def register_cli(subparser) -> None:
    """Build the hermes noxem argparse tree."""
    subs = subparser.add_subparsers(dest="noxem_command")

    p_status = subs.add_parser("status", help="Show server status and memory stats")
    p_status.set_defaults(func=_cmd_status)

    p_search = subs.add_parser("search", help="Search memories")
    p_search.add_argument("query", help="Search query")
    p_search.add_argument("--limit", "-l", type=int, default=10)
    p_search.set_defaults(func=_cmd_search)

    p_advice = subs.add_parser("advice", help="Show advisor analysis")
    p_advice.set_defaults(func=_cmd_advice)

    p_config = subs.add_parser("config", help="Show noxem config")
    p_config.set_defaults(func=_cmd_config)

    p_run = subs.add_parser("run", help="Run maintenance manually")
    p_run.set_defaults(func=_cmd_run)

    subparser.set_defaults(func=lambda args: print("Usage: hermes noxem <status|search|advice|config|run>"))