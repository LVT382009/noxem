#include "elf_format.h"

size_t z_elf_align(size_t value, size_t alignment) {
  size_t remainder = alignment ? value % alignment : 0;
  return remainder == 0 ? value : value + (alignment - remainder);
}

void z_elf_append_u8(ZBuf *buf, unsigned value) {
  zbuf_append_char(buf, (char)(value & 0xff));
}

void z_elf_append_u16(ZBuf *buf, uint16_t value) {
  z_elf_append_u8(buf, value);
  z_elf_append_u8(buf, value >> 8);
}

void z_elf_append_u32(ZBuf *buf, uint32_t value) {
  z_elf_append_u8(buf, value);
  z_elf_append_u8(buf, value >> 8);
  z_elf_append_u8(buf, value >> 16);
  z_elf_append_u8(buf, value >> 24);
}

void z_elf_append_u64(ZBuf *buf, uint64_t value) {
  z_elf_append_u32(buf, (uint32_t)value);
  z_elf_append_u32(buf, (uint32_t)(value >> 32));
}

void z_elf_append_bytes(ZBuf *buf, const unsigned char *bytes, size_t len) {
  for (size_t i = 0; i < len; i++) z_elf_append_u8(buf, bytes[i]);
}

void z_elf_append_zeros(ZBuf *buf, size_t len) {
  for (size_t i = 0; i < len; i++) z_elf_append_u8(buf, 0);
}

void z_elf_pad_to(ZBuf *buf, size_t offset) {
  while (buf->len < offset) z_elf_append_u8(buf, 0);
}

void z_elf_append_symbol(ZBuf *symtab, uint32_t name, unsigned char info, uint16_t shndx, uint64_t value, uint64_t size) {
  z_elf_append_u32(symtab, name);
  z_elf_append_u8(symtab, info);
  z_elf_append_u8(symtab, 0);
  z_elf_append_u16(symtab, shndx);
  z_elf_append_u64(symtab, value);
  z_elf_append_u64(symtab, size);
}

void z_elf_append_rela(ZBuf *rela, uint64_t offset, uint32_t sym, uint32_t type, int64_t addend) {
  z_elf_append_u64(rela, offset);
  z_elf_append_u64(rela, ((uint64_t)sym << 32) | type);
  z_elf_append_u64(rela, (uint64_t)addend);
}

static void elf_append_section_header(ZBuf *out, uint32_t name, uint32_t type, uint64_t flags, uint64_t offset, uint64_t size, uint32_t link, uint32_t info, uint64_t align, uint64_t entsize) {
  z_elf_append_u32(out, name);
  z_elf_append_u32(out, type);
  z_elf_append_u64(out, flags);
  z_elf_append_u64(out, 0);
  z_elf_append_u64(out, offset);
  z_elf_append_u64(out, size);
  z_elf_append_u32(out, link);
  z_elf_append_u32(out, info);
  z_elf_append_u64(out, align);
  z_elf_append_u64(out, entsize);
}

