import { createRestoreV2Handler } from './handler.mjs';
import { createRestoreV2Runtime } from './runtime.mjs';

const handler = createRestoreV2Handler(createRestoreV2Runtime());

Deno.serve(handler);
