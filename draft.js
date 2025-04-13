#!/usr/bin/env node
/**
 * deploy-metadata.js
 *
 * Automatiza o deploy de metadados do Salesforce com estilo funcional:
 * - Uso de early return para evitar aninhamentos profundos.
 * - Estrutura concisa e fácil de ler.
 *
 * Pré-requisitos:
 *   npm install fs-extra xml-js
 */

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const convert = require('xml-js');
const { injectHack } = require('./apexClassCoverageHack');

const DEPLOY_STAGING = path.join(process.cwd(), 'deploy-staging');
const NEWS_DIR = path.join(DEPLOY_STAGING, 'news', 'force-app', 'main', 'default');
const SANITIZED_DIR = path.join(DEPLOY_STAGING, 'sanitized', 'force-app', 'main', 'default');
const PACKAGES_DIR = path.join(DEPLOY_STAGING, 'packages');
const METADATA_STATES_FILE = path.join(DEPLOY_STAGING, 'metadata-original-states.json');

let originalStates = {};
// Helpers
const getAllFiles = (dirPath, files = []) => {
    if (!fs.existsSync(dirPath)) return files;
    fs.readdirSync(dirPath).forEach(file => {
        const fullPath = path.join(dirPath, file);
        if (fs.statSync(fullPath).isDirectory()) return getAllFiles(fullPath, files);
        files.push(fullPath);
    });
    return files;
};

const areFilesDifferent = (fileA, fileB) => {
    if (!fs.existsSync(fileB)) return true;
    const contentA = fs.readFileSync(fileA, 'utf8').replace(/^\s+|\s+$/gm, '');//removes leading and trailing spaces on each line
    const contentB = fs.readFileSync(fileB, 'utf8').replace(/^\s+|\s+$/gm, '');
    return contentA !== contentB;
};
const lockedFiles = new Set();
const getFileLock = async (...filePath) => {
    while (filePath.some(file => lockedFiles.has(file))) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    for (const file of filePath) {
        lockedFiles.add(file);
    }
}
const releaseFileLock = (...filePath) => filePath.forEach(file => lockedFiles.delete(file));
const CREATED_FILES_SET = new Set();
const CREATED_DIRS_SET = new Set();
const fileCounterPath = (filePath) => filePath.endsWith('-meta.xml') ? filePath.replace('-meta.xml', '') : filePath + '-meta.xml';
const copyFileWithStructure = async (filePath, sourceBase, destBase) => {
    const fileCounterPart = fileCounterPath(filePath);

    const relativePath = path.relative(sourceBase, filePath);
    const destPath = path.join(destBase, relativePath);

    const destCounterPath = fileCounterPath(destPath);
    const dirname = path.dirname(destPath);
    if (false === CREATED_DIRS_SET.has(dirname)) {
        CREATED_DIRS_SET.add(dirname);
        await fs.ensureDir(dirname);
    }

    if (!CREATED_FILES_SET.has(destPath) && !CREATED_FILES_SET.has(destCounterPath)) {
        CREATED_FILES_SET.add(destPath);
        await getFileLock(destPath, destCounterPath);
        await Promise.all([fs.copy(filePath, destPath), fs.copy(fileCounterPart, destCounterPath).catch(() => { })]);
        releaseFileLock(destPath, destCounterPath);
    }
};

const parseXml = xmlStr =>
    convert.xml2js(xmlStr, { compact: false, spaces: 4 });
const buildXml = jsonObj =>
    convert.js2xml(jsonObj, { compact: false, spaces: 4 });
const saveOriginalStates = () =>
    fs.writeJson(METADATA_STATES_FILE, originalStates, { spaces: 2 });

// Busca um elemento recursivamente; retorna null imediatamente se não encontrar.
const findElement = (xmlObj, nodeName) => {
    if (!xmlObj?.elements) return null;
    for (const elem of xmlObj.elements) {
        if (elem.name === nodeName) return elem;
        const found = findElement(elem, nodeName);
        if (found) return found;
    }
    return null;
};