void z_elf_write_object64(ZBuf *out, const ZElfObjectImage *image) {
  const ZBuf empty = {0};
  const ZBuf *text = image && image->text ? image->text : &empty;
  const ZBuf *rodata = image && image->rodata ? image->rodata : &empty;
  const ZBuf *rela_text = image && image->rela_text ? image->rela_text : &empty;
  const ZBuf *symtab = image && image->symtab ? image->symtab : &empty;
  const ZBuf *strtab = image && image->strtab ? image->strtab : &empty;
  bool has_rodata = rodata->len > 0;
  bool has_rela_text = rela_text->len > 0;
  size_t text_align = image && image->text_align ? image->text_align : 16;
  size_t rodata_align = image && image->rodata_align ? image->rodata_align : 8;

  ZBuf shstrtab;
  zbuf_init(&shstrtab);
  z_elf_append_u8(&shstrtab, 0);
  uint32_t sh_name_text = (uint32_t)shstrtab.len;
  zbuf_append(&shstrtab, ".text");
  z_elf_append_u8(&shstrtab, 0);
  uint32_t sh_name_rodata = 0;
  uint32_t sh_name_rela_text = 0;
  if (has_rodata) {
    sh_name_rodata = (uint32_t)shstrtab.len;
    zbuf_append(&shstrtab, ".rodata");
    z_elf_append_u8(&shstrtab, 0);
  }
  if (has_rela_text) {
    sh_name_rela_text = (uint32_t)shstrtab.len;
    zbuf_append(&shstrtab, ".rela.text");
    z_elf_append_u8(&shstrtab, 0);
  }
  uint32_t sh_name_symtab = (uint32_t)shstrtab.len;
  zbuf_append(&shstrtab, ".symtab");
  z_elf_append_u8(&shstrtab, 0);
  uint32_t sh_name_strtab = (uint32_t)shstrtab.len;
  zbuf_append(&shstrtab, ".strtab");
  z_elf_append_u8(&shstrtab, 0);
  uint32_t sh_name_shstrtab = (uint32_t)shstrtab.len;
  zbuf_append(&shstrtab, ".shstrtab");
  z_elf_append_u8(&shstrtab, 0);

  const size_t ehdr_size = 64;
  const size_t shnum = 5 + (has_rodata ? 1 : 0) + (has_rela_text ? 1 : 0);
  const uint16_t symtab_shndx = (uint16_t)(2 + (has_rodata ? 1 : 0) + (has_rela_text ? 1 : 0));
  const uint16_t strtab_shndx = (uint16_t)(symtab_shndx + 1);
  const uint16_t shstrtab_shndx = (uint16_t)(strtab_shndx + 1);
  size_t text_offset = z_elf_align(ehdr_size, text_align);
  size_t rodata_offset = has_rodata ? z_elf_align(text_offset + text->len, rodata_align) : 0;
  size_t rela_text_offset = has_rela_text ? z_elf_align((has_rodata ? rodata_offset + rodata->len : text_offset + text->len), 8) : 0;
  size_t symtab_offset = z_elf_align((has_rela_text ? rela_text_offset + rela_text->len : (has_rodata ? rodata_offset + rodata->len : text_offset + text->len)), 8);
  size_t strtab_offset = symtab_offset + symtab->len;
  size_t shstrtab_offset = strtab_offset + strtab->len;
  size_t shoff = z_elf_align(shstrtab_offset + shstrtab.len, 8);

  zbuf_init(out);
  const unsigned char ident[] = {0x7f, 'E', 'L', 'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0};
  z_elf_append_bytes(out, ident, sizeof(ident));
  z_elf_append_u16(out, 1);
  z_elf_append_u16(out, image ? (uint16_t)image->machine : 0);
  z_elf_append_u32(out, 1);
  z_elf_append_u64(out, 0);
  z_elf_append_u64(out, 0);
  z_elf_append_u64(out, shoff);
  z_elf_append_u32(out, 0);
  z_elf_append_u16(out, 64);
  z_elf_append_u16(out, 0);
  z_elf_append_u16(out, 0);
  z_elf_append_u16(out, 64);
  z_elf_append_u16(out, (uint16_t)shnum);
  z_elf_append_u16(out, shstrtab_shndx);

  z_elf_pad_to(out, text_offset);
  z_elf_append_bytes(out, (const unsigned char *)text->data, text->len);
  if (has_rodata) {
    z_elf_pad_to(out, rodata_offset);
    z_elf_append_bytes(out, (const unsigned char *)rodata->data, rodata->len);
  }
  if (has_rela_text) {
    z_elf_pad_to(out, rela_text_offset);
    z_elf_append_bytes(out, (const unsigned char *)rela_text->data, rela_text->len);
  }
  z_elf_pad_to(out, symtab_offset);
  z_elf_append_bytes(out, (const unsigned char *)symtab->data, symtab->len);
  z_elf_pad_to(out, strtab_offset);
  z_elf_append_bytes(out, (const unsigned char *)strtab->data, strtab->len);
  z_elf_pad_to(out, shstrtab_offset);
  z_elf_append_bytes(out, (const unsigned char *)shstrtab.data, shstrtab.len);
  z_elf_pad_to(out, shoff);

  elf_append_section_header(out, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  elf_append_section_header(out, sh_name_text, 1, 0x6, text_offset, text->len, 0, 0, text_align, 0);
  if (has_rodata) elf_append_section_header(out, sh_name_rodata, 1, 0x2, rodata_offset, rodata->len, 0, 0, rodata_align, 0);
  if (has_rela_text) elf_append_section_header(out, sh_name_rela_text, 4, 0, rela_text_offset, rela_text->len, symtab_shndx, 1, 8, 24);
  elf_append_section_header(out, sh_name_symtab, 2, 0, symtab_offset, symtab->len, strtab_shndx, image ? image->local_symbol_count : 1, 8, 24);
  elf_append_section_header(out, sh_name_strtab, 3, 0, strtab_offset, strtab->len, 0, 0, 1, 0);
  elf_append_section_header(out, sh_name_shstrtab, 3, 0, shstrtab_offset, shstrtab.len, 0, 0, 1, 0);
  zbuf_free(&shstrtab);
}

void z_elf_write_executable64(ZBuf *out, const ZElfExecutableImage *image) {
  const ZBuf empty = {0};
  const ZBuf *text = image && image->text ? image->text : &empty;
  const ZBuf *rodata = image && image->rodata ? image->rodata : &empty;
  bool has_rodata = image && image->rodata && rodata->len > 0;
  uint64_t file_size = has_rodata ? image->rodata_offset + rodata->len : image->text_offset + text->len;

  zbuf_init(out);
  const unsigned char ident[] = {0x7f, 'E', 'L', 'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0};
  z_elf_append_bytes(out, ident, sizeof(ident));
  z_elf_append_u16(out, 2);
  z_elf_append_u16(out, image ? (uint16_t)image->machine : 0);
  z_elf_append_u32(out, 1);
  z_elf_append_u64(out, image ? image->entry_addr : 0);
  z_elf_append_u64(out, 64);
  z_elf_append_u64(out, 0);
  z_elf_append_u32(out, 0);
  z_elf_append_u16(out, 64);
  z_elf_append_u16(out, 56);
  z_elf_append_u16(out, 1);
  z_elf_append_u16(out, 0);
  z_elf_append_u16(out, 0);
  z_elf_append_u16(out, 0);

  z_elf_append_u32(out, 1);
  z_elf_append_u32(out, 5);
  z_elf_append_u64(out, 0);
  z_elf_append_u64(out, image ? image->base_addr : 0);
  z_elf_append_u64(out, image ? image->base_addr : 0);
  z_elf_append_u64(out, file_size);
  z_elf_append_u64(out, file_size);
  z_elf_append_u64(out, image && image->segment_align ? image->segment_align : 0x1000);

  z_elf_pad_to(out, image ? image->text_offset : 0);
  z_elf_append_bytes(out, (const unsigned char *)text->data, text->len);
  if (has_rodata) {
    z_elf_pad_to(out, image->rodata_offset);
    z_elf_append_bytes(out, (const unsigned char *)rodata->data, rodata->len);
  }
}
