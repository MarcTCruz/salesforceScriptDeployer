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

const DEPLOY_STAGING = path.join(process.cwd(), 'deploy-staging');
const NEWS_DIR = path.join(DEPLOY_STAGING, 'news', 'force-app', 'main');
const SANITIZED_DIR = path.join(DEPLOY_STAGING, 'sanitized', 'force-app', 'main');
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

const fileCounterPath = (filePath) => filePath.endsWith('-meta.xml') ? filePath.replace('-meta.xml', '') : filePath + '-meta.xml';
const copyFileWithStructure = async (filePath, sourceBase, destBase) => {
    const fileCounterPart = fileCounterPath(filePath);

    const relativePath = path.relative(sourceBase, filePath);
    const destPath = path.join(destBase, relativePath);

    const destCounterPath = fileCounterPath(destPath);
    await fs.ensureDir(path.dirname(destPath));
    await Promise.all([fs.copy(filePath, destPath), fs.copy(fileCounterPart, destCounterPath).catch(() => { })]);
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
            if (typeElem && typeElem.elements[0].text in ['ResumeBilling']) {
                modified = true;
                return false;
            }
        }
        modified = processActionOverrides(elem) || modified;
        return true;
    });
    return modified;
};

// -------------------------------------------------------
// NOVA FUNÇÃO: Retorna os fullName dos CustomObjects idless
// -------------------------------------------------------
const IGNORE_OBJECTS_FILE = path.join(DEPLOY_STAGING, 'ignoreObjects.json');
const loadIgnoreObjects = () => {
    if (!fs.existsSync(IGNORE_OBJECTS_FILE)) {
        console.error(`Arquivo ${IGNORE_OBJECTS_FILE} não encontrado.`);
        process.exit(1);
    }

    try {
        const ignoreObjects = JSON.parse(fs.readFileSync(IGNORE_OBJECTS_FILE, 'utf8'));
        if (!Array.isArray(ignoreObjects)) {
            throw new Error('O arquivo ignoreObjects.json deve conter uma lista de strings.');
        }
        return new Set(ignoreObjects);
    } catch (e) {
        console.error(`Erro ao carregar ignoreObjects: ${e.message}`);
        process.exit(1);
    }
};

