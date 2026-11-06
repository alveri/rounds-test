import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { openTestDatabase } from '../test-db.js';

const database = openTestDatabase();
const dir = mkdtempSync(join(tmpdir(), 'web-dist-'));
writeFileSync(join(dir, 'index.html'), '<div id="root"></div>');
const app = buildApp({ db: database.db, staticDir: dir });

afterAll(async () => {
  await app.close();
  await database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('serving the built web app', () => {
  it('serves index.html at / and for client-side routes', async () => {
    for (const url of ['/', '/competitors/acme-crm']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('id="root"');
    }
  });

  it('serves a file added after startup (a rebuilt bundle) and 404s a missing asset', async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'index-new.js'), 'console.log(1)');

    const added = await app.inject({ method: 'GET', url: '/assets/index-new.js' });
    expect(added.statusCode).toBe(200);
    expect(added.headers['content-type']).toMatch(/javascript/);

    const missing = await app.inject({ method: 'GET', url: '/assets/index-old.js' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).not.toMatch(/html/);
  });

  it('keeps JSON 404s for unknown API routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/no route/) });
  });
});
