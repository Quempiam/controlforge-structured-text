/**
 * AST-based parser for Structured Text (IEC 61131-3)
 *
 * Key design decisions:
 *  - Multi-line declaration support via statement accumulator (collects until ';')
 *  - Unified declaration parsing shared across VAR, VAR_INPUT/OUTPUT, VAR_GLOBAL
 *  - VAR qualifiers (CONSTANT, RETAIN, PERSISTENT) handled properly
 *  - STRING[n], POINTER TO, REFERENCE TO, multi-dim ARRAY types supported
 *  - Multi-variable declarations (a, b, c : INT;) expanded to individual symbols
 */

import { TextDocument } from 'vscode-languageserver-textdocument';
import { Position, Range, Location } from 'vscode-languageserver';
import * as path from 'path';
import {
    STSymbolKind,
    STScope,
    STParameter,
    STSymbolExtended,
    ArrayDimension
} from '../shared/types';
import { uriToFsPath } from './uri-utils';

/**
 * Parsed declaration result from a single statement (may contain multiple names)
 */
interface ParsedDeclaration {
    names: string[];
    dataType: string;           // full type text, e.g. "ARRAY[1..10] OF INT"
    baseType: string;           // extracted base type, e.g. "INT"
    initialValue?: string;
    hasAT: boolean;
    atAddress?: string;
    isArray: boolean;
    isPointer: boolean;
    isReference: boolean;
    arrayDimensions?: ArrayDimension[]; // parsed bounds for each dimension
}

/**
 * Enhanced parser that builds an AST and extracts comprehensive symbol information
 */
export class STASTParser {
    private document: TextDocument;
    private text: string;
    private lines: string[];

    constructor(document: TextDocument) {
        this.document = document;
        this.text = document.getText();
        this.lines = this.text.split('\n');
    }

    // ─── public API ──────────────────────────────────────────────

    /**
     * Parse the document and extract all symbols
     */
    public parseSymbols(): STSymbolExtended[] {
        const symbols: STSymbolExtended[] = [];

        try {
            const programs = this.safeOp(() => this.parsePrograms(), 'parsePrograms');
            const functions = this.safeOp(() => this.parseFunctions(), 'parseFunctions');
            const functionBlocks = this.safeOp(() => this.parseFunctionBlocks(), 'parseFunctionBlocks');
            const actions = this.safeOp(() => this.parseActions(), 'parseActions');
            const methods = this.safeOp(() => this.parseMethods(), 'parseMethods');
            const globalVariables = this.safeOp(() => this.parseGlobalVariables(), 'parseGlobalVariables');

            symbols.push(...programs, ...functions, ...functionBlocks, ...actions, ...methods, ...globalVariables);

            // Flatten member symbols into top-level list with parentSymbol set
            for (const parent of [...programs, ...functions, ...functionBlocks, ...actions]) {
                if (parent.members) {
                    for (const member of parent.members) {
                        member.parentSymbol = parent.name;
                        symbols.push(member);
                    }
                }
            }

            return symbols;
        } catch (error) {
            console.error(`Error parsing symbols: ${error}`);
            return [];
        }
    }

    // ─── top-level construct parsers ─────────────────────────────

    private parsePrograms(): STSymbolExtended[] {
        const results: STSymbolExtended[] = [];
        const regex = /^\s*PROGRAM\s+(\w+)/i;

        for (let i = 0; i < this.lines.length; i++) {
            const match = this.lines[i].match(regex);
            if (!match) continue;

            const name = match[1];
            const location = this.createLocation(i, this.lines[i].indexOf(name), name.length);
            const endLine = this.findEndKeyword(i, 'PROGRAM');
            const variables = this.parseVarSectionsInRange(i, endLine, false);

            results.push({
                name,
                normalizedName: name.toLowerCase(),
                kind: STSymbolKind.Program,
                location,
                scope: STScope.Program,
                members: variables,
                description: this.extractLeadingDocComment(i),
                references: []
            });
        }
        return results;
    }

    private parseFunctions(): STSymbolExtended[] {
        const results: STSymbolExtended[] = [];
        const regex = /^\s*FUNCTION\s+(\w+)\s*:\s*(\w+)/i;

        for (let i = 0; i < this.lines.length; i++) {
            const match = this.lines[i].match(regex);
            if (!match) continue;

            const name = match[1];
            const returnType = match[2];
            const location = this.createLocation(i, this.lines[i].indexOf(name), name.length);
            const endLine = this.findEndKeyword(i, 'FUNCTION');
            const parameters = this.parseParameterSectionsInRange(i, endLine);
            const variables = this.parseVarSectionsInRange(i, endLine, false);

            results.push({
                name,
                normalizedName: name.toLowerCase(),
                kind: STSymbolKind.Function,
                location,
                scope: STScope.Function,
                returnType,
                parameters,
                members: variables,
                description: this.extractLeadingDocComment(i),
                references: []
            });
        }
        return results;
    }