// Remove todos os elementos com o nome dado usando uma abordagem funcional.
const removeElements = (xmlObj, nodeName) => {
    if (!xmlObj?.elements) return false;
    let modified = false;
    for (let i = xmlObj.elements.length - 1; i >= 0; i--) {
        const elem = xmlObj.elements[i];
        if (elem.name === nodeName) {
            xmlObj.elements.splice(i, 1);
            modified = true;
        } else {
            modified = removeElements(elem, nodeName) || modified;
        }
    }
    return modified;
};

// Remove o primeiro elemento encontrado com o nome dado.
const removeElement = (xmlObj, nodeName) => {
    if (!xmlObj?.elements) return;
    const index = xmlObj.elements.findIndex(e => e.name === nodeName);
    if (index !== -1) {
        xmlObj.elements.splice(index, 1);
        return;
    }
    xmlObj.elements.forEach(child => removeElement(child, nodeName));
};

// Processa actionOverrides em XML e marca para remoção se necessário.
const processActionOverrides = xmlObj => {
    if (!xmlObj?.elements) return false;
    let modified = false;
    xmlObj.elements = xmlObj.elements.filter(elem => {
        if (elem.name === 'actionOverrides') {
            const typeElem = findElement(elem, 'type');
            if (typeElem && typeElem.elements[0].text !== 'Default') {
                modified = true;
                return false;
            }
            const actionName = findElement(elem, 'actionName');
            if (actionName && typeElem.elements[0].text in ['ResumeBilling']) {
                modified = true;
                return false;
            }
        }
        modified = processActionOverrides(elem) || modified;
        return true;
    });
    return modified;
};

const os = require('os');
class ConcurrencyManager {
    constructor(maxConcurrent) {
        this.maxConcurrent = maxConcurrent;
        this.currentlyRunning = 0;
        this.queue = [];
        this.allTasksCompleted = new Promise(resolve => this.resolveAllTasks = resolve);
    }

    async run(task) {
        if (this.currentlyRunning >= this.maxConcurrent) {
            await new Promise(resolve => this.queue.push(resolve));
        }
        this.currentlyRunning++;
        try {
            await task();
        } finally {
            this.currentlyRunning--;
            if (this.queue.length > 0) {
                const next = this.queue.shift();
                next();
            } else if (this.currentlyRunning === 0) {
                this.resolveAllTasks();
            }
        }
    }

    async waitForAll() {
        await this.allTasksCompleted;
    }
}

const loadExceptionPaths = (exceptionPathFile) => {
    if (!fs.existsSync(exceptionPathFile)) {
        console.error(`Arquivo ${exceptionPathFile} não encontrado.`);
        process.exit(1);
    }

    try {
        const exceptionPaths = JSON.parse(fs.readFileSync(exceptionPathFile, 'utf8'));
        const parsedExceptions = {};
        for (const [exceptionKey, rule] of Object.entries(exceptionPaths)) {
            rule.includeTests ??= [];
            rule.ignoredPaths ??= [];
            parsedExceptions[exceptionKey] = { ignoredPaths: [], includeTests: [] };
            parsedExceptions[exceptionKey].ignoredPaths = rule.ignoredPaths.map(path => {
                // If the pattern starts with a "/" assume it is a regex literal.
                if (path.startsWith('/')) {
                    // Find the last slash – characters between the first and last slash are taken as the regex pattern; what's after is treated as flags.
                    const lastSlashIndex = path.lastIndexOf('/');
                    const patternBody = path.slice(1, lastSlashIndex);
                    const flags = path.slice(lastSlashIndex + 1); // This could be empty.
                    return new RegExp(patternBody, flags);
                } else {
                    // Otherwise, treat it as plain text by escaping regex characters.
                    return path;
                }
            });

            parsedExceptions[exceptionKey].includeTests = rule.includeTests.map(path => {
                // If the pattern starts with a "/" assume it is a regex literal.
                if (path.startsWith('/')) {
                    // Find the last slash – characters between the first and last slash are taken as the regex pattern; what's after is treated as flags.
                    const lastSlashIndex = path.lastIndexOf('/');
                    const patternBody = path.slice(1, lastSlashIndex);
                    const flags = path.slice(lastSlashIndex + 1); // This could be empty.
                    return new RegExp(patternBody, flags);
                } else {
                    // Otherwise, treat it as plain text by escaping regex characters.
                    return path;
                }
            });
        }

        return parsedExceptions;
    } catch (e) {
        console.error(`Erro ao carregar exceptionPath: ${e.message}`);
        process.exit(1);
    }
};

