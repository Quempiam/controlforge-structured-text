/**
 * URI/path conversion utilities matching VS Code's `file://` URI conventions.
 *
 * VS Code emits URIs in the form `file:///c%3A/Users/foo` on Windows
 * (3 slashes, lowercased drive letter, URL-encoded colon). The naive
 * `uri.replace('file://', '')` produces an invalid filesystem path on
 * Windows because of the leading slash and the encoded characters.
 */

import * as path from 'path';

const FILE_SCHEME = 'file://';

/**
 * Convert a `file://` URI to an absolute filesystem path that the `fs`
 * module can consume. Returns the input unchanged if it is not a `file://`
 * URI.
 */
export function uriToFsPath(uri: string): string {
    if (!uri.startsWith(FILE_SCHEME)) {
        return uri;
    }

    let p = decodeURIComponent(uri.slice(FILE_SCHEME.length));

    if (process.platform === 'win32') {
        if (/^\/[a-zA-Z]:/.test(p)) {
            p = p.slice(1);
        }
        p = p.replace(/\//g, path.sep);
    }

    return p;
}

/**
 * Convert an absolute filesystem path to a canonical `file://` URI matching
 * the form VS Code generates (lowercased drive letter, URL-encoded colon,
 * 3 slashes for absolute paths).
 */
export function fsPathToUri(fsPath: string): string {
    const forwardSlashed = fsPath.replace(/\\/g, '/');

    const encodedSegments = forwardSlashed.split('/').map((segment, idx) => {
        // The first segment is empty for absolute Unix paths (leading '/').
        if (segment === '') return segment;
        return encodeURIComponent(segment);
    });
    let encoded = encodedSegments.join('/');

    // Lowercase the drive letter for Windows-style paths (`C%3A` -> `c%3A`).
    encoded = encoded.replace(/^([a-zA-Z])%3A/, (_m, letter) => `${letter.toLowerCase()}%3A`);

    if (/^[a-z]%3A/.test(encoded)) {
        return `file:///${encoded}`;
    }
    if (encoded.startsWith('/')) {
        return `file://${encoded}`;
    }
    return `file:///${encoded}`;
}