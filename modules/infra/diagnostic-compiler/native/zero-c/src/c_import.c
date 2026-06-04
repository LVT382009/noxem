#include "c_import.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static bool c_ident_char(char ch) {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_';
}

static char *trim_span_copy(const char *start, const char *end) {
  if (!start || !end || end < start) return z_strdup("");
  while (start < end && isspace((unsigned char)*start)) start++;
  while (end > start && isspace((unsigned char)end[-1])) end--;
  return z_strndup(start, (size_t)(end - start));
}

char *z_c_header_strip_comments(const char *header) {
  ZBuf out;
  zbuf_init(&out);
  const char *cursor = header ? header : "";
  while (*cursor) {
    if (cursor[0] == '/' && cursor[1] == '/') {
      cursor += 2;
      while (*cursor && *cursor != '\n') cursor++;
      if (*cursor == '\n') zbuf_append_char(&out, *cursor++);
      continue;
    }
    if (cursor[0] == '/' && cursor[1] == '*') {
      zbuf_append_char(&out, ' ');
      cursor += 2;
      while (*cursor) {
        if (cursor[0] == '*' && cursor[1] == '/') {
          cursor += 2;
          break;
        }
        if (*cursor == '\n') zbuf_append_char(&out, '\n');
        cursor++;
      }
      continue;
    }
    if (*cursor == '"' || *cursor == '\'') {
      char quote = *cursor;
      zbuf_append_char(&out, *cursor++);
      while (*cursor) {
        char ch = *cursor++;
        zbuf_append_char(&out, ch);
        if (ch == '\\' && *cursor) {
          zbuf_append_char(&out, *cursor++);
          continue;
        }
        if (ch == quote) break;
      }
      continue;
    }
    zbuf_append_char(&out, *cursor++);
  }
  return out.data ? out.data : z_strdup("");
}

static const char *last_ident_start_before(const char *start, const char *end) {
  const char *cursor = end;
  while (cursor > start && !c_ident_char(cursor[-1])) cursor--;
  const char *ident_end = cursor;
  while (cursor > start && c_ident_char(cursor[-1])) cursor--;
  return ident_end > cursor ? cursor : NULL;
}

static void c_import_function_push_param(ZCImportFunction *function, ZCImportParam param) {
  if (function->param_len == function->param_cap) {
    function->param_cap = z_grow_capacity(function->param_cap, function->param_len + 1, 4);
    function->params = z_checked_reallocarray(function->params, function->param_cap, sizeof(ZCImportParam));
  }
  function->params[function->param_len++] = param;
}

static void c_import_function_vec_push(ZCImportFunctionVec *vec, ZCImportFunction function) {
  if (vec->len == vec->cap) {
    vec->cap = z_grow_capacity(vec->cap, vec->len + 1, 4);
    vec->items = z_checked_reallocarray(vec->items, vec->cap, sizeof(ZCImportFunction));
  }
  vec->items[vec->len++] = function;
}

void z_c_import_function_free(ZCImportFunction *function) {
  if (!function) return;
  free(function->name);
  free(function->import_header);
  free(function->import_resolved_header);
  free(function->return_c_type);
  free(function->return_zero_type);
  for (size_t i = 0; i < function->param_len; i++) {
    free(function->params[i].name);
    free(function->params[i].c_type);
    free(function->params[i].zero_type);
  }
  free(function->params);
  *function = (ZCImportFunction){0};
}

void z_c_import_function_vec_free(ZCImportFunctionVec *vec) {
  if (!vec) return;
  for (size_t i = 0; i < vec->len; i++) z_c_import_function_free(&vec->items[i]);
  free(vec->items);
  *vec = (ZCImportFunctionVec){0};
}

