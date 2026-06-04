#include "zero.h"
#include "aarch64_direct.h"

size_t z_direct_target_stack_bytes(const ZTargetInfo *target, const IrProgram *program) {
  if (!program) return 0;
  if (z_direct_object_backend(target) == Z_DIRECT_BACKEND_MACHO64 ||
      z_direct_exe_backend(target) == Z_DIRECT_BACKEND_MACHO64) {
    return z_macho64_stack_bytes_from_ir(program);
  }
  if (z_direct_object_backend(target) == Z_DIRECT_BACKEND_ELF_AARCH64 ||
      z_direct_exe_backend(target) == Z_DIRECT_BACKEND_ELF_AARCH64 ||
      z_direct_object_backend(target) == Z_DIRECT_BACKEND_COFF_AARCH64 ||
      z_direct_exe_backend(target) == Z_DIRECT_BACKEND_COFF_AARCH64) {
    return z_aarch64_direct_stack_bytes_from_ir(program);
  }
  return program->direct_stack_bytes;
}

size_t z_direct_target_max_frame_bytes(const ZTargetInfo *target, const IrProgram *program) {
  if (!program) return 0;
  if (z_direct_object_backend(target) == Z_DIRECT_BACKEND_MACHO64 ||
      z_direct_exe_backend(target) == Z_DIRECT_BACKEND_MACHO64) {
    return z_macho64_max_frame_bytes_from_ir(program);
  }
  if (z_direct_object_backend(target) == Z_DIRECT_BACKEND_ELF_AARCH64 ||
      z_direct_exe_backend(target) == Z_DIRECT_BACKEND_ELF_AARCH64 ||
      z_direct_object_backend(target) == Z_DIRECT_BACKEND_COFF_AARCH64 ||
      z_direct_exe_backend(target) == Z_DIRECT_BACKEND_COFF_AARCH64) {
    return z_aarch64_direct_max_frame_bytes_from_ir(program);
  }
  return program->direct_max_frame_bytes;
}
