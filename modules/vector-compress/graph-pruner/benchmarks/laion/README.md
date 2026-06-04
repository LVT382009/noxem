# LAION Multimodal Benchmark

A multimodal benchmark for evaluating image retrieval and generation performance using LEANN with CLIP embeddings and Qwen2.5-VL for multimodal generation on LAION dataset subset.

## Overview

This benchmark evaluates:
- **Image retrieval timing** using caption-based queries
- **Recall@K performance** for image search
- **Complexity analysis** across different search parameters
- **Index size and storage efficiency**
- **Multimodal generation** with Qwen2.5-VL for image understanding and description

## Dataset Configuration

- **Dataset**: LAION-400M subset (10,000 images)
- **Embeddings**: Pre-computed CLIP ViT-B/32 (512 dimensions)
- **Queries**: 200 random captions from the dataset
- **Ground Truth**: Self-recall (query caption → original image)

## Quick Start

### 1. Setup the benchmark

```bash
cd benchmarks/laion
python setup_laion.py --num-samples 10000 --num-queries 200
```

This will:
- Create dummy LAION data (10K samples)
- Generate CLIP embeddings (512-dim)
- Build LEANN index with HNSW backend
- Create 200 evaluation queries

### 2. Run evaluation

```bash
# Run all evaluation stages
python evaluate_laion.py --index data/laion_index.leann

# Run specific stages
python evaluate_laion.py --index data/laion_index.leann --stage 2  # Recall evaluation
python evaluate_laion.py --index data/laion_index.leann --stage 3  # Complexity analysis
python evaluate_laion.py --index data/laion_index.leann --stage 4  # Index comparison
python evaluate_laion.py --index data/laion_index.leann --stage 5  # Multimodal generation

# Multimodal generation with Qwen2.5-VL
python evaluate_laion.py --index data/laion_index.leann --stage 5 --model-name Qwen/Qwen2.5-VL-7B-Instruct
```

### 3. Save results

```bash
python evaluate_laion.py --index data/laion_index.leann --output results.json
```

## Configuration Options

### Setup Options
```bash
python setup_laion.py \
  --num-samples 10000 \
  --num-queries 200 \
  --index-path data/laion_index.leann \
  --backend hnsw
```

### Evaluation Options
```bash
python evaluate_laion.py \
  --index data/laion_index.leann \
  --queries data/evaluation_queries.jsonl \
  --complexity 64 \
  --top-k 3 \
  --num-samples 100 \
  --stage all
```

## Evaluation Stages

### Stage 2: Recall Evaluation
- Evaluates Recall@3 for multimodal retrieval
- Compares LEANN vs FAISS baseline performance
- Self-recall: query caption should retrieve original image

### Stage 3: Complexity Analysis
- Binary search for optimal complexity (90% recall target)
- Tests performance across different complexity levels
- Analyzes speed vs. accuracy tradeoffs

### Stage 4: Index Comparison
- Compares compact vs non-compact index sizes
- Measures search performance differences
- Reports storage efficiency and speed ratios

### Stage 5: Multimodal Generation
- Uses Qwen2.5-VL for image understanding and description
- Retrieval-Augmented Generation (RAG) with multimodal context
- Measures both search and generation timing

## Output Metrics

### Timing Metrics
- Average/median/min/max search time
- Standard deviation
- Searches per second
- Latency in milliseconds

### Recall Metrics
- Recall@3 percentage for image retrieval
- Number of queries with ground truth

### Index Metrics
- Total index size (MB)
- Component breakdown (index, passages, metadata)
- Storage savings (compact vs non-compact)
- Backend and embedding model info

### Generation Metrics (Stage 5)
- Average search time per query
- Average generation time per query
- Time distribution (search vs generation)
- Sample multimodal responses
- Model: Qwen2.5-VL performance

## Benchmark Results

### LEANN-RAG Performance (CLIP ViT-L/14 + Qwen2.5-VL)

**Stage 3: Optimal Complexity Analysis**
- **Optimal Complexity**: 85 (achieving 90% Recall@3)
- **Binary Search Range**: 1-128
- **Target Recall**: 90%
- **Index Type**: Non-compact (for fast binary search)

**Stage 5: Multimodal Generation Performance (Qwen2.5-VL)**
- **Total Queries**: 20
- **Average Search Time**: 1.200s per query
- **Average Generation Time**: 6.558s per query
- **Time Distribution**: Search 15.5%, Generation 84.5%
- **LLM Backend**: HuggingFace transformers
- **Model**: Qwen/Qwen2.5-VL-7B-Instruct
- **Optimal Complexity**: 85

**System Performance:**
- **Index Size**: ~10,000 image embeddings from LAION subset
- **Embedding Model**: CLIP ViT-L/14 (768 dimensions)
- **Backend**: HNSW with cosine distance

### Example Results

```
🎯 LAION MULTIMODAL BENCHMARK RESULTS
============================================================

📊 Multimodal Generation Results:
  Total Queries: 20
  Avg Search Time: 1.200s
  Avg Generation Time: 6.558s
  Time Distribution: Search 15.5%, Generation 84.5%
  LLM Backend: HuggingFace transformers
  Model: Qwen/Qwen2.5-VL-7B-Instruct

⚙️ Optimal Complexity Analysis:
  Target Recall: 90%
  Optimal Complexity: 85
  Binary Search Range: 1-128
  Non-compact Index (fast search, no recompute)

🚀 Performance Summary:
  Multimodal RAG: 7.758s total per query
  Search: 15.5% of total time
  Generation: 84.5% of total time
```

## Directory Structure

```
benchmarks/laion/
├── setup_laion.py           # Setup script
├── evaluate_laion.py        # Evaluation script
├── README.md               # This file
└── data/                   # Generated data
    ├── laion_images/       # Image files (placeholder)
    ├── laion_metadata.jsonl # Image metadata
    ├── laion_passages.jsonl # LEANN passages
    ├── laion_embeddings.npy # CLIP embeddings
    ├── evaluation_queries.jsonl # Evaluation queries
    └── laion_index.leann/  # LEANN index files
```

## Notes

- Current implementation uses dummy data for demonstration
- For real LAION data, implement actual download logic in `setup_laion.py`
- CLIP embeddings are randomly generated - replace with real CLIP model for production
- Adjust `num_samples` and `num_queries` based on available resources
- Consider using `--num-samples` during evaluation for faster testing
