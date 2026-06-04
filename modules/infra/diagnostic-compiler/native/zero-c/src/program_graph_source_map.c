#include "program_graph_source_map.h"

#include "canonical_text.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  char *path;
  char *text;
  ZCanonicalTokenVec tokens;
  size_t node_count;
  bool readable;
  bool tokenized;
} GraphSourceMapFile;

typedef struct {
  const char *path;
  int start_line;
  int start_column;
  int end_line;
  int end_column;
} GraphSourceRange;

static bool source_map_text_eq(const char *left, const char *right) {
  return strcmp(left ? left : "", right ? right : "") == 0;
}

static uint64_t source_map_hash_text(const char *text) {
  uint64_t hash = 1469598103934665603ull;
  for (const unsigned char *cursor = (const unsigned char *)(text ? text : ""); *cursor; cursor++) {
    hash ^= (uint64_t)*cursor;
    hash *= 1099511628211ull;
  }
  return hash;
}

static size_t source_map_line_count(const char *text) {
  if (!text || !text[0]) return 0;
  size_t lines = 1;
  for (const char *cursor = text; *cursor; cursor++) {
    if (*cursor == '\n' && cursor[1]) lines++;
  }
  return lines;
}

static void source_map_json_string(ZBuf *buf, const char *value) {
  zbuf_append_char(buf, '"');
  for (const unsigned char *cursor = (const unsigned char *)(value ? value : ""); *cursor; cursor++) {
    unsigned char ch = *cursor;
    switch (ch) {
      case '"': zbuf_append(buf, "\\\""); break;
      case '\\': zbuf_append(buf, "\\\\"); break;
      case '\n': zbuf_append(buf, "\\n"); break;
      case '\r': zbuf_append(buf, "\\r"); break;
      case '\t': zbuf_append(buf, "\\t"); break;
      default:
        if (ch < 0x20) zbuf_appendf(buf, "\\u%04x", (unsigned)ch);
        else zbuf_append_char(buf, (char)ch);
        break;
    }
  }
  zbuf_append_char(buf, '"');
}

static int source_map_start_line(const ZProgramGraphNode *node) {
  return node && node->line > 0 ? node->line : 1;
}

static int source_map_start_column(const ZProgramGraphNode *node) {
  return node && node->column > 0 ? node->column : 1;
}

static bool source_map_token_text_eq(const ZCanonicalToken *token, const char *text) {
  return token && text && text[0] && source_map_text_eq(token->text, text);
}

static const char *source_map_node_keyword(const ZProgramGraphNode *node) {
  if (!node) return NULL;
  switch (node->kind) {
    case Z_PROGRAM_GRAPH_NODE_CONST: return "const";
    case Z_PROGRAM_GRAPH_NODE_TYPE_ALIAS: return "alias";
    case Z_PROGRAM_GRAPH_NODE_SHAPE: return "shape";
    case Z_PROGRAM_GRAPH_NODE_INTERFACE: return "interface";
    case Z_PROGRAM_GRAPH_NODE_ENUM: return "enum";
    case Z_PROGRAM_GRAPH_NODE_CHOICE: return "choice";
    case Z_PROGRAM_GRAPH_NODE_FUNCTION: return "fn";
    case Z_PROGRAM_GRAPH_NODE_LET: return "let";
    case Z_PROGRAM_GRAPH_NODE_ASSIGNMENT: return "set";
    case Z_PROGRAM_GRAPH_NODE_DEFER: return "defer";
    case Z_PROGRAM_GRAPH_NODE_CHECK: return "check";
    case Z_PROGRAM_GRAPH_NODE_RETURN: return "return";
    case Z_PROGRAM_GRAPH_NODE_IF: return "if";
    case Z_PROGRAM_GRAPH_NODE_WHILE: return "while";
    case Z_PROGRAM_GRAPH_NODE_FOR: return "for";
    case Z_PROGRAM_GRAPH_NODE_BREAK: return "break";
    case Z_PROGRAM_GRAPH_NODE_CONTINUE: return "continue";
    case Z_PROGRAM_GRAPH_NODE_MATCH: return "match";
    case Z_PROGRAM_GRAPH_NODE_RAISE: return "raise";
    case Z_PROGRAM_GRAPH_NODE_EFFECT_REF: return "raises";
    default: return NULL;
  }
}

