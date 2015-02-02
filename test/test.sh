cp node_modules/systemjs-builder/node_modules/systemjs/dist/system.js test/sample_app/
cp node_modules/systemjs-builder/node_modules/systemjs/node_modules/es6-module-loader/dist/es6-module-loader.js test/sample_app/
./test/assetGraphBuild.js
./test/assetGraphTrace.js
