#include "macho_format.h"

#include <string.h>

static const uint32_t MACHO_CPU_TYPE_ARM64 = 0x0100000c;
static const uint32_t MACHO_CPU_SUBTYPE_ARM64_ALL = 0;
static const uint32_t MACHO_CPU_TYPE_X86_64 = 0x01000007;
static const uint32_t MACHO_CPU_SUBTYPE_X86_64_ALL = 3;
static const uint32_t MACHO_MAGIC_64 = 0xfeedfacf;
static const uint32_t MACHO_LC_SEGMENT_64 = 0x19;
static const uint32_t MACHO_LC_SYMTAB = 0x2;
static const uint32_t MACHO_LC_DYLD_INFO_ONLY = 0x80000022;
static const uint32_t MACHO_LC_UUID = 0x1b;
static const uint32_t MACHO_LC_LOAD_DYLINKER = 0xe;
static const uint32_t MACHO_LC_LOAD_DYLIB = 0xc;
static const uint32_t MACHO_LC_MAIN = 0x80000028;
static const uint32_t MACHO_LC_BUILD_VERSION = 0x32;
static const uint32_t MACHO_LC_CODE_SIGNATURE = 0x1d;

typedef struct {
  uint32_t state[8];
  uint64_t bitlen;
  unsigned char data[64];
  size_t datalen;
} MachOSha256;

size_t z_macho_align(size_t value, size_t alignment) {
  size_t remainder = alignment ? value % alignment : 0;
  return remainder == 0 ? value : value + (alignment - remainder);
}

void z_macho_append_u8(ZBuf *buf, unsigned value) {
  zbuf_append_char(buf, (char)(value & 0xffu));
}

void z_macho_append_u16(ZBuf *buf, uint16_t value) {
  z_macho_append_u8(buf, value);
  z_macho_append_u8(buf, value >> 8);
}

void z_macho_append_u32(ZBuf *buf, uint32_t value) {
  z_macho_append_u8(buf, value);
  z_macho_append_u8(buf, value >> 8);
  z_macho_append_u8(buf, value >> 16);
  z_macho_append_u8(buf, value >> 24);
}

void z_macho_append_u64(ZBuf *buf, uint64_t value) {
  z_macho_append_u32(buf, (uint32_t)(value & 0xffffffffu));
  z_macho_append_u32(buf, (uint32_t)(value >> 32));
}

void z_macho_patch_u64(ZBuf *buf, size_t offset, uint64_t value) {
  for (unsigned i = 0; i < 8; i++) buf->data[offset + i] = (char)((value >> (i * 8)) & 0xffu);
}

void z_macho_append_bytes(ZBuf *buf, const char *bytes, size_t len) {
  for (size_t i = 0; i < len; i++) z_macho_append_u8(buf, (unsigned char)bytes[i]);
}

void z_macho_pad_to(ZBuf *buf, size_t offset) {
  while (buf->len < offset) z_macho_append_u8(buf, 0);
}

void z_macho_append_uleb128(ZBuf *buf, uint64_t value) {
  do {
    unsigned byte = (unsigned)(value & 0x7fu);
    value >>= 7;
    if (value) byte |= 0x80u;
    z_macho_append_u8(buf, byte);
  } while (value);
}

static void macho_append_fixed(ZBuf *buf, const char *text, size_t width) {
  size_t len = text ? strlen(text) : 0;
  if (len > width) len = width;
  for (size_t i = 0; i < len; i++) z_macho_append_u8(buf, (unsigned char)text[i]);
  for (size_t i = len; i < width; i++) z_macho_append_u8(buf, 0);
}

static void macho_append_section64(ZBuf *out, const char *sectname, const char *segname, uint64_t addr, uint64_t size, uint32_t offset, uint32_t align, uint32_t reloff, uint32_t nreloc, uint32_t flags) {
  macho_append_fixed(out, sectname, 16);
  macho_append_fixed(out, segname, 16);
  z_macho_append_u64(out, addr);
  z_macho_append_u64(out, size);
  z_macho_append_u32(out, offset);
  z_macho_append_u32(out, align);
  z_macho_append_u32(out, reloff);
  z_macho_append_u32(out, nreloc);
  z_macho_append_u32(out, flags);
  z_macho_append_u32(out, 0);
  z_macho_append_u32(out, 0);
  z_macho_append_u32(out, 0);
}

