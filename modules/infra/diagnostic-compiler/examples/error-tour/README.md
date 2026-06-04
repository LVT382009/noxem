# Error Tour

These examples are intentionally copyable diagnostics and repairs for the current compiler slice. They point at real fixtures so docs, tests, and agent guidance stay aligned.

## Hosted Fs On A Non-Host Target

Bad:

```sh
bin/zero check --json --target linux-musl-x64 conformance/native/fail/std-fs-target-unsupported.0
```

Good:

```sh
bin/zero build --target linux-musl-x64 examples/memory-package --out .zero/out/memory-package
```

## Immutable Storage Passed To A Mutable Api

Bad:

```sh
bin/zero check --json conformance/native/fail/mem-copy-immutable-dst.0
```

Good:

```sh
bin/zero check conformance/native/pass/std-mem-copy-fill.0
```

## Missing Std Fs Error Name

Bad:

```sh
bin/zero check --json conformance/native/fail/std-fs-create-error-set-mismatch.0
```

Good:

```sh
bin/zero check conformance/native/pass/std-fs-fallible-resources.0
```

## Unchecked Named-Error Std Fs Call

Bad:

```sh
bin/zero check --json conformance/native/fail/std-fs-unchecked-resource-fallible.0
```

Good:

```sh
bin/zero check conformance/native/pass/std-fs-fallible-resources.0
```

## Inspect Repairs

```sh
bin/zero explain TAR002
bin/zero fix --plan --json --target linux-musl-x64 conformance/native/fail/std-fs-target-unsupported.0
```