static bool source_map_literal_token_candidate(const ZProgramGraphNode *node, const ZCanonicalToken *token, int *priority) {
  if (!node || !token || node->kind != Z_PROGRAM_GRAPH_NODE_LITERAL) return false;
  if (source_map_token_text_eq(token, node->value)) {
    if (priority) *priority = 0;
    return true;
  }
  if (token->kind == Z_CANON_TOKEN_STRING || token->kind == Z_CANON_TOKEN_CHAR) {
    if (priority) *priority = 0;
    return true;
  }
  if (token->kind == Z_CANON_TOKEN_NUMBER && node->value && node->value[0]) {
    if (priority) *priority = 1;
    return true;
  }
  if (token->kind == Z_CANON_TOKEN_WORD &&
      (source_map_text_eq(node->value, "true") || source_map_text_eq(node->value, "false") || source_map_text_eq(node->value, "null"))) {
    if (priority) *priority = 0;
    return true;
  }
  return false;
}

static bool source_map_token_candidate(const ZProgramGraphNode *node, const ZCanonicalToken *token, int *priority) {
  if (!node || !token || token->kind == Z_CANON_TOKEN_NEWLINE || token->kind == Z_CANON_TOKEN_COMMENT || token->kind == Z_CANON_TOKEN_EOF) return false;
  if (source_map_literal_token_candidate(node, token, priority)) return true;
  if (source_map_token_text_eq(token, node->name)) {
    if (priority) *priority = 0;
    return true;
  }
  if (source_map_token_text_eq(token, node->value)) {
    if (priority) *priority = 0;
    return true;
  }
  if (source_map_token_text_eq(token, node->type)) {
    if (priority) *priority = 1;
    return true;
  }
  if (source_map_token_text_eq(token, source_map_node_keyword(node))) {
    if (priority) *priority = 2;
    return true;
  }
  return false;
}

static int source_map_column_distance(int left, int right) {
  int delta = left - right;
  return delta < 0 ? -delta : delta;
}

static const char *source_map_node_signature_text(const ZProgramGraphNode *node) {
  if (!node) return NULL;
  if (node->kind == Z_PROGRAM_GRAPH_NODE_LITERAL && node->value && node->value[0]) return node->value;
  if (node->name && node->name[0]) return node->name;
  if (node->value && node->value[0]) return node->value;
  if (node->type && node->type[0]) return node->type;
  return source_map_node_keyword(node);
}

static bool source_map_same_node_signature(const ZProgramGraphNode *left, const ZProgramGraphNode *right) {
  const char *left_text = source_map_node_signature_text(left);
  const char *right_text = source_map_node_signature_text(right);
  return left &&
         right &&
         left->kind == right->kind &&
         source_map_text_eq(left->path, right->path) &&
         source_map_start_line(left) == source_map_start_line(right) &&
         left_text &&
         left_text[0] &&
         source_map_text_eq(left_text, right_text);
}

static size_t source_map_node_occurrence(const ZProgramGraph *graph, const ZProgramGraphNode *node) {
  size_t occurrence = 0;
  for (size_t i = 0; graph && node && i < graph->node_len; i++) {
    const ZProgramGraphNode *candidate = &graph->nodes[i];
    if (candidate == node || source_map_text_eq(candidate->id, node->id)) return occurrence;
    if (source_map_same_node_signature(candidate, node)) occurrence++;
  }
  return 0;
}

static const ZCanonicalToken *source_map_find_occurrence_token(const ZProgramGraphNode *node, const ZCanonicalTokenVec *tokens, size_t occurrence) {
  if (!node || !tokens || tokens->len == 0 || occurrence == 0) return NULL;
  bool found_priority = false;
  int best_priority = 0;
  int line = source_map_start_line(node);
  for (size_t i = 0; i < tokens->len; i++) {
    const ZCanonicalToken *token = &tokens->items[i];
    int priority = 0;
    if (token->line != line || !source_map_token_candidate(node, token, &priority)) continue;
    if (!found_priority || priority < best_priority) {
      found_priority = true;
      best_priority = priority;
    }
  }
  if (!found_priority) return NULL;

  size_t seen = 0;
  for (size_t i = 0; i < tokens->len; i++) {
    const ZCanonicalToken *token = &tokens->items[i];
    int priority = 0;
    if (token->line != line || !source_map_token_candidate(node, token, &priority) || priority != best_priority) continue;
    if (seen == occurrence) return token;
    seen++;
  }
  return NULL;
}

