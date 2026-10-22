# pattern-compiler — doğrulama notları

## Kaynak

Skript sözdizimi tahmin edilmedi; **SkriptLang/Skript `2.17.1`** etiketi (commit
`19172ca06e798dea53d97b647167e6ebe7f5fe94`) üzerinden doğrulandı. Geçici klasöre indirilen
dosyalar repoya konmadı:

- `ch/njol/skript/patterns/`: `PatternCompiler`, `SkriptPattern`, `PatternElement`,
  `LiteralPatternElement`, `ChoicePatternElement`, `OptionalPatternElement`, `GroupPatternElement`,
  `TypePatternElement`, `RegexPatternElement`, `ParseTagPatternElement`, `MatchResult`
- `ch/njol/skript/lang/SkriptParser` (`nextBracket`, `next`, `nextOccurrence`, `ALL_FLAGS`)
- `ch/njol/skript/doc/Documentation` (`cleanPatterns`) ve `doc/JSONGenerator` (`cleanPatterns`)
- Yardımcı: `util/Patterns`, `conditions/CondCompare`, `src/test/java/ch/njol/skript/patterns/PatternCompilerTest`

## Önemli bulgular

- **Eşleştirme**: girdi `trim()` edilir; literal karşılaştırması İngilizce küçük harfe çevrilerek
  yapılır. `LiteralPatternElement` boşlukları özel işler: pattern'deki tek boşluk, girdide bir
  boşluk tüketir; girdideki ekstra boşluklar veya pattern'in başındaki/sonundaki boşluklar atlanır.
  Bu davranış birebir uygulandı.
- **Seçim**: `a|b c` seçenekleri `a` ve `b c`'dir (seçim tüm üst düzey kuyruğu kapsar), soldan sağa
  denenir. Opsiyonel içindeki seçim `[(a|b)]` gibi davranır.
- **Parse mark**: `1¦` biçimi `mark ^= 1` (XOR). `tag:` biçimi hem tag listesine ekler hem de sayısal
  tag ise mark olarak yorumlanır. Tag'ler eşleşme sırasında eklenir. Boş tag (`:x`) Skript'te bir
  sonraki literalden türetilir; `(a|:b)` → `(a|b:b)`.
- **Yer tutucu bayrakları**: `-`, `*`, `~` herhangi bir sırada; sonra `@zaman` ayrılır; türler `/` ile
  bölünür. `-` = nullable, `*` = yalnızca literal, `~` = literal ayrıştırmayı kapat (ifade).
- **Regex**: `<...>` Java `Pattern.matches` gibi tüm alt metne uygulanır.
- **Doküman biçimi**: `Documentation.cleanPatterns` parse mark'ları (`(?<=[(|])[-0-9]+?¦`), tag'leri,
  `@zaman` eklerini ve nullable `-` bayrağını siler; `(|x)` / `(x|)` seçimlerini `[x]`'e çevirir.
  Veritabanındaki pattern'ler bu temizlenmiş biçimdedir; ham biçim de desteklenir.
- **Veri kaynaklı iki bozukluk** (toleranslı derleme bunları kabul eder):
  1. `CondCompare`'in `<` / `<=` karşılaştırma seçeneklerinde kaçış (`\<`) doküman çıktısında
     kaybolmuştur. Toleranslı modda kapanmamış `<` literal sayılır. Dört veritabanında da yalnızca
     bu iki pattern etkilenir.
  2. `string` türünün kullanım metnindeki `%%` boş yer tutucu gibi görünür; toleranslı modda `%`
     literalı sayılır.
  Bu iki istisna dışında 4 veritabanındaki **9897 pattern'in tamamı** hatasız derlenir.
- Tür ve fonksiyon kayıtlarındaki `patterns` gerçek eşleşme pattern'i değil, kullanım/imza metnidir
  (`named []`, `itemstack "<alias>..."`, `abs(n: number)`). Yine de sözdizimi hatası raporlamak için
  derlenirler.

## API

Sözleşmedeki adların tamamı aynen export edilir. Ekler:

- `CompileOptions` (`tolerant`), `PatternCompileError`
- `CompiledPattern.placeholderCount`
- AST düğüm arayüzleri (`SequenceNode`, `LiteralNode`, `OptionalNode`, `GroupNode`, `ChoiceNode`,
  `PlaceholderNode`, `RegexNode`, `ParseTagNode`)
