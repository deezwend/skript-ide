# Corpus — gerçek dünya Skript betikleri ve sunucu referansı

Bu paket, Skript IDE'nin statik analizini (parser + language server) gerçek Skript betikleriyle
ölçmek için kullanılan test corpus'unu, gerçek Paper + Skript sunucusundan alınan referans
sonuçlarını (ground truth) ve ölçüm araçlarını içerir.

## Yapı

```
packages/corpus/
├─ samples/
│  ├─ vanilla/                 Yalnızca Skript çekirdeğiyle çalışan betikler
│  ├─ addons/                  SkBee, SkQuery, skript-reflect, Lusk vb. gerektiren betikler
│  ├─ SOURCES.json             Her dosyanın repo, yol, commit SHA, lisans ve addon bilgisi
│  ├─ ground-truth/<sürüm>.json  Gerçek sunucunun `sk reload` sonuçları
│  └─ report-<sürüm>.json      Statik diagnostics ile ground truth karşılaştırması
└─ tools/
   ├─ ground-truth.ts          Corpus'u gerçek sunucuda yükler, referans JSON üretir
   └─ measure.ts               Language server diagnostics'ini ground truth ile karşılaştırır
```

Corpus'ta 79 dosya vardır: **52 vanilla**, **27 addon**. Toplam **14.161 satır**.
En küçük dosyalar birkaç satır, en büyükleri 1000 satırın üzerindedir
(`addons/Plutoren--SnapMc/wilderness.sk` 2.379 satır, `vanilla/Plutoren--SnapMc/quests.sk` 1.676 satır).

## Kaynak ve lisans politikası

- Yalnızca **izin verici lisanslı** depolar kullanılır: MIT, Apache-2.0, CC0-1.0, Unlicense.
  Lisansı belirsiz (NOASSERTION) veya copyleft (GPL/AGPL) depolar corpus'a alınmaz.
- Her dosya GitHub'dan **commit SHA'sına sabitlenmiş** biçimde indirilir; içerik değiştirilmez.
  Satır sonları (CRLF/LF), BOM ve kodlama olduğu gibi korunur.
- Kaynak bilgisi dosya başına `samples/SOURCES.json` içinde tutulur: `source`, `sourcePath`,
  `commit`, `license`, `kind`, `addons`, `bytes`, `lines`, `sha256`.
- Addon gerektiren betikler `samples/addons/` altındadır ve hangi addon(lar)a ihtiyaç duydukları
  dosya kaydında belirtilir. Bu dosyalar gerçek sunucu ground-truth'una **dahil edilmez**;
  çünkü test sunucusunda addon jar'ları yoktur.