    private parseFunctionBlocks(): STSymbolExtended[] {
        const results: STSymbolExtended[] = [];
        const regex = /^\s*FUNCTION_BLOCK\s+(\w+)/i;

        for (let i = 0; i < this.lines.length; i++) {
            const match = this.lines[i].match(regex);
            if (!match) continue;

            const name = match[1];
            const location = this.createLocation(i, this.lines[i].indexOf(name), name.length);
            const endLine = this.findEndKeyword(i, 'FUNCTION_BLOCK');
            const parameters = this.parseParameterSectionsInRange(i, endLine);
            const variables = this.parseVarSectionsInRange(i, endLine, false);

            results.push({
                name,
                normalizedName: name.toLowerCase(),
                kind: STSymbolKind.FunctionBlock,
                location,
                scope: STScope.FunctionBlock,
                parameters,
                members: variables,
                description: this.extractLeadingDocComment(i),
                references: []
            });
        }
        return results;
    }

    /**
     * Infer a split-out member's owning POU/FB name from its folder position,
     * matching the convention used by tools that export one code object per
     * file (e.g. CODESYS project mirrors): a member file sitting directly
     * under a `<parentFolder>/<kindFolder>/` directory belongs to the POU
     * named `<parentFolder>`. `kindFolder` is checked case-insensitively.
     *
     * Returns undefined for any document not following this convention
     * (e.g. untitled buffers, or a flat/non-split project layout) - callers
     * must treat a missing parent as "unknown", not as a parsing error.
     */
    private inferParentFromFolderConvention(kindFolder: string): string | undefined {
        const fsPath = uriToFsPath(this.document.uri);
        if (!fsPath || fsPath === this.document.uri) return undefined; // not a file:// URI

        const dir = path.dirname(fsPath);
        if (path.basename(dir).toLowerCase() !== kindFolder.toLowerCase()) return undefined;

        const parentName = path.basename(path.dirname(dir));
        return parentName || undefined;
    }

    /**
     * Extract a CODESYS-style LibDoc documentation comment immediately
     * preceding a declaration line, if any (see
     * https://content.helpme-codesys.com/en/LibDevSummary/reSTOverview.html).
     *
     * Walks backward from `declLineIndex` collecting a contiguous run of
     * comment-only lines (`///`, `//`, or `(* ... *)`) with no blank line in
     * between - a blank line breaks the run, so this naturally stops before
     * reaching an unrelated comment further up (e.g. this project's own
     * mirror_export header, which always leaves a blank line before the
     * declaration it precedes). Returns undefined when there's nothing
     * (the common case for most declarations today).
     */
    private extractLeadingDocComment(declLineIndex: number): string | undefined {
        const collected: string[] = [];

        for (let i = declLineIndex - 1; i >= 0; i--) {
            const raw = this.lines[i];
            if (raw === undefined) break;
            const trimmed = raw.trim();
            if (trimmed === '') break; // blank line ends the run

            let content: string | null = null;
            if (trimmed.startsWith('///')) {
                content = trimmed.slice(3);
            } else if (trimmed.startsWith('//')) {
                content = trimmed.slice(2);
            } else if (trimmed.startsWith('(*') && trimmed.endsWith('*)')) {
                content = trimmed.slice(2, -2);
            } else {
                break; // not a comment line - run ends
            }

            collected.unshift(content.trim());
        }

        if (collected.length === 0) return undefined;
        return this.renderDocComment(collected);
    }

    /**
     * Extract a trailing same-line comment from a declaration, e.g.
     * `value : INT; // Internal counter for X` - a common one-line-per-field
     * documentation style, distinct from the LibDoc block-above convention
     * extractLeadingDocComment handles. Checked as a fallback when there's
     * no leading doc comment. Only looks at the given line (the
     * declaration's own start line) - a trailing comment on a later line of
     * a multi-line declaration is not picked up.
     */
    private extractTrailingComment(rawLine: string | undefined): string | undefined {
        if (!rawLine) return undefined;

        const withoutBlocks = rawLine.replace(/\(\*.*?\*\)/g, '');
        const slashIdx = withoutBlocks.indexOf('//');
        if (slashIdx !== -1) {
            const text = withoutBlocks.slice(slashIdx + 2).trim();
            return text || undefined;
        }

        const blockMatches = [...rawLine.matchAll(/\(\*(.*?)\*\)/g)];
        if (blockMatches.length > 0) {
            const last = blockMatches[blockMatches.length - 1][1].trim();
            return last || undefined;
        }

        return undefined;
    }

