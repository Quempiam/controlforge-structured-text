import * as assert from 'assert';
import { uriToFsPath, fsPathToUri } from '../../server/uri-utils';

const isWindows = process.platform === 'win32';

suite('URI Utils Unit Tests', () => {

    suite('uriToFsPath', () => {
        test('returns input unchanged for non-file:// URIs', () => {
            assert.strictEqual(uriToFsPath('http://example.com/foo'), 'http://example.com/foo');
        });

        test('decodes URL-encoded characters', () => {
            const decoded = uriToFsPath('file:///path/with%20space');
            assert.ok(decoded.includes(' '), `expected decoded space, got ${decoded}`);
        });

        if (isWindows) {
            test('strips leading slash before drive letter on Windows', () => {
                const result = uriToFsPath('file:///c%3A/Users/foo');
                assert.match(result, /^c:[\\/]/i, `expected drive-letter path, got ${result}`);
            });

            test('handles uppercase drive letter without encoding', () => {
                const result = uriToFsPath('file:///C:/Users/foo');
                assert.match(result, /^C:[\\/]Users[\\/]foo$/, `unexpected: ${result}`);
            });
        } else {
            test('preserves leading slash on Unix', () => {
                assert.strictEqual(uriToFsPath('file:///Users/foo'), '/Users/foo');
            });
        }
    });

    suite('fsPathToUri', () => {
        if (isWindows) {
            test('produces canonical 3-slash URI with lowercased drive and encoded colon', () => {
                assert.strictEqual(fsPathToUri('C:\\Users\\foo'), 'file:///c%3A/Users/foo');
            });

            test('handles forward slashes in input', () => {
                assert.strictEqual(fsPathToUri('C:/Users/foo'), 'file:///c%3A/Users/foo');
            });
        } else {
            test('produces file:// URI for absolute Unix paths', () => {
                assert.strictEqual(fsPathToUri('/Users/foo'), 'file:///Users/foo');
            });
        }
    });

    suite('round-trip', () => {
        test('fsPathToUri then uriToFsPath returns original path', () => {
            const original = isWindows ? 'C:\\Users\\foo\\bar.st' : '/Users/foo/bar.st';
            const uri = fsPathToUri(original);
            const back = uriToFsPath(uri);
            // On Windows the drive letter case may shift; compare case-insensitively.
            assert.strictEqual(back.toLowerCase(), original.toLowerCase());
        });
    });
});