static void macho_append_segment64(ZBuf *out, const char *segname, uint64_t vmaddr, uint64_t vmsize, uint64_t fileoff, uint64_t filesize, uint32_t maxprot, uint32_t initprot, uint32_t nsects, uint32_t flags) {
  z_macho_append_u32(out, MACHO_LC_SEGMENT_64);
  z_macho_append_u32(out, 72 + nsects * 80);
  macho_append_fixed(out, segname, 16);
  z_macho_append_u64(out, vmaddr);
  z_macho_append_u64(out, vmsize);
  z_macho_append_u64(out, fileoff);
  z_macho_append_u64(out, filesize);
  z_macho_append_u32(out, maxprot);
  z_macho_append_u32(out, initprot);
  z_macho_append_u32(out, nsects);
  z_macho_append_u32(out, flags);
}

static uint32_t macho_cpu_type(ZMachOCpu cpu) {
  return cpu == Z_MACHO_CPU_X86_64 ? MACHO_CPU_TYPE_X86_64 : MACHO_CPU_TYPE_ARM64;
}

static uint32_t macho_cpu_subtype(ZMachOCpu cpu) {
  return cpu == Z_MACHO_CPU_X86_64 ? MACHO_CPU_SUBTYPE_X86_64_ALL : MACHO_CPU_SUBTYPE_ARM64_ALL;
}

static void macho_append_header64(ZBuf *out, ZMachOCpu cpu, uint32_t filetype, uint32_t ncmds, uint32_t sizeofcmds, uint32_t flags) {
  z_macho_append_u32(out, MACHO_MAGIC_64);
  z_macho_append_u32(out, macho_cpu_type(cpu));
  z_macho_append_u32(out, macho_cpu_subtype(cpu));
  z_macho_append_u32(out, filetype);
  z_macho_append_u32(out, ncmds);
  z_macho_append_u32(out, sizeofcmds);
  z_macho_append_u32(out, flags);
  z_macho_append_u32(out, 0);
}

static void macho_append_nlist64(ZBuf *out, const ZMachOSymbol *symbol) {
  z_macho_append_u32(out, symbol ? symbol->string_offset : 0);
  z_macho_append_u8(out, symbol ? symbol->type : 0);
  z_macho_append_u8(out, symbol ? symbol->section : 0);
  z_macho_append_u16(out, symbol ? symbol->desc : 0);
  z_macho_append_u64(out, symbol ? symbol->value : 0);
}

void z_macho_write_object64(ZBuf *out, const ZMachOObjectImage *image) {
  const ZBuf empty = {0};
  const ZBuf *text = image && image->text ? image->text : &empty;
  const ZBuf *rodata = image && image->rodata ? image->rodata : &empty;
  const ZBuf *relocs = image && image->relocs ? image->relocs : &empty;
  const ZBuf *strings = image && image->strings ? image->strings : &empty;
  bool has_rodata = rodata->len > 0;
  uint32_t header_size = 32;
  uint32_t section_count = has_rodata ? 2u : 1u;
  uint32_t segment_cmd_size = 72 + section_count * 80;
  uint32_t symtab_cmd_size = 24;
  uint32_t sizeofcmds = segment_cmd_size + symtab_cmd_size;
  uint32_t text_offset = header_size + sizeofcmds;
  uint32_t const_addr = has_rodata ? (uint32_t)z_macho_align(text->len, 8) : 0;
  uint32_t segment_file_size = has_rodata ? const_addr + (uint32_t)rodata->len : (uint32_t)text->len;
  uint32_t reloff = relocs->len > 0 ? text_offset + segment_file_size : 0;
  uint32_t symoff = text_offset + segment_file_size + (uint32_t)relocs->len;
  uint32_t nsyms = image ? (uint32_t)image->symbol_len : 0;
  uint32_t stroff = symoff + nsyms * 16;

  zbuf_init(out);
  ZMachOCpu cpu = image ? image->cpu : Z_MACHO_CPU_ARM64;
  macho_append_header64(out, cpu, 1, 2, sizeofcmds, 0);
  macho_append_segment64(out, "", 0, segment_file_size, text_offset, segment_file_size, 7, 5, section_count, 0);
  macho_append_section64(out, "__text", "__TEXT", 0, text->len, text_offset, 2, reloff, image ? image->text_reloc_count : 0, 0x80000400u);
  if (has_rodata) macho_append_section64(out, "__const", "__DATA", const_addr, rodata->len, text_offset + const_addr, 3, 0, 0, 0);
  z_macho_append_u32(out, MACHO_LC_SYMTAB);
  z_macho_append_u32(out, symtab_cmd_size);
  z_macho_append_u32(out, symoff);
  z_macho_append_u32(out, nsyms);
  z_macho_append_u32(out, stroff);
  z_macho_append_u32(out, (uint32_t)strings->len);
  if (text->data) z_macho_append_bytes(out, text->data, text->len);
  if (has_rodata) {
    z_macho_pad_to(out, text_offset + const_addr);
    if (rodata->data) z_macho_append_bytes(out, rodata->data, rodata->len);
  }
  if (relocs->data) z_macho_append_bytes(out, relocs->data, relocs->len);
  for (size_t i = 0; image && i < image->symbol_len; i++) macho_append_nlist64(out, &image->symbols[i]);
  if (strings->data) z_macho_append_bytes(out, strings->data, strings->len);
}