const isPathException = (relativePath, exceptions) => {
    const matchingPath = relativePath.split(path.sep).slice(1).join(path.sep);

    const pathDir = path.dirname(relativePath);
    for (const pattern of exceptions) {
        if (pattern instanceof RegExp && pattern.test(relativePath)) {
            return true;
        }
        if (typeof pattern === 'string') {
            const normalizedPattern = path.normalize(pattern);
            if (matchingPath.toLowerCase() === normalizedPattern.toLowerCase()) {
                return true;
            }
        }
    }
    return false;
};

// -------------------------------------------------------
// Fase 1: Identificação de Metadados Novos
// -------------------------------------------------------
const identifyNewMetadata = async ({ sourcePath, targetPath, debug, exceptionMap }) => {
    console.log('Fase 1: Identificação de metadados novos...');
    await fs.ensureDir(NEWS_DIR);
    const sourceFiles = getAllFiles(sourcePath);
    const copiedFiles = new Set();

    const isObjectRegex = /force-app\/main\/default\/objects\/([^\/]+)\//;
    const concurrencyManager = new ConcurrencyManager(os.cpus().length);

    for (const sourceFile of sourceFiles) {
        concurrencyManager.run(async () => {
            const relativePath = path.relative(sourcePath, sourceFile);
            const paths = path.dirname(relativePath).split(path.sep);
            const exceptionKey = paths[0];
            if (exceptionKey in exceptionMap && isPathException(relativePath, exceptionMap[exceptionKey].ignoredPaths ?? [])) {
                console.log(`Ignorado conforme exceptionPath.json: ${relativePath}`);
                return;
            }

            if (exceptionKey === 'standardValueSets' && sourceFile.endsWith('.xml')) {
                const xmlContent = fs.readFileSync(sourceFile, 'utf8');
                if (!xmlContent.includes('<standardValue>')) {
                    console.log(`Ignorando arquivo sem <standardValue>: ${relativePath}`);
                    return;
                }
            }

            if (exceptionKey === 'objects' && 3 === path.length && path[2].includes('listViews') && sourceFile.endsWith('-meta.xml')) {
                const xmlContent = fs.readFileSync(sourceFile, 'utf8');
                if (xmlContent.includes('<filterScope>Mine</filterScope>')) {
                    console.log(`Ignorando arquivo com <filterScope>Mine</filterScope>: ${relativePath}`);
                    return;
                }
            }

            const targetFile = path.join(targetPath, relativePath);
            const sourceFileCounterPath = fileCounterPath(sourceFile);

            if (copiedFiles.has(targetFile)) {
                return;
            }
            copiedFiles.add(sourceFileCounterPath);
            if (!fs.existsSync(targetFile)) {
                await copyFileWithStructure(sourceFile, sourcePath, NEWS_DIR);
                debug && console.log(`Novo: ${relativePath}`);
            } else if (areFilesDifferent(sourceFile, targetFile)) {
                await copyFileWithStructure(sourceFile, sourcePath, NEWS_DIR);
                debug && console.log(`Alterado: ${relativePath}`);
            } else {
                return;
            }

            const isAnyObjectPartBeingCopied = isObjectRegex.test(relativePath);
            if (isAnyObjectPartBeingCopied) {
                const objectName = relativePath.match(isObjectRegex)[1];
                const objectFile = path.join(sourcePath, 'force-app', 'main', 'default', 'objects', objectName, `${objectName}.object-meta.xml`);
                await copyFileWithStructure(objectFile, sourcePath, NEWS_DIR);
            }
        });
    }

    await concurrencyManager.waitForAll();
};

