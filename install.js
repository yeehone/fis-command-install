/*
 * fis
 * http://fis.baidu.com/
 */

'use strict';

exports.name = 'install';
exports.usage = '[options] <components...>';
exports.desc = 'install components';

var logger = require('./lib/logger');
var factory = require('./lib/remotes/factory.js');
var _ = require('./lib/util.js');
var fs = require('fs');
var path = require('path');
var exists = fs.existsSync;
var write = fs.writeFileSync;

exports.register = function(commander) {

    commander
        .option('--save', 'save component(s) dependencies into `components.json` file.')
        .option('-r, --root <path>', 'set project root')
        .action(function() {
            var args = [].slice.call(arguments);
            var options = args.pop();
            var Promise = require('bluebird');
            var settings = {
                save: !!options.save,
                root: options.root || '',
                components: args.concat()
            };

            Promise

                // resolve project root.
                // 根据 fis-conf.js 所在目录来决定 root 是哪个目录。
                .try(function() {
                    if (!settings.root) {
                        var findup = require('findup');

                        return new Promise(function(resolve, reject) {
                                var fup = findup(process.cwd(), 'fis-conf.js');
                                var dir = null;

                                fup.on('found', function(found) {
                                    dir = found;
                                    fup.stop();
                                });

                                fup.on('error', reject);

                                fup.on('end', function() {
                                    resolve(dir);
                                });
                            })

                            .then(function(dir) {
                                settings.root = dir || process.cwd();
                            });
                    }
                })

                // load fis-conf.js if exists.
                // 读取用户配置信息。
                .then(function() {
                    var filepath =  path.join(settings.root, 'fis-conf.js');

                    if (exists(filepath)) {
                        require(filepath);
                    }

                    // 应用  fis-conf.js
                    settings.componentsDir = path.join(settings.root,
                            fis.config.get('component.dir') || '/components');
                    settings.protocol = fis.config.get('component.protocol', 'github');
                    settings.github = fis.config.get('component.github', {});
                    settings.gitlab = fis.config.get('component.gitlab', {});
                    settings.lights = fis.config.get('component.lights', {});
                })

                // 读取 components.json 如果存在
                .then(function() {
                    var components = settings.components;
                    var path = require('path');
                    var exists = require('fs').existsSync;
                    var componentJson = path.join(settings.root, 'component.json');

                    if (!components.length && !exists(componentJson)) {
                        throw new Error('missing `component.json`');
                    }

                    if (exists(componentJson)) {
                        var config = Promise.promisify(require('./lib/config'));

                        return config(componentJson)

                            .then(function(ret) {
                                settings.config = ret;

                                []
                                    .join
                                    .apply(settings.components, ret.dependencies || []);

                                ret.protocol && (settings.protocol = ret.protocol);
                                ret.github && _.mixin(settings.github, ret.github);
                                ret.gitlab && _.mixin(settings.gitlab, ret.gitlab);
                                ret.lights && _.mixin(settings.lights, ret.lights);
                            });
                    }
                })

                .then(function() {
                    var components = settings.components || [];

                    factory.setSettings(settings);

                    // validate and filter invalid dependencies.
                    // 过滤掉不能识别的依赖。
                    return strToRemote(components);
                })

                // finally get components list.
                .then(function(components) {
                    if (!components.length) {
                        logger.warn('Installed nothing!');
                        return;
                    }

                    var collector = require('./lib/collector.js');
                    return collector(components)

                        .then(function(components) {

                            // 过滤掉本地的仓库。已经同名的包。
                            components = components

                                .filter(function(item) {
                                    return item.location !== 'local';
                                })

                                // 先不 sort 了，通过先后顺序来准定用哪个版本吧。
                                // 而不是总是用最新版本。
                                // .sort(function(a, b) {
                                //     return _.compareVersion(a.version, b.version);
                                // })

                                // 过滤同名的组件名。
                                .filter(function(item, index, list) {
                                    return _.indexOfArray('name', item.name, list) === index;
                                });

                            if (!components.length) {
                                console.log('Aready installed');
                                return;
                            }

                            var ProgressBar = require('progress');
                            var percentages = {};

                            // 优化进度提示。
                            components.forEach(function(item) {
                                percentages[item.name] = {
                                    loaded: 0,
                                    total: 1024 * 1024 // 假的，后面会动态调整。
                                };
                            });

                            var bar;
                            var ticked = 0;
                            var update = function(name, loaded, total) {
                                // percentages[name] = percentages[name] || {};
                                percentages[name].loaded = loaded;
                                percentages[name].total = total;
                                updateAll();
                            };
                            var updateAll = function() {
                                bar = bar || new ProgressBar(' downloading [:bar] :percent :etas', {
                                    incomplete: ' ',
                                    total: 100,
                                    clear: true
                                });

                                var total = 0;
                                var loaded = 0;

                                Object.keys(percentages).forEach(function(key) {
                                    var item = percentages[key];

                                    total += item.total;
                                    loaded += item.loaded;
                                });

                                var percentage = Math.round(loaded * 100 / total);
                                var step = Math.max(percentage - ticked, 0);
                                ticked += step;
                                bar.tick(step);
                            }

                            return Promise

                                .all(components.map(function(component) {
                                    return component.install(function(percent, loaded, total) {
                                        update(component.name, loaded, total);
                                    });
                                }))

                                .then(function(components) {

                                    // 如果没有 tick 完，则收下尾
                                    (100 - ticked) && bar && bar.tick(100 - ticked);

                                    var last = components.length - 1;
                                    var arrs = components.map(function(item, index) {
                                        return (index === last ? '└── ' : '├── ') + item.type + ':' + item.address + '@' + item.version;
                                    });

                                    console.log('Installed\n%s', arrs.join('\n'));
                                    return components;
                                });
                        });
                })

                // 保存 components.json
                .then(function(installed) {
                    // 如果指定了  --save， 则需要把数据写入到 components.josn 文件里面。
                    if (settings.save && args.length && installed && installed.length) {
                        var config = settings.config;
                        var specified = strToRemote(args.concat());

                        config.dependencies = config.dependencies || [];

                        var oldList = strToRemote(config.dependencies);
                        specified.forEach(function(item) {
                            var idx;

                            if (!~_.indexOfArray('name', item.name, oldList) && ~(idx = _.indexOfArray('name', item.name, installed))) {

                                var found = installed[idx];

                                config.dependencies.push(found.type + ':' + found.address + '@' + found.version);
                            }
                        });

                        var componentJson = path.join(settings.root, 'component.json');
                        write(componentJson, JSON.stringify(config, null, 2));
                    }
                })

                // error handle
                .catch(function(e) {
                    if (/Not\s+Found/i.test(e.message)) {
                        logger.warn('`fis install` now is for installing commponents, you may use `\x1b[31mlights install\x1b[0m` instead.');
                    }
                    logger.error('\x1b[31m%s\x1b[0m', e.message);
                });
        });
};

function strToRemote(components, ignoreInvalid) {
    return components

        .map(function(component) {
            var type = factory.detect(component);

            if (!type) {
                ignoreInvalid || logger.warn('`%s` is not a valid repository.', component);
                return null;
            }

            return factory(component);
        })
        .filter(function(item) {
            return item != null;
        });
}