    /**
     * Light reST-to-Markdown touch-up for a LibDoc comment's lines.
     * reST and Markdown already agree on **bold**, *italic*, and `- item`
     * bullet lists, so most text passes through unchanged. Only the
     * CODESYS-specific field markers (`:return:`, `:prefix:`, etc.) and the
     * `.. directive::` syntax need translating/dropping for a VS Code hover
     * (which renders plain Markdown, not full reST).
     */
    private renderDocComment(lines: string[]): string {
        const rendered = lines.map(line => {
            const fieldMatch = line.match(/^:(\w[\w-]*):\s*(.*)$/);
            if (fieldMatch) {
                const [, field, rest] = fieldMatch;
                const label = field.charAt(0).toUpperCase() + field.slice(1);
                return `**${label}:** ${rest}`.trim();
            }
            if (line.startsWith('..')) return ''; // directive (e.g. .. image::) - not renderable here
            return line;
        });
        return rendered.join('\n').trim();
    }

    /**
     * Parse standalone `ACTION Name: ... END_ACTION` blocks.
     *
     * An Action shares its parent POU's variable scope rather than declaring
     * its own VAR_INPUT/VAR_OUTPUT/VAR sections, so unlike PROGRAM/FUNCTION/
     * FUNCTION_BLOCK no parameters or local members are parsed here - just
     * the name, so it registers as a known callable symbol workspace-wide
     * (e.g. when exported as its own file by a tool that splits a POU's
     * actions out, the unqualified call in the parent POU's body would
     * otherwise be flagged as an undefined identifier).
     *
     * `parentSymbol` is set when the file sits under a `<Pou>/act/` folder
     * (see inferParentFromFolderConvention) - informational for now, not
     * relied on by the undefined-identifier check, which treats all Action
     * names as a single flat set regardless of parent.
     */
    private parseActions(): STSymbolExtended[] {
        const results: STSymbolExtended[] = [];
        const regex = /^\s*ACTION\s+(\w+)/i;
        const inferredParent = this.inferParentFromFolderConvention('act');

        for (let i = 0; i < this.lines.length; i++) {
            const match = this.lines[i].match(regex);
            if (!match) continue;

            const name = match[1];
            const location = this.createLocation(i, this.lines[i].indexOf(name), name.length);

            results.push({
                name,
                normalizedName: name.toLowerCase(),
                kind: STSymbolKind.Action,
                location,
                scope: STScope.Action,
                parentSymbol: inferredParent,
                description: this.extractLeadingDocComment(i),
                references: []
            });
        }
        return results;
    }

    /**
     * Parse standalone `METHOD [PUBLIC|PRIVATE|PROTECTED|INTERNAL] Name [: ReturnType]
     * ... END_METHOD` blocks.
     *
     * Like Actions, a Method shares its parent FB's scope. `parentSymbol` is
     * set when the file sits under a `<FBName>/mth/` folder (see
     * inferParentFromFolderConvention), so that member-access validation
     * (member-access-provider.ts) can tell a method apart from a same-named
     * method on an unrelated FB - important since method names routinely
     * repeat across different function blocks in a real project (e.g.
     * `mAlarms`, `mResetCounters`). Unlike parseActions's Action handling,
     * a Method with no inferred parent is NOT registered as a flat/global
     * name, since that would make same-named methods on different FBs
     * indistinguishable - see buildCustomFBTypes in diagnostics-provider.ts.
     */
    private parseMethods(): STSymbolExtended[] {
        const results: STSymbolExtended[] = [];
        const regex = /^\s*METHOD\s+(?:(PUBLIC|PRIVATE|PROTECTED|INTERNAL|ABSTRACT|FINAL)\s+)?(\w+)\s*(?::\s*([\w\[\]]+))?/i;
        const inferredParent = this.inferParentFromFolderConvention('mth');

        for (let i = 0; i < this.lines.length; i++) {
            const match = this.lines[i].match(regex);
            if (!match) continue;

            const name = match[2];
            const returnType = match[3];
            const location = this.createLocation(i, this.lines[i].indexOf(name), name.length);

            results.push({
                name,
                normalizedName: name.toLowerCase(),
                kind: STSymbolKind.Method,
                location,
                scope: STScope.Function,
                returnType,
                parentSymbol: inferredParent,
                description: this.extractLeadingDocComment(i),
                references: []
            });
        }
        return results;
    }

