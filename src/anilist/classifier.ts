import type { GraphQLErrorShape, HealthStatus } from './types.js';

const DEPRECATION_MARKERS = [
  'deprecated',
  'no longer supported',
  'removed from the schema',
  'field has been removed',
  'operation has been removed'
];

function explicitDeprecation(error: GraphQLErrorShape): boolean {
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  const extensions = error.extensions && typeof error.extensions === 'object' ? error.extensions as Record<string, unknown> : {};
  const code = typeof extensions.code === 'string' ? extensions.code.toLowerCase() : '';
  const category = typeof extensions.category === 'string' ? extensions.category.toLowerCase() : '';
  if (code.includes('deprecated') || category.includes('deprecated')) return true;
  return DEPRECATION_MARKERS.some(marker => message.includes(marker));
}

export function classifyGraphQLErrors(errors: GraphQLErrorShape[]): { status: HealthStatus; error: string } {
  const messages = errors.map(error => typeof error.message === 'string' ? error.message : 'Unknown GraphQL error').filter(Boolean);
  const sanitized = messages.join('; ').slice(0, 1000) || 'GraphQL request failed.';
  return { status: errors.some(explicitDeprecation) ? 'DEPRECATED' : 'API_ERROR', error: sanitized };
}