// -------------------------------------------------------
// Fase 2: Sanitização dos Metadados Novos
// ------------------------------------------------------
const sanitizeMetadata = async (exceptionMap) => {
    console.log('Fase 2: Sanitização dos metadados...');
    await fs.ensureDir(SANITIZED_DIR);
    const newsFiles = getAllFiles(NEWS_DIR);
    const testClassesCounterSet = new Set();
    const concurrencyManager = new ConcurrencyManager(os.cpus().length);
    const dirCreatedSet = new Set();

    for (const file of newsFiles) {
        concurrencyManager.run(async () => {
            const relativePath = path.relative(NEWS_DIR, file);
            const destSanitizedPath = path.join(SANITIZED_DIR, relativePath);

            // do not copy webLinks under objects
            if (relativePath.includes(path.join('objects', '')) && relativePath.includes(path.join('webLinks', ''))) {
                console.log(`Removendo webLinks: ${relativePath}`);
                return; // Skip copying this file
            }

            if (testClassesCounterSet.has(file)) {
                return;
            }

            const pathDir = path.dirname(relativePath);
            if (!file.endsWith('-meta.xml')) {
                await copyFileWithStructure(file, NEWS_DIR, SANITIZED_DIR);
                // For non-XML files, process as usual:
                if (pathDir === 'classes') {
                    // Presume injectHack returns an object where isTest indicates a test class
                    const { isTest } = await injectHack(destSanitizedPath);
                    const exceptionKey = path.dirname(relativePath).split(path.sep).pop().trim();
                    const mustIncludeTest = isTest && exceptionKey in exceptionMap && isPathException(relativePath, exceptionMap[exceptionKey].includeTests ?? []);

                    /*if (relativePath.includes('DataFactory')) {
                        console.log(isTest, mustIncludeTest, exceptionMap, exceptionKey, exceptionMap);
                        console.log(exceptionMap[exceptionKey].includeTests);
                        process.exit()
                    }*/

                    if (isTest && false === mustIncludeTest) {
                        // Add the -meta.xml counterPart
                        testClassesCounterSet.add(fileCounterPath(file));
                        console.log(`Ignorando test class: ${relativePath}`);
                        await Promise.all([fs.unlink(destSanitizedPath),
                        fs.unlink(fileCounterPath(destSanitizedPath))]);
                    }
                }
                return;
            }

            if (pathDir === 'classes') {//class xml will eventually end up here while its counterpart is being processed above in injectHack
                return;
            }

            let xmlContent = fs.readFileSync(file, 'utf8');
            let xmlObj;
            try {
                xmlObj = parseXml(xmlContent);
            } catch (error) {
                console.error(`Erro no XML (${relativePath}): ${error.message}`);
                process.exit(1);
            }

            let modified = false;
            const pathDirs = path.dirname(relativePath).split(path.sep);

            if (pathDirs[0] === 'permissionsets') {
                const permissionSetElem = findElement(xmlObj, 'PermissionSet');
                if (permissionSetElem) {
                    permissionSetElem.elements = permissionSetElem.elements.filter(elem => elem.name === 'label');
                    modified = true;
                    console.log(`Corpo do PermissionSet removido: ${relativePath}`);
                }
            }

            // Flows: remover <areMetricsLoggedToDataCloud>
            if (pathDirs[0] === 'flows') {
                modified = removeElements(xmlObj, 'areMetricsLoggedToDataCloud') || modified;
                if (modified) console.log(`Elementos <areMetricsLoggedToDataCloud> removidos: ${relativePath}`);

                modified = removeElements(xmlObj, 'offset') || modified;
                if (modified) console.log(`Elementos <areMetricsLoggedToDataCloud> removidos: ${relativePath}`);

                modified = removeElements(xmlObj, 'customErrors') || modified;
                if (modified) console.log(`Elementos <areMetricsLoggedToDataCloud> removidos: ${relativePath}`);
            }

            // queueRoutingConfigs: remover <capacityType>
            if (pathDirs[0] === 'queueRoutingConfigs') {
                modified = removeElements(xmlObj, 'capacityType') || modified;
                if (modified) console.log(`Elementos <areMetricsLoggedToDataCloud> removidos: ${relativePath}`);
            }

            // Flow Definitions: remove <activeVersionNumber>
            if (pathDirs[0] === 'flowDefinitions') {
                const activeVersionElem = findElement(xmlObj, 'activeVersionNumber');
                if (!activeVersionElem) {
                    return; // já está inativado
                }
                originalStates[relativePath] = { type: 'FlowDefinition', originalValue: activeVersionElem.elements[0].text };
                removeElement(xmlObj, 'activeVersionNumber');
                modified = true;
                console.log(`FlowDefinition desativada: ${relativePath}`);
            }

            // Triggers: muda de Active para Inactive
            /*if (pathDirs[0] === 'triggers') {
                const statusElem = findElement(xmlObj, 'status');
                if (!statusElem) {
                    console.error(`Elemento <status> ausente: ${relativePath}`);
                    process.exit(1);
                }
                if (statusElem.elements[0].text === 'Active') {
                    originalStates[relativePath] = { type: 'Trigger', originalValue: 'Active' };
                    statusElem.elements[0].text = 'Inactive';
                    modified = true;
                    console.log(`Trigger inativada: ${relativePath}`);
                }
            }
                QUando sobe Inact, Salesforce é incapaz de testart a trigger, logo falha.*/

            // Validation Rules: desativa se <active> estiver true
            if (pathDirs[0] === 'objects' && relativePath.includes(path.join('validationRules', ''))) {
                const ruleElem = findElement(xmlObj, 'active');
                if (!ruleElem) {
                    console.error(`Elemento <active> ausente: ${relativePath}`);
                    process.exit(1);
                }
                if (ruleElem.elements[0].text === 'true') {
                    originalStates[relativePath] = { type: 'ValidationRule', originalValue: 'true' };
                    ruleElem.elements[0].text = 'false';
                    modified = true;
                    console.log(`Validation rule desativada: ${relativePath}`);
                }
            }

            // Objects: processa actionOverrides e compactLayoutAssignment
            if (pathDirs[0] === 'objects' && file.endsWith('.object-meta.xml')) {
                modified = processActionOverrides(xmlObj) || modified;
                const compactElem = findElement(xmlObj, 'compactLayoutAssignment');
                if (compactElem) {
                    compactElem.elements[0].text = 'SYSTEM';
                    modified = true;
                }
                if (modified) console.log(`Object ajustado: ${relativePath}`);
            }

            // Queues: remove <queueMembers>
            if (relativePath.includes(path.join('queues', ''))) {
                modified = removeElements(xmlObj, 'queueMembers') || modified;
                if (modified) console.log(`QueueMembers removido: ${relativePath}`);
            }

            const finalXml = modified ? buildXml(xmlObj) : xmlContent;

            const dirPath = path.dirname(destSanitizedPath);
            dirCreatedSet.has(dirPath) === false && await fs.ensureDir(path.dirname(destSanitizedPath));
            dirCreatedSet.add(dirPath);
            await getFileLock(destSanitizedPath);
            fs.writeFileSync(destSanitizedPath, finalXml, 'utf8');
            releaseFileLock(destSanitizedPath);

        });
    }

    await concurrencyManager.waitForAll();
    await saveOriginalStates();
};