static bool normalized_c_type(const char *c_type, char *out, size_t out_len) {
  if (!c_type || !out || out_len == 0) return false;
  out[0] = 0;
  if (strchr(c_type, '*') || strchr(c_type, '[') || strchr(c_type, ']')) return false;
  char *copy = trim_span_copy(c_type, c_type + strlen(c_type));
  size_t used = 0;
  const char *cursor = copy;
  while (*cursor) {
    while (isspace((unsigned char)*cursor)) cursor++;
    if (!*cursor) break;
    const char *word_start = cursor;
    while (*cursor && !isspace((unsigned char)*cursor)) cursor++;
    char *word = z_strndup(word_start, (size_t)(cursor - word_start));
    bool skip = strcmp(word, "const") == 0 || strcmp(word, "volatile") == 0 ||
                strcmp(word, "register") == 0 || strcmp(word, "extern") == 0;
    if (!skip) {
      if (used > 0 && used + 1 < out_len) out[used++] = ' ';
      for (size_t i = 0; word[i] && used + 1 < out_len; i++) out[used++] = word[i];
    }
    free(word);
  }
  out[used < out_len ? used : out_len - 1] = 0;
  free(copy);
  return out[0] != 0;
}

bool z_c_type_to_zero(const char *c_type, char *out, size_t out_len) {
  if (!out || out_len == 0) return false;
  out[0] = 0;
  char normalized[128];
  if (!normalized_c_type(c_type, normalized, sizeof(normalized))) return false;
  if (strcmp(normalized, "void") == 0) snprintf(out, out_len, "Void");
  else if (strcmp(normalized, "bool") == 0 || strcmp(normalized, "_Bool") == 0) snprintf(out, out_len, "Bool");
  else if (strcmp(normalized, "char") == 0 || strcmp(normalized, "unsigned char") == 0 || strcmp(normalized, "uint8_t") == 0) snprintf(out, out_len, "u8");
  else if (strcmp(normalized, "unsigned short") == 0 || strcmp(normalized, "uint16_t") == 0) snprintf(out, out_len, "u16");
  else if (strcmp(normalized, "int") == 0 || strcmp(normalized, "signed int") == 0 || strcmp(normalized, "int32_t") == 0) snprintf(out, out_len, "i32");
  else if (strcmp(normalized, "unsigned") == 0 || strcmp(normalized, "unsigned int") == 0 || strcmp(normalized, "uint32_t") == 0) snprintf(out, out_len, "u32");
  else if (strcmp(normalized, "long long") == 0 || strcmp(normalized, "signed long long") == 0 || strcmp(normalized, "int64_t") == 0) snprintf(out, out_len, "i64");
  else if (strcmp(normalized, "unsigned long long") == 0 || strcmp(normalized, "uint64_t") == 0) snprintf(out, out_len, "u64");
  else if (strcmp(normalized, "size_t") == 0) snprintf(out, out_len, "usize");
  else return false;
  return true;
}

static bool c_import_parse_param(ZCImportFunction *function, const char *start, const char *end) {
  char *param_text = trim_span_copy(start, end);
  if (!param_text[0] || strcmp(param_text, "void") == 0) {
    free(param_text);
    return true;
  }
  char zero_type[128];
  if (z_c_type_to_zero(param_text, zero_type, sizeof(zero_type))) {
    char name[32];
    snprintf(name, sizeof(name), "arg%zu", function->param_len);
    c_import_function_push_param(function, (ZCImportParam){.name = z_strdup(name), .c_type = z_strdup(param_text), .zero_type = z_strdup(zero_type)});
    free(param_text);
    return true;
  }
  const char *param_end = param_text + strlen(param_text);
  const char *name_start = last_ident_start_before(param_text, param_end);
  if (!name_start) {
    free(param_text);
    return false;
  }
  const char *name_end = name_start;
  while (*name_end && c_ident_char(*name_end)) name_end++;
  char *name = z_strndup(name_start, (size_t)(name_end - name_start));
  char *c_type = trim_span_copy(param_text, name_start);
  char *mapped = z_c_type_to_zero(c_type, zero_type, sizeof(zero_type)) ? z_strdup(zero_type) : z_strdup("Unknown");
  c_import_function_push_param(function, (ZCImportParam){.name = name, .c_type = c_type, .zero_type = mapped});
  free(param_text);
  return true;
}

static void c_import_parse_params(ZCImportFunction *function, const char *start, const char *end) {
  const char *cursor = start;
  while (cursor && cursor < end) {
    const char *comma = cursor;
    while (comma < end && *comma != ',') comma++;
    if (!c_import_parse_param(function, cursor, comma)) break;
    cursor = comma < end ? comma + 1 : end;
  }
}

