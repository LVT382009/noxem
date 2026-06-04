#include "coff_format.h"

#include <string.h>

typedef struct {
  uint32_t import_directory_rva;
  uint32_t import_directory_size;
  uint32_t iat_rva;
  uint32_t iat_size;
  uint32_t iat_offsets[Z_COFF_IMPORT_COUNT];
} CoffImportLayout;

size_t z_coff_align(size_t value, size_t alignment) {
  size_t remainder = alignment ? value % alignment : 0;
  return remainder == 0 ? value : value + (alignment - remainder);
}

void z_coff_append_u8(ZBuf *buf, unsigned value) {
  zbuf_append_char(buf, (char)(value & 0xffu));
}

void z_coff_append_u16(ZBuf *buf, uint16_t value) {
  z_coff_append_u8(buf, value);
  z_coff_append_u8(buf, value >> 8);
}

void z_coff_append_u32(ZBuf *buf, uint32_t value) {
  z_coff_append_u8(buf, value);
  z_coff_append_u8(buf, value >> 8);
  z_coff_append_u8(buf, value >> 16);
  z_coff_append_u8(buf, value >> 24);
}

void z_coff_append_u64(ZBuf *buf, uint64_t value) {
  z_coff_append_u32(buf, (uint32_t)(value & 0xffffffffu));
  z_coff_append_u32(buf, (uint32_t)(value >> 32));
}

void z_coff_append_bytes(ZBuf *buf, const char *bytes, size_t len) {
  for (size_t i = 0; i < len; i++) z_coff_append_u8(buf, (unsigned char)bytes[i]);
}

void z_coff_append_zeros(ZBuf *buf, size_t len) {
  for (size_t i = 0; i < len; i++) z_coff_append_u8(buf, 0);
}

void z_coff_pad_to(ZBuf *buf, size_t offset) {
  while (buf->len < offset) z_coff_append_u8(buf, 0);
}

void z_coff_patch_u32(ZBuf *buf, size_t offset, uint32_t value) {
  buf->data[offset + 0] = (char)(value & 0xff);
  buf->data[offset + 1] = (char)((value >> 8) & 0xff);
  buf->data[offset + 2] = (char)((value >> 16) & 0xff);
  buf->data[offset + 3] = (char)((value >> 24) & 0xff);
}

void z_coff_patch_u64(ZBuf *buf, size_t offset, uint64_t value) {
  for (unsigned i = 0; i < 8; i++) buf->data[offset + i] = (char)((value >> (i * 8)) & 0xffu);
}

void z_coff_append_reloc(ZBuf *buf, uint32_t offset, uint32_t symbol_index, uint16_t type) {
  z_coff_append_u32(buf, offset);
  z_coff_append_u32(buf, symbol_index);
  z_coff_append_u16(buf, type);
}

void z_coff_append_reloc_amd64(ZBuf *buf, uint32_t offset, uint32_t symbol_index, uint16_t type) {
  z_coff_append_reloc(buf, offset, symbol_index, type);
}

static void coff_append_name(ZBuf *buf, const char *name) {
  size_t len = name ? strlen(name) : 0;
  if (len > 8) len = 8;
  for (size_t i = 0; i < len; i++) z_coff_append_u8(buf, (unsigned char)name[i]);
  for (size_t i = len; i < 8; i++) z_coff_append_u8(buf, 0);
}

static void coff_append_symbol_name(ZBuf *buf, const char *name, ZBuf *strings) {
  size_t len = name ? strlen(name) : 0;
  if (len <= 8) {
    coff_append_name(buf, name);
    return;
  }
  z_coff_append_u32(buf, 0);
  z_coff_append_u32(buf, (uint32_t)strings->len + 4);
  zbuf_append(strings, name);
  z_coff_append_u8(strings, 0);
}

static void coff_append_symbol(ZBuf *out, const ZCoffSymbol *symbol, ZBuf *strings) {
  coff_append_symbol_name(out, symbol && symbol->name ? symbol->name : "zero_fn", strings);
  z_coff_append_u32(out, symbol ? symbol->value : 0);
  z_coff_append_u16(out, symbol ? symbol->section_number : 0);
  z_coff_append_u16(out, symbol ? symbol->type : 0);
  z_coff_append_u8(out, symbol ? symbol->storage_class : Z_COFF_SYMBOL_STATIC);
  z_coff_append_u8(out, 0);
}

