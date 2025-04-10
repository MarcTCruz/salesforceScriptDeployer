const fs = require('fs');
const path = require('path');

function processApexFiles(directory, outputFile) {
  const files = fs.readdirSync(directory);
  const testClasses = [];

  files.forEach(file => {
    if (path.extname(file) === '.cls') {
      const filePath = path.join(directory, file);
      let content = fs.readFileSync(filePath, 'utf8');

      // Remove single-line and multi-line comments
      content = content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');

      // Check for @IsTest annotation
      if (/@isTest/i.test(content)) {
        testClasses.push(file.substring(0, file.length - 4)); // Remove the .cls extension
      }
    }
  });

  // Write the list of test classes to the output file
  fs.writeFileSync(outputFile, '--tests "' + testClasses.join('"\n --tests "') + '"', 'utf8');
}

// Example usage
processApexFiles('./deploy-staging/packages/package3/force-app/main/default/classes', './specifiedTests.txt');