static const char *c_import_function_decl_close(const char *paren) {
  if (!paren) return NULL;
  int depth = 0;
  for (const char *cursor = paren; *cursor; cursor++) {
    if (*cursor == '(') depth++;
    else if (*cursor == ')' && depth > 0) {
      depth--;
      if (depth == 0) {
        const char *after = cursor + 1;
        while (isspace((unsigned char)*after)) after++;
        if (*after == ';') return cursor;
      }
    }
  }
  return NULL;
}

static bool c_import_parse_function_line(const char *line, ZCImportFunction *out) {
  const char *paren = strchr(line, '(');
  const char *close = c_import_function_decl_close(paren);
  const char *name_start = paren ? last_ident_start_before(line, paren) : NULL;
  if (!paren || !close || !name_start || strstr(line, "typedef")) return false;
  const char *name_end = name_start;
  while (*name_end && c_ident_char(*name_end)) name_end++;
  char *name = z_strndup(name_start, (size_t)(name_end - name_start));
  char *return_c_type = trim_span_copy(line, name_start);
  char return_zero_type[128];
  char *mapped_return = z_c_type_to_zero(return_c_type, return_zero_type, sizeof(return_zero_type)) ? z_strdup(return_zero_type) : z_strdup("Unknown");
  *out = (ZCImportFunction){
    .name = name,
    .return_c_type = return_c_type,
    .return_zero_type = mapped_return,
  };
  char *params_text = trim_span_copy(paren + 1, close);
  out->old_style_params = params_text[0] == 0;
  free(params_text);
  if (!out->old_style_params) c_import_parse_params(out, paren + 1, close);
  return true;
}

static void c_import_append_declaration_fragment(ZBuf *decl, const char *line) {
  if (!decl || !line) return;
  const char *cursor = line;
  bool wrote_space = decl->len > 0;
  while (*cursor) {
    while (isspace((unsigned char)*cursor)) cursor++;
    if (!*cursor) break;
    const char *start = cursor;
    while (*cursor && !isspace((unsigned char)*cursor)) cursor++;
    if (wrote_space) zbuf_append_char(decl, ' ');
    char *word = z_strndup(start, (size_t)(cursor - start));
    zbuf_append(decl, word);
    free(word);
    wrote_space = true;
  }
}

static void c_import_consume_complete_declarations(ZBuf *decl, ZCImportFunctionVec *out) {
  if (!decl || !decl->data || !out) return;
  const char *start = decl->data;
  const char *cursor = decl->data;
  bool consumed = false;
  while (*cursor) {
    if (*cursor == ';') {
      char *text = trim_span_copy(start, cursor + 1);
      if (text[0] && strchr(text, '(')) {
        ZCImportFunction function = {0};
        if (c_import_parse_function_line(text, &function)) c_import_function_vec_push(out, function);
      }
      free(text);
      start = cursor + 1;
      consumed = true;
    }
    cursor++;
  }
  if (!consumed) return;
  char *tail = trim_span_copy(start, decl->data + strlen(decl->data));
  zbuf_free(decl);
  zbuf_init(decl);
  if (tail[0]) zbuf_append(decl, tail);
  free(tail);
}

typedef struct {
  bool parent_active;
  bool active;
  bool branch_taken;
} CImportPreprocFrame;

static bool c_import_parse_directive_word(const char *line, char *word, size_t word_len, const char **rest) {
  if (!line || line[0] != '#' || !word || word_len == 0) return false;
  const char *cursor = line + 1;
  while (isspace((unsigned char)*cursor)) cursor++;
  const char *start = cursor;
  while (c_ident_char(*cursor)) cursor++;
  size_t len = (size_t)(cursor - start);
  if (len == 0) return false;
  size_t copy_len = len < word_len - 1 ? len : word_len - 1;
  memcpy(word, start, copy_len);
  word[copy_len] = 0;
  while (isspace((unsigned char)*cursor)) cursor++;
  if (rest) *rest = cursor;
  return true;
}

