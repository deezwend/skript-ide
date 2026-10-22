import { SKRIPT_LANGUAGE_ID } from '@skript-ide/skript-language'
import { api } from './api'
import { languageForPath, monaco } from './monaco'
import { basename, samePath } from './paths'

import { l } from '@skript-ide/i18n'
type Editor = monaco.editor.IStandaloneCodeEditor

export interface OpenDocument {
  id: number
  /** Kaydedilmemiş yeni dosyalarda null. */
  path: string | null
  untitledName: string
  model: monaco.editor.ITextModel
  viewState: monaco.editor.ICodeEditorViewState | null
  /** Son kayıttaki `alternativeVersionId`; geri alarak kayıtlı hale dönmek de "temiz" sayılır. */
  savedVersionId: number
  wasDirty: boolean
}

export class DocumentManager {
  private docs: OpenDocument[] = []
  private activeId: number | null = null
  private nextId = 1
  private untitledCounter = 0
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly editor: Editor,
    /** Arka planda oluşturulmuş bir model sahiplenilince çağrılır; taşıma onu artık dispose etmez. */
    private readonly onModelAdopted: (model: monaco.editor.ITextModel) => void = () => {}
  ) {}

  get documents(): readonly OpenDocument[] {
    return this.docs
  }

  get active(): OpenDocument | null {
    return this.docs.find((doc) => doc.id === this.activeId) ?? null
  }

  title(doc: OpenDocument): string {
    return doc.path ? basename(doc.path) : doc.untitledName
  }

  /** Doğrulama sonuçlarını belgeyle eşlemek için kimlik; kaydedilmemiş belgede yol yok. */
  sourceId(doc: OpenDocument): string {
    return doc.path ?? `untitled:${doc.id}`
  }

  findBySource(source: string): OpenDocument | undefined {
    return this.docs.find((doc) => this.sourceId(doc) === source)
  }

  isDirty(doc: OpenDocument): boolean {
    return doc.model.getAlternativeVersionId() !== doc.savedVersionId
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  newUntitled(content = ''): OpenDocument {
    this.untitledCounter += 1
    const model = monaco.editor.createModel(content, SKRIPT_LANGUAGE_ID)
    return this.add(null, l(`Adsız-${this.untitledCounter}.sk`, `Untitled-${this.untitledCounter}.sk`), model)
  }

  async open(path: string): Promise<OpenDocument> {
    const existing = this.docs.find((doc) => doc.path !== null && samePath(doc.path, path))
    if (existing) {
      this.activate(existing.id)
      return existing
    }
    const content = await api.readFile(path)
    const uri = monaco.Uri.file(path)
    // Tanıma gitme gibi işlemler arka planda model oluşturmuş olabilir; modeli yeniden yaratmak
    // yerine sahiplen (LSP eşitleyicisi didClose/didOpen çalkalaması yaşamasın).
    let model = findModelByUri(uri)
    if (model) {
      if (model.getValue() !== content) model.setValue(content)
      monaco.editor.setModelLanguage(model, languageForPath(path))
      this.onModelAdopted(model)
    } else {
      model = monaco.editor.createModel(content, languageForPath(path), uri)
    }
    return this.add(path, '', model)
  }

  activate(id: number): void {
    const next = this.docs.find((doc) => doc.id === id)
    if (!next) return
    const current = this.active
    if (current && current !== next) current.viewState = this.editor.saveViewState()
    this.activeId = id
    this.editor.setModel(next.model)
    if (next.viewState) this.editor.restoreViewState(next.viewState)
    this.editor.focus()
    this.emit()
  }

  /**
   * Diskte başka biri (örn. agent) değiştirdiği dosyanın yeni içeriğini sekmeye alır.
   * Değişiklik geri alınabilir; içerik diskle aynı olduğu için belge temiz sayılır.
   */
  replaceWithSaved(doc: OpenDocument, content: string): void {
    if (doc.model.getValue() === content) return
    doc.model.pushStackElement()
    doc.model.pushEditOperations(null, [{ range: doc.model.getFullModelRange(), text: content }], () => null)
    doc.model.pushStackElement()
    doc.savedVersionId = doc.model.getAlternativeVersionId()
    doc.wasDirty = false
    this.emit()
  }

  /** Kaydedildiyse true, kullanıcı vazgeçtiyse false döner. */
  async save(doc = this.active): Promise<boolean> {
    if (!doc) return false
    if (!doc.path) return this.saveAs(doc)
    await this.write(doc, doc.path)
    return true
  }

  async saveAs(doc = this.active): Promise<boolean> {
    if (!doc) return false
    const path = await api.saveFileDialog(doc.path ?? this.title(doc))
    if (!path) return false
    await this.write(doc, path)
    doc.path = path
    this.rebind(doc)
    this.emit()
    return true
  }

  /**
   * Modeli kaydedilen dosyanın URI'si ve diliyle yeniden oluşturur; dil sunucusu eski URI'yi
   * didClose ile bırakıp yenisini didOpen ile açar. Geri alma geçmişi yeniden başlar.
   */
  private rebind(doc: OpenDocument): void {
    const path = doc.path
    if (!path) return
    const language = languageForPath(path)
    const uri = monaco.Uri.file(path)
    const target = uri.toString(true).toLowerCase()
    const owned = this.docs.some(
      (candidate) => candidate !== doc && candidate.model.uri.toString(true).toLowerCase() === target
    )
    // URI'yi başka bir sekme tutuyorsa ikinci model yaratılamaz; eski davranış korunur
    if (owned) {
      monaco.editor.setModelLanguage(doc.model, language)
      return
    }

    const previous = doc.model
    const value = previous.getValue()
    const active = doc.id === this.activeId
    const viewState = active ? this.editor.saveViewState() : doc.viewState
    let model = findModelByUri(uri)
    if (model) {
      if (model.getValue() !== value) model.setValue(value)
      this.onModelAdopted(model)
    } else {
      model = monaco.editor.createModel(value, language, uri)
    }
    monaco.editor.setModelLanguage(model, language)

    doc.model = model
    doc.savedVersionId = model.getAlternativeVersionId()
    doc.wasDirty = false
    doc.viewState = viewState
    this.watch(doc)

    if (active) {
      this.editor.setModel(model)
      if (viewState) this.editor.restoreViewState(viewState)
    }
    if (previous !== model) previous.dispose()
  }

  close(id = this.activeId): void {
    const index = this.docs.findIndex((doc) => doc.id === id)
    if (index < 0) return
    const doc = this.docs[index]
    if (
      this.isDirty(doc) &&
      !window.confirm(
        l(
          `"${this.title(doc)}" dosyasındaki değişiklikler kaydedilmedi.\nKaydetmeden kapatılsın mı?`,
          `Changes to "${this.title(doc)}" have not been saved.\nClose without saving?`
        )
      )
    ) {
      return
    }

    this.docs.splice(index, 1)
    if (doc.id === this.activeId) {
      const neighbour = this.docs[Math.min(index, this.docs.length - 1)]
      if (neighbour) {
        this.activate(neighbour.id)
      } else {
        this.activeId = null
        this.editor.setModel(null)
      }
    }
    doc.model.dispose()
    this.emit()
  }

  private add(path: string | null, untitledName: string, model: monaco.editor.ITextModel): OpenDocument {
    const doc: OpenDocument = {
      id: this.nextId++,
      path,
      untitledName,
      model,
      viewState: null,
      savedVersionId: model.getAlternativeVersionId(),
      wasDirty: false
    }
    // Her tuşta değil, yalnızca "kaydedildi / değişti" durumu değişince bildir
    this.watch(doc)
    this.docs.push(doc)
    this.activate(doc.id)
    return doc
  }

  /** Kirli durum bildirimi için modelin içerik dinleyicisini bağlar. */
  private watch(doc: OpenDocument): void {
    doc.model.onDidChangeContent(() => {
      const dirty = this.isDirty(doc)
      if (dirty !== doc.wasDirty) {
        doc.wasDirty = dirty
        this.emit()
      }
    })
  }

  private async write(doc: OpenDocument, path: string): Promise<void> {
    await api.writeFile(path, doc.model.getValue())
    doc.savedVersionId = doc.model.getAlternativeVersionId()
    doc.wasDirty = false
    this.emit()
  }

  private emit(): void {
    api.setDirty(this.docs.some((doc) => this.isDirty(doc)))
    this.listeners.forEach((listener) => listener())
  }
}

/** Monaco URI'leri büyük/küçük harfe duyarlıdır; Windows yolları için küçük harfle arar. */
function findModelByUri(uri: monaco.Uri): monaco.editor.ITextModel | null {
  const target = uri.toString(true).toLowerCase()
  return monaco.editor.getModels().find((model) => model.uri.toString(true).toLowerCase() === target) ?? null
}