    private parseGlobalVariables(): STSymbolExtended[] {
        const globals: STSymbolExtended[] = [];
        const regex = /^\s*VAR_GLOBAL\b/i;

        for (let i = 0; i < this.lines.length; i++) {
            if (!regex.test(this.lines[i])) continue;

            // Detect CONSTANT qualifier on VAR_GLOBAL line
            const sectionMatch = this.matchVarSectionStart(this.stripComments(this.lines[i]).trim());
            const isConstant = sectionMatch ? sectionMatch.qualifiers.includes('CONSTANT') : false;

            // Find END_VAR
            let endLine = i + 1;
            while (endLine < this.lines.length) {
                if (this.stripComments(this.lines[endLine]).trim().toUpperCase().startsWith('END_VAR')) break;
                endLine++;
            }

            const declarations = this.collectDeclarationsInRange(i + 1, endLine - 1);

            for (const { decl, lineIndex } of declarations) {
                for (const varName of decl.names) {
                    const isKnown = this.isKnownDataType(decl.baseType);
                    const kind = isKnown ? STSymbolKind.Variable : STSymbolKind.FunctionBlockInstance;

                    let description: string;
                    if (decl.isArray) {
                        description = `Array of ${decl.baseType}`;
                        if (decl.initialValue) description += ` := ${decl.initialValue.trim()}`;
                    } else if (isKnown) {
                        description = decl.initialValue
                            ? `Initial value: ${decl.initialValue.trim()}`
                            : `Global variable of type ${decl.baseType}`;
                    } else {
                        description = `Global instance of ${decl.baseType}`;
                    }
                    description = this.extractLeadingDocComment(lineIndex) || this.extractTrailingComment(this.lines[lineIndex]) || description;

                    const sym: STSymbolExtended = {
                        name: varName,
                        normalizedName: varName.toLowerCase(),
                        kind,
                        location: this.createLocation(lineIndex, this.findColumnOf(lineIndex, varName), varName.length),
                        scope: STScope.Global,
                        dataType: decl.baseType,
                        description,
                        literalType: this.getLiteralType(decl.initialValue, decl.baseType),
                        references: []
                    };
                    if (isConstant) sym.isConstant = true;
                    globals.push(sym);
                }
            }

            i = endLine; // advance past END_VAR
        }
        return globals;
    }

    // ─── VAR section scanning ────────────────────────────────────

    /**
     * Scan a range for VAR / VAR_INPUT / VAR_OUTPUT / VAR_IN_OUT / VAR_TEMP sections.
     * When `parameterMode` is false, VAR_INPUT/OUTPUT/IN_OUT sections produce
     * STSymbolExtended members (not STParameter). This keeps the existing API.
     */
    private parseVarSectionsInRange(startLine: number, endLine: number, _parameterMode: boolean): STSymbolExtended[] {
        const variables: STSymbolExtended[] = [];

        for (let i = startLine; i <= endLine; i++) {
            const trimmed = this.stripComments(this.lines[i] || '').trim();
            if (!trimmed) continue;

            const sectionMatch = this.matchVarSectionStart(trimmed);
            if (!sectionMatch) continue;

            const scope = this.getVarScope(sectionMatch.suffix);
            const isConstant = sectionMatch.qualifiers.includes('CONSTANT');

            // Scan until END_VAR
            const sectionEnd = this.findEndVar(i + 1, endLine);
            const declarations = this.collectDeclarationsInRange(i + 1, sectionEnd - 1);

            for (const { decl, lineIndex } of declarations) {
                for (const varName of decl.names) {
                    const isKnown = this.isKnownDataType(decl.baseType);
                    const kind = isKnown ? STSymbolKind.Variable : STSymbolKind.FunctionBlockInstance;

                    let description: string;
                    if (decl.isArray) {
                        description = `Array of ${decl.baseType}`;
                        if (decl.initialValue) description += ` := ${decl.initialValue.trim()}`;
                    } else if (decl.isPointer) {
                        description = `Pointer to ${decl.baseType}`;
                    } else if (decl.isReference) {
                        description = `Reference to ${decl.baseType}`;
                    } else if (isKnown) {
                        description = decl.initialValue
                            ? `Initial value: ${decl.initialValue.trim()}`
                            : `Variable of type ${decl.baseType}`;
                    } else {
                        description = `Instance of ${decl.baseType}`;
                    }
                    description = this.extractLeadingDocComment(lineIndex) || this.extractTrailingComment(this.lines[lineIndex]) || description;

                    const varLocation = this.createLocation(lineIndex, this.findColumnOf(lineIndex, varName), varName.length);

                    const sym: STSymbolExtended = {
                        name: varName,
                        normalizedName: varName.toLowerCase(),
                        kind,
                        location: varLocation,
                        scope,
                        dataType: decl.baseType,
                        description,
                        literalType: this.getLiteralType(decl.initialValue, decl.baseType),
                        references: []
                    };
                    if (isConstant) sym.isConstant = true;
                    if (decl.arrayDimensions) sym.arrayDimensions = decl.arrayDimensions;
                    variables.push(sym);
                }
            }

            i = sectionEnd; // skip past END_VAR
        }
        return variables;
    }

