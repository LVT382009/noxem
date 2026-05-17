from urllib.parse import urlparse
"""Noxem CLI — hermes noxem status, config, search, advisor."""

import json
import os
import urllib.parse
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

SERVER_DEFAULT = "http://127.0.0.1:3001"


def _get_server():
    return os.environ.get("NOXEM_SERVER", SERVER_DEFAULT)


def _api_get(path):
    base = _get_server()
    scheme = urlparse(base).scheme
    if scheme not in ("http", "https"):
        return {"error": f"Invalid server URL scheme: {scheme}. Must be http or https."}
    url = f"{base}{path}"
    try:
        with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=5) as r:
            return json.loads(r.read().decode())
    except URLError as e:
        return {"error": str(e)}


def _safe_float(v, default=0.0):
    try:
        return float(v) if v is not None else default
    except (ValueError, TypeError):
        return default


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
    _truncated_query = args.query[:500]  # P-#34
    data = _api_get(f"/memory/search?q={urllib.parse.quote(_truncated_query, safe='')}&limit={args.limit}")
    results = data.get("results", [])
    if not results:
        print("No memories found.")
        return
    print(f"Found {len(results)} memories:")
    for i, m in enumerate(results, 1):
        score = _safe_float(m.get('score'))  # P-#33
        print(f"\n  [{i}] ({m.get('type', '?')}) [rel: {score:.2f}]")
        print(f"      {m.get('text', '')[:200]}")
        print(f"      session: {m.get('session_id', '')[:20]}")


def _cmd_advice(args):
    """Get advisor analysis."""
    data = _api_get("/memory/advisor/analysis")
    if "error" in data:  # P-#35
        print(f"Error: {data['error']}")
        return
    print(data.get("analysis", "No advisor analysis available."))


def _cmd_config(args):
    """Show current config."""
    config_path = Path.home() / ".hermes" / "noxem.json"
    if config_path.exists():
        print(config_path.read_text())
    else:
        print("No noxem.json config found. Run `hermes memory setup` first.")


def _cmd_run(args):
    """Run maintenance manually. The POST endpoint triggers maintenance without requiring a body."""
    result = _api_post("/memory/maintenance/run")
    print(f"Maintenance: {json.dumps(result, indent=2)}")


def _api_post(path, body=None):
    """POST to the Noxem server. body=None sends empty JSON (for trigger endpoints like maintenance/run)."""
    base = _get_server()
    scheme = urlparse(base).scheme
    if scheme not in ("http", "https"):
        return {"error": f"Invalid server URL scheme: {scheme}. Must be http or https."}
    url = f"{base}{path}"
    data = json.dumps(body or {}).encode()
    try:
        with urlopen(Request(url, data=data, headers={"Content-Type": "application/json"}), timeout=30) as r:
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