void z_coff_write_object(ZBuf *out, const ZCoffObjectImage *image) {
  const ZBuf empty = {0};
  const ZBuf *text = image && image->text ? image->text : &empty;
  const ZBuf *rodata = image && image->rodata ? image->rodata : &empty;
  const ZBuf *relocs = image && image->text_relocs ? image->text_relocs : &empty;
  bool has_rodata = rodata->len > 0;
  uint16_t section_count = has_rodata ? 2 : 1;
  uint32_t section_symbol_count = has_rodata ? 2u : 1u;
  uint32_t header_size = 20 + 40 * section_count;
  uint32_t raw_text_offset = header_size;
  uint32_t raw_rodata_offset = has_rodata ? raw_text_offset + (uint32_t)text->len : 0;
  uint32_t reloc_offset = raw_text_offset + (uint32_t)text->len + (uint32_t)rodata->len;
  uint32_t symbol_offset = reloc_offset + (uint32_t)relocs->len;
  uint32_t symbol_count = section_symbol_count + (uint32_t)(image ? image->symbol_len : 0);

  ZBuf strings;
  zbuf_init(&strings);
  zbuf_init(out);
  z_coff_append_u16(out, image ? (uint16_t)image->machine : 0);
  z_coff_append_u16(out, section_count);
  z_coff_append_u32(out, 0);
  z_coff_append_u32(out, symbol_offset);
  z_coff_append_u32(out, symbol_count);
  z_coff_append_u16(out, 0);
  z_coff_append_u16(out, 0);

  coff_append_name(out, ".text");
  z_coff_append_u32(out, (uint32_t)text->len);
  z_coff_append_u32(out, 0);
  z_coff_append_u32(out, (uint32_t)text->len);
  z_coff_append_u32(out, raw_text_offset);
  z_coff_append_u32(out, relocs->len > 0 ? reloc_offset : 0);
  z_coff_append_u32(out, 0);
  z_coff_append_u16(out, image ? image->text_reloc_count : 0);
  z_coff_append_u16(out, 0);
  z_coff_append_u32(out, 0x60000020u);

  if (has_rodata) {
    coff_append_name(out, ".rdata");
    z_coff_append_u32(out, (uint32_t)rodata->len);
    z_coff_append_u32(out, 0);
    z_coff_append_u32(out, (uint32_t)rodata->len);
    z_coff_append_u32(out, raw_rodata_offset);
    z_coff_append_u32(out, 0);
    z_coff_append_u32(out, 0);
    z_coff_append_u16(out, 0);
    z_coff_append_u16(out, 0);
    z_coff_append_u32(out, 0x40000040u);
  }

  if (text->data) z_coff_append_bytes(out, text->data, text->len);
  if (rodata->data) z_coff_append_bytes(out, rodata->data, rodata->len);
  if (relocs->data) z_coff_append_bytes(out, relocs->data, relocs->len);

  ZCoffSymbol text_symbol = {.name = ".text", .section_number = 1, .storage_class = Z_COFF_SYMBOL_STATIC};
  coff_append_symbol(out, &text_symbol, &strings);
  if (has_rodata) {
    ZCoffSymbol rodata_symbol = {.name = ".rdata", .section_number = 2, .storage_class = Z_COFF_SYMBOL_STATIC};
    coff_append_symbol(out, &rodata_symbol, &strings);
  }
  for (size_t i = 0; image && i < image->symbol_len; i++) coff_append_symbol(out, &image->symbols[i], &strings);

  z_coff_append_u32(out, (uint32_t)strings.len + 4);
  if (strings.data) z_coff_append_bytes(out, strings.data, strings.len);
  zbuf_free(&strings);
}

static void coff_patch_rel32_to_va(ZBuf *text, size_t patch_offset, uint64_t text_base_va, uint64_t target_va) {
  int64_t rel = (int64_t)target_va - (int64_t)(text_base_va + patch_offset + 4);
  z_coff_patch_u32(text, patch_offset, (uint32_t)(int32_t)rel);
}