    /**
     * Parse VAR_INPUT / VAR_OUTPUT / VAR_IN_OUT sections as STParameter[]
     */
    private parseParameterSectionsInRange(startLine: number, endLine: number): STParameter[] {
        const parameters: STParameter[] = [];

        for (let i = startLine; i <= endLine; i++) {
            const trimmed = this.stripComments(this.lines[i] || '').trim();
            if (!trimmed) continue;

            const sectionMatch = this.matchVarSectionStart(trimmed);
            if (!sectionMatch) continue;

            const suffix = sectionMatch.suffix.toUpperCase();
            if (suffix !== '_INPUT' && suffix !== '_OUTPUT' && suffix !== '_IN_OUT') continue;

            const direction = suffix.substring(1) as 'INPUT' | 'OUTPUT' | 'IN_OUT';

            const sectionEnd = this.findEndVar(i + 1, endLine);
            const declarations = this.collectDeclarationsInRange(i + 1, sectionEnd - 1);

            for (const { decl, lineIndex } of declarations) {
                for (const paramName of decl.names) {
                    parameters.push({
                        name: paramName,
                        normalizedName: paramName.toLowerCase(),
                        dataType: decl.baseType,
                        direction,
                        defaultValue: decl.initialValue?.trim(),
                        location: this.createLocation(lineIndex, this.findColumnOf(lineIndex, paramName), paramName.length)
                    });
                }
            }

            i = sectionEnd;
        }
        return parameters;
    }

    // ─── VAR section start matching ──────────────────────────────

    /**
     * Match a VAR section header, handling qualifiers.
     * Matches: VAR, VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT, VAR_GLOBAL, VAR_TEMP
     * Plus optional qualifiers: CONSTANT, RETAIN, PERSISTENT, NON_RETAIN
     * Returns null if not a VAR section start.
     */
    private matchVarSectionStart(trimmedLine: string): { suffix: string; qualifiers: string[] } | null {
        const match = trimmedLine.match(
            /^VAR(_INPUT|_OUTPUT|_IN_OUT|_GLOBAL|_TEMP)?\s*((?:CONSTANT|RETAIN|PERSISTENT|NON_RETAIN)\s*)*$/i
        );
        if (!match) return null;

        const suffix = match[1] || '';
        const qualifiersRaw = match[2] || '';
        const qualifiers = qualifiersRaw.trim().split(/\s+/).filter(Boolean).map(q => q.toUpperCase());
        return { suffix, qualifiers };
    }

    /**
     * Find END_VAR line within a bounded range. Returns the line index of END_VAR
     * or the boundary if not found.
     */
    private findEndVar(fromLine: number, maxLine: number): number {
        for (let j = fromLine; j <= maxLine; j++) {
            const clean = this.stripComments(this.lines[j] || '').trim();
            if (clean.toUpperCase().startsWith('END_VAR')) return j;
        }
        return maxLine;
    }

    // ─── multi-line declaration accumulator ──────────────────────

