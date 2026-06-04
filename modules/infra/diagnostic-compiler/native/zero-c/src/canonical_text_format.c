#include "canonical_text.h"

#include <stdlib.h>

typedef struct {
  const ZCanonicalTokenVec *tokens;
  ZBuf *out;
  bool *compact_angles;
  const ZCanonicalToken *previous;
  const ZCanonicalToken *before_previous;
  const ZCanonicalToken *line_first;
  size_t indent;
  size_t paren_depth, bracket_depth, angle_depth;
  bool line_start, line_has_assignment, line_has_list_declaration;
  unsigned char *brace_flags;
  size_t brace_depth;
  size_t brace_cap;
} CanonFormat;

enum { FMT_BRACE_MULTILINE = 1, FMT_BRACE_LIST = 2, FMT_BRACE_MATCH = 4 };

static bool fmt_text_eq(const char *left, const char *right) {
  if (!left || !right) return left == right;
  while (*left && *right && *left == *right) {
    left++;
    right++;
  }
  return *left == 0 && *right == 0;
}

static bool fmt_is_symbol(const ZCanonicalToken *token, const char *text) {
  return token && token->kind == Z_CANON_TOKEN_SYMBOL && fmt_text_eq(token->text, text);
}

static bool fmt_is_word(const ZCanonicalToken *token, const char *text) {
  return token && token->kind == Z_CANON_TOKEN_WORD && fmt_text_eq(token->text, text);
}

static void fmt_append_char(ZBuf *out, char ch) {
  size_t required = out->len + 2;
  if (required > out->cap) {
    out->cap = z_grow_capacity(out->cap, required, 64);
    out->data = z_checked_reallocarray(out->data, out->cap, sizeof(char));
  }
  out->data[out->len++] = ch;
  out->data[out->len] = 0;
}

static void fmt_append(ZBuf *out, const char *text) {
  while (text && *text) fmt_append_char(out, *text++);
}

static void fmt_newline(CanonFormat *fmt) {
  if (fmt->out->len > 0 && fmt->out->data[fmt->out->len - 1] != '\n') fmt_append_char(fmt->out, '\n');
  fmt->line_start = true;
  fmt->previous = NULL;
  fmt->before_previous = NULL;
  fmt->line_first = NULL;
  fmt->line_has_assignment = false;
  fmt->line_has_list_declaration = false;
  fmt->paren_depth = 0;
  fmt->bracket_depth = 0;
  fmt->angle_depth = 0;
}

static void fmt_blank_line(CanonFormat *fmt) {
  fmt_newline(fmt);
  if (fmt->out->len < 2 || fmt->out->data[fmt->out->len - 2] != '\n') fmt_append_char(fmt->out, '\n');
}

static void fmt_indent(CanonFormat *fmt) {
  if (!fmt->line_start) return;
  for (size_t i = 0; i < fmt->indent; i++) fmt_append(fmt->out, "    ");
  fmt->line_start = false;
}

static const ZCanonicalToken *fmt_next_significant(const ZCanonicalTokenVec *tokens, size_t index) {
  for (size_t i = index + 1; i < tokens->len; i++) {
    const ZCanonicalToken *token = &tokens->items[i];
    if (token->kind != Z_CANON_TOKEN_NEWLINE && token->kind != Z_CANON_TOKEN_COMMENT) return token;
  }
  return NULL;
}

static bool fmt_angle_tail_allows_compact(const ZCanonicalToken *token) {
  if (!token || token->kind == Z_CANON_TOKEN_EOF || token->kind == Z_CANON_TOKEN_NEWLINE || token->kind == Z_CANON_TOKEN_COMMENT) return true;
  if (fmt_is_word(token, "raises")) return true;
  return fmt_is_symbol(token, "(") || fmt_is_symbol(token, "{") || fmt_is_symbol(token, "[") ||
    fmt_is_symbol(token, ")") || fmt_is_symbol(token, "}") || fmt_is_symbol(token, "]") ||
    fmt_is_symbol(token, ",") || fmt_is_symbol(token, "=") || fmt_is_symbol(token, "->") ||
    fmt_is_symbol(token, ">");
}