// -------------------------------------------------------
// Fase 3: Gerar Pacotes de Deploy
// -------------------------------------------------------
const PACKAGES = {
    package0: {
        components: ['permissionsets', 'customPermissions']
    },
    package1: {
        components: ['labels', 'standardValueSets', 'groups', 'objects', 'customMetadata', 'queues', 'queueRoutingConfigs', 'remoteSiteSettings']
    },
    package2: {
        components: ['globalValueSets', 'staticresources']
    },
    package3: {
        components: ['tabs', 'classes', 'triggers', 'pages', 'lwc', 'aura']
    },
    package4: {
        components: ['flows', 'flowDefinitions', /*'Email', 'letterhead', feito deploy direto da pasta hml, " Unable to calculate fullName from component at path: (EmailTemplate)"*/ 'labels', 'SharingRules', 'workflows', /*'assignmentRules,' só tem lead e case, sem alteração no CRM*/ 'approvalProcesses']//alguns flows usam email alerts que ficam dentro de workflows
    },
    package5: {
        components: []
    },
    package6: {
        components: []
    },
    package7: {
        components: []
    },
    package8: {
        components: []
    },
    package9: {
        components: []
    },
    package10: {
        baseSource: NEWS_DIR,
        components: ['objects', 'applications', 'quickActions', 'layouts', 'flexiPages']
    },
    package11: {
        baseSource: NEWS_DIR,
        components: ['profiles', 'permissionsets', 'customPermissions', 'permissionsetgroups']
    },
    package12: {
        components: ['Roles']//roles são necessários para sharingRules, subir antes deles
    },
    package13: {
        components: []//objectTranslations
    }
};
const generateDeployPackages = async () => {
    console.log('Fase 3: Gerando pacotes de deploy...');
    // Define your packages along with an optional baseSource per package.

    const concurrencyManager = new ConcurrencyManager(os.cpus().length);
    // Process each package using the defined baseSource (default to SANITIZED_DIR)
    for (const [pkgName, { components, baseSource = SANITIZED_DIR }] of Object.entries(PACKAGES)) {
        concurrencyManager.run(async () => {
            const pkgDir = path.join(PACKAGES_DIR, pkgName, 'force-app', 'main', 'default');
            await fs.ensureDir(pkgDir);
            console.log(`Criando pacote ${pkgName} com [${components.join(', ')}] usando base "${baseSource === NEWS_DIR ? 'NEWS_DIR' : 'SANITIZED_DIR'}"`);

            // For each component, copy its folder structure from the specified baseSource
            for (const comp of components) {
                const compSourceDir = path.join(baseSource, comp);
                if (!fs.existsSync(compSourceDir)) {
                    continue;
                }
                const destDir = path.join(pkgDir, comp);
                await fs.copy(compSourceDir, destDir);
            }
        });

    }
    await concurrencyManager.waitForAll();
};
// Function to generate deployment commands
const generateDeployCommands = async () => {
    const specifiedTestsPath = path.join(process.cwd(), 'specifiedTests.txt');
    const specifiedTests = fs.existsSync(specifiedTestsPath) ? fs.readFileSync(specifiedTestsPath, 'utf8') : '';
    const deployCommandsPath = path.join(process.cwd(), 'deployCommands.txt');

    const commands = Object.entries(PACKAGES).map(([pkgName, { components }], index) => {
        if (components.length === 0) return '';

        const packageDir = path.relative(process.cwd(), path.join(DEPLOY_STAGING, 'packages', pkgName)).split(path.sep).join(path.posix.sep);
        const testOption = pkgName === 'package3' ? specifiedTests : '-t "Dummy"';
        const command = `sf project deploy validate --source-dir ./${packageDir} --source-dir ./DummyTest.cls -l RunSpecifiedTests ${testOption} --target-org`;

        return `---------------- PACKAGE${index} ----------------\n${command}\n---------------- PACKAGE${index} ----------------`;
    }).filter(Boolean).join('\n\n');

    fs.writeFileSync(deployCommandsPath, commands, 'utf8');
    console.log('Deployment commands written to deployCommands.txt');
};
// -------------------------------------------------------
// Fase 4: Deploy
// -------------------------------------------------------
const deployPackages = async () => {
    throw 'Não usar esta função a menos que saiba realmente o que está fazendo!';
    console.log('Fase 4: Deploy dos pacotes...');
    const packageOrder = ['package1', 'package2', 'package3', 'package4', 'package5', 'package6', 'package7', 'package8', 'package9', 'package10', 'package11', 'package12'];

    for (const pkgName of packageOrder) {
        const pkgPath = path.join(PACKAGES_DIR, pkgName);
        console.log(`Deploy do pacote ${pkgName} – ${pkgPath}`);
        try {
            execSync(`sf project deploy start -d ${pkgPath} --json`, { stdio: 'inherit' });
            console.log(`Pacote ${pkgName} deploy com sucesso.`);
        } catch (error) {
            console.error(`Deploy falhou em ${pkgName}: ${error.message}`);
            process.exit(1);
        }
    }
};

