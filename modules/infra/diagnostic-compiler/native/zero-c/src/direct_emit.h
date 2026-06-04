#ifndef ZERO_C_DIRECT_EMIT_H
#define ZERO_C_DIRECT_EMIT_H

#include "zero.h"

#include <stdio.h>

static inline bool z_direct_exe_reject_c_import_calls(const IrProgram *program, ZDiag *diag, const char *backend_name) {
  if (!program || program->direct_c_import_call_count == 0) return true;
  const char *symbol = (program->external_function_len > 0 && program->external_functions[0].symbol) ? program->external_functions[0].symbol : "extern C call";
  if (diag) {
    diag->code = 4004;
    diag->line = 1;
    diag->column = 1;
    diag->length = 1;
    snprintf(diag->message, sizeof(diag->message), "direct %s executable backend requires object emission and an explicit link step for extern C calls", backend_name ? backend_name : "native");
    snprintf(diag->expected, sizeof(diag->expected), "direct executable without extern C calls");
    snprintf(diag->actual, sizeof(diag->actual), "%s", symbol);
    snprintf(diag->help, sizeof(diag->help), "emit an object and link it with the required C libraries");
  }
  return false;
}

#endif