static void coff_append_import_table(ZBuf *rdata, uint32_t rdata_rva, CoffImportLayout *layout) {
  static const char *names[Z_COFF_IMPORT_COUNT] = {"ExitProcess", "GetStdHandle", "WriteFile"};
  z_coff_pad_to(rdata, z_coff_align(rdata->len, 4));
  uint32_t descriptor_offset = (uint32_t)rdata->len;
  z_coff_append_zeros(rdata, 40);
  z_coff_pad_to(rdata, z_coff_align(rdata->len, 8));
  uint32_t int_offset = (uint32_t)rdata->len;
  z_coff_append_zeros(rdata, (Z_COFF_IMPORT_COUNT + 1) * 8);
  z_coff_pad_to(rdata, z_coff_align(rdata->len, 8));
  uint32_t iat_offset = (uint32_t)rdata->len;
  z_coff_append_zeros(rdata, (Z_COFF_IMPORT_COUNT + 1) * 8);
  uint32_t dll_name_offset = (uint32_t)rdata->len;
  z_coff_append_bytes(rdata, "KERNEL32.dll", strlen("KERNEL32.dll") + 1);

  uint32_t hint_name_offsets[Z_COFF_IMPORT_COUNT];
  for (unsigned i = 0; i < Z_COFF_IMPORT_COUNT; i++) {
    z_coff_pad_to(rdata, z_coff_align(rdata->len, 2));
    hint_name_offsets[i] = (uint32_t)rdata->len;
    z_coff_append_u16(rdata, 0);
    z_coff_append_bytes(rdata, names[i], strlen(names[i]) + 1);
  }

  z_coff_patch_u32(rdata, descriptor_offset + 0, rdata_rva + int_offset);
  z_coff_patch_u32(rdata, descriptor_offset + 12, rdata_rva + dll_name_offset);
  z_coff_patch_u32(rdata, descriptor_offset + 16, rdata_rva + iat_offset);
  for (unsigned i = 0; i < Z_COFF_IMPORT_COUNT; i++) {
    uint64_t thunk = rdata_rva + hint_name_offsets[i];
    z_coff_patch_u64(rdata, int_offset + i * 8, thunk);
    z_coff_patch_u64(rdata, iat_offset + i * 8, thunk);
    if (layout) layout->iat_offsets[i] = iat_offset + i * 8;
  }
  if (layout) {
    layout->import_directory_rva = rdata_rva + descriptor_offset;
    layout->import_directory_size = 40;
    layout->iat_rva = rdata_rva + iat_offset;
    layout->iat_size = (Z_COFF_IMPORT_COUNT + 1) * 8;
  }
}

static void coff_append_pe_data_directory(ZBuf *out, uint32_t rva, uint32_t size) {
  z_coff_append_u32(out, rva);
  z_coff_append_u32(out, size);
}

static void coff_append_pe_data_directories(ZBuf *out, const CoffImportLayout *imports) {
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, imports ? imports->import_directory_rva : 0, imports ? imports->import_directory_size : 0);
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, imports ? imports->iat_rva : 0, imports ? imports->iat_size : 0);
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, 0, 0);
  coff_append_pe_data_directory(out, 0, 0);
}

static void coff_append_pe64_optional_header(ZBuf *out, uint32_t text_raw_size, uint32_t rdata_raw_size, uint32_t text_rva, uint64_t image_base, uint32_t section_alignment, uint32_t file_alignment, uint32_t size_of_image, uint32_t headers_size, const CoffImportLayout *imports) {
  z_coff_append_u16(out, 0x20b);
  z_coff_append_u8(out, 0);
  z_coff_append_u8(out, 1);
  z_coff_append_u32(out, text_raw_size);
  z_coff_append_u32(out, rdata_raw_size);
  z_coff_append_u32(out, 0);
  z_coff_append_u32(out, text_rva);
  z_coff_append_u32(out, text_rva);
  z_coff_append_u64(out, image_base);
  z_coff_append_u32(out, section_alignment);
  z_coff_append_u32(out, file_alignment);
  z_coff_append_u16(out, 6);
  z_coff_append_u16(out, 0);
  z_coff_append_u16(out, 0);
  z_coff_append_u16(out, 0);
  z_coff_append_u16(out, 6);
  z_coff_append_u16(out, 0);
  z_coff_append_u32(out, 0);
  z_coff_append_u32(out, size_of_image);
  z_coff_append_u32(out, headers_size);
  z_coff_append_u32(out, 0);
  z_coff_append_u16(out, 3);
  z_coff_append_u16(out, 0x0100);
  z_coff_append_u64(out, 0x100000);
  z_coff_append_u64(out, 0x1000);
  z_coff_append_u64(out, 0x100000);
  z_coff_append_u64(out, 0x1000);
  z_coff_append_u32(out, 0);
  z_coff_append_u32(out, 16);
  coff_append_pe_data_directories(out, imports);
}

static void coff_append_pe_section_header(ZBuf *out, const char *name, uint32_t virtual_size, uint32_t virtual_address, uint32_t raw_size, uint32_t raw_offset, uint32_t characteristics) {
  coff_append_name(out, name);
  z_coff_append_u32(out, virtual_size);
  z_coff_append_u32(out, virtual_address);
  z_coff_append_u32(out, raw_size);
  z_coff_append_u32(out, raw_offset);
  z_coff_append_u32(out, 0);
  z_coff_append_u32(out, 0);
  z_coff_append_u16(out, 0);
  z_coff_append_u16(out, 0);
  z_coff_append_u32(out, characteristics);
}

