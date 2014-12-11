SystemJS AssetGraph
===

An AssetGraph transform plugin to automatically detect and optimize the use of SystemJS in HTML files.

It works out the main entry point and configuration file for the HTML asset, and then generates the [SystemJS bundle](https://github.com/systemjs/builder),
or [injects the depcache if using HTTP/2 for optimization](#http-2-optimization).

### Installation

npm install assetgraph systemjs-assetgraph

### Usage

Consider a simple SystemJS application:

app/main.html
```html
<html>
  <script src="system.js"></script>
  <script src="config.js"></script>
  <script>System.import('main')</script>
```

We can build this with:

build.js
```javascript
var AssetGraph = require('assetgraph');
var systemJsAssetGraph = require('systemjs-assetgraph');

var outRoot = 'app-built';

new AssetGraph({root: 'app'})
  .loadAssets(['*.html', '*.js'])
  .queue(systemJsAssetGraph({
    outRoot: 'app-built',
    bundle: true
  }))
  .writeAssetsToDisc({url: /^file:/}, 'app-built')
  .run(function (err) {
    if (err) throw err;
    console.log('Done');
  });
```

The SystemJS transform will automatically detect the `System.config(...)` and know to bundle `main`.

It will then update the config to reference the bundled file, with full source maps support.

### Config Overrides

It can be useful to specify configuration overrides that are specifically for the production / build config.

This can be added with the `configOverride` option:

```javascript
  .queue(systemJsAssetGraph({
    outRoot: 'app-built',
    bundle: true,
    configOverride: {
      map: {
        'some/module': 'production/module'
      }
    }
  }))
```

### HTTP/2 Optimization

In HTTP/2, rather than generating a single bundle file, we can inject the dependency tree into the page, so that all modules are
loaded in parallel.

This mode is enabled by setting `bundle: false` in the options.

In addition, each of the separate module files will be moved to a hashed file name and the hashes injected into the configuration
so that when making application updates, only those modules that have changed need to be reloaded in the browser cache.

### License

MIT