static bool c_import_preproc_active(const CImportPreprocFrame *frames, size_t depth) {
  return depth == 0 || (frames[depth - 1].parent_active && frames[depth - 1].active);
}

typedef struct {
  char **items;
  size_t len;
  size_t cap;
} CImportNameVec;

typedef struct {
  const ZTargetInfo *target;
  CImportNameVec defines;
  CImportNameVec truthy_defines;
  CImportNameVec undefines;
} CImportPreprocEnv;

static void c_import_name_vec_free(CImportNameVec *vec) {
  if (!vec) return;
  for (size_t i = 0; i < vec->len; i++) free(vec->items[i]);
  free(vec->items);
  *vec = (CImportNameVec){0};
}

static bool c_import_name_vec_contains(const CImportNameVec *vec, const char *name) {
  if (!vec || !name) return false;
  for (size_t i = 0; i < vec->len; i++) {
    if (vec->items[i] && strcmp(vec->items[i], name) == 0) return true;
  }
  return false;
}

static void c_import_name_vec_remove(CImportNameVec *vec, const char *name) {
  if (!vec || !name) return;
  for (size_t i = 0; i < vec->len; i++) {
    if (!vec->items[i] || strcmp(vec->items[i], name) != 0) continue;
    free(vec->items[i]);
    if (i + 1 < vec->len) memmove(&vec->items[i], &vec->items[i + 1], (vec->len - i - 1) * sizeof(char *));
    vec->len--;
    return;
  }
}

static void c_import_name_vec_add(CImportNameVec *vec, const char *name) {
  if (!vec || !name || !name[0] || c_import_name_vec_contains(vec, name)) return;
  if (vec->len == vec->cap) {
    vec->cap = z_grow_capacity(vec->cap, vec->len + 1, 8);
    vec->items = z_checked_reallocarray(vec->items, vec->cap, sizeof(char *));
  }
  vec->items[vec->len++] = z_strdup(name);
}

static void c_import_preproc_env_free(CImportPreprocEnv *env) {
  if (!env) return;
  c_import_name_vec_free(&env->defines);
  c_import_name_vec_free(&env->truthy_defines);
  c_import_name_vec_free(&env->undefines);
}

static char *c_import_parse_macro_name_copy(const char *text) {
  const char *cursor = text ? text : "";
  while (isspace((unsigned char)*cursor)) cursor++;
  const char *start = cursor;
  while (c_ident_char(*cursor)) cursor++;
  return start < cursor ? z_strndup(start, (size_t)(cursor - start)) : z_strdup("");
}

static char *c_import_parse_macro_definition_copy(const char *text, char **out_value) {
  const char *cursor = text ? text : "";
  while (isspace((unsigned char)*cursor)) cursor++;
  const char *start = cursor;
  while (c_ident_char(*cursor)) cursor++;
  char *name = start < cursor ? z_strndup(start, (size_t)(cursor - start)) : z_strdup("");
  while (isspace((unsigned char)*cursor)) cursor++;
  if (out_value) *out_value = trim_span_copy(cursor, cursor + strlen(cursor));
  return name;
}

static bool c_import_string_eq(const char *left, const char *right) {
  return left && right && strcmp(left, right) == 0;
}

static bool c_import_name_in_list(const char *name, const char *const *items, size_t len) {
  if (!name) return false;
  for (size_t i = 0; i < len; i++) {
    if (strcmp(name, items[i]) == 0) return true;
  }
  return false;
}

