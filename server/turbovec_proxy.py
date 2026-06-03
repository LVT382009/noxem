#!/usr/bin/env python3
"""
TurboVec Proxy — FastAPI sidecar for high-performance vector KNN search.

Wraps turbovec.IdMapIndex with HTTP endpoints for add/search/remove/save.
Uses numpy for vector I/O, .tvim file for persistence.

Endpoints:
  POST /add       — add vectors with ids
  POST /search    — search with optional allowlist
  POST /remove/{id} — remove a vector by id
  POST /save      — persist index to .tvim file
  GET  /health    — liveness + stats
"""

import os
import sys
import json
import asyncio
import numpy as np

try:
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from pydantic import BaseModel
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False

try:
    import turbovec
    from turbovec import IdMapIndex
    HAS_TURBOVEC = True
except ImportError:
    HAS_TURBOVEC = False

# ── Config ───────────────────────────────────────────────

EMBED_DIM = int(os.environ.get("EMBEDDING_DIM", "256"))
BIT_WIDTH = int(os.environ.get("TURBOVEC_BIT_WIDTH", "4"))
TVIM_PATH = os.environ.get("TURBOVEC_TVIM_PATH", "data/turbovec_index.tvim")
PORT = int(os.environ.get("TURBOVEC_PORT", "3003"))

# ── Index State ──────────────────────────────────────────

index = None

def ensure_index():
    global index
    if index is not None:
        return

    if not HAS_TURBOVEC:
        print("[TurboVec] turbovec package not installed", file=sys.stderr)
        return

    # Try loading existing index
    if os.path.exists(TVIM_PATH):
        try:
            index = IdMapIndex.load(TVIM_PATH)
            print(f"[TurboVec] Loaded existing index: dim={index.dim}, count={len(index)}", file=sys.stderr)
            return
        except Exception as e:
            print(f"[TurboVec] Load failed, creating fresh: {e}", file=sys.stderr)

    # Create fresh index
    index = IdMapIndex(dim=EMBED_DIM, bit_width=BIT_WIDTH)
    index.prepare()
    print(f"[TurboVec] Fresh index created: dim={EMBED_DIM}, bit_width={BIT_WIDTH}", file=sys.stderr)


def ensure_tvim_dir():
    d = os.path.dirname(TVIM_PATH)
    if d and not os.path.exists(d):
        os.makedirs(d, exist_ok=True)


# ── FastAPI App ──────────────────────────────────────────

if not HAS_FASTAPI:
    print("[TurboVec] FastAPI not installed. Install: pip install fastapi uvicorn", file=sys.stderr)
    sys.exit(1)

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    ensure_index()
    yield

app = FastAPI(title="TurboVec Proxy", version="1.0.0", lifespan=lifespan)


# ── Models ───────────────────────────────────────────────

class AddRequest(BaseModel):
    ids: list[int]
    vectors: list[list[float]]

class SearchRequest(BaseModel):
    query: list[float]
    k: int = 10
    allowlist: list[int] | None = None

class SaveResponse(BaseModel):
    ok: bool
    path: str
    count: int


# ── Endpoints ────────────────────────────────────────────

@app.get("/health")
async def health():
    stats = {
        "ok": index is not None,
        "turbovec_installed": HAS_TURBOVEC,
        "index_loaded": index is not None,
        "dim": index.dim if index else None,
        "count": len(index) if index else 0,
        "tvim_path": TVIM_PATH,
        "tvim_exists": os.path.exists(TVIM_PATH),
    }
    return JSONResponse(stats)


@app.post("/add")
async def add_vectors(req: AddRequest):
    if index is None:
        return JSONResponse({"error": "index not ready"}, status_code=503)

    if len(req.ids) != len(req.vectors):
        return JSONResponse({"error": "ids and vectors must have same length"}, status_code=400)

    try:
        ids = np.array(req.ids, dtype=np.uint64)
        vectors = np.array(req.vectors, dtype=np.float32)
        index.add_with_ids(vectors, ids)
        return {"ok": True, "added": len(req.ids), "total": len(index)}
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/search")
async def search_vectors(req: SearchRequest):
    if index is None:
        return JSONResponse({"error": "index not ready"}, status_code=503)

    try:
        query = np.array([req.query], dtype=np.float32)
        allowlist = None
        if req.allowlist:
            allowlist = np.array(req.allowlist, dtype=np.uint64)

        scores, ids = index.search(query, k=req.k, allowlist=allowlist)

        # Convert to serializable format
        results = []
        for s_row, id_row in zip(scores, ids):
            for score, id_val in zip(s_row, id_row):
                results.append({"id": int(id_val), "score": float(score)})

        return {"ok": True, "results": results, "count": len(results)}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/remove/{id}")
async def remove_vector(id: int):
    if index is None:
        return JSONResponse({"error": "index not ready"}, status_code=503)

    try:
        removed = index.remove(id)
        return {"ok": True, "removed": removed, "total": len(index)}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/save")
async def save_index():
    if index is None:
        return JSONResponse({"error": "index not ready"}, status_code=503)

    try:
        ensure_tvim_dir()
        index.write(TVIM_PATH)
        return {"ok": True, "path": TVIM_PATH, "count": len(index)}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Run ──────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