static bool fmt_find_matching_angle(const ZCanonicalTokenVec *tokens, size_t open_index, size_t *close_index) {
  size_t depth = 0;
  for (size_t i = open_index; i < tokens->len; i++) {
    const ZCanonicalToken *token = &tokens->items[i];
    if (token->kind == Z_CANON_TOKEN_EOF || token->kind == Z_CANON_TOKEN_NEWLINE || token->kind == Z_CANON_TOKEN_COMMENT) break;
    if (fmt_is_symbol(token, "<")) {
      depth++;
      continue;
    }
    if (!fmt_is_symbol(token, ">")) continue;
    if (depth == 0) return false;
    depth--;
    if (depth == 0) {
      *close_index = i;
      return true;
    }
  }
  return false;
}

static bool *fmt_build_compact_angles(const ZCanonicalTokenVec *tokens) {
  if (!tokens || tokens->len == 0) return NULL;
  bool *compact = z_checked_reallocarray(NULL, tokens->len, sizeof(bool));
  for (size_t i = 0; i < tokens->len; i++) compact[i] = false;
  for (size_t i = 1; i < tokens->len; i++) {
    const ZCanonicalToken *token = &tokens->items[i];
    const ZCanonicalToken *previous = &tokens->items[i - 1];
    if (!fmt_is_symbol(token, "<") || previous->kind != Z_CANON_TOKEN_WORD) continue;
    size_t close = 0;
    if (!fmt_find_matching_angle(tokens, i, &close) || close == i + 1) continue;
    const ZCanonicalToken *tail = close + 1 < tokens->len ? &tokens->items[close + 1] : NULL;
    if (!fmt_angle_tail_allows_compact(tail)) continue;
    compact[i] = true;
    compact[close] = true;
  }
  return compact;
}

static bool fmt_token_is_compact_angle(const CanonFormat *fmt, const ZCanonicalToken *token) {
  if (!fmt || !fmt->tokens || !fmt->compact_angles || !token || (!fmt_is_symbol(token, "<") && !fmt_is_symbol(token, ">"))) return false;
  size_t index = (size_t)(token - fmt->tokens->items);
  return index < fmt->tokens->len && fmt->compact_angles[index];
}

static bool fmt_compact_angle_pair(const CanonFormat *fmt, const ZCanonicalToken *left, const ZCanonicalToken *right) {
  if (!left || !right) return false;
  if (fmt_token_is_compact_angle(fmt, right)) return true;
  if (fmt_token_is_compact_angle(fmt, left) && fmt_is_symbol(left, "<")) return true;
  return fmt_token_is_compact_angle(fmt, left) && fmt_is_symbol(left, ">") && (fmt_is_symbol(right, ">") || fmt_is_symbol(right, "("));
}

static void fmt_push_brace(CanonFormat *fmt, unsigned char flags) {
  if (fmt->brace_depth == fmt->brace_cap) {
    size_t next_cap = z_grow_capacity(fmt->brace_cap, fmt->brace_depth + 1, 64);
    fmt->brace_flags = z_checked_reallocarray(fmt->brace_flags, next_cap, sizeof(unsigned char));
    fmt->brace_cap = next_cap;
  }
  fmt->brace_flags[fmt->brace_depth++] = flags;
}

static bool fmt_current_brace(const CanonFormat *fmt, unsigned char flag) { return fmt->brace_depth > 0 && (fmt->brace_flags[fmt->brace_depth - 1] & flag) != 0; }

static bool fmt_starts_declaration(const ZCanonicalToken *token) {
  return fmt_is_word(token, "use") || fmt_is_word(token, "extern") || fmt_is_word(token, "const") ||
    fmt_is_word(token, "alias") || fmt_is_word(token, "type") || fmt_is_word(token, "packed") ||
    fmt_is_word(token, "enum") || fmt_is_word(token, "choice") || fmt_is_word(token, "interface") ||
    fmt_is_word(token, "fn") || fmt_is_word(token, "pub") || fmt_is_word(token, "export") ||
    fmt_is_word(token, "test");
}