static uint32_t macho_sha_rotr(uint32_t value, unsigned bits) {
  return (value >> bits) | (value << (32 - bits));
}

static void macho_sha256_transform(MachOSha256 *ctx, const unsigned char data[64]) {
  static const uint32_t k[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
  };
  uint32_t m[64];
  for (unsigned i = 0; i < 16; i++) {
    m[i] = ((uint32_t)data[i * 4] << 24) | ((uint32_t)data[i * 4 + 1] << 16) | ((uint32_t)data[i * 4 + 2] << 8) | ((uint32_t)data[i * 4 + 3]);
  }
  for (unsigned i = 16; i < 64; i++) {
    uint32_t s0 = macho_sha_rotr(m[i - 15], 7) ^ macho_sha_rotr(m[i - 15], 18) ^ (m[i - 15] >> 3);
    uint32_t s1 = macho_sha_rotr(m[i - 2], 17) ^ macho_sha_rotr(m[i - 2], 19) ^ (m[i - 2] >> 10);
    m[i] = m[i - 16] + s0 + m[i - 7] + s1;
  }
  uint32_t a = ctx->state[0], b = ctx->state[1], c = ctx->state[2], d = ctx->state[3];
  uint32_t e = ctx->state[4], f = ctx->state[5], g = ctx->state[6], h = ctx->state[7];
  for (unsigned i = 0; i < 64; i++) {
    uint32_t s1 = macho_sha_rotr(e, 6) ^ macho_sha_rotr(e, 11) ^ macho_sha_rotr(e, 25);
    uint32_t ch = (e & f) ^ ((~e) & g);
    uint32_t temp1 = h + s1 + ch + k[i] + m[i];
    uint32_t s0 = macho_sha_rotr(a, 2) ^ macho_sha_rotr(a, 13) ^ macho_sha_rotr(a, 22);
    uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t temp2 = s0 + maj;
    h = g; g = f; f = e; e = d + temp1; d = c; c = b; b = a; a = temp1 + temp2;
  }
  ctx->state[0] += a; ctx->state[1] += b; ctx->state[2] += c; ctx->state[3] += d;
  ctx->state[4] += e; ctx->state[5] += f; ctx->state[6] += g; ctx->state[7] += h;
}

static void macho_sha256_init(MachOSha256 *ctx) {
  ctx->datalen = 0;
  ctx->bitlen = 0;
  ctx->state[0] = 0x6a09e667u; ctx->state[1] = 0xbb67ae85u; ctx->state[2] = 0x3c6ef372u; ctx->state[3] = 0xa54ff53au;
  ctx->state[4] = 0x510e527fu; ctx->state[5] = 0x9b05688cu; ctx->state[6] = 0x1f83d9abu; ctx->state[7] = 0x5be0cd19u;
}

static void macho_sha256_update(MachOSha256 *ctx, const unsigned char *data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    ctx->data[ctx->datalen++] = data[i];
    if (ctx->datalen == 64) {
      macho_sha256_transform(ctx, ctx->data);
      ctx->bitlen += 512;
      ctx->datalen = 0;
    }
  }
}

static void macho_sha256_final(MachOSha256 *ctx, unsigned char hash[32]) {
  size_t i = ctx->datalen;
  ctx->data[i++] = 0x80;
  if (i > 56) {
    while (i < 64) ctx->data[i++] = 0;
    macho_sha256_transform(ctx, ctx->data);
    i = 0;
  }
  while (i < 56) ctx->data[i++] = 0;
  ctx->bitlen += ctx->datalen * 8;
  for (unsigned j = 0; j < 8; j++) ctx->data[63 - j] = (unsigned char)(ctx->bitlen >> (j * 8));
  macho_sha256_transform(ctx, ctx->data);
  for (unsigned j = 0; j < 8; j++) {
    hash[j * 4] = (unsigned char)(ctx->state[j] >> 24);
    hash[j * 4 + 1] = (unsigned char)(ctx->state[j] >> 16);
    hash[j * 4 + 2] = (unsigned char)(ctx->state[j] >> 8);
    hash[j * 4 + 3] = (unsigned char)ctx->state[j];
  }
}