static const ZCanonicalToken *source_map_find_token(const ZProgramGraphNode *node, const ZCanonicalTokenVec *tokens, size_t occurrence) {
  if (!node || !tokens || tokens->len == 0) return NULL;
  const ZCanonicalToken *occurrence_token = source_map_find_occurrence_token(node, tokens, occurrence);
  if (occurrence_token) return occurrence_token;

  const ZCanonicalToken *best = NULL;
  int line = source_map_start_line(node);
  int column = source_map_start_column(node);
  int best_priority = 0;
  int best_distance = 0;
  for (size_t i = 0; i < tokens->len; i++) {
    const ZCanonicalToken *token = &tokens->items[i];
    int priority = 0;
    if (token->line != line || !source_map_token_candidate(node, token, &priority)) continue;
    int distance = source_map_column_distance(token->column, column);
    if (!best || priority < best_priority || (priority == best_priority && distance < best_distance) ||
        (priority == best_priority && distance == best_distance && token->column >= column && best->column < column)) {
      best = token;
      best_priority = priority;
      best_distance = distance;
    }
  }
  return best;
}

static GraphSourceRange source_map_resolve_range(const ZProgramGraphNode *node, const char *fallback_path, const ZCanonicalTokenVec *tokens, size_t occurrence) {
  GraphSourceRange range = {
    .path = node && node->path && node->path[0] ? node->path : (fallback_path ? fallback_path : ""),
    .start_line = source_map_start_line(node),
    .start_column = source_map_start_column(node),
    .end_line = source_map_start_line(node),
    .end_column = source_map_start_column(node) + 1,
  };
  const ZCanonicalToken *token = source_map_find_token(node, tokens, occurrence);
  if (token) {
    range.start_line = token->line > 0 ? token->line : range.start_line;
    range.start_column = token->column > 0 ? token->column : range.start_column;
    range.end_line = range.start_line;
    range.end_column = range.start_column + (token->length > 0 ? (int)token->length : 1);
  }
  return range;
}

static void source_map_append_range_value_json(ZBuf *buf, const GraphSourceRange *range) {
  int start_line = range ? range->start_line : 1;
  int start_column = range ? range->start_column : 1;
  int end_line = range ? range->end_line : start_line;
  int end_column = range ? range->end_column : start_column + 1;
  zbuf_append(buf, "{\"path\":");
  source_map_json_string(buf, range ? range->path : "");
  zbuf_appendf(buf,
               ",\"start\":{\"line\":%d,\"column\":%d},\"end\":{\"line\":%d,\"column\":%d},\"columnUnit\":\"utf8-byte\"}",
               start_line,
               start_column,
               end_line,
               end_column);
}

static void source_map_append_range_json(ZBuf *buf, const ZProgramGraphNode *node, const char *fallback_path, const ZCanonicalTokenVec *tokens, size_t occurrence) {
  GraphSourceRange range = source_map_resolve_range(node, fallback_path, tokens, occurrence);
  source_map_append_range_value_json(buf, &range);
}

static size_t source_map_file_index(GraphSourceMapFile *files, size_t len, const char *path) {
  for (size_t i = 0; i < len; i++) {
    if (source_map_text_eq(files[i].path, path)) return i;
  }
  return (size_t)-1;
}

static void source_map_collect_file(GraphSourceMapFile **files, size_t *len, size_t *cap, const char *path) {
  if (!path || !path[0]) return;
  size_t index = source_map_file_index(*files, *len, path);
  if (index != (size_t)-1) {
    (*files)[index].node_count++;
    return;
  }
  if (*len == *cap) {
    size_t next = *cap ? *cap * 2 : 4;
    *files = z_checked_reallocarray(*files, next, sizeof(GraphSourceMapFile));
    for (size_t i = *cap; i < next; i++) (*files)[i] = (GraphSourceMapFile){0};
    *cap = next;
  }
  (*files)[*len].path = z_strdup(path);
  (*files)[*len].node_count = 1;
  (*len)++;
}