static bool fmt_line_opens_multiline_brace(const CanonFormat *fmt) {
  if (fmt->line_has_assignment) return false;
  const ZCanonicalToken *first = fmt->line_first;
  return fmt_is_word(first, "type") || fmt_is_word(first, "packed") || fmt_is_word(first, "enum") ||
    fmt_is_word(first, "choice") || fmt_is_word(first, "interface") || fmt_is_word(first, "extern") || fmt_is_word(first, "fn") ||
    fmt_is_word(first, "pub") || fmt_is_word(first, "export") || fmt_is_word(first, "test") ||
    fmt_is_word(first, "if") || fmt_is_word(first, "else") || fmt_is_word(first, "while") ||
    fmt_is_word(first, "for") || fmt_is_word(first, "match") ||
    fmt_is_symbol(first, ".");
}

static bool fmt_operator(const ZCanonicalToken *token) {
  return fmt_is_symbol(token, "=") || fmt_is_symbol(token, "->") || fmt_is_symbol(token, "=>") ||
    fmt_is_symbol(token, "+") || fmt_is_symbol(token, "-") || fmt_is_symbol(token, "*") ||
    fmt_is_symbol(token, "/") || fmt_is_symbol(token, "%") || fmt_is_symbol(token, "==") ||
    fmt_is_symbol(token, "!=") || fmt_is_symbol(token, "<=") || fmt_is_symbol(token, ">=") ||
    fmt_is_symbol(token, "&&") || fmt_is_symbol(token, "||") || fmt_is_symbol(token, "+%") ||
    fmt_is_symbol(token, "+|");
}

static bool fmt_prefix_context(const ZCanonicalToken *token) {
  if (!token) return true;
  if (fmt_operator(token) || fmt_is_symbol(token, "(") || fmt_is_symbol(token, "[") || fmt_is_symbol(token, "{") ||
      fmt_is_symbol(token, "<") || fmt_is_symbol(token, ">") || fmt_is_symbol(token, ",") || fmt_is_symbol(token, ":") || fmt_is_symbol(token, ";")) return true;
  return fmt_is_word(token, "if") || fmt_is_word(token, "while") || fmt_is_word(token, "return") || fmt_is_word(token, "check") || fmt_is_word(token, "expect") || fmt_is_word(token, "rescue");
}

static bool fmt_prefix_operator_pair(const CanonFormat *fmt, const ZCanonicalToken *left, const ZCanonicalToken *right) {
  if (!left || !right) return false;
  return fmt_is_symbol(left, "&") || fmt_is_symbol(left, "!") || ((fmt_is_symbol(left, "-") || fmt_is_symbol(left, "+") || fmt_is_symbol(left, "*")) && fmt_prefix_context(fmt->before_previous));
}

static bool fmt_operand_can_take_postfix(const ZCanonicalToken *token) {
  return token && (token->kind == Z_CANON_TOKEN_WORD || token->kind == Z_CANON_TOKEN_STRING ||
                   token->kind == Z_CANON_TOKEN_CHAR || token->kind == Z_CANON_TOKEN_NUMBER ||
                   fmt_is_symbol(token, ")") || fmt_is_symbol(token, "]"));
}

static bool fmt_space_before(const CanonFormat *fmt, const ZCanonicalToken *token) {
  const ZCanonicalToken *prev = fmt->previous;
  if (!prev || fmt->line_start) return false;
  if (fmt_is_symbol(token, ",") || fmt_is_symbol(token, ":") || fmt_is_symbol(token, ";") || fmt_is_symbol(token, ")") || fmt_is_symbol(token, "]")) return false;
  if (fmt_is_symbol(token, "}")) return !fmt_is_symbol(prev, "{");
  if (fmt_is_symbol(token, ".") || fmt_is_symbol(prev, ".")) return false;
  if (fmt_is_symbol(token, "..") || fmt_is_symbol(prev, "..")) return false;
  if (fmt_prefix_operator_pair(fmt, prev, token)) return false;
  if (fmt_is_symbol(prev, "]") && token->kind == Z_CANON_TOKEN_WORD && !fmt_is_word(token, "as") && !fmt_is_word(token, "err") && !fmt_is_word(token, "in")) return false;
  if (fmt_compact_angle_pair(fmt, prev, token)) return false;
  if (fmt_is_symbol(token, "(")) {
    if (fmt_is_symbol(prev, "]")) return false;
    if (prev->kind == Z_CANON_TOKEN_WORD && !fmt_is_word(prev, "if") && !fmt_is_word(prev, "while") &&
        !fmt_is_word(prev, "for") && !fmt_is_word(prev, "match") && !fmt_is_word(prev, "return") &&
        !fmt_is_word(prev, "check") && !fmt_is_word(prev, "expect") && !fmt_is_word(prev, "rescue")) return false;
    return !(fmt_is_symbol(prev, "(") || fmt_is_symbol(prev, "["));
  }
  if (fmt_is_symbol(token, "[")) {
    if (fmt_is_word(prev, "raises")) return true;
    if (fmt_operand_can_take_postfix(prev)) return false;
    return !(fmt_is_symbol(prev, "(") || fmt_is_symbol(prev, "[") || fmt_is_symbol(prev, "<"));
  }
  if (fmt_is_symbol(prev, "(") || fmt_is_symbol(prev, "[")) return false;
  if (fmt_is_symbol(token, "{")) return true;
  if (fmt_is_symbol(prev, "{")) return true;
  if (fmt_operator(prev) || fmt_operator(token) || fmt_is_symbol(token, "<") || fmt_is_symbol(token, ">") || fmt_is_symbol(prev, ":") || fmt_is_symbol(prev, ",") || fmt_is_symbol(prev, ";")) return true;
  return true;
}

