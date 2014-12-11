var crypto = require('crypto');
var path = require('path');
var builder = require('systemjs-builder');
var fs = require('graceful-fs');
var Promise = require('rsvp').Promise;
var asp = require('rsvp').denodeify;
var mkdirp = require('mkdirp');

// populated from assetGraph instance
var uglifyJs, uglifyAst;

// 10 chars of md5 hex
function hash(str) {
  var md5 = crypto.createHash('md5');
  md5.update(str);
  return md5.digest('hex').toString().substr(0, 10);
}

// deep plain object extension
function dextend(a, b) {
  for (var p in b) {
    if (typeof b[p] === 'object') {
      dextend(a[p] = a[p] || {}, b[p]);
    } else {
      a[p] = b[p];
    }
  }
  return a;
}

// generate a hash of a file and move it to a name appended with the hash
// return the hash
function copyToHashed(file, root, outRoot) {
  file = path.resolve(root, file);
  var fileHash;

  return asp(fs.readFile)(file)
  .then(function (source) {
    fileHash = hash(source);
    var toFile = path.resolve(outRoot, path.relative(root, file.replace(/.js$/, '@' + fileHash + '.js')));

    return asp(mkdirp)(path.dirname(toFile))
    .then(function() {
      return asp(fs.writeFile)(toFile, source);
    })
  })
  .then(function() {
    return fileHash;
  });
}

function findSystemJsImportNodes(ast) {
  var imports = [];
  var walker = new uglifyJs.TreeWalker(function (node) {
    if (node instanceof uglifyJs.AST_Call &&
        node.expression instanceof uglifyJs.AST_Dot &&
        node.expression.property === 'import' &&
        node.expression.expression.name === 'System' &&
        node.args.length === 1) {
      imports.push(node.args[0].value);
    }
  });
  ast.walk(walker);
  return imports;
}
function findSystemJsConfigNode(ast) {
  var configNode;
  var walker = new uglifyJs.TreeWalker(function (node) {
    if (node instanceof uglifyJs.AST_Call &&
        node.expression instanceof uglifyJs.AST_Dot &&
        node.expression.property === 'config' &&
        node.expression.expression.name === 'System' &&
        node.args.length === 1 &&
        node.args[0] instanceof uglifyJs.AST_Object) {
      configNode = node.args[0];
    }
  });
  ast.walk(walker);
  return configNode;
}

function extractSystemJsCalls(assetGraph, initialAsset) {
  var main, mainRelation, config, configRelation;

  return new Promise(function(resolve, reject) {
    assetGraph.populate({ followRelations: { type: 'HtmlScript' } }).run(function(err, assetGraph) {
      if (err) {
        return reject(err);
      }

      // work out the main entry point assuming it is an inline script
      // of the form
      // <script> ... System.import('x') ... </script>
      assetGraph.findRelations({ type: 'HtmlScript', from: initialAsset }).forEach(function (relation) {
        var imports = findSystemJsImportNodes(relation.to.parseTree);
        if (!main && imports.length) {
          main = imports[0];
          mainRelation = relation;
        }
      });

      // look out for the configuration file in assets
      // System.config(...) in external script
      assetGraph.findRelations({ type: 'HtmlScript', from: initialAsset }).forEach(function (relation) {
        // one of these relations contains our config
        var configNode;
        if (!config && (configNode = findSystemJsConfigNode(relation.to.parseTree))) {
          config = uglifyAst.astToObj(configNode);
          configRelation = relation;
        }
      });

      if (!main || !config)
        return resolve();

      return resolve({
        config: config,
        configRelation: configRelation,
        main: main,
        mainRelation: mainRelation
      });
    });
  });
}

