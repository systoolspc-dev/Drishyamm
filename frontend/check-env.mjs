import { loadEnv } from 'vite';
const env = loadEnv('production', process.cwd(), '');
for (const k of Object.keys(env).filter(k => k.startsWith('VITE_')).sort()) {
  console.log(`${k}=${env[k]}`);
}
