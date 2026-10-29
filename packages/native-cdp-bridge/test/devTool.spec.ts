import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE } from '../src/constants.js';
import { DevTool } from '../src/devTool.js';

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('DevTool', () => {
  it('should reject with TIMEOUT_WAIT_PORT and leave the port marked closed when the debugger port never opens', async () => {
    const port = await closedPort();
    const devTool = new DevTool({ host: 'localhost', port, timeout: 100 });

    const timeout = { message: `${ERROR_MESSAGE.TIMEOUT_WAIT_PORT}: localhost:${port}` };
    await expect(devTool.list()).rejects.toMatchObject(timeout);
    // A second call must still wait on the port (and time out with TIMEOUT_WAIT_PORT)
    // rather than skipping waitPort and failing with ECONNREFUSED.
    await expect(devTool.list()).rejects.toMatchObject(timeout);
  });

  it('should name the refused address when the debugger port closes after opening', async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end('[]');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const devTool = new DevTool({ host: 'localhost', port, timeout: 200 });
    await expect(devTool.list()).resolves.toEqual([]);

    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(devTool.list()).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(`^Request Error: .*ECONNREFUSED .*:${port}`)),
    });
  });

  it('should report wait-port rejection with its message and address when the debugger host cannot be resolved', async () => {
    const devTool = new DevTool({ host: 'unresolvable.invalid', port: 9222, timeout: 500 });

    await expect(devTool.list()).rejects.toMatchObject({
      message: "The address 'unresolvable.invalid' cannot be found: unresolvable.invalid:9222",
      cause: expect.any(Error),
    });
  });

  it('should report wait-port validation errors with their message and address', async () => {
    const devTool = new DevTool({ host: 'localhost', port: 70000, timeout: 500 });

    await expect(devTool.list()).rejects.toMatchObject({
      message: "'port' must not be greater than 65535.: localhost:70000",
      cause: expect.any(Error),
    });
  });
});