static void macho_sha256_hash(const unsigned char *data, size_t len, unsigned char hash[32]) {
  MachOSha256 ctx;
  macho_sha256_init(&ctx);
  macho_sha256_update(&ctx, data, len);
  macho_sha256_final(&ctx, hash);
}

static void macho_append_u32be(ZBuf *buf, uint32_t value) {
  z_macho_append_u8(buf, value >> 24);
  z_macho_append_u8(buf, value >> 16);
  z_macho_append_u8(buf, value >> 8);
  z_macho_append_u8(buf, value);
}

static void macho_append_u64be(ZBuf *buf, uint64_t value) {
  macho_append_u32be(buf, (uint32_t)(value >> 32));
  macho_append_u32be(buf, (uint32_t)(value & 0xffffffffu));
}

static void macho_append_code_signature(ZBuf *sig, const unsigned char *code, size_t code_len, const char *identifier) {
  const uint32_t page_log = 12;
  const size_t page_size = 1u << page_log;
  const uint32_t hash_size = 32;
  const uint32_t nslots = (uint32_t)((code_len + page_size - 1) / page_size);
  const uint32_t cd_header_size = 88;
  const uint32_t ident_offset = cd_header_size;
  const uint32_t ident_len = (uint32_t)strlen(identifier) + 1;
  const uint32_t hash_offset = (uint32_t)z_macho_align(ident_offset + ident_len, 4);
  const uint32_t cd_length = hash_offset + nslots * hash_size;
  const uint32_t cd_offset = 20;
  const uint32_t super_length = cd_offset + cd_length;

  zbuf_init(sig);
  macho_append_u32be(sig, 0xfade0cc0u);
  macho_append_u32be(sig, super_length);
  macho_append_u32be(sig, 1);
  macho_append_u32be(sig, 0);
  macho_append_u32be(sig, cd_offset);
  macho_append_u32be(sig, 0xfade0c02u);
  macho_append_u32be(sig, cd_length);
  macho_append_u32be(sig, 0x00020400u);
  macho_append_u32be(sig, 0x00000002u);
  macho_append_u32be(sig, hash_offset);
  macho_append_u32be(sig, ident_offset);
  macho_append_u32be(sig, 0);
  macho_append_u32be(sig, nslots);
  macho_append_u32be(sig, (uint32_t)code_len);
  z_macho_append_u8(sig, hash_size);
  z_macho_append_u8(sig, 2);
  z_macho_append_u8(sig, 0);
  z_macho_append_u8(sig, page_log);
  macho_append_u32be(sig, 0);
  macho_append_u32be(sig, 0);
  macho_append_u32be(sig, 0);
  macho_append_u32be(sig, 0);
  macho_append_u64be(sig, code_len);
  macho_append_u64be(sig, 0);
  macho_append_u64be(sig, code_len);
  macho_append_u64be(sig, 0);
  z_macho_append_bytes(sig, identifier, ident_len);
  z_macho_pad_to(sig, cd_offset + hash_offset);
  for (uint32_t slot = 0; slot < nslots; slot++) {
    size_t offset = slot * page_size;
    size_t len = code_len - offset;
    if (len > page_size) len = page_size;
    unsigned char hash[32];
    macho_sha256_hash(code + offset, len, hash);
    z_macho_append_bytes(sig, (const char *)hash, sizeof(hash));
  }
}

