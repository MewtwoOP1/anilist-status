// Hosting-friendly launcher for Node 20+ hosts that only allow a start-file setting.
// It registers tsx so the TypeScript application can run without a separate build command.
import { register } from 'node:module';

register('tsx/esm', import.meta.url);
await import('./index.ts');
