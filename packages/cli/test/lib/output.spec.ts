import { printJson, printTable } from '../../src/lib/output.js';

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

describe('printJson', () => {
  it('prints exactly one parseable JSON value, nothing else mixed in', () => {
    const output = captureStdout(() => printJson({ id: 'p1', name: 'Test' }));
    expect(() => JSON.parse(output)).not.toThrow();
    expect(JSON.parse(output)).toEqual({ id: 'p1', name: 'Test' });
  });

  it('produces output containing no ANSI color codes', () => {
    const output = captureStdout(() => printJson({ ok: true }));
    // eslint-disable-next-line no-control-regex
    expect(output).not.toMatch(/\x1b\[/);
  });
});

describe('printTable', () => {
  it('renders a header row and one row per item', () => {
    const output = captureStdout(() =>
      printTable(
        [
          { name: 'my-video-app', id: 'proj_123' },
          { name: 'chat-app', id: 'proj_456' },
        ],
        [
          { header: 'NAME', value: (r) => r.name },
          { header: 'ID', value: (r) => r.id },
        ],
      ),
    );

    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('NAME');
    expect(lines[0]).toContain('ID');
    expect(lines[1]).toContain('my-video-app');
    expect(lines[1]).toContain('proj_123');
    expect(lines[2]).toContain('chat-app');
  });

  it('renders just the header for an empty row set, without throwing', () => {
    const output = captureStdout(() => printTable([], [{ header: 'NAME', value: () => '' }]));
    expect(output.trim().split('\n')).toHaveLength(1);
  });
});
