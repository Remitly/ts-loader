import path = require('path');
import fs = require('fs');
import loaderUtils = require('loader-utils');
import objectAssign = require('object-assign');
import arrify = require('arrify');
require('colors');

import instances = require('./instances');
import interfaces = require('./interfaces');
import utils = require('./utils');

import typescript = require('typescript');

let webpackInstances: any = [];
const definitionFileRegex = /\.d\.ts$/;

function loader(this: interfaces.Webpack, contents: string) {
    this.cacheable && this.cacheable();
    const callback = this.async();
    const options = makeOptions(this);
    const rawFilePath = path.normalize(this.resourcePath);
    const filePath = utils.appendTsSuffixIfMatch(options.appendTsSuffixTo, rawFilePath);

    const { instance, error } = instances.ensureTypeScriptInstance(options, this);

    if (error) {
        callback(error);
        return;
    }

    const file = updateFileInCache(filePath, contents, instance);

    const { outputText } = options.transpileOnly
        ? getTranspilationEmit(filePath, contents, instance, this)
        : getEmit(filePath, instance, this);

    if (outputText === null || outputText === undefined) {
        const additionalGuidance = filePath.indexOf('node_modules') !== -1
        ? "\nYou should not need to recompile .ts files in node_modules.\nPlease contact the package author to advise them to use --declaration --outDir.\nMore https://github.com/Microsoft/TypeScript/issues/12358"
        : "";
        throw new Error(`Typescript emitted no output for ${filePath}.${additionalGuidance}`);
    }

    const { sourceMap, output } = makeSourceMap('', outputText, filePath, contents, this);

    // Make sure webpack is aware that even though the emitted JavaScript may be the same as
    // a previously cached version the TypeScript may be different and therefore should be
    // treated as new
    this._module.meta.tsLoaderFileVersion = file.version;

    callback(null, output, sourceMap);
}

function makeOptions(loader: interfaces.Webpack) {
    const queryOptions = loaderUtils.parseQuery<interfaces.LoaderOptions>(loader.query);
    const configFileOptions = loader.options.ts || {};

    const options = objectAssign<interfaces.LoaderOptions>({}, {
        silent: false,
        logLevel: 'INFO',
        logInfoToStdOut: false,
        instance: 'default',
        compiler: 'typescript',
        configFileName: 'tsconfig.json',
        transpileOnly: false,
        visualStudioErrorFormat: false,
        compilerOptions: {},
        appendTsSuffixTo: [],
        entryFileIsJs: false,
    }, configFileOptions, queryOptions);
    options.ignoreDiagnostics = arrify(options.ignoreDiagnostics).map(Number);
    options.logLevel = options.logLevel.toUpperCase();

    // differentiate the TypeScript instance based on the webpack instance
    let webpackIndex = webpackInstances.indexOf(loader._compiler);
    if (webpackIndex === -1) {
        webpackIndex = webpackInstances.push(loader._compiler) - 1;
    }
    options.instance = webpackIndex + '_' + options.instance;

    return options;
}

function updateFileInCache(filePath: string, contents: string, instance: interfaces.TSInstance) {
    // Update file contents
    let file = instance.files[filePath];
    if (!file) {
        file = instance.files[filePath] = <interfaces.TSFile> { version: 0 };
    }

    if (file.text !== contents) {
        file.version++;
        file.text = contents;
        instance.version++;
    }

    // push this file to modified files hash.
    if (!instance.modifiedFiles) {
        instance.modifiedFiles = {};
    }
    instance.modifiedFiles[filePath] = file;
    return file;
}

function mapObject<T, S>(obj: typescript.Map<T>, operator: (val: T) => S): typescript.Map<S> {
    const newObj: typescript.Map<S> = { __mapBrand: obj.__mapBrand };
    for (const symbol in obj) {
        if (symbol in obj && obj[symbol]) {
            newObj[symbol] = operator(obj[symbol]);
        }
    }

    return newObj;
}