static void source_map_load_file(GraphSourceMapFile *file) {
  if (!file || !file->path || !file->path[0]) return;
  ZDiag diag = {0};
  file->text = z_read_file(file->path, &diag);
  file->readable = file->text != NULL;
  if (!file->text) return;
  ZDiag token_diag = {0};
  file->tokens = z_canonical_text_tokenize(file->text, &token_diag);
  file->tokenized = token_diag.code == 0;
  if (!file->tokenized) z_free_canonical_text_tokens(&file->tokens);
}

static void source_map_append_file_json(ZBuf *buf, const GraphSourceMapFile *file) {
  zbuf_append(buf, "{\"path\":");
  source_map_json_string(buf, file ? file->path : "");
  zbuf_appendf(buf,
               ",\"sourceHash\":\"%016llx\",\"lineCount\":%zu,\"nodeCount\":%zu,\"columnUnit\":\"utf8-byte\",\"readable\":%s}",
               (unsigned long long)source_map_hash_text(file && file->text ? file->text : ""),
               source_map_line_count(file && file->text ? file->text : ""),
               file ? file->node_count : 0,
               file && file->readable ? "true" : "false");
}

static const ZCanonicalTokenVec *source_map_tokens_for_node(const GraphSourceMapFile *files, size_t file_len, const ZProgramGraphNode *node) {
  if (!node || !node->path || !node->path[0]) return NULL;
  for (size_t i = 0; files && i < file_len; i++) {
    if (source_map_text_eq(files[i].path, node->path)) return files[i].tokenized ? &files[i].tokens : NULL;
  }
  return NULL;
}

static void source_map_append_node_json(ZBuf *buf, const ZProgramGraph *graph, const ZProgramGraphNode *node, const char *input_path, const ZCanonicalTokenVec *tokens) {
  zbuf_append(buf, "{\"nodeId\":");
  source_map_json_string(buf, node ? node->id : "");
  zbuf_append(buf, ",\"kind\":");
  source_map_json_string(buf, node ? z_program_graph_node_kind_name(node->kind) : "");
  zbuf_append(buf, ",\"name\":");
  source_map_json_string(buf, node ? node->name : "");
  zbuf_append(buf, ",\"type\":");
  source_map_json_string(buf, node ? node->type : "");
  zbuf_append(buf, ",\"value\":");
  source_map_json_string(buf, node ? node->value : "");
  zbuf_append(buf, ",\"nodeHash\":");
  source_map_json_string(buf, node ? node->node_hash : "");
  zbuf_append(buf, ",\"symbolId\":");
  source_map_json_string(buf, node ? node->symbol_id : "");
  zbuf_append(buf, ",\"typeId\":");
  source_map_json_string(buf, node ? node->type_id : "");
  zbuf_append(buf, ",\"effectId\":");
  source_map_json_string(buf, node ? node->effect_id : "");
  zbuf_append(buf, ",\"sourceAvailable\":");
  zbuf_append(buf, tokens ? "true" : "false");
  zbuf_append(buf, ",\"sourceRange\":");
  source_map_append_range_json(buf, node, node && node->path && node->path[0] ? node->path : input_path, tokens, source_map_node_occurrence(graph, node));
  zbuf_append(buf, "}");
}

size_t z_program_graph_source_map_count(const ZProgramGraph *graph) {
  return graph ? graph->node_len : 0;
}

void z_program_graph_source_range_context_init(ZProgramGraphSourceRangeContext *context, const ZProgramGraph *graph) {
  if (!context) return;
  *context = (ZProgramGraphSourceRangeContext){0};
  GraphSourceMapFile *files = NULL;
  size_t file_len = 0;
  size_t file_cap = 0;
  for (size_t i = 0; graph && i < graph->node_len; i++) {
    source_map_collect_file(&files, &file_len, &file_cap, graph->nodes[i].path);
  }
  for (size_t i = 0; i < file_len; i++) source_map_load_file(&files[i]);
  context->files = files;
  context->file_len = file_len;
  context->file_cap = file_cap;
}

