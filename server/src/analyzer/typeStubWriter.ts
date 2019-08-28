/*
* typeStubWriter.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* Logic to emit a type stub file for a corresponding parsed
* and analyzed python source file.
*/

import * as fs from 'fs';

import { ArgumentCategory, ArgumentNode, ClassNode, DecoratorNode,
    ExpressionNode, FunctionNode, ImportFromNode, ImportNode, ModuleNameNode,
    ParameterCategory, ParameterNode } from '../parser/parseNodes';
import { ParseTreeUtils } from './parseTreeUtils';
import { ParseTreeWalker } from './parseTreeWalker';
import { SourceFile } from './sourceFile';
import { SymbolUtils } from './symbolUtils';

export class TypeStubWriter extends ParseTreeWalker {
    private _indentAmount = 0;
    private _typeStubText = '';
    private _lineEnd = '\n';
    private _tab = '    ';
    private _classNestCount = 0;
    private _functionNestCount = 0;
    private _emittedSuite = false;

    constructor(private _typingsPath: string, private _sourceFile: SourceFile) {
        super();
    }

    write() {
        const parseResults = this._sourceFile.getParseResults()!;
        this._lineEnd = parseResults.predominantLineEndSequence;
        this._tab = parseResults.predominantTabSequence;

        this._emitHeaderDocString();

        this.walk(parseResults.parseTree);

        this._writeFile();
    }

    visitClass(node: ClassNode) {
        const className = node.name.nameToken.value;

        // Skip if it's private.
        if (!SymbolUtils.isProtectedName(className) && !SymbolUtils.isPrivateName(className)) {
            this._emittedSuite = true;
            this._emitDecorators(node.decorators);
            let line = `class ${ className }`;
            if (node.arguments.length > 0) {
                line += `(${ node.arguments.map(arg => {
                    let argString = '';
                    if (arg.name) {
                        argString = arg.name.nameToken.value + '=';
                    }
                    argString += this._printExpression(arg.valueExpression);
                    return argString;
                }).join(', ') })`;
            }
            line += ':';
            this._emitLine(line);

            this._emitSuite(() => {
                this._classNestCount++;
                this.walkChildren(node);
                this._classNestCount--;
            });

            this._emitLine('');
            this._emitLine('');
        }

        return false;
    }

    visitFunction(node: FunctionNode) {
        const functionName = node.name.nameToken.value;

        // Skip if it's private or if we're already within a function.
        if (this._functionNestCount === 0 &&
            !SymbolUtils.isProtectedName(functionName) &&
                !SymbolUtils.isPrivateName(functionName)) {

            this._emittedSuite = true;
            this._emitDecorators(node.decorators);
            let line = node.isAsync ? 'async ' : '';
            line += `def ${ functionName }`;
            line += `(${ node.parameters.map(param => this._printParameter(param)).join(', ') })`;
            if (node.returnTypeAnnotation) {
                line += ' -> ' + this._printExpression(node.returnTypeAnnotation);
            }
            line += ':';
            this._emitLine(line);

            this._emitSuite(() => {
                // Don't emit any nested functions.
                this._functionNestCount++;
                this.walkChildren(node);
                this._functionNestCount--;
            });

            this._emitLine('');
        }

        return false;
    }

    visitImport(node: ImportNode) {
        if (this._functionNestCount > 0 || this._classNestCount > 0) {
            return false;
        }

        let line = 'import ';

        line += node.list.map(imp => {
            let impText = this._printModuleName(imp.module);
            if (imp.alias) {
                impText += ' as ' + imp.alias.nameToken.value;
            }
            return impText;
        }).join(', ');

        this._emitLine(line);

        return false;
    }

    visitImportFrom(node: ImportFromNode) {
        if (this._functionNestCount > 0 || this._classNestCount > 0) {
            return false;
        }

        let line = 'from ' + this._printModuleName(node.module) + ' import ';
        if (node.isWildcardImport) {
            line += '*';
        } else {
            line += node.imports.map(imp => {
                let impString = imp.name.nameToken.value;
                if (imp.alias) {
                    impString += ' as ' + imp.alias.nameToken.value;
                }
                return impString;
            }).join(', ');
        }

        this._emitLine(line);

        return false;
    }

    private _emitSuite(callback: () => void) {
        this._increaseIndent(() => {
            const prevEmittedSuite = this._emittedSuite;
            this._emittedSuite = false;

            callback();

            if (!this._emittedSuite) {
                this._emitLine('...');
            }

            this._emittedSuite = prevEmittedSuite;
        });
    }

    private _increaseIndent(callback: () => void) {
        this._indentAmount++;
        callback();
        this._indentAmount--;
    }

    private _emitDecorators(decorators: DecoratorNode[]) {
        decorators.forEach(decorator => {
            let line = '@' + this._printExpression(decorator.leftExpression);
            if (decorator.arguments) {
                line += `(${ decorator.arguments.map(
                    arg => this._printArgument(arg)).join(', ') })`;
            }
            this._emitLine(line);
        });
    }

    private _emitHeaderDocString() {
        this._emitLine('"""');
        this._emitLine('This type stub file was generated by pyright.');
        this._emitLine('"""');
        this._emitLine('');
    }

    private _emitLine(line: string) {
        for (let i = 0; i < this._indentAmount; i++) {
            this._typeStubText += this._tab;
        }

        this._typeStubText += line + this._lineEnd;
    }

    private _printModuleName(node: ModuleNameNode): string {
        let line = '';
        for (let i = 0; i < node.leadingDots; i++) {
            line += '.';
        }
        line += node.nameParts.map(part => part.nameToken.value).join('.');
        return line;
    }

    private _printParameter(node: ParameterNode): string {
        let line = '';
        if (node.category === ParameterCategory.VarArgList) {
            line += '*';
        } else if (node.category === ParameterCategory.VarArgDictionary) {
            line += '**';
        }

        if (node.name) {
            line += node.name.nameToken.value;
        }

        if (node.typeAnnotation) {
            line += ': ' + this._printExpression(node.typeAnnotation);
        }

        if (node.defaultValue) {
            if (node.typeAnnotation) {
                line += ' = ...';
            } else {
                line += '=...';
            }
        }

        return line;
    }

    private _printArgument(node: ArgumentNode): string {
        let line = '';
        if (node.argumentCategory === ArgumentCategory.UnpackedList) {
            line += '*';
        } else if (node.argumentCategory === ArgumentCategory.UnpackedDictionary) {
            line += '**';
        }

        if (node.name) {
            line += node.name.nameToken.value + '=';
        }

        return line + this._printExpression(node.valueExpression);
    }

    private _printExpression(node: ExpressionNode): string {
        return ParseTreeUtils.printExpression(node);
    }

    private _writeFile() {
        fs.writeFileSync(this._typingsPath, this._typeStubText, { encoding: 'utf8' });
    }
}
