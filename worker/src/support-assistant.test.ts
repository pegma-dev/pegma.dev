import { createMemoryStore } from '@pegma/storage-core';
import { registerSupportAssistantCases } from './support-assistant-fixtures';

registerSupportAssistantCases(
  'published SDK MemoryStore regressions',
  async () => ({
    store: createMemoryStore(),
  }),
);
