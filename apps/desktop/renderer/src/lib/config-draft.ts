import type { RepoConfig, ServiceFile } from "../../../../../lib/config.ts";
import type { ConfigDocument, RepoConfigDocument } from "../../../../../lib/config-file.ts";
import type { HostDesktopApi } from "../../../shared.ts";

type RepoDocuments = Record<string, RepoConfigDocument & { root: string }>;
type RepoEdit = { adoptedRevision: string; value: RepoConfig };

/** Form state belongs to a host, so navigation preserves drafts and pending saves. */
export class ConfigDraftController {
  document: ConfigDocument | null = null;
  adopted: ConfigDocument | null = null;
  draft: ServiceFile | null = null;
  dirty = false;
  saving = false;
  repoDocuments: RepoDocuments = {};
  repoDrafts: Record<string, RepoEdit> = {};

  constructor(
    private api: HostDesktopApi,
    private changed: () => void,
    private saved: (document: ConfigDocument) => void,
    private repoSaved: (id: string, document: RepoConfigDocument) => void,
  ) {}

  get anyDirty() { return this.dirty || Object.keys(this.repoDrafts).length > 0; }
  get externalChange() {
    return this.dirty && this.document?.revision !== this.adopted?.revision ? this.document : null;
  }
  get repoExternalChange() {
    return Object.entries(this.repoDrafts).some(([id, edit]) =>
      this.repoDocuments[id] && this.repoDocuments[id]!.revision !== edit.adoptedRevision);
  }

  receive(document: ConfigDocument) {
    if (this.document === document) return;
    this.document = document;
    if (!this.dirty) this.adopt(document);
    this.changed();
  }

  receiveRepos(documents: RepoDocuments) {
    if (this.repoDocuments === documents) return;
    this.repoDocuments = documents;
    this.changed();
  }

  private adopt(document: ConfigDocument) {
    this.adopted = document;
    this.draft = document.valid ? structuredClone(document.value) : null;
    this.dirty = false;
  }

  mutate = (change: (draft: ServiceFile) => void) => {
    if (!this.draft) return;
    const next = structuredClone(this.draft);
    change(next);
    this.draft = next;
    this.dirty = true;
    this.changed();
  };

  repoConfig = (id: string) => {
    const document = this.repoDocuments[id];
    return {
      config: this.repoDrafts[id]?.value ?? (document?.valid ? document.value : null),
      error: document && !document.valid ? document.error : null,
      path: document?.path ?? null,
      mutate: (change: (value: RepoConfig) => void) => {
        const current = this.repoDrafts[id];
        const source = this.repoDocuments[id];
        const base = current?.value ?? (source?.valid ? source.value : null);
        if (!base || !source) return;
        const next = structuredClone(base);
        change(next);
        this.repoDrafts = { ...this.repoDrafts, [id]: { adoptedRevision: current?.adoptedRevision ?? source.revision, value: next } };
        this.changed();
      },
    };
  };

  save = async () => {
    if (!this.draft || !this.adopted || this.saving) return;
    this.saving = true;
    this.changed();
    try {
      if (this.dirty) {
        const submitted = this.draft;
        const saved = await this.api.config.save({ expectedRevision: this.adopted.revision, value: submitted });
        this.document = saved;
        this.adopted = saved;
        // An edit made while saving is still an unsaved edit on this same host.
        if (this.draft === submitted) this.adopt(saved);
        this.saved(saved);
      }
      for (const [id, edit] of Object.entries(this.repoDrafts)) {
        const saved = await this.api.repoConfigs.save({ id, expectedRevision: edit.adoptedRevision, value: edit.value });
        this.repoDocuments = { ...this.repoDocuments, [id]: { ...saved, root: this.repoDocuments[id]?.root ?? "" } };
        if (this.repoDrafts[id] === edit) {
          const remaining = { ...this.repoDrafts };
          delete remaining[id];
          this.repoDrafts = remaining;
        } else if (this.repoDrafts[id]) {
          this.repoDrafts = { ...this.repoDrafts, [id]: { ...this.repoDrafts[id]!, adoptedRevision: saved.revision } };
        }
        this.repoSaved(id, saved);
      }
    } finally {
      this.saving = false;
      this.changed();
    }
  };

  commit = async (change: (draft: ServiceFile) => void) => {
    const pending = this.anyDirty;
    this.mutate(change);
    if (!pending) await this.save();
  };

  revert = () => {
    if (this.saving) return;
    this.repoDrafts = {};
    if (this.document) this.adopt(this.document);
    this.changed();
  };
}