static void fmt_emit_token(CanonFormat *fmt, const ZCanonicalToken *token) {
  if (fmt_space_before(fmt, token)) fmt_append_char(fmt->out, ' ');
  fmt_indent(fmt);
  fmt_append(fmt->out, token->text);
  if (!fmt->line_first && (token->kind != Z_CANON_TOKEN_SYMBOL || fmt_is_symbol(token, "."))) fmt->line_first = token;
  if (fmt_is_symbol(token, "=")) fmt->line_has_assignment = true;
  if (fmt_is_word(token, "type") || fmt_is_word(token, "packed") || fmt_is_word(token, "extern") ||
      fmt_is_word(token, "enum") || fmt_is_word(token, "choice")) fmt->line_has_list_declaration = true;
  fmt->before_previous = fmt->previous;
  fmt->previous = token;
}

static void fmt_note_delimiter(CanonFormat *fmt, const ZCanonicalToken *token) {
  if (fmt_is_symbol(token, "(")) fmt->paren_depth++;
  else if (fmt_is_symbol(token, ")") && fmt->paren_depth > 0) fmt->paren_depth--;
  else if (fmt_is_symbol(token, "[")) fmt->bracket_depth++;
  else if (fmt_is_symbol(token, "]") && fmt->bracket_depth > 0) fmt->bracket_depth--;
  else if (fmt_token_is_compact_angle(fmt, token) && fmt_is_symbol(token, "<")) fmt->angle_depth++;
  else if (fmt_token_is_compact_angle(fmt, token) && fmt_is_symbol(token, ">") && fmt->angle_depth > 0) fmt->angle_depth--;
}

static bool fmt_at_list_item_separator(const CanonFormat *fmt) {
  return fmt_current_brace(fmt, FMT_BRACE_LIST) && fmt->paren_depth == 0 && fmt->bracket_depth == 0 && fmt->angle_depth == 0;
}

