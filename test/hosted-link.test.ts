import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normaliseBasePath } from '../src/app/basePath';
import { appUrl, FETCH_CHANNEL, makeFetchBookmark } from '../src/app/fetchBookmark';
import { fetchFromMediRotaWizardStep } from '../src/app/setupWizard';

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sourceFiles(join(path, entry.name)) : /\.(ts|tsx|css|html)$/.test(entry.name) ? [join(path, entry.name)] : []);
}

describe('hosted link base path', () => {
  it.each([
    ['medirota-rota-planner', '/medirota-rota-planner/'],
    ['/medirota-rota-planner', '/medirota-rota-planner/'],
    ['medirota-rota-planner/', '/medirota-rota-planner/'],
    ['/medirota-rota-planner/', '/medirota-rota-planner/'],
    ['', '/'],
    ['/', '/'],
  ])('normalises %j to %s', (input, expected) => expect(normaliseBasePath(input)).toBe(expected));

  it('builds the local root bookmark at origin + "/"', () => {
    expect(appUrl('http://127.0.0.1:5180', '/')).toBe('http://127.0.0.1:5180/');
    const code = makeFetchBookmark(appUrl('http://127.0.0.1:5180', '/'));
    expect(code).toContain('"http://127.0.0.1:5180/"');
    expect(code).toContain("window.open(app+'?fetchFromMediRota=1','rota-planner-fetch'");
  });

  it('keeps no absolute /... paths to app-served files in index.html or src/', () => {
    const files = ['index.html', ...sourceFiles('src')];
    const absoluteAsset = /(?:src|href)=["']\/(?!\/)[^"']+|url\(\s*["']?\/(?!\/)[^)"']+/g;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // MediRota bookmark strings build paths on the MediRota host, not this app.
      const withoutBookmarkTemplate = file.endsWith('fetchBookmark.ts')
        ? text.replace(/makeFetchBookmark[\s\S]*$/m, '')
        : text;
      expect(withoutBookmarkTemplate.match(absoluteAsset) ?? [], file).toEqual([]);
    }
  });
});

describe('hosted link MediRota continue steps', () => {
  it('continues the fetch tab at doctor for doctors and types for coordinators', () => {
    expect(fetchFromMediRotaWizardStep(undefined)).toBe('doctor');
    expect(fetchFromMediRotaWizardStep('doctor')).toBe('doctor');
    expect(fetchFromMediRotaWizardStep('coordinator')).toBe('types');
  });

  it('keeps the bookmark channel, origin and source-window checks in the generated script', () => {
    const code = makeFetchBookmark('https://kshamiyah.github.io/medirota-rota-planner/');
    expect(code).toContain(`channel='${FETCH_CHANNEL}'`);
    expect(code).toContain('event.origin!==appOrigin||event.source!==tab||event.data?.channel!==channel');
    expect(code).toContain('"https://kshamiyah.github.io/medirota-rota-planner/"');
    expect(code).toContain("window.open(app+'?fetchFromMediRota=1','rota-planner-fetch'");
  });
});