void z_macho_compute_executable64_layout(ZMachOExecutableLayout *layout, const ZBuf *text, const ZBuf *rodata, const ZBuf *rebase, const char *code_signature_id) {
  if (!layout) return;
  const ZBuf empty = {0};
  text = text ? text : &empty;
  rodata = rodata ? rodata : &empty;
  rebase = rebase ? rebase : &empty;
  const char *identifier = code_signature_id ? code_signature_id : "zero-direct";
  bool has_rodata = rodata->len > 0;
  layout->base_addr = 0x100000000ull;
  layout->page_size = 0x4000;
  layout->header_size = 32;
  layout->pagezero_cmd_size = 72;
  layout->text_segment_cmd_size = 72 + (has_rodata ? 2u : 1u) * 80;
  layout->linkedit_cmd_size = 72;
  layout->dyld_info_cmd_size = 48;
  layout->uuid_cmd_size = 24;
  layout->dylinker_cmd_size = 32;
  layout->libsystem_cmd_size = 56;
  layout->main_cmd_size = 24;
  layout->build_version_cmd_size = 24;
  layout->code_signature_cmd_size = 16;
  layout->sizeofcmds = layout->pagezero_cmd_size + layout->text_segment_cmd_size + layout->linkedit_cmd_size + layout->dyld_info_cmd_size + layout->uuid_cmd_size + layout->dylinker_cmd_size + layout->libsystem_cmd_size + layout->main_cmd_size + layout->build_version_cmd_size + layout->code_signature_cmd_size;
  layout->text_offset = (uint32_t)z_macho_align(layout->header_size + layout->sizeofcmds, 16);
  layout->rodata_offset = has_rodata ? (uint32_t)z_macho_align(layout->text_offset + text->len, 8) : 0;
  uint64_t segment_content_size = has_rodata ? layout->rodata_offset + rodata->len : layout->text_offset + text->len;
  layout->segment_file_size = z_macho_align((size_t)segment_content_size, layout->page_size);
  layout->segment_vm_size = layout->segment_file_size;
  layout->rebase_offset = rebase->len > 0 ? (uint32_t)layout->segment_file_size : 0;
  layout->rebase_size = (uint32_t)rebase->len;
  layout->code_signature_offset = (uint32_t)z_macho_align((size_t)layout->segment_file_size + rebase->len, 16);
  uint32_t hash_offset = (uint32_t)z_macho_align(88 + strlen(identifier) + 1, 4);
  uint32_t slots = (layout->code_signature_offset + 4095u) / 4096u;
  layout->code_signature_size = 20 + hash_offset + slots * 32;
  layout->linkedit_vmaddr = layout->base_addr + layout->segment_file_size;
  layout->linkedit_vmsize = z_macho_align(layout->code_signature_size, layout->page_size);
}

static void macho_patch_bytes(ZBuf *buf, size_t offset, const unsigned char *bytes, size_t len) {
  if (!buf || !bytes || offset + len > buf->len) return;
  for (size_t i = 0; i < len; i++) buf->data[offset + i] = (char)bytes[i];
}

static void macho_append_dylinker_command(ZBuf *out, const ZMachOExecutableLayout *layout) {
  z_macho_append_u32(out, MACHO_LC_LOAD_DYLINKER);
  z_macho_append_u32(out, layout->dylinker_cmd_size);
  z_macho_append_u32(out, 12);
  z_macho_append_bytes(out, "/usr/lib/dyld", strlen("/usr/lib/dyld") + 1);
  z_macho_pad_to(out, layout->header_size + layout->pagezero_cmd_size + layout->text_segment_cmd_size + layout->linkedit_cmd_size + layout->dyld_info_cmd_size + layout->uuid_cmd_size + layout->dylinker_cmd_size);
}

static void macho_append_libsystem_command(ZBuf *out, const ZMachOExecutableLayout *layout) {
  z_macho_append_u32(out, MACHO_LC_LOAD_DYLIB);
  z_macho_append_u32(out, layout->libsystem_cmd_size);
  z_macho_append_u32(out, 24);
  z_macho_append_u32(out, 2);
  z_macho_append_u32(out, 0x054c0000);
  z_macho_append_u32(out, 0x00010000);
  z_macho_append_bytes(out, "/usr/lib/libSystem.B.dylib", strlen("/usr/lib/libSystem.B.dylib") + 1);
  z_macho_pad_to(out, layout->header_size + layout->pagezero_cmd_size + layout->text_segment_cmd_size + layout->linkedit_cmd_size + layout->dyld_info_cmd_size + layout->uuid_cmd_size + layout->dylinker_cmd_size + layout->libsystem_cmd_size);
}