    /**
     * Collect complete declarations from a line range.
     * Accumulates text across lines until ';', then parses.
     * Supports multi-line declarations by accumulating across lines until ';'.
     */
    private collectDeclarationsInRange(
        startLine: number,
        endLine: number
    ): { decl: ParsedDeclaration; lineIndex: number }[] {
        const results: { decl: ParsedDeclaration; lineIndex: number }[] = [];

        let accumulator = '';
        let statementStartLine = startLine;

        for (let i = startLine; i <= endLine; i++) {
            const raw = this.lines[i] || '';
            const clean = this.stripComments(raw).trim();
            if (!clean) continue;

            // Skip END_VAR or nested section starts
            if (clean.toUpperCase().startsWith('END_VAR')) break;

            if (!accumulator) {
                statementStartLine = i;
            }
            accumulator += (accumulator ? ' ' : '') + clean;

            // Check if statement is complete (ends with ';')
            if (accumulator.endsWith(';')) {
                const decl = this.parseDeclarationStatement(accumulator);
                if (decl) {
                    results.push({ decl, lineIndex: statementStartLine });
                }
                accumulator = '';
            }
        }

        // Handle unterminated accumulator (missing ';')
        if (accumulator.trim()) {
            const decl = this.parseDeclarationStatement(accumulator + ';');
            if (decl) {
                results.push({ decl, lineIndex: statementStartLine });
            }
        }

        return results;
    }

    // ─── declaration statement parser ────────────────────────────

    /**
     * Parse a single complete declaration statement (already joined from multi-line).
     * Handles:
     *   name : TYPE;
     *   name : TYPE := value;
     *   a, b, c : TYPE;
     *   name AT %IX0.0 : TYPE;
     *   name : ARRAY[1..10] OF TYPE;
     *   name : ARRAY[1..10, 1..20] OF TYPE;
     *   name : STRING[80];
     *   name : POINTER TO TYPE;
     *   name : REFERENCE TO TYPE;
     *   name : TYPE {attribute := 'value'};
     *   name : TYPE := [1, 2, 3];
     *   name : TYPE := (field1 := val, field2 := val);
     */
    private parseDeclarationStatement(stmt: string): ParsedDeclaration | null {
        // Remove trailing semicolon
        let s = stmt.replace(/;\s*$/, '').trim();
        if (!s) return null;

        // Remove trailing attribute block {…}
        s = s.replace(/\s*\{[^}]*\}\s*$/, '').trim();

        // ── Split into LHS (names + optional AT) and RHS (type + optional init) ──
        // Find the first ':' that is NOT ':='
        const colonIdx = this.findTypeColon(s);
        if (colonIdx < 0) return null;

        const lhs = s.substring(0, colonIdx).trim();
        const rhs = s.substring(colonIdx + 1).trim();

        // ── Parse LHS: names and optional AT address ──
        let namesStr = lhs;
        let hasAT = false;
        let atAddress: string | undefined;

        const atMatch = lhs.match(/^(.+?)\s+AT\s+(%\w+[\w.]*)\s*$/i);
        if (atMatch) {
            namesStr = atMatch[1].trim();
            hasAT = true;
            atAddress = atMatch[2];
        }

        // Split by comma for multi-variable declarations
        const names = namesStr.split(',').map(n => n.trim()).filter(n => /^[A-Za-z_]\w*$/.test(n));
        if (names.length === 0) return null;

        // ── Parse RHS: type and optional := initialValue ──
        let typeText: string;
        let initialValue: string | undefined;

        // Find ':=' assignment that is not inside brackets/parens
        const assignIdx = this.findAssignmentOperator(rhs);
        if (assignIdx >= 0) {
            typeText = rhs.substring(0, assignIdx).trim();
            initialValue = rhs.substring(assignIdx + 2).trim();
        } else {
            typeText = rhs.trim();
        }

        if (!typeText) return null;

        // ── Classify type ──
        const upperType = typeText.toUpperCase();
        const isPointer = /^POINTER\s+TO\s+/i.test(typeText);
        const isReference = /^REFERENCE\s+TO\s+/i.test(typeText);
        const isArray = upperType.startsWith('ARRAY');

        const baseType = this.extractBaseType(typeText);
        const arrayDimensions = isArray ? this.parseArrayDimensions(typeText) : undefined;