static bool c_import_target_macro_defined(const ZTargetInfo *target, const char *name) {
  if (!name || !name[0]) return false;
  if (strcmp(name, "__cplusplus") == 0) return false;
  if (strcmp(name, "__STDC__") == 0 || strcmp(name, "__STDC_HOSTED__") == 0) return true;
  if (!target) return false;

  const bool is_windows = c_import_string_eq(target->os, "windows");
  const bool is_linux = c_import_string_eq(target->os, "linux");
  const bool is_macos = c_import_string_eq(target->os, "macos");
  const bool is_x86_64 = c_import_string_eq(target->arch, "x86_64");
  const bool is_aarch64 = c_import_string_eq(target->arch, "aarch64");
  const bool is_msvc = c_import_string_eq(target->abi, "msvc");
  const bool is_gnu = c_import_string_eq(target->abi, "gnu");

  static const char *const windows_names[] = {"_WIN32", "WIN32", "_WIN64", "WIN64", "__WIN32__", "__WIN64__"};
  static const char *const linux_names[] = {"__linux__", "__linux", "linux"};
  static const char *const macos_names[] = {"__APPLE__", "__MACH__", "__APPLE_CC__"};
  static const char *const x86_64_names[] = {"__x86_64__", "__x86_64", "__amd64__", "__amd64"};
  static const char *const msvc_x86_64_names[] = {"_M_X64", "_M_AMD64"};
  static const char *const aarch64_names[] = {"__aarch64__"};
  static const char *const macos_aarch64_names[] = {"__arm64__"};
  static const char *const msvc_aarch64_names[] = {"_M_ARM64"};

  if (is_windows && c_import_name_in_list(name, windows_names, sizeof(windows_names) / sizeof(windows_names[0]))) return true;
  if (is_linux && c_import_name_in_list(name, linux_names, sizeof(linux_names) / sizeof(linux_names[0]))) return true;
  if (is_macos && c_import_name_in_list(name, macos_names, sizeof(macos_names) / sizeof(macos_names[0]))) return true;
  if (is_x86_64 && c_import_name_in_list(name, x86_64_names, sizeof(x86_64_names) / sizeof(x86_64_names[0]))) return true;
  if (is_msvc && is_x86_64 && c_import_name_in_list(name, msvc_x86_64_names, sizeof(msvc_x86_64_names) / sizeof(msvc_x86_64_names[0]))) return true;
  if (is_aarch64 && c_import_name_in_list(name, aarch64_names, sizeof(aarch64_names) / sizeof(aarch64_names[0]))) return true;
  if (is_macos && is_aarch64 && c_import_name_in_list(name, macos_aarch64_names, sizeof(macos_aarch64_names) / sizeof(macos_aarch64_names[0]))) return true;
  if (is_msvc && is_aarch64 && c_import_name_in_list(name, msvc_aarch64_names, sizeof(msvc_aarch64_names) / sizeof(msvc_aarch64_names[0]))) return true;
  if (!is_windows && (strcmp(name, "__LP64__") == 0 || strcmp(name, "_LP64") == 0)) return true;
  if (is_msvc && strcmp(name, "_MSC_VER") == 0) return true;
  if (is_gnu && (strcmp(name, "__GLIBC__") == 0 || strcmp(name, "__gnu_linux__") == 0)) return true;
  return false;
}

static bool c_import_macro_defined(const CImportPreprocEnv *env, const char *name) {
  if (!env || !name || !name[0]) return false;
  if (c_import_name_vec_contains(&env->undefines, name)) return false;
  if (c_import_name_vec_contains(&env->defines, name)) return true;
  return c_import_target_macro_defined(env->target, name);
}

static bool c_import_macro_expr_true(const CImportPreprocEnv *env, const char *name) {
  if (!env || !name || !name[0]) return false;
  if (c_import_name_vec_contains(&env->undefines, name)) return false;
  if (c_import_target_macro_defined(env->target, name)) return true;
  if (c_import_name_vec_contains(&env->defines, name)) return c_import_name_vec_contains(&env->truthy_defines, name);
  return false;
}

static void c_import_define_macro(CImportPreprocEnv *env, const char *name, bool truthy) {
  if (!env || !name || !name[0]) return;
  c_import_name_vec_remove(&env->undefines, name);
  c_import_name_vec_add(&env->defines, name);
  if (truthy) c_import_name_vec_add(&env->truthy_defines, name);
  else c_import_name_vec_remove(&env->truthy_defines, name);
}

static void c_import_undef_macro(CImportPreprocEnv *env, const char *name) {
  if (!env || !name || !name[0]) return;
  c_import_name_vec_remove(&env->defines, name);
  c_import_name_vec_remove(&env->truthy_defines, name);
  c_import_name_vec_add(&env->undefines, name);
}

typedef struct {
  const char *cursor;
  const CImportPreprocEnv *env;
  bool valid;
} CImportPPExprParser;

