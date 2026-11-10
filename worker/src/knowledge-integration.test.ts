import { createMemoryStore } from '@pegma/storage-core';
import { registerKnowledgeIntegrationScenarios } from './knowledge-integration-scenarios';

registerKnowledgeIntegrationScenarios({
  name: 'released Agent Access and KB host integration over Memory Store',
  createStore: createMemoryStore,
});