bool z_canonical_text_format(const ZCanonicalTokenVec *tokens, ZBuf *out, ZDiag *diag) {
  if (!tokens || !out) return false;
  CanonFormat fmt = {.tokens = tokens, .out = out, .compact_angles = fmt_build_compact_angles(tokens), .line_start = true};
  for (size_t i = 0; i < tokens->len; i++) {
    const ZCanonicalToken *token = &tokens->items[i];
    if (token->kind == Z_CANON_TOKEN_EOF) break;
    if (token->kind == Z_CANON_TOKEN_NEWLINE) {
      const ZCanonicalToken *next = fmt_next_significant(tokens, i);
      size_t j = i + 1;
      while (j < tokens->len && tokens->items[j].kind == Z_CANON_TOKEN_NEWLINE) j++;
      const ZCanonicalToken *next_non_newline = j < tokens->len ? &tokens->items[j] : NULL;
      if (fmt_is_symbol(fmt.previous, "}") && fmt_is_word(next_non_newline, "else")) continue;
      if (next && fmt.indent == 0 && fmt_starts_declaration(next) && fmt.out->len > 0) fmt_blank_line(&fmt);
      else fmt_newline(&fmt);
      continue;
    }
    if (token->kind == Z_CANON_TOKEN_COMMENT) {
      if (!fmt.line_start) fmt_append_char(out, ' ');
      fmt_indent(&fmt);
      fmt_append(out, token->text);
      fmt_newline(&fmt);
      continue;
    }
    if (fmt_is_symbol(token, "{")) {
      const ZCanonicalToken *next = fmt_next_significant(tokens, i);
      bool multiline = next && !fmt_is_symbol(next, "}") && (fmt_line_opens_multiline_brace(&fmt) || fmt_current_brace(&fmt, FMT_BRACE_MATCH));
      unsigned char flags = multiline ? FMT_BRACE_MULTILINE : 0;
      if (multiline && fmt.line_has_list_declaration) flags |= FMT_BRACE_LIST;
      if (multiline && fmt_is_word(fmt.line_first, "match")) flags |= FMT_BRACE_MATCH;
      fmt_push_brace(&fmt, flags);
      fmt_emit_token(&fmt, token);
      if (multiline) {
        fmt.indent++;
        fmt_newline(&fmt);
      }
      continue;
    }
    if (fmt_is_symbol(token, "}")) {
      bool multiline = fmt_current_brace(&fmt, FMT_BRACE_MULTILINE);
      if (multiline) {
        if (!fmt.line_start) fmt_newline(&fmt);
        if (fmt.indent > 0) fmt.indent--;
      }
      if (fmt.brace_depth > 0) fmt.brace_depth--;
      fmt_emit_token(&fmt, token);
      const ZCanonicalToken *next = fmt_next_significant(tokens, i);
      if (multiline && next && !fmt_is_word(next, "else") && !fmt_is_symbol(next, ",") && !fmt_is_symbol(next, ")") && !fmt_is_symbol(next, "]")) {
        if (fmt.indent == 0 && fmt_starts_declaration(next)) fmt_blank_line(&fmt);
        else fmt_newline(&fmt);
      }
      continue;
    }
    if (fmt_is_symbol(token, ",") && fmt_at_list_item_separator(&fmt)) {
      fmt_emit_token(&fmt, token);
      const ZCanonicalToken *next = fmt_next_significant(tokens, i);
      if (next && !fmt_is_symbol(next, "}")) fmt_newline(&fmt);
      continue;
    }
    fmt_emit_token(&fmt, token);
    fmt_note_delimiter(&fmt, token);
  }
  fmt_newline(&fmt);
  free(fmt.compact_angles);
  free(fmt.brace_flags);
  (void)diag;
  return true;
}

bool z_canonical_text_format_source(const char *source, ZBuf *out, ZDiag *diag) {
  ZDiag local_diag = {0};
  ZDiag *active_diag = diag ? diag : &local_diag;
  ZCanonicalTokenVec tokens = z_canonical_text_tokenize(source, active_diag);
  if (active_diag->code != 0) {
    z_free_canonical_text_tokens(&tokens);
    return false;
  }
  ZCanonicalTree tree = {0};
  ZCanonicalFacts facts = {0};
  if (!z_canonical_text_parse(&tokens, &tree, &facts, active_diag)) {
    z_free_canonical_text_tree(&tree);
    z_free_canonical_text_tokens(&tokens);
    return false;
  }
  bool ok = z_canonical_text_format(&tokens, out, active_diag);
  z_free_canonical_text_tree(&tree);
  z_free_canonical_text_tokens(&tokens);
  if (!ok) return false;
  ZCanonicalTokenVec formatted_tokens = z_canonical_text_tokenize(out->data ? out->data : "", active_diag);
  if (active_diag->code != 0) {
    z_free_canonical_text_tokens(&formatted_tokens);
    return false;
  }
  ZCanonicalTree formatted_tree = {0};
  ZCanonicalFacts formatted_facts = {0};
  ok = z_canonical_text_parse(&formatted_tokens, &formatted_tree, &formatted_facts, active_diag);
  z_free_canonical_text_tree(&formatted_tree);
  z_free_canonical_text_tokens(&formatted_tokens);
  return ok;
}