// only do one build at a time
var buildQueue;
// assets shared between apps, so log which have been moved
var processedHashes = {};
function doSystemJsDepCache(main, config, root, outRoot) {
  if (buildQueue)
    return buildQueue.then(function () {
      buildQueue = null;
      return doSystemJsDepCache(main, config, root, outRoot);
    });

  config = dextend(config);

  // trace in the root folder
  config.baseURL = path.resolve(root);

  config.depCache = config.depCache || {};
  config.versions = config.versions || {};

  return buildQueue = builder.trace(main, config, true)
  .then(function (output) {
    var tree = output.tree;
    var l;

    return Promise.all(Object.keys(tree).map(function (l) {
      var deps = tree[l].deps.map(function (dep) {
        return tree[l].depMap[dep];
      });

      if (deps.length)
        config.depCache[l] = deps;

      // copy each module in the root tree to a hashed name in the outRoot
      // (if not already)
      var file = tree[l].address.substr(5);
      if (processedHashes[file]) {
        config.versions[l] = processedHashes[file];
      } else {
        return copyToHashed(file, root, outRoot).then(function (hash) {
          config.versions[l] = hash;
          processedHashes[file] = hash;
        });
      }
    }));
  })
  .then(function() {
    return config;
  });
}


var bundlesForMain = {};
function doSystemJsBundle(main, config, root, outRoot) {
  if (buildQueue) {
    return buildQueue.then(function () {
      buildQueue = null;
      // Re-use config if the same entry points has already been bundled
      if (main in bundlesForMain) {
        return bundlesForMain[main];
      } else {
        return doSystemJsBundle(main, config, root, outRoot);
      }
    });
  }

  config = dextend(config);

  var outFile = 'static/bundle.js';

  // do the build
  config.baseURL = path.resolve(root);
  return buildQueue = builder.build(main, path.resolve(outRoot, outFile), {
    sourceMaps: true,
    minify: true,
    config: config
  })
  .then(function () {
    return copyToHashed(outFile, outRoot, outRoot);
  })
  .then(function (hash) {
    // ensure the main loads the bundle    
    config.bundles = config.bundles || {};
    config.bundles[outFile.replace(/.js$/, '') + '@' + hash] = [main];
    bundlesForMain[main] = config;

    // remove unhashed bundle file
    return fs.unlink(path.resolve(outRoot, outFile));
  })
  .then(function () {
    return config;
  });
}

function parseConfig(config, override) {
  // do config overrides
  dextend(config, override || {});

  // remove identity mappings
  // used to remove eg the app: app-compiled maps
  for (var p in config.map) {
    if (config.map[p] === p)
      delete config.map[p];
  }

  return config;
}

function systemJsBuildHtml(assetGraph, initialAsset, options) {
  return extractSystemJsCalls(assetGraph, initialAsset)
  .then(function(systemJs) {
    // skip if not using SystemJS
    if (!systemJs)
      return;

    var config = parseConfig(systemJs.config, options.configOverride);

    var strategy = options.bundle ? doSystemJsBundle : doSystemJsDepCache;

    return strategy(systemJs.main, config, assetGraph.root.substr(7), options.outRoot)
    .then(function(config) {
      // save back the config file
      delete config.baseURL;
      var configString = 'System.config(' + JSON.stringify(config) + ');';

      var configRelation = systemJs.configRelation;

      // clone the config asset as each app has its own modified config
      configRelation.to.clone(configRelation);

      // when a script attribute is set, the bundle step doesn't add this into the main bundle
      // better ways of doing this welcome!
      configRelation.node.setAttribute('config', 'system');

      configRelation.to.parseTree = uglifyJs.parse(configString);
    });
  });
}

module.exports = function (options) {
  options = options || {};

  return function systemJsProduction(assetGraph, callback) {
    uglifyJs = uglifyJs || assetGraph.JavaScript.uglifyJs;
    uglifyAst = uglifyAst || assetGraph.JavaScript.uglifyAst;

    return Promise.all(
      assetGraph.findAssets({ isInitial: true, type: 'Html' }).map(function(initialAsset) {
        return systemJsBuildHtml(assetGraph, initialAsset, options);
      })
    ).then(function() { callback() }, callback);
  };
};
