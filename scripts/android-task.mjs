import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.argv[2];
if (mode !== 'build' && mode !== 'run') throw new Error('사용법: android-task.mjs build|run');

const javaHomes = [
  process.env.MV_ANDROID_JAVA_HOME,
  '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
  '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
].filter(Boolean);
const sdkHomes = [
  process.env.MV_ANDROID_SDK_HOME,
  '/opt/homebrew/share/android-commandlinetools',
  '/usr/local/share/android-commandlinetools',
].filter(Boolean);
const javaHome = javaHomes.find(existsSync);
const sdkHome = sdkHomes.find(existsSync);

if (!javaHome) throw new Error('JDK 21 없음: brew install openjdk@21');
if (!sdkHome) throw new Error('Android SDK 없음: brew install --cask android-commandlinetools');

const command = mode === 'build' ? './gradlew' : 'npx';
const args = mode === 'build' ? ['assembleDebug'] : ['cap', 'run', 'android'];
const cwd = mode === 'build' ? new URL('../android/', import.meta.url) : new URL('../', import.meta.url);
const child = spawn(command, args, {
  cwd,
  stdio: 'inherit',
  env: {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: sdkHome,
    ANDROID_SDK_ROOT: sdkHome,
    PATH: `${sdkHome}/platform-tools:${process.env.PATH || ''}`,
  },
});

child.on('error', (err) => {
  throw err;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
