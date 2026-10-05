import * as assert from 'assert';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { computeDiagnostics } from '../../server/providers/diagnostics-provider';
import { STASTParser } from '../../server/ast-parser';
import { WorkspaceIndexer } from '../../server/workspace-indexer';

/**
 * Diagnostics on code laid out like a CODESYS one-object-per-file export:
 * qualified enum CASE labels, statements spread over several lines, VAR_INST,
 * pragmas in front of declarations, global lists known only by file name.
 */
function diagnose(content: string, workspaceNames?: Set<string>) {
    const document = TextDocument.create('file:///test.st', 'structured-text', 1, content);
    const symbols = new STASTParser(document).parseSymbols();
    return computeDiagnostics(document, symbols, [], undefined, workspaceNames);
}

function messages(content: string, workspaceNames?: Set<string>, filter = ''): string[] {
    return diagnose(content, workspaceNames).map(d => d.message).filter(m => m.includes(filter));
}

suite('CODESYS export diagnostics', () => {

    suite('CASE branch labels', () => {
        test('qualified enum labels need no semicolon', () => {
            const found = messages(`
PROGRAM Main
VAR
    mode : INT;
    x : INT;
END_VAR
    CASE mode OF
        LocalMode.SetPower:
            x := 1;
        LocalMode.Schedule:
            x := 2;
        ELSE
            x := 0;
    END_CASE
END_PROGRAM`, undefined, 'Missing semicolon');
            assert.deepStrictEqual(found, []);
        });

        test('label lists and ranges of qualified values need no semicolon', () => {
            const found = messages(`
PROGRAM Main
VAR
    mode : INT;
    x : INT;
END_VAR
    CASE mode OF
        Mode.A, Mode.B:
            x := 1;
        1..5, Mode.C .. Mode.D:
            x := 2;
        -1:
            x := 3;
    END_CASE
END_PROGRAM`, undefined, 'Missing semicolon');
            assert.deepStrictEqual(found, []);
        });
    });

    suite('statements over several lines', () => {
        test('operator at the end or at the start of the next line continues the statement', () => {
            const found = messages(`
PROGRAM Main
VAR
    total : INT;
    ok : BOOL;
    a : INT;
    b : INT;
END_VAR
    total :=
        a +
        b;
    ok := a > 1 AND
        b > 2
        AND a < 9;
END_PROGRAM`, undefined, 'Missing semicolon');
            assert.deepStrictEqual(found, []);
        });

        test('a real missing semicolon on the last line is still reported', () => {
            const found = messages(`
PROGRAM Main
VAR
    total : INT;
    a : INT;
END_VAR
    total :=
        a + 1
    a := 2;
END_PROGRAM`, undefined, 'Missing semicolon');
            assert.strictEqual(found.length, 1);
        });
    });

    suite('declarations', () => {
        test('VAR_INST is a variable section', () => {
            const found = messages(`
METHOD mAlarms
VAR_INST
    hbLast : BYTE;
END_VAR

hbLast := 1;`, undefined, 'VAR section');
            assert.deepStrictEqual(found, []);
        });

        test('a pragma line before a declaration does not swallow its name', () => {
            const document = TextDocument.create('file:///test.st', 'structured-text', 1, `
PROGRAM Main
VAR
    {attribute 'displaymode' := 'binary'}
    flags : DWORD := 2#00000011;
    other : INT;
END_VAR
END_PROGRAM`);
            const names = new STASTParser(document).parseSymbols().map(s => s.name);
            assert.ok(names.includes('flags'), `symbols: ${names.join(', ')}`);
            assert.ok(names.includes('other'));
        });
    });

    suite('names defined in other files', () => {
        const program = `
PROGRAM Main
VAR
    x : INT;
END_VAR
    x := gControl.value;
    gControl.flag := Mode.Local = 0;
END_PROGRAM`;

        test('a global list name is undefined without workspace knowledge', () => {
            const found = messages(program, undefined, "Undefined identifier 'gControl'");
            assert.ok(found.length > 0);
        });

        test('workspace names (GVL names, TYPEs) are not reported', () => {
            const found = messages(program, new Set(['GCONTROL', 'MODE']), 'Undefined identifier');
            assert.deepStrictEqual(found, []);
        });

        test('TO_<TYPE> conversions and S=/R= assignments are not names', () => {
            const found = messages(`
PROGRAM Main
VAR
    r : REAL;
    i : INT;
    on : BOOL;
END_VAR
    r := TO_REAL(i);
    on S= i > 3;
END_PROGRAM`, undefined, 'Undefined identifier');
            assert.deepStrictEqual(found, []);
        });
    });

    suite('WorkspaceIndexer.getWorkspaceDeclaredNames', () => {
        test('collects GVL file names and TYPE names, and drops them with the file', () => {
            const indexer = new WorkspaceIndexer();
            indexer.updateFileIndex(TextDocument.create('file:///p/_GVL/gControl.gvl.st', 'structured-text', 1,
                'VAR_GLOBAL\n    bStart : BOOL;\nEND_VAR\n'));
            indexer.updateFileIndex(TextDocument.create('file:///p/settings.pvl.st', 'structured-text', 1,
                'VAR_GLOBAL PERSISTENT\n    n : INT;\nEND_VAR\n'));
            indexer.updateFileIndex(TextDocument.create('file:///p/enum/Mode.enum.st', 'structured-text', 1,
                'TYPE Mode :\n(\n    Local := 0\n)INT;\nEND_TYPE\n'));

            const names = indexer.getWorkspaceDeclaredNames();
            assert.ok(names.has('GCONTROL'));
            assert.ok(names.has('SETTINGS'));
            assert.ok(names.has('MODE'));

            indexer.removeFileFromIndex('file:///p/_GVL/gControl.gvl.st');
            assert.ok(!indexer.getWorkspaceDeclaredNames().has('GCONTROL'));
        });
    });
});