static void c_import_pp_skip_space(CImportPPExprParser *parser) {
  while (parser && isspace((unsigned char)*parser->cursor)) parser->cursor++;
}

static bool c_import_pp_consume(CImportPPExprParser *parser, const char *token) {
  if (!parser || !token) return false;
  c_import_pp_skip_space(parser);
  size_t len = strlen(token);
  if (strncmp(parser->cursor, token, len) != 0) return false;
  parser->cursor += len;
  return true;
}

static bool c_import_pp_parse_or(CImportPPExprParser *parser);

static bool c_import_pp_parse_macro_defined(CImportPPExprParser *parser) {
  c_import_pp_skip_space(parser);
  bool parenthesized = c_import_pp_consume(parser, "(");
  c_import_pp_skip_space(parser);
  const char *start = parser->cursor;
  while (c_ident_char(*parser->cursor)) parser->cursor++;
  if (start == parser->cursor) {
    parser->valid = false;
    return false;
  }
  char *name = z_strndup(start, (size_t)(parser->cursor - start));
  bool defined = c_import_macro_defined(parser->env, name);
  free(name);
  if (parenthesized && !c_import_pp_consume(parser, ")")) parser->valid = false;
  return defined;
}

static bool c_import_pp_parse_primary(CImportPPExprParser *parser) {
  c_import_pp_skip_space(parser);
  if (c_import_pp_consume(parser, "(")) {
    bool value = c_import_pp_parse_or(parser);
    if (!c_import_pp_consume(parser, ")")) parser->valid = false;
    return value;
  }
  if (isdigit((unsigned char)*parser->cursor)) {
    char *end = NULL;
    unsigned long long value = strtoull(parser->cursor, &end, 0);
    if (!end || end == parser->cursor) {
      parser->valid = false;
      return false;
    }
    parser->cursor = end;
    return value != 0;
  }
  if (c_ident_char(*parser->cursor)) {
    const char *start = parser->cursor;
    while (c_ident_char(*parser->cursor)) parser->cursor++;
    char *name = z_strndup(start, (size_t)(parser->cursor - start));
    bool value = false;
    if (strcmp(name, "defined") == 0) {
      free(name);
      return c_import_pp_parse_macro_defined(parser);
    }
    if (strcmp(name, "true") == 0) value = true;
    else if (strcmp(name, "false") == 0) value = false;
    else value = c_import_macro_expr_true(parser->env, name);
    free(name);
    return value;
  }
  parser->valid = false;
  return false;
}

static bool c_import_pp_parse_unary(CImportPPExprParser *parser) {
  if (c_import_pp_consume(parser, "!")) return !c_import_pp_parse_unary(parser);
  return c_import_pp_parse_primary(parser);
}

static bool c_import_pp_parse_and(CImportPPExprParser *parser) {
  bool value = c_import_pp_parse_unary(parser);
  while (c_import_pp_consume(parser, "&&")) {
    bool right = c_import_pp_parse_unary(parser);
    value = value && right;
  }
  return value;
}

static bool c_import_pp_parse_or(CImportPPExprParser *parser) {
  bool value = c_import_pp_parse_and(parser);
  while (c_import_pp_consume(parser, "||")) {
    bool right = c_import_pp_parse_and(parser);
    value = value || right;
  }
  return value;
}

static bool c_import_pp_expr_active(const CImportPreprocEnv *env, const char *expr) {
  if (!expr) return false;
  CImportPPExprParser parser = {.cursor = expr, .env = env, .valid = true};
  bool value = c_import_pp_parse_or(&parser);
  c_import_pp_skip_space(&parser);
  return parser.valid && *parser.cursor == 0 && value;
}

static void c_import_preproc_push(CImportPreprocFrame **frames, size_t *depth, size_t *cap, bool parent_active, bool active) {
  if (*depth == *cap) {
    *cap = z_grow_capacity(*cap, *depth + 1, 8);
    *frames = z_checked_reallocarray(*frames, *cap, sizeof(CImportPreprocFrame));
  }
  (*frames)[(*depth)++] = (CImportPreprocFrame){.parent_active = parent_active, .active = active, .branch_taken = active};
}