void z_coff_write_pe64_executable(ZBuf *out, const ZCoffExecutableImage *image) {
  ZBuf empty_text;
  ZBuf empty_rdata;
  zbuf_init(&empty_text);
  zbuf_init(&empty_rdata);
  ZBuf *text = image && image->text ? image->text : &empty_text;
  ZBuf *rdata = image && image->rdata ? image->rdata : &empty_rdata;
  uint64_t image_base = image && image->image_base ? image->image_base : 0x140000000ull;
  uint32_t section_alignment = image && image->section_alignment ? image->section_alignment : 0x1000;
  uint32_t file_alignment = image && image->file_alignment ? image->file_alignment : 0x200;
  uint32_t dos_header_size = 0x80;
  uint16_t section_count = 2;
  uint32_t optional_header_size = 240;
  uint32_t pe_header_offset = dos_header_size;
  uint32_t headers_unaligned = pe_header_offset + 4 + 20 + optional_header_size + section_count * 40;
  uint32_t headers_size = (uint32_t)z_coff_align(headers_unaligned, file_alignment);
  uint32_t text_rva = section_alignment;
  uint32_t text_raw_offset = headers_size;
  uint32_t text_raw_size = (uint32_t)z_coff_align(text->len, file_alignment);
  uint32_t rdata_rva = (uint32_t)z_coff_align(text_rva + text->len, section_alignment);
  CoffImportLayout imports = {0};
  coff_append_import_table(rdata, rdata_rva, &imports);
  uint32_t rdata_raw_offset = text_raw_offset + text_raw_size;
  uint32_t rdata_raw_size = (uint32_t)z_coff_align(rdata->len, file_alignment);
  uint32_t size_of_image = (uint32_t)z_coff_align(rdata_rva + rdata->len, section_alignment);

  for (size_t i = 0; image && i < image->rodata_patch_len; i++) {
    const ZCoffImageDataPatch *patch = &image->rodata_patches[i];
    uint64_t addr = image_base + rdata_rva + (patch->data_offset - image->rodata_base_offset);
    z_coff_patch_u64(text, patch->patch_offset, addr);
  }
  for (size_t i = 0; image && i < image->import_patch_len; i++) {
    const ZCoffImportPatch *patch = &image->import_patches[i];
    if (patch->import_index >= Z_COFF_IMPORT_COUNT) continue;
    uint64_t target = image_base + rdata_rva + imports.iat_offsets[patch->import_index];
    if (image && image->machine == Z_COFF_MACHINE_ARM64) z_coff_patch_u64(text, patch->patch_offset, target);
    else coff_patch_rel32_to_va(text, patch->patch_offset, image_base + text_rva, target);
  }

  zbuf_init(out);
  z_coff_append_u8(out, 'M');
  z_coff_append_u8(out, 'Z');
  z_coff_append_zeros(out, 0x3a);
  z_coff_append_u32(out, pe_header_offset);
  z_coff_pad_to(out, dos_header_size);

  z_coff_append_u8(out, 'P');
  z_coff_append_u8(out, 'E');
  z_coff_append_u8(out, 0);
  z_coff_append_u8(out, 0);
  z_coff_append_u16(out, image ? (uint16_t)image->machine : 0);
  z_coff_append_u16(out, section_count);
  z_coff_append_u32(out, 0);
  z_coff_append_u32(out, 0);
  z_coff_append_u32(out, 0);
  z_coff_append_u16(out, optional_header_size);
  z_coff_append_u16(out, 0x0022);

  coff_append_pe64_optional_header(out, text_raw_size, rdata_raw_size, text_rva, image_base, section_alignment, file_alignment, size_of_image, headers_size, &imports);
  coff_append_pe_section_header(out, ".text", (uint32_t)text->len, text_rva, text_raw_size, text_raw_offset, 0x60000020u);
  coff_append_pe_section_header(out, ".rdata", (uint32_t)rdata->len, rdata_rva, rdata_raw_size, rdata_raw_offset, 0x40000040u);

  z_coff_pad_to(out, headers_size);
  if (text->data) z_coff_append_bytes(out, text->data, text->len);
  z_coff_pad_to(out, text_raw_offset + text_raw_size);
  if (rdata->data) z_coff_append_bytes(out, rdata->data, rdata->len);
  z_coff_pad_to(out, rdata_raw_offset + rdata_raw_size);
  zbuf_free(&empty_rdata);
  zbuf_free(&empty_text);
}
