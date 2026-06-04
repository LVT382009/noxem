## Status

Runnable today:

| API | Return | Notes |
| --- | --- | --- |
| `std.env.get(name)` | `Maybe<String>` | Returns a hosted process environment value when present. |
| `std.env.has(name)` | `Bool` | Reports whether a hosted environment variable exists. |
| `std.env.getOr(name, fallback)` | `String` | Returns the environment value or a caller-provided fallback. |
| `std.env.parseBool(name)` | `Maybe<Bool>` | Parses an environment value as `Bool`. |
| `std.env.parseU32(name)` | `Maybe<u32>` | Parses an environment value as `u32`. |

Current limits:

- Dotenv/source composition.
- Secret redaction metadata.
- Rich diagnostics for missing keys, invalid values, and source precedence.

## Example

```zero
pub fn main(world: World) -> Void raises {
    let mode: String = std.env.getOr("ZERO_MODE", "default")
    let verbose: Maybe<Bool> = std.env.parseBool("ZERO_VERBOSE")
    if verbose.has && verbose.value {
        check world.out.write(mode)
        check world.out.write("\n")
    } else {
        check world.out.write("default\n")
    }
}
```

## Design Notes

Environment access is a hosted capability. Non-host targets reject `std.env`
unless they explicitly provide an environment capability.

Diagnostics name the selected target context.