// -------------------------------------------------------
// Fase 5: Pós-Deploy – Reativação
// -------------------------------------------------------
const postDeploy = async () => {
    console.log('Fase 5: Pós-deploy (Reativação)...');
    const reactivationDir = path.join(DEPLOY_STAGING, 'reactivation');
    await fs.ensureDir(reactivationDir);
    const reactivationPackageDir = path.join(reactivationDir, 'force-app', 'main', 'default');
    await fs.ensureDir(reactivationPackageDir);

    Object.entries(originalStates).forEach(([filePath, state]) => {
        const fileName = path.basename(filePath);
        const targetFile = path.join(reactivationPackageDir, filePath);
        fs.ensureDirSync(path.dirname(targetFile));
        let reactivationXml = '';
        if (state.type === 'ValidationRule') {
            reactivationXml = `<ValidationRule><fullName>${fileName.replace('.validationRule-meta.xml', '')}</fullName><active>true</active></ValidationRule>`;
        } else if (state.type === 'FlowDefinition') {
            reactivationXml = `<FlowDefinition><fullName>${fileName.replace('-meta.xml', '')}</fullName><activeVersionNumber>${state.originalValue}</activeVersionNumber></FlowDefinition>`;
        } else if (state.type === 'Trigger') {
            reactivationXml = `<Trigger><fullName>${fileName.replace('-meta.xml', '')}</fullName><status>Active</status></Trigger>`;
        }
        fs.writeFileSync(targetFile, reactivationXml, 'utf8');
        console.log(`Reativação criada: ${targetFile}`);
    });

    try {
        execSync(`sf project deploy start -d ${reactivationDir} --json`, { stdio: 'inherit' });
        console.log('Reativação deploy concluído.');
    } catch (error) {
        console.error(`Falha no deploy de reativação: ${error.message}`);
        process.exit(1);
    }
};
const wipeDirectories = async () => {
    try {
        await Promise.all([
            fs.remove(DEPLOY_STAGING)
        ]);
        console.log('Diretórios limpos: news, sanitized, packages');
    } catch (err) {
        console.error('Erro ao limpar diretórios:', err);
        process.exit(1);
    }
};

