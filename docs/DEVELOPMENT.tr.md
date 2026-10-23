# Skript IDE

Minecraft [Skript](https://github.com/SkriptLang/Skript) betikleri için masaüstü geliştirme ortamı.

## Çalıştırma

```bash
npm install
npm run dev
```

`npm install`, Electron'un ikili dosyasını da indirir (`postinstall` → `install-electron`).

| Komut | Ne yapar |
|---|---|
| `npm run dev` | Uygulamayı geliştirme modunda açar (arayüz değişiklikleri anında yansır) |
| `npm run build` | Üretim derlemesini `packages/desktop/out/` klasörüne alır |
| `npm run typecheck` | Tüm paketlerde TypeScript kontrolü yapar |
| `npm test` | Tüm paketlerin birim testlerini çalıştırır (node:test + tsx) |

Renklendirmeyi denemek için `examples/ornek.sk` dosyasını açabilirsin.

### Gerçek sunucuyla doğrulama

`.sk` dosyası kaydedildiğinde ya da **Doğrula (F5)** ile, betik arka planda çalışan headless bir
Paper + Skript sunucusunda `sk reload` ile yüklenir; Skript'in bildirdiği hatalar ve uyarılar
**PROBLEMLER** sekmesinde ve editörde dalgalı çizgi olarak görünür. Hatalı örnek: `examples/hatali.sk`.

- Gereken Java sürümü seçilen Skript sürümüne bağlıdır: Paper 26.x için Java 25, Paper 1.21.x için Java 21
  (uygulama `JAVA_HOME`, `PATH` ve bilinen kurulum klasörlerine bakar; eksikse sürüm seçicide uyarı çıkar).
- İlk çalıştırmada uygulama Minecraft EULA'sını gösterip onay ister; onay verilmeden `eula.txt` yazılmaz.
- Paper ve Skript jar'ları ilk açılışta indirilip `userData/runtime/cache` altında saklanır. Test sunucusu
  `userData/runtime/servers` altında, yalnızca `127.0.0.1` üzerinde ve çevrimdışı modda çalışır.
- Sunucu, projenin Skript sürümüne karşılık gelen Paper sürümüyle çalışır (varsayılan: Skript 2.17.1 + Paper 26.3).

### Arayüz dili

Uygulama Türkçe ve İngilizce kullanılabilir. İlk açılışta sistem dili Türkçeyse Türkçe, değilse İngilizce
seçilir; **Görünüm → Dil (Language)** menüsünden değiştirilebilir (seçim `userData/settings.json` dosyasına
yazılır ve yeniden başlatınca uygulanır). Menüler, paneller, sunucu durumları ve dil sunucusunun tanı / hover /
tamamlama metinleri seçilen dilde gösterilir; Skript'in kendi hata mesajları her zaman İngilizcedir.

Metinler kodda iki dilde yazılır: `l('Kaydet', 'Save')` (`packages/i18n`). `index.html`'deki sabit metinlerin
İngilizcesi `data-en`, `data-en-title`, `data-en-placeholder` ve `data-en-aria-label` özniteliklerindedir.
Tarayıcı önizlemesinde (`http://localhost:5199`) dil `?lang=en` ile seçilebilir.

### Skript sürümü seçme

Durum çubuğundaki **Skript 2.x.y** öğesine tıklayınca sürüm listesi açılır. Bir sürüm seçildiğinde doğrulama
sunucusu o sürümün Paper + Skript ikilisine geçer (gerekirse indirilir ve yeniden başlatılır), Syntax Tarayıcısı
da o sürümün verisini gösterir. Klasör açıksa seçim kökteki `skript-project.json` dosyasına yazılır:

```json
{
  "skriptVersion": "2.14.3"
}
```

Dosya yoksa varsayılan sürüm kullanılır; geçersizse uyarı gösterilip varsayılana dönülür. İleride
`serverVersion` ve `addons` alanları da gelecek (bilinmeyen alanlar yazarken korunur).

| Skript | Paper (doğrulama) | Java | Desteklenen Minecraft | Not |
|---|---|---|---|---|
| 2.17.1 | 26.3 | 25 | 1.21.5 – 26.3 | Güncel sürüm |
| 2.16.2 | 26.2 | 25 | 1.21.4 – 26.2 | 2.16 serisinin son sürümü |
| 2.14.3 | 1.21.11 | 21 | 1.21.0 – 1.21.11 | MiniMessage/Adventure geçişinden (2.15) önceki son sürüm |
| 2.12.2 | 1.21.8 | 21 | 1.19.4 – 1.21.8 | Spigot ve 1.19.4 desteği olan son seri |

Tablo `packages/runtime-validator/src/versions.ts` içindedir; her ikili bu makinede gerçekten açılıp denendi.

### Statik analiz (Language Server)

Editör, sunucu doğrulamasını beklemeden yazarken çalışan bir Skript dil sunucusuna (LSP) bağlıdır:

- **Tanılar:** girinti hataları (tab/boşluk karışımı, tutarsız seviye), kapanmamış `"` / `{` / `%`,
  tanımsız fonksiyon, tanımsız `{@option}`, tekrarlanan komut girdisi ve seçili sürümde olmayan ya da
  sonraki bir sürümde eklenmiş syntax için sürüm uyarısı. Seçili sürümde, başka bir sürümde ve bilinen
  addon'larda hiçbir syntax'a uymayan satırlar için sunucuyu beklemeden Skript'in "Can't understand
  this …" hatasının karşılığı (`unknown-syntax`) verilir. Yanlış pozitif, eksik uyarıdan daha kötü
  sayıldığı için emin olunamayan durumlarda (verisi olmayan addon seçili, skript-reflect özel syntax'ı,
  Java çağrısı) uyarı verilmez.
- **PROBLEMLER** paneli statik tanıları ve sunucu doğrulamasını birlikte listeler; kaynak her satırda
  **statik** / **sunucu** etiketiyle ayrılır.
- **Tamamlama** (olaylar, efektler/koşullar/bölümler, ifadeler, fonksiyonlar, `{@option}`, değişkenler,
  komut girdileri), **hover** (syntax belgesi, fonksiyon imzası, option değeri), fonksiyonlar için
  **tanıma git** (F12) / **referanslar** (Shift+F12) ve **semantic tokens**.
- **Anahat:** kenar çubuğundaki **ANAHAT** sekmesi ya da **Git › Sembole Git… (Ctrl+Alt+O)**
  (Ctrl+Shift+O "Klasör Aç" için ayrıldığından).
- Sürüm `skript-project.json` dosyasından okunur; değişince sunucu yeniden yapılandırılır.

### Syntax Tarayıcısı

Kenar çubuğundaki **SYNTAX TARAYICISI** sekmesi, seçili sürümdeki olay, koşul, efekt, ifade, bölüm, yapı,
tür ve fonksiyonlarda arama yapar; pattern'leri, açıklamayı, örnekleri, eklendiği sürümü, dönüş türünü ve
olay değerlerini gösterir. Addon seçiliyse kayıtlar kaynağıyla (**Skript** / addon adı) etiketlenir ve
kaynağa göre süzülebilir.

### Addon'lar

`skript-project.json` içindeki `addons` alanı projede kullanılan addon'ları ve sürümlerini tutar:

```json
{ "skriptVersion": "2.17.1", "addons": { "SkBee": "3.26.0", "skript-reflect": "2.6.3" } }
```

- **Skript › Addon'lar…** menüsü ya da durum çubuğundaki **Addon** öğesi seçiciyi açar. Her sürümün yanında
  seçili Skript sürümüyle gerçek sunucuda denenmiş sonucu yazar: ✓ çalışıyor, ◐ kısmen, ✕ çalışmıyor,
  ? denenmedi. Bilinmeyen addon'lar proje dosyasında korunur ama kurulmaz.
- Seçili addon'ların syntax'ları tamamlama, hover ve tanılarda tanınır. Seçili olmayan bir addon'un
  syntax'ı kullanılırsa `addon-syntax` uyarısı hangi addon'un gerektiğini söyler.
- Doğrulama sunucusu seçili addon jar'larını (Modrinth / GitHub, sha256/sha512 denetimli) indirip kurar;
  addon değişince sunucu yeniden başlar.

Desteklenen addon'lar ve doğrulanmış uyumluluk:

| Addon | Sürüm | Skript 2.17.1 | 2.16.2 | 2.14.3 | 2.12.2 |
| --- | --- | --- | --- | --- | --- |
| SkBee | 3.26.0 | ✓ | ✓ | ✕ | ✕ |
| SkBee | 3.16.1 | ◐ | ◐ | ✓ | ✓ |
| skript-reflect | 2.6.3 | ✓ | ✓ | ✓ | ✕ |
| skript-reflect | 2.6.1 | ✕ | ✕ | ✕ | ✓ |

Tablonun ayrıntılı ve üretilmiş hali `packages/runtime-validator/src/addon-compat.ts` dosyasında
(`npm run verify-addons -w @skript-ide/runtime-validator -- --runtime-dir=<klasör>`). Her addon sürümünün
syntax verisi, gerçek sunucuda o addon yüklüyken Skript'in kayıt defterinden dökülerek üretilir
(`packages/syntax-db/data/addons/`).

### Değişken analizi

- Hiç yazılmayan yerel değişken (uyarı), hiç okunmayan değişken (bilgi), büyük ihtimalle yazım hatası
  olan değişken (**"şunu mu demek istedin?"** + hızlı düzeltme) ve tetikleyici dışında kullanılan yerel
  değişken tanıları. Genel değişkenlerin "yazılmıyor" tanısı, başka dosya ya da eklentiden yazılabildikleri
  için bilgi düzeyindedir.
- Değişkenler için **tanıma git**, **referanslar** ve **yeniden adlandır** (F2). Liste değişkenlerinin
  `::*` biçimleri ve fonksiyon parametreleri de kapsanır.

### Sürüm Geçiş Asistanı

**Skript › Sürüm Geçiş Asistanı…** (ya da sürüm seçicinin altındaki bağlantı) projedeki her satırı kaynak ve
hedef sürümün syntax verisiyle eşleştirir ve üç grup listeler: hedefte **kaldırılan**, kalıbı **değişen**
(hedef kalıplarıyla birlikte) ve yalnızca hedefte tanınan **yeni** kullanımlar. Bilinen yeniden yazımlar
(ör. `command "x" by console` → `execute command "x" by console`) hedef sürümde gerçekten eşleştiği
doğrulanırsa tek tek ya da topluca uygulanabilir; aynı düzeltmeler editörde hızlı düzeltme olarak da çıkar.
**Gerçek sunucuda doğrula**, projeyi hedef sürümün sunucusunda (seçili addon'larla) dener ve ardından
eski sürüme döner.

### Güncellemeler

Kurulum dosyasıyla yüklenen uygulama, açılıştan kısa süre sonra ve dört saatte bir GitHub sürümlerini
denetler (`electron-updater`). Yeni sürüm arka planda iner, durum çubuğunda **↻ Güncellemek için yeniden
başlat** görünür; uygulama kapatılınca da kurulur. **Yardım → Güncellemeleri Denetle…** elle denetler,
**Yardım → Otomatik Güncelle** otomatik denetimi ve indirmeyi kapatır (seçim `userData/settings.json`'da).
Güncellemeden sonraki ilk açılışta **Yenilikler** penceresi o sürümün GitHub yayın notlarını gösterir;
**Yardım → Yenilikler…** ile her zaman açılabilir. Geliştirme modunda (`npm run dev`) denetim yapılmaz.

Yeni sürüm yayımlamak:

1. `packages/desktop/package.json` (ve kökteki) `version` alanını artır.
2. `GH_TOKEN` ortam değişkenine `repo` yetkili bir GitHub token'ı koy ve `npm run release -w @skript-ide/desktop`
   çalıştır. Kurulum dosyası, `latest.yml` ve `.blockmap` `v<sürüm>` etiketli GitHub sürümüne yüklenir
   (sürüm taslak olarak oluşur).
3. GitHub'da sürümün açıklamasına yenilikleri yaz (Markdown) ve yayımla. Bu metin hem güncelleme
   penceresinde hem **Yenilikler** penceresinde gösterilir.

## Yapı

```
packages/
├─ skript-language/   Skript dil tanımı: Monarch tokenizer, girinti kuralları, tema
│                     (editörden bağımsız; ileride language server ve VS Code eklentisi de kullanacak)
├─ runtime-validator/ Paper/Skript indirme, Java bulma, sunucuyu yönetme, Skript konsol çıktısını ayrıştırma,
│                     Skript ↔ Paper ↔ Java uyumluluk tablosu
├─ syntax-db/         Sürüm başına Skript syntax veritabanı (JSON) + şema tipleri, yükleyiciler, arama
├─ pattern-compiler/  Skript pattern'lerini ([], (a|b), %tür%, <regex>, 1¦ işaretleri) derleyip satır eşleyen motor
├─ parser/            Hataya dayanıklı girinti tabanlı parser: yapılar, bölümler, fonksiyonlar, option/değişken
│                     referansları ve tanılar
├─ language-server/   Editörden bağımsız LSP sunucusu (tarayıcı Web Worker'ı ve Node/stdio girişleri)
├─ corpus/            Gerçek dünya .sk örnekleri, sunucu referansı (ground truth) ve yanlış pozitif ölçümü
└─ desktop/           Electron uygulaması
   ├─ src/main/       Ana süreç: pencere, menü, dosya sistemi (yalnızca kullanıcının seçtiği yollara erişim),
   │                  doğrulama sunucusunun yaşam döngüsü
   ├─ src/preload/    Arayüze güvenli `window.skriptIde` API'si
   ├─ src/shared/     Ana süreç ↔ arayüz IPC sözleşmesi
   └─ src/renderer/   Monaco editör, sekmeler, dosya gezgini, Syntax Tarayıcısı, Problemler / Sunucu Konsolu
                      paneli, durum çubuğu ve sürüm seçici
```

## `@skript-ide/syntax-db`

Editörden bağımsız paket; ileride language server ve VS Code eklentisi de kullanacak.

```ts
import { listSyntaxVersions, loadSyntaxDatabase, SyntaxIndex } from '@skript-ide/syntax-db'

const db = await loadSyntaxDatabase('2.17.1')   // sürüm başına ayrı parça, istendiğinde yüklenir
const index = new SyntaxIndex(db)
index.search('send title', { kinds: ['effect'], limit: 10 })
index.get('expression', 'ExprPing')
```

Paketlenmemiş düz Node'da `@skript-ide/syntax-db/node` içindeki `readSyntaxDatabase()` dosyadan okur.
Her kayıtta `kind`, `id`, `name`, ham Skript `patterns`, `description`, `examples`, `since` ve varsa
`returnType`, `eventValues`, `cancellable`, `events`, `requirements`, `keywords`, `deprecated` bulunur
(şema: `packages/syntax-db/src/schema.ts`).

### Veriyi yeniden üretme

Veri elle yazılmaz; Skript'in kendi doküman üreticisinin (`JSONGenerator`, `/skript gen-docs`) çıktısından üretilir.

```bash
npm run generate -w @skript-ide/syntax-db
```

- `--source=archive` (varsayılan): SkriptLang'in her sürümde CI'da ürettiği
  [`skript-docs/docs/archives/<sürüm>/docs.json`](https://github.com/SkriptLang/skript-docs/tree/main/docs/archives)
  dosyasını indirir. İndirme commit SHA'sına sabitlenir; SHA ve dosyanın sha256'sı çıktıda `source` alanına yazılır.
  `--docs-commit=<sha>` ile belirli bir commit kullanılabilir.
- `--source=server`: Eşleşen Paper + Skript sunucusunu yerelde açıp `sk gen-docs` çalıştırır
  (EULA önceden kabul edilmiş olmalı; betik EULA'yı kendisi kabul etmez). `--runtime-dir` ile sunucu klasörü verilir.
- `--check`: Dosyaları yazmak yerine depodaki veriyle karşılaştırıp farkları özetler (iki kaynağı çapraz doğrulamak için).
- Sürüm listesi varsayılan olarak uyumluluk tablosundan gelir; komut satırında sürüm verilerek daraltılabilir.
  `src/catalog.ts` de bu betik tarafından üretilir.

Addon verisi:

```bash
npm run generate-addons -w @skript-ide/syntax-db -- --runtime-dir=<klasör>
```

Her (addon sürümü, Skript sürümü) çifti için sunucu o addon'la açılır, kayıt defteri dökülür ve addon'un
kendi doküman komutu (varsa) çalıştırılır. Ham dökümler `--raw-dir` ile saklanırsa `--offline` sunucu
açmadan yeniden üretir.

## Language Server mimarisi

`@skript-ide/language-server` hiçbir editöre bağlı değildir; aynı sunucu iki girişle çalışır:

- **Masaüstü:** arayüzde bir modül **Web Worker** içinde (`@skript-ide/language-server/browser`), Monaco'nun
  yerleşik LSP istemcisiyle `postMessage` üzerinden JSON-RPC konuşur. Böylece `contextIsolation` ve
  `sandbox` açık kalır, yeni bir süreç ya da IPC kanalı gerekmez ve mevcut CSP (`worker-src 'self' blob:`) yeterlidir.
  Çalışma alanındaki `.sk` dosyaları arayüzün zaten izinli olan `readDir`/`readFile` API'siyle okunup
  sunucuya bildirilir (derinlik 8, en çok 300 dosya, dosya başına 256 KB).
- **Node / stdio:** `@skript-ide/language-server/node` (ileride VS Code eklentisi bunu kullanacak).

Protokol eklemeleri: `initializationOptions.skriptVersion`,
`workspace/didChangeConfiguration { settings: { skript: { version, addons } } }`, çalışma alanı için
`skript/workspaceFiles` ve `skript/workspaceFileChanged` bildirimleri, `skript/addonStatus` (seçili addon'ların
veri durumu) ve `skript/migrationReport { from, to }` istekleri. Ayrıntılar ve diagnostic kodları:
`packages/language-server/README.md`, parser kodları: `packages/parser/NOTES.md`.

### Yanlış pozitif ölçümü

`packages/corpus` 79 gerçek dünya betiği içerir (lisansları `samples/SOURCES.json`). Vanilla betikler
gerçek Paper + Skript sunucusunda tek tek yüklenip sunucunun bildirdiği hatalar referans olarak saklanır;
statik tanılar bu referansla satır bazında karşılaştırılır:

```bash
npm run measure -w @skript-ide/corpus
```

Güncel sonuç (52 vanilla dosya): yanlış pozitif oranı Skript 2.17.1 için %3,45 (TP 84, FP 3), 2.12.2 için
%0 (TP 35, FP 0). Kalan 3 satır, sunucunun komutu tümden reddettiği için hiç ayrıştırmadığı satırlardır
(ayrıntı: `packages/corpus/README.md`).

Değişken analizi ayrıca ölçülür:

```bash
npm run measure-variables -w @skript-ide/corpus
```

Güncel sonuç: elle incelenen 16 yerel değişken bulgusunun 16'sı doğru (yanlış pozitif yok). İnceleme
`samples/variables-report.json` dosyasının `review` alanındadır. Genel değişken bulguları, betiklerin
eksik depoları nedeniyle ölçülmedi.

## Yol haritası

- [x] **Faz 1:** Editör iskeleti, Skript renklendirmesi, dosya aç/kaydet, gezgin
- [x] **Faz 2:** Gerçek doğrulama: arka planda Paper + Skript sunucusu, hataları Problemler paneline düşürme
- [x] **Faz 3:** Sürüme göre syntax veritabanı ve sürüm seçici
- [x] **Faz 4:** Parser + Language Server (statik hatalar, otomatik tamamlama, hover)
- [x] **Faz 5:** Addon desteği, değişken analizi, sürüm geçiş asistanı
