#ifndef ZERO_C_MACHO_FORMAT_H
#define ZERO_C_MACHO_FORMAT_H

#include "zero.h"

#include <stdint.h>

typedef struct {
  uint32_t string_offset;
  unsigned char type;
  unsigned char section;
  uint16_t desc;
  uint64_t value;
} ZMachOSymbol;

typedef enum {
  Z_MACHO_CPU_ARM64,
  Z_MACHO_CPU_X86_64
} ZMachOCpu;

typedef struct {
  ZMachOCpu cpu;
  const ZBuf *text;
  const ZBuf *rodata;
  const ZBuf *relocs;
  const ZBuf *strings;
  const ZMachOSymbol *symbols;
  size_t symbol_len;
  uint32_t text_reloc_count;
} ZMachOObjectImage;

typedef struct {
  uint64_t base_addr;
  uint32_t page_size;
  uint32_t header_size;
  uint32_t pagezero_cmd_size;
  uint32_t text_segment_cmd_size;
  uint32_t linkedit_cmd_size;
  uint32_t dyld_info_cmd_size;
  uint32_t uuid_cmd_size;
  uint32_t dylinker_cmd_size;
  uint32_t libsystem_cmd_size;
  uint32_t main_cmd_size;
  uint32_t build_version_cmd_size;
  uint32_t code_signature_cmd_size;
  uint32_t sizeofcmds;
  uint32_t text_offset;
  uint32_t rodata_offset;
  uint64_t segment_file_size;
  uint64_t segment_vm_size;
  uint32_t rebase_offset;
  uint32_t rebase_size;
  uint32_t code_signature_offset;
  uint32_t code_signature_size;
  uint64_t linkedit_vmaddr;
  uint64_t linkedit_vmsize;
} ZMachOExecutableLayout;

typedef struct {
  ZMachOCpu cpu;
  const ZBuf *text;
  const ZBuf *rodata;
  const ZBuf *rebase;
  ZMachOExecutableLayout layout;
  const char *code_signature_id;
} ZMachOExecutableImage;

size_t z_macho_align(size_t value, size_t alignment);
void z_macho_append_u8(ZBuf *buf, unsigned value);
void z_macho_append_u16(ZBuf *buf, uint16_t value);
void z_macho_append_u32(ZBuf *buf, uint32_t value);
void z_macho_append_u64(ZBuf *buf, uint64_t value);
void z_macho_patch_u64(ZBuf *buf, size_t offset, uint64_t value);
void z_macho_append_bytes(ZBuf *buf, const char *bytes, size_t len);
void z_macho_pad_to(ZBuf *buf, size_t offset);
void z_macho_append_uleb128(ZBuf *buf, uint64_t value);
void z_macho_write_object64(ZBuf *out, const ZMachOObjectImage *image);
void z_macho_compute_executable64_layout(ZMachOExecutableLayout *layout, const ZBuf *text, const ZBuf *rodata, const ZBuf *rebase, const char *code_signature_id);
void z_macho_write_executable64(ZBuf *out, const ZMachOExecutableImage *image);

#endif
