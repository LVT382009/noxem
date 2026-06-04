#ifndef ZERO_C_ELF_FORMAT_H
#define ZERO_C_ELF_FORMAT_H

#include "zero.h"

#include <stdint.h>

typedef enum {
  Z_ELF_MACHINE_X86_64 = 62,
  Z_ELF_MACHINE_AARCH64 = 183
} ZElfMachine;

typedef struct {
  ZElfMachine machine;
  const ZBuf *text;
  size_t text_align;
  const ZBuf *rodata;
  size_t rodata_align;
  const ZBuf *rela_text;
  const ZBuf *symtab;
  const ZBuf *strtab;
  uint32_t local_symbol_count;
} ZElfObjectImage;

typedef struct {
  ZElfMachine machine;
  uint64_t base_addr;
  uint64_t entry_addr;
  size_t text_offset;
  const ZBuf *text;
  const ZBuf *rodata;
  size_t rodata_offset;
  uint64_t segment_align;
} ZElfExecutableImage;

size_t z_elf_align(size_t value, size_t alignment);
void z_elf_append_u8(ZBuf *buf, unsigned value);
void z_elf_append_u16(ZBuf *buf, uint16_t value);
void z_elf_append_u32(ZBuf *buf, uint32_t value);
void z_elf_append_u64(ZBuf *buf, uint64_t value);
void z_elf_append_bytes(ZBuf *buf, const unsigned char *bytes, size_t len);
void z_elf_append_zeros(ZBuf *buf, size_t len);
void z_elf_pad_to(ZBuf *buf, size_t offset);
void z_elf_append_symbol(ZBuf *symtab, uint32_t name, unsigned char info, uint16_t shndx, uint64_t value, uint64_t size);
void z_elf_append_rela(ZBuf *rela, uint64_t offset, uint32_t sym, uint32_t type, int64_t addend);
void z_elf_write_object64(ZBuf *out, const ZElfObjectImage *image);
void z_elf_write_executable64(ZBuf *out, const ZElfExecutableImage *image);

#endif
