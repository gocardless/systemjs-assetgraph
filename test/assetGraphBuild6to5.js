#!/usr/bin/env node

var AssetGraph = require('assetgraph');

var outRoot = 'test/sample_app_built_6to5';

new AssetGraph({ root: 'test/sample_app' })
.loadAssets(['*.html', '*.js'])
.queue(require('../')({
  bundle: true,
  outRoot: outRoot,
  transpiler: '6to5',
}))
.writeAssetsToDisc({ url: /^file:/, isLoaded: true }, outRoot)
.writeStatsToStderr()
.run(function(err) {
  if (err) {
    console.log(err);
    throw err;
  }
});
