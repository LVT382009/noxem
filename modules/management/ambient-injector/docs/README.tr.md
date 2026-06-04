<p align="center">
  <img src="../assets/logo.png" width="200" alt="Lemma Logo">
</p>

# Lemma — LLM'ler için Kalıcı Bellek (MCP)

[English](../README.md) | [Türkçe](README.tr.md)

Lemma, LLM'lere oturumlar arası kalıcı bellek sağlayan bir MCP sunucusudur. Bellekler her oturuma otomatik enjekte edilir — araç çağrısına gerek yoktur. Bilgi kullanım yoluyla evrilir: sık erişilenler güçlenir, kullanılmayanlar solar, örüntüler yeniden kullanılabilir yeteneklere dönüştürülür. Arka planda otonom bir zeka katmanı çalışır — çelişkileri tespit eder, eylem önerileri sunar ve ilgili bilgileri otomatik bağlar.

## Hızlı Başlangıç

Lemma'yı MCP istemci yapılandırmanıza ekleyin:

**Claude Desktop (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`
**Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Claude Code (Linux):** `~/.claude.json` veya `~/.claude/settings.json`
**opencode:** `~/.config/opencode/opencode.json` (Linux/macOS) veya `%APPDATA%\opencode\opencode.json` (Windows)

```json
{
  "mcpServers": {
    "lemma": {
      "command": "npx",
      "args": ["-y", "lemma-mcp@latest"]
    }
  }
}
```

> `@latest` kullanmak npx'in her zaman en yeni sürümü çekmesini sağlar.

**Gereksinimler:** Node.js 20.0.0 veya üzeri

### CLI Kullanımı

```bash
lemma -lib    # Library Mode: bilgi tabanınızın tam anlık görüntüsü
```

Tüm bellekler, rehberler, ilişkiler, eski fragmanlar, damıtma adayları ve önerilen eylemlerin tam analizini çıkarır. Periyodik bakım ve inceleme için kullanışlıdır.

## Nasıl Çalışır?

Bellekler `tools/list` üzerinden araç açıklamalarına enjekte edilir. LLM her oturuma en önemli belleklerini zaten bilerek başlar.

**3 katmanlı enjeksiyon:**
- En önemli bellekler için tam içerik (token bütçeli)
- Kalan bellekler için özet indeksi
- Öğrenimleriyle aktif rehberler

**Bellek türleri:** `fact`, `pattern`, `lesson`, `warning`, `context`

**Bilgi hattı:** Memory (ne biliyorsun, `memory_add`) → Pattern (`type: "pattern"`) → Guide (nasıl çalışıyorsun, `guide_distill` → `guide_practice`)

**AGENTS.md enjeksiyonu:** Lemma projenizin `AGENTS.md` dosyasına otomatik olarak bir sistem prompt'u enjekte eder ve LLM'e bellek sistemini nasıl etkili kullanacağını öğretir. Tüm MCP istemcilerinde tutarlı davranış sağlar.

## Otonom Zeka

Lemma arka planda zeka çalıştırır — manuel tetiklemeye gerek yoktur:

- **Çelişki Tespiti:** Yeni bellekleri mevcut bilgiyle otomatik karşılaştırır. Çelişkileri çözüm önerileriyle raporlar.
- **Proaktif Öneriler:** Bellek ekledikten veya rehber pratiği yaptıktan sonra örüntüleri damıtma, yinelenenleri birleştirme veya düşük performanslı rehberleri iyileştirme gibi eylemler önerir.
- **Otomatik Bağlama:** Sık birlikte okunan bellekler ve konu örtüşen fragmanlar otomatik olarak ilişkilendirilir.

Manuel derin analiz de özel araçlarla kullanılabilir.

## Araçlar (24)

### Bellek (11)

| Araç | Açıklama |
|------|----------|
| `memory_read` | Fragmanları oku/ara. Özet modu veya ID ile tam detay |
| `memory_add` | Bulguları kaydet. Gizli bilgileri otomatik sansürler, tekrarları ve çelişkileri algılar |
| `memory_update` | ID ile fragman güncelle |
| `memory_feedback` | Pozitif/negatif geri bildirim, güveni ayarlar |
| `memory_forget` | Fragman sil |
| `memory_merge` | Fragmanları birleştir, ilişkiler ve rehber bağlantıları aktarılır |
| `memory_relate` | Tipli bağlantılar oluştur (`contradicts`, `supersedes`, `supports`, `related_to`) |
| `memory_stats` | Fragman sayıları, güven, proje dağılımı |
| `memory_audit` | Bütünlük kontrolü (yetim, tekrar, anomali) |
| `memory_library` | Tüm bilgi tabanının analiz sinyalleri ve önerilerle tam anlık görüntüsü |

### Rehberler (8)

| Araç | Açıklama |
|------|----------|
| `guide_get` | Kullanıma göre sıralı rehberler, kategori veya görev filtresi |
| `guide_practice` | Rehber kullanımını kaydet. Rehber yoksa otomatik oluşturur |
| `guide_create` | Detaylı kılavuzla rehber oluştur |
| `guide_distill` | Belleği rehber öğrenimine dönüştür (çift yönlü bağlantı) |
| `guide_update` | Rehber özelliklerini, anti-örüntüleri, tuzakları güncelle |
| `guide_forget` | Rehber sil |
| `guide_merge` | Rehberleri birleştir, kaynak bellekleri aktar |

### Oturumlar (3)

| Araç | Açıklama |
|------|----------|
| `session_start` | İzlenen oturum başlat, ilgili bağlamı önceden yükle |
| `session_end` | İnceleme, otomatik bağlama ve önerilerle oturumu sonlandır |
| `session_stats` | Sanal oturum istatistikleri |

### Zeka (4)

| Araç | Açıklama |
|------|----------|
| `conflict_scan` | Tüm bellekleri çelişkiler için tara |
| `proactive_analysis` | Tam bilgi tabanı analizi: eski, yetim, damıtma adayları, kullanım dışı |
| `project_analytics` | Oturumlar arası proje sağlığı, büyüme oranı, beceri kapsama |
| `semantic_search` | TF-IDF benzerlik araması |

## Yapılandırma

`~/.lemma/config.json` konumunda isteğe bağlı:

```json
{
  "token_budget": {
    "full_content": 5000,
    "summary_index": 1000,
    "guides_detail": 1000
  },
  "injection": {
    "max_full_content_fragments": 15,
    "max_summary_fragments": 30,
    "max_guides": 20
  },
  "virtual_session": {
    "timeout_minutes": 30
  }
}
```

## Dosya Konumları

| İşletim Sistemi | Yol |
|---|---|
| **Windows** | `C:\Users\{username}\.lemma\` |
| **macOS/Linux** | `~/.lemma/` |

Dosyalar: `lemma.db` (SQLite), `config.json`, `sessions/`, `logs/`

## Arama

Lemma bellek arama, tekrar algılama ve konu örtüşme tespiti için **SQLite FTS5** tam metin arama kullanır.

## Veri Depolama

Tüm veriler tek bir SQLite veritabanında (`~/.lemma/lemma.db`) saklanır:

| Tablo | Amaç |
|-------|------|
| `memories` | Bellek fragmanları (FTS5 + metadata) |
| `guides` | Prosedürel bilgi ve öğrenimler |
| `sessions` | Oturum takibi ve sonuçlar |
| `relations` | Bellekler arası tipli bağlantılar |
| `guide_learnings` | Rehber bazlı biriken öğrenimler |
| `guide_memory_links` | Çift yönlü rehber ↔ bellek bağlantıları |

Eski JSONL dosyaları ilk çalıştırmada otomatik olarak taşınır.

## Güvenlik

Tüm veriler yerel olarak `~/.lemma/` dizininde saklanır. Hiçbir şey harici sunuculara gönderilmez. Gizli bilgiler bellek fragmanlarından otomatik olarak sansürlenir (API anahtarları, tokenlar, bağlantı dizgileri için 17 regex deseni).

## Dokümantasyon

- [Geliştirme Rehberi](development/DEVELOPMENT.md) — Mimari, proje yapısı, test
- [Handler Refaktörü](development/HANDLERS-REFACTOR.md) — Hedeflenen SQL geçiş planı
- [Yol Haritası](development/ROADMAP.md) — v0.9, v0.10, v1.0 planları
- [Araştırmalar](research/README.md) — Lemma'nın tasarımını etkileyen akademik makaleler
- [Değişiklik Günlüğü](../CHANGELOG.md) — Sürüm geçmişi

## Lisans

MIT
