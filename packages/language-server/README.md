# `@skript-ide/language-server`

Minecraft Skript betikleri için, LSP taşımasından bağımsız dil sunucusu. Parser ve pattern matcher
`@skript-ide/parser` ile `@skript-ide/pattern-compiler` paketlerinden gelir; ikisi de
`LanguageServiceOptions` üzerinden değiştirilebilir (testler sahte uygulamalar enjekte eder).

## Girişler

| Giriş | Ne yapar |
|---|---|
| `@skript-ide/language-server` | `SkriptLanguageService` (çekirdek) ve tipler |
| `@skript-ide/language-server/browser` | `startBrowserServer()`: module Web Worker içinde `self` ile çalışır, syntax DB'yi `loadSyntaxDatabase` ile yükler |
| `@skript-ide/language-server/node` | `startNodeServer()`: stdio taşıması, syntax DB'yi `readSyntaxDatabase` ile dosyadan okur |
| `src/bin.ts` | `node --import tsx src/bin.ts --stdio` |

```ts
const service = new SkriptLanguageService({
  loadDatabase: (version) => readSyntaxDatabase(version),
  skriptVersion: '2.17.1' // isteğe bağlı
})
service.openDocument(uri, text, 1)
const diagnostics = await service.getDiagnostics(uri)
```

Sunucu tarafında `startServer(connection, options)` tüm LSP handler'larını bağlar; `connection.listen()`
çağrısı giriş noktasına aittir.

## Protokol uzantıları

- **Sürüm:** `initialize` → `initializationOptions.skriptVersion` ve
  `workspace/didChangeConfiguration` → `{ settings: { skript: { version: "2.14.3" } } }`.
  Bilinmeyen sürümde en yeni sürüme dönülür ve `window/showMessage` ile uyarı gösterilir. Sürüm
  değişince servis yeniden yapılandırılır ve açık belgelerin tanıları yeniden yayımlanır.
- **Çalışma alanı dosyaları:**
  - `skript/workspaceFiles` `{ files: { uri, text }[], complete: boolean }` — listeyi tamamen değiştirir.
  - `skript/workspaceFileChanged` `{ uri, text: string | null }` — tek dosyayı ekler/günceller, `null` siler.
  Açık belge aynı URI'deki çalışma alanı dosyasını gölgeler (URI karşılaştırması büyük/küçük harf duyarsız).
- **Tanılar:** push modeli (`textDocument/publishDiagnostics`), her tanıda `source: "skript-ls"`;
  yazarken ~180 ms debounce.
- **Dinamik kayıt:** İstemci `dynamicRegistration` destekliyorsa completion, hover, definition,
  references, documentSymbol ve semantic tokens `documentSelector: [{ language: "skript" }]` ile
  `client/registerCapability` üzerinden kaydedilir. Monaco 0.57'nin istemcisi semantic tokens kaydını
  `textDocument/semanticTokens/full` yöntemiyle eşlediği için kayıt bu yöntemle yapılır. Desteklemiyorsa
  aynı yetenekler `initialize` sonucunda statik olarak bildirilir.
- **Addon'lar:** `{ settings: { skript: { addons: { "SkBee": "3.26.0" } } } }` (ya da `[{ name, version }]`).
  Seçili addon'ların syntax verisi (`@skript-ide/syntax-db` `data/addons/`) Skript verisine eklenir; tam
  eşleşen veri yoksa en yakın Skript sürümününki kullanılır. `skript/addonStatus` isteği her addon için
  `{ name, version, data: "exact" | "nearest" | "missing", skriptVersion? }` döndürür.
- **Geçiş raporu:** `skript/migrationReport { from, to }` → `MigrationReport` (kaldırılan / değişen / yeni
  kullanımlar ve doğrulanmış düzeltmeler). Son raporun düzeltmeleri, satır değişmediyse
  `textDocument/codeAction` sonucuna da eklenir.
- **Değişkenler:** `textDocument/definition`, `references` ve `rename` değişkenleri de kapsar.
- Yalnızca `languageId === "skript"` belgeler analiz edilir.

## Diagnostics kodları

