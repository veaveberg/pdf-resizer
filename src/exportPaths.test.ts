import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialExportDirectory,
  nativeErrorMessage,
  selectedSubfolder,
} from './exportPaths.ts';

test('a browser import clears any previous native export directory', () => {
  assert.equal(initialExportDirectory({ kind: 'browser' }), '');
});

test('a desktop import starts in its native parent directory', () => {
  assert.equal(
    initialExportDirectory({ kind: 'desktop', directory: 'G:\\My Drive\\Print' }),
    'G:\\My Drive\\Print',
  );
});

test('subfolder selection trims names and omits disabled or empty values', () => {
  assert.equal(selectedSubfolder(false, 'PDF'), null);
  assert.equal(selectedSubfolder(true, '   '), null);
  assert.equal(selectedSubfolder(true, '  PDF exports  '), 'PDF exports');
});

test('native error messages preserve structured errors', () => {
  assert.equal(nativeErrorMessage({ code: 'permissionDenied', message: 'Folder is read-only.' }), 'Folder is read-only.');
  assert.equal(nativeErrorMessage(new Error('Cloud provider is offline.')), 'Cloud provider is offline.');
  assert.equal(nativeErrorMessage(null), 'The destination could not be accessed.');
});
