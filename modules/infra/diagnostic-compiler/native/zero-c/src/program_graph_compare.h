#ifndef ZERO_C_PROGRAM_GRAPH_COMPARE_H
#define ZERO_C_PROGRAM_GRAPH_COMPARE_H

#include "program_graph.h"

typedef struct {
  bool ok;
  char code[16];
  char message[160];
  char field[32];
  size_t left_index;
  size_t right_index;
  size_t left_count;
  size_t right_count;
  size_t left_semantic_nodes;
  size_t right_semantic_nodes;
  size_t left_semantic_edges;
  size_t right_semantic_edges;
} ZProgramGraphCompare;

bool z_program_graph_semantic_compare(const ZProgramGraph *left, const ZProgramGraph *right, ZProgramGraphCompare *out);

#endif