- Orijinal dosya adları (ör. Gamealition'daki `-easter.sk`, `!utilities.sk`) olduğu gibi korunur.
  Ground truth yüklerken bu adlar `gt_<sıra>_<ad>.sk` biçiminde güvenli bir sahne adına çevrilir;
  böylece Skript'in `-` ile başlayan dosyaları devre dışı sayması önlenir.

### Lisans dağılımı

| Lisans | Dosya |
|---|---|
| MIT | Gamealition, skript-reflect, Lusk, mtskr, FabricSK, Plutoren, Wikipedico, realjbtytm |
| Apache-2.0 | nerd-bear, Spiralyfox, CubeRhythm2, MINIGAMES.SK, mapletav |
| CC0-1.0 | SilverSK |
| Unlicense | pacskage, jungpaeng, BuggyAl |

## Ground truth üretimi

```bash
npx tsx packages/corpus/tools/ground-truth.ts --version 2.17.1
npx tsx packages/corpus/tools/ground-truth.ts --version 2.12.2
npx tsx packages/corpus/tools/ground-truth.ts --version 2.17.1 --version 2.12.2
```

Seçenekler:

| Seçenek | Açıklama |
|---|---|
| `--version <sürüm>` | Skript sürümü; birden çok kez verilebilir. Varsayılan 2.17.1. |
| `--root <klasör>` | Sunucu/önbellek kökü. Varsayılan: işletim sistemi geçici klasöründe `skript-corpus-server`. |
| `--java <java.exe>` | Sunucu için Java yolu. Verilmezse `runtime-validator` uygun Java'yı arar. |
| `--filter <metin>` | Yalnızca yolu bu metni içeren vanilla dosyaları doğrular. |
| `--verbose` | Sunucu durum değişikliklerini de yazdırır. |

Davranış:

- Her vanilla dosya **tek başına** yüklenir: `sk reload ide/<dosya>`. Bu, editörde tek dosya
  açma senaryosunu yansıtır. Bir sonraki dosyaya geçmeden önce `sk disable` ile betik kaldırılır;
  böylece dosyalar arası fonksiyon/komut çakışması olmaz.
- Tek dosya senaryosu nedeniyle başka dosyalarda tanımlı fonksiyonları çağıran betiklerde
  "function ... does not exist" hataları görülebilir. Bu, gerçek sunucuda tüm betikler birlikte
  yüklendiğinde ortaya çıkmayabilir; corpus bunu bilinçli olarak tek dosya bağlamında ölçer.
- Sunucu yalnızca `127.0.0.1` üzerinde ve çevrimdışı modda çalışır. Uygulamanın `userData`
  klasörüne yazılmaz; kök klasör geçicidir.
- EULA onayı yalnızca bu geçici test kökünde (`SkriptServer.acceptEula()`) programatik olarak
  verilir. Son kullanıcı akışına dokunulmaz.
- Daha önce indirilmiş Paper/Skript jar'ları `%APPDATA%` altındaki uygulama önbelleğinden
  geçici köke kopyalanır; önbellekte olmayan sürümler (ör. 2.12.2) indirilir.
- Çıktı: `samples/ground-truth/<skriptSürümü>.json`. Sunucu konsolu
  `<root>/ground-truth-<sürüm>.log` dosyasına yazılır.

Üretilen referans dosyası, her betik için 1 tabanlı satır numaralarıyla hata/uyarı listesi,
`ok` durumu ve süre bilgisini içerir. Hata/uyarı ayrımı Skript konsolundaki başlık renginden
yapılır (`runtime-validator` içindeki `SkriptLogParser`).

## Ölçüm

```bash
npx tsx packages/corpus/tools/measure.ts
npx tsx packages/corpus/tools/measure.ts --version 2.17.1
npm run typecheck -w @skript-ide/corpus
```

`measure.ts`, `@skript-ide/language-server` içindeki `SkriptLanguageService` sözleşmesini
(`faz4-sozlesme.md` §3) kullanır. Language server paketi henüz hazır değilse araç bunu
`report-<sürüm>.json` içine `languageServerAvailable: false` olarak yazar ve 2 koduyla çıkar.
Paket hazır olduğunda aynı komut yeniden çalıştırılabilir.

Karşılaştırma satır bazlıdır:

- **Gerçek pozitif (TP):** Statik diagnostic'in olduğu satırda sunucu da hata/uyarı bildirmiş.
- **Yanlış pozitif (FP):** Statik diagnostic var, sunucu o satırda hata/uyarı bildirmemiş.
- **Yanlış negatif (FN):** Sunucu hata/uyarı bildirmiş, statik diagnostic yok.
- **Yanlış pozitif oranı:** `FP / (TP + FP)`.
- `byCode` ve `topFalsePositiveCodes`, statik diagnostic `code` değerlerine göre kırılım verir.
- Önem derecesi uyuşmazlıkları (ör. statik "warning", sunucu "error") ayrıca sayılır; satır
  eşleşmesi bozulmadığı için TP/FP sınıflandırmasını değiştirmez.

Konsol özeti her sürüm için dosya sayısı, TP/FP/FN, yanlış pozitif oranı ve en sık FP kodlarını
yazdırır; ayrıntılı dosya/satır dökümü `samples/report-<sürüm>.json` içindedir.

## Mevcut ölçüm (2026-10-22)

| Sürüm | Sunucu | Dosya | Statik diag. | Sunucu diag. | TP | FP | FN | FP oranı |
|---|---|---|---|---|---|---|---|---|
| 2.17.1 | Paper 26.3 #211, Java 25 | 52 | 88 | 231 | 84 | 3 | 138 | %3,45 |
| 2.12.2 | Paper 1.21.8 #60, Java 21 | 52 | 36 | 140 | 35 | 0 | 103 | %0,00 |

`unknown-syntax` (hiçbir syntax'a uymayan satır) her iki sürümde 18 TP, 0 FP getirdi. Addon corpus'unda
(27 dosya, 8.483 satır, addon seçilmeden) 23 satır işaretlenir; bunlar verisi olmayan addon'lar (skGUI)
ya da başka dosyada tanımlı skript-reflect syntax'ıdır.

Ground truth toplamları: 2.17.1 için 195 hata + 36 uyarı, 2.12.2 için 136 hata + 4 uyarı.

İlk ölçümde FP oranı 2.17.1 için %27,5, 2.12.2 için %56,4 idi. Giderilen kaynaklar:

- **Girinti zinciri** (`keyall_command.sk`): Skript girintisi hatalı satırı raporlayıp atlar ve açık
  blokları değiştirmez. Parser önceden blok yığınını kapatıp sonraki geçerli satırları da
  `indent-inconsistent` + `invalid-command-line` ile işaretliyordu; artık yalnızca hatalı satır tanılanır.
- **Yalnızca yorum içeren `trigger:`** (`-template.sk`): Skript bu durumda uyarmaz (olay için uyarır);
  `empty-section` buna göre ayarlandı.
- **Tekrarlanan komut girdisi** (`plotgen.sk`, iki `permission:`): yeni `parse/duplicate-command-entry`
  hatası sunucunun "Unexpected entry" hatasıyla eşleşir (TP).

Kalan 3 FP satırı (`plotgen.sk` 143/147/148, `version-syntax`) gerçek bir yanlış pozitif değildir:
sunucu, tekrarlanan girdi yüzünden komutun tamamını reddettiği için `trigger` gövdesini hiç
ayrıştırmaz. Aynı `console command "..."` satırları başka dosyalarda 2.17.1 sunucusunda
"Can't understand this condition/effect" hatası verir ve orada TP sayılır.

Önem derecesi uyuşmazlığı 2.17.1'de 49, 2.12.2'de 0'dır; bunların tamamı statik "warning" /
sunucu "error" farkıdır ve satır eşleşmesini değiştirmez.

## Sınırlamalar

- Addon betikleri gerçek sunucuda çalıştırılmaz; yalnızca statik analiz için corpus'ta tutulur.
- Eski Skript sürümleri için yazılmış gerçek betiklerde kaldırılmış sözdizimi nedeniyle çok sayıda
  gerçek hata bulunur. Bu hatalar ground truth'un parçasıdır; corpus'un amacı yalnızca "temiz"
  betiklerden oluşmak değil, gerçek dünyadaki çeşitliliği ölçmektir.
- Corpus dosyaları üçüncü taraflara aittir ve kendi lisanslarıyla kullanılır; ayrıntı ve atıf için
  `samples/SOURCES.json` dosyasına bakın.