static bool c_import_handle_preprocessor_line(const char *line, CImportPreprocFrame **frames, size_t *depth, size_t *cap, CImportPreprocEnv *env) {
  char directive[16];
  const char *rest = NULL;
  if (!c_import_parse_directive_word(line, directive, sizeof(directive), &rest)) return false;
  if (strcmp(directive, "if") == 0) {
    bool parent_active = c_import_preproc_active(*frames, *depth);
    c_import_preproc_push(frames, depth, cap, parent_active, parent_active && c_import_pp_expr_active(env, rest));
    return true;
  }
  if (strcmp(directive, "ifdef") == 0) {
    bool parent_active = c_import_preproc_active(*frames, *depth);
    char *name = c_import_parse_macro_name_copy(rest);
    c_import_preproc_push(frames, depth, cap, parent_active, parent_active && c_import_macro_defined(env, name));
    free(name);
    return true;
  }
  if (strcmp(directive, "ifndef") == 0) {
    bool parent_active = c_import_preproc_active(*frames, *depth);
    char *name = c_import_parse_macro_name_copy(rest);
    c_import_preproc_push(frames, depth, cap, parent_active, parent_active && !c_import_macro_defined(env, name));
    free(name);
    return true;
  }
  if (strcmp(directive, "elif") == 0 && *depth > 0) {
    CImportPreprocFrame *frame = &(*frames)[*depth - 1];
    bool active = frame->parent_active && !frame->branch_taken && c_import_pp_expr_active(env, rest);
    frame->active = active;
    frame->branch_taken = frame->branch_taken || active;
    return true;
  }
  if (strcmp(directive, "else") == 0 && *depth > 0) {
    CImportPreprocFrame *frame = &(*frames)[*depth - 1];
    frame->active = frame->parent_active && !frame->branch_taken;
    frame->branch_taken = true;
    return true;
  }
  if (strcmp(directive, "endif") == 0 && *depth > 0) {
    (*depth)--;
    return true;
  }
  if (strcmp(directive, "define") == 0 && c_import_preproc_active(*frames, *depth)) {
    char *value = NULL;
    char *name = c_import_parse_macro_definition_copy(rest, &value);
    c_import_define_macro(env, name, value && value[0] ? c_import_pp_expr_active(env, value) : false);
    free(value);
    free(name);
    return true;
  }
  if (strcmp(directive, "undef") == 0 && c_import_preproc_active(*frames, *depth)) {
    char *name = c_import_parse_macro_name_copy(rest);
    c_import_undef_macro(env, name);
    free(name);
    return true;
  }
  return true;
}

static bool c_import_linkage_wrapper_line(const char *line) {
  if (!line) return false;
  if ((strstr(line, "extern \"C\"") || strstr(line, "extern \"C++\"")) && strchr(line, '{')) return true;
  const char *cursor = line;
  while (isspace((unsigned char)*cursor)) cursor++;
  if (*cursor != '}') return false;
  cursor++;
  while (isspace((unsigned char)*cursor)) cursor++;
  return *cursor == 0 || strncmp(cursor, "//", 2) == 0 || strncmp(cursor, "/*", 2) == 0;
}

bool z_c_header_parse_functions_for_target(const char *header, const ZTargetInfo *target, ZCImportFunctionVec *out) {
  if (!out) return false;
  char *stripped = z_c_header_strip_comments(header);
  const char *cursor = stripped ? stripped : "";
  CImportPreprocFrame *frames = NULL;
  size_t preproc_depth = 0;
  size_t preproc_cap = 0;
  CImportPreprocEnv env = {.target = target};
  ZBuf declaration;
  zbuf_init(&declaration);
  while (*cursor) {
    const char *line_end = strchr(cursor, '\n');
    if (!line_end) line_end = cursor + strlen(cursor);
    char *line = trim_span_copy(cursor, line_end);
    bool wrapper_line = c_import_linkage_wrapper_line(line);
    if (line[0] == '#') {
      c_import_handle_preprocessor_line(line, &frames, &preproc_depth, &preproc_cap, &env);
    } else if (c_import_preproc_active(frames, preproc_depth) && !wrapper_line) {
      if (line[0]) c_import_append_declaration_fragment(&declaration, line);
      c_import_consume_complete_declarations(&declaration, out);
    } else if (!c_import_preproc_active(frames, preproc_depth)) {
      zbuf_free(&declaration);
      zbuf_init(&declaration);
    } else if (wrapper_line) {
      zbuf_free(&declaration);
      zbuf_init(&declaration);
    }
    free(line);
    cursor = *line_end ? line_end + 1 : line_end;
  }
  zbuf_free(&declaration);
  c_import_preproc_env_free(&env);
  free(frames);
  free(stripped);
  return true;
}

