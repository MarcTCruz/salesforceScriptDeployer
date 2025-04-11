const fs = require('fs');
const path = require('path');

function processApexFiles(directory, outputFile) {
  const files = fs.readdirSync(directory);
  const testClasses = [];

  files.forEach(file => {
    if (path.extname(file) === '.cls') {
      const filePath = path.join(directory, file);
      let content = fs.readFileSync(filePath, 'utf8');

      content = content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');

      if (/@isTest/i.test(content)) {
        testClasses.push(file.substring(0, file.length - 4));
      }
    }
  });

  fs.writeFileSync(outputFile, '-t "' + testClasses.join('" "') + '"', 'utf8');
}

module.exports = { processApexFiles };

// Example usage
//processApexFiles('./deploy-staging/packages/package3/force-app/main/default/classes', './specifiedTests.txt');