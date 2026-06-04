#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const tmpBase = path.join("/tmp", `zero-type-core-smoke-${process.pid}`);
const sourcePath = `${tmpBase}.c`;
const exePath = process.platform === "win32" ? `${tmpBase}.exe` : tmpBase;

const source = String.raw`
#include "type_core.h"
#include "unify.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void expect(int ok, const char *message) {
  if (ok) return;
  fprintf(stderr, "%s\n", message);
  exit(1);
}

static ZTypeId parse_or_die(ZTypeArena *arena, const char *text) {
  ZTypeId type = Z_TYPE_ID_INVALID;
  ZTypeParseError error = {0};
  if (!z_type_parse(arena, text, &type, &error)) {
    fprintf(stderr, "failed to parse '%s': %s at %zu\n", text, error.message, error.offset);
    exit(1);
  }
  return type;
}

static ZTypeId parse_with_binders_or_die(ZTypeArena *arena, const char *text, const ZTypeBinderScope *scope) {
  ZTypeId type = Z_TYPE_ID_INVALID;
  ZTypeParseError error = {0};
  if (!z_type_parse_with_binders(arena, text, scope, &type, &error)) {
    fprintf(stderr, "failed to parse '%s' with binders: %s at %zu\n", text, error.message, error.offset);
    exit(1);
  }
  return type;
}

static void expect_roundtrip(const char *source, const char *expected) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeId type = parse_or_die(&arena, source);
  char *formatted = z_type_format(&arena, type);
  expect(formatted && strcmp(formatted, expected) == 0, "type format mismatch");
  free(formatted);
  z_type_arena_free(&arena);
}

static void expect_static_roundtrip(const char *source, const char *expected, ZStaticValueKind kind) {
  ZStaticValue value = {0};
  ZTypeParseError error = {0};
  if (!z_static_value_parse(source, &value, &error)) {
    fprintf(stderr, "failed to parse static value '%s': %s at %zu\n", source, error.message, error.offset);
    exit(1);
  }
  expect(value.kind == kind, "static value kind mismatch");
  char *formatted = z_static_value_format(&value);
  expect(formatted && strcmp(formatted, expected) == 0, "static value format mismatch");
  free(formatted);
  z_static_value_free(&value);
}

static void expect_invalid_type(const char *source) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeId type = Z_TYPE_ID_INVALID;
  ZTypeParseError error = {0};
  int ok = z_type_parse(&arena, source, &type, &error);
  expect(!ok && type == Z_TYPE_ID_INVALID && error.message[0] != 0, "invalid type parsed successfully");
  expect(arena.len == 0, "failed type parse mutated arena");
  z_type_arena_free(&arena);
}

static void expect_invalid_type_offset(const char *source, size_t offset) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeId type = Z_TYPE_ID_INVALID;
  ZTypeParseError error = {0};
  int ok = z_type_parse(&arena, source, &type, &error);
  expect(!ok && type == Z_TYPE_ID_INVALID && error.message[0] != 0, "invalid type parsed successfully");
  expect(error.offset == offset, "invalid type reported wrong offset");
  expect(arena.len == 0, "failed type parse mutated arena");
  z_type_arena_free(&arena);
}

static void expect_invalid_static(const char *source) {
  ZStaticValue value = {0};
  ZTypeParseError error = {0};
  int ok = z_static_value_parse(source, &value, &error);
  expect(!ok && error.message[0] != 0, "invalid static value parsed successfully");
  z_static_value_free(&value);
}

static void expect_equal_and_hash(const char *left_text, const char *right_text) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeId left = parse_or_die(&arena, left_text);
  ZTypeId right = parse_or_die(&arena, right_text);
  expect(z_type_equal(&arena, left, right), "equal types did not compare equal");
  expect(z_type_hash(&arena, left) == z_type_hash(&arena, right), "equal types produced different hashes");
  z_type_arena_free(&arena);
}

static void expect_not_equal(const char *left_text, const char *right_text) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeId left = parse_or_die(&arena, left_text);
  ZTypeId right = parse_or_die(&arena, right_text);
  expect(!z_type_equal(&arena, left, right), "different types compared equal");
  z_type_arena_free(&arena);
}

static void expect_failed_parse_rewinds(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeId base = parse_or_die(&arena, "i32");
  size_t before = arena.len;
  ZTypeId bad = Z_TYPE_ID_INVALID;
  ZTypeParseError error = {0};
  expect(!z_type_parse(&arena, "Span<", &bad, &error), "bad type parsed successfully");
  expect(arena.len == before, "failed parse did not rewind arena");
  char *formatted = z_type_format(&arena, base);
  expect(formatted && strcmp(formatted, "i32") == 0, "rewind corrupted prior type");
  free(formatted);
  z_type_arena_free(&arena);
}

static void expect_speculative_arg_rewinds(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeId gate = parse_or_die(&arena, "Gate<Mode.tiny>");
  expect(arena.len == 1, "static enum arg left speculative type nodes");
  char *formatted = z_type_format(&arena, gate);
  expect(formatted && strcmp(formatted, "Gate<Mode.tiny>") == 0, "static enum arg formatted incorrectly");
  free(formatted);
  z_type_arena_free(&arena);
}

static void expect_binder_identity(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl left_decl[] = {
    {.name = "T", .kind = Z_TYPE_BINDER_TYPE, .id = 1},
    {.name = "N", .kind = Z_TYPE_BINDER_STATIC, .id = 2, .static_type = "usize"},
  };
  ZTypeBinderDecl right_decl[] = {
    {.name = "T", .kind = Z_TYPE_BINDER_TYPE, .id = 3},
    {.name = "N", .kind = Z_TYPE_BINDER_STATIC, .id = 4, .static_type = "usize"},
  };
  ZTypeBinderScope left_scope = {.items = left_decl, .len = 2};
  ZTypeBinderScope right_scope = {.items = right_decl, .len = 2};
  ZTypeId left = parse_with_binders_or_die(&arena, "FixedVec<T,N>", &left_scope);
  ZTypeId right = parse_with_binders_or_die(&arena, "FixedVec<T,N>", &right_scope);
  expect(!z_type_equal(&arena, left, right), "binder identity collapsed to names");
  char *formatted = z_type_format(&arena, left);
  expect(formatted && strcmp(formatted, "FixedVec<T,N>") == 0, "binder formatting changed public type text");
  free(formatted);
  z_type_arena_free(&arena);
}

static void expect_unify_and_substitute(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl decls[] = {
    {.name = "T", .kind = Z_TYPE_BINDER_TYPE, .id = 10},
    {.name = "N", .kind = Z_TYPE_BINDER_STATIC, .id = 11, .static_type = "usize"},
  };
  ZTypeBinderScope scope = {.items = decls, .len = 2};
  ZTypeId pattern = parse_with_binders_or_die(&arena, "FixedVec<T,N>", &scope);
  ZTypeId actual = parse_or_die(&arena, "FixedVec<u8,0x4>");

  ZUnifyTrace trace;
  z_unify_trace_init(&trace);
  expect(z_type_unify(&arena, pattern, actual, &trace), "binder pattern did not unify with concrete type");
  const ZUnifyBinding *type_binding = z_unify_trace_lookup(&trace, 10, Z_UNIFY_BINDING_TYPE);
  const ZUnifyBinding *static_binding = z_unify_trace_lookup(&trace, 11, Z_UNIFY_BINDING_STATIC);
  expect(type_binding && static_binding && trace.len == 2, "unification trace missed binder facts");
  char *bound_type = z_type_format(&arena, type_binding->type);
  expect(bound_type && strcmp(bound_type, "u8") == 0, "type binder bound to wrong type");
  free(bound_type);
  expect(static_binding->static_value.kind == Z_STATIC_VALUE_NUMBER && static_binding->static_value.number == 4, "static binder bound to wrong value");

  ZTypeId substituted = Z_TYPE_ID_INVALID;
  expect(z_type_substitute(&arena, pattern, &trace, &substituted), "substitution failed");
  expect(z_type_equal(&arena, substituted, actual), "substitution result differs from concrete type");
  expect(z_type_occurs(&arena, pattern, 10), "occurs check did not find type binder");
  expect(z_type_occurs(&arena, pattern, 11), "occurs check did not find static binder");
  expect(!z_type_occurs(&arena, actual, 10), "occurs check found binder in concrete type");
  z_unify_trace_free(&trace);
  z_type_arena_free(&arena);
}

static void expect_occurs_check_rejects_recursive_binding(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl decls[] = {
    {.name = "T", .kind = Z_TYPE_BINDER_TYPE, .id = 20},
  };
  ZTypeBinderScope scope = {.items = decls, .len = 1};
  ZTypeId pattern = parse_with_binders_or_die(&arena, "T", &scope);
  ZTypeId recursive = parse_with_binders_or_die(&arena, "Maybe<T>", &scope);
  ZUnifyTrace trace;
  z_unify_trace_init(&trace);
  expect(!z_type_unify(&arena, pattern, recursive, &trace), "recursive type binding passed occurs check");
  expect(strstr(trace.message, "occurs") != NULL, "occurs check failure did not leave a trace message");
  z_unify_trace_free(&trace);
  z_type_arena_free(&arena);
}

static void expect_occurs_check_follows_trace_bindings(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl decls[] = {
    {.name = "T", .kind = Z_TYPE_BINDER_TYPE, .id = 30},
    {.name = "U", .kind = Z_TYPE_BINDER_TYPE, .id = 31},
  };
  ZTypeBinderScope scope = {.items = decls, .len = 2};
  ZTypeId pattern = parse_with_binders_or_die(&arena, "Pair<T,U>", &scope);
  ZTypeId recursive = parse_with_binders_or_die(&arena, "Pair<U,Maybe<T>>", &scope);
  ZUnifyTrace trace;
  z_unify_trace_init(&trace);
  expect(!z_type_unify(&arena, pattern, recursive, &trace), "transitive recursive type binding passed occurs check");
  expect(strstr(trace.message, "occurs") != NULL, "transitive occurs check failure did not leave a trace message");
  z_unify_trace_free(&trace);
  z_type_arena_free(&arena);
}

static void expect_binder_alias_swap_unifies(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl decls[] = {
    {.name = "T", .kind = Z_TYPE_BINDER_TYPE, .id = 40},
    {.name = "U", .kind = Z_TYPE_BINDER_TYPE, .id = 41},
  };
  ZTypeBinderScope scope = {.items = decls, .len = 2};
  ZTypeId pattern = parse_with_binders_or_die(&arena, "Pair<T,U>", &scope);
  ZTypeId actual = parse_with_binders_or_die(&arena, "Pair<U,T>", &scope);
  ZUnifyTrace trace;
  z_unify_trace_init(&trace);
  expect(z_type_unify(&arena, pattern, actual, &trace), "plain binder alias swap did not unify");
  ZTypeId substituted = Z_TYPE_ID_INVALID;
  expect(z_type_substitute(&arena, pattern, &trace, &substituted), "alias substitution failed");
  char *formatted = z_type_format(&arena, substituted);
  expect(formatted && strcmp(formatted, "Pair<U,U>") == 0, "alias substitution did not use canonical binder");
  free(formatted);
  z_unify_trace_free(&trace);
  z_type_arena_free(&arena);
}

static void expect_chained_type_substitution(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl decls[] = {
    {.name = "T", .kind = Z_TYPE_BINDER_TYPE, .id = 50},
    {.name = "U", .kind = Z_TYPE_BINDER_TYPE, .id = 51},
  };
  ZTypeBinderScope scope = {.items = decls, .len = 2};
  ZTypeId pattern = parse_with_binders_or_die(&arena, "Pair<T,T>", &scope);
  ZTypeId actual = parse_with_binders_or_die(&arena, "Pair<U,i32>", &scope);
  ZUnifyTrace trace;
  z_unify_trace_init(&trace);
  expect(z_type_unify(&arena, pattern, actual, &trace), "chained type binder pattern did not unify");
  ZTypeId substituted = Z_TYPE_ID_INVALID;
  expect(z_type_substitute(&arena, pattern, &trace, &substituted), "chained type substitution failed");
  char *formatted = z_type_format(&arena, substituted);
  expect(formatted && strcmp(formatted, "Pair<i32,i32>") == 0, "chained type substitution left an unresolved binder");
  free(formatted);
  z_unify_trace_free(&trace);
  z_type_arena_free(&arena);
}

static void expect_concrete_first_type_substitution(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl decls[] = {
    {.name = "T", .kind = Z_TYPE_BINDER_TYPE, .id = 52},
    {.name = "U", .kind = Z_TYPE_BINDER_TYPE, .id = 53},
  };
  ZTypeBinderScope scope = {.items = decls, .len = 2};
  ZTypeId pattern = parse_with_binders_or_die(&arena, "Pair<Box<T>,Box<T>>", &scope);
  ZTypeId actual = parse_with_binders_or_die(&arena, "Pair<Box<i32>,Box<U>>", &scope);
  ZUnifyTrace trace;
  z_unify_trace_init(&trace);
  expect(z_type_unify(&arena, pattern, actual, &trace), "concrete-first type binder pattern did not unify");
  ZTypeId substituted = Z_TYPE_ID_INVALID;
  expect(z_type_substitute(&arena, actual, &trace, &substituted), "concrete-first actual substitution failed");
  char *formatted = z_type_format(&arena, substituted);
  expect(formatted && strcmp(formatted, "Pair<Box<i32>,Box<i32>>") == 0, "concrete-first type substitution left an unresolved binder");
  free(formatted);
  z_unify_trace_free(&trace);
  z_type_arena_free(&arena);
}

static void expect_chained_static_substitution(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl decls[] = {
    {.name = "N", .kind = Z_TYPE_BINDER_STATIC, .id = 60, .static_type = "usize"},
    {.name = "M", .kind = Z_TYPE_BINDER_STATIC, .id = 61, .static_type = "usize"},
  };
  ZTypeBinderScope scope = {.items = decls, .len = 2};
  ZTypeId pattern = parse_with_binders_or_die(&arena, "Pair<FixedVec<u8,N>,FixedVec<u8,N>>", &scope);
  ZTypeId actual = parse_with_binders_or_die(&arena, "Pair<FixedVec<u8,M>,FixedVec<u8,4>>", &scope);
  ZUnifyTrace trace;
  z_unify_trace_init(&trace);
  expect(z_type_unify(&arena, pattern, actual, &trace), "chained static binder pattern did not unify");
  ZTypeId substituted = Z_TYPE_ID_INVALID;
  expect(z_type_substitute(&arena, pattern, &trace, &substituted), "chained static substitution failed");
  char *formatted = z_type_format(&arena, substituted);
  expect(formatted && strcmp(formatted, "Pair<FixedVec<u8,4>,FixedVec<u8,4>>") == 0, "chained static substitution left an unresolved binder");
  free(formatted);
  z_unify_trace_free(&trace);
  z_type_arena_free(&arena);
}

static void expect_concrete_first_static_substitution(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl decls[] = {
    {.name = "N", .kind = Z_TYPE_BINDER_STATIC, .id = 62, .static_type = "usize"},
    {.name = "M", .kind = Z_TYPE_BINDER_STATIC, .id = 63, .static_type = "usize"},
  };
  ZTypeBinderScope scope = {.items = decls, .len = 2};
  ZTypeId pattern = parse_with_binders_or_die(&arena, "Pair<FixedVec<u8,N>,FixedVec<u8,N>>", &scope);
  ZTypeId actual = parse_with_binders_or_die(&arena, "Pair<FixedVec<u8,4>,FixedVec<u8,M>>", &scope);
  ZUnifyTrace trace;
  z_unify_trace_init(&trace);
  expect(z_type_unify(&arena, pattern, actual, &trace), "concrete-first static binder pattern did not unify");
  ZTypeId substituted = Z_TYPE_ID_INVALID;
  expect(z_type_substitute(&arena, actual, &trace, &substituted), "concrete-first static substitution failed");
  char *formatted = z_type_format(&arena, substituted);
  expect(formatted && strcmp(formatted, "Pair<FixedVec<u8,4>,FixedVec<u8,4>>") == 0, "concrete-first static substitution left an unresolved binder");
  free(formatted);
  z_unify_trace_free(&trace);
  z_type_arena_free(&arena);
}

static bool mixed_arg_kind(const void *context, const char *type_name, size_t arg_index, ZTypeArgKind *out_kind) {
  (void)context;
  if (!type_name || strcmp(type_name, "Mixed") != 0 || arg_index > 1 || !out_kind) return false;
  *out_kind = arg_index == 0 ? Z_TYPE_ARG_TYPE : Z_TYPE_ARG_STATIC;
  return true;
}

static void expect_slot_aware_ambiguous_arg_parse(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl decls[] = {
    {.name = "Foo", .kind = Z_TYPE_BINDER_STATIC, .id = 63, .static_type = "usize"},
  };
  ZTypeBinderScope scope = {.items = decls, .len = 1, .arg_kind = mixed_arg_kind};
  ZTypeId mixed = parse_with_binders_or_die(&arena, "Mixed<Foo,Foo>", &scope);
  expect(z_type_kind(&arena, mixed) == Z_TYPE_NODE_APPLY, "slot-aware parse did not create an applied type");
  const ZTypeArg *type_arg = z_type_apply_arg(&arena, mixed, 0);
  const ZTypeArg *static_arg = z_type_apply_arg(&arena, mixed, 1);
  expect(type_arg && type_arg->kind == Z_TYPE_ARG_TYPE, "ambiguous type slot parsed as static value");
  expect(z_type_kind(&arena, type_arg->as.type) == Z_TYPE_NODE_NAME, "ambiguous type slot did not parse as a concrete type");
  expect(static_arg && static_arg->kind == Z_TYPE_ARG_STATIC, "ambiguous static slot parsed as a type");
  expect(static_arg->as.static_value.kind == Z_STATIC_VALUE_BINDER && static_arg->as.static_value.binder == 63, "ambiguous static slot did not use the static binder");
  z_type_arena_free(&arena);
}

static void expect_static_binder_types_are_checked(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl decls[] = {
    {.name = "N", .kind = Z_TYPE_BINDER_STATIC, .id = 64, .static_type = "usize"},
    {.name = "Flag", .kind = Z_TYPE_BINDER_STATIC, .id = 65, .static_type = "Bool"},
    {.name = "ModeValue", .kind = Z_TYPE_BINDER_STATIC, .id = 66, .static_type = "Mode"},
  };
  ZTypeBinderScope scope = {.items = decls, .len = 3};
  ZTypeId integer_pattern = parse_with_binders_or_die(&arena, "FixedVec<u8,N>", &scope);
  ZTypeId bool_actual = parse_or_die(&arena, "FixedVec<u8,true>");
  ZUnifyTrace trace;
  z_unify_trace_init(&trace);
  expect(!z_type_unify(&arena, integer_pattern, bool_actual, &trace), "static integer binder accepted a Bool value");
  expect(strstr(trace.message, "static value") != NULL, "static type failure did not leave a trace message");

  ZTypeId alias_pattern = parse_with_binders_or_die(&arena, "Pair<N,N>", &scope);
  ZTypeId alias_actual = parse_with_binders_or_die(&arena, "Pair<Flag,N>", &scope);
  expect(!z_type_unify(&arena, alias_pattern, alias_actual, &trace), "static binders with different declared types unified");

  ZTypeId enum_pattern = parse_with_binders_or_die(&arena, "Gate<ModeValue>", &scope);
  ZTypeId enum_actual = parse_or_die(&arena, "Gate<Mode.tiny>");
  expect(z_type_unify(&arena, enum_pattern, enum_actual, &trace), "enum-like static binder rejected matching symbol value");
  z_unify_trace_free(&trace);
  z_type_arena_free(&arena);
}

static void expect_failed_unify_rolls_back_trace(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl decls[] = {
    {.name = "T", .kind = Z_TYPE_BINDER_TYPE, .id = 70},
    {.name = "U", .kind = Z_TYPE_BINDER_TYPE, .id = 71},
  };
  ZTypeBinderScope scope = {.items = decls, .len = 2};
  ZTypeId pattern = parse_with_binders_or_die(&arena, "Pair<T,T>", &scope);
  ZTypeId bad = parse_or_die(&arena, "Pair<i32,String>");
  ZTypeId prior_pattern = parse_with_binders_or_die(&arena, "U", &scope);
  ZTypeId prior_actual = parse_or_die(&arena, "u8");
  ZUnifyTrace trace;
  z_unify_trace_init(&trace);
  expect(z_type_unify(&arena, prior_pattern, prior_actual, &trace), "prior trace binding did not unify");
  expect(trace.len == 1, "prior trace binding was not committed");
  expect(!z_type_unify(&arena, pattern, bad, &trace), "conflicting type binder pattern unified successfully");
  expect(trace.len == 1, "failed unification did not roll back to the prior trace length");
  const ZUnifyBinding *prior_binding = z_unify_trace_lookup(&trace, 71, Z_UNIFY_BINDING_TYPE);
  expect(prior_binding != NULL, "failed unification dropped a prior trace binding");
  expect(trace.message[0] != 0, "failed unification did not preserve a diagnostic message");

  ZTypeId good = parse_or_die(&arena, "Pair<u8,u8>");
  expect(z_type_unify(&arena, pattern, good, &trace), "trace was poisoned after failed unification rollback");
  expect(trace.message[0] == 0, "successful retry left a stale unification failure message");
  expect(trace.len == 2, "successful retry did not commit expected binding count");
  const ZUnifyBinding *type_binding = z_unify_trace_lookup(&trace, 70, Z_UNIFY_BINDING_TYPE);
  expect(type_binding != NULL, "successful retry did not bind T");
  char *bound_type = z_type_format(&arena, type_binding->type);
  expect(bound_type && strcmp(bound_type, "u8") == 0, "successful retry bound T to the wrong type");
  free(bound_type);
  z_unify_trace_free(&trace);
  z_type_arena_free(&arena);
}

static void expect_failed_substitute_rolls_back_arena(void) {
  ZTypeArena arena;
  z_type_arena_init(&arena);
  ZTypeBinderDecl decls[] = {
    {.name = "T", .kind = Z_TYPE_BINDER_TYPE, .id = 80},
  };
  ZTypeBinderScope scope = {.items = decls, .len = 1};
  ZTypeId source = parse_with_binders_or_die(&arena, "Tuple<i32,T,u8>", &scope);
  ZTypeId recursive = parse_with_binders_or_die(&arena, "T", &scope);
  size_t before = arena.len;

  ZUnifyTrace trace;
  z_unify_trace_init(&trace);
  trace.items = calloc(1, sizeof(ZUnifyBinding));
  expect(trace.items != NULL, "failed to allocate regression trace");
  trace.len = 1;
  trace.cap = 1;
  trace.items[0] = (ZUnifyBinding){.binder = 80, .kind = Z_UNIFY_BINDING_TYPE, .type = recursive};

  ZTypeId substituted = Z_TYPE_ID_INVALID;
  expect(!z_type_substitute(&arena, source, &trace, &substituted), "recursive substitution unexpectedly succeeded");
  expect(substituted == Z_TYPE_ID_INVALID, "failed substitution returned a type id");
  expect(arena.len == before, "failed substitution did not roll back arena");

  z_unify_trace_free(&trace);
  z_type_arena_free(&arena);
}

int main(void) {
  expect_roundtrip("i32", "i32");
  expect_roundtrip("const i32", "const i32");
  expect_roundtrip("[4]u8", "[4]u8");
  expect_roundtrip("[0x10]u8", "[16]u8");
  expect_roundtrip("[cap]u8", "[cap]u8");
  expect_roundtrip("Span<u8>", "Span<u8>");
  expect_roundtrip("MutSpan<Span<u8>>", "MutSpan<Span<u8>>");
  expect_roundtrip("Maybe<owned<ByteBuf>>", "Maybe<owned<ByteBuf>>");
  expect_roundtrip("Box<trueThing<u8>>", "Box<trueThing<u8>>");
  expect_roundtrip("ref<FixedVec<u8, 4>>", "ref<FixedVec<u8,4>>");
  expect_roundtrip("mutref<MutSpan<u8>>", "mutref<MutSpan<u8>>");
  expect_roundtrip("FixedVec<T,N>", "FixedVec<T,N>");
  expect_roundtrip("FixedVec<u8, 4_usize>", "FixedVec<u8,4>");
  expect_roundtrip("Gate<true, Mode.tiny>", "Gate<true,Mode.tiny>");
  expect_roundtrip("const [4]Maybe<ref<Point>>", "const [4]Maybe<ref<Point>>");

  expect_static_roundtrip("42", "42", Z_STATIC_VALUE_NUMBER);
  expect_static_roundtrip("4_096", "4096", Z_STATIC_VALUE_NUMBER);
  expect_static_roundtrip("0b1010", "10", Z_STATIC_VALUE_NUMBER);
  expect_static_roundtrip("true", "true", Z_STATIC_VALUE_BOOL);
  expect_static_roundtrip("Mode.tiny", "Mode.tiny", Z_STATIC_VALUE_SYMBOL);

  expect_equal_and_hash("FixedVec<u8,4>", "FixedVec<u8,0x4>");
  expect_equal_and_hash("Maybe<Span<u8>>", "Maybe<Span<u8>>");
  expect_not_equal("FixedVec<u8,4>", "FixedVec<u8,5>");
  expect_not_equal("Span<u8>", "MutSpan<u8>");

  expect_failed_parse_rewinds();
  expect_speculative_arg_rewinds();
  expect_binder_identity();
  expect_unify_and_substitute();
  expect_occurs_check_rejects_recursive_binding();
  expect_occurs_check_follows_trace_bindings();
  expect_binder_alias_swap_unifies();
  expect_chained_type_substitution();
  expect_chained_static_substitution();
  expect_concrete_first_type_substitution();
  expect_concrete_first_static_substitution();
  expect_slot_aware_ambiguous_arg_parse();
  expect_static_binder_types_are_checked();
  expect_failed_unify_rolls_back_trace();
  expect_failed_substitute_rolls_back_arena();

  expect_invalid_type("");
  expect_invalid_type("Span<");
  expect_invalid_type("[4");
  expect_invalid_type("Maybe<>");
  expect_invalid_type("Span<u8,,i32>");
  expect_invalid_type("[]u8");
  expect_invalid_type("const");
  expect_invalid_type("FixedVec<u8,>");
  expect_invalid_type("[4_]u8");
  expect_invalid_type("[4__5]u8");
  expect_invalid_type("[0x_1]u8");
  expect_invalid_type("FixedVec<u8,4_nope>");
  expect_invalid_type_offset("FixedVec<u8,4_>", 12);
  expect_invalid_type_offset("[4_]u8", 1);

  expect_invalid_static("");
  expect_invalid_static("Mode.");
  expect_invalid_static("0x");
  expect_invalid_static("4_");
  expect_invalid_static("4__5");
  expect_invalid_static("0x_1");
  expect_invalid_static("4_nope");

  printf("type core smoke ok\n");
  return 0;
}
`;

try {
  writeFileSync(sourcePath, source);
  execFileSync(
    "cc",
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Wpedantic",
      "-I",
      path.join(repoRoot, "native/zero-c/src"),
      sourcePath,
      path.join(repoRoot, "native/zero-c/src/type_core.c"),
      path.join(repoRoot, "native/zero-c/src/unify.c"),
      "-o",
      exePath,
    ],
    { stdio: "inherit" },
  );
  execFileSync(exePath, [], { stdio: "inherit" });
} finally {
  rmSync(sourcePath, { force: true });
  rmSync(exePath, { force: true });
}