const ensureSfdxProjectJson = async () => {
    const sfdxProjectPath = path.join(process.cwd(), 'sfdx-project.json');
    if (!fs.existsSync(sfdxProjectPath)) {
        const sfdxProjectContent = {
            packageDirectories: [
                {
                    path: ".",
                    default: true
                }
            ],
            name: "RTFYUIOPIUIYYTUIOPTYUIO",
            namespace: "",
            sfdcLoginUrl: "https://login.salesforce.com",
            sourceApiVersion: "62.0"
        };
        await fs.writeJson(sfdxProjectPath, sfdxProjectContent, { spaces: 2 });
        console.log('sfdx-project.json created.');
    } else {
        console.log('Skipping sfdx-project.json creation...');
    }
};
// -------------------------------------------------------
// Função Principal
// -------------------------------------------------------
const main = async () => {
    const { parseArgs } = require('node:util');
    const { values: args } = parseArgs({
        options: {
            sourcePath: { type: 'string', short: 's' },
            targetPath: { type: 'string', short: 't' },
            debug: { type: 'boolean', short: 'd' }
        }
    });

    const sourcePath = args.sourcePath;
    const targetPath = args.targetPath;
    const debug = args.debug;

    if (!sourcePath || !targetPath) {
        console.error('Uso: node deploy-metadata.js --sourcePath=<origem> --targetPath=<destino>');
        console.error('Exemplo: node deploy-metadata.js --sourcePath=/path/to/source --targetPath=/path/to/target');
        process.exit(1);
    }
    const EXCEPTION_PATH_FILE = path.join(process.cwd(), 'exceptionPath.json');
    const exceptionMap = loadExceptionPaths(EXCEPTION_PATH_FILE);
    try {
        ensureSfdxProjectJson();
        await wipeDirectories();
        await identifyNewMetadata({ sourcePath, targetPath, debug, exceptionMap });
        await sanitizeMetadata(exceptionMap);
        await generateDeployPackages();
        const { processApexFiles } = require('./listTests');
        const package3Dir = path.join(PACKAGES_DIR, 'package3', 'force-app', 'main', 'default', 'classes');
        const outputFile = path.join(process.cwd(), 'specifiedTests.txt');
        processApexFiles(package3Dir, outputFile);
        await generateDeployCommands();
        console.log('Pacotes para deploy gerados com sucesso.');
        console.log('Versão 2025-04-11 08:17');
    } catch (err) {
        console.error('Erro no processo:', err);
        process.exit(1);
    }
};

main();

//script usage: node deploy-metadata.js --sourcePath=/path/to/hml/force-app/main/default --targetPath=./path/to/miniprod/force-app/main/default
//deve ser testado os métodos:
//await identifyNewMetadata(sourcePath, targetPath);
//await sanitizeMetadata();
//await generateDeployPackages();