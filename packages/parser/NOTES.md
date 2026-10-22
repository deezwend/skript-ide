# `@skript-ide/parser` — kaynak doğrulama notları

Bu paket Skript betiklerinin **yapısal** çözümlemesini yapar: girinti, bölümler, girdiler,
semboller ve Skript'in kendi hata verdiği sözdizimsel durumlar. Pattern (syntax) eşleştirmesi
bu paketin işi değildir; `pattern-compiler` paketindedir.

## İncelenen Skript kaynakları

İndirilen dosyalar depoya konmadı (geçici klasörde tutuldu). Kullanılan tag: **2.17.1**;
girinti/yorum davranışının değişmediğini doğrulamak için **2.12.2** ile karşılaştırıldı.

| Dosya (2.17.1) | Doğrulanan konu |
|---|---|
| `src/main/java/ch/njol/skript/config/Node.java` | `splitLine`: `#`, `##`, string içi `#`, `%…%` durum makinesi |
| `src/main/java/ch/njol/skript/config/SectionNode.java` | Girinti birimi, beklenen girinti, dedent, `M_EMPTY_SECTION`, `###` |
| `src/main/java/ch/njol/skript/config/Config.java` | Varsayılan birim `\t`, `level`, `setIndentation` |
| `src/main/java/ch/njol/skript/config/ConfigReader.java` | UTF-8 BOM'un yalnızca başta çıkarılması |
| `src/main/java/ch/njol/skript/ScriptLoader.java` | `simple=true`, `allowEmptySections=false`, `:` ayırıcı, `replaceOptions`, `validateLine` |
| `src/main/java/ch/njol/skript/structures/StructEvent.java` | `[on] [:cancelled|:uncancelled|any:(any\|all)] <.+> [with priority …]` |
| `src/main/java/ch/njol/skript/structures/StructOptions.java` | `convertToEntries(-1)`, iç içe bölümlerde `a.b` öneki |
| `src/main/java/ch/njol/skript/structures/StructVariables.java` | `convertToEntries(0, "=")`, süslü parantez uyarısı, `{…}` adı |
| `src/main/java/ch/njol/skript/structures/StructAliases.java` | `convertToEntries(1, "=")` |
| `src/main/java/ch/njol/skript/structures/StructFunction.java` | Fonksiyon imza regex'i, `local`, `returns`/`->`/`::` |
| `org/skriptlang/skript/common/function/FunctionParser.java` | Parametre regex'i (`ad: tür = varsayılan`) |
| `org/skriptlang/skript/bukkit/command/…/StructCommand.java` ve `util/SubCommandEntryData.java` | Komut giriş anahtarları (`trigger`, `permission`, `cooldown storage`, …) |
| `ch/njol/skript/structures/StructCommand.java` (2.12.2) | Eski komut girişleri ve `command /ad` deseni |
| `src/main/java/ch/njol/skript/structures/StructUsing.java` | Gövdesiz `using …` yapısı |
| `src/main/java/ch/njol/skript/lang/VariableString.java` | `%%`, `""`, `%…%`, tek `%` hatası, `{…}` |
| `src/main/java/ch/njol/skript/lang/SkriptParser.java` | `nextQuote`, `next`, `validateLine`, tırnak sayısı |
| `org/skriptlang/skript/common/function/FunctionReferenceParser.java` | Fonksiyon çağrısı deseni |

## Doğrulanan kurallar

### Yorum ve satır bölme (`Node.splitLine`)

- Satır trim edilmiş hali `###` ise **blok yorum** açılır/kapanır; `###` satırı ve içindeki
  tüm satırlar yorumdur. Açık kalan blok yorumu Skript'te hatadır.
- Trim edilmiş satır `#` ile başlıyorsa tamamı yorumdur (`##` ile başlayan satır da yorumdur;
  kaçış yalnızca satır ortasında geçerlidir).
- Durum makinesi: `"` kod↔string, `{` kod→değişken, `}` değişken→kod, `%` kod↔önceki durum,
  `#` kod/değişkende yorumu başlatır; **string içindeki `#` yorum değildir**.
- `##` (string dışında), `%%` ve `""` çiftlenmiş kaçışlardır; çiftlenmiş `#` tek `#` anlamına gelir.
- Değişken adı içindeki `#` yorum başlatır.
- `ConfigReader` UTF-8 BOM'u dosyanın ilk boş olmayan satırından çıkarır.

### Girinti

- Betikler `simple=true`, `allowEmptySections=false`, ayırıcı `:` ile yüklenir.
- Bir üst düzey bölümün **ilk girintili boş olmayan satırı** girinti birimini belirler.
  Birim, o satırın tamamı kadardır (ör. 4 boşluk, 1 tab) ve yalnızca tek tür boşluk içerebilir;
  tab+boşluk karışımı Skript'te hatadır.
