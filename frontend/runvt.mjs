import { startVitest } from 'vitest/node';
const v = await startVitest('test', ['src/test/trivial.test.ts'], { run: true, watch:false, config: '/tmp/vt.config.ts' });
await v?.close();
process.exit(0);
