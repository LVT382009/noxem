# Enron Emails Benchmark

A comprehensive RAG benchmark for evaluating LEANN search and generation on the Enron email corpus. It mirrors the structure and CLI of the existing FinanceBench and LAION benches, using stage-based evaluation with Recall@3 and generation timing.

- Dataset: Enron email CSV (e.g., Kaggle wcukierski/enron-email-dataset) for passages
- Queries: corbt/enron_emails_sample_questions (filtered for realistic questions)
- Metrics: Recall@3 vs FAISS Flat baseline + Generation evaluation with Qwen3-8B

## Layout

benchmarks/enron_emails/
- setup_enron_emails.py: Prepare passages, build LEANN index, build FAISS baseline
- evaluate_enron_emails.py: Evaluate retrieval recall (Stages 2-5) + generation with Qwen3-8B
- data/: Generated passages, queries, embeddings-related files
- baseline/: FAISS Flat baseline files
- llm_utils.py: LLM utilities for Qwen3-8B generation (in parent directory)

## Quickstart

1) Prepare the data and index

cd benchmarks/enron_emails
python setup_enron_emails.py --data-dir data

Notes:
- If `--emails-csv` is omitted, the script attempts to download from Kaggle dataset `wcukierski/enron-email-dataset` using Kaggle API (requires `KAGGLE_USERNAME` and `KAGGLE_KEY`).
  Alternatively, pass a local path to `--emails-csv`.

Notes:
- The script parses emails, chunks header/body into passages, builds a compact LEANN index, and then builds a FAISS Flat baseline from the same passages and embedding model.
- Optionally, it will also create evaluation queries from HuggingFace dataset `corbt/enron_emails_sample_questions`.

2) Run recall evaluation (Stage 2)

python evaluate_enron_emails.py --index data/enron_index_hnsw.leann --stage 2

3) Complexity sweep (Stage 3)

python evaluate_enron_emails.py --index data/enron_index_hnsw.leann --stage 3 --target-recall 0.90 --max-queries 200

Stage 3 uses binary search over complexity to find the minimal value achieving the target Recall@3 (assumes recall is non-decreasing with complexity). The search expands the upper bound as needed and snaps complexity to multiples of 8.

4) Index comparison (Stage 4)

python evaluate_enron_emails.py --index data/enron_index_hnsw.leann --stage 4 --complexity 88 --max-queries 100 --output results.json

5) Generation evaluation (Stage 5)

python evaluate_enron_emails.py --index data/enron_index_hnsw.leann --stage 5 --complexity 88 --llm-backend hf --model-name Qwen/Qwen3-8B

6) Combined index + generation evaluation (Stages 4+5, recommended)

python evaluate_enron_emails.py --index data/enron_index_hnsw.leann --stage 45 --complexity 88 --llm-backend hf

Notes:
- Minimal CLI: you can run from repo root with only `--index`, defaults match financebench/laion patterns:
  - `--stage` defaults to `all` (runs 2, 3, 4, 5)
  - `--baseline-dir` defaults to `baseline`
  - `--queries` defaults to `data/evaluation_queries.jsonl` (or falls back to the index directory)
  - `--llm-backend` defaults to `hf` (HuggingFace), can use `vllm`
  - `--model-name` defaults to `Qwen/Qwen3-8B`
- Fail-fast behavior: no silent fallbacks. If compact index cannot run with recompute, it errors out.
- Stage 5 requires Stage 4 retrieval results. Use `--stage 45` to run both efficiently.

Optional flags:
- --queries data/evaluation_queries.jsonl (custom queries file)
- --baseline-dir baseline (where FAISS baseline lives)
- --complexity 88 (LEANN complexity parameter, optimal for 90% recall)
- --llm-backend hf|vllm (LLM backend for generation)
- --model-name Qwen/Qwen3-8B (LLM model for generation)
- --max-queries 1000 (limit number of queries for evaluation)

## Files Produced
- data/enron_passages_preview.jsonl: Small preview of passages used (for inspection)
- data/enron_index_hnsw.leann.*: LEANN index files
- baseline/faiss_flat.index + baseline/metadata.pkl: FAISS baseline with passage IDs
- data/evaluation_queries.jsonl: Query file (id + query; includes GT IDs for reference)

## Notes
- Evaluates both retrieval Recall@3 and generation timing with Qwen3-8B thinking model.
- The emails CSV must contain a column named "message" (raw RFC822 email) and a column named "file" for source identifier. Message-ID headers are parsed as canonical message IDs when present.
- Qwen3-8B requires special handling for thinking models with chat templates and <think></think> tag processing.

## Stages Summary

- Stage 2 (Recall@3):
  - Compares LEANN vs FAISS Flat baseline on Recall@3.
  - Compact index runs with `recompute_embeddings=True`.

- Stage 3 (Binary Search for Complexity):
  - Builds a non-compact index (`<index>_noncompact.leann`) and runs binary search with `recompute_embeddings=False` to find the minimal complexity achieving target Recall@3 (default 90%).

- Stage 4 (Index Comparison):
  - Reports .index-only sizes for compact vs non-compact.
  - Measures timings on queries by default: non-compact (no recompute) vs compact (with recompute).
  - Stores retrieval results for Stage 5 generation evaluation.
  - Fails fast if compact recompute cannot run.
  - If `--complexity` is not provided, the script tries to use the best complexity from Stage 3:
    - First from the current run (when running `--stage all`), otherwise
    - From `enron_stage3_results.json` saved next to the index during the last Stage 3 run.
    - If neither exists, Stage 4 will error and ask you to run Stage 3 or pass `--complexity`.

- Stage 5 (Generation Evaluation):
  - Uses Qwen3-8B thinking model for RAG generation on retrieved documents from Stage 4.
  - Supports HuggingFace (`hf`) and vLLM (`vllm`) backends.
  - Measures generation timing separately from search timing.
  - Requires Stage 4 results (no additional searching performed).

## Example Results

These are sample results obtained on Enron data using all-mpnet-base-v2 and Qwen3-8B.

- Stage 3 (Binary Search):
  - Minimal complexity achieving 90% Recall@3: 88
  - Sampled points:
    - C=8 → 59.9% Recall@3
    - C=72 → 89.4% Recall@3
    - C=88 → 90.2% Recall@3
    - C=96 → 90.7% Recall@3
    - C=112 → 91.1% Recall@3
    - C=136 → 91.3% Recall@3
    - C=256 → 92.0% Recall@3

- Stage 4 (Index Sizes, .index only):
  - Compact: ~2.2 MB
  - Non-compact: ~82.0 MB
  - Storage saving by compact: ~97.3%

- Stage 4 (Search Timing, 988 queries, complexity=88):
  - Non-compact (no recompute): ~0.0075 s avg per query
  - Compact (with recompute): ~1.981 s avg per query
  - Speed ratio (non-compact/compact): ~0.0038x

- Stage 5 (RAG Generation, 988 queries, Qwen3-8B):
  - Average generation time: ~22.302 s per query
  - Total queries processed: 988
  - LLM backend: HuggingFace transformers
  - Model: Qwen/Qwen3-8B (thinking model with <think></think> processing)

Full JSON output is saved by the script (see `--output`), e.g.:
`benchmarks/enron_emails/results_enron_stage45.json`.
