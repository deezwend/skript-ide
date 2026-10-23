<div align="center">

<img src="packages/desktop/resources/icon.png" width="96" alt="Skript IDE" />

# Skript IDE

**A desktop IDE for Minecraft [Skript](https://github.com/SkriptLang/Skript) — validated against a real Paper server.**
**Minecraft [Skript](https://github.com/SkriptLang/Skript) için masaüstü geliştirme ortamı — gerçek bir Paper sunucusuyla doğrulanır.**

[![Release](https://img.shields.io/github/v/release/deezwend/skript-ide?include_prereleases&label=release)](https://github.com/deezwend/skript-ide/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-blue)](https://github.com/deezwend/skript-ide/releases/latest)
[![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](#-english) · [Türkçe](#-türkçe)

</div>

---

## 🇬🇧 English

### Download

Grab **`Skript-IDE-Setup-<version>.exe`** from the [latest release](https://github.com/deezwend/skript-ide/releases/latest) and run it.

> The installer is not code-signed yet, so Windows SmartScreen may warn you. Click **More info → Run anyway**.

**Requirements:** Windows 10/11 x64. For live server validation you also need Java — **Java 25** for Skript 2.16+ (Paper 26.x) or **Java 21** for Skript 2.12–2.14 (Paper 1.21.x).

### Features

- **Real server validation** — on save or with **Validate (F5)**, your script is loaded with `sk reload` on a headless Paper + Skript server running in the background (offline mode, `127.0.0.1` only). Skript's own errors and warnings show up in the **Problems** panel and as squiggles in the editor.
- **Language server** — instant static diagnostics while you type: indentation, unclosed `"` / `{` / `%`, undefined functions and `{@options}`, unknown syntax, and syntax that doesn't exist in your selected Skript version.
- **Completion, hover, go to definition (F12), references (Shift+F12), rename (F2)** for syntax, functions, options and variables.
- **Variable analysis** — never-set / never-read variables, likely typos with a *"did you mean?"* quick fix.
- **Version picker** — switch between Skript **2.17.1, 2.16.2, 2.14.3 and 2.12.2**; the validation server, syntax data and diagnostics follow the selected version.
- **Addon support** — SkBee and skript-reflect, with compatibility tested on a real server (✓ / ◐ / ✕) and checksum-verified downloads.
- **Syntax Browser** — search every event, condition, effect, expression, section, structure, type and function of the selected version.
- **Version Migration Assistant** — lists removed, changed and new syntax between two versions and applies known rewrites automatically.
- **AI assistant** — a chat panel beside the editor that writes and fixes Skript code, checks it with the language server and the real server, and can run tests. Works with Anthropic, ChatGPT (Codex) and any OpenAI-compatible API. Pick a mode: **quick**, **standard** or **thorough**. Conversations are kept and can be referenced later, short memory notes are stored per user and per project (`.skript-ide/memory.md`), and larger jobs can be handed to a sub-agent.
- **Automatic updates** — new releases are checked for in the background and can be installed from inside the app.
- **Turkish & English UI** — chosen from the system language, switchable under **View → Language**.

### Supported versions

| Skript | Paper (validation) | Java | Minecraft |
|---|---|---|---|
| 2.17.1 | 26.3 | 25 | 1.21.5 – 26.3 |
| 2.16.2 | 26.2 | 25 | 1.21.4 – 26.2 |
| 2.14.3 | 1.21.11 | 21 | 1.21.0 – 1.21.11 |
| 2.12.2 | 1.21.8 | 21 | 1.19.4 – 1.21.8 |

On first validation the app asks you to accept the Minecraft EULA, then downloads Paper and Skript once and caches them.

### Build from source

```bash
npm install        # also downloads the Electron binary
npm run dev        # run in development mode
npm test           # unit tests for all packages
npm run dist       # build the Windows installer → packages/desktop/dist/
```

Requires Node.js 22+. Detailed architecture and developer notes (in Turkish): [docs/DEVELOPMENT.tr.md](docs/DEVELOPMENT.tr.md).

---

## 🇹🇷 Türkçe

### İndirme

[Son sürümden](https://github.com/deezwend/skript-ide/releases/latest) **`Skript-IDE-Setup-<sürüm>.exe`** dosyasını indirip çalıştırın.

> Kurulum dosyası henüz kod imzalı değil; Windows SmartScreen uyarı verebilir. **Ek bilgi → Yine de çalıştır** ile devam edebilirsiniz.

**Gereksinimler:** Windows 10/11 x64. Gerçek sunucu doğrulaması için Java gerekir — Skript 2.16+ (Paper 26.x) için **Java 25**, Skript 2.12–2.14 (Paper 1.21.x) için **Java 21**.

### Özellikler

- **Gerçek sunucuyla doğrulama** — kaydettiğinizde ya da **Doğrula (F5)** ile betik, arka planda çalışan headless bir Paper + Skript sunucusunda (çevrimdışı mod, yalnızca `127.0.0.1`) `sk reload` ile yüklenir. Skript'in kendi hata ve uyarıları **Problemler** panelinde ve editörde dalgalı çizgi olarak görünür.
- **Dil sunucusu (LSP)** — yazarken anında statik tanılar: girinti hataları, kapanmamış `"` / `{` / `%`, tanımsız fonksiyon ve `{@option}`, tanınmayan syntax ve seçili Skript sürümünde bulunmayan syntax.
- **Tamamlama, hover, tanıma git (F12), referanslar (Shift+F12), yeniden adlandır (F2)** — syntax, fonksiyon, option ve değişkenler için.
- **Değişken analizi** — hiç yazılmayan / okunmayan değişkenler, olası yazım hataları için *"şunu mu demek istedin?"* hızlı düzeltmesi.
- **Sürüm seçici** — Skript **2.17.1, 2.16.2, 2.14.3 ve 2.12.2** arasında geçiş; doğrulama sunucusu, syntax verisi ve tanılar seçili sürümü izler.
- **Addon desteği** — SkBee ve skript-reflect; uyumluluk gerçek sunucuda denendi (✓ / ◐ / ✕), indirmeler checksum ile doğrulanır.
- **Syntax Tarayıcısı** — seçili sürümdeki tüm olay, koşul, efekt, ifade, bölüm, yapı, tür ve fonksiyonlarda arama.
- **Sürüm Geçiş Asistanı** — iki sürüm arasında kaldırılan, değişen ve yeni syntax'ları listeler; bilinen yeniden yazımları otomatik uygular.
- **Yapay zekâ asistanı** — editörün yanındaki sohbet panelinde Skript kodu yazılır ve düzeltilir; dil sunucusu ve gerçek sunucu ile denetlenir, testler çalıştırılabilir. Anthropic, ChatGPT (Codex) ve OpenAI uyumlu her API ile çalışır. **Hızlı**, **standart** ve **derinlemesine** modlar arasından seçim yapılır. Konuşmalar saklanıp sonradan başvurulabilir; kısa hafıza notları kullanıcı ve proje bazında tutulur (`.skript-ide/memory.md`), büyük işler bir alt agent'a devredilebilir.
- **Otomatik güncelleme** — yeni sürümler arka planda denetlenir ve uygulama içinden kurulabilir.
- **Türkçe ve İngilizce arayüz** — sistem diline göre seçilir, **Görünüm → Dil** menüsünden değiştirilebilir.

### Desteklenen sürümler

| Skript | Paper (doğrulama) | Java | Minecraft |
|---|---|---|---|
| 2.17.1 | 26.3 | 25 | 1.21.5 – 26.3 |
| 2.16.2 | 26.2 | 25 | 1.21.4 – 26.2 |
| 2.14.3 | 1.21.11 | 21 | 1.21.0 – 1.21.11 |
| 2.12.2 | 1.21.8 | 21 | 1.19.4 – 1.21.8 |

İlk doğrulamada uygulama Minecraft EULA'sını onayınıza sunar; ardından Paper ve Skript bir kez indirilip önbelleğe alınır.

### Kaynaktan derleme

```bash
npm install        # Electron ikili dosyasını da indirir
npm run dev        # geliştirme modunda çalıştırır
npm test           # tüm paketlerin birim testleri
npm run dist       # Windows kurulum dosyasını üretir → packages/desktop/dist/
```

Node.js 22+ gerekir. Ayrıntılı mimari ve geliştirici notları: [docs/DEVELOPMENT.tr.md](docs/DEVELOPMENT.tr.md).

---

## Project structure / Proje yapısı

```
packages/
├─ agent/              AI assistant: providers, tools, memory, conversations, sub-agents
├─ desktop/            Electron app (Monaco editor, panels, server lifecycle, updater)
├─ language-server/    Editor-agnostic Skript LSP (Web Worker + Node/stdio)
├─ parser/             Error-tolerant, indentation-based Skript parser
├─ pattern-compiler/   Compiles & matches Skript syntax patterns
├─ syntax-db/          Per-version Skript + addon syntax database
├─ runtime-validator/  Paper/Skript download, Java discovery, server management
├─ skript-language/    Monaco tokenizer, indentation rules, theme
├─ i18n/               Turkish / English strings
└─ corpus/             Real-world .sk samples & false-positive measurement
```

<div align="center">
<sub>Skript IDE is not affiliated with SkriptLang, PaperMC or Mojang. · Skript IDE; SkriptLang, PaperMC veya Mojang ile bağlantılı değildir.</sub>
</div>
