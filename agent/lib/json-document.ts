export interface StoredDocument<T> {
  readonly value: T;
  readonly etag: string;
}

export class DocumentConflict extends Error {}

export interface DocumentStore<T> {
  read(): Promise<StoredDocument<T> | null>;
  write(value: T, expected: { etag: string } | "absent"): Promise<void>;
}

export interface DocumentChange<T, R> {
  readonly next: T;
  readonly result: R;
}

const maxAttempts = 6;

// `change` must be pure: a lost race re-reads the document and runs it again. Returning the value
// it was given skips the write.
export async function updateDocument<T, R>(
  store: DocumentStore<T>,
  empty: T,
  change: (current: T) => DocumentChange<T, R>,
): Promise<R> {
  for (let attempt = 1; ; attempt += 1) {
    const stored = await store.read();
    const current = stored?.value ?? empty;
    const { next, result } = change(current);
    if (next === current) return result;
    try {
      await store.write(next, stored ? { etag: stored.etag } : "absent");
      return result;
    } catch (error) {
      if (!(error instanceof DocumentConflict) || attempt === maxAttempts) throw error;
    }
  }
}

export async function readDocument<T>(store: DocumentStore<T>, empty: T): Promise<T> {
  return (await store.read())?.value ?? empty;
}

export function memoryDocumentStore<T>(): DocumentStore<T> & { value: T | undefined } {
  let version = 0;
  const store = {
    value: undefined as T | undefined,
    async read() {
      return store.value === undefined ? null : { value: store.value, etag: String(version) };
    },
    async write(value: T, expected: { etag: string } | "absent") {
      const matches = expected === "absent" ? store.value === undefined : expected.etag === String(version);
      if (!matches) throw new DocumentConflict("document changed underneath the write");
      store.value = value;
      version += 1;
    },
  };
  return store;
}
