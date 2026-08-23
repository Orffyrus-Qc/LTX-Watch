import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**', '.vinext/**', 'dist/**', 'out/**', 'build/**',
    'installer/.build/**', 'installer/.tools/**', 'release/**', 'next-env.d.ts',
  ]),
]);

export default eslintConfig;