function getEmit(
    filePath: string,
    instance: interfaces.TSInstance,
    loader: interfaces.Webpack
) {
    // Emit Javascript
    const output = instance.languageService.getEmitOutput(filePath);

    const program = instance.languageService.getProgram();
    const checker = program.getTypeChecker();

    type DocEntry = any;
    const inspections: { [key: string]: DocEntry } = {};

    console.log(filePath);

    const exports = checker.getSymbolAtLocation(program.getSourceFile(filePath)).exports;
    for (const symbol in exports) {
        if (symbol in exports) {
            try {
                const flags = exports[symbol].getFlags();
                if (flags | typescript.SymbolFlags.Function) {
                    inspections[(exports[symbol].valueDeclaration.name! as any).text] = serializeFunction(exports[symbol]);
                }
            } catch (e) {
                console.log("something's not working yet", e);
            }
        }
    }

    function serializeFunction(symbol: typescript.Symbol): DocEntry {
        const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration);
        return {
            name: symbol.getName(),
            documentation: typescript.displayPartsToString(symbol.getDocumentationComment()),
            type: 'function',
            parameters: type.getCallSignatures().map(serializeSignature),
        };
    }

    function serializeInterface(symbol: typescript.Symbol): DocEntry {
        return {
            name: symbol.getName(),
            documentation: typescript.displayPartsToString(symbol.getDocumentationComment()),
            type: 'interface',
            members: mapObject(symbol.members, serializeSymbol),
        };
    }

    /** Serialize a symbol into a json object */
    function serializeSymbol(symbol: typescript.Symbol): DocEntry {
        const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration);
        let serializedType: DocEntry | string;
        if (typeof type.symbol === "undefined") {
            serializedType = checker.typeToString(type);
        } else {
            serializedType = serializeInterface(type.symbol);
        }
        return {
            name: symbol.getName(),
            documentation: typescript.displayPartsToString(symbol.getDocumentationComment()),
            type: serializedType,
        };
    }

    /** Serialize a class symbol infomration */
    function serializeClass(symbol: typescript.Symbol) {
        const details = serializeSymbol(symbol);

        // Get the construct signatures
        const constructorType = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration);
        details.constructors = constructorType.getConstructSignatures().map(serializeSignature);
        return details;
    }

    /** Serialize a signature (call or construct) */
    function serializeSignature(signature: typescript.Signature) {
        return {
            parameters: signature.parameters.map(serializeSymbol),
            returnType: checker.typeToString(signature.getReturnType()),
            documentation: typescript.displayPartsToString(signature.getDocumentationComment())
        };
    }

    /** True if this is visible outside this file, false otherwise */
    function isNodeExported(node: typescript.Node): boolean {
        // tslint:disable-next-line:no-bitwise
        return (node.flags & typescript.NodeFlags.ExportContext) !== 0 || (node.parent && node.parent.kind === typescript.SyntaxKind.SourceFile);
    }
    // }
    //





































    // Make this file dependent on *all* definition files in the program
    loader.clearDependencies();
    loader.addDependency(filePath);

    const allDefinitionFiles = Object.keys(instance.files).filter(fp => definitionFileRegex.test(fp));
    allDefinitionFiles.forEach(loader.addDependency.bind(loader));

    /* - alternative approach to the below which is more correct but has a heavy performance cost
         see https://github.com/TypeStrong/ts-loader/issues/393
         with this approach constEnumReExportWatch test will pass; without it, not.

    // Additionally make this file dependent on all imported files as well
    // as any deeper recursive dependencies
    const additionalDependencies = utils.collectAllDependencies(instance.dependencyGraph, filePath);
    */

    // Additionally make this file dependent on all imported files
    const additionalDependencies = instance.dependencyGraph[filePath];
    if (additionalDependencies) {
        additionalDependencies.forEach(loader.addDependency.bind(loader));
    }

    loader._module.meta.tsLoaderDefinitionFileVersions = allDefinitionFiles
        .concat(additionalDependencies)
        .map((fp) => fp + '@' + (instance.files[fp] || {version: '?'}).version);

    let outputText = `
${fs.readFileSync(filePath).toString()}
`;

    for (const symbol in inspections) {
        if (symbol in inspections) {
            outputText += `
try {
    (${symbol} as any).__inspection = ${JSON.stringify(inspections[symbol])};
} catch (e) {
    console.log("can't apply inspection", e);
}
`;
        }
    }

    return { outputText };
}

function getTranspilationEmit(
    filePath: string,
    contents: string,
    instance: interfaces.TSInstance,
    loader: interfaces.Webpack
) {

    const fileName = path.basename(filePath);
    const transpileResult = instance.compiler.transpileModule(contents, {
        compilerOptions: instance.compilerOptions,
        reportDiagnostics: true,
        fileName,
    });

    const { outputText, sourceMapText, diagnostics } = transpileResult;

    utils.registerWebpackErrors(loader._module.errors, utils.formatErrors(diagnostics, instance.loaderOptions, instance.compiler, {module: loader._module}));

    return { outputText, sourceMapText };
}

function makeSourceMap(
    sourceMapText: string,
    outputText: string,
    filePath: string,
    contents: string,
    loader: interfaces.Webpack
) {
    if (!sourceMapText) {
        return { output: outputText, sourceMap: undefined as interfaces.SourceMap };
    }

    const sourceMap = JSON.parse(sourceMapText);
    sourceMap.sources = [loaderUtils.getRemainingRequest(loader)];
    sourceMap.file = filePath;
    sourceMap.sourcesContent = [contents];

    return {
        output: outputText.replace(/^\/\/# sourceMappingURL=[^\r\n]*/gm, ''),
        sourceMap
    };
}

export = loader;