void z_program_graph_source_range_context_free(ZProgramGraphSourceRangeContext *context) {
  if (!context) return;
  GraphSourceMapFile *files = (GraphSourceMapFile *)context->files;
  for (size_t i = 0; i < context->file_len; i++) {
    free(files[i].path);
    free(files[i].text);
    z_free_canonical_text_tokens(&files[i].tokens);
  }
  free(files);
  *context = (ZProgramGraphSourceRangeContext){0};
}

void z_program_graph_append_source_map_json(ZBuf *buf, const ZProgramGraph *graph, const char *input_path) {
  GraphSourceMapFile *files = NULL;
  size_t file_len = 0;
  size_t file_cap = 0;
  for (size_t i = 0; graph && i < graph->node_len; i++) {
    source_map_collect_file(&files, &file_len, &file_cap, graph->nodes[i].path);
  }
  for (size_t i = 0; i < file_len; i++) source_map_load_file(&files[i]);

  zbuf_append(buf, "{\n  \"schemaVersion\": 1,\n  \"ok\": true,\n  \"artifact\": ");
  source_map_json_string(buf, input_path ? input_path : "");
  zbuf_appendf(buf, ",\n  \"canonicalSource\": %s,\n  \"moduleIdentity\": ", graph && graph->canonical_source ? "true" : "false");
  source_map_json_string(buf, graph ? graph->module_identity : "");
  zbuf_append(buf, ",\n  \"graphHash\": ");
  source_map_json_string(buf, graph ? graph->graph_hash : "");
  zbuf_appendf(buf, ",\n  \"counts\": {\"files\": %zu, \"mappings\": %zu},\n  \"files\": [", file_len, graph ? graph->node_len : 0);
  for (size_t i = 0; i < file_len; i++) {
    if (i > 0) zbuf_append(buf, ", ");
    source_map_append_file_json(buf, &files[i]);
  }
  zbuf_append(buf, "],\n  \"mappings\": [");
  for (size_t i = 0; graph && i < graph->node_len; i++) {
    if (i > 0) zbuf_append(buf, ", ");
    source_map_append_node_json(buf, graph, &graph->nodes[i], input_path, source_map_tokens_for_node(files, file_len, &graph->nodes[i]));
  }
  zbuf_append(buf, "],\n  \"diagnostics\": []\n}\n");

  for (size_t i = 0; i < file_len; i++) {
    free(files[i].path);
    free(files[i].text);
    z_free_canonical_text_tokens(&files[i].tokens);
  }
  free(files);
}

void z_program_graph_append_source_range_json(ZBuf *buf, const ZProgramGraphNode *node, const char *fallback_path) {
  z_program_graph_append_source_range_for_graph_json(buf, NULL, node, fallback_path);
}

void z_program_graph_append_source_range_from_context_json(ZBuf *buf, const ZProgramGraphSourceRangeContext *context, const ZProgramGraph *graph, const ZProgramGraphNode *node, const char *fallback_path) {
  const GraphSourceMapFile *files = context ? (const GraphSourceMapFile *)context->files : NULL;
  const ZCanonicalTokenVec *tokens = source_map_tokens_for_node(files, context ? context->file_len : 0, node);
  GraphSourceRange range = source_map_resolve_range(node, fallback_path, tokens, source_map_node_occurrence(graph, node));
  source_map_append_range_value_json(buf, &range);
}

void z_program_graph_append_source_range_for_graph_json(ZBuf *buf, const ZProgramGraph *graph, const ZProgramGraphNode *node, const char *fallback_path) {
  char *text = NULL;
  ZCanonicalTokenVec tokens = {0};
  const char *path = node && node->path && node->path[0] ? node->path : fallback_path;
  if (path && path[0]) {
    ZDiag read_diag = {0};
    text = z_read_file(path, &read_diag);
    if (text) {
      ZDiag token_diag = {0};
      tokens = z_canonical_text_tokenize(text, &token_diag);
      if (token_diag.code != 0) z_free_canonical_text_tokens(&tokens);
    }
  }
  GraphSourceRange range = source_map_resolve_range(node, fallback_path, tokens.len > 0 ? &tokens : NULL, source_map_node_occurrence(graph, node));
  source_map_append_range_value_json(buf, &range);
  z_free_canonical_text_tokens(&tokens);
  free(text);
}
