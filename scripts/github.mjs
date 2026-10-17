import { spawnSync } from 'node:child_process';
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  if (r.status) process.exit(r.status);
};
const name = process.argv[2] || 'looma-crm';
if (!/^[a-zA-Z0-9_.-]+$/.test(name))
  throw new Error('Repository name must not contain a URL or shell characters');
run('git', ['status', '--short']);
run('gh', ['auth', 'status']);
run('gh', [
  'repo',
  'create',
  name,
  '--private',
  '--source=.',
  '--remote=origin',
  '--push',
  '--description',
  'LOOMA.CRM — мебельное производство, React + TypeScript + Node.js + PostgreSQL',
]);
