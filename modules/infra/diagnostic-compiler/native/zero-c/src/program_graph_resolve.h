#ifndef ZERO_C_PROGRAM_GRAPH_RESOLVE_H
#define ZERO_C_PROGRAM_GRAPH_RESOLVE_H

#include "program_graph.h"

typedef struct {
  char *node_id;
  char *kind;
  char *name;
  char *qualified_name;
  char *scope_id;
  char *target_kind;
  char *target_node;
  char *symbol_id;
  char *via_import;
  bool resolved;
  bool ambiguous;
} ZProgramGraphResolutionReference;

typedef struct {
  ZProgramGraphResolutionReference *references;
  size_t reference_len;
  size_t diagnostic_len;
} ZProgramGraphResolutionFacts;

void z_program_graph_resolution_facts_init(ZProgramGraphResolutionFacts *facts);
void z_program_graph_resolution_facts_free(ZProgramGraphResolutionFacts *facts);
bool z_program_graph_collect_resolution_facts(const ZProgramGraph *graph, ZProgramGraphResolutionFacts *facts);
void z_program_graph_append_resolution_json(ZBuf *buf, const ZProgramGraph *graph);

#endif