static void macho_append_executable_load_commands(ZBuf *out, const ZMachOExecutableImage *image, size_t *uuid_offset) {
  const ZMachOExecutableLayout *layout = &image->layout;
  const ZBuf empty = {0};
  const ZBuf *text = image->text ? image->text : &empty;
  const ZBuf *rodata = image->rodata ? image->rodata : &empty;
  uint32_t section_count = rodata->len > 0 ? 2u : 1u;

  macho_append_segment64(out, "__PAGEZERO", 0, layout->base_addr, 0, 0, 0, 0, 0, 0);
  macho_append_segment64(out, "__TEXT", layout->base_addr, layout->segment_vm_size, 0, layout->segment_file_size, 5, 5, section_count, 0);
  macho_append_section64(out, "__text", "__TEXT", layout->base_addr + layout->text_offset, text->len, layout->text_offset, 2, 0, 0, 0x80000400u);
  if (rodata->len > 0) macho_append_section64(out, "__const", "__TEXT", layout->base_addr + layout->rodata_offset, rodata->len, layout->rodata_offset, 3, 0, 0, 0);
  macho_append_segment64(out, "__LINKEDIT", layout->linkedit_vmaddr, layout->linkedit_vmsize, layout->code_signature_offset, layout->code_signature_size, 1, 1, 0, 0);
  z_macho_append_u32(out, MACHO_LC_DYLD_INFO_ONLY);
  z_macho_append_u32(out, layout->dyld_info_cmd_size);
  z_macho_append_u32(out, layout->rebase_offset);
  z_macho_append_u32(out, layout->rebase_size);
  for (unsigned i = 0; i < 8; i++) z_macho_append_u32(out, 0);
  z_macho_append_u32(out, MACHO_LC_UUID);
  z_macho_append_u32(out, layout->uuid_cmd_size);
  if (uuid_offset) *uuid_offset = out->len;
  for (unsigned i = 0; i < 16; i++) z_macho_append_u8(out, 0);
  macho_append_dylinker_command(out, layout);
  macho_append_libsystem_command(out, layout);
  z_macho_append_u32(out, MACHO_LC_MAIN);
  z_macho_append_u32(out, layout->main_cmd_size);
  z_macho_append_u64(out, layout->text_offset);
  z_macho_append_u64(out, 0);
  z_macho_append_u32(out, MACHO_LC_BUILD_VERSION);
  z_macho_append_u32(out, layout->build_version_cmd_size);
  z_macho_append_u32(out, 1);
  z_macho_append_u32(out, 0x000b0000);
  z_macho_append_u32(out, 0);
  z_macho_append_u32(out, 0);
  z_macho_append_u32(out, MACHO_LC_CODE_SIGNATURE);
  z_macho_append_u32(out, layout->code_signature_cmd_size);
  z_macho_append_u32(out, layout->code_signature_offset);
  z_macho_append_u32(out, layout->code_signature_size);
}

void z_macho_write_executable64(ZBuf *out, const ZMachOExecutableImage *image) {
  const ZBuf empty = {0};
  const char *identifier = image && image->code_signature_id ? image->code_signature_id : "zero-direct";
  const ZBuf *text = image && image->text ? image->text : &empty;
  const ZBuf *rodata = image && image->rodata ? image->rodata : &empty;
  const ZBuf *rebase = image && image->rebase ? image->rebase : &empty;
  ZMachOExecutableImage local = image ? *image : (ZMachOExecutableImage){0};
  if (local.layout.text_offset == 0) z_macho_compute_executable64_layout(&local.layout, text, rodata, rebase, identifier);
  local.text = text;
  local.rodata = rodata;
  local.rebase = rebase;
  local.code_signature_id = identifier;

  zbuf_init(out);
  macho_append_header64(out, local.cpu, 2, 10, local.layout.sizeofcmds, 0x200085);
  size_t uuid_offset = 0;
  macho_append_executable_load_commands(out, &local, &uuid_offset);
  z_macho_pad_to(out, local.layout.text_offset);
  if (text->data) z_macho_append_bytes(out, text->data, text->len);
  if (rodata->len > 0) {
    z_macho_pad_to(out, local.layout.rodata_offset);
    if (rodata->data) z_macho_append_bytes(out, rodata->data, rodata->len);
  }
  z_macho_pad_to(out, (size_t)local.layout.segment_file_size);
  if (rebase->data) z_macho_append_bytes(out, rebase->data, rebase->len);
  z_macho_pad_to(out, local.layout.code_signature_offset);
  unsigned char uuid_hash[32];
  macho_sha256_hash((const unsigned char *)out->data, out->len, uuid_hash);
  uuid_hash[6] = (unsigned char)((uuid_hash[6] & 0x0fu) | 0x50u);
  uuid_hash[8] = (unsigned char)((uuid_hash[8] & 0x3fu) | 0x80u);
  macho_patch_bytes(out, uuid_offset, uuid_hash, 16);
  ZBuf signature;
  macho_append_code_signature(&signature, (const unsigned char *)out->data, out->len, identifier);
  if (signature.data) z_macho_append_bytes(out, signature.data, signature.len);
  zbuf_free(&signature);
}