- `matchWithBudget`, `createMatchBudget`, `MatchBudget` (SyntaxMatcher'ın paylaşılan adım bütçesi)
- `SyntaxMatcher.matchWithStatus` / `matchEventWithStatus` ve `SyntaxMatchResult`: eşleşmelerle birlikte
  `complete` (bütçe tükenmeden bitti mi). Boş sonuç yalnızca `complete` ise "hiçbir syntax'a uymuyor" demektir.
- `%~tip%` yapısal kabulünde olay/döngü değerleri (`event-block`, `loop-value`) de değiştirilebilir sayılır.

Sözleşmeden tek yapısal sapma: `matchExpression` bir literal tanıdığında `SyntaxMatch.entry` için
`literal:<kategori>` kimlikli **sentetik bir `SyntaxEntry`** üretir (`literal:number`,
`literal:variable`, `literal:function-call`, ...). Sözleşme `entry: SyntaxEntry` istediği için
kaçınılmazdı; sentetik kayıtlar `kind: 'expression'`, boş `patterns` ve Türkçe ad taşır.

## Eşleştirme güveni

- Önce yapısal (ucuz) eşleşme bulunur, sonra yer tutucuların içi doğrulanır. Tümü doğrulanırsa
  `exact`, en az biri doğrulanamazsa `structural`.
- Literal tanıma: sayı, tırnaklı metin (`""` kaçışı ve `%...%` içeriği), değişken, `{@option}`,
  true/false, zaman aralığı (`5 seconds`, `1 minute and 3 seconds`), saat (`6:00`, `7am`),
  `arg-1`, `event-player`, `loop-value`, `isim(...)`, parantezli ifade, üst düzey `and`/`or`/virgül
  listeleri, tek kelimelik literal.
- `[the] [event-]<.+>` gibi zorunlu literal içermeyen ve her metni yakalayan ifade pattern'leri
  (ör. `ExprEntity`) hiçbir zaman `exact` sayılmaz; eşleşirlerse `structural` olur.
- Tür uyumluluğu (ör. `%players%` yerine sayı konması) kontrol edilmez; bu bilinçli bir sınırdır.

## Performans

Ölçüm: Windows, Node 24.19.0, `tsx`; 5 çalıştırmanın medyanı.

| Sürüm | `new SyntaxMatcher(db.entries)` (5 çalıştırma medyanı) | Tipik satır (önbelleksiz) |
|---|---|---|
| 2.17.1 (1213 kayıt, 2703 pattern) | 53.6–72.7 ms (min 45.3) | 0.19–3.96 ms |
| 2.16.2 (1200 kayıt, 2660 pattern) | 44.7–51.7 ms (min 32.0) | 0.20–2.77 ms |
| 2.14.3 (1162 kayıt, 2553 pattern) | 33.5–39.4 ms (min 27.0) | 0.19–2.46 ms |
| 2.12.2 (1069 kayıt, 1981 pattern) | 40.1–40.3 ms (min 27.4) | 0.20–2.02 ms |

Aralıklar iki ayrı ölçüm turundan; en yavaş tipik örnek `player has permission "a"`
(2.17.1'de ~4 ms). Diğer tipik satırlar ~0.2–2 ms.
Aynı matcher'da önbellekli çağrılar ~0.2 ms. `maxSteps` (varsayılan 20 000) patolojik girdide
donmayı engeller; testte 500 adım bütçesiyle 6 yer tutuculu pattern saniyeler değil milisaniyeler
içinde `null` döner.

## Örnek eşleşme oranı

Ölçüm: her kaydın `examples` alanındaki **tek satırlık** örnekler; yorumlar ve `:`/`if ` önekleri
temizlendi; girintili satırlar (2.12.2'de kod blokları satır satır düzleştirilmiş) hariç tutuldu.
"Kendi kaydı" = eşleşmeler arasında o kaydın `kind`+`id`'si var.

| Sürüm | Kendi kaydı | Oran | Başka kayıt | Başka tür | Eşleşmeyen |
|---|---|---|---|---|---|
| 2.17.1 | 564/1102 | %51.2 | 532 | 5 | 1 |
| 2.16.2 | 567/1099 | %51.6 | 526 | 5 | 1 |
| 2.14.3 | 571/1086 | %52.6 | 509 | 5 | 1 |
| 2.12.2 | 790/1658 | %47.6 | 745 | 122 | 1 |

2.17.1 için tür bazında: event %95.1, effect %96.6, section %88.9, structure %100,
condition %83.7, expression %21.1.

Kalanların kategorileri:

- **Başka kayıt (other-entry)**: Çoğunlukla gerçek sözdizimi belirsizliği. Ör.
  `tool of the player is enchanted with efficiency 2`, genel `CondCompare` pattern'ine de uyar;
  ayrıca `%inventories% (has|have) %item types%` gibi geniş pattern'ler özel koşulları gölgeler.
- **Başka tür (other-syntax)**: Örnek kendi kaydının sözdizimi değil, başka bir syntax'ın satırıdır
  (özellikle 2.12.2'de koşul örneklerinin effect gibi görünmesi). Eşleşmeyen değil, "başka kayda ait".
- **Eşleşmeyen**: Dört sürümde de yalnızca `EffRegisterTag`'in uzun açıklama biçimli örneği
  (`register a new custom entity tag named "fish" using ...`) 1 adet.
- **Expression örnekleri**: Kendi kaydıyla düşük oran gerçek bir hata değil; bu alandaki örneklerin
  çoğu ifadenin kendisi değil, kullanıldığı statement (`set {_x} to ...`, `send ...`). Örneği tek
  başına ifade olarak eşleştirmek başka bir expression kaydına (veya `structural` bir genel kayda)
  düşer. Bu yüzden expression satırı tabloda bilgi amaçlıdır.

## Bilinen sınırlamalar

- Tam Skript ayrıştırıcısı değildir: tür uyumluluğu ve addon ifadeleri doğrulanmaz; emin
  olunamayan yer tutucular `structural` döner.
- Eşleşme sırasında ilk uygun (en kısa) yer tutucu bölünmesi seçilir. Başka bir bölünme `exact`
  olabilecekken sonuç `structural` kalabilir; muhafazakâr yönde hata yapılır.
- `ExprEntity` gibi genel pattern'ler yapısal kabul edilir; addon ortamında gerçek event değerleri
  için daha fazla bağlam gerekir.
- Java regex ile JavaScript `RegExp` arasındaki farklar: veritabanındaki 14 farklı regex'in tamamı
  Node 24'te geçerli; `\Q...\E` gibi Java'ya özgü yapılar desteklenmez.
- Parse tag sözdizimi Skript'teki gerçek biçimdir (önek `tag:` ve boş tag çıkarımı). `(a|b):tag`
  yazımı Skript'te "sonraki literal `tag`" anlamına gelir; ayrı bir "grup sonrası tag" biçimi yoktur.
- Yalnızca İngilizce pattern'ler hedeflenir; Türkçe yerelleştirilmiş Skript sözdizimi kapsam dışıdır.