        return {
            names,
            dataType: typeText,
            baseType,
            initialValue,
            hasAT,
            atAddress,
            isArray,
            isPointer,
            isReference,
            arrayDimensions
        };
    }

    /**
     * Find the index of the type-colon ':' that separates names from type.
     * Skips ':=' sequences.
     */
    private findTypeColon(s: string): number {
        for (let i = 0; i < s.length; i++) {
            if (s[i] === ':') {
                if (i + 1 < s.length && s[i + 1] === '=') {
                    i++; // skip ':='
                    continue;
                }
                return i;
            }
        }
        return -1;
    }

    /**
     * Find ':=' assignment operator in the RHS, ignoring those inside
     * brackets [], parens (), or struct inits.
     */
    private findAssignmentOperator(s: string): number {
        let depth = 0;
        for (let i = 0; i < s.length - 1; i++) {
            const c = s[i];
            if (c === '(' || c === '[') depth++;
            else if (c === ')' || c === ']') depth--;
            else if (depth === 0 && c === ':' && s[i + 1] === '=') {
                return i;
            }
        }
        return -1;
    }

    // ─── END keyword finder ──────────────────────────────────────

    /**
     * Find matching END_<keyword> handling nesting
     */
    private findEndKeyword(startLine: number, keyword: string): number {
        const endKeyword = `END_${keyword}`;
        let depth = 1;

        for (let i = startLine + 1; i < this.lines.length; i++) {
            const line = this.stripComments(this.lines[i]).trim().toUpperCase();
            if (!line) continue;

            // Check for nested same keyword (word-boundary aware)
            const keywordRegex = new RegExp(`^${keyword}\\b`, 'i');
            if (keywordRegex.test(line)) {
                depth++;
            } else if (line.startsWith(endKeyword)) {
                depth--;
                if (depth === 0) return i;
            }
        }

        // Silently return end of document if no match found
        // (proper diagnostics are handled by diagnostics-provider.ts)
        return this.lines.length - 1;
    }

    // ─── comment stripping ───────────────────────────────────────

    /**
     * Strip single-line (//) and block ((* *)) comments from a line.
     * Handles nested block comments.
     */
    private stripComments(line: string): string {
        if (!line) return '';
        let result = '';
        let depth = 0;
        let i = 0;

        while (i < line.length) {
            if (depth > 0) {
                if (i + 1 < line.length && line[i] === '(' && line[i + 1] === '*') {
                    depth++;
                    i += 2;
                } else if (i + 1 < line.length && line[i] === '*' && line[i + 1] === ')') {
                    depth--;
                    i += 2;
                } else {
                    i++;
                }
            } else {
                if (i + 1 < line.length && line[i] === '(' && line[i + 1] === '*') {
                    depth++;
                    i += 2;
                } else if (i + 1 < line.length && line[i] === '/' && line[i + 1] === '/') {
                    break;
                } else {
                    result += line[i];
                    i++;
                }
            }
        }

        return result.trim();
    }

    // ─── type utilities ──────────────────────────────────────────

    /**
     * Extract the base/element type from complex type declarations.
     *   ARRAY[…] OF T     → T
     *   POINTER TO T       → T
     *   REFERENCE TO T     → T
     *   STRING[80]         → STRING
     *   WSTRING[255]       → WSTRING
     *   plain type         → type
     */
    private extractBaseType(typeText: string): string {
        const t = typeText.trim();

        // ARRAY[…] OF T
        const arrayMatch = t.match(/ARRAY\s*\[.*?\]\s*OF\s+(.+)/i);
        if (arrayMatch) return this.extractBaseType(arrayMatch[1]);

        // POINTER TO T
        const ptrMatch = t.match(/^POINTER\s+TO\s+(.+)/i);
        if (ptrMatch) return this.extractBaseType(ptrMatch[1]);

        // REFERENCE TO T
        const refMatch = t.match(/^REFERENCE\s+TO\s+(.+)/i);
        if (refMatch) return this.extractBaseType(refMatch[1]);

        // STRING[n] / WSTRING[n]
        const strLenMatch = t.match(/^(STRING|WSTRING)\s*\[.*?\]/i);
        if (strLenMatch) return strLenMatch[1].toUpperCase();

        return t;
    }

    /**
     * Parse ARRAY dimension bounds from a type text.
     * e.g. "ARRAY[1..10] OF REAL"       → [{lower:1, upper:10}]
     *      "ARRAY[1..10, 0..5] OF INT"  → [{lower:1,upper:10},{lower:0,upper:5}]
     * Returns undefined if not an array or bounds can't be parsed.
     */
    private parseArrayDimensions(typeText: string): ArrayDimension[] | undefined {
        const match = typeText.match(/ARRAY\s*\[([^\]]+)\]\s*OF/i);
        if (!match) return undefined;

        const dimStrings = match[1].split(',');
        const dims: ArrayDimension[] = [];
        for (const dim of dimStrings) {
            const rangeMatch = dim.trim().match(/^(-?\d+)\s*\.\.\s*(-?\d+)$/);
            if (!rangeMatch) return undefined; // non-literal bound — bail
            dims.push({ lower: parseInt(rangeMatch[1], 10), upper: parseInt(rangeMatch[2], 10) });
        }
        return dims.length > 0 ? dims : undefined;
    }

    /**
     * Check if a type is a known standard IEC 61131-3 data type
     */
    private isKnownDataType(dataType: string): boolean {
        if (!dataType) return false;

        const upper = dataType.toUpperCase();

        // STRING/WSTRING with or without length spec
        if (upper === 'STRING' || upper === 'WSTRING' ||
            upper.startsWith('STRING[') || upper.startsWith('WSTRING[')) {
            return true;
        }

        return KNOWN_TYPES.has(upper);
    }

    /**
     * Get literal type from initialization value
     */
    private getLiteralType(value: string | undefined, dataType: string): string {
        if (!value) return dataType;

        const upperDataType = dataType.toUpperCase();
        if (upperDataType === 'STRING' || upperDataType === 'WSTRING' ||
            upperDataType === 'CHAR' || upperDataType === 'WCHAR' ||
            upperDataType.startsWith('STRING[') || upperDataType.startsWith('WSTRING[')) {
            return upperDataType;
        }

        const upperVal = value.trim().toUpperCase();
        const val = value.trim();

        // Time literals
        if (upperVal.startsWith('LTIME#') || upperVal.startsWith('LT#')) return 'LTIME';
        if (upperVal.startsWith('TIME#') || upperVal.startsWith('T#')) return 'TIME';

        // Date literals
        if (upperVal.startsWith('LDATE#') || upperVal.startsWith('LD#')) return 'LDATE';
        if (upperVal.startsWith('DATE#') || upperVal.startsWith('D#')) return 'DATE';
        if (upperVal.startsWith('DT#') || upperVal.startsWith('DATE_AND_TIME#')) return 'DATE_AND_TIME';
        if (upperVal.startsWith('TOD#') || upperVal.startsWith('TIME_OF_DAY#')) return 'TIME_OF_DAY';

        // String & Char literals
        if (upperVal.startsWith('WSTRING#') || val.startsWith('"')) return 'WSTRING';
        if (upperVal.startsWith('STRING#')) return 'STRING';
        if (upperVal.startsWith('WCHAR#')) return 'WCHAR';
        if (val.startsWith("'")) {
            return val.length === 3 ? 'CHAR' : 'STRING';
        }

        // Number literals
        if (/^[0-9]+$/.test(val)) return 'INT';
        if (/^[0-9]+\.[0-9]+$/.test(val)) return 'REAL';
        if (upperVal === 'TRUE' || upperVal === 'FALSE') return 'BOOL';

        return dataType;
    }

    // ─── scope mapping ───────────────────────────────────────────

    private getVarScope(varType: string): STScope {
        switch (varType.toUpperCase()) {
            case '_INPUT': return STScope.Input;
            case '_OUTPUT': return STScope.Output;
            case '_IN_OUT': return STScope.InOut;
            case '_GLOBAL': return STScope.Global;
            default: return STScope.Local;
        }
    }

    // ─── location helpers ────────────────────────────────────────

    private createLocation(line: number, character: number, length: number): Location {
        return {
            uri: this.document.uri,
            range: {
                start: { line, character },
                end: { line, character: character + length }
            }
        };
    }

    /**
     * Find the column of a variable name in a source line.
     * Falls back to 0 if not found.
     */
    private findColumnOf(lineIndex: number, name: string): number {
        const line = this.lines[lineIndex] || '';
        const idx = line.indexOf(name);
        return idx >= 0 ? idx : 0;
    }

    // ─── safe wrapper ────────────────────────────────────────────

    private safeOp<T>(operation: () => T[], operationName: string): T[] {
        try {
            return operation();
        } catch (error) {
            console.error(`Error in ${operationName}: ${error}`);
            return [];
        }
    }
}

// ─── known data types (see src/iec61131_specification.ts) ───

const KNOWN_TYPES = new Set([
    // Elementary types
    'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
    'SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT', 'ULINT',
    'REAL', 'LREAL',
    'TIME', 'LTIME',
    'DATE', 'LDATE',
    'TIME_OF_DAY', 'TOD',
    'DATE_AND_TIME', 'DT',
    'STRING', 'WSTRING',
    'CHAR', 'WCHAR',

    // Generic types
    'ANY', 'ANY_INT', 'ANY_REAL', 'ANY_BIT', 'ANY_STRING', 'ANY_DATE',
    'ANY_NUM', 'ANY_ELEMENTARY', 'ANY_DERIVED', 'ANY_MAGNITUDE',
    'ANY_CHAR', 'ANY_CHARS',

    // Standard FBs (treated as known to distinguish from user-defined types)
    'TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG', 'SR', 'RS'
]);
