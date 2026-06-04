#ifndef ZERO_C_PROGRAM_GRAPH_SOURCE_MAP_H
#define ZERO_C_PROGRAM_GRAPH_SOURCE_MAP_H

#include "program_graph.h"

typedef struct {
  void *files;
  size_t file_len;
  size_t file_cap;
} ZProgramGraphSourceRangeContext;

void z_program_graph_source_range_context_init(ZProgramGraphSourceRangeContext *context, const ZProgramGraph *graph);
void z_program_graph_source_range_context_free(ZProgramGraphSourceRangeContext *context);
void z_program_graph_append_source_map_json(ZBuf *buf, const ZProgramGraph *graph, const char *input_path);
void z_program_graph_append_source_range_json(ZBuf *buf, const ZProgramGraphNode *node, const char *fallback_path);
void z_program_graph_append_source_range_for_graph_json(ZBuf *buf, const ZProgramGraph *graph, const ZProgramGraphNode *node, const char *fallback_path);
void z_program_graph_append_source_range_from_context_json(ZBuf *buf, const ZProgramGraphSourceRangeContext *context, const ZProgramGraph *graph, const ZProgramGraphNode *node, const char *fallback_path);
size_t z_program_graph_source_map_count(const ZProgramGraph *graph);

#endif
