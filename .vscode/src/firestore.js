export async function createFirestoreNotesStore(config, options = {}) {
  const enabled = Boolean(options.enabled && config?.apiKey);

  return {
    enabled,
    async saveNote() {},
    async deleteNote() {},
    subscribe() {
      return () => {};
    }
  };
}
