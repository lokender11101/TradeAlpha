const { spawnSync } = require('child_process');
console.log("Running auth then distributed...");
const res = spawnSync('npx', ['jest', 'src/auth.e2e.test.ts', 'src/distributed.e2e.test.ts', '--runInBand'], { stdio: 'inherit', env: { ...process.env, LOG_LEVEL: 'debug' }});
console.log("Exit code:", res.status);
