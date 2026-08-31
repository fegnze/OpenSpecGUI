'use strict';

var crypto = require('node:crypto');
var fs = require('node:fs');
var path = require('node:path');
var asar = require('@electron/asar');

var SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64']);
var SOURCE_EXTENSIONS = new Set(['.css', '.html', '.js']);
var PRODUCT_NAME = 'OpenSpec GUI';

function verificationError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
}

function collectProductionSourceFiles(sourceRoot) {
    var files = [];

    function collect(directory) {
        fs.readdirSync(directory, { withFileTypes: true }).sort(function (left, right) {
            return left.name.localeCompare(right.name);
        }).forEach(function (entry) {
            var target = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                collect(target);
            } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
                files.push(target);
            }
        });
    }

    collect(sourceRoot);
    return files;
}

function sourceDigest(entries) {
    var digest = crypto.createHash('sha256');
    entries.forEach(function (entry) {
        digest.update(entry.relativePath);
        digest.update('\0');
        digest.update(entry.content);
        digest.update('\0');
    });
    return digest.digest('hex');
}

function resolvePackagePaths(options) {
    var projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, '..'));
    var outputRoot = path.resolve(options.outputRoot || path.join(projectRoot, 'out'));
    var productName = options.productName || PRODUCT_NAME;
    var outputDirectory = productName + '-darwin-' + options.arch;
    var appPath = path.join(outputRoot, outputDirectory, productName + '.app');

    return {
        projectRoot: projectRoot,
        appPath: appPath,
        asarPath: path.join(appPath, 'Contents', 'Resources', 'app.asar')
    };
}

function verifyPackage(options) {
    options = options || {};
    var arch = options.arch;
    if (!SUPPORTED_ARCHITECTURES.has(arch)) {
        throw verificationError('ARCH_UNSUPPORTED', 'Unsupported macOS architecture: ' + String(arch));
    }

    var packagePaths = resolvePackagePaths(options);
    if (!fs.existsSync(packagePaths.appPath)) {
        throw verificationError('APP_MISSING', 'Missing ' + arch + ' application bundle: ' + packagePaths.appPath);
    }
    if (!fs.existsSync(packagePaths.asarPath)) {
        throw verificationError('ASAR_MISSING', 'Missing ' + arch + ' app.asar: ' + packagePaths.asarPath);
    }

    var sourceRoot = path.join(packagePaths.projectRoot, 'src');
    if (!fs.existsSync(sourceRoot)) {
        throw verificationError('SOURCE_MISSING', 'Missing production source directory: ' + sourceRoot);
    }

    var sourceEntries = collectProductionSourceFiles(sourceRoot).map(function (sourcePath) {
        var relativePath = path.relative(packagePaths.projectRoot, sourcePath).split(path.sep).join('/');
        return {
            relativePath: relativePath,
            content: fs.readFileSync(sourcePath)
        };
    });
    if (sourceEntries.length === 0) {
        throw verificationError('SOURCE_EMPTY', 'No production text sources found under: ' + sourceRoot);
    }

    sourceEntries.forEach(function (entry) {
        var packagedContent;
        try {
            packagedContent = asar.extractFile(packagePaths.asarPath, entry.relativePath);
        } catch (error) {
            throw verificationError('SOURCE_MISSING_FROM_ASAR', arch + ' package is missing ' + entry.relativePath + ': ' + error.message);
        }
        if (!entry.content.equals(packagedContent)) {
            throw verificationError('SOURCE_MISMATCH', arch + ' package source differs from workspace: ' + entry.relativePath);
        }
    });

    return {
        arch: arch,
        appPath: packagePaths.appPath,
        asarPath: packagePaths.asarPath,
        sourceFileCount: sourceEntries.length,
        sourceDigest: sourceDigest(sourceEntries)
    };
}

function parseArguments(argumentsList) {
    var options = {};
    for (var index = 0; index < argumentsList.length; index += 1) {
        var argument = argumentsList[index];
        if (argument === '--arch' || argument === '--project-root' || argument === '--output-root') {
            var value = argumentsList[index + 1];
            if (!value) {
                throw verificationError('ARGUMENT_VALUE_MISSING', 'Expected a value after ' + argument);
            }
            options[argument.slice(2).replace(/-([a-z])/g, function (_, letter) {
                return letter.toUpperCase();
            })] = value;
            index += 1;
        } else {
            throw verificationError('ARGUMENT_UNKNOWN', 'Unknown argument: ' + argument);
        }
    }
    return options;
}

if (require.main === module) {
    try {
        var result = verifyPackage(parseArguments(process.argv.slice(2)));
        console.log('Verified ' + result.arch + ' package at ' + result.appPath + ' (' + result.sourceFileCount + ' source files, sha256 ' + result.sourceDigest + ').');
    } catch (error) {
        console.error('Package verification failed: ' + error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    collectProductionSourceFiles: collectProductionSourceFiles,
    parseArguments: parseArguments,
    resolvePackagePaths: resolvePackagePaths,
    verifyPackage: verifyPackage
};