// -------------------------------------------------------
// Fase 1: Identificação de Metadados Novos
// -------------------------------------------------------
const identifyNewMetadata = async (sourcePath, targetPath, ignoreObjects) => {
    console.log('Fase 1: Identificação de metadados novos...');
    await fs.ensureDir(NEWS_DIR);
    const sourceFiles = getAllFiles(sourcePath);
    const copiedObjects = new Set();
    const copiedFiles = new Set();

    // Regex para identificar a pasta de um objeto.
    const isObjectRegex = /force-app\/main\/default\/objects\/([^\/]+)\//;

    for (const sourceFile of sourceFiles) {
        const relativePath = path.relative(sourcePath, sourceFile);

        // Se o arquivo pertence a um objeto, verifique se o objeto estiver na lista idless.
        if (relativePath.includes(path.join('force-app', 'main', 'default', 'objects') + path.sep)) {
            const match = isObjectRegex.exec(relativePath);
            if (match) {
                const objectName = match[1];
                if (ignoreObjects.has(objectName)) {
                    console.log(`Ignorado conforme ignoreObjects.json: ${relativePath}`);
                    continue;
                }
            }
        }

        if (relativePath.includes(path.join('standardValueSets', '')) && sourceFile.endsWith('.xml')) {
            const xmlContent = fs.readFileSync(sourceFile, 'utf8');
            if (false === xmlContent.includes('<standardValue>')) {
                console.log(`Ignorando arquivo com <standardValue>: ${relativePath}`);
                continue;
            }
        }

        if (relativePath.includes(path.join('objects', '')) && relativePath.includes(path.join('listViews', '')) && sourceFile.endsWith('-meta.xml')) {
            const xmlContent = fs.readFileSync(sourceFile, 'utf8');
            if (xmlContent.includes('<filterScope>Mine</filterScope>')) {
                console.log(`Ignorando arquivo com <filterScope>Mine</filterScope>: ${relativePath}`);
                continue;
            }
        }

        const targetFile = path.join(targetPath, relativePath);
        const targetCounterPath = fileCounterPath(targetFile);

        if (copiedFiles.has(relativePath)) {
            continue;
        }

        if (!fs.existsSync(targetFile)) {
            await copyFileWithStructure(sourceFile, sourcePath, NEWS_DIR);
            copiedFiles.add(targetCounterPath);
            console.log(`Novo: ${relativePath}`);
        } else if (areFilesDifferent(sourceFile, targetFile)) {
            await copyFileWithStructure(sourceFile, sourcePath, NEWS_DIR);
            copiedFiles.add(targetCounterPath);
            console.log(`Alterado: ${relativePath}`);
        } else {
            continue; // early return: nada a fazer
        }

        // Processa pastas de objetos para garantir que o arquivo XML do objeto seja copiado.
        if (isObjectRegex.test(relativePath)) {
            const objectName = relativePath.match(isObjectRegex)[1];
            if (copiedObjects.has(objectName)) {
                continue;
            }

            const objectFile = path.join(sourcePath, 'force-app', 'main', 'default', 'objects', objectName, `${objectName}.object-meta.xml`);
            const objectRelative = path.relative(sourcePath, objectFile);
            copiedObjects.add(objectName);
            if (!fs.existsSync(path.join(NEWS_DIR, objectRelative))) {
                await copyFileWithStructure(objectFile, sourcePath, NEWS_DIR);
            }
        }
    }
};

