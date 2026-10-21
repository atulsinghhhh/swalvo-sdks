import { spawn } from 'node:child_process';

/** Runs a command with stdio inherited straight to the terminal. Swallowing a real install's output helps nobody. */
export function runCommand(command: string, args: string[], cwd: string = process.cwd()): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}
