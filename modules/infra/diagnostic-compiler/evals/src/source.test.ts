import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractZeroSource,
  finalSourceResponseFailures,
  sourcePatternFailures,
} from "./source.js";

describe("eval source helpers", () => {
  it("extracts fenced Zero code", () => {
    const source = extractZeroSource("```zero\npub fn main() -> Void {}\n```");
    assert.equal(source, "pub fn main() -> Void {}\n");
  });

  it("keeps plain source", () => {
    const source = extractZeroSource("pub fn main() -> Void {}");
    assert.equal(source, "pub fn main() -> Void {}\n");
  });

  it("reports missing source patterns", () => {
    assert.deepEqual(sourcePatternFailures("hello", [/hello/, /zero/]), [
      "/zero/",
    ]);
  });

  it("accepts a source-only final response", () => {
    assert.deepEqual(
      finalSourceResponseFailures("pub fn main() -> Void {}\n", "pub fn main() -> Void {}\n"),
      [],
    );
  });

  it("accepts canonical top-level declaration starts", () => {
    const sources = [
      "use std.fs\n",
      "pub alias ByteCount = usize\n",
      "alias BytePair = Pair<u8, u8>\n",
      "interface Reader {\n}\n",
      "pub interface Writer {\n}\n",
      "extern c \"vendor/math.h\" as math\n",
      "extern type CPoint {\n}\n",
      "pub extern type CHandle {}\n",
      "packed type Header {\n}\n",
      "pub packed type Packet {}\n",
      "export c fn main() -> i32 {\n    return 0\n}\n",
      "pub export c fn zero_main() -> i32 {\n    return 0\n}\n",
    ];

    for (const source of sources) {
      assert.deepEqual(finalSourceResponseFailures(source, source), []);
    }
  });

  it("rejects prose or Markdown around final source", () => {
    assert.deepEqual(
      finalSourceResponseFailures(
        "Here is the source:\n\n```zero\npub fn main() -> Void {}\n```",
        "pub fn main() -> Void {}\n",
      ),
      ["final response included prose or Markdown around the source"],
    );
  });

  it("rejects unfenced prose before source", () => {
    assert.deepEqual(
      finalSourceResponseFailures(
        "The program checks cleanly.\n\npub fn main() -> Void {}",
        "The program checks cleanly.\n\npub fn main() -> Void {}\n",
      ),
      ["final response did not start with Zero source"],
    );
  });
});
