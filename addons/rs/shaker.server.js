/*
 * Copyright (c) 2012, Yahoo! Inc.  All rights reserved.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */

/*jslint anon:true, sloppy:true, nomen:true*/
/*global YUI*/

YUI.add('addon-rs-shaker', function (Y, NAME) {

    var libpath = require('path'),
        libfs = require('fs'),
        //bootstrap
        BOOTSTRAP_DIR = '../../lib/bootstrap/',
        BOOTSTRAP_YUI_OVERRIDE = 'yui-bootstrap-override',
        BOOTSTRAP_YUI_INLINE = 'yui-bootstrap-inline-min',
        //inline (defined in core as well)
        INLINE_SELECTOR = 'shaker-inline';

    function RSAddonShaker() {
        RSAddonShaker.superclass.constructor.apply(this, arguments);
    }

    RSAddonShaker.NS = 'shaker';
    RSAddonShaker.ATTRS = {};

    Y.extend(RSAddonShaker, Y.Plugin.Base, {

        initializer: function (config) {
            this.rs = config.host;
            this._poslCache = {};   // context: POSL
            this.appRoot = config.appRoot;
            this.mojitoRoot = config.mojitoRoot;
            this.appConfig = config.host.getStaticAppConfig() || {};
            this.shakerConfig = this.appConfig.shaker || {};

            var yuiRS = this.rs.yui,
                store = this.rs,
                shakerConfig = this.shakerConfig;

            if (!this.initilized) {
                //first read the shaker metadata
                this.meta = this.rs.config.readConfigSimple(libpath.join(this.appRoot, 'shaker-meta.json'));

                if (this.meta && !Y.Object.isEmpty(this.meta)) {
                    Y.log('Metadata loaded correctly.', 'info', 'Shaker');
                    Y.log('Preloading store', 'info', 'mojito-store');
                } else {
                    Y.log('Metadata not found.', 'warn', 'Shaker');
                }
            }

            /*
            * AOP HOOKS:
            * We need to hook some events on the store,
            * but we will have to do different hooks depending if we are on build time or in runtime
            * The reason is that there are some hook that are not needeed on runtime or viceversa
            */

            if (shakerConfig.optimizeBootstrap) {
                this.beforeHostMethod('makeResourceVersions', this.makeResourceVersions, this);
            }

            //on build time we need this to reconfigure the url of where the assets come from...
            if (shakerConfig.comboCDN) {
                this.beforeHostMethod('resolveResourceVersions', this.resolveResourceVersions, this);
            }

            this.beforeHostMethod('parseResourceVersion', this.parseResourceVersion, this);

            // This hooks are for runtime
            if (!process.shakerCompile) {

                //alter the url for the seeds or augment it if necesary...
                if (shakerConfig.comboCDN || shakerConfig.optimizeBootstrap) {
                    Y.Do.after(this.alterAppSeedFiles, yuiRS, 'getAppSeedFiles', this);
                }
                //alter bootstrap config
                //Y.Do.after(function (){console.log(Y.Do.currentRetVal);}, yuiRS, 'getAppGroupConfig', this);

                // Augments the view with assets
                this.onHostEvent('mojitResourcesResolved', this.mojitResourcesResolved, this);
            }
        },

        destructor: function () {
            // TODO:  needed to break cycle so we don't leak memory?
            this.rs = null;
        },

        /*
        * We need to add the synthetic bootstrap items
        */
        makeResourceVersions: function () {
            var store = this.rs,
                yuiRS = store.yui;
            this.addOptimizedBootstrap(store, yuiRS);
        },

        /*
        * Add the synthetic resources for the optimized bootstrap
        * On runtime we can access the new synthethic files
        */
        addOptimizedBootstrap: function (store, yuiRS) {
            var relativePath = libpath.join(__dirname, BOOTSTRAP_DIR),
                bootstrapResources = [
                    BOOTSTRAP_YUI_OVERRIDE,
                    BOOTSTRAP_YUI_INLINE
                ];

            Y.Array.each(bootstrapResources, function (item) {
                var content = libfs.readFileSync(relativePath + item + '.js', 'utf8'),
                    res = {
                        source: {},
                        mojit: 'shared',
                        type: 'yui-module',
                        subtype: 'synthetic',
                        name: item,
                        affinity: 'client',
                        selector: '*',
                        yui: {
                            name: item
                        }
                    };

                // this is how mojito creates synthetic resources when the server start, so wejust replicate it.
                res.id = [res.type, res.subtype, res.name].join('-');
                res.source.pkg = store.getAppPkgMeta();
                res.source.fs = store.makeResourceFSMeta(__dirname, 'app', '../../lib/bootstrap/', item + '.js', true);

                // adding synthetic resources to the store and tho the yuiRS since it will cache them.
                yuiRS.appModulesRess[item] = res;
                yuiRS.resContents[item] = content;
                store.addResourceVersion(res);

                // We save in the shaker addon the content of the hook
                // because on runtime we want to pick it syncronously
                if (item === BOOTSTRAP_YUI_INLINE) {
                    this.fakeYUIBootstrap = content;
                }

            }, this);
        },

        _resolveSeedResourceURL: function (moduleList) {
            var store = this.rs,
                yuiRS = store.yui,
                seed = moduleList,
                files,
                i;

            for (i = 0; i < seed.length; i += 1) {
                if (yuiRS.yuiModulesRess.hasOwnProperty(seed[i])) {
                    seed[i] = yuiRS.yuiModulesRess[seed[i]].url;
                } else if (yuiRS.appModulesRess.hasOwnProperty(seed[i])) {
                    seed[i] = yuiRS.appModulesRess[seed[i]].url;
                } else {
                    Y.log('Couldnt find module for seed. Optmized bootstrap may fail', 'warn', 'Shaker');
                }
            }

            return seed;
        },

        /*
        * When comboLoad is active we need to change the seed to point to the CDN...
        * We rely on the mapping we have on the Shaker metadata.
        * Also if optimizeBootstrap is set to true we need to augment the seed files to create our own seed.
        *
        * NOTE:
        *   I have to implement _resolveSeedResourceURL, because the original method @getAppSeedFiles
        *   pulls the seed directly from configuration or it creates it's own,
        *   so we cannot hook directly those files.
        */
        alterAppSeedFiles: function () {
            var i,
                newUrl,
                resources,
                shakerConfig = this.shakerConfig,
                cdnUrls = this.meta && this.meta.cdnModules,
                currentSeed = Y.Do.currentRetVal;

            if (shakerConfig.optimizeBootstrap) {

                resources = this._resolveSeedResourceURL([BOOTSTRAP_YUI_OVERRIDE]);
                //the first element has to be the yui-override
                currentSeed.unshift(resources[0]);
            }

            // We need to change the url to point to the generated in CDN...
            if (shakerConfig.comboCDN && cdnUrls) {
                for (i in currentSeed) {
                    if (currentSeed.hasOwnProperty(i)) {
                        newUrl = cdnUrls[currentSeed[i]];
                        if (newUrl) {
                            currentSeed[i] = newUrl;
                        }
                    }
                }
            }
        },

        /*
        * Change the URL's of the Store so we get the comboLoad from CDN.
        */
        resolveResourceVersions: function (cdnUrls) {
            var r,
                res,
                ress,
                m,
                mojit,
                mojits,
                meta,
                urls = {};

            //get the CDN URL mapping
            cdnUrls = cdnUrls || this.meta.cdnModules;

            if (!cdnUrls) {
                return;
            }

            //Iterate over all the resources
            mojits = this.rs.listAllMojits();
            mojits.push('shared');

            for (m = 0; m < mojits.length; m += 1) {
                mojit = mojits[m];
                ress = this.rs.getResourceVersions({mojit: mojit});
                for (r = 0; r < ress.length; r += 1) {
                    res = ress[r];
                    //Change the url
                    if (res.yui && cdnUrls[res.url]) {
                        res.url = cdnUrls[res.url];
                    }
                }
            }
        },

        /*
        * Converting inlines files to be readable by the store.
        * parseResourceVersion:
        * AOP hook!
        */
        parseResourceVersion: function (source, type, subtype) {
            var basename,
                tmpBasename,
                inline;

            if (type === 'asset') {
                basename = source.fs.basename.split('.');
                inline = basename.pop();

                if (inline === INLINE_SELECTOR) {
                    // Add the inline property to source, since we don't have access to the resource itself yet.
                    source.inline = true;
                    // put back the basename without the INLINE_SELECTOR so mojito doesnt skip the file.
                    basename[0] = basename[0] + '-' + INLINE_SELECTOR;
                    source.fs.basename = basename.join('.');
                }
            }
        },

        /*
        * Augment the view spec with the Shaker computed assets.
        * Will be merged on the action-context module (either on the client or in the server).
        */
        mojitResourcesResolved: function (e) {
            var env = e.env,
                posl = e.posl,
                mojitName = e.mojit,
                ress = e.ress,
                strContext = posl.join('-'),
                isFrame = mojitName.indexOf('ShakerHTMLFrameMojit') !== -1,
                shakerMeta = this.meta,
                shakerBase,
                frameActionMeta,
                actionMeta,
                css,
                resource,
                i;

            if (Y.Object.isEmpty(this.meta)) {
                return;
            }

            // If the mojit is the ShakerHTMLFrame, we are going to put the common assets there.
            if (isFrame) {
                shakerBase = shakerMeta.app[strContext];
                shakerBase = shakerBase && shakerBase.app;
                frameActionMeta = {
                    css: shakerBase
                };

            } else {
                // Check if on the nested meta we have all the info we need...
                shakerBase = shakerMeta.app[strContext];
                shakerBase = shakerBase && shakerBase.mojits[mojitName];
            }

            for (i in ress) {
                if (ress.hasOwnProperty(i)) {
                    resource = ress[i];
                    // we got a view, let's attach the proper assets if some
                    if (resource.type === 'view') {
                        actionMeta =  (isFrame ? frameActionMeta : shakerBase && shakerBase[resource.name]) || {css: [], blob: []};
                        ress[i].view.assets = {
                            topShaker: {
                                css: actionMeta.css
                            },
                            inlineShaker: {
                                blob: actionMeta.blob
                            }
                        };
                    }
                }
            }
        }
    });

    Y.namespace('mojito.addons.rs').shaker = RSAddonShaker;

}, '0.0.1', {
    requires: [
        'plugin',
        'oop',
        'addon-rs-url',
        'addon-rs-yui'
    ]
});
