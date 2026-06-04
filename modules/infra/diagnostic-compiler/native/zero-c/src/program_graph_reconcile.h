#ifndef ZERO_C_PROGRAM_GRAPH_RECONCILE_H
#define ZERO_C_PROGRAM_GRAPH_RECONCILE_H

#include "program_graph.h"

typedef struct {
  bool ok;
  bool patch_available;
  bool module_identity_changed;
  size_t unchanged;
  size_t edited;
  size_t inserted;
  size_t deleted;
  size_t ambiguous;
  size_t identity_changed;
} ZProgramGraphReconcileSummary;

void z_program_graph_reconcile_summary(const ZProgramGraph *base, const ZProgramGraph *edited, ZProgramGraphReconcileSummary *out);
void z_program_graph_append_reconcile_json(ZBuf *buf,
                                           const ZProgramGraph *base,
                                           const ZProgramGraph *edited,
                                           const char *base_path,
                                           const char *edited_path,
                                           const ZProgramGraphReconcileSummary *summary);

#endif