| Kod | Kural | Önem |
|---|---|---|
| `parse/<parser-kodu>` | Parser'ın sözdizimsel tanısı (ör. `parse/unclosed-string`, `parse/indent-mixed`) | Parser'ın verdiği önem |
| `undefined-function` | Çağrılan ad ne çalışma alanında (bu dosya + diğer dosyalar, `local function` yalnızca kendi dosyasında) ne de seçili sürümün yerleşik fonksiyonlarında var | warning |
| `function-arguments` | Çalışma alanındaki bir fonksiyona imzasından az ya da çok argüman verilmiş (tek parametreli fonksiyonlarda ve `and` listelerinde denetlenmez) | error |
| `function-argument-type` | Sayı/konum/varlık gibi bir parametreye metin sabiti (`"..."`) verilmiş | error |
| `function-disabled-file` | Fonksiyon yalnızca Skript'in yüklemediği, adı `-` ile başlayan bir dosyada/klasörde tanımlı | error |
| `function-other-file` | Fonksiyon başka bir dosyada tanımlı; bu dosya oyunda tek başına yüklenirse önce o dosya yüklü olmalı (fonksiyon başına bir kez) | information |
| `undefined-option` | `{@ad}` bu dosyanın `options:` bölümünde tanımlı değil (option'lar dosyaya özeldir) | warning |
| `version-syntax` | Satır seçili sürümde hiçbir kayda (exact/structural) uymuyor, başka bir sürümde `exact` uyuyor | warning |
| `unknown-syntax` | Satır seçili sürümde hiçbir kayda (structural dahil) uymuyor; başka sürümde ya da bilinen bir addon'da da `exact` karşılığı yok. Ayrıca üst düzeyde `if …:`, `loop …:`, `trigger:` gibi yalnızca gövdede geçerli başlıklar | error |
| `addon-syntax` | Satır seçili sürümde uymuyor ama seçili olmayan bir addon'un (ya da seçili addon'un başka sürümünün) syntax'ına uyuyor | warning |
| `variable-unwritten` | Değişken okunuyor ama hiçbir yerde yazılmıyor (genel değişkende bilgi düzeyi) | warning / information |
| `variable-unread` | Yerel değişken yazılıyor ama hiç okunmuyor | information |
| `variable-typo` | Yazılmayan değişken, yazılan bir değişkene çok benziyor; "şunu mu demek istedin?" hızlı düzeltmesiyle | warning |
| `variable-local-scope` | Yerel değişken bir tetikleyici / fonksiyon gövdesi dışında kullanılıyor | warning |

**Neden `undefined-function` warning?** Addon'lar kendi fonksiyonlarını ekleyebilir ve çalışma alanı
listesi eksik olabilir. Bu yüzden hata yerine uyarı verilir; çalışma alanı listesi `complete: false`
ise (ve en az bir dosya bildirilmişse) bu denetim tamamen atlanır. Tek dosya modunda (hiç çalışma alanı
bildirilmemişse) denetim yapılır.

Sürüm uyarısı yalnızca yukarıdaki dar koşulda üretilir. Hiçbir yerde eşleşmeyen satır `unknown-syntax`
olur; ancak şu durumlarda **verilmez**: eşleştirici adım bütçesini tüketti (sonuç kesin değil,
`matchWithStatus().complete === false`), verisi olmayan bir addon seçili, çalışma alanında skript-reflect
özel syntax yapısı (`effect …:`, `expression …:`, `… property …:`) var, satır yalın fonksiyon çağrısı,
Java çağrısı (`{_x}.add(…)`), addon bölümü girişi (`anahtar: değer`) ya da `if any:` / `if all:`.
Bölüm başlıkları ayrıca koşul (Skript'in örtük `if`'i) ve efekt olarak da denenir. Corpus ölçümünde
(52 vanilla dosya, iki sürüm) bu kural 36 gerçek sunucu hatasını yakaladı, yeni yanlış pozitif üretmedi.
Satır türü bağlama göre seçilir: olay başlığı `matchEvent`,
`if`/`else if`/`while`/`parse if` başlıkları koşul, diğer bölüm başlıkları `section`, gövde satırları
effect/condition (satır içinde kullanılabilen bölümler de kabul edilir, ör. `wait 2 seconds`) olarak
eşleştirilir. `options:`, `variables:`, `aliases:` ve komut girişleri taranmaz. Skript dokümanlarındaki
`implicit:<…>` işaretleri gerçek satırlarla eşleştirilmez.

## Özellikler

- **Tamamlama:** Bağlama göre olay/yapı (üst düzey), efekt/koşul/bölüm (gövde), ifade/fonksiyon
  (ifade bağlamı); `patternToSnippet` ile snippet. Tanımlı fonksiyonlar imzayla, `{@` yazınca
  option'lar, `{` yazınca değişken adları, komut gövdesinde `permission:` gibi girişler.
  Trigger karakterleri: `{`, `@`, `%`, `.`.
- **Hover:** en iyi syntax eşleşmesi (ad, tür, açıklama, ilk örnek, `since`, gereksinimler, deprecated,
  olay değerleri); fonksiyon çağrısında/tanımında imza; `{@option}` üzerinde değer.
- **Tanıma git / referanslar:** Fonksiyonlar dosyalar arası (local kapsamı korunur), option tanımları.
- **Outline:** event/command/function/options/variables/aliases ve içlerindeki bölümler; Türkçe ayrıntı.
- **Semantic tokens (full):** fonksiyon tanım/çağrı adları, parametreler, değişkenler, option referansları.
  Legend `SEMANTIC_TOKENS_LEGEND` olarak dışa açılır (`function`, `parameter`, `variable`, `macro`;
  `declaration` değiştiricisi).

## Çalıştırma ve test

```bash
npm run typecheck -w @skript-ide/language-server
npm test -w @skript-ide/language-server

# stdio sunucusunu doğrudan çalıştırma
node --import tsx packages/language-server/src/bin.ts --stdio
```

Testler: çekirdek servis özellikleri sahte parser/matcher ile (hızlı, deterministik), ayrıca gerçek
`@skript-ide/parser` + `@skript-ide/pattern-compiler` ile entegrasyon ve `src/bin.ts` sürecini stdio
üzerinden başlatan uçtan uca akış (`test/e2e.test.ts`).
