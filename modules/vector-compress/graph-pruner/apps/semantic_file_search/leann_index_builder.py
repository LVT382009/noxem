#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from leann import LeannBuilder


def process_json_items(json_file_path):
    """Load and process JSON file with metadata items"""

    with open(json_file_path, encoding="utf-8") as f:
        items = json.load(f)

    # Guard against empty JSON
    if not items:
        print("⚠️  No items found in the JSON file. Exiting gracefully.")
        return

    INDEX_PATH = str(Path("./").resolve() / "demo.leann")
    builder = LeannBuilder(backend_name="hnsw", is_recompute=False)

    total_items = len(items)
    items_added = 0
    print(f"Processing {total_items} items...")

    for idx, item in enumerate(items):
        try:
            # Create embedding text sentence
            embedding_text = f"{item.get('Name', 'unknown')} located at {item.get('Path', 'unknown')} and size {item.get('Size', 'unknown')} bytes with content type {item.get('ContentType', 'unknown')} and kind {item.get('Kind', 'unknown')}"

            # Prepare metadata with dates
            metadata = {}
            if "CreationDate" in item:
                metadata["creation_date"] = item["CreationDate"]
            if "ContentChangeDate" in item:
                metadata["modification_date"] = item["ContentChangeDate"]

            # Add to builder
            builder.add_text(embedding_text, metadata=metadata)
            items_added += 1

        except Exception as e:
            print(f"\n⚠️  Warning: Failed to process item {idx}: {e}")
            continue

        # Show progress
        progress = (idx + 1) / total_items * 100
        sys.stdout.write(f"\rProgress: {idx + 1}/{total_items} ({progress:.1f}%)")
        sys.stdout.flush()

    print()  # New line after progress

    # Guard against no successfully added items
    if items_added == 0:
        print("⚠️  No items were successfully added to the index. Exiting gracefully.")
        return

    print(f"\n✅ Successfully processed {items_added}/{total_items} items")
    print("Building index...")

    try:
        builder.build_index(INDEX_PATH)
        print(f"✓ Index saved to {INDEX_PATH}")
    except ValueError as e:
        if "No chunks added" in str(e):
            print("⚠️  No chunks were added to the builder. Index not created.")
        else:
            raise


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python build_index.py <json_file>")
        sys.exit(1)

    json_file = sys.argv[1]
    if not Path(json_file).exists():
        print(f"Error: File {json_file} not found")
        sys.exit(1)

    process_json_items(json_file)
