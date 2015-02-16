var crypto = require('crypto');
var path = require('path');
var Builder = require('systemjs-builder');
var fs = require('graceful-fs');
var RSVP = require('rsvp');
var Promise = RSVP.Promise;
var denodeify = RSVP.denodeify;
var mkdirp = require('mkdirp');
var _ = require('lodash');
var builder = new Builder();

// populated from assetGraph instance
var uglifyJs, uglifyAst;

// 10 chars of md5 hex
function hash(str) {
  var md5 = crypto.createHash('md5');
  md5.update(str);
  return md5.digest('hex').toString().substr(0, 10);
}

function jsFileNameHashed(fileName, fileHash) {
  return fileName.replace(/.js$/, '@' + fileHash + '.js');
}

// generate a hash of a file and move it to a name appended with the hash
// return the hash
function writeToHashed(outFile, source) {
  var fileHash = hash(source);
  var hashedOutFile = jsFileNameHashed(outFile, fileHash);

  return denodeify(fs.writeFile)(hashedOutFile, source)
    .then(function() {
      return fileHash;
    });
}

function copyFile(inFile, outFile) {
  return denodeify(fs.readFile)(inFile)
    .then(function(source){
      return denodeify(mkdirp)(path.dirname(outFile))
        .then(function() {
          return denodeify(fs.writeFile)(outFile, source)
            .then(function() {
              return source;
            });
        })
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
  return new Promise(function(resolve, reject) {
    assetGraph.populate({ followRelations: { type: 'HtmlScript' } }).run(function(err, assetGraph) {
      var main, mainRelation, config, configRelation;
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

      if (!main || !config) {
        return resolve();
      }

      return resolve({
        config: config,
        configRelation: configRelation,
        main: main,
        mainRelation: mainRelation
      });
    });
  });
}

// assets shared between apps, so log which have been moved
var processedHashes = {};

// WARNING
// DOESN'T WORK PROPERLY YET
// WARNING
function doSystemJsDepCache(main, options, sourceRoot, outRoot) {
  console.log('Dep caching:', main);
  options = _.cloneDeep(options);

  // trace in the sourceRoot folder
  options.config.baseURL = path.resolve(sourceRoot);

  options.config.depCache = options.config.depCache || {};
  options.config.versions = options.config.versions || {};

  return builder.trace(main, options.config, true)
    .then(function(output) {
      var tree = output.tree;
      return Promise.all(Object.keys(tree).map(function(module) {
        var deps = tree[module].deps.map(function(dep) {
          return tree[module].depMap[dep];
        });

        if (deps.length) {
          options.config.depCache[module] = deps;
        }

        // copy each module in the root tree to a hashed name in the outRoot
        // (if not already)
        var fileName = path.relative(sourceRoot, tree[module].address.substr(5));
        if (processedHashes[fileName]) {
          options.config.versions[module] = processedHashes[fileName];
        } else {
          return copyFile(path.resolve(sourceRoot, fileName), path.resolve(outRoot, fileName))
            .then(function(source) {
              return writeToHashed(path.resolve(outRoot, fileName), source)
            }).then(function (hash) {
              options.config.versions[module] = hash;
              processedHashes[fileName] = hash;
            });
        }
      }));
    })
    .then(function() {
      return options.config;
    });
}

var bundlesForMain = {};
function doSystemJsBundle(main, options, sourceRoot, outRoot) {
  if (main in bundlesForMain) {
    console.log('Re-using bundle for:', main);
    return RSVP.resolve(bundlesForMain[main]);
  } else {
    console.log('Bundling:', main);
  }

  options = _.cloneDeep(options);

  var outFile = 'static/bundle.js';
  var outPath = path.resolve(outRoot, outFile);

  // do the build
  options.config.baseURL = path.resolve(sourceRoot);

  return builder.build(main, outPath, options)
    .then(function() {
      return denodeify(fs.readFile)(outPath);
    })
    .then(function (source) {
      return writeToHashed(path.resolve(outRoot, outFile), source);
    })
    .then(function (hash) {
      // ensure the main loads the bundle
      options.config.bundles = options.config.bundles || {};
      options.config.bundles[outFile.replace(/.js$/, '') + '@' + hash] = [main];
      bundlesForMain[main] = _.cloneDeep(options.config);

      // remove unhashed bundle file
      return denodeify(fs.unlink)(outPath);
    })
    .then(function () {
      return options.config;
    });
}

function systemJsBuildHtml(assetGraph, initialAsset, options) {
  return extractSystemJsCalls(assetGraph, initialAsset)
    .then(function(systemJs) {
      options = _.cloneDeep(options);

      // skip if not using SystemJS
      if (!systemJs){
        return;
      }

      var config = _.cloneDeep(systemJs.config);
      var builderConfig = _.merge({
        config: config,
        transpiler: 'traceur'
      }, options.builderConfig || {});

      var strategy = options.bundle ? doSystemJsBundle : doSystemJsDepCache;
      var sourceRoot = assetGraph.root.substr(7);

      builder.loader.transpiler = builderConfig.transpiler;

      return strategy(systemJs.main, builderConfig, sourceRoot, options.outRoot)
        .then(function(config) {
          config = _.cloneDeep(config);

          // save back the config file
          delete config.baseURL;
          var configString = 'System.transpiler = "' + builderConfig.transpiler + '";';

          configString += 'System.config(' + JSON.stringify(config) + ');';

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
  if (!options || !options.outRoot) {
    throw new Error('options must include outRoot');
  }

  return function systemJsProduction(assetGraph, callback) {
    uglifyJs = uglifyJs || assetGraph.JavaScript.uglifyJs;
    uglifyAst = uglifyAst || assetGraph.JavaScript.uglifyAst;

    return assetGraph.findAssets({ isInitial: true, type: 'Html' }).map(function(initialAsset) {
      return function doBuild() {
        return systemJsBuildHtml(assetGraph, initialAsset, options);
      }
    }).reduce(function(current, next){
      return current.then(next);
    }, RSVP.resolve()).then(function() {
      callback();
    }).catch(function(rejection) {
      callback(rejection);
    });
  };
};