- Beklenen girinti `seviye × birim`dir. Daha derin girinti (birimden sonra boşluk) veya birimin
  tam katı olmayan girinti hatadır. Daha az girinti, birim katıysa üst bölüme döner.
- Üst düzey (ana bölüm) satırları girintisiz olmalıdır.
- İç içe bölümlerde birim yeniden belirlenmez; üst düzey bölüm değişince yeniden belirlenebilir.
- Bir bölümde boş olmayan alt düğüm yoksa (yorum/satır boşları sayılmaz) Skript
  `M_EMPTY_SECTION` uyarısı verir: dedent anında veya dosya sonunda.
- Skript `simple` betiklerde `:` ile biten **her** satırı bölüm başlığı yapar; bu nedenle
  `trigger:` gibi komut girdileri de bölüm olarak açılır. Bu paket bunları bağlama göre
  `EntryNode` (alt bloklu) veya `SectionNode` olarak temsil eder.
- Skript'in `#-#` özel yorumu (`fullLinePattern`) uygulanır: `on join: #-# devre dışı` gibi
  satırlar bölüm başlığı sayılmaz; `simple` betikte normal satır/girdi olarak işlenir.

### Yapılar

- `options`, `variables`, `aliases`: tam eşleşme (büyük/küçük harf duyarsız).
- `using …`, `import …`, `auto[matically] reload …`: gövdesiz (simple) yapılar.
- Olay başlıkları `on`, `every`, `at`, `cancelled`, `uncancelled`, `any`, `all` ile başlarsa
  `event`; diğer `:` ile biten üst düzey başlıklar `unknown`.
- `function ad(...)`, `local function ad(...)`; dönüş türü `::`, `->` veya `returns` ile.
- Komut başlığı `command <ad> …`; ad ilk belirteçtir (`/heal` yazıldığı gibi).
- Komut girdileri: `aliases`, `description`, `usage`, `prefix`, `permission`,
  `permission message`, `executable by`, `cooldown`, `cooldown message`, `cooldown bypass`,
  `cooldown storage`, `trigger`, `suggestions`, `subcommand(s)`.