// -------------------------------------------------------
// Fase 2: Sanitização dos Metadados Novos
// -------------------------------------------------------
const sanitizeMetadata = async () => {
    console.log('Fase 2: Sanitização dos metadados...');
    await fs.ensureDir(SANITIZED_DIR);
    const newsFiles = getAllFiles(NEWS_DIR);

    for (const file of newsFiles) {
        const relativePath = path.relative(NEWS_DIR, file);
        const destSanitizedPath = path.join(SANITIZED_DIR, relativePath);

        // do not copy webLinks under objects
        if (relativePath.includes(path.join('objects', '')) && relativePath.includes(path.join('webLinks', ''))) {
            console.log(`Removendo webLinks: ${relativePath}`);
            continue; // Skip copying this file
        }

        if (!file.endsWith('-meta.xml')) {
            await copyFileWithStructure(file, NEWS_DIR, SANITIZED_DIR);
            continue;
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

        if (relativePath.includes(path.join('permissionsets', ''))) {
            xmlContent = '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"></PermissionSet>';
            modified = true;
            console.log(`Corpo do PermissionSet removido: ${relativePath}`);
        }

        // Validation Rules: desativa se <active> estiver true
        if (relativePath.includes(path.join('objects', '')) && relativePath.includes(path.join('validationRules', ''))) {
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



        // Flows: remover <areMetricsLoggedToDataCloud>
        if (relativePath.includes(path.join('flows', ''))) {
            modified = removeElements(xmlObj, 'areMetricsLoggedToDataCloud') || modified;
            if (modified) console.log(`Elementos <areMetricsLoggedToDataCloud> removidos: ${relativePath}`);
        }

        // Flow Definitions: remove <activeVersionNumber>
        if (relativePath.includes(path.join('flowDefinitions', ''))) {
            const activeVersionElem = findElement(xmlObj, 'activeVersionNumber');
            if (!activeVersionElem) {
                continue; // já está inativado
            }
            originalStates[relativePath] = { type: 'FlowDefinition', originalValue: activeVersionElem.elements[0].text };
            removeElement(xmlObj, 'activeVersionNumber');
            modified = true;
            console.log(`FlowDefinition desativada: ${relativePath}`);
        }

        // Triggers: muda de Active para Inactive
        if (relativePath.includes(path.join('triggers', ''))) {
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

        // Objects: processa actionOverrides e compactLayoutAssignment
        if (relativePath.includes(path.join('objects', '')) && file.endsWith('.object-meta.xml')) {
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
        await fs.ensureDir(path.dirname(destSanitizedPath));
        fs.writeFileSync(destSanitizedPath, finalXml, 'utf8');
    }

    await saveOriginalStates();
};

// -------------------------------------------------------
// Fase 3: Gerar Pacotes de Deploy
// -------------------------------------------------------
const generateDeployPackages = async () => {
    console.log('Fase 3: Gerando pacotes de deploy...');

        </div >
    );
// Define your packages along with an optional baseSource per package.
const packages = {
    package0: {
        components: ['permissionsets', 'customPermissions']
    },
    package1: {
        components: ['labels', 'standardValueSets', 'groups', 'objects', 'customMetadata', 'queues', 'queueRoutingConfigs', 'remoteSiteSettings']
    },
    package2: {
        components: ['globalValueSets', 'objects']
    },
    package3: {
        components: ['tabs', 'classes', 'triggers']
    },
    package4: {
        components: ['flows', 'flowDefinitions', 'Email', 'labels']
    },
    package5: {
        components: ['SharingRules', 'workflows', 'assignmentRules', 'approvalProcesses']
    },
    package6: {
        components: ['lwc', 'aura', 'pages']
    },
    package7: {
        components: ['staticresources']
    },
    package8: {
        components: ['quickActions', 'layouts', 'flexiPages']
    },
    package9: {
        components: ['applications']
    },
    package10: {
        baseSource: NEWS_DIR,
        components: ['objects']
    },
    package11: {
        baseSource: NEWS_DIR,
        components: ['profiles', 'permissionsets', 'customPermissions', 'permissionsetgroups']
    },
    package12: {
        components: ['Roles']
    },
    package13: {
        components: ['objectTranslations']
    }
};

// Process each package using the defined baseSource (default to SANITIZED_DIR)
for (const [pkgName, { components, baseSource = SANITIZED_DIR }] of Object.entries(packages)) {
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
}
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
            fs.remove(NEWS_DIR),
            fs.remove(SANITIZED_DIR),
            fs.remove(PACKAGES_DIR)
        ]);
        console.log('Diretórios limpos: news, sanitized, packages');
    } catch (err) {
        console.error('Erro ao limpar diretórios:', err);
        process.exit(1);
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
            "target-org": { type: 'string', short: 'o' }
        }
    });

    const sourcePath = args.sourcePath;
    const targetPath = args.targetPath;
    const targetOrg = args["target-org"];

    if (!sourcePath || !targetPath || !targetOrg) {
        console.error('Uso: node deploy-metadata.js --sourcePath=<origem> --targetPath=<destino> --target-org=<targetOrg>');
        console.error('Exemplo: node deploy-metadata.js --sourcePath=/path/to/source --targetPath=/path/to/target --target-org=myOrg');
        process.exit(1);
    }

    const idlessObjects = loadIgnoreObjects(targetOrg);
    ignoreObjects = new Set(idlessObjects);
    try {
        await wipeDirectories();
        await identifyNewMetadata(sourcePath, targetPath, ignoreObjects);
        await sanitizeMetadata();
        await generateDeployPackages();
        console.log('Pacotes para deploy gerados com sucesso.');
    } catch (err) {
        console.error('Erro no processo:', err);
        process.exit(1);
    }
};

main();

//script usage: node deploy-metadata.js --sourcePath=/path/to/hml/force-app/main/default --targetPath=./path/to/miniprod/force-app/main/default --target-org=<targetOrg>
//deve ser testado os métodos:
//await identifyNewMetadata(sourcePath, targetPath);
//await sanitizeMetadata();
//await generateDeployPackages();