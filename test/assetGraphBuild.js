#!/usr/bin/env node

var AssetGraph = require('assetgraph');

var outRoot = 'test/sample_app_built';

new AssetGraph({ root: 'test/sample_app' })
.loadAssets(['*.html', '*.js'])
.queue(require('../')({
  bundle: true,
  outRoot: outRoot
}))
.writeAssetsToDisc({ url: /^file:/, isLoaded: true }, outRoot)
.writeStatsToStderr()
.run(function(err) {
  if (err) {
    console.log(err);
    throw err;
  }
});