- `options` içinde iç içe bölümler `a.b` biçiminde option adı üretir.
- `variables` ve `aliases` girdileri ilk `=` işaretinden ayrılır; `variables` anahtarı
  `{ad}` biçiminde olmalıdır (parantezsiz ad Skript'te uyarıdır).
- Fonksiyon parametreleri üst düzey virgüllerden ayrılır; `ad: tür [= varsayılan]`.
  Tür/parametre regex'i Skript'in `SCRIPT_PARAMETER_PATTERN`'i ile uyumludur.

### String, yüzde ve değişken

- `VariableString`: tek `%` hatadır (“literal % için %%”); `%%` kaçıştır; `%…%` arası ifadedir.
- String içinde `{…}` yalnızca `%…%` içindeyse değişkendir; düz metindeki `{`/`}` literaldir.
- Değişken adları iç içe olabilir: `{a::%{_b}%}`. İç ifade ayrıca taranır.
- `{@ad}` option referansıdır; yorumlarda aranmaz.
- Fonksiyon çağrısı deseni: `[\p{L}_][\p{L}\d_]*\(…\)` (ad ile parantez arasında boşluk yok).
  String içinde yalnızca `%…%` arasındaki çağrılar semboldür.

## API

Sözleşmedeki tüm adlar aynen export edilir:

`parseDocument`, `nodePathAt`, `SkriptDocument`, `LineInfo`, `StructureNode`, `SectionNode`,
`StatementNode`, `EntryNode`, `BodyNode`, `StructureKind`, `FunctionDefinition`,
`FunctionParameter`, `FunctionCall`, `OptionDefinition`, `OptionReference`,
`VariableReference`, `CommandDefinition`, `ParseDiagnostic`, `Position`, `Range`, `Severity`.

Ek olarak `NodeBase` export edilir. Sözleşmeden sapma yoktur.

Konumlar 0 tabanlı satır/karakter ve UTF-16 kod birimidir. `LineInfo.start` ve tüm `Range`
değerleri belgeyle (BOM dahil) hizalıdır.

## Tanılama kodları

| Kod | Önem | Durum |
|---|---|---|
| `indent-mixed` | error | Girintide tab ve boşluk karışımı |
| `indent-unexpected` | error | Üst düzeyde girinti |
| `indent-inconsistent` | error | Beklenen birim/seviye ile uyuşmayan girinti |
| `top-level-statement` | error | `:` ile bitmeyen üst düzey satır (betikte SimpleNode) |
| `empty-section` | warning | Gövdesiz bölüm (Skript `M_EMPTY_SECTION`) |
| `unclosed-string` | error | Kapanmamış `"` |
| `unclosed-variable` | error | Kapanmamış `{` |
| `unclosed-percent` | error | String/VariableString içinde tek `%` |
| `unclosed-block-comment` | error | Açık kalan `###` |
| `invalid-option-line` | error | options içinde `anahtar: değer` olmayan satır |
| `invalid-variable-line` | error | variables içinde `{ad} = değer` olmayan satır |
| `invalid-alias-line` | error | aliases içinde `ad = değer` olmayan satır |
| `invalid-command-line` | error | command gövdesinde girdi olmayan satır |
| `duplicate-command-entry` | error | komutta aynı girdi anahtarı (ör. iki `permission:`) tekrarlanmış; Skript komutu "Unexpected entry" ile reddeder |
| `variable-missing-brackets` | warning | variables içinde süslü parantezsiz ad |
| `function-invalid-parameter` | error | Boş/eksik parametre ya da tür/varsayılan |
| `function-duplicate-parameter` | error | Aynı adlı parametre |
| `function-invalid-signature` | error | İmza veya dönüş türü okunamıyor |
| `internal-error` | error | Yalnızca güvenlik ağı; normalde oluşmaz (fuzz testi yasaklar) |

## Kararlar ve bilinçli sınırlamalar

- **Bilinmeyen üst düzey başlıklar** `unknown` olarak temsil edilir ve gövdesi yapısal olarak
  (bölüm/statement) çözümlenir. Eklenti yapılarının ham metin gövdesi olabileceği için bu
  gövdede **sözcüksel tanılama ve sembol çıkarımı yapılmaz** (yanlış pozitiften kaçınmak için).
  `using`/`import`/`auto reload` gövdesiz yapı olarak tanınır.
- **`##` çözülmez:** `LineInfo.text` ve girdi değerleri kaynak metnini korur; böylece konumlar
  bozulmaz. Skript'in iç değeri `#` olabilir, ancak editör konumları bu pakette önceliklidir.
- **Aralıklar** son içeriğin sonunda biter; satır sonundaki yorumlar bölüm/statement aralığına
  dahil edilmez. `headerRange`, `keyRange`, `valueRange`, `textRange` yorum içermez.
- **Fonksiyon çağrıları** sözdizimseldir; tanımlı olup olmadığı veya tür uyumu bu pakette
  denetlenmez (syntax-db/language-server işi).
- **Fonksiyon türleri** kayıtlı tür veritabanına karşı doğrulanmaz; yalnızca yapı denetlenir.
- **Komut giriş anahtarları** bilinmeyen anahtarlar için tanılama üretilmez (eklenti/ileri sürüm
  uyumluluğu). Bilinen anahtarların değerleri bağlama göre taranır.
- **`%` parity** yalnızca string/VariableString bağlamında denetlenir; `variables:` anahtarı ve
  `cooldown storage` gibi VARIABLE_NAME bağlamlarında `%…%` tür adı sayılır ve taranmaz.
- BOM yalnızca ilk boş olmayan satırda (ConfigReader gibi), tek `\r`/`\n`/`\r\n` satır sonları desteklenir.
- Girinti yalnızca boşluk/tab olarak kabul edilir; diğer Unicode boşlukları metin sayılır.
- `top-level-statement` için `using`, `import`, `auto[matically] reload` muaf tutulur. Başka bir
  eklentinin gövdesiz yapısı bu satırda false positive üretebilir (bilinen sınırlama).

## Performans

Ölçüm: `test/performance.test.ts` içinde 10.000 satırlık gerçekçi betik (event + command +
iç içe bölüm + string interpolasyonları). Windows, Node 24, `tsx`:

- Isınmış parse, 3 ölçümün en iyisi: **~19–33 ms** (ölçümler arasında JIT/ortam farkı)
- İlk (soğuk/JIT) parse: ~200 ms
- 2.500 rastgele bozulmuş girdi fuzz testi: ~0,4–0,7 s

Çözümleyici tek geçişlidir; satır başına doğrusal tarama yapar.

## Testler

`npm test -w @skript-ide/parser` → **68 test**, 7 dosya:

- `lines.test.ts` — LF/CRLF/CR, BOM, yorumlar, `##`, `###`, boş belge
- `structures.test.ts` — tüm yapı türleri, komut girdileri, iç içe bölümler, options/variables
- `diagnostics.test.ts` — girinti, boş bölüm, kapanmamış string/değişken/yüzde, satır hataları
- `symbols.test.ts` — fonksiyonlar/çağrılar, option'lar, değişkenler, astral karakter konumları
- `path.test.ts` — `nodePathAt`
- `fuzz.test.ts` — 2.500 kesilmiş/bozulmuş girdi, determinizm, aralık sınırları
- `performance.test.ts` — 10.000 satır ölçümü

`npm run typecheck -w @skript-ide/parser` strict + `noUnusedLocals` + `noUnusedParameters` ile temiz.