bool z_c_header_parse_functions(const char *header, ZCImportFunctionVec *out) {
  return z_c_header_parse_functions_for_target(header, NULL, out);
}

static void c_import_function_clone(ZCImportFunction *out, const ZCImportFunction *source) {
  *out = (ZCImportFunction){
    .name = z_strdup(source->name),
    .import_header = source->import_header ? z_strdup(source->import_header) : NULL,
    .import_resolved_header = source->import_resolved_header ? z_strdup(source->import_resolved_header) : NULL,
    .return_c_type = z_strdup(source->return_c_type),
    .return_zero_type = z_strdup(source->return_zero_type),
    .old_style_params = source->old_style_params,
  };
  for (size_t i = 0; i < source->param_len; i++) {
    c_import_function_push_param(out, (ZCImportParam){
      .name = z_strdup(source->params[i].name),
      .c_type = z_strdup(source->params[i].c_type),
      .zero_type = z_strdup(source->params[i].zero_type),
    });
  }
}

bool z_c_import_alias_exists(const Program *program, const char *alias) {
  if (!program || !alias) return false;
  for (size_t i = 0; i < program->c_imports.len; i++) {
    const CImport *import = &program->c_imports.items[i];
    if (import->alias && strcmp(import->alias, alias) == 0) return true;
  }
  return false;
}

static const char *c_import_read_path(const CImport *import) {
  return import && import->resolved_header && import->resolved_header[0] ? import->resolved_header : (import ? import->header : NULL);
}

bool z_c_import_find_function_for_target(const Program *program, const ZTargetInfo *target, const char *alias, const char *symbol, ZCImportFunction *out, ZDiag *diag) {
  if (!program || !alias || !symbol || !out) return false;
  for (size_t i = 0; i < program->c_imports.len; i++) {
    const CImport *import = &program->c_imports.items[i];
    if (!import->alias || strcmp(import->alias, alias) != 0) continue;
    ZDiag read_diag = {0};
    const char *read_path = c_import_read_path(import);
    char *header = z_read_file(read_path, &read_diag);
    if (!header) {
      if (diag) {
        diag->code = 8001;
        diag->line = import->line;
        diag->column = import->column;
        diag->length = 1;
        snprintf(diag->message, sizeof(diag->message), "extern c header could not be read");
        snprintf(diag->expected, sizeof(diag->expected), "readable C header path");
        snprintf(diag->actual, sizeof(diag->actual), "%s", import->header ? import->header : "<missing>");
        snprintf(diag->help, sizeof(diag->help), "make the header path package-relative and target-specific");
      }
      return false;
    }
    ZCImportFunctionVec functions = {0};
    z_c_header_parse_functions_for_target(header, target, &functions);
    free(header);
    for (size_t fn = 0; fn < functions.len; fn++) {
      if (functions.items[fn].name && strcmp(functions.items[fn].name, symbol) == 0) {
        c_import_function_clone(out, &functions.items[fn]);
        free(out->import_header);
        free(out->import_resolved_header);
        out->import_header = import->header ? z_strdup(import->header) : NULL;
        out->import_resolved_header = import->resolved_header ? z_strdup(import->resolved_header) : NULL;
        z_c_import_function_vec_free(&functions);
        return true;
      }
    }
    z_c_import_function_vec_free(&functions);
  }
  return false;
}

bool z_c_import_find_function(const Program *program, const char *alias, const char *symbol, ZCImportFunction *out, ZDiag *diag) {
  return z_c_import_find_function_for_target(program, NULL, alias, symbol, out, diag